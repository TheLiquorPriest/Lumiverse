/**
 * Authenticated, one-turn Agentic runtime decision contracts.
 *
 * These DTOs deliberately separate the public preflight projection from the
 * internal frozen decision.  A public response may identify a safe label and
 * revision, but it must never carry a credential reference, endpoint, or
 * trust-domain fingerprint.
 */

export const AGENT_RUNTIME_DECISION_VERSION = 1 as const;
export const AGENT_RUNTIME_DECISION_TOKEN_TTL_MS = 60_000;
export const AGENT_RUNTIME_DECISION_MAX_LIVE_PER_USER = 16;
export const AGENT_RUNTIME_DECISION_MAX_LIVE_PROCESS = 512;

export const AGENTIC_GENERATION_TYPES = [
  "normal",
  "continue",
  "regenerate",
  "swipe",
] as const;

export type AgenticGenerationType = (typeof AGENTIC_GENERATION_TYPES)[number];
export type AgentRuntimeMode = "response" | "agentic";
export type RuntimeRevision = string | number;

export const AGENT_RUNTIME_CAPABILITY_REQUIREMENTS = [
  "generation",
  "streaming",
  "tool_calling",
  "native_tool_continuation",
  "tools_disabled_finalization",
] as const;

export type AgentRuntimeCapabilityRequirement =
  (typeof AGENT_RUNTIME_CAPABILITY_REQUIREMENTS)[number];

export const AGENT_RUNTIME_REPAIR_CODES = [
  "agent_config_missing",
  "agent_config_disabled",
  "agent_config_review_required",
  "agent_config_repair_required",
  "agentic_mode_not_allowed",
  "agentic_slot_unresolved",
  "agentic_slot_stale",
  "agentic_capability_missing_generation",
  "agentic_capability_missing_streaming",
  "agentic_capability_missing_tool_calling",
  "agentic_capability_missing_native_tool_continuation",
  "agentic_capability_missing_tools_disabled_finalization",
  "agentic_domain_mismatch",
  "agentic_generation_type_unsupported",
  "agentic_target_unsupported",
  "agentic_input_revisions_incomplete",
  "agentic_readiness_unavailable",
  "agentic_kill_switch",
  "cognition_invalid",
  "cognition_repair_required",
  "cognition_missing_block_revision",
  "cognition_missing_pack_revision",
  "cognition_deleted_attachment",
  "cognition_predicate_limit_exceeded",
  "cognition_authorization_stale",
  "cognition_import_review_required",
  "cognition_foreign_authority_blocked",
  "agentic_connection_unavailable",
  "agentic_response_escape",
  "decision_capacity_exceeded",
  "decision_refresh_required",
] as const;

export type AgentRuntimeRepairCode = (typeof AGENT_RUNTIME_REPAIR_CODES)[number];

/** The target identity must be frozen before preflight can issue a token. */
export interface GenerationTargetV1 {
  generationType: AgenticGenerationType;
  messageId?: string | null;
  swipeId?: number | null;
  branchId?: string | null;
  targetCharacterId?: string | null;
  revision?: RuntimeRevision | null;
}

/**
 * Every member is intentionally named rather than represented by a metadata
 * bag.  `null` is meaningful: it records that an optional entity is absent in
 * the frozen snapshot, while `undefined` means the snapshot was incomplete.
 */
export interface InputRevisionSetV1 {
  target: RuntimeRevision | null;
  chat: RuntimeRevision | null;
  message: RuntimeRevision | null;
  preset: RuntimeRevision | null;
  block: RuntimeRevision | null;
  config: RuntimeRevision | null;
  binding: RuntimeRevision | null;
  connection: RuntimeRevision | null;
  endpoint: RuntimeRevision | null;
  credential: RuntimeRevision | null;
  persona: RuntimeRevision | null;
  character: RuntimeRevision | null;
  group: RuntimeRevision | null;
  world: RuntimeRevision | null;
  lore: RuntimeRevision | null;
  settings: RuntimeRevision | null;
  macro: RuntimeRevision | null;
  regex: RuntimeRevision | null;
  context: RuntimeRevision | null;
  acl: RuntimeRevision | null;
  cognition: RuntimeRevision | null;
  readiness: RuntimeRevision | null;
}

/**
 * Closed runtime readiness vector. Production resolution fills every field
 * from installed authorities; the canonical encoder in
 * agent-cognition-integrity.service.ts hashes these exact keys in order so
 * decision tokens invalidate when any component revision or readiness flag
 * changes.
 */
export interface AgenticReadinessVectorV1 {
  schemaEpoch: RuntimeRevision;
  runtimeEpoch: RuntimeRevision;
  reconciliationEpoch: RuntimeRevision;
  archiveRegistryVersion: RuntimeRevision;
  isolateHealthEpoch: RuntimeRevision;
  publicationStoreHealthEpoch: RuntimeRevision;
  providerCapabilityRevision: RuntimeRevision;
  configRevision: RuntimeRevision;
  bindingRevision: RuntimeRevision;
  concreteConnectionRevision: RuntimeRevision;
  targetRevision: RuntimeRevision;
  inputRevisionDigest: string;
  cognitionRevision: RuntimeRevision;
  contextAclRevision: RuntimeRevision;
  killSwitchState: "off" | "auto" | "on";
  ready: boolean;
  reasons: readonly string[];
}

export interface EffectiveRuntimeRequestV1 {
  chatId: string;
  logicalConnectionId?: string | null;
  presetId?: string | null;
  forcePresetId?: boolean;
  personaId?: string | null;
  targetCharacterId?: string | null;
  generationType?: AgenticGenerationType | string;
  target?: GenerationTargetV1 | null;
  mode?: AgentRuntimeMode;
  requestEpoch?: RuntimeRevision;
  inputRevisions?: Partial<InputRevisionSetV1> | null;
  readinessVector?: Partial<AgenticReadinessVectorV1> | null;
}

export interface SafeConnectionProjectionV1 {
  /** Local logical ID is safe to return to the authenticated owner. */
  id: string | null;
  label: string | null;
  provider: string | null;
  model: string | null;
  revision: RuntimeRevision | null;
  endpointRevision: RuntimeRevision | null;
  credentialRevision: RuntimeRevision | null;
  candidateRevision: RuntimeRevision | null;
}

export interface SafePresetProjectionV1 {
  id: string | null;
  label: string | null;
  revision: RuntimeRevision | null;
  source: "chat" | "persona" | "character" | "connection" | "default" | "forced" | "none";
}

export interface CapabilityReadinessV1 {
  ready: boolean;
  sameDomain: boolean;
  required: readonly AgentRuntimeCapabilityRequirement[];
  missing: readonly AgentRuntimeCapabilityRequirement[];
  repairCodes: readonly AgentRuntimeRepairCode[];
  responseEscape: "available";
}

export interface ChatAgentModeOverrideV1 {
  mode: AgentRuntimeMode | null;
  revision: number;
  state: "ready" | "review_required" | "repair_required";
}

/** Authenticated public response for POST /api/v1/generate/effective-runtime. */
export interface EffectiveRuntimePublicResponseV1 {
  version: typeof AGENT_RUNTIME_DECISION_VERSION;
  chatId: string;
  target: GenerationTargetV1;
  connection: SafeConnectionProjectionV1;
  preset: SafePresetProjectionV1;
  agentsEnabled: boolean;
  allowedModes: readonly AgentRuntimeMode[];
  defaultMode: AgentRuntimeMode;
  requestedMode: AgentRuntimeMode;
  effectiveMode: AgentRuntimeMode;
  chatOverride: ChatAgentModeOverrideV1 | null;
  capabilityReadiness: CapabilityReadinessV1;
  repairCodes: readonly AgentRuntimeRepairCode[];
  runtimeDecisionToken: string | null;
  runtimeDecisionExpiresAt: number | null;
}

/** Internal concrete candidate. Never serialize this object as an API DTO. */
export interface FrozenConcreteConnectionV1 {
  logicalId: string | null;
  concreteId: string | null;
  label: string | null;
  provider: string | null;
  model: string | null;
  /** Canonical normalized endpoint captured with the concrete candidate. */
  effectiveEndpoint: string | null;
  endpointRevision: RuntimeRevision | null;
  credentialSecretRef: string | null;
  credentialRevision: RuntimeRevision | null;
  candidateRevision: RuntimeRevision | null;
  revision: RuntimeRevision | null;
  fingerprint: string | null;
  capabilities: Readonly<Record<string, unknown>>;
}

export interface RuntimeDecisionBindingV1 {
  userId: string;
  chatId: string;
  targetDigest: string;
  requestEpoch: RuntimeRevision;
  logicalConnectionId: string | null;
  concreteConnectionId: string | null;
  provider: string | null;
  model: string | null;
  fingerprint: string | null;
  candidateRevision: RuntimeRevision | null;
  credentialRevision: RuntimeRevision | null;
  endpointRevision: RuntimeRevision | null;
  presetId: string | null;
  configRevision: RuntimeRevision | null;
  bindingRevision: RuntimeRevision | null;
  inputRevisionDigest: string;
  readinessDigest: string;
}

export interface RuntimeDecisionInternalV1 {
  binding: RuntimeDecisionBindingV1;
  rootConnection: FrozenConcreteConnectionV1 | null;
  childConnections: Readonly<Record<string, FrozenConcreteConnectionV1>>;
  /**
   * The exact normalized V2 config admitted with the decision. This is
   * private, in-memory authority; public DTOs and tokens never expose it.
   */
  configSnapshot?: unknown;
  readinessVector: AgenticReadinessVectorV1;
  issuedAt: number;
  expiresAt: number;
}

export interface EffectiveRuntimeDecisionV1 extends EffectiveRuntimePublicResponseV1 {
  /** Internal-only frozen fields. Routes must call `toPublicRuntimeDecision`. */
  internal: RuntimeDecisionInternalV1;
}

export interface RuntimeDecisionTokenConsumptionV1 {
  accepted: boolean;
  code: "accepted" | "decision_refresh_required";
  decision: EffectiveRuntimeDecisionV1 | null;
}

export interface ChatAgentModeWriteV1 {
  mode: AgentRuntimeMode | null;
  expectedRevision: number;
}

export interface ChatAgentModeWriteResponseV1 {
  chatId: string;
  mode: AgentRuntimeMode | null;
  revision: number;
  state: ChatAgentModeOverrideV1["state"];
}

export function isAgenticGenerationType(value: unknown): value is AgenticGenerationType {
  return typeof value === "string" && (AGENTIC_GENERATION_TYPES as readonly string[]).includes(value);
}

export function isAgentRuntimeMode(value: unknown): value is AgentRuntimeMode {
  return value === "response" || value === "agentic";
}

export function isCapabilityRequirement(value: unknown): value is AgentRuntimeCapabilityRequirement {
  return typeof value === "string"
    && (AGENT_RUNTIME_CAPABILITY_REQUIREMENTS as readonly string[]).includes(value);
}
