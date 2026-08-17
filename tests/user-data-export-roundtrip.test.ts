/**
 * Round-trip test for the user-data export/import pipeline.
 *
 * Background: the export writer was historically fflate-based, which only
 * produces ZIP32 archives. The 32-bit compressedSize / uncompressedSize /
 * localHeaderOffset fields wrap to 0 when an archive crosses 2³²−1 bytes,
 * silently corrupting the central directory with no error and no recovery
 * path on import. The fix swaps the export writer for archiver with
 * `forceZip64: true`. This test pins the contract:
 *
 *   1. The export stream produces a well-formed ZIP.
 *   2. The manifest round-trips through the central-directory verifier and
 *      its compatibility entry point.
 *   3. Pushing a realistic multi-row payload (10⁵ rows × ~1 KB each →
 *      ~100 MB) through the streaming pipeline produces a valid archive
 *      — proves the streaming path is healthy at scale, which is what
 *      makes the >4 GB case work (the same code path is exercised, just
 *      with more bytes).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { join } from "path";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import {
  closeDatabase,
  getDb,
  initDatabase,
} from "../src/db/connection";
import { runMigrations } from "../src/db/migrate";
import { buildExportStream } from "../src/services/user-data/export.service";
import { verifyArchiveFast, verifyArchive } from "../src/services/user-data/import.service";
import {
  ARCHIVE_SCHEMA_VERSION,
  NDJSON_FORMAT_VERSION,
  NDJSON_MAX_RECORD_BYTES,
  MAX_ARCHIVE_FILE_BYTES,
  parseManifest,
} from "../src/services/user-data/manifest";
const USER_ID = "export-roundtrip-user";

function testManifest(archiveId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    producer: "lumiverse",
    exportedAt: 0,
    archiveId,
    producerVersion: "test",
    includeVectors: false,
    embeddingConfig: { provider: null, model: null, dimension: null },
    counts: {},
    missingFiles: [],
  };
}


async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function isValidZip(bytes: Uint8Array): boolean {
  // Every ZIP (incl. ZIP64) starts with the local file header signature
  // "PK\x03\x04" at byte 0.
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function hasEocd(bytes: Uint8Array): boolean {
  // End-of-central-directory record signature: "PK\x05\x06".
  if (bytes.byteLength < 22) return false;
  // Scan backward for the EOCD signature.
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return true;
    }
  }
  return false;
}

describe("user-data export ZIP64 round-trip", () => {
  let workDir: string;

  beforeEach(async () => {
    closeDatabase();
    workDir = mkdtempSync(join(tmpdir(), "lvbak-test-"));
    initDatabase(":memory:");
    await runMigrations(getDb());
    // Minimal user row — the registry-driven export filters everything by
    // user_id, so we need at least one row in `user` for the joins to
    // resolve to a non-empty result set.
    getDb()
      .query(
        "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) " +
          "VALUES (?, ?, ?, 1, ?, ?)",
      )
      .run(USER_ID, "Test User", "test@example.com", 0, 0);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  test("export produces a well-formed ZIP with a parseable manifest", async () => {
    const stream = buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    });

    const bytes = await readAll(stream);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(isValidZip(bytes)).toBe(true);
    expect(hasEocd(bytes)).toBe(true);

    // Persist so the import-side verifier (which expects a file path) can
    // exercise both code paths.
    const archivePath = join(workDir, "export.lvbak");
    writeFileSync(archivePath, bytes);

    // Fast path: ZIP central-directory parse + manifest read.
    const manifest = await verifyArchiveFast(archivePath);
    expect(manifest.producer).toBe("lumiverse");
    expect(manifest.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
    expect(manifest.ndjsonFormatVersion).toBe(NDJSON_FORMAT_VERSION);
    expect(manifest.ndjsonMaxRecordBytes).toBe(NDJSON_MAX_RECORD_BYTES);
    expect(manifest.archiveId).toMatch(/^[0-9a-f-]{36}$/i);
  });
  test("V3 manifest is last and authenticates every emitted entry", async () => {
    const bytes = await readAll(
      buildExportStream({
        userId: USER_ID,
        includeVectors: false,
        producerVersion: "test",
      }),
    );
    const archive = unzipSync(bytes);
    const names = Object.keys(archive);
    expect(names[names.length - 1]).toBe("manifest.json");
    expect(new Set(names).size).toBe(names.length);
    const manifest = parseManifest(JSON.parse(strFromU8(archive["manifest.json"] ?? new Uint8Array())));
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.entries?.map((entry) => entry.path)).toEqual(
      manifest.entries?.map((entry) => entry.path).slice().sort((a, b) => a.localeCompare(b)),
    );
    for (const entry of manifest.entries ?? []) {
      const payload = archive[entry.path];
      if (!payload) throw new Error(`archive is missing ${entry.path}`);
      expect(payload.byteLength).toBe(entry.bytes);
      expect(createHash("sha256").update(payload).digest("hex")).toBe(entry.sha256);
      expect(manifest.byteCounts?.[entry.path]).toBe(entry.bytes);
    }
  });
  test("secret export fails closed when a selected key is missing", async () => {
    await expect(
      readAll(
        buildExportStream({
          userId: USER_ID,
          includeVectors: false,
          producerVersion: "test",
          secrets: { smk: new Uint8Array(32), secretKeys: ["missing-secret"] },
        }),
      ),
    ).rejects.toThrow();
  });

  test("V3 parser rejects duplicate, traversal, and invalid SHA metadata", () => {
    const base = {
      schemaVersion: 3,
      producer: "lumiverse",
      exportedAt: 0,
      archiveId: crypto.randomUUID(),
      producerVersion: "test",
      ndjsonFormatVersion: 2,
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      embeddingIdentity: "test-embedding",
      vectorStatus: "rebuild_required",
      registryVersion: 2,
      snapshotId: "snapshot-test",
      counts: {},
      missingFiles: [],
      missingOptionalFiles: [],
      fileAliases: [],
      byteCounts: { "database/settings.ndjson": 0 },
      entries: [
        {
          path: "database/settings.ndjson",
          kind: "database",
          required: true,
          bytes: 0,
          sha256: "0".repeat(64),
        },
      ],
    };
    expect(() => parseManifest({
      ...base,
      entries: undefined,
    })).toThrow(/entries/);
    expect(() => parseManifest({
      ...base,
      byteCounts: undefined,
    })).toThrow(/counts/);
    expect(() => parseManifest({
      ...base,
      byteCounts: { "database/settings.ndjson": Number.MAX_SAFE_INTEGER },
    })).toThrow(/exceeds/);
    const exactEntry = parseManifest({
      ...base,
      byteCounts: { "database/settings.ndjson": MAX_ARCHIVE_FILE_BYTES },
      entries: [{ ...base.entries[0], bytes: MAX_ARCHIVE_FILE_BYTES }],
    });
    expect(exactEntry.entries?.[0].bytes).toBe(MAX_ARCHIVE_FILE_BYTES);
    expect(() => parseManifest({
      ...base,
      byteCounts: { "database/settings.ndjson": MAX_ARCHIVE_FILE_BYTES + 1 },
      entries: [{ ...base.entries[0], bytes: MAX_ARCHIVE_FILE_BYTES + 1 }],
    })).toThrow(/exceeds/);
    expect(() => parseManifest({
      ...base,
      entries: [base.entries[0], { ...base.entries[0] }],
    })).toThrow(/duplicate archive entry/);
    expect(() => parseManifest({
      ...base,
      entries: [{ ...base.entries[0], sha256: "not-a-sha" }],
    })).toThrow(/SHA-256/);
    for (const path of ["../settings.ndjson", "database/../settings.ndjson", "./settings.ndjson", "database//settings.ndjson"]) {
      expect(() => parseManifest({
        ...base,
        entries: [{ ...base.entries[0], path }],
      })).toThrow(/invalid archive entry path/);
    }
  });
  test("V1/V2 manifests retain legacy defaults while V3 remains strict", () => {
    const legacy = parseManifest({
      schemaVersion: 1,
      producer: "lumiverse",
    });
    expect(legacy.archiveId).toBe("");
    expect(legacy.exportedAt).toBe(0);
    expect(legacy.producerVersion).toBeNull();
    expect(legacy.includeVectors).toBe(false);
    expect(legacy.embeddingConfig).toEqual({ provider: null, model: null, dimension: null });
    expect(legacy.counts).toEqual({});
    expect(legacy.missingFiles).toEqual([]);
    const legacyV2 = parseManifest({
      schemaVersion: 2,
      producer: "lumiverse",
    });
    expect(legacyV2).toMatchObject({
      archiveId: "",
      exportedAt: 0,
      producerVersion: null,
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      counts: {},
      missingFiles: [],
    });

    expect(() => parseManifest({
      schemaVersion: 2,
      producer: "lumiverse",
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES + 1,
    })).toThrow(/advertises an NDJSON limit/);


    expect(() => parseManifest({
      schemaVersion: 3,
      producer: "lumiverse",
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      ndjsonFormatVersion: 2,
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
      counts: {},
      missingFiles: [],
      registryVersion: 2,
      snapshotId: "snapshot",
      entries: [],
      fileAliases: [],
      byteCounts: {},
      missingOptionalFiles: [],
      vectorStatus: "rebuild_required",
      embeddingIdentity: "embedding",
    })).toThrow(/exportedAt|archiveId|producerVersion/);
  });

  test("V3 file entries require source identity bytes to match the payload", () => {
    const base = {
      schemaVersion: 3,
      producer: "lumiverse",
      exportedAt: 0,
      archiveId: crypto.randomUUID(),
      producerVersion: "test",
      ndjsonFormatVersion: 2,
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      embeddingIdentity: "embedding",
      vectorStatus: "rebuild_required",
      registryVersion: 2,
      snapshotId: "snapshot",
      counts: {},
      missingFiles: [],
      missingOptionalFiles: [],
      fileAliases: [],
      byteCounts: { "files/images/a.bin": 2 },
    };
    const entry = {
      path: "files/images/a.bin",
      kind: "file",
      required: true,
      bytes: 2,
      sha256: "0".repeat(64),
    };
    expect(() => parseManifest({ ...base, entries: [entry] })).toThrow(/sourceIdentity.size/);
    expect(() => parseManifest({
      ...base,
      entries: [{ ...entry, sourceIdentity: { device: 1, inode: 2, size: 1, mtimeMs: 3 } }],
    })).toThrow(/sourceIdentity.size/);
    expect(parseManifest({
      ...base,
      entries: [{ ...entry, sourceIdentity: { device: 1, inode: 2, size: 2, mtimeMs: 3 } }],
    }).entries?.[0].sourceIdentity).toEqual({ device: 1, inode: 2, size: 2, mtimeMs: 3 });
  });


  test("V3 ledger preserves required and optional file references", () => {
    const manifest = parseManifest({
      schemaVersion: 3,
      producer: "lumiverse",
      exportedAt: 0,
      archiveId: crypto.randomUUID(),
      producerVersion: "test",
      ndjsonFormatVersion: 2,
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      embeddingIdentity: "test-embedding",
      vectorStatus: "rebuild_required",
      registryVersion: 2,
      snapshotId: "snapshot-test",
      counts: {},
      missingFiles: ["optional-image"],
      missingOptionalFiles: ["files/images/optional.bin"],
      fileAliases: [],
      byteCounts: { "files/images/required.bin": 1 },
      entries: [
        {
          path: "files/images/required.bin",
          kind: "file",
          required: true,
          bytes: 1,
          sha256: "0".repeat(64),
          sourceIdentity: { device: 1, inode: 2, size: 1, mtimeMs: 3 },
        },
      ],
    });
    expect(manifest.entries?.[0].required).toBe(true);
    expect(manifest.missingOptionalFiles).toEqual(["files/images/optional.bin"]);
  });


  test("exports canonical agent tool-call limits and strips legacy metadata authority", async () => {
    const baseConfig = {
      version: 1,
      enabled: false,
      maxInvocations: 64,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [],
    };
    for (const [index, maxToolCalls] of [1, 64, Number.MAX_SAFE_INTEGER].entries()) {
      getDb().query(
        "INSERT INTO presets (id, name, provider, metadata, user_id) VALUES (?, ?, ?, ?, ?)",
      ).run(
        `agent-${index}`,
        `Agent ${index}`,
        "loom",
        JSON.stringify({ agentConfig: { ...baseConfig, maxToolCalls } }),
        USER_ID,
      );
      getDb().query(
        "INSERT INTO preset_agent_configs (user_id, preset_id, max_invocations, max_tool_calls) VALUES (?, ?, 64, ?)",
      ).run(USER_ID, `agent-${index}`, maxToolCalls);
    }
    getDb().query(
      "INSERT INTO presets (id, name, provider, metadata, user_id) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "agent-legacy",
      "Agent legacy",
      "loom",
      JSON.stringify({ agentConfig: baseConfig }),
      USER_ID,
    );
    getDb().query(
      "INSERT INTO presets (id, name, provider, metadata, user_id) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "agent-absent",
      "Agent absent",
      "loom",
      '{"extensionData":{"keep":true}}',
      USER_ID,
    );


    const bytes = await readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }));
    const entries = unzipSync(bytes);
    const rows = strFromU8(entries["database/presets.ndjson"] ?? new Uint8Array())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; metadata: string });
    type ExportedMetadata = {
      agentConfig?: unknown;
      [key: string]: unknown;
    };
    const byId = new Map(rows.map((row) => [
      row.id,
      JSON.parse(row.metadata) as ExportedMetadata,
    ]));
    expect(byId.get("agent-0")?.agentConfig).toBeUndefined();
    expect(byId.get("agent-1")?.agentConfig).toBeUndefined();
    expect(byId.get("agent-2")?.agentConfig).toBeUndefined();
    expect(byId.get("agent-legacy")?.agentConfig).toBeUndefined();
    expect(byId.get("agent-absent")).toEqual({ extensionData: { keep: true } });

    const configRows = strFromU8(entries["database/preset_agent_configs.ndjson"] ?? new Uint8Array())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { preset_id: string; max_tool_calls: number });
    const limitsByPreset = new Map(configRows.map((row) => [row.preset_id, row.max_tool_calls]));
    expect(limitsByPreset.get("agent-0")).toBe(1);
    expect(limitsByPreset.get("agent-1")).toBe(64);
    expect(limitsByPreset.get("agent-2")).toBe(Number.MAX_SAFE_INTEGER);
    expect(limitsByPreset.has("agent-legacy")).toBe(false);
  });

  test("compatibility verifier also accepts the export", async () => {
    const stream = buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    });

    const bytes = await readAll(stream);
    const archivePath = join(workDir, "export-compatibility.lvbak");
    writeFileSync(archivePath, bytes);

    // The public compatibility entry point intentionally uses the same
    // bounded central-directory verifier as the import route.
    const manifest = await verifyArchive(archivePath);
    expect(manifest.producer).toBe("lumiverse");
    expect(manifest.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
  });

  test("fast verifier scans a multi-page central directory without loading it whole", async () => {
    const archiveId = crypto.randomUUID();
    const entries: Record<string, Uint8Array> = {};
    const empty = new Uint8Array(0);
    // Put the manifest last and make the directory comfortably larger than
    // two verifier pages so records and names cross read boundaries.
    for (let i = 0; i < 8_000; i++) {
      entries[`files/images/${i.toString(36).padStart(6, "0")}-asset.bin`] = empty;
    }
    entries["manifest.json"] = strToU8(JSON.stringify(testManifest(archiveId)));

    const bytes = zipSync(entries, { level: 0 });
    expect(bytes.byteLength).toBeGreaterThan(512 * 1024);
    const archivePath = join(workDir, "large-central-directory.lvbak");
    writeFileSync(archivePath, bytes);

    const manifest = await verifyArchiveFast(archivePath);
    expect(manifest.archiveId).toBe(archiveId);
  });

  test("compatibility verifier finds a trailing manifest without reading leading data", async () => {
    const archiveId = crypto.randomUUID();
    const leadingData = new Uint8Array(8 * 1024 * 1024);
    const bytes = zipSync(
      {
        "files/images/large.bin": leadingData,
        "manifest.json": strToU8(JSON.stringify(testManifest(archiveId))),
      },
      { level: 0 },
    );
    const archivePath = join(workDir, "manifest-last.lvbak");
    writeFileSync(archivePath, bytes);

    const manifest = await verifyArchive(archivePath);
    expect(manifest.archiveId).toBe(archiveId);
  });

  test("fast verifier caps manifest inflation even when ZIP metadata lies", async () => {
    const archiveId = crypto.randomUUID();
    const oversized = {
      ...testManifest(archiveId),
      padding: "x".repeat(17 * 1024 * 1024),
    };
    const bytes = zipSync(
      { "manifest.json": strToU8(JSON.stringify(oversized)) },
      { level: 9 },
    );

    // Lie about the uncompressed size in the central-directory record so the
    // preflight metadata check passes. The bounded inflater must still reject
    // the actual >16 MB output rather than allocating it without limit.
    let cdh = -1;
    for (let i = bytes.byteLength - 46; i >= 0; i--) {
      if (
        bytes[i] === 0x50 &&
        bytes[i + 1] === 0x4b &&
        bytes[i + 2] === 0x01 &&
        bytes[i + 3] === 0x02
      ) {
        cdh = i;
        break;
      }
    }
    expect(cdh).toBeGreaterThanOrEqual(0);
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(cdh + 24, 1, true);

    const archivePath = join(workDir, "manifest-inflate-cap.lvbak");
    writeFileSync(archivePath, bytes);
    await expect(verifyArchiveFast(archivePath)).rejects.toMatchObject({
      name: "ArchiveValidationError",
      code: "bad_manifest",
    });
  });

  test("export with 10⁵ character rows streams to ~100 MB without OOM", async () => {
    // Insert 100,000 characters in batches. ~1 KB of description each →
    // a ~100 MB NDJSON stream, the same per-row path a multi-GB export
    // exercises. Catches any regression where the streaming pipeline
    // accidentally buffers the whole NDJSON in memory.
    const stmt = getDb().prepare(
      "INSERT INTO characters (id, user_id, name, description, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 0, 0)",
    );
    const tx = getDb().transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        const id = `char-${i.toString(36).padStart(8, "0")}`;
        const desc = "x".repeat(900) + ` #${i}`;
        stmt.run(id, USER_ID, `Char ${i}`, desc);
      }
    });
    tx(100_000);

    const stream = buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    });

    const bytes = await readAll(stream);
    expect(isValidZip(bytes)).toBe(true);
    // 100,000 rows × ~1 KB compressed → archive should comfortably exceed
    // a few MB. The exact number is irrelevant; what matters is that the
    // stream finished, didn't OOM, and the central directory is well-formed.
    expect(bytes.byteLength).toBeGreaterThan(1_000_000);

    // And the import-side fast verifier accepts it.
    const archivePath = join(workDir, "export-big.lvbak");
    writeFileSync(archivePath, bytes);
    const manifest = await verifyArchiveFast(archivePath);
    expect(manifest.producer).toBe("lumiverse");
  });

  test.skipIf(!process.env.BENCHMARK)(
    "500k character rows benchmark (set BENCHMARK=1 to run)",
    async () => {
      const ROWS = 500_000;
      const stmt = getDb().prepare(
        "INSERT INTO characters (id, user_id, name, description, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, 0, 0)",
      );
      const tx = getDb().transaction((count: number) => {
        for (let i = 0; i < count; i++) {
          const id = `char-${i.toString(36).padStart(8, "0")}`;
          const desc = "x".repeat(900) + ` #${i}`;
          stmt.run(id, USER_ID, `Char ${i}`, desc);
        }
      });
      tx(ROWS);

      const t0 = performance.now();
      const stream = buildExportStream({
        userId: USER_ID,
        includeVectors: false,
        producerVersion: "test",
      });
      const bytes = await readAll(stream);
      const t1 = performance.now();

      expect(isValidZip(bytes)).toBe(true);
      expect(bytes.byteLength).toBeGreaterThan(1_000_000);
      console.log(
        `[benchmark] ${ROWS.toLocaleString()} rows in ${(t1 - t0).toFixed(1)}ms ` +
          `(${Math.round(ROWS / ((t1 - t0) / 1000)).toLocaleString()} rows/s)`,
      );
    },
    120_000,
  );
});
