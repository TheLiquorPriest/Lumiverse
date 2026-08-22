import { createHash } from "node:crypto";
import {
  activateCognitionAtPoint,
  compareCognitionUtf8,
  completeCognitionFixedPoint,
  createCognitionActivationState,
  inspectLoomPromptPolicies,
  parseCognitionGraph,
  parseContextActivationRule,
  freezeCognitionGraph,
  parseCognitionEvaluationContext,
  parseCognitionSourceSnapshot,
} from "./agent-cognition.service";
import {
  AgentCognitionRuntimeError,
  COGNITION_RUNTIME_PHASES,
  type AgentCognitionRuntimeSourceV1,
  type AgentCognitionRuntimeV1,
  type AuthenticatedAgentCognitionSourceV1,
  type CognitionContextPackCandidateV1,
  type CognitionContextPackRequirementV1,
  type CognitionContextPackSelectionV1,
  type CognitionTaskIdentityV1,
  type CognitionRuntimeActivationV1,
  type CognitionRuntimeCompletionInputV1,
  type CognitionRuntimeCompletionV1,
  type CognitionRuntimePhaseInputV1,
  type CognitionRuntimePhaseV1,
  type CognitionRuntimePreparedAcceptanceV1,
  type CognitionRuntimeTaskTransitionInputV1,
  type CognitionWorkspaceActivationUpdateV1,
  type CognitionWorkspaceCompletionResultV1,
  type CognitionWorkspaceCompletionUpdateV1,
  type CognitionWorkspaceMutationResultV1,
  type CognitionWorkspacePhaseUpdateV1,
  type CreateAgentCognitionRuntimeInputV1,
} from "../types/agent-cognition-runtime";
import type {
  CognitionActivationResultV1,
  CognitionCompletionResultV1,
  CognitionActivationRootsV1,
  CognitionActivationStateV1,
  CognitionEvaluationContextV1,
  CognitionPhase,
  CognitionTaskTransition,
  FrozenCognitionGraphV1,
  CognitionLoomBlockRefV1,
  CognitionPolicyRefsV1,
  LoomPolicyBucketsV1,
  TaskTemplateV1,
} from "../types/agent-cognition";
import {
  acceptWorkspaceSubmissionWithCognition,
  activateWorkspaceCognitionAtPhase,
  createWorkspaceTaskWithCognition,
  freezeWorkspaceForCompletionWithCognition,
  previewWorkspaceCompletionWithCognition,
  submitWorkspaceChildResultWithCognition,
  updateWorkspaceTaskProgressWithCognition,
  type CognitionWorkspacePreparedAcceptanceV1,
} from "./turn-workspace.service";

const encoder = new TextEncoder();
const HEX = "0123456789abcdefABCDEF";
const EMPTY_POLICY: CognitionPolicyRefsV1 = Object.freeze({
  workPolicy: Object.freeze([]),
  workspaceUsage: Object.freeze([]),
  completionCriteria: Object.freeze([]),
  renderPolicy: Object.freeze([]),
});
const LOOM_POLICY_BUCKET_KEYS = ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"] as const;

function refsFromCanonicalLoomPolicy(value: unknown): CognitionPolicyRefsV1 {
  if (value === undefined || value === null) return EMPTY_POLICY;
  if (!isRecord(value)) failSource("config.runtimePolicy.loomPolicy", "expected a canonical Loom policy object");
  const result = {} as Record<(typeof LOOM_POLICY_BUCKET_KEYS)[number], CognitionLoomBlockRefV1[]>;
  for (const bucket of LOOM_POLICY_BUCKET_KEYS) {
    const rawEntries = value[bucket];
    if (!Array.isArray(rawEntries)) failSource(`config.runtimePolicy.loomPolicy.${bucket}`, "expected an array");
    result[bucket] = rawEntries.map((rawEntry, index): CognitionLoomBlockRefV1 => {
      const path = `config.runtimePolicy.loomPolicy.${bucket}[${index}]`;
      if (!isRecord(rawEntry) || !isRecord(rawEntry.source)) {
        failSource(path, "expected a Loom entry with source provenance");
      }
      const source = rawEntry.source;
      if (typeof source.blockId !== "string") {
        failSource(`${path}.source`, "invalid Loom block provenance");
      }
      const presetRevision = nonNegativeSafeInteger(source.presetRevision, `${path}.source.presetRevision`);
      const blockRevision = nonNegativeSafeInteger(source.blockRevision, `${path}.source.blockRevision`);
      return {
        blockId: source.blockId,
        expectedPresetRevision: presetRevision,
        expectedBlockRevision: blockRevision,
      };
    });
  }
  return {
    workPolicy: result.workPolicy,
    workspaceUsage: result.workspaceUsage,
    completionCriteria: result.completionCriteria,
    renderPolicy: result.renderPolicy,
  };
}
function cortexSnapshotFromSource(source: AgentCognitionRuntimeSourceV1): unknown {
  if (source.cortexSidecarSnapshot !== undefined) return source.cortexSidecarSnapshot;
  if (isRecord(source.config) && source.config.cortexSidecarSnapshot !== undefined) {
    return source.config.cortexSidecarSnapshot;
  }
  if (isRecord(source.source) && source.source.cortexSidecarSnapshot !== undefined) {
    return source.source.cortexSidecarSnapshot;
  }
  return undefined;
}



function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function failSource(path: string, message: string): never {
  throw new AgentCognitionRuntimeError("invalid_source", message, path);
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    failSource(path, "expected a non-negative safe integer");
  }
  return value;
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) failSource(path, "expected a non-empty string");
  if (bytes(value) > 4 * 1024) failSource(path, "string exceeds the cognition runtime limit");
  return value;
}

function digest(value: unknown, path: string): string {
  const result = text(value, path);
  if (result.length !== 64 || [...result].some((character) => !HEX.includes(character))) failSource(path, "expected a SHA-256 digest");
  return result.toLowerCase();
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) failSource(`${path}.${key}`, "unknown field");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach((entry) => deepFreeze(entry));
  else Object.values(value as Record<string, unknown>).forEach((entry) => deepFreeze(entry));
  return Object.freeze(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(String(value));
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function semanticWorkspacePayload(operation: CognitionRuntimeTaskTransitionInputV1["operation"], workspace: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const fields = operation === "create_task"
    ? ["title", "objective", "required", "dependencyIds", "assignedFrameId", "retention", "ttlSeconds"]
    : operation === "update_assigned_progress"
      ? ["state", "progress", "progressPercent"]
      : operation === "submit_child_result"
        ? ["summary", "resultDigest", "byteCount", "retention", "ttlSeconds"]
        : ["submissionId"];
  return Object.freeze(Object.fromEntries(fields.filter((field) => Object.hasOwn(workspace, field)).map((field) => [field, workspace[field]])));
}

function semanticCompletionPayload(workspace: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const fields = ["completionSummary", "completionUnresolvedIds", "completionRenderGuidance"];
  return Object.freeze(Object.fromEntries(fields.filter((field) => Object.hasOwn(workspace, field)).map((field) => [field, workspace[field]])));
}

/**
 * Cognition templates use authored IDs in the graph while the workspace CAS
 * stores a turn-scoped operational ID.  Keep the two identities explicit at
 * the runtime boundary; neither identity is inferred from the other outside
 * this authenticated graph/workspace pair.
 */
function operationalCognitionTaskId(workspace: Record<string, unknown>, authoredTaskId: string): string {
  return typeof workspace.turnId === "string" && workspace.turnId.length > 0
    ? `${workspace.turnId}:${authoredTaskId}`
    : authoredTaskId;
}

function cognitionTaskIdentity(
  graph: FrozenCognitionGraphV1,
  workspace: Record<string, unknown>,
  taskId: string,
): CognitionTaskIdentityV1 {
  const authored = graph.templates.find((template) => template.id === taskId);
  if (authored) {
    return Object.freeze({
      authoredTaskId: authored.id,
      operationalTaskId: operationalCognitionTaskId(workspace, authored.id),
    });
  }
  const operational = graph.templates.find((template) => operationalCognitionTaskId(workspace, template.id) === taskId);
  if (operational) {
    return Object.freeze({ authoredTaskId: operational.id, operationalTaskId: taskId });
  }
  return Object.freeze({ authoredTaskId: taskId, operationalTaskId: taskId });
}

function authoredTaskIdForOperational(
  graph: FrozenCognitionGraphV1,
  workspace: Record<string, unknown>,
  operationalTaskId: string,
): string {
  return graph.templates.find((template) => operationalCognitionTaskId(workspace, template.id) === operationalTaskId)?.id ?? operationalTaskId;
}

function publicMaterializedTaskIds(
  graph: FrozenCognitionGraphV1,
  workspace: Record<string, unknown>,
  operationalTaskIds: readonly string[],
): readonly string[] {
  return Object.freeze(operationalTaskIds.map((taskId) => authoredTaskIdForOperational(graph, workspace, taskId)));
}


function sourceDigest(
  graph: FrozenCognitionGraphV1,
  source: unknown,
  selections: readonly CognitionContextPackSelectionV1[],
  candidates: readonly CognitionContextPackCandidateV1[],
  roots: CognitionActivationRootsV1,
): string {
  return createHash("sha256").update(canonical({ graph, source, selections, candidates, roots }), "utf8").digest("hex");
}

function parseSelections(value: unknown): readonly CognitionContextPackSelectionV1[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) failSource("contextPackSelections", "expected an array");
  const seen = new Set<string>();
  const result: CognitionContextPackSelectionV1[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) failSource(`contextPackSelections[${index}]`, "expected an object");
    exactKeys(entry, ["packId", "revisionId", "revision", "digest", "required"], `contextPackSelections[${index}]`);
    const revision = entry.revision;
    if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) {
      failSource(`contextPackSelections[${index}].revision`, "expected a positive safe integer");
    }
    const packId = text(entry.packId, `contextPackSelections[${index}].packId`);
    const revisionId = text(entry.revisionId, `contextPackSelections[${index}].revisionId`);
    const selectionDigest = digest(entry.digest, `contextPackSelections[${index}].digest`);
    const required = entry.required === undefined ? true : entry.required;
    if (typeof required !== "boolean") failSource(`contextPackSelections[${index}].required`, "expected a boolean");
    const key = `${packId}\u0000${revisionId}`;
    if (seen.has(key)) failSource(`contextPackSelections[${index}]`, "duplicate pack revision");
    seen.add(key);
    result.push(Object.freeze({ packId, revisionId, digest: selectionDigest, required }));
  });
  result.sort((left, right) => compareCognitionUtf8(left.packId, right.packId) || compareCognitionUtf8(left.revisionId, right.revisionId));
  return Object.freeze(result);
}

function parseCandidates(value: unknown): readonly CognitionContextPackCandidateV1[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) failSource("contextPackCandidates", "expected an array");
  const sourceRank = { chat: 0, world_book: 1, preset: 2, account: 3 } as const;
  const byKey = new Map<string, CognitionContextPackCandidateV1>();
  value.forEach((entry, index) => {
    if (!isRecord(entry)) failSource(`contextPackCandidates[${index}]`, "expected an object");
    exactKeys(entry, ["packId", "revisionId", "digest", "source", "required"], `contextPackCandidates[${index}]`);
    const packId = text(entry.packId, `contextPackCandidates[${index}].packId`);
    const revisionId = text(entry.revisionId, `contextPackCandidates[${index}].revisionId`);
    const candidateDigest = digest(entry.digest, `contextPackCandidates[${index}].digest`);
    const source = entry.source === undefined ? "account" : entry.source;
    if (source !== "account" && source !== "preset" && source !== "chat" && source !== "world_book") failSource(`contextPackCandidates[${index}].source`, "invalid candidate source");
    const required = entry.required === undefined ? false : entry.required;
    if (typeof required !== "boolean") failSource(`contextPackCandidates[${index}].required`, "expected a boolean");
    const candidate = Object.freeze({ packId, revisionId, digest: candidateDigest, source, required });
    const key = `${packId}\u0000${revisionId}`;
    const prior = byKey.get(key);
    if (prior && prior.digest !== candidate.digest) failSource(`contextPackCandidates[${index}]`, "conflicting candidate digest");
    // The same authorized pack may appear as a chat attachment and a preset
    // selection. Matching digest is one candidate; keep the more specific source.
    const keep = !prior || sourceRank[candidate.source] < sourceRank[prior.source ?? "account"] ? candidate : prior;
    byKey.set(key, Object.freeze({ ...keep, required: Boolean(prior?.required || candidate.required) }));
  });
  return Object.freeze([...byKey.values()].sort((left, right) => compareCognitionUtf8(left.packId, right.packId) || compareCognitionUtf8(left.revisionId, right.revisionId)));
}

function phaseContext(base: CognitionEvaluationContextV1, phase: CognitionPhase, transitions: Readonly<Record<string, CognitionTaskTransition>>): CognitionEvaluationContextV1 {
  return parseCognitionEvaluationContext({ ...base, phase, taskTransitions: transitions });
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("cognition_transition_cancelled");
}

function phaseRefs(graph: FrozenCognitionGraphV1, phase: CognitionPhase): CognitionRuntimeActivationV1["promptBlocks"] {
  const refs = phase === "ASSEMBLE"
    ? [...graph.policies.workPolicy, ...graph.policies.workspaceUsage, ...graph.policies.completionCriteria, ...graph.policies.renderPolicy]
    : phase === "WORK"
      ? [...graph.policies.workPolicy, ...graph.policies.workspaceUsage, ...graph.policies.completionCriteria]
      : phase === "COMPLETE"
        ? [...graph.policies.completionCriteria]
        : phase === "RENDER"
          ? [...graph.policies.renderPolicy]
          : [];
  const seen = new Set<string>();
  const ordered = refs.filter((ref) => {
    if (seen.has(ref.blockId)) return false;
    seen.add(ref.blockId);
    return true;
  });
  return Object.freeze({ phase, refs: Object.freeze(ordered) });
}

function contextRequirementForRule(ruleId: string, graph: FrozenCognitionGraphV1, candidateByKey: ReadonlyMap<string, CognitionContextPackCandidateV1>, requiredContextRuleIds: ReadonlySet<string>): CognitionContextPackRequirementV1 {
  const rule = graph.contextRules.find((candidate) => candidate.id === ruleId);
  if (!rule) failSource(`contextRules.${ruleId}`, "activated rule is missing from the frozen graph");
  const candidate = candidateByKey.get(`${rule.packId}\u0000${rule.revisionId}`);
  return Object.freeze({ ruleId: rule.id, source: "rule", packId: rule.packId, revisionId: rule.revisionId, digest: candidate?.digest ?? null, required: rule.required || requiredContextRuleIds.has(rule.id) });
}

function contextRequirements(graph: FrozenCognitionGraphV1, state: CognitionActivationStateV1, selections: readonly CognitionContextPackSelectionV1[], candidateByKey: ReadonlyMap<string, CognitionContextPackCandidateV1>): readonly CognitionContextPackRequirementV1[] {
  const byKey = new Map<string, CognitionContextPackRequirementV1>();
  const add = (requirement: CognitionContextPackRequirementV1): void => {
    const key = `${requirement.packId}\u0000${requirement.revisionId}`;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, requirement);
      return;
    }
    if (prior.digest !== null && requirement.digest !== null && prior.digest !== requirement.digest) failSource(`contextRequirements.${requirement.packId}`, "conflicting candidate digest");
    const selected = prior.source === "rule"
      ? prior
      : requirement.source === "rule"
        ? requirement
        : prior.source === "direct"
          ? prior
          : requirement.source === "direct"
            ? requirement
            : prior;
    byKey.set(key, Object.freeze({
      ...selected,
      digest: selected.digest ?? prior.digest ?? requirement.digest,
      required: prior.required || requirement.required,
    }));
  };
  for (const selection of selections) {
    const candidate = candidateByKey.get(`${selection.packId}\u0000${selection.revisionId}`);
    add(Object.freeze({
      ruleId: null,
      source: "direct",
      packId: selection.packId,
      revisionId: selection.revisionId,
      digest: candidate?.digest ?? selection.digest ?? null,
      required: selection.required,
    }));
  }
  // Attachment candidates are exact host-authorized context and are active
  // immediately. Account candidates remain inactive until directly selected or
  // activated by an authored context rule at a named checkpoint.
  for (const candidate of candidateByKey.values()) {
    if (candidate.source === "account") continue;
    add(Object.freeze({
      ruleId: null,
      source: "attachment",
      packId: candidate.packId,
      revisionId: candidate.revisionId,
      digest: candidate.digest,
      required: candidate.required === true,
    }));
  }
  const requiredContextRuleIds = new Set(state.requiredContextRuleIds);
  for (const id of state.activatedContextRuleIds) add(contextRequirementForRule(id, graph, candidateByKey, requiredContextRuleIds));
  return Object.freeze([...byKey.values()].sort((left, right) => compareCognitionUtf8(left.packId, right.packId) || compareCognitionUtf8(left.revisionId, right.revisionId) || compareCognitionUtf8(left.ruleId ?? "", right.ruleId ?? "")));
}

function missingRequired(requirements: readonly CognitionContextPackRequirementV1[]): readonly CognitionContextPackRequirementV1[] {
  return Object.freeze(requirements.filter((requirement) => requirement.required && requirement.digest === null));
}

function assertRequiredContext(requirements: readonly CognitionContextPackRequirementV1[], phase: CognitionPhase): void {
  const missing = missingRequired(requirements);
  if (missing.length === 0) return;
  const first = missing[0];
  throw new AgentCognitionRuntimeError("context_required_unavailable", `required context pack ${first.packId}@${first.revisionId} is unavailable during ${phase}`, first.ruleId ?? first.packId);
}

function newlyActivatedRequirements(activation: CognitionActivationResultV1, graph: FrozenCognitionGraphV1, candidateByKey: ReadonlyMap<string, CognitionContextPackCandidateV1>): readonly CognitionContextPackRequirementV1[] {
  return Object.freeze(activation.newlyActivatedContextRuleIds.map((id) => contextRequirementForRule(id, graph, candidateByKey, new Set(activation.state.requiredContextRuleIds))));
}

function materializationTemplates(graph: FrozenCognitionGraphV1, ids: readonly string[]): readonly TaskTemplateV1[] {
  const wanted = new Set(ids);
  return Object.freeze(graph.templates.filter((template) => wanted.has(template.id)));
}
function phaseWorkspaceUpdate(
  state: CognitionActivationStateV1,
  activation: CognitionActivationResultV1,
  graph: FrozenCognitionGraphV1,
): CognitionWorkspacePhaseUpdateV1 {
  return Object.freeze({
    state: Object.freeze({ ...activation.state, workspaceRevision: state.workspaceRevision + 1 }),
    activation,
    materializeTemplates: materializationTemplates(graph, activation.newlyActivatedTemplateIds),
  });
}
const SUCCESS_COMPLETION_PHASES = Object.freeze(["RENDER", "PREPARE_COMMIT", "COMMITTING", "COMMITTED"] as const);

function appendedIds(after: readonly string[], before: readonly string[]): readonly string[] {
  const prior = new Set(before);
  return Object.freeze(after.filter((id) => !prior.has(id)));
}

interface CognitionCompletionClosureV1 {
  readonly activation: CognitionActivationResultV1;
  readonly completion: CognitionCompletionResultV1;
  readonly activationViews: readonly CognitionRuntimeActivationV1[];
  readonly materializeTemplates: readonly TaskTemplateV1[];
  readonly blockingRequiredTaskIds: readonly string[];
}

function completionActivationClosure(
  graph: FrozenCognitionGraphV1,
  state: CognitionActivationStateV1,
  baseEvaluation: CognitionEvaluationContextV1,
  transitions: Readonly<Record<string, CognitionTaskTransition>>,
  selections: readonly CognitionContextPackSelectionV1[],
  candidateByKey: ReadonlyMap<string, CognitionContextPackCandidateV1>,
  frozenSourceDigest: string,
  loomSource: AgentCognitionRuntimeSourceV1,
  roots: CognitionActivationRootsV1,
): CognitionCompletionClosureV1 {
  const startingTemplateIds = state.activatedTemplateIds;
  const startingContextRuleIds = state.activatedContextRuleIds;
  let current = completeCognitionFixedPoint(
    graph,
    state,
    phaseContext(baseEvaluation, "COMPLETE", transitions),
    roots,
  );
  const activationViews: CognitionRuntimeActivationV1[] = [
    runtimeActivation("COMPLETE", current.state, current, graph, selections, candidateByKey, frozenSourceDigest, loomSource, phaseContext(baseEvaluation, "COMPLETE", transitions)),
  ];
  let finalActivation: CognitionActivationResultV1 = current;
  for (const phase of SUCCESS_COMPLETION_PHASES) {
    const next = activateCognitionAtPoint(
      graph,
      current.state,
      phaseContext(baseEvaluation, phase, transitions),
      "phase_entry",
      roots,
    );
    current = {
      ...current,
      ...next,
      point: "completion_fixed_point",
      state: next.state,
      newlyActivatedTemplateIds: appendedIds(next.state.activatedTemplateIds, startingTemplateIds),
      newlyActivatedContextRuleIds: appendedIds(next.state.activatedContextRuleIds, startingContextRuleIds),
      newlyRequiredTemplateIds: appendedIds(next.state.requiredTemplateIds, state.requiredTemplateIds),
      newlyRequiredContextRuleIds: appendedIds(next.state.requiredContextRuleIds, state.requiredContextRuleIds),
    };
    finalActivation = current;
    activationViews.push(runtimeActivation(phase, next.state, next, graph, selections, candidateByKey, frozenSourceDigest, loomSource, phaseContext(baseEvaluation, phase, transitions)));
  }
  const blockingRequiredTaskIds = Object.freeze(
    finalActivation.state.requiredTemplateIds
      .filter((taskId) => transitions[taskId] !== "completed")
      .sort(compareCognitionUtf8),
  );
  const activation = Object.freeze({
    ...finalActivation,
    state: finalActivation.state,
    newlyActivatedTemplateIds: appendedIds(finalActivation.state.activatedTemplateIds, startingTemplateIds),
    newlyActivatedContextRuleIds: appendedIds(finalActivation.state.activatedContextRuleIds, startingContextRuleIds),
    newlyRequiredTemplateIds: appendedIds(finalActivation.state.requiredTemplateIds, state.requiredTemplateIds),
    newlyRequiredContextRuleIds: appendedIds(finalActivation.state.requiredContextRuleIds, state.requiredContextRuleIds),
  });
  const completion = Object.freeze({
    ...activation,
    fixedPointIterations: current.fixedPointIterations,
    blockingRequiredTaskIds,
    canComplete: blockingRequiredTaskIds.length === 0,
  });
  return Object.freeze({
    activation,
    completion,
    activationViews: Object.freeze(activationViews),
    materializeTemplates: materializationTemplates(graph, finalActivation.state.activatedTemplateIds.filter((id) => !startingTemplateIds.includes(id))),
    blockingRequiredTaskIds,
  });
}

function runtimeActivation(
  phase: CognitionRuntimePhaseV1 | "COMPLETE",
  state: CognitionActivationStateV1,
  activation: CognitionActivationResultV1,
  graph: FrozenCognitionGraphV1,
  selections: readonly CognitionContextPackSelectionV1[],
  candidateByKey: ReadonlyMap<string, CognitionContextPackCandidateV1>,
  frozenSourceDigest: string,
  loomSource?: AgentCognitionRuntimeSourceV1,
  evaluation?: CognitionEvaluationContextV1,
): CognitionRuntimeActivationV1 {
  const requirements = contextRequirements(graph, state, selections, candidateByKey);
  const policySurface = loomPolicySurface(phase, loomSource, evaluation);
  return Object.freeze({
    phase,
    state,
    activation,
    newlyActivatedContextPackRequirements: newlyActivatedRequirements(activation, graph, candidateByKey),
    contextPackRequirements: requirements,
    promptBlocks: phaseRefs(graph, phase),
    ...(policySurface === undefined ? {} : { policySurface }),
    sourceRevisions: graph.sourceRevisions,
    sourceDigest: frozenSourceDigest,
    workspaceRevision: state.workspaceRevision,
  });
}

function loomPolicySurface(
  phase: CognitionRuntimePhaseV1 | "COMPLETE",
  source: AgentCognitionRuntimeSourceV1 | undefined,
  evaluation: CognitionEvaluationContextV1 | undefined,
): CognitionRuntimeActivationV1["policySurface"] {
  if (!source?.loomPolicy) return undefined;
  const checkpoint = phase === "ASSEMBLE" || phase === "WORK" || phase === "RENDER"
    ? phase
    : "PREPARE_COMMIT";
  const inspection = inspectLoomPromptPolicies(source.loomPolicy, {
    checkpoint,
    surface: "WORK",
    blocks: source.loomBlocks ?? [],
    contextPacks: source.loomContextPacks ?? [],
    ...(evaluation === undefined ? {} : { evaluation }),
  });
  return Object.freeze({ policies: source.loomPolicy, promptInspection: inspection });
}

function assertWorkspaceRevision(workspace: Record<string, unknown>, expectedRevision: number): void {
  if (workspace.expectedRevision !== expectedRevision) {
    throw new AgentCognitionRuntimeError("workspace_cas_conflict", "workspace context is stale for cognition CAS");
  }
}

function graphFromAuthenticatedSource(source: AgentCognitionRuntimeSourceV1): AgentCognitionRuntimeSourceV1 {
  const cortexSidecarSnapshot = cortexSnapshotFromSource(source);
  const runtimePolicy = isRecord(source.config?.runtimePolicy) ? source.config.runtimePolicy : null;
  const loomPolicy = source.loomPolicy
    ?? (runtimePolicy && Object.hasOwn(runtimePolicy, "loomPolicy")
      ? runtimePolicy.loomPolicy as LoomPolicyBucketsV1
      : undefined);
  if (source.graph !== undefined) {
    return {
      graph: source.graph,
      source: source.source,
      contextPackSelections: source.contextPackSelections,
      contextPackCandidates: source.contextPackCandidates,
      contextRules: source.contextRules,
      taskTemplates: source.taskTemplates,
      taskTemplateIds: source.taskTemplateIds,
      ...(loomPolicy === undefined ? {} : { loomPolicy }),
      ...(source.loomBlocks === undefined ? {} : { loomBlocks: source.loomBlocks }),
      ...(source.loomContextPacks === undefined ? {} : { loomContextPacks: source.loomContextPacks }),
      ...(cortexSidecarSnapshot === undefined ? {} : { cortexSidecarSnapshot }),
    };
  }
  if (!source.config) failSource("config", "normalized config is required when graph is absent");
  return {
    graph: {
      version: 1,
      policies: refsFromCanonicalLoomPolicy(loomPolicy),
      templates: source.taskTemplates ?? [],
      contextRules: source.contextRules ?? [],
    },
    source: source.source,
    contextPackSelections: source.contextPackSelections,
    contextPackCandidates: source.contextPackCandidates,
    contextRules: source.contextRules,
    taskTemplates: source.taskTemplates,
    taskTemplateIds: source.taskTemplateIds,
    ...(loomPolicy === undefined ? {} : { loomPolicy }),
    ...(source.loomBlocks === undefined ? {} : { loomBlocks: source.loomBlocks }),
    ...(source.loomContextPacks === undefined ? {} : { loomContextPacks: source.loomContextPacks }),
    ...(cortexSidecarSnapshot === undefined ? {} : { cortexSidecarSnapshot }),
  };
}


function authoredGraphFromSnapshot(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const frozenKeys = ["sourceRevisions", "templateDependencyClosure", "contextDependencyClosure", "requiredTemplateClosure", "requiredContextClosure"] as const;
  if (!frozenKeys.every((key) => Object.hasOwn(value, key))) return value;
  return {
    version: value.version,
    policies: value.policies,
    templates: value.templates,
    contextRules: value.contextRules,
  };
}
function graphWithSelectedContextRules(graphValue: unknown, selectedContextRules: readonly unknown[] | undefined): unknown {
  const authored = authoredGraphFromSnapshot(graphValue);
  // Undefined preserves the authenticated graph's complete root set; an
  // explicit empty array is a closed coordinator selection that activates none.
  if (selectedContextRules === undefined) return authored;
  if (!Array.isArray(selectedContextRules)) failSource("contextRules", "expected an array");
  const parsedGraph = parseCognitionGraph(authored);
  const rulesById = new Map(parsedGraph.contextRules.map((rule) => [rule.id, rule] as const));
  const selectedIds = new Set<string>();
  const selectedRoots = new Set<string>();
  const includeClosure = (id: string, path: string): void => {
    if (selectedIds.has(id)) return;
    const rule = rulesById.get(id);
    if (!rule) failSource(path, `selected context rule ${id} is missing from the frozen graph`);
    selectedIds.add(id);
    for (const dependency of rule.dependencies ?? []) includeClosure(dependency, `${path}.dependencies`);
  };
  selectedContextRules.forEach((value, index) => {
    const selected = parseContextActivationRule(value);
    if (selectedRoots.has(selected.id)) failSource(`contextRules[${index}]`, `duplicate selected context rule ${selected.id}`);
    selectedRoots.add(selected.id);
    const sourceRule = rulesById.get(selected.id);
    if (!sourceRule) failSource(`contextRules[${index}]`, `selected context rule ${selected.id} is missing from the frozen graph`);
    if (JSON.stringify(selected) !== JSON.stringify(sourceRule)) {
      failSource(`contextRules[${index}]`, `selected context rule ${selected.id} differs from the frozen graph`);
    }
    includeClosure(selected.id, `contextRules[${index}]`);
  });
  const authoredObject = authored as Record<string, unknown>;
  return {
    ...authoredObject,
    contextRules: parsedGraph.contextRules.filter((rule) => selectedIds.has(rule.id)),
  };
}

function selectedContextRootIds(graphValue: unknown, selectedContextRules: readonly unknown[] | undefined): readonly string[] {
  const parsedGraph = parseCognitionGraph(authoredGraphFromSnapshot(graphValue));
  if (selectedContextRules === undefined) return Object.freeze(parsedGraph.contextRules.map((rule) => rule.id));
  return Object.freeze(selectedContextRules.map((value, index) => {
    try {
      return parseContextActivationRule(value).id;
    } catch {
      failSource(`contextRules[${index}]`, "selected context rule is invalid");
    }
  }));
}

function selectedTaskRootIds(graphValue: unknown, selectedTaskIds: readonly unknown[] | undefined): readonly string[] {
  const parsedGraph = parseCognitionGraph(authoredGraphFromSnapshot(graphValue));
  if (selectedTaskIds === undefined) return Object.freeze(parsedGraph.templates.map((template) => template.id));
  return Object.freeze(selectedTaskIds.map((value, index) => {
    if (typeof value !== "string" || value.length === 0) failSource(`taskTemplateIds[${index}]`, "expected a non-empty template ID");
    return value;
  }));
}
function graphWithSelectedTaskTemplates(graphValue: unknown, selectedTaskIds: readonly unknown[] | undefined): unknown {
  const authored = authoredGraphFromSnapshot(graphValue);
  // Undefined preserves all authenticated task roots; an explicit empty array
  // is the coordinator's closed "select none" task policy.
  if (selectedTaskIds === undefined) return authored;
  if (!Array.isArray(selectedTaskIds)) failSource("taskTemplateIds", "expected an array");
  const parsedGraph = parseCognitionGraph(authored);
  const templatesById = new Map(parsedGraph.templates.map((template) => [template.id, template] as const));
  const selectedIds = new Set<string>();
  const selectedRoots = new Set<string>();
  const includeClosure = (id: string, path: string): void => {
    if (selectedIds.has(id)) return;
    const template = templatesById.get(id);
    if (!template) failSource(path, `selected task template ${id} is missing from the frozen graph`);
    selectedIds.add(id);
    for (const dependency of template.dependencies ?? []) includeClosure(dependency, `${path}.dependencies`);
  };
  selectedTaskIds.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) failSource(`taskTemplateIds[${index}]`, "expected a non-empty template ID");
    if (selectedRoots.has(value)) failSource(`taskTemplateIds[${index}]`, `duplicate selected task template ${value}`);
    selectedRoots.add(value);
    if (!templatesById.has(value)) failSource(`taskTemplateIds[${index}]`, `selected task template ${value} is missing from the frozen graph`);
    includeClosure(value, `taskTemplateIds[${index}]`);
  });
  const authoredObject = authored as Record<string, unknown>;
  return {
    ...authoredObject,
    templates: parsedGraph.templates.filter((template) => selectedIds.has(template.id)),
  };
}


export function createAgentCognitionRuntime(input: CreateAgentCognitionRuntimeInputV1): AgentCognitionRuntimeV1 {
  const authenticatedSource = graphFromAuthenticatedSource(input.source);
  const contextRootIds = selectedContextRootIds(authenticatedSource.graph, authenticatedSource.contextRules);
  const contextFilteredGraph = graphWithSelectedContextRules(authenticatedSource.graph, authenticatedSource.contextRules);
  const taskRootIds = selectedTaskRootIds(contextFilteredGraph, authenticatedSource.taskTemplateIds);
  const graph = freezeCognitionGraph(graphWithSelectedTaskTemplates(contextFilteredGraph, authenticatedSource.taskTemplateIds), authenticatedSource.source);
  const activationRoots: CognitionActivationRootsV1 = deepFreeze({ templateIds: taskRootIds, contextRuleIds: contextRootIds });
  const frozenSource = deepFreeze(parseCognitionSourceSnapshot(authenticatedSource.source));
  const baseEvaluation = parseCognitionEvaluationContext(input.evaluation);
  const selections = parseSelections(authenticatedSource.contextPackSelections);
  const candidates = parseCandidates(authenticatedSource.contextPackCandidates);
  const candidateByKey = new Map(candidates.map((candidate) => [`${candidate.packId}\u0000${candidate.revisionId}`, candidate] as const));
  for (const selection of selections) {
    const candidate = candidateByKey.get(`${selection.packId}\u0000${selection.revisionId}`);
    if (candidate && candidate.digest !== selection.digest) throw new AgentCognitionRuntimeError("context_digest_mismatch", `context pack digest differs for ${selection.packId}@${selection.revisionId}`, selection.packId);
  }
  const frozenSourceDigest = sourceDigest(graph, frozenSource, selections, candidates, activationRoots);
  const initialRevision = input.workspaceRevision;
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) failSource("workspaceRevision", "expected a non-negative safe integer");
  const expectedRevision = input.workspace.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision !== initialRevision) {
    failSource("workspaceRevision", "runtime revision does not match the workspace CAS revision");
  }
  let state = createCognitionActivationState(graph, initialRevision);
  let currentPhase: CognitionRuntimePhaseV1 = "ASSEMBLE";
  const transitions: Record<string, CognitionTaskTransition> = Object.create(null);
  let completionAccepted = false;
  const operationResults = new Map<string, { fingerprint: string; result: CognitionWorkspaceMutationResultV1 }>();
  const completionResults = new Map<string, { fingerprint: string; result: CognitionRuntimeCompletionV1 }>();
  const initialCandidate = activateCognitionAtPoint(graph, state, phaseContext(baseEvaluation, "ASSEMBLE", transitions), "initial", activationRoots);
  const initialCandidateView = runtimeActivation("ASSEMBLE", initialCandidate.state, initialCandidate, graph, selections, candidateByKey, frozenSourceDigest, authenticatedSource, phaseContext(baseEvaluation, "ASSEMBLE", transitions));
  assertRequiredContext(initialCandidateView.contextPackRequirements, "ASSEMBLE");
  const committed = activateWorkspaceCognitionAtPhase(input.workspace, {
    state,
    update: (currentState): CognitionWorkspacePhaseUpdateV1 => phaseWorkspaceUpdate(currentState, initialCandidate, graph),
  });
  state = committed.state;
  const initialView = runtimeActivation("ASSEMBLE", state, committed.activation, graph, selections, candidateByKey, frozenSourceDigest, authenticatedSource, phaseContext(baseEvaluation, "ASSEMBLE", transitions));

  const runtime: AgentCognitionRuntimeV1 = {
    graph,
    activationRoots,
    source: deepFreeze({
      graph,
      source: frozenSource,
      contextPackSelections: selections,
      contextPackCandidates: candidates,
      ...(authenticatedSource.loomPolicy === undefined ? {} : { loomPolicy: authenticatedSource.loomPolicy }),
      ...(authenticatedSource.loomBlocks === undefined ? {} : { loomBlocks: authenticatedSource.loomBlocks }),
      ...(authenticatedSource.loomContextPacks === undefined ? {} : { loomContextPacks: authenticatedSource.loomContextPacks }),
      ...(authenticatedSource.cortexSidecarSnapshot === undefined
        ? {}
        : { cortexSidecarSnapshot: authenticatedSource.cortexSidecarSnapshot }),
    }),
    initialActivation: initialView,
    adoptWorkspaceMutationRevision(workspaceRevision: number): void {
      if (!Number.isSafeInteger(workspaceRevision) || workspaceRevision !== state.workspaceRevision + 1) {
        throw new AgentCognitionRuntimeError("workspace_cas_conflict", "non-cognition workspace mutation is not the next CAS revision");
      }
      if (completionAccepted) {
        throw new AgentCognitionRuntimeError("completion_blocked", "workspace cognition is frozen after completion");
      }
      state = Object.freeze({ ...state, workspaceRevision });
    },
    enterPhase(inputPhase: CognitionRuntimePhaseInputV1): CognitionRuntimeActivationV1 {
      assertWorkspaceRevision(inputPhase.workspace, state.workspaceRevision);
      const phaseEvaluation = phaseContext(baseEvaluation, inputPhase.phase, transitions);
      const candidate = activateCognitionAtPoint(graph, state, phaseEvaluation, "phase_entry", activationRoots);
      const candidateView = runtimeActivation(inputPhase.phase, candidate.state, candidate, graph, selections, candidateByKey, frozenSourceDigest, authenticatedSource, phaseEvaluation);
      assertRequiredContext(candidateView.contextPackRequirements, inputPhase.phase);
      if (completionAccepted) {
        if (
          candidate.newlyActivatedTemplateIds.length > 0
          || candidate.newlyActivatedContextRuleIds.length > 0
          || candidate.newlyRequiredTemplateIds.length > 0
          || candidate.newlyRequiredContextRuleIds.length > 0
        ) {
          throw new AgentCognitionRuntimeError("completion_blocked", `cognition activation is not frozen for ${inputPhase.phase}`);
        }
        currentPhase = inputPhase.phase;
        return candidateView;
      }
      const committed = activateWorkspaceCognitionAtPhase(inputPhase.workspace, {
        state,
        update: (currentState): CognitionWorkspacePhaseUpdateV1 => phaseWorkspaceUpdate(currentState, candidate, graph),
      });
      state = committed.state;
      const view = runtimeActivation(inputPhase.phase, state, committed.activation, graph, selections, candidateByKey, frozenSourceDigest, authenticatedSource, phaseEvaluation);
      currentPhase = inputPhase.phase;
      return view;
    },
    applyWorkspaceTransition(input: CognitionRuntimeTaskTransitionInputV1): CognitionWorkspaceMutationResultV1 {
      throwIfAborted(input.signal);
      const identity = cognitionTaskIdentity(graph, input.workspace, input.taskId);
      const operationKey = input.operationKey;
      const transition: CognitionTaskTransition = input.operation === "create_task"
        ? "pending"
        : input.operation === "submit_child_result" || input.operation === "accept_submission"
          ? "completed"
          : input.workspace.state === "pending"
            ? "pending"
            : input.workspace.state === "active"
              ? "active"
              : input.workspace.state === "blocked"
                ? "blocked"
                : input.workspace.state === "cancelled"
                  ? "cancelled"
                  : input.workspace.state === "failed"
                    ? "failed"
                    : (() => { throw new AgentCognitionRuntimeError("invalid_source", "workspace progress state is invalid"); })();
      if (input.transition !== transition) {
        throw new AgentCognitionRuntimeError("invalid_source", "workspace transition does not match the authenticated operation");
      }
      const fingerprint = canonical({ operation: input.operation, taskId: identity.authoredTaskId, transition, payload: semanticWorkspacePayload(input.operation, input.workspace) });
      if (operationKey) {
        const previous = operationResults.get(operationKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new AgentCognitionRuntimeError("idempotency_conflict", "operation key was reused for a different transition", operationKey);
          return previous.result;
        }
      }
      if (completionAccepted) {
        throw new AgentCognitionRuntimeError("completion_blocked", "workspace cognition is frozen after completion");
      }
      assertWorkspaceRevision(input.workspace, state.workspaceRevision);
      if (input.operation === "create_task" && graph.templates.some((template) => template.id === identity.authoredTaskId)) {
        throw new AgentCognitionRuntimeError("invalid_source", "workspace task identifier is reserved by frozen cognition templates", input.taskId);
      }
      const nextTransitions = { ...transitions, [identity.authoredTaskId]: transition };
      const preflightActivation = activateCognitionAtPoint(graph, state, phaseContext(baseEvaluation, currentPhase, nextTransitions), "task_transition", activationRoots);
      const preflightView = runtimeActivation(currentPhase, preflightActivation.state, preflightActivation, graph, selections, candidateByKey, frozenSourceDigest, authenticatedSource, phaseContext(baseEvaluation, currentPhase, nextTransitions));
      assertRequiredContext(preflightView.contextPackRequirements, currentPhase);
      let computed: CognitionWorkspaceActivationUpdateV1 | undefined;
      const update = (current: CognitionActivationStateV1): CognitionWorkspaceActivationUpdateV1 => {
        if (current.workspaceRevision !== state.workspaceRevision) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "cognition state is stale for workspace CAS");
        const activation = activateCognitionAtPoint(graph, current, phaseContext(baseEvaluation, currentPhase, nextTransitions), "task_transition", activationRoots);
        computed = {
          taskId: identity.operationalTaskId,
          transition,
          ...(operationKey ? { operationKey } : {}),
          state: Object.freeze({ ...activation.state, workspaceRevision: current.workspaceRevision + 1 }),
          activation,
          materializeTemplates: materializationTemplates(graph, activation.newlyActivatedTemplateIds),
        };
        return computed;
      };
      const workspace = input.operation === "accept_submission"
        ? (() => {
          const normalized = { ...input.workspace };
          delete normalized.taskId;
          return normalized;
        })()
        : { ...input.workspace, taskId: identity.operationalTaskId };
      const workspaceResult = input.operation === "create_task"
        ? createWorkspaceTaskWithCognition(workspace, { state, update })
        : input.operation === "update_assigned_progress"
          ? updateWorkspaceTaskProgressWithCognition(workspace, { state, update })
          : input.operation === "submit_child_result"
            ? submitWorkspaceChildResultWithCognition(workspace, { state, update })
            : acceptWorkspaceSubmissionWithCognition(workspace, { state, update });
      const evaluated = computed;
      if (!evaluated) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "workspace CAS did not evaluate cognition");
      const cognition = runtimeActivation(currentPhase, workspaceResult.state, workspaceResult.activation, graph, selections, candidateByKey, frozenSourceDigest, authenticatedSource, phaseContext(baseEvaluation, currentPhase, nextTransitions));
      const result = deepFreeze({
        workspaceRevision: workspaceResult.workspaceRevision,
        state: workspaceResult.state,
        activation: workspaceResult.activation,
        materializedTaskIds: publicMaterializedTaskIds(graph, input.workspace, workspaceResult.materializedTaskIds),
        taskId: evaluated.taskId,
        transition: evaluated.transition,
        cognition,
        ...(operationKey ? { operationKey } : {}),
      });
      state = result.state;
      transitions[identity.authoredTaskId] = transition;
      if (operationKey) operationResults.set(operationKey, { fingerprint, result });
      return result;
    },
    async acceptCompletionFixedPoint(input: CognitionRuntimeCompletionInputV1): Promise<CognitionRuntimeCompletionV1> {
      throwIfAborted(input.signal);
      const operationKey = input.operationKey;
      const fingerprint = canonical({ operation: "completion_fixed_point", payload: semanticCompletionPayload(input.workspace) });
      if (operationKey) {
        const previous = completionResults.get(operationKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new AgentCognitionRuntimeError("idempotency_conflict", "completion operation key was reused for a different workspace", operationKey);
          return previous.result;
        }
      }
      if (completionAccepted) {
        throw new AgentCognitionRuntimeError("completion_blocked", "completion fixed point is already accepted");
      }
      assertWorkspaceRevision(input.workspace, state.workspaceRevision);
      let computed: CognitionWorkspaceCompletionUpdateV1 | undefined;
      let closure: CognitionCompletionClosureV1 | undefined;
      const workspace = { ...input.workspace };
      delete workspace.completionSummary;
      delete workspace.completionUnresolvedIds;
      delete workspace.completionRenderGuidance;
      const update = (current: CognitionActivationStateV1): CognitionWorkspaceCompletionUpdateV1 => {
        if (current.workspaceRevision !== state.workspaceRevision) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "cognition state is stale for completion CAS");
        const activationClosure = completionActivationClosure(graph, current, baseEvaluation, transitions, selections, candidateByKey, frozenSourceDigest, authenticatedSource, activationRoots);
        closure = activationClosure;
        const requirements = contextRequirements(graph, activationClosure.activation.state, selections, candidateByKey);
        const contextBlockers = missingRequired(requirements);
        const completionUpdate: CognitionWorkspaceCompletionUpdateV1 = {
          state: Object.freeze({ ...activationClosure.activation.state, workspaceRevision: current.workspaceRevision + 1 }),
          activation: activationClosure.activation,
          accepted: contextBlockers.length === 0 && activationClosure.completion.canComplete,
          blockingRequiredTaskIds: activationClosure.blockingRequiredTaskIds,
          blockingContextRequirements: contextBlockers,
          materializeTemplates: activationClosure.materializeTemplates,
        };
        computed = completionUpdate;
        return completionUpdate;
      };
      const makeRuntimeCompletion = (
        workspaceResult: CognitionWorkspaceCompletionResultV1,
        evaluated: CognitionWorkspaceCompletionUpdateV1,
        evaluatedClosure: CognitionCompletionClosureV1,
      ): CognitionRuntimeCompletionV1 => {
        const finalActivation = Object.freeze({ ...workspaceResult.activation, state: workspaceResult.state });
        const requirements = contextRequirements(graph, workspaceResult.state, selections, candidateByKey);
        const operationalBlockingRequiredTaskIds = [...new Set(
          workspaceResult.blockingRequiredTaskIds.map((id) => authoredTaskIdForOperational(graph, workspace, id)),
        )];
        const blockers = [
          ...operationalBlockingRequiredTaskIds.map((id) => ({ kind: "task" as const, id })),
          ...evaluated.blockingRequiredTaskIds
            .filter((id) => !operationalBlockingRequiredTaskIds.includes(id))
            .map((id) => ({ kind: "task" as const, id })),
          ...missingRequired(requirements).map((requirement) => ({ kind: "context" as const, id: requirement.ruleId ?? requirement.packId, packId: requirement.packId, revisionId: requirement.revisionId })),
        ];
        return deepFreeze({
          ...runtimeActivation("COMPLETE", workspaceResult.state, finalActivation, graph, selections, candidateByKey, frozenSourceDigest, authenticatedSource, phaseContext(baseEvaluation, "PREPARE_COMMIT", transitions)),
          accepted: workspaceResult.accepted && blockers.length === 0,
          blockers,
          blockingRequiredTaskIds: Object.freeze(blockers.filter((blocker) => blocker.kind === "task").map((blocker) => blocker.id)),
          materializedTaskIds: publicMaterializedTaskIds(graph, workspace, workspaceResult.materializedTaskIds),
          preCommitActivations: Object.freeze([...evaluatedClosure.activationViews]),
        });
      };

      // The read-only planner provides fail-fast feedback without mutating the
      // workspace. Accepted handoff preparation is deferred to the transaction
      // so it observes the exact post-materialization candidate.
      const provisionalPreview = previewWorkspaceCompletionWithCognition(workspace, { state, update });
      const provisionalWorkspaceResult = provisionalPreview.candidate;
      const provisionalUpdate = computed;
      if (!provisionalUpdate) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "completion fixed point was not evaluated");
      const provisionalClosure = closure;
      if (!provisionalClosure) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "completion fixed point was not evaluated");
      const provisionalResult = makeRuntimeCompletion(provisionalWorkspaceResult, provisionalUpdate, provisionalClosure);
      const preparedWorkspace = input.prepareAcceptance && provisionalResult.accepted
        ? {
          prepare: (workspaceResult: CognitionWorkspaceCompletionResultV1) => {
            const evaluated = computed;
            const evaluatedClosure = closure;
            if (!evaluated || !evaluatedClosure) {
              throw new AgentCognitionRuntimeError("workspace_cas_conflict", "completion fixed point was not evaluated");
            }
            const transactionResult = makeRuntimeCompletion(workspaceResult, evaluated, evaluatedClosure);
            let prepared: CognitionRuntimePreparedAcceptanceV1;
            try {
              prepared = input.prepareAcceptance!(transactionResult);
            } catch (error) {
              if (error instanceof AgentCognitionRuntimeError) throw error;
              throw new AgentCognitionRuntimeError("completion_blocked", "completion handoff preparation failed");
            }
            if (isThenable(prepared) || !prepared || canonical(prepared.candidate) !== canonical(transactionResult)) {
              throw new AgentCognitionRuntimeError("completion_blocked", "completion handoff preparation did not match the fixed point");
            }
            if (input.validatePreparedAcceptance && !input.validatePreparedAcceptance(prepared, transactionResult)) {
              throw new AgentCognitionRuntimeError("completion_blocked", "completion handoff preparation was not acknowledged");
            }
            return {
              candidate: workspaceResult,
              bundle: prepared.bundle,
            };
          },
        } satisfies CognitionWorkspacePreparedAcceptanceV1
        : undefined;
      const workspaceResult = freezeWorkspaceForCompletionWithCognition(
        workspace,
        { state, update },
        preparedWorkspace,
      );
      const evaluated = computed;
      const evaluatedClosure = closure;
      if (!evaluated || !evaluatedClosure) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "workspace CAS did not evaluate completion cognition");
      const completion = makeRuntimeCompletion(workspaceResult, evaluated, evaluatedClosure);
      const result = workspaceResult.preparedAcceptance
        ? deepFreeze({
          ...completion,
          preparedAcceptance: {
            candidate: completion,
            bundle: workspaceResult.preparedAcceptance.bundle,
          },
        })
        : completion;
      state = workspaceResult.state;
      currentPhase = "WORK";
      completionAccepted = result.accepted;
      if (operationKey) completionResults.set(operationKey, { fingerprint, result });
      return result;
    },
  };
  return runtime;
}
/** Return the authenticated, immutable Cortex input carried by this runtime, if any. */
export function cognitionRuntimeCortexSnapshot(runtime: AgentCognitionRuntimeV1): unknown | undefined {
  return cortexSnapshotFromSource(runtime.source);
}


export function createAgentCognitionRuntimeFromAuthenticatedSource(
  source: AuthenticatedAgentCognitionSourceV1,
  evaluation: CognitionEvaluationContextV1,
  workspaceRevision: number,
  workspace: Record<string, unknown>,
): AgentCognitionRuntimeV1 {
  return createAgentCognitionRuntime({ source: graphFromAuthenticatedSource(source), evaluation, workspaceRevision, workspace });
}
