import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { agentRunsRoutes } from "./agent-runs.routes";
import {
  appendAgentRunSnapshot,
  withAgentRunProjectionTransaction,
} from "../services/agent-run-projection.service";

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
});
