import { canonicalizeAgenticReadinessVectorV1, hashAgenticReadinessVectorV1 } from "./agent-cognition-integrity.service";
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/connection";
import * as chatsSvc from "./chats.service";
import * as connectionsSvc from "./connections.service";
import * as personasSvc from "./personas.service";
import * as presetProfilesSvc from "./preset-profiles.service";
import * as presetsSvc from "./presets.service";
import * as settingsSvc from "./settings.service";
import * as councilProfilesSvc from "./council/council-profiles.service";
import type {
  AgenticReadinessVectorV1,
  AgentRuntimeCapabilityRequirement,
  AgentRuntimeMode,
  AgentRuntimeRepairCode,
  ChatAgentModeOverrideV1,
  ChatAgentModeWriteResponseV1,
  EffectiveRuntimeDecisionV1,
  EffectiveRuntimePublicResponseV1,
  EffectiveRuntimeRequestV1,
  FrozenConcreteConnectionV1,
  GenerationTargetV1,
  InputRevisionSetV1,
  RuntimeDecisionBindingV1,
  RuntimeDecisionInternalV1,
  RuntimeDecisionTokenConsumptionV1,
  RuntimeRevision,
  SafeConnectionProjectionV1,
  SafePresetProjectionV1,
} from "../types/agent-runtime-decision";
import {
  isAgenticGenerationType,
  AGENT_RUNTIME_CAPABILITY_REQUIREMENTS,
  AGENT_RUNTIME_DECISION_TOKEN_TTL_MS,
  AGENT_RUNTIME_DECISION_MAX_LIVE_PER_USER,
  AGENT_RUNTIME_DECISION_MAX_LIVE_PROCESS,
  AGENT_RUNTIME_DECISION_VERSION,
  isAgentRuntimeMode,
} from "../types/agent-runtime-decision";

import { validateAgentConfigForExecution } from "./agent-runtime-limits";
import { parseAgentConfigV2 } from "../types/agents";
const INPUT_REVISION_KEYS: readonly (keyof InputRevisionSetV1)[] = [
  "target",
  "chat",
  "message",
  "preset",
  "block",
  "config",
  "binding",
  "connection",
  "endpoint",
  "credential",
  "persona",
  "character",
  "group",
  "world",
  "lore",
  "settings",
  "macro",
  "regex",
  "context",
  "acl",
  "cognition",
  "readiness",
];

const REQUIRED_AGENTIC_CAPABILITIES: readonly AgentRuntimeCapabilityRequirement[] = [
  "generation",
  "streaming",
  "tool_calling",
  "native_tool_continuation",
  "tools_disabled_finalization",
];

const AGENT_RUNTIME_RESPONSE_ESCAPE = "available" as const;
const DEFAULT_REVISION: RuntimeRevision = 0;
const DEFAULT_READINESS_EPOCH: RuntimeRevision = 0;
const SAFE_STRING_MAX = 512;

export type RuntimeDecisionErrorCode =
  | "not_found"
  | "invalid_request"
  | "decision_refresh_required"
  | "decision_capacity_exceeded";

export class RuntimeDecisionError extends Error {
  readonly code: RuntimeDecisionErrorCode;
  readonly status: number;

  constructor(code: RuntimeDecisionErrorCode, message: string, status = 400) {
    super(message);
    this.name = "RuntimeDecisionError";
    this.code = code;
    this.status = status;
  }
}

export class DecisionTokenCapacityError extends Error {
  constructor() {
    super("Runtime decision capacity is temporarily exhausted.");
    this.name = "DecisionTokenCapacityError";
  }
}

interface StoredDecisionToken {
  tokenHash: string;
  userId: string;
  decision: RuntimeDecisionInternalV1;
  request: EffectiveRuntimeRequestV1;
}

export interface RuntimeDecisionTokenStoreLimits {
  maxPerUser?: number;
  maxProcess?: number;
  ttlMs?: number;
}

/**
 * Process-local opaque token storage. Tokens are one-use: consume removes the
 * entry before any binding check, including checks that fail for another user.
 */
export class RuntimeDecisionTokenStore {
  private readonly byHash = new Map<string, StoredDecisionToken>();
  private readonly byUser = new Map<string, Set<string>>();
  private readonly maxPerUser: number;
  private readonly maxProcess: number;
  readonly ttlMs: number;

  constructor(
    private readonly now: () => number = Date.now,
    limits: RuntimeDecisionTokenStoreLimits = {},
  ) {
    this.maxPerUser = limits.maxPerUser ?? AGENT_RUNTIME_DECISION_MAX_LIVE_PER_USER;
    this.maxProcess = limits.maxProcess ?? AGENT_RUNTIME_DECISION_MAX_LIVE_PROCESS;
    this.ttlMs = limits.ttlMs ?? AGENT_RUNTIME_DECISION_TOKEN_TTL_MS;
  }

  issue(userId: string, decision: RuntimeDecisionInternalV1, request: EffectiveRuntimeRequestV1): { token: string; expiresAt: number } {
    const now = this.now();
    this.purgeExpired(now);
    const userTokens = this.byUser.get(userId);
    if ((userTokens?.size ?? 0) >= this.maxPerUser || this.byHash.size >= this.maxProcess) {
      throw new DecisionTokenCapacityError();
    }

    const token = `lvrd_${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashToken(token);
    const expiresAt = now + this.ttlMs;
    const stored: StoredDecisionToken = {
      tokenHash,
      userId,
      decision: { ...decision, issuedAt: now, expiresAt },
      request: structuredClone(request),
    };
    this.byHash.set(tokenHash, stored);
    const nextUserTokens = userTokens ?? new Set<string>();
    nextUserTokens.add(tokenHash);
    this.byUser.set(userId, nextUserTokens);
    return { token, expiresAt };
  }

  consume(userId: string, token: string): StoredDecisionToken | null {
    const now = this.now();
    this.purgeExpired(now);
    if (!isOpaqueDecisionToken(token)) return null;
    const tokenHash = hashToken(token);
    const stored = this.byHash.get(tokenHash);
    if (!stored) return null;

    // Delete before comparing ownership or any other binding. A replay and a
    // cross-user guess therefore have exactly the same one-use semantics.
    this.byHash.delete(tokenHash);
    const userTokens = this.byUser.get(stored.userId);
    userTokens?.delete(tokenHash);
    if (userTokens && userTokens.size === 0) this.byUser.delete(stored.userId);
    if (stored.userId !== userId || stored.decision.expiresAt <= now) return null;
    return stored;
  }

  purgeExpired(now = this.now()): number {
    let removed = 0;
    for (const [tokenHash, stored] of this.byHash) {
      if (stored.decision.expiresAt > now) continue;
      this.byHash.delete(tokenHash);
      const userTokens = this.byUser.get(stored.userId);
      userTokens?.delete(tokenHash);
      if (userTokens && userTokens.size === 0) this.byUser.delete(stored.userId);
      removed++;
    }
    return removed;
  }

  clear(): void {
    this.byHash.clear();
    this.byUser.clear();
  }

  get liveCount(): number {
    return this.byHash.size;
  }

  getLiveCountForUser(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }
}

interface AgentConfigSlotView {
  id: string;
  label: string;
  requiredCapabilities: AgentRuntimeCapabilityRequirement[];
}

interface AgentConfigProfileView {
  id: string;
  connectionRef: { kind: "inherit_main" } | { kind: "slot"; slotId: string };
}

interface AgentConfigView {
  version: 2;
  agentsEnabled: boolean;
  allowedModes: AgentRuntimeMode[];
  defaultMode: AgentRuntimeMode;
  maxInvocations: number;
  maxToolCalls: number;
  profiles: AgentConfigProfileView[];
  connectionSlots: AgentConfigSlotView[];
  revision: RuntimeRevision | null;
  bindingRevision: RuntimeRevision | null;
  state: "ready" | "review_required" | "repair_required";
}

interface AgentRuntimeChatView {
  id: string;
  character_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface AgentRuntimePresetView {
  id: string;
  name?: string;
  cache_revision?: number;
  agent_config?: unknown;
}

export interface RuntimeCouncilProfileView {
  council_settings: {
    councilMode?: boolean;
    members: readonly { tools?: readonly unknown[] }[];
  };
}
export interface RuntimeDecisionDependencies {
  getChat: (userId: string, chatId: string) => AgentRuntimeChatView | null;
  getPreset: (userId: string, presetId: string) => AgentRuntimePresetView | null;
  resolveProfile: (
    userId: string,
    fallbackPresetId: string | null,
    chatId: string,
    characterId: string | null,
    options: { isGroup?: boolean; connectionId?: string | null; personaId?: string | null },
  ) => { preset_id: string | null; binding?: unknown; source?: string; source_id?: string | null };
  resolveCouncilProfile: (
    userId: string,
    chatId: string,
    characterId: string | null,
    options: { isGroup?: boolean },
  ) => RuntimeCouncilProfileView;
  resolvePersona: (userId: string, personaId?: string | null) => { id?: string } | null;
  resolveConcreteConnection: (
    userId: string,
    logicalId?: string | null,
    expectedConcreteId?: string | null,
  ) => Promise<unknown>;
  getPresetAgentConfig?: (userId: string, presetId: string) => unknown;
  getChatAgentModeOverride: (userId: string, chatId: string) => ChatAgentModeOverrideV1 | null;
  setChatAgentModeOverride: (
    userId: string,
    chatId: string,
    mode: AgentRuntimeMode | null,
    expectedRevision?: number,
  ) => ChatAgentModeWriteResponseV1;
  getInputRevisions?: (
    userId: string,
    request: EffectiveRuntimeRequestV1,
    context: {
      chat: AgentRuntimeChatView;
      target: GenerationTargetV1;
      requestedMode: AgentRuntimeMode;
      rootConnection?: FrozenConcreteConnectionV1 | null;
      childConnections?: Readonly<Record<string, FrozenConcreteConnectionV1>>;
      preset?: AgentRuntimePresetView | null;
      config?: unknown;
    },
  ) => Partial<InputRevisionSetV1> | null;
  getReadinessVector?: (
    userId: string,
    request: EffectiveRuntimeRequestV1,
    context: {
      configRevision: RuntimeRevision | null;
      bindingRevision: RuntimeRevision | null;
      inputRevisionDigest: string;
      rootConnection?: FrozenConcreteConnectionV1 | null;
      childConnections?: Readonly<Record<string, FrozenConcreteConnectionV1>>;
      target?: GenerationTargetV1;
      config?: unknown;
    },
  ) => Partial<AgenticReadinessVectorV1> | null;
}

export interface AgentRuntimeDecisionServiceOptions {
  dependencies?: Partial<RuntimeDecisionDependencies>;
  now?: () => number;
  tokenStore?: RuntimeDecisionTokenStore;
}

interface InternalResolutionContext {
  request: EffectiveRuntimeRequestV1;
  chat: AgentRuntimeChatView;
  target: GenerationTargetV1;
  rootConnection: FrozenConcreteConnectionV1 | null;
  childConnections: Record<string, FrozenConcreteConnectionV1>;
  config: AgentConfigView | null;
  preset: AgentRuntimePresetView | null;
  presetSource: SafePresetProjectionV1["source"];
  chatOverride: ChatAgentModeOverrideV1 | null;
  inputRevisionDigest: string;
  inputRevisionsComplete: boolean;
  readinessVector: AgenticReadinessVectorV1;
  readinessDigest: string;
  capabilityReadiness: {
    ready: boolean;
    sameDomain: boolean;
    required: AgentRuntimeCapabilityRequirement[];
    missing: AgentRuntimeCapabilityRequirement[];
    repairCodes: AgentRuntimeRepairCode[];
  };
  repairCodes: AgentRuntimeRepairCode[];
  requestedMode: AgentRuntimeMode;
  effectiveMode: AgentRuntimeMode;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SAFE_STRING_MAX) return fallback;
  return trimmed;
}

function safeRevision(value: unknown): RuntimeRevision | null {
  if (typeof value === "string" && value.length <= SAFE_STRING_MAX) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
}

function uniqueOrderedModes(value: unknown): AgentRuntimeMode[] {
  const modes: AgentRuntimeMode[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isAgentRuntimeMode(item) || modes.includes(item)) continue;
      modes.push(item);
    }
  }
  if (!modes.includes("response")) modes.unshift("response");
  return modes;
}

function normalizeRequirements(value: unknown): AgentRuntimeCapabilityRequirement[] {
  const requirements: AgentRuntimeCapabilityRequirement[] = [];
  if (!Array.isArray(value)) return requirements;
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!(AGENT_RUNTIME_CAPABILITY_REQUIREMENTS as readonly string[]).includes(item)) continue;
    const requirement = item as AgentRuntimeCapabilityRequirement;
    if (!requirements.includes(requirement)) requirements.push(requirement);
  }
  return requirements.sort((left, right) => left.localeCompare(right));
}

function normalizeTarget(request: EffectiveRuntimeRequestV1): { target: GenerationTargetV1; invalidType: boolean } {
  const rawType = request.target?.generationType ?? request.generationType ?? "normal";
  const validType = isAgenticGenerationType(rawType);
  const generationType = validType ? rawType : "normal";
  const target: GenerationTargetV1 = {
    generationType,
    messageId: safeString(request.target?.messageId, null),
    swipeId: Number.isSafeInteger(request.target?.swipeId) && (request.target?.swipeId ?? -1) >= 0
      ? request.target?.swipeId
      : null,
    branchId: safeString(request.target?.branchId, null),
    targetCharacterId: safeString(request.target?.targetCharacterId ?? request.targetCharacterId, null),
    revision: safeRevision(request.target?.revision),
  };
  return { target, invalidType: !validType };
}
type RuntimeConcreteConnection = FrozenConcreteConnectionV1 & { presetId?: string | null };

function normalizeConcreteConnection(raw: unknown, logicalId: string | null): RuntimeConcreteConnection | null {
  if (!isRecord(raw)) return null;
  const capabilities = isRecord(raw.capabilities) ? { ...raw.capabilities } : {};
  const concreteId = safeString(raw.concreteId ?? raw.concrete_id ?? raw.id, null);
  const normalizedLogicalId = safeString(raw.logicalId ?? raw.logical_id, logicalId);
  return {
    logicalId: normalizedLogicalId,
    concreteId,
    label: safeString(raw.label ?? raw.name, null),
    presetId: safeString(raw.presetId ?? raw.preset_id, null),
    provider: safeString(raw.provider, null),
    model: safeString(raw.model, null),
    effectiveEndpoint: safeString(raw.endpoint ?? raw.effectiveEndpoint ?? raw.apiUrl ?? raw.api_url, null),
    endpointRevision: safeRevision(raw.endpointRevision ?? raw.endpoint_revision),
    credentialSecretRef: safeString(raw.credentialSecretRef ?? raw.credential_secret_ref, null),
    credentialRevision: safeRevision(raw.credentialRevision ?? raw.credential_revision),
    candidateRevision: safeRevision(raw.candidateRevision ?? raw.candidate_revision),
    revision: safeRevision(raw.revision ?? raw.updatedAt ?? raw.updated_at),
    fingerprint: safeString(raw.fingerprint, null),
    capabilities,
  };
}
function sameFrozenConnection(left: FrozenConcreteConnectionV1 | null | undefined, right: FrozenConcreteConnectionV1 | null | undefined): boolean {
  if (!left || !right) return left === right;
  const leftEndpoint = (left as FrozenConcreteConnectionV1 & { effectiveEndpoint?: string | null }).effectiveEndpoint ?? null;
  const rightEndpoint = (right as FrozenConcreteConnectionV1 & { effectiveEndpoint?: string | null }).effectiveEndpoint ?? null;
  return left.logicalId === right.logicalId
    && left.concreteId === right.concreteId
    && left.provider === right.provider
    && left.model === right.model
    && leftEndpoint === rightEndpoint
    && String(left.endpointRevision) === String(right.endpointRevision)
    && String(left.credentialSecretRef) === String(right.credentialSecretRef)
    && String(left.credentialRevision) === String(right.credentialRevision)
    && String(left.candidateRevision) === String(right.candidateRevision)
    && String(left.fingerprint) === String(right.fingerprint);
}

function capabilityIsPresent(capabilities: Readonly<Record<string, unknown>>, requirement: AgentRuntimeCapabilityRequirement): boolean {
  if (requirement === "generation") return true;
  if (requirement === "streaming") {
    return capabilities.streaming === true
      || capabilities.supportsStreaming === true
      || capabilities.stream === true;
  }
  if (requirement === "tool_calling") {
    return capabilities.toolCalling === true
      || capabilities.tool_calling === true
      || capabilities.supportsToolCalling === true;
  }
  if (requirement === "native_tool_continuation") {
    /*
     * Agentic WORK supports both provider-native continuation carriers and
     * the bounded legacy assistant/user-result transcript. The provider
     * contract is explicit: an unsupported mode is the only rejection.
     */
    const mode = capabilities.toolContinuationMode
      ?? capabilities.tool_continuation_mode;
    if (mode === "native") {
      return (
        (capabilities.nativeToolContinuation === true
          || capabilities.native_tool_continuation === true)
        && capabilityIsPresent(capabilities, "tool_calling")
      );
    }
    if (mode === "legacy") {
      return capabilityIsPresent(capabilities, "tool_calling");
    }
    return false;
  }
  return capabilities.toolsDisabledFinalization === true
    || capabilities.tools_disabled_finalization === true
    || capabilities.supportsToolsDisabledFinalization === true
    || capabilities.supportsToolFinalization === true;
}

function mapCapabilityFailure(requirement: AgentRuntimeCapabilityRequirement): AgentRuntimeRepairCode {
  switch (requirement) {
    case "generation": return "agentic_capability_missing_generation";
    case "streaming": return "agentic_capability_missing_streaming";
    case "tool_calling": return "agentic_capability_missing_tool_calling";
    case "native_tool_continuation": return "agentic_capability_missing_native_tool_continuation";
    case "tools_disabled_finalization": return "agentic_capability_missing_tools_disabled_finalization";
  }
}

function normalizeInputRevisions(value: Partial<InputRevisionSetV1> | null | undefined): { complete: boolean; normalized: Record<string, unknown>; digest: string } {
  const source = isRecord(value) ? value : {};
  const normalized: Record<string, unknown> = {};
  let complete = true;
  for (const key of INPUT_REVISION_KEYS) {
    if (!Object.hasOwn(source, key) || source[key] === undefined) complete = false;
    normalized[key] = source[key] ?? null;
  }
  return { complete, normalized, digest: hashCanonical(normalized) };
}

/** Canonical digest used by decision tokens and the pre-dispatch snapshot gate. */
export function canonicalInputRevisionDigest(
  value: Partial<InputRevisionSetV1> | null | undefined,
): string {
  return normalizeInputRevisions(value).digest;
}

function defaultReadinessVector(inputRevisionDigest: string, configRevision: RuntimeRevision | null, bindingRevision: RuntimeRevision | null): AgenticReadinessVectorV1 {
  return {
    schemaEpoch: DEFAULT_READINESS_EPOCH,
    runtimeEpoch: DEFAULT_READINESS_EPOCH,
    reconciliationEpoch: DEFAULT_READINESS_EPOCH,
    archiveRegistryVersion: DEFAULT_READINESS_EPOCH,
    isolateHealthEpoch: DEFAULT_READINESS_EPOCH,
    publicationStoreHealthEpoch: DEFAULT_READINESS_EPOCH,
    providerCapabilityRevision: DEFAULT_READINESS_EPOCH,
    configRevision: configRevision ?? DEFAULT_REVISION,
    bindingRevision: bindingRevision ?? DEFAULT_REVISION,
    concreteConnectionRevision: DEFAULT_REVISION,
    targetRevision: DEFAULT_REVISION,
    inputRevisionDigest,
    cognitionRevision: DEFAULT_READINESS_EPOCH,
    contextAclRevision: DEFAULT_READINESS_EPOCH,
    killSwitchState: "auto",
    ready: true,
    reasons: [],
  };
}

function normalizeReadinessVector(
  raw: Partial<AgenticReadinessVectorV1> | null | undefined,
  inputRevisionDigest: string,
  configRevision: RuntimeRevision | null,
  bindingRevision: RuntimeRevision | null,
): AgenticReadinessVectorV1 {
  const defaults = defaultReadinessVector(inputRevisionDigest, configRevision, bindingRevision);
  if (!isRecord(raw)) return defaults;
  const state = raw.killSwitchState === "off" || raw.killSwitchState === "on" || raw.killSwitchState === "auto"
    ? raw.killSwitchState
    : defaults.killSwitchState;
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter((reason): reason is string => typeof reason === "string" && reason.length <= SAFE_STRING_MAX)
    : defaults.reasons;
  return {
    ...defaults,
    ...Object.fromEntries(Object.keys(defaults).map((key) => {
      const value = raw[key as keyof AgenticReadinessVectorV1];
      return [key, value === undefined ? defaults[key as keyof AgenticReadinessVectorV1] : value];
    })),
    killSwitchState: state,
    reasons,
    inputRevisionDigest,
    configRevision: safeRevision(raw.configRevision) ?? configRevision ?? DEFAULT_REVISION,
    bindingRevision: safeRevision(raw.bindingRevision) ?? bindingRevision ?? DEFAULT_REVISION,
    ready: raw.ready !== false && state !== "on",
  };
}

function normalizeConfig(
  raw: unknown,
  revision: RuntimeRevision,
  bindingRevision: RuntimeRevision | null,
  state: "ready" | "review_required" | "repair_required",
): AgentConfigView | null {
  let config: ReturnType<typeof parseAgentConfigV2>;
  try {
    config = parseAgentConfigV2(raw);
  } catch {
    return null;
  }
  return {
    version: 2,
    agentsEnabled: config.agentsEnabled,
    allowedModes: [...config.allowedModes],
    defaultMode: config.defaultMode,
    maxInvocations: config.maxInvocations,
    maxToolCalls: config.maxToolCalls,
    profiles: config.profiles.map((profile) => ({
      id: profile.id,
      connectionRef: profile.connectionRef.kind === "slot"
        ? { kind: "slot", slotId: profile.connectionRef.slotId }
        : { kind: "inherit_main" },
    })),
    connectionSlots: config.connectionSlots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      requiredCapabilities: normalizeRequirements(slot.requiredCapabilities),
    })),
    revision,
    bindingRevision,
    state,
  };
}

function getSlotBindingId(rawConfig: unknown, slotId: string): string | null {
  if (!isRecord(rawConfig) || !isRecord(rawConfig.slotBindings)) return null;
  return safeString(rawConfig.slotBindings[slotId], null);
}

function getSlotBindingState(rawConfig: unknown, slotId: string): string | null {
  if (!isRecord(rawConfig) || !isRecord(rawConfig.slotBindingStates)) return null;
  return safeString(rawConfig.slotBindingStates[slotId], null);
}

function isNoPresetChat(chat: AgentRuntimeChatView): boolean {
  const metadata = chat.metadata;
  return isRecord(metadata) && (metadata.no_preset === true || metadata.noPreset === true || metadata.temporary === true && metadata.no_preset === true);
}

function hasGroup(chat: AgentRuntimeChatView): boolean {
  return isRecord(chat.metadata) && (chat.metadata.group === true || chat.metadata.group === 1);
}

function hasMultiplayer(chat: AgentRuntimeChatView): boolean {
  return isRecord(chat.metadata) &&
    (chat.metadata.multiplayer === true ||
      typeof chat.metadata.multiplayer_room_id === "string");
}

function mapPresetSource(source: unknown): SafePresetProjectionV1["source"] {
  if (source === "chat" || source === "persona" || source === "character" || source === "connection" || source === "forced") return source;
  if (source === "defaults" || source === "default") return "default";
  return "none";
}


function publicConnection(connection: FrozenConcreteConnectionV1 | null): SafeConnectionProjectionV1 {
  return {
    id: connection?.logicalId ?? connection?.concreteId ?? null,
    label: connection?.label ?? null,
    provider: connection?.provider ?? null,
    model: connection?.model ?? null,
    revision: connection?.revision ?? null,
    endpointRevision: connection?.endpointRevision ?? null,
    credentialRevision: connection?.credentialRevision ?? null,
    candidateRevision: connection?.candidateRevision ?? null,
  };
}

function buildBinding(
  userId: string,
  context: InternalResolutionContext,
): RuntimeDecisionBindingV1 {
  const root = context.rootConnection;
  return {
    userId,
    chatId: context.chat.id,
    targetDigest: hashCanonical(context.target),
    requestEpoch: safeRevision(context.request.requestEpoch) ?? DEFAULT_REVISION,
    logicalConnectionId: root?.logicalId ?? null,
    concreteConnectionId: root?.concreteId ?? null,
    provider: root?.provider ?? null,
    model: root?.model ?? null,
    fingerprint: root?.fingerprint ?? null,
    candidateRevision: root?.candidateRevision ?? null,
    credentialRevision: root?.credentialRevision ?? null,
    endpointRevision: root?.endpointRevision ?? null,
    presetId: context.preset?.id ?? null,
    configRevision: context.config?.revision ?? null,
    bindingRevision: context.config?.bindingRevision ?? null,
    inputRevisionDigest: context.inputRevisionDigest,
    readinessDigest: context.readinessDigest,
  };
}
function safePublicResponse(decision: EffectiveRuntimeDecisionV1): EffectiveRuntimePublicResponseV1 {
  const { internal: _internal, ...publicPart } = decision;
  return publicPart;
}

function isOpaqueDecisionToken(value: unknown): value is string {
  return typeof value === "string" && /^lvrd_[A-Za-z0-9_-]{32,128}$/.test(value);
}

function readOverrideViaPersistenceService(userId: string, chatId: string): ChatAgentModeOverrideV1 | null | undefined {
  try {
    const module = require("./agent-config-portability.service") as {
      getChatAgentModeOverride?: (userId: string, chatId: string) => unknown;
    };
    if (typeof module.getChatAgentModeOverride !== "function") return undefined;
    const result = module.getChatAgentModeOverride(userId, chatId);
    if (!isRecord(result)) return result === null ? null : undefined;
    return {
      mode: isAgentRuntimeMode(result.mode) ? result.mode : null,
      revision: typeof result.revision === "number" && Number.isSafeInteger(result.revision) ? result.revision : 1,
      state: result.state === "review_required" || result.state === "repair_required" ? result.state : "ready",
    };
  } catch {
    return undefined;
  }
}

function readOverrideFromDb(userId: string, chatId: string): ChatAgentModeOverrideV1 | null {
  const persisted = readOverrideViaPersistenceService(userId, chatId);
  if (persisted !== undefined) return persisted;
  try {
    const row = getDb().query(
      "SELECT mode, revision, state FROM chat_agent_mode_overrides WHERE user_id = ? AND chat_id = ?",
    ).get(userId, chatId) as { mode?: unknown; revision?: unknown; state?: unknown } | null;
    if (!row) return null;
    return {
      mode: isAgentRuntimeMode(row.mode) ? row.mode : null,
      revision: typeof row.revision === "number" && Number.isSafeInteger(row.revision) ? row.revision : 1,
      state: row.state === "review_required" || row.state === "repair_required" ? row.state : "ready",
    };
  } catch {
    return null;
  }
}

function writeOverrideToDb(
  userId: string,
  chatId: string,
  mode: AgentRuntimeMode | null,
  expectedRevision?: number,
): ChatAgentModeWriteResponseV1 {
  let persistence: ((userId: string, chatId: string, mode: AgentRuntimeMode | null, expectedRevision?: number) => unknown) | undefined;
  try {
    const module = require("./agent-config-portability.service") as {
      setChatAgentModeOverride?: (userId: string, chatId: string, mode: AgentRuntimeMode | null, expectedRevision?: number) => unknown;
    };
    persistence = module.setChatAgentModeOverride;
  } catch {
    persistence = undefined;
  }
  if (persistence) {
    try {
      const result = persistence(userId, chatId, mode, expectedRevision);
      if (result === null) throw new RuntimeDecisionError("not_found", "Not found", 404);
      if (isRecord(result) && typeof result.revision === "number") {
        return {
          chatId,
          mode: isAgentRuntimeMode(result.mode) ? result.mode : null,
          revision: result.revision,
          state: result.state === "review_required" || result.state === "repair_required" ? result.state : "ready",
        };
      }
      throw new RuntimeDecisionError("invalid_request", "Chat agent mode storage is unavailable.", 503);
    } catch (error) {
      if (error instanceof RuntimeDecisionError) throw error;
      if (error instanceof Error && error.message === "AGENT_CHAT_MODE_REVISION_REQUIRED") {
        throw new RuntimeDecisionError("invalid_request", "Chat agent mode expectedRevision is required (use 0 for the first write).", 428);
      }
      if (error instanceof Error && error.message === "AGENT_CHAT_MODE_REVISION_CONFLICT") {
        throw new RuntimeDecisionError("invalid_request", "Chat agent mode changed; refresh and try again.", 409);
      }
      throw new RuntimeDecisionError("invalid_request", "Chat agent mode storage is unavailable.", 503);
    }
  }
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) throw new RuntimeDecisionError("not_found", "Not found", 404);
  if (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RuntimeDecisionError("invalid_request", "Chat agent mode expectedRevision is required (use 0 for the first write).", 428);
  }
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new RuntimeDecisionError("invalid_request", "Chat agent mode revision is exhausted; refresh and try again.", 409);
  }
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  try {
    const result = db.transaction(() => {
      if (expectedRevision === 0) {
        // A first write is a conditional insert, not an upsert. Two callers
        // with the same base revision must not both win revision 1.
        return db.query(`
          INSERT INTO chat_agent_mode_overrides
            (user_id, chat_id, mode, revision, state, review_code, review_acknowledged, updated_at)
          VALUES (?, ?, ?, 1, 'ready', NULL, 1, ?)
          ON CONFLICT(user_id, chat_id) DO NOTHING
        `).run(userId, chatId, mode, now);
      }
      // Existing writes advance only the row whose revision the caller read.
      return db.query(`
        UPDATE chat_agent_mode_overrides
        SET mode = ?, revision = ?, state = 'ready', review_code = NULL,
            review_acknowledged = 1, updated_at = ?
        WHERE user_id = ? AND chat_id = ? AND revision = ?
      `).run(mode, expectedRevision + 1, now, userId, chatId, expectedRevision);
    })();
    if (result.changes !== 1) {
      throw new RuntimeDecisionError("invalid_request", "Chat agent mode changed; refresh and try again.", 409);
    }
  } catch (error) {
    if (error instanceof RuntimeDecisionError) throw error;
    throw new RuntimeDecisionError("invalid_request", "Chat agent mode storage is unavailable.", 503);
  }
  return { chatId, mode, revision: expectedRevision + 1, state: "ready" };
}

async function defaultConcreteResolver(
  userId: string,
  logicalId?: string | null,
  expectedConcreteId?: string | null,
): Promise<unknown> {
  const resolver = (connectionsSvc as unknown as {
    resolveConcreteConnectionV1?: (
      id: string,
      logicalId?: string | null,
      expectedConcreteId?: string | null,
    ) => unknown;
  }).resolveConcreteConnectionV1;
  const legacy = (connectionsSvc as unknown as { resolveConnection?: (id: string, logicalId?: string) => unknown }).resolveConnection;
  const resolved = await (resolver
    ? resolver(userId, logicalId, expectedConcreteId)
    : legacy?.(userId, logicalId ?? undefined) ?? null);
  if (!isRecord(resolved)) return resolved;
  const concreteId = safeString(resolved.concreteId ?? resolved.concrete_id ?? resolved.id, null);
  const profile = concreteId ? connectionsSvc.getUsableConnection(userId, concreteId) : null;
  return profile ? { ...resolved, presetId: profile.preset_id } : resolved;
}

function normalizeConfigProjection(projection: unknown): { config: AgentConfigView | null; raw: unknown } {
  if (!isRecord(projection) || !isRecord(projection.config) || projection.config.version !== 2) {
    return { config: null, raw: null };
  }
  if (!Object.hasOwn(projection, "review") || !Object.hasOwn(projection, "configRevision") || !Object.hasOwn(projection, "bindings")) {
    return { config: null, raw: null };
  }
  const projectedConfig = projection.config;
  const review = projection.review;
  if (!isRecord(review) || !["ready", "review_required", "repair_required"].includes(String(review.state))) {
    return { config: null, raw: null };
  }
  const configRevision = safeRevision(projection.configRevision);
  if (configRevision === null || !Array.isArray(projection.bindings)) return { config: null, raw: null };
  const unresolved = review.unresolvedSlotIds;
  const stale = review.staleSlotIds;
  if ((unresolved !== undefined && !Array.isArray(unresolved)) || (stale !== undefined && !Array.isArray(stale))) {
    return { config: null, raw: null };
  }
  const slotBindings: Record<string, string> = {};
  const slotBindingStates: Record<string, string> = {};
  let maxBindingRevision: RuntimeRevision | null = null;
  for (const binding of projection.bindings) {
    if (!isRecord(binding)) return { config: null, raw: null };
    const slotId = safeString(binding.slotId, null);
    const connectionId = safeString(binding.connectionId, null);
    const state = binding.state;
    const revision = safeRevision(binding.bindingRevision);
    if (!slotId || revision === null || !["ready", "review_required", "repair_required"].includes(String(state))) {
      return { config: null, raw: null };
    }
    if (connectionId) slotBindings[slotId] = connectionId;
    slotBindingStates[slotId] = String(state);
    if (maxBindingRevision === null || Number(revision) > Number(maxBindingRevision)) maxBindingRevision = revision;
  }
  const projectedBindingRevision = safeRevision(projection.bindingRevision);
  if (projectedBindingRevision !== null && (
    maxBindingRevision === null
    || typeof projectedBindingRevision === "number" && typeof maxBindingRevision === "number" && projectedBindingRevision > maxBindingRevision
  )) maxBindingRevision = projectedBindingRevision;
  const reviewState = String(review.state);
  const hasReviewItems = (Array.isArray(unresolved) && unresolved.length > 0) || (Array.isArray(stale) && stale.length > 0);
  const state = reviewState === "ready" && hasReviewItems ? "review_required" : reviewState as "ready" | "review_required" | "repair_required";
  const raw = {
    ...projectedConfig,
    revision: configRevision,
    bindingRevision: maxBindingRevision,
    state,
    slotBindings,
    slotBindingStates,
  };
  return { config: normalizeConfig(projectedConfig, configRevision, maxBindingRevision, state), raw };
}

function defaultConfigReader(userId: string, presetId: string): { config: AgentConfigView | null; raw: unknown } {
  return normalizeConfigProjection(defaultPresetAgentConfig(userId, presetId));
}

function defaultPresetAgentConfig(userId: string, presetId: string): unknown {
  try {
    const module = require("./agent-config-portability.service") as {
      getPresetAgentConfig?: (userId: string, presetId: string) => unknown;
    };
    return module.getPresetAgentConfig?.(userId, presetId) ?? null;
  } catch {
    return null;
  }
}

function defaultDependencies(): RuntimeDecisionDependencies {
  return {
    getChat: (userId, chatId) => chatsSvc.getChat(userId, chatId) as AgentRuntimeChatView | null,
    getPreset: (userId, presetId) => presetsSvc.getPreset(userId, presetId) as AgentRuntimePresetView | null,
    getPresetAgentConfig: defaultPresetAgentConfig,
    resolveProfile: (userId, fallbackPresetId, chatId, characterId, options) => presetProfilesSvc.resolveProfile(userId, fallbackPresetId, chatId, characterId, options),
    resolveCouncilProfile: (userId, chatId, characterId, options) => councilProfilesSvc.resolveProfile(userId, chatId, characterId, options),
    resolvePersona: (userId, personaId) => personasSvc.resolvePersonaOrDefault(userId, personaId),
    resolveConcreteConnection: defaultConcreteResolver,
    getChatAgentModeOverride: readOverrideFromDb,
    setChatAgentModeOverride: writeOverrideToDb,
    // Admission remains fail-closed until the generation snapshot/readiness
    // authorities are installed by the runtime orchestrator.
    getInputRevisions: () => null,
    getReadinessVector: () => null,
  };
}

function ensureDependencies(overrides: Partial<RuntimeDecisionDependencies> | undefined): RuntimeDecisionDependencies {
  const dependencies = { ...defaultDependencies(), ...(overrides ?? {}) };
  if (overrides && !Object.hasOwn(overrides, "getInputRevisions")) dependencies.getInputRevisions = undefined;
  if (overrides && !Object.hasOwn(overrides, "getPresetAgentConfig")) dependencies.getPresetAgentConfig = undefined;
  if (overrides && !Object.hasOwn(overrides, "getReadinessVector")) dependencies.getReadinessVector = undefined;
  return dependencies;
}

export class AgentRuntimeDecisionService {
  readonly tokenStore: RuntimeDecisionTokenStore;
  private dependencies: RuntimeDecisionDependencies;
  private readonly now: () => number;
  private dependencyUseStarted = false;
  private dependenciesConfigured = false;
  /**
   * A default fail-closed resolver may be queried during bootstrap probes
   * before the concrete coordinator is installed. Such a probe must not make
   * the one-time production installation impossible; custom authorities remain
   * immutable once used.
   */
  private readonly startsWithDefaultDependencies: boolean;

  constructor(options: AgentRuntimeDecisionServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenStore = options.tokenStore ?? new RuntimeDecisionTokenStore(this.now);
    this.startsWithDefaultDependencies = options.dependencies === undefined;
    this.dependencies = ensureDependencies(options.dependencies);
  }

  async resolve(
    userId: string,
    request: EffectiveRuntimeRequestV1,
    options: {
      issueToken?: boolean;
      frozenRootConnection?: FrozenConcreteConnectionV1 | null;
      frozenChildConnections?: Readonly<Record<string, FrozenConcreteConnectionV1>>;
    } = {},
  ): Promise<EffectiveRuntimeDecisionV1> {
    this.dependencyUseStarted = true;
    if (!userId || !request || !request.chatId) {
      throw new RuntimeDecisionError("invalid_request", "chatId is required", 400);
    }
    const chat = this.dependencies.getChat(userId, request.chatId);
    if (!chat || chat.id !== request.chatId) throw new RuntimeDecisionError("not_found", "Not found", 404);

    const { target, invalidType } = normalizeTarget(request);
    const noPreset = isNoPresetChat(chat);
    const isGroup = hasGroup(chat);
    const targetCharacterId = target.targetCharacterId ?? chat.character_id ?? null;
    const isMultiplayer = hasMultiplayer(chat);
    const councilProfile = this.dependencies.resolveCouncilProfile(
      userId,
      chat.id,
      targetCharacterId,
      { isGroup },
    );
    const councilSettings = councilProfile.council_settings;
    const councilActive =
      councilSettings.councilMode === true &&
      councilSettings.members.length > 0;
    const councilToolsActive = councilSettings.members.some(
      (member) => Array.isArray(member.tools) && member.tools.length > 0,
    );
    const unsupportedAgenticSurface =
      isGroup || isMultiplayer || councilActive || councilToolsActive;
    const requestedLogicalConnectionId = safeString(request.logicalConnectionId, null);
    const rootConnection = normalizeConcreteConnection(
      await this.dependencies.resolveConcreteConnection(
        userId,
        requestedLogicalConnectionId,
        options.frozenRootConnection?.concreteId ?? null,
      ),
      requestedLogicalConnectionId,
    );

    const repairCodes: AgentRuntimeRepairCode[] = [];
    if (!rootConnection) repairCodes.push("agentic_connection_unavailable");
    if (invalidType) repairCodes.push("agentic_generation_type_unsupported");
    if (target.generationType !== "normal" && !target.messageId && !target.revision) repairCodes.push("agentic_target_unsupported");
    if (target.targetCharacterId && !isGroup && target.targetCharacterId !== chat.character_id) repairCodes.push("agentic_target_unsupported");
    if (target.targetCharacterId && isGroup) {
      const members = isRecord(chat.metadata) && Array.isArray(chat.metadata.character_ids) ? chat.metadata.character_ids : [];
      if (!members.includes(target.targetCharacterId)) repairCodes.push("agentic_target_unsupported");
    }

    let preset: AgentRuntimePresetView | null = null;
    let presetSource: SafePresetProjectionV1["source"] = "none";
    let config: AgentConfigView | null = null;
    let rawConfig: unknown = null;
    let configSnapshot: unknown = null;
    const activePresetSetting = settingsSvc.getSetting(userId, "activeLoomPresetId");
    const activePresetId = typeof activePresetSetting?.value === "string" ? activePresetSetting.value : null;
    const rootPresetId = rootConnection && "presetId" in rootConnection && typeof rootConnection.presetId === "string"
      ? rootConnection.presetId
      : null;
    const requestedPresetId = noPreset
      ? null
      : safeString(request.presetId, null) ?? rootPresetId ?? activePresetId;

    if (!noPreset && request.forcePresetId && request.presetId) {
      preset = this.dependencies.getPreset(userId, request.presetId);
      presetSource = preset ? "forced" : "none";
      if (!preset) repairCodes.push("agent_config_missing");
    } else if (!noPreset) {
      const resolved = this.dependencies.resolveProfile(
        userId,
        requestedPresetId,
        chat.id,
        targetCharacterId,
        { isGroup, connectionId: rootConnection?.logicalId, personaId: request.personaId ?? this.dependencies.resolvePersona(userId, request.personaId)?.id ?? null },
      );
      if (resolved.preset_id) {
        preset = this.dependencies.getPreset(userId, resolved.preset_id);
        presetSource = mapPresetSource(resolved.source);
      }
    }
    if (!preset && !noPreset && requestedPresetId) {
      preset = this.dependencies.getPreset(userId, requestedPresetId);
      if (preset) presetSource = "default";
    }
    if (preset) {
      if (this.dependencies.getPresetAgentConfig) {
        const projected = this.dependencies.getPresetAgentConfig(userId, preset.id);
        const normalized = normalizeConfigProjection(projected);
        config = normalized.config;
        rawConfig = normalized.raw;
        if (isRecord(projected) && isRecord(projected.config)) {
          configSnapshot = structuredClone(projected.config);
        }
      } else {
        // Runtime authority is always the normalized projection. The preset
        // payload is presentation data and may contain import-only legacy
        // metadata; never use it as an executable config fallback.
        const persisted = defaultConfigReader(userId, preset.id);
        config = persisted.config;
        rawConfig = persisted.raw;
      }
    }

    const chatOverride = this.dependencies.getChatAgentModeOverride(userId, chat.id);
    const configAllowedModes = config?.allowedModes ?? ["response"];
    const configDefaultMode = config?.defaultMode ?? "response";
    const requestedMode: AgentRuntimeMode = request.mode
      ?? chatOverride?.mode
      ?? configDefaultMode;
    const normalizedRequestedMode = isAgentRuntimeMode(requestedMode) ? requestedMode : "response";
    if (request.mode && !isAgentRuntimeMode(request.mode)) repairCodes.push("agentic_mode_not_allowed");
    if (normalizedRequestedMode === "agentic" && unsupportedAgenticSurface) {
      repairCodes.push("agentic_target_unsupported");
    }

    if (noPreset) {
      config = null;
      rawConfig = null;
    }
    if (config?.state === "review_required") repairCodes.push("agent_config_review_required");
    if (config?.state === "repair_required") repairCodes.push("agent_config_repair_required");
    if (normalizedRequestedMode === "agentic" && !config) repairCodes.push("agent_config_missing");
    if (normalizedRequestedMode === "agentic" && config && !config.agentsEnabled) repairCodes.push("agent_config_disabled");
    if (normalizedRequestedMode === "agentic" && config && !configAllowedModes.includes("agentic")) repairCodes.push("agentic_mode_not_allowed");
    if (normalizedRequestedMode === "agentic" && config && !validateAgentConfigForExecution({ maxInvocations: config.maxInvocations, maxToolCalls: config.maxToolCalls }).executable) repairCodes.push("agentic_readiness_unavailable");
    const missingCapabilities: AgentRuntimeCapabilityRequirement[] = [];
    const requiredCapabilities = [...REQUIRED_AGENTIC_CAPABILITIES];
    const childConnections: Record<string, FrozenConcreteConnectionV1> = {};
    let sameDomain = true;
    if (config && rawConfig) {
      for (const profile of config.profiles) {
        const slotRef = profile.connectionRef;
        if (slotRef.kind !== "slot") continue;
        const slot = config.connectionSlots.find((candidate) => candidate.id === slotRef.slotId);
        const connectionId = getSlotBindingId(rawConfig, slotRef.slotId);
        const bindingState = getSlotBindingState(rawConfig, slotRef.slotId);
        if (bindingState && bindingState !== "ready") {
          repairCodes.push("agentic_slot_stale");
          continue;
        }
        if (!slot || !connectionId) {
          repairCodes.push("agentic_slot_unresolved");
          continue;
        }
        const childConnection = normalizeConcreteConnection(
          await this.dependencies.resolveConcreteConnection(
            userId,
            connectionId,
            options.frozenChildConnections?.[profile.id]?.concreteId ?? null,
          ),
          connectionId,
        );
        if (!childConnection) {
          repairCodes.push("agentic_slot_stale");
          continue;
        }
        childConnections[profile.id] = childConnection;
        for (const requirement of slot.requiredCapabilities) {
          if (!requiredCapabilities.includes(requirement)) requiredCapabilities.push(requirement);
          if (!capabilityIsPresent(childConnection.capabilities, requirement)) {
            if (!missingCapabilities.includes(requirement)) missingCapabilities.push(requirement);
            repairCodes.push(mapCapabilityFailure(requirement));
          }
        }
        if (!rootConnection?.fingerprint || !childConnection.fingerprint || rootConnection.fingerprint !== childConnection.fingerprint) {
          sameDomain = false;
          repairCodes.push("agentic_domain_mismatch");
        }
      }
    }
    const revisionSource = this.dependencies.getInputRevisions
      ? this.dependencies.getInputRevisions(userId, request, {
        chat,
        target,
        requestedMode: normalizedRequestedMode,
        rootConnection,
        childConnections,
        preset,
        config: rawConfig,
      })
      : request.inputRevisions;
    const revisions = normalizeInputRevisions(revisionSource);
    for (const requirement of REQUIRED_AGENTIC_CAPABILITIES) {
      if (!rootConnection || !capabilityIsPresent(rootConnection.capabilities, requirement)) {
        if (!missingCapabilities.includes(requirement)) missingCapabilities.push(requirement);
        repairCodes.push(mapCapabilityFailure(requirement));
      }
    }
    if (!revisions.complete && normalizedRequestedMode === "agentic") repairCodes.push("agentic_input_revisions_incomplete");

    const readinessFromDependency = this.dependencies.getReadinessVector?.(userId, request, {
      configRevision: config?.revision ?? null,
      bindingRevision: config?.bindingRevision ?? null,
      inputRevisionDigest: revisions.digest,
      rootConnection,
      childConnections,
      target,
      config: rawConfig,
    });
    const readinessInput = this.dependencies.getReadinessVector
      ? readinessFromDependency ?? { ready: false, reasons: ["agentic_readiness_authority_unavailable"] }
      : request.readinessVector;
    const readinessVector = canonicalizeAgenticReadinessVectorV1(normalizeReadinessVector(
      readinessInput,
      revisions.digest,
      config?.revision ?? null,
      config?.bindingRevision ?? null,
    ));
    if (normalizedRequestedMode === "agentic" && !readinessVector.ready) repairCodes.push("agentic_readiness_unavailable");
    if (normalizedRequestedMode === "agentic" && readinessVector.killSwitchState === "on") repairCodes.push("agentic_kill_switch");

    const uniqueRepairCodes = [...new Set(repairCodes)];
    const capabilityReady = missingCapabilities.length === 0
      && sameDomain
      && uniqueRepairCodes.every((code) => !code.startsWith("agentic_") || code === "agentic_response_escape")
      && normalizedRequestedMode === "agentic"
      && config?.state === "ready"
      && (!chatOverride || chatOverride.state === "ready")
      && !!config?.agentsEnabled
      && configAllowedModes.includes("agentic")
      && revisions.complete
      && readinessVector.ready
      && readinessVector.killSwitchState !== "on";
    if (!capabilityReady && normalizedRequestedMode === "agentic") uniqueRepairCodes.push("agentic_response_escape");

    const capabilityReadiness = {
      ready: capabilityReady,
      sameDomain,
      required: [...new Set(requiredCapabilities)].sort((left, right) => left.localeCompare(right)),
      missing: missingCapabilities.sort((left, right) => left.localeCompare(right)),
      repairCodes: [...new Set(uniqueRepairCodes)],
    };
    const effectiveMode: AgentRuntimeMode = capabilityReady ? "agentic" : "response";
    const readinessDigest = hashAgenticReadinessVectorV1(readinessVector);
    const context: InternalResolutionContext = {
      request,
      chat,
      target,
      rootConnection,
      childConnections,
      config,
      preset,
      presetSource,
      chatOverride,
      inputRevisionDigest: revisions.digest,
      inputRevisionsComplete: revisions.complete,
      readinessVector,
      readinessDigest,
      capabilityReadiness,
      repairCodes: [...new Set(uniqueRepairCodes)],
      requestedMode: normalizedRequestedMode,
      effectiveMode,
    };
    const internal: RuntimeDecisionInternalV1 = {
      binding: buildBinding(userId, context),
      rootConnection,
      childConnections,
      configSnapshot,
      readinessVector,
      issuedAt: this.now(),
      expiresAt: 0,
    };
    let runtimeDecisionToken: string | null = null;
    let runtimeDecisionExpiresAt: number | null = null;
    if (effectiveMode === "agentic" && options.issueToken !== false) {
      try {
        const issued = this.tokenStore.issue(userId, internal, request);
        runtimeDecisionToken = issued.token;
        runtimeDecisionExpiresAt = issued.expiresAt;
        internal.expiresAt = issued.expiresAt;
        internal.issuedAt = issued.expiresAt - this.tokenStore.ttlMs;
      } catch (error) {
        if (!(error instanceof DecisionTokenCapacityError)) throw error;
        context.effectiveMode = "response";
        context.capabilityReadiness.ready = false;
        context.capabilityReadiness.repairCodes = [...new Set([...context.capabilityReadiness.repairCodes, "decision_capacity_exceeded", "agentic_response_escape"] as AgentRuntimeRepairCode[])];
        context.repairCodes = context.capabilityReadiness.repairCodes.slice();
      }
    }

    const decision: EffectiveRuntimeDecisionV1 = {
      version: AGENT_RUNTIME_DECISION_VERSION,
      chatId: chat.id,
      target,
      connection: publicConnection(rootConnection),
      preset: {
        id: preset?.id ?? null,
        label: safeString(preset?.name, null),
        revision: safeRevision(preset?.cache_revision),
        source: presetSource,
      },
      agentsEnabled: config?.agentsEnabled === true,
      allowedModes: configAllowedModes,
      defaultMode: configDefaultMode,
      requestedMode: normalizedRequestedMode,
      effectiveMode: context.effectiveMode,
      chatOverride,
      capabilityReadiness: {
        ready: context.capabilityReadiness.ready && context.effectiveMode === "agentic",
        sameDomain: context.capabilityReadiness.sameDomain,
        required: context.capabilityReadiness.required,
        missing: context.capabilityReadiness.missing,
        repairCodes: context.capabilityReadiness.repairCodes,
        responseEscape: AGENT_RUNTIME_RESPONSE_ESCAPE,
      },
      repairCodes: context.repairCodes,
      runtimeDecisionToken,
      runtimeDecisionExpiresAt,
      internal,
    };
    return decision;
  }

  async consume(userId: string, token: string, request: EffectiveRuntimeRequestV1): Promise<RuntimeDecisionTokenConsumptionV1> {
    const stored = this.tokenStore.consume(userId, token);
    if (!stored) return { accepted: false, code: "decision_refresh_required", decision: null };
    const storedRequest = stored.request;
    const normalizedIncoming = normalizeTarget(request).target;
    const normalizedStored = normalizeTarget(storedRequest).target;
    const incomingBinding = {
      userId,
      chatId: request.chatId,
      targetDigest: hashCanonical(normalizedIncoming),
      requestEpoch: safeRevision(request.requestEpoch) ?? DEFAULT_REVISION,
    };
    if (incomingBinding.userId !== stored.decision.binding.userId
      || incomingBinding.chatId !== stored.decision.binding.chatId
      || incomingBinding.targetDigest !== stored.decision.binding.targetDigest
      || incomingBinding.requestEpoch !== stored.decision.binding.requestEpoch
      || hashCanonical(normalizedStored) !== stored.decision.binding.targetDigest) {
      return { accepted: false, code: "decision_refresh_required", decision: null };
    }

    const expected = stored.decision.binding;
    const storedRoot = stored.decision.rootConnection;
    // Re-resolve against the admitted logical ID and concrete member. This
    // validates current endpoint/credential/config/input/readiness revisions
    // without asking a roulette/router to choose a second candidate.
    const currentRequest: EffectiveRuntimeRequestV1 = {
      ...storedRequest,
      ...request,
      chatId: expected.chatId,
      target: request.target ?? storedRequest.target,
      requestEpoch: expected.requestEpoch,
      logicalConnectionId: expected.logicalConnectionId,
      presetId: expected.presetId,
      forcePresetId: expected.presetId !== null,
      mode: "agentic",
    };
    const current = await this.resolve(
      userId,
      { ...currentRequest, readinessVector: request.readinessVector ?? storedRequest.readinessVector },
      {
        issueToken: false,
        frozenRootConnection: storedRoot,
        frozenChildConnections: stored.decision.childConnections,
      },
    );
    if (current.effectiveMode !== "agentic" || !current.internal.rootConnection) {
      return { accepted: false, code: "decision_refresh_required", decision: null };
    }
    const currentBinding = current.internal.binding;
    if (currentBinding.userId !== expected.userId
      || currentBinding.chatId !== expected.chatId
      || currentBinding.targetDigest !== expected.targetDigest
      || currentBinding.requestEpoch !== expected.requestEpoch
      || currentBinding.logicalConnectionId !== expected.logicalConnectionId
      || currentBinding.concreteConnectionId !== expected.concreteConnectionId
      || currentBinding.provider !== expected.provider
      || currentBinding.model !== expected.model
      || currentBinding.fingerprint !== expected.fingerprint
      || currentBinding.candidateRevision !== expected.candidateRevision
      || currentBinding.credentialRevision !== expected.credentialRevision
      || currentBinding.endpointRevision !== expected.endpointRevision
      || currentBinding.presetId !== expected.presetId
      || currentBinding.configRevision !== expected.configRevision
      || currentBinding.bindingRevision !== expected.bindingRevision
      || currentBinding.inputRevisionDigest !== expected.inputRevisionDigest
      || currentBinding.readinessDigest !== expected.readinessDigest
      || !sameFrozenConnection(current.internal.rootConnection, storedRoot)) {
      return { accepted: false, code: "decision_refresh_required", decision: null };
    }
    const expectedChildren = stored.decision.childConnections;
    const currentChildren = current.internal.childConnections;
    const expectedChildIds = Object.keys(expectedChildren);
    const currentChildIds = Object.keys(currentChildren);
    if (expectedChildIds.length !== currentChildIds.length
      || expectedChildIds.some((profileId) => !sameFrozenConnection(expectedChildren[profileId], currentChildren[profileId]))) {
      return { accepted: false, code: "decision_refresh_required", decision: null };
    }
    return { accepted: true, code: "accepted", decision: current };
  }

  getChatAgentModeOverride(userId: string, chatId: string): ChatAgentModeOverrideV1 | null {
    return this.dependencies.getChatAgentModeOverride(userId, chatId);
  }

  setChatAgentModeOverride(userId: string, chatId: string, mode: AgentRuntimeMode | null, expectedRevision?: number): ChatAgentModeWriteResponseV1 {
    if (mode !== null && !isAgentRuntimeMode(mode)) {
      throw new RuntimeDecisionError("invalid_request", "mode must be 'response', 'agentic', or null", 400);
    }
    if (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RuntimeDecisionError("invalid_request", "Chat agent mode expectedRevision is required (use 0 for the first write).", 428);
    }
    if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new RuntimeDecisionError("invalid_request", "Chat agent mode revision is exhausted; refresh and try again.", 409);
    }
    return this.dependencies.setChatAgentModeOverride(userId, chatId, mode, expectedRevision);
  }

  configureDependencies(overrides: Partial<RuntimeDecisionDependencies>): void {
    if (this.dependenciesConfigured || (this.dependencyUseStarted && !this.startsWithDefaultDependencies)) {
      throw new RuntimeDecisionError("invalid_request", "Runtime decision dependencies are already installed.", 409);
    }
    const next = { ...this.dependencies } as RuntimeDecisionDependencies;
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    }
    this.dependencies = next;
    this.dependenciesConfigured = true;
  }

  resetTokensForTests(): void {
    this.tokenStore.clear();
  }
}
/** Install startup-owned snapshot/readiness/config authorities before serving requests. */
export function configureAgentRuntimeDecisionDependencies(
  dependencies: Partial<RuntimeDecisionDependencies>,
): void {
  AGENT_RUNTIME_DECISION_SERVICE.configureDependencies(dependencies);
}


export const AGENT_RUNTIME_DECISION_SERVICE = new AgentRuntimeDecisionService();

export async function resolveEffectiveRuntime(userId: string, request: EffectiveRuntimeRequestV1): Promise<EffectiveRuntimeDecisionV1> {
  return AGENT_RUNTIME_DECISION_SERVICE.resolve(userId, request);
}
export async function resolveEffectiveRuntimeWithoutToken(
  userId: string,
  request: EffectiveRuntimeRequestV1,
): Promise<EffectiveRuntimeDecisionV1> {
  return AGENT_RUNTIME_DECISION_SERVICE.resolve(userId, request, { issueToken: false });
}

export async function consumeRuntimeDecisionToken(
  userId: string,
  token: string,
  request: EffectiveRuntimeRequestV1,
): Promise<RuntimeDecisionTokenConsumptionV1> {
  return AGENT_RUNTIME_DECISION_SERVICE.consume(userId, token, request);
}

export function toPublicRuntimeDecision(decision: EffectiveRuntimeDecisionV1): EffectiveRuntimePublicResponseV1 {
  return safePublicResponse(decision);
}

function assertClosedObject(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new RuntimeDecisionError("invalid_request", `${path}.${key} is not allowed`, 400);
  }
}

function readAliasedField(
  object: Record<string, unknown>,
  names: readonly string[],
  path: string,
): { present: boolean; value: unknown } {
  const present = names.filter((name) => Object.hasOwn(object, name));
  if (present.length > 1) {
    const first = stableStringify(object[present[0]]);
    if (present.some((name) => stableStringify(object[name]) !== first)) {
      throw new RuntimeDecisionError("invalid_request", `${path} has conflicting aliases`, 400);
    }
  }
  return present.length === 0
    ? { present: false, value: undefined }
    : { present: true, value: object[present[0]] };
}
function parseStrictString(value: unknown, path: string, nullable = true): string | null | undefined {
  if (value === undefined) throw new RuntimeDecisionError("invalid_request", `${path} is required`, 400);
  if (value === null) {
    if (nullable) return null;
    throw new RuntimeDecisionError("invalid_request", `${path} must be a string`, 400);
  }
  if (typeof value !== "string") throw new RuntimeDecisionError("invalid_request", `${path} must be a string`, 400);
  const result = value.trim();
  if (result.length === 0 || result.length > SAFE_STRING_MAX) {
    throw new RuntimeDecisionError("invalid_request", `${path} must be a non-empty bounded string`, 400);
  }
  return result;
}

function parseStrictRevision(value: unknown, path: string, nullable = true): RuntimeRevision | null {
  if (value === undefined) throw new RuntimeDecisionError("invalid_request", `${path} is required`, 400);
  if (value === null) {
    if (nullable) return null;
    throw new RuntimeDecisionError("invalid_request", `${path} must be a revision`, 400);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RuntimeDecisionError("invalid_request", `${path} must be a safe integer revision`, 400);
    return value;
  }
  if (typeof value === "string") {
    if (value.length === 0 || value.length > SAFE_STRING_MAX) throw new RuntimeDecisionError("invalid_request", `${path} must be a bounded revision`, 400);
    return value;
  }
  throw new RuntimeDecisionError("invalid_request", `${path} must be a revision`, 400);
}

function parseStrictSwipe(value: unknown, path: string): number | null {
  if (value === undefined) throw new RuntimeDecisionError("invalid_request", `${path} is required`, 400);
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeDecisionError("invalid_request", `${path} must be a non-negative safe integer`, 400);
  }
  return value;
}

function parseStrictPartialInputRevisions(value: unknown, path: string): Partial<InputRevisionSetV1> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) throw new RuntimeDecisionError("invalid_request", `${path} must be an object`, 400);
  assertClosedObject(value, INPUT_REVISION_KEYS, path);
  const result: Partial<InputRevisionSetV1> = {};
  for (const key of INPUT_REVISION_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    result[key] = parseStrictRevision(value[key], `${path}.${key}`) as RuntimeRevision | null;
  }
  return result;
}

const READINESS_KEYS = [
  "schemaEpoch",
  "runtimeEpoch",
  "reconciliationEpoch",
  "archiveRegistryVersion",
  "isolateHealthEpoch",
  "publicationStoreHealthEpoch",
  "providerCapabilityRevision",
  "configRevision",
  "bindingRevision",
  "concreteConnectionRevision",
  "targetRevision",
  "inputRevisionDigest",
  "cognitionRevision",
  "contextAclRevision",
  "killSwitchState",
  "ready",
  "reasons",
] as const;

function parseStrictReadinessVector(value: unknown, path: string): Partial<AgenticReadinessVectorV1> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) throw new RuntimeDecisionError("invalid_request", `${path} must be an object`, 400);
  assertClosedObject(value, READINESS_KEYS, path);
  const result: Partial<AgenticReadinessVectorV1> = {};
  for (const key of READINESS_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const field = value[key];
    if (key === "killSwitchState") {
      if (field !== "off" && field !== "auto" && field !== "on") throw new RuntimeDecisionError("invalid_request", `${path}.${key} is invalid`, 400);
      result[key] = field;
    } else if (key === "ready") {
      if (typeof field !== "boolean") throw new RuntimeDecisionError("invalid_request", `${path}.${key} must be boolean`, 400);
      result[key] = field;
    } else if (key === "reasons") {
      if (!Array.isArray(field) || field.length > 64 || field.some((reason) => typeof reason !== "string" || reason.length === 0 || reason.length > 256)) {
        throw new RuntimeDecisionError("invalid_request", `${path}.${key} is invalid`, 400);
      }
      result[key] = field.slice() as string[];
    } else if (key === "inputRevisionDigest") {
      result[key] = parseStrictString(field, `${path}.${key}`, false) as string;
    } else {
      result[key] = parseStrictRevision(field, `${path}.${key}`, false) as RuntimeRevision;
    }
  }
  return result;
}

export function normalizeEffectiveRuntimeRequest(raw: unknown): EffectiveRuntimeRequestV1 {
  if (!isRecord(raw)) throw new RuntimeDecisionError("invalid_request", "Request body must be an object", 400);
  const topLevelKeys = [
    "chatId", "chat_id", "logicalConnectionId", "connectionId", "connection_id",
    "presetId", "preset_id", "forcePresetId", "force_preset_id", "personaId", "persona_id",
    "targetCharacterId", "target_character_id", "generationType", "generation_type", "target",
    "mode", "requestEpoch", "request_epoch", "inputRevisions", "input_revision_set",
    "input_revisions", "readinessVector", "readiness_vector", "messageId", "message_id",
    "swipeId", "swipe_id",
  ] as const;
  assertClosedObject(raw, topLevelKeys, "request");

  const chatIdField = readAliasedField(raw, ["chatId", "chat_id"], "chatId");
  if (!chatIdField.present) throw new RuntimeDecisionError("invalid_request", "chatId is required", 400);
  const chatId = parseStrictString(chatIdField.value, "chatId", false) as string;
  const logicalConnection = readAliasedField(raw, ["logicalConnectionId", "connectionId", "connection_id"], "logicalConnectionId");
  const preset = readAliasedField(raw, ["presetId", "preset_id"], "presetId");
  const forcePreset = readAliasedField(raw, ["forcePresetId", "force_preset_id"], "forcePresetId");
  const persona = readAliasedField(raw, ["personaId", "persona_id"], "personaId");
  const targetCharacter = readAliasedField(raw, ["targetCharacterId", "target_character_id"], "targetCharacterId");
  const generation = readAliasedField(raw, ["generationType", "generation_type"], "generationType");
  const targetField = readAliasedField(raw, ["target"], "target");
  const mode = readAliasedField(raw, ["mode"], "mode");
  const requestEpoch = readAliasedField(raw, ["requestEpoch", "request_epoch"], "requestEpoch");
  const inputRevisions = readAliasedField(raw, ["inputRevisions", "input_revision_set", "input_revisions"], "inputRevisions");
  const readiness = readAliasedField(raw, ["readinessVector", "readiness_vector"], "readinessVector");
  const message = readAliasedField(raw, ["messageId", "message_id"], "messageId");
  const swipe = readAliasedField(raw, ["swipeId", "swipe_id"], "swipeId");

  const parsedMode = mode.present ? parseStrictString(mode.value, "mode", false) : undefined;
  if (parsedMode !== undefined && !isAgentRuntimeMode(parsedMode)) {
    throw new RuntimeDecisionError("invalid_request", "mode must be 'response' or 'agentic'", 400);
  }
  const parsedForcePreset = forcePreset.present
    ? (typeof forcePreset.value === "boolean"
      ? forcePreset.value
      : (() => { throw new RuntimeDecisionError("invalid_request", "forcePresetId must be boolean", 400); })())
    : undefined;
  const generationType = generation.present ? parseStrictString(generation.value, "generationType", false) : undefined;

  let target: GenerationTargetV1 | null | undefined;
  if (!targetField.present || targetField.value === null) {
    target = null;
  } else {
    if (!isRecord(targetField.value)) throw new RuntimeDecisionError("invalid_request", "target must be an object or null", 400);
    const targetRaw = targetField.value;
    assertClosedObject(targetRaw, ["generationType", "messageId", "message_id", "swipeId", "swipe_id", "branchId", "branch_id", "targetCharacterId", "target_character_id", "revision"], "target");
    const targetGeneration = readAliasedField(targetRaw, ["generationType"], "target.generationType");
    const targetMessage = readAliasedField(targetRaw, ["messageId", "message_id"], "target.messageId");
    const targetSwipe = readAliasedField(targetRaw, ["swipeId", "swipe_id"], "target.swipeId");
    const targetBranch = readAliasedField(targetRaw, ["branchId", "branch_id"], "target.branchId");
    const targetCharacterField = readAliasedField(targetRaw, ["targetCharacterId", "target_character_id"], "target.targetCharacterId");
    const targetRevision = readAliasedField(targetRaw, ["revision"], "target.revision");
    const targetGenerationValue = targetGeneration.present
      ? parseStrictString(targetGeneration.value, "target.generationType", false)
      : (generationType ?? "normal");
    const parsedTargetSwipe = targetSwipe.present
      ? parseStrictSwipe(targetSwipe.value, "target.swipeId")
      : (swipe.present ? parseStrictSwipe(swipe.value, "swipeId") : null);
    target = {
      generationType: targetGenerationValue as GenerationTargetV1["generationType"],
      messageId: targetMessage.present ? parseStrictString(targetMessage.value, "target.messageId") as string | null : (message.present ? parseStrictString(message.value, "messageId") as string | null : null),
      swipeId: parsedTargetSwipe as number | null,
      branchId: targetBranch.present ? parseStrictString(targetBranch.value, "target.branchId") as string | null : null,
      targetCharacterId: targetCharacterField.present
        ? parseStrictString(targetCharacterField.value, "target.targetCharacterId") as string | null
        : (targetCharacter.present ? parseStrictString(targetCharacter.value, "targetCharacterId") as string | null : null),
      revision: targetRevision.present ? parseStrictRevision(targetRevision.value, "target.revision") as RuntimeRevision | null : null,
    };
  }
  return {
    chatId,
    logicalConnectionId: logicalConnection.present ? parseStrictString(logicalConnection.value, "logicalConnectionId") as string | null : undefined,
    presetId: preset.present ? parseStrictString(preset.value, "presetId") as string | null : undefined,
    forcePresetId: parsedForcePreset,
    personaId: persona.present ? parseStrictString(persona.value, "personaId") as string | null : undefined,
    targetCharacterId: targetCharacter.present ? parseStrictString(targetCharacter.value, "targetCharacterId") as string | null : undefined,
    generationType: generationType as EffectiveRuntimeRequestV1["generationType"],
    target,
    mode: parsedMode as AgentRuntimeMode | undefined,
    requestEpoch: requestEpoch.present ? parseStrictRevision(requestEpoch.value, "requestEpoch", false) as RuntimeRevision : undefined,
    inputRevisions: parseStrictPartialInputRevisions(inputRevisions.value, "inputRevisions"),
    readinessVector: parseStrictReadinessVector(readiness.value, "readinessVector"),
  };
}

export { publicConnection as toPublicConnectionProjection };
