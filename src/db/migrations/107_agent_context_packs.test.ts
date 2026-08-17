import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

const baselineSql = await Bun.file(join(import.meta.dir, "..", "baseline.sql")).text();
const migrationSql = await Bun.file(join(import.meta.dir, "107_agent_context_packs.sql")).text();

function createDatabase(): Database {
  const db = new Database(":memory:");
  db.run(baselineSql);
  db.run(migrationSql);
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

describe("107_agent_context_packs revision history", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase();
    db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run("u1", "Context owner", "u1@example.test");
    db.query(
      `INSERT INTO agent_context_packs
       (user_id, id, name, description, visibility, state, latest_revision, provenance_json)
       VALUES (?, ?, ?, ?, 'private', 'review_required', 1, '{}')`,
    ).run("u1", "pack-1", "Imported", "Review me");
  });

  afterEach(() => db.close());

  test("permits an active reviewed copy to retain the original digest", () => {
    const digest = "a".repeat(64);
    const insert = db.query(
      `INSERT INTO agent_context_pack_revisions
       (user_id, pack_id, revision, content_json, content_digest, token_count, byte_count, state, provenance_json, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("u1", "pack-1", 1, "[]", digest, 0, 2, "review_required", "{}", "u1");
    expect(() => insert.run("u1", "pack-1", 2, "[]", digest, 0, 2, "active", "{}", "u1")).not.toThrow();
    expect(db.query(
      "SELECT revision, state, content_digest FROM agent_context_pack_revisions WHERE user_id = ? AND pack_id = ? ORDER BY revision",
    ).all("u1", "pack-1")).toEqual([
      { revision: 1, state: "review_required", content_digest: digest },
      { revision: 2, state: "active", content_digest: digest },
    ]);
    expect(() => insert.run("u1", "pack-1", 1, "[]", digest, 0, 2, "active", "{}", "u1")).toThrow();
  });
});
