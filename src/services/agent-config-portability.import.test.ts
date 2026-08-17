import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import {
  createPortableContextPackSnapshotId,
  estimateContextPackTokens,
  hashContextPackContent,
  type PortableContextPackSnapshotV1,
} from "../types/agent-context-packs";
import type { PortableAgentConfigV1 } from "../types/agents";
import {
  duplicatePresetWithAgentConfig,
  importPortablePresetRuntime,
  type PortablePresetRuntimeEnvelopeV1,
} from "./agent-config-portability.service";

const USER_ID = "portable-import-user";

function contextSnapshot(): PortableContextPackSnapshotV1 {
  const content: PortableContextPackSnapshotV1["content"] = [];
  const serialized = "[]";
  const digest = hashContextPackContent(serialized);
  return {
    portableVersion: 1,
    snapshotId: createPortableContextPackSnapshotId(digest, 1),
    name: "Imported facts",
    description: "Atomic import fixture",
    revision: 1,
    content,
    contentDigest: digest,
    tokenCount: estimateContextPackTokens(serialized),
    byteCount: new TextEncoder().encode(serialized).byteLength,
  };
}

function portableConfig(packSnapshotId: string): PortableAgentConfigV1 {
  return {
    portableVersion: 1,
    agentsEnabled: false,
    allowedModes: ["response"],
    defaultMode: "response",
    maxInvocations: 1,
    maxToolCalls: 1,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles: [],
    connectionSlots: [],
    contextPolicy: { packIds: [packSnapshotId], ruleIds: [] },
  };
}

function runtimeEnvelope(withContext = true): PortablePresetRuntimeEnvelopeV1 {
  const snapshot = contextSnapshot();
  return {
    version: 1,
    agentConfig: withContext ? portableConfig(snapshot.snapshotId) : null,
    contextPacks: withContext ? [snapshot] : [],
    contextSelections: withContext ? [{
      packSnapshotId: snapshot.snapshotId,
      revisionId: `${snapshot.snapshotId}@${snapshot.revision}`,
      digest: snapshot.contentDigest,
    }] : [],
    contextRules: [],
    taskTemplates: [],
  };
}

function preset(
  regex_scripts?: readonly Record<string, unknown>[],
  name = "Portable preset",
) {
  return {
    name,
    provider: "loom",
    parameters: {},
    prompt_order: [],
    prompts: {},
    metadata: {},
    ...(regex_scripts === undefined ? {} : { regex_scripts }),
  };
}

function validRegex(scriptId: string): Record<string, unknown> {
  return {
    name: `Portable ${scriptId}`,
    script_id: scriptId,
    find_regex: "foo",
    replace_string: "bar",
    flags: "g",
    placement: ["ai_output"],
    scope: "global",
    target: ["response"],
    trim_strings: [],
    run_on_edit: false,
    substitute_macros: "none",
    disabled: false,
    sort_order: 0,
    description: "",
    folder: "Portable preset",
    metadata: {},
  };
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await runMigrations(getDb());
  getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(
    USER_ID,
    "Portable Import User",
    "portable-import@example.test",
  );
});

afterEach(() => closeDatabase());

describe("portable preset runtime import atomicity", () => {
  test("rolls back preset, config, context, regex, and revisions when a later regex fails", () => {
    const malformed = { name: "Missing pattern" };

    expect(() => importPortablePresetRuntime(USER_ID, {
      preset: preset([validRegex("first"), malformed]),
      agentRuntime: runtimeEnvelope(),
    })).toThrow("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");

    const db = getDb();
    expect(db.query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM preset_agent_configs WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_context_packs WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_context_account_state WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM settings WHERE user_id = ? AND key LIKE 'presetRegexEnabled:%'").get(USER_ID)).toEqual({ count: 0 });
  });
  test("rolls back an existing preset replacement when a later regex fails", () => {
    const initial = importPortablePresetRuntime(USER_ID, {
      preset: preset([validRegex("original")], "Original"),
      agentRuntime: runtimeEnvelope(),
    });
    const db = getDb();
    const beforePresetRow = db.query(
      "SELECT name, cache_revision FROM presets WHERE user_id = ? AND id = ?",
    ).get(USER_ID, initial.preset.id) as { name?: unknown; cache_revision?: unknown } | null;
    if (
      !beforePresetRow
      || typeof beforePresetRow.name !== "string"
      || typeof beforePresetRow.cache_revision !== "number"
    ) {
      throw new Error("portable import fixture did not create a preset");
    }
    const beforePreset = {
      name: beforePresetRow.name,
      cache_revision: beforePresetRow.cache_revision,
    };
    const beforeConfig = db.query(
      "SELECT config_json, config_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, initial.preset.id);
    const beforeRegex = db.query(
      "SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY id",
    ).all(USER_ID, initial.preset.id);
    const beforeSettings = db.query(
      "SELECT key, value FROM settings WHERE user_id = ? AND key LIKE 'presetRegexEnabled:%' ORDER BY key",
    ).all(USER_ID);

    expect(() => importPortablePresetRuntime(USER_ID, {
      preset: preset([validRegex("replacement"), { name: "Missing pattern" }], "Replacement"),
      agentRuntime: runtimeEnvelope(),
      existingPresetId: initial.preset.id,
      expectedPresetRevision: beforePreset.cache_revision,
    })).toThrow("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");

    expect(db.query(
      "SELECT name, cache_revision FROM presets WHERE user_id = ? AND id = ?",
    ).get(USER_ID, initial.preset.id)).toEqual(beforePreset);
    expect(db.query(
      "SELECT config_json, config_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, initial.preset.id)).toEqual(beforeConfig);
    expect(db.query(
      "SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY id",
    ).all(USER_ID, initial.preset.id)).toEqual(beforeRegex);
    expect(db.query(
      "SELECT key, value FROM settings WHERE user_id = ? AND key LIKE 'presetRegexEnabled:%' ORDER BY key",
    ).all(USER_ID)).toEqual(beforeSettings);
    expect(db.query("SELECT COUNT(*) AS count FROM agent_context_packs WHERE user_id = ?").get(USER_ID)).toEqual({ count: 1 });
  });

  test("commits each portable component once when every embedded regex is valid", () => {
    const result = importPortablePresetRuntime(USER_ID, {
      preset: preset([validRegex("first"), validRegex("second")]),
      agentRuntime: runtimeEnvelope(),
    });
    const db = getDb();

    expect(result.preset.id).toBeString();
    expect(db.query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM preset_agent_configs WHERE user_id = ?").get(USER_ID)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_context_packs WHERE user_id = ?").get(USER_ID)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM settings WHERE user_id = ? AND key LIKE 'presetRegexEnabled:%'").get(USER_ID)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ? AND preset_id = ?").get(USER_ID, result.preset.id)).toEqual({ count: 2 });
    const authored = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, result.preset.id) as { config_json: string };
    expect(JSON.parse(authored.config_json)).toMatchObject({
      contextPackSelections: [{ packId: expect.any(String) }],
    });

    const duplicate = duplicatePresetWithAgentConfig(USER_ID, result.preset.id, "Portable copy");
    expect(duplicate.copiedRegexScriptIds).toHaveLength(2);
    expect(db.query("SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ? AND preset_id = ?").get(USER_ID, duplicate.preset.id)).toEqual({ count: 2 });
  });

  test("accepts a legacy runtime envelope with no embedded regex field", () => {
    const result = importPortablePresetRuntime(USER_ID, {
      preset: preset(),
      agentRuntime: runtimeEnvelope(false),
    });

    expect(result.preset.name).toBe("Portable preset");
    expect(getDb().query("SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
  });
});
