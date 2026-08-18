import { getDb } from "../db/connection";
import type { Database } from "bun:sqlite";
import type {
  AgentCapabilityV1,
  AgentConfigReviewV1,
  AgentConfigStateV1,
  AgentConfigV2,
  AgentConnectionSlotV1,
  AgentProfileConfigV2,
  PortableAgentConfigV1,
} from "../types/agents";
import {
  AGENT_CAPABILITIES,
  createDisabledAgentConfigV2,
  parseAgentConfigV2,
  parsePortableAgentConfigV1,
  toPortableAgentConfigV1,
} from "../types/agents";
import { WORKSPACE_OPERATIONS, type WorkspaceOperationKindV1 } from "../types/turn-workspace";
import type { ContextActivationRuleV1 } from "../types/agent-cognition";
import { createPortableContextPackSnapshotId, parsePortableContextPackSnapshotV1, type PortableContextPackSnapshotV1 } from "../types/agent-context-packs";
import * as contextPacksService from "./agent-context-packs.service";
import type { Preset } from "../types/preset";
import { normalizeImportedCognition, validateCognitionIntegrity } from "./agent-cognition-integrity.service";
import { parseContextActivationRule, parseTaskTemplate } from "./agent-cognition.service";
import { getAgentRuntimeHostLimits } from "./agent-runtime-limits";
import { resolveConcreteConnectionV1, type ResolvedConcreteConnectionV1 } from "./connections.service";
import * as regexScriptsService from "./regex-scripts.service";

export const AGENT_RUNTIME_RESERVED_PRESET_KEYS = Object.freeze([
  "agent_config",
  "agent_config_revision",
  "agent_config_review",
  "agent_config_review_required",
  "agentConfig",
  "agentConfigRevision",
  "agentConfigReview",
  "agentConfigReviewRequired",
  "portableAgentConfig",
  "portable_agent_config",
  "agentRuntime",
  "agent_runtime",
] as const);
const RESERVED_METADATA_KEYS = new Set<string>(AGENT_RUNTIME_RESERVED_PRESET_KEYS);

export interface PresetAgentSlotBindingV1 {
  slotId: string;
  connectionId: string | null;
  bindingRevision: number;
  state: AgentConfigStateV1;
  reviewCode: string | null;
}

export interface PresetAgentConfigProjection {
  config: AgentConfigV2;
  review: AgentConfigReviewV1;
  configRevision: number;
  /** High-water mark across deleted/recreated slot bindings. */
  bindingRevision: number;
  bindings: PresetAgentSlotBindingV1[];
}

export interface AgentConfigWriteInput {
  config: unknown;
  bindings?: readonly { slotId: string; connectionId: string | null }[];
  expectedConfigRevision?: number;
  review?: Partial<AgentConfigReviewV1>;
  /** Retain an invalid imported cognition payload for authenticated repair. */
  cognitionPolicyOverride?: unknown;
  authoredDraft?: unknown;
}

export interface AgentConfigWriteResult extends PresetAgentConfigProjection {
  presetId: string;
}

export interface PortablePresetPayload {
  name: string;
  provider: string;
  engine?: string;
  parameters?: Record<string, unknown>;
  prompt_order?: unknown[];
  prompts?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  agent_config?: unknown;
  regex_scripts?: readonly Record<string, unknown>[];
  regexScripts?: readonly Record<string, unknown>[];
}

export interface PortablePresetRuntimeContextSelectionV1 {
  packSnapshotId: string;
  revisionId: string;
  digest: string;
}

export interface PortablePresetRuntimeEnvelopeV1 {
  version: 1;
  agentConfig: PortableAgentConfigV1 | null;
  contextPacks: readonly PortableContextPackSnapshotV1[];
  contextSelections: readonly PortablePresetRuntimeContextSelectionV1[];
  contextRules: readonly unknown[];
  taskTemplates: readonly unknown[];
}

export interface PortablePresetImportResult {
  preset: Preset;
  agent_config: AgentConfigV2;
  agent_config_review: AgentConfigReviewV1;
}

export interface PresetDuplicateResult {
  preset: Preset;
  agent_config: AgentConfigV2;
  agent_config_review: AgentConfigReviewV1;
  copiedRegexScriptIds: string[];
}

export interface ChatAgentModeOverride {
  mode: "response" | "agentic" | null;
  revision: number;
  state: AgentConfigStateV1;
  reviewCode: string | null;
  acknowledged: boolean;
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function scrubMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (RESERVED_METADATA_KEYS.has(key)) continue;
    output[key] = entry;
  }
  return output;
}

function parseJsonObject(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonArray(value: unknown, fallback: unknown[] = []): unknown[] {
  if (!Array.isArray(value) && typeof value !== "string") return fallback;
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Normalize already-materialized rows defensively. Writers and ingress parsers
 * reject malformed grants; a corrupt/imported row must not leak an unknown or
 * duplicate operation into runtime, so reads fail closed to no grant.
 */
function readWorkspaceCapabilities(value: unknown): WorkspaceOperationKindV1[] {
  const raw = parseJsonArray(value);
  if (raw.length === 0) return [];
  const seen = new Set<string>();
  let previousIndex = -1;
  const normalized: WorkspaceOperationKindV1[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return [];
    const operationIndex = WORKSPACE_OPERATIONS.indexOf(entry as WorkspaceOperationKindV1);
    if (operationIndex < 0 || operationIndex <= previousIndex || seen.has(entry)) return [];
    seen.add(entry);
    previousIndex = operationIndex;
    normalized.push(entry as WorkspaceOperationKindV1);
  }
  return normalized;
}

function hasConnectionCapability(
  connection: ResolvedConcreteConnectionV1 | null,
  requirement: AgentCapabilityV1,
): boolean {
  if (!connection) return false;
  if (requirement === "generation") return true;
  const capabilities = connection.capabilities as Readonly<Record<string, unknown>>;
  if (requirement === "streaming") {
    return capabilities.supportsStreaming === true || capabilities.streaming === true;
  }
  if (requirement === "tool_calling") {
    return capabilities.toolCalling === true || capabilities.tool_calling === true || capabilities.supportsToolCalling === true;
  }
  if (requirement === "native_tool_continuation") {
    const mode = capabilities.toolContinuationMode ?? capabilities.tool_continuation_mode;
    if (mode === "native") {
      return (capabilities.nativeToolContinuation === true || capabilities.native_tool_continuation === true)
        && hasConnectionCapability(connection, "tool_calling");
    }
    if (mode === "legacy") return hasConnectionCapability(connection, "tool_calling");
    return false;
  }
  return capabilities.toolsDisabledFinalization === true
    || capabilities.tools_disabled_finalization === true
    || capabilities.supportsToolsDisabledFinalization === true
    || capabilities.supportsToolFinalization === true;
}

interface BindingCapabilityValidation {
  state: AgentConfigStateV1;
  reviewCode: string | null;
}

function validateBindingCapabilities(
  userId: string,
  slot: AgentConnectionSlotV1,
  connectionId: string | null,
  connectionCache: Map<string, ResolvedConcreteConnectionV1 | null>,
): BindingCapabilityValidation {
  if (connectionId === null) return { state: "review_required", reviewCode: "unresolved_slot" };
  const requirements = slot.requiredCapabilities.filter((value): value is AgentCapabilityV1 => (
    (AGENT_CAPABILITIES as readonly string[]).includes(value)
  ));
  if (requirements.length === 0) return { state: "ready", reviewCode: null };

  let connection = connectionCache.get(connectionId);
  if (connection === undefined && !connectionCache.has(connectionId)) {
    try {
      connection = resolveConcreteConnectionV1(userId, connectionId);
    } catch {
      connection = null;
    }
    connectionCache.set(connectionId, connection);
  }
  const missing = requirements.filter((requirement) => !hasConnectionCapability(connection ?? null, requirement));
  return missing.length > 0
    ? { state: "review_required", reviewCode: "capability_mismatch" }
    : { state: "ready", reviewCode: null };
}

function rowReview(
  db: Database,
  userId: string,
  presetId: string,
  state: AgentConfigStateV1,
  reviewCode: string | null,
  reviewAcknowledged = false,
  projectedBindings?: readonly PresetAgentSlotBindingV1[],
): AgentConfigReviewV1 {
  const unresolvedSlotIds = new Set<string>();
  const staleSlotIds = new Set<string>();
  const rows = projectedBindings ?? (
    tableExists(db, "preset_agent_slot_bindings")
      ? db.query("SELECT slot_id, connection_id, binding_revision, state, review_code FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ?").all(userId, presetId) as Array<Record<string, unknown>>
      : []
  );
  for (const row of rows) {
    const slotId = String("slotId" in row ? row.slotId : row.slot_id);
    const rowState = ("state" in row ? row.state : null) as AgentConfigStateV1;
    const rowReviewCode = ("reviewCode" in row ? row.reviewCode : row.review_code) as string | null | undefined;
    if (rowState === "repair_required" || rowReviewCode === "unresolved_slot" || rowReviewCode === "foreign_connection") unresolvedSlotIds.add(slotId);
    else if (rowState === "review_required") staleSlotIds.add(slotId);
  }
  const effectiveState: AgentConfigStateV1 = state === "repair_required"
    ? "repair_required"
    : unresolvedSlotIds.size > 0 || staleSlotIds.size > 0
      ? "review_required"
      : state;
  const effectiveReasonCode = reviewCode
    ?? (rows.some((row) => ("reviewCode" in row ? row.reviewCode : row.review_code) === "capability_mismatch") ? "capability_mismatch" : null);
  return {
    state: effectiveState,
    reasonCode: effectiveReasonCode,
    unresolvedSlotIds: [...unresolvedSlotIds].sort(),
    staleSlotIds: [...staleSlotIds].sort(),
    acknowledged: reviewAcknowledged
      && effectiveState === "ready"
      && unresolvedSlotIds.size === 0
      && staleSlotIds.size === 0,
  };
}


function cognitionReview(userId: string, presetId: string, config: AgentConfigV2, source: "local" | "legacy" | "imported" | "foreign", importedReviewRequired = false): { state: AgentConfigStateV1; reasonCode: string | null } {
  if (config.cognitionPolicy === undefined) return { state: "ready", reasonCode: null };
  const validation = validateCognitionIntegrity({ userId, presetId, cognition: config.cognitionPolicy, source, importedReviewRequired, repairRequired: false });
  return validation.valid ? { state: "ready", reasonCode: null } : { state: importedReviewRequired || source === "foreign" || source === "imported" || source === "legacy" ? "review_required" : "repair_required", reasonCode: validation.repairCode };
}

function rowToConfig(row: Record<string, unknown>, profiles: AgentProfileConfigV2[], slots: AgentConnectionSlotV1[]): AgentConfigV2 {
  const config: AgentConfigV2 = {
    version: 2,
    agentsEnabled: Number(row.agents_enabled) === 1,
    allowedModes: parseJsonArray(row.allowed_modes, ["response"]) as AgentConfigV2["allowedModes"],
    defaultMode: row.default_mode === "agentic" ? "agentic" : "response",
    maxInvocations: Number(row.max_invocations) >= 1 ? Number(row.max_invocations) : 64,
    maxToolCalls: Number(row.max_tool_calls) >= 1 ? Number(row.max_tool_calls) : 64,
    mainToolIds: parseJsonArray(row.main_tool_ids) as AgentConfigV2["mainToolIds"],
    mainLoreScope: row.main_lore_scope === "all_owned" ? "all_owned" : "active",
    profiles,
    connectionSlots: slots,
  };
  const phasePolicy = parseJsonObject(row.phase_policy_json);
  const cognitionPolicy = parseJsonObject(row.cognition_policy_json);
  const contextPolicy = parseJsonObject(row.context_policy_json);
  const taskPolicy = parseJsonObject(row.task_policy_json);
  const workspacePolicy = parseJsonObject(row.workspace_policy_json);
  if (Object.keys(phasePolicy).length) config.phasePolicy = phasePolicy as unknown as AgentConfigV2["phasePolicy"];
  if (Object.keys(cognitionPolicy).length) config.cognitionPolicy = cognitionPolicy as unknown as AgentConfigV2["cognitionPolicy"];
  if (Object.keys(contextPolicy).length) config.contextPolicy = contextPolicy as unknown as AgentConfigV2["contextPolicy"];
  if (Object.keys(taskPolicy).length) config.taskPolicy = taskPolicy as unknown as AgentConfigV2["taskPolicy"];
  if (Object.keys(workspacePolicy).length) config.workspacePolicy = workspacePolicy as unknown as AgentConfigV2["workspacePolicy"];
  try {
    return parseAgentConfigV2(config);
  } catch (error) {
    if (row.state === "review_required" || row.state === "repair_required") {
      return createDisabledAgentConfigV2();
    }
    throw error;
  }
}

function readNormalizedProjection(db: Database, userId: string, presetId: string): PresetAgentConfigProjection | null {
  if (!tableExists(db, "preset_agent_configs")) return null;
  const row = db.query("SELECT * FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as Record<string, unknown> | null;
  if (!row) return null;
  const profileRows = tableExists(db, "preset_agent_profiles")
    ? db.query("SELECT * FROM preset_agent_profiles WHERE user_id = ? AND preset_id = ? ORDER BY rowid ASC").all(userId, presetId) as Array<Record<string, unknown>>
    : [];
  const slotRows = tableExists(db, "preset_agent_connection_slots")
    ? db.query("SELECT * FROM preset_agent_connection_slots WHERE user_id = ? AND preset_id = ? ORDER BY rowid ASC").all(userId, presetId) as Array<Record<string, unknown>>
    : [];
  const slots: AgentConnectionSlotV1[] = slotRows.map((slot) => ({
    id: String(slot.slot_id),
    label: String(slot.label ?? slot.slot_id),
    requiredCapabilities: parseJsonArray(slot.required_capabilities) as AgentCapabilityV1[],
  }));
  const profiles: AgentProfileConfigV2[] = profileRows.map((profile) => ({
    id: String(profile.profile_id),
    name: String(profile.name ?? ""),
    systemPrompt: String(profile.system_prompt ?? ""),
    connectionRef: profile.connection_ref_kind === "slot"
      ? { kind: "slot", slotId: String(profile.slot_id) }
      : { kind: "inherit_main" },
    toolIds: parseJsonArray(profile.tool_ids) as AgentProfileConfigV2["toolIds"],
    workspaceCapabilities: readWorkspaceCapabilities(profile.workspace_capabilities),
    loreScope: profile.lore_scope === "all_owned" ? "all_owned" : "active",
    allowMainDelegation: Number(profile.allow_main_delegation) === 1,
    failurePolicy: profile.failure_policy === "required" ? "required" : "optional",
    streamActivity: Number(profile.stream_activity) === 1,
    maxOutputTokens: Number(profile.max_output_tokens),
    timeoutMs: Number(profile.timeout_ms),
  }));
  const config = rowToConfig(row, profiles, slots);
  const bindings: PresetAgentSlotBindingV1[] = tableExists(db, "preset_agent_slot_bindings")
    ? (db.query("SELECT slot_id, connection_id, binding_revision, state, review_code FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? ORDER BY slot_id").all(userId, presetId) as Array<Record<string, unknown>>).map((binding) => ({
      slotId: String(binding.slot_id),
      connectionId: binding.connection_id == null ? null : String(binding.connection_id),
      bindingRevision: Number(binding.binding_revision) || 1,
      state: (binding.state === "repair_required" || binding.state === "review_required" ? binding.state : "ready") as AgentConfigStateV1,
      reviewCode: binding.review_code == null ? null : String(binding.review_code),
    }))
    : [];
  const connectionCache = new Map<string, ResolvedConcreteConnectionV1 | null>();
  for (const binding of bindings) {
    if (binding.connectionId === null) continue;
    const slot = slots.find((candidate) => candidate.id === binding.slotId);
    if (!slot) continue;
    const validation = validateBindingCapabilities(userId, slot, binding.connectionId, connectionCache);
    if (validation.reviewCode === "capability_mismatch") {
      // Projection is intentionally live: a provider capability change cannot
      // leave an otherwise-ready binding looking executable until it is saved.
      binding.state = "review_required";
      binding.reviewCode = validation.reviewCode;
    }
  }
  const state = (row.state === "repair_required" || row.state === "review_required" ? row.state : "ready") as AgentConfigStateV1;
  const persistedReview = rowReview(
    db,
    userId,
    presetId,
    state,
    row.review_code == null ? null : String(row.review_code),
    Number(row.review_acknowledged) === 1,
    bindings,
  );
  const cognition = cognitionReview(
    userId,
    presetId,
    config,
    state === "review_required" ? "foreign" : "local",
    state === "review_required",
  );
  const review = cognition.state === "ready"
    ? persistedReview
    : { ...persistedReview, state: cognition.state, reasonCode: cognition.reasonCode, acknowledged: false };
  return {
    config,
    review,
    configRevision: Number(row.config_revision) || 1,
    bindingRevision: Number(row.binding_revision) || Math.max(1, ...bindings.map((binding) => binding.bindingRevision)),
    bindings,
  };
}

export function getPresetAgentConfig(userId: string, presetId: string): PresetAgentConfigProjection | null {
  const db = getDb();
  // Only the normalized V2 projection has executable authority. Missing rows
  // remain inert.
  return readNormalizedProjection(db, userId, presetId);
}


function assertPresetOwned(db: Database, userId: string, presetId: string): Record<string, unknown> {
  const row = db.query("SELECT * FROM presets WHERE id = ? AND user_id = ?").get(presetId, userId) as Record<string, unknown> | null;
  if (!row) throw new Error("Preset not found");
  return row;
}
interface PreparedWriteConfig {
  config: AgentConfigV2;
}

export type AgentConfigWritePreparation = PreparedWriteConfig;

export function preparePresetAgentConfigForWrite(raw: unknown): AgentConfigWritePreparation {
  return { config: parseAgentConfigV2(raw) };
}



function writeAgentConfigWithDb(
  db: Database,
  userId: string,
  presetId: string,
  input: AgentConfigWriteInput,
  preparedOverride?: AgentConfigWritePreparation,
): AgentConfigWriteResult {
  assertPresetOwned(db, userId, presetId);
  const current = readNormalizedProjection(db, userId, presetId);
  const currentConfigRevision = current?.configRevision ?? 0;
  if (input.expectedConfigRevision !== undefined && input.expectedConfigRevision !== currentConfigRevision) throw new Error("AGENT_CONFIG_REVISION_CONFLICT");
  const prepared = preparedOverride ?? preparePresetAgentConfigForWrite(input.config);
  const config = prepared.config;
  const persistedBindings = current?.bindings
    .filter((binding) => config.connectionSlots.some((slot) => slot.id === binding.slotId))
    .map((binding) => ({ slotId: binding.slotId, connectionId: binding.connectionId })) ?? [];
  const previousBindingRevisions = new Map((current?.bindings ?? []).map((binding) => [binding.slotId, binding.bindingRevision]));
  let bindingRevisionHighWater = Math.max(1, current?.bindingRevision ?? 0, currentConfigRevision, ...previousBindingRevisions.values());
  const bindings = [...(input.bindings ?? persistedBindings)];
  for (const slot of config.connectionSlots) {
    if (!bindings.some((binding) => binding.slotId === slot.id)) bindings.push({ slotId: slot.id, connectionId: null });
  }
  for (const slotId of input.review?.unresolvedSlotIds ?? []) {
    if (!bindings.some((binding) => binding.slotId === slotId)) bindings.push({ slotId, connectionId: null });
  }
  const connectionCache = new Map<string, ResolvedConcreteConnectionV1 | null>();
  const bindingValidation = new Map<string, BindingCapabilityValidation>();
  for (const binding of bindings) {
    const slot = config.connectionSlots.find((candidate) => candidate.id === binding.slotId);
    if (slot) bindingValidation.set(binding.slotId, validateBindingCapabilities(userId, slot, binding.connectionId, connectionCache));
  }
  const hasCapabilityMismatch = [...bindingValidation.values()].some((validation) => validation.reviewCode === "capability_mismatch");
  const replacementCognition = cognitionReview(userId, presetId, config, "local", false);
  const inheritedRepairRequired = (current?.review.state === "repair_required" || input.review?.state === "repair_required")
    && replacementCognition.state !== "ready";
  const requestedReviewState = input.review?.state ?? "ready";
  const cognition = cognitionReview(userId, presetId, config, requestedReviewState === "review_required" ? "foreign" : "local", requestedReviewState !== "ready");
  const reviewState = cognition.state === "ready"
    ? inheritedRepairRequired
      ? "repair_required"
      : hasCapabilityMismatch
        ? "review_required"
        : requestedReviewState
    : cognition.state;
  let reviewCode: string | null = cognition.reasonCode;
  if (reviewCode === null && inheritedRepairRequired) {
    reviewCode = current?.review.reasonCode ?? input.review?.reasonCode ?? null;
  }
  if (reviewCode === null && hasCapabilityMismatch) reviewCode = "capability_mismatch";
  if (reviewCode === null) reviewCode = input.review?.reasonCode ?? null;
  const now = Math.floor(Date.now() / 1000);
  const nextRevision = currentConfigRevision + 1;
  db.query(`INSERT INTO preset_agent_configs (user_id, preset_id, version, agents_enabled, allowed_modes, default_mode, max_invocations, max_tool_calls, main_tool_ids, main_lore_scope, phase_policy_json, cognition_policy_json, context_policy_json, task_policy_json, workspace_policy_json, config_json, state, review_code, review_acknowledged, config_revision, binding_revision, created_at, updated_at) VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, preset_id) DO UPDATE SET agents_enabled = excluded.agents_enabled, allowed_modes = excluded.allowed_modes, default_mode = excluded.default_mode, max_invocations = excluded.max_invocations, max_tool_calls = excluded.max_tool_calls, main_tool_ids = excluded.main_tool_ids, main_lore_scope = excluded.main_lore_scope, phase_policy_json = excluded.phase_policy_json, cognition_policy_json = excluded.cognition_policy_json, context_policy_json = excluded.context_policy_json, task_policy_json = excluded.task_policy_json, workspace_policy_json = excluded.workspace_policy_json, config_json = excluded.config_json, state = excluded.state, review_code = excluded.review_code, review_acknowledged = excluded.review_acknowledged, config_revision = excluded.config_revision, binding_revision = excluded.binding_revision, updated_at = excluded.updated_at`).run(userId, presetId, config.agentsEnabled ? 1 : 0, JSON.stringify(config.allowedModes), config.defaultMode, config.maxInvocations, config.maxToolCalls, JSON.stringify(config.mainToolIds), config.mainLoreScope, JSON.stringify(config.phasePolicy ?? {}), JSON.stringify(input.cognitionPolicyOverride ?? config.cognitionPolicy ?? {}), JSON.stringify(config.contextPolicy ?? {}), JSON.stringify(config.taskPolicy ?? {}), JSON.stringify(config.workspacePolicy ?? {}), JSON.stringify(input.authoredDraft ?? {}), reviewState, reviewCode, input.review?.acknowledged ? 1 : 0, nextRevision, bindingRevisionHighWater, now, now);
  db.query("DELETE FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ?").run(userId, presetId);
  db.query("DELETE FROM preset_agent_profiles WHERE user_id = ? AND preset_id = ?").run(userId, presetId);
  db.query("DELETE FROM preset_agent_connection_slots WHERE user_id = ? AND preset_id = ?").run(userId, presetId);
  for (const slot of config.connectionSlots) db.query("INSERT INTO preset_agent_connection_slots (user_id, preset_id, slot_id, label, required_capabilities, slot_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(userId, presetId, slot.id, slot.label, JSON.stringify(slot.requiredCapabilities), now, now);
  for (const profile of config.profiles) db.query("INSERT INTO preset_agent_profiles (user_id, preset_id, profile_id, name, system_prompt, connection_ref_kind, slot_id, tool_ids, workspace_capabilities, lore_scope, allow_main_delegation, failure_policy, stream_activity, max_output_tokens, timeout_ms, profile_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").run(userId, presetId, profile.id, profile.name, profile.systemPrompt, profile.connectionRef.kind, profile.connectionRef.kind === "slot" ? profile.connectionRef.slotId : null, JSON.stringify(profile.toolIds), JSON.stringify(profile.workspaceCapabilities ?? []), profile.loreScope, profile.allowMainDelegation ? 1 : 0, profile.failurePolicy, profile.streamActivity ? 1 : 0, profile.maxOutputTokens, profile.timeoutMs, now, now);
  for (const binding of bindings) {
    const slot = config.connectionSlots.find((candidate) => candidate.id === binding.slotId);
    if (!slot) throw new Error(`Unknown agent connection slot: ${binding.slotId}`);
    if (binding.connectionId !== null && !db.query("SELECT 1 FROM connection_profiles WHERE user_id = ? AND id = ?").get(userId, binding.connectionId)) throw new Error("Agent connection binding is not owned by this user");
    const bindingRevision = ++bindingRevisionHighWater;
    const validation = bindingValidation.get(binding.slotId) ?? validateBindingCapabilities(userId, slot, binding.connectionId, connectionCache);
    const bindingState = validation.state;
    const bindingReviewCode = validation.reviewCode;
    db.query("INSERT INTO preset_agent_slot_bindings (user_id, preset_id, slot_id, connection_id, binding_revision, state, review_code, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(userId, presetId, binding.slotId, binding.connectionId, bindingRevision, bindingState, bindingReviewCode, now);
  }
  if (bindingRevisionHighWater !== Number(current?.bindingRevision ?? 0)) {
    db.query("UPDATE preset_agent_configs SET binding_revision = ? WHERE user_id = ? AND preset_id = ?").run(bindingRevisionHighWater, userId, presetId);
  }
  const projection = readNormalizedProjection(db, userId, presetId);
  if (!projection) throw new Error("Agent config write did not produce a projection");
  return { ...projection, presetId };
}
export function writePresetAgentConfigWithDb(
  db: Database,
  userId: string,
  presetId: string,
  input: AgentConfigWriteInput,
  preparedOverride?: AgentConfigWritePreparation,
): AgentConfigWriteResult {
  return writeAgentConfigWithDb(db, userId, presetId, input, preparedOverride);
}

export function writePresetAgentConfig(userId: string, presetId: string, input: AgentConfigWriteInput): AgentConfigWriteResult {
  const db = getDb(); return db.transaction(() => writeAgentConfigWithDb(db, userId, presetId, input))();
}

export function encodePortableAgentConfig(config: AgentConfigV2): string { return JSON.stringify(toPortableAgentConfigV1(config)); }


function assertExactObjectKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort().join(",");
  const wanted = [...expected].sort().join(",");
  if (actual !== wanted) throw new Error(`${path} contains unknown or missing fields`);
}

export function getPortablePresetRuntimeEnvelope(userId: string, presetId: string): PortablePresetRuntimeEnvelopeV1 | null {
  const projection = getPresetAgentConfig(userId, presetId);
  if (!projection) return null;
  const source = getPresetAgentCognitionSourceV1(userId, presetId);
  const directSelections = source?.contextPackSelections.map(({ packId, revision, digest }) => ({ packId, revision, digest })) ?? [];
  const contextPacks = [...contextPacksService.getPortablePresetContextPackSnapshots(userId, presetId, directSelections)];
  const snapshotsByKey = new Map<string, PortableContextPackSnapshotV1>();
  for (const selection of directSelections) {
    const snapshot = contextPacks.find((candidate) =>
      candidate.snapshotId === createPortableContextPackSnapshotId(selection.digest, selection.revision, selection.packId),
    );
    if (snapshot) snapshotsByKey.set(`${selection.packId}\u0000${selection.revision}`, snapshot);
  }
  const selections: PortablePresetRuntimeContextSelectionV1[] = [];
  const selectionByPack = new Map<string, PortablePresetRuntimeContextSelectionV1>();
  const contextRules: unknown[] = [];
  const taskTemplates: unknown[] = [];
  if (source) {
    for (const selection of source.contextPackSelections) {
      const snapshot = snapshotsByKey.get(`${selection.packId}\u0000${selection.revision}`);
      if (!snapshot) throw new Error("AGENT_RUNTIME_PORTABLE_CONTEXT_MISSING");
      const output = { packSnapshotId: snapshot.snapshotId, revisionId: `${snapshot.snapshotId}@${snapshot.revision}`, digest: snapshot.contentDigest };
      const existing = selectionByPack.get(selection.packId);
      if (existing) {
        if (existing.packSnapshotId !== output.packSnapshotId || existing.revisionId !== output.revisionId || existing.digest !== output.digest) {
          throw new Error("AGENT_RUNTIME_PORTABLE_CONTEXT_DUPLICATE");
        }
        continue;
      }
      selections.push(output);
      selectionByPack.set(selection.packId, output);
    }
    for (const rawRule of source.contextRules) {
      const rule = parseContextActivationRule(rawRule);
      const selection = selectionByPack.get(rule.packId);
      if (!selection || selection.revisionId !== `${selection.packSnapshotId}@${rule.revisionId.split("@").at(-1)}`) throw new Error("AGENT_RUNTIME_PORTABLE_CONTEXT_REFERENCE_INVALID");
      contextRules.push({ ...rule, packId: selection.packSnapshotId, revisionId: selection.revisionId });
    }
    taskTemplates.push(...source.taskTemplates);
  }
  const authored = toPortableAgentConfigV1(projection.config);
  const directPackIds = authored.contextPolicy?.packIds.map((packId) => {
    const selection = selectionByPack.get(packId);
    if (!selection) throw new Error("AGENT_RUNTIME_PORTABLE_CONTEXT_REFERENCE_INVALID");
    return selection.packSnapshotId;
  }) ?? [];
  const agentConfig = authored.contextPolicy
    ? { ...authored, contextPolicy: { ...authored.contextPolicy, packIds: directPackIds } }
    : authored;
  return { version: 1, agentConfig, contextPacks, contextSelections: selections, contextRules, taskTemplates };
}

export function parsePortablePresetRuntimeEnvelope(raw: unknown): PortablePresetRuntimeEnvelopeV1 {
  const object = parsePortableWireObject(raw);
  assertExactObjectKeys(object, ["version", "agentConfig", "contextPacks", "contextSelections", "contextRules", "taskTemplates"], "agentRuntime");
  if (object.version !== 1) throw new Error("AGENT_RUNTIME_PORTABLE_VERSION_UNSUPPORTED");
  const agentConfig = object.agentConfig === null ? null : parsePortableAgentConfigV1(object.agentConfig);
  if (!Array.isArray(object.contextPacks) || !Array.isArray(object.contextSelections) || !Array.isArray(object.contextRules) || !Array.isArray(object.taskTemplates)) throw new Error("AGENT_RUNTIME_PORTABLE_INVALID");
  const contextPacks: PortableContextPackSnapshotV1[] = [];
  const bySnapshotId = new Map<string, PortableContextPackSnapshotV1>();
  for (const [index, rawSnapshot] of object.contextPacks.entries()) {
    let snapshot: PortableContextPackSnapshotV1;
    try {
      snapshot = parsePortableContextPackSnapshotV1(rawSnapshot);
    } catch {
      throw new Error(`AGENT_RUNTIME_PORTABLE_CONTEXT_INVALID:${index}`);
    }
    const existing = bySnapshotId.get(snapshot.snapshotId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error("AGENT_RUNTIME_PORTABLE_CONTEXT_DUPLICATE");
      continue;
    }
    bySnapshotId.set(snapshot.snapshotId, snapshot);
    contextPacks.push(snapshot);
  }
  const contextSelections: PortablePresetRuntimeContextSelectionV1[] = [];
  const selectionById = new Map<string, PortablePresetRuntimeContextSelectionV1>();
  for (const [index, rawSelection] of object.contextSelections.entries()) {
    if (typeof rawSelection !== "object" || rawSelection === null || Array.isArray(rawSelection)) throw new Error(`AGENT_RUNTIME_PORTABLE_SELECTION_INVALID:${index}`);
    const selection = rawSelection as Record<string, unknown>;
    assertExactObjectKeys(selection, ["packSnapshotId", "revisionId", "digest"], `contextSelections[${index}]`);
    const snapshot = typeof selection.packSnapshotId === "string" ? bySnapshotId.get(selection.packSnapshotId) : undefined;
    if (!snapshot || typeof selection.revisionId !== "string" || typeof selection.digest !== "string") throw new Error(`AGENT_RUNTIME_PORTABLE_SELECTION_INVALID:${index}`);
    if (selection.revisionId !== `${snapshot.snapshotId}@${snapshot.revision}` || selection.digest !== snapshot.contentDigest) throw new Error(`AGENT_RUNTIME_PORTABLE_SELECTION_MISMATCH:${index}`);
    const normalized = { packSnapshotId: snapshot.snapshotId, revisionId: selection.revisionId, digest: selection.digest };
    const existing = selectionById.get(normalized.packSnapshotId);
    if (existing) {
      if (existing.revisionId !== normalized.revisionId || existing.digest !== normalized.digest) throw new Error(`AGENT_RUNTIME_PORTABLE_SELECTION_MISMATCH:${index}`);
      continue;
    }
    contextSelections.push(normalized);
    selectionById.set(normalized.packSnapshotId, normalized);
  }
  const selectionIds = new Set(contextSelections.map((selection) => selection.packSnapshotId));
  const contextRules = object.contextRules.map((rawRule, index) => {
    const rule = parseContextActivationRule(rawRule);
    const selection = selectionById.get(rule.packId);
    if (!selection || rule.revisionId !== selection.revisionId) throw new Error(`AGENT_RUNTIME_PORTABLE_RULE_INVALID:${index}`);
    return rule;
  });
  const taskTemplates = object.taskTemplates.map((template) => parseTaskTemplate(template));
  const policy = agentConfig?.contextPolicy;
  if ((contextSelections.length > 0 || contextRules.length > 0) && !policy) throw new Error("AGENT_RUNTIME_PORTABLE_CONFIG_REFERENCE_INVALID");
  if (policy) {
    if (policy.packIds.some((id) => !selectionIds.has(id))) throw new Error("AGENT_RUNTIME_PORTABLE_CONFIG_REFERENCE_INVALID");
    const ruleIds = new Set(contextRules.map((rule) => rule.id));
    if (policy.ruleIds.some((id) => !ruleIds.has(id)) || contextRules.some((rule) => !policy.ruleIds.includes(rule.id))) {
      throw new Error("AGENT_RUNTIME_PORTABLE_CONFIG_REFERENCE_INVALID");
    }
    const referencedPackIds = new Set([...policy.packIds, ...contextRules.map((rule) => rule.packId)]);
    if ([...selectionIds].some((id) => !referencedPackIds.has(id))) throw new Error("AGENT_RUNTIME_PORTABLE_CONFIG_REFERENCE_INVALID");
  }
  return { version: 1, agentConfig, contextPacks, contextSelections, contextRules, taskTemplates };
}
function parsePortableWireObject(raw: unknown): Record<string, unknown> {
  if (raw instanceof Uint8Array) raw = new TextDecoder().decode(raw);
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { throw new Error("PORTABLE_AGENT_CONFIG_INVALID"); }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error("PORTABLE_AGENT_CONFIG_INVALID");
  return raw as Record<string, unknown>;
}

function parsePortablePresetPayload(raw: unknown): PortablePresetPayload {
  const object = parsePortableWireObject(raw);
  const allowed: Record<string, true> = {
    name: true, provider: true, engine: true, parameters: true, prompt_order: true,
    prompts: true, metadata: true, regex_scripts: true, regexScripts: true,
  };
  for (const key of Object.keys(object)) {
    if (!allowed[key]) throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
  }
  if (typeof object.name !== "string" || !object.name.trim() || object.name.length > 512) {
    throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
  }
  if (typeof object.provider !== "string" || !object.provider.trim() || object.provider.length > 256) {
    throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
  }
  if (object.engine !== undefined && (typeof object.engine !== "string" || object.engine.length > 256)) {
    throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
  }
  for (const key of ["parameters", "prompts", "metadata"] as const) {
    const value = object[key];
    if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)) {
      throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
    }
  }
  if (object.prompt_order !== undefined && !Array.isArray(object.prompt_order)) {
    throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
  }
  if (object.regex_scripts !== undefined && !Array.isArray(object.regex_scripts)) {
    throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
  }
  if (object.regexScripts !== undefined && !Array.isArray(object.regexScripts)) {
    throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
  }
  if (Object.hasOwn(object, "regex_scripts") && Object.hasOwn(object, "regexScripts")) {
    throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
  }
  return object as unknown as PortablePresetPayload;
}

export function parsePortablePresetRuntimeImportRequest(raw: unknown): PortablePresetRuntimeImportInput {
  const object = parsePortableWireObject(raw);
  assertExactObjectKeys(object, ["preset", "agentRuntime"], "portable preset import");
  return {
    preset: parsePortablePresetPayload(object.preset),
    agentRuntime: parsePortablePresetRuntimeEnvelope(object.agentRuntime),
  };
}

export function decodePortableAgentConfig(raw: unknown): PortableAgentConfigV1 {
  return parsePortableAgentConfigV1(parsePortableWireObject(raw));
}

function foreignConfig(config: AgentConfigV2): AgentConfigV2 {
  return {
    ...config,
    agentsEnabled: false,
    allowedModes: ["response"],
    defaultMode: "response",
    profiles: config.profiles.map((profile) => ({
      ...profile,
      toolIds: [...profile.toolIds],
      workspaceCapabilities: [...(profile.workspaceCapabilities ?? [])],
    })),
    connectionSlots: config.connectionSlots.map((slot) => ({ ...slot, requiredCapabilities: [...slot.requiredCapabilities] })),
  };
}
export function prepareForeignAgentConfig(config: AgentConfigV2): { config: AgentConfigV2; review: AgentConfigReviewV1 } {
  const inert = foreignConfig(config);
  const unresolvedSlotIds = inert.connectionSlots.map((slot) => slot.id).sort();
  return { config: inert, review: { state: "review_required", reasonCode: "foreign_import", unresolvedSlotIds, staleSlotIds: [], acknowledged: false } };
}

function rowToPreset(row: Record<string, unknown>, projection: PresetAgentConfigProjection): Preset {
  return { id: String(row.id), name: String(row.name), provider: String(row.provider), engine: String(row.engine ?? "classic"), parameters: parseJsonObject(row.parameters), prompt_order: parseJsonArray(row.prompt_order), prompts: parseJsonObject(row.prompts), metadata: scrubMetadata(parseJsonObject(row.metadata)), agent_config: projection.config, agent_config_revision: projection.configRevision, agent_config_review: projection.review, cache_revision: Number(row.cache_revision) || 0, created_at: Number(row.created_at) || 0, updated_at: Number(row.updated_at) || 0 } as Preset;
}

function insertPresetWithDb(db: Database, userId: string, input: PortablePresetPayload, config: AgentConfigV2, review: AgentConfigReviewV1, bindings?: readonly { slotId: string; connectionId: string | null }[], cognitionPolicyOverride?: unknown): { id: string; projection: PresetAgentConfigProjection } {
  if (typeof input.name !== "string" || !input.name.trim() || typeof input.provider !== "string" || !input.provider.trim()) throw new Error("name and provider are required");
  const id = crypto.randomUUID(); const now = Math.floor(Date.now() / 1000);
  db.query("INSERT INTO presets (id, name, provider, engine, parameters, prompt_order, prompts, metadata, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.name.trim(), input.provider.trim(), input.engine ?? "classic", JSON.stringify(input.parameters ?? {}), JSON.stringify(input.prompt_order ?? []), JSON.stringify(input.prompts ?? {}), JSON.stringify(scrubMetadata(input.metadata)), userId, now, now);
  return { id, projection: writeAgentConfigWithDb(db, userId, id, { config, review, bindings, cognitionPolicyOverride }) };
}

function updatePresetWithDb(
  db: Database,
  userId: string,
  presetId: string,
  input: PortablePresetPayload,
  config: AgentConfigV2,
  review: AgentConfigReviewV1,
  expectedPresetRevision: number | undefined,
  bindings: readonly { slotId: string; connectionId: string | null }[] = [],
): { id: string; projection: PresetAgentConfigProjection } {
  assertPresetOwned(db, userId, presetId);
  if (expectedPresetRevision === undefined) throw new Error("PRESET_REVISION_REQUIRED");
  const expected = expectedPresetRevision;
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("PRESET_REVISION_REQUIRED");
  const now = Math.floor(Date.now() / 1000);
  const result = db.query("UPDATE presets SET name = ?, provider = ?, engine = ?, parameters = ?, prompt_order = ?, prompts = ?, metadata = ?, updated_at = ?, cache_revision = cache_revision + 1 WHERE id = ? AND user_id = ? AND cache_revision = ?").run(
    input.name,
    input.provider,
    input.engine ?? "classic",
    JSON.stringify(input.parameters ?? {}),
    JSON.stringify(input.prompt_order ?? []),
    JSON.stringify(input.prompts ?? {}),
    JSON.stringify(scrubMetadata(input.metadata)),
    now,
    presetId,
    userId,
    expected,
  );
  if (result.changes !== 1) throw new Error("PRESET_REVISION_CONFLICT");
  const currentProjection = readNormalizedProjection(db, userId, presetId);
  const expectedConfigRevision = currentProjection?.configRevision ?? 0;
  const projection = writeAgentConfigWithDb(db, userId, presetId, {
    config,
    review,
    bindings,
    expectedConfigRevision,
  });
  return { id: presetId, projection };
}

function readPortableRegexScripts(input: PortablePresetPayload): readonly Record<string, unknown>[] {
  const hasSnakeCase = Object.hasOwn(input, "regex_scripts");
  const hasCamelCase = Object.hasOwn(input, "regexScripts");
  if (hasSnakeCase && hasCamelCase) throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
  const value = hasSnakeCase ? input.regex_scripts : input.regexScripts;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
  return value;
}

/**
 * Import preset-bound regex companions while the caller's database transaction
 * is open. The lower-level importer retains invalid foreign scripts as
 * disabled/quarantined rows, but malformed entries and persistence conflicts
 * are integrity failures for a portable preset and must abort the transaction.
 */
export function importPortablePresetRegexScriptsWithDb(
  db: Database,
  userId: string,
  presetId: string,
  presetName: string,
  input: PortablePresetPayload,
): { imported: number; skipped: number } {
  void db;
  const scripts = readPortableRegexScripts(input);
  if (scripts.length === 0) return { imported: 0, skipped: 0 };
  const result = regexScriptsService.importPresetBoundRegexScripts(
    userId,
    presetId,
    presetName,
    [...scripts],
  );
  if (result.skipped !== 0 || result.imported !== scripts.length) {
    throw new Error(`AGENT_RUNTIME_PORTABLE_REGEX_INVALID:skipped=${result.skipped}`);
  }
  return result;
}

export function importPortablePreset(userId: string, input: PortablePresetPayload): PortablePresetImportResult {
  const db = getDb();
  const rawConfig = input.agent_config;
  let portable: PortableAgentConfigV1 | null = null;
  let invalidCognition: unknown;
  let hasInvalidCognition = false;
  if (rawConfig !== undefined) {
    const wire = parsePortableWireObject(rawConfig);
    try {
      portable = parsePortableAgentConfigV1(wire);
    } catch (error) {
      if (!Object.hasOwn(wire, "cognitionPolicy")) throw error;
      invalidCognition = wire.cognitionPolicy;
      hasInvalidCognition = true;
      const withoutCognition = { ...wire };
      delete withoutCognition.cognitionPolicy;
      portable = parsePortableAgentConfigV1(withoutCognition);
    }
  }
  const authored = portable
    ? (() => {
      const { portableVersion: _portableVersion, ...authoredPortable } = portable;
      return parseAgentConfigV2({ ...authoredPortable, version: 2 });
    })()
    : createDisabledAgentConfigV2();
  const normalizedCognition = normalizeImportedCognition(hasInvalidCognition ? invalidCognition : authored.cognitionPolicy, { source: "foreign" });
  void normalizedCognition;
  const preparedBase = prepareForeignAgentConfig(authored);
  const cognition = hasInvalidCognition ? { state: "repair_required" as const, reasonCode: "cognition_invalid" } : cognitionReview(userId, "portable-import", authored, "foreign", true);
  const prepared = {
    config: preparedBase.config,
    review: {
      ...preparedBase.review,
      state: hasInvalidCognition ? "repair_required" as const : preparedBase.review.state,
      reasonCode: cognition.reasonCode ?? preparedBase.review.reasonCode,
    },
  };
  const inserted = db.transaction(() => {
    const stored = insertPresetWithDb(db, userId, input, prepared.config, prepared.review, undefined, hasInvalidCognition ? invalidCognition : undefined);
    importPortablePresetRegexScriptsWithDb(db, userId, stored.id, input.name, input);
    return stored;
  })();
  const row = assertPresetOwned(db, userId, inserted.id);
  return { preset: rowToPreset(row, inserted.projection), agent_config: inserted.projection.config, agent_config_review: inserted.projection.review };
}

export interface PortablePresetRuntimeImportInput {
  preset: PortablePresetPayload;
  agentRuntime: unknown;
  /** Existing LumiHub installation to replace transactionally, when present. */
  existingPresetId?: string;
  expectedPresetRevision?: number;
}

export function importPortablePresetRuntime(userId: string, input: PortablePresetRuntimeImportInput): PortablePresetImportResult {
  const db = getDb();
  const preset = parsePortablePresetPayload(input.preset);
  const envelope = parsePortablePresetRuntimeEnvelope(input.agentRuntime);
  return db.transaction(() => {
    const importedPacks = new Map<string, { packId: string; revision: number; digest: string }>();
    const timestamp = Math.floor(Date.now() / 1000);
    for (const snapshot of envelope.contextPacks) {
      const imported = contextPacksService.importForeignContextPackWithDb(db, userId, snapshot, timestamp);
      importedPacks.set(snapshot.snapshotId, { packId: imported.pack.id, revision: imported.revision.revision, digest: imported.revision.contentDigest });
    }
    const portable = envelope.agentConfig ? parsePortableAgentConfigV1(envelope.agentConfig) : toPortableAgentConfigV1(createDisabledAgentConfigV2());
    const { portableVersion: _portableVersion, ...authoredPortable } = portable;
    const mappedPackIds = authoredPortable.contextPolicy?.packIds.map((packId) => {
      const imported = importedPacks.get(packId);
      if (!imported) throw new Error("AGENT_RUNTIME_PORTABLE_CONFIG_REFERENCE_INVALID");
      return imported.packId;
    }) ?? [];
    const mappedRules = envelope.contextRules.map((rawRule) => {
      const rule = parseContextActivationRule(rawRule);
      const imported = importedPacks.get(rule.packId);
      if (!imported) throw new Error("AGENT_RUNTIME_PORTABLE_RULE_INVALID");
      return { ...rule, packId: imported.packId, revisionId: `${imported.packId}@${imported.revision}` };
    });
    const importedConfig = parseAgentConfigV2({
      ...authoredPortable,
      version: 2,
      agentsEnabled: false,
      allowedModes: ["response"],
      defaultMode: "response",
      ...(authoredPortable.contextPolicy ? { contextPolicy: { ...authoredPortable.contextPolicy, packIds: mappedPackIds } } : {}),
    });
    const selections = envelope.contextSelections.map((selection) => {
      const imported = importedPacks.get(selection.packSnapshotId);
      if (!imported) throw new Error("AGENT_RUNTIME_PORTABLE_SELECTION_INVALID");
      return { packId: imported.packId, revisionId: `${imported.packId}@${imported.revision}`, revision: imported.revision, digest: imported.digest };
    });
    const review = prepareForeignAgentConfig(importedConfig).review;
    const importedReview = { ...review, reasonCode: "foreign_import" };
    const targetPresetRevision = input.existingPresetId
      ? (Number(assertPresetOwned(db, userId, input.existingPresetId).cache_revision) || 0) + 1
      : 0;
    const targetConfig = rebindPromptPresetRevisions(importedConfig, targetPresetRevision) as AgentConfigV2;
    const stored = input.existingPresetId
      ? updatePresetWithDb(db, userId, input.existingPresetId, preset, targetConfig, importedReview, input.expectedPresetRevision, [])
      : insertPresetWithDb(db, userId, preset, targetConfig, importedReview, undefined, undefined);
    const authoredRow = {
      config: targetConfig,
      contextPackSelections: selections,
      contextRules: mappedRules,
      taskTemplates: envelope.taskTemplates,
      reviewAcknowledgements: [],
    };
    db.query("UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?")
      .run(JSON.stringify(authoredRow), userId, stored.id);
    if (input.existingPresetId) {
      regexScriptsService.deleteRegexScriptsByPresetId(userId, stored.id);
    }
    importPortablePresetRegexScriptsWithDb(db, userId, stored.id, preset.name, preset);
    const row = assertPresetOwned(db, userId, stored.id);
    return { preset: rowToPreset(row, stored.projection), agent_config: stored.projection.config, agent_config_review: stored.projection.review };
  })();
}

function copyRegexCompanionsWithDb(db: Database, userId: string, sourcePresetId: string, targetPresetId: string): string[] {
  if (!tableExists(db, "regex_scripts")) return [];
  const rows = db.query("SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY sort_order ASC, created_at ASC").all(userId, sourcePresetId) as Array<Record<string, unknown>>;
  const columns = (db.query("PRAGMA table_info(regex_scripts)").all() as Array<{ name: string }>).map((column) => column.name); const copyable = columns.filter((column) => column !== "id" && column !== "user_id" && column !== "preset_id"); const copied: string[] = [];
  for (const row of rows) { const id = crypto.randomUUID(); const allColumns = ["id", "user_id", "preset_id", ...copyable]; const values = [id, userId, targetPresetId, ...copyable.map((column) => column === "script_id" ? `${String(row[column] ?? "script")}-${id.slice(0, 8)}`.slice(0, 255) : row[column] ?? null)]; const quoted = allColumns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", "); db.query(`INSERT INTO regex_scripts (${quoted}) VALUES (${allColumns.map(() => "?").join(", ")})`).run(...(values as any[])); copied.push(id); }
  return copied;
}
function readValidatedAuthoredRuntimeEnvelopeJson(
  db: Database,
  userId: string,
  presetId: string,
  projection: PresetAgentConfigProjection,
): string {
  const row = tableExists(db, "preset_agent_configs")
    ? db.query("SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as { config_json?: unknown } | null
    : null;
  const raw = row?.config_json;
  if (typeof raw !== "string" || raw.trim() === "") return "{}";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_RUNTIME_AUTHORED_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AGENT_RUNTIME_AUTHORED_INVALID");
  }
  const envelope = parsed as Record<string, unknown>;
  if (Object.keys(envelope).length === 0) return raw;

  try {
    assertExactObjectKeys(
      envelope,
      ["config", "contextPackSelections", "contextRules", "taskTemplates", "reviewAcknowledgements"],
      "authored agent runtime",
    );
    const config = parseAgentConfigV2(envelope.config);
    const selections = normalizeContextPackSelections(
      normalizeDraftList(envelope.contextPackSelections, "contextPackSelections"),
    );
    const rules = normalizeContextRules(
      normalizeDraftList(envelope.contextRules, "contextRules"),
      selections,
    );
    const taskTemplates = normalizeDraftList(envelope.taskTemplates, "taskTemplates")
      .map((template) => parseTaskTemplate(template));
    normalizeReviewAcknowledgements(
      envelope.reviewAcknowledgements,
      reviewItemIds(projection.review),
    );

    const selectedPackIds = new Set(selections.map((selection) => selection.packId));
    const ruleIds = new Set(rules.map((rule) => rule.id));
    const rulePackIds = new Set(rules.map((rule) => rule.packId));
    const policy = config.contextPolicy;
    if ((selections.length > 0 || rules.length > 0) && !policy) {
      throw new Error("context policy is missing");
    }
    if (policy) {
      if (
        policy.packIds.some((packId) => !selectedPackIds.has(packId))
        || policy.ruleIds.some((ruleId) => !ruleIds.has(ruleId))
        || rules.some((rule) => !policy.ruleIds.includes(rule.id))
        || selections.some((selection) => (
          !policy.packIds.includes(selection.packId) && !rulePackIds.has(selection.packId)
        ))
      ) {
        throw new Error("context references are not authorized by context policy");
      }
      for (const rule of rules) {
        const selection = selections.find((candidate) => candidate.packId === rule.packId);
        if (!selection || selection.revisionId !== rule.revisionId) {
          throw new Error("context rule revision does not match selected pack");
        }
      }
    }

    const taskTemplateIds = new Set(taskTemplates.map((template) => template.id));
    const policyTemplateIds = config.taskPolicy?.templateIds ?? [];
    if (
      policyTemplateIds.some((templateId) => !taskTemplateIds.has(templateId))
      || taskTemplates.some((template) => !policyTemplateIds.includes(template.id))
    ) {
      throw new Error("task template references are not authorized by task policy");
    }
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`AGENT_RUNTIME_AUTHORED_INVALID${detail}`);
  }

  // Preserve the validated bytes exactly. In particular, labels and authored
  // review acknowledgements are part of the editor envelope and must not be
  // reconstructed from the normalized projection during duplication.
  return raw;
}

export function duplicatePresetWithAgentConfig(userId: string, sourcePresetId: string, name?: string): PresetDuplicateResult {
  const db = getDb();
  return db.transaction(() => {
    const source = assertPresetOwned(db, userId, sourcePresetId);
    const sourceProjection = getPresetAgentConfig(userId, sourcePresetId);
    if (!sourceProjection) throw new Error("Preset agent config not found");
    const authoredRuntimeEnvelope = readValidatedAuthoredRuntimeEnvelopeJson(
      db,
      userId,
      sourcePresetId,
      sourceProjection,
    );
    const targetConfig = rebindPromptPresetRevisions(sourceProjection.config, 0) as AgentConfigV2;
    const inserted = insertPresetWithDb(
      db,
      userId,
      {
        name: name?.trim() || `${String(source.name)} copy`,
        provider: String(source.provider),
        engine: String(source.engine ?? "classic"),
        parameters: parseJsonObject(source.parameters),
        prompt_order: parseJsonArray(source.prompt_order),
        prompts: parseJsonObject(source.prompts),
        metadata: scrubMetadata(parseJsonObject(source.metadata)),
      },
      targetConfig,
      sourceProjection.review,
      sourceProjection.bindings.map((binding) => ({ slotId: binding.slotId, connectionId: binding.connectionId })),
    );
    contextPacksService.copyPresetContextPackAttachmentsWithDb(db, userId, sourcePresetId, inserted.id);
    const targetPreset = assertPresetOwned(db, userId, inserted.id);
    const targetPresetRevision = Number(targetPreset.cache_revision) || 0;
    let targetAuthoredRuntimeEnvelope = authoredRuntimeEnvelope;
    if (authoredRuntimeEnvelope !== "{}") {
      const parsedEnvelope = JSON.parse(authoredRuntimeEnvelope) as Record<string, unknown>;
      targetAuthoredRuntimeEnvelope = JSON.stringify(rebindPromptPresetRevisions({
        ...parsedEnvelope,
        // The normalized V2 row is the authority after duplication. Replacing
        // the authored copy prevents stale source config revisions from
        // reactivating against the new preset.
        config: targetConfig,
      }, targetPresetRevision));
    }
    db.query("UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?")
      .run(targetAuthoredRuntimeEnvelope, userId, inserted.id);
    const copiedRegexScriptIds = copyRegexCompanionsWithDb(db, userId, sourcePresetId, inserted.id);
    const row = assertPresetOwned(db, userId, inserted.id);
    const projection = getPresetAgentConfig(userId, inserted.id)!;
    return { preset: rowToPreset(row, projection), agent_config: projection.config, agent_config_review: projection.review, copiedRegexScriptIds };
  })();
}

export function getChatAgentModeOverride(userId: string, chatId: string): ChatAgentModeOverride | null {
  const db = getDb();
  if (!tableExists(db, "chat_agent_mode_overrides")) return null;
  const row = db.query("SELECT mode, revision, state, review_code, review_acknowledged FROM chat_agent_mode_overrides WHERE user_id = ? AND chat_id = ?").get(userId, chatId) as { mode: "response" | "agentic" | null; revision: number; state: AgentConfigStateV1; review_code: string | null; review_acknowledged: number } | null;
  return row ? { mode: row.mode ?? null, revision: Number(row.revision) || 1, state: row.state, reviewCode: row.review_code ?? null, acknowledged: Number(row.review_acknowledged) === 1 } : null;
}

export function setChatAgentModeOverride(userId: string, chatId: string, mode: "response" | "agentic" | null, expectedRevision?: number): ChatAgentModeOverride | null {
  const db = getDb();
  if (!tableExists(db, "chat_agent_mode_overrides")) return null;
  if (expectedRevision === undefined) throw new Error("AGENT_CHAT_MODE_REVISION_REQUIRED");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("AGENT_CHAT_MODE_REVISION_REQUIRED");
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error("AGENT_CHAT_MODE_REVISION_CONFLICT");
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM chats WHERE user_id = ? AND id = ?").get(userId, chatId)) return null;
    const now = Math.floor(Date.now() / 1000);
    const result = expectedRevision === 0
      ? db.query("INSERT INTO chat_agent_mode_overrides (user_id, chat_id, mode, revision, state, review_code, review_acknowledged, updated_at) VALUES (?, ?, ?, 1, 'ready', NULL, 1, ?) ON CONFLICT(user_id, chat_id) DO NOTHING").run(userId, chatId, mode, now)
      : db.query("UPDATE chat_agent_mode_overrides SET mode = ?, revision = ?, state = 'ready', review_code = NULL, review_acknowledged = 1, updated_at = ? WHERE user_id = ? AND chat_id = ? AND revision = ?").run(mode, expectedRevision + 1, now, userId, chatId, expectedRevision);
    if (result.changes !== 1) throw new Error("AGENT_CHAT_MODE_REVISION_CONFLICT");
    return getChatAgentModeOverride(userId, chatId);
  })();
}

export const scrubPresetMetadata = scrubMetadata;

export interface AgentRuntimeSharedDraftV1 {
  config: unknown;
  slotBindings?: readonly { slotId?: unknown; connectionId?: unknown }[];
  contextPackSelections?: readonly unknown[];
  contextRules?: readonly unknown[];
  taskTemplates?: readonly unknown[];
  reviewAcknowledgements?: unknown;
  promptOrder?: unknown[];
  expectedPresetRevision?: number;
  expectedConfigRevision?: number;
}

export interface AgentRuntimeSharedDraftResultV1 {
  preset: Preset;
  editor: { presetId: string; presetRevision: number; configRevision: number; config: AgentConfigV2; review: AgentRuntimeEditorReviewV1; slotBindings: PresetAgentSlotBindingV1[]; contextPackSelections: unknown[]; contextRules: unknown[]; taskTemplates: unknown[]; hostCeilings: ReturnType<typeof getAgentRuntimeHostLimits>; reviewAcknowledgements: unknown; };
}

function normalizeDraftList(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.slice();
}

export interface AgentContextPackSelectionV1 {
  packId: string;
  revisionId: string;
  revision: number;
  digest: string;
  label?: string;
  revisionLabel?: string;
}

export interface AgentPresetCognitionSourceV1 {
  presetId: string;
  presetRevision: number;
  configRevision: number;
  config: AgentConfigV2;
  contextPackSelections: readonly AgentContextPackSelectionV1[];
  contextRules: readonly unknown[];
  taskTemplates: readonly unknown[];
  review: AgentConfigReviewV1;
}

function normalizeContextPackSelections(value: readonly unknown[]): AgentContextPackSelectionV1[] {
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`contextPackSelections[${index}] must be an object`);
    const object = entry as Record<string, unknown>;
    const allowed = new Set(["packId", "revisionId", "revision", "digest", "label", "revisionLabel"]);
    for (const key of Object.keys(object)) if (!allowed.has(key)) throw new Error(`contextPackSelections[${index}] contains an unknown field`);
    const packId = object.packId;
    if (typeof packId !== "string" || !packId || packId.trim() !== packId || packId.length > 256) throw new Error(`contextPackSelections[${index}].packId is invalid`);
    const revisionValue = object.revision;
    let revision: number;
    if (typeof revisionValue === "number" && Number.isSafeInteger(revisionValue) && revisionValue >= 1) revision = revisionValue;
    else if (typeof object.revisionId === "string" && /^(?:\d+|[^@]+@\d+)$/.test(object.revisionId)) {
      const candidate = Number(object.revisionId.slice(object.revisionId.lastIndexOf("@") + 1));
      if (!Number.isSafeInteger(candidate) || candidate < 1) throw new Error(`contextPackSelections[${index}].revision is invalid`);
      revision = candidate;
    } else {
      throw new Error(`contextPackSelections[${index}].revision is required`);
    }
    const suppliedRevisionId = object.revisionId;
    if (suppliedRevisionId !== undefined && (typeof suppliedRevisionId !== "string" || !suppliedRevisionId.trim() || suppliedRevisionId !== String(revision) && suppliedRevisionId !== `${packId}@${revision}`)) throw new Error(`contextPackSelections[${index}].revisionId does not match revision`);
    const digest = object.digest;
    if (typeof digest !== "string" || !digest || digest.length > 128 || digest.trim() !== digest) throw new Error(`contextPackSelections[${index}].digest is invalid`);
    const result: AgentContextPackSelectionV1 = { packId, revisionId: `${packId}@${revision}`, revision, digest };
    if (typeof object.label === "string") result.label = object.label;
    if (typeof object.revisionLabel === "string") result.revisionLabel = object.revisionLabel;
    return result;
  });
}

function normalizeContextRules(value: readonly unknown[], selections: readonly AgentContextPackSelectionV1[]): ContextActivationRuleV1[] {
  const byPack = new Map(selections.map((selection) => [selection.packId, selection]));
  return value.map((rule, index) => {
    const parsed = parseContextActivationRule(rule);
    const selection = byPack.get(parsed.packId);
    if (!selection) throw new Error(`contextRules[${index}] references an unselected pack`);
    if (parsed.revisionId !== selection.revisionId && parsed.revisionId !== String(selection.revision)) throw new Error(`contextRules[${index}] revision does not match selected pack`);
    return { ...parsed, revisionId: selection.revisionId };
  });
}

function normalizeDraftConfig(raw: unknown, contextRules: readonly unknown[], taskTemplates: readonly unknown[]): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("AGENT_CONFIG_INVALID");
  const input = { ...(raw as Record<string, unknown>) };
  if (contextRules.length > 0 || Object.hasOwn(input, "contextPolicy")) {
    const parsed = contextRules.map((rule) => parseContextActivationRule(rule));
    const current = input.contextPolicy && typeof input.contextPolicy === "object" && !Array.isArray(input.contextPolicy)
      ? input.contextPolicy as Record<string, unknown>
      : {};
    // Direct pack attachments and rule-target packs have separate authority.
    // Preserve authored direct packIds; a rule-only selection must not become
    // directly active merely because it is present in the draft.
    input.contextPolicy = {
      ...current,
      ruleIds: parsed.map((rule) => rule.id),
      packIds: Array.isArray(current.packIds) ? current.packIds : [],
    };
  }
  if (taskTemplates.length > 0) {
    const parsed = taskTemplates.map((template) => parseTaskTemplate(template));
    input.taskPolicy = { templateIds: parsed.map((template) => template.id) };
  } else if (Object.hasOwn(input, "taskPolicy")) {
    input.taskPolicy = { templateIds: [] };
  }
  return input;
}

function readAuthoredCognitionSource(db: Database, userId: string, presetId: string, projection: PresetAgentConfigProjection): AgentPresetCognitionSourceV1 | null {
  if (projection.review.state !== "ready") return null;
  const preset = db.query("SELECT cache_revision FROM presets WHERE user_id = ? AND id = ?").get(userId, presetId) as { cache_revision?: unknown } | null;
  const row = tableExists(db, "preset_agent_configs")
    ? db.query("SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as { config_json?: unknown } | null
    : null;
  if (!preset || !row || typeof row.config_json !== "string") return null;
  let authored: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.config_json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    authored = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  try {
    const contextPackSelections = normalizeContextPackSelections(normalizeDraftList(authored.contextPackSelections, "contextPackSelections"));
    if (contextPackSelections.some((selection) => !/^[0-9a-f]{64}$/.test(selection.digest))) return null;
    const strictSelections = contextPackSelections.map(({ packId, revisionId, revision, digest }) => ({ packId, revisionId, revision, digest }));
    const contextRules = normalizeDraftList(authored.contextRules, "contextRules").map((rule) => parseContextActivationRule(rule));
    const taskTemplates = normalizeDraftList(authored.taskTemplates, "taskTemplates").map((template) => parseTaskTemplate(template));
    const policy = projection.config.contextPolicy;
    const policyPackIds = policy?.packIds ?? [];
    const policyRuleIds = policy?.ruleIds ?? [];
    const selectedPackIds = new Set(strictSelections.map((selection) => selection.packId));
    const ruleIds = new Set(contextRules.map((rule) => rule.id));
    const rulePackIds = new Set(contextRules.map((rule) => rule.packId));
    // Every direct attachment and every rule target must be selected at the
    // exact revision. Unreferenced selections are rejected rather than
    // widening the authority implied by the authored policy.
    if (policyPackIds.some((packId) => !selectedPackIds.has(packId))
      || policyRuleIds.some((ruleId) => !ruleIds.has(ruleId))
      || contextRules.some((rule) => !policyRuleIds.includes(rule.id))
      || strictSelections.some((selection) => !policyPackIds.includes(selection.packId) && !rulePackIds.has(selection.packId))) return null;
    for (const rule of contextRules) {
      const selection = strictSelections.find((candidate) => candidate.packId === rule.packId);
      if (!selection || selection.revisionId !== rule.revisionId) return null;
    }
    return {
      presetId,
      presetRevision: Number(preset.cache_revision) || 0,
      configRevision: projection.configRevision,
      config: projection.config,
      contextPackSelections: strictSelections,
      contextRules,
      taskTemplates,
      review: projection.review,
    };
  } catch {
    return null;
  }
}


export function getPresetAgentCognitionSourceV1(userId: string, presetId: string): AgentPresetCognitionSourceV1 | null {
  const db = getDb();
  const projection = getPresetAgentConfig(userId, presetId);
  if (!projection) return null;
  return readAuthoredCognitionSource(db, userId, presetId, projection);
}

export function getAgentRuntimeSharedDraft(userId: string, presetId: string): AgentRuntimeSharedDraftResultV1["editor"] | null {
  const db = getDb();
  const preset = db.query("SELECT cache_revision FROM presets WHERE user_id = ? AND id = ?").get(userId, presetId) as { cache_revision?: unknown } | null;
  if (!preset) return null;
  const projection = getPresetAgentConfig(userId, presetId);
  const config = projection?.config ?? createDisabledAgentConfigV2();
  const review = projection?.review ?? { state: "ready" as const, reasonCode: null, unresolvedSlotIds: [], staleSlotIds: [], acknowledged: false };
  const configRevision = projection?.configRevision ?? 0;
  const bindings = projection?.bindings ?? [];
  const authoredRow = tableExists(db, "preset_agent_configs")
    ? db.query("SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as { config_json?: unknown } | null
    : null;
  const authored = parseJsonObject(authoredRow?.config_json);
  const boundedList = (value: unknown): unknown[] => Array.isArray(value) ? value.slice(0, 128) : [];
  const reviewAcknowledgements = Array.isArray(authored.reviewAcknowledgements)
    ? authored.reviewAcknowledgements.filter((value): value is string => typeof value === "string").slice(0, 128)
    : [];
  return {
    presetId,
    presetRevision: Number(preset.cache_revision) || 0,
    configRevision,
    config,
    review: editorReview(review, configRevision, reviewAcknowledgements),
    slotBindings: bindings,
    contextPackSelections: boundedList(authored.contextPackSelections),
    contextRules: boundedList(authored.contextRules),
    taskTemplates: boundedList(authored.taskTemplates),
    hostCeilings: getAgentRuntimeHostLimits(),
    reviewAcknowledgements,
  };
}

function reviewItemIds(review: AgentConfigReviewV1): string[] {
  const ids = [
    ...review.unresolvedSlotIds.map((slotId) => `slot:${slotId}`),
    ...review.staleSlotIds.map((slotId) => `stale-slot:${slotId}`),
  ];
  if (ids.length === 0 && review.state !== "ready") ids.push(`review:${review.reasonCode ?? review.state}`);
  return [...new Set(ids)].sort();
}

function normalizeReviewAcknowledgements(value: unknown, required: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("AGENT_REVIEW_ACKNOWLEDGEMENTS_INVALID");
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) throw new Error("AGENT_REVIEW_ACKNOWLEDGEMENTS_INVALID");
  const allowed = new Set(required);
  if (ids.some((id) => !allowed.has(id))) throw new Error("AGENT_REVIEW_ACKNOWLEDGEMENT_UNKNOWN");
  return [...ids].sort();
}

export interface AgentConfigReviewItemV1 {
  id: string;
  kind: "unresolved_slot" | "stale_slot" | "capability_mismatch" | "disabled_import" | "invalid_rule";
  reasonCode: string;
  action: { kind: "map_slot" | "acknowledge"; ref?: string };
  acknowledged: boolean;
}

export interface AgentRuntimeEditorReviewV1 extends AgentConfigReviewV1 {
  revision: number;
  items: readonly AgentConfigReviewItemV1[];
}

function editorReview(review: AgentConfigReviewV1, revision: number, acknowledgements: readonly string[]): AgentRuntimeEditorReviewV1 {
  const items: AgentConfigReviewItemV1[] = [];
  for (const slotId of review.unresolvedSlotIds) {
    items.push({
      id: `slot:${slotId}`,
      kind: "unresolved_slot",
      reasonCode: "unresolved_slot",
      action: { kind: "map_slot", ref: slotId },
      acknowledged: review.state === "review_required" && acknowledgements.includes(`slot:${slotId}`),
    });
  }
  for (const slotId of review.staleSlotIds) {
    const capabilityMismatch = review.reasonCode === "capability_mismatch";
    items.push({
      id: `stale-slot:${slotId}`,
      kind: capabilityMismatch ? "capability_mismatch" : "stale_slot",
      reasonCode: capabilityMismatch ? "capability_mismatch" : "stale_slot",
      action: { kind: "map_slot", ref: slotId },
      acknowledged: review.state === "review_required" && acknowledgements.includes(`stale-slot:${slotId}`),
    });
  }
  if (items.length === 0 && review.state !== "ready") {
    const reasonCode = review.reasonCode ?? review.state;
    items.push({
      id: `review:${reasonCode}`,
      kind: review.state === "repair_required" ? "invalid_rule" : "disabled_import",
      reasonCode,
      action: { kind: "acknowledge" },
      acknowledged: review.state === "review_required" && acknowledgements.includes(`review:${reasonCode}`),
    });
  }
  return { ...review, revision, items };
}

function rebindPromptPresetRevisions(value: unknown, presetRevision: number): unknown {
  if (Array.isArray(value)) return value.map((item) => rebindPromptPresetRevisions(item, presetRevision));
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  const rebound: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) rebound[key] = rebindPromptPresetRevisions(item, presetRevision);
  if (Object.hasOwn(rebound, "expectedPresetRevision") && Object.hasOwn(rebound, "expectedBlockRevision")) rebound.expectedPresetRevision = presetRevision;
  return rebound;
}

export function saveAgentRuntimeSharedDraft(userId: string, presetId: string, draft: AgentRuntimeSharedDraftV1): AgentRuntimeSharedDraftResultV1 {
  const db = getDb();
  return db.transaction(() => {
    const preset = assertPresetOwned(db, userId, presetId);
    const expectedPresetRevision = draft.expectedPresetRevision;
    if (!Number.isSafeInteger(expectedPresetRevision) || (expectedPresetRevision as number) < 0) throw new Error("PRESET_REVISION_REQUIRED");
    const actualPresetRevision = Number(preset.cache_revision) || 0;
    if (expectedPresetRevision !== actualPresetRevision) throw new Error("PRESET_REVISION_CONFLICT");
    if (!Number.isSafeInteger(draft.expectedConfigRevision) || (draft.expectedConfigRevision as number) < 0) throw new Error("AGENT_CONFIG_REVISION_REQUIRED");
    const contextPackSelections = normalizeContextPackSelections(normalizeDraftList(draft.contextPackSelections, "contextPackSelections"));
    const contextRules = normalizeContextRules(normalizeDraftList(draft.contextRules, "contextRules"), contextPackSelections);
    const taskTemplates = normalizeDraftList(draft.taskTemplates, "taskTemplates");
    const config = normalizeDraftConfig(draft.config, contextRules, taskTemplates);
    const slotBindings = (draft.slotBindings ?? []).map((binding, index) => {
      if (typeof binding !== "object" || binding === null || Array.isArray(binding)) throw new Error(`slotBindings[${index}] must be an object`);
      const row = binding as Record<string, unknown>;
      for (const key of Object.keys(row)) if (key !== "slotId" && key !== "connectionId") throw new Error("AGENT_RUNTIME_DRAFT_UNKNOWN_FIELD");
      const slotId = row.slotId;
      const connectionId = row.connectionId ?? null;
      if (typeof slotId !== "string") throw new Error(`slotBindings[${index}].slotId is required`);
      if (connectionId !== null && typeof connectionId !== "string") throw new Error(`slotBindings[${index}].connectionId is invalid`);
      return { slotId, connectionId: connectionId as string | null };
    });
    const promptOrder = draft.promptOrder;
    if (!Array.isArray(promptOrder)) throw new Error("promptOrder must be an array");
    const now = Math.floor(Date.now() / 1000);
    const promptResult = db.query("UPDATE presets SET prompt_order = ?, updated_at = ?, cache_revision = cache_revision + 1 WHERE id = ? AND user_id = ? AND cache_revision = ?").run(JSON.stringify(promptOrder), now, presetId, userId, actualPresetRevision);
    if (promptResult.changes !== 1) throw new Error("PRESET_REVISION_CONFLICT");
    const currentProjection = readNormalizedProjection(db, userId, presetId);
    const inheritedReview = currentProjection?.review ?? { state: "ready" as const, reasonCode: null, unresolvedSlotIds: [], staleSlotIds: [], acknowledged: false };
    const parsedConfig = parseAgentConfigV2(config);
    const connectionCache = new Map<string, ResolvedConcreteConnectionV1 | null>();
    const capabilityMismatchSlotIds: string[] = [];
    for (const binding of slotBindings) {
      const slot = parsedConfig.connectionSlots.find((candidate) => candidate.id === binding.slotId);
      if (!slot) continue;
      const validation = validateBindingCapabilities(userId, slot, binding.connectionId, connectionCache);
      if (validation.reviewCode === "capability_mismatch") capabilityMismatchSlotIds.push(binding.slotId);
    }
    capabilityMismatchSlotIds.sort();
    const replacementCognition = cognitionReview(userId, presetId, parsedConfig, "local", false);
    const repairStillRequired = inheritedReview.state === "repair_required" && replacementCognition.state !== "ready";
    const preserveReview = inheritedReview.state === "review_required"
      && inheritedReview.reasonCode !== null
      && inheritedReview.reasonCode !== "capability_mismatch";
    const candidateReview = {
      ...inheritedReview,
      state: repairStillRequired
        ? "repair_required" as const
        : capabilityMismatchSlotIds.length > 0 || preserveReview
          ? "review_required" as const
          : "ready" as const,
      reasonCode: repairStillRequired
        ? inheritedReview.reasonCode
        : capabilityMismatchSlotIds.length > 0
          ? "capability_mismatch"
          : preserveReview
            ? inheritedReview.reasonCode
            : null,
      unresolvedSlotIds: slotBindings.filter((binding) => binding.connectionId === null).map((binding) => binding.slotId),
      staleSlotIds: capabilityMismatchSlotIds,
    };
    const requiredReviewIds = reviewItemIds(candidateReview);
    const reviewAcknowledgements = normalizeReviewAcknowledgements(draft.reviewAcknowledgements, requiredReviewIds);
    if (candidateReview.state === "repair_required" && reviewAcknowledgements.length > 0) {
      throw new Error("AGENT_REVIEW_ACKNOWLEDGEMENT_NOT_ALLOWED");
    }
    const reviewAcknowledged = requiredReviewIds.every((id) => reviewAcknowledgements.includes(id));
    const hasUnresolvedReviewItems = candidateReview.unresolvedSlotIds.length > 0 || candidateReview.staleSlotIds.length > 0;
    const requestedReviewState = candidateReview.state === "repair_required"
      ? "repair_required" as const
      : candidateReview.state === "review_required" && reviewAcknowledged
        ? "review_required" as const
        : candidateReview.state === "review_required" && !reviewAcknowledged
          ? "review_required" as const
          : "ready" as const;
    const committedConfig = rebindPromptPresetRevisions(config, actualPresetRevision + 1);
    const authoredDraft = { config: committedConfig, contextPackSelections, contextRules, taskTemplates, reviewAcknowledgements };
    const projection = writeAgentConfigWithDb(db, userId, presetId, { config: committedConfig, bindings: slotBindings, expectedConfigRevision: draft.expectedConfigRevision, review: { state: requestedReviewState, reasonCode: candidateReview.reasonCode, unresolvedSlotIds: candidateReview.unresolvedSlotIds, staleSlotIds: candidateReview.staleSlotIds, acknowledged: reviewAcknowledged && !hasUnresolvedReviewItems }, authoredDraft });
    const updated = assertPresetOwned(db, userId, presetId);
    const editor = { presetId, presetRevision: actualPresetRevision + 1, configRevision: projection.configRevision, config: projection.config, review: editorReview(projection.review, projection.configRevision, reviewAcknowledgements), slotBindings: projection.bindings, contextPackSelections, contextRules, taskTemplates, hostCeilings: getAgentRuntimeHostLimits(), reviewAcknowledgements };
    return { preset: rowToPreset(updated, projection), editor };
  })();
}
