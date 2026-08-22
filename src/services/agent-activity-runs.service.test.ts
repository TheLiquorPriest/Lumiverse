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
  createAgentInspectionWriter,
  getAgentRunInspection,
  listAgentActivityRuns,
  ownsChatForActivity,
  persistAgentRunInspection,
  persistTerminalAgentActivityRun,
} from "./agent-activity-runs.service";
import { runMigrations } from "../db/migrate";
import type { AgentActivitySnapshotV1 } from "../types/agent-runtime";
import type { PersistAgentRunInspectionInputV1 } from "./agent-activity-runs.service";

import { createChat, createMessage, deleteMessage, deleteSwipe } from "./chats.service";

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
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "108_agent_run_projection.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "119_agent_inspection_source_retention.sql")).text());
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
function inspectionInput(
  chatId: string,
  overrides: Partial<PersistAgentRunInspectionInputV1> = {},
): PersistAgentRunInspectionInputV1 {
  return {
    userId: OWNER,
    chatId,
    attemptId: "inspection-attempt",
    runId: "inspection-run",
    turnSessionId: "inspection-turn",
    generationId: "inspection-generation",
    generationType: "normal",
    hostCorrelationId: "inspection-host",
    lifecycle: "TERMINAL",
    status: "terminal",
    outcome: "completed",
    ...overrides,
  };
}

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

describe("agent run inspection terminal persistence", () => {
  test("canonicalizes omitted optional transcript fields at the writer boundary", () => {
    const chat = createChat(OWNER, { name: "inspection-writer" });
    const writer = createAgentInspectionWriter({
      userId: OWNER,
      chatId: chat.id,
      attemptId: "writer-attempt",
      runId: "writer-run",
      turnSessionId: "writer-turn",
      generationId: "writer-generation",
      generationType: "normal",
      hostCorrelationId: "writer-host",
      lifecycle: "WORK",
      status: "running",
    });

    const detail = writer.record("provider_exchange", {
      kind: "provider_exchange",
      actor: "provider",
      recipient: "agent",
      content: "provider output",
      arguments: "{}",
      result: "{\"finishReason\":\"tool_calls\"}",
      provider: {
        adapter: "agentic-work",
        providerId: null,
        modelId: "deepseek-v4-flash",
        connectionRevision: null,
        fingerprint: null,
      },
      correlation: { parentId: "root" },
    });

    expect(detail?.transcript).toHaveLength(1);
    expect(detail?.transcript[0]).toMatchObject({
      kind: "provider_exchange",
      durationMs: null,
      late: false,
      errorReason: null,
    });
    expect(detail?.markers.some((marker) => marker.scope === "transcript")).toBe(false);
  });

  test("exposes a committed normal response separately from its input target", () => {
    const chat = createChat(OWNER, { name: "inspection-committed-target" });
    const writer = createAgentInspectionWriter({
      userId: OWNER,
      chatId: chat.id,
      attemptId: "committed-target-attempt",
      runId: "committed-target-run",
      turnSessionId: "committed-target-turn",
      generationId: "committed-target-generation",
      generationType: "normal",
      hostCorrelationId: "committed-target-host",
      lifecycle: "COMMIT",
      status: "waiting",
    });

    const detail = writer.record("terminal", {
      kind: "terminal",
      actor: "host",
      recipient: "owner",
    }, {
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "completed",
      reason: "none",
      terminalReceipt: {
        messageId: "committed-response-message",
        swipeId: 0,
      },
    });

    expect(detail?.target).toBeNull();
    expect(detail?.committedTarget).toEqual({
      messageId: "committed-response-message",
      swipeId: 0,
    });
  });

  test("stamps host correlation onto canonical usage evidence", () => {
    const chat = createChat(OWNER, { name: "inspection-usage-writer" });
    const writer = createAgentInspectionWriter({
      userId: OWNER,
      chatId: chat.id,
      attemptId: "usage-writer-attempt",
      runId: "usage-writer-run",
      turnSessionId: "usage-writer-turn",
      generationId: "usage-writer-generation",
      generationType: "normal",
      hostCorrelationId: "usage-writer-host",
      lifecycle: "WORK",
      status: "running",
    });

    const detail = writer.record("usage", {
      version: 1,
      id: "usage-writer-provider",
      source: "final",
      layer: "provider",
      correlation: { parentId: "root" },
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12,
      toolCalls: 0,
      childInvocations: 0,
      canonical: true,
    });

    expect(detail?.usageEvidence).toHaveLength(1);
    expect(detail?.usageEvidence[0]).toMatchObject({
      id: "usage-writer-provider",
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12,
      correlation: {
        turnSessionId: "usage-writer-turn",
        runId: "usage-writer-run",
        attemptId: "usage-writer-attempt",
        chatId: chat.id,
        generationId: "usage-writer-generation",
        hostCorrelationId: "usage-writer-host",
        parentId: "root",
        phase: "WORK",
      },
    });
    expect(detail?.markers.some((marker) => marker.scope === "usage")).toBe(false);
  });

  test("uses the authoritative Agent Run projection when no duplicate activity audit exists", () => {
    const chat = createChat(OWNER, { name: "inspection-projected-activity" });
    persistAgentRunInspection(inspectionInput(chat.id, {
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      startedAt: 100,
      updatedAt: 120,
    }));
    const snapshot = JSON.stringify({
      version: 2,
      runId: "inspection-run",
      turnId: "inspection-turn",
      generationId: "inspection-generation",
      chatId: chat.id,
      inspectionAttemptId: "inspection-attempt",
      activity: [{
        version: 2,
        id: "provider-round-1",
        parentId: null,
        kind: "provider",
        actor: "provider",
        phase: "WORK",
        status: "completed",
        startedAt: 101,
        elapsedMs: 9,
        roundIndex: 0,
      }],
    });
    getDb().query(
      `INSERT INTO agent_run_projections
        (user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
         target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
         snapshot_json, terminal_handoff_json, omission_json)
       VALUES (?, ?, ?, ?, 'normal', NULL, NULL, 'WORK', 'WORK', 1, 1, 100, 120, ?, NULL, ?)`,
    ).run(
      OWNER,
      chat.id,
      "inspection-turn",
      "inspection-generation",
      snapshot,
      JSON.stringify({
        omittedNodeCount: 0,
        omittedEventCount: 0,
        firstOmittedSequence: null,
        lastOmittedSequence: null,
      }),
    );

    const detail = getAgentRunInspection(OWNER, "inspection-attempt", chat.id);
    expect(detail?.activity.milestones).toEqual([
      expect.objectContaining({
        id: "projection:provider-round-1",
        kind: "provider",
        actor: "provider",
        phase: "WORK",
        status: "terminal",
        startedAt: 101,
        endedAt: 110,
        elapsedMs: 9,
      }),
    ]);
    expect(detail?.sectionAvailability.find((section) => section.section === "activity")?.state).toBe("available");
  });

  test("keeps terminal lifecycle and outcome while retaining late evidence", () => {
    const chat = createChat(OWNER, { name: "inspection" });
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      updatedAt: 100,
      terminalAt: 100,
    }))).not.toBeNull();

    const late = persistAgentRunInspection(inspectionInput(chat.id, {
      updatedAt: 200,
      transcript: [{
        id: "late-record",
        kind: "tool",
        actor: "tool",
        recipient: "agent",
        occurredAt: 90,
        hostSequence: 4,
        late: true,
        content: "late evidence",
        durationMs: null,
      }],
    }));

    expect(late?.lifecycle).toBe("TERMINAL");
    expect(late?.status).toBe("terminal");
    expect(late?.outcome).toBe("completed");
    expect(late?.transcript).toHaveLength(1);
    expect(late?.transcript[0]?.late).toBe(true);
    expect(late?.transcript[0]?.correlation.hostSequence).toBe(4);
    expect(late?.markers.map((marker) => marker.kind)).toContain("late_event");
  });

  test("deduplicates duplicate late records and their markers", () => {
    const chat = createChat(OWNER, { name: "inspection" });
    persistAgentRunInspection(inspectionInput(chat.id, { updatedAt: 100, terminalAt: 100 }));
    const lateRecord = {
      id: "duplicate-late",
      kind: "tool",
      actor: "tool",
      recipient: "agent",
      occurredAt: 90,
      hostSequence: 2,
      late: true,
      content: "first payload",
      durationMs: null,
    };
    persistAgentRunInspection(inspectionInput(chat.id, { transcript: [lateRecord] }));
    persistAgentRunInspection(inspectionInput(chat.id, {
      transcript: [{ ...lateRecord, content: "duplicate payload" }],
    }));

    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_audit_records WHERE user_id = ? AND attempt_id = ? AND record_kind = ?",
    ).get(OWNER, "inspection-attempt", "transcript")).toEqual({ count: 1 });
    const inspection = getAgentRunInspection(OWNER, "inspection-attempt", chat.id);
    expect(inspection?.transcript).toHaveLength(1);
    expect(inspection?.markers.filter((marker) => marker.kind === "late_event")).toHaveLength(1);
  });

  test("rejects an immutable identity mismatch without adding evidence", () => {
    const chat = createChat(OWNER, { name: "inspection" });
    persistAgentRunInspection(inspectionInput(chat.id, { updatedAt: 100, terminalAt: 100 }));

    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      runId: "different-run",
      transcript: [{ id: "rejected", kind: "tool", actor: "tool", late: true }],
    }))).toBeNull();
    expect(getAgentRunInspection(OWNER, "inspection-attempt", chat.id)?.transcript).toHaveLength(0);
  });

  test("refuses terminal lifecycle and outcome changes", () => {
    const chat = createChat(OWNER, { name: "inspection" });
    persistAgentRunInspection(inspectionInput(chat.id, { updatedAt: 100, terminalAt: 100 }));

    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      transcript: [{ id: "invalid-transition", kind: "tool", actor: "tool", late: true }],
    }))).toBeNull();
    const inspection = getAgentRunInspection(OWNER, "inspection-attempt", chat.id);
    expect(inspection?.lifecycle).toBe("TERMINAL");
    expect(inspection?.status).toBe("terminal");
    expect(inspection?.outcome).toBe("completed");
    expect(inspection?.transcript).toHaveLength(0);
  });
  test("projects complete owner detail with causal lineage while keeping private evidence out of compact activity", () => {
    const chat = createChat(OWNER, { name: "inspection-rich" });
    const target = createMessage(
      chat.id,
      { is_user: false, name: "Assistant", content: "stable target" },
      OWNER,
    );
    const correlation = {
      turnSessionId: "rich-turn",
      runId: "rich-run",
      attemptId: "rich-attempt",
      chatId: chat.id,
      generationId: "rich-generation",
      messageId: target.id,
      swipeId: 0,
      actorId: "agent",
      recipientId: "tool",
      phase: "WORK",
      taskId: "task-rich",
      toolId: "chat_search_history",
      parentId: null,
      hostCorrelationId: "inspection-host",
      hostSequence: 1,
    };
    const detail = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "rich-attempt",
      runId: "rich-run",
      turnSessionId: "rich-turn",
      generationId: "rich-generation",
      generationType: "swipe",
      targetMessageId: target.id,
      targetSwipeId: 0,
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      startedAt: 10,
      updatedAt: 20,
      transcript: [
        {
          id: "tool-request",
          kind: "tool",
          actor: "agent",
          recipient: "tool",
          occurredAt: 11,
          hostSequence: 2,
          late: false,
          content: null,
          arguments: "PRIVATE-TRANSCRIPT-PAYLOAD",
          result: null,
          durationMs: null,
          errorReason: null,
          correlation: { ...correlation, parentId: "prompt-1", hostSequence: 2 },
        },
        {
          id: "tool-result",
          kind: "tool",
          actor: "tool",
          recipient: "agent",
          occurredAt: 12,
          hostSequence: 3,
          late: false,
          content: null,
          arguments: null,
          result: "PRIVATE-TOOL-RESULT",
          durationMs: null,
          errorReason: null,
          correlation: {
            ...correlation,
            actorId: "tool",
            recipientId: "agent",
            parentId: "tool-request",
            hostSequence: 3,
          },
        },
      ],
      turnSession: [{
        id: "turn-input",
        kind: "input",
        occurredAt: 10,
        hostSequence: 1,
        detail: "PRIVATE-TURN-SESSION",
        transcriptRecordIds: ["tool-request"],
        correlation: { ...correlation, actorId: "owner", recipientId: "host", hostSequence: 1 },
      }],
      activity: [{
        id: "activity-tool",
        kind: "tool",
        actor: "tool",
        phase: "WORK",
        status: "running",
        parentId: null,
        label: "Search history",
        toolId: "chat_search_history",
        taskId: "task-rich",
        sequence: 2,
        startedAt: 11,
        endedAt: null,
        elapsedMs: null,
        usage: null,
        privatePayload: "PRIVATE-ACTIVITY-PAYLOAD",
        correlation: { ...correlation, actorId: "tool", hostSequence: 2 },
      }],
      promptEvidence: [{
        version: 1,
        id: "prompt-1",
        sourceId: "loom-block",
        sourceRevision: 3,
        destination: "root_work",
        role: "system",
        correlation: { ...correlation, hostSequence: 4 },
        included: true,
        content: "PRIVATE-PROMPT-PAYLOAD",
        contentDigest: "a".repeat(64),
        omissionReason: null,
      }],
      cortexReceipts: [{
        version: 1,
        id: "cortex-1",
        requestId: "cortex-request",
        attemptId: "rich-attempt",
        checkpoint: "WORK",
        snapshotId: "snapshot-1",
        sourceRevision: "source-revision-1",
        revision: "revision-1",
        scope: { chatId: chat.id, targetMessageId: target.id, targetSwipeId: 0 },
        required: true,
        startedAt: 13,
        completedAt: 14,
        state: "accepted",
        resultDigest: "cortex-digest",
        resultCount: 2,
        correlation: { ...correlation, actorId: "cortex", recipientId: "host", hostSequence: 5 },
        reason: null,
        omission: null,
        canonical: false,
      }],
      councilReceipts: [{
        version: 1,
        id: "council-1",
        requestId: "council-request",
        checkpoint: "WORK",
        required: false,
        startedAt: 15,
        completedAt: 16,
        state: "omitted",
        memberCount: 3,
        resultDigest: null,
        correlation: { ...correlation, actorId: "council", recipientId: "host", hostSequence: 6 },
        reason: "unavailable",
        canonical: false,
      }],
      workspaceAssociations: [{
        version: 1,
        id: "publication-1",
        workspaceId: "workspace-1",
        workspaceRevision: 8,
        relation: "published",
        objectKind: "publication",
        objectId: "publication-1",
        sourceRevision: 7,
        sourceDeleted: true,
        provenanceDigest: "publication-provenance",
        correlation: { ...correlation, actorId: "host", recipientId: "owner", hostSequence: 7 },
      }],
    }));

    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      attempt: {
        attemptId: "rich-attempt",
        target: {
          chatId: chat.id,
          generationType: "swipe",
          messageId: target.id,
          swipeId: 0,
        },
      },
      hostCorrelationId: "inspection-host",
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      target: { messageId: target.id, swipeId: 0 },
    });
    expect(detail!.transcript.map((entry) => entry.id)).toEqual(["tool-request", "tool-result"]);
    expect(detail!.transcript[1]!.correlation.parentId).toBe("tool-request");
    expect(detail!.transcript[1]!.correlation.hostSequence).toBe(3);
    expect(detail!.turnSession[0]!.detail).toBe("PRIVATE-TURN-SESSION");
    expect(detail!.promptEvidence[0]).toMatchObject({
      sourceId: "loom-block",
      destination: "root_work",
      content: "PRIVATE-PROMPT-PAYLOAD",
    });
    expect(detail!.cortexReceipts[0]!.resultDigest).toBe("cortex-digest");
    expect(detail!.councilReceipts[0]!.memberCount).toBe(3);
    expect(detail!.workspaceAssociations[0]!.sourceDeleted).toBe(true);
    expect(detail!.activity.milestones).toHaveLength(1);
    expect(detail!.activity.milestones[0]).not.toHaveProperty("privatePayload");
    expect(JSON.stringify(detail!.activity)).not.toContain("PRIVATE-");
  });

  test("retains recovered and terminal lineage while late and reordered evidence cannot mutate terminal state", () => {
    const chat = createChat(OWNER, { name: "inspection-recovered" });
    const recovered = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "recovered-attempt",
      runId: "recovered-run",
      turnSessionId: "recovered-turn",
      generationId: "recovered-generation",
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      reconciliation: "recovered",
      startedAt: 90,
      updatedAt: 100,
    }));
    expect(recovered).toMatchObject({
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      activity: { reconciliation: "recovered" },
    });

    const terminal = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "recovered-attempt",
      runId: "recovered-run",
      turnSessionId: "recovered-turn",
      generationId: "recovered-generation",
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "stopped",
      reason: "reconciled",
      reconciliation: "recovered",
      updatedAt: 120,
      terminalAt: 120,
      markers: [{
        id: "recovery-marker",
        kind: "recovered_duplicate",
        scope: "run",
        firstSequence: 4,
        lastSequence: 4,
        recoverable: true,
        detail: "recovered duplicate boundary",
      }],
    }));
    expect(terminal).toMatchObject({
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "stopped",
      terminalAt: 120,
      activity: { reconciliation: "recovered" },
    });

    const late = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "recovered-attempt",
      runId: "recovered-run",
      turnSessionId: "recovered-turn",
      generationId: "recovered-generation",
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "stopped",
      reason: "reconciled",
      transcript: [{
        id: "late-reordered-record",
        kind: "tool",
        actor: "tool",
        recipient: "agent",
        occurredAt: 80,
        hostSequence: 1,
        late: true,
        content: "late evidence",
        durationMs: null,
        correlation: { parentId: "recovery-marker", hostSequence: 1 },
      }],
    }));
    expect(late).toMatchObject({
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "stopped",
      terminalAt: 120,
    });
    expect(late!.transcript[0]!.late).toBe(true);
    expect(late!.markers.map((marker) => marker.kind)).toEqual(expect.arrayContaining([
      "recovered_duplicate",
      "late_event",
      "reordered_event",
    ]));
  });

  test("fails closed across owners and for malformed or unavailable audit sections", () => {
    const chat = createChat(OWNER, { name: "inspection-ownership" });
    const stored = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "owner-scoped-attempt",
      runId: "owner-scoped-run",
      turnSessionId: "owner-scoped-turn",
      generationId: "owner-scoped-generation",
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "failed",
      reason: "provider_failure",
      terminalReceipt: {
        error: {
          code: "provider_request_error",
          category: "provider",
          summaryCode: "agentRun.errors.provider_request_error",
          causalCode: "provider_timeout",
          authority: "provider",
          source: "provider",
          scope: "provider",
          capGate: {
            id: "provider-round",
            limit: 3,
            observed: 4,
            exceeded: true,
            authority: "host",
            source: "execution",
          },
          recoveryEligible: true,
          recoveryAction: "retry",
          omissionCount: 2,
        },
      },
      councilReceipts: [{
        version: 99,
        id: "malformed-council",
        secret: "SHOULD-NOT-LEAK",
      }],
      cortexReceipts: [{
        version: 99,
        id: "malformed-cortex",
        secret: "SHOULD-NOT-LEAK",
      }],
      markers: [
        {
          id: "prompt-withheld",
          kind: "credentials_withheld",
          scope: "prompt",
          firstSequence: null,
          lastSequence: null,
          recoverable: false,
          detail: "credentials withheld",
        },
        {
          id: "transcript-unavailable",
          kind: "unavailable",
          scope: "transcript",
          firstSequence: null,
          lastSequence: null,
          recoverable: false,
          detail: "transcript unavailable",
        },
      ],
    }));
    expect(stored).not.toBeNull();
    expect(getAgentRunInspection(OTHER, "owner-scoped-attempt", chat.id)).toBeNull();
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      userId: OTHER,
      attemptId: "foreign-attempt",
      runId: "foreign-run",
      turnSessionId: "foreign-turn",
      generationId: "foreign-generation",
    }))).toBeNull();
    expect(stored!.councilReceipts).toHaveLength(0);
    expect(stored!.cortexReceipts).toHaveLength(0);
    expect(stored!.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "credentials_withheld", scope: "prompt", recoverable: false }),
      expect.objectContaining({ kind: "unavailable", scope: "transcript", recoverable: false }),
      expect.objectContaining({ kind: "unavailable", scope: "council", recoverable: false }),
      expect.objectContaining({ kind: "unavailable", scope: "cortex", recoverable: false }),
    ]));
    expect(stored!.error).toMatchObject({
      code: "provider_request_error",
      category: "provider",
      summaryCode: "agentRun.errors.provider_request_error",
      causalCode: null,
      authority: "provider",
      source: "provider",
      scope: "provider",
      capGate: { id: "provider-round", limit: 3, observed: 4, exceeded: true },
      recoveryEligible: true,
      recoveryAction: "retry",
      omissionCount: 2,
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
    });
    expect(JSON.stringify(stored)).not.toContain("SHOULD-NOT-LEAK");
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "invalid-lifecycle",
      runId: "invalid-run",
      turnSessionId: "invalid-turn",
      generationId: "invalid-generation",
      lifecycle: "NOT_A_PHASE" as never,
    }))).toBeNull();
  });

  test("scrubs source-private evidence through owner deletion while retaining durable publication copies", () => {
    const chat = createChat(OWNER, { name: "inspection-source-deleted" });
    const target = createMessage(
      chat.id,
      { is_user: false, name: "Assistant", content: "source message" },
      OWNER,
    );
    getDb().query(
      "INSERT INTO persistent_workspaces (workspace_id, user_id, chat_id, objective) VALUES (?, ?, ?, ?)",
    ).run("workspace-durable", OWNER, chat.id, "Durable publication workspace");
    getDb().query(
      `INSERT INTO persistent_workspace_publications
        (publication_id, workspace_id, user_id, chat_id, category, source_id, source_revision,
         source_provenance_json, source_created_at, source_updated_at, source_deleted_at,
         copy_json, copy_digest, byte_count, published_at, published_by, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "publication-durable",
      "workspace-durable",
      OWNER,
      chat.id,
      "finding",
      "source-finding",
      1,
      JSON.stringify({ sourceMessageId: target.id, sourceSwipeId: 0 }),
      10,
      20,
      null,
      JSON.stringify({ summary: "durable publication copy" }),
      "a".repeat(64),
      32,
      20,
      `owner:${OWNER}`,
      1,
    );
    const detail = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "source-deleted-attempt",
      runId: "source-deleted-run",
      turnSessionId: "source-deleted-turn",
      generationId: "source-deleted-generation",
      targetMessageId: target.id,
      targetSwipeId: 0,
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "completed",
      transcript: [{
        id: "private-transcript",
        kind: "tool",
        actor: "agent",
        recipient: "tool",
        occurredAt: 10,
        late: false,
        content: "PRIVATE-SOURCE-TRANSCRIPT",
        arguments: null,
        result: null,
        durationMs: null,
        errorReason: null,
        correlation: { hostSequence: 1 },
      }],
      turnSession: [{
        id: "private-turn-session",
        kind: "input",
        occurredAt: 11,
        detail: "PRIVATE-SOURCE-TURN-SESSION",
        transcriptRecordIds: ["private-transcript"],
        correlation: { hostSequence: 2 },
      }],
      promptEvidence: [{
        version: 1,
        id: "private-prompt",
        sourceId: "loom-source",
        sourceRevision: 1,
        destination: "root_work",
        role: "system",
        correlation: { hostSequence: 3 },
        included: true,
        content: "PRIVATE-SOURCE-PROMPT",
        contentDigest: "b".repeat(64),
        omissionReason: null,
      }],
    }));
    expect(detail).not.toBeNull();
    expect(detail!.transcript[0]!.content).toBe("PRIVATE-SOURCE-TRANSCRIPT");
    expect(detail!.turnSession[0]!.detail).toBe("PRIVATE-SOURCE-TURN-SESSION");
    expect(detail!.promptEvidence[0]!.content).toBe("PRIVATE-SOURCE-PROMPT");

    expect(deleteMessage(OWNER, target.id)).toBe(true);
    const deleted = getAgentRunInspection(OWNER, "source-deleted-attempt", chat.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.transcript).toEqual([]);
    expect(deleted!.turnSession).toEqual([]);
    expect(deleted!.promptEvidence).toEqual([]);
    expect(deleted!.retry.allowed).toBe(false);
    expect(deleted!.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "transcript", kind: "unavailable", detail: "source_deleted" }),
      expect.objectContaining({ scope: "turn_session", kind: "unavailable", detail: "source_deleted" }),
      expect.objectContaining({ scope: "prompt", kind: "unavailable", detail: "source_deleted" }),
    ]));
    expect(deleted!.sectionAvailability).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "transcript", state: "source_deleted" }),
      expect.objectContaining({ section: "turn_session", state: "source_deleted" }),
      expect.objectContaining({ section: "prompt", state: "source_deleted" }),
    ]));
    expect(deleted!.error).toMatchObject({
      code: "agentRun.errors.source_deleted",
      recoveryEligible: false,
      recoveryAction: "none",
    });
    expect(JSON.stringify(deleted)).not.toContain("PRIVATE-SOURCE-");
    expect(getDb().query(
      "SELECT publication_id, source_deleted_at, copy_json FROM persistent_workspace_publications WHERE publication_id = ?",
    ).get("publication-durable")).toEqual({
      publication_id: "publication-durable",
      source_deleted_at: null,
      copy_json: JSON.stringify({ summary: "durable publication copy" }),
    });
    expect(deleteMessage(OWNER, target.id)).toBe(false);
  });
  test("scrubs inspection evidence for an exact deleted swipe without deleting its sibling", () => {
    const chat = createChat(OWNER, { name: "inspection-swipe-deleted" });
    const target = createMessage(
      chat.id,
      { is_user: false, name: "Assistant", content: "swipe zero" },
      OWNER,
    );
    getDb().query(
      "UPDATE messages SET content = ?, swipes = ?, swipe_dates = ?, swipe_id = 0 WHERE id = ?",
    ).run("swipe zero", JSON.stringify(["swipe zero", "swipe one"]), JSON.stringify([10, 11]), target.id);
    const detail = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "swipe-deleted-attempt",
      runId: "swipe-deleted-run",
      turnSessionId: "swipe-deleted-turn",
      generationId: "swipe-deleted-generation",
      targetMessageId: target.id,
      targetSwipeId: 0,
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "completed",
      transcript: [{
        id: "swipe-private-transcript",
        kind: "tool",
        actor: "agent",
        recipient: "tool",
        occurredAt: 10,
        late: false,
        content: "PRIVATE-SWIPE-TRANSCRIPT",
        arguments: null,
        result: null,
        durationMs: null,
        errorReason: null,
        correlation: { hostSequence: 1 },
      }],
    }));
    expect(detail).not.toBeNull();
    expect(deleteSwipe(OWNER, target.id, 0)).not.toBeNull();
    const deleted = getAgentRunInspection(OWNER, "swipe-deleted-attempt", chat.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.transcript).toEqual([]);
    expect(deleted!.sectionAvailability).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "transcript", state: "source_deleted" }),
    ]));
    expect(JSON.stringify(deleted)).not.toContain("PRIVATE-SWIPE-");
    expect(getDb().query("SELECT swipes, swipe_id FROM messages WHERE id = ?").get(target.id)).toEqual({
      swipes: JSON.stringify(["swipe one"]),
      swipe_id: 0,
    });
  });
  test("projects layered usage without counting recovered duplicates or provisional evidence twice", () => {
    const chat = createChat(OWNER, { name: "inspection-usage" });
    const detail = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "usage-attempt",
      runId: "usage-run",
      turnSessionId: "usage-turn",
      generationId: "usage-generation",
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "completed",
      usageEvidence: [
        {
          id: "root-provisional",
          source: "provisional",
          layer: "root",
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          toolCalls: 0,
          childInvocations: 0,
          canonical: false,
          correlation: { hostSequence: 1 },
        },
        {
          id: "root-final",
          source: "final",
          layer: "root",
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          toolCalls: 1,
          childInvocations: 1,
          canonical: true,
          correlation: { hostSequence: 2 },
        },
        {
          id: "root-recovered",
          source: "recovered_duplicate",
          layer: "root",
          inputTokens: 900,
          outputTokens: 900,
          totalTokens: 1800,
          toolCalls: 99,
          childInvocations: 99,
          canonical: false,
          correlation: { hostSequence: 3 },
        },
        {
          id: "tool-final",
          source: "final",
          layer: "tool",
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          toolCalls: 4,
          childInvocations: 0,
          canonical: true,
          correlation: { hostSequence: 4 },
        },
      ],
    }));
    expect(detail).not.toBeNull();
    expect(detail!.usageEvidence).toHaveLength(4);
    expect(detail!.usage.totals).toMatchObject({
      inputTokens: 12,
      outputTokens: 23,
      totalTokens: 35,
      toolCalls: 5,
      childInvocations: 1,
    });
    expect(detail!.usage.evidenceCount).toBe(4);
    expect(detail!.usage.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        layer: "root",
        source: "final",
        evidenceIds: expect.arrayContaining(["root-final"]),
        canonical: true,
      }),
      expect.objectContaining({
        layer: "tool",
        source: "final",
        evidenceIds: ["tool-final"],
        canonical: true,
      }),
    ]));
    expect(JSON.stringify(detail!.usage)).not.toContain("root-recovered");
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
