import { Database } from "bun:sqlite";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { chatsRoutes } from "../routes/chats.routes";
import {
  AGENT_ACTIVITY_CHAT_MAX_BYTES,
  AGENT_ACTIVITY_RUN_MAX_BYTES,
  AGENT_ACTIVITY_RUN_MAX_COUNT,
  __test__serializeAgentActivityRun,
  listAgentActivityRuns,
  ownsChatForActivity,
  persistTerminalAgentActivityRun,
} from "./agent-activity-runs.service";
import { runMigrations } from "../db/migrate";
import type { AgentActivitySnapshotV1 } from "../types/agent-runtime";
import { createChat } from "./chats.service";

const OWNER = "activity-owner";
const OTHER = "activity-other";
const app = new Hono();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  await next();
});
app.route("/", chatsRoutes);

async function applyActivitySchema(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "078_chats_character_id_nullable.sql")).text());
}

function snapshot(status: AgentActivitySnapshotV1["status"] = "completed", extra: Record<string, unknown> = {}): AgentActivitySnapshotV1 {
  return {
    version: 1,
    rootId: "root-1",
    nodes: [{
      id: "root-node",
      parentId: null,
      kind: "root_turn",
      actor: "root",
      phase: status,
      status,
      startedAt: 1,
      elapsedMs: 2,
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, toolCalls: 1, childInvocations: 1 },
    }],
    omittedNodeCount: 0,
    errorCounts: {},
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, toolCalls: 1, childInvocations: 1 },
    status,
    ...extra,
  };
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await applyActivitySchema();
});
afterEach(() => closeDatabase());

describe("agent activity fallback persistence", () => {
  test("persists target-backed and no-target terminal outcomes without changing swipe scope", () => {
    const chat = createChat(OWNER, { name: "activity" });
    const target = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "regen-generation",
      targetMessageId: "assistant-message",
      targetSwipeId: 3,
      snapshot: snapshot("completed"),
    });
    const noTarget = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "setup-generation",
      snapshot: snapshot("failed"),
      status: "failed",
    });
    const stopped = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "stop-generation",
      targetMessageId: null,
      targetSwipeId: null,
      snapshot: snapshot("cancelled"),
      status: "cancelled",
    });

    expect(target?.targetMessageId).toBe("assistant-message");
    expect(target?.targetSwipeId).toBe(3);
    expect(noTarget?.targetMessageId).toBeNull();
    expect(noTarget?.targetSwipeId).toBeNull();
    expect(stopped?.snapshot.status).toBe("cancelled");
    expect(listAgentActivityRuns(OWNER, chat.id).map((run) => run.generationId)).toEqual([
      "stop-generation", "setup-generation", "regen-generation",
    ]);
  });

  test("drops prose, arguments, results, carriers, and unknown fields before storing", () => {
    const chat = createChat(OWNER, { name: "activity" });
    const input = snapshot("failed", {
      task: "private prompt",
      result: { secret: "tool result" },
      carrier: "encrypted provider carrier",
      nodes: Array.from({ length: 128 }, (_, index) => ({
        id: `node-${index}-${"x".repeat(240)}`,
        parentId: null,
        kind: "tool_attempt",
        actor: "tool",
        phase: "failed",
        status: "failed",
        startedAt: index,
        elapsedMs: 1,
        toolId: "unknown-provider-tool",
        arguments: "secret args",
        result: "secret result",
        prose: "secret prose",
      })),
    }) as unknown as AgentActivitySnapshotV1;
    const persisted = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "hostile-generation",
      snapshot: input,
      status: "failed",
    });
    expect(persisted).not.toBeNull();
    const encoded = JSON.stringify(persisted);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(AGENT_ACTIVITY_RUN_MAX_BYTES);
    expect(encoded).not.toContain("private prompt");
    expect(encoded).not.toContain("secret args");
    expect(encoded).not.toContain("secret result");
    expect(encoded).not.toContain("encrypted provider carrier");
    expect(persisted!.snapshot.nodes.every((node) => node.toolId === "unknown_tool")).toBe(true);
    expect(persisted!.snapshot.omittedNodeCount).toBeGreaterThan(0);
    const stored = getDb().query("SELECT snapshot_json FROM agent_activity_runs WHERE generation_id = ?").get("hostile-generation") as { snapshot_json: string };
    expect(stored.snapshot_json).not.toContain("arguments");
    expect(stored.snapshot_json).not.toContain("result");
  });

  test("evicts oldest rows transactionally at the count and byte bounds", () => {
    const chat = createChat(OWNER, { name: "activity" });
    for (let i = 0; i < AGENT_ACTIVITY_RUN_MAX_COUNT + 2; i++) {
      persistTerminalAgentActivityRun({
        userId: OWNER,
        chatId: chat.id,
        generationId: `generation-${i}`,
        snapshot: snapshot("completed"),
      });
    }
    const rows = listAgentActivityRuns(OWNER, chat.id);
    expect(rows).toHaveLength(AGENT_ACTIVITY_RUN_MAX_COUNT);
    expect(rows.map((row) => row.generationId)).not.toContain("generation-0");
    expect(rows.map((row) => row.generationId)).not.toContain("generation-1");
    const totals = getDb().query("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM agent_activity_runs WHERE user_id = ? AND chat_id = ?").get(OWNER, chat.id) as { count: number; bytes: number };
    expect(totals.count).toBeLessThanOrEqual(AGENT_ACTIVITY_RUN_MAX_COUNT);
    expect(totals.bytes).toBeLessThanOrEqual(AGENT_ACTIVITY_CHAT_MAX_BYTES);
  });

  test("rejects an oversized identity and reports ownership without leaking rows", () => {
    const ownedChat = createChat(OWNER, { name: "owned" });
    const otherChat = createChat(OTHER, { name: "other" });
    expect(persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: ownedChat.id,
      generationId: "bad-target",
      targetMessageId: "x".repeat(300),
      snapshot: snapshot(),
    })).toBeNull();
    expect(ownsChatForActivity(OWNER, ownedChat.id)).toBe(true);
    expect(ownsChatForActivity(OTHER, ownedChat.id)).toBe(false);
    expect(listAgentActivityRuns(OTHER, ownedChat.id)).toEqual([]);
    expect(ownsChatForActivity(OTHER, otherChat.id)).toBe(true);
  });

  test("serves only the authenticated owner's bounded runs", async () => {
    const ownerChat = createChat(OWNER, { name: "owned" });
    const otherChat = createChat(OTHER, { name: "other" });
    persistTerminalAgentActivityRun({ userId: OWNER, chatId: ownerChat.id, generationId: "owner-run", snapshot: snapshot() });
    persistTerminalAgentActivityRun({ userId: OTHER, chatId: otherChat.id, generationId: "other-run", snapshot: snapshot() });

    const ownerResponse = await app.request(`http://localhost/${ownerChat.id}/agent-activity-runs`, { headers: { "x-test-user": OWNER } });
    expect(ownerResponse.status).toBe(200);
    expect((await ownerResponse.json()).runs.map((run: { generationId: string }) => run.generationId)).toEqual(["owner-run"]);

    const forbiddenResponse = await app.request(`http://localhost/${ownerChat.id}/agent-activity-runs`, { headers: { "x-test-user": OTHER } });
    expect(forbiddenResponse.status).toBe(404);
    const missingResponse = await app.request("http://localhost/missing-chat/agent-activity-runs", { headers: { "x-test-user": OWNER } });
    expect(missingResponse.status).toBe(404);
  });
});

describe("agent activity migration compatibility", () => {
  test("fresh bootstrap includes the fallback table and records its migration", async () => {
    const db = new Database(":memory:");
    try {
      await runMigrations(db);
      const columns = db.query("PRAGMA table_info(agent_activity_runs)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "user_id", "chat_id", "generation_id", "target_message_id", "target_swipe_id", "snapshot_json", "byte_size",
      ]));
      expect(db.query("SELECT name FROM _migrations WHERE name = ?").get("102_agent_activity_runs.sql")).toEqual({
        name: "102_agent_activity_runs.sql",
      });
      const chatForeignKey = (
        db.query("PRAGMA foreign_key_list(agent_activity_runs)").all() as Array<{
          from: string;
          table: string;
          on_delete: string;
        }>
      ).find((foreignKey) => foreignKey.from === "chat_id");
      expect(chatForeignKey?.table).toBe("chats");
      expect(chatForeignKey?.on_delete).toBe("CASCADE");

      db.run("PRAGMA foreign_keys = ON");
      db.query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(
        "fresh-owner",
        "Fresh Owner",
        "fresh-owner@example.test",
      );
      db.query(
        "INSERT INTO chats (id, name, metadata, user_id) VALUES (?, ?, ?, ?)",
      ).run("fresh-chat", "Fresh Chat", "{}", "fresh-owner");
      db.query(
        `INSERT INTO agent_activity_runs
          (user_id, chat_id, generation_id, snapshot_json, byte_size)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("fresh-owner", "fresh-chat", "fresh-generation", "{}", 2);
      db.query("DELETE FROM chats WHERE id = ?").run("fresh-chat");
      expect(
        db.query("SELECT COUNT(*) AS count FROM agent_activity_runs").get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

describe("agent activity serialization bounds", () => {
  test("always returns a bounded serialized DTO", () => {
    const result = __test__serializeAgentActivityRun({
      userId: OWNER,
      chatId: "chat",
      generationId: "generation",
      snapshot: snapshot("completed"),
    });
    expect(result).not.toBeNull();
    expect(result!.byteSize).toBeLessThanOrEqual(AGENT_ACTIVITY_RUN_MAX_BYTES);
  });
});
