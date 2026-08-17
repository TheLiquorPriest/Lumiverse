import { createHash } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { getDb } from "../db/connection";
import type { Chat } from "../types/chat";
import type { Message } from "../types/message";
import type { PromptBlock, PromptVariableValues } from "../types/preset";
import {
  ContextPackSnapshotAccessError,
  buildHostPrefetchedAgentContextSnapshot,
  freezeContextPackCandidateSnapshot,
} from "./agent-context-tools.service";
import type {
  ContextPackCandidateSnapshotV1,
  ContextPackCandidateV1,
  ContextPackInputRevisionV1,
  ContextPackSnapshotScopeV1,
  ContextPackAccountCandidateSelectionV1,
} from "./agent-context-tools.service";
import { HOST_PREPARATION_LIMITS_V1 } from "../types/agent-preprocessing";
import type { InputRevisionKindV1, InputRevisionSetV1, PreparationLimitsV1 } from "../types/agent-preprocessing";
import { parseAgentConfigV2 } from "../types/agents";
import {
  CanonicalDataError,
  CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
  cloneCanonicalPlainData,
  encodeCanonicalPlainData,
  freezeCanonicalPlainData,
} from "../utils/canonical-plain-data";
import type { AgentContextPolicyV1 } from "../types/agents";
import { freezeCognitionGraph, parseCognitionSourceSnapshot } from "./agent-cognition.service";
import type {
  CognitionSourceSnapshotV1,
  ContextActivationRuleV1,
  FrozenCognitionGraphV1,
} from "../types/agent-cognition";

/**
 * The strict assembly path is deliberately fed by plain data.  It must not
 * retain service instances, database handles, extension registries, callback
 * functions, or mutable model objects across the isolate boundary.
 */
/** Mirrors the canonical value-frame depth: root `0`, each child value `parent + 1`. */
export const SNAPSHOT_DATA_LIMITS_V1 = CANONICAL_SNAPSHOT_DATA_LIMITS_V1;
export const SNAPSHOT_DATA_MAX_DEPTH_V1 = CANONICAL_SNAPSHOT_DATA_LIMITS_V1.maxDepth;
export const SNAPSHOT_DATA_MAX_NODES_V1 = CANONICAL_SNAPSHOT_DATA_LIMITS_V1.maxNodes;

const CORE_TOOL_IDS = [
  "lore_list_books",
  "lore_get_book",
  "lore_list_entries",
  "lore_get_entry",
  "lore_search_entries",
  "chat_search_history",
] as const;

const encoder = new TextEncoder();
const FALLBACK_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  cumulativeExpansionBytes: 16 * 1024 * 1024,
  operationBytes: 2 * 1024 * 1024,
  promptBlocks: 1024,
  activeScripts: 512,
  compiledPatterns: 1024,
  macroResolutions: 10_000,
  trimStrings: 512,
  cooperativeCpuMs: 30_000,
  wallClockMs: 60_000,
  workers: 2,
  queuedJobsPerUser: 4,
  queuedJobsProcess: 32,
});

export interface SnapshotContextPackSelectionV1 {
  readonly packId: string;
  readonly revisionId?: string;
  readonly revision?: number;
  readonly digest?: string;
  readonly required?: boolean;
}

/** Inputs captured immediately before the strict assembly isolate is entered. */
export interface GenerationAssemblySnapshotInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly generationId?: string;
  readonly generationType?: "normal" | "continue" | "regenerate" | "swipe";
  readonly connectionId?: string | null;
  readonly presetId?: string | null;
  readonly personaId?: string | null;
  readonly targetCharacterId?: string | null;
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
  readonly excludeMessageId?: string | null;
  readonly continueMessageId?: string | null;
  /** Candidate snapshot accepted only with the explicit host_prefetched marker. */
  readonly contextPackSnapshot?: ContextPackCandidateSnapshotV1;
  /**
   * Runtime-only provenance for a supplied candidate snapshot. Untrusted
   * callers force a fresh account-service read instead of freezing their data.
   */
  readonly contextPackSnapshotSource?: "host_prefetched" | "untrusted";
  /** Authenticated selections whose revision/digest requirements must be frozen. */
  readonly contextPackSelections?: readonly SnapshotContextPackSelectionV1[];
  readonly userInput?: string;
  readonly toolIds?: readonly string[];
  /** Authenticated normalized-config revision captured by runtime admission. */
  readonly configRevision?: number | string | null;
  /** Authenticated slot-binding high-water revision captured by admission. */
  readonly bindingRevision?: number | string | null;
  /** Optional authenticated effective connection identity supplied by runtime admission. */
  readonly concreteConnection?: Readonly<Record<string, unknown>>;
  /** Authenticated cognition graph/source supplied by the execution loader. */
  readonly cognitionGraph?: unknown;
  readonly cognitionSource?: unknown;
  /** Optional authenticated config projection supplied by runtime admission. */
  readonly agentConfig?: unknown;
  readonly limits?: Partial<Record<LegacyLimitKey | keyof PreparationLimitsV1, number>>;
  readonly db?: Database;
  /**
   * Internal escape hatch for callers that already hold the transaction.
   * Normal snapshots remain isolated by their own read transaction.
   */
  readonly useTransaction?: boolean;
}

export interface SnapshotRevisionV1 {
  readonly kind: InputRevisionKindV1;
  /** Compatibility alias for diagnostics grouped by domain. */
  readonly domain: InputRevisionKindV1;
  readonly id: string;
  readonly revision: string;
  readonly digest: string;
}

/**
 * A compatibility-friendly closed revision set. `entries` is the canonical
 * ordered representation; domain arrays are retained to make membership
 * obvious to callers and to prevent accidental omission during future schema
 * additions.
 */
export interface InputRevisionSetV1Local extends InputRevisionSetV1 {
  readonly entries: readonly SnapshotRevisionV1[];
  readonly target: readonly SnapshotRevisionV1[];
  readonly chat: readonly SnapshotRevisionV1[];
  readonly messages: readonly SnapshotRevisionV1[];
  readonly preset: readonly SnapshotRevisionV1[];
  readonly blocks: readonly SnapshotRevisionV1[];
  readonly config: readonly SnapshotRevisionV1[];
  readonly slotBinding: readonly SnapshotRevisionV1[];
  readonly connection: readonly SnapshotRevisionV1[];
  readonly endpoint: readonly SnapshotRevisionV1[];
  readonly credential: readonly SnapshotRevisionV1[];
  readonly participants: readonly SnapshotRevisionV1[];
  readonly worldLore: readonly SnapshotRevisionV1[];
  readonly settings: readonly SnapshotRevisionV1[];
  readonly variables: readonly SnapshotRevisionV1[];
  readonly regex: readonly SnapshotRevisionV1[];
  readonly context: readonly SnapshotRevisionV1[];
  readonly acl: readonly SnapshotRevisionV1[];
  readonly cognition: readonly SnapshotRevisionV1[];
  readonly readiness: readonly SnapshotRevisionV1[];
}

export interface SnapshotTargetV1 {
  readonly generationType: "normal" | "continue" | "regenerate" | "swipe";
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly continueMessageId: string | null;
  readonly excludedMessageId: string | null;
  readonly userInput: string;
}

export interface SnapshotChatV1 extends Omit<Chat, "metadata"> {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly revision: string;
}

export interface SnapshotMessageV1 extends Omit<Message, "extra" | "swipes" | "swipe_dates"> {
  readonly extra: Readonly<Record<string, unknown>>;
  readonly swipes: readonly string[];
  readonly swipe_dates: readonly number[];
  readonly revision: string;
}

export interface SnapshotBlockV1 extends PromptBlock {
  readonly order: number;
  readonly revision: string;
}

export interface SnapshotPresetV1 {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly engine: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly prompts: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly blocks: readonly SnapshotBlockV1[];
}

export interface SnapshotParticipantV1 {
  readonly persona: Readonly<Record<string, unknown>> | null;
  readonly character: Readonly<Record<string, unknown>>;
  readonly group: readonly Readonly<Record<string, unknown>>[];
  readonly availabilityRevision: string;
}

export interface SnapshotVariableStateV1 {
  readonly preset: Readonly<PromptVariableValues>;
  readonly chat: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly revision: string;
}

export interface SnapshotRegexScriptV1 {
  readonly id: string;
  readonly name: string;
  readonly findRegex: string;
  readonly replaceString: string;
  readonly actions: readonly unknown[];
  readonly flags: string;
  readonly placement: readonly string[];
  readonly scope: string;
  readonly scopeId: string | null;
  readonly target: readonly string[];
  readonly trimStrings: readonly string[];
  readonly disabled: false;
  readonly sortOrder: number;
  readonly revision: string;
}

export interface SnapshotWorldBookV1 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: "character" | "persona" | "chat" | "global" | "peer";
  readonly order: number;
  readonly revision: string;
}

export interface SnapshotWorldEntryV1 {
  readonly id: string;
  readonly bookId: string;
  readonly bookName: string;
  readonly source: SnapshotWorldBookV1["source"];
  /**
   * This is the complete callback-free activation input. Keep these fields
   * explicit rather than deriving constant/keyword state from `activated`;
   * activation is recomputed in the strict isolate.
   */
  readonly uid: string;
  readonly outletName: string | null;
  readonly wiMarker: string | null;
  readonly wiMarkerSide: "before" | "after" | null;
  readonly order: number;
  readonly orderValue: number;
  readonly activated: boolean;
  readonly disabled: boolean;
  readonly constant: boolean;
  readonly selective: boolean;
  readonly groupName: string;
  readonly groupOverride: boolean;
  readonly groupWeight: number;
  readonly probability: number;
  readonly scanDepth: number | null;
  readonly excludeGreeting: boolean;
  readonly caseSensitive: boolean;
  readonly matchWholeWords: boolean;
  readonly useRegex: boolean;
  readonly preventRecursion: boolean;
  readonly excludeRecursion: boolean;
  readonly delayUntilRecursion: boolean;
  readonly priority: number;
  readonly sticky: number;
  readonly cooldown: number;
  readonly delay: number;
  readonly selectiveLogic: number;
  readonly useProbability: boolean;
  readonly vectorized: boolean;
  readonly vectorIndexStatus: string;
  readonly content: string;
  readonly comment: string;
  readonly keys: readonly string[];
  readonly secondaryKeys: readonly string[];
  readonly position: number;
  readonly depth: number;
  readonly role: string | null;
  readonly state: Readonly<Record<string, unknown>>;
  readonly revision: string;
}

export interface SnapshotWorldInfoV1 {
  readonly books: readonly SnapshotWorldBookV1[];
  readonly entries: readonly SnapshotWorldEntryV1[];
  readonly candidates: readonly SnapshotWorldEntryV1[];
  readonly state: Readonly<Record<string, unknown>>;
}

export interface SnapshotContextPackPolicySelectionV1 {
  readonly packId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly required: boolean;
}

export interface SnapshotContextPacksV1 {
  readonly schema: "present";
  readonly contextAclRevision: number | string;
  readonly candidates: readonly ContextPackCandidateV1[];
  /** Explicit policy selections consumed by cognition runtime; never DB-derived. */
  readonly contextPackSelections: readonly SnapshotContextPackPolicySelectionV1[];
  readonly candidateInputRevisions: readonly ContextPackInputRevisionV1[];
  readonly attachments: readonly Readonly<Record<string, unknown>>[];
  readonly acl: readonly Readonly<Record<string, unknown>>[];
  /** Source-checked cognition graph and Loom source snapshot frozen for this turn. */
  readonly cognitionGraph: FrozenCognitionGraphV1 | null;
  readonly cognitionSource: CognitionSourceSnapshotV1 | null;
  /** Frozen canonical context activation rules selected by AgentContextPolicyV1. */
  readonly contextRules: readonly ContextActivationRuleV1[];
  readonly revision: string;
}
export interface SnapshotAvailabilityV1 {
  readonly participantIds: readonly string[];
  readonly toolIds: readonly string[];
  readonly extensionsExcluded: true;
  readonly ambientSpindleExcluded: true;
  readonly revision: string;
}

export interface GenerationAssemblySnapshotV1 {
  readonly version: 1;
  readonly snapshotId: string;
  readonly userId: string;
  readonly generationId: string;
  readonly chatId: string;
  readonly target: SnapshotTargetV1;
  readonly chat: SnapshotChatV1;
  readonly messages: readonly SnapshotMessageV1[];
  readonly preset: SnapshotPresetV1 | null;
  readonly blocks: readonly SnapshotBlockV1[];
  readonly participants: SnapshotParticipantV1;
  readonly variables: SnapshotVariableStateV1;
  readonly regexScripts: readonly SnapshotRegexScriptV1[];
  readonly worldInfo: SnapshotWorldInfoV1;
  readonly contextPacks: SnapshotContextPacksV1;
  readonly contextPackSnapshot: ContextPackCandidateSnapshotV1;
  readonly availability: SnapshotAvailabilityV1;
  readonly connection: Readonly<Record<string, unknown>> | null;
  /** Normalized V2 config captured by authenticated runtime admission. */
  readonly agentConfig: unknown;
  readonly limits: PreparationLimitsV1;
  readonly inputRevisionSet: InputRevisionSetV1Local;
  /** Alias used by consumers that name the field after its DTO type. */
  readonly revisions: InputRevisionSetV1Local;
  readonly extensionData: null;
  readonly ambientSpindleData: null;
}

type LegacyLimitKey =
  | "inputBytes"
  | "outputBytes"
  | "cumulativeExpansionBytes"
  | "operationBytes"
  | "promptBlocks"
  | "activeScripts"
  | "compiledPatterns"
  | "macroResolutions"
  | "trimStrings"
  | "cooperativeCpuMs"
  | "wallClockMs"
  | "workers"
  | "queuedJobsPerUser"
  | "queuedJobsProcess";
type Limits = PreparationLimitsV1 & Readonly<Record<LegacyLimitKey, number>>;
type RawRow = Record<string, unknown>;

function publicLimits(limits: Limits): PreparationLimitsV1 {
  return Object.freeze({
    maxInputBytes: limits.inputBytes,
    maxOutputBytes: limits.outputBytes,
    maxCumulativeExpansionBytes: limits.cumulativeExpansionBytes,
    maxOperationBytes: limits.operationBytes,
    maxPromptBlocks: limits.promptBlocks,
    maxActiveScripts: limits.activeScripts,
    maxCompiledPatterns: limits.compiledPatterns,
    maxMacroResolutions: limits.macroResolutions,
    maxTrimStrings: limits.trimStrings,
    maxCooperativeCpuMs: limits.cooperativeCpuMs,
    maxWallClockMs: limits.wallClockMs,
    maxWorkers: limits.workers,
    maxQueuedJobsPerUser: limits.queuedJobsPerUser,
    maxQueuedJobsProcess: limits.queuedJobsProcess,
  });
}

function hostLimits(): Limits {
  const source = HOST_PREPARATION_LIMITS_V1;
  const maxInputBytes = source.maxInputBytes;
  const maxOutputBytes = source.maxOutputBytes;
  const maxCumulativeExpansionBytes = source.maxCumulativeExpansionBytes;
  const maxOperationBytes = source.maxOperationBytes;
  const maxPromptBlocks = source.maxPromptBlocks;
  const maxActiveScripts = source.maxActiveScripts;
  const maxCompiledPatterns = source.maxCompiledPatterns;
  const maxMacroResolutions = source.maxMacroResolutions;
  const maxTrimStrings = source.maxTrimStrings;
  const maxCooperativeCpuMs = source.maxCooperativeCpuMs;
  const maxWallClockMs = source.maxWallClockMs;
  const maxWorkers = source.maxWorkers;
  const maxQueuedJobsPerUser = source.maxQueuedJobsPerUser;
  const maxQueuedJobsProcess = source.maxQueuedJobsProcess;
  return Object.freeze({
    ...source,
    inputBytes: maxInputBytes,
    outputBytes: maxOutputBytes,
    cumulativeExpansionBytes: maxCumulativeExpansionBytes,
    operationBytes: maxOperationBytes,
    promptBlocks: maxPromptBlocks,
    activeScripts: maxActiveScripts,
    compiledPatterns: maxCompiledPatterns,
    macroResolutions: maxMacroResolutions,
    trimStrings: maxTrimStrings,
    cooperativeCpuMs: maxCooperativeCpuMs,
    wallClockMs: maxWallClockMs,
    workers: maxWorkers,
    queuedJobsPerUser: maxQueuedJobsPerUser,
    queuedJobsProcess: maxQueuedJobsProcess,
  });
}

function lowerLimits(requested: GenerationAssemblySnapshotInputV1["limits"]): Limits {
  const host = hostLimits();
  const output: Record<string, number> = { ...host };
  const legacyKeys = Object.keys(FALLBACK_LIMITS) as LegacyLimitKey[];
  const canonicalKeys: readonly (keyof PreparationLimitsV1)[] = [
    "maxInputBytes", "maxOutputBytes", "maxCumulativeExpansionBytes", "maxOperationBytes",
    "maxPromptBlocks", "maxActiveScripts", "maxCompiledPatterns", "maxMacroResolutions",
    "maxTrimStrings", "maxCooperativeCpuMs", "maxWallClockMs", "maxWorkers",
    "maxQueuedJobsPerUser", "maxQueuedJobsProcess",
  ];
  for (let index = 0; index < legacyKeys.length; index++) {
    const legacy = legacyKeys[index]!;
    const canonicalKey = canonicalKeys[index]!;
    const requestedValue = requested?.[legacy];
    if (typeof requestedValue === "number" && Number.isFinite(requestedValue) && requestedValue > 0) {
      output[legacy] = Math.min(host[legacy], Math.floor(requestedValue));
      output[canonicalKey] = output[legacy];
    }
  }
  for (const canonicalKey of canonicalKeys) {
    const requestedValue = requested?.[canonicalKey];
    if (typeof requestedValue === "number" && Number.isFinite(requestedValue) && requestedValue > 0) {
      output[canonicalKey] = Math.min(host[canonicalKey], Math.floor(requestedValue));
    }
  }
  for (let index = 0; index < legacyKeys.length; index++) output[legacyKeys[index]!] = output[canonicalKeys[index]!]!;
  return Object.freeze(output) as Limits;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function assertString(value: unknown, label: string, maxBytes: number, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new SnapshotInputError(`invalid ${label}`);
  }
  if (utf8Bytes(value) > maxBytes) throw new SnapshotLimitError(`${label} exceeds input limit`);
  return value;
}

function assertId(value: unknown, label: string): string {
  return assertString(value, label, 4096, false);
}

function parseJson<T>(value: unknown, label: string, maxBytes: number, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  assertString(value, label, maxBytes);
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new SnapshotInputError(`invalid ${label}`);
  }
}

function objectValue(value: unknown, label: string, maxBytes: number): Readonly<Record<string, unknown>> {
  const parsed = parseJson<unknown>(value, label, maxBytes, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SnapshotInputError(`invalid ${label}`);
  }
  try {
    encodeCanonicalPlainData(parsed, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
  } catch (error) {
    throwSnapshotDataError(error, label);
  }
  return deepFreeze({ ...(parsed as Record<string, unknown>) }, maxBytes);
}

function arrayValue(value: unknown, label: string, maxBytes: number): readonly unknown[] {
  const parsed = parseJson<unknown>(value, label, maxBytes, []);
  if (!Array.isArray(parsed)) throw new SnapshotInputError(`invalid ${label}`);
  try {
    encodeCanonicalPlainData(parsed, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
  } catch (error) {
    throwSnapshotDataError(error, label);
  }
  return deepFreeze([...parsed], maxBytes);
}

function throwSnapshotDataError(error: unknown, label: string): never {
  if (error instanceof CanonicalDataError && error.code === "limit_exceeded") {
    throw new SnapshotLimitError(`${label} exceeds ${error.dimension ?? "data"} limit`);
  }
  throw new SnapshotInputError(`invalid ${label}`);
}

function deepFreeze<T>(value: T, maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes): T {
  try {
    return freezeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
  } catch (error) {
    throwSnapshotDataError(error, "snapshot data");
  }
}

function canonical(value: unknown, maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes): string {
  try {
    return encodeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
  } catch (error) {
    throwSnapshotDataError(error, "snapshot data");
  }
}

function isClosedData(value: unknown, maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes): boolean {
  try {
    encodeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
    return true;
  } catch (error) {
    if (error instanceof CanonicalDataError && error.code === "limit_exceeded") return false;
    return false;
  }
}

function normalizeAgentConfig(value: unknown, maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes): unknown {
  if (value === undefined || value === null) return null;
  try {
    encodeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
  } catch (error) {
    throwSnapshotDataError(error, "agent config");
  }
  try {
    const record = value as Record<string, unknown>;
    if (record.version !== 2) {
      throw new SnapshotInputError("agent config must use canonical V2");
    }
    return deepFreeze(parseAgentConfigV2(value), maxBytes);
  } catch (error) {
    if (error instanceof SnapshotInputError || error instanceof SnapshotLimitError) throw error;
    throw new SnapshotInputError("invalid agent config");
  }
}

function boundedClosedDataBytes(value: unknown, maxBytes: number): number {
  try {
    return utf8Bytes(encodeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    }));
  } catch {
    return maxBytes + 1;
  }
}

function cloneClosedData(value: unknown): unknown {
  try {
    return cloneCanonicalPlainData(value, CANONICAL_SNAPSHOT_DATA_LIMITS_V1);
  } catch (error) {
    throwSnapshotDataError(error, "snapshot data");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function revision(kind: InputRevisionKindV1, id: string, value: unknown, sourceRevision?: unknown): SnapshotRevisionV1 {
  const canonicalValue = canonical(value);
  const valueDigest = createHash("sha256").update(canonicalValue).digest("hex");
  return Object.freeze({
    kind,
    domain: kind,
    id,
    revision: typeof sourceRevision === "number" || typeof sourceRevision === "string"
      ? String(sourceRevision)
      : valueDigest,
    digest: valueDigest,
  });
}

function rowsFor<T extends RawRow>(db: Database, sql: string, ...params: SQLQueryBindings[]): T[] {
  return db.query(sql).all(...params) as T[];
}

function rowFor<T extends RawRow>(db: Database, sql: string, ...params: SQLQueryBindings[]): T | null {
  return (db.query(sql).get(...params) as T | null | undefined) ?? null;
}

function rowNumber(row: RawRow, key: string, fallback = 0): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rowBoolean(row: RawRow, key: string): boolean {
  return row[key] === true || row[key] === 1 || row[key] === "1";
}

function safeArrayOfStrings(value: unknown, label: string, maxBytes: number): string[] {
  const values = arrayValue(value, label, maxBytes);
  const output: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") throw new SnapshotInputError(`invalid ${label}`);
    assertString(item, label, maxBytes);
    output.push(item);
  }
  return output;
}

function normalizePromptBlock(raw: unknown, order: number, maxBytes: number): SnapshotBlockV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SnapshotInputError("invalid prompt block");
  const source = raw as Record<string, unknown>;
  const id = assertId(source.id, "prompt block id");
  const content = assertString(source.content ?? "", "prompt block content", maxBytes);
  const role = source.role;
  const position = source.position;
  const validRoles = new Set(["system", "user", "assistant", "user_append", "assistant_append"]);
  const validPositions = new Set(["pre_history", "post_history", "in_history"]);
  if (typeof role !== "string" || !validRoles.has(role)) throw new SnapshotInputError("invalid prompt block role");
  if (typeof position !== "string" || !validPositions.has(position)) throw new SnapshotInputError("invalid prompt block position");
  const variables = source.variables === undefined ? undefined : source.variables;
  const normalized: PromptBlock = {
    id,
    name: assertString(source.name ?? id, "prompt block name", maxBytes),
    content,
    role: role as PromptBlock["role"],
    enabled: source.enabled !== false,
    position: position as PromptBlock["position"],
    depth: typeof source.depth === "number" && Number.isFinite(source.depth) ? Math.max(0, Math.floor(source.depth)) : 0,
    marker: typeof source.marker === "string" ? source.marker : null,
    isLocked: source.isLocked === true,
    color: typeof source.color === "string" ? source.color : null,
    injectionTrigger: Array.isArray(source.injectionTrigger)
      ? source.injectionTrigger.filter((item): item is string => typeof item === "string")
      : [],
    characterTagTrigger: Array.isArray(source.characterTagTrigger)
      ? source.characterTagTrigger.filter((item): item is string => typeof item === "string")
      : undefined,
    group: typeof source.group === "string" ? source.group : null,
    categoryMode: source.categoryMode === "radio" || source.categoryMode === "checkbox" ? source.categoryMode : null,
    variables: Array.isArray(variables) ? variables as PromptBlock["variables"] : undefined,
    placementBinding: source.placementBinding as PromptBlock["placementBinding"],
    stashId: typeof source.stashId === "string" ? source.stashId : undefined,
    sealed: source.sealed === true,
    sealedKey: typeof source.sealedKey === "string" ? source.sealedKey : undefined,
    sealedSource: typeof source.sealedSource === "string" ? source.sealedSource : undefined,
    sealedOriginPresetId: typeof source.sealedOriginPresetId === "string" ? source.sealedOriginPresetId : undefined,
    sealedOriginVersion: typeof source.sealedOriginVersion === "string" ? source.sealedOriginVersion : source.sealedOriginVersion === null ? null : undefined,
    sealedSha256: typeof source.sealedSha256 === "string" ? source.sealedSha256 : undefined,
  };
  return deepFreeze({ ...normalized, order, revision: digest(normalized) });
}

function normalizePreset(row: RawRow, limits: Limits): SnapshotPresetV1 {
  const max = limits.inputBytes;
  const id = assertId(row.id, "preset id");
  const parameters = objectValue(row.parameters, "preset parameters", max);
  const prompts = objectValue(row.prompts, "preset prompts", max);
  const metadata = objectValue(row.metadata, "preset metadata", max);
  const promptOrder = parseJson<unknown>(row.prompt_order, "preset prompt order", max, []);
  if (!Array.isArray(promptOrder)) throw new SnapshotInputError("invalid preset prompt order");
  if (promptOrder.length > limits.promptBlocks) throw new SnapshotLimitError("prompt block limit exceeded");
  const blocks = promptOrder.map((block, order) => normalizePromptBlock(block, order, max));
  const value = {
    id,
    name: assertString(row.name ?? id, "preset name", max),
    provider: assertString(row.provider ?? "", "preset provider", max),
    engine: assertString(row.engine ?? "classic", "preset engine", max),
    parameters,
    prompts,
    metadata,
    revision: String(row.cache_revision ?? row.updated_at ?? digest({ id, blocks })),
    blocks,
  } satisfies Omit<SnapshotPresetV1, "revision"> & { revision: string };
  return deepFreeze(value);
}

function normalizeMessage(row: RawRow, limits: Limits): SnapshotMessageV1 {
  const max = limits.inputBytes;
  const swipes = safeArrayOfStrings(row.swipes, "message swipes", max);
  const swipeDatesRaw = arrayValue(row.swipe_dates, "message swipe dates", max);
  const swipeDates = swipeDatesRaw.map((value) => typeof value === "number" && Number.isFinite(value) ? value : 0);
  const extra = objectValue(row.extra, "message extra", max);
  const content = assertString(row.content ?? "", "message content", max);
  const message = {
    id: assertId(row.id, "message id"),
    chat_id: assertId(row.chat_id, "message chat id"),
    index_in_chat: rowNumber(row, "index_in_chat"),
    is_user: rowBoolean(row, "is_user"),
    name: assertString(row.name ?? "", "message name", max),
    content,
    send_date: rowNumber(row, "send_date"),
    swipe_id: Math.max(0, Math.floor(rowNumber(row, "swipe_id"))),
    swipes,
    swipe_dates: swipeDates,
    extra,
    parent_message_id: typeof row.parent_message_id === "string" ? row.parent_message_id : null,
    branch_id: typeof row.branch_id === "string" ? row.branch_id : null,
    created_at: rowNumber(row, "created_at"),
    revision: String(row.revision ?? row.generation_revision ?? row.updated_at ?? digest({ id: row.id, content, swipes, extra })),
  } satisfies SnapshotMessageV1;
  return deepFreeze(message);
}

function normalizeChat(row: RawRow, limits: Limits): SnapshotChatV1 {
  const metadata = objectValue(row.metadata, "chat metadata", limits.inputBytes);
  return deepFreeze({
    id: assertId(row.id, "chat id"),
    character_id: typeof row.character_id === "string" ? row.character_id : null,
    name: assertString(row.name ?? "", "chat name", limits.inputBytes),
    metadata,
    created_at: rowNumber(row, "created_at"),
    updated_at: rowNumber(row, "updated_at"),
    revision: String(row.revision ?? row.generation_revision ?? row.updated_at ?? digest({ id: row.id, metadata })),
  } as SnapshotChatV1);
}

function normalizeParticipant(row: RawRow | null, limits: Limits): Readonly<Record<string, unknown>> {
  if (!row) return deepFreeze({ id: "__assistant__", name: "Assistant" });
  const allowed = [
    "id", "name", "description", "personality", "scenario", "first_mes", "mes_example",
    "system_prompt", "post_history_instructions", "extensions", "updated_at", "revision",
  ];
  const output: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key === "extensions") {
      // Extensions can contain ambient callbacks/registries. Only retain the
      // explicit world-book attachment identifiers needed by this snapshot.
      const extensions = objectValue(row[key], "character extensions", limits.inputBytes);
      output.world_book_ids = safeArrayOfStrings(extensions.world_book_ids ?? [], "character world books", limits.inputBytes);
      continue;
    }
    const value = row[key];
    if (typeof value === "string") output[key] = assertString(value, `participant ${key}`, limits.inputBytes);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) output[key] = value;
  }
  return deepFreeze(output);
}

function normalizePersona(row: RawRow | null, limits: Limits): Readonly<Record<string, unknown>> | null {
  if (!row) return null;
  const output: Record<string, unknown> = {};
  for (const key of [
    "id", "name", "title", "description", "subjective_pronoun", "objective_pronoun",
    "possessive_pronoun", "reflexive_pronoun", "possessive_pronoun_standalone", "attached_world_book_id",
    "is_narrator", "updated_at", "revision",
  ]) {
    const value = row[key];
    if (typeof value === "string") output[key] = assertString(value, `persona ${key}`, limits.inputBytes);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) output[key] = value;
  }
  return deepFreeze(output);
}

function regexFlagsValid(flags: string): boolean {
  const valid = new Set(["d", "g", "i", "m", "s", "u", "v", "y"]);
  return [...flags].every((flag) => valid.has(flag)) && new Set(flags).size === flags.length;
}

function regexRowToSnapshot(row: RawRow, limits: Limits): SnapshotRegexScriptV1 | null {
  const pattern = typeof row.find_regex === "string" ? row.find_regex : "";
  const flags = typeof row.flags === "string" ? row.flags : "gi";
  if (!pattern || utf8Bytes(pattern) > limits.operationBytes || !regexFlagsValid(flags)) return null;
  try {
    // A source row with macro placeholders cannot be compiled in the strict
    // worker; it is not an active strict row until a pure snapshot resolver
    // supplies a concrete pattern.
    if (pattern.includes("{{") || pattern.includes("<USER>") || pattern.includes("<BOT>") || pattern.includes("<CHAR>")) return null;
    new RegExp(pattern, flags);
  } catch {
    return null;
  }
  const placements = safeArrayOfStrings(row.placement, "regex placement", limits.operationBytes);
  const targets = safeArrayOfStrings(row.target, "regex target", limits.operationBytes);
  const trimStrings = safeArrayOfStrings(row.trim_strings, "regex trim strings", limits.operationBytes);
  if (trimStrings.length > limits.trimStrings || trimStrings.some((value) => value.length === 0 || utf8Bytes(value) > limits.operationBytes)) return null;
  const actions = arrayValue(row.actions, "regex actions", limits.operationBytes);
  const replaceString = assertString(row.replace_string ?? "", "regex replacement", limits.operationBytes);
  const name = assertString(row.name ?? row.id ?? "", "regex name", limits.operationBytes);
  const script = {
    id: assertId(row.id, "regex id"),
    name,
    findRegex: pattern,
    replaceString,
    actions,
    flags,
    placement: placements,
    scope: typeof row.scope === "string" ? row.scope : "global",
    scopeId: typeof row.scope_id === "string" ? row.scope_id : null,
    target: targets,
    trimStrings,
    disabled: false as const,
    sortOrder: rowNumber(row, "sort_order"),
    revision: String(row.revision ?? row.updated_at ?? digest({ id: row.id, pattern, replaceString, flags, actions })),
  } satisfies SnapshotRegexScriptV1;
  return deepFreeze(script);
}

function parseSettings(rows: RawRow[], limits: Limits): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  let bytes = 0;
  for (const row of rows) {
    const key = assertString(row.key, "setting key", limits.inputBytes, false);
    const raw = typeof row.value === "string" ? row.value : row.value;
    bytes += utf8Bytes(key) + (typeof raw === "string" ? utf8Bytes(raw) : 0);
    if (bytes > limits.inputBytes) throw new SnapshotLimitError("settings input limit exceeded");
    settings[key] = parseJson(raw, `setting ${key}`, limits.inputBytes, null);
  }
  return settings;
}

function getWorldBookIds(
  chat: SnapshotChatV1,
  character: Readonly<Record<string, unknown>>,
  persona: Readonly<Record<string, unknown>> | null,
  group: readonly Readonly<Record<string, unknown>>[],
  settings: Readonly<Record<string, unknown>>,
  maxBooks: number,
): Array<{ id: string; source: SnapshotWorldBookV1["source"] }> {
  const output: Array<{ id: string; source: SnapshotWorldBookV1["source"] }> = [];
  const seen = new Set<string>();
  const push = (value: unknown, source: SnapshotWorldBookV1["source"]) => {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) return;
    if (output.length >= maxBooks) throw new SnapshotLimitError("world-book limit exceeded");
    seen.add(value);
    output.push({ id: value, source });
  };
  const charBooks = character.world_book_ids;
  if (Array.isArray(charBooks)) for (const id of charBooks) push(id, "character");
  for (const member of group) {
    const ids = member.world_book_ids;
    if (Array.isArray(ids)) for (const id of ids) push(id, "character");
  }
  push(persona?.attached_world_book_id, "persona");
  const chatIds = chat.metadata.chat_world_book_ids;
  if (Array.isArray(chatIds)) for (const id of chatIds) push(id, "chat");
  const globals = settings.globalWorldBooks;
  if (Array.isArray(globals)) for (const id of globals) push(id, "global");
  return output;
}

function tableColumnSet(db: Database, table: "world_book_entries"): ReadonlySet<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as RawRow[];
  return new Set(rows.map((row) => typeof row.name === "string" ? row.name : "").filter(Boolean));
}

function normalizeWorld(
  db: Database,
  userId: string,
  chat: SnapshotChatV1,
  character: Readonly<Record<string, unknown>>,
  persona: Readonly<Record<string, unknown>> | null,
  group: readonly Readonly<Record<string, unknown>>[],
  settings: Readonly<Record<string, unknown>>,
  limits: Limits,
): SnapshotWorldInfoV1 {
  const requested = getWorldBookIds(chat, character, persona, group, settings, limits.promptBlocks);
  if (requested.length === 0) return deepFreeze({ books: [], entries: [], candidates: [], state: {} });
  if (requested.length > limits.promptBlocks) throw new SnapshotLimitError("world-book limit exceeded");
  const booksById = new Map<string, SnapshotWorldBookV1>();
  const books: SnapshotWorldBookV1[] = [];
  for (let index = 0; index < requested.length; index++) {
    const sourceRef = requested[index]!;
    const row = rowFor<RawRow>(
      db,
      "SELECT id, name, description, updated_at FROM world_books WHERE user_id = ? AND id = ? LIMIT 1",
      userId,
      sourceRef.id,
    );
    if (!row) continue;
    const book = deepFreeze({
      id: assertId(row.id, "world book id"),
      name: assertString(row.name ?? row.id, "world book name", limits.inputBytes),
      description: assertString(row.description ?? "", "world book description", limits.inputBytes),
      source: sourceRef.source,
      order: index,
      revision: String(row.revision ?? row.updated_at ?? digest(row)),
    } satisfies SnapshotWorldBookV1);
    books.push(book);
    booksById.set(book.id, book);
  }
  if (books.length === 0) return deepFreeze({ books: [], entries: [], candidates: [], state: {} });

  const entries: SnapshotWorldEntryV1[] = [];
  const maxEntries = limits.promptBlocks * 16;
  let scannedEntries = 0;
  const entryColumns = tableColumnSet(db, "world_book_entries");
  const selectColumns = [
    "id", "world_book_id", "uid", "key", "keysecondary", "content", "comment", "position", "depth", "role",
    "order_value", "selective", "constant", "disabled", "group_name", "group_override", "group_weight",
    "probability", "scan_depth", "exclude_greeting", "case_sensitive", "match_whole_words", "use_regex",
    "prevent_recursion", "exclude_recursion", "delay_until_recursion", "priority", "sticky", "cooldown", "delay",
    "selective_logic", "use_probability", "vectorized", "vector_index_status", "extensions", "revision",
    "updated_at", "created_at",
  ].filter((column) => entryColumns.has(column));
  const orderColumns = ["order_value", "position", "depth", "created_at", "id"].filter((column) => entryColumns.has(column));
  if (!entryColumns.has("id") || !entryColumns.has("world_book_id") || orderColumns.length === 0) {
    throw new SnapshotInputError("world_book_entries schema is incomplete");
  }
  const entryQuery = `SELECT ${selectColumns.join(", ")} FROM world_book_entries WHERE world_book_id = ? ORDER BY ${orderColumns.join(", ")} LIMIT 1 OFFSET ?`;
  for (const bookId of books.map((book) => book.id).sort()) {
    let entryOffset = 0;
    while (scannedEntries <= maxEntries) {
      const row = rowFor<RawRow>(db, entryQuery, bookId, entryOffset);
      if (!row) break;
      entryOffset++;
      scannedEntries++;
      if (scannedEntries > maxEntries) throw new SnapshotLimitError("world-entry limit exceeded");
      const book = booksById.get(String(row.world_book_id));
      if (!book) continue;
      const extensions = objectValue(row.extensions ?? "{}", "world entry extensions", limits.inputBytes);
      const rawOutlet = extensions.outlet_name ?? extensions.outletName;
      const rawMarker = extensions.wi_marker ?? extensions.wiMarker;
      const rawMarkerSide = extensions.wi_marker_side ?? extensions.wiMarkerSide;
      const entry = deepFreeze({
        id: assertId(row.id, "world entry id"),
        bookId: book.id,
        bookName: book.name,
        source: book.source,
        uid: assertId(row.uid ?? row.id, "world entry uid"),
        outletName: typeof rawOutlet === "string" && rawOutlet.trim().length > 0 ? assertString(rawOutlet.trim(), "world entry outlet", limits.inputBytes) : null,
        wiMarker: typeof rawMarker === "string" && rawMarker.trim().length > 0 ? assertString(rawMarker.trim(), "world entry marker", limits.inputBytes) : null,
        wiMarkerSide: rawMarkerSide === "before" || rawMarkerSide === "after" ? rawMarkerSide : null,
        order: entries.length,
        orderValue: rowNumber(row, "order_value", 100),
        activated: false,
        disabled: rowBoolean(row, "disabled"),
        constant: rowBoolean(row, "constant"),
        selective: rowBoolean(row, "selective"),
        groupName: assertString(row.group_name ?? "", "world entry group", limits.inputBytes),
        groupOverride: rowBoolean(row, "group_override"),
        groupWeight: rowNumber(row, "group_weight", 100),
        probability: rowNumber(row, "probability", 100),
        scanDepth: row.scan_depth === null || row.scan_depth === undefined ? null : rowNumber(row, "scan_depth"),
        excludeGreeting: rowBoolean(row, "exclude_greeting"),
        caseSensitive: rowBoolean(row, "case_sensitive"),
        matchWholeWords: rowBoolean(row, "match_whole_words"),
        useRegex: rowBoolean(row, "use_regex"),
        preventRecursion: rowBoolean(row, "prevent_recursion"),
        excludeRecursion: rowBoolean(row, "exclude_recursion"),
        delayUntilRecursion: rowBoolean(row, "delay_until_recursion"),
        priority: rowNumber(row, "priority", 10),
        sticky: rowNumber(row, "sticky"),
        cooldown: rowNumber(row, "cooldown"),
        delay: rowNumber(row, "delay"),
        selectiveLogic: rowNumber(row, "selective_logic"),
        useProbability: rowBoolean(row, "use_probability"),
        vectorized: rowBoolean(row, "vectorized"),
        vectorIndexStatus: typeof row.vector_index_status === "string" ? row.vector_index_status : "not_enabled",
        content: assertString(row.content ?? "", "world entry content", limits.inputBytes),
        comment: assertString(row.comment ?? "", "world entry comment", limits.inputBytes),
        keys: safeArrayOfStrings(row.key, "world entry keys", limits.inputBytes),
        secondaryKeys: safeArrayOfStrings(row.keysecondary, "world entry secondary keys", limits.inputBytes),
        position: rowNumber(row, "position"),
        depth: rowNumber(row, "depth", 4),
        role: typeof row.role === "string" ? row.role : null,
        state: deepFreeze({}),
        revision: String(row.revision ?? row.updated_at ?? digest(row)),
      } satisfies SnapshotWorldEntryV1);
      entries.push(entry);
    }
  }
  const stateValue = chat.metadata.wi_state;
  const state = stateValue && typeof stateValue === "object" && !Array.isArray(stateValue)
    ? deepFreeze({ ...(stateValue as Record<string, unknown>) })
    : deepFreeze({});
  return deepFreeze({ books, entries, candidates: entries, state });
}

function activeRegexRows(
  db: Database,
  userId: string,
  chat: SnapshotChatV1,
  characterId: string | null,
  presetId: string | null,
  settings: Readonly<Record<string, unknown>>,
  limits: Limits,
): SnapshotRegexScriptV1[] {
  const maxRows = limits.activeScripts * 4;
  let rowOffset = 0;
  const rows: RawRow[] = [];
  while (rowOffset <= maxRows) {
    const row = rowFor<RawRow>(
      db,
      "SELECT * FROM regex_scripts WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC LIMIT 1 OFFSET ?",
      userId,
      rowOffset,
    );
    if (!row) break;
    rows.push(row);
    rowOffset++;
  }
  if (rows.length > maxRows) throw new SnapshotLimitError("regex row limit exceeded");
  const presetEnabled = presetId ? settings[`presetRegexEnabled:${presetId}`] : undefined;
  const enabledIds = Array.isArray(presetEnabled)
    ? new Set(presetEnabled.filter((value): value is string => typeof value === "string"))
    : null;
  const output: SnapshotRegexScriptV1[] = [];
  for (const row of rows) {
    if (rowBoolean(row, "disabled")) continue;
    const validationErrorCode = typeof row.validation_error_code === "string"
      ? row.validation_error_code.trim()
      : "";
    if (validationErrorCode) {
      throw new SnapshotInputError(`requires_response_mode: active regex script requires repair (${validationErrorCode})`);
    }
    const scope = typeof row.scope === "string" ? row.scope : "global";
    const scopeId = typeof row.scope_id === "string" ? row.scope_id : null;
    if (scope === "character" && scopeId !== characterId) continue;
    if (scope === "chat" && scopeId !== chat.id) continue;
    if (typeof row.preset_id === "string" && presetId !== row.preset_id) continue;
    if (enabledIds && typeof row.preset_id === "string" && !enabledIds.has(String(row.id))) continue;
    const normalized = regexRowToSnapshot(row, limits);
    if (!normalized) continue;
    output.push(normalized);
    if (output.length > limits.activeScripts) throw new SnapshotLimitError("active regex limit exceeded");
  }
  return output;

}
function normalizeTools(toolIds: readonly string[] | undefined, limits: Limits): readonly string[] {
  if (toolIds !== undefined && !Array.isArray(toolIds)) {
    throw new SnapshotInputError("tool IDs must be an array");
  }
  const requested = toolIds === undefined ? CORE_TOOL_IDS : toolIds;
  if (toolIds !== undefined) {
    if (requested.length > limits.promptBlocks) throw new SnapshotLimitError("tool ID limit exceeded");
    let bytes = 0;
    for (const tool of requested) {
      bytes += typeof tool === "string" ? utf8Bytes(tool) : 1;
      if (bytes > limits.inputBytes) throw new SnapshotLimitError("tool input limit exceeded");
    }
  }
  const allowed = new Set<string>(CORE_TOOL_IDS);
  const unique = [...new Set(requested.filter((tool): tool is string => typeof tool === "string" && allowed.has(tool)))];
  return Object.freeze(CORE_TOOL_IDS.filter((tool) => unique.includes(tool)));
}

function getConnection(
  db: Database,
  userId: string,
  connectionId: string | null | undefined,
  presetId: string | null | undefined,
  concrete: Readonly<Record<string, unknown>> | undefined,
  limits: Limits,
): Readonly<Record<string, unknown>> | null {
  const row = concrete
    ? null
    : connectionId
      ? rowFor<RawRow>(db, "SELECT id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, updated_at FROM connection_profiles WHERE id = ? AND user_id = ?", connectionId, userId)
      : rowFor<RawRow>(db, "SELECT id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, updated_at FROM connection_profiles WHERE user_id = ? AND is_default = 1 ORDER BY id LIMIT 1", userId);
  const safe: Record<string, unknown> = {};
  if (concrete) {
    if (Array.isArray(concrete) || !isClosedData(concrete) || boundedClosedDataBytes(concrete, limits.inputBytes) > limits.inputBytes) {
      throw new SnapshotLimitError("connection input limit exceeded");
    }
    const allowed = new Set([
      "logicalId", "concreteId", "label", "provider", "model", "effectiveEndpoint",
      "endpointRevision", "credentialRevision", "candidateRevision", "revision", "capabilities",
    ]);
    const hasLogicalIdentity = typeof concrete.logicalId === "string" && concrete.logicalId.trim().length > 0;
    const hasConcreteIdentity = typeof concrete.concreteId === "string" && concrete.concreteId.trim().length > 0;
    if (!hasLogicalIdentity && !hasConcreteIdentity) {
      throw new SnapshotInputError("concrete connection identity is required");
    }
    for (const key of ["candidateRevision", "endpointRevision", "credentialRevision"]) {
      if (!Object.hasOwn(concrete, key)) throw new SnapshotInputError(`missing connection ${key}`);
    }
    const revisionKeys = new Set(["endpointRevision", "credentialRevision", "candidateRevision", "revision"]);
    for (const [key, value] of Object.entries(concrete)) {
      if (!allowed.has(key)) throw new SnapshotInputError(`unsupported connection field: ${key}`);
      if (revisionKeys.has(key) && value !== null) assertRevision(value, `connection ${key}`);
      if (typeof value === "string") safe[key] = assertString(value, `connection ${key}`, limits.inputBytes);
      else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
      else if (isClosedData(value) && boundedClosedDataBytes(value, limits.inputBytes) <= limits.inputBytes) safe[key] = cloneClosedData(value);
      else throw new SnapshotInputError(`invalid connection field: ${key}`);
    }
  }
  if (row) {
    for (const key of ["id", "name", "provider", "api_url", "model", "preset_id", "is_default", "has_api_key", "updated_at"]) {
      const value = row[key];
      if (typeof value === "string") safe[key] = assertString(value, `connection ${key}`, limits.inputBytes);
      else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
    }
    safe.metadata = objectValue(row.metadata, "connection metadata", limits.inputBytes);
  }
  if (Object.keys(safe).length === 0 && !presetId && !connectionId) return null;
  return deepFreeze(safe);
}

function ensureAggregateBytes(snapshot: Omit<GenerationAssemblySnapshotV1, "snapshotId" | "inputRevisionSet" | "revisions">, limits: Limits): void {
  const bytes = utf8Bytes(canonical(snapshot));
  if (bytes > limits.inputBytes) throw new SnapshotLimitError("assembly snapshot input limit exceeded");
}

function revisionSet(groups: SnapshotRevisionV1[][]): InputRevisionSetV1Local {
  const entries = Object.freeze(groups.flat());
  const domain = (name: InputRevisionKindV1) => Object.freeze(entries.filter((entry) => entry.domain === name));
  const result = {
    version: 1 as const,
    revisions: entries,
    entries,
    target: domain("target"),
    chat: domain("chat"),
    messages: domain("message"),
    preset: domain("preset"),
    blocks: domain("preset_block"),
    config: domain("config"),
    slotBinding: domain("slot_binding"),
    connection: domain("connection"),
    endpoint: domain("endpoint"),
    credential: domain("credential"),
    participants: domain("persona").concat(domain("character"), domain("group")),
    worldLore: domain("world_lore"),
    settings: domain("settings"),
    variables: domain("macro_variables"),
    regex: domain("regex"),
    context: domain("context_pack").concat(domain("context_attachment")),
    acl: domain("context_acl"),
    cognition: domain("cognition_policy"),
    readiness: domain("readiness"),
    digest: digest(entries),
  } satisfies Omit<InputRevisionSetV1Local, "digest"> & { digest: string };
  return deepFreeze(result);
}

export class SnapshotInputError extends Error {
  readonly code = "invalid_input" as const;
  constructor(message: string) {
    super(message);
    this.name = "SnapshotInputError";
  }
}

export class SnapshotLimitError extends Error {
  readonly code = "limit_exceeded" as const;
  constructor(message: string) {
    super(message);
    this.name = "SnapshotLimitError";
  }
}

const NUMERIC_REVISION_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

function isSafeNonnegativeIntegerLiteral(value: string): boolean {
  const match = value.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|(?:\.(\d+)))(?:e([+-]?\d+))?$/i);
  if (!match || match[1] === "-") return false;
  const integerPart = match[2] ?? "0";
  const fractionPart = match[3] ?? match[4] ?? "";
  const digits = `${integerPart}${fractionPart}`.replace(/^0+/, "");
  if (digits.length === 0) return true;
  const exponent = match[5] ? BigInt(match[5]) : 0n;
  const scale = exponent - BigInt(fractionPart.length);
  if (scale >= 0n) {
    if (scale > 15n) return false;
    const integer = BigInt(`${digits}${"0".repeat(Number(scale))}`);
    return integer <= BigInt(Number.MAX_SAFE_INTEGER);
  }
  const places = -scale;
  if (places > BigInt(digits.length)) return false;
  const placesNumber = Number(places);
  const split = digits.length - placesNumber;
  if (/[^0]/.test(digits.slice(split))) return false;
  const integer = BigInt(digits.slice(0, split) || "0");
  return integer <= BigInt(Number.MAX_SAFE_INTEGER);
}

function assertRevision(value: unknown, label: string): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SnapshotInputError(`invalid ${label}`);
    }
    return;
  }
  if (typeof value !== "string") throw new SnapshotInputError(`invalid ${label}`);
  if (
    value.length === 0
    || value.length > 256
    || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new SnapshotInputError(`invalid ${label}`);
  }
  if (NUMERIC_REVISION_PATTERN.test(value) && !isSafeNonnegativeIntegerLiteral(value)) {
    throw new SnapshotInputError(`invalid ${label}`);
  }
}

function assertRequest(input: GenerationAssemblySnapshotInputV1): void {
  if (!input || typeof input !== "object") throw new SnapshotInputError("invalid snapshot input");
  assertId(input.userId, "user id");
  assertId(input.chatId, "chat id");
  for (const [value, label] of [
    [input.generationId, "generation id"],
    [input.connectionId, "connection id"],
    [input.presetId, "preset id"],
    [input.personaId, "persona id"],
    [input.targetCharacterId, "target character id"],
    [input.targetMessageId, "target message id"],
    [input.continueMessageId, "continue message id"],
    [input.excludeMessageId, "excluded message id"],
  ] as const) {
    if (value !== undefined && value !== null) assertId(value, label);
  }
  for (const [value, label] of [
    [input.configRevision, "config revision"],
    [input.bindingRevision, "binding revision"],
  ] as const) {
    if (value !== undefined && value !== null) assertRevision(value, label);
  }
  if (input.generationType && !["normal", "continue", "regenerate", "swipe"].includes(input.generationType)) {
    throw new SnapshotInputError("unsupported generation type");
  }
  if (input.targetSwipeId !== undefined && input.targetSwipeId !== null && (!Number.isSafeInteger(input.targetSwipeId) || input.targetSwipeId < 0)) {
    throw new SnapshotInputError("invalid target swipe");
  }
  if (input.contextPackSnapshotSource !== undefined
    && input.contextPackSnapshotSource !== "host_prefetched"
    && input.contextPackSnapshotSource !== "untrusted") {
    throw new SnapshotInputError("invalid context snapshot source");
  }
}

const MAX_CONTEXT_PACK_SELECTIONS = 256;

interface NormalizedContextPackSelectionV1 {
  readonly packId: string;
  readonly revisionId?: string;
  readonly revision?: number;
  readonly digest?: string;
  readonly required: boolean;
}

interface FrozenContextPolicyV1 {
  readonly selections: readonly NormalizedContextPackSelectionV1[];
  readonly accountSelections: readonly NormalizedContextPackSelectionV1[];
  readonly rules: readonly ContextActivationRuleV1[];
  readonly cognitionGraph: FrozenCognitionGraphV1 | null;
  readonly cognitionSource: CognitionSourceSnapshotV1 | null;
  readonly hasPolicy: boolean;
}

function canonicalContextRevisionNumber(packId: string, revisionId: string): number | undefined {
  const prefix = `${packId}@`;
  if (!revisionId.startsWith(prefix)) return undefined;
  const suffix = revisionId.slice(prefix.length);
  const revision = Number(suffix);
  return Number.isSafeInteger(revision) && revision >= 1 && String(revision) === suffix ? revision : undefined;
}

function isCanonicalContextRevisionId(packId: string, revisionId: string): boolean {
  return canonicalContextRevisionNumber(packId, revisionId) !== undefined;
}
function parseContextPackSelection(
  value: unknown,
  path: string,
  defaultRequired: boolean,
  exact: boolean,
): NormalizedContextPackSelectionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SnapshotInputError(`invalid ${path}`);
  }
  const row = value as Record<string, unknown>;
  if (exact) {
    for (const key of Object.keys(row)) {
      if (
        key !== "packId"
        && key !== "revisionId"
        && key !== "revision"
        && key !== "digest"
        && key !== "label"
        && key !== "revisionLabel"
        && key !== "required"
      ) {
        throw new SnapshotInputError(`invalid ${path}`);
      }
    }
  }
  const packId = assertId(row.packId, `${path}.packId`);
  const revisionId = row.revisionId === undefined || row.revisionId === null
    ? undefined
    : assertId(row.revisionId, `${path}.revisionId`);
  const selectedRevision = row.revision === undefined || row.revision === null
    ? undefined
    : row.revision;
  if (selectedRevision !== undefined && (
    typeof selectedRevision !== "number"
    || !Number.isSafeInteger(selectedRevision)
    || selectedRevision < 1
  )) {
    throw new SnapshotInputError(`invalid ${path}.revision`);
  }
  const normalizedRevision = selectedRevision as number | undefined;
  const selectedDigest = row.digest === undefined || row.digest === null
    ? undefined
    : assertString(row.digest, `${path}.digest`, 4096, false);
  const required = row.required === undefined ? defaultRequired : row.required;
  if (typeof required !== "boolean") {
    throw new SnapshotInputError(`invalid ${path}.required`);
  }
  const canonicalRevision = revisionId === undefined
    ? undefined
    : canonicalContextRevisionNumber(packId, revisionId);
  if (exact && (
    revisionId === undefined
    || selectedDigest === undefined
    || canonicalRevision === undefined
    || (normalizedRevision !== undefined && revisionId !== `${packId}@${normalizedRevision}`)
  )) {
    throw new SnapshotInputError(`invalid ${path}: exact canonical revision and digest are required`);
  }
  const effectiveRevision = normalizedRevision ?? canonicalRevision;
  return Object.freeze({
    packId,
    ...(revisionId === undefined ? {} : { revisionId }),
    ...(effectiveRevision === undefined ? {} : { revision: effectiveRevision }),
    ...(selectedDigest === undefined ? {} : { digest: selectedDigest }),
    required,
  });
}

function contextPackSelections(
  input: GenerationAssemblySnapshotInputV1,
  exact: boolean,
): readonly NormalizedContextPackSelectionV1[] {
  const selections: NormalizedContextPackSelectionV1[] = [];
  const suppliedSelections = input.contextPackSelections;
  if (suppliedSelections !== undefined && !Array.isArray(suppliedSelections)) {
    throw new SnapshotInputError("invalid contextPackSelections");
  }
  for (let index = 0; index < (suppliedSelections?.length ?? 0); index++) {
    if (selections.length >= MAX_CONTEXT_PACK_SELECTIONS) {
      throw new SnapshotLimitError("context pack selection limit exceeded");
    }
    selections.push(parseContextPackSelection(
      suppliedSelections?.[index],
      `contextPackSelections[${index}]`,
      true,
      exact,
    ));
  }
  return Object.freeze(selections);
}


function sameContextSelection(
  left: NormalizedContextPackSelectionV1,
  right: NormalizedContextPackSelectionV1,
): boolean {
  return canonical({
    packId: left.packId,
    revisionId: left.revisionId,
    revision: left.revision,
    digest: left.digest,
  }) === canonical({
    packId: right.packId,
    revisionId: right.revisionId,
    revision: right.revision,
    digest: right.digest,
  });
}

function selectionKey(selection: NormalizedContextPackSelectionV1): string {
  return selection.packId;
}

function deduplicateContextSelections(
  values: readonly NormalizedContextPackSelectionV1[],
  label: string,
): readonly NormalizedContextPackSelectionV1[] {
  const byPack = new Map<string, NormalizedContextPackSelectionV1>();
  for (const value of values) {
    const previous = byPack.get(selectionKey(value));
    if (previous && !sameContextSelection(previous, value)) {
      throw new SnapshotInputError(`${label} contains conflicting references for ${value.packId}`);
    }
    if (!previous) {
      byPack.set(selectionKey(value), value);
    } else if (previous.required !== value.required) {
      byPack.set(selectionKey(value), Object.freeze({ ...previous, required: previous.required || value.required }));
    }
  }
  return Object.freeze([...byPack.values()].sort((left, right) => left.packId.localeCompare(right.packId)));
}

function freezeExplicitCognition(
  input: GenerationAssemblySnapshotInputV1,
): { readonly graph: FrozenCognitionGraphV1; readonly source: CognitionSourceSnapshotV1 } | null {
  const graphValue = input.cognitionGraph;
  const sourceValue = input.cognitionSource;
  if (graphValue === undefined && sourceValue === undefined) return null;
  if (graphValue === undefined || sourceValue === undefined) {
    throw new SnapshotInputError("cognition graph and source must be supplied together");
  }
  try {
    const source = parseCognitionSourceSnapshot(sourceValue);
    if (!graphValue || typeof graphValue !== "object" || Array.isArray(graphValue)) {
      throw new SnapshotInputError("invalid cognition graph");
    }
    const graph = graphValue as Record<string, unknown>;
    const baseGraph = {
      version: graph.version,
      policies: graph.policies,
      templates: graph.templates,
      contextRules: graph.contextRules,
    };
    const frozen = freezeCognitionGraph(baseGraph, source);
    if (canonical(frozen) !== canonical(graphValue)) {
      throw new SnapshotInputError("cognition graph source revision mismatch");
    }
    return {
      graph: deepFreeze(frozen),
      source: deepFreeze(source),
    };
  } catch (error) {
    if (error instanceof SnapshotInputError) throw error;
    throw new SnapshotInputError("invalid cognition graph/source");
  }
}

function resolveContextPolicy(
  input: GenerationAssemblySnapshotInputV1,
  normalizedAgentConfig: unknown,
): FrozenContextPolicyV1 {
  const cognition = freezeExplicitCognition(input);
  const rawPolicy = normalizedAgentConfig && typeof normalizedAgentConfig === "object" && !Array.isArray(normalizedAgentConfig)
    ? (normalizedAgentConfig as Record<string, unknown>).contextPolicy
    : undefined;
  const hasPolicy = rawPolicy !== undefined && rawPolicy !== null;
  if (!hasPolicy) {
    const selections = contextPackSelections(input, cognition?.graph.contextRules.length ? true : false);
    return {
      selections,
      accountSelections: selections,
      rules: Object.freeze([]),
      cognitionGraph: cognition?.graph ?? null,
      cognitionSource: cognition?.source ?? null,
      hasPolicy: false,
    };
  }
  const policy = rawPolicy as AgentContextPolicyV1;
  const requiresGraph = policy.ruleIds.length > 0;
  if (requiresGraph && !cognition) {
    throw new ContextPackSnapshotAccessError("cognition graph/source is required by context policy");
  }
  const selections = contextPackSelections(input, true);
  const rulesById = new Map((cognition?.graph.contextRules ?? []).map((rule) => [rule.id, rule] as const));
  const rules: ContextActivationRuleV1[] = [];
  for (const ruleId of policy.ruleIds) {
    const rule = rulesById.get(ruleId);
    if (!rule) {
      throw new ContextPackSnapshotAccessError(`required context activation rule is unavailable: ${ruleId}`);
    }
    if (!isCanonicalContextRevisionId(rule.packId, rule.revisionId)) {
      throw new SnapshotInputError(`contextRules.${rule.id}.revisionId is not canonical`);
    }
    rules.push(rule);
  }
  rules.sort((left, right) => left.id.localeCompare(right.id));
  const rulePackIds = new Set(rules.map((rule) => rule.packId));
  const authorizedPackIds = new Set([...policy.packIds, ...rulePackIds]);
  for (const selection of selections) {
    if (!authorizedPackIds.has(selection.packId)) {
      throw new SnapshotInputError(`contextPackSelections is not authorized by contextPolicy: ${selection.packId}`);
    }
  }
  const selectionByPack = new Map<string, NormalizedContextPackSelectionV1>();
  for (const selection of selections) {
    const previous = selectionByPack.get(selection.packId);
    if (previous && !sameContextSelection(previous, selection)) {
      throw new SnapshotInputError(`contextPackSelections contains conflicting references for ${selection.packId}`);
    }
    if (!previous) selectionByPack.set(selection.packId, selection);
  }
  const directSelections: NormalizedContextPackSelectionV1[] = [];
  for (const packId of policy.packIds) {
    const selection = selectionByPack.get(packId);
    if (!selection) {
      throw new ContextPackSnapshotAccessError(`required context pack selection is unavailable: ${packId}`);
    }
    directSelections.push(selection);
  }
  const ruleSelections = rules.map((rule) => {
    const selection = selectionByPack.get(rule.packId);
    if (!selection || selection.revisionId !== rule.revisionId || selection.digest === undefined) {
      throw new ContextPackSnapshotAccessError(`context rule revision identity is unavailable: ${rule.id}`);
    }
    // Rule requiredness remains in the frozen graph and is activated only by
    // cognition transitions; it is not an initial direct-pack requirement.
    return Object.freeze({ ...selection });
  });
  const selected = deduplicateContextSelections([...directSelections, ...ruleSelections], "context policy");
  return {
    selections: selected,
    accountSelections: Object.freeze(directSelections),
    rules: Object.freeze(rules),
    cognitionGraph: cognition?.graph ?? null,
    cognitionSource: cognition?.source ?? null,
    hasPolicy: true,
  };
}

function candidateMatchesSelection(
  candidate: ContextPackCandidateV1,
  selection: NormalizedContextPackSelectionV1,
): boolean {
  return candidate.packId === selection.packId
    && (selection.revisionId === undefined || candidate.revisionId === selection.revisionId)
    && (selection.revision === undefined || candidate.revision === selection.revision)
    && (selection.digest === undefined || candidate.digest === selection.digest);
}
function contextCandidateIdentity(candidate: ContextPackCandidateV1): Readonly<Record<string, unknown>> {
  return {
    ownerId: candidate.ownerId,
    packId: candidate.packId,
    revisionId: candidate.revisionId,
    revision: candidate.revision,
    digest: candidate.digest,
    source: candidate.source,
    targetId: candidate.targetId,
    attachmentId: candidate.attachmentId,
    attachmentRevision: candidate.attachmentRevision,
    aclRevision: candidate.aclRevision,
    required: candidate.required,
    order: candidate.order,
  };
}

function assertHostPrefetchedSnapshotMatches(
  supplied: ContextPackCandidateSnapshotV1,
  canonicalSnapshot: ContextPackCandidateSnapshotV1,
): void {
  let normalizedSupplied: ContextPackCandidateSnapshotV1;
  try {
    normalizedSupplied = freezeContextPackCandidateSnapshot({
      ownerId: supplied.ownerId,
      contextAclRevision: supplied.contextAclRevision,
      candidates: supplied.candidates,
    });
  } catch {
    throw new ContextPackSnapshotAccessError("context candidate identity mismatch");
  }
  if (
    supplied.version !== 1
    || supplied.ownerId !== canonicalSnapshot.ownerId
    || supplied.contextAclRevision !== canonicalSnapshot.contextAclRevision
    || !Array.isArray(supplied.candidateInputRevisions)
    || canonical(supplied.candidateInputRevisions) !== canonical(canonicalSnapshot.candidateInputRevisions)
    || canonical(normalizedSupplied.candidates.map(contextCandidateIdentity))
      !== canonical(canonicalSnapshot.candidates.map(contextCandidateIdentity))
  ) {
    throw new ContextPackSnapshotAccessError("context candidate identity mismatch");
  }
}

function assertContextPackSelectionAvailability(
  policy: FrozenContextPolicyV1,
  frozen: ContextPackCandidateSnapshotV1,
): void {
  for (const selection of policy.selections) {
    const matches = frozen.candidates.some((candidate) => candidateMatchesSelection(candidate, selection));
    if (selection.required && !matches) {
      throw new ContextPackSnapshotAccessError(
        `required context pack selection is unavailable: ${selection.packId}`,
      );
    }
  }
}

function applyContextPackPolicy(
  frozen: ContextPackCandidateSnapshotV1,
  policy: FrozenContextPolicyV1,
): ContextPackCandidateSnapshotV1 {
  if (!policy.hasPolicy) return frozen;
  const policyByPack = new Map<string, readonly NormalizedContextPackSelectionV1[]>();
  for (const selection of policy.selections) {
    const current = policyByPack.get(selection.packId) ?? [];
    policyByPack.set(selection.packId, [...current, selection]);
  }
  const candidates = frozen.candidates
    .filter((candidate) => {
      const selections = policyByPack.get(candidate.packId);
      // All target-attached candidates remain in the frozen initial set.
      // Account candidates are admitted only when directly/rule selected.
      return candidate.source !== "account"
        || !selections
        || selections.some((selection) => candidateMatchesSelection(candidate, selection));
    })
    .map((candidate) => Object.freeze({ ...candidate }));
  return freezeContextPackCandidateSnapshot({
    ownerId: frozen.ownerId,
    contextAclRevision: frozen.contextAclRevision,
    candidates,
  });
}

function buildContextPackSnapshot(
  input: GenerationAssemblySnapshotInputV1,
  presetId: string | null,
  chatId: string,
  worldInfo: SnapshotWorldInfoV1,
  db: Database,
  normalizedAgentConfig: unknown,
): SnapshotContextPacksV1 {
  const scopes: ContextPackSnapshotScopeV1[] = [
    { scope: "chat", targetId: chatId },
    ...(presetId ? [{ scope: "preset", targetId: presetId } satisfies ContextPackSnapshotScopeV1] : []),
    ...worldInfo.books.map((book) => ({ scope: "world_book", targetId: book.id }) satisfies ContextPackSnapshotScopeV1),
  ];
  const policy = resolveContextPolicy(input, normalizedAgentConfig);
  const allowedScopeTargets = new Set(scopes.map((scope) => `${scope.scope}\u0000${scope.targetId}`));
  const supplied = input.contextPackSnapshotSource === "host_prefetched"
    ? input.contextPackSnapshot
    : undefined;
  if ((policy.hasPolicy || policy.cognitionGraph !== null) && input.contextPackSnapshotSource !== "host_prefetched") {
    throw new ContextPackSnapshotAccessError("authenticated context candidate snapshot is required");
  }
  const hostSelections: ContextPackAccountCandidateSelectionV1[] = policy.selections
    .filter((selection) => (
      typeof selection.revisionId === "string"
      && typeof selection.digest === "string"
      && Number.isSafeInteger(selection.revision)
    ))
    .map((selection, order) => ({
      packId: selection.packId,
      revisionId: selection.revisionId!,
      revision: selection.revision!,
      digest: selection.digest!,
      ...(selection.required === undefined ? {} : { required: selection.required }),
      order,
    }));

  const canonicalHostSnapshot = buildHostPrefetchedAgentContextSnapshot({
    ownerId: input.userId,
    targetScopes: scopes,
    selections: hostSelections,
    db,
  });
  if (supplied) {
    if (supplied.ownerId !== input.userId) {
      throw new SnapshotInputError("context candidate owner mismatch");
    }
    for (const candidate of supplied.candidates) {
      if (candidate.source === "account") {
        if (candidate.targetId !== null || candidate.attachmentId !== null || candidate.attachmentRevision !== null) {
          throw new SnapshotInputError("account context candidate cannot have an attachment");
        }
      } else if (!allowedScopeTargets.has(`${candidate.source}\u0000${candidate.targetId}`)) {
        throw new SnapshotInputError("context candidate scope mismatch");
      }
    }
    assertHostPrefetchedSnapshotMatches(supplied, canonicalHostSnapshot);
  }
  const attached = canonicalHostSnapshot;
  const frozen = applyContextPackPolicy(attached, policy);
  assertContextPackSelectionAvailability(policy, frozen);
  const candidates = Object.freeze(frozen.candidates.map((candidate) => Object.freeze({ ...candidate })));
  const candidateInputRevisions = Object.freeze(
    frozen.candidateInputRevisions.map((revision) => Object.freeze({ ...revision })),
  );
  const attachments = Object.freeze(candidates.map((candidate) => Object.freeze({
    ownerId: candidate.ownerId,
    attachmentId: candidate.attachmentId,
    packId: candidate.packId,
    revisionId: candidate.revisionId,
    source: candidate.source,
    targetId: candidate.targetId,
    required: candidate.required,
    revision: candidate.revision,
  })));
  const contextPackSelectionsByKey = new Map<string, SnapshotContextPackPolicySelectionV1>();
  for (const selection of policy.accountSelections) {
    if (selection.revisionId === undefined || selection.digest === undefined) continue;
    const revision = selection.revision ?? canonicalContextRevisionNumber(selection.packId, selection.revisionId);
    if (revision === undefined) continue;
    const key = `${selection.packId}\u0000${selection.revisionId}`;
    contextPackSelectionsByKey.set(key, Object.freeze({
      packId: selection.packId,
      revisionId: selection.revisionId,
      revision,
      digest: selection.digest,
      required: selection.required,
    }));
  }
  const contextPackSelections = Object.freeze([...contextPackSelectionsByKey.values()]
    .sort((left, right) => left.packId.localeCompare(right.packId) || left.revision - right.revision));
  const acl = Object.freeze([...new Map(candidates.map((candidate) => [
    `${candidate.ownerId}:${candidate.packId}`,
    Object.freeze({
      ownerId: candidate.ownerId,
      packId: candidate.packId,
      aclRevision: candidate.aclRevision,
      contextAclRevision: frozen.contextAclRevision,
    }),
  ])).values()]);
  return deepFreeze({
    schema: "present" as const,
    contextAclRevision: frozen.contextAclRevision,
    candidates,
    contextPackSelections,
    candidateInputRevisions,
    attachments,
    acl,
    cognitionGraph: policy.cognitionGraph,
    cognitionSource: policy.cognitionSource,
    contextRules: policy.rules,
    revision: digest({
      ownerId: frozen.ownerId,
      contextAclRevision: frozen.contextAclRevision,
      candidates,
      contextPackSelections,
      candidateInputRevisions,
      cognitionSource: policy.cognitionSource,
      contextRules: policy.rules,
    }),
  });
}

/**
 * Read all inputs under one SQLite read transaction. No extension/Spindle
 * callbacks or live service instances cross this boundary, which keeps the
 * revision set meaningful.
 */
export function buildGenerationAssemblySnapshot(
  input: GenerationAssemblySnapshotInputV1,
): GenerationAssemblySnapshotV1 {
  assertRequest(input);
  const limits = lowerLimits(input.limits);
  const db = input.db ?? getDb();
  const readSnapshot = () => {
  const chatRow = rowFor<RawRow>(db, "SELECT id, character_id, name, metadata, created_at, updated_at, generation_revision FROM chats WHERE id = ? AND user_id = ? LIMIT 1", input.chatId, input.userId);
  if (!chatRow) throw new SnapshotInputError("chat not found");
  const chat = normalizeChat(chatRow, limits);
    const maxMessages = limits.promptBlocks * 16;
    const messagePageSize = 1;
    const messages: SnapshotMessageV1[] = [];
    let messageOffset = 0;
    let messageBytes = 0;
    while (messageOffset <= maxMessages) {
      const page = rowsFor<RawRow>(
        db,
        "SELECT id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, parent_message_id, branch_id, created_at, generation_revision FROM messages WHERE chat_id = ? ORDER BY index_in_chat ASC, id ASC LIMIT ? OFFSET ?",
        chat.id,
        messagePageSize,
        messageOffset,
      );
      if (page.length === 0) break;
      if (messages.length + page.length > maxMessages) throw new SnapshotLimitError("message count limit exceeded");
      for (const row of page) {
        const message = normalizeMessage(row, limits);
        messageBytes += utf8Bytes(canonical(message));
        if (messageBytes > limits.inputBytes) throw new SnapshotLimitError("message input limit exceeded");
        messages.push(message);
      }
      messageOffset += page.length;
      if (page.length < messagePageSize) break;
    }
    const metadata = chat.metadata;
    const selectedPresetId = input.presetId ?? (typeof input.connectionId === "string" ? null : null);
    const connection = getConnection(db, input.userId, input.connectionId, selectedPresetId, input.concreteConnection, limits);
    const effectivePresetId = selectedPresetId ?? (typeof connection?.preset_id === "string" ? connection.preset_id : null);
    const presetRow = effectivePresetId
      ? rowFor<RawRow>(db, "SELECT id, name, provider, engine, parameters, prompt_order, metadata, prompts, updated_at, cache_revision FROM presets WHERE id = ? AND user_id = ? LIMIT 1", effectivePresetId, input.userId)
      : null;
    if (effectivePresetId && !presetRow) throw new SnapshotInputError("preset not found");
    const preset = presetRow ? normalizePreset(presetRow, limits) : null;
    const blocks = preset?.blocks ?? [];
    const characterId = input.targetCharacterId ?? chat.character_id;
    const characterRow = characterId
      ? rowFor<RawRow>(db, "SELECT id, name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, extensions, updated_at FROM characters WHERE id = ? AND user_id = ? LIMIT 1", characterId, input.userId)
      : null;
    const character = characterRow ? normalizeParticipant(characterRow, limits) : normalizeParticipant(null, limits);
    const rawGroupIds = metadata.group === true || metadata.group === 1
      ? Array.isArray(metadata.character_ids) ? metadata.character_ids.filter((id): id is string => typeof id === "string") : []
      : [];
    const groupIds = [...new Set(rawGroupIds)];
    if (groupIds.length > limits.promptBlocks) throw new SnapshotLimitError("group participant limit exceeded");
    const group: Readonly<Record<string, unknown>>[] = [];
    if (groupIds.length > 0) {
      for (const id of groupIds) {
        const row = rowFor<RawRow>(
          db,
          "SELECT id, name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, extensions, updated_at FROM characters WHERE user_id = ? AND id = ? LIMIT 1",
          input.userId,
          id,
        );
        if (row) group.push(normalizeParticipant(row, limits));
      }
    }
    const personaId = input.personaId ?? (typeof metadata.persona_id === "string" ? metadata.persona_id : null);
    const personaRow = personaId
      ? rowFor<RawRow>(db, "SELECT id, name, title, description, subjective_pronoun, objective_pronoun, possessive_pronoun, reflexive_pronoun, possessive_pronoun_standalone, attached_world_book_id, is_narrator, updated_at FROM personas WHERE id = ? AND user_id = ? LIMIT 1", personaId, input.userId)
      : rowFor<RawRow>(db, "SELECT id, name, title, description, subjective_pronoun, objective_pronoun, possessive_pronoun, reflexive_pronoun, possessive_pronoun_standalone, attached_world_book_id, is_narrator, updated_at FROM personas WHERE user_id = ? AND is_default = 1 ORDER BY id LIMIT 1", input.userId);
    const persona = normalizePersona(personaRow, limits);
    const settingsValues: Record<string, unknown> = {};
    let settingsOffset = 0;
    let settingsBytes = 0;
    while (settingsOffset <= limits.promptBlocks * 16) {
      const page = rowsFor<RawRow>(
        db,
        "SELECT key, value, updated_at FROM settings WHERE user_id = ? ORDER BY key ASC LIMIT 1 OFFSET ?",
        input.userId,
        settingsOffset,
      );
      if (page.length === 0) break;
      if (settingsOffset + page.length > limits.promptBlocks * 16) {
        throw new SnapshotLimitError("settings row limit exceeded");
      }
      const parsed = parseSettings(page, limits);
      settingsBytes += utf8Bytes(canonical(parsed));
      if (settingsBytes > limits.inputBytes) throw new SnapshotLimitError("settings input limit exceeded");
      Object.assign(settingsValues, parsed);
      settingsOffset += page.length;
    }
    const settings = deepFreeze(settingsValues);
    const chatVariables = metadata.chat_variables && typeof metadata.chat_variables === "object" && !Array.isArray(metadata.chat_variables)
      ? deepFreeze({ ...(metadata.chat_variables as Record<string, unknown>) })
      : deepFreeze({});
    const presetVariables = preset?.metadata.promptVariables && typeof preset.metadata.promptVariables === "object" && !Array.isArray(preset.metadata.promptVariables)
      ? deepFreeze({ ...(preset.metadata.promptVariables as PromptVariableValues) })
      : deepFreeze({});
    const variables = deepFreeze({
      preset: presetVariables,
      chat: chatVariables,
      settings,
      revision: digest({ preset: presetVariables, chat: chatVariables, settings }),
    } satisfies SnapshotVariableStateV1);
    const regexScripts = activeRegexRows(db, input.userId, chat, characterId, effectivePresetId, settings, limits);
    const worldInfo = normalizeWorld(db, input.userId, chat, character, persona, group, settings, limits);
    const targetMessageId = input.targetMessageId ?? input.continueMessageId ?? null;
    const target = deepFreeze({
      generationType: input.generationType ?? "normal",
      messageId: targetMessageId,
      swipeId: input.targetSwipeId ?? null,
      continueMessageId: input.continueMessageId ?? null,
      excludedMessageId: input.excludeMessageId ?? null,
      userInput: assertString(input.userInput ?? "", "user input", limits.inputBytes),
    } satisfies SnapshotTargetV1);
    const participantIds = [
      persona?.id,
      character.id,
      ...group.map((member) => typeof member.id === "string" ? member.id : null),
    ].filter((id): id is string => typeof id === "string");
    const tools = normalizeTools(input.toolIds, limits);
    const availability = deepFreeze({
      participantIds: Object.freeze([...participantIds]),
      toolIds: tools,
      extensionsExcluded: true as const,
      ambientSpindleExcluded: true as const,
      revision: digest({ participantIds, tools }),
    } satisfies SnapshotAvailabilityV1);
    const normalizedAgentConfig = normalizeAgentConfig(input.agentConfig, limits.inputBytes);
    const contextInput = normalizedAgentConfig === input.agentConfig
      ? input
      : { ...input, agentConfig: normalizedAgentConfig };
    const contextPacks = buildContextPackSnapshot(contextInput, effectivePresetId, chat.id, worldInfo, db, normalizedAgentConfig);
    const contextPackSnapshot = deepFreeze({
      version: 1 as const,
      ownerId: input.userId,
      contextAclRevision: contextPacks.contextAclRevision,
      candidates: contextPacks.candidates,
      candidateInputRevisions: contextPacks.candidateInputRevisions,
    } satisfies ContextPackCandidateSnapshotV1);
    const targetRevision = revision("target", `${chat.id}:${target.messageId ?? "none"}:${target.swipeId ?? "none"}`, {
      generationType: target.generationType,
      messageId: target.messageId,
      swipeId: target.swipeId,
      continueMessageId: target.continueMessageId,
      excludedMessageId: target.excludedMessageId,
    });
    const chatRevision = revision("chat", chat.id, chat, chat.revision);
    const messageRevisions = messages.map((message) => revision("message", message.id, message, message.revision));
    const presetRevision = preset ? [revision("preset", preset.id, preset, preset.revision)] : [];
    const blockRevisions = blocks.map((block) => revision("preset_block", block.id, block, block.revision));
    const concreteConnectionId = String(connection?.concreteId ?? connection?.logicalId ?? connection?.id ?? "default");
    const revisionPresetId = effectivePresetId ?? "none";
    const configRevision = [revision("config", revisionPresetId, normalizedAgentConfig ?? {}, input.configRevision)];
    const slotBindingValue = {
      logicalId: connection?.logicalId ?? connection?.id ?? null,
      concreteId: connection?.concreteId ?? connection?.id ?? null,
      bindingRevision: input.bindingRevision ?? null,
    };
    const slotBindingRevision = [revision("slot_binding", revisionPresetId, slotBindingValue, input.bindingRevision)];
    const candidateSourceRevision = Object.hasOwn(connection ?? {}, "candidateRevision")
      ? connection?.candidateRevision
      : connection?.revision ?? connection?.updated_at;
    const connectionRevision = connection
      ? [revision("connection", concreteConnectionId, connection, candidateSourceRevision)]
      : [];
    const endpointRevision = connection
      ? [revision("endpoint", concreteConnectionId, {
        provider: connection.provider,
        model: connection.model,
        endpoint: connection.effectiveEndpoint ?? connection.api_url ?? null,
      }, connection.endpointRevision)]
      : [];
    const credentialRevision = connection
      ? [revision("credential", concreteConnectionId, {
        has_api_key: connection.has_api_key ?? null,
        updated_at: connection.updated_at ?? null,
      }, connection.credentialRevision)]
      : [];
    const participantRevisions = [
      persona ? revision("persona", String(persona.id), persona, persona.revision) : null,
      revision("character", String(character.id), character, character.revision),
      ...group.map((member) => revision("group", String(member.id), member, member.revision)),
    ].filter((item): item is SnapshotRevisionV1 => !!item);
    const worldRevisions = [
      ...worldInfo.books.map((book) => revision("world_lore", book.id, book, book.revision)),
      ...worldInfo.entries.map((entry) => revision("world_lore", entry.id, entry, entry.revision)),
      revision("world_lore", chat.id, worldInfo.state, digest(worldInfo.state)),
    ];
    const settingsRevision = [revision("settings", input.userId, settings, digest(settings))];
    const variableRevision = [revision("macro_variables", `${chat.id}:${preset?.id ?? "none"}`, variables, variables.revision)];
    const regexRevisions = regexScripts.map((script) => revision("regex", script.id, script, script.revision));
    const contextRevision = [
      revision("context_pack", `${input.userId}:context-packs`, contextPacks, contextPacks.revision),
      ...contextPacks.candidateInputRevisions.map((candidate) =>
        revision("context_pack", `${candidate.packId}:${candidate.revisionId}:${candidate.attachmentId ?? "account"}`, candidate, candidate.revision)),
    ];
    const contextAttachmentRevision = contextPacks.candidateInputRevisions
      .filter((candidate) => candidate.attachmentId !== null && candidate.attachmentRevision !== null)
      .map((candidate) =>
        revision("context_attachment", candidate.attachmentId as string, candidate, candidate.attachmentRevision as string));
    const aclRevision = [
      revision("context_acl", `${input.userId}:context-acl`, contextPacks.acl, contextPacks.revision),
      ...contextPacks.candidateInputRevisions.map((candidate) =>
        revision("context_acl", `${candidate.packId}:${candidate.attachmentId ?? "account"}`, candidate, candidate.aclRevision)),
    ];
    const cognitionRevisionValue = { agentConfig: normalizedAgentConfig ?? {}, contextRules: contextPacks.contextRules };
    const cognitionRevision = [revision("cognition_policy", preset?.id ?? "none", cognitionRevisionValue, digest(cognitionRevisionValue))];
    const readinessRevision = [revision("readiness", `${input.userId}:${chat.id}`, availability, availability.revision)];
    const runtimeEpochRevision = [revision("runtime_epoch", `${input.userId}:${chat.id}`, { generationId: input.generationId ?? "", snapshotVersion: 1 }, digest({ generationId: input.generationId ?? "", snapshotVersion: 1 }))];
    const revisions = revisionSet([
      [targetRevision, chatRevision],
      messageRevisions,
      presetRevision,
      blockRevisions,
      configRevision,
      slotBindingRevision,
      connectionRevision,
      endpointRevision,
      credentialRevision,
      participantRevisions,
      worldRevisions,
      settingsRevision,
      variableRevision,
      regexRevisions,
      contextRevision,
      contextAttachmentRevision,
      aclRevision,
      cognitionRevision,
      readinessRevision,
      runtimeEpochRevision,
    ]);
    const base = {
      version: 1 as const,
      userId: input.userId,
      generationId: input.generationId ?? `${chat.id}:${target.messageId ?? "new"}:${target.swipeId ?? "active"}`,
      chatId: chat.id,
      target,
      chat,
      messages,
      preset,
      blocks,
      participants: deepFreeze({
        persona,
        character,
        group: Object.freeze(group),
        availabilityRevision: availability.revision,
      } satisfies SnapshotParticipantV1),
      variables,
      regexScripts: Object.freeze(regexScripts),
      worldInfo,
      contextPacks,
      contextPackSnapshot,
      availability,
      connection,
      agentConfig: normalizedAgentConfig,
      limits: publicLimits(limits),
      extensionData: null,
      ambientSpindleData: null,
    } satisfies Omit<GenerationAssemblySnapshotV1, "snapshotId" | "inputRevisionSet" | "revisions">;
    ensureAggregateBytes(base, limits);
    const snapshotId = digest({ base, revisions });
    return deepFreeze({ ...base, snapshotId, inputRevisionSet: revisions, revisions });
  };
  return input.useTransaction === false ? readSnapshot() : db.transaction(readSnapshot)();
}

/** Alias retained for callers that use an imperative name. */
export const createGenerationAssemblySnapshot = buildGenerationAssemblySnapshot;
export const buildAssemblySnapshot = buildGenerationAssemblySnapshot;

/** Small helper used by tests and admission code to prove the input is closed. */
export function isGenerationAssemblySnapshotV1(value: unknown): value is GenerationAssemblySnapshotV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GenerationAssemblySnapshotV1>;
  return candidate.version === 1
    && typeof candidate.snapshotId === "string"
    && typeof candidate.userId === "string"
    && typeof candidate.chatId === "string"
    && candidate.contextPackSnapshot?.version === 1
    && candidate.contextPackSnapshot.ownerId === candidate.userId
    && Array.isArray(candidate.contextPackSnapshot.candidates)
    && Array.isArray(candidate.contextPackSnapshot.candidateInputRevisions)
    && Array.isArray(candidate.contextPacks?.contextRules)
    && candidate.availability?.extensionsExcluded === true
    && candidate.availability?.ambientSpindleExcluded === true
    && candidate.extensionData === null
    && candidate.ambientSpindleData === null;
}
