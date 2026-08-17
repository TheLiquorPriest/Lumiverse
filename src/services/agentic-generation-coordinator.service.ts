import type { Database } from "bun:sqlite";
import {
  AgenticGenerationError,
  abortAcceptedAgenticGeneration,
  type AgenticContextRuntimeV1,
  type AgenticExecutionHandle,
  type AgenticGenerationDependencies,
  type AgenticGenerationInput,
  type AgenticRuntimeDecision,
  type AgenticTargetSnapshot,
} from "./agentic-generation.service";
import { configureAgenticGenerationDependencies } from "./generate.service";
import {
  canonicalInputRevisionDigest,
  consumeRuntimeDecisionToken,
  configureAgentRuntimeDecisionDependencies,
  resolveEffectiveRuntimeWithoutToken,
} from "./agent-runtime-decision.service";
import { ARCHIVE_REGISTRY_VERSION } from "./user-data/table-registry";
import { CanonicalDataError, canonicalPlainDataBounds } from "../utils/canonical-plain-data";
import { getIsolateHealthEpoch } from "./isolate-pool";
import {
  getPresetAgentConfig,
  getPresetAgentCognitionSourceV1,
  type AgentPresetCognitionSourceV1,
  type PresetAgentConfigProjection,
} from "./agent-config-portability.service";
import { listPromptBlocks } from "./presets.service";
import {
  buildGenerationAssemblySnapshot,
  isGenerationAssemblySnapshotV1,
  type GenerationAssemblySnapshotInputV1,
  type GenerationAssemblySnapshotV1,
} from "./prompt-assembly-snapshot.service";
import {
  type AssemblyPlanV1,
  type AssemblyProviderMessageV1,
} from "./agentic-assembly-compiler";
import {
  prepareAgentRender,
  compileAgentAssemblyPlan,
} from "./agentic-preprocessing-worker-client";
import { validateRenderPreparationResultV1 } from "./agentic-render-preparation-validator";
import {
  executeBoundedAgenticChildFrame,
  runAgenticWorkPhase,
  AgenticWorkPhaseError,
  type AgenticWorkPhaseOutcome,
  type AgenticWorkOptions,
  type AgenticWorkRenderHandoff,
} from "./agentic-work-phase.service";
import {
  AgenticRenderPhaseError,
  runAgenticRenderPhaseV1,
  type AgenticRenderPhaseInputV1,
} from "./agentic-render-phase.service";
import {
  AGENTIC_COMMIT_DEPENDENCIES_V1,
  commitAgenticTurnV1,
  type AgenticCommitInputV1,
} from "./agentic-commit.service";
import {
  calculateFinalRenderReservationEnvelopeV1,
  createTurnExecution,
  getAgenticReadiness,
  getAgenticRuntimeMode,
  getRuntimeEpoch,
  getTurnExecution,
  requestTurnCancellation,
  reserveFinalRender,
  transitionTurnExecution,
} from "./turn-execution.service";
import {
  createTurnWorkspace,
  freezeFrameCapabilities,
  invalidateFrameCapabilitiesForTurn,
  getCurrentWorkspaceRevisionV1,
  getWorkspaceCompletionGatesV1,
  readTurnWorkspaceSection,
  freezeWorkspaceForCompletionV1,
  createWorkspaceTask,
  updateWorkspaceTaskProgress,
  submitWorkspaceChildResult,
  acceptWorkspaceSubmission,
  recordWorkspaceRecord,
  attachWorkspaceArtifactReference,
  proposeWorkspacePublication,
  assignChildTasks as assignWorkspaceChildTasks,
  WORKSPACE_MAX_TERMINAL_TTL_SECONDS,
  TurnWorkspaceError,
} from "./turn-workspace.service";
import {
  appendAgentRunSnapshot,
  registerAgentRunStopHandler,
  withAgentRunProjectionTransaction,
  type AgentRunProjectionInputV2,
} from "./agent-run-projection.service";
import {
  createAccountContextPackReader,
  createContextToolCapability,
  ContextPackInputRevisionTracker,
  ContextPackToolBudget,
  recheckContextPackInputRevisionsAtCommit,
  type ContextPackToolBudgetV1,
} from "./agent-context-tools.service";
import { freezeAgentCognitionV1 } from "./agent-cognition.service";
import {
  createAgentCognitionRuntime,
} from "./agent-cognition-runtime.service";
import type {
  AgentCognitionRuntimeV1,
  CognitionContextPackRequirementV1,
  CognitionRuntimeActivationV1,
  CognitionRuntimeCompletionV1,
  CognitionRuntimeTaskTransitionInputV1,
} from "../types/agent-cognition-runtime";
import type { CognitionValue } from "../types/agent-cognition";
import { buildWorkspaceContextProjectionFromWorkspaceV1 } from "./workspace-context-projection.service";
import { createHash } from "node:crypto";
import {
  COGNITION_REPAIR_CODES,
  applyCognitionReadinessV1,
  createCognitionContextInvalidationSink,
  type CognitionRepairCode,
} from "./agent-cognition-integrity.service";
import { getDb } from "../db/connection";
import { getMessage } from "./chats.service";
import type { Message } from "../types/message";
import { getProvider, validateProviderCapabilities } from "../llm/registry";
import * as secretsSvc from "./secrets.service";
import { CORE_AGENT_TOOL_IDS, createDisabledAgentConfigV2, parseAgentConfigV2, type AgentConfigStateV1, type AgentConfigV2, type AgentLoreScope, type AgentToolSnapshot, type CoreAgentToolId } from "../types/agents";
import { createAgentToolSnapshot, executeCoreAgentTool } from "./agent-tools.service";
import { AgentRuntimeOwner } from "./agent-runtime.service";
import { cloneAndFreeze, resolveConcreteConnectionV1, type ResolvedConcreteConnectionV1 } from "./connections.service";
import * as pool from "./generation-pool.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { GenerationRequest, GenerationResponse, GenerationParameters, LlmMessage, StreamChunk } from "../llm/types";
import { observeOutputTokens } from "./agent-runtime-accounting";
import type {
  FrozenConcreteConnectionV1,
  EffectiveRuntimeRequestV1,
  EffectiveRuntimeDecisionV1,
  InputRevisionSetV1 as RuntimeInputRevisionSetV1,
  RuntimeDecisionInternalV1,
  AgenticReadinessVectorV1,
} from "../types/agent-runtime-decision";
import type { FinalRenderReservationV1 } from "../types/turn-execution";
import { HOST_PREPARATION_LIMITS_V1 } from "../types/agent-preprocessing";
import type {
  RenderPreparationInputV1,
  FrozenSourceMessageV1,
  FrozenSwipeV1,
  FrozenRegexScriptV1,
  RenderMacroSnapshotV1,
  RenderTargetV1,
  RegexActionDeltaV1,
  WorldInfoStateDeltaV1,
} from "../types/agent-preprocessing";
import type { WorkspaceArtifactReferenceV1, WorkspaceOperationCapabilitiesV1, WorkspaceOperationKindV1, WorkspaceTerminalHandoffV1, WorkspaceUsageV1 } from "../types/turn-workspace";
import { withUserDataMutationSync } from "./user-data/snapshot";
import type { AgenticPhase } from "./agentic-generation.service";
import type { AgenticWorkProviderRequest, AgenticWorkspaceCapability, AgenticWorkspaceCompletionFixedPointResult, AgenticWorkspacePreparationResult, AgenticWorkFrame } from "./agentic-work-phase.service";
import type { AgenticRenderProviderRequestV1 } from "./agentic-render-phase.service";
import { AGENT_RUNTIME_ADMISSION_MANAGER } from "./agent-runtime-admission";
import { getAgentRuntimeHostLimits } from "./agent-runtime-limits";
type RuntimeExecution = {
  id: string;
  userId: string;
  chatId: string;
  target: AgenticTargetSnapshot;
  workspaceId: string;
  workspaceRevision: number;
  workspaceRetention: "turn_terminal" | "chat_lifetime";
  workspaceSharing: "root_only" | "view_only";
  deadlineAt: number;
  owner: AgentRuntimeOwner;
  credentialCarrier: Map<string, string>;
  ownerToken?: string;
  commitKey?: string;
  signal?: AbortSignal;
};
type CoordinatorContextRuntime = AgenticContextRuntimeV1 & {
  readonly budget: ContextPackToolBudgetV1;
  readonly refreshContextCapability: (requirements: readonly CognitionContextPackRequirementV1[]) => void;
};
type FrozenRenderCommitProjection = Readonly<{
  reservation: FinalRenderReservationV1;
  workspaceRevision: number;
  workspaceUsage: WorkspaceUsageV1;
  terminalHandoff: WorkspaceTerminalHandoffV1;
}>;

function requireRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  if (!isGenerationAssemblySnapshotV1(value)) throw new Error("agentic_snapshot_invalid");
  return value;
}


function isRuntimeExecution(value: AgenticExecutionHandle): value is RuntimeExecution {
  return isRecord(value)
    && typeof value.userId === "string"
    && typeof value.chatId === "string"
    && typeof value.workspaceId === "string"
    && typeof value.workspaceRevision === "number"
    && Number.isFinite(value.deadlineAt)
    && (value.workspaceRetention === "turn_terminal" || value.workspaceRetention === "chat_lifetime")
    && (value.workspaceSharing === "root_only" || value.workspaceSharing === "view_only")
    && value.owner instanceof AgentRuntimeOwner
    && value.credentialCarrier instanceof Map;
}

function requireRuntimeExecution(value: AgenticExecutionHandle): RuntimeExecution {
  if (!isRuntimeExecution(value)) throw new Error("agentic_execution_invalid");
  return value;
}

function isCoordinatorContextRuntime(value: unknown): value is CoordinatorContextRuntime {
  return isRecord(value)
    && isRecord(value.snapshot)
    && isRecord(value.reader)
    && isRecord(value.tracker)
    && isRecord(value.capability)
    && typeof value.refreshContextCapability === "function"
    && typeof value.recheckAtCommit === "function";
}

function requireCoordinatorContextRuntime(
  value: AgenticContextRuntimeV1 | undefined,
): CoordinatorContextRuntime | undefined {
  if (!value) return undefined;
  if (!isCoordinatorContextRuntime(value)) throw new Error("agentic_context_runtime_invalid");
  return value;
}

const INSTALLATION_KEY = Symbol.for("lumiverse.agentic-generation-coordinator.installed");
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();
const installationMarker = Object.freeze({
  get(): boolean {
    return Reflect.get(globalThis, INSTALLATION_KEY) === true;
  },
  set(): void {
    Reflect.set(globalThis, INSTALLATION_KEY, true);
  },
  clear(): void {
    Reflect.deleteProperty(globalThis, INSTALLATION_KEY);
  },
});
const WORKSPACE_OPERATIONS: readonly WorkspaceOperationKindV1[] = [
  "read_section", "read_page", "create_task", "update_assigned_progress",
  "submit_child_result", "accept_submission", "record_finding", "record_decision", "record_question",
  "attach_artifact", "propose_publication",
];
const DEFAULT_QUOTA = Object.freeze({
  maxTasks: 256,
  maxRecords: 1024,
  maxSubmissions: 1024,
  maxArtifacts: 256,
  maxBytes: 4 * 1024 * 1024,
});
/**
 * Handoff between `getInputRevisions` and `getReadinessVector` within one
 * synchronous `resolve()` call. It is deliberately never reused as an assembly
 * snapshot: preflight carries no user input and may only gate external state.
 */
type RuntimeInternal = RuntimeDecisionInternalV1;
type DecisionWithInternal = AgenticRuntimeDecision & { internal: RuntimeInternal };
type RuntimeSnapshot = GenerationAssemblySnapshotV1;
type RuntimePlan = AssemblyPlanV1;
function materializePolicyMessages(messages: readonly AssemblyProviderMessageV1[]): readonly LlmMessage[] {
  return messages.map((message) => {
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      throw new Error("agentic_render_policy_invalid");
    }
    const text = message.segments.map((segment) => {
      if (segment.kind !== "literal") throw new Error("agentic_render_policy_invalid");
      return segment.text;
    }).join("");
    return { role: message.role, content: text };
  });
}
/** One request-lifetime handoff between the input and readiness authorities. */
interface PreflightReadinessRecord {
  readonly snapshot: RuntimeSnapshot | null;
  readonly reviewState: AgentConfigStateV1 | null;
  readonly reviewCode: string | null;
}

const preflightSnapshots = new Map<string, PreflightReadinessRecord>();

function preflightRequestKey(userId: string, request: EffectiveRuntimeRequestV1): string {
  return [
    userId,
    request.chatId,
    String(request.requestEpoch ?? 0),
    request.generationType ?? "",
    JSON.stringify(request.target ?? null),
  ].join("\u0000");
}

let installed = false;
let decisionAuthoritiesInstalled = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeInternal(value: unknown): value is RuntimeInternal {
  if (!isRecord(value) || !isRecord(value.binding) || !isRecord(value.childConnections)) return false;
  const rootConnection = value.rootConnection;
  if (rootConnection !== null && !isRecord(rootConnection)) return false;
  if (!Object.values(value.childConnections).every((connection) => isRecord(connection))) return false;
  return typeof value.binding.userId === "string"
    && typeof value.binding.chatId === "string"
    && typeof value.binding.targetDigest === "string"
    && typeof value.binding.inputRevisionDigest === "string"
    && typeof value.binding.readinessDigest === "string"
    && isRecord(value.readinessVector);
}

function internalDecision(value: AgenticRuntimeDecision): DecisionWithInternal {
  if (!isRecord(value) || !isRuntimeInternal(value.internal) || !value.internal.rootConnection) {
    throw new Error("decision_refresh_required");
  }
  return { ...value, internal: value.internal };
}

function publicConnection(connection: FrozenConcreteConnectionV1): NonNullable<AgenticRuntimeDecision["connection"]> {
  return {
    ...(connection.logicalId === null ? {} : { logicalId: connection.logicalId }),
    ...(connection.concreteId === null ? {} : { concreteId: connection.concreteId }),
    ...(connection.label === null ? {} : { name: connection.label }),
    ...(connection.provider === null ? {} : { provider: connection.provider }),
    ...(connection.model === null ? {} : { model: connection.model }),
    ...(connection.effectiveEndpoint === null ? {} : { endpoint: connection.effectiveEndpoint }),
    capabilities: { ...connection.capabilities },
    ...(connection.candidateRevision === null ? {} : { candidateRevision: connection.candidateRevision }),
    ...(connection.endpointRevision === null ? {} : { endpointRevision: connection.endpointRevision }),
    ...(connection.credentialRevision === null ? {} : { credentialRevision: connection.credentialRevision }),
  };
}

function mapDecision(value: EffectiveRuntimeDecisionV1): AgenticRuntimeDecision {
  const internal = value.internal;
  if (!internal.rootConnection) throw new Error("decision_refresh_required");
  const target: AgenticTargetSnapshot = {
    generationType: value.target.generationType,
    ...(value.target.messageId == null ? {} : { messageId: value.target.messageId }),
    ...(value.target.swipeId == null ? {} : { swipeId: value.target.swipeId }),
    ...(value.target.revision == null ? {} : { revision: value.target.revision }),
  };
  return {
    mode: value.effectiveMode,
    target,
    connection: publicConnection(internal.rootConnection),
    presetId: value.preset.id ?? undefined,
    configRevision: internal.binding.configRevision ?? undefined,
    bindingRevision: internal.binding.bindingRevision ?? undefined,
    inputRevisions: internal.binding.inputRevisionDigest,
    readiness: internal.readinessVector,
    readinessDigest: internal.binding.readinessDigest,
    token: value.runtimeDecisionToken ?? undefined,
    expiresAt: value.runtimeDecisionExpiresAt ?? undefined,
    internal,
  };
}

/**
 * Adapt the provider resolver's concrete descriptor to the runtime decision
 * descriptor, supplying the canonical candidate revision for its aggregate
 * revision while retaining private trust-domain fields.
 */
function normalizeConcreteConnection(
  connection: ResolvedConcreteConnectionV1 | null | undefined,
): FrozenConcreteConnectionV1 | null {
  if (!connection) return null;
  return Object.freeze({
    logicalId: connection.logicalId ?? null,
    concreteId: connection.concreteId ?? null,
    label: connection.label ?? null,
    provider: connection.provider ?? null,
    model: connection.model ?? null,
    effectiveEndpoint: connection.effectiveEndpoint ?? null,
    endpointRevision: connection.endpointRevision ?? null,
    credentialSecretRef: connection.credentialSecretRef ?? null,
    credentialRevision: connection.credentialRevision ?? null,
    candidateRevision: connection.candidateRevision ?? null,
    revision: connection.candidateRevision ?? null,
    fingerprint: connection.fingerprint ?? null,
    capabilities: cloneAndFreeze(connection.capabilities),
  });
}

function requireRenderConnection(connection: FrozenConcreteConnectionV1): ResolvedConcreteConnectionV1 {
  const providerName = connection.provider;
  const effectiveEndpoint = connection.effectiveEndpoint;
  const logicalId = connection.logicalId;
  const concreteId = connection.concreteId;
  const label = connection.label;
  const model = connection.model;
  const credentialSecretRef = connection.credentialSecretRef;
  const fingerprint = connection.fingerprint;
  const endpointRevision = connection.endpointRevision;
  const credentialRevision = connection.credentialRevision;
  const candidateRevision = connection.candidateRevision;
  if (
    typeof providerName !== "string" || !providerName
    || typeof effectiveEndpoint !== "string" || !effectiveEndpoint
    || typeof logicalId !== "string" || !logicalId
    || typeof concreteId !== "string" || !concreteId
    || typeof label !== "string" || !label
    || typeof model !== "string" || !model
    || typeof credentialSecretRef !== "string" || !credentialSecretRef
    || typeof fingerprint !== "string" || !fingerprint
    || (typeof endpointRevision !== "string" && typeof endpointRevision !== "number")
    || (typeof credentialRevision !== "string" && typeof credentialRevision !== "number")
    || (typeof candidateRevision !== "string" && typeof candidateRevision !== "number")
  ) {
    throw new Error("agentic_provider_failure");
  }
  const provider = getProvider(providerName);
  if (!provider) throw new Error("agentic_provider_failure");
  validateProviderCapabilities(provider);
  return Object.freeze({
    logicalId,
    concreteId,
    label,
    provider: providerName,
    model,
    endpoint: effectiveEndpoint,
    effectiveEndpoint,
    endpointRevision: String(endpointRevision),
    credentialSecretRef,
    credentialRevision: String(credentialRevision),
    candidateRevision: String(candidateRevision),
    fingerprint,
    capabilities: cloneAndFreeze(provider.capabilities),
  });
}
/**
 * Project the frozen candidate down to exactly the accepted members.
 */
function snapshotConnection(connection: FrozenConcreteConnectionV1 | null): Readonly<Record<string, unknown>> | null {
  if (!connection) return null;
  const projected: Record<string, unknown> = {};
  const fields: readonly [string, unknown][] = [
    ["logicalId", connection.logicalId],
    ["concreteId", connection.concreteId],
    ["label", connection.label],
    ["provider", connection.provider],
    ["model", connection.model],
    ["effectiveEndpoint", connection.effectiveEndpoint],
    ["endpointRevision", connection.endpointRevision],
    ["credentialRevision", connection.credentialRevision],
    ["candidateRevision", connection.candidateRevision],
    ["revision", connection.revision ?? connection.candidateRevision],
    ["capabilities", connection.capabilities],
  ];
  const required = new Set(["endpointRevision", "credentialRevision", "candidateRevision"]);
  for (const [key, item] of fields) {
    if (item !== undefined && (item !== null || required.has(key))) projected[key] = item;
  }
  return Object.freeze(projected);
}

function runtimeRequest(input: AgenticGenerationInput, target: AgenticTargetSnapshot): EffectiveRuntimeRequestV1 {
  return {
    chatId: input.chatId,
    logicalConnectionId: input.connectionId ?? null,
    presetId: input.presetId ?? null,
    forcePresetId: input.forcePresetId === true,
    personaId: input.personaId ?? null,
    targetCharacterId: input.targetCharacterId ?? null,
    generationType: target.generationType,
    target: {
      generationType: target.generationType,
      messageId: target.messageId ?? null,
      swipeId: target.swipeId ?? null,
      targetCharacterId: target.targetCharacterId ?? input.targetCharacterId ?? null,
      ...(target.revision !== undefined ? { revision: target.revision } : {}),
    },
    mode: "agentic",
    requestEpoch: input.requestEpoch ?? 0,
  };
}

type LiveTargetBinding = {
  readonly target: "normal" | "continue" | "regenerate" | "swipe";
  readonly chatId: string;
  readonly branchId: string | null;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly messageIndex: number | null;
  readonly swipeCount: number | null;
  readonly chatGenerationRevision: number;
  readonly messageGenerationRevision: number | null;
};

function targetFromBinding(binding: LiveTargetBinding): AgenticTargetSnapshot {
  return Object.freeze({
    generationType: binding.target,
    ...(binding.messageId !== null ? { messageId: binding.messageId } : {}),
    ...(binding.swipeId !== null ? { swipeId: binding.swipeId } : {}),
  });
}

/**
 * Read the live, owner-scoped target identity and its monotonic revisions.
 * The same binding is used to create the durable execution and to commit, so a
 * concurrent chat or message mutation is observable as a revision conflict
 * instead of being silently overwritten by a hardcoded zero.
 */
function bindLiveTarget(userId: string, chatId: string, target: AgenticTargetSnapshot): LiveTargetBinding {
  const db = getDb();
  const chatRow = db.query(
    "SELECT generation_revision FROM chats WHERE id = ? AND user_id = ? LIMIT 1",
  ).get(chatId, userId) as { generation_revision?: number } | null;
  if (!chatRow) throw new Error("agentic_target_unsupported");
  const chatGenerationRevision = Number(chatRow.generation_revision ?? 0);
  const kind = target.generationType;
  if (kind === "normal") {
    return {
      target: kind, chatId, branchId: null, messageId: null, swipeId: null,
      messageIndex: null, swipeCount: null, chatGenerationRevision, messageGenerationRevision: null,
    };
  }
  const messageId = target.messageId ?? null;
  if (!messageId) throw new Error("agentic_target_unsupported");
  const messageRow = db.query(
    "SELECT id, index_in_chat, swipes, swipe_id, branch_id, generation_revision FROM messages WHERE id = ? AND chat_id = ? LIMIT 1",
  ).get(messageId, chatId) as Record<string, unknown> | null;
  if (!messageRow) throw new Error("agentic_target_unsupported");
  let parsedSwipes: unknown = [];
  try { parsedSwipes = JSON.parse(String(messageRow.swipes ?? "[]")); } catch { parsedSwipes = []; }
  const swipeCount = Array.isArray(parsedSwipes) ? parsedSwipes.length : 0;
  const currentSwipe = typeof messageRow.swipe_id === "number" ? messageRow.swipe_id : 0;
  // Regenerate always appends one new swipe, regardless of the submitted
  // current swipe. Explicit `swipe` generation retains its requested slot.
  const appends = kind === "swipe" || kind === "regenerate";
  const defaultSwipe = appends ? swipeCount : currentSwipe;
  const requestedSwipe = kind === "regenerate" ? swipeCount : target.swipeId ?? defaultSwipe;
  const maximum = appends ? swipeCount : swipeCount - 1;
  if (!Number.isSafeInteger(requestedSwipe) || requestedSwipe < 0 || requestedSwipe > maximum) {
    throw new Error("agentic_target_unsupported");
  }
  return {
    target: kind,
    chatId,
    branchId: typeof messageRow.branch_id === "string" ? messageRow.branch_id : null,
    messageId,
    swipeId: requestedSwipe,
    messageIndex: Number(messageRow.index_in_chat ?? 0),
    swipeCount,
    chatGenerationRevision,
    messageGenerationRevision: Number(messageRow.generation_revision ?? 0),
  };
}
type FrozenAgentConfig = AgentConfigV2;
const CHILD_WORKSPACE_CAPABILITIES: readonly WorkspaceOperationKindV1[] = [
  "update_assigned_progress",
  "submit_child_result",
];


type WorkspacePolicy = {
  readonly retention: "turn_terminal" | "chat_lifetime";
  readonly sharing: "root_only" | "view_only";
};

function workspacePolicy(value: unknown): WorkspacePolicy {
  if (value === undefined || value === null) {
    return { retention: "turn_terminal", sharing: "root_only" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace_policy_unsupported");
  }
  const policy = value as Record<string, unknown>;
  if (
    (policy.retention !== "turn_terminal" && policy.retention !== "chat_lifetime")
    || (policy.sharing !== "root_only" && policy.sharing !== "view_only")
  ) {
    throw new Error("workspace_policy_unsupported");
  }
  return { retention: policy.retention, sharing: policy.sharing };
}
function frozenConfig(value: unknown): FrozenAgentConfig {
  if (value === undefined || value === null) return createDisabledAgentConfigV2();
  return parseAgentConfigV2(value);
}
function rootMaxOutputTokens(parameters: GenerationParameters | undefined): number | undefined {
  const value = parameters?.max_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
function normalizeLoreScope(value: string | undefined): AgentLoreScope {
  return value === "all_owned" ? "all_owned" : "active";
}
function assemblyAbortError(signal: AbortSignal): AgenticGenerationError {
  const reason = signal.reason;
  const timedOut = (reason instanceof DOMException && reason.name === "TimeoutError")
    || (isRecord(reason) && reason.code === "agentic_timed_out");
  return new AgenticGenerationError(
    timedOut ? "agentic_timed_out" : "agentic_cancelled",
    timedOut ? "Agentic root deadline exceeded." : "Agentic generation cancelled.",
    { phase: "ASSEMBLE" },
  );
}
function mapRenderPhaseError(error: unknown): AgenticGenerationError | undefined {
  if (!(error instanceof AgenticRenderPhaseError)) return undefined;
  const code = error.code;
  const generationCode =
    code === "render_deadline_exceeded"
      ? "agentic_timed_out"
      : code === "cancelled"
        ? "agentic_cancelled"
        : code === "render_provider_failed"
          ? "agentic_provider_failure"
          : code === "render_budget_exceeded"
            || code === "render_context_limit_exceeded"
            || code === "render_output_limit_exceeded"
            || code === "render_activity_limit_exceeded"
            ? "agentic_work_exhausted"
            : code === "render_protocol_error"
              || code === "render_tool_finalization_unsupported"
              || code === "render_tool_returned"
              || code === "invalid_input"
                ? "agentic_protocol_failure"
                : "agentic_internal_error";
  return new AgenticGenerationError(
    generationCode,
    `Agentic render failed: ${code}.`,
    { phase: "RENDER", cause: error },
  );
}

/**
 * Snapshot availability is the union of every authored grant. Individual root
 * and child grants are narrowed from it; it is never widened to the catalog.
 */
function authoredToolIds(config: unknown): readonly CoreAgentToolId[] {
  const parsed = frozenConfig(config);
  const union = new Set<CoreAgentToolId>(parsed.mainToolIds ?? []);
  for (const profile of parsed.profiles ?? []) {
    for (const toolId of profile.toolIds ?? []) union.add(toolId);
  }
  return [...union];
}


function cognitionSnapshotInputs(
  userId: string,
  presetId: string | null,
  projectedConfig?: unknown,
): Pick<GenerationAssemblySnapshotInputV1, "cognitionGraph" | "cognitionSource" | "contextPackSelections" | "contextPackSnapshotSource"> {
  if (!presetId) return { contextPackSnapshotSource: "host_prefetched" };
  const projected = frozenConfig(projectedConfig);
  const authored = getPresetAgentCognitionSourceV1(userId, presetId) as AgentPresetCognitionSourceV1 | null;
  if (!authored) {
    const hasPolicy = [projected.cognitionPolicy, projected.phasePolicy, projected.contextPolicy, projected.taskPolicy]
      .some((value) => value !== undefined && value !== null);
    if (hasPolicy) throw new Error("cognition_source_unavailable");
    return { contextPackSnapshotSource: "host_prefetched" };
  }
  const config = frozenConfig(authored.config);
  const cognitionPolicy = config.cognitionPolicy ?? {
    workPolicy: [],
    workspaceUsage: [],
    completionCriteria: [],
    renderPolicy: [],
  };
  const phasePolicy = config.phasePolicy ?? { work: [], render: [] };
  const contextPolicy = config.contextPolicy ?? { ruleIds: [], packIds: [] };
  const refs: Record<string, { blockId: string; revision: number }> = {};
  const collectRefs = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const ref = candidate as Record<string, unknown>;
      if (typeof ref.blockId !== "string" || !Number.isSafeInteger(ref.expectedBlockRevision)) continue;
      const previous = refs[ref.blockId];
      if (previous && previous.revision !== ref.expectedBlockRevision) {
        throw new Error(`cognition block revision conflict: ${ref.blockId}`);
      }
      refs[ref.blockId] = { blockId: ref.blockId, revision: ref.expectedBlockRevision as number };
    }
  };
  collectRefs(cognitionPolicy.workPolicy);
  collectRefs(cognitionPolicy.workspaceUsage);
  collectRefs(cognitionPolicy.completionCriteria);
  collectRefs(cognitionPolicy.renderPolicy);
  collectRefs(phasePolicy.work);
  collectRefs(phasePolicy.render);
  const blocks = listPromptBlocks(userId, presetId) ?? [];
  const sourceBlocks = Object.values(refs).map((ref) => {
    const block = blocks.find((candidate) => candidate.id === ref.blockId);
    if (!block) throw new Error(`cognition block is unavailable: ${ref.blockId}`);
    const rawRevision = isRecord(block) ? block.revision : undefined;
    const actualRevision = typeof rawRevision === "number" && Number.isSafeInteger(rawRevision) && rawRevision >= 0
      ? rawRevision
      : typeof rawRevision === "string" && /^\d+$/.test(rawRevision) ? Number(rawRevision) : 1;
    if (actualRevision !== ref.revision) {
      throw new Error(`cognition block revision is stale: ${ref.blockId}`);
    }
    return { blockId: ref.blockId, revision: actualRevision, promptOrder: blocks.indexOf(block) };
  });
  const source = {
    presetRevision: authored.presetRevision,
    blocks: sourceBlocks,
  };
  const directPackIds = Array.isArray(contextPolicy.packIds) ? contextPolicy.packIds : [];
  const selections = authored.contextPackSelections.map((selection) => ({
    packId: selection.packId,
    revisionId: selection.revisionId,
    digest: selection.digest,
    required: directPackIds.includes(selection.packId),
  }));
  const frozen = freezeAgentCognitionV1({
    config: { ...config, contextPolicy: { ...contextPolicy, packIds: directPackIds } },
    contextRules: authored.contextRules,
    taskTemplates: authored.taskTemplates,
    selections,
  }, source);
  if (!frozen) return { contextPackSnapshotSource: "host_prefetched" };
  return {
    cognitionGraph: frozen.graph,
    cognitionSource: frozen.source,
    contextPackSelections: frozen.contextPackSelections,
    contextPackSnapshotSource: "host_prefetched",
  };
}
/**
 * Build the bounded snapshot input for one turn. `concreteConnection` may be
 * re-resolved so that a provider/endpoint/credential change during WORK is
 * observable as a different connection revision at COMMIT.
 */
function snapshotInput(
  input: AgenticGenerationInput,
  decision: AgenticRuntimeDecision,
  target: AgenticTargetSnapshot,
  concreteConnection?: FrozenConcreteConnectionV1 | null,
): GenerationAssemblySnapshotInputV1 {
  const internal = internalDecision(decision).internal;
  const presetId = internal.binding.presetId ?? input.presetId ?? null;
  const projection = presetId ? getPresetAgentConfig(input.userId, presetId) as PresetAgentConfigProjection | null : null;
  const connection = concreteConnection ?? internal.rootConnection;
  const cognition = cognitionSnapshotInputs(input.userId, presetId, projection?.config);
  return {
    userId: input.userId,
    chatId: input.chatId,
    generationId: `agentic:${input.chatId}:${target.generationType}:${target.messageId ?? "new"}`,
    generationType: target.generationType,
    connectionId: connection?.logicalId ?? connection?.concreteId ?? input.connectionId ?? null,
    presetId,
    personaId: input.personaId ?? null,
    targetCharacterId: target.targetCharacterId ?? input.targetCharacterId ?? null,
    targetMessageId: target.messageId ?? input.messageId ?? null,
    targetSwipeId: target.swipeId ?? input.swipeId ?? null,
    userInput: input.userInput ?? "",
    toolIds: authoredToolIds(projection?.config),
    configRevision: projection?.configRevision ?? internal.binding.configRevision,
    bindingRevision: projection?.bindingRevision ?? internal.binding.bindingRevision,
    concreteConnection: snapshotConnection(connection) ?? undefined,
    agentConfig: projection?.config ?? null,
    ...cognition,
  };
}

function runtimeInputRevisions(snapshot: RuntimeSnapshot): RuntimeInputRevisionSetV1 {
  type Entry = { readonly revision: string; readonly digest: string };
  const revision = (entries: readonly Entry[]): string | null => {
    if (entries.length === 0) return null;
    if (entries.length === 1) return entries[0].revision;
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  };
  const revisions = snapshot.inputRevisionSet;
  return {
    target: revision(revisions.target),
    chat: revision(revisions.chat),
    message: revision(revisions.messages),
    preset: revision(revisions.preset),
    block: revision(revisions.blocks),
    config: revision(revisions.config),
    binding: revision(revisions.slotBinding),
    connection: revision(revisions.connection),
    endpoint: revision(revisions.endpoint),
    credential: revision(revisions.credential),
    persona: revision(revisions.participants),
    character: revision(revisions.participants),
    group: revision(revisions.participants),
    world: revision(revisions.worldLore),
    lore: revision(revisions.worldLore),
    settings: revision(revisions.settings),
    macro: revision(revisions.variables),
    regex: revision(revisions.regex),
    context: revision(revisions.context),
    acl: revision(revisions.acl),
    cognition: revision(revisions.cognition),
    readiness: revision(revisions.readiness),
  };
}

type RevisionMember = { readonly kind?: unknown; readonly id?: unknown };

/** Exact `kind:id` lookup so COMMIT compares every named member, not a constant. */
function indexSnapshotRevisions(snapshot: RuntimeSnapshot): ReadonlyMap<string, { revision: string; digest: string }> {
  const index = new Map<string, { revision: string; digest: string }>();
  for (const entry of snapshot.inputRevisionSet.entries) {
    index.set(`${entry.kind}:${entry.id}`, { revision: entry.revision, digest: entry.digest });
  }
  return index;
}

function makeRevisionReader(snapshotInputValue: GenerationAssemblySnapshotInputV1) {
  return (member: RevisionMember, db?: Database): { revision: string; digest: string } | null => {
    if (typeof member?.kind !== "string" || typeof member?.id !== "string") return null;
    // Never retain the commit-preflight snapshot as the revision authority.
    // COMMIT supplies its transaction handle so this read observes the same
    // SQLite fence that protects the subsequent delta/message writes.
    const revisionDb = db ?? getDb();
    let liveInput = snapshotInputValue;
    const frozenConcreteId = typeof snapshotInputValue.concreteConnection?.concreteId === "string"
      ? snapshotInputValue.concreteConnection.concreteId
      : null;
    if (snapshotInputValue.presetId) {
      const configRow = revisionDb.query(
        "SELECT config_revision, binding_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ? LIMIT 1",
      ).get(snapshotInputValue.userId, snapshotInputValue.presetId) as { config_revision?: unknown; binding_revision?: unknown } | null;
      if (!configRow) return null;
      liveInput = {
        ...liveInput,
        configRevision: configRow.config_revision as number | string,
        bindingRevision: configRow.binding_revision as number | string,
      };
    }
    if (snapshotInputValue.connectionId || frozenConcreteId) {
      let liveConnection: FrozenConcreteConnectionV1 | null = null;
      try {
        liveConnection = normalizeConcreteConnection(resolveConcreteConnectionV1(
          snapshotInputValue.userId,
          snapshotInputValue.connectionId ?? undefined,
          frozenConcreteId ?? null,
        ));
      } catch {
        liveConnection = null;
      }
      // A roulette/router candidate is frozen for the frame. A changed
      // candidate is a revision mismatch, never an implicit reroll.
      if (frozenConcreteId && liveConnection?.concreteId !== frozenConcreteId) return null;
      liveInput = {
        ...liveInput,
        concreteConnection: snapshotConnection(liveConnection) ?? undefined,
      };
    }
    const liveSnapshot = buildGenerationAssemblySnapshot({
      ...liveInput,
      db: revisionDb,
      useTransaction: false,
    });
    return indexSnapshotRevisions(liveSnapshot).get(`${member.kind}:${member.id}`) ?? null;
  };
}
/** Stable canonical encoding used to compare an applied delta with a frozen one. */
function canonicalDelta(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item
  )) ?? "";
}

/**
 * Only a delta that the frozen plan or the validated render preparation already
 * produced may be applied, and its source identity must exist in the frozen
 * snapshot. Every other delta — including every absent kind — is denied.
 */
function makeDeltaAuthorizer(
  snapshot: RuntimeSnapshot,
  frozen: readonly unknown[],
): (delta: unknown) => boolean {
  const allowed = new Set(frozen.map(canonicalDelta));
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message] as const));
  const entryIds = new Set(snapshot.worldInfo.entries.map((entry) => entry.id));
  const scriptIds = new Set(snapshot.regexScripts.map((script) => script.id));
  return (delta: unknown): boolean => {
    if (!delta || typeof delta !== "object") return false;
    if (!allowed.has(canonicalDelta(delta))) return false;
    const record = delta as Record<string, unknown>;
    if (typeof record.sourceMessageId === "string") {
      const message = messagesById.get(record.sourceMessageId);
      if (!message) return false;
      if (record.swipeId !== undefined && record.swipeId !== message.swipe_id) return false;
    } else if (record.swipeId !== undefined) {
      return false;
    }
    if (typeof record.entryId === "string" && !entryIds.has(record.entryId)) return false;
    if (typeof record.scriptId === "string" && !scriptIds.has(record.scriptId)) return false;
    return true;
  };
}

function sameDeltaRevision(expected: number | string | undefined, actual: unknown): boolean {
  return expected === undefined || String(expected) === String(actual);
}

function applyRegexActionDeltaV1(
  db: Database,
  userId: string,
  delta: RegexActionDeltaV1,
): void {
  const row = db.query(
    "SELECT id, disabled, updated_at FROM regex_scripts WHERE id = ? AND user_id = ? LIMIT 1",
  ).get(delta.scriptId, userId) as { id?: string; disabled?: number; updated_at?: number | string } | null;
  if (!row || !sameDeltaRevision(delta.expectedRevision, row.updated_at)) {
    throw new Error("regex_action_revision_conflict");
  }
  if (delta.operation !== "disable") return;
  const currentUpdatedAt = typeof row.updated_at === "number" ? row.updated_at : Number(row.updated_at ?? 0);
  const nextUpdatedAt = Math.max(
    Number.isSafeInteger(currentUpdatedAt) ? currentUpdatedAt + 1 : 0,
    Math.floor(Date.now() / 1000),
  );
  const result = db.query(
    "UPDATE regex_scripts SET disabled = 1, updated_at = ? WHERE id = ? AND user_id = ? AND updated_at = ?",
  ).run(nextUpdatedAt, delta.scriptId, userId, row.updated_at ?? null);
  if (result.changes !== 1) throw new Error("regex_action_revision_conflict");
}

function applyWorldInfoStateDeltaV1(
  db: Database,
  userId: string,
  delta: WorldInfoStateDeltaV1,
  metadata: Record<string, unknown>,
): void {
  const entry = db.query(
    `SELECT e.id, e.uid, e.revision
       FROM world_book_entries e
       JOIN world_books b ON b.id = e.world_book_id
      WHERE e.id = ? AND b.user_id = ?
      LIMIT 1`,
  ).get(delta.entryId, userId) as { id?: string; uid?: string; revision?: number | string } | null;
  if (!entry || typeof entry.uid !== "string" || !sameDeltaRevision(delta.expectedRevision, entry.revision)) {
    throw new Error("world_info_state_revision_conflict");
  }
  if (
    (delta.operation === "activate" && (delta.state !== "active" || !delta.afterState.active))
    || (delta.operation === "deactivate" && (delta.state !== "inactive" || delta.afterState.active))
    || (delta.operation === "set_cooldown" && (delta.state !== "cooldown" || delta.afterState.active))
  ) {
    throw new Error("world_info_state_transition_mismatch");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("world_info_state_metadata_unavailable");
  }
  const currentState = metadata.wi_state && typeof metadata.wi_state === "object" && !Array.isArray(metadata.wi_state)
    ? { ...(metadata.wi_state as Record<string, unknown>) }
    : {};
  currentState[entry.uid] = {
    active: delta.afterState.active,
    stickyLeft: delta.afterState.stickyLeft,
    cooldownLeft: delta.afterState.cooldownLeft,
    delayCount: delta.afterState.delayCount,
  };
  metadata.wi_state = currentState;
}

/**
 * Only the ASSEMBLE plan's own deferred deltas are authority. Including the
 * render preparation's output here would make authorization tautological: the
 * value being checked would also be the source of the allowance.
 */
function frozenDeltas(plan: RuntimePlan): RuntimePlan["deltas"] {
  return plan.deltas;
}

/**
 * Every root, child, and render provider dispatch goes through here, so the
 * provider admission permit is taken once around the whole stream and released
 * exactly once when iteration settles.
 */
function connectionIdentity(connection: FrozenConcreteConnectionV1): string {
  return [
    connection.logicalId ?? "",
    connection.concreteId ?? "",
    connection.provider ?? "",
    connection.model ?? "",
    connection.effectiveEndpoint ?? "",
    connection.endpointRevision ?? "",
    connection.credentialRevision ?? "",
    connection.candidateRevision ?? "",
    connection.fingerprint ?? "",
  ].join("\u0000");
}
function frozenCredentialFor(
  execution: RuntimeExecution,
  connection: FrozenConcreteConnectionV1,
): string {
  const value = execution.credentialCarrier.get(connectionIdentity(connection));
  if (value === undefined) throw new AgenticGenerationError(
    "decision_refresh_required",
    "Frozen provider credential is unavailable.",
    { phase: "ASSEMBLE", retryable: true },
  );
  return value;
}

async function freezeConnectionCredentials(
  userId: string,
  connections: readonly FrozenConcreteConnectionV1[],
): Promise<Map<string, string>> {
  const carrier = new Map<string, string>();
  const seen = new Set<string>();
  for (const connection of connections) {
    const identity = connectionIdentity(connection);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (!connection.credentialSecretRef || connection.credentialRevision === null) {
      carrier.set(identity, "");
      continue;
    }
    try {
      const value = await secretsSvc.getSecretAtRevision(
        userId,
        connection.credentialSecretRef,
        String(connection.credentialRevision),
      );
      carrier.set(identity, value ?? "");
    } catch (error) {
      if (error instanceof Error && error.message === "credential_revision_mismatch") {
        throw new AgenticGenerationError(
          "decision_refresh_required",
          "Provider credential changed after runtime admission.",
          { phase: "ASSEMBLE", retryable: true, cause: error },
        );
      }
      throw error;
    }
  }
  return carrier;
}

async function providerStream(
  userId: string,
  connection: FrozenConcreteConnectionV1,
  request: GenerationRequest,
  frozenCredential: string,
  ledger?: AgentRuntimeOwner["ledger"],
): Promise<AsyncIterable<StreamChunk>> {
  const providerName = connection.provider;
  const endpoint = connection.effectiveEndpoint;
  if (!providerName || !endpoint || !connection.model) throw new Error("provider_unavailable");
  const provider = getProvider(providerName);
  if (!provider) throw new Error("provider_unavailable");

  const reservations = ledger?.reserveProviderDispatch();
  if (ledger && !reservations) throw new Error("agentic_admission_capacity_exceeded");
  const permit = ledger
    ? ledger.acquireProviderPermit()
    : AGENT_RUNTIME_ADMISSION_MANAGER.tryAcquireProvider(userId);
  if (!permit) {
    reservations?.logical.release();
    reservations?.physical.release();
    throw new Error("agentic_admission_capacity_exceeded");
  }
  reservations?.logical.consume();
  reservations?.physical.consume();

  let upstream: AsyncIterator<StreamChunk> | undefined;
  let released = false;
  let started = false;
  const onAbort = (): void => {
    // An async generator does not run its finally block when return() is
    // called before its first next(). Release here, while the request signal
    // prevents the provider from starting a network request later.
    if (!started) {
      release();
      void Promise.resolve(upstream?.return?.()).catch(() => undefined);
    }
  };
  const release = (): void => {
    if (released) return;
    released = true;
    request.signal?.removeEventListener("abort", onAbort);
    if (ledger) ledger.releaseOperationPermit(permit);
    else permit.release();
  };
  try {
    if (request.signal?.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
    const key = frozenCredential;
    const stream = provider.generateStream(key, endpoint, request);
    upstream = stream[Symbol.asyncIterator]();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const wrapped: AsyncIterableIterator<StreamChunk> = {
      [Symbol.asyncIterator](): AsyncIterableIterator<StreamChunk> {
        return this;
      },
      next(value?: unknown): Promise<IteratorResult<StreamChunk>> {
        started = true;
        return Promise.resolve(upstream!.next(value)).then(
          (result) => {
            if (result.done) release();
            return result;
          },
          (error: unknown) => {
            release();
            throw error;
          },
        );
      },
      return(value?: unknown): Promise<IteratorResult<StreamChunk>> {
        const result = upstream?.return
          ? upstream.return(value)
          : Promise.resolve({ done: true, value } as IteratorResult<StreamChunk>);
        return Promise.resolve(result).finally(release);
      },
      throw(error?: unknown): Promise<IteratorResult<StreamChunk>> {
        const result = upstream?.throw
          ? upstream.throw(error)
          : Promise.reject(error);
        return Promise.resolve(result).finally(release);
      },
    };
    return wrapped;
  } catch (error) {
    release();
    throw error;
  }
}
function serializedBytes(value: unknown): number {
  try {
    return canonicalPlainDataBounds(value, { maxBytes: MAX_OUTPUT_BYTES }).bytes;
  } catch (error) {
    throw new AgenticWorkPhaseError(
      error instanceof CanonicalDataError && error.code === "limit_exceeded"
        ? "limit_exceeded"
        : "provider_protocol_error",
      "Provider stream metadata is malformed or exceeds its bounded carrier",
    );
  }
}
async function collectProviderResponse(
  stream: AsyncIterable<StreamChunk>,
  receiveLimitBytes: number,
  ledger: AgentRuntimeOwner["ledger"] | undefined,
  chargeChildOutput: boolean,
): Promise<GenerationResponse> {
  if (!Number.isSafeInteger(receiveLimitBytes) || receiveLimitBytes <= 0) {
    throw new AgenticWorkPhaseError("limit_exceeded", "Provider receive limit is invalid");
  }
  const limit = Math.min(MAX_OUTPUT_BYTES, receiveLimitBytes);
  let receivedBytes = 0;
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let toolCalls: GenerationResponse["tool_calls"];
  let thinkingBlocks: GenerationResponse["thinking_blocks"];
  let reasoningDetails: GenerationResponse["reasoning_details"];
  let providerTransientCarrier: GenerationResponse["providerTransientCarrier"];
  let usage: GenerationResponse["usage"];
  for await (const chunk of stream) {
    if (chunk.token !== undefined && typeof chunk.token !== "string") {
      throw new AgenticWorkPhaseError("provider_protocol_error", "Provider token is malformed");
    }
    if (chunk.reasoning !== undefined && typeof chunk.reasoning !== "string") {
      throw new AgenticWorkPhaseError("provider_protocol_error", "Provider reasoning is malformed");
    }
    const token = chunk.token ?? "";
    const reasoningChunk = chunk.reasoning ?? "";
    const tokenBytes = UTF8_ENCODER.encode(token).byteLength;
    const reasoningChunkBytes = UTF8_ENCODER.encode(reasoningChunk).byteLength;
    const finishBytes = chunk.finish_reason === undefined
      ? 0
      : serializedBytes(chunk.finish_reason);
    const privateChunkBytes = [
      chunk.tool_calls,
      chunk.thinking_blocks,
      chunk.reasoning_details,
      chunk.providerTransientCarrier,
      chunk.usage,
    ].reduce((total, value) => {
      const next = total + (value === undefined ? 0 : serializedBytes(value));
      if (!Number.isSafeInteger(next)) throw new AgenticWorkPhaseError("limit_exceeded", "Provider output size overflow");
      return next;
    }, 0);
    const nextBytes = receivedBytes + tokenBytes + reasoningChunkBytes + finishBytes + privateChunkBytes;
    if (!Number.isSafeInteger(nextBytes) || nextBytes > limit) {
      throw new AgenticWorkPhaseError("limit_exceeded", "Provider output exceeds the frozen receive limit");
    }
    // The cap is checked before any retained text or private provider state is
    // appended. A malicious stream therefore cannot bypass the frame budget by
    // omitting usage or splitting one response across many chunks.
    receivedBytes = nextBytes;
    content += token;
    reasoning += reasoningChunk;
    if (chunk.finish_reason) finishReason = chunk.finish_reason;
    if (chunk.tool_calls) toolCalls = chunk.tool_calls;
    if (chunk.thinking_blocks) thinkingBlocks = chunk.thinking_blocks;
    if (chunk.reasoning_details) reasoningDetails = chunk.reasoning_details;
    if (chunk.providerTransientCarrier) providerTransientCarrier = chunk.providerTransientCarrier;
    if (chunk.usage) usage = chunk.usage;
  }
  const response: GenerationResponse = {
    content,
    reasoning,
    finish_reason: finishReason,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(thinkingBlocks ? { thinking_blocks: thinkingBlocks } : {}),
    ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
    ...(providerTransientCarrier ? { providerTransientCarrier } : {}),
    ...(usage ? { usage } : {}),
  };
  if (ledger && chargeChildOutput) {
    let observed = 0;
    try {
      observed = observeOutputTokens(response);
    } catch {
      throw new AgenticWorkPhaseError("provider_protocol_error", "Provider child output accounting failed");
    }
    const reported = usage && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0
      ? usage.completion_tokens
      : 0;
    const amount = Math.max(observed, reported);
    if (amount > 0 && !ledger.charge("child_output_tokens", amount)) {
      throw new AgenticWorkPhaseError("child_output_limit_exceeded", "Aggregate child output token limit exceeded");
    }
  }
  return response;
}

function makeWorkProvider(
  userId: string,
  connection: FrozenConcreteConnectionV1,
  parameters: GenerationParameters | undefined,
  ledger: AgentRuntimeOwner["ledger"] | undefined,
  frozenCredential: string,
) {
  return async (request: AgenticWorkProviderRequest): Promise<GenerationResponse> => {
    const continuationMode = connection.capabilities.toolContinuationMode;
    if (continuationMode !== "native" && continuationMode !== "legacy") {
      throw new AgenticWorkPhaseError("provider_protocol_error", "Provider tool continuation is unsupported");
    }
    const generationRequest: GenerationRequest = {
      messages: [...request.messages],
      model: connection.model ?? request.model,
      parameters: { ...(parameters ?? {}), max_tokens: request.maxOutputTokens },
      tools: [...request.tools],
      stream: true,
      signal: request.signal,
      receiveLimitBytes: request.receiveLimitBytes,
      toolMode: "ordinary",
      ...(request.providerTransientCarrier
        ? { providerTransientCarrier: request.providerTransientCarrier }
        : {}),
    };
    const stream = await providerStream(userId, connection, generationRequest, frozenCredential, ledger);
    return collectProviderResponse(stream, request.receiveLimitBytes, ledger, request.frame.kind === "child");
  };
}

/**
 * The render phase owns validation and provisional publication. This adapter
 * only acquires the frozen provider stream and returns it unchanged.
 */
function makeRenderProvider(
  userId: string,
  connection: FrozenConcreteConnectionV1,
  ledger: AgentRuntimeOwner["ledger"] | undefined,
  frozenCredential: string,
) {
  return async (request: AgenticRenderProviderRequestV1): Promise<AsyncIterable<StreamChunk>> => {
    if (connection.capabilities.toolsDisabledFinalization !== true) {
      throw new AgenticRenderPhaseError("render_tool_finalization_unsupported");
    }
    const generationRequest: GenerationRequest = {
      messages: [...request.messages],
      model: connection.model ?? request.model,
      parameters: request.maxOutputTokens === undefined
        ? request.parameters
        : { ...(request.parameters ?? {}), max_tokens: request.maxOutputTokens },
      tools: [],
      stream: true,
      signal: request.signal,
      receiveLimitBytes: request.receiveLimitBytes,
      toolMode: "finalization",
      ...(request.providerTransientCarrier
        ? { providerTransientCarrier: request.providerTransientCarrier }
        : {}),
    };
    return providerStream(userId, connection, generationRequest, frozenCredential, ledger);
  };
}

function participantName(value: Readonly<Record<string, unknown>> | null, fallback: string): string {
  if (!value) return fallback;
  for (const key of ["name", "display_name", "title", "char_name", "persona_name"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return fallback;
}
function renderTargetKind(kind: AgenticGenerationInput["generationType"]): RenderTargetV1["kind"] {
  if (kind === "normal" || kind === "continue" || kind === "regenerate" || kind === "swipe") return kind;
  throw new Error("requires_response_mode");
}


function makeToolSnapshot(snapshot: RuntimeSnapshot, signal: AbortSignal): AgentToolSnapshot {
  const participants = snapshot.participants;
  const groupMembers = participants.group ?? [];
  const isGroupChat = groupMembers.length > 0;
  const charName = participantName(participants.character, "Character");
  const groupNames = groupMembers.map((member) => participantName(member, ""))
    .filter((name) => name.length > 0);
  const others = groupNames.filter((name) => name !== charName);
  const names = {
    user: participantName(participants.persona, "User"),
    char: charName,
    group: groupNames.join(", "),
    groupNotMuted: groupNames.join(", "),
    notChar: others.join(", "),
    charGroupFocused: charName,
    isGroupChat: isGroupChat ? "true" : "false",
    groupOthers: others.join(", "),
    groupMemberCount: String(groupMembers.length),
  };
  const entries = snapshot.worldInfo.entries.map((entry) => ({
    id: entry.id, world_book_id: entry.bookId, uid: entry.id, outlet_name: null, wi_marker: null,
    wi_marker_side: null, key: [...entry.keys], keysecondary: [...entry.secondaryKeys], content: entry.content,
    comment: entry.comment, position: entry.position, depth: entry.depth, role: entry.role, order_value: entry.order,
    selective: false, constant: false, disabled: false, group_name: "", group_override: false, group_weight: 0,
    probability: 100, scan_depth: null, exclude_greeting: false, case_sensitive: false, match_whole_words: false,
    automation_id: null, use_regex: false, prevent_recursion: false, exclude_recursion: false,
    delay_until_recursion: false, priority: 0, sticky: 0, cooldown: 0, delay: 0, selective_logic: 0,
    use_probability: false, vectorized: false, vector_index_status: "not_enabled" as const, vector_indexed_at: null,
    vector_index_error: null, revision: Number(entry.revision) || 0, extensions: {}, created_at: 0, updated_at: 0,
  }));
  const books = snapshot.worldInfo.books.map((book) => ({ id: book.id, name: book.name, description: book.description, source: book.source, active: true }));
  const messages: Message[] = snapshot.messages.map((message) => ({
    ...message,
    swipes: [...message.swipes],
    swipe_dates: [...message.swipe_dates],
    extra: { ...message.extra },
  }));
  return createAgentToolSnapshot({ rootUserId: snapshot.userId, chatId: snapshot.chatId, books, entries, messages, names, signal });
}

/**
 * Tool, workspace, context, and child operations all consume a tool permit.
 * The permit is released exactly once, including on failure. A supplied signal
 * is checked both before admission and immediately before the operation so a
 * cancelled turn cannot begin a durable mutation after waiting for capacity.
 */
async function withToolPermit<T>(
  userId: string,
  run: () => T | Promise<T>,
  signal?: AbortSignal,
  ledger?: AgentRuntimeOwner["ledger"],
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const permit = ledger
    ? ledger.acquireToolPermit()
    : AGENT_RUNTIME_ADMISSION_MANAGER.tryAcquireTool(userId);
  if (!permit) throw new Error("agentic_admission_capacity_exceeded");
  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return await run();
  } finally {
    if (ledger) ledger.releaseOperationPermit(permit);
    else permit.release();
  }
}

/** Race callback completion against the turn's cancellation fence. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Adopt the revision the workspace service just committed. The service advances
 * its CAS once per successful mutation; the owner mirrors that exact value
 * rather than guessing an increment.
 */
function advanceWorkspaceRevision(execution: Pick<RuntimeExecution, "workspaceRevision">, result: unknown): void {
  const envelope = result as {
    readonly result?: unknown;
    readonly cognition?: { readonly workspaceRevision?: unknown };
  } | null | undefined;
  const publicResult = envelope && Object.prototype.hasOwnProperty.call(envelope, "result")
    ? envelope.result
    : result;
  const observed = publicResult as { workspaceRevision?: unknown } | null | undefined;
  const publicRevision = typeof observed?.workspaceRevision === "number" ? observed.workspaceRevision : undefined;
  const privateRevision = typeof envelope?.cognition?.workspaceRevision === "number"
    ? envelope.cognition.workspaceRevision
    : undefined;
  if (publicRevision !== undefined && privateRevision !== undefined && publicRevision !== privateRevision) {
    throw new Error("workspace_revision_conflict");
  }
  const next = publicRevision ?? privateRevision;
  if (next === undefined || !Number.isSafeInteger(next) || next < 0) {
    throw new Error("workspace_revision_missing");
  }
  const current = execution.workspaceRevision ?? 0;
  if (next < current) throw new Error("workspace_revision_stale");
  execution.workspaceRevision = next;
}
/**
 * Adopt the workspace revision only for a WORK outcome that can continue.
 * Cancellation and timeout deliberately retain the coordinator's last
 * pre-cancellation revision; the durable row may have advanced in a raced
 * callback and must not become accepted state for the cancelled turn.
 */
function adoptWorkWorkspaceRevision(
  runtimeExecution: Pick<RuntimeExecution, "workspaceRevision" | "userId" | "chatId" | "id" | "workspaceId">,
  outcome: Pick<AgenticWorkPhaseOutcome, "status" | "workspaceRevision">,
): number {
  const cancellationOutcome = outcome.status === "cancelled" || outcome.status === "timed_out";
  const workspaceRevision = cancellationOutcome
    ? runtimeExecution.workspaceRevision
    : typeof outcome.workspaceRevision === "number"
      ? outcome.workspaceRevision
      : getCurrentWorkspaceRevisionV1({
        userId: runtimeExecution.userId,
        chatId: runtimeExecution.chatId,
        turnId: runtimeExecution.id,
        workspaceId: runtimeExecution.workspaceId,
      });
  if (!cancellationOutcome) {
    advanceWorkspaceRevision(runtimeExecution, { workspaceRevision });
    runtimeExecution.workspaceRevision = workspaceRevision;
  }
  return workspaceRevision;
}
function requireOperationKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || UTF8_ENCODER.encode(value).byteLength > 256) {
    throw new Error("workspace_operation_key_required");
  }
  return value;
}
function publicWorkspaceResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const privateKeys = new Set([
    "state", "activation", "cognition", "contextPackRequirements",
    "newlyActivatedContextPackRequirements", "sourceRevisions", "sourceDigest",
  ]);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!privateKeys.has(key)) output[key] = item;
  }
  return Object.freeze(output);
}

function workspaceEnvelope(
  value: unknown,
  cognition?: CognitionRuntimeActivationV1,
): { readonly result: unknown; readonly cognition?: Readonly<Record<string, unknown>> } {
  const result = publicWorkspaceResult(value);
  if (!cognition) return Object.freeze({ result });
  return Object.freeze({
    result,
    cognition: Object.freeze({
      workspaceRevision: cognition.workspaceRevision,
      contextPackRequirements: cognition.contextPackRequirements,
      newlyActivatedContextPackRequirements: cognition.newlyActivatedContextPackRequirements,
    }),
  });
}

function frozenWorkspaceUsage(execution: RuntimeExecution, revision: number): WorkspaceUsageV1 {
  const row = getDb().query(
    "SELECT revision, task_count, record_count, submission_count, artifact_count, byte_count FROM agent_turn_workspaces WHERE workspace_id = ? AND turn_id = ? AND user_id = ? AND chat_id = ? LIMIT 1",
  ).get(execution.workspaceId, execution.id, execution.userId, execution.chatId) as {
    revision?: unknown;
    task_count?: unknown;
    record_count?: unknown;
    submission_count?: unknown;
    artifact_count?: unknown;
    byte_count?: unknown;
  } | null;
  if (!row || Number(row.revision) !== revision) throw new Error("workspace_revision_conflict");
  const count = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("workspace_usage_invalid");
    }
    return value;
  };
  return Object.freeze({
    taskCount: count(row.task_count),
    recordCount: count(row.record_count),
    submissionCount: count(row.submission_count),
    artifactCount: count(row.artifact_count),
    byteCount: count(row.byte_count),
  });
}
function frozenWorkspaceArtifacts(execution: RuntimeExecution, revision: number): readonly WorkspaceArtifactReferenceV1[] {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("workspace_revision_invalid");
  // `attached` rows are ephemeral. Only an explicit proposal enters the
  // frozen COMMIT set; publication then promotes that approved ref.
  const rows = getDb().query(
    `SELECT artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
            byte_count, provenance_json, source_frame_id, source_task_id,
            publication_state, retention, revision, expires_at, created_at
       FROM agent_workspace_artifacts
      WHERE workspace_id = ? AND turn_id = ? AND user_id = ? AND chat_id = ?
        AND publication_state = 'proposed'
      ORDER BY artifact_id ASC`,
  ).all(execution.workspaceId, execution.id, execution.userId, execution.chatId) as Array<Record<string, unknown>>;
  return Object.freeze(rows.map((row) => {
    if (
      typeof row.artifact_id !== "string"
      || typeof row.workspace_id !== "string"
      || typeof row.turn_id !== "string"
      || typeof row.user_id !== "string"
      || typeof row.chat_id !== "string"
      || typeof row.blob_digest !== "string"
      || typeof row.mime_type !== "string"
      || typeof row.byte_count !== "number"
      || !Number.isSafeInteger(row.byte_count)
      || typeof row.publication_state !== "string"
      || row.publication_state !== "proposed"
      || typeof row.retention !== "string"
      || typeof row.revision !== "number"
      || !Number.isSafeInteger(row.revision)
      || typeof row.expires_at !== "number"
      || !Number.isSafeInteger(row.expires_at)
      || typeof row.created_at !== "number"
      || !Number.isSafeInteger(row.created_at)
    ) throw new Error("agentic_workspace_artifact_invalid");
    let provenance: WorkspaceArtifactReferenceV1["provenance"];
    try {
      const parsed: unknown = typeof row.provenance_json === "string" ? JSON.parse(row.provenance_json) : row.provenance_json;
      if (parsed !== "host" && parsed !== "root" && parsed !== "child") throw new Error("invalid provenance");
      provenance = parsed;
    } catch {
      throw new Error("agentic_workspace_artifact_invalid");
    }
    return Object.freeze({
      id: row.artifact_id,
      workspaceId: row.workspace_id,
      turnId: row.turn_id,
      userId: row.user_id,
      chatId: row.chat_id,
      blobDigest: row.blob_digest,
      mimeType: row.mime_type,
      byteCount: row.byte_count,
      provenance,
      sourceFrameId: typeof row.source_frame_id === "string" ? row.source_frame_id : null,
      sourceTaskId: typeof row.source_task_id === "string" ? row.source_task_id : null,
      publicationState: "proposed" as const,
      // COMMIT promotes a proposed workspace artifact to chat-owned data;
      // the publication contract rejects turn-terminal references.
      retention: "chat_lifetime",
      revision: row.revision,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    });
  }));
}

function makeWorkspace(
  execution: RuntimeExecution,
  capabilities: WorkspaceOperationCapabilitiesV1,
  workspaceContextBytes: number,
  cognitionRuntime?: AgentCognitionRuntimeV1,
  contextRuntime?: CoordinatorContextRuntime,
): AgenticWorkspaceCapability {
  const sanitizeWorkspaceArgs = (operationArgs: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
    Object.entries(operationArgs).filter(([key]) =>
      key !== "userId" && key !== "chatId" && key !== "turnId" && key !== "workspaceId"
      && key !== "actor" && key !== "frameId" && key !== "expectedRevision"
      && key !== "revision" && key !== "capabilities" && key !== "fieldCapabilities"
      && key !== "operationKey"
      // Cognition/context metadata is host output, never model input.
      && key !== "cognition" && key !== "contextPackRequirements"
      && key !== "newlyActivatedContextPackRequirements"
      && key !== "activation" && key !== "sourceRevisions" && key !== "sourceDigest"),
  );
  const registerFrame = (frame: AgenticWorkFrame): void => {
    if (frame.kind !== "child") return;
    if (!frame.frameId || frame.parentFrameId !== execution.id) throw new Error("workspace_frame_scope_mismatch");
    const allowed = capabilities.allowed.filter((operation) => frame.workspaceCapabilities.has(operation));
    freezeFrameCapabilities({
      userId: execution.userId,
      chatId: execution.chatId,
      turnId: execution.id,
      workspaceId: execution.workspaceId,
      frameId: frame.frameId,
      capabilities: {
        revision: capabilities.revision,
        allowed,
        maxOperationBytes: capabilities.maxOperationBytes,
        maxOperations: capabilities.maxOperations,
      },
    });
  };
  const context = (
    frame: AgenticWorkFrame,
    operationArgs: Record<string, unknown> = {},
    expectedRevision = execution.workspaceRevision ?? 0,
  ): Record<string, unknown> => {
    registerFrame(frame);
    return {
      userId: execution.userId,
      chatId: execution.chatId,
      turnId: execution.id,
      workspaceId: execution.workspaceId,
      actor: frame.kind,
      ...(frame.kind === "child" ? { frameId: frame.frameId } : {}),
      expectedRevision,
      ...sanitizeWorkspaceArgs(operationArgs),
    };
  };
  const rootContext = (
    operationArgs: Record<string, unknown> = {},
    expectedRevision = execution.workspaceRevision ?? 0,
  ): Record<string, unknown> => ({
    userId: execution.userId,
    chatId: execution.chatId,
    turnId: execution.id,
    workspaceId: execution.workspaceId,
    actor: "root",
    expectedRevision,
    ...sanitizeWorkspaceArgs(operationArgs),
  });
  const authenticatedContext = (
    actor: "root" | "child",
    frameId: string | undefined,
    operationArgs: Record<string, unknown>,
    expectedRevision: number,
  ): Record<string, unknown> => {
    if (actor === "child" && !frameId) throw new Error("workspace_frame_missing");
    return {
      userId: execution.userId,
      chatId: execution.chatId,
      turnId: execution.id,
      workspaceId: execution.workspaceId,
      actor,
      ...(actor === "child" && frameId ? { frameId } : {}),
      expectedRevision,
      ...sanitizeWorkspaceArgs(operationArgs),
    };
  };
  const applyCognitionWorkspaceTransition = cognitionRuntime
    ? async (input: CognitionRuntimeTaskTransitionInputV1): Promise<unknown> => {
      const rawWorkspace = input.workspace && typeof input.workspace === "object" && !Array.isArray(input.workspace)
        ? input.workspace as Record<string, unknown>
        : {};
      const actor = rawWorkspace.actor === "child" ? "child" : "root";
      if ((input.operation === "create_task" || input.operation === "accept_submission") && actor !== "root") {
        throw new Error("workspace_actor_forbidden");
      }
      const frameId = typeof rawWorkspace.frameId === "string" ? rawWorkspace.frameId : undefined;
      const operationKey = requireOperationKey(input.operationKey);
      const result = await withToolPermit(
        execution.userId,
        () => cognitionRuntime.applyWorkspaceTransition({
          ...input,
          operationKey,
          workspace: authenticatedContext(actor, frameId, rawWorkspace, execution.workspaceRevision ?? 0),
        }),
        input.signal,
        execution.owner.ledger,
      );
      advanceWorkspaceRevision(execution, result);
      return workspaceEnvelope(
        {
          workspaceRevision: result.workspaceRevision,
          taskId: result.taskId,
          transition: result.transition,
          materializedTaskIds: result.materializedTaskIds,
          ...(result.operationKey ? { operationKey: result.operationKey } : {}),
        },
        result.cognition,
      );
    }
    : undefined;
  const acceptCompletionFixedPoint = cognitionRuntime
    ? async (input: {
      readonly frame: AgenticWorkFrame;
      readonly completion: { readonly summary: string; readonly unresolvedIds: readonly string[]; readonly renderGuidance?: string };
      readonly expectedRevision?: number;
      readonly operationKey?: string;
      readonly signal: AbortSignal;
      readonly prepareAcceptance?: (result: {
        readonly accepted: boolean;
        readonly workspaceRevision: number;
        readonly cognition?: CognitionRuntimeCompletionV1;
      }) => AgenticWorkspacePreparationResult;
    }): Promise<{
      readonly accepted: boolean;
      readonly workspaceRevision: number;
      readonly code?: string;
      readonly cognition?: CognitionRuntimeCompletionV1;
      readonly workspaceContextProjection?: AgenticWorkspaceCompletionFixedPointResult["workspaceContextProjection"];
    }> => {
      const expectedRevision = input.expectedRevision ?? execution.workspaceRevision ?? 0;
      const operationKey = requireOperationKey(input.operationKey);
      const result = await abortable(withToolPermit(
        execution.userId,
        () => cognitionRuntime.acceptCompletionFixedPoint({
          operationKey,
          signal: input.signal,
          workspace: context(input.frame, {
            completionSummary: input.completion.summary,
            completionUnresolvedIds: input.completion.unresolvedIds,
            ...(input.completion.renderGuidance ? { completionRenderGuidance: input.completion.renderGuidance } : {}),
          }, expectedRevision),
          ...(input.prepareAcceptance ? {
            prepareAcceptance: (completion) => {
              const prepared = input.prepareAcceptance!({
                accepted: completion.accepted,
                workspaceRevision: completion.workspaceRevision,
                cognition: completion,
              });
              if (
                !isRecord(prepared)
                || prepared.acknowledged !== true
                || !Object.prototype.hasOwnProperty.call(prepared, "bundle")
              ) {
                throw new Error("completion_handoff_not_acknowledged");
              }
              return Object.freeze({
                candidate: completion,
                bundle: prepared.bundle,
              });
            },
          } : {}),
        }),
        input.signal,
        execution.owner.ledger,
      ), input.signal);
      if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
      advanceWorkspaceRevision(execution, result);
      const preparedFixedPoint = result.preparedAcceptance?.bundle as AgenticWorkspaceCompletionFixedPointResult | undefined;
      const { preparedAcceptance: _preparedAcceptance, ...publicCognition } = result;
      return {
        accepted: result.accepted,
        workspaceRevision: result.workspaceRevision,
        ...(result.accepted ? {} : { code: "completion_blocked" }),
        cognition: Object.freeze(publicCognition) as CognitionRuntimeCompletionV1,
        ...(preparedFixedPoint?.workspaceContextProjection
          ? { workspaceContextProjection: preparedFixedPoint.workspaceContextProjection }
          : {}),
      };
    }
    : undefined;
  return {
    authenticateFrame: registerFrame,
    getCompletionGates: ({ frame }) => getWorkspaceCompletionGatesV1(context(frame)),
    listRequiredOpenTasks: ({ frame }) => {
      const gates = getWorkspaceCompletionGatesV1(context(frame));
      return Array.from({ length: gates.openRequiredTaskIds.length }, () => ({}));
    },
    getUnacceptedSubmissions: ({ frame }) => {
      const gates = getWorkspaceCompletionGatesV1(context(frame));
      return Array.from({ length: gates.pendingSubmissionCount }, () => ({}));
    },
    projectContext: ({ expectedRevision }) => {
      const persistedRevision = execution.workspaceRevision ?? 0;
      const sourceWorkspaceRevision = expectedRevision ?? persistedRevision;
      if (sourceWorkspaceRevision !== persistedRevision && sourceWorkspaceRevision !== persistedRevision + 1) {
        throw new Error("workspace_projection_revision_mismatch");
      }
      return buildWorkspaceContextProjectionFromWorkspaceV1({
        userId: execution.userId,
        chatId: execution.chatId,
        turnId: execution.id,
        workspaceId: execution.workspaceId,
        expectedRevision: persistedRevision,
        sourceWorkspaceRevision,
      }, { reservedBytes: workspaceContextBytes });
    },
    ...(acceptCompletionFixedPoint ? { acceptCompletionFixedPoint } : {}),
    ...(applyCognitionWorkspaceTransition ? { applyCognitionWorkspaceTransition } : {}),
    preparesCompletionBeforeAcceptance: true,
    execute: async (operation, args, toolContext) => {
      const raw = context(toolContext.frame, args);
      if (operation === "read_section" || operation === "read_page") {
        return workspaceEnvelope(await withToolPermit(
          execution.userId,
          () => readTurnWorkspaceSection(raw),
          toolContext.signal,
          execution.owner.ledger,
        ));
      }
      const result = await withToolPermit(execution.userId, async () => {
        if (operation === "create_task") return createWorkspaceTask(raw);
        if (operation === "update_assigned_progress") return updateWorkspaceTaskProgress(raw);
        if (operation === "submit_child_result") return submitWorkspaceChildResult(raw);
        if (operation === "accept_submission") {
          const { taskId: _taskId, ...submissionInput } = raw;
          return acceptWorkspaceSubmission(submissionInput);
        }
        if (operation === "record_finding" || operation === "record_decision" || operation === "record_question") return recordWorkspaceRecord(raw);
        if (operation === "attach_artifact") return attachWorkspaceArtifactReference(raw);
        return proposeWorkspacePublication(raw);
      }, toolContext.signal, execution.owner.ledger);
      if (toolContext.signal.aborted) throw toolContext.signal.reason ?? new DOMException("Aborted", "AbortError");
      // Every mutating operation normally commits one workspace CAS revision.
      // Accepting an already-accepted submission is the canonical idempotent
      // no-op, so its post-mutation row may still carry the prior revision.
      const expectedRevision = (execution.workspaceRevision ?? 0) + 1;
      let gates: ReturnType<typeof getWorkspaceCompletionGatesV1>;
      try {
        gates = getWorkspaceCompletionGatesV1(context(toolContext.frame, {}, expectedRevision));
      } catch (error) {
        if (operation !== "accept_submission" || !(error instanceof TurnWorkspaceError) || error.code !== "stale_revision") throw error;
        gates = getWorkspaceCompletionGatesV1(context(toolContext.frame, {}, execution.workspaceRevision ?? 0));
      }
      const workspaceRevision = gates.workspaceRevision;
      advanceWorkspaceRevision(execution, { workspaceRevision });
      const publicResult = isRecord(result)
        ? { ...result, workspaceRevision }
        : { result, workspaceRevision };
      return workspaceEnvelope(publicResult);
    },
    assignChildTasks: async ({ frame, assignments, expectedRevision, signal }) => {
      if (signal.aborted) throw signal.reason ?? new Error("workspace_assignment_cancelled");
      const rootFrame =
        frame.kind === "root"
        && frame.parentFrameId === null
        && frame.frameId === execution.id
        && frame.signal === signal
        ? frame
        : undefined;
      if (!rootFrame) throw new Error("workspace_assignment_root_required");
      const expected = expectedRevision ?? execution.workspaceRevision ?? 0;
      const result = await abortable(Promise.resolve(withToolPermit(execution.userId, () => assignWorkspaceChildTasks({
        ...context(rootFrame, { assignments }, expected),
      }), signal, execution.owner.ledger)), signal);
      if (signal.aborted) throw signal.reason ?? new Error("workspace_assignment_cancelled");
      if (result.tasks.length !== assignments.length) {
        throw new Error("workspace_assignment_mismatch");
      }
      const persistedAssignments = result.tasks.map((task, index) => {
        const requested = assignments[index];
        if (!requested || task.id !== requested.taskId || task.assignedFrameId !== requested.frameId) {
          throw new Error("workspace_assignment_mismatch");
        }
        if (!task.assignedFrameId) throw new Error("workspace_assignment_missing_frame");
        return { taskId: task.id, frameId: task.assignedFrameId };
      });
      if (signal.aborted) throw signal.reason ?? new Error("workspace_assignment_cancelled");
      advanceWorkspaceRevision(execution, result);
      return {
        accepted: true,
        workspaceRevision: result.workspaceRevision,
        assignments: persistedAssignments,
      };
    },
    freezeForCompletion: async ({ frame, expectedRevision, signal, prepareAcceptance }) => {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const expected = expectedRevision ?? execution.workspaceRevision ?? 0;
      let preparedFixedPoint: AgenticWorkspaceCompletionFixedPointResult | undefined;
      const frozen = await withToolPermit(execution.userId, () => freezeWorkspaceForCompletionV1(
        context(frame, {}, expected),
        prepareAcceptance ? {
          prepare: (candidate) => {
            if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
            const prepared = prepareAcceptance(candidate);
            if (prepared === true) return true;
            if (!isRecord(prepared) || prepared.acknowledged !== true) return false;
            preparedFixedPoint = prepared.bundle as AgenticWorkspaceCompletionFixedPointResult;
            return true;
          },
        } : undefined,
      ), signal, execution.owner.ledger);
      advanceWorkspaceRevision(execution, frozen);
      return {
        ...frozen,
        ...(preparedFixedPoint?.workspaceContextProjection
          ? { workspaceContextProjection: preparedFixedPoint.workspaceContextProjection }
          : {}),
      };
    },
  };
}

function boundedProviderUsage(
  value: Readonly<Record<string, number>> | undefined,
): { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number } | undefined {
  if (!value) return undefined;
  const promptTokens = value.promptTokens;
  const completionTokens = value.completionTokens;
  const totalTokens = value.totalTokens;
  if (
    !Number.isSafeInteger(promptTokens)
    || !Number.isSafeInteger(completionTokens)
    || !Number.isSafeInteger(totalTokens)
    || promptTokens < 0
    || completionTokens < 0
    || totalTokens < 0
    || promptTokens > Number.MAX_SAFE_INTEGER - completionTokens
    || totalTokens !== promptTokens + completionTokens
  ) {
    return undefined;
  }
  return Object.freeze({ promptTokens, completionTokens, totalTokens });
}
function prepareInput(
  input: AgenticGenerationInput,
  execution: RuntimeExecution,
  snapshot: RuntimeSnapshot,
  plan: RuntimePlan,
  render: { content: string },
  binding: LiveTargetBinding,
): RenderPreparationInputV1 {
  const sourceMessages: FrozenSourceMessageV1[] = snapshot.messages.map((message) => ({
    sourceMessageId: message.id,
    revision: message.revision,
    role: message.is_user ? "user" : "assistant",
    content: { kind: "text", text: message.content },
    // Stable active-swipe identity travels with the frozen message so a pure
    // source-message delta can only ever address the exact slot it read.
    swipeId: message.swipe_id,
    ...(message.name ? { authorName: message.name } : {}),
  }));
  const targetMessage = binding.messageId
    ? snapshot.messages.find((message) => message.id === binding.messageId)
    : null;
  const swipes: FrozenSwipeV1[] = targetMessage
    ? targetMessage.swipes.map((content, index) => ({ swipeId: String(index), index, revision: targetMessage.revision, content: { kind: "text", text: content } }))
    : [];
  const isAppendSwipe = targetMessage !== null
    && (binding.target === "swipe" || binding.target === "regenerate")
    && binding.swipeId !== null
    && binding.swipeCount !== null
    && binding.swipeId === binding.swipeCount
    && binding.swipeId === swipes.length;
  if (isAppendSwipe && targetMessage) {
    swipes.push({
      swipeId: String(binding.swipeId),
      index: binding.swipeId,
      revision: targetMessage.revision,
      content: { kind: "text", text: "" },
      slot: "append",
    });
  }
  const pairs = (value: unknown): readonly [string, string][] => isRecord(value)
    ? Object.entries(value).map(([key, item]): [string, string] => [key, typeof item === "string" ? item : JSON.stringify(item) ?? ""])
    : [];
  const macroSnapshot: RenderMacroSnapshotV1 = { local: [], global: pairs(snapshot.variables.settings), chat: pairs(snapshot.variables.chat), promptVariables: pairs(snapshot.variables.preset) };
  const regexScripts: FrozenRegexScriptV1[] = snapshot.regexScripts.map((script) => ({
    scriptId: script.id, revision: script.revision, pattern: script.findRegex, replacement: script.replaceString,
    flags: script.flags, stage: "response", enabled: script.disabled === false, order: script.sortOrder,
  }));
  const target: RenderTargetV1 = {
    kind: renderTargetKind(binding.target),
    ...(binding.messageId ? { messageId: binding.messageId } : {}),
    ...(binding.swipeId !== null ? { swipeId: binding.swipeId } : {}),
  };
  return {
    version: 1, operation: "prepare_agent_render", requestId: `prepare:${execution.id}`, limits: snapshot.limits,
    turnId: execution.id, target, content: { kind: "text", text: render.content },
    sourceMessages, swipes, macroSnapshot, regexScripts,
    formatting: { stripGuidedReasoning: true, healFormatting: true, preserveProviderReasoning: true },
    inputRevisions: plan.inputRevisions,
    deltas: plan.deltas,
  };
}
/** Narrow a review reason to the closed cognition repair vocabulary. */
function isCognitionRepairCode(value: string): value is CognitionRepairCode {
  return (COGNITION_REPAIR_CODES as readonly string[]).includes(value);
}

function installDecisionAuthorities(): void {
  if (decisionAuthoritiesInstalled) return;
  configureAgentRuntimeDecisionDependencies({
    getPresetAgentConfig: (userId, presetId) => getPresetAgentConfig(userId, presetId),
    getInputRevisions: (userId, request, context) => {
      const key = preflightRequestKey(userId, request);
      preflightSnapshots.delete(key);
      if (request.mode !== "agentic") return request.inputRevisions ?? {};
      const target = context.target;
      const presetId = context.preset?.id ?? request.presetId ?? null;
      // The canonical projection's review state is the durable cognition
      // authority: a repair-required row must keep Agentic closed even when
      // the snapshot below cannot be built. Both reads stay inside the try so
      // an authority failure still degrades to Response instead of 500.
      let reviewState: AgentConfigStateV1 | null = null;
      let reviewCode: string | null = null;
      try {
        const projection = presetId
          ? getPresetAgentConfig(userId, presetId) as PresetAgentConfigProjection | null
          : null;
        reviewState = projection?.review.state ?? null;
        reviewCode = projection?.review.reasonCode ?? null;
        // Preflight must read the canonical stored V2 config, not the normalized
        // gate projection: cognition, context policy, and attachment selections
        // change which packs and revisions this turn depends on.
        const canonicalConfig = projection?.config ?? null;
        const cognition = cognitionSnapshotInputs(userId, presetId, canonicalConfig);
        const snapshot = buildGenerationAssemblySnapshot({
          userId,
          chatId: request.chatId,
          // Keep the revision-bearing runtime epoch identical to ASSEMBLE.
          // The request epoch is already bound by the one-use decision token;
          // using a different generation label here would manufacture a stale
          // revision before the first provider call.
          generationId: `agentic:${request.chatId}:${target.generationType}:${target.messageId ?? "new"}`,
          generationType: target.generationType,
          connectionId: context.rootConnection?.logicalId ?? context.rootConnection?.concreteId ?? request.logicalConnectionId ?? null,
          presetId,
          personaId: request.personaId ?? null,
          targetCharacterId: target.targetCharacterId ?? request.targetCharacterId ?? null,
          targetMessageId: target.messageId ?? null,
          targetSwipeId: target.swipeId ?? null,
          userInput: "",
          toolIds: authoredToolIds(canonicalConfig),
          configRevision: projection?.configRevision ?? null,
          bindingRevision: projection?.bindingRevision ?? null,
          concreteConnection: snapshotConnection(context.rootConnection ?? null) ?? undefined,
          agentConfig: canonicalConfig,
          ...cognition,
        });
        preflightSnapshots.set(key, { snapshot, reviewState, reviewCode });
        return runtimeInputRevisions(snapshot);
      } catch {
        // A snapshot, context, or ACL failure must leave preflight incomplete so
        // the decision degrades to Response. It is never a request error. The
        // review state survives so repair-required cognition still closes
        // Agentic with its stable repair reason.
        preflightSnapshots.set(key, { snapshot: null, reviewState, reviewCode });
        return null;
      }
    },
    getReadinessVector: (userId, request, context) => {
      const key = preflightRequestKey(userId, request);
      const record = preflightSnapshots.get(key);
      preflightSnapshots.delete(key);
      const snapshot = record?.snapshot ?? null;
      const status = getAgenticReadiness();
      const runtimeEpoch = getRuntimeEpoch();
      const root = context.rootConnection;
      const capabilities = root?.capabilities ?? {};
      // Canonical `ProviderCapabilities` keys. Generation is implicit in the
      // adapter contract; every other requirement is declared explicitly.
      const streamingReady = capabilities.supportsStreaming === true;
      const toolCallingReady = capabilities.toolCalling === true;
      const continuationReady =
        (capabilities.nativeToolContinuation === true && capabilities.toolContinuationMode === "native")
        || (capabilities.toolCalling === true && capabilities.toolContinuationMode === "legacy");
      const finalizationReady = capabilities.toolsDisabledFinalization === true;
      // Provider/configuration readiness is request-local. Startup intentionally
      // does not assert a global provider candidate because roulette and aliases
      // are verified only after this request's concrete snapshot is frozen.
      const providerReady = streamingReady && toolCallingReady && continuationReady && finalizationReady;
      const configReady = context.config !== undefined && context.config !== null;
      // Context readiness is only true when the frozen candidate set is owned by
      // this user and every required pack carries complete revision identity.
      const packs = snapshot?.contextPacks;
      const contextReady = !!packs
        && packs.schema === "present"
        && packs.candidates.every((candidate) => (
          candidate.ownerId === userId
          && (!candidate.required || (
            typeof candidate.revisionId === "string" && candidate.revisionId.length > 0
            && typeof candidate.digest === "string" && candidate.digest.length > 0
            && candidate.aclRevision !== null && candidate.aclRevision !== undefined
          ))
        ));
      const inputReady = context.inputRevisionDigest.length > 0;
      const staticReady = status.schema
        && status.reconciliation
        && status.archiveRegistry
        && status.isolateTermination
        && status.publicationStore;
      const ready = getAgenticRuntimeMode() === "auto" && staticReady && providerReady && configReady && contextReady && inputReady;
      // Every unavailable component is reported with its declared vocabulary
      // reason (AgenticReadinessReasonV1); a caller repairing one reason must
      // not be surprised by the next one.
      const reasons: string[] = [];
      if (!status.schema) reasons.push("schema_unavailable");
      if (!status.reconciliation) reasons.push("reconciliation_required");
      if (!status.archiveRegistry) reasons.push("archive_registry_unavailable");
      if (!status.isolateTermination) reasons.push("isolate_unavailable");
      if (!status.publicationStore) reasons.push("publication_store_unavailable");
      if (!providerReady) reasons.push("provider_capability_unavailable");
      if (!configReady) reasons.push("config_unavailable");
      if (!contextReady) {
        if (!packs) reasons.push("input_revisions_incomplete");
        else if (packs.candidates.some((candidate) => candidate.ownerId !== userId)) reasons.push("cognition_authorization_stale");
        else reasons.push("cognition_missing_pack_revision");
      }
      if (!inputReady) reasons.push("input_revisions_incomplete");
      if (getAgenticRuntimeMode() !== "auto") reasons.push("kill_switch_off");
      // Static components share the readiness authority's own digest. It is the
      // authoritative value that changes whenever any component flips, so no
      // per-component epoch is invented here.
      const authority = staticReady ? status.digest : 0;
      // Cognition and context-ACL identity come from the frozen preflight
      // snapshot so the readiness digest changes with either revision. With no
      // frozen snapshot both revisions are absent (0) and the
      // input_revisions_incomplete reason above already closes readiness.
      const inputRevisions = snapshot ? runtimeInputRevisions(snapshot) : null;
      const repairCode = record?.reviewState === "repair_required"
        && record.reviewCode !== null
        && isCognitionRepairCode(record.reviewCode)
        ? record.reviewCode
        : null;
      const baseVector: AgenticReadinessVectorV1 = {
        schemaEpoch: authority,
        runtimeEpoch,
        reconciliationEpoch: authority,
        archiveRegistryVersion: status.archiveRegistry ? ARCHIVE_REGISTRY_VERSION : 0,
        isolateHealthEpoch: status.isolateTermination ? getIsolateHealthEpoch() : 0,
        publicationStoreHealthEpoch: authority,
        providerCapabilityRevision: providerReady ? root?.candidateRevision ?? root?.revision ?? 0 : 0,
        configRevision: context.configRevision ?? 0,
        bindingRevision: context.bindingRevision ?? 0,
        concreteConnectionRevision: root?.candidateRevision ?? root?.revision ?? 0,
        targetRevision: context.target?.revision ?? 0,
        inputRevisionDigest: context.inputRevisionDigest,
        cognitionRevision: inputRevisions?.cognition ?? 0,
        contextAclRevision: snapshot?.contextPacks.contextAclRevision ?? 0,
        killSwitchState: getAgenticRuntimeMode(),
        ready,
        reasons,
      };
      // Merge the durable cognition repair state through the production merge
      // so repair-required cognition yields ready: false plus its stable
      // repair code; Response availability is never affected.
      return applyCognitionReadinessV1(baseVector, {
        cognitionRevision: baseVector.cognitionRevision,
        contextAclRevision: baseVector.contextAclRevision,
        scopeRevision: 0,
        agenticAllowed: repairCode === null,
        responseAvailable: true,
        repairCode,
        issues: [],
      });
    },
  });
  decisionAuthoritiesInstalled = true;
}
function cognitionValue(value: unknown): CognitionValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return Object.freeze([...value]);
  return undefined;
}

function cognitionValues(value: unknown): Readonly<Record<string, CognitionValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const output: Record<string, CognitionValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = cognitionValue(item);
    if (normalized !== undefined) output[key] = normalized;
  }
  return Object.freeze(output);
}

function cognitionWorkspaceContext(
  execution: RuntimeExecution,
  _capabilities?: WorkspaceOperationCapabilitiesV1,
): Record<string, unknown> {
  return {
    userId: execution.userId,
    chatId: execution.chatId,
    turnId: execution.id,
    workspaceId: execution.workspaceId,
    actor: "root",
    expectedRevision: execution.workspaceRevision ?? 0,
  };
}

function createCognitionRuntimeForTurn(
  execution: RuntimeExecution,
  snapshot: RuntimeSnapshot,
  capabilities: WorkspaceOperationCapabilitiesV1,
): AgentCognitionRuntimeV1 | undefined {
  const contextPacks = snapshot.contextPacks;
  if (!contextPacks.cognitionGraph || !contextPacks.cognitionSource) return undefined;
  const participants = snapshot.participants;
  const participantFacts: Record<string, CognitionValue> = {
    hasPersona: participants.persona !== null,
    groupSize: participants.group.length,
    hasGroup: participants.group.length > 0,
  };
  const characterId = typeof participants.character.id === "string" ? participants.character.id : undefined;
  if (characterId) participantFacts.characterId = characterId;
  if (participants.persona && typeof participants.persona.id === "string") participantFacts.personaId = participants.persona.id;
  return createAgentCognitionRuntime({
    source: {
      graph: contextPacks.cognitionGraph,
      source: contextPacks.cognitionSource,
      config: Object.freeze({ ...frozenConfig(snapshot.agentConfig) }),
      contextRules: contextPacks.contextRules,
      taskTemplateIds: (() => {
        const config = frozenConfig(snapshot.agentConfig);
        return config.taskPolicy?.templateIds ?? [];
      })(),
      contextPackSelections: contextPacks.contextPackSelections,
      contextPackCandidates: contextPacks.candidates.map((candidate) => ({
        packId: candidate.packId,
        revisionId: candidate.revisionId,
        digest: candidate.digest,
        source: candidate.source,
        required: candidate.required,
      })),
    },
    evaluation: {
      generationType: snapshot.target.generationType,
      phase: "ASSEMBLE",
      presetVariables: cognitionValues(snapshot.variables.preset),
      participantFacts: Object.freeze(participantFacts),
      availableTools: snapshot.availability.toolIds,
      taskTransitions: Object.freeze({}),
    },
    workspaceRevision: execution.workspaceRevision ?? 0,
    workspace: cognitionWorkspaceContext(execution, capabilities),
  });
}

async function enterCognitionPhase(
  execution: RuntimeExecution,
  runtime: AgentCognitionRuntimeV1,
  phase: "WORK" | "RENDER" | "PREPARE_COMMIT" | "COMMITTING" | "COMMITTED",
  capabilities: WorkspaceOperationCapabilitiesV1,
  signal?: AbortSignal,
): Promise<CognitionRuntimeActivationV1> {
  return withToolPermit(execution.userId, () => {
    const view = runtime.enterPhase({
      phase,
      workspace: cognitionWorkspaceContext(execution, capabilities),
    });
    execution.workspaceRevision = view.workspaceRevision;
    return view;
  }, signal ?? execution.signal, execution.owner.ledger);
}

function buildDependencies(): AgenticGenerationDependencies {
  const cognitionRuntimes = new Map<string, AgentCognitionRuntimeV1>();
  const contextRuntimes = new Map<string, CoordinatorContextRuntime>();
  const snapshots = new Map<string, RuntimeSnapshot>();
  const plans = new Map<string, RuntimePlan>();
  const renders = new Map<string, { content: string }>();
  const renderProjections = new Map<string, FrozenRenderCommitProjection>();
  const renderFrames = new Map<string, {
    readonly handoff: AgenticWorkRenderHandoff;
    readonly renderMessages: readonly LlmMessage[];
  }>();
  const works = new Map<string, any>();
  const caps = new Map<string, WorkspaceOperationCapabilitiesV1>();
  const bindings = new Map<string, LiveTargetBinding>();
  const stopRegistrations = new Map<string, () => void>();
  const rootSignals = new Map<string, AbortSignal>();
  const rootDeadlines = new Map<string, number>();
  const deadlineDisposers = new Map<string, () => void>();
  const childJoins = new Map<string, Set<Promise<void>>>();
  const trackChild = <T>(executionId: string, run: () => Promise<T>): Promise<T> => {
    let joins = childJoins.get(executionId);
    if (!joins) {
      joins = new Set<Promise<void>>();
      childJoins.set(executionId, joins);
    }
    const pending = Promise.resolve().then(run);
    const joined = pending.then(() => undefined, () => undefined);
    joins.add(joined);
    void joined.finally(() => {
      joins?.delete(joined);
      if (joins?.size === 0 && childJoins.get(executionId) === joins) childJoins.delete(executionId);
    });
    return pending;
  };
  const joinChildren = async (executionId: string): Promise<void> => {
    for (;;) {
      const joins = childJoins.get(executionId);
      if (!joins || joins.size === 0) {
        childJoins.delete(executionId);
        return;
      }
      await Promise.all([...joins]);
    }
  };

  const resolve = async (input: AgenticGenerationInput, target: AgenticTargetSnapshot): Promise<AgenticRuntimeDecision> => {
    const result = await resolveEffectiveRuntimeWithoutToken(input.userId, runtimeRequest(input, target));
    return mapDecision(result);
  };
  const consume = async (input: AgenticGenerationInput, target: AgenticTargetSnapshot, token: string): Promise<AgenticRuntimeDecision> => {
    const result = await consumeRuntimeDecisionToken(input.userId, token, runtimeRequest(input, target));
    if (!result.accepted || !result.decision) throw new Error("decision_refresh_required");
    return mapDecision(result.decision);
  };
  return {
    requestCancellation: (execution, reason) => {
      if (!execution.ownerToken) return false;
      const result = requestTurnCancellation({
        executionId: execution.id,
        ownerToken: execution.ownerToken,
        reason: reason ?? "cancelled",
      });
      if (result.code === "too_late") return "too_late";
      return result.code === "cancelled" || result.code === "timed_out";
    },
    cancelAndJoinChildren: (execution) => joinChildren(execution.id),
    resolveRuntime: resolve,
    consumeRuntimeToken: (input, target, token) => consume(input, target, token),
    createExecution: async (value) => {
      const decision = internalDecision(value.decision);
      const root = decision.internal.rootConnection;
      const presetId = decision.internal.binding.presetId;
      const projection = presetId
        ? getPresetAgentConfig(value.userId, presetId) as PresetAgentConfigProjection | null
        : null;
      if (presetId && (
        !projection
        || String(projection.configRevision) !== String(decision.internal.binding.configRevision)
        || String(projection.bindingRevision) !== String(decision.internal.binding.bindingRevision)
      )) {
        throw new AgenticGenerationError(
          "decision_refresh_required",
          "Preset configuration changed after runtime admission.",
          { phase: "ASSEMBLE", retryable: true },
        );
      }
      const config = frozenConfig(decision.internal.configSnapshot ?? projection?.config);
      const policy = workspacePolicy(config.workspacePolicy);
      const now = Date.now();
      const maxRootDuration = getAgentRuntimeHostLimits().rootWallClockMs;
      const requestedDeadline = value.deadlineAt;
      const boundedDeadline = now + maxRootDuration;
      const deadlineAt = typeof requestedDeadline === "number" && Number.isFinite(requestedDeadline)
        ? Math.min(requestedDeadline, boundedDeadline)
        : boundedDeadline;
      const deadlineController = new AbortController();
      const rootSignal = AbortSignal.any([value.signal, deadlineController.signal]);
      let executionOwnerToken: string | undefined;
      const deadlineTimer = setTimeout(
        () => {
          // A deadline is a durable terminal decision too. CAS the live owner
          // before aborting the signal consumed by provider/child work.
          if (executionOwnerToken) {
            try {
              requestTurnCancellation({
                executionId: value.executionId,
                ownerToken: executionOwnerToken,
                reason: "timed_out",
              });
            } catch {
              // The terminal transition/recovery owner will reconcile a row
              // that disappeared between the timer and this CAS.
            }
          }
          deadlineController.abort(new DOMException("Agentic root deadline", "TimeoutError"));
        },
        Math.max(0, deadlineAt - now),
      );
      const disposeDeadline = (): void => {
        clearTimeout(deadlineTimer);
        deadlineController.abort(new DOMException("Agentic execution disposed", "AbortError"));
      };
      rootSignals.set(value.executionId, rootSignal);
      rootDeadlines.set(value.executionId, deadlineAt);
      deadlineDisposers.set(value.executionId, disposeDeadline);
      let owner: AgentRuntimeOwner | undefined;
      let credentialCarrier: Map<string, string> | undefined;
      try {
        const frozenConnections = [
          root,
          ...Object.values(decision.internal.childConnections),
        ].filter((connection): connection is FrozenConcreteConnectionV1 => connection !== null);
        credentialCarrier = await freezeConnectionCredentials(value.userId, frozenConnections);
        const carrier = credentialCarrier;
        if (!carrier) throw new AgenticGenerationError("decision_refresh_required", "Frozen provider credentials are unavailable.", { phase: "ASSEMBLE", retryable: true });
        const rootConnection = root ? requireRenderConnection(root) : null;
        if (!rootConnection) throw new AgenticGenerationError(
          "agentic_provider_failure",
          "Agentic root connection is unavailable.",
          { phase: "ASSEMBLE" },
        );
        let runtimeOwner: AgentRuntimeOwner;
        runtimeOwner = new AgentRuntimeOwner({
          generationId: value.executionId,
          userId: value.userId,
          config,
          rootConnection,
          signal: rootSignal,
          dispatch: async (request) => {
            const frozen = normalizeConcreteConnection(request.connection);
            if (!frozen) throw new AgenticGenerationError("decision_refresh_required", "Frozen child connection is unavailable.", { phase: "WORK", retryable: true });
            if (frozen.capabilities.toolContinuationMode !== "native" && frozen.capabilities.toolContinuationMode !== "legacy") {
              throw new AgenticGenerationError("agentic_provider_failure", "Provider tool continuation is unsupported.", { phase: "WORK" });
            }
            const credential = carrier.get(connectionIdentity(frozen));
            if (credential === undefined) throw new AgenticGenerationError("decision_refresh_required", "Frozen provider credential is unavailable.", { phase: "WORK", retryable: true });
            const stream = await providerStream(value.userId, frozen, {
              messages: [...request.messages],
              model: frozen.model ?? "",
              parameters: { max_tokens: request.maxOutputTokens },
              tools: [...(request.tools ?? [])],
              stream: true,
              signal: request.signal,
              receiveLimitBytes: request.receiveLimitBytes ?? MAX_OUTPUT_BYTES,
              toolMode: request.toolMode ?? "ordinary",
              ...(request.providerTransientCarrier ? { providerTransientCarrier: request.providerTransientCarrier } : {}),
            }, credential, runtimeOwner.ledger);
            const response = await collectProviderResponse(
              stream,
              request.receiveLimitBytes ?? MAX_OUTPUT_BYTES,
              runtimeOwner.ledger,
              false,
            );
            let observedOutputTokens: number | undefined;
            try {
              observedOutputTokens = observeOutputTokens(response);
            } catch {
              throw new AgenticGenerationError("agentic_provider_failure", "Provider output accounting failed.", { phase: "WORK" });
            }
            return {
              ...response,
              toolContinuationMode: frozen.capabilities.toolContinuationMode,
              supportsToolFinalization: frozen.capabilities.toolsDisabledFinalization === true,
              observedOutputTokens,
            };
          },
        });
        rootSignal.addEventListener("abort", () => {
          credentialCarrier?.clear();
        }, { once: true });
        owner = runtimeOwner;
        const binding = bindLiveTarget(value.userId, value.chatId, value.target);
        // Retain the normalized binding before any later setup can throw so a
        // partially-created turn can publish the exact terminal target.
        bindings.set(value.executionId, binding);
        const presetRevision = Number(decision.internal.binding.configRevision);
        const connectionRevision = Number(root?.candidateRevision ?? root?.revision);
        const execution = createTurnExecution({
          id: value.executionId, userId: value.userId, chatId: value.chatId, generationId: value.executionId,
          target: binding,
          presetSnapshotId: decision.internal.binding.presetId,
          presetRevision: Number.isSafeInteger(presetRevision) && presetRevision >= 0 ? presetRevision : 0,
          configSnapshotId: decision.internal.binding.presetId,
          configRevision: Number.isSafeInteger(presetRevision) && presetRevision >= 0 ? presetRevision : 0,
          concreteConnectionSnapshotId: root?.concreteId ?? root?.logicalId ?? null,
          concreteConnectionRevision: Number.isSafeInteger(connectionRevision) && connectionRevision >= 0 ? connectionRevision : 0,
          worldLoreSnapshotId: null, worldLoreRevision: 0, mode: "agentic", runtimeEpoch: getRuntimeEpoch(),
          deadlineAt, workspaceId: `workspace:${value.executionId}`, rootLedger: {}, frameCapabilities: {},
        });
        executionOwnerToken = execution.ownerToken;
        // §6.5: reserve the single root RENDER request/context/output/deadline/
        // activity budget at admission so WORK can never starve the frozen
        // render. The envelope derives from immutable host limits; ASSEMBLE
        // freezes those same host defaults into its snapshot, so the
        // RENDER-entry reservation is an idempotent same-envelope no-op that
        // still fails closed on any drift.
        const renderReservationEnvelope = calculateFinalRenderReservationEnvelopeV1({
          activityChunks: 16,
          contextBytes: HOST_PREPARATION_LIMITS_V1.maxInputBytes,
          outputBytes: HOST_PREPARATION_LIMITS_V1.maxOutputBytes,
        });
        reserveFinalRender({
          executionId: value.executionId,
          ownerToken: execution.ownerToken,
          reservationKey: `render:${value.executionId}`,
          maxBytes: renderReservationEnvelope.maxBytes,
          contextBytes: renderReservationEnvelope.contextBytes,
          outputBytes: renderReservationEnvelope.outputBytes,
          activityChunks: renderReservationEnvelope.activityChunks,
          deadlineAt,
        });
        if (deadlineController.signal.aborted) {
          try {
            requestTurnCancellation({
              executionId: value.executionId,
              ownerToken: executionOwnerToken,
              reason: "timed_out",
            });
          } catch {
            // The already-aborted root signal prevents provider dispatch.
          }
        }
        const unregisterStop = registerAgentRunStopHandler(
          value.userId,
          value.chatId,
          value.executionId,
          (): "accepted" | "too_late" | "terminal" => {
            try {
              const outcome = requestTurnCancellation({
                executionId: value.executionId,
                ownerToken: execution.ownerToken,
                reason: "stopped",
              });
              if (outcome.code === "too_late") return "too_late";
              if (outcome.code === "already_terminal") return "terminal";
              // The durable CAS above wins the reversible phase gate. Abort
              // the live controller only after that CAS so provider/tool
              // streams observe the same terminal decision and cannot later
              // publish a stale failure or commit.
              abortAcceptedAgenticGeneration(value.userId, value.executionId);
              return "accepted";
            } catch {
              return "too_late";
            }
          },
        );
        stopRegistrations.set(value.executionId, unregisterStop);
        const workspaceId = `workspace:${value.executionId}`;
        const workspaceCapabilities: WorkspaceOperationCapabilitiesV1 = {
          revision: 1, allowed: WORKSPACE_OPERATIONS, maxOperationBytes: 131_072, maxOperations: 128,
        };
        createTurnWorkspace({
          userId: value.userId, chatId: value.chatId, turnId: value.executionId, workspaceId,
          objective: "Complete the requested turn", constraints: [], retention: policy.retention,
          ...(policy.retention === "turn_terminal" ? { ttlSeconds: WORKSPACE_MAX_TERMINAL_TTL_SECONDS } : {}),
          quota: DEFAULT_QUOTA, capabilities: workspaceCapabilities,
        });
        caps.set(value.executionId, workspaceCapabilities);
        pool.createPoolEntry({
          generationId: value.executionId, userId: value.userId, chatId: value.chatId,
          generationType: binding.target, characterName: "", model: root?.model ?? "",
          ...(binding.messageId ? { targetMessageId: binding.messageId } : {}),
          ...(binding.swipeId !== null ? { targetSwipeId: binding.swipeId } : {}),
        });
        eventBus.emit(
          EventType.GENERATION_STARTED,
          {
            generationId: value.executionId, chatId: value.chatId, model: root?.model ?? "",
            targetMessageId: binding.messageId, targetSwipeId: binding.swipeId, generationType: binding.target,
          },
          value.userId,
        );
        return {
          id: value.executionId,
          ownerToken: execution.ownerToken,
          commitKey: execution.commitKey,
          phase: "ASSEMBLE",
          target: targetFromBinding(binding),
          signal: rootSignal,
          userId: value.userId,
          chatId: value.chatId,
          workspaceId,
          workspaceRevision: 0,
          deadlineAt,
          workspaceRetention: policy.retention,
          workspaceSharing: policy.sharing,
          owner: runtimeOwner,
          credentialCarrier: carrier,
        };
      } catch (error) {
        stopRegistrations.get(value.executionId)?.();
        invalidateFrameCapabilitiesForTurn({ userId: value.userId, chatId: value.chatId, turnId: value.executionId });
        stopRegistrations.delete(value.executionId);
        caps.delete(value.executionId);
        snapshots.delete(value.executionId);
        plans.delete(value.executionId);
        works.delete(value.executionId);
        renderFrames.delete(value.executionId);
        renders.delete(value.executionId);
        renderProjections.delete(value.executionId);
        cognitionRuntimes.delete(value.executionId);
        contextRuntimes.delete(value.executionId);
        try {
          pool.removePoolEntry(value.executionId);
        } catch {
          // A failed create may have occurred before the pool entry existed.
        }
        try {
          requestTurnCancellation({ executionId: value.executionId, reason: "admission_failed" });
        } catch {
          // A failed create may have occurred before the durable row existed.
        }
        owner?.close();
        credentialCarrier?.clear();
        deadlineDisposers.get(value.executionId)?.();
        deadlineDisposers.delete(value.executionId);
        rootSignals.delete(value.executionId);
        rootDeadlines.delete(value.executionId);
        throw error;
      }
    },
    transitionExecution: (execution, expected, next) => {
      if (!execution.ownerToken || expected === next) return execution;
      const result = transitionTurnExecution({
        executionId: execution.id,
        ownerToken: execution.ownerToken,
        expectedPhase: expected,
        nextPhase: next,
      });
      if (result.execution.phase === next) return { ...execution, phase: next };
      const phase = result.execution.phase;
      const code = phase === "CANCELLED"
        ? "agentic_cancelled"
        : phase === "TIMED_OUT"
          ? "agentic_timed_out"
          : phase === "EXHAUSTED"
            ? "agentic_work_exhausted"
            : phase === "COMMIT_FAILED"
              ? "agentic_commit_failed"
              : "agentic_internal_error";
      throw new AgenticGenerationError(code, "Agentic execution became terminal before the requested phase.", { phase });
    },
    readExecutionPhase: (execution) => {
      try {
        if (!isRuntimeExecution(execution)) return undefined;
        const current = getTurnExecution(execution.id, execution.userId);
        return current?.phase as AgenticPhase | undefined;
      } catch {
        return undefined;
      }
    },
    readExecutionPhaseById: (executionId, userId) => {
      try {
        return getTurnExecution(executionId, userId)?.phase as AgenticPhase | undefined;
      } catch {
        return undefined;
      }
    },
    getExecutionTarget: (executionId) => {
      const binding = bindings.get(executionId);
      return binding ? targetFromBinding(binding) : undefined;
    },
    buildAssemblySnapshot: async (input, decision, target, signal, executionId) => {
      // ASSEMBLE always reads fresh under the frozen decision. The preflight
      // snapshot carried no user input and is never reused as assembly.
      const rootSignal = rootSignals.get(executionId) ?? signal;
      if (rootSignal.aborted) {
        throw assemblyAbortError(rootSignal);
      }
      const snapshot = buildGenerationAssemblySnapshot(
        snapshotInput(input, decision, target, internalDecision(decision).internal.rootConnection),
      );
      if (rootSignal.aborted) {
        throw assemblyAbortError(rootSignal);
      }
      const expectedDigest = internalDecision(decision).internal.binding.inputRevisionDigest;
      const actualDigest = canonicalInputRevisionDigest(runtimeInputRevisions(snapshot));
      if (actualDigest !== expectedDigest) {
        throw new AgenticGenerationError("agentic_revision_conflict", "stale_input_revision", {
          phase: "ASSEMBLE",
          retryable: true,
        });
      }
      snapshots.set(executionId, snapshot);
      return snapshot;
    },
    compileAssemblyPlan: async (snapshot, input, _decision, signal, executionId) => {
      const rootSignal = rootSignals.get(executionId) ?? signal;
      const rootDeadline = rootDeadlines.get(executionId) ?? Date.now() + snapshot.limits.maxWallClockMs;
      const timeoutMs = Math.max(1, rootDeadline - Date.now());
      const plan = await compileAgentAssemblyPlan(snapshot, {
        userId: input.userId,
        signal: rootSignal,
        timeoutMs,
      });
      plans.set(executionId, plan);
      return plan;
    },
    createContextRuntime: (snapshot, _input, _decision, _signal, _executionId) => {
      const contextSnapshot = snapshot.contextPackSnapshot;
      if (!contextSnapshot) throw new Error("context_snapshot_unavailable");
      const reader = createAccountContextPackReader();
      const tracker = new ContextPackInputRevisionTracker();
      const invalidationSink = createCognitionContextInvalidationSink();
      const budget = new ContextPackToolBudget();
      // Cognition is the only authority that activates context candidates.
      // Start empty; WORK refreshes this capability from its frozen graph.
      let current = createContextToolCapability(contextSnapshot, reader, {
        budget,
        revisionTracker: tracker,
        invalidationSink,
        activeCandidates: { contextPackRequirements: [] },
      });
      const operationGate = current.operationGate;
      const capability = {
        operationGate,
        list: (args: unknown, signal?: AbortSignal) => current.list(args, signal),
        get: (args: unknown, signal?: AbortSignal) => current.get(args, signal),
      };
      const runtime: CoordinatorContextRuntime = {
        snapshot: contextSnapshot,
        reader,
        tracker,
        budget,
        capability,
        refreshContextCapability: (requirements) => {
          current = createContextToolCapability(contextSnapshot, reader, {
            budget,
            operationGate,
            revisionTracker: tracker,
            invalidationSink,
            activeCandidates: {
              contextPackRequirements: requirements.map((requirement) => Object.freeze({
                ruleId: requirement.ruleId,
                source: requirement.source,
                packId: requirement.packId,
                revisionId: requirement.revisionId,
                digest: requirement.digest,
                required: requirement.required,
              })),
            },
          });
        },
        recheckAtCommit: (signal?: AbortSignal) =>
          recheckContextPackInputRevisionsAtCommit(contextSnapshot, reader, tracker, invalidationSink, signal, operationGate),
      };
      return runtime;
    },
    runWork: async ({ execution, input, decision, snapshot, plan, signal, contextRuntime }) => {
      const runtimeExecution = requireRuntimeExecution(execution);
      const internal = internalDecision(decision).internal;
      const root = internal.rootConnection;
      const runtimeSnapshot = snapshot;
      if (!root) return { status: "failed", errorCode: "agentic_provider_failure" };
      const phaseSignal = runtimeExecution.signal ?? signal;
      const workspaceCapabilities = caps.get(execution.id);
      if (!workspaceCapabilities) throw new Error("agentic_workspace_capability_missing");
      const coordinatorContextRuntime = requireCoordinatorContextRuntime(contextRuntime);
      if (coordinatorContextRuntime) contextRuntimes.set(execution.id, coordinatorContextRuntime);
      const cognitionRuntime = await withToolPermit(
        input.userId,
        () => createCognitionRuntimeForTurn(runtimeExecution, runtimeSnapshot, workspaceCapabilities),
        phaseSignal,
        runtimeExecution.owner.ledger,
      );
      const contextCapability = coordinatorContextRuntime
        ? {
          list: (args: Record<string, unknown>, toolSignal: AbortSignal) =>
            withToolPermit(
              input.userId,
              () => coordinatorContextRuntime.capability.list(args, toolSignal),
              toolSignal,
              runtimeExecution.owner.ledger,
            ),
          get: (args: Record<string, unknown>, toolSignal: AbortSignal) =>
            withToolPermit(
              input.userId,
              () => coordinatorContextRuntime.capability.get(args, toolSignal),
              toolSignal,
              runtimeExecution.owner.ledger,
            ),
          refreshContextCapability: (requirements: readonly CognitionContextPackRequirementV1[]) =>
            withToolPermit(
              input.userId,
              () => coordinatorContextRuntime.refreshContextCapability(requirements),
              phaseSignal,
              runtimeExecution.owner.ledger,
            ),
        }
        : undefined;
      if (cognitionRuntime) {
        if (!coordinatorContextRuntime || !contextCapability) throw new Error("agentic_context_runtime_missing");
        runtimeExecution.workspaceRevision = cognitionRuntime.initialActivation.workspaceRevision;
        await contextCapability.refreshContextCapability!(cognitionRuntime.initialActivation.contextPackRequirements);
        const workActivation = await enterCognitionPhase(runtimeExecution, cognitionRuntime, "WORK", workspaceCapabilities, phaseSignal);
        await contextCapability.refreshContextCapability!(workActivation.contextPackRequirements);
      }
      const config = frozenConfig(runtimeSnapshot.agentConfig);
      const available = new Set(runtimeSnapshot.availability.toolIds.filter(
        (id): id is CoreAgentToolId => (CORE_AGENT_TOOL_IDS as readonly string[]).includes(id),
      ));
      const rootToolIds = (config.mainToolIds ?? []).filter((id) => available.has(id));
      const rootLoreScope = normalizeLoreScope(config.mainLoreScope);
      const toolSnapshot = makeToolSnapshot(runtimeSnapshot, phaseSignal);
      // The root grant is exactly the authored main grant narrowed by snapshot
      // availability. A child never inherits it.
      const executorFor = (grantToolIds: readonly CoreAgentToolId[], loreScope: AgentLoreScope) => ({
        execute: (toolId: CoreAgentToolId, args: Record<string, unknown>, toolSignal: AbortSignal) =>
          withToolPermit(input.userId, () =>
            executeCoreAgentTool(toolId, args, {
              snapshot: toolSnapshot,
              grant: { toolIds: grantToolIds, loreScope },
              signal: toolSignal,
            }), toolSignal, runtimeExecution.owner.ledger),
      });
      const coreExecutor = executorFor(rootToolIds, rootLoreScope);
      // All authored profiles can satisfy deterministic ASSEMBLE children.
      // `allowMainDelegation` gates only the agent_delegate tool exposed to
      const profiles = config.profiles ?? [];
      const delegatable = profiles.filter((profile) => profile.allowMainDelegation === true);
      const connectionFor = (profileId: string) => internal.childConnections[profileId] ?? root;
      const profileOutputLimits = new Map(plan.profileOutputLimits.map((entry) => [entry.profileId, entry.maxOutputTokens]));
      const delegatableProfiles = delegatable.map((profile) => {
        const child = connectionFor(profile.id);
        const workspaceCapabilities = (profile.workspaceCapabilities ?? [])
          .filter((operation) => CHILD_WORKSPACE_CAPABILITIES.includes(operation));
        return {
          profileId: profile.id,
          toolIds: (profile.toolIds ?? []).filter((id) => available.has(id)),
          ...(workspaceCapabilities.length > 0 ? { workspaceCapabilities } : {}),
          ...(profileOutputLimits.has(profile.id) ? { maxOutputTokens: profileOutputLimits.get(profile.id)! } : {}),
          model: child.model ?? root.model ?? "",
          connectionId: child.concreteId ?? child.logicalId ?? null,
        };
      });
      const hostLimits = getAgentRuntimeHostLimits();
      const workspace = makeWorkspace(
        runtimeExecution,
        workspaceCapabilities,
        runtimeSnapshot.limits.maxInputBytes,
        cognitionRuntime,
        coordinatorContextRuntime,
      );
      const effectiveParameters: GenerationParameters = {
        ...((runtimeSnapshot.preset?.parameters ?? {}) as GenerationParameters),
        ...(input.parameters ?? {}),
      };
      const rootOutputTokenLimit = rootMaxOutputTokens(effectiveParameters);
      const options: AgenticWorkOptions = {
        rootFrameId: execution.id,
        trustedAssemblyLimits: runtimeSnapshot.limits,
        plan,
        connectionId: root.concreteId ?? root.logicalId ?? null,
        model: root.model ?? "",
        signal: phaseSignal,
        deadlineAt: runtimeExecution.deadlineAt,
        dispatch: makeWorkProvider(input.userId, root, effectiveParameters, runtimeExecution.owner.ledger, frozenCredentialFor(runtimeExecution, root)),
        coreToolIds: rootToolIds,
        workPolicyMessages: plan.workPolicyMessages,
        workspaceUsageMessages: plan.workspaceUsageMessages,
        completionCriteriaMessages: plan.completionCriteriaMessages,
        renderPolicyMessages: plan.renderPolicyMessages,
        coreSnapshot: toolSnapshot,
        coreToolCapability: coreExecutor,
        workspace,
        context: contextCapability,
        workspaceCapabilities: WORKSPACE_OPERATIONS,
        contextTools: contextCapability ? ["context_pack_list", "context_pack_get"] : [],
        allowAgentDelegate: delegatable.length > 0,
        delegatableProfiles,
        budget: {
          maxToolCalls: Math.min(config.maxToolCalls ?? hostLimits.aggregateToolCalls, hostLimits.aggregateToolCalls),
          maxChildFrames: Math.min(config.maxInvocations ?? hostLimits.childAdmissions, hostLimits.childAdmissions),
          ...(rootOutputTokenLimit !== undefined ? { maxOutputTokens: rootOutputTokenLimit } : {}),
        },
        executeChild: ({ frame, descriptor, definitions, workspace: childWorkspace }) =>
          trackChild(execution.id, async () => {
          // use every authored profile. Only agent_delegate is filtered above.
          const profile = profiles.find((candidate) => candidate.id === descriptor.profileId);
          if (!profile || typeof profile.systemPrompt !== "string") {
            return { content: "", status: "failed" as const, errorCode: "child_profile_unauthorized" };
          }
          const childToolIds = (profile.toolIds ?? []).filter((id) => available.has(id));
          const child = connectionFor(descriptor.profileId);
          const result = await executeBoundedAgenticChildFrame({
            frame, task: descriptor.task, definitions,
            ...(childWorkspace ? { workspace: childWorkspace } : {}),
            systemPrompt: profile.systemPrompt,
            dispatch: makeWorkProvider(input.userId, child, effectiveParameters, runtimeExecution.owner.ledger, frozenCredentialFor(runtimeExecution, child)),
            executeCore: executorFor(childToolIds, normalizeLoreScope(profile.loreScope)),
            budget: {
              maxChildOutputBytes: descriptor.maxOutputBytes,
              maxOutputTokens: descriptor.maxOutputTokens,
            },
          });
          return {
            content: result.content,
            status: result.status,
            errorCode: result.code,
            ...(result.workspaceRevision !== undefined ? { workspaceRevision: result.workspaceRevision } : {}),
          };
          }),
      };
      const outcome = await runAgenticWorkPhase(options);
      // Some workspace adapters intentionally keep the CAS revision private
      // in their result envelope. Read the durable owner row only when WORK
      // can continue; cancellation/timeout retains the pre-cancel revision.
      const workspaceRevision = adoptWorkWorkspaceRevision(runtimeExecution, outcome);
      works.set(execution.id, outcome);
      if (outcome.renderHandoff) {
        renderFrames.set(execution.id, Object.freeze({
          handoff: outcome.renderHandoff,
          renderMessages: Object.freeze(materializePolicyMessages(plan.renderPolicyMessages)),
        }));
      }
      return {
        status: outcome.status,
        workspaceRevision,
        summary: outcome.completion?.summary,
        renderGuidance: outcome.completion?.renderGuidance,
        workspace: { revision: workspaceRevision },
        acceptedWorkspace: outcome.renderHandoff
          ? {
            revision: outcome.renderHandoff.workspaceRevision,
            workspaceContextProjection: outcome.renderHandoff.workspaceContextProjection,
          }
          : { revision: workspaceRevision },
        usage: {},
        observations: outcome.observations.map((observation) => ({
          sequence: observation.sequence,
          callId: observation.callId,
          correlationId: observation.correlationId,
          toolName: observation.toolName,
          status: observation.status,
          ...(observation.code ? { code: observation.code } : {}),
          resultBytes: observation.resultBytes,
        })),
        ...(outcome.completion?.unresolvedIds ? { unresolvedIds: outcome.completion.unresolvedIds } : {}),
        ...(outcome.code ? { errorCode: outcome.code } : {}),
      };
    },
    render: async ({ execution, input, decision, snapshot, plan, work, signal }) => {
      const runtimeExecution = requireRuntimeExecution(execution);
      const workspaceCapabilities = caps.get(execution.id);
      if (!workspaceCapabilities) throw new Error("agentic_workspace_capability_missing");
      const cognitionRuntime = cognitionRuntimes.get(execution.id);
      const contextRuntime = contextRuntimes.get(execution.id);
      if (cognitionRuntime) {
        if (!contextRuntime) throw new Error("agentic_context_runtime_missing");
        await enterCognitionPhase(runtimeExecution, cognitionRuntime, "RENDER", workspaceCapabilities, runtimeExecution.signal ?? signal);
      }
      const root = internalDecision(decision).internal.rootConnection;
      if (!root) throw new Error("agentic_provider_failure");
      const runtimeSnapshot = requireRuntimeSnapshot(snapshot);
      // ASSEMBLE snapshots the same host limits used at admission (§6.5), so
      // this reservation is an idempotent same-envelope no-op against the
      // admission row. Any future per-turn limit override must update
      // admission too, or this call fails closed with
      // render_reservation_taken/invalid_execution_input.
      const reservationEnvelope = calculateFinalRenderReservationEnvelopeV1({
        activityChunks: 16,
        contextBytes: runtimeSnapshot.limits.maxInputBytes,
        outputBytes: runtimeSnapshot.limits.maxOutputBytes,
      });
      const reservationResult = reserveFinalRender({
        executionId: execution.id, ownerToken: execution.ownerToken ?? "", reservationKey: `render:${execution.id}`,
        maxBytes: reservationEnvelope.maxBytes,
        contextBytes: reservationEnvelope.contextBytes,
        outputBytes: reservationEnvelope.outputBytes,
        activityChunks: reservationEnvelope.activityChunks,
        deadlineAt: runtimeExecution.deadlineAt,
      });
      const reservation = reservationResult.execution.finalRenderReservations.find(
        (candidate): candidate is FinalRenderReservationV1 => candidate.id === reservationResult.reservationKey,
      );
      if (!reservation || reservation.id !== reservationResult.reservationKey) {
        throw new Error("agentic_render_reservation_missing");
      }
      const binding = bindings.get(execution.id);
      if (!binding) throw new Error("agentic_target_binding_missing");
      const target = {
        target: binding.target,
        chatId: binding.chatId,
        branchId: binding.branchId,
        messageId: binding.messageId,
        swipeId: binding.swipeId,
        messageIndex: binding.messageIndex,
        swipeCount: binding.swipeCount,
        chatGenerationRevision: binding.chatGenerationRevision,
        messageGenerationRevision: binding.messageGenerationRevision,
      };
      const frame = renderFrames.get(execution.id);
      if (!frame || frame.handoff.workspaceRevision !== runtimeExecution.workspaceRevision) {
        throw new Error("workspace_context_projection_stale");
      }
      const renderMessages = frame.renderMessages;
      const effectiveParameters: GenerationParameters = {
        ...((runtimeSnapshot.preset?.parameters ?? {}) as GenerationParameters),
        ...(input.parameters ?? {}),
      };
      const rootOutputTokenLimit = rootMaxOutputTokens(effectiveParameters);
      const renderInput: AgenticRenderPhaseInputV1 = {
        turnId: execution.id,
        target,
        connection: requireRenderConnection(root),
        acceptedWorkspace: {
          revision: frame.handoff.workspaceRevision,
          workspaceContextProjection: frame.handoff.workspaceContextProjection,
        },
        renderPolicy: {
          revision: 1,
          messages: renderMessages,
          maxOutputTokens: rootOutputTokenLimit ?? Math.floor(runtimeSnapshot.limits.maxOutputBytes / 4),
          parameters: effectiveParameters,
        },
        reservedBudgets: reservation,
        ...(frame ? {
          framePrivate: {
            continuationMode: frame.handoff.continuationMode,
            ...(frame.handoff.providerTransientCarrier
              ? { providerTransientCarrier: frame.handoff.providerTransientCarrier }
              : {}),
            ...(frame.handoff.transcript
              ? { transcript: frame.handoff.transcript }
              : {}),
          },
        } : {}),
        signal: runtimeExecution.signal ?? signal,
      };
      pool.setPoolStatus(execution.id, "streaming");
      pool.markStreamingStarted(execution.id);
      let result: Awaited<ReturnType<typeof runAgenticRenderPhaseV1>>;
      try {
        result = await runAgenticRenderPhaseV1(renderInput, {
          dispatch: makeRenderProvider(input.userId, root, runtimeExecution.owner.ledger, frozenCredentialFor(runtimeExecution, root)),
          emitProvisional: ({ key, text }) => {
            if (text.length === 0) return;
            const appended = pool.appendPoolContent(key.turnId, text);
            eventBus.emit(
              EventType.STREAM_TOKEN_RECEIVED,
              {
                generationId: key.turnId,
                chatId: key.target.chatId,
                token: text,
                seq: appended.seq,
                startSeq: appended.seq,
                offset: appended.offset,
              },
              input.userId,
              { topic: `stream:${key.turnId}` },
            );
          },
        });
      } catch (error) {
        throw mapRenderPhaseError(error) ?? error;
      }
      renders.set(execution.id, { content: result.text });
      const frozenWorkspaceRevision = frame.handoff.workspaceRevision;
      const frozenUsage = frozenWorkspaceUsage(runtimeExecution, frozenWorkspaceRevision);
      const frozenTerminalHandoff: WorkspaceTerminalHandoffV1 = Object.freeze({
        workspaceId: runtimeExecution.workspaceId,
        state: "frozen",
        revision: frozenWorkspaceRevision,
        executionState: "COMMITTING",
        usage: frozenUsage,
        finalRenderReservations: Object.freeze([reservation]),
      });
      renderProjections.set(execution.id, Object.freeze({
        reservation,
        workspaceRevision: frozenWorkspaceRevision,
        workspaceUsage: frozenUsage,
        terminalHandoff: frozenTerminalHandoff,
      }));
      return {
        content: result.text,
        usage: result.usage ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, totalTokens: result.usage.totalTokens } : undefined,
        finishReason: result.finishReason,
        toolCalls: [],
      };
    },
    prepareRender: async ({ execution, input, snapshot, plan, render }) => {
      const runtimeExecution = requireRuntimeExecution(execution);
      const workspaceCapabilities = caps.get(execution.id);
      if (!workspaceCapabilities) throw new Error("agentic_workspace_capability_missing");
      const cognitionRuntime = cognitionRuntimes.get(execution.id);
      const contextRuntime = contextRuntimes.get(execution.id);
      if (cognitionRuntime) {
        if (!contextRuntime) throw new Error("agentic_context_runtime_missing");
        const prepareActivation = await enterCognitionPhase(runtimeExecution, cognitionRuntime, "PREPARE_COMMIT", workspaceCapabilities, runtimeExecution.signal ?? execution.signal);
        // PREPARE_COMMIT is provisional. Its context requirements become live
        // only after the owning commit transaction succeeds.
      }
      const runtimeSnapshot = requireRuntimeSnapshot(snapshot);
      const binding = bindings.get(execution.id);
      if (!binding) throw new Error("agentic_target_binding_missing");
      const result = await prepareAgentRender(
        prepareInput(input, runtimeExecution, runtimeSnapshot, plan, render, binding),
        {
          userId: input.userId,
          signal: runtimeExecution.signal ?? execution.signal,
          timeoutMs: Math.min(
            runtimeSnapshot.limits.maxWallClockMs,
            Math.max(1, runtimeExecution.deadlineAt - Date.now()),
          ),
        },
      );
      const content = result.content.kind === "text"
        ? result.content.text
        : result.content.parts?.map((part) => part.kind === "text" ? part.text : "").join("");
      if (typeof content !== "string") throw new Error("agentic_render_content_missing");
      const providerUsage = boundedProviderUsage(render.usage);
      // The strict worker estimates usage from bounded bytes. Replace that
      // estimate only when RENDER supplied validated provider counters.
      const preparedResult = providerUsage
        ? { ...result, usage: providerUsage }
        : result;
      return {
        content,
        usage: providerUsage ?? result.usage,
        inputRevisions: result.inputRevisions,
        preparedResult,
      };
    },
    commit: async ({ execution, input, decision, snapshot, plan, work, prepared }) => {
      const runtimeExecution = requireRuntimeExecution(execution);
      const workspaceCapabilities = caps.get(execution.id);
      if (!workspaceCapabilities) throw new Error("agentic_workspace_capability_missing");
      const cognitionRuntime = cognitionRuntimes.get(execution.id);
      const contextRuntime = contextRuntimes.get(execution.id);
      const runtimeSnapshot = requireRuntimeSnapshot(snapshot);
      const runtimePlan = plan;
      const rawPreparedResult = prepared.preparedResult;
      if (!rawPreparedResult || typeof rawPreparedResult !== "object") {
        throw new Error("agentic_render_preparation_missing");
      }
      const preparedResult = validateRenderPreparationResultV1(rawPreparedResult, runtimeSnapshot.limits);
      const frozenRoot = internalDecision(decision).internal.rootConnection;
      const currentConnection = resolveConcreteConnectionV1(
        input.userId,
        frozenRoot?.logicalId ?? frozenRoot?.concreteId ?? input.connectionId ?? undefined,
        frozenRoot?.concreteId ?? null,
      );
      if (
        frozenRoot?.concreteId
        && (
          !currentConnection
          || currentConnection.concreteId !== frozenRoot.concreteId
          || String(currentConnection.candidateRevision) !== String(frozenRoot.candidateRevision)
          || String(currentConnection.endpointRevision) !== String(frozenRoot.endpointRevision)
          || String(currentConnection.credentialRevision) !== String(frozenRoot.credentialRevision)
        )
      ) {
        throw new Error("decision_refresh_required");
      }
      for (const frozenChild of Object.values(internalDecision(decision).internal.childConnections)) {
        const currentChild = frozenChild.logicalId || frozenChild.concreteId
          ? resolveConcreteConnectionV1(
            input.userId,
            frozenChild.logicalId ?? frozenChild.concreteId ?? undefined,
            frozenChild.concreteId ?? null,
          )
          : null;
        if (
          !currentChild
          || currentChild.concreteId !== frozenChild.concreteId
          || String(currentChild.candidateRevision) !== String(frozenChild.candidateRevision)
          || String(currentChild.endpointRevision) !== String(frozenChild.endpointRevision)
          || String(currentChild.credentialRevision) !== String(frozenChild.credentialRevision)
        ) {
          throw new Error("decision_refresh_required");
        }
      }
      const commitTarget: AgenticTargetSnapshot = {
        generationType: runtimeSnapshot.target.generationType,
        ...(runtimeSnapshot.target.messageId ? { messageId: runtimeSnapshot.target.messageId } : {}),
        ...(runtimeSnapshot.target.swipeId !== null ? { swipeId: runtimeSnapshot.target.swipeId } : {}),
      };
      const resolvedCommitConnection = normalizeConcreteConnection(currentConnection);
      const commitConnection = resolvedCommitConnection && frozenRoot
        ? Object.freeze({ ...resolvedCommitConnection, logicalId: frozenRoot.logicalId })
        : resolvedCommitConnection;
      const commitSnapshotInput = snapshotInput(input, decision, commitTarget, commitConnection);
      const commitSnapshot = buildGenerationAssemblySnapshot(commitSnapshotInput);
      const revisionReader = makeRevisionReader(commitSnapshotInput);
      const authorizeDelta = makeDeltaAuthorizer(commitSnapshot, frozenDeltas(runtimePlan));
      const renderDeltaKeys = new Set([
        ...preparedResult.macroVariableDeltas,
        ...preparedResult.sourceMessageDeltas,
        ...preparedResult.chatMetadataDeltas,
        ...preparedResult.regexActionDeltas,
        ...preparedResult.worldInfoStateDeltas,
      ].map(canonicalDelta));
      // Render preparation carries forward frozen deltas so each is committed
      // once, from the render result rather than from ASSEMBLE as well.
      const assemblyDeltas = runtimePlan.deltas.filter((delta) => !renderDeltaKeys.has(canonicalDelta(delta)));
      // The durable execution was created against this exact binding; reusing it
      // keeps target identity and revisions consistent across the CAS gate.
      const binding = bindings.get(execution.id)
        ?? bindLiveTarget(input.userId, input.chatId, commitTarget);
      const ownerToken = execution.ownerToken;
      const commitKey = execution.commitKey;
      if (!ownerToken || !commitKey || binding.chatId !== input.chatId || binding.target !== commitTarget.generationType) {
        throw new Error("agentic_execution_identity_missing");
      }
      // createTurnExecution persists id as both turn_id and generation_id; the
      // handle exposes that canonical immutable identity as execution.id.
      const renderProjection = renderProjections.get(execution.id);
      if (!renderProjection) throw new Error("agentic_render_projection_missing");
      const renderReservationId = renderProjection.reservation.id;
      const activitySnapshot = runtimeExecution.owner.ledger.activitySnapshot("completed");
      const fixedWorkspaceRevision = renderProjection.workspaceRevision;
      // Response attribution is frozen from the assembly snapshot. Do not
      // re-resolve a character after WORK; the message and commit fence must
      // agree on the identity that was admitted.
      const frozenCharacter = runtimeSnapshot.participants.character;
      const frozenCharacterId = typeof frozenCharacter.id === "string"
        && frozenCharacter.id.length > 0
        && frozenCharacter.id !== "__assistant__"
        ? frozenCharacter.id
        : undefined;
      const frozenCharacterName = participantName(frozenCharacter, "Assistant");
      const normalMessageAttribution = binding.target === "normal"
        ? {
          name: frozenCharacterName,
          ...(frozenCharacterId ? { extra: { character_id: frozenCharacterId } } : {}),
        }
        : {};
      const workspaceUsage = renderProjection.workspaceUsage;
      const workspaceArtifacts = frozenWorkspaceArtifacts(runtimeExecution, fixedWorkspaceRevision);
      const terminalHandoff = renderProjection.terminalHandoff;
      const commitInput: AgenticCommitInputV1 = {
        db: getDb(),
        dependencies: AGENTIC_COMMIT_DEPENDENCIES_V1,
        executionId: execution.id,
        ownerToken,
        userId: input.userId,
        chatId: input.chatId,
        turnId: execution.id,
        generationId: execution.id,
        target: binding,
        renderReservationId,
        commitKey,
        inputRevisions: runtimePlan.inputRevisions,
        revisionReader,
        terminalHandoff,
        workspaceUsage,
        activity: activitySnapshot.nodes,
        activityOmittedNodeCount: activitySnapshot.omittedNodeCount,
        renderPreparation: preparedResult,
        artifacts: workspaceArtifacts,
        assemblyPlan: { inputRevisions: runtimePlan.inputRevisions, deltas: assemblyDeltas },
        completion: {
          summary: work.summary ?? "Agentic turn completed",
          unresolvedIds: work.unresolvedIds ?? [],
          renderGuidance: work.renderGuidance,
        },
        message: { content: prepared.content, ...normalMessageAttribution },
        workspaceId: runtimeExecution.workspaceId,
        workspaceRevision: fixedWorkspaceRevision,
        signal: execution.signal,
        authorizeMacroVariableDelta: authorizeDelta,
        authorizeSourceMessageDelta: authorizeDelta,
        authorizeChatMetadataDelta: authorizeDelta,
        authorizeRegexActionDelta: authorizeDelta,
        authorizeWorldInfoStateDelta: authorizeDelta,
        applyRegexActionDelta: (db, delta) => applyRegexActionDeltaV1(db, input.userId, delta),
        applyWorldInfoStateDelta: (db, delta, metadata) => {
          if (!metadata) throw new Error("world_info_state_metadata_unavailable");
          applyWorldInfoStateDeltaV1(db, input.userId, delta, metadata);
        },
      };
      const result = withUserDataMutationSync(
        input.userId,
        () => commitAgenticTurnV1(commitInput),
      );
      if (result.status === "committed" && cognitionRuntime) {
        const committedActivation = await enterCognitionPhase(runtimeExecution, cognitionRuntime, "COMMITTED", workspaceCapabilities, runtimeExecution.signal ?? execution.signal);
        if (contextRuntime) {
          await withToolPermit(
            runtimeExecution.userId,
            () => contextRuntime.refreshContextCapability(committedActivation.contextPackRequirements),
            runtimeExecution.signal ?? execution.signal,
            runtimeExecution.owner.ledger,
          );
        }
      }
      if (result.status === "committed" && result.messageId) {
        const committed = getMessage(input.userId, result.messageId);
        if (committed && committed.chat_id === input.chatId) {
          eventBus.emit(
            binding.target === "normal" ? EventType.MESSAGE_SENT : EventType.MESSAGE_EDITED,
            { chatId: input.chatId, message: committed },
            input.userId,
          );
        }
      }
      return { receiptId: result.receipt.id, commitKey: execution.commitKey, messageId: result.messageId ?? undefined, swipeId: result.swipeId ?? undefined, summary: typeof result.receipt.summary === "object" ? result.receipt.summary as Record<string, unknown> : undefined };
    },
    publishPhase: (event) => {
      const binding = bindings.get(event.executionId);
      const targetMessageId = binding?.messageId ?? event.target.messageId ?? null;
      const targetSwipeId = binding?.swipeId ?? event.target.swipeId ?? null;
      const projection: AgentRunProjectionInputV2 = {
        userId: event.userId,
        chatId: event.chatId,
        turnId: event.executionId,
        generationId: event.executionId,
        generationType: event.target.generationType,
        targetMessageId,
        targetSwipeId,
        status: event.phase,
      };
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, projection));
    },
    publishTerminal: (event) => {
      const status = event.status === "completed"
        ? "COMMITTED"
        : event.status === "cancelled"
          ? "CANCELLED"
          : event.status === "timed_out"
            ? "TIMED_OUT"
            : event.phase;
      const binding = bindings.get(event.executionId);
      const targetMessageId = binding?.messageId ?? event.target.messageId ?? null;
      const targetSwipeId = binding?.swipeId ?? event.target.swipeId ?? null;
      const terminalMessageId = event.receipt?.messageId ?? null;
      const terminalSwipeId = event.receipt?.swipeId ?? null;
      const projection: AgentRunProjectionInputV2 = {
        userId: event.userId,
        chatId: event.chatId,
        turnId: event.executionId,
        generationId: event.executionId,
        generationType: event.target.generationType,
        targetMessageId,
        targetSwipeId,
        status,
        terminalHandoff: {
          version: 2,
          committed: status === "COMMITTED",
          messageId: terminalMessageId,
          swipeId: terminalSwipeId,
          messageRevision: null,
          swipeRevision: null,
        },
        error: event.errorCode ? { code: event.errorCode } : null,
      };
      // The standard stream must always terminate, including when the turn
      // failed before any durable row existed; otherwise the UI hangs.
      const messageId = event.receipt?.messageId ?? undefined;
      const content = pool.getPoolEntry(event.executionId)?.content ?? "";
      try {
        if (event.status === "cancelled") pool.stopPool(event.executionId);
        else if (event.status === "completed") pool.completePool(event.executionId, messageId);
        else pool.errorPool(event.executionId, event.errorCode ?? "agentic_failed");
        eventBus.emit(
          event.status === "cancelled" ? EventType.GENERATION_STOPPED : EventType.GENERATION_ENDED,
          {
            generationId: event.executionId,
            chatId: event.chatId,
            ...(messageId ? { messageId } : {}),
            content,
            ...(targetMessageId ? { targetMessageId } : {}),
            ...(targetSwipeId !== null ? { targetSwipeId } : {}),
            ...(event.errorCode ? { error: event.errorCode } : {}),
          },
          event.userId,
        );
      } finally {
        try {
          withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, projection));
        } catch {
          console.error("[agentic] terminal projection failed (stage_failed)");
        }
      }
    },
    cleanup: ({ execution, executionId }) => {
      const id = execution?.id ?? executionId;
      if (!id) return;
      const runtimeExecution = execution && isRuntimeExecution(execution) ? execution : undefined;
      const durableExecution = runtimeExecution ?? getTurnExecution(id);
      if (durableExecution) {
        invalidateFrameCapabilitiesForTurn({
          userId: durableExecution.userId,
          chatId: durableExecution.chatId,
          turnId: durableExecution.id,
        });
      }
      stopRegistrations.get(id)?.();
      stopRegistrations.delete(id);
      snapshots.delete(id);
      cognitionRuntimes.delete(id);
      contextRuntimes.delete(id);
      plans.delete(id);
      works.delete(id);
      renderFrames.delete(id);
      renders.delete(id);
      renderProjections.delete(id);
      caps.delete(id);
      bindings.delete(id);
      childJoins.delete(id);
      rootSignals.delete(id);
      rootDeadlines.delete(id);
      const disposeDeadline = deadlineDisposers.get(id);
      deadlineDisposers.delete(id);
      disposeDeadline?.();
      runtimeExecution?.owner.close();
      runtimeExecution?.credentialCarrier.clear();
    },
  };
}

/** Install all concrete Agentic authorities before request routes are served. */
export function installAgenticGenerationCoordinator(): void {
  if (installed || installationMarker.get()) return;
  try {
    // Publish the process marker only after every concrete authority is wired.
    // A bootstrap probe may have touched the default fail-closed decision
    // service, but it must not leave a half-installed coordinator behind.
    installDecisionAuthorities();
    configureAgenticGenerationDependencies(buildDependencies());
    installed = true;
    installationMarker.set();
  } catch (error) {
    installed = false;
    installationMarker.clear();
    throw error;
  }
}

export const __testing = {
  buildDependencies,
  makeWorkspace: (execution: AgenticExecutionHandle, capabilities: WorkspaceOperationCapabilitiesV1) =>
    makeWorkspace(requireRuntimeExecution(execution), capabilities, HOST_PREPARATION_LIMITS_V1.maxInputBytes),
  mapRenderPhaseError,
  adoptWorkWorkspaceRevision,
  resetInstallation(): void {
    installed = false;
    preflightSnapshots.clear();
    installationMarker.clear();
  },
};
