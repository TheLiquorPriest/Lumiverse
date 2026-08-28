import type { Database } from "bun:sqlite";
import {
  AgenticGenerationError,
  abortAcceptedAgenticGeneration,
  configureAgenticGenerationRuntimeDependencies,
  type AgenticExecutionHandle,
  type AgenticGenerationDependencies,
  type AgenticGenerationInput,
  type AgenticPhase,
  type AgenticRuntimeDecision,
  type AgenticTargetSnapshot,
} from "./agentic-generation.service";
import { configureAgenticGenerationDependencies } from "./generate.service";
import * as breakdownSvc from "./breakdown.service";
import {
  canonicalInputRevisionDigest,
  canonicalRuntimeCapabilityDigest,
  claimRuntimeDecisionToken,
  consumeRuntimeDecisionToken,
  configureAgentRuntimeDecisionDependencies,
  resolveEffectiveRuntimeWithoutToken,
} from "./agent-runtime-decision.service";
import type {
  AgenticReadinessVectorV1,
  EffectiveRuntimeDecisionV1,
  EffectiveRuntimeRequestV1,
  FrozenConcreteConnectionV1,
  InputRevisionSetV1 as RuntimeInputRevisionSetV1,
  RuntimeDecisionInternalV1,
} from "../types/agent-runtime-decision";
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
  liveDatabankDocumentInputRevision,
  liveChatInputRevision,
  liveConnectionInputRevision,
  liveCredentialInputRevision,
  liveEndpointInputRevision,
  liveMessageInputRevision,
  readLiveSettingsInputRevision,
  type GenerationAssemblySnapshotInputV1,
  type GenerationAssemblySnapshotV1,
} from "./prompt-assembly-snapshot.service";
import { resolveAgenticDatabankProjection } from "./databank/agentic-projection.service";
import {
  projectNativeContextForChat,
  resolveCognitionPresetVariables,
} from "./prompt-assembly.service";
import {
  NativeMediaProjectionError,
  resolveNativeCurrentTurnMedia,
  type NativeMediaProjectionResultV1,
} from "./native-message-media.service";
import {
  selectEffectiveLoomPolicyMessagesV1,
  type AssemblyMediaSegmentV1,
  type AssemblyPlanV1,
  type AssemblyProviderMessageV1,
} from "./agentic-assembly-compiler";
import {
  prepareAgentRender,
  compileAgentAssemblyPlan,
} from "./agentic-preprocessing-worker-client";
import { validateRenderPreparationResultV1 } from "./agentic-render-preparation-validator";
import {
  HOST_PREPARATION_LIMITS_V1,
  type FrozenRegexScriptV1,
  type FrozenSourceMessageV1,
  type FrozenSwipeV1,
  type RegexActionDeltaV1,
  type RenderMacroSnapshotV1,
  type RenderPreparationInputV1,
  type RenderTargetV1,
  type WorldInfoStateDeltaV1,
} from "../types/agent-preprocessing";
import {
  accountProviderResponse,
  executeBoundedAgenticChildFrame,
  runAgenticWorkPhase,
  AgenticWorkPhaseError,
  MAX_CHILD_OUTPUT_BYTES,
  type AgenticChildExecutionResult,
  type AgenticWorkFrame,
  type AgenticWorkProviderRequest,
  type AgenticWorkspaceCapability,
  type AgenticWorkspaceCompletionFixedPointResult,
  type AgenticWorkspacePreparationResult,
  type AgenticWorkPhaseOutcome,
  type AgenticWorkOptions,
  type AgenticWorkRenderHandoff,
} from "./agentic-work-phase.service";
import {
  AgenticRenderPhaseError,
  runAgenticRenderPhaseV1,
  type AgenticRenderPhaseInputV1,
  type AgenticRenderProviderRequestV1,
} from "./agentic-render-phase.service";
import {
  AGENTIC_COMMIT_DEPENDENCIES_V1,
  commitAgenticTurnV1,
  type AgenticCommitInputV1,
} from "./agentic-commit.service";
import {
  calculateFinalRenderReservationEnvelopeV1,
  finalRenderActivityChunksFromHostLimitsV1,
  createTurnExecution,
  finalizeTurnCommit,
  getAgenticReadiness,
  getAgenticRuntimeMode,
  getRuntimeEpoch,
  getTurnCommitReceipt,
  getTurnExecution,
  requestTurnCancellation,
  reserveFinalRender,
  transitionTurnExecution,
  type TurnCommitReceipt,
  type TurnExecutionRecord,
} from "./turn-execution.service";
import type { FinalRenderReservationV1 } from "../types/turn-execution";
import {
  createTurnWorkspace,
  freezeFrameCapabilities,
  invalidateFrameCapabilitiesForTurn,
  getCurrentWorkspaceRevisionV1,
  getWorkspaceCompletionGatesV1,
  type WorkspaceCompletionGatesV1,
  listWorkspaceTaskTransitionsV1,
  listWorkspaceTaskAcceptanceV1,
  readTurnWorkspaceSection,
  freezeWorkspaceForCompletionV1,
  createWorkspaceTask,
  updateWorkspaceTaskProgress,
  submitWorkspaceChildResult,
  submitWorkspaceRootResult,
  settleWorkspaceChildTask,
  acceptWorkspaceSubmission,
  recordWorkspaceRecord,
  attachWorkspaceArtifactReference,
  proposeWorkspacePublication,
  assignChildTasks as assignWorkspaceChildTasks,
  WORKSPACE_MAX_TERMINAL_TTL_SECONDS,
  TurnWorkspaceError,
} from "./turn-workspace.service";
import {
  createPersistentWorkspaceHostAuthority,
  createPersistentWorkspaceHostTask,
  createPersistentWorkspaceHostTurnSession,
  ensurePersistentWorkspaceHost,
  getPersistentWorkspaceById,
  updatePersistentWorkspaceHostTurnSession,
} from "./turn-workspace.service";
import {
  WORKSPACE_OPERATIONS,
  type WorkspaceArtifactReferenceV1,
  type WorkspaceOperationCapabilitiesV1,
  type WorkspaceTerminalHandoffV1,
  type WorkspaceUsageV1,
} from "../types/turn-workspace";
import {
  appendAgentRunSnapshot,
  registerAgentRunStopHandler,
  repairAgentRunProjectionFromReceipt,
  withAgentRunProjectionTransaction,
  type AgentRunProjectionInputV2,
} from "./agent-run-projection.service";
import {
  freezeAgentCognitionV1,
} from "./agent-cognition.service";
import {
  cognitionRuntimeCortexSnapshot,
  createAgentCognitionRuntime,
} from "./agent-cognition-runtime.service";
import {
  admitCortexSidecar,
  createCortexAuthorizedSnapshot,
  createCortexSidecarRequestId,
  CortexSidecarError,
  WORK_CORTEX_CHECKPOINT,
  type CortexAuthorizedSnapshotV1,
  type CortexSidecarAcceptedV1,
  type CortexSidecarReadResultV1,
  WORK_CORTEX_MAX_RESULT_BYTES,
} from "./work-cortex-sidecar.service";
import {
  createWorkCouncilCapability,
  type WorkCouncilAdmission,
} from "./work-council.service";
import type {
  AgentCognitionRuntimeV1,
  CognitionRuntimeActivationV1,
  CognitionRuntimeCompletionV1,
  CognitionRuntimeTaskTransitionInputV1,
} from "../types/agent-cognition-runtime";
import type {
  PersistentWorkspaceHostAuthorityV1,
  PersistentWorkspaceTurnSession,
} from "../types/turn-workspace";

import type {
  CognitionValue,
} from "../types/agent-cognition";
import { buildWorkspaceContextProjectionFromWorkspaceV1 } from "./workspace-context-projection.service";
import { createHash } from "node:crypto";
import {
  COGNITION_REPAIR_CODES,
  applyCognitionReadinessV1,
  type CognitionRepairCode,
} from "./agent-cognition-integrity.service";
import { getDb } from "../db/connection";
import {
  createAgentInspectionWriter,
  type AgentInspectionWriterV1,
} from "./agent-activity-runs.service";
import type {
  AgentInspectionLifecycleV1,
  AgentInspectionOutcomeV1,
  AgentInspectionReasonV1,
  AgentInspectionStatusV1,
} from "../types/agent-run-projection";
import {
  AGENT_RUNTIME_ADMISSION_MANAGER,
} from "./agent-runtime-admission";
import { getAgentRuntimeHostLimits } from "./agent-runtime-limits";
import { resolveCounter } from "./tokenizer.service";
import { withUserDataMutationSync } from "./user-data/snapshot";
import {
  publicActivityToolId,
  AGENT_PUBLIC_ERROR_CODES,
  type AgentActivityLifecycle,
  type AgentActivityNodeV1,
  type AgentActivityUsageV1,
  type AgentPublicErrorCode,
  type AgentWorkAttemptLineageV1,
} from "../types/agent-runtime";
import { getMessage } from "./chats.service";
import type { Message } from "../types/message";
import { getProvider, validateProviderCapabilities } from "../llm/registry";
import type { LlmProvider } from "../llm/provider";
import * as secretsSvc from "./secrets.service";
import { CORE_AGENT_TOOL_IDS, createDisabledAgentConfigV2, parseAgentConfigV2, type AgentConfigStateV1, type AgentConfigV2, type AgentLoreScope, type AgentToolSnapshot, type CoreAgentToolId } from "../types/agents";
import { createAgentOwnedLoreReader, createAgentToolSnapshot, executeCoreAgentTool, safeToolInspectionValue } from "./agent-tools.service";
import { AgentRuntimeOwner } from "./agent-runtime.service";
import { cloneAndFreeze, resolveConcreteConnectionV1, type ResolvedConcreteConnectionV1 } from "./connections.service";
import * as pool from "./generation-pool.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { GenerationRequest, GenerationResponse, GenerationParameters, LlmMessage, LlmMessagePart, StreamChunk } from "../llm/types";
import { redactAgentOutputFrames } from "./agent-seals.service";
import { observeOutputTokens } from "./agent-runtime-accounting";
function cognitionSnapshotInputs(
  userId: string,
  presetId: string | null,
  projectedConfig?: unknown,
): Pick<GenerationAssemblySnapshotInputV1, "cognitionGraph" | "cognitionSource" | "loomPolicy"> {
  if (!presetId) return {};
  const projected = frozenConfig(projectedConfig);
  const authored = getPresetAgentCognitionSourceV1(userId, presetId) as AgentPresetCognitionSourceV1 | null;
  if (!authored) {
    const hasPolicy = [projected.runtimePolicy?.loomPolicy, projected.taskPolicy]
      .some((value) => value !== undefined && value !== null);
    if (hasPolicy) throw new Error("cognition_source_unavailable");
    return {};
  }
  const config = frozenConfig(authored.config);
  const loomPolicy = config.runtimePolicy?.loomPolicy;
  type SourceRef = { blockId: string; revision: number; presetRevision: number; promptOrder: number };
  const refs = new Map<string, SourceRef>();
  const strictRefs = new Map<string, SourceRef>();
  const blocks = listPromptBlocks(userId, presetId) ?? [];
  const blocksById = new Map<string, (typeof blocks)[number]>();
  for (const block of blocks) {
    if (blocksById.has(block.id)) {
      throw new Error("cognition block identity is ambiguous: " + block.id);
    }
    blocksById.set(block.id, block);
  }
  const parseCanonicalSource = (source: unknown): SourceRef | undefined => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
    const sourceRecord = source as Record<string, unknown>;
    const blockRevision = typeof sourceRecord.blockRevision === "number" ? sourceRecord.blockRevision : undefined;
    const presetRevision = typeof sourceRecord.presetRevision === "number" ? sourceRecord.presetRevision : undefined;
    const promptOrder = typeof sourceRecord.promptOrder === "number" ? sourceRecord.promptOrder : undefined;
    if (typeof sourceRecord.blockId !== "string"
      || blockRevision === undefined || !Number.isSafeInteger(blockRevision)
      || presetRevision === undefined || !Number.isSafeInteger(presetRevision)
      || promptOrder === undefined || !Number.isSafeInteger(promptOrder)) return undefined;
    return { blockId: sourceRecord.blockId, revision: blockRevision, presetRevision, promptOrder };
  };
  const recordCanonicalSource = (ref: SourceRef, strict: boolean): void => {
    const previous = refs.get(ref.blockId);
    if (previous && (previous.revision !== ref.revision
      || previous.presetRevision !== ref.presetRevision
      || previous.promptOrder !== ref.promptOrder)) {
      throw new Error(`cognition block provenance conflict: ${ref.blockId}`);
    }
    refs.set(ref.blockId, ref);
    if (strict) strictRefs.set(ref.blockId, ref);
  };
  const collectCanonicalSource = (source: unknown, strict: boolean): void => {
    const ref = parseCanonicalSource(source);
    if (ref) recordCanonicalSource(ref, strict);
  };
  const collectCanonicalEntries = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      collectCanonicalSource((candidate as Record<string, unknown>).source, true);
    }
  };
  if (loomPolicy) {
    collectCanonicalEntries(loomPolicy.workPolicy);
    collectCanonicalEntries(loomPolicy.workspaceUsage);
    collectCanonicalEntries(loomPolicy.completionCriteria);
    collectCanonicalEntries(loomPolicy.renderPolicy);
  }
  const actualBlockRevision = (block: unknown): number => {
    const rawRevision = isRecord(block) ? block.revision : undefined;
    return typeof rawRevision === "number" && Number.isSafeInteger(rawRevision) && rawRevision >= 0
      ? rawRevision
      : typeof rawRevision === "string" && /^\d+$/.test(rawRevision) ? Number(rawRevision) : 1;
  };
  const currentBlockFor = (ref: SourceRef): unknown => {
    const block = blocksById.get(ref.blockId);
    if (!block || actualBlockRevision(block) !== ref.revision
      || ref.presetRevision !== authored.presetRevision
      || blocks.indexOf(block) !== ref.promptOrder) return undefined;
    return block;
  };
  for (const ref of strictRefs.values()) {
    if (!blocksById.has(ref.blockId)) {
      throw new Error("cognition block is unavailable: " + ref.blockId);
    }
    if (!currentBlockFor(ref)) throw new Error("cognition block provenance is stale: " + ref.blockId);
  }
  const collectCanonicalPhaseSources = (phases: readonly {
    instructionRefs: readonly unknown[];
    childInstructionSubsets?: readonly { instructionRefs: readonly unknown[] }[];
  }[]): void => {
    for (const phase of phases) {
      for (const source of phase.instructionRefs) {
        const ref = parseCanonicalSource(source);
        if (ref && currentBlockFor(ref)) recordCanonicalSource(ref, false);
      }
      for (const subset of phase.childInstructionSubsets ?? []) {
        for (const source of subset.instructionRefs) {
          const ref = parseCanonicalSource(source);
          if (ref && currentBlockFor(ref)) recordCanonicalSource(ref, false);
        }
      }
    }
  };
  collectCanonicalPhaseSources(config.runtimePolicy?.phases ?? []);
  const sourceBlocks = [...refs.values()].map((ref) => {
    const block = currentBlockFor(ref);
    if (!block) {
      if (strictRefs.has(ref.blockId)) throw new Error(`cognition block provenance is stale: ${ref.blockId}`);
      return undefined;
    }
    return { blockId: ref.blockId, revision: actualBlockRevision(block), promptOrder: ref.promptOrder };
  }).filter((block): block is { blockId: string; revision: number; promptOrder: number } => block !== undefined);
  const source = { presetRevision: authored.presetRevision, blocks: sourceBlocks };
  const frozen = freezeAgentCognitionV1({
    config,
    taskTemplates: authored.taskTemplates,
  }, source);
  if (!frozen) return {};
  return {
    cognitionGraph: frozen.graph,
    cognitionSource: frozen.source,
    loomPolicy: frozen.policyBuckets,
  };
}

type AgenticRenderPolicyMessageInputV1 = {
  /** Strict ASSEMBLE projection with phased/agent-result carriers excluded. */
  readonly nativeMessages: readonly AssemblyProviderMessageV1[];
  readonly materializeMedia?: (segment: AssemblyMediaSegmentV1) => LlmMessagePart;
  readonly renderGuidance: AgenticWorkRenderHandoff["renderGuidance"];
  readonly renderPolicyMessages: readonly AssemblyProviderMessageV1[];
};

function materializePolicyMessages(messages: readonly AssemblyProviderMessageV1[]): readonly LlmMessage[] {
  return messages.map((message) => {
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") throw new Error("agentic_render_policy_invalid");
    const text = message.segments.map((segment) => {
      if (segment.kind !== "literal") throw new Error("agentic_render_policy_invalid");
      return segment.text;
    }).join("");
    return { role: message.role, content: text };
  });
}

function requireInspectedLoomPolicyMessages(
  messages: readonly AssemblyProviderMessageV1[],
  inspection: unknown,
  bucket: "workPolicy" | "workspaceUsage" | "completionCriteria" | "renderPolicy",
  limits: GenerationAssemblySnapshotV1["limits"],
  authoredCount: number,
): readonly AssemblyProviderMessageV1[] {
  if (authoredCount === 0) return Object.freeze([]);
  if (inspection == null) {
    throw new Error("loom_policy_inspection_required");
  }
  return selectEffectiveLoomPolicyMessagesV1(messages, inspection, bucket, limits);
}

const DELEGATED_WORKSPACE_OPERATIONS: Readonly<Record<string, true>> = Object.freeze({
  read_section: true,
  read_page: true,
  update_assigned_progress: true,
  submit_child_result: true,
});

function materializeNativeRenderMessages(
  messages: readonly AssemblyProviderMessageV1[],
  materializeMedia?: (segment: AssemblyMediaSegmentV1) => LlmMessagePart,
): readonly LlmMessage[] {
  const allowedSources = new Set(["block", "history", "world_info", "databank"]);
  const result: LlmMessage[] = [];
  for (const message of messages) {
    const provenance = message?.provenance;
    if (
      !provenance
      || !allowedSources.has(provenance.kind)
      || provenance.loom !== undefined
      || (message.role !== "system" && message.role !== "user" && message.role !== "assistant")
      || !Array.isArray(message.segments)
      || message.segments.some((segment) => segment.kind === "result_slot")
    ) {
      continue;
    }
    const parts: LlmMessagePart[] = [];
    let text = "";
    const flushText = (): void => {
      if (text.length === 0) return;
      parts.push({ type: "text", text });
      text = "";
    };
    for (const segment of message.segments) {
      if (segment.kind === "literal") {
        text += segment.text;
      } else {
        if (!materializeMedia) throw new Error("agentic_render_media_unavailable");
        flushText();
        parts.push(materializeMedia(segment));
      }
    }
    let content: LlmMessage["content"];
    if (parts.length === 0) {
      content = text;
    } else {
      flushText();
      content = parts;
    }
    result.push({
      role: message.role,
      content,
      ...(message.name ? { name: message.name } : {}),
    });
  }
  return Object.freeze(result);
}

function completionHandoffMessage(
  renderGuidance: AgenticWorkRenderHandoff["renderGuidance"],
): LlmMessage {
  return {
    role: "system",
    content: [
      "Host-accepted completion handoff (not the reply):",
      "WORK has completed. Treat the accepted workspace findings/submissions as additional host-accepted evidence alongside the supplied conversation and native World Info/Databank context. Never infer or expose private WORK records, reasoning, completion evidence, unresolved item IDs, or the operational transcript.",
      ...(renderGuidance ? [`Render guidance:\n${renderGuidance}`] : []),
    ].join("\n"),
  };
}

function buildAgenticRenderPolicyMessages(input: AgenticRenderPolicyMessageInputV1): readonly LlmMessage[] {
  const messages: LlmMessage[] = [
    ...materializeNativeRenderMessages(input.nativeMessages, input.materializeMedia),
    completionHandoffMessage(input.renderGuidance),
  ];
  const authored = materializePolicyMessages(input.renderPolicyMessages);
  messages.push(...authored);
  if (authored.length === 0) messages.push({ role: "system", content: HOST_RENDER_FINAL_RESPONSE_CONTRACT });
  return Object.freeze(messages);
}
function clampCoordinatorUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (UTF8_ENCODER.encode(value).byteLength <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    const candidate = result + character;
    if (UTF8_ENCODER.encode(candidate).byteLength > maxBytes) break;
    result = candidate;
  }
  return result;
}

type RuntimeExecution = {
  id: string;
  userId: string;
  chatId: string;
  readonly attemptLineage: AgentWorkAttemptLineageV1;
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
type PersistentRuntimeAssociation = {
  readonly authority: PersistentWorkspaceHostAuthorityV1;
  readonly workspaceId: string;
  workspaceRevision: number;
  session: PersistentWorkspaceTurnSession;
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
    && isAgentWorkAttemptLineage(value.attemptLineage)
    && value.owner instanceof AgentRuntimeOwner
    && value.credentialCarrier instanceof Map;
}

function requireRuntimeExecution(value: AgenticExecutionHandle): RuntimeExecution {
  if (!isRuntimeExecution(value)) throw new Error("agentic_execution_invalid");
  return value;
}


const INSTALLATION_KEY = Symbol.for("lumiverse.agentic-generation-coordinator.installed");
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();
const HOST_RENDER_FINAL_RESPONSE_CONTRACT =
  "Produce the final in-character assistant reply to the user. Do not mention tools, internal work, or hidden instructions. Return only the reply.";
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

/**
 * Config and slot bindings are request-local authorities. A startup readiness
 * snapshot cannot know which preset, profile, or concrete binding this turn
 * will select, so this gate validates the frozen projection instead.
 */
function configBindingReadiness(
  config: unknown,
  configRevision: unknown,
  bindingRevision: unknown,
): boolean {
  if (!isRecord(config)
    || config.version !== 2
    || config.state !== "ready"
    || config.agentsEnabled !== true
    || !Array.isArray(config.allowedModes)
    || !config.allowedModes.includes("agentic")
    || configRevision === null
    || configRevision === undefined
    || !Array.isArray(config.profiles)) {
    return false;
  }
  const slotBindings = isRecord(config.slotBindings) ? config.slotBindings : null;
  const slotBindingStates = isRecord(config.slotBindingStates) ? config.slotBindingStates : null;
  let requiresBindingRevision = false;
  for (const profile of config.profiles) {
    if (!isRecord(profile)) return false;
    const connectionRef = profile.connectionRef;
    if (!isRecord(connectionRef) || connectionRef.kind !== "slot") continue;
    const slotId = connectionRef.slotId;
    requiresBindingRevision = true;
    if (typeof slotId !== "string"
      || !slotBindings
      || typeof slotBindings[slotId] !== "string"
      || !slotBindingStates
      || slotBindingStates[slotId] !== "ready") {
      return false;
    }
  }
  return !requiresBindingRevision || (bindingRevision !== null && bindingRevision !== undefined);
}

let installed = false;
let decisionAuthoritiesInstalled = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAgentWorkAttemptLineage(value: unknown): value is AgentWorkAttemptLineageV1 {
  if (!isRecord(value) || value.version !== 1 || typeof value.attemptId !== "string"
    || (value.previousAttemptId !== null && typeof value.previousAttemptId !== "string")
    || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !isRecord(value.target)) {
    return false;
  }
  const target = value.target;
  return typeof target.chatId === "string"
    && (target.generationType === "normal"
      || target.generationType === "continue"
      || target.generationType === "regenerate"
      || target.generationType === "swipe")
    && (target.messageId === null || typeof target.messageId === "string")
    && (target.swipeId === null || (typeof target.swipeId === "number" && Number.isSafeInteger(target.swipeId) && target.swipeId >= 0));
}
function isRuntimeInternal(value: unknown): value is RuntimeInternal {
  if (!isRecord(value) || !isRecord(value.binding) || !isRecord(value.childConnections)) return false;
  const rootConnection = value.rootConnection;
  if (
    rootConnection !== null
    && (
      !isRecord(rootConnection)
      || typeof rootConnection.capabilityDigest !== "string"
      || !isRecord(rootConnection.capabilities)
    )
  ) return false;
  if (!Object.values(value.childConnections).every((connection) =>
    isRecord(connection)
    && typeof connection.capabilityDigest === "string"
    && isRecord(connection.capabilities)
  )) return false;
  return typeof value.binding.userId === "string"
    && typeof value.binding.chatId === "string"
    && typeof value.binding.targetDigest === "string"
    && typeof value.binding.inputRevisionDigest === "string"
    && typeof value.binding.readinessDigest === "string"
    && typeof value.binding.capabilityDigest === "string"
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
    mode: value.runtimePolicy.effectiveValue,
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
  const capabilities = cloneAndFreeze(connection.capabilities);
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
    fingerprint: connection.fingerprint ?? null,
    revision: connection.candidateRevision ?? null,
    capabilityDigest: canonicalRuntimeCapabilityDigest(
      capabilities as unknown as Readonly<Record<string, unknown>>,
    ),
    capabilities,
  });
}
function assertProviderCapabilitySnapshot(
  connection: FrozenConcreteConnectionV1,
  provider: LlmProvider,
): void {
  const expectedDigest = connection.capabilityDigest;
  const frozenDigest = canonicalRuntimeCapabilityDigest(connection.capabilities);
  const liveDigest = canonicalRuntimeCapabilityDigest(
    provider.capabilities as unknown as Readonly<Record<string, unknown>>,
  );
  if (
    typeof expectedDigest !== "string"
    || expectedDigest.length === 0
    || frozenDigest !== expectedDigest
    || liveDigest !== expectedDigest
  ) {
    throw new AgenticGenerationError(
      "decision_refresh_required",
      "Provider capability metadata changed after runtime admission.",
      { retryable: true },
    );
  }
}

type CompleteFrozenConnectionV1 = FrozenConcreteConnectionV1 & {
  readonly logicalId: string;
  readonly concreteId: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly effectiveEndpoint: string;
  readonly endpointRevision: Exclude<FrozenConcreteConnectionV1["endpointRevision"], null>;
  readonly credentialSecretRef: string;
  readonly credentialRevision: Exclude<FrozenConcreteConnectionV1["credentialRevision"], null>;
  readonly candidateRevision: Exclude<FrozenConcreteConnectionV1["candidateRevision"], null>;
  readonly fingerprint: string;
};

/**
 * Refine one frozen admission descriptor without substituting live/default
 * identity. Provider capabilities are the only live value consulted, and only
 * to prove that the admitted adapter contract has not changed.
 */
function requireCompleteFrozenConnection(
  connection: FrozenConcreteConnectionV1 | null | undefined,
  phase: AgenticPhase,
  subject: "root" | "child",
): CompleteFrozenConnectionV1 {
  if (!connection) {
    throw new AgenticGenerationError(
      subject === "root" ? "agentic_provider_failure" : "decision_refresh_required",
      subject === "root"
        ? "Agentic root connection is unavailable."
        : "Agentic child connection is unavailable.",
      { phase, retryable: subject === "child" },
    );
  }
  const providerName = connection.provider;
  const logicalId = connection.logicalId;
  const concreteId = connection.concreteId;
  const label = connection.label;
  const model = connection.model;
  const credentialSecretRef = connection.credentialSecretRef;
  const fingerprint = connection.fingerprint;
  const endpointRevision = connection.endpointRevision;
  const credentialRevision = connection.credentialRevision;
  const candidateRevision = connection.candidateRevision;
  const provider = typeof providerName === "string" && providerName ? getProvider(providerName) : undefined;
  const resolvedEndpoint = connection.effectiveEndpoint;
  if (
    !provider
    || typeof providerName !== "string" || !providerName
    || typeof resolvedEndpoint !== "string" || !resolvedEndpoint
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
    throw new AgenticGenerationError(
      subject === "root" ? "agentic_provider_failure" : "decision_refresh_required",
      subject === "root"
        ? "Agentic root connection is incomplete."
        : "Agentic child connection is incomplete.",
      { phase, retryable: subject === "child" },
    );
  }
  assertProviderCapabilitySnapshot(connection, provider);
  validateProviderCapabilities(provider);
  return connection as CompleteFrozenConnectionV1;
}

function requireRenderConnection(connection: FrozenConcreteConnectionV1): ResolvedConcreteConnectionV1 {
  const complete = requireCompleteFrozenConnection(connection, "RENDER", "root");
  return Object.freeze({
    logicalId: complete.logicalId,
    concreteId: complete.concreteId,
    label: complete.label,
    provider: complete.provider,
    model: complete.model,
    endpoint: complete.effectiveEndpoint,
    effectiveEndpoint: complete.effectiveEndpoint,
    endpointRevision: String(complete.endpointRevision),
    credentialSecretRef: complete.credentialSecretRef,
    credentialRevision: String(complete.credentialRevision),
    candidateRevision: String(complete.candidateRevision),
    fingerprint: complete.fingerprint,
    capabilities: cloneAndFreeze(complete.capabilities) as unknown as LlmProvider["capabilities"],
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
    ["capabilityDigest", connection.capabilityDigest],
    ["capabilities", connection.capabilities],
  ];
  const required = new Set(["endpointRevision", "credentialRevision", "candidateRevision", "capabilityDigest"]);
  for (const [key, item] of fields) {
    if (item !== undefined && (item !== null || required.has(key))) projected[key] = item;
  }
  return Object.freeze(projected);
}

function runtimeRequest(
  input: AgenticGenerationInput,
  target: AgenticTargetSnapshot,
  transientMode?: "agentic",
): EffectiveRuntimeRequestV1 {
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
    ...(transientMode
      ? {
        transientSelection: {
          mode: transientMode,
          turnFence: input.requestEpoch ?? 0,
          authenticated: true as const,
        },
      }
      : {}),
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
function bindLiveTarget(
  userId: string,
  chatId: string,
  target: AgenticTargetSnapshot,
  preserveRequestedTarget = false,
): LiveTargetBinding {
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
  const appends = !preserveRequestedTarget && (kind === "swipe" || kind === "regenerate");
  const defaultSwipe = appends ? swipeCount : currentSwipe;
  const requestedSwipe = !preserveRequestedTarget && kind === "regenerate"
    ? swipeCount
    : target.swipeId ?? defaultSwipe;
  const preservesAppendSlot = preserveRequestedTarget
    && (kind === "regenerate" || kind === "swipe")
    && requestedSwipe === swipeCount;
  const maximum = appends || preservesAppendSlot ? swipeCount : swipeCount - 1;
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
const FALLBACK_ROOT_OUTPUT_TOKENS = 4_096;
function authoredPositiveTokenCap(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
function rootMaxOutputTokens(parameters: GenerationParameters | undefined): number | undefined {
  if (!parameters) return undefined;
  const record = parameters as Record<string, unknown>;
  const direct = authoredPositiveTokenCap(record.max_tokens) ?? authoredPositiveTokenCap(record.maxTokens);
  if (direct !== undefined) return direct;
  const overrides = record.samplerOverrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return undefined;
  const sampler = overrides as Record<string, unknown>;
  if (sampler.enabled !== true) return undefined;
  return authoredPositiveTokenCap(sampler.maxTokens);
}
function effectiveRootGenerationParameters(
  snapshot: RuntimeSnapshot,
  input: Pick<AgenticGenerationInput, "parameters">,
): { readonly parameters: GenerationParameters; readonly maxOutputTokens: number } {
  const merged: GenerationParameters = {
    ...((snapshot.preset?.parameters ?? {}) as GenerationParameters),
    ...(input.parameters ?? {}),
  };
  const maxOutputTokens = rootMaxOutputTokens(merged) ?? FALLBACK_ROOT_OUTPUT_TOKENS;
  return {
    parameters: { ...merged, max_tokens: maxOutputTokens },
    maxOutputTokens,
  };
}
function normalizeLoreScope(value: string | undefined): AgentLoreScope {
  return value === "all_owned" ? "all_owned" : "active";
}
function isAgenticTimeout(
  error: unknown,
  signals: readonly (AbortSignal | undefined)[],
  deadlineAt?: number,
): boolean {
  if (error instanceof AgenticGenerationError && error.code === "agentic_timed_out") return true;
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  for (const signal of signals) {
    if (!signal?.aborted) continue;
    const reason = signal.reason;
    if (reason === "agentic_timed_out" || reason === "timed_out") return true;
    if (reason instanceof AgenticGenerationError && reason.code === "agentic_timed_out") return true;
    if (reason instanceof DOMException && reason.name === "TimeoutError") return true;
    if (isRecord(reason) && (
      reason.code === "agentic_timed_out"
      || reason.code === "timed_out"
      || reason.name === "TimeoutError"
    )) return true;
  }
  return deadlineAt !== undefined && deadlineAt <= Date.now();
}

function persistentAdmissionOutcomeForFailure(input: {
  executionId: string;
  userId: string;
  error: unknown;
  signals: readonly (AbortSignal | undefined)[];
  deadlineAt: number;
}): Exclude<PersistentWorkspaceTurnSession["outcome"], null> {
  let durablePhase: TurnExecutionRecord["phase"] | undefined;
  try {
    durablePhase = getTurnExecution(input.executionId, input.userId)?.phase;
  } catch {
    // The original admission error remains authoritative when the execution
    // row cannot be read during failure cleanup.
  }
  if (durablePhase === "EXHAUSTED") return "exhausted";
  if (durablePhase === "TIMED_OUT") return "failed";
  if (durablePhase === "CANCELLED") return "stopped";
  if (isAgenticTimeout(input.error, input.signals, input.deadlineAt)) return "failed";
  if (input.signals.some((signal) => signal?.aborted === true)) return "stopped";
  if (input.error instanceof AgenticGenerationError) {
    if (input.error.code === "agentic_work_exhausted") return "exhausted";
    if (input.error.code === "decision_refresh_required") return "rejected";
  }
  return "failed";
}

function assemblyAbortError(signal: AbortSignal): AgenticGenerationError {
  const timedOut = isAgenticTimeout(undefined, [signal]);
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
    assemblySurface: "WORK",
    userId: input.userId,
    chatId: input.chatId,
    generationId: `agentic:${input.chatId}:${target.generationType}:${target.messageId ?? "new"}`,
    generationType: target.generationType,
    connectionId: connection?.logicalId ?? connection?.concreteId ?? input.connectionId ?? null,
    presetId,
    forcePresetId: input.forcePresetId === true,
    personaId: input.personaId ?? null,
    targetCharacterId: target.targetCharacterId ?? input.targetCharacterId ?? null,
    targetMessageId: target.messageId ?? input.messageId ?? null,
    targetSwipeId: target.swipeId ?? input.swipeId ?? null,
    excludeMessageId:
      target.generationType === "regenerate" || target.generationType === "swipe"
        ? target.messageId ?? input.messageId ?? null
        : null,
    userInput: input.userInput ?? "",
    toolIds: authoredToolIds(projection?.config),
    configRevision: projection?.configRevision ?? internal.binding.configRevision,
    bindingRevision: projection?.bindingRevision ?? internal.binding.bindingRevision,
    concreteConnection: snapshotConnection(connection) ?? undefined,
    agentConfig: projection?.config ?? null,
    ...cognition,
  };
}
interface NativeSnapshotProjectionResult {
  readonly snapshotInput: GenerationAssemblySnapshotInputV1;
  readonly materializeMedia: NativeMediaProjectionResultV1["materialize"];
}

async function snapshotInputWithNativeContext(
  input: AgenticGenerationInput,
  decision: AgenticRuntimeDecision,
  target: AgenticTargetSnapshot,
  concreteConnection: FrozenConcreteConnectionV1 | null | undefined,
  signal: AbortSignal,
): Promise<NativeSnapshotProjectionResult> {
  const base = snapshotInput(input, decision, target, concreteConnection);
  const excludedMessageId =
    target.generationType === "regenerate" || target.generationType === "swipe"
      ? target.messageId ?? input.messageId ?? null
      : null;
  const projectionOptions = {
    personaId: input.personaId ?? null,
    targetCharacterId: target.targetCharacterId ?? input.targetCharacterId ?? null,
    personaAddonStates: input.personaAddonStates,
    excludedMessageId,
    generationType: target.generationType,
    presetId: base.presetId,
    connectionId: base.connectionId,
    forcePresetId: base.forcePresetId,
    userInput: input.userInput ?? "",
    signal,
  };
  let media: NativeMediaProjectionResultV1;
  try {
    const [databank, nativeContext, resolvedMedia] = await Promise.all([
      resolveAgenticDatabankProjection({
        userId: input.userId,
        chatId: input.chatId,
        targetCharacterId: projectionOptions.targetCharacterId,
        excludedMessageId,
        userInput: input.userInput ?? "",
        signal,
      }),
      projectNativeContextForChat(input.userId, input.chatId, projectionOptions),
      resolveNativeCurrentTurnMedia(
        input.userId,
        input.chatId,
        input.sourceUserMessageIds ?? [],
      ),
    ]);
    media = resolvedMedia;
    return {
      snapshotInput: {
        ...base,
        databank,
        structuralBlockValues: nativeContext.structuralBlockValues,
        mediaPartsByMessageId: media.byMessageId,
        nativeWorldInfo: nativeContext.worldInfo,
      },
      materializeMedia: media.materialize,
    };
  } catch (error) {
    if (error instanceof NativeMediaProjectionError) {
      throw new AgenticGenerationError("agentic_protocol_failure", error.message, {
        phase: "ASSEMBLE",
        cause: error,
      });
    }
    throw error;
  }
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
  let fencedSnapshotIndex: ReadonlyMap<string, { revision: string; digest: string }> | null | undefined;
  let fencedSnapshotDb: Database | undefined;
  return (member: RevisionMember, db?: Database): { revision: string; digest: string } | null => {
    if (typeof member?.kind !== "string" || typeof member?.id !== "string") return null;
    // Never retain the commit-preflight snapshot as the revision authority.
    // COMMIT supplies its transaction handle so this read observes the same
    // SQLite fence that protects the subsequent delta/message writes.
    const revisionDb = db ?? getDb();
    if (member.kind === "chat") {
      const row = revisionDb.query(
        "SELECT generation_revision FROM chats WHERE id = ? AND user_id = ? LIMIT 1",
      ).get(member.id, snapshotInputValue.userId) as { generation_revision?: unknown } | null;
      if (!row) return null;
      return liveChatInputRevision(member.id, row.generation_revision);
    }
    if (member.kind === "message") {
      const row = revisionDb.query(
        "SELECT m.generation_revision FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND m.chat_id = ? AND c.user_id = ? LIMIT 1",
      ).get(member.id, snapshotInputValue.chatId, snapshotInputValue.userId) as { generation_revision?: unknown } | null;
      if (!row) return null;
      return liveMessageInputRevision(member.id, row.generation_revision);
    }
    if (member.kind === "databank") {
      const row = revisionDb.query(
        "SELECT databank_id, name, content_hash, status FROM databank_documents WHERE id = ? AND user_id = ? LIMIT 1",
      ).get(member.id, snapshotInputValue.userId) as {
        databank_id?: unknown;
        name?: unknown;
        content_hash?: unknown;
        status?: unknown;
      } | null;
      if (!row) return null;
      return liveDatabankDocumentInputRevision(
        member.id,
        row.databank_id,
        row.name,
        row.content_hash,
        row.status,
      );
    }
    if (member.kind === "settings") {
      return readLiveSettingsInputRevision(
        revisionDb,
        snapshotInputValue.userId,
        snapshotInputValue.presetId ?? null,
      );
    }
    const frozenConcreteId = typeof snapshotInputValue.concreteConnection?.concreteId === "string"
      ? snapshotInputValue.concreteConnection.concreteId
      : null;
    if (member.kind === "connection" || member.kind === "endpoint" || member.kind === "credential") {
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
      if (!liveConnection) return null;
      if (frozenConcreteId && liveConnection.concreteId !== frozenConcreteId) return null;
      const liveId = String(liveConnection.concreteId ?? liveConnection.logicalId ?? "default");
      if (liveId !== member.id) return null;
      if (member.kind === "connection") return liveConnectionInputRevision(member.id, liveConnection.candidateRevision);
      if (member.kind === "endpoint") return liveEndpointInputRevision(member.id, liveConnection.endpointRevision);
      return liveCredentialInputRevision(member.id, liveConnection.credentialRevision);
    }
    // Generic members (character, lore, config) must not reuse a snapshot
    // built before acquireCommitWriteFence. Only an in-transaction
    // view of this same handle may be retained for later members / delta CAS.
    const inTransaction = revisionDb.inTransaction === true;
    if (!inTransaction || fencedSnapshotDb !== revisionDb) {
      fencedSnapshotIndex = undefined;
      fencedSnapshotDb = undefined;
    }
    if (fencedSnapshotIndex === undefined) {
      let liveInput = snapshotInputValue;
      if (snapshotInputValue.presetId) {
        const configRow = revisionDb.query(
          "SELECT config_revision, binding_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ? LIMIT 1",
        ).get(snapshotInputValue.userId, snapshotInputValue.presetId) as { config_revision?: unknown; binding_revision?: unknown } | null;
        if (!configRow) {
          if (inTransaction) {
            fencedSnapshotIndex = null;
            fencedSnapshotDb = revisionDb;
          }
          return null;
        }
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
        if (frozenConcreteId && liveConnection?.concreteId !== frozenConcreteId) {
          if (inTransaction) {
            fencedSnapshotIndex = null;
            fencedSnapshotDb = revisionDb;
          }
          return null;
        }
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
      const index = indexSnapshotRevisions(liveSnapshot);
      if (!inTransaction) return index.get(`${member.kind}:${member.id}`) ?? null;
      fencedSnapshotIndex = index;
      fencedSnapshotDb = revisionDb;
    }
    return fencedSnapshotIndex?.get(`${member.kind}:${member.id}`) ?? null;
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
    connection.capabilityDigest ?? "",
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
  const provider = typeof providerName === "string" && providerName ? getProvider(providerName) : undefined;
  const endpoint = connection.effectiveEndpoint
    || (typeof provider?.defaultUrl === "string" ? provider.defaultUrl : "");
  if (!providerName || !endpoint || !connection.model || !provider) throw new Error("provider_unavailable");
  assertProviderCapabilitySnapshot(connection, provider);

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
  countTokens?: (text: string) => number,
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
      console.error(`[agentic] collect receive ${nextBytes} bytes exceeds ${limit}`);
      throw new AgenticWorkPhaseError("limit_exceeded", `Provider output exceeds the frozen receive limit (${nextBytes} > ${limit})`);
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
      observed = observeOutputTokens({
        content: response.content,
        finish_reason: response.finish_reason,
        ...(response.tool_calls ? { tool_calls: response.tool_calls } : {}),
      }, { countTokens });
    } catch {
      throw new AgenticWorkPhaseError("provider_protocol_error", "Provider child output accounting failed");
    }
    const remaining = ledger.remaining("child_output_tokens");
    if (observed > 0 && !ledger.charge("child_output_tokens", observed)) {
      console.error(`[agentic] child ledger charge failed: observed=${observed} remaining=${remaining}`);
      throw new AgenticWorkPhaseError("child_output_limit_exceeded", `Aggregate child output token limit exceeded (${observed} > ${remaining})`);
    }
  }
  return response;
}

type WorkProviderExchangeOutcome =
  | { readonly status: "succeeded"; readonly response: GenerationResponse }
  | { readonly status: "failed"; readonly error: unknown };

type WorkProviderExchangeObserver = (
  request: AgenticWorkProviderRequest,
  outcome: WorkProviderExchangeOutcome,
) => void;

function assertExactWorkDispatchIdentity(
  request: AgenticWorkProviderRequest,
  connection: CompleteFrozenConnectionV1,
): void {
  if (
    request.connectionId !== connection.concreteId
    || request.model !== connection.model
    || request.frame.connectionId !== connection.concreteId
    || request.frame.provider !== connection.provider
    || request.frame.model !== connection.model
  ) {
    throw new AgenticWorkPhaseError(
      "provider_protocol_error",
      "Provider dispatch identity does not match the frozen connection",
    );
  }
}

function makeWorkProvider(
  userId: string,
  connection: CompleteFrozenConnectionV1,
  parameters: GenerationParameters | undefined,
  ledger: AgentRuntimeOwner["ledger"] | undefined,
  frozenCredential: string,
  onExchange?: WorkProviderExchangeObserver,
) {
  return async (request: AgenticWorkProviderRequest): Promise<GenerationResponse> => {
    assertExactWorkDispatchIdentity(request, connection);
    const continuationMode = connection.capabilities.toolContinuationMode;
    if (continuationMode !== "native" && continuationMode !== "legacy") {
      throw new AgenticWorkPhaseError("provider_protocol_error", "Provider tool continuation is unsupported");
    }
    const generationRequest: GenerationRequest = {
      messages: [...request.messages],
      model: connection.model,
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
    let providerSettled = false;
    try {
      const stream = await providerStream(userId, connection, generationRequest, frozenCredential, ledger);
      const iterator = stream[Symbol.asyncIterator]();
      const iterable: AsyncIterable<StreamChunk> = { [Symbol.asyncIterator]: () => iterator };
      const counter = await resolveCounter(connection.model);
      const collection = collectProviderResponse(
        iterable,
        request.receiveLimitBytes,
        ledger,
        request.frame.kind === "child",
        counter.count,
      );
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => {
          void iterator.return?.();
          reject(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        if (request.signal.aborted) abortListener();
        else request.signal.addEventListener("abort", abortListener, { once: true });
      });
      let response: GenerationResponse;
      try {
        response = await Promise.race([collection, aborted]);
      } finally {
        if (abortListener) request.signal.removeEventListener("abort", abortListener);
      }
      accountProviderResponse(
        response,
        request.receiveLimitBytes,
        request.maxOutputTokens,
        { tokenBasis: "published_content", countTokens: counter.count },
      );
      if (
        (response.tool_calls?.length ?? 0) === 0
        && UTF8_ENCODER.encode(response.content).byteLength > request.publishedOutputLimitBytes
      ) {
        throw new AgenticWorkPhaseError("child_output_limit_exceeded", "Provider output exceeds the child publication limit");
      }
      providerSettled = true;
      onExchange?.(request, { status: "succeeded", response });
      return response;
    } catch (error) {
      if (!providerSettled) onExchange?.(request, { status: "failed", error });
      throw error;
    }
  };
}

function isProviderTimeout(value: unknown): boolean {
  return value instanceof DOMException && value.name === "TimeoutError"
    || value instanceof AgenticGenerationError && value.code === "agentic_timed_out"
    || value instanceof Error && value.name === "TimeoutError";
}

function childProviderFailure(
  error: unknown,
  signal: AbortSignal,
): { readonly status: "failed" | "cancelled" | "timed_out"; readonly code: string; readonly reason: AgentInspectionReasonV1 } {
  if (signal.aborted) {
    return isProviderTimeout(signal.reason)
      ? { status: "timed_out", code: "timed_out", reason: "deadline" }
      : { status: "cancelled", code: "cancelled", reason: "interrupted" };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { status: "cancelled", code: "cancelled", reason: "interrupted" };
  }
  if (error instanceof AgenticWorkPhaseError) {
    if (error.code === "limit_exceeded" || error.code === "child_output_limit_exceeded") {
      return { status: "failed", code: error.code, reason: "budget_exhausted" };
    }
    if (error.code === "provider_protocol_error") {
      return { status: "failed", code: error.code, reason: "invalid_input" };
    }
  }
  return { status: "failed", code: "provider_failure", reason: "provider_failure" };
}

function recordChildProviderExchange(
  writer: AgentInspectionWriterV1 | undefined,
  request: AgenticWorkProviderRequest,
  outcome: WorkProviderExchangeOutcome,
  connection: CompleteFrozenConnectionV1,
  configRevision: string | number | null,
  profileId: string,
  childId: string,
): void {
  if (!writer) return;
  const frameDigest = createHash("sha256").update(request.frame.frameId, "utf8").digest("hex");
  const exchangeId = "provider:work:child:" + frameDigest + ":" + request.roundIndex;
  const taskId = request.frame.assignedTaskId ?? childId;
  const correlation = { taskId, parentId: request.frame.parentFrameId };
  const response = outcome.status === "succeeded" ? outcome.response : undefined;
  const failure = outcome.status === "failed"
    ? childProviderFailure(outcome.error, request.signal)
    : undefined;
  const boundary = failure?.status === "cancelled"
    ? { lifecycle: "WORK" as const, status: "cancelling" as const }
    : { lifecycle: "WORK" as const, status: "running" as const };
  writer.record("provider_exchange", {
    id: exchangeId,
    kind: "provider_exchange",
    actor: "provider",
    recipient: "child",
    ...(response ? { content: response.content } : {}),
    arguments: JSON.stringify({
      profileId,
      provider: connection.provider,
      connectionId: connection.concreteId,
      model: connection.model,
      configRevision,
      sourceFingerprint: connection.fingerprint,
      roundIndex: request.roundIndex,
      toolCalls: (response?.tool_calls ?? []).map((call) => ({
        callId: call.call_id,
        toolName: call.name,
        args: call.args,
      })),
    }),
    result: response
      ? JSON.stringify({ finishReason: response.finish_reason, usage: response.usage ?? null })
      : JSON.stringify({ status: failure!.status, code: failure!.code }),
    provider: {
      adapter: "agentic-work",
      providerId: connection.provider,
      modelId: connection.model,
      connectionId: connection.concreteId,
      configRevision,
      connectionRevision: connection.candidateRevision,
      fingerprint: connection.fingerprint,
    },
    ...(failure ? { errorReason: failure.reason } : {}),
    correlation,
  }, boundary);
  if (response?.usage) {
    writer.record("usage", {
      version: 1,
      id: "usage:" + exchangeId,
      source: "provider_reported",
      layer: "child",
      correlation,
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens,
      toolCalls: response.tool_calls?.length ?? 0,
      childInvocations: 0,
      canonical: false,
    }, boundary);
  }
}

type InspectionRecordArguments = Parameters<AgentInspectionWriterV1["record"]>;

function createChildInspectionCorrelation(
  authority: AgentInspectionWriterV1 | undefined,
): {
  readonly writer: AgentInspectionWriterV1 | undefined;
  readonly childTaskIds: ReadonlyMap<string, string>;
  readonly bind: (childId: string, assignedTaskId?: string) => void;
  readonly flush: () => void;
} {
  const childTaskIds = new Map<string, string>();
  const pendingPolicies = new Map<string, InspectionRecordArguments[]>();

  const write = (
    kind: InspectionRecordArguments[0],
    value: InspectionRecordArguments[1],
    state: InspectionRecordArguments[2],
    allowDefer: boolean,
  ) => {
    if (!authority || !isRecord(value)) return authority?.record(kind, value, state) ?? null;
    const source = value;
    const requestedCorrelation = isRecord(source.correlation) ? source.correlation : {};
    const requestedTaskId = typeof requestedCorrelation.taskId === "string"
      ? requestedCorrelation.taskId
      : undefined;
    const policyPrefix = "work:child-policy:";
    const policyChildId = typeof source.id === "string" && source.id.startsWith(policyPrefix)
      ? source.id.slice(policyPrefix.length)
      : undefined;
    let projectedTaskId = requestedTaskId;
    if (requestedTaskId !== undefined && source.kind === "child_result" && source.actor === "child") {
      projectedTaskId = childTaskIds.get(requestedTaskId) ?? requestedTaskId;
    }
    if (policyChildId) {
      const bound = childTaskIds.get(policyChildId);
      if (!bound && allowDefer) {
        const pending = pendingPolicies.get(policyChildId) ?? [];
        pending.push([kind, value, state]);
        pendingPolicies.set(policyChildId, pending);
        return null;
      }
      projectedTaskId = bound ?? policyChildId;
    }
    if (projectedTaskId === undefined) return authority.record(kind, value, state);
    return authority.record(kind, {
      ...source,
      correlation: { ...requestedCorrelation, taskId: projectedTaskId },
    }, state);
  };

  const bind = (childId: string, assignedTaskId?: string): void => {
    childTaskIds.set(childId, assignedTaskId ?? childId);
    const pending = pendingPolicies.get(childId);
    if (!pending) return;
    pendingPolicies.delete(childId);
    for (const [kind, value, state] of pending) write(kind, value, state, false);
  };
  const flush = (): void => {
    for (const childId of [...pendingPolicies.keys()]) bind(childId);
  };
  const writer = authority
    ? Object.freeze({
        record: (...args: InspectionRecordArguments) => write(args[0], args[1], args[2], true),
      })
    : undefined;
  return Object.freeze({ writer, childTaskIds, bind, flush });
}

/** Never throws: tokenizer resolution falls back to chars/4. */
async function resolveRenderCountTokens(model: string | undefined): Promise<(text: string) => number> {
  try {
    return (await resolveCounter(model ?? "")).count;
  } catch {
    return (text) => (text ? Math.ceil(text.length / 4) : 0);
  }
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
  onDispatch?: (request: GenerationRequest) => void,
) {
  return async (request: AgenticRenderProviderRequestV1): Promise<AsyncIterable<StreamChunk>> => {
    if (connection.capabilities.toolsDisabledFinalization !== true) {
      throw new AgenticRenderPhaseError("render_tool_finalization_unsupported");
    }
    const maxOutputTokens = request.maxOutputTokens
      ?? rootMaxOutputTokens(request.parameters as GenerationParameters | undefined)
      ?? FALLBACK_ROOT_OUTPUT_TOKENS;
    const generationRequest: GenerationRequest = {
      messages: [...request.messages],
      model: connection.model ?? request.model,
      parameters: { ...(request.parameters ?? {}), max_tokens: maxOutputTokens },
      tools: [],
      stream: true,
      signal: request.signal,
      receiveLimitBytes: request.receiveLimitBytes,
      toolMode: "finalization",
    };
    onDispatch?.(generationRequest);
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
    selective: false, constant: false, disabled: entry.disabled, group_name: "", group_override: false, group_weight: 0,
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
  return createAgentToolSnapshot({
    rootUserId: snapshot.userId,
    chatId: snapshot.chatId,
    books,
    entries,
    messages,
    names,
    ownedLore: createAgentOwnedLoreReader(snapshot.userId),
    signal,
  });
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
 * Keep the private cognition state aligned with a successful workspace CAS that
 * cannot change cognition predicates (records, artifacts, or child assignment).
 */
type WorkspaceCognitionRuntime = Pick<
  AgentCognitionRuntimeV1,
  "acceptCompletionFixedPoint" | "adoptWorkspaceMutationRevision" | "applyWorkspaceTransition"
>;
function advanceNonCognitionWorkspaceRevision(
  execution: Pick<RuntimeExecution, "workspaceRevision">,
  cognitionRuntime: WorkspaceCognitionRuntime | undefined,
  workspaceRevision: number,
): void {
  if (!cognitionRuntime) {
    advanceWorkspaceRevision(execution, { workspaceRevision });
    return;
  }
  const current = execution.workspaceRevision ?? 0;
  if (!Number.isSafeInteger(workspaceRevision) || workspaceRevision !== current + 1) {
    throw new Error("workspace_revision_conflict");
  }
  cognitionRuntime.adoptWorkspaceMutationRevision(workspaceRevision);
  execution.workspaceRevision = workspaceRevision;
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

function publicWorkActivityUsage(
  outcome: Pick<AgenticWorkPhaseOutcome, "observations" | "childResults">,
): AgentActivityUsageV1 {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: outcome.observations.length,
    childInvocations: outcome.childResults.length,
  };
}


const PUBLIC_WORK_ACTIVITY_ERROR_CODES = new Set<string>(AGENT_PUBLIC_ERROR_CODES);

function publicWorkActivityErrorCode(value: unknown): AgentPublicErrorCode | undefined {
  return typeof value === "string" && PUBLIC_WORK_ACTIVITY_ERROR_CODES.has(value)
    ? value as AgentPublicErrorCode
    : undefined;
}

function recordPublicWorkActivity(
  ledger: { recordActivityNode(node: AgentActivityNodeV1): void },
  outcome: Pick<AgenticWorkPhaseOutcome, "observations" | "childResults">,
  generationId: string,
  childTaskIds?: ReadonlyMap<string, string>,
  seenNodeIds: Set<string> = new Set<string>(),
  usage: AgentActivityUsageV1 = publicWorkActivityUsage(outcome),
): AgentActivityUsageV1 {
  if (usage.toolCalls === 0 && usage.childInvocations === 0) return usage;
  const startedAt = Date.now();
  for (const observation of outcome.observations) {
    const id = typeof observation.callId === "string" && observation.callId.length > 0
      ? observation.callId
      : `work-tool:${observation.sequence}`;
    if (seenNodeIds.has(id)) continue;
    seenNodeIds.add(id);
    const status: AgentActivityLifecycle = observation.status === "error" || observation.status === "rejected"
      ? "failed"
      : "completed";
    const errorCode = publicWorkActivityErrorCode(observation.code);
    ledger.recordActivityNode({
      id,
      parentId: generationId,
      kind: "tool_attempt",
      actor: "tool",
      phase: "running",
      status,
      startedAt,
      elapsedMs: 0,
      toolId: publicActivityToolId(observation.toolName),
      usage,
      ...(errorCode ? { errorCode } : {}),
    });
  }
  for (const child of outcome.childResults) {
    const taskId = childTaskIds?.get(child.childId) ?? child.childId;
    const id = "task:" + taskId;
    if (seenNodeIds.has(id)) continue;
    seenNodeIds.add(id);
    const status: AgentActivityLifecycle = child.status === "succeeded" ? "completed" : child.status;
    const errorCode = publicWorkActivityErrorCode(child.errorCode);
    ledger.recordActivityNode({
      id,
      parentId: generationId,
      kind: "child_invocation",
      actor: "child",
      phase: "running",
      status,
      startedAt,
      elapsedMs: 0,
      taskId,
      ...(typeof child.profileId === "string" && child.profileId.length > 0
        ? { profileId: child.profileId }
        : {}),
      usage,
      ...(errorCode ? { errorCode } : {}),
    });
  }
  return usage;
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
    "state", "activation", "cognition", "sourceRevisions", "sourceDigest",
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
    }),
  });
}
function readCognitionWorkspaceSettlement(value: unknown): { readonly workspaceRevision: number } {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "result") || !isRecord(value.result)) {
    throw new Error("workspace_settlement_result_invalid");
  }
  const workspaceRevision = value.result.workspaceRevision;
  if (!Number.isSafeInteger(workspaceRevision) || (workspaceRevision as number) < 0) {
    throw new Error("workspace_settlement_result_invalid");
  }
  if (!isRecord(value.cognition)) {
    throw new Error("workspace_settlement_result_invalid");
  }
  const cognitionRevision = value.cognition.workspaceRevision;
  if (!Number.isSafeInteger(cognitionRevision)
    || (cognitionRevision as number) < 0
    || cognitionRevision !== workspaceRevision) {
    throw new Error("workspace_settlement_result_invalid");
  }
  return { workspaceRevision: workspaceRevision as number };
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
  cognitionRuntime?: WorkspaceCognitionRuntime,
): AgenticWorkspaceCapability {
  const sanitizeWorkspaceArgs = (operationArgs: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
    Object.entries(operationArgs).filter(([key]) =>
      key !== "userId" && key !== "chatId" && key !== "turnId" && key !== "workspaceId"
      && key !== "actor" && key !== "frameId" && key !== "expectedRevision"
      && key !== "revision" && key !== "capabilities" && key !== "fieldCapabilities"
      && key !== "operationKey"
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
  // Revision reads accept only the immutable workspace identity; actor and
  // capability fields belong to operation contexts and are intentionally absent.
  const workspaceIdentity = (): Record<string, unknown> => ({
    userId: execution.userId,
    chatId: execution.chatId,
    turnId: execution.id,
    workspaceId: execution.workspaceId,
  });

  const authenticatedContext = (
    actor: "root" | "child" | "host",
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
      ...(frameId ? { frameId } : {}),
      expectedRevision,
      ...sanitizeWorkspaceArgs(operationArgs),
    };
  };
  const applyCognitionWorkspaceTransition = cognitionRuntime
    ? async (input: CognitionRuntimeTaskTransitionInputV1): Promise<unknown> => {
      const rawWorkspace = input.workspace && typeof input.workspace === "object" && !Array.isArray(input.workspace)
        ? input.workspace as Record<string, unknown>
        : {};
      const actor = rawWorkspace.actor === "child"
        ? "child"
        : rawWorkspace.actor === "host"
          ? "host"
          : "root";
      if (
        (input.operation === "create_task" || input.operation === "submit_root_result" || input.operation === "accept_submission")
        && actor !== "root"
      ) {
        throw new Error("workspace_actor_forbidden");
      }
      if (input.operation === "settle_child_failure" && actor !== "host") {
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
            prepareAcceptance: (completion: CognitionRuntimeCompletionV1) => {
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
    settleAssignedTask: async ({ taskId, frameId, state, operationKey, signal }) => {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const expectedRevision = execution.workspaceRevision ?? 0;
      const authenticated = authenticatedContext("host", frameId, {
        taskId,
        assignedFrameId: frameId,
        state,
      }, expectedRevision);
      if (cognitionRuntime && applyCognitionWorkspaceTransition) {
        const rawResult = await abortable(Promise.resolve(applyCognitionWorkspaceTransition({
          taskId,
          transition: state,
          operationKey: requireOperationKey(operationKey),
          workspace: authenticated,
          operation: "settle_child_failure",
          signal,
        })), signal);
        const settlement = readCognitionWorkspaceSettlement(rawResult);
        advanceWorkspaceRevision(execution, rawResult);
        return {
          accepted: true,
          workspaceRevision: settlement.workspaceRevision,
        };
      }
      await abortable(withToolPermit(
        execution.userId,
        () => settleWorkspaceChildTask(authenticated),
        signal,
        execution.owner.ledger,
      ), signal);
      const workspaceRevision = getCurrentWorkspaceRevisionV1(workspaceIdentity());
      advanceNonCognitionWorkspaceRevision(execution, cognitionRuntime, workspaceRevision);
      return { accepted: true, workspaceRevision };
    },
    getPhaseEvaluationSnapshot: async ({ phase: _phase, expectedRevision, signal }) => {
      const expected = expectedRevision ?? execution.workspaceRevision ?? 0;
      const snapshot = await abortable(withToolPermit(
        execution.userId,
        () => {
          if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
          const beforeRevision = getCurrentWorkspaceRevisionV1(workspaceIdentity());
          if (expectedRevision !== undefined && beforeRevision !== expectedRevision) {
            throw new TurnWorkspaceError("stale_revision", "workspace revision changed before phase evaluation");
          }
          const transitionSnapshot = listWorkspaceTaskTransitionsV1(rootContext({}, beforeRevision));
          const afterRevision = getCurrentWorkspaceRevisionV1(workspaceIdentity());
          if (beforeRevision !== afterRevision || transitionSnapshot.workspaceRevision !== afterRevision) {
            throw new TurnWorkspaceError("stale_revision", "workspace revision changed during phase evaluation");
          }
          return Object.freeze({
            workspaceRevision: afterRevision,
            taskTransitions: Object.freeze({ ...transitionSnapshot.taskTransitions }),
          });
        },
        signal,
        execution.owner.ledger,
      ), signal);
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      return snapshot;
    },
    getCompletionGates: ({ frame }) => {
      const gates = getWorkspaceCompletionGatesV1(context(frame));
      return {
        workspaceRevision: gates.workspaceRevision,
        canComplete: gates.accepted,
        requiredOpenTasks: gates.openRequiredTaskIds.length,
        openRequiredTaskIds: gates.openRequiredTaskIds,
        unacceptedSubmissions: gates.pendingSubmissionCount,
      };
    },
    listRequiredOpenTasks: ({ frame }) => {
      const gates = getWorkspaceCompletionGatesV1(context(frame));
      return gates.openRequiredTaskIds;
    },
    listTaskAcceptance: ({ frame }) => listWorkspaceTaskAcceptanceV1(context(frame)),

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
        if (operation === "submit_root_result") return submitWorkspaceRootResult(raw);
        if (operation === "accept_submission") return acceptWorkspaceSubmission(raw);
        if (operation === "record_finding" || operation === "record_decision" || operation === "record_question") {
          const kind = operation === "record_finding"
            ? "finding"
            : operation === "record_decision"
              ? "decision"
              : "question";
          const { digest: _untrustedDigest, ...recordInput } = raw;
          return recordWorkspaceRecord({ ...recordInput, kind });
        }
        if (operation === "attach_artifact") return attachWorkspaceArtifactReference(raw);
        return proposeWorkspacePublication(raw);
      }, toolContext.signal, execution.owner.ledger);
      if (toolContext.signal.aborted) throw toolContext.signal.reason ?? new DOMException("Aborted", "AbortError");
      // Every mutating operation normally commits one workspace CAS revision.
      // Accepting an already-accepted submission is the canonical idempotent
      // no-op, so its post-mutation row may still carry the prior revision.
      const expectedRevision = (execution.workspaceRevision ?? 0) + 1;
      let gates: WorkspaceCompletionGatesV1;
      try {
        gates = getWorkspaceCompletionGatesV1(context(toolContext.frame, {}, expectedRevision));
      } catch (error) {
        if (
          (operation !== "accept_submission" && operation !== "submit_root_result")
          || !(error instanceof TurnWorkspaceError)
          || error.code !== "stale_revision"
        ) throw error;
        gates = getWorkspaceCompletionGatesV1(context(toolContext.frame, {}, execution.workspaceRevision ?? 0));
      }
      const workspaceRevision = gates.workspaceRevision;
      advanceNonCognitionWorkspaceRevision(execution, cognitionRuntime, workspaceRevision);
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
      const result = await withToolPermit(
        execution.userId,
        () => assignWorkspaceChildTasks({
          ...context(rootFrame, { assignments }, expected),
        }),
        signal,
        execution.owner.ledger,
      );
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
      advanceNonCognitionWorkspaceRevision(execution, cognitionRuntime, result.workspaceRevision);
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
      if (context.requestedMode !== "agentic") return request.inputRevisions ?? {};
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
        // gate projection: cognition and attachment selections change which
        // revisions this turn depends on.
        const canonicalConfig = projection?.config ?? null;
        const cognition = cognitionSnapshotInputs(userId, presetId, canonicalConfig);
        const snapshot = buildGenerationAssemblySnapshot({
          assemblySurface: "WORK",
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
          forcePresetId: request.forcePresetId === true,
          personaId: request.personaId ?? null,
          targetCharacterId: target.targetCharacterId ?? request.targetCharacterId ?? null,
          targetMessageId: target.messageId ?? null,
          targetSwipeId: target.swipeId ?? null,
          excludeMessageId:
            target.generationType === "regenerate" || target.generationType === "swipe"
              ? target.messageId ?? null
              : null,
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
      } catch (error) {
        console.error("[Agentic] Effective runtime snapshot preflight failed", error);
        // A snapshot or input-revision failure must leave preflight incomplete so
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
      const provider = root?.provider ? getProvider(root.provider) : undefined;
      const frozenCapabilityDigest = root
        ? canonicalRuntimeCapabilityDigest(root.capabilities)
        : null;
      const admittedCapabilityDigest = root?.capabilityDigest ?? null;
      const liveCapabilityDigest = provider
        ? canonicalRuntimeCapabilityDigest(
          provider.capabilities as unknown as Readonly<Record<string, unknown>>,
        )
        : null;
      const capabilityAuthorityReady = root !== null
        && root !== undefined
        && provider !== undefined
        && typeof admittedCapabilityDigest === "string"
        && admittedCapabilityDigest.length > 0
        && frozenCapabilityDigest === admittedCapabilityDigest
        && liveCapabilityDigest === admittedCapabilityDigest;
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
      const providerReady = capabilityAuthorityReady
        && streamingReady
        && toolCallingReady
        && continuationReady
        && finalizationReady;
      // Configuration and slot bindings are request-local. Validate the
      // frozen projection here; startup cannot know which preset this turn
      // will select.
      const configReady = configBindingReadiness(
        context.config,
        context.configRevision,
        context.bindingRevision,
      );
      // The input authority reports completeness separately from its digest:
      // a digest of placeholder nulls must never make an incomplete request
      // appear admissible. Incomplete Agentic input revisions never reject
      // ordinary Response eligibility.
      const agenticInputRequired = context.requestedMode === "agentic";
      const inputReady = !agenticInputRequired
        || (context.inputRevisionsComplete && context.inputRevisionDigest.length > 0);
      const staticReady = status.schema
        && status.reconciliation
        && status.archiveRegistry
        && status.isolateTermination
        && status.publicationStore;
      const ready = getAgenticRuntimeMode() === "auto" && staticReady && providerReady && configReady && inputReady;
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
      if (agenticInputRequired && !inputReady) reasons.push("input_revisions_incomplete");
      if (getAgenticRuntimeMode() !== "auto") reasons.push("kill_switch_off");
      if (!ready) {
        console.error("[Agentic] Effective runtime readiness denied", {
          reasons,
          staticReady,
          providerReady,
          configReady,
          inputReady,
        });
      }
      // Static components share the readiness authority's own digest. It is the
      // authoritative value that changes whenever any component flips, so no
      // per-component epoch is invented here.
      const authority = staticReady ? status.digest : 0;
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
        killSwitchState: getAgenticRuntimeMode(),
        ready,
        reasons,
      };
      // Merge the durable cognition repair state through the production merge
      // so repair-required cognition yields ready: false plus its stable
      // repair code; Response availability is never affected.
      return applyCognitionReadinessV1(baseVector, {
        cognitionRevision: baseVector.cognitionRevision,
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
function cognitionPresetVariables(
  snapshot: RuntimeSnapshot,
): Readonly<Record<string, CognitionValue>> {
  const values = snapshot.variables.effective?.values;
  if (values) {
    const output: Record<string, CognitionValue> = {};
    for (const [name, value] of Object.entries(values)) output[name] = value;
    return Object.freeze(output);
  }
  return resolveCognitionPresetVariables(
    snapshot.blocks,
    snapshot.variables.preset,
    snapshot.variables.profile ?? undefined,
  );
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



type CortexSnapshotCandidateV1 = Readonly<{
  snapshotId: string;
  revision: string | number;
  value: unknown;
  availability?: "available" | "stale" | "unauthorized" | "unavailable";
  required?: boolean;
  ownerId?: string;
  attemptId?: string;
  checkpoint?: string;
  scope?: Readonly<{
    chatId?: string;
    targetMessageId?: string | null;
    targetSwipeId?: number | null;
  }>;
}>;

function cortexSnapshotSourceFromAssembly(snapshot: RuntimeSnapshot): unknown {
  const value = snapshot as unknown as Record<string, unknown>;
  if (Object.hasOwn(value, "cortexSidecarSnapshot")) return value.cortexSidecarSnapshot;
  if (isRecord(value.agentConfig) && Object.hasOwn(value.agentConfig, "cortexSidecarSnapshot")) {
    return value.agentConfig.cortexSidecarSnapshot;
  }
  return undefined;
}

function cortexSnapshotCandidate(value: unknown): CortexSnapshotCandidateV1 | undefined {
  const record = isRecord(value) && isRecord(value.snapshot) && value.snapshot.version === 1
    ? value.snapshot
    : isRecord(value) ? value : undefined;
  if (!record || typeof record.snapshotId !== "string" || record.snapshotId.length === 0) return undefined;
  const revision = record.revision ?? record.sourceRevision;
  if (!((typeof revision === "string" && revision.length > 0) || (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0))) {
    return undefined;
  }
  if (!Object.hasOwn(record, "value")) return undefined;
  const availability = record.availability;
  const normalizedAvailability = availability === "available"
    || availability === "stale"
    || availability === "unauthorized"
    || availability === "unavailable"
    ? availability
    : undefined;
  const required = typeof record.required === "boolean" ? record.required : undefined;
  const scope = isRecord(record.scope)
    ? {
      ...(typeof record.scope.chatId === "string" ? { chatId: record.scope.chatId } : {}),
      ...(record.scope.targetMessageId === null || typeof record.scope.targetMessageId === "string"
        ? { targetMessageId: record.scope.targetMessageId }
        : {}),
      ...(record.scope.targetSwipeId === null || (typeof record.scope.targetSwipeId === "number" && Number.isSafeInteger(record.scope.targetSwipeId) && record.scope.targetSwipeId >= 0)
        ? { targetSwipeId: record.scope.targetSwipeId }
        : {}),
    }
    : undefined;
  return Object.freeze({
    snapshotId: record.snapshotId,
    revision: revision as string | number,
    value: record.value,
    ...(normalizedAvailability ? { availability: normalizedAvailability } : {}),
    ...(required === undefined ? {} : { required }),
    ...(typeof record.ownerId === "string" ? { ownerId: record.ownerId } : {}),
    ...(typeof record.attemptId === "string" ? { attemptId: record.attemptId } : {}),
    ...(typeof record.checkpoint === "string" ? { checkpoint: record.checkpoint } : {}),
    ...(scope ? { scope: Object.freeze(scope) } : {}),
  });
}

function cortexRequiredFromConfig(config: unknown): boolean {
  if (!isRecord(config)) return false;
  if (typeof config.cortexRequired === "boolean") return config.cortexRequired;
  for (const key of ["cortexPolicy", "cortexSidecarPolicy", "cortex"]) {
    const policy = config[key];
    if (isRecord(policy) && typeof policy.required === "boolean") return policy.required;
  }
  return false;
}

function cortexAttemptId(execution: RuntimeExecution): string {
  return execution.attemptLineage.attemptId;
}

function cortexAuthorizedSnapshotForWork(
  execution: RuntimeExecution,
  snapshot: RuntimeSnapshot,
  cognitionRuntime: AgentCognitionRuntimeV1 | undefined,
): { readonly attemptId: string; readonly required: boolean; readonly snapshot: CortexAuthorizedSnapshotV1 } {
  const attemptId = cortexAttemptId(execution);
  const rawFromRuntime = cognitionRuntime ? cognitionRuntimeCortexSnapshot(cognitionRuntime) : undefined;
  const raw = rawFromRuntime === undefined ? cortexSnapshotSourceFromAssembly(snapshot) : rawFromRuntime;
  const candidate = cortexSnapshotCandidate(raw);
  const required = cortexRequiredFromConfig(snapshot.agentConfig) || candidate?.required === true;
  const targetMessageId = snapshot.target.messageId ?? null;
  const targetSwipeId = snapshot.target.swipeId ?? null;
  const metadataMismatch = candidate !== undefined && (
    candidate.ownerId !== undefined && candidate.ownerId !== snapshot.userId
    || candidate.attemptId !== undefined && candidate.attemptId !== attemptId
    || candidate.checkpoint !== undefined && candidate.checkpoint !== WORK_CORTEX_CHECKPOINT
    || candidate.scope?.chatId !== undefined && candidate.scope.chatId !== snapshot.chatId
    || candidate.scope?.targetMessageId !== undefined && candidate.scope.targetMessageId !== targetMessageId
    || candidate.scope?.targetSwipeId !== undefined && candidate.scope.targetSwipeId !== targetSwipeId
  );
  const available = candidate !== undefined && !metadataMismatch;
  const input = {
    ownerId: snapshot.userId,
    attemptId,
    chatId: snapshot.chatId,
    targetMessageId,
    targetSwipeId,
    checkpoint: WORK_CORTEX_CHECKPOINT,
    snapshotId: available ? candidate.snapshotId : snapshot.snapshotId,
    revision: available ? candidate.revision : snapshot.snapshotId,
    value: available ? candidate.value : null,
    availability: available ? candidate.availability : "unavailable",
  } as const;
  let authorized: CortexAuthorizedSnapshotV1;
  try {
    authorized = createCortexAuthorizedSnapshot(input);
  } catch {
    authorized = createCortexAuthorizedSnapshot({
      ...input,
      snapshotId: snapshot.snapshotId,
      revision: snapshot.snapshotId,
      value: null,
      availability: "unavailable",
    });
  }
  return Object.freeze({ attemptId, required, snapshot: authorized });
}
function mapCortexRequiredError(error: CortexSidecarError): AgenticGenerationError {
  const code = error.code === "stale" || error.code === "snapshot_mismatch"
    ? "agentic_revision_conflict"
    : error.code === "cancelled"
      ? "agentic_cancelled"
      : error.code === "failed"
        ? "agentic_provider_failure"
        : error.code === "limit_exceeded"
          ? "agentic_work_exhausted"
          : "agentic_preflight_failed";
  return new AgenticGenerationError(code, `cortex_required_failed:${error.code}`, {
    phase: "WORK",
    retryable: code === "agentic_revision_conflict",
    cause: error,
  });
}
function recordCortexInspection(
  writer: AgentInspectionWriterV1 | undefined,
  result: CortexSidecarReadResultV1,
): void {
  if (!writer) return;
  const receipt = result.receipt;
  writer.record("cortex", receipt, { lifecycle: "WORK", status: "running" });
  const included = result.kind === "accepted";
  const content = clampCoordinatorUtf8(JSON.stringify({
    nonCanonical: true,
    snapshotId: receipt.snapshotId,
    revision: receipt.revision,
    state: receipt.state,
    included,
    ...(included
      ? { value: safeToolInspectionValue(result.value) }
      : { omission: safeToolInspectionValue(result.omission) }),
  }), WORK_CORTEX_MAX_RESULT_BYTES);
  writer.record("turn_session", {
    id: `cortex:context:${receipt.id}`,
    kind: "policy",
    detail: content,
    correlation: receipt.correlation,
    occurredAt: receipt.completedAt ?? receipt.startedAt,
    transcriptRecordIds: [],
  }, { lifecycle: "WORK", status: "running" });
}



function createCognitionRuntimeForTurn(
  execution: RuntimeExecution,
  snapshot: RuntimeSnapshot,
  plan: RuntimePlan,
  capabilities: WorkspaceOperationCapabilitiesV1,
): AgentCognitionRuntimeV1 | undefined {
  const cognition = snapshot.agentCognition;
  if (!cognition.cognitionGraph || !cognition.cognitionSource) return undefined;
  const config = frozenConfig(snapshot.agentConfig);
  const participants = snapshot.participants;
  const participantFacts: Record<string, CognitionValue> = {
    hasPersona: participants.persona !== null,
    groupSize: participants.group.length,
    hasGroup: participants.group.length > 0,
  };
  const characterId = typeof participants.character.id === "string" ? participants.character.id : undefined;
  if (characterId) participantFacts.characterId = characterId;
  if (participants.persona && typeof participants.persona.id === "string") participantFacts.personaId = participants.persona.id;
  const cortexSidecarSnapshot = cortexSnapshotSourceFromAssembly(snapshot);
  try {
    return createAgentCognitionRuntime({
      source: {
        graph: cognition.cognitionGraph,
        source: cognition.cognitionSource,
        config: Object.freeze({ ...config }),
        ...(config.taskPolicy === undefined ? {} : { taskTemplateIds: config.taskPolicy.templateIds }),
        ...(cognition.loomPolicy === undefined ? {} : { loomPolicy: cognition.loomPolicy }),
        loomBlocks: plan.loomBlocks,
        ...(cortexSidecarSnapshot === undefined ? {} : { cortexSidecarSnapshot }),
      },
      evaluation: {
        generationType: snapshot.target.generationType,
        phase: "ASSEMBLE",
        presetVariables: cognitionPresetVariables(snapshot),
        participantFacts: Object.freeze(participantFacts),
        availableTools: snapshot.availability.toolIds,
        taskTransitions: Object.freeze({}),
      },
      workspaceRevision: execution.workspaceRevision ?? 0,
      workspace: cognitionWorkspaceContext(execution, capabilities),
    });
  } catch (error) {
    throw error;
  }
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

function inspectionLifecycleForPhase(phase: AgenticPhase): AgentInspectionLifecycleV1 {
  if (phase === "ASSEMBLE") return "ASSEMBLE";
  if (phase === "WORK") return "WORK";
  if (phase === "COMPLETE") return "PREPARE_COMMIT";
  if (phase === "RENDER") return "RENDER";
  if (phase === "PREPARE_COMMIT" || phase === "COMMITTING" || phase === "COMMITTED" || phase === "COMMIT_FAILED") {
    return "COMMIT";
  }
  return "TERMINAL";
}

function inspectionStatusForPhase(
  phase: AgenticPhase,
  status: unknown,
): AgentInspectionStatusV1 {
  if (status === "pending" || status === "running" || status === "waiting" || status === "cancelling" || status === "terminal") {
    return status;
  }
  return phase === "COMPLETE" || phase === "PREPARE_COMMIT" ? "waiting" : "running";
}

function inspectionOutcome(value: unknown): AgentInspectionOutcomeV1 | null {
  return value === "completed" || value === "stopped" || value === "failed"
    || value === "exhausted" || value === "rejected"
    ? value
    : null;
}

function inspectionReason(value: unknown): AgentInspectionReasonV1 {
  const reason = typeof value === "string" ? value.toLowerCase() : "";
  if (reason === "completed") return "none";
  if (reason === "stopped" || reason === "cancelled" || reason.includes("cancel")) return "user_stop";
  if (reason.includes("timed") || reason.includes("deadline") || reason.includes("wall_clock")) return "deadline";
  if (reason.includes("provider")) return "provider_failure";
  if (reason.includes("tool")) return "tool_failure";
  if (reason.includes("budget") || reason.includes("exhaust")) return "budget_exhausted";
  if (reason === "decision_refresh_required" || reason.includes("decision_refresh")) return "stale_input";
  if (reason.includes("revision") || reason.includes("stale")) return "stale_input";
  if (reason === "none" || reason.length === 0) return "none";
  if (reason === "reconciled") return "reconciled";
  if (reason === "retry_requested") return "retry_requested";
  return "needs_attention";
}

function terminalInspectionReason(
  status: unknown,
  reason: unknown,
  errorCode: unknown,
): AgentInspectionReasonV1 {
  return status === "completed" ? "none" : inspectionReason(reason ?? errorCode ?? status);
}
function recordInspectionPrompts(
  writer: AgentInspectionWriterV1 | undefined,
  messages: readonly AssemblyProviderMessageV1[] | undefined,
  destination: "root_work" | "completion_handoff" | "render",
  lifecycle: AgentInspectionLifecycleV1,
  loomInspection?: unknown,
  forceEmpty = false,
): boolean {
  if (!writer) return false;
  if (!messages || messages.length === 0) {
    if (!forceEmpty) return false;
    const content = "";
    return writer.record("prompt", {
      id: "prompt:" + destination + ":empty",
      sourceId: destination + ":empty",
      sourceRevision: 0,
      destination,
      role: "system",
      included: true,
      content,
      contentDigest: createHash("sha256").update(content).digest("hex"),
      omissionReason: null,
      nativeProvenance: null,
      loomInspection: loomInspection ?? null,
    }, { lifecycle, status: lifecycle === "PREPARE_COMMIT" ? "waiting" : "running" }) !== null;
  }
  for (const [index, message] of messages.entries()) {
    const content = message.segments.map((segment) =>
      segment.kind === "literal" ? segment.text : "[result_slot]",
    ).join("");
    const provenance = message.provenance;
    const sourceId = provenance?.sourceId ?? destination + ":" + index;
    const sourceRevision = provenance?.sourceRevision ?? 0;
    const role = message.role === "developer" ? "system" : message.role;
    const nativeProvenance = provenance?.kind === "world_info"
      ? {
        kind: "world_info" as const,
        sourceId: provenance.sourceId,
        sourceRevision: provenance.sourceRevision,
        sourceIndex: provenance.sourceIndex,
      }
      : provenance?.kind === "databank" && provenance.databank
        ? {
          kind: "databank" as const,
          sourceRevision: provenance.sourceRevision,
          sources: provenance.databank.sources,
        }
        : null;
    writer.record("prompt", {
      id: "prompt:" + destination + ":" + index,
      sourceId,
      sourceRevision,
      destination,
      role,
      included: true,
      content,
      contentDigest: createHash("sha256").update(content).digest("hex"),
      omissionReason: null,
      nativeProvenance,
      loomInspection: loomInspection ?? null,
    }, { lifecycle, status: lifecycle === "PREPARE_COMMIT" ? "waiting" : "running" });
  }
  return true;
}
function recordRenderCrossings(
  writer: AgentInspectionWriterV1 | undefined,
  handoff: Pick<AgenticWorkRenderHandoff, "workspaceContextProjection" | "renderGuidance">,
  generationId: string,
): void {
  if (!writer) return;
  const records = [
    ...handoff.workspaceContextProjection.mandatory,
    ...handoff.workspaceContextProjection.optional,
  ];
  for (const record of records) {
    if (record.kind !== "finding" && record.kind !== "accepted_submission") continue;
    const kind = record.kind === "finding" ? "accepted_finding" : "accepted_submission";
    const contentDigest = createHash("sha256").update(record.text).digest("hex");
    const crossing = {
      version: 1 as const,
      id: "render-crossing:" + generationId + ":" + record.kind + ":" + record.id,
      kind,
      sourceId: record.id,
      sourceRevision: record.sourceRevision,
      contentDigest,
      content: record.text,
      correlation: { parentId: "root" },
    };
    writer.record("prompt", {
      id: "prompt:render-crossing:" + generationId + ":" + record.kind + ":" + record.id,
      sourceId: record.id,
      sourceRevision: record.sourceRevision,
      destination: "render",
      role: "system",
      included: true,
      content: record.text,
      contentDigest,
      omissionReason: null,
      nativeProvenance: null,
      loomInspection: null,
      renderCrossing: crossing,
    }, { lifecycle: "RENDER", status: "running" });
  }
  if (handoff.renderGuidance === null) return;
  const contentDigest = createHash("sha256").update(handoff.renderGuidance).digest("hex");
  const sourceId = "completion-guidance:" + generationId;
  const crossing = {
    version: 1 as const,
    id: "render-crossing:" + generationId + ":completion_guidance",
    kind: "completion_guidance" as const,
    sourceId,
    sourceRevision: null,
    contentDigest,
    content: handoff.renderGuidance,
    correlation: { parentId: "root" },
  };
  writer.record("prompt", {
    id: "prompt:render-crossing:" + generationId + ":completion_guidance",
    sourceId,
    sourceRevision: 0,
    destination: "render",
    role: "system",
    included: true,
    content: handoff.renderGuidance,
    contentDigest,
    omissionReason: null,
    nativeProvenance: null,
    loomInspection: null,
    renderCrossing: crossing,
  }, { lifecycle: "RENDER", status: "running" });
}

type RecoverablePersistentWorkspaceOutcome = Exclude<PersistentWorkspaceTurnSession["outcome"], null>;

const PERSISTENT_SESSION_RECOVERY_PAGE_SIZE = 256;
const PERSISTENT_SESSION_RECOVERY_MAX_ROWS = 2048;
const PERSISTENT_SESSION_RECOVERY_MAX_MS = 5_000;
let persistentRecoveryClock: () => number = Date.now;

function persistentRecoveryNowMs(): number {
  return persistentRecoveryClock();
}

type PersistentWorkspaceRecoveryResult = {
  readonly inspected: number;
  readonly recovered: number;
  readonly complete: boolean;
};

function persistentOutcomeFromAttempt(value: unknown): RecoverablePersistentWorkspaceOutcome | undefined {
  switch (value) {
    case "completed":
    case "stopped":
    case "failed":
    case "exhausted":
    case "rejected":
      return value;
    default:
      return undefined;
  }
}

function persistentOutcomeFromTerminalState(value: unknown): RecoverablePersistentWorkspaceOutcome | undefined {
  switch (value) {
    case "COMMITTED":
      return "completed";
    case "CANCELLED":
      return "stopped";
    case "TIMED_OUT":
      return "failed";
    case "EXHAUSTED":
      return "exhausted";
    case "COMMIT_FAILED":
    case "FAILED":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * Host turn sessions are the only persistent session records. A process
 * restart leaves no live host authority, so a surviving nonterminal session
 * with a terminal durable attempt/projection is deterministically stale and
 * must be terminalized. Receipt-backed projection repair is deliberately
 * ordered after that session CAS.
 */
function reconcilePersistentWorkspaceSessions(): PersistentWorkspaceRecoveryResult {
  const db = getDb();
  const authority = createPersistentWorkspaceHostAuthority();
  const runtimeEpoch = getRuntimeEpoch();
  const recoveryOrderedAt = "COALESCE(s.created_at, s.updated_at, 0)";
  const scanStartedAt = persistentRecoveryNowMs();
  const scanUpperBound = (() => {
    try {
      const row = db.query(
        "SELECT MAX(COALESCE(created_at, updated_at, 0)) AS max_ordered_at FROM persistent_workspace_turn_sessions",
      ).get() as { max_ordered_at?: unknown } | null;
      const value = row?.max_ordered_at;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "bigint") return Number(value);
    } catch {
      // Fall back to the wall clock only when the durable snapshot cannot be read.
    }
    return scanStartedAt;
  })();
  const scanDeadline = scanStartedAt + PERSISTENT_SESSION_RECOVERY_MAX_MS;
  let remainingRows = PERSISTENT_SESSION_RECOVERY_MAX_ROWS;
  let cursorPriority = -1;
  let cursorUpdatedAt = 0;
  let cursorTurnSessionId = "";
  const result = {
    inspected: 0,
    recovered: 0,
    complete: true,
  };
  const receiptBacked = `
    e.state IN ('COMMITTED', 'COMMITTING')
    AND EXISTS (
      SELECT 1
        FROM agent_turn_commit_receipts AS r
       WHERE r.user_id = s.user_id
         AND (r.execution_id = s.execution_id OR r.turn_id = s.execution_id)
    )`;
  const recoveryPriority = `(CASE WHEN ${receiptBacked} THEN 0 ELSE 1 END)`;
  for (;;) {
    if (remainingRows <= 0 || persistentRecoveryNowMs() >= scanDeadline) {
      result.complete = false;
      return result;
    }
    const pageLimit = Math.min(PERSISTENT_SESSION_RECOVERY_PAGE_SIZE, remainingRows);
    let rows: Array<Record<string, unknown>>;
    try {
      rows = db.query(`
        SELECT
          s.turn_session_id,
          s.workspace_id,
          s.user_id,
          s.execution_id,
          ${recoveryOrderedAt} AS recovery_updated_at,
          ${recoveryPriority} AS recovery_priority,
          a.status AS attempt_status,
          a.outcome AS attempt_outcome,
          p.status AS projection_status,
          e.state AS execution_state,
          e.runtime_epoch AS execution_runtime_epoch,
          e.deadline_at AS execution_deadline_at
        FROM persistent_workspace_turn_sessions AS s
        LEFT JOIN agent_run_attempts AS a
          ON a.user_id = s.user_id AND a.attempt_id = s.attempt_id
        LEFT JOIN agent_run_projections AS p
          ON p.user_id = s.user_id AND p.turn_id = s.execution_id
        LEFT JOIN agent_turn_executions AS e
          ON e.user_id = s.user_id AND e.id = s.execution_id
        WHERE (s.phase <> 'TERMINAL' OR s.status <> 'terminal')
          AND ${recoveryOrderedAt} <= ?
          AND (
            ${recoveryPriority} > ?
            OR (
              ${recoveryPriority} = ?
              AND (
                ${recoveryOrderedAt} > ?
                OR (
                  ${recoveryOrderedAt} = ?
                  AND s.turn_session_id > ?
                )
              )
            )
          )
        ORDER BY ${recoveryPriority} ASC, ${recoveryOrderedAt} ASC, s.turn_session_id ASC
        LIMIT ?
      `).all(
        scanUpperBound,
        cursorPriority,
        cursorPriority,
        cursorUpdatedAt,
        cursorUpdatedAt,
        cursorTurnSessionId,
        pageLimit,
      ) as Array<Record<string, unknown>>;
    } catch (error) {
      console.error("[agentic] persistent session recovery scan failed", error);
      result.complete = false;
      return result;
    }
    if (rows.length === 0) return result;
    remainingRows -= rows.length;
    result.inspected += rows.length;
    for (const row of rows) {
      if (persistentRecoveryNowMs() >= scanDeadline) {
        result.complete = false;
        return result;
      }
      const userId = typeof row.user_id === "string" ? row.user_id : undefined;
      const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : undefined;
      const turnSessionId = typeof row.turn_session_id === "string" ? row.turn_session_id : undefined;
      const executionId = typeof row.execution_id === "string" ? row.execution_id : undefined;
      if (!userId || !workspaceId || !turnSessionId) {
        result.complete = false;
        continue;
      }

      let execution: TurnExecutionRecord | null = null;
      let receipt: TurnCommitReceipt | null = null;
      try {
        if (executionId) {
          execution = getTurnExecution(executionId, userId, db);
          receipt = execution ? getTurnCommitReceipt(execution.id, userId, db) : null;
        }
      } catch (error) {
        console.error(`[agentic] persistent session execution inspection failed (${turnSessionId})`, error);
        result.complete = false;
        continue;
      }
      const executionCommittedWithReceipt = execution?.phase === "COMMITTED" && receipt !== null;
      // A receipt may exist while the turn reconciler still owns COMMITTING.
      // Leave that row for the phase CAS first; repairing the public projection
      // here would publish success before the execution authority converges.
      if (row.execution_state === "COMMITTING" && receipt !== null) {
        result.complete = false;
        continue;
      }

      const projectionOutcome = persistentOutcomeFromTerminalState(row.projection_status);
      const attemptOutcome = row.attempt_status === "terminal"
        ? persistentOutcomeFromAttempt(row.attempt_outcome)
        : undefined;
      const executionOutcome = persistentOutcomeFromTerminalState(row.execution_state);
      const executionRuntimeEpoch = typeof row.execution_runtime_epoch === "number"
        && Number.isSafeInteger(row.execution_runtime_epoch)
        ? row.execution_runtime_epoch
        : undefined;
      const executionDeadlineAt = typeof row.execution_deadline_at === "number"
        && Number.isFinite(row.execution_deadline_at)
        ? row.execution_deadline_at
        : undefined;
      // Nonterminal execution rows are owned by turn startup reconciliation.
      // Do not invent an exhausted outcome while a COMMITTING/WORK row still
      // has a replayable phase transition pending.
      const staleExecution = row.execution_state === null
        || row.execution_state === undefined
        || executionRuntimeEpoch !== undefined && executionRuntimeEpoch !== runtimeEpoch
        || executionDeadlineAt !== undefined && executionDeadlineAt <= Date.now();
      const outcome = executionCommittedWithReceipt
        ? "completed"
        : projectionOutcome && projectionOutcome !== "completed"
          ? projectionOutcome
          : attemptOutcome && attemptOutcome !== "completed"
            ? attemptOutcome
            : executionOutcome ?? attemptOutcome ?? projectionOutcome
              ?? (staleExecution ? "failed" : undefined);
      if (!outcome) {
        result.complete = false;
        continue;
      }

      let recovered = false;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const workspace = getPersistentWorkspaceById({ userId, workspaceId });
            const session = updatePersistentWorkspaceHostTurnSession(authority, {
              userId,
              workspaceId,
              expectedRevision: workspace.revision,
              turnSessionId,
              phase: "TERMINAL",
              status: "terminal",
              outcome,
            });
            recovered = session.phase === "TERMINAL"
              && session.status === "terminal"
              && session.outcome === outcome;
            if (recovered) break;
          } catch (error) {
            if (attempt === 1) throw error;
          }
        }
        if (!recovered) {
          console.error(`[agentic] persistent session recovery did not converge (${turnSessionId})`);
          result.complete = false;
          continue;
        }
      } catch (error) {
        console.error(`[agentic] persistent session recovery failed (${turnSessionId})`, error);
        result.complete = false;
        continue;
      }
      result.recovered++;

      if (executionCommittedWithReceipt && execution && receipt) {
        try {
          withAgentRunProjectionTransaction((projectionDb) =>
            repairAgentRunProjectionFromReceipt(projectionDb, execution!, receipt!),
          );
        } catch (error) {
          // The session CAS is already durable. Leave the staged projection and
          // receipt for the next bounded startup repair attempt.
          result.complete = false;
          console.error(`[agentic] persistent receipt projection repair failed (${turnSessionId})`, error);
        }
      }
    }
    const lastRow = rows[rows.length - 1]!;
    const nextPriority = Number(lastRow.recovery_priority);
    const nextUpdatedAt = Number(lastRow.recovery_updated_at);
    const nextTurnSessionId = typeof lastRow.turn_session_id === "string"
      ? lastRow.turn_session_id
      : cursorTurnSessionId;
    if (!Number.isFinite(nextPriority)
      || !Number.isFinite(nextUpdatedAt)
      || nextPriority < cursorPriority
      || nextPriority === cursorPriority && (
        nextUpdatedAt < cursorUpdatedAt
        || nextUpdatedAt === cursorUpdatedAt && nextTurnSessionId <= cursorTurnSessionId
      )) {
      result.complete = false;
      return result;
    }
    cursorPriority = nextPriority;
    cursorUpdatedAt = nextUpdatedAt;
    cursorTurnSessionId = nextTurnSessionId;
    if (rows.length < pageLimit) return result;
    if (remainingRows <= 0 || persistentRecoveryNowMs() >= scanDeadline) {
      result.complete = false;
      return result;
    }
  }
}


type CoordinatorTerminalEvent = NonNullable<AgenticGenerationDependencies["publishTerminal"]> extends (
  event: infer Event,
) => unknown ? Event : never;

type CoordinatorTerminalPublicationState = Readonly<{
  status: "COMMITTED" | "COMMIT_FAILED" | "CANCELLED" | "TIMED_OUT" | "EXHAUSTED" | "FAILED";
  phase: AgenticPhase;
  outcome: RecoverablePersistentWorkspaceOutcome;
}>;
type CoordinatorCommittedTerminalSettlement = Readonly<{
  messageId: string;
  swipeId: number;
  content: string;
}>;

/**
 * A COMMITTED compatibility event may expose only the exact durable swipe
 * named by its owner-scoped receipt. The render pool contains provisional
 * output (for continue it is only the appended suffix), so it is never a
 * committed-content authority.
 */
function requireCommittedTerminalSettlement(
  event: Pick<CoordinatorTerminalEvent, "executionId" | "userId" | "chatId" | "receipt">,
  receipt: TurnCommitReceipt | null,
): CoordinatorCommittedTerminalSettlement {
  const messageId = receipt?.messageId;
  const swipeId = receipt?.swipeId;
  if (
    !receipt
    || receipt.executionId !== event.executionId
    || receipt.userId !== event.userId
    || receipt.chatId !== event.chatId
    || typeof messageId !== "string"
    || messageId.length === 0
    || typeof swipeId !== "number"
    || !Number.isSafeInteger(swipeId)
    || swipeId < 0
    || event.receipt?.messageId !== undefined && event.receipt.messageId !== messageId
    || event.receipt?.swipeId !== undefined && event.receipt.swipeId !== swipeId
  ) {
    throw new Error("committed_terminal_receipt_integrity_failed");
  }
  const message = getMessage(event.userId, messageId);
  const content = message?.swipes[swipeId];
  if (message?.chat_id !== event.chatId || typeof content !== "string") {
    throw new Error("committed_terminal_message_integrity_failed");
  }
  return { messageId, swipeId, content };
}

/**
 * Keep terminal publication recovery on the exact same status/outcome
 * translation as the normal terminal publisher. The event phase is already
 * canonicalized by the generation owner and must not be replaced by a generic
 * FAILED phase during recovery.
 */
function coordinatorTerminalPublicationState(
  event: Pick<CoordinatorTerminalEvent, "status" | "phase" | "workOutcome">,
  committedBoundary: boolean,
): CoordinatorTerminalPublicationState {
  const status = committedBoundary
    ? "COMMITTED"
    : event.status === "completed"
      ? "COMMIT_FAILED"
      : event.status === "cancelled"
        ? "CANCELLED"
        : event.status === "timed_out"
          ? "TIMED_OUT"
          : event.status === "exhausted"
            ? "EXHAUSTED"
            : "FAILED";
  const reportedOutcome = event.workOutcome;
  const outcome = committedBoundary
    ? "completed"
    : event.status === "completed"
      ? "failed"
      : event.status === "cancelled"
        ? "stopped"
        : event.status === "timed_out"
          ? "failed"
          : event.status === "exhausted"
            ? "exhausted"
            : event.status === "rejected"
              ? "rejected"
              : reportedOutcome === "stopped"
                ? "stopped"
                : reportedOutcome === "exhausted"
                  ? "exhausted"
                  : reportedOutcome === "rejected"
                    ? "rejected"
                    : "failed";
  return {
    status,
    phase: committedBoundary ? "COMMITTED" : event.phase,
    outcome,
  };
}

function preservedDecisionRefreshCode(errorCode: unknown): "decision_refresh_required" | undefined {
  return errorCode === "decision_refresh_required" ? "decision_refresh_required" : undefined;
}



function buildDependencies(): AgenticGenerationDependencies {
  const cognitionRuntimes = new Map<string, AgentCognitionRuntimeV1>();
  const snapshots = new Map<string, RuntimeSnapshot>();
  const mediaMaterializers = new Map<string, NativeMediaProjectionResultV1["materialize"]>();
  const plans = new Map<string, RuntimePlan>();
  const renders = new Map<string, { content: string }>();
  const renderProjections = new Map<string, FrozenRenderCommitProjection>();
  const renderBreakdowns = new Map<string, {
    readonly entries: readonly {
      readonly name: string;
      readonly type: "utility";
      readonly tokens: number;
      readonly role: LlmMessage["role"];
      readonly content: string;
    }[];
    readonly messages: readonly {
      readonly role: LlmMessage["role"];
      readonly content: string;
      readonly name?: LlmMessage["name"];
    }[];
    readonly totalTokens: number;
    readonly model: string;
    readonly provider: string;
    readonly parameters: GenerationParameters;
    readonly loomPromptInspection?: unknown;
  }>();
  const renderFrames = new Map<string, {
    readonly handoff: AgenticWorkRenderHandoff;
  }>();
  const works = new Map<string, AgenticWorkPhaseOutcome>();
  const workUsages = new Map<string, AgentActivityUsageV1>();
  const terminalUsages = new Map<string, AgentActivityUsageV1>();
  const runtimeOwners = new Map<string, AgentRuntimeOwner>();
  const commitTargetRevisions = new Map<string, {
    readonly messageRevision: number | null;
    readonly swipeRevision: number | null;
  }>();
  const caps = new Map<string, WorkspaceOperationCapabilitiesV1>();
  const bindings = new Map<string, LiveTargetBinding>();
  const inspectionWriters = new Map<string, AgentInspectionWriterV1>();
  const persistentAssociations = new Map<string, PersistentRuntimeAssociation>();
  /**
   * A failed terminal inspection is deliberately remembered through the
   * request cleanup. Cleanup must not convert the still-mutable persistent
   * session into a terminal row after this callback has deferred recovery.
   */
  const terminalInspectionFailures = new Set<string>();
  const commitDependencies: typeof AGENTIC_COMMIT_DEPENDENCIES_V1 = Object.freeze({
    ...AGENTIC_COMMIT_DEPENDENCIES_V1,
    // The commit transaction must leave a mutable COMMITTING projection
    // until terminal reconciliation has completed. publishTerminal owns the
    // immutable terminal snapshot after the persistent session and inspection
    // writes have succeeded.
    publishAgentRunCommit: (db: Database, input: AgentRunProjectionInputV2) => {
      const projection = appendAgentRunSnapshot(db, {
        ...input,
        status: "COMMITTING",
        terminalHandoff: null,
      });
      const commitRecorded = inspectionWriters.get(input.generationId)?.record("milestone", {
        id: `phase:${input.generationId}:COMMIT`,
        kind: "milestone",
        actor: "host",
        recipient: "owner",
        result: JSON.stringify({
          phase: "COMMIT",
          workPhase: "COMMIT",
          workStatus: "waiting",
          workOutcome: null,
          reason: null,
        }),
        correlation: { parentId: "root" },
      }, {
        lifecycle: "COMMIT",
        status: "waiting",
        updatedAt: Date.now(),
      });
      if (!commitRecorded) throw new Error("commit_chronology_projection_missing");
      return projection;
    },
  });
  const refreshPersistentAssociation = (association: PersistentRuntimeAssociation): void => {
    const workspace = getPersistentWorkspaceById({
      userId: association.session.userId,
      workspaceId: association.workspaceId,
    });
    association.workspaceRevision = workspace.revision;
  };
  const syncPersistentSession = (
    executionId: string,
    phase: PersistentWorkspaceTurnSession["phase"],
    status: PersistentWorkspaceTurnSession["status"],
    outcome?: PersistentWorkspaceTurnSession["outcome"],
  ): void => {
    const association = persistentAssociations.get(executionId);
    if (!association) return;
    refreshPersistentAssociation(association);
    association.session = updatePersistentWorkspaceHostTurnSession(association.authority, {
      userId: association.session.userId,
      workspaceId: association.workspaceId,
      expectedRevision: association.workspaceRevision,
      turnSessionId: association.session.id,
      phase,
      status,
      ...(outcome === undefined ? {} : { outcome }),
    });
  };
  const terminalizePersistentSession = (
    executionId: string,
    outcome: Exclude<PersistentWorkspaceTurnSession["outcome"], null>,
  ): boolean => {
    const association = persistentAssociations.get(executionId);
    if (!association) return true;
    if (association.session.phase === "TERMINAL" && association.session.status === "terminal") {
      return association.session.outcome === outcome;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // Admission failure can race another persistent workspace mutation or
        // chat deletion. Refresh the owner/workspace CAS immediately before
        // each terminal attempt; the host session update itself is detached.
        refreshPersistentAssociation(association);
        const terminal = updatePersistentWorkspaceHostTurnSession(association.authority, {
          userId: association.session.userId,
          workspaceId: association.workspaceId,
          expectedRevision: association.workspaceRevision,
          turnSessionId: association.session.id,
          phase: "TERMINAL",
          status: "terminal",
          outcome,
        });
        association.session = terminal;
        return terminal.phase === "TERMINAL"
          && terminal.status === "terminal"
          && terminal.outcome === outcome;
      } catch (error) {
        const code = isRecord(error) && typeof error.code === "string" ? error.code : "internal_error";
        if (code === "stale_revision" && attempt === 0) continue;
        console.error(`[agentic] persistent session terminalization failed (${code})`);
        return false;
      }
    }
    return false;
  };
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
      const deadlineAt = rootDeadlines.get(executionId);
      const remaining = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await (remaining === undefined
          ? Promise.all([...joins])
          : Promise.race([
            Promise.all([...joins]),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new AgenticGenerationError(
                "agentic_timed_out",
                "Agentic child execution did not settle before the root deadline.",
                { phase: "WORK" },
              )), Math.max(0, remaining));
            }),
          ]));
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
  };
  const ensureInspectionWriter = (event: {
    readonly executionId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly target: AgenticTargetSnapshot;
    readonly attemptLineage?: AgentWorkAttemptLineageV1;
  }): { readonly writer: AgentInspectionWriterV1; readonly recovered: boolean } => {
    const existing = inspectionWriters.get(event.executionId);
    if (existing) return { writer: existing, recovered: false };
    const lineage = event.attemptLineage;
    const attemptId = lineage?.attemptId ?? event.executionId;
    const writer = createAgentInspectionWriter({
      userId: event.userId,
      chatId: event.chatId,
      attemptId,
      ...(lineage?.previousAttemptId !== undefined ? { previousAttemptId: lineage.previousAttemptId } : {}),
      runId: event.executionId,
      turnSessionId: event.executionId,
      generationId: event.executionId,
      generationType: event.target.generationType,
      targetMessageId: event.target.messageId ?? null,
      targetSwipeId: event.target.swipeId ?? null,
      hostCorrelationId: `agentic:${event.executionId}:${attemptId}`,
      ...(lineage?.createdAt !== undefined ? { startedAt: lineage.createdAt } : {}),
      reconciliation: "recovered",
    });
    inspectionWriters.set(event.executionId, writer);
    writer.record("recovery", {
      id: `recovery:writer:${event.executionId}`,
      kind: "recovery",
      actor: "host",
      recipient: "owner",
      result: JSON.stringify({ executionId: event.executionId, source: "terminal_publication" }),
      correlation: { parentId: "root" },
    }, { lifecycle: "ADMIT", status: "pending", reconciliation: "recovered" });
    return { writer, recovered: true };
  };

  const materializeFallbackExecution = (event: CoordinatorTerminalEvent): TurnExecutionRecord | null => {
    const existing = getTurnExecution(event.executionId, event.userId);
    if (existing) return existing;
    if (event.attemptLineage?.previousAttemptId) return null;
    const fallbackBinding = bindings.get(event.executionId) ?? bindLiveTarget(event.userId, event.chatId, event.target);
    bindings.set(event.executionId, fallbackBinding);
    const created = createTurnExecution({
      id: event.executionId,
      userId: event.userId,
      chatId: event.chatId,
      generationId: event.executionId,
      target: fallbackBinding,
      attemptLineage: event.attemptLineage,
      worldLoreSnapshotId: null,
      worldLoreRevision: 0,
      mode: "agentic",
      runtimeEpoch: getRuntimeEpoch(),
      deadlineAt: Number.MAX_SAFE_INTEGER,
      workspaceId: `workspace:${event.executionId}`,
      rootLedger: {},
      frameCapabilities: {},
      ...(event.receipt?.commitKey ? { commitKey: event.receipt.commitKey } : {}),
    });
    if (event.status === "completed" && event.receipt?.receiptId) {
      let current = created.execution;
      for (const nextPhase of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
        current = transitionTurnExecution({
          executionId: current.id,
          ownerToken: created.ownerToken,
          expectedPhase: current.phase,
          nextPhase,
          ignoreCancellation: true,
        }).execution;
      }
      return finalizeTurnCommit({
        executionId: current.id,
        ownerToken: created.ownerToken,
        receiptId: event.receipt.receiptId,
        summary: event.receipt.summary,
        workspaceId: current.workspaceId ?? undefined,
        messageId: event.receipt.messageId ?? current.targetMessageId,
        swipeId: event.receipt.swipeId ?? current.targetSwipeId,
      }).execution;
    }
    if (event.status === "completed") {
      let current = created.execution;
      for (const nextPhase of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
        current = transitionTurnExecution({
          executionId: current.id,
          ownerToken: created.ownerToken,
          expectedPhase: current.phase,
          nextPhase,
          ignoreCancellation: true,
        }).execution;
      }
      return transitionTurnExecution({
        executionId: current.id,
        ownerToken: created.ownerToken,
        expectedPhase: current.phase,
        nextPhase: "COMMIT_FAILED",
        reason: event.errorCode ?? "terminal_publication_failed",
        ignoreCancellation: true,
      }).execution;
    }
    const nextPhase = event.status === "cancelled"
      ? "CANCELLED"
      : event.status === "timed_out"
        ? "TIMED_OUT"
        : event.status === "exhausted"
          ? "EXHAUSTED"
          : "FAILED";
    let current = created.execution;
    if (nextPhase === "EXHAUSTED") {
      current = transitionTurnExecution({
        executionId: current.id,
        ownerToken: created.ownerToken,
        expectedPhase: current.phase,
        nextPhase: "WORK",
        ignoreCancellation: true,
      }).execution;
    }
    return transitionTurnExecution({
      executionId: current.id,
      ownerToken: created.ownerToken,
      expectedPhase: current.phase,
      nextPhase,
      reason: preservedDecisionRefreshCode(event.errorCode)
        ?? (event.status === "rejected"
          ? "invalid_input"
          : event.errorCode ?? "terminal_publication_failed"),
      ignoreCancellation: true,
    }).execution;
  };

  const resolve = async (input: AgenticGenerationInput, target: AgenticTargetSnapshot): Promise<AgenticRuntimeDecision> => {
    const result = await resolveEffectiveRuntimeWithoutToken(input.userId, runtimeRequest(input, target, "agentic"));
    return mapDecision(result);
  };
  const consume = async (input: AgenticGenerationInput, target: AgenticTargetSnapshot, token: string): Promise<AgenticRuntimeDecision> => {
    const result = await consumeRuntimeDecisionToken(input.userId, token, runtimeRequest(input, target));
    if (!result.accepted || !result.decision) {
      const mismatch = result.mismatch ? `: ${result.mismatch}` : "";
      throw new AgenticGenerationError(
        "decision_refresh_required",
        `decision_refresh_required${mismatch}`,
        { phase: "ASSEMBLE", retryable: true },
      );
    }
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
    claimRuntimeToken: (input, token) => {
      if (!claimRuntimeDecisionToken(input.userId, token)) {
        throw new AgenticGenerationError(
          "decision_refresh_required",
          "decision_refresh_required",
          { phase: "ASSEMBLE", retryable: true },
        );
      }
    },
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
          inspectionWriters.get(value.executionId)?.record("stop", {
            id: `stop:deadline:${value.executionId}`,
            state: "accepted",
            reason: "deadline",
            requestedAt: Date.now(),
            correlation: { actorId: "host", recipientId: "agent" },
          }, { status: "cancelling", reason: "deadline" });
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
        const binding = bindLiveTarget(
          value.userId,
          value.chatId,
          value.target,
          value.attemptLineage?.previousAttemptId != null,
        );
        bindings.set(value.executionId, binding);
        const presetRevision = Number(decision.internal.binding.configRevision);
        const connectionRevision = Number(root?.candidateRevision ?? root?.revision);
        const execution = createTurnExecution({
          id: value.executionId, userId: value.userId, chatId: value.chatId, generationId: value.executionId,
          target: binding,
          attemptLineage: value.attemptLineage,
          presetSnapshotId: decision.internal.binding.presetId,
          presetRevision: Number.isSafeInteger(presetRevision) && presetRevision >= 0 ? presetRevision : 0,
          configSnapshotId: decision.internal.binding.presetId,
          configRevision: Number.isSafeInteger(presetRevision) && presetRevision >= 0 ? presetRevision : 0,
          concreteConnectionSnapshotId: root?.concreteId ?? root?.logicalId ?? null,
          concreteConnectionRevision: Number.isSafeInteger(connectionRevision) && connectionRevision >= 0 ? connectionRevision : 0,
          worldLoreSnapshotId: null, worldLoreRevision: 0, mode: "agentic", runtimeEpoch: getRuntimeEpoch(),
          deadlineAt, workspaceId: `workspace:${value.executionId}`, rootLedger: {}, frameCapabilities: {},
        });
        const lineage = isAgentWorkAttemptLineage(value.attemptLineage)
          ? value.attemptLineage
          : execution.execution.attemptLineage;
        const attemptId = lineage.attemptId;
        const previousAttemptId = lineage.previousAttemptId;
        const recordAdmissionTarget = (
          writer: AgentInspectionWriterV1,
          targetLineage: AgentWorkAttemptLineageV1,
        ): boolean => writer.record("target", {
          id: "admit:target",
          kind: "target",
          actor: "host",
          recipient: "agent",
          arguments: JSON.stringify({
            generationType: targetLineage.target.generationType,
            messageId: targetLineage.target.messageId,
            swipeId: targetLineage.target.swipeId,
            messageRevision: binding.messageGenerationRevision,
            chatGenerationRevision: binding.chatGenerationRevision,
          }),
        }, { lifecycle: "ADMIT", status: "pending" }) !== null;
        let inspectionWriter = createAgentInspectionWriter({
          userId: value.userId,
          chatId: value.chatId,
          attemptId,
          ...(previousAttemptId !== undefined ? { previousAttemptId } : {}),
          runId: value.executionId,
          turnSessionId: value.executionId,
          generationId: value.executionId,
          generationType: lineage.target.generationType,
          targetMessageId: lineage.target.messageId,
          targetSwipeId: lineage.target.swipeId,
          hostCorrelationId: `agentic:${value.executionId}:${attemptId}`,
          startedAt: lineage.createdAt,
        });
        let workspaceAttemptId = attemptId;
        if (!recordAdmissionTarget(inspectionWriter, lineage)) {
          // A supplied retry lineage can be externally admitted before its
          // parent attempt has reached this host. Keep that lineage immutable
          // on the execution, but give the workspace its own persisted
          // turn-attempt row rather than weakening the owner/chat/turn check.
          const canonicalAttemptId = execution.execution.id;
          const canonicalLineage = execution.execution.attemptLineage;
          inspectionWriter = createAgentInspectionWriter({
            userId: value.userId,
            chatId: value.chatId,
            attemptId: canonicalAttemptId,
            runId: value.executionId,
            turnSessionId: value.executionId,
            generationId: value.executionId,
            generationType: execution.execution.targetKind,
            targetMessageId: execution.execution.targetMessageId,
            targetSwipeId: execution.execution.targetSwipeId,
            hostCorrelationId: `agentic:${value.executionId}:${canonicalAttemptId}`,
            startedAt: execution.execution.createdAt,
          });
          if (!recordAdmissionTarget(inspectionWriter, canonicalLineage)) {
            throw new AgenticGenerationError(
              "agentic_runtime_unavailable",
              "Durable turn-attempt admission is unavailable.",
              { phase: "ASSEMBLE", retryable: true },
            );
          }
          workspaceAttemptId = canonicalAttemptId;
        }
        inspectionWriters.set(value.executionId, inspectionWriter);
        // Establish the durable ASSEMBLE inspection surface before any snapshot,
        // provider, or compiler work can fail. The same stable empty record is
        // deduplicated if compileAssemblyPlan later confirms an empty policy.
        if (!recordInspectionPrompts(inspectionWriter, [], "root_work", "ASSEMBLE", undefined, true)) {
          throw new AgenticGenerationError(
            "agentic_runtime_unavailable",
            "Durable ASSEMBLE inspection is unavailable.",
            { phase: "ASSEMBLE", retryable: true },
          );
        }
        inspectionWriter.record("condition", {
          id: "admit:condition",
          kind: "condition",
          actor: "host",
          recipient: "agent",
          result: JSON.stringify({
            presetId: decision.internal.binding.presetId,
            configRevision: decision.internal.binding.configRevision,
            bindingRevision: decision.internal.binding.bindingRevision,
            connectionRevision: root?.candidateRevision ?? root?.revision ?? null,
            deadlineAt,
          }),
        }, { lifecycle: "ADMIT", status: "running" });
        const persistentAuthority = createPersistentWorkspaceHostAuthority();
        const persistentWorkspace = ensurePersistentWorkspaceHost(persistentAuthority, {
          userId: value.userId,
          chatId: value.chatId,
          objective: "Complete the requested turn",
        });
        const persistentSession = createPersistentWorkspaceHostTurnSession(persistentAuthority, {
          userId: value.userId,
          chatId: value.chatId,
          workspaceId: persistentWorkspace.id,
          turnSessionId: value.executionId,
          turnId: value.executionId,
          attemptId: workspaceAttemptId,
          executionId: value.executionId,
          expectedRevision: persistentWorkspace.revision,
        });
        persistentAssociations.set(value.executionId, {
          authority: persistentAuthority,
          workspaceId: persistentWorkspace.id,
          workspaceRevision: persistentWorkspace.revision,
          session: persistentSession,
        });
        const linkedPersistentAssociation = persistentAssociations.get(value.executionId);
        if (!linkedPersistentAssociation) {
          throw new AgenticGenerationError(
            "agentic_runtime_unavailable",
            "Persistent workspace association is unavailable after session admission.",
            { phase: "ASSEMBLE" },
          );
        }
        const linkedRecorded = inspectionWriter.record("workspace", {
          version: 1,
          id: `workspace:linked:${value.executionId}`,
          workspaceId: linkedPersistentAssociation.workspaceId,
          workspaceRevision: linkedPersistentAssociation.workspaceRevision,
          relation: "linked",
          objectKind: "objective",
          objectId: null,
          sourceRevision: linkedPersistentAssociation.workspaceRevision,
          sourceDeleted: false,
          provenanceDigest: null,
        }, { lifecycle: "ASSEMBLE", status: "running" });
        if (!linkedRecorded) {
          throw new AgenticGenerationError(
            "agentic_runtime_unavailable",
            "Persistent workspace association could not be recorded.",
            { phase: "ASSEMBLE", retryable: true },
          );
        }
        executionOwnerToken = execution.ownerToken;
        const lifecycleIdentity = {
          model: root?.model ?? "",
          ...(root?.provider ? { provider: root.provider } : {}),
        };
        pool.createPoolEntry({
          generationId: value.executionId, userId: value.userId, chatId: value.chatId,
          generationType: binding.target, characterName: "", ...lifecycleIdentity,
          ...(binding.messageId ? { targetMessageId: binding.messageId } : {}),
          ...(binding.swipeId !== null ? { targetSwipeId: binding.swipeId } : {}),
        });
        eventBus.emit(
          EventType.GENERATION_STARTED,
          {
            generationId: value.executionId, chatId: value.chatId, ...lifecycleIdentity,
            targetMessageId: binding.messageId, targetSwipeId: binding.swipeId, generationType: binding.target,
          },
          value.userId,
        );
        const frozenConnections = [
          root,
          ...Object.values(decision.internal.childConnections),
        ].filter((connection): connection is FrozenConcreteConnectionV1 => connection !== null);
        const admittedConnections = new Map(
          frozenConnections.map((candidate) => [connectionIdentity(candidate), candidate] as const),
        );
        credentialCarrier = await freezeConnectionCredentials(value.userId, frozenConnections);
        const carrier = credentialCarrier;
        if (!carrier) throw new AgenticGenerationError("decision_refresh_required", "Frozen provider credentials are unavailable.", { phase: "ASSEMBLE", retryable: true });
        const rootConnection = root ? requireRenderConnection(root) : null;
        if (!rootConnection) throw new AgenticGenerationError(
          "agentic_provider_failure",
          "Agentic root connection is unavailable.",
          { phase: "ASSEMBLE" },
        );
        const normalizedRootConnection = normalizeConcreteConnection(rootConnection);
        if (normalizedRootConnection && root) {
          admittedConnections.set(connectionIdentity(normalizedRootConnection), root);
        }
        let runtimeOwner: AgentRuntimeOwner;
        runtimeOwner = new AgentRuntimeOwner({
          generationId: value.executionId,
          userId: value.userId,
          config,
          rootConnection,
          signal: rootSignal,
          dispatch: async (request) => {
            let requested: FrozenConcreteConnectionV1 | null = null;
            try {
              requested = normalizeConcreteConnection(request.connection);
            } catch {
              requested = null;
            }
            const frozen = requested
              ? admittedConnections.get(connectionIdentity(requested)) ?? null
              : null;
            if (!frozen) {
              throw new AgenticGenerationError(
                "decision_refresh_required",
                "Provider connection no longer matches runtime admission.",
                { phase: "WORK", retryable: true },
              );
            }
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
              const counter = await resolveCounter(frozen.model ?? "");
              observedOutputTokens = observeOutputTokens(response, { countTokens: counter.count });
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
        // §6.5: reserve the single root RENDER request/context/output/deadline/
        // activity budget at admission so WORK can never starve the frozen
        // render. The envelope derives from immutable host limits; ASSEMBLE
        // freezes those same host defaults into its snapshot, so the
        // RENDER-entry reservation is an idempotent same-envelope no-op that
        // still fails closed on any drift.
        const renderReservationEnvelope = calculateFinalRenderReservationEnvelopeV1({
          activityChunks: finalRenderActivityChunksFromHostLimitsV1(getAgentRuntimeHostLimits().activityEvents),
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
              inspectionWriters.get(value.executionId)?.record("stop", {
                id: `stop:user:${value.executionId}`,
                state: "accepted",
                reason: "user_stop",
                requestedAt: Date.now(),
                correlation: { actorId: "owner", recipientId: "host" },
              }, { status: "cancelling", reason: "user_stop" });
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
        try {
          createTurnWorkspace({
            userId: value.userId, chatId: value.chatId, turnId: value.executionId, workspaceId,
            objective: "Complete the requested turn", constraints: [], retention: policy.retention,
            ...(policy.retention === "turn_terminal" ? { ttlSeconds: WORKSPACE_MAX_TERMINAL_TTL_SECONDS } : {}),
            quota: DEFAULT_QUOTA, capabilities: workspaceCapabilities,
          });
        } catch (error) {
          const admissionOutcome = persistentAdmissionOutcomeForFailure({
            executionId: value.executionId,
            userId: value.userId,
            error,
            signals: [value.signal, rootSignal],
            deadlineAt,
          });
          terminalizePersistentSession(value.executionId, admissionOutcome);
          throw error;
        }
        caps.set(value.executionId, workspaceCapabilities);
        runtimeOwners.set(value.executionId, runtimeOwner);
        return {
          id: value.executionId,
          ownerToken: execution.ownerToken,
          commitKey: execution.commitKey,
          phase: "ASSEMBLE",
          target: targetFromBinding(binding),
          attemptLineage: lineage,
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
        const admissionOutcome = persistentAdmissionOutcomeForFailure({
          executionId: value.executionId,
          userId: value.userId,
          error,
          signals: [value.signal, rootSignal],
          deadlineAt,
        });
        const persistentSessionTerminalized = terminalizePersistentSession(value.executionId, admissionOutcome);
        inspectionWriters.get(value.executionId)?.record("failure", {
          id: `admit:failure:${value.executionId}`,
          kind: "failure",
          actor: "host",
          recipient: "agent",
          errorReason: error instanceof AgenticGenerationError ? inspectionReason(error.code) : "needs_attention",
        }, {
          lifecycle: "TERMINAL",
          status: "terminal",
          outcome: admissionOutcome,
          reason: error instanceof AgenticGenerationError ? inspectionReason(error.code) : "needs_attention",
        });
        console.error("[agentic] createExecution failed", error);
        const unregisterStop = stopRegistrations.get(value.executionId);
        stopRegistrations.delete(value.executionId);
        try {
          unregisterStop?.();
        } catch (unregisterError) {
          console.error("[agentic] stop registration cleanup failed", unregisterError);
        }
        try {
          invalidateFrameCapabilitiesForTurn({ userId: value.userId, chatId: value.chatId, turnId: value.executionId });
        } catch (invalidateError) {
          console.error("[agentic] frame capability cleanup failed", invalidateError);
        }
        if (!persistentSessionTerminalized) {
          console.error("[agentic] persistent admission session could not be terminalized");
        }
        persistentAssociations.delete(value.executionId);
        caps.delete(value.executionId);
        snapshots.delete(value.executionId);
        mediaMaterializers.delete(value.executionId);
        plans.delete(value.executionId);
        works.delete(value.executionId);
        renderFrames.delete(value.executionId);
        renders.delete(value.executionId);
        renderProjections.delete(value.executionId);
        cognitionRuntimes.delete(value.executionId);
        inspectionWriters.delete(value.executionId);
        renderBreakdowns.delete(value.executionId);
        workUsages.delete(value.executionId);
        terminalUsages.delete(value.executionId);
        bindings.delete(value.executionId);
        childJoins.delete(value.executionId);
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
    transitionExecution: (execution, expected, next, terminalReason) => {
      if (!execution.ownerToken || expected === next) return execution;
      const result = transitionTurnExecution({
        executionId: execution.id,
        ownerToken: execution.ownerToken,
        expectedPhase: expected,
        nextPhase: next,
        ...(terminalReason ? { reason: terminalReason } : {}),
      });
      if (result.execution.phase === next) {
        try {
          switch (next) {
            case "ASSEMBLE":
            case "WORK":
            case "RENDER":
              syncPersistentSession(execution.id, next, "running");
              break;
            case "COMPLETE":
              syncPersistentSession(execution.id, "PREPARE_COMMIT", "waiting");
              break;
            case "PREPARE_COMMIT":
              syncPersistentSession(execution.id, "COMMIT", "waiting");
              break;
            case "COMMITTING":
              syncPersistentSession(execution.id, "COMMIT", "running");
              break;
            // Terminal publication owns the single immutable session boundary.
            case "COMMITTED":
              break;
            case "CANCELLED":
              break;
            case "TIMED_OUT":
              break;
            case "EXHAUSTED":
              break;
            case "FAILED":
            case "COMMIT_FAILED":
              break;
            default:
              break;
          }
        } catch (error) {
          // The execution CAS already advanced. Do not retry it with the
          // stale expected phase or let the caller publish a false rollback.
          throw new AgenticGenerationError(
            "agentic_commit_failed",
            "Durable execution advanced but host session reconciliation failed.",
            { phase: result.execution.phase as AgenticPhase, retryable: true, cause: error },
          );
        }
        return { ...execution, phase: result.execution.phase as AgenticPhase };
      }
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
      const nativeProjection = await snapshotInputWithNativeContext(
        input,
        decision,
        target,
        internalDecision(decision).internal.rootConnection,
        rootSignal,
      );
      const snapshot = buildGenerationAssemblySnapshot(nativeProjection.snapshotInput);
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
      mediaMaterializers.set(executionId, nativeProjection.materializeMedia);
      const inspectionWriter = inspectionWriters.get(executionId);
      inspectionWriter?.record("input", {
        id: "assemble:input",
        kind: "input",
        actor: "owner",
        recipient: "host",
        arguments: input.userInput ?? "",
        result: JSON.stringify({
          target: snapshot.target,
          inputRevisions: runtimeInputRevisions(snapshot),
          limits: snapshot.limits,
          databank: snapshot.databank
            ? {
              enabled: snapshot.databank.enabled,
              activeBankIds: snapshot.databank.activeBankIds,
              automaticCount: snapshot.databank.automaticChunks.length,
              mentionSlugs: snapshot.databank.mentions.map((mention) => mention.slug),
              provenance: snapshot.databank.provenance,
            }
            : null,
        }),
      }, { lifecycle: "ASSEMBLE", status: "running" });
      if (input.userInput) {
        inspectionWriter?.record("prompt", {
          id: "prompt:root:user_input",
          sourceId: "turn_input",
          sourceRevision: 0,
          destination: "root_work",
          role: "user",
          included: true,
          content: input.userInput,
          contentDigest: createHash("sha256").update(input.userInput).digest("hex"),
          omissionReason: null,
          nativeProvenance: null,
          loomInspection: null,
        }, { lifecycle: "ASSEMBLE", status: "running" });
      }
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
      const inspectionWriter = inspectionWriters.get(executionId);
      if ((plan.workPolicyMessages?.length ?? 0) + (plan.workspaceUsageMessages?.length ?? 0) + (plan.completionCriteriaMessages?.length ?? 0) + (plan.renderPolicyMessages?.length ?? 0) === 0) {
        recordInspectionPrompts(inspectionWriter, [], "root_work", "ASSEMBLE", undefined, true);
      }
      recordInspectionPrompts(inspectionWriter, plan.workPolicyMessages, "root_work", "ASSEMBLE");
      recordInspectionPrompts(inspectionWriter, plan.workspaceUsageMessages, "root_work", "ASSEMBLE");
      recordInspectionPrompts(inspectionWriter, plan.completionCriteriaMessages, "completion_handoff", "ASSEMBLE");
      recordInspectionPrompts(inspectionWriter, plan.renderPolicyMessages, "render", "ASSEMBLE");
      inspectionWriter?.record("turn_session", {
        id: "assemble:policy",
        kind: "policy",
        detail: JSON.stringify({
          workPolicy: plan.workPolicyMessages?.length ?? 0,
          workspaceUsage: plan.workspaceUsageMessages?.length ?? 0,
          completionCriteria: plan.completionCriteriaMessages?.length ?? 0,
          renderPolicy: plan.renderPolicyMessages?.length ?? 0,
          inputRevisionDigest: canonicalInputRevisionDigest(runtimeInputRevisions(snapshot)),
        }),
      }, { lifecycle: "ASSEMBLE", status: "running" });
      return plan;
    },
    runWork: async ({ execution, input, decision, snapshot, plan, signal }) => {
      const runtimeExecution = requireRuntimeExecution(execution);
      const internal = internalDecision(decision).internal;
      const frozenRoot = internal.rootConnection;
      const runtimeSnapshot = snapshot;
      if (!frozenRoot) return { status: "failed", errorCode: "agentic_provider_failure" };
      const root = requireCompleteFrozenConnection(frozenRoot, "WORK", "root");
      const phaseSignal = runtimeExecution.signal ?? signal;
      const workspaceCapabilities = caps.get(execution.id);
      if (!workspaceCapabilities) {
        throw new AgenticGenerationError("agentic_runtime_unavailable", "Workspace capabilities were not admitted.", { phase: "WORK" });
      }
      const persistentAssociation = persistentAssociations.get(execution.id);
      if (!persistentAssociation) {
        throw new AgenticGenerationError(
          "agentic_runtime_unavailable",
          "Persistent workspace association is unavailable for WORK.",
          { phase: "WORK" },
        );
      }
      refreshPersistentAssociation(persistentAssociation);
      for (const child of plan.children) {
        if (!child.required) continue;
        const currentWorkspace = getPersistentWorkspaceById({
          userId: persistentAssociation.session.userId,
          workspaceId: persistentAssociation.workspaceId,
        });
        persistentAssociation.workspaceRevision = currentWorkspace.revision;
        createPersistentWorkspaceHostTask(persistentAssociation.authority, {
          userId: persistentAssociation.session.userId,
          chatId: runtimeExecution.chatId,
          workspaceId: persistentAssociation.workspaceId,
          expectedRevision: persistentAssociation.workspaceRevision,
          id: `${execution.id}:task:${child.childId}`,
          turnSessionId: persistentAssociation.session.id,
          title: `Required task ${child.slotIndex + 1}`,
          objective: child.task,
          state: "pending",
          required: true,
          dependencyIds: [],
        });
        persistentAssociation.workspaceRevision = getPersistentWorkspaceById({
          userId: persistentAssociation.session.userId,
          workspaceId: persistentAssociation.workspaceId,
        }).revision;
      }
      refreshPersistentAssociation(persistentAssociation);
      const cognitionRuntime = await withToolPermit(
        input.userId,
        () => createCognitionRuntimeForTurn(
          runtimeExecution,
          runtimeSnapshot,
          plan,
          workspaceCapabilities,
        ),
        phaseSignal,
        runtimeExecution.owner.ledger,
      );
      if (cognitionRuntime) cognitionRuntimes.set(execution.id, cognitionRuntime);
      let workActivation: CognitionRuntimeActivationV1 | undefined;
      if (cognitionRuntime) {
        runtimeExecution.workspaceRevision = cognitionRuntime.initialActivation.workspaceRevision;
        workActivation = await enterCognitionPhase(runtimeExecution, cognitionRuntime, "WORK", workspaceCapabilities, phaseSignal);
      }
      const cortexInspectionWriter = inspectionWriters.get(execution.id);
      const cortexAdmissionInput = cortexAuthorizedSnapshotForWork(runtimeExecution, runtimeSnapshot, cognitionRuntime);
      const cortexCorrelation = {
        turnSessionId: execution.id,
        runId: execution.id,
        attemptId: cortexAdmissionInput.attemptId,
        chatId: runtimeSnapshot.chatId,
        generationId: runtimeSnapshot.generationId,
        messageId: runtimeSnapshot.target.messageId ?? null,
        swipeId: runtimeSnapshot.target.swipeId ?? null,
        actorId: "host",
        recipientId: "cortex",
        phase: "WORK" as const,
        taskId: null,
        toolId: null,
        parentId: null,
        hostCorrelationId: `agentic:${execution.id}:${cortexAdmissionInput.attemptId}:cortex:WORK`,
        hostSequence: 0,
      };
      const cortexAdmission = admitCortexSidecar({
        ownerId: runtimeSnapshot.userId,
        attemptId: cortexAdmissionInput.attemptId,
        scope: cortexAdmissionInput.snapshot.scope,
        snapshot: cortexAdmissionInput.snapshot,
        checkpoint: WORK_CORTEX_CHECKPOINT,
        revision: cortexAdmissionInput.snapshot.revision,
        required: cortexAdmissionInput.required,
        requestId: createCortexSidecarRequestId(),
        correlation: cortexCorrelation,
        signal: phaseSignal,
      });
      let cortexContext: CortexSidecarAcceptedV1 | undefined;
      try {
        const cortexResult = await cortexAdmission.read({
          ownerId: runtimeSnapshot.userId,
          attemptId: cortexAdmissionInput.attemptId,
          snapshotId: cortexAdmissionInput.snapshot.snapshotId,
          checkpoint: WORK_CORTEX_CHECKPOINT,
          revision: cortexAdmissionInput.snapshot.revision,
          scope: cortexAdmissionInput.snapshot.scope,
          signal: phaseSignal,
        });
        recordCortexInspection(cortexInspectionWriter, cortexResult);
        if (cortexResult.kind === "accepted") cortexContext = cortexResult;
      } catch (error) {
        if (error instanceof CortexSidecarError) {
          recordCortexInspection(cortexInspectionWriter, {
            kind: "omission",
            omission: error.omission,
            receipt: error.receipt,
          });
          throw mapCortexRequiredError(error);
        }
        throw error;
      }
      const config = frozenConfig(runtimeSnapshot.agentConfig);
      const available = new Set(runtimeSnapshot.availability.toolIds.filter(
        (id): id is CoreAgentToolId => (CORE_AGENT_TOOL_IDS as readonly string[]).includes(id),
      ));
      const rootToolIds = (config.mainToolIds ?? []).filter((id) => available.has(id));
      const rootLoreScope = normalizeLoreScope(config.mainLoreScope);
      const inspectionWriter = inspectionWriters.get(execution.id);
      const childInspection = createChildInspectionCorrelation(inspectionWriter);
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
              ...(inspectionWriter ? { inspection: inspectionWriter } : {}),
            }), toolSignal, runtimeExecution.owner.ledger),
      });
      const coreExecutor = executorFor(rootToolIds, rootLoreScope);
      // All authored profiles can satisfy deterministic ASSEMBLE children.
      // `allowMainDelegation` gates only the agent_delegate tool exposed to
      const profiles = config.profiles ?? [];
      const delegatable = profiles.filter((profile) => profile.allowMainDelegation === true);
      const profileConnections = new Map(profiles.map((profile) => {
        const frozenConnection = profile.connectionRef.kind === "slot"
          ? internal.childConnections[profile.id]
          : root;
        return [
          profile.id,
          requireCompleteFrozenConnection(frozenConnection, "WORK", "child"),
        ] as const;
      }));
      const connectionFor = (profileId: string): CompleteFrozenConnectionV1 => {
        const connection = profileConnections.get(profileId);
        if (!connection) {
          throw new AgenticGenerationError(
            "decision_refresh_required",
            "No frozen child connection is bound to profile " + profileId + ".",
            { phase: "WORK" },
          );
        }
        return connection;
      };
      const childProfiles = profiles.map((profile) => {
        const child = connectionFor(profile.id);
        return Object.freeze({
          profileId: profile.id,
          provider: child.provider,
          connectionId: child.concreteId,
          model: child.model,
        });
      });
      const profileOutputLimits = new Map(plan.profileOutputLimits.map((entry) => [entry.profileId, entry.maxOutputTokens]));
      const delegatableProfiles = delegatable.map((profile) => {
        const child = connectionFor(profile.id);
        return {
          profileId: profile.id,
          provider: child.provider,
          connectionId: child.concreteId,
          model: child.model,
          toolIds: (profile.toolIds ?? []).filter((id) => available.has(id)),
          workspaceCapabilities: Object.freeze(
            (profile.workspaceCapabilities ?? []).filter((operation) =>
              workspaceCapabilities.allowed.includes(operation)
              && DELEGATED_WORKSPACE_OPERATIONS[operation] === true,
            ),
          ),
          ...(profileOutputLimits.has(profile.id) ? { maxOutputTokens: profileOutputLimits.get(profile.id)! } : {}),
        };
      });
      const hostLimits = getAgentRuntimeHostLimits();
      const workspace = makeWorkspace(
        runtimeExecution,
        workspaceCapabilities,
        runtimeSnapshot.limits.maxInputBytes,
        cognitionRuntime,
      );
      const { parameters: effectiveParameters, maxOutputTokens: rootOutputTokenLimit } =
        effectiveRootGenerationParameters(runtimeSnapshot, input);
      const councilProfile = internal.councilProfile;
      const councilSettings = councilProfile?.council_settings;
      const councilAdmission: WorkCouncilAdmission | undefined =
        councilSettings?.councilMode === true
          && councilSettings.toolsSettings.mode === "sidecar"
          && councilSettings.members.length > 0
          && councilProfile !== undefined
          ? {
            userId: runtimeSnapshot.userId,
            chatId: runtimeSnapshot.chatId,
            requestId: `council:${execution.id}`,
            required: false,
            settings: councilProfile.council_settings,
            sidecarSettings: councilProfile.sidecar_settings,
            connection: internal.councilConnection === null || internal.councilConnection === undefined
              ? null
              : {
                concreteId: internal.councilConnection.concreteId,
                provider: internal.councilConnection.provider,
                model: internal.councilConnection.model,
                revision: internal.councilConnection.revision,
                fingerprint: internal.councilConnection.fingerprint,
              },
            toolDefinitions: [],
            connectionRevision: internal.councilConnection?.revision ?? null,
            correlation: {
              turnSessionId: execution.id,
              runId: execution.id,
              attemptId: cortexAdmissionInput.attemptId,
              chatId: runtimeSnapshot.chatId,
              generationId: runtimeSnapshot.generationId,
              messageId: runtimeSnapshot.target.messageId ?? null,
              swipeId: runtimeSnapshot.target.swipeId ?? null,
              actorId: "host",
              recipientId: "council",
              phase: "WORK",
              taskId: null,
              toolId: null,
              parentId: null,
              hostCorrelationId: "agentic:" + execution.id + ":" + cortexAdmissionInput.attemptId + ":council:WORK",
              hostSequence: 0,
            },
          }
          : undefined;
      const council = councilAdmission
        ? createWorkCouncilCapability(councilAdmission)
        : undefined;
      const workInspection = workActivation?.policySurface?.promptInspection;
      const effectiveWorkPolicyMessages = requireInspectedLoomPolicyMessages(
        plan.workPolicyMessages,
        workInspection,
        "workPolicy",
        runtimeSnapshot.limits,
        plan.loomPolicy.workPolicy.length,
      );
      const effectiveWorkspaceUsageMessages = requireInspectedLoomPolicyMessages(
        plan.workspaceUsageMessages,
        workInspection,
        "workspaceUsage",
        runtimeSnapshot.limits,
        plan.loomPolicy.workspaceUsage.length,
      );
      recordInspectionPrompts(inspectionWriters.get(execution.id), effectiveWorkPolicyMessages, "root_work", "WORK", workActivation?.policySurface?.promptInspection);
      recordInspectionPrompts(inspectionWriters.get(execution.id), effectiveWorkspaceUsageMessages, "root_work", "WORK", workActivation?.policySurface?.promptInspection);
      const seenPublicActivityNodeIds = new Set<string>();
      const options: AgenticWorkOptions = {
        rootFrameId: execution.id,
        workspaceId: persistentAssociation.workspaceId,
        workspaceAssociationRevision: persistentAssociation.workspaceRevision,
        trustedAssemblyLimits: runtimeSnapshot.limits,
        snapshot: runtimeSnapshot,
        materializeMedia: mediaMaterializers.get(execution.id),
        plan,
        connectionId: root.concreteId,
        model: root.model,
        provider: root.provider,
        connectionLabel: root.label,
        dispatch: makeWorkProvider(
          input.userId,
          root,
          effectiveParameters,
          runtimeExecution.owner.ledger,
          frozenCredentialFor(runtimeExecution, root),
        ),
        signal: phaseSignal,
        deadlineAt: runtimeExecution.deadlineAt,
        inspection: childInspection.writer,
        onProgress: (progress) => {
          if (progress.provider) {
            eventBus.emit(EventType.GENERATION_PHASE_CHANGED, {
              generationId: execution.id,
              chatId: input.chatId,
              phase: "streaming",
              agentOperation: progress.provider.operation,
              agentLifecycle: progress.provider.lifecycle,
              provider: progress.provider.provider,
              connectionLabel: progress.provider.connectionLabel,
              model: progress.provider.model,
            }, input.userId);
          }
          recordPublicWorkActivity(
            runtimeExecution.owner.ledger,
            progress,
            execution.id,
            childInspection.childTaskIds,
            seenPublicActivityNodeIds,
            {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              toolCalls: progress.observationCount,
              childInvocations: progress.childResultCount,
            },
          );
          const activitySnapshot = runtimeExecution.owner.ledger.activitySnapshot();
          workUsages.set(execution.id, activitySnapshot.usage);
          const liveBinding = bindings.get(execution.id);
          withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
            userId: input.userId,
            chatId: input.chatId,
            turnId: execution.id,
            generationId: execution.id,
            generationType: runtimeSnapshot.target.generationType,
            targetMessageId: liveBinding?.messageId ?? runtimeSnapshot.target.messageId ?? null,
            targetSwipeId: liveBinding?.swipeId ?? runtimeSnapshot.target.swipeId ?? null,
            attemptLineage: runtimeExecution.attemptLineage,
            status: "WORK",
            workPhase: "WORK",
            workStatus: "running",
            activity: activitySnapshot.nodes,
            omission: { omittedNodeCount: activitySnapshot.omittedNodeCount },
            usage: activitySnapshot.usage,
          }));
        },
        ...(plan.customPhasePlan && plan.customPhasePlan.phases.length > 0
          ? {
            phaseEvaluationContext: {
              generationType: runtimeSnapshot.target.generationType,
              phase: "WORK" as const,
              presetVariables: cognitionPresetVariables(runtimeSnapshot),
              participantFacts: Object.freeze({
                hasPersona: runtimeSnapshot.participants.persona !== null,
                groupSize: runtimeSnapshot.participants.group.length,
                hasGroup: runtimeSnapshot.participants.group.length > 0,
              }),
              availableTools: runtimeSnapshot.availability.toolIds,
              taskTransitions: Object.freeze({}),
            },
            phaseAdmittedCapabilities: Object.freeze([
              ...(rootToolIds.length > 0 ? ["core_retrieval" as const] : []),
              ...(workspaceCapabilities.allowed.some((operation) => operation === "read_section" || operation === "read_page") ? ["workspace_read" as const] : []),
              ...(workspaceCapabilities.allowed.some((operation) => operation !== "read_section" && operation !== "read_page") ? ["workspace_write" as const] : []),
              ...(delegatable.length > 0 ? ["delegation" as const] : []),
              ...(cortexContext ? ["cortex" as const] : []),
              ...(council ? ["council" as const] : []),
            ]),
            phaseRevision: runtimeExecution.workspaceRevision ?? 0,
          }
          : {}),
        ...(cortexContext ? { cortexContext } : {}),
        ...(council ? { council } : {}),
        ...(workInspection === undefined ? {} : { promptInspection: workInspection }),
        coreToolIds: rootToolIds,
        workPolicyMessages: effectiveWorkPolicyMessages,
        workspaceUsageMessages: effectiveWorkspaceUsageMessages,
        completionCriteriaMessages: plan.completionCriteriaMessages,
        renderPolicyMessages: plan.renderPolicyMessages,
        coreSnapshot: toolSnapshot,
        coreToolCapability: coreExecutor,
        workspace,
        workspaceCapabilities,
        allowAgentDelegate: delegatable.length > 0,
        delegatableProfiles,
        childProfiles,
        budget: {
          maxToolCalls: Math.min(config.maxToolCalls ?? hostLimits.aggregateToolCalls, hostLimits.aggregateToolCalls),
          maxChildFrames: Math.min(config.maxInvocations ?? hostLimits.childAdmissions, hostLimits.childAdmissions),
          maxOutputTokens: rootOutputTokenLimit,
        },
        executeChild: ({
          frame,
          descriptor,
          definitions,
          phaseId,
          phaseInstructionSubset,
          workspace: childWorkspace,
        }): Promise<AgenticChildExecutionResult> =>
          trackChild(execution.id, async () => {
          childInspection.bind(descriptor.childId, frame.assignedTaskId);
          const profile = profiles.find((candidate) => candidate.id === descriptor.profileId);
          if (!profile || typeof profile.systemPrompt !== "string") {
            return { content: "", status: "failed" as const, errorCode: "child_profile_unauthorized" };
          }
          const childToolIds = (profile.toolIds ?? []).filter((id) => available.has(id));
          const child = connectionFor(descriptor.profileId);
          const result = await executeBoundedAgenticChildFrame({
            frame, task: descriptor.task, definitions,
            ...(childWorkspace ? { workspace: childWorkspace } : {}),
            ...(phaseId !== undefined ? { phaseId } : {}),
            ...(phaseInstructionSubset ? { phaseInstructionSubset } : {}),
            systemPrompt: profile.systemPrompt,
            maxInputBytes: runtimeSnapshot.limits.maxInputBytes,
            reserveInitialInput: (bytes) =>
              runtimeExecution.owner.ledger.chargeBytes("initial_input_bytes", bytes),
            dispatch: makeWorkProvider(
              input.userId,
              child,
              effectiveParameters,
              runtimeExecution.owner.ledger,
              frozenCredentialFor(runtimeExecution, child),
              (request, outcome) => recordChildProviderExchange(
                childInspection.writer,
                request,
                outcome,
                child,
                internal.binding.configRevision ?? null,
                profile.id,
                descriptor.childId,
              ),
            ),
            executeCore: executorFor(childToolIds, normalizeLoreScope(profile.loreScope)),
            budget: {
              maxChildOutputBytes: descriptor.maxOutputBytes,
              maxChildReceiveBytes: MAX_OUTPUT_BYTES,
              maxOutputTokens: descriptor.maxOutputTokens,
            },
          });
          return {
            content: result.content,
            status: result.status,
            ...(result.code ? { errorCode: result.code } : {}),
            ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.workspaceRevision !== undefined ? { workspaceRevision: result.workspaceRevision } : {}),
          };
          }),
      };
      const outcome = await runAgenticWorkPhase(options).finally(() => childInspection.flush());
      const workspaceRevision = adoptWorkWorkspaceRevision(runtimeExecution, outcome);
      recordPublicWorkActivity(
        runtimeExecution.owner.ledger,
        outcome,
        execution.id,
        childInspection.childTaskIds,
        seenPublicActivityNodeIds,
      );
      const usage = runtimeExecution.owner.ledger.activitySnapshot().usage;
      works.set(execution.id, outcome);
      workUsages.set(execution.id, usage);
      if (outcome.renderHandoff) {
        renderFrames.set(execution.id, Object.freeze({
          handoff: outcome.renderHandoff,
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
        usage: { toolCalls: usage.toolCalls, childInvocations: usage.childInvocations },
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
        ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      };
    },
    render: async ({ execution, input, decision, snapshot, plan, signal }) => {
      const runtimeExecution = requireRuntimeExecution(execution);
      const workspaceCapabilities = caps.get(execution.id);
      if (!workspaceCapabilities) throw new Error("agentic_workspace_capability_missing");
      const cognitionRuntime = cognitionRuntimes.get(execution.id);
      let renderActivation: CognitionRuntimeActivationV1 | undefined;
      if (cognitionRuntime) {
        renderActivation = await enterCognitionPhase(runtimeExecution, cognitionRuntime, "RENDER", workspaceCapabilities, runtimeExecution.signal ?? signal);
      }
      const root = internalDecision(decision).internal.rootConnection;
      if (!root) throw new Error("agentic_provider_failure");
      const runtimeSnapshot = requireRuntimeSnapshot(snapshot);
      const reservationEnvelope = calculateFinalRenderReservationEnvelopeV1({
        activityChunks: finalRenderActivityChunksFromHostLimitsV1(getAgentRuntimeHostLimits().activityEvents),
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
      const effectiveRenderPolicyMessages = requireInspectedLoomPolicyMessages(
        plan.renderPolicyMessages,
        renderActivation?.policySurface?.promptInspection,
        "renderPolicy",
        runtimeSnapshot.limits,
        plan.loomPolicy.renderPolicy.length,
      );
      const renderInspectionWriter = inspectionWriters.get(execution.id);
      recordRenderCrossings(renderInspectionWriter, frame.handoff, execution.id);
      recordInspectionPrompts(renderInspectionWriter, effectiveRenderPolicyMessages, "render", "RENDER", renderActivation?.policySurface?.promptInspection);
      recordInspectionPrompts(
        renderInspectionWriter,
        plan.providerMessages.filter((message) => {
          const kind = message.provenance.kind;
          return !message.provenance.loom && (kind === "block" || kind === "history" || kind === "world_info" || kind === "databank");
        }),
        "render",
        "RENDER",
      );
      const renderMessages = buildAgenticRenderPolicyMessages({
        nativeMessages: plan.providerMessages,
        materializeMedia: mediaMaterializers.get(execution.id),
        renderGuidance: frame.handoff.renderGuidance,
        renderPolicyMessages: effectiveRenderPolicyMessages,
      });
      const { parameters: effectiveParameters, maxOutputTokens: rootOutputTokenLimit } =
        effectiveRootGenerationParameters(runtimeSnapshot, input);
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
          maxOutputTokens: rootOutputTokenLimit,
          parameters: effectiveParameters,
        },
        reservedBudgets: reservation,
        signal: runtimeExecution.signal ?? signal,
      };
      pool.setPoolStatus(execution.id, "streaming");
      pool.markStreamingStarted(execution.id);
      const countRenderTokens = await resolveRenderCountTokens(root.model ?? undefined);
      const captureRenderBreakdown = (request: GenerationRequest): void => {
        const breakdownMessages = request.messages.map((message) => {
          const content = typeof message.content === "string"
            ? message.content
            : message.content
                .map((part) => part.type === "text" ? part.text : "")
                .join("");
          return {
            role: message.role,
            content: redactAgentOutputFrames(content),
            ...(message.name === undefined ? {} : { name: message.name }),
          };
        });
        const breakdownEntries = breakdownMessages.map((message, index) => ({
          name: `Render message ${index + 1}`,
          type: "utility" as const,
          tokens: countRenderTokens(message.content),
          role: message.role,
          content: message.content,
        }));
        renderBreakdowns.set(execution.id, {
          entries: breakdownEntries,
          messages: breakdownMessages,
          totalTokens: breakdownEntries.reduce((total, entry) => total + entry.tokens, 0),
          model: request.model,
          provider: root.provider ?? "",
          parameters: request.parameters ?? {},
          ...(renderActivation?.policySurface?.promptInspection
            ? { loomPromptInspection: renderActivation.policySurface.promptInspection }
            : {}),
        });
      };
      let result: Awaited<ReturnType<typeof runAgenticRenderPhaseV1>>;
      try {
        result = await runAgenticRenderPhaseV1(renderInput, {
          dispatch: makeRenderProvider(
            input.userId,
            root,
            runtimeExecution.owner.ledger,
            frozenCredentialFor(runtimeExecution, root),
            captureRenderBreakdown,
          ),
          countTokens: countRenderTokens,
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
      if (cognitionRuntime) {
        await enterCognitionPhase(runtimeExecution, cognitionRuntime, "PREPARE_COMMIT", workspaceCapabilities, runtimeExecution.signal ?? execution.signal);
      }
      const runtimeSnapshot = requireRuntimeSnapshot(snapshot);
      const binding = bindings.get(execution.id);
      if (!binding) throw new Error("agentic_target_binding_missing");
      const timeoutMs = Math.min(
        HOST_PREPARATION_LIMITS_V1.maxWallClockMs,
        Math.max(1, runtimeExecution.deadlineAt - Date.now()),
      );
      const preparedInput = prepareInput(input, runtimeExecution, runtimeSnapshot, plan, render, binding);
      const result = await prepareAgentRender(
        preparedInput,
        {
          userId: input.userId,
          signal: runtimeExecution.signal ?? execution.signal,
          timeoutMs,
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
      const workUsage = workUsages.get(execution.id)
        ?? publicWorkActivityUsage(works.get(execution.id) ?? { observations: [], childResults: [] });
      const activityUsage: AgentActivityUsageV1 = {
        inputTokens: activitySnapshot.usage.inputTokens,
        outputTokens: activitySnapshot.usage.outputTokens,
        totalTokens: activitySnapshot.usage.totalTokens,
        toolCalls: Math.max(activitySnapshot.usage.toolCalls, workUsage.toolCalls),
        childInvocations: Math.max(activitySnapshot.usage.childInvocations, workUsage.childInvocations),
      };
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
        ? { name: frozenCharacterName }
        : {};
      const messageExtra = {
        generation_id: execution.id,
        generation_type: runtimeSnapshot.target.generationType,
        ...(frozenCharacterId ? { character_id: frozenCharacterId } : {}),
      };
      const workspaceUsage = renderProjection.workspaceUsage;
      const workspaceArtifacts = frozenWorkspaceArtifacts(runtimeExecution, fixedWorkspaceRevision);
      const terminalHandoff = renderProjection.terminalHandoff;
      const commitInput: AgenticCommitInputV1 = {
        db: getDb(),
        dependencies: commitDependencies,
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
        activityUsage,
        renderPreparation: preparedResult,
        artifacts: workspaceArtifacts,
        assemblyPlan: { inputRevisions: runtimePlan.inputRevisions, deltas: assemblyDeltas },
        completion: {
          summary: work.summary ?? "Agentic turn completed",
          unresolvedIds: work.unresolvedIds ?? [],
          renderGuidance: work.renderGuidance,
        },
        message: { content: prepared.content, ...normalMessageAttribution, extra: messageExtra },
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
      if (result.status === "committed") {
        const messageRevision = result.messageId === undefined
          ? null
          : (binding.messageGenerationRevision ?? 0) + 1;
        commitTargetRevisions.set(execution.id, {
          messageRevision,
          swipeRevision: messageRevision === null || result.swipeId === undefined ? null : messageRevision,
        });
      }
      const renderUsage = prepared.usage
        ? boundedProviderUsage({
          promptTokens: prepared.usage.promptTokens,
          completionTokens: prepared.usage.completionTokens,
          totalTokens: prepared.usage.totalTokens,
        })
        : undefined;
      const renderBreakdown = renderBreakdowns.get(execution.id);
      if (result.status === "committed" && result.messageId && renderBreakdown) {
        try {
          breakdownSvc.storeBreakdown(
            input.userId,
            result.messageId,
            input.chatId,
            {
              assemblySurface: "WORK",
              entries: renderBreakdown.entries,
              messages: renderBreakdown.messages,
              totalTokens: renderBreakdown.totalTokens,
              chatHistoryTokens: 0,
              maxContext: 0,
              model: renderBreakdown.model,
              provider: renderBreakdown.provider,
              parameters: renderBreakdown.parameters,
              ...(renderUsage
                ? {
                    usage: {
                      prompt_tokens: renderUsage.promptTokens,
                      completion_tokens: renderUsage.completionTokens,
                      total_tokens: renderUsage.totalTokens,
                    },
                  }
                : {}),
              ...(renderBreakdown.loomPromptInspection === undefined
                ? {}
                : { loomPromptInspection: renderBreakdown.loomPromptInspection }),
              tokenizer_name: null,
            },
          );
        } catch (error) {
          console.warn("[agentic] Failed to store WORK prompt breakdown:", error);
        }
      }
      if (result.status === "committed" && renderUsage) {
        terminalUsages.set(execution.id, {
          inputTokens: renderUsage.promptTokens,
          outputTokens: renderUsage.completionTokens,
          totalTokens: renderUsage.totalTokens,
          toolCalls: workUsage.toolCalls,
          childInvocations: workUsage.childInvocations,
        });
      }
      const commitInspectionWriter = inspectionWriters.get(execution.id);
      if (result.status === "committed") {
        try {
          if (renderUsage) {
            const usageRecorded = commitInspectionWriter?.record("usage", {
              version: 1,
              id: `usage:render:${execution.id}`,
              source: "final",
              layer: "root",
              correlation: { parentId: "root" },
              inputTokens: renderUsage.promptTokens,
              outputTokens: renderUsage.completionTokens,
              totalTokens: renderUsage.totalTokens,
              toolCalls: 0,
              childInvocations: 0,
              canonical: true,
            }, { lifecycle: "COMMIT", status: "waiting" });
            if (!usageRecorded) {
              throw new Error("render_usage_projection_missing");
            }
          }
          const publicationPersistentAssociation = persistentAssociations.get(execution.id);
          if (!publicationPersistentAssociation) {
            throw new Error("persistent_workspace_association_missing");
          }
          refreshPersistentAssociation(publicationPersistentAssociation);
          const publicationRecorded = commitInspectionWriter?.record("workspace", {
            version: 1,
            id: `workspace:publication:${execution.id}`,
            workspaceId: publicationPersistentAssociation.workspaceId,
            workspaceRevision: publicationPersistentAssociation.workspaceRevision,
            relation: "published",
            objectKind: "publication",
            objectId: result.messageId ?? null,
            sourceRevision: publicationPersistentAssociation.workspaceRevision,
            sourceDeleted: false,
            provenanceDigest: null,
          }, { lifecycle: "COMMIT", status: "waiting" });
          if (!publicationRecorded) {
            throw new Error("published_workspace_association_missing");
          }
          const commitRecorded = commitInspectionWriter?.record("commit", {
            id: `commit:${execution.id}`,
            kind: "commit",
            actor: "host",
            recipient: "owner",
            result: JSON.stringify({
              status: result.status,
              receiptId: result.receipt.id,
              messageId: result.messageId,
              swipeId: result.swipeId,
            }),
            correlation: { parentId: "root" },
          }, { lifecycle: "COMMIT", status: "waiting" });
          if (!commitRecorded) throw new Error("commit_projection_missing");
          if (cognitionRuntime) {
            await enterCognitionPhase(runtimeExecution, cognitionRuntime, "COMMITTED", workspaceCapabilities, runtimeExecution.signal ?? execution.signal);
          }
          if (result.messageId) {
            const committed = getMessage(input.userId, result.messageId);
            if (committed && committed.chat_id === input.chatId) {
              eventBus.emit(
                binding.target === "normal" ? EventType.MESSAGE_SENT : EventType.MESSAGE_EDITED,
                { chatId: input.chatId, message: committed },
                input.userId,
              );
            }
          }
        } catch (error) {
          throw new AgenticGenerationError(
            "agentic_commit_failed",
            "Post-commit publication or projection reconciliation failed.",
            { phase: "COMMITTING", retryable: true, cause: error },
          );
        }
      } else {
        commitInspectionWriter?.record("commit", {
          id: `commit:${execution.id}`,
          kind: "commit",
          actor: "host",
          recipient: "owner",
          result: JSON.stringify({
            status: result.status,
            receiptId: result.receipt.id,
            messageId: result.messageId,
            swipeId: result.swipeId,
          }),
          correlation: { parentId: "root" },
        }, { lifecycle: "COMMIT", status: "waiting" });
      }
      return { receiptId: result.receipt.id, commitKey: execution.commitKey, messageId: result.messageId ?? undefined, swipeId: result.swipeId ?? undefined, summary: typeof result.receipt.summary === "object" ? result.receipt.summary as Record<string, unknown> : undefined };
    },
    publishPhase: (event) => {
      const phaseWriter = inspectionWriters.get(event.executionId);
      phaseWriter?.record("milestone", {
        id: `phase:${event.executionId}:${event.phase}`,
        kind: "milestone",
        actor: "host",
        recipient: "owner",
        result: JSON.stringify({
          phase: event.phase,
          workPhase: event.workPhase ?? null,
          workStatus: event.workStatus ?? null,
          workOutcome: event.workOutcome ?? null,
          reason: event.reason ?? null,
        }),
        correlation: { parentId: "root" },
      }, {
        lifecycle: inspectionLifecycleForPhase(event.phase),
        status: inspectionStatusForPhase(event.phase, event.workStatus),
        reason: inspectionReason(event.reason),
        updatedAt: Date.now(),
      });
      // COMMITTED is the immutable terminal projection. It is published by
      // publishTerminal only after persistent-session and inspection
      // reconciliation succeeds.
      if (event.phase === "COMMITTED") return;
      if (!getTurnExecution(event.executionId, event.userId)) return;
      const binding = bindings.get(event.executionId);
      const targetMessageId = binding?.messageId ?? event.target.messageId ?? null;
      const targetSwipeId = binding?.swipeId ?? event.target.swipeId ?? null;
      const activitySnapshot = runtimeOwners.get(event.executionId)?.ledger.activitySnapshot();
      const projection: AgentRunProjectionInputV2 = {
        userId: event.userId,
        chatId: event.chatId,
        turnId: event.executionId,
        generationId: event.executionId,
        generationType: event.target.generationType,
        targetMessageId,
        targetSwipeId,
        ...(event.attemptLineage ? { attemptLineage: event.attemptLineage } : {}),
        status: event.phase,
        workPhase: event.workPhase,
        workStatus: event.workStatus,
        workOutcome: event.workOutcome,
        reason: event.reason,
        ...(activitySnapshot
          ? {
              activity: activitySnapshot.nodes,
              omission: { omittedNodeCount: activitySnapshot.omittedNodeCount },
              usage: activitySnapshot.usage,
            }
          : workUsages.get(event.executionId)
            ? { usage: workUsages.get(event.executionId) }
            : {}),
      };
      try {
        withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, projection));
      } catch (error) {
        console.error("[agentic] phase projection failed", error);
        throw error;
      }
    },
    publishTerminal: (event) => {
      const initialExecution = getTurnExecution(event.executionId, event.userId);
      if (!initialExecution && event.attemptLineage?.previousAttemptId) return;
      const durableExecution = initialExecution ?? materializeFallbackExecution(event);
      const durableReceipt = durableExecution
        ? getTurnCommitReceipt(event.executionId, event.userId)
        : null;
      const receiptForProjection = event.receipt ?? (durableReceipt
        ? {
            receiptId: durableReceipt.id,
            messageId: durableReceipt.messageId ?? undefined,
            swipeId: durableReceipt.swipeId ?? undefined,
            summary: durableReceipt.summary,
          }
        : undefined);
      const committedBoundary = durableExecution?.phase === "COMMITTED"
        && (event.receipt !== undefined || durableReceipt !== null);
      const terminalState = coordinatorTerminalPublicationState(event, committedBoundary);
      const status = terminalState.status;
      const committedSettlement = status === "COMMITTED"
        ? requireCommittedTerminalSettlement(event, durableReceipt)
        : null;
      const terminalOutcome = terminalState.outcome;
      const terminalInspection = ensureInspectionWriter(event);
      const inspectionReasonValue: AgentInspectionReasonV1 = committedBoundary && event.status !== "completed"
        ? "reconciled"
        : terminalInspectionReason(committedBoundary ? "completed" : event.status, event.reason, event.errorCode);
      const terminalReason = committedBoundary && event.status !== "completed"
        ? "reconciliation_required"
        : inspectionReasonValue;
      const terminalAt = Date.now();
      const binding = bindings.get(event.executionId);
      const targetMessageId = binding?.messageId ?? event.target.messageId ?? null;
      const targetSwipeId = binding?.swipeId ?? event.target.swipeId ?? null;
      const terminalMessageId = committedSettlement?.messageId
        ?? event.receipt?.messageId
        ?? durableReceipt?.messageId
        ?? null;
      const terminalSwipeId = committedSettlement?.swipeId
        ?? event.receipt?.swipeId
        ?? durableReceipt?.swipeId
        ?? null;
      const committedTargetRevisions = commitTargetRevisions.get(event.executionId);
      const terminalMessageRevision = terminalMessageId === null
        ? null
        : committedTargetRevisions?.messageRevision ?? null;
      const terminalSwipeRevision = terminalSwipeId === null
        ? null
        : committedTargetRevisions?.swipeRevision ?? terminalMessageRevision;
      const terminalUsage = terminalUsages.get(event.executionId) ?? workUsages.get(event.executionId);
      const projection: AgentRunProjectionInputV2 = {
        userId: event.userId,
        chatId: event.chatId,
        turnId: event.executionId,
        generationId: event.executionId,
        generationType: event.target.generationType,
        targetMessageId,
        targetSwipeId,
        ...(event.attemptLineage ? { attemptLineage: event.attemptLineage } : {}),
        status,
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: terminalOutcome,
        reason: terminalReason,
        ...(event.errorCode || status === "COMMIT_FAILED" ? {
          error: {
            code: preservedDecisionRefreshCode(event.errorCode)
              ?? (terminalOutcome === "rejected"
                ? "invalid_input"
                : event.errorCode ?? "agentic_commit_failed"),
            recoveryAction: "resync",
            reason: event.errorMessage ?? terminalReason,
            workPhase: "TERMINAL",
            workStatus: "terminal",
            workOutcome: terminalOutcome,
          },
        } : {}),
        terminalHandoff: {
          version: 2,
          committed: status === "COMMITTED",
          messageId: terminalMessageId,
          swipeId: terminalSwipeId,
          messageRevision: terminalMessageRevision,
          swipeRevision: terminalSwipeRevision,
        },
        ...(terminalUsage ? { usage: terminalUsage } : {}),
      };
      // Terminal reconciliation is one durable boundary. The nonterminal
      // COMMITTING projection staged by commitAgenticTurnV1 remains mutable
      // until both the host session CAS and terminal inspection succeed.
      withAgentRunProjectionTransaction((db) => {
        syncPersistentSession(event.executionId, "TERMINAL", "terminal", terminalOutcome);
        const terminalRecorded = terminalInspection.writer.record("terminal", {
          id: `terminal:${event.executionId}`,
          kind: "terminal",
          actor: "host",
          recipient: "owner",
          result: JSON.stringify({
            status,
            phase: terminalState.phase,
            workOutcome: terminalOutcome,
            errorCode: event.errorCode ?? null,
            errorMessage: event.errorMessage ?? null,
            receiptId: receiptForProjection?.receiptId ?? null,
          }),
          errorReason: inspectionReasonValue,
        }, {
          lifecycle: "TERMINAL",
          status: "terminal",
          outcome: terminalOutcome,
          reason: inspectionReasonValue,
          terminalAt,
          terminalReceipt: receiptForProjection ?? null,
          ...(terminalInspection.recovered ? { reconciliation: "recovered" as const } : {}),
        });
        if (!terminalRecorded) throw new Error("terminal_inspection_projection_failed");
        return appendAgentRunSnapshot(db, projection);
      });
      const messageId = terminalMessageId ?? undefined;
      const completed = status === "COMMITTED";
      const content = committedSettlement?.content
        ?? pool.getPoolEntry(event.executionId)?.content
        ?? "";
      const terminalPhase = terminalState.phase;
      const diagnostic = completed
        ? ""
        : [
          terminalPhase,
          event.errorCode ?? (status === "COMMIT_FAILED" ? "agentic_commit_failed" : null),
          event.errorMessage && event.errorMessage !== event.errorCode ? event.errorMessage : null,
        ].filter((part): part is string => typeof part === "string" && part.length > 0).join(": ");
      try {
        if (status === "CANCELLED") pool.stopPool(event.executionId);
        else if (completed) pool.completePool(event.executionId, messageId);
        else pool.errorPool(event.executionId, diagnostic || event.errorCode || "agentic_failed");
      } catch (error) {
        console.error("[agentic] terminal pool settlement failed", error);
      }
      try {
        eventBus.emit(
          status === "CANCELLED" ? EventType.GENERATION_STOPPED : EventType.GENERATION_ENDED,
          {
            generationId: event.executionId,
            chatId: event.chatId,
            ...(messageId ? { messageId } : {}),
            content,
            ...(targetMessageId ? { targetMessageId } : {}),
            ...(targetSwipeId !== null ? { targetSwipeId } : {}),
            phase: terminalPhase,
            status,
            ...(completed || !event.errorCode ? {} : { errorCode: event.errorCode }),
            ...(completed || !diagnostic ? {} : { error: diagnostic }),
          },
          event.userId,
        );
      } catch (error) {
        // The durable projection/outbox is authoritative; a websocket listener
        // failure must not turn an already-published terminal row into a retry.
        console.error("[agentic] terminal event emission failed", error);
      }
    },
    terminalPublicationFailed: (event, error) => {
      terminalInspectionFailures.delete(event.executionId);
      const initialExecution = getTurnExecution(event.executionId, event.userId);
      if (!initialExecution && event.attemptLineage?.previousAttemptId) return;
      const durableExecution = initialExecution ?? materializeFallbackExecution(event);
      const durableReceipt = durableExecution
        ? getTurnCommitReceipt(event.executionId, event.userId)
        : null;
      const committedBoundary = durableExecution?.phase === "COMMITTED"
        && (event.receipt !== undefined || durableReceipt !== null);
      const receiptForProjection = event.receipt ?? (durableReceipt
        ? {
            receiptId: durableReceipt.id,
            messageId: durableReceipt.messageId ?? undefined,
            swipeId: durableReceipt.swipeId ?? undefined,
            summary: durableReceipt.summary,
          }
        : undefined);
      const terminalState = coordinatorTerminalPublicationState(event, committedBoundary);
      const terminalAt = Date.now();
      const failureCode = "projection_unavailable";
      const inspectionReasonValue: AgentInspectionReasonV1 = committedBoundary ? "reconciled" : inspectionReason(failureCode);
      const terminalReason = committedBoundary ? "reconciliation_required" : failureCode;
      const terminalOutcome = terminalState.outcome;
      const terminalLifecycleErrorCode = terminalOutcome === "stopped"
        ? "cancelled"
        : terminalOutcome === "exhausted"
          ? "limit_exceeded"
          : preservedDecisionRefreshCode(event.errorCode)
            ?? (terminalOutcome === "rejected"
              ? "invalid_input"
              : "internal_error");
      const terminalStatus = terminalState.status;
      const terminalPhase = terminalState.phase;
      const terminalMessageId = event.receipt?.messageId ?? durableReceipt?.messageId ?? null;
      const terminalSwipeId = event.receipt?.swipeId ?? durableReceipt?.swipeId ?? null;
      let terminalInspection: { readonly writer: AgentInspectionWriterV1; readonly recovered: boolean } | undefined;
      let terminalInspectionPersisted = false;
      const settlePool = (): void => {
        const diagnostic = terminalStatus === "COMMITTED"
          ? ""
          : [
            terminalPhase,
            failureCode,
          ].filter((part): part is string => part.length > 0).join(": ");
        try {
          if (terminalStatus === "CANCELLED") pool.stopPool(event.executionId);
          else if (terminalStatus === "COMMITTED") pool.completePool(event.executionId, terminalMessageId ?? undefined);
          else pool.errorPool(event.executionId, diagnostic || failureCode);
        } catch (poolError) {
          console.error("[agentic] terminal failure pool reconciliation failed", poolError);
        }
      };

      try {
        terminalInspection = ensureInspectionWriter(event);
        const recorded = terminalInspection.writer.record(committedBoundary ? "terminal" : "failure", {
          id: committedBoundary
            ? `terminal:${event.executionId}`
            : `terminal:failure:${event.executionId}`,
          kind: committedBoundary ? "terminal" : "failure",
          actor: "host",
          recipient: "owner",
          result: JSON.stringify({
            phase: terminalPhase,
            status: terminalStatus,
            workOutcome: terminalOutcome,
            error: error instanceof Error ? error.message : String(error),
            receiptId: receiptForProjection?.receiptId ?? null,
          }),
          errorReason: inspectionReasonValue,
          correlation: { parentId: "root" },
        }, {
          lifecycle: "TERMINAL",
          status: "terminal",
          outcome: terminalOutcome,
          reason: inspectionReasonValue,
          updatedAt: terminalAt,
          terminalReceipt: receiptForProjection ?? null,
          ...(terminalInspection.recovered ? { reconciliation: "recovered" as const } : {}),
        });
        if (!recorded) throw new Error("terminal_failure_inspection_projection_failed");
        terminalInspectionPersisted = true;
      } catch (inspectionError) {
        console.error("[agentic] terminal failure inspection reconciliation failed", inspectionError);
      }
      if (!terminalInspectionPersisted || !terminalInspection) {
        terminalInspectionFailures.add(event.executionId);
        console.error("[agentic] terminal failure recovery deferred until inspection persistence succeeds");
        settlePool();
        return;
      }

      let persistentSessionTerminal = false;
      try {
        persistentSessionTerminal = terminalizePersistentSession(event.executionId, terminalOutcome);
      } catch (syncError) {
        console.error("[agentic] terminal failure session reconciliation failed", syncError);
      }

      if (committedBoundary && durableExecution && durableReceipt && !persistentSessionTerminal) {
        console.error("[agentic] committed receipt projection deferred until persistent session terminalization");
      }

      try {
        if (committedBoundary && durableExecution && durableReceipt) {
          if (persistentSessionTerminal) {
            withAgentRunProjectionTransaction((db) =>
              repairAgentRunProjectionFromReceipt(db, durableExecution!, durableReceipt, {
                reason: terminalReason,
                error: {
                  code: failureCode,
                  recoveryEligible: true,
                  recoveryAction: "resync",
                  workPhase: "TERMINAL",
                  workStatus: "terminal",
                  workOutcome: "completed",
                  reason: terminalReason,
                },
              }),
            );
          }
        } else if (!committedBoundary) {
          const binding = bindings.get(event.executionId);
          const targetMessageId = binding?.messageId ?? event.target.messageId ?? null;
          const targetSwipeId = binding?.swipeId ?? event.target.swipeId ?? null;
          const committedTargetRevisions = commitTargetRevisions.get(event.executionId);
          const terminalMessageRevision = terminalMessageId === null
            ? null
            : committedTargetRevisions?.messageRevision ?? null;
          const terminalSwipeRevision = terminalSwipeId === null
            ? null
            : committedTargetRevisions?.swipeRevision ?? terminalMessageRevision;
          const terminalUsage = terminalUsages.get(event.executionId) ?? workUsages.get(event.executionId);
          withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
            userId: event.userId,
            chatId: event.chatId,
            turnId: event.executionId,
            generationId: event.executionId,
            generationType: event.target.generationType,
            targetMessageId,
            targetSwipeId,
            ...(event.attemptLineage ? { attemptLineage: event.attemptLineage } : {}),
            status: terminalStatus,
            workPhase: "TERMINAL",
            workStatus: "terminal",
            workOutcome: terminalOutcome,
            reason: terminalReason,
            error: {
              code: terminalLifecycleErrorCode,
              summaryCode: `agentRun.errors.${failureCode}`,
              recoveryEligible: true,
              recoveryAction: "resync",
              reason: terminalReason,
              workPhase: "TERMINAL",
              workStatus: "terminal",
              workOutcome: terminalOutcome,
            },
            terminalHandoff: {
              version: 2,
              committed: false,
              messageId: terminalMessageId,
              swipeId: terminalSwipeId,
              messageRevision: terminalMessageRevision,
              swipeRevision: terminalSwipeRevision,
            },
            ...(terminalUsage ? { usage: terminalUsage } : {}),
          }));
        }
      } catch (reconciliationError) {
        console.error("[agentic] terminal failure projection reconciliation failed", reconciliationError);
      }

      settlePool();
    },
    cleanup: ({ execution, executionId, phase, status }) => {
      const id = execution?.id ?? executionId;
      if (!id) return;
      const runtimeExecution = execution && isRuntimeExecution(execution) ? execution : undefined;
      let durableExecution: RuntimeExecution | TurnExecutionRecord | null = runtimeExecution ?? null;
      if (!runtimeExecution) {
        try {
          durableExecution = getTurnExecution(id);
        } catch (error) {
          console.error("[agentic] durable execution cleanup lookup failed", error);
          durableExecution = null;
        }
      }
      if (durableExecution) {
        try {
          invalidateFrameCapabilitiesForTurn({
            userId: durableExecution.userId,
            chatId: durableExecution.chatId,
            turnId: durableExecution.id,
          });
        } catch (error) {
          console.error("[agentic] frame capability cleanup failed", error);
        }
      }
      const unregisterStop = stopRegistrations.get(id);
      stopRegistrations.delete(id);
      try {
        unregisterStop?.();
      } catch (error) {
        console.error("[agentic] stop registration cleanup failed", error);
      }
      const deferTerminalRecovery = terminalInspectionFailures.delete(id);
      const persistentAssociation = persistentAssociations.get(id);
      const cleanupOutcome: Exclude<PersistentWorkspaceTurnSession["outcome"], null> =
        status === "timed_out" || phase === "TIMED_OUT"
          ? "failed"
          : status === "exhausted" || phase === "EXHAUSTED"
            ? "exhausted"
            : status === "completed" || phase === "COMMITTED"
              ? "completed"
              : status === "cancelled" || phase === "CANCELLED"
                ? "stopped"
                : status === "rejected"
                  ? "rejected"
                  : "failed";
      if (persistentAssociation) {
        if (deferTerminalRecovery) {
          console.error("[agentic] persistent session cleanup deferred until terminal inspection recovery");
        } else {
          const terminal = persistentAssociation.session.phase === "TERMINAL"
            && persistentAssociation.session.status === "terminal"
            && persistentAssociation.session.outcome === cleanupOutcome;
          const terminalized = terminal || terminalizePersistentSession(id, cleanupOutcome);
          if (!terminalized) {
            console.error("[agentic] persistent session cleanup reconciliation failed");
            try {
              inspectionWriters.get(id)?.record("failure", {
                id: `cleanup:failure:${id}`,
                kind: "failure",
                actor: "host",
                recipient: "owner",
                errorReason: "needs_attention",
                correlation: { parentId: "root" },
              }, {
                lifecycle: "TERMINAL",
                status: "terminal",
                outcome: "failed",
                reason: "needs_attention",
              });
            } catch (error) {
              console.error("[agentic] persistent session cleanup inspection failed", error);
            }
          }
        }
        // A failed CAS must not retain process-local authority or fabricate
        // success by retrying after cleanup has released the execution.
        persistentAssociations.delete(id);
      }
      snapshots.delete(id);
      mediaMaterializers.delete(id);
      cognitionRuntimes.delete(id);
      plans.delete(id);
      works.delete(id);
      renderProjections.delete(id);
      renderBreakdowns.delete(id);
      renderFrames.delete(id);
      renders.delete(id);
      workUsages.delete(id);
      terminalUsages.delete(id);
      runtimeOwners.delete(id);
      caps.delete(id);
      inspectionWriters.delete(id);
      bindings.delete(id);
      childJoins.delete(id);
      rootSignals.delete(id);
      rootDeadlines.delete(id);
      const disposeDeadline = deadlineDisposers.get(id);
      deadlineDisposers.delete(id);
      try {
        disposeDeadline?.();
      } catch (error) {
        console.error("[agentic] deadline cleanup failed", error);
      }
      try {
        runtimeExecution?.owner.close();
      } catch (error) {
        console.error("[agentic] runtime owner cleanup failed", error);
      }
      try {
        runtimeExecution?.credentialCarrier.clear();
      } catch (error) {
        console.error("[agentic] credential cleanup failed", error);
      }
    },
  };
}

/** Install all concrete Agentic authorities before request routes are served. */
export function installAgenticGenerationCoordinator(): void {
  if (installed || installationMarker.get()) return;
  try {
    const recovery = reconcilePersistentWorkspaceSessions();
    if (!recovery.complete) {
      throw new Error("persistent session recovery incomplete");
    }
    // Publish the process marker only after every concrete authority is wired.
    // A bootstrap probe may have touched the default fail-closed decision
    // service, but it must not leave a half-installed coordinator behind.
    installDecisionAuthorities();
    const dependencies = buildDependencies();
    configureAgenticGenerationDependencies(dependencies);
    configureAgenticGenerationRuntimeDependencies(dependencies);
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
  makeWorkProvider,
  recordChildProviderExchange,
  createChildInspectionCorrelation,
  recordPublicWorkActivity,
  reconcilePersistentWorkspaceSessions,
  persistentRecoveryLimits: Object.freeze({
    pageSize: PERSISTENT_SESSION_RECOVERY_PAGE_SIZE,
    maxRows: PERSISTENT_SESSION_RECOVERY_MAX_ROWS,
    maxDurationMs: PERSISTENT_SESSION_RECOVERY_MAX_MS,
  }),
  makeWorkspace: (
    execution: AgenticExecutionHandle,
    capabilities: WorkspaceOperationCapabilitiesV1,
    cognitionRuntime?: WorkspaceCognitionRuntime,
  ) => makeWorkspace(
    requireRuntimeExecution(execution),
    capabilities,
    HOST_PREPARATION_LIMITS_V1.maxInputBytes,
    cognitionRuntime,
  ),
  mapRenderPhaseError,
  adoptWorkWorkspaceRevision,
  HOST_RENDER_FINAL_RESPONSE_CONTRACT,
  buildAgenticRenderPolicyMessages,
  recordRenderCrossings,
  makeRevisionReader,
  terminalInspectionReason,
  setPersistentRecoveryClock(clock?: (() => number) | null): void {
    persistentRecoveryClock = clock ?? Date.now;
  },
  resetInstallation(): void {
    installed = false;
    preflightSnapshots.clear();
    installationMarker.clear();
  },
};
