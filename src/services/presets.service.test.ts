import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  createPreset,
  deletePreset,
  getPreset,
  getPresetCacheRevision,
  getPresetRegistrySignature,
  reconcileActiveLoomPreset,
  updatePreset,
  validateAgentConfigForExecution,
} from "./presets.service";
import {
  decodePortableAgentConfig,
  duplicatePresetWithAgentConfig,
  encodePortableAgentConfig,
  getAgentRuntimeSharedDraft,
  getPresetAgentCognitionSourceV1,
  importPortablePresetRuntime,
  importPortablePreset,
  saveAgentRuntimeSharedDraft,
  writePresetAgentConfigWithDb,
} from "./agent-config-portability.service";
import type { WorkspaceOperationKindV1 } from "../types/turn-workspace";
import { PresetRevisionConflictError, type PromptBlock } from "../types/preset";
import { addPromptBlockToStash, removePromptBlockFromStash } from "./prompt-stash.service";
import * as settingsSvc from "./settings.service";

function initPresetsTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    parameters TEXT NOT NULL DEFAULT '{}',
    prompt_order TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    prompts TEXT NOT NULL DEFAULT '{}',
    user_id TEXT,
    engine TEXT NOT NULL DEFAULT 'classic',
    cache_revision INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
  getDb().run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    preset_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    has_api_key INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE regex_scripts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    preset_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE secrets (
    key TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    user_id TEXT NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
  getDb().run(`CREATE TABLE agent_preset_context_pack_attachments (
    user_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0 AND position <= 1024),
    required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'review_required', 'repair_required')),
    provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (length(provenance_json) <= 16384),
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, attachment_id),
    UNIQUE (user_id, preset_id, pack_id, revision)
  )`);

  getDb().run(`CREATE TABLE preset_agent_configs (
    user_id TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 2,
    agents_enabled INTEGER NOT NULL DEFAULT 0,
    allowed_modes TEXT NOT NULL DEFAULT '["response"]',
    default_mode TEXT NOT NULL DEFAULT 'response',
    max_invocations INTEGER NOT NULL DEFAULT 64,
    max_tool_calls INTEGER NOT NULL DEFAULT 64,
    main_tool_ids TEXT NOT NULL DEFAULT '[]',
    main_lore_scope TEXT NOT NULL DEFAULT 'active',
    phase_policy_json TEXT NOT NULL DEFAULT '{}',
    cognition_policy_json TEXT NOT NULL DEFAULT '{}',
    context_policy_json TEXT NOT NULL DEFAULT '{}',
    task_policy_json TEXT NOT NULL DEFAULT '{}',
    workspace_policy_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'ready',
    review_code TEXT,
    review_acknowledged INTEGER NOT NULL DEFAULT 0,
    config_revision INTEGER NOT NULL DEFAULT 1,
    binding_revision INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, preset_id)
  )`);
  getDb().run(`CREATE TABLE preset_agent_connection_slots (
    user_id TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    label TEXT NOT NULL,
    required_capabilities TEXT NOT NULL DEFAULT '[]',
    slot_revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, preset_id, slot_id)
  )`);
  getDb().run(`CREATE TABLE preset_agent_profiles (
    user_id TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    name TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    connection_ref_kind TEXT NOT NULL,
    slot_id TEXT,
    tool_ids TEXT NOT NULL DEFAULT '[]',
    workspace_capabilities TEXT NOT NULL DEFAULT '[]',
    lore_scope TEXT NOT NULL,
    allow_main_delegation INTEGER NOT NULL,
    failure_policy TEXT NOT NULL,
    stream_activity INTEGER NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    timeout_ms INTEGER NOT NULL,
    profile_revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, preset_id, profile_id)
  )`);
  getDb().run(`CREATE TABLE preset_agent_slot_bindings (
    user_id TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    connection_id TEXT,
    binding_revision INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'ready',
    review_code TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, preset_id, slot_id)
  )`);
}

function insertPreset(o: {
  id: string;
  name: string;
  provider: string;
  user_id: string;
  updated_at?: number;
  parameters?: unknown;
  prompt_order?: unknown;
  prompts?: unknown;
  metadata?: unknown;
  engine?: string;
}): void {
  getDb().run(
    `INSERT INTO presets (id, name, provider, parameters, prompt_order, metadata, created_at, updated_at, prompts, user_id, engine)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      o.id,
      o.name,
      o.provider,
      JSON.stringify(o.parameters ?? {}),
      JSON.stringify(o.prompt_order ?? []),
      JSON.stringify(o.metadata ?? {}),
      0,
      o.updated_at ?? 0,
      JSON.stringify(o.prompts ?? {}),
      o.user_id,
      o.engine ?? "classic",
    ],
  );
}

beforeEach(initPresetsTestDb);
afterEach(() => closeDatabase());

describe("presets.service — ETag sources + row trim", () => {
  test("getPreset parses JSON columns and does NOT leak internal columns (user_id)", () => {
    insertPreset({
      id: "p1",
      name: "A",
      provider: "openai",
      user_id: "u1",
      updated_at: 100,
      parameters: { temperature: 1 },
      prompt_order: [{ id: "b1" }],
      engine: "loom",
    });

    const preset = getPreset("u1", "p1");
    expect(preset).not.toBeNull();
    expect(Object.keys(preset!)).not.toContain("user_id");
    expect(preset!.parameters).toEqual({ temperature: 1 });
    expect(preset!.prompt_order).toEqual([{ id: "b1" }]);
    expect(preset!.engine).toBe("loom");
    expect(preset!.updated_at).toBe(100);
    expect(preset!.cache_revision).toBe(0);
  });

  test("getPreset is scoped to the owning user", () => {
    insertPreset({ id: "p1", name: "A", provider: "openai", user_id: "u1", updated_at: 100 });
    expect(getPreset("u2", "p1")).toBeNull();
  });


  test("registry signatures are scoped by user and filters", () => {
    insertPreset({ id: "p1", name: "A", provider: "openai", user_id: "u1", updated_at: 100 });
    insertPreset({ id: "p2", name: "B", provider: "loom", user_id: "u1", updated_at: 250 });
    insertPreset({ id: "p3", name: "C", provider: "loom", user_id: "u2", updated_at: 999 });

    const all = getPresetRegistrySignature("u1");
    const loom = getPresetRegistrySignature("u1", "loom");
    const empty = getPresetRegistrySignature("u1", "anthropic");
    expect(all).not.toBe(loom);
    expect(loom).not.toBe(empty);
    expect(empty).not.toBe(getPresetRegistrySignature("u2", "anthropic"));
    expect(empty).toBe(getPresetRegistrySignature("u1", "anthropic"));
  });

  test("registry signature changes for a same-second non-maximum edit", () => {
    insertPreset({ id: "p1", name: "A", provider: "loom", user_id: "u1", updated_at: 100 });
    insertPreset({ id: "p2", name: "B", provider: "loom", user_id: "u1", updated_at: 250 });
    const before = getPresetRegistrySignature("u1", "loom");
    getDb().run("UPDATE presets SET cache_revision = ? WHERE id = ?", [1, "p1"]);
    const after = getPresetRegistrySignature("u1", "loom");
    expect(after).not.toBe(before);
  });

  test("registry signature changes for a same-timestamp delete/create replacement", () => {
    insertPreset({ id: "p1", name: "A", provider: "loom", user_id: "u1", updated_at: 250 });
    const before = getPresetRegistrySignature("u1", "loom");
    getDb().run("DELETE FROM presets WHERE id = ?", ["p1"]);
    insertPreset({ id: "p2", name: "B", provider: "loom", user_id: "u1", updated_at: 250 });
    expect(getPresetRegistrySignature("u1", "loom")).not.toBe(before);
  });

  test("updatePreset increments a dedicated cache revision without distorting timestamps", () => {
    insertPreset({ id: "p1", name: "A", provider: "loom", user_id: "u1", updated_at: 2_000_000_000 });
    const first = updatePreset("u1", "p1", { name: "B" });
    const second = updatePreset("u1", "p1", { name: "C" });
    expect(first?.updated_at).toBeLessThan(2_000_000_000);
    expect(getPresetCacheRevision("u1", "p1")).toBe(2);
    expect(second?.name).toBe("C");
    expect(getPresetCacheRevision("u1", "missing")).toBeNull();
  });

  test("rejects a stale conditional writer without changing newer metadata or blocks", () => {
    insertPreset({
      id: "p1",
      name: "A",
      provider: "loom",
      user_id: "u1",
      metadata: { before: true },
      prompt_order: [{ id: "block", content: "before" }],
    });
    const updated = updatePreset("u1", "p1", {
      metadata: { after: true },
      expected_cache_revision: 0,
    });
    expect(updated?.metadata).toEqual({ after: true });
    expect(() => updatePreset("u1", "p1", {
      metadata: { stale: true },
      expected_cache_revision: 0,
    })).toThrow(PresetRevisionConflictError);
    expect(getPreset("u1", "p1")?.metadata).toEqual({ after: true });
    expect(getPreset("u1", "p1")?.prompt_order).toEqual([{ id: "block", content: "before" }]);
  });

});

describe("presets.service — active preset recovery", () => {
  test("repairs a legacy deleted selection during settings hydration", () => {
    insertPreset({ id: "available", name: "Available", provider: "loom", user_id: "u1", updated_at: 100 });
    settingsSvc.putSetting("u1", "activeLoomPresetId", "already-deleted");

    expect(reconcileActiveLoomPreset("u1")).toBe("available");
    expect(settingsSvc.getSetting("u1", "activeLoomPresetId")?.value).toBe("available");
  });

  test("replaces a deleted active preset with the most recently updated remaining Loom preset", () => {
    insertPreset({ id: "deleted", name: "Deleted", provider: "loom", user_id: "u1", updated_at: 300 });
    insertPreset({ id: "older", name: "Older", provider: "loom", user_id: "u1", updated_at: 100 });
    insertPreset({ id: "recent", name: "Recent", provider: "loom", user_id: "u1", updated_at: 200 });
    settingsSvc.putSetting("u1", "activeLoomPresetId", "deleted");

    expect(deletePreset("u1", "deleted")).toBe(true);
    expect(settingsSvc.getSetting("u1", "activeLoomPresetId")?.value).toBe("recent");
  });

  test("clears the active setting when the deleted preset was the final Loom preset", () => {
    insertPreset({ id: "only", name: "Only", provider: "loom", user_id: "u1" });
    settingsSvc.putSetting("u1", "activeLoomPresetId", "only");

    expect(deletePreset("u1", "only")).toBe(true);
    expect(settingsSvc.getSetting("u1", "activeLoomPresetId")?.value).toBeNull();
  });
});
  test("does not promote legacy metadata when the normalized authority row is absent", () => {
    insertPreset({
      id: "legacy-only",
      name: "Legacy only",
      provider: "loom",
      user_id: "u1",
      metadata: {
        agentConfig: {
          version: 1,
          enabled: true,
          profiles: [],
          mainToolIds: ["chat_search_history"],
        },
      },
    });

    const preset = getPreset("u1", "legacy-only");

    expect(preset?.agent_config).toBeUndefined();
    expect(preset?.agent_config_review).toBeUndefined();
    expect(preset?.metadata).toEqual({});
  });
  describe("agentConfig boundary", () => {
    const agentConfig: import("../types/agents").AgentConfigV2 = {
      version: 2,
      agentsEnabled: true,
      allowedModes: ["response"],
      defaultMode: "response",
      maxInvocations: 64,
      maxToolCalls: 64,
      mainToolIds: ["chat_search_history"],
      mainLoreScope: "active",
      profiles: [{
        id: "writer",
        name: "Writer",
        systemPrompt: "literal",
        connectionRef: { kind: "inherit_main" },
        toolIds: ["lore_search_entries"],
        loreScope: "active",
        allowMainDelegation: true,
        failurePolicy: "required",
        streamActivity: true,
        maxOutputTokens: 64,
        timeoutMs: 5_000,
      }],
      connectionSlots: [],
    };

    test("validates V2 config on create/update and projects it outside metadata", () => {
      const malformedConfig = { ...agentConfig, unknown: true };
      expect(() => createPreset("u1", {
        name: "Agent",
        provider: "loom",
        agent_config: malformedConfig,
      })).toThrow();

      const created = createPreset("u1", {
        name: "Agent",
        provider: "loom",
        agent_config: { ...agentConfig, agentsEnabled: false },
      });
      expect(created.agent_config?.agentsEnabled).toBe(false);
      expect(created.agent_config_revision).toBe(1);
      expect(created.agent_config_review?.state).toBe("ready");
      expect(created.metadata.agentConfig).toBeUndefined();

      const updated = updatePreset("u1", created.id, {
        agent_config: agentConfig,
        expected_cache_revision: created.cache_revision,
      });
      expect(updated?.agent_config_revision).toBe(2);
      expect(updated?.agent_config?.agentsEnabled).toBe(true);
      expect(updated?.agent_config_review?.state).toBe("ready");
      expect(updated?.metadata.agentConfig).toBeUndefined();
    });

    test("persists workspace capability grants through portable projection and duplicate", () => {
      const workspaceCapabilities: WorkspaceOperationKindV1[] = ["read_section", "update_assigned_progress", "submit_child_result"];
      const config = {
        ...agentConfig,
        profiles: [{ ...agentConfig.profiles[0], workspaceCapabilities }],
      };
      const created = createPreset("u1", { name: "Workspace grants", provider: "loom", agent_config: config });
      expect(getDb().query("SELECT workspace_capabilities FROM preset_agent_profiles WHERE user_id = ? AND preset_id = ?").get("u1", created.id)).toEqual({
        workspace_capabilities: JSON.stringify(workspaceCapabilities),
      });
      expect(created.agent_config?.profiles[0]?.workspaceCapabilities).toEqual(workspaceCapabilities);
      expect(decodePortableAgentConfig(encodePortableAgentConfig(created.agent_config!)).profiles[0]?.workspaceCapabilities).toEqual(workspaceCapabilities);
      const duplicate = duplicatePresetWithAgentConfig("u1", created.id, "Workspace grants copy");
      expect(duplicate.agent_config.profiles[0]?.workspaceCapabilities).toEqual(workspaceCapabilities);
      expect(() => createPreset("u1", {
        name: "Invalid workspace grants",
        provider: "loom",
        agent_config: {
          ...config,
          profiles: [{ ...config.profiles[0], workspaceCapabilities: ["submit_child_result", "read_section"] }],
        },
      })).toThrow();
    });

    test("duplicates the validated authored cognition envelope with normalized state and regex companions", () => {
      const rule = {
        id: "rule_one",
        packId: "rule-pack",
        revisionId: "rule-pack@2",
        required: true,
        dependencies: [],
      };
      const task = {
        id: "task_one",
        required: true,
        dependencies: [],
        label: "Verify the rules",
      };
      const cognitionReference = {
        blockId: "cognition-block",
        expectedPresetRevision: 0,
        expectedBlockRevision: 1,
      };
      const cognitionConfig = {
        ...agentConfig,
        profiles: [{
          ...agentConfig.profiles[0],
          connectionRef: { kind: "slot" as const, slotId: "writer" },
        }],
        connectionSlots: [{ id: "writer", label: "Writer", requiredCapabilities: ["generation" as const] }],
        cognitionPolicy: {
          workPolicy: [cognitionReference],
          workspaceUsage: [cognitionReference],
          completionCriteria: [cognitionReference],
          renderPolicy: [cognitionReference],
        },
        contextPolicy: { packIds: ["direct-pack"], ruleIds: ["rule_one"] },
        taskPolicy: { templateIds: ["task_one"] },
      };
      const created = createPreset("u1", {
        name: "Cognition source",
        provider: "loom",
        prompt_order: [{ id: "cognition-block" }],
        agent_config: cognitionConfig,
      });
      getDb().run(
        "INSERT INTO regex_scripts (id, user_id, preset_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?)",
        ["regex-source", "u1", created.id, 1, 1],
      );
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      saveAgentRuntimeSharedDraft("u1", created.id, {
        config: cognitionConfig,
        slotBindings: [{ slotId: "writer", connectionId: null }],
        contextPackSelections: [{
          packId: "direct-pack",
          revisionId: "direct-pack@1",
          revision: 1,
          digest: "a".repeat(64),
          label: "Direct rules",
        }, {
          packId: "rule-pack",
          revisionId: "rule-pack@2",
          revision: 2,
          digest: "b".repeat(64),
          label: "Rule context",
        }],
        contextRules: [rule],
        taskTemplates: [task],
        promptOrder: [{ id: "cognition-block" }],
        reviewAcknowledgements: ["slot:writer"],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });
      const sourceEnvelope = getDb().query(
        "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
      ).get("u1", created.id) as { config_json: string };

      const duplicate = duplicatePresetWithAgentConfig("u1", created.id, "Cognition copy");
      const targetEnvelope = getDb().query(
        "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
      ).get("u1", duplicate.preset.id) as { config_json: string };
      const sourceAuthoredEnvelope = JSON.parse(sourceEnvelope.config_json) as { config: typeof cognitionConfig; reviewAcknowledgements?: unknown };
      const targetAuthoredEnvelope = JSON.parse(targetEnvelope.config_json) as { config: typeof cognitionConfig; reviewAcknowledgements?: unknown };
      const sourceConfig = sourceAuthoredEnvelope.config;
      const targetConfig = targetAuthoredEnvelope.config;
      expect(sourceAuthoredEnvelope.reviewAcknowledgements).toEqual(["slot:writer"]);
      expect(targetAuthoredEnvelope.reviewAcknowledgements).toEqual(sourceAuthoredEnvelope.reviewAcknowledgements);
      const targetPresetRow = getDb().query(
        "SELECT cache_revision FROM presets WHERE user_id = ? AND id = ?",
      ).get("u1", duplicate.preset.id) as { cache_revision: number };
      const targetPresetRevision = targetPresetRow.cache_revision;
      const targetReferences = [
        ...(targetConfig.cognitionPolicy?.workPolicy ?? []),
        ...(targetConfig.cognitionPolicy?.workspaceUsage ?? []),
        ...(targetConfig.cognitionPolicy?.completionCriteria ?? []),
        ...(targetConfig.cognitionPolicy?.renderPolicy ?? []),
      ];
      expect(targetReferences).toHaveLength(4);
      expect(targetReferences.every((reference: { expectedPresetRevision: number }) => reference.expectedPresetRevision === targetPresetRevision)).toBe(true);
      expect(targetReferences.every((reference: { expectedBlockRevision: number }) => reference.expectedBlockRevision === 1)).toBe(true);
      expect(sourceConfig.cognitionPolicy.workPolicy[0].expectedPresetRevision).not.toBe(targetPresetRevision);
      expect(targetConfig.cognitionPolicy).toEqual({
        ...sourceConfig.cognitionPolicy,
        workPolicy: [{ ...sourceConfig.cognitionPolicy.workPolicy[0], expectedPresetRevision: targetPresetRevision }],
        workspaceUsage: [{ ...sourceConfig.cognitionPolicy.workspaceUsage[0], expectedPresetRevision: targetPresetRevision }],
        completionCriteria: [{ ...sourceConfig.cognitionPolicy.completionCriteria[0], expectedPresetRevision: targetPresetRevision }],
        renderPolicy: [{ ...sourceConfig.cognitionPolicy.renderPolicy[0], expectedPresetRevision: targetPresetRevision }],
      });
      expect(duplicate.agent_config.contextPolicy).toEqual({ packIds: ["direct-pack"], ruleIds: ["rule_one"] });
      expect(duplicate.agent_config.taskPolicy).toEqual({ templateIds: ["task_one"] });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ? AND preset_id = ?",
      ).get("u1", duplicate.preset.id)).toEqual({ count: 1 });
      expect(duplicate.copiedRegexScriptIds).toHaveLength(1);
    });

    test("rejects V1 config on the ordinary preset writer", () => {
      const legacy = {
        version: 1,
        enabled: true,
        maxInvocations: 4,
        maxToolCalls: 8,
        mainToolIds: [],
        mainLoreScope: "active",
        profiles: [],
      };
      // Intentionally bypass the closed DTO to exercise runtime rejection.
      const legacyInput = {
        name: "Legacy",
        provider: "loom",
        agent_config: legacy,
      } as unknown as Parameters<typeof createPreset>[1];
      expect(() => createPreset("u1", legacyInput)).toThrow("agentConfig.enabled: unknown key");
    });

    test("keeps slot binding revisions monotonic across delete-and-recreate rewrites", () => {
      const slotConfig = {
        ...agentConfig,
        profiles: [{ ...agentConfig.profiles[0], connectionRef: { kind: "slot" as const, slotId: "writer" } }],
        connectionSlots: [{ id: "writer", label: "Writer", requiredCapabilities: ["generation" as const] }],
      };
      const created = createPreset("u1", { name: "Binding revisions", provider: "loom", agent_config: slotConfig });
      const first = getDb().query("SELECT config_revision, binding_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get("u1", created.id) as { config_revision: number; binding_revision: number };
      const firstBinding = getDb().query("SELECT binding_revision FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? AND slot_id = ?").get("u1", created.id, "writer") as { binding_revision: number };
      expect(first.binding_revision).toBe(firstBinding.binding_revision);

      const rewritten = writePresetAgentConfigWithDb(getDb(), "u1", created.id, {
        config: slotConfig,
        bindings: [{ slotId: "writer", connectionId: null }],
        expectedConfigRevision: first.config_revision,
      });
      const second = getDb().query("SELECT config_revision, binding_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get("u1", created.id) as { config_revision: number; binding_revision: number };
      const secondBinding = getDb().query("SELECT binding_revision FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? AND slot_id = ?").get("u1", created.id, "writer") as { binding_revision: number };
      expect(rewritten.configRevision).toBe(second.config_revision);
      expect(second.binding_revision).toBe(secondBinding.binding_revision);
      expect(second.binding_revision).toBeGreaterThan(first.binding_revision);
      expect(secondBinding.binding_revision).toBeGreaterThan(firstBinding.binding_revision);
    });

    test("rolls back the preset row when normalized config persistence fails", () => {
      getDb().run(`
        CREATE TRIGGER reject_agent_config_insert
        BEFORE INSERT ON preset_agent_configs
        BEGIN
          SELECT RAISE(ABORT, 'config persistence failed');
        END
      `);

      expect(() => createPreset("u1", {
        name: "Atomic create",
        provider: "loom",
        agent_config: agentConfig,
      })).toThrow();
      expect(getDb().query("SELECT COUNT(*) AS count FROM presets WHERE name = ?").get("Atomic create")).toEqual({ count: 0 });
    });

    test("creates omitted-slot tombstones and rolls back preset fields on config CAS failure", () => {
      const slotConfig = {
        ...agentConfig,
        connectionSlots: [
          { id: "writer", label: "Writer", requiredCapabilities: ["generation" as const] },
          { id: "reviewer", label: "Reviewer", requiredCapabilities: ["generation" as const] },
        ],
      };
      const created = createPreset("u1", {
        name: "Atomic runtime",
        provider: "loom",
        prompt_order: [{ id: "before" }],
        agent_config: slotConfig,
      });
      const bindings = getDb().query(
        "SELECT slot_id, connection_id, state FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? ORDER BY slot_id",
      ).all("u1", created.id);
      expect(bindings).toEqual([
        { slot_id: "reviewer", connection_id: null, state: "review_required" },
        { slot_id: "writer", connection_id: null, state: "review_required" },
      ]);
      expect(() => updatePreset("u1", created.id, {
        prompt_order: [{ id: "after" }],
        agent_config: slotConfig,
        expected_cache_revision: created.cache_revision,
        expected_config_revision: 999,
      } as any)).toThrow("AGENT_CONFIG_REVISION_CONFLICT");
      const after = getPreset("u1", created.id)!;
      expect(after.prompt_order).toEqual([{ id: "before" }]);
      expect(after.cache_revision).toBe(created.cache_revision);
    });

    test("rejects stored V2 configs missing required tool-call limits", () => {
      const { maxToolCalls: _maxToolCalls, ...withoutToolCallLimit } = agentConfig;
      // Intentionally bypass the closed DTO to exercise runtime rejection.
      const incompleteInput = {
        name: "Agent without explicit tool limit",
        provider: "loom",
        agent_config: withoutToolCallLimit,
        metadata: { extensionData: { keep: true } },
      } as unknown as Parameters<typeof createPreset>[1];
      expect(() => createPreset("u1", incompleteInput)).toThrow();
    });

    test("does not execute legacy metadata when normalized authority is absent", () => {
      getDb().run(
        "INSERT INTO presets (id, name, provider, metadata, user_id, engine, cache_revision) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["legacy-only", "Legacy only", "loom", JSON.stringify({ agentConfig: { version: 1, enabled: true, mainToolIds: ["chat_search_history"] } }), "u1", "classic", 1],
      );


      const preset = getPreset("u1", "legacy-only");
      expect(preset?.agent_config).toBeUndefined();
      expect(preset?.agent_config_review).toBeUndefined();
      expect(preset?.metadata.agentConfig).toBeUndefined();
    });
    test("keeps malformed imported cognition in repair_required state", () => {
      const portable = JSON.parse(encodePortableAgentConfig(agentConfig)) as Record<string, unknown>;
      portable.cognitionPolicy = null;
      const imported = importPortablePreset("u1", {
        name: "Malformed cognition",
        provider: "loom",
        agent_config: portable,
      });

      expect(imported.agent_config_review).toMatchObject({
        state: "repair_required",
        reasonCode: "cognition_invalid",
        acknowledged: false,
      });
      expect(getDb().query(
        "SELECT state, review_code FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
      ).get("u1", imported.preset.id)).toEqual({
        state: "repair_required",
        review_code: "cognition_invalid",
      });
    });
    test("initializes normalized authority for an existing preset on runtime import", () => {
      insertPreset({ id: "runtime-only", name: "Runtime only", provider: "loom", user_id: "u1" });
      const imported = importPortablePresetRuntime("u1", {
        preset: { name: "Runtime replacement", provider: "loom" },
        agentRuntime: {
          version: 1,
          agentConfig: null,
          contextPacks: [],
          contextSelections: [],
          contextRules: [],
          taskTemplates: [],
        },
        existingPresetId: "runtime-only",
        expectedPresetRevision: 0,
      });

      expect(imported.preset.id).toBe("runtime-only");
      expect(imported.agent_config?.agentsEnabled).toBe(false);
      expect(imported.preset.agent_config_revision).toBe(1);
      expect(getDb().query("SELECT state, review_code FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get("u1", "runtime-only")).toEqual({
        state: "review_required",
        review_code: "foreign_import",
      });
    });


    test("rebases every authored prompt reference to the committed preset revision", () => {
      const created = createPreset("u1", {
        name: "Shared runtime draft",
        provider: "loom",
        prompt_order: [{ id: "old-block" }],
        agent_config: agentConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id);
      expect(before).not.toBeNull();

      const reference = (blockId: string) => ({
        blockId,
        expectedPresetRevision: 0,
        expectedBlockRevision: 1,
      });
      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: {
          ...agentConfig,
          phasePolicy: {
            work: [reference("work-block")],
            render: [reference("render-block")],
          },
          cognitionPolicy: {
            workPolicy: [reference("cognition-work")],
            workspaceUsage: [reference("workspace")],
            completionCriteria: [reference("completion")],
            renderPolicy: [reference("cognition-render")],
          },
        },
        slotBindings: [],
        contextPackSelections: [],
        contextRules: [],
        taskTemplates: [],
        reviewAcknowledgements: [],
        promptOrder: [{ id: "new-block" }],
        expectedPresetRevision: before!.presetRevision,
        expectedConfigRevision: before!.configRevision,
      });

      expect(saved.editor.presetRevision).toBe(before!.presetRevision + 1);
      const refs = [
        ...(saved.editor.config.phasePolicy?.work ?? []),
        ...(saved.editor.config.phasePolicy?.render ?? []),
        ...(saved.editor.config.cognitionPolicy?.workPolicy ?? []),
        ...(saved.editor.config.cognitionPolicy?.workspaceUsage ?? []),
        ...(saved.editor.config.cognitionPolicy?.completionCriteria ?? []),
        ...(saved.editor.config.cognitionPolicy?.renderPolicy ?? []),
      ];
      expect(refs).toHaveLength(6);
      expect(refs.every((item) => item.expectedPresetRevision === saved.editor.presetRevision)).toBe(true);
      expect(refs.every((item) => item.expectedBlockRevision === 1)).toBe(true);
    });

    test("keeps direct and rule-target context pack authority separate", () => {
      const rule = {
        id: "rule_one",
        packId: "rule-pack",
        revisionId: "rule-pack@2",
        required: true,
        dependencies: [],
      };
      const config = {
        ...agentConfig,
        contextPolicy: { packIds: ["direct-pack"], ruleIds: ["rule_one"] },
      };
      const created = createPreset("u1", { name: "Mixed context", provider: "loom", agent_config: config });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config,
        slotBindings: [],
        contextPackSelections: [
          { packId: "direct-pack", revisionId: "direct-pack@1", revision: 1, digest: "a".repeat(64) },
          { packId: "rule-pack", revisionId: "rule-pack@2", revision: 2, digest: "b".repeat(64) },
        ],
        contextRules: [rule],
        taskTemplates: [],
        reviewAcknowledgements: [],
        promptOrder: [],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(saved.editor.config.contextPolicy).toEqual({ packIds: ["direct-pack"], ruleIds: ["rule_one"] });
      expect(getPresetAgentCognitionSourceV1("u1", created.id)?.contextPackSelections.map((selection) => selection.packId)).toEqual(["direct-pack", "rule-pack"]);
      expect(getPresetAgentCognitionSourceV1("u1", created.id)?.contextRules).toEqual([rule]);
      expect(decodePortableAgentConfig(encodePortableAgentConfig(saved.editor.config)).contextPolicy).toEqual({
        packIds: ["direct-pack"],
        ruleIds: ["rule_one"],
      });
    });

    test("allows a rule-only context pack without direct attachment authority", () => {
      const rule = {
        id: "rule_only",
        packId: "rule-only-pack",
        revisionId: "rule-only-pack@1",
        required: false,
        dependencies: [],
      };
      const config = {
        ...agentConfig,
        contextPolicy: { packIds: [], ruleIds: ["rule_only"] },
      };
      const created = createPreset("u1", { name: "Rule-only context", provider: "loom", agent_config: config });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config,
        slotBindings: [],
        contextPackSelections: [{ packId: "rule-only-pack", revisionId: "rule-only-pack@1", revision: 1, digest: "c".repeat(64) }],
        contextRules: [rule],
        taskTemplates: [],
        reviewAcknowledgements: [],
        promptOrder: [],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(saved.editor.config.contextPolicy).toEqual({ packIds: [], ruleIds: ["rule_only"] });
      expect(getPresetAgentCognitionSourceV1("u1", created.id)?.contextPackSelections.map((selection) => selection.packId)).toEqual(["rule-only-pack"]);
      expect(getPresetAgentCognitionSourceV1("u1", created.id)?.contextRules).toEqual([rule]);
    });



    test("keeps unresolved slot reviews inert while recording explicit partial acknowledgement", () => {
      const slotConfig = {
        ...agentConfig,
        profiles: [{
          ...agentConfig.profiles[0],
          connectionRef: { kind: "slot" as const, slotId: "writer" },
        }],
        connectionSlots: [{ id: "writer", label: "Writer", requiredCapabilities: ["generation" as const] }],
      };
      const created = createPreset("u1", {
        name: "Unresolved runtime draft",
        provider: "loom",
        agent_config: slotConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const partial = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: slotConfig,
        slotBindings: [{ slotId: "writer", connectionId: null }],
        contextPackSelections: [],
        contextRules: [],
        taskTemplates: [],
        reviewAcknowledgements: [],
        promptOrder: [],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });
      expect(partial.editor.review.state).toBe("review_required");
      expect(partial.editor.review.items).toEqual([
        expect.objectContaining({ id: "slot:writer", acknowledged: false }),
      ]);

      const acknowledged = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: slotConfig,
        slotBindings: [{ slotId: "writer", connectionId: null }],
        contextPackSelections: [],
        contextRules: [],
        taskTemplates: [],
        reviewAcknowledgements: ["slot:writer"],
        promptOrder: [],
        expectedPresetRevision: partial.editor.presetRevision,
        expectedConfigRevision: partial.editor.configRevision,
      });
      expect(acknowledged.editor.review.state).toBe("review_required");
      expect(acknowledged.editor.review.items).toEqual([
        expect.objectContaining({ id: "slot:writer", acknowledged: true }),
      ]);
      expect(acknowledged.editor.config.agentsEnabled).toBe(true);
    });
    test("marks incompatible concrete slot bindings for review instead of ready", () => {
      getDb().run(
        "INSERT INTO connection_profiles (id, user_id, name, provider, model, metadata) VALUES (?, ?, ?, ?, ?, ?)",
        ["pollinations-no-tools", "u1", "Pollinations", "pollinations_text", "default", "{}"],
      );
      const slotConfig = {
        ...agentConfig,
        profiles: [{
          ...agentConfig.profiles[0],
          connectionRef: { kind: "slot" as const, slotId: "writer" },
        }],
        connectionSlots: [{
          id: "writer",
          label: "Writer",
          requiredCapabilities: ["tools_disabled_finalization" as const],
        }],
      };
      const created = createPreset("u1", {
        name: "Incompatible runtime binding",
        provider: "loom",
        agent_config: slotConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: slotConfig,
        slotBindings: [{ slotId: "writer", connectionId: "pollinations-no-tools" }],
        contextPackSelections: [],
        contextRules: [],
        taskTemplates: [],
        reviewAcknowledgements: [],
        promptOrder: [],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(saved.editor.review.state).toBe("review_required");
      expect(saved.editor.review.reasonCode).toBe("capability_mismatch");
      expect(saved.editor.review.items).toEqual([
        expect.objectContaining({
          id: "stale-slot:writer",
          kind: "capability_mismatch",
          acknowledged: false,
        }),
      ]);
      expect(getDb().query(
        "SELECT state, review_code FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? AND slot_id = ?",
      ).get("u1", created.id, "writer")).toEqual({
        state: "review_required",
        review_code: "capability_mismatch",
      });
      expect(saved.editor.config.agentsEnabled).toBe(true);
    });


    test("rolls back the prompt revision when review acknowledgement validation fails", () => {
      const created = createPreset("u1", {
        name: "Atomic review draft",
        provider: "loom",
        prompt_order: [{ id: "before" }],
        agent_config: agentConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      expect(() => saveAgentRuntimeSharedDraft("u1", created.id, {
        config: agentConfig,
        slotBindings: [],
        contextPackSelections: [],
        contextRules: [],
        taskTemplates: [],
        reviewAcknowledgements: ["review:unknown"],
        promptOrder: [{ id: "after" }],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      })).toThrow("AGENT_REVIEW_ACKNOWLEDGEMENT_UNKNOWN");

      const after = getAgentRuntimeSharedDraft("u1", created.id)!;
      expect(after.presetRevision).toBe(before.presetRevision);
      expect(getPreset("u1", created.id)?.prompt_order).toEqual([{ id: "before" }]);
    });

    test("rejects unknown slot references without exposing local connection IDs", () => {
      const invalidSlotConfig = {
        ...agentConfig,
        profiles: [{
          ...agentConfig.profiles[0],
          connectionRef: { kind: "slot" as const, slotId: "missing-slot" },
        }],
      };
      expect(() => validateAgentConfigForExecution("u1", invalidSlotConfig)).toThrow("unknown slot id");

      const disabledPreset = createPreset("u1", {
        name: "Imported disabled agent",
        provider: "loom",
        agent_config: { ...agentConfig, agentsEnabled: false },
      });
      expect(disabledPreset.agent_config?.agentsEnabled).toBe(false);
      expect(validateAgentConfigForExecution("u1", {
        ...agentConfig,
        agentsEnabled: false,
      }).agentsEnabled).toBe(false);
    });
  });

describe("presets.service — prompt stash", () => {
  test("syncs a stashed block globally while keeping visibility and grouping local", () => {
    const source: PromptBlock = {
      id: "source-block", name: "Shared prompt", content: "original", role: "system",
      enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false,
      color: null, injectionTrigger: [], group: null,
    };
    const stash = addPromptBlockToStash("u1", source);
    insertPreset({
      id: "p1", name: "One", provider: "loom", user_id: "u1",
      prompt_order: [{ ...source, id: "p1-block", stashId: stash.id }],
    });
    insertPreset({
      id: "p2", name: "Two", provider: "loom", user_id: "u1",
      prompt_order: [{ ...source, id: "p2-block", stashId: stash.id, enabled: false, group: "local-category" }],
    });

    updatePreset("u1", "p1", {
      prompt_order: [{ ...source, id: "p1-block", stashId: stash.id, content: "updated everywhere" }],
    });

    const second = getPreset("u1", "p2")!;
    expect(second.prompt_order[0]).toMatchObject({
      content: "updated everywhere",
      enabled: false,
      group: "local-category",
      stashId: stash.id,
    });
    expect(second.cache_revision).toBe(1);
  });

  test("un-stashing keeps linked blocks as independent local copies", () => {
    const source: PromptBlock = {
      id: "source-block", name: "Shared prompt", content: "keep this", role: "system",
      enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false,
      color: null, injectionTrigger: [], group: null,
    };
    const stash = addPromptBlockToStash("u1", source, { id: "origin", name: "Origin preset" });
    insertPreset({
      id: "p1", name: "One", provider: "loom", user_id: "u1",
      prompt_order: [{ ...source, id: "p1-block", stashId: stash.id, enabled: false, group: "local-category" }],
    });

    expect(removePromptBlockFromStash("u1", stash.id)).toBe(true);
    expect(getPreset("u1", "p1")?.prompt_order[0]).toMatchObject({
      content: "keep this", enabled: false, group: "local-category",
    });
    expect(getPreset("u1", "p1")?.prompt_order[0].stashId).toBeUndefined();
  });
});
