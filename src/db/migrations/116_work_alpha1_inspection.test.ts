import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const baselineSql = await Bun.file(join(import.meta.dir, "..", "baseline.sql")).text();
const migration106Sql = await Bun.file(join(import.meta.dir, "106_agent_turn_workspace.sql")).text();
const migration116Sql = await Bun.file(join(import.meta.dir, "116_work_alpha1_inspection.sql")).text();

function createPre116Database(): Database {
  const db = new Database(":memory:");
  db.run(baselineSql);
  db.run(migration106Sql);
  db.run("PRAGMA foreign_keys = ON");

  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)")
    .run("u1", "Test", "u1@example.test");
  db.query("INSERT INTO characters (id, name) VALUES (?, ?)")
    .run("character-1", "Character");
  db.query("INSERT INTO chats (id, user_id, character_id) VALUES (?, ?, ?)")
    .run("chat-1", "u1", "character-1");

  return db;
}

function insertExecution(
  db: Database,
  id: string,
  state: "FAILED" | "TIMED_OUT" | "EXHAUSTED",
  terminalCode: string,
): void {
  db.query(
    `INSERT INTO agent_turn_executions
      (id, user_id, chat_id, generation_id, target_kind, target_chat_revision,
       mode, runtime_epoch, deadline_at, state, root_ledger_json,
       frame_capabilities_json, commit_key, expires_at, terminal_code,
       created_at, updated_at, terminal_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    "u1",
    "chat-1",
    `generation-${id}`,
    "normal",
    0,
    "agentic",
    1,
    2_000_000_000,
    state,
    "{}",
    "{}",
    `commit-${id}`,
    2_000_000_000,
    terminalCode,
    100,
    200,
    300,
  );
}

describe("116 work alpha1 inspection migration", () => {
  test("maps timeout states and root wall-clock deadlines to failed while preserving budget exhaustion", () => {
    const db = createPre116Database();
    try {
      insertExecution(db, "execution-timed-out", "TIMED_OUT", "timed_out");
      insertExecution(db, "execution-root-deadline", "FAILED", "root_wall_clock_limit_exceeded");
      insertExecution(db, "execution-exhausted", "EXHAUSTED", "agentic_work_exhausted");

      db.run(migration116Sql);

      expect(db.query(
        "SELECT outcome, reason FROM agent_run_attempts WHERE attempt_id = ?",
      ).get("execution-timed-out")).toEqual({ outcome: "failed", reason: "timed_out" });
      expect(db.query(
        "SELECT outcome, reason FROM agent_run_attempts WHERE attempt_id = ?",
      ).get("execution-root-deadline")).toEqual({ outcome: "failed", reason: "root_wall_clock_limit_exceeded" });
      expect(db.query(
        "SELECT outcome, reason FROM agent_run_attempts WHERE attempt_id = ?",
      ).get("execution-exhausted")).toEqual({ outcome: "exhausted", reason: "agentic_work_exhausted" });
    } finally {
      db.close();
    }
  });
});
