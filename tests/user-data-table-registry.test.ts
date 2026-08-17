import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  ARCHIVE_CANONICAL_TABLES,
  ARCHIVE_TABLE_REGISTRY,
  assertArchiveRegistryCoverage,
  getArchiveTableSpec,
  getCanonicalImportOrder,
  buildArchiveOwnerPredicate,
  getArchiveVectorTables,
} from "../src/services/user-data/table-registry";

describe("archive table registry", () => {
  test("classifies the current archive-sensitive table families exactly once", () => {
    const names = ARCHIVE_TABLE_REGISTRY.map((spec) => spec.table);
    expect(new Set(names).size).toBe(names.length);
    expect(getArchiveTableSpec("audio_files")?.kind).toBe("canonical");
    expect(getArchiveTableSpec("agent_context_packs")?.kind).toBe("canonical");
    expect(getArchiveTableSpec("agent_context_pack_revisions")?.parentEdges.some((edge) => edge.columns?.length === 2)).toBe(true);
    expect(getArchiveTableSpec("agent_run_projections")?.kind).toBe("operational");
    expect(getArchiveTableSpec("agent_activity_runs")?.kind).toBe("operational");
    expect(getArchiveTableSpec("multiplayer_rooms")?.kind).toBe("operational");
    expect(getArchiveTableSpec("user_data_import_receipts")?.kind).toBe("operational");
    expect(getArchiveTableSpec("sso_providers")?.kind).toBe("forbidden");
    expect(getArchiveTableSpec("characters_fts_data")?.kind).toBe("forbidden");
    expect(getArchiveTableSpec("stream_deck_tokens")?.kind).toBe("forbidden");
    expect(getArchiveVectorTables()).toEqual(["embeddings_world_books", "embeddings"]);
    const themeFileRef = getArchiveTableSpec("theme_assets")?.fileRefs[0];
    expect(themeFileRef?.applies?.({ storage_type: "file", file_name: "theme.css" })).toBe(true);
    expect(themeFileRef?.applies?.({ storage_type: "url", file_name: "theme.css" })).toBe(false);
  });
  test("rejects both unclassified and missing required schema tables", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE rogue_archive_table (id TEXT PRIMARY KEY)");
    expect(() => assertArchiveRegistryCoverage(db)).toThrow(/unclassified=rogue_archive_table/);
    expect(() => assertArchiveRegistryCoverage(db)).toThrow(/missing=.*audio_files/);
    db.close();
  });
  test("registers the migrated Weaver people table with account and session edges", () => {
    const spec = getArchiveTableSpec("weaver_people");
    expect(spec?.kind).toBe("canonical");
    expect(spec?.owner).toMatchObject({ kind: "direct", column: "user_id" });
    expect(spec?.primaryKey).toEqual(["id"]);
    expect(spec?.uniqueKeys).toEqual([["id"]]);
    expect(spec?.parentEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        column: "user_id",
        parentTable: "user",
        parentColumn: "id",
        nullable: false,
        onMissing: "reject",
      }),
      expect.objectContaining({
        column: "session_id",
        parentTable: "weaver_sessions",
        parentColumn: "id",
        nullable: false,
        onMissing: "reject",
      }),
    ]));
    const order = getCanonicalImportOrder();
    expect(order.indexOf("weaver_sessions")).toBeLessThan(order.indexOf("weaver_people"));
  });
  test("computes parent-first order from declared canonical edges", () => {
    const order = getCanonicalImportOrder();
    const positions = new Map(order.map((table, index) => [table, index]));
    for (const spec of ARCHIVE_CANONICAL_TABLES) {
      const childPosition = positions.get(spec.table);
      expect(childPosition).toBeDefined();
      for (const edge of spec.parentEdges) {
        if (edge.deferred || edge.parentTable === spec.table) continue;
        const parentSpec = getArchiveTableSpec(edge.parentTable);
        if (parentSpec?.kind !== "canonical") continue;
        expect(positions.get(edge.parentTable)!).toBeLessThan(childPosition!);
      }
    }
  });

  test("builds nested parent ownership predicates without leaking another user", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE users (id TEXT PRIMARY KEY)");
    db.run("CREATE TABLE user_data_imports (job_id TEXT PRIMARY KEY, user_id TEXT NOT NULL)");
    db.run("CREATE TABLE user_data_import_files (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, archive_path TEXT NOT NULL)");
    db.run("INSERT INTO users (id) VALUES ('alice'), ('bob')");
    db.run("INSERT INTO user_data_imports (job_id, user_id) VALUES ('job-a', 'alice'), ('job-b', 'bob')");
    db.run("INSERT INTO user_data_import_files (id, job_id, archive_path) VALUES (1, 'job-a', 'alice-file'), (2, 'job-b', 'bob-file')");

    const spec = getArchiveTableSpec("user_data_import_files");
    expect(spec).toBeDefined();
    const predicate = buildArchiveOwnerPredicate(spec!, "alice", '"user_data_import_files"');
    expect(predicate).toBeDefined();
    const rows = db
      .query(`SELECT archive_path FROM user_data_import_files WHERE ${predicate!.sql}`)
      .all(...predicate!.params) as { archive_path: string }[];
    expect(rows).toEqual([{ archive_path: "alice-file" }]);
    db.close();
  });

  test("builds predicate-owned extension filters as executable SQL", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE extensions (id TEXT PRIMARY KEY, installed_by_user_id TEXT, install_scope TEXT)");
    db.run("INSERT INTO extensions VALUES ('user-ext', 'alice', 'user'), ('operator-ext', 'alice', 'operator'), ('other-ext', 'bob', 'user')");

    const spec = getArchiveTableSpec("extensions");
    expect(spec).toBeDefined();
    const predicate = buildArchiveOwnerPredicate(spec!, "alice", '"extensions"');
    expect(predicate).toBeDefined();
    const rows = db
      .query(`SELECT id FROM extensions WHERE ${predicate!.sql}`)
      .all(...predicate!.params) as { id: string }[];
    expect(rows).toEqual([{ id: "user-ext" }]);
    db.close();
  });
});
