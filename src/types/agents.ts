/**
 * Persisted preset-owned agent contracts.
 *
 * This module is intentionally self-contained: it owns the versioned metadata
 * shape and the strict ingress parser used by API, import, and execution paths.
 * Runtime services may add richer state around these values, but must not widen
 * the persisted contract.
 */

import type { WorkspaceOperationKindV1 } from "./turn-workspace";
import { WORKSPACE_OPERATIONS } from "./turn-workspace";


export const LEGACY_AGENT_CONFIG_V1_VERSION = 1 as const;
export const AGENT_CONFIG_MAX_PROFILES = 16;
export const AGENT_PROFILE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const AGENT_RESULT_NAME_PATTERN = AGENT_PROFILE_ID_PATTERN;
export const AGENT_PROFILE_NAME_MAX_LENGTH = 80;
export const AGENT_SYSTEM_PROMPT_MAX_BYTES = 32 * 1024;
export const AGENT_MAX_OUTPUT_TOKENS_MIN = 64;
export const AGENT_MAX_OUTPUT_TOKENS_MAX = 8_192;
export const AGENT_TIMEOUT_MS_MIN = 5_000;
export const AGENT_INVOCATION_DEFAULT = 64;
export const AGENT_INVOCATION_MIN = 1;
export const AGENT_TOOL_CALL_DEFAULT = 64;
export const AGENT_TOOL_CALL_MIN = 1;
/** The six host-owned retrieval tools available to the main model and children. */
export type CoreAgentToolId =
  | "lore_list_books"
  | "lore_get_book"
  | "lore_list_entries"
  | "lore_get_entry"
  | "lore_search_entries"
  | "chat_search_history";

export const CORE_AGENT_TOOL_IDS: readonly CoreAgentToolId[] = [
  "lore_list_books",
  "lore_get_book",
  "lore_list_entries",
  "lore_get_entry",
  "lore_search_entries",
  "chat_search_history",
] as const;

const CORE_AGENT_TOOL_ID_SET = new Set<string>(CORE_AGENT_TOOL_IDS);
const LORE_AGENT_TOOL_ID_SET = new Set<CoreAgentToolId>([
  "lore_list_books",
  "lore_get_book",
  "lore_list_entries",
  "lore_get_entry",
  "lore_search_entries",
]);
const UTF8_ENCODER = new TextEncoder();

export type AgentLoreScope = "active" | "all_owned";
export type AgentFailurePolicy = "required" | "optional";

export interface LegacyAgentProfileConfigV1 {
  id: string;
  name: string;
  systemPrompt: string;
  connectionProfileId: string | null;
  toolIds: CoreAgentToolId[];
  loreScope: AgentLoreScope;
  allowMainDelegation: boolean;
  failurePolicy: AgentFailurePolicy;
  streamActivity: boolean;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface LegacyAgentConfigV1 {
  version: typeof LEGACY_AGENT_CONFIG_V1_VERSION;
  enabled: boolean;
  maxInvocations: number;
  maxToolCalls: number;
  mainToolIds: CoreAgentToolId[];
  mainLoreScope: AgentLoreScope;
  profiles: LegacyAgentProfileConfigV1[];
}

export const AGENT_CONFIG_V2_VERSION = 2 as const;
export const PORTABLE_AGENT_CONFIG_VERSION = 1 as const;

export type AgentMode = "response" | "agentic";
export type AgentCapabilityV1 =
  | "generation"
  | "streaming"
  | "tool_calling"
  | "native_tool_continuation"
  | "tools_disabled_finalization";

export const AGENT_CAPABILITIES: readonly AgentCapabilityV1[] = [
  "generation",
  "streaming",
  "tool_calling",
  "native_tool_continuation",
  "tools_disabled_finalization",
] as const;

export const AGENT_SLOT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}(?:\/[a-z][a-z0-9_-]{0,63})?$/;
export const AGENT_SLOT_LABEL_MAX_LENGTH = 80;
export const AGENT_POLICY_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface AgentConnectionRefV1 {
  kind: "inherit_main";
}

export interface AgentSlotConnectionRefV1 {
  kind: "slot";
  slotId: string;
}

export type AgentConnectionRef = AgentConnectionRefV1 | AgentSlotConnectionRefV1;

export interface AgentConnectionSlotV1 {
  id: string;
  label: string;
  requiredCapabilities: AgentCapabilityV1[];
}

export interface AgentPromptBlockRefV1 {
  blockId: string;
  expectedPresetRevision: number;
  expectedBlockRevision: number;
}

export interface AgentPhasePolicyV1 {
  work: AgentPromptBlockRefV1[];
  render: AgentPromptBlockRefV1[];
}

export interface AgentCognitionPolicyV1 {
  workPolicy: AgentPromptBlockRefV1[];
  workspaceUsage: AgentPromptBlockRefV1[];
  completionCriteria: AgentPromptBlockRefV1[];
  renderPolicy: AgentPromptBlockRefV1[];
}

export interface AgentContextPolicyV1 {
  ruleIds: string[];
  packIds: string[];
}

export interface AgentTaskPolicyV1 {
  templateIds: string[];
}

export interface AgentWorkspacePolicyV1 {
  retention: "turn_terminal" | "chat_lifetime";
  sharing: "root_only" | "view_only";
}

export interface AgentProfileConfigV2 {
  id: string;
  name: string;
  systemPrompt: string;
  connectionRef: AgentConnectionRef;
  toolIds: CoreAgentToolId[];
  /**
   * Explicit child workspace grants. The parser always materializes this as
   * a canonical ordered array; the optional type keeps legacy in-memory callers
   * source-compatible until they cross the V2 ingress boundary.
   */
  workspaceCapabilities?: WorkspaceOperationKindV1[];
  loreScope: AgentLoreScope;
  allowMainDelegation: boolean;
  failurePolicy: AgentFailurePolicy;
  streamActivity: boolean;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface AgentConfigV2 {
  version: typeof AGENT_CONFIG_V2_VERSION;
  agentsEnabled: boolean;
  allowedModes: AgentMode[];
  defaultMode: AgentMode;
  maxInvocations: number;
  maxToolCalls: number;
  mainToolIds: CoreAgentToolId[];
  mainLoreScope: AgentLoreScope;
  profiles: AgentProfileConfigV2[];
  connectionSlots: AgentConnectionSlotV1[];
  phasePolicy?: AgentPhasePolicyV1;
  cognitionPolicy?: AgentCognitionPolicyV1;
  contextPolicy?: AgentContextPolicyV1;
  taskPolicy?: AgentTaskPolicyV1;
  workspacePolicy?: AgentWorkspacePolicyV1;
}

export interface PortableAgentConfigV1 {
  portableVersion: typeof PORTABLE_AGENT_CONFIG_VERSION;
  agentsEnabled: boolean;
  allowedModes: AgentMode[];
  defaultMode: AgentMode;
  maxInvocations: number;
  maxToolCalls: number;
  mainToolIds: CoreAgentToolId[];
  mainLoreScope: AgentLoreScope;
  profiles: AgentProfileConfigV2[];
  connectionSlots: AgentConnectionSlotV1[];
  phasePolicy?: AgentPhasePolicyV1;
  contextPolicy?: AgentContextPolicyV1;
  taskPolicy?: AgentTaskPolicyV1;
  workspacePolicy?: AgentWorkspacePolicyV1;
  cognitionPolicy?: AgentCognitionPolicyV1;
}

export type AgentConfigStateV1 = "ready" | "review_required" | "repair_required";

export interface AgentConfigReviewV1 {
  state: AgentConfigStateV1;
  reasonCode: string | null;
  unresolvedSlotIds: string[];
  staleSlotIds: string[];
  acknowledged: boolean;
}

export type AgentInvocationKind = "deterministic" | "delegated";
export type AgentInvocationStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type AgentActivityPhase = "queued" | "started" | "tool_call" | "completed" | "failed" | "cancelled" | "timed_out";
export type AgentActivityActor = "main_model" | "child_profile";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Compact server-authored activity event; never carries prompts or results. */
export interface AgentActivityEvent {
  generationId: string;
  messageId?: string;
  invocationId: string;
  parentInvocationId?: string;
  actor: AgentActivityActor;
  profileName?: string;
  phase: AgentActivityPhase;
  status: AgentInvocationStatus;
  errorCode?: string;
  toolName?: CoreAgentToolId | "agent_delegate";
  startedAt: number;
  elapsedMs: number;
  usage?: AgentUsage;
}

/** Persisted summary intentionally omits child prose, prompts, arguments, and data. */
export interface AgentSummary {
  status: Extract<AgentInvocationStatus, "succeeded" | "failed" | "cancelled" | "timed_out">;
  invocationCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  timedOutCount: number;
  toolCallCount: number;
  usage: AgentUsage;
  errorCodes?: string[];
}

export interface AgentInvocation {
  id: string;
  parentId: string | null;
  actor: AgentActivityActor;
  profileId: string;
  profileName?: string;
  kind: AgentInvocationKind;
  status: AgentInvocationStatus;
  startedAt: number;
  finishedAt: number | null;
  usage: AgentUsage;
}

/** Server-held grants captured before provider work begins. */
export interface AgentAuthorizationSnapshot {
  rootUserId: string;
  mainToolIds: readonly CoreAgentToolId[];
  mainLoreScope: AgentLoreScope;
  profileGrants: Readonly<Record<string, {
    toolIds: readonly CoreAgentToolId[];
    loreScope: AgentLoreScope;
    allowMainDelegation: boolean;
  }>>;
}

export type AgentLoreSource =
  | "character"
  | "persona"
  | "chat"
  | "global"
  | "peer"
  | "injected"
  | "owned";

/** Macro-safe identity fields available to core lore rendering. */
export interface AgentToolNames {
  user: string;
  char: string;
  group: string;
  groupNotMuted: string;
  notChar: string;
  charGroupFocused: string;
  isGroupChat: string;
  groupOthers: string;
  groupMemberCount: string;
}

export interface AgentSnapshotBook {
  id: string;
  name: string;
  description: string;
  folder: string;
  source: AgentLoreSource;
  active: boolean;
}

export interface AgentSnapshotEntry {
  id: string;
  bookId: string;
  bookName: string;
  bookSource: AgentLoreSource;
  comment: string;
  keys: readonly string[];
  secondaryKeys: readonly string[];
  content: string;
  position: number;
  depth: number;
  role: string | null;
  activated: boolean;
}

export interface AgentSnapshotChatMessage {
  id: string;
  indexInChat: number;
  role: "user" | "assistant";
  name: string;
  content: string;
}

/** Bounded page returned by a trusted all-owned lore accessor. */
export interface AgentOwnedLorePage<T> {
  data: readonly T[];
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
}

/** Trusted, root-user-bound accessors for bounded all-owned lore calls. */
export interface AgentOwnedLoreReader {
  listBooks(input: {
    limit: number;
    offset: number;
    folder?: string;
    query?: string;
  }): AgentOwnedLorePage<AgentSnapshotBook>;
  resolveBookName(name: string): {
    candidates: ReadonlyArray<{ id: string; name: string }>;
    total: number;
    truncated: boolean;
  };
  getBook(bookId: string): AgentSnapshotBook | null;
  listEntries(input: {
    bookId: string;
    limit: number;
    offset: number;
    query?: string;
  }): AgentOwnedLorePage<AgentSnapshotEntry>;
  getEntry(entryId: string): AgentSnapshotEntry | null;
  searchEntries(input: {
    query: string;
    bookId?: string;
    limit: number;
    offset: number;
  }): AgentOwnedLorePage<AgentSnapshotEntry>;
}

/** Immutable active-lore/chat projection; ownedLore is a bounded, root-user-bound live capability. */
export interface AgentToolSnapshot {
  rootUserId: string;
  chatId: string;
  books: readonly AgentSnapshotBook[];
  entries: readonly AgentSnapshotEntry[];
  chatMessages: readonly AgentSnapshotChatMessage[];
  names: Readonly<AgentToolNames>;
  signal?: AbortSignal;
  ownedLore?: AgentOwnedLoreReader;
}

export type AgentToolResultStatus = "success" | "error";
export type AgentToolErrorCode =
  | "invalid_arguments"
  | "batch_rejected"
  | "unauthorized"
  | "not_found"
  | "ambiguous"
  | "limit_exceeded"
  | "cancelled"
  | "timed_out"
  | "provider_failed"
  | "internal_error";

/** Closed host-owned result envelope used for both core tools and delegation. */
export interface AgentToolResult<T = unknown> {
  status: AgentToolResultStatus;
  toolName: CoreAgentToolId | "agent_delegate";
  data?: T;
  errorCode?: AgentToolErrorCode;
  message?: string;
}
export type AgentRuntimeErrorCode =
  | "runtime_closed"
  | "snapshot_required"
  | "invalid_profile"
  | "invalid_task"
  | "invocation_limit_exceeded"
  | "child_already_active"
  | "initial_input_limit_exceeded"
  | "tool_unauthorized"
  | "tool_call_limit_exceeded"
  | "tool_round_limit_exceeded"
  | "batch_rejected"
  | "serialized_value_limit_exceeded"
  | "retained_data_limit_exceeded"
  | "output_token_limit_exceeded"
  | "profile_timeout"
  | "cancelled"
  | "provider_unavailable"
  | "provider_failed"
  | "feature_disabled"
  | "internal_error";

export interface AgentRuntimeError {
  code: AgentRuntimeErrorCode;
  message: string;
}


export class AgentConfigValidationError extends Error {
  readonly code = "AGENT_CONFIG_INVALID" as const;
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "AgentConfigValidationError";
    this.path = path;
  }
}

type PlainRecord = Record<string, unknown>;

function ownDataEntries(value: unknown, path: string): PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentConfigValidationError(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentConfigValidationError(path, "must be a plain object");
  }

  const result = Object.create(null) as PlainRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new AgentConfigValidationError(path, "must not contain symbol keys");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new AgentConfigValidationError(`${path}.${key}`, "must be a data property");
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function exactKeys(
  value: PlainRecord,
  allowed: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new AgentConfigValidationError(`${path}.${key}`, "unknown key");
    }
  }
  for (const key of allowed) {
    if (!optionalSet.has(key) && !Object.hasOwn(value, key)) {
      throw new AgentConfigValidationError(`${path}.${key}`, "is required");
    }
  }
}

function requireString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new AgentConfigValidationError(path, "must be a string");
  }
  if ([...value].length > maxLength) {
    throw new AgentConfigValidationError(path, `must be at most ${maxLength} characters`);
  }
  return value;
}

function requireUtf8String(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new AgentConfigValidationError(path, "must be a string");
  }
  if (UTF8_ENCODER.encode(value).byteLength > maxBytes) {
    throw new AgentConfigValidationError(path, `must be at most ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new AgentConfigValidationError(path, "must be a boolean");
  }
  return value;
}

function requireIntegerInRange(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new AgentConfigValidationError(path, "must be a finite integer");
  }
  if (value < min || value > max) {
    throw new AgentConfigValidationError(path, `must be between ${min} and ${max}`);
  }
  return value;
}

function requireAgentLimit(value: unknown, path: string, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new AgentConfigValidationError(path, "must be a finite safe integer");
  }
  if (value < min) {
    throw new AgentConfigValidationError(path, `must be at least ${min}`);
  }
  return value;
}

function requireTimeoutMs(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new AgentConfigValidationError(path, "must be a finite safe integer");
  }
  if (value < AGENT_TIMEOUT_MS_MIN) {
    throw new AgentConfigValidationError(path, `must be at least ${AGENT_TIMEOUT_MS_MIN}`);
  }
  if (value % 1_000 !== 0) {
    throw new AgentConfigValidationError(path, "must be a whole number of seconds");
  }
  return value;
}

function requireScope(value: unknown, path: string): AgentLoreScope {
  if (value !== "active" && value !== "all_owned") {
    throw new AgentConfigValidationError(path, "must be 'active' or 'all_owned'");
  }
  return value;
}

function requireToolIds(value: unknown, path: string): CoreAgentToolId[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new AgentConfigValidationError(path, "must be an array");
  }
  const result: CoreAgentToolId[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) {
      throw new AgentConfigValidationError(`${path}[${index}]`, "must be present");
    }
    const tool = value[index];
    if (typeof tool !== "string" || !CORE_AGENT_TOOL_ID_SET.has(tool)) {
      throw new AgentConfigValidationError(`${path}[${index}]`, "unknown tool id");
    }
    if (seen.has(tool)) {
      throw new AgentConfigValidationError(`${path}[${index}]`, "duplicate tool id");
    }
    seen.add(tool);
    result.push(tool as CoreAgentToolId);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (key !== "length" && !/^\d+$/.test(key))) {
      throw new AgentConfigValidationError(path, "must contain only indexed values");
    }
  }
  return result;
}

function requireLoreScopeCombination(scope: AgentLoreScope, toolIds: readonly CoreAgentToolId[], path: string): void {
  if (scope === "all_owned" && !toolIds.some((tool) => LORE_AGENT_TOOL_ID_SET.has(tool))) {
    throw new AgentConfigValidationError(path, "all_owned requires at least one lore tool");
  }
}

/** Parse closed legacy metadata only at migration/import boundaries. */
export function parseLegacyAgentConfigV1(raw: unknown): LegacyAgentConfigV1 {
  const config = ownDataEntries(raw, "agentConfig");
  exactKeys(
    config,
    ["version", "enabled", "maxInvocations", "maxToolCalls", "mainToolIds", "mainLoreScope", "profiles"],
    "agentConfig",
    ["maxInvocations", "maxToolCalls"],
  );

  if (config.version !== LEGACY_AGENT_CONFIG_V1_VERSION) {
    throw new AgentConfigValidationError("agentConfig.version", "must be version 1");
  }
  const enabled = requireBoolean(config.enabled, "agentConfig.enabled");
  const maxInvocations = Object.hasOwn(config, "maxInvocations")
    ? requireAgentLimit(config.maxInvocations, "agentConfig.maxInvocations", AGENT_INVOCATION_MIN)
    : AGENT_INVOCATION_DEFAULT;
  const maxToolCalls = Object.hasOwn(config, "maxToolCalls")
    ? requireAgentLimit(config.maxToolCalls, "agentConfig.maxToolCalls", AGENT_TOOL_CALL_MIN)
    : AGENT_TOOL_CALL_DEFAULT;
  const mainToolIds = requireToolIds(config.mainToolIds, "agentConfig.mainToolIds");
  const mainLoreScope = requireScope(config.mainLoreScope, "agentConfig.mainLoreScope");
  requireLoreScopeCombination(mainLoreScope, mainToolIds, "agentConfig.mainLoreScope");

  if (!Array.isArray(config.profiles) || Object.getPrototypeOf(config.profiles) !== Array.prototype) {
    throw new AgentConfigValidationError("agentConfig.profiles", "must be an array");
  }
  if (config.profiles.length > AGENT_CONFIG_MAX_PROFILES) {
    throw new AgentConfigValidationError("agentConfig.profiles", `must contain at most ${AGENT_CONFIG_MAX_PROFILES} profiles`);
  }

  const profileIds = new Set<string>();
  const profiles: LegacyAgentProfileConfigV1[] = [];
  for (let index = 0; index < config.profiles.length; index += 1) {
    const path = `agentConfig.profiles[${index}]`;
    if (!Object.hasOwn(config.profiles, String(index))) {
      throw new AgentConfigValidationError(path, "must be present");
    }
    const profile = ownDataEntries(config.profiles[index], path);
    exactKeys(profile, [
      "id", "name", "systemPrompt", "connectionProfileId", "toolIds", "loreScope",
      "allowMainDelegation", "failurePolicy", "streamActivity", "maxOutputTokens", "timeoutMs",
    ], path);

    const id = requireString(profile.id, `${path}.id`, 64);
    if (!AGENT_PROFILE_ID_PATTERN.test(id)) {
      throw new AgentConfigValidationError(`${path}.id`, "must match [a-z][a-z0-9_]{0,63}");
    }
    if (profileIds.has(id)) {
      throw new AgentConfigValidationError(`${path}.id`, "duplicate profile id");
    }
    profileIds.add(id);

    const name = requireString(profile.name, `${path}.name`, AGENT_PROFILE_NAME_MAX_LENGTH);
    const systemPrompt = requireUtf8String(profile.systemPrompt, `${path}.systemPrompt`, AGENT_SYSTEM_PROMPT_MAX_BYTES);
    const connectionProfileId = profile.connectionProfileId === null
      ? null
      : requireString(profile.connectionProfileId, `${path}.connectionProfileId`, 512);
    if (connectionProfileId === "") {
      throw new AgentConfigValidationError(`${path}.connectionProfileId`, "must not be empty");
    }
    const toolIds = requireToolIds(profile.toolIds, `${path}.toolIds`);
    const loreScope = requireScope(profile.loreScope, `${path}.loreScope`);
    requireLoreScopeCombination(loreScope, toolIds, `${path}.loreScope`);
    const allowMainDelegation = requireBoolean(profile.allowMainDelegation, `${path}.allowMainDelegation`);
    const failurePolicy = profile.failurePolicy === "required" || profile.failurePolicy === "optional"
      ? profile.failurePolicy
      : (() => { throw new AgentConfigValidationError(`${path}.failurePolicy`, "must be 'required' or 'optional'"); })();
    const streamActivity = requireBoolean(profile.streamActivity, `${path}.streamActivity`);
    const maxOutputTokens = requireIntegerInRange(
      profile.maxOutputTokens,
      `${path}.maxOutputTokens`,
      AGENT_MAX_OUTPUT_TOKENS_MIN,
      AGENT_MAX_OUTPUT_TOKENS_MAX,
    );
    const timeoutMs = requireTimeoutMs(profile.timeoutMs, `${path}.timeoutMs`);

    profiles.push({
      id,
      name,
      systemPrompt,
      connectionProfileId,
      toolIds,
      loreScope,
      allowMainDelegation,
      failurePolicy,
      streamActivity,
      maxOutputTokens,
      timeoutMs,
    });
  }

  return {
    version: LEGACY_AGENT_CONFIG_V1_VERSION,
    enabled,
    maxInvocations,
    maxToolCalls,
    mainToolIds,
    mainLoreScope,
    profiles,
  };
}

function requireModeList(value: unknown, path: string): AgentMode[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new AgentConfigValidationError(path, "must be an array");
  }
  const result: AgentMode[] = [];
  const seen = new Set<AgentMode>();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) throw new AgentConfigValidationError(`${path}[${index}]`, "must be present");
    const mode = value[index];
    if (mode !== "response" && mode !== "agentic") throw new AgentConfigValidationError(`${path}[${index}]`, "must be response or agentic");
    if (seen.has(mode)) throw new AgentConfigValidationError(`${path}[${index}]`, "duplicate mode");
    seen.add(mode); result.push(mode);
  }
  if (!seen.has("response")) throw new AgentConfigValidationError(path, "must contain response");
  for (const key of Reflect.ownKeys(value)) if (typeof key !== "string" || (key !== "length" && !/^\d+$/.test(key))) throw new AgentConfigValidationError(path, "must contain only indexed values");
  return result;
}

function requireCapabilities(value: unknown, path: string): AgentCapabilityV1[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new AgentConfigValidationError(path, "must be an array");
  const result: AgentCapabilityV1[] = []; let previousIndex = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) throw new AgentConfigValidationError(`${path}[${index}]`, "must be present");
    const capability = value[index]; const capabilityIndex = AGENT_CAPABILITIES.indexOf(capability as AgentCapabilityV1);
    if (capabilityIndex < 0) throw new AgentConfigValidationError(`${path}[${index}]`, "unknown capability");
    if (capabilityIndex <= previousIndex) throw new AgentConfigValidationError(`${path}[${index}]`, "capabilities must be sorted and unique");
    previousIndex = capabilityIndex; result.push(capability as AgentCapabilityV1);
  }
  for (const key of Reflect.ownKeys(value)) if (typeof key !== "string" || (key !== "length" && !/^\d+$/.test(key))) throw new AgentConfigValidationError(path, "must contain only indexed values");
  return result;
}

function requireWorkspaceCapabilities(
  value: unknown,
  path: string,
  optional = false,
): WorkspaceOperationKindV1[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new AgentConfigValidationError(path, "must be an array");
  }
  const result: WorkspaceOperationKindV1[] = [];
  let previousIndex = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) {
      throw new AgentConfigValidationError(`${path}[${index}]`, "must be present");
    }
    const operation = value[index];
    const operationIndex = typeof operation === "string"
      ? WORKSPACE_OPERATIONS.indexOf(operation as WorkspaceOperationKindV1)
      : -1;
    if (operationIndex < 0) {
      throw new AgentConfigValidationError(`${path}[${index}]`, "unknown workspace operation");
    }
    if (operationIndex <= previousIndex) {
      throw new AgentConfigValidationError(`${path}[${index}]`, "workspace capabilities must be sorted and unique");
    }
    previousIndex = operationIndex;
    result.push(operation as WorkspaceOperationKindV1);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (key !== "length" && !/^\d+$/.test(key))) {
      throw new AgentConfigValidationError(path, "must contain only indexed values");
    }
  }
  return result;
}

function requireSlotId(value: unknown, path: string): string {
  const id = requireString(value, path, 128);
  if (!AGENT_SLOT_ID_PATTERN.test(id)) throw new AgentConfigValidationError(path, "must match a preset-scoped slot id");
  return id;
}

function requireIdList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new AgentConfigValidationError(path, "must be an array");
  const result: string[] = []; const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) throw new AgentConfigValidationError(`${path}[${index}]`, "must be present");
    const id = requireString(value[index], `${path}[${index}]`, 64);
    if (!AGENT_POLICY_ID_PATTERN.test(id) || seen.has(id)) throw new AgentConfigValidationError(`${path}[${index}]`, "must be a unique policy id");
    seen.add(id); result.push(id);
  }
  return result;
}
function requireContextPackIdList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new AgentConfigValidationError(path, "must be an array");
  const result: string[] = []; const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) throw new AgentConfigValidationError(`${path}[${index}]`, "must be present");
    const id = requireString(value[index], `${path}[${index}]`, 256);
    if (!id || id.trim() !== id || /[\u0000-\u0020\u007f]/.test(id) || id.includes("{{") || id.includes("}}") || seen.has(id)) {
      throw new AgentConfigValidationError(`${path}[${index}]`, "must be a unique bounded context-pack id");
    }
    seen.add(id); result.push(id);
  }
  return result;
}

function parsePromptBlockRefs(value: unknown, path: string): AgentPromptBlockRefV1[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new AgentConfigValidationError(path, "must be an array");
  const refs: AgentPromptBlockRefV1[] = []; const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const refPath = `${path}[${index}]`; const ref = ownDataEntries(value[index], refPath);
    exactKeys(ref, ["blockId", "expectedPresetRevision", "expectedBlockRevision"], refPath);
    const blockId = requireString(ref.blockId, `${refPath}.blockId`, 128);
    if (!blockId || seen.has(blockId)) throw new AgentConfigValidationError(`${refPath}.blockId`, "must be unique and non-empty");
    seen.add(blockId);
    refs.push({ blockId, expectedPresetRevision: requireIntegerInRange(ref.expectedPresetRevision, `${refPath}.expectedPresetRevision`, 0, Number.MAX_SAFE_INTEGER), expectedBlockRevision: requireIntegerInRange(ref.expectedBlockRevision, `${refPath}.expectedBlockRevision`, 0, Number.MAX_SAFE_INTEGER) });
  }
  return refs;
}
function parsePhasePolicy(value: unknown, path: string): AgentPhasePolicyV1 {
  const policy = ownDataEntries(value, path); exactKeys(policy, ["work", "render"], path);
  return { work: parsePromptBlockRefs(policy.work, `${path}.work`), render: parsePromptBlockRefs(policy.render, `${path}.render`) };
}

function parseCognitionPolicy(value: unknown, path: string): AgentCognitionPolicyV1 {
  const policy = ownDataEntries(value, path);
  exactKeys(policy, ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"], path);
  return {
    workPolicy: parsePromptBlockRefs(policy.workPolicy, `${path}.workPolicy`),
    workspaceUsage: parsePromptBlockRefs(policy.workspaceUsage, `${path}.workspaceUsage`),
    completionCriteria: parsePromptBlockRefs(policy.completionCriteria, `${path}.completionCriteria`),
    renderPolicy: parsePromptBlockRefs(policy.renderPolicy, `${path}.renderPolicy`),
  };
}

function parseContextPolicy(value: unknown, path: string): AgentContextPolicyV1 {
  const policy = ownDataEntries(value, path); exactKeys(policy, ["ruleIds", "packIds"], path);
  return { ruleIds: requireIdList(policy.ruleIds, `${path}.ruleIds`), packIds: requireContextPackIdList(policy.packIds, `${path}.packIds`) };
}

function parseTaskPolicy(value: unknown, path: string): AgentTaskPolicyV1 {
  const policy = ownDataEntries(value, path); exactKeys(policy, ["templateIds"], path);
  return { templateIds: requireIdList(policy.templateIds, `${path}.templateIds`) };
}

function parseWorkspacePolicy(value: unknown, path: string): AgentWorkspacePolicyV1 {
  const policy = ownDataEntries(value, path); exactKeys(policy, ["retention", "sharing"], path);
  if (policy.retention !== "turn_terminal" && policy.retention !== "chat_lifetime") throw new AgentConfigValidationError(`${path}.retention`, "must be turn_terminal or chat_lifetime");
  if (policy.sharing !== "root_only" && policy.sharing !== "view_only") throw new AgentConfigValidationError(`${path}.sharing`, "must be root_only or view_only");
  return { retention: policy.retention, sharing: policy.sharing };
}

function parseAgentConnectionRef(value: unknown, path: string): AgentConnectionRef {
  const ref = ownDataEntries(value, path);
  exactKeys(ref, ["kind", "slotId"], path, ["slotId"]);
  if (ref.kind === "inherit_main") return { kind: "inherit_main" };
  if (ref.kind !== "slot") throw new AgentConfigValidationError(`${path}.kind`, "must be inherit_main or slot");
  return { kind: "slot", slotId: requireSlotId(ref.slotId, `${path}.slotId`) };
}

function parseAgentProfileV2(value: unknown, path: string): AgentProfileConfigV2 {
  const profile = ownDataEntries(value, path);
  exactKeys(
    profile,
    ["id", "name", "systemPrompt", "connectionRef", "toolIds", "workspaceCapabilities", "loreScope", "allowMainDelegation", "failurePolicy", "streamActivity", "maxOutputTokens", "timeoutMs"],
    path,
    ["workspaceCapabilities"],
  );
  const id = requireString(profile.id, `${path}.id`, 64);
  if (!AGENT_PROFILE_ID_PATTERN.test(id)) throw new AgentConfigValidationError(`${path}.id`, "must match [a-z][a-z0-9_]{0,63}");
  const name = requireString(profile.name, `${path}.name`, AGENT_PROFILE_NAME_MAX_LENGTH);
  const systemPrompt = requireUtf8String(profile.systemPrompt, `${path}.systemPrompt`, AGENT_SYSTEM_PROMPT_MAX_BYTES);
  const toolIds = requireToolIds(profile.toolIds, `${path}.toolIds`);
  const workspaceCapabilities = requireWorkspaceCapabilities(
    profile.workspaceCapabilities,
    `${path}.workspaceCapabilities`,
    true,
  );
  const loreScope = requireScope(profile.loreScope, `${path}.loreScope`);
  requireLoreScopeCombination(loreScope, toolIds, `${path}.loreScope`);
  if (profile.failurePolicy !== "required" && profile.failurePolicy !== "optional") throw new AgentConfigValidationError(`${path}.failurePolicy`, "must be required or optional");
  return {
    id, name, systemPrompt,
    connectionRef: parseAgentConnectionRef(profile.connectionRef, `${path}.connectionRef`),
    toolIds, workspaceCapabilities, loreScope,
    allowMainDelegation: requireBoolean(profile.allowMainDelegation, `${path}.allowMainDelegation`),
    failurePolicy: profile.failurePolicy,
    streamActivity: requireBoolean(profile.streamActivity, `${path}.streamActivity`),
    maxOutputTokens: requireIntegerInRange(profile.maxOutputTokens, `${path}.maxOutputTokens`, AGENT_MAX_OUTPUT_TOKENS_MIN, AGENT_MAX_OUTPUT_TOKENS_MAX),
    timeoutMs: requireTimeoutMs(profile.timeoutMs, `${path}.timeoutMs`),
  };
}

function parseAgentConfigV2Object(config: PlainRecord, path: string): AgentConfigV2 {
  exactKeys(config, ["version", "agentsEnabled", "allowedModes", "defaultMode", "maxInvocations", "maxToolCalls", "mainToolIds", "mainLoreScope", "profiles", "connectionSlots", "phasePolicy", "cognitionPolicy", "contextPolicy", "taskPolicy", "workspacePolicy"], path, ["phasePolicy", "cognitionPolicy", "contextPolicy", "taskPolicy", "workspacePolicy"]);
  if (config.version !== AGENT_CONFIG_V2_VERSION) throw new AgentConfigValidationError(`${path}.version`, "must be version 2");
  const agentsEnabled = requireBoolean(config.agentsEnabled, `${path}.agentsEnabled`);
  const allowedModes = requireModeList(config.allowedModes, `${path}.allowedModes`);
  if (config.defaultMode !== "response" && config.defaultMode !== "agentic") throw new AgentConfigValidationError(`${path}.defaultMode`, "must be response or agentic");
  if (!allowedModes.includes(config.defaultMode)) throw new AgentConfigValidationError(`${path}.defaultMode`, "must be one of allowedModes");
  if (!agentsEnabled && (allowedModes.length !== 1 || allowedModes[0] !== "response" || config.defaultMode !== "response")) throw new AgentConfigValidationError(path, "disabled configs must be response-only");
  const mainToolIds = requireToolIds(config.mainToolIds, `${path}.mainToolIds`);
  const mainLoreScope = requireScope(config.mainLoreScope, `${path}.mainLoreScope`);
  requireLoreScopeCombination(mainLoreScope, mainToolIds, `${path}.mainLoreScope`);
  if (!Array.isArray(config.profiles) || Object.getPrototypeOf(config.profiles) !== Array.prototype) throw new AgentConfigValidationError(`${path}.profiles`, "must be an array");
  if (config.profiles.length > AGENT_CONFIG_MAX_PROFILES) throw new AgentConfigValidationError(`${path}.profiles`, `must contain at most ${AGENT_CONFIG_MAX_PROFILES} profiles`);
  const profiles: AgentProfileConfigV2[] = []; const profileIds = new Set<string>();
  for (let index = 0; index < config.profiles.length; index += 1) {
    const parsed = parseAgentProfileV2(config.profiles[index], `${path}.profiles[${index}]`);
    if (profileIds.has(parsed.id)) throw new AgentConfigValidationError(`${path}.profiles[${index}].id`, "duplicate profile id");
    profileIds.add(parsed.id); profiles.push(parsed);
  }
  if (!Array.isArray(config.connectionSlots) || Object.getPrototypeOf(config.connectionSlots) !== Array.prototype) throw new AgentConfigValidationError(`${path}.connectionSlots`, "must be an array");
  if (config.connectionSlots.length > AGENT_CONFIG_MAX_PROFILES * 2) throw new AgentConfigValidationError(`${path}.connectionSlots`, "contains too many slots");
  const connectionSlots: AgentConnectionSlotV1[] = []; const slotIds = new Set<string>();
  for (let index = 0; index < config.connectionSlots.length; index += 1) {
    const slotPath = `${path}.connectionSlots[${index}]`; const slot = ownDataEntries(config.connectionSlots[index], slotPath);
    exactKeys(slot, ["id", "label", "requiredCapabilities"], slotPath);
    const id = requireSlotId(slot.id, `${slotPath}.id`);
    if (slotIds.has(id)) throw new AgentConfigValidationError(`${slotPath}.id`, "duplicate slot id");
    slotIds.add(id);
    connectionSlots.push({ id, label: requireString(slot.label, `${slotPath}.label`, AGENT_SLOT_LABEL_MAX_LENGTH), requiredCapabilities: requireCapabilities(slot.requiredCapabilities, `${slotPath}.requiredCapabilities`) });
  }
  for (const profile of profiles) if (profile.connectionRef.kind === "slot" && !slotIds.has(profile.connectionRef.slotId)) throw new AgentConfigValidationError(`${path}.profiles.${profile.id}.connectionRef.slotId`, "unknown slot id");
  const parsed: AgentConfigV2 = {
    version: AGENT_CONFIG_V2_VERSION, agentsEnabled, allowedModes, defaultMode: config.defaultMode,
    maxInvocations: Object.hasOwn(config, "maxInvocations") ? requireAgentLimit(config.maxInvocations, `${path}.maxInvocations`, AGENT_INVOCATION_MIN) : AGENT_INVOCATION_DEFAULT,
    maxToolCalls: Object.hasOwn(config, "maxToolCalls") ? requireAgentLimit(config.maxToolCalls, `${path}.maxToolCalls`, AGENT_TOOL_CALL_MIN) : AGENT_TOOL_CALL_DEFAULT,
    mainToolIds, mainLoreScope, profiles, connectionSlots,
  };
  if (Object.hasOwn(config, "phasePolicy")) parsed.phasePolicy = parsePhasePolicy(config.phasePolicy, `${path}.phasePolicy`);
  if (Object.hasOwn(config, "cognitionPolicy")) parsed.cognitionPolicy = parseCognitionPolicy(config.cognitionPolicy, `${path}.cognitionPolicy`);
  if (Object.hasOwn(config, "contextPolicy")) parsed.contextPolicy = parseContextPolicy(config.contextPolicy, `${path}.contextPolicy`);
  if (Object.hasOwn(config, "taskPolicy")) parsed.taskPolicy = parseTaskPolicy(config.taskPolicy, `${path}.taskPolicy`);
  if (Object.hasOwn(config, "workspacePolicy")) parsed.workspacePolicy = parseWorkspacePolicy(config.workspacePolicy, `${path}.workspacePolicy`);
  return parsed;
}

export function parseAgentConfigV2(raw: unknown): AgentConfigV2 {
  return parseAgentConfigV2Object(ownDataEntries(raw, "agentConfig"), "agentConfig");
}

export const validateAgentConfigV2 = parseAgentConfigV2;

export function createDisabledAgentConfigV2(): AgentConfigV2 {
  return { version: AGENT_CONFIG_V2_VERSION, agentsEnabled: false, allowedModes: ["response"], defaultMode: "response", maxInvocations: AGENT_INVOCATION_DEFAULT, maxToolCalls: AGENT_TOOL_CALL_DEFAULT, mainToolIds: [], mainLoreScope: "active", profiles: [], connectionSlots: [] };
}

export function parsePortableAgentConfigV1(raw: unknown): PortableAgentConfigV1 {
  const portable = ownDataEntries(raw, "portableAgentConfig");
  exactKeys(portable, ["portableVersion", "agentsEnabled", "allowedModes", "defaultMode", "maxInvocations", "maxToolCalls", "mainToolIds", "mainLoreScope", "profiles", "connectionSlots", "phasePolicy", "cognitionPolicy", "contextPolicy", "taskPolicy", "workspacePolicy"], "portableAgentConfig", ["phasePolicy", "cognitionPolicy", "contextPolicy", "taskPolicy", "workspacePolicy"]);
  if (portable.portableVersion !== PORTABLE_AGENT_CONFIG_VERSION) throw new AgentConfigValidationError("portableAgentConfig.portableVersion", "must be version 1");
  const { portableVersion: _portableVersion, ...authoredFields } = portable;
  const v2 = parseAgentConfigV2Object({ ...authoredFields, version: AGENT_CONFIG_V2_VERSION }, "portableAgentConfig");
  const { version: _version, ...authored } = v2;
  return { portableVersion: PORTABLE_AGENT_CONFIG_VERSION, ...authored };
}

export function toPortableAgentConfigV1(config: AgentConfigV2): PortableAgentConfigV1 {
  const parsed = parseAgentConfigV2(config);
  const { version: _version, ...authored } = parsed;
  return { portableVersion: PORTABLE_AGENT_CONFIG_VERSION, ...authored };
}

interface LegacyAgentConfigMigration {
  config: AgentConfigV2;
  review: AgentConfigReviewV1;
  localBindings: Array<{ slotId: string; connectionId: string }>;
}

export function migrateParsedLegacyAgentConfigV1(legacy: LegacyAgentConfigV1, resolveOwnedConnection?: (connectionId: string) => boolean): LegacyAgentConfigMigration {
  const localBindings: Array<{ slotId: string; connectionId: string }> = [];
  const unresolvedSlotIds: string[] = [];
  const profiles = legacy.profiles.map((profile): AgentProfileConfigV2 => {
    if (profile.connectionProfileId === null) {
      return { id: profile.id, name: profile.name, systemPrompt: profile.systemPrompt, connectionRef: { kind: "inherit_main" }, toolIds: [...profile.toolIds], workspaceCapabilities: [], loreScope: profile.loreScope, allowMainDelegation: profile.allowMainDelegation, failurePolicy: profile.failurePolicy, streamActivity: profile.streamActivity, maxOutputTokens: profile.maxOutputTokens, timeoutMs: profile.timeoutMs };
    }
    const slotId = "profile/" + profile.id;
    const owned = resolveOwnedConnection ? resolveOwnedConnection(profile.connectionProfileId) : true;
    if (owned) localBindings.push({ slotId, connectionId: profile.connectionProfileId });
    else unresolvedSlotIds.push(slotId);
    return { id: profile.id, name: profile.name, systemPrompt: profile.systemPrompt, connectionRef: { kind: "slot", slotId }, toolIds: [...profile.toolIds], workspaceCapabilities: [], loreScope: profile.loreScope, allowMainDelegation: profile.allowMainDelegation, failurePolicy: profile.failurePolicy, streamActivity: profile.streamActivity, maxOutputTokens: profile.maxOutputTokens, timeoutMs: profile.timeoutMs };
  });
  const config: AgentConfigV2 = {
    version: AGENT_CONFIG_V2_VERSION, agentsEnabled: legacy.enabled, allowedModes: ["response"], defaultMode: "response",
    maxInvocations: legacy.maxInvocations, maxToolCalls: legacy.maxToolCalls, mainToolIds: [...legacy.mainToolIds], mainLoreScope: legacy.mainLoreScope, profiles,
    connectionSlots: profiles.filter((profile): profile is AgentProfileConfigV2 & { connectionRef: AgentSlotConnectionRefV1 } => profile.connectionRef.kind === "slot").map((profile) => ({ id: profile.connectionRef.slotId, label: profile.name, requiredCapabilities: ["generation"] })),
  };
  return { config, review: unresolvedSlotIds.length ? { state: "review_required", reasonCode: "foreign_connection", unresolvedSlotIds, staleSlotIds: [], acknowledged: false } : { state: "ready", reasonCode: null, unresolvedSlotIds: [], staleSlotIds: [], acknowledged: false }, localBindings };
}



export type {
  AgentActivityContinuationMode,
  AgentActivityEventV1,
  AgentActivityLifecycle,
  AgentActivityNodeKind,
  AgentActivityNodeV1,
  AgentActivityRunV1,
  AgentActivitySnapshotV1,
  AgentActivityTerminalSummaryV1,
  AgentActivityToolId,
  AgentActivityUsageV1,
  AgentAdapterCapabilities,
  AgentContinuationCarrier,
  AgentFinalizationRequest,
  AgentLedgerCounters,
  AgentLedgerReservation,
  AgentLoopFrame,
  AgentLoopFrameKind,
  AgentPendingToolCall,
  AgentProviderAdapterContract,
  AgentProviderAdapterId,
  AgentPublicBudgetContext,
  AgentPublicBudgetId,
  AgentPublicErrorCategory,
  AgentPublicErrorCode,
  AgentPublicErrorPayload,
  AgentPublicErrorV1,
  AgentRuntimeHostLimits,
  AgentTerminalReason,
  AgentToolLoopFrame,
  AgentToolMode,
  AgentToolModePolicy,
  AgentTurnLedger,
} from "./agent-runtime";
export {
  AGENT_ACTIVITY_LIVE_BYTES_LIMIT,
  AGENT_ACTIVITY_LIVE_NODE_LIMIT,
  AGENT_PUBLIC_PROVIDER_CODE_PATTERN,
} from "./agent-runtime";