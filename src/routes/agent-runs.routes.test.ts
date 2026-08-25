import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { agentRunsRoutes } from "./agent-runs.routes";
import {
  appendAgentRunSnapshot,
  withAgentRunProjectionTransaction,
} from "../services/agent-run-projection.service";
import {
  AGENT_RUN_INSPECTION_MAX_CURSOR_BYTES,
  persistAgentRunInspection,
} from "../services/agent-activity-runs.service";

const OWNER = "route-owner";
const OTHER = "route-other";
const app = new Hono();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  await next();
});
app.route("/agent-runs", agentRunsRoutes);

function seedUser(userId: string): void {
  getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(userId, userId, `${userId}@example.test`);
}

function seedChat(userId: string, chatId: string): void {
  getDb().query("INSERT INTO chats (id, name, metadata, user_id) VALUES (?, ?, '{}', ?)").run(chatId, chatId, userId);
}

function seedRun(userId: string, chatId: string, turnId: string): void {
  getDb().query(
    `INSERT INTO agent_turn_executions
      (id, user_id, chat_id, generation_id, target_kind, target_chat_revision,
       mode, runtime_epoch, deadline_at, state, root_ledger_json,
       frame_capabilities_json, commit_key, expires_at)
     VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999,
             'WORK', '{}', '{}', ?, 9999999999)`,
  ).run(turnId, userId, chatId, turnId, `commit-${turnId}`);
}

// Chat cursors fail closed without an application auth secret, so the route
// suite configures one exactly as startup identity derivation does.
const TEST_AUTH_SECRET = "agent-runs-routes-test-auth-secret";
let priorProcessAuthSecret: string | undefined;

beforeEach(async () => {
  priorProcessAuthSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = TEST_AUTH_SECRET;
  closeDatabase();
  initDatabase(":memory:");
  await runMigrations(getDb());
  seedUser(OWNER);
  seedUser(OTHER);
});

afterEach(() => {
  if (priorProcessAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = priorProcessAuthSecret;
  closeDatabase();
});

describe("authenticated Agentic run routes", () => {
  test("returns cursor changes only for the chat owner and serves exact status", async () => {
    seedChat(OWNER, "route-chat");
    seedRun(OWNER, "route-chat", "route-turn");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      userId: OWNER,
      chatId: "route-chat",
      turnId: "route-turn",
      generationId: "route-turn",
      generationType: "normal",
      status: "WORK",
    }));

    const changes = await app.request("http://localhost/agent-runs/changes/route-chat", {
      headers: { "x-test-user": OWNER },
    });
    expect(changes.status).toBe(200);
    const body = await changes.json() as { resync: boolean; runs: unknown[]; cursor: { version: number; token: string } };
    expect(body.resync).toBe(true);
    expect(body.runs).toHaveLength(1);
    expect(body.cursor.version).toBe(1);
    expect(body.cursor.token).not.toContain("route-owner");

    const status = await app.request("http://localhost/agent-runs/status/route-turn", {
      headers: { "x-test-user": OWNER },
    });
    expect(status.status).toBe(200);
    expect((await status.json()).turnId).toBe("route-turn");

    const forbidden = await app.request("http://localhost/agent-runs/status/route-turn", {
      headers: { "x-test-user": OTHER },
    });
    expect(forbidden.status).toBe(404);
  });

  test("exact root Stop never broadens to another chat and is idempotent", async () => {
    seedChat(OWNER, "route-stop-chat");
    seedChat(OWNER, "route-other-chat");
    seedRun(OWNER, "route-stop-chat", "route-stop-turn");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      userId: OWNER,
      chatId: "route-stop-chat",
      turnId: "route-stop-turn",
      generationId: "route-stop-turn",
      generationType: "normal",
      status: "WORK",
    }));

    const accepted = await app.request("http://localhost/agent-runs/route-stop-turn/stop", {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "route-stop-chat", root_id: "route-stop-turn" }),
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).status).toBe("accepted");

    const terminal = await app.request("http://localhost/agent-runs/route-stop-turn/stop", {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "route-stop-chat", root_id: "route-stop-turn" }),
    });
    expect((await terminal.json()).status).toBe("terminal");

    const wrongRoot = await app.request("http://localhost/agent-runs/route-stop-turn/stop", {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "route-stop-chat", root_id: "other-root" }),
    });
    expect(wrongRoot.status).toBe(404);
  });
  test("rejects malformed optional IDs instead of ignoring them", async () => {
    seedChat(OWNER, "route-invalid-chat");
    seedRun(OWNER, "route-invalid-chat", "route-invalid-turn");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      userId: OWNER,
      chatId: "route-invalid-chat",
      turnId: "route-invalid-turn",
      generationId: "route-invalid-turn",
      generationType: "normal",
      status: "WORK",
    }));

    const wrongTyped = await app.request("http://localhost/agent-runs/route-invalid-turn/stop", {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 123 }),
    });
    expect(wrongTyped.status).toBe(400);

    const conflictingAliases = await app.request(
      "http://localhost/agent-runs/status/route-invalid-turn?chatId=route-invalid-chat&chat_id=other-chat",
      { headers: { "x-test-user": OWNER } },
    );
    expect(conflictingAliases.status).toBe(400);
  });

  test("derives stable workspace identity from authenticated chat scope and fences CAS writes", async () => {
    seedChat(OWNER, "route-workspace-chat");
    seedChat(OWNER, "route-other-chat");
    seedChat(OTHER, "route-other-owner-chat");

    const createdResponse = await app.request("http://localhost/agent-runs/workspace?chat_id=route-workspace-chat", {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({
        userId: OTHER,
        chatId: "route-other-owner-chat",
        workspaceId: "client-forged-workspace",
        objective: "Stable route workspace",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string; userId: string; chatId: string | null; objective: string; revision: number };
    expect(created).toMatchObject({ userId: OWNER, chatId: "route-workspace-chat", objective: "Stable route workspace", revision: 0 });

    const replayResponse = await app.request("http://localhost/agent-runs/workspace?chat_id=route-workspace-chat", {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: OTHER,
        chat_id: "route-other-owner-chat",
        workspace_id: "another-client-workspace",
        objective: "A later turn cannot replace it",
        authority: { kind: "host" },
      }),
    });
    expect(replayResponse.status).toBe(201);
    const replay = await replayResponse.json() as { id: string; objective: string };
    expect(replay).toMatchObject({ id: created.id, objective: "Stable route workspace" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspaces WHERE user_id = ? AND chat_id = ?").get(OWNER, "route-workspace-chat")).toEqual({ count: 1 });

    const ownerRead = await app.request(`http://localhost/agent-runs/workspace/${created.id}?chat_id=route-workspace-chat`, {
      headers: { "x-test-user": OWNER },
    });
    expect(ownerRead.status).toBe(200);
    expect((await ownerRead.json()).id).toBe(created.id);

    const wrongChatRead = await app.request(`http://localhost/agent-runs/workspace/${created.id}?chat_id=route-other-chat`, {
      headers: { "x-test-user": OWNER },
    });
    expect(wrongChatRead.status).toBe(404);
    const wrongOwnerRead = await app.request(`http://localhost/agent-runs/workspace/${created.id}`, {
      headers: { "x-test-user": OTHER },
    });
    expect(wrongOwnerRead.status).toBe(404);

    const firstWrite = await app.request(`http://localhost/agent-runs/workspace/${created.id}`, {
      method: "PATCH",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({
        userId: OTHER,
        chatId: "route-other-chat",
        workspaceId: "forged-workspace",
        expectedRevision: 0,
        objective: "Owner update",
      }),
    });
    expect(firstWrite.status).toBe(200);
    expect((await firstWrite.json()).revision).toBe(1);

    const staleWrite = await app.request(`http://localhost/agent-runs/workspace/${created.id}`, {
      method: "PATCH",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, objective: "Lost update" }),
    });
    expect(staleWrite.status).toBe(409);
    expect((await staleWrite.json()).error.reason).toBe("stale_workspace_revision");

    const optionalTask = await app.request(`http://localhost/agent-runs/workspace/${created.id}/tasks`, {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        title: "Owner optional task",
        required: false,
        creator: "host",
        hostAdmitted: true,
      }),
    });
    expect(optionalTask.status).toBe(201);
    expect((await optionalTask.json())).toMatchObject({ required: false, creator: "owner", hostAdmitted: false });

    const forgedRequiredTask = await app.request(`http://localhost/agent-runs/workspace/${created.id}/tasks`, {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 2,
        title: "Forged required task",
        required: true,
        creator: "host",
        hostAdmitted: true,
      }),
    });
    expect(forgedRequiredTask.status).toBe(403);
  });

  test("exposes session reads without an owner mutation route", async () => {
    seedChat(OWNER, "route-session-chat");
    const createdResponse = await app.request("http://localhost/agent-runs/workspace?chat_id=route-session-chat", {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ objective: "Session route workspace" }),
    });
    const created = await createdResponse.json() as { id: string };

    const sessions = await app.request(`http://localhost/agent-runs/workspace/${created.id}/sessions?limit=1&offset=0`, {
      headers: { "x-test-user": OWNER },
    });
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toEqual({ data: [], total: 0, limit: 1, offset: 0 });
    for (const offset of ["-1", "100001", "9007199254740992", "12junk"]) {
      const invalidPage = await app.request(
        `http://localhost/agent-runs/workspace/${created.id}/sessions?limit=1&offset=${offset}`,
        { headers: { "x-test-user": OWNER } },
      );
      expect(invalidPage.status).toBe(400);
      expect((await invalidPage.json()).error.reason).toBe("invalid_workspace_sessions_page");
    }
    const boundary = await app.request(
      `http://localhost/agent-runs/workspace/${created.id}/sessions?limit=1&offset=100000`,
      { headers: { "x-test-user": OWNER } },
    );
    expect(boundary.status).toBe(200);
    expect(await boundary.json()).toEqual({ data: [], total: 0, limit: 1, offset: 100000 });


    const mutation = await app.request(`http://localhost/agent-runs/workspace/${created.id}/sessions`, {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ status: "terminal", phase: "TERMINAL", outcome: "completed" }),
    });
    expect(mutation.status).toBe(404);
  });

  test("serves owner-scoped inspection detail and keeps malformed or foreign requests private", async () => {
    seedChat(OWNER, "route-inspection-chat");
    seedChat(OTHER, "route-other-inspection-chat");
    const detail = persistAgentRunInspection({
      userId: OWNER,
      chatId: "route-inspection-chat",
      attemptId: "route-inspection-attempt",
      runId: "route-inspection-run",
      turnSessionId: "route-inspection-turn",
      generationId: "route-inspection-generation",
      generationType: "normal",
      hostCorrelationId: "route-inspection-host",
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "failed",
      reason: "provider_failure",
      transcript: [{
        id: "route-private-transcript",
        kind: "tool",
        actor: "agent",
        recipient: "tool",
        hostSequence: 1,
        occurredAt: 1,
        late: false,
        content: null,
        arguments: "PRIVATE-ROUTE-TRANSCRIPT",
        result: null,
        durationMs: null,
        correlation: { parentId: null, hostSequence: 1 },
      }],
      activity: [{
        id: "route-compact-activity",
        kind: "tool",
        actor: "tool",
        phase: "TERMINAL",
        status: "terminal",
        parentId: null,
        label: "Completed tool",
        toolId: null,
        taskId: null,
        sequence: 1,
        startedAt: 1,
        endedAt: 2,
        elapsedMs: 1,
        privatePayload: "PRIVATE-ROUTE-ACTIVITY",
        correlation: { hostSequence: 1 },
      }],
    });
    expect(detail).not.toBeNull();

    const ownerResponse = await app.request(
      "http://localhost/agent-runs/route-inspection-attempt/inspection?chatId=route-inspection-chat",
      { headers: { "x-test-user": OWNER } },
    );
    expect(ownerResponse.status).toBe(200);
    const ownerBody = await ownerResponse.json() as {
      runId: string;
      turnSessionId: string;
      generationId: string;
      attempt: { attemptId: string };
      transcript: Array<{ arguments: string | null }>;
      activity: { milestones: Array<Record<string, unknown>> };
    };
    expect(ownerBody.attempt.attemptId).toBe("route-inspection-attempt");
    expect(ownerBody.runId).toBe("route-inspection-run");
    expect(ownerBody.turnSessionId).toBe("route-inspection-turn");
    expect(ownerBody.generationId).toBe("route-inspection-generation");
    expect(ownerBody.transcript[0]?.arguments).toBe("PRIVATE-ROUTE-TRANSCRIPT");
    expect(ownerBody.activity.milestones[0]).not.toHaveProperty("privatePayload");
    expect(JSON.stringify(ownerBody.activity)).not.toContain("PRIVATE-ROUTE");

    const foreignResponse = await app.request(
      "http://localhost/agent-runs/route-inspection-attempt/inspection?chatId=route-inspection-chat",
      { headers: { "x-test-user": OTHER } },
    );
    expect(foreignResponse.status).toBe(404);

    const wrongChatResponse = await app.request(
      "http://localhost/agent-runs/route-inspection-attempt/inspection?chatId=route-other-inspection-chat",
      { headers: { "x-test-user": OWNER } },
    );
    expect(wrongChatResponse.status).toBe(404);

    const conflictingAliases = await app.request(
      "http://localhost/agent-runs/route-inspection-attempt/inspection?chatId=route-inspection-chat&chat_id=route-other-inspection-chat",
      { headers: { "x-test-user": OWNER } },
    );
    expect(conflictingAliases.status).toBe(400);
  });
  test("serves inspection pages through emitted keyset cursors and rejects legacy or oversized cursors", async () => {
    seedChat(OWNER, "route-inspection-pagination-chat");
    for (const attemptId of ["route-page-01", "route-page-02", "route-page-03"]) {
      expect(persistAgentRunInspection({
        userId: OWNER,
        chatId: "route-inspection-pagination-chat",
        attemptId,
        runId: `${attemptId}-run`,
        turnSessionId: `${attemptId}-turn`,
        generationId: `${attemptId}-generation`,
        generationType: "normal",
        hostCorrelationId: `${attemptId}-host`,
        lifecycle: "TERMINAL",
        status: "terminal",
        outcome: "completed",
        reason: "none",
        updatedAt: 1,
        terminalAt: 1,
      })).not.toBeNull();
    }

    const first = await app.request(
      "http://localhost/agent-runs/inspection?chatId=route-inspection-pagination-chat&limit=1",
      { headers: { "x-test-user": OWNER } },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      runs: Array<{ attempt: { attemptId: string } }>;
      nextCursor: string | null;
    };
    expect(firstBody.runs.map((run) => run.attempt.attemptId)).toEqual(["route-page-03"]);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await app.request(
      `http://localhost/agent-runs/inspection?chatId=route-inspection-pagination-chat&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: { "x-test-user": OWNER } },
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json() as {
      runs: Array<{ attempt: { attemptId: string } }>;
      nextCursor: string | null;
    };
    expect(secondBody.runs.map((run) => run.attempt.attemptId)).toEqual(["route-page-02"]);
    expect(secondBody.nextCursor).toEqual(expect.any(String));

    const third = await app.request(
      `http://localhost/agent-runs/inspection?chatId=route-inspection-pagination-chat&limit=1&cursor=${encodeURIComponent(secondBody.nextCursor!)}`,
      { headers: { "x-test-user": OWNER } },
    );
    expect(third.status).toBe(200);
    const thirdBody = await third.json() as {
      runs: Array<{ attempt: { attemptId: string } }>;
      nextCursor: string | null;
    };
    expect(thirdBody.runs.map((run) => run.attempt.attemptId)).toEqual(["route-page-01"]);
    expect(thirdBody.nextCursor).toBeNull();

    const legacy = await app.request(
      "http://localhost/agent-runs/inspection?chatId=route-inspection-pagination-chat&limit=1&cursor=100000",
      { headers: { "x-test-user": OWNER } },
    );
    expect(legacy.status).toBe(400);

    const oversized = await app.request(
      `http://localhost/agent-runs/inspection?chatId=route-inspection-pagination-chat&limit=1&cursor=${encodeURIComponent(`v1.${"a".repeat(AGENT_RUN_INSPECTION_MAX_CURSOR_BYTES)}`)}`,
      { headers: { "x-test-user": OWNER } },
    );
    expect(oversized.status).toBe(400);
  });
});
