import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import * as chatMemoryCacheSvc from "./chat-memory-cache.service";
import * as chatsSvc from "./chats.service";
import * as embeddingsSvc from "./embeddings.service";
import type { EmbeddingConfigWithStatus } from "./embeddings.service";
import * as memoryCortex from "./memory-cortex";
import * as vectorizationQueueSvc from "./vectorization-queue.service";
import { __test__ as userDataImportTest } from "./user-data/import.service";

const USER_ID = "maintenance-owner";

describe.serial("chat chunk maintenance lifecycle", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  let enabledEmbeddingConfig: EmbeddingConfigWithStatus;
  let refreshCacheImpl: () => Promise<void>;

  function track<T extends { mockRestore: () => void }>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  function createTemporaryChat() {
    return chatsSvc.createChat(USER_ID, {
      character_id: null,
      name: "Maintenance lifecycle",
      metadata: { temporary: true },
    });
  }

  function seedMessage(
    chatId: string,
    id: string,
    index: number,
    isUser: boolean,
    content: string,
  ): void {
    getDb().query(
      `INSERT INTO messages (
        id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id,
        swipes, swipe_dates, extra, parent_message_id, branch_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '{}', NULL, NULL, ?)`,
    ).run(
      id,
      chatId,
      index,
      isUser ? 1 : 0,
      isUser ? "User" : "Assistant",
      content,
      index + 1,
      JSON.stringify([content]),
      JSON.stringify([index + 1]),
      index + 1,
    );
  }

  function seedChunk(
    chatId: string,
    id: string,
    messageIds: string[],
    createdAt: number,
  ): void {
    const startMessageId = messageIds[0];
    const endMessageId = messageIds.at(-1);
    if (!startMessageId || !endMessageId) throw new Error("chunk fixture requires at least one message");
    getDb().query(
      `INSERT INTO chat_chunks (
        id, chat_id, start_message_id, end_message_id, message_ids, content,
        token_count, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      id,
      chatId,
      startMessageId,
      endMessageId,
      JSON.stringify(messageIds),
      `chunk:${id}`,
      messageIds.length,
      createdAt,
      createdAt,
    );
  }

  function isPending(promise: Promise<unknown>): () => boolean {
    let pending = true;
    void promise.then(
      () => { pending = false; },
      () => { pending = false; },
    );
    return () => pending;
  }

  beforeEach(async () => {
    await chatsSvc.waitForChatChunkMaintenance();
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    getDb().query(
      'INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)',
    ).run(USER_ID, "Maintenance Owner", "maintenance-owner@example.test");
    getDb().run("CREATE TABLE lifecycle_probe (stage TEXT PRIMARY KEY)");

    const defaultConfig = await embeddingsSvc.getEmbeddingConfig(USER_ID);
    enabledEmbeddingConfig = {
      ...defaultConfig,
      enabled: true,
      vectorize_chat_messages: true,
    };

    track(spyOn(embeddingsSvc, "deleteChatChunkEmbeddings").mockResolvedValue(undefined));
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => ({
      processedCount: tasks.length,
      failedChunkIds: [],
      refreshedChatIds: [],
    }));
    refreshCacheImpl = async () => {};
    chatMemoryCacheSvc.__test__.setRefreshChatMemoryCache(async () => refreshCacheImpl());
    track(spyOn(chatMemoryCacheSvc, "refreshChatMemoryCache").mockImplementation(() => (
      refreshCacheImpl()
    )));
  });

  afterEach(async () => {
    let maintenanceError: unknown;
    try {
      await chatsSvc.waitForChatChunkMaintenance();
    } catch (error) {
      maintenanceError = error;
    }
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(null);
    chatMemoryCacheSvc.__test__.setRefreshChatMemoryCache(null);
    for (const spy of spies.splice(0)) spy.mockRestore();
    closeDatabase();
    if (maintenanceError) throw maintenanceError;
  });

  test("create waits through the deferred cortex callback before database replacement", async () => {
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(enabledEmbeddingConfig));
    track(spyOn(memoryCortex, "isCortexEnabledForChat").mockReturnValue(true));

    const cortexEntered = Promise.withResolvers<void>();
    const releaseCortex = Promise.withResolvers<void>();
    track(spyOn(memoryCortex, "scheduleProcessChunk").mockImplementation(async () => {
      cortexEntered.resolve();
      await releaseCortex.promise;
      getDb().query("INSERT INTO lifecycle_probe (stage) VALUES ('cortex')").run();
      return { status: "completed" };
    }));

    const chat = createTemporaryChat();
    const message = chatsSvc.createMessage(chat.id, {
      is_user: true,
      name: "User",
      content: "Remember the deferred callback",
    }, USER_ID);
    expect(message.content).toBe("Remember the deferred callback");

    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const maintenancePending = isPending(maintenance);
    await cortexEntered.promise;
    await Promise.resolve();
    expect(maintenancePending()).toBe(true);

    releaseCortex.resolve();
    await maintenance;
    expect(getDb().query("SELECT stage FROM lifecycle_probe").all()).toEqual([
      { stage: "cortex" },
    ]);

    closeDatabase();
    initDatabase(":memory:");
    getDb().run("CREATE TABLE lifecycle_probe (stage TEXT PRIMARY KEY)");
    expect(getDb().query("SELECT stage FROM lifecycle_probe").all()).toEqual([]);
  });

  test("update waits for surgical rebuild hashing before exposing quiescence", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "message-1", 0, true, "first");
    seedMessage(chat.id, "message-2", 1, false, "second");
    seedMessage(chat.id, "message-3", 2, true, "third");
    seedChunk(chat.id, "preserved-chunk", ["message-1"], 1);
    seedChunk(chat.id, "replaced-chunk", ["message-2", "message-3"], 2);

    let configCalls = 0;
    const hashEntered = Promise.withResolvers<void>();
    const releaseHash = Promise.withResolvers<void>();
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockImplementation(async () => {
      configCalls += 1;
      if (configCalls === 2) {
        hashEntered.resolve();
        await releaseHash.promise;
      }
      return enabledEmbeddingConfig;
    }));

    const updated = chatsSvc.updateMessage(USER_ID, "message-2", {
      content: "edited second",
    });
    expect(updated?.content).toBe("edited second");

    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const maintenancePending = isPending(maintenance);
    await hashEntered.promise;
    await Promise.resolve();

    expect(maintenancePending()).toBe(true);
    expect(getDb().query("SELECT id FROM chat_chunks WHERE id = 'preserved-chunk'").get())
      .toEqual({ id: "preserved-chunk" });
    expect(chatsSvc.getChat(USER_ID, chat.id)?.metadata.ltcm_config_hash).toBeUndefined();

    releaseHash.resolve();
    await maintenance;

    expect(chatsSvc.getChat(USER_ID, chat.id)?.metadata.ltcm_config_hash)
      .toEqual(expect.any(String));
    expect(getDb().query("SELECT id FROM chat_chunks WHERE id = 'preserved-chunk'").get())
      .toEqual({ id: "preserved-chunk" });
    expect(getDb().query("SELECT id FROM chat_chunks WHERE id = 'replaced-chunk'").get())
      .toBeNull();
  });

  test("full rebuild awaits hash and cache work and reports maintenance failures", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "message-1", 0, true, "rebuild me");

    const configSpy = track(
      spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(enabledEmbeddingConfig),
    );
    const refreshEntered = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    refreshCacheImpl = async () => {
      refreshEntered.resolve();
      await releaseRefresh.promise;
      getDb().query("INSERT INTO lifecycle_probe (stage) VALUES ('cache')").run();
    };

    const rebuild = chatsSvc.rebuildChatChunks(USER_ID, chat.id);
    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const rebuildPending = isPending(rebuild);
    const maintenancePending = isPending(maintenance);
    await refreshEntered.promise;
    await Promise.resolve();

    expect(rebuildPending()).toBe(true);
    expect(maintenancePending()).toBe(true);
    expect(chatsSvc.getChat(USER_ID, chat.id)?.metadata.ltcm_config_hash)
      .toEqual(expect.any(String));

    releaseRefresh.resolve();
    await Promise.all([rebuild, maintenance]);
    expect(getDb().query("SELECT stage FROM lifecycle_probe").all()).toEqual([
      { stage: "cache" },
    ]);

    const hashFailure = new Error("hash lookup failed");
    let failedConfigCalls = 0;
    configSpy.mockImplementation(async () => {
      failedConfigCalls += 1;
      if (failedConfigCalls === 2) throw hashFailure;
      return enabledEmbeddingConfig;
    });
    refreshCacheImpl = async () => {};

    const failedRebuild = chatsSvc.rebuildChatChunks(USER_ID, chat.id);
    const failedMaintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const [rebuildResult, maintenanceResult] = await Promise.allSettled([
      failedRebuild,
      failedMaintenance,
    ]);

    expect(rebuildResult).toEqual({ status: "rejected", reason: hashFailure });
    expect(maintenanceResult).toEqual({ status: "rejected", reason: hashFailure });
  });
  test("barrier follows the real vector queue timer through a retry", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "retry-message", 0, true, "retry vectorization");
    seedChunk(chat.id, "retry-chunk", ["retry-message"], 1);

    let calls = 0;
    const retryEntered = Promise.withResolvers<void>();
    const releaseRetry = Promise.withResolvers<void>();
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => {
      calls += 1;
      if (calls === 1) {
        return { processedCount: 0, failedChunkIds: tasks.map((task) => task.chunkId), refreshedChatIds: [] };
      }
      retryEntered.resolve();
      await releaseRetry.promise;
      return { processedCount: tasks.length, failedChunkIds: [], refreshedChatIds: [] };
    });

    vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "retry-chunk", 1);
    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const maintenancePending = isPending(maintenance);
    await retryEntered.promise;
    await Promise.resolve();
    expect(maintenancePending()).toBe(true);
    expect(calls).toBe(2);

    releaseRetry.resolve();
    await maintenance;
  });

  test("terminal vector failure is retained until the barrier reports it", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "failed-message", 0, true, "fail vectorization");
    seedChunk(chat.id, "failed-chunk", ["failed-message"], 1);
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => ({
      processedCount: 0,
      failedChunkIds: tasks.map((task) => task.chunkId),
      refreshedChatIds: [],
    }));

    vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "failed-chunk", 0);
    await expect(chatsSvc.waitForChatChunkMaintenance(chat.id))
      .rejects.toThrow("Chunk vectorization failed after retries: failed-chunk");
  });

  test("barrier includes the cache refresh scheduled after vector persistence", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "cache-message", 0, true, "refresh cache after vectors");
    seedChunk(chat.id, "cache-chunk", ["cache-message"], 1);
    const refreshEntered = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    refreshCacheImpl = async () => {
      refreshEntered.resolve();
      await releaseRefresh.promise;
    };
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => ({
      processedCount: tasks.length,
      failedChunkIds: [],
      refreshedChatIds: [chat.id],
    }));

    vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "cache-chunk", 1);
    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const maintenancePending = isPending(maintenance);
    await refreshEntered.promise;
    await Promise.resolve();
    expect(maintenancePending()).toBe(true);

    releaseRefresh.resolve();
    await maintenance;
  });

  test("import rebuild is registered before its dynamic import can resolve", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "import-message", 0, true, "rebuild after import");
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(enabledEmbeddingConfig));

    const vectorEntered = Promise.withResolvers<void>();
    const releaseVector = Promise.withResolvers<void>();
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => {
      vectorEntered.resolve();
      await releaseVector.promise;
      return { processedCount: tasks.length, failedChunkIds: [], refreshedChatIds: [] };
    });

    expect(userDataImportTest.scheduleDerivedVectorProjectionSync(USER_ID)).toBeGreaterThan(0);
    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const maintenancePending = isPending(maintenance);
    await vectorEntered.promise;
    await Promise.resolve();
    expect(maintenancePending()).toBe(true);

    releaseVector.resolve();
    await maintenance;
    expect(getDb().query("SELECT COUNT(*) AS count FROM chat_chunks WHERE chat_id = ?").get(chat.id))
      .toEqual({ count: 1 });
  });
});
