import type {
  AgentCustomPhaseV1,
  AgentRuntimePhaseCapabilityV1,
} from "../types/agents";
import {
  AGENT_RUNTIME_MAX_CUSTOM_PHASES,
  AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS,
  AGENT_RUNTIME_PHASE_CAPABILITIES,
} from "../types/agents";
import type {
  CognitionEvaluationContextV1,
  CognitionPredicateV1,
  CognitionSourceSnapshotV1,
  LoomPolicySourceV1,
} from "../types/agent-cognition";
import {
  evaluateCognitionPredicate,
  parseCognitionPredicate,
} from "./agent-cognition.service";

/** Host result for compiling preset-authored custom WORK phases. */
export type AgentRuntimePhaseCompileStatusV1 = "ready" | "repair_required" | "failed";

export type AgentRuntimePhaseCompileIssueCodeV1 =
  | "invalid_phase"
  | "invalid_predicate"
  | "invalid_source"
  | "stale_source"
  | "duplicate_phase_id"
  | "unknown_phase"
  | "invalid_transition"
  | "optional_phase_omitted"
  | "required_phase_unavailable";

export interface AgentRuntimePhaseCompileIssueV1 {
  readonly code: AgentRuntimePhaseCompileIssueCodeV1;
  readonly phaseId: string;
  readonly phaseIndex: number;
  readonly required: boolean;
  readonly detail: string;
  readonly source: "authoring" | "revision" | "transition";
}

export interface AgentRuntimePhaseSourceIdentityV1 {
  readonly blockId: string;
  readonly presetRevision: number;
  readonly blockRevision: number;
  readonly promptOrder: number;
}

/** A phase after host validation, retaining the exact authored source refs. */
export interface CompiledAgentRuntimePhaseV1 extends AgentCustomPhaseV1 {
  readonly index: number;
  readonly sourceStatus: "verified" | "unverified";
  readonly sourceIdentity: readonly AgentRuntimePhaseSourceIdentityV1[];
}

export interface AgentRuntimePhaseCompileResultV1 {
  readonly status: AgentRuntimePhaseCompileStatusV1;
  readonly phases: readonly CompiledAgentRuntimePhaseV1[];
  readonly issues: readonly AgentRuntimePhaseCompileIssueV1[];
  readonly omittedPhaseIds: readonly string[];
}

export interface CompileAgentRuntimePhasesOptionsV1 {
  /** Frozen source snapshot captured at admission. Omit only for source-independent tests. */
  readonly source?: CognitionSourceSnapshotV1 | null;
}

/**
 * Intersect authored phase requests with grants already admitted by the host.
 * This function never broadens the host grant and preserves authored order.
 */
export function intersectAgentRuntimePhaseCapabilities(
  requested: readonly AgentRuntimePhaseCapabilityV1[],
  admitted: readonly AgentRuntimePhaseCapabilityV1[],
): readonly AgentRuntimePhaseCapabilityV1[] {
  const admittedSet = new Set<string>();
  for (const capability of admitted) {
    if ((AGENT_RUNTIME_PHASE_CAPABILITIES as readonly string[]).includes(capability)) {
      admittedSet.add(capability);
    }
  }
  const result: AgentRuntimePhaseCapabilityV1[] = [];
  const seen = new Set<string>();
  for (const capability of requested) {
    if (
      (AGENT_RUNTIME_PHASE_CAPABILITIES as readonly string[]).includes(capability)
      && admittedSet.has(capability)
      && !seen.has(capability)
    ) {
      seen.add(capability);
      result.push(capability);
    }
  }
  return Object.freeze(result);
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCapability(value: unknown): value is AgentRuntimePhaseCapabilityV1 {
  return typeof value === "string"
    && (AGENT_RUNTIME_PHASE_CAPABILITIES as readonly string[]).includes(value);
}

function sourceIdentity(ref: LoomPolicySourceV1): AgentRuntimePhaseSourceIdentityV1 {
  return {
    blockId: ref.blockId,
    presetRevision: ref.presetRevision,
    blockRevision: ref.blockRevision,
    promptOrder: ref.promptOrder,
  };
}

function issue(
  code: AgentRuntimePhaseCompileIssueCodeV1,
  phase: Partial<AgentCustomPhaseV1>,
  phaseIndex: number,
  detail: string,
  source: AgentRuntimePhaseCompileIssueV1["source"],
): AgentRuntimePhaseCompileIssueV1 {
  return {
    code,
    phaseId: typeof phase.id === "string" ? phase.id : `phase-${phaseIndex}`,
    phaseIndex,
    required: phase.required === true,
    detail,
    source,
  };
}

function validateSourceRefs(
  phase: AgentCustomPhaseV1,
  phaseIndex: number,
  source: CognitionSourceSnapshotV1 | null | undefined,
): AgentRuntimePhaseCompileIssueV1 | null {
  const refs = phase.instructionRefs;
  if (!Array.isArray(refs)) {
    return issue("invalid_source", phase, phaseIndex, "instructionRefs must be an array", "authoring");
  }
  if (refs.length > AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS) {
    return issue("invalid_source", phase, phaseIndex, `instructionRefs must contain at most ${AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS} entries`, "authoring");
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (
      !ref || ref.kind !== "loom_block" || typeof ref.blockId !== "string" || ref.blockId.length === 0
      || !isSafeRevision(ref.presetRevision) || !isSafeRevision(ref.blockRevision)
      || !isSafeRevision(ref.promptOrder) || seen.has(ref.blockId)
    ) {
      return issue("invalid_source", phase, phaseIndex, "instructionRefs contains an invalid or duplicate source", "authoring");
    }
    seen.add(ref.blockId);
    if (source === undefined || source === null) continue;
    if (ref.presetRevision !== source.presetRevision) {
      return issue("stale_source", phase, phaseIndex, `source preset revision ${ref.presetRevision} is not ${source.presetRevision}`, "revision");
    }
    const block = source.blocks.find((candidate) => candidate.blockId === ref.blockId);
    if (!block || block.revision !== ref.blockRevision || block.promptOrder !== ref.promptOrder) {
      return issue("stale_source", phase, phaseIndex, `source block ${ref.blockId} revision or order is stale`, "revision");
    }
  }
  return null;
}

function parsePhasePredicate(
  predicate: CognitionPredicateV1,
  phase: AgentCustomPhaseV1,
  phaseIndex: number,
  field: "enter" | "exit" | "skip",
): { readonly predicate: CognitionPredicateV1 } | { readonly issue: AgentRuntimePhaseCompileIssueV1 } {
  try {
    return { predicate: parseCognitionPredicate(predicate) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : `${field} predicate is invalid`;
    return { issue: issue("invalid_predicate", phase, phaseIndex, `${field}: ${detail}`, "authoring") };
  }
}

/**
 * Compile the ordered custom phase array. Optional malformed/stale phases are
 * omitted with a visible repair issue; malformed/stale required phases fail
 * closed. This does not mutate or invent any authored phase or transition.
 */
export function compileAgentRuntimePhases(
  phases: readonly AgentCustomPhaseV1[],
  options: CompileAgentRuntimePhasesOptionsV1 = {},
): AgentRuntimePhaseCompileResultV1 {
  if (!Array.isArray(phases) || phases.length > AGENT_RUNTIME_MAX_CUSTOM_PHASES) {
    const limitIssue: AgentRuntimePhaseCompileIssueV1 = {
      ...issue(
        "invalid_phase",
        {},
        -1,
        `phase array must contain at most ${AGENT_RUNTIME_MAX_CUSTOM_PHASES} phases`,
        "authoring",
      ),
      required: true,
    };
    return Object.freeze({
      status: "failed",
      phases: Object.freeze([]),
      issues: Object.freeze([limitIssue]),
      omittedPhaseIds: Object.freeze([]),
    });
  }
  const issues: AgentRuntimePhaseCompileIssueV1[] = [];
  const omittedPhaseIds: string[] = [];
  const phaseIds = new Set<string>();
  const candidates: Array<{ phase: AgentCustomPhaseV1; index: number }> = [];

  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    if (!phase || typeof phase !== "object") {
      issues.push(issue("invalid_phase", {}, index, "phase must be an object", "authoring"));
      continue;
    }
    if (typeof phase.id !== "string" || phase.id.length === 0 || phaseIds.has(phase.id)) {
      const duplicate = typeof phase.id === "string" && phaseIds.has(phase.id);
      issues.push(issue(duplicate ? "duplicate_phase_id" : "invalid_phase", phase, index, duplicate ? "phase id is duplicated" : "phase id is invalid", "authoring"));
      if (phase.required === true) omittedPhaseIds.push(phase.id ?? `phase-${index}`);
      continue;
    }
    phaseIds.add(phase.id);
    candidates.push({ phase, index });
  }

  const validCandidates: Array<{ phase: AgentCustomPhaseV1; index: number; sourceStatus: "verified" | "unverified" }> = [];
  for (const candidate of candidates) {
    const { phase, index } = candidate;
    let phaseIssue: AgentRuntimePhaseCompileIssueV1 | null = null;
    if (
      phase.version !== 1
      || typeof phase.label !== "string"
      || phase.label.length === 0
      || typeof phase.required !== "boolean"
      || !Array.isArray(phase.nextPhaseIds)
      || phase.nextPhaseIds.some((nextId) => typeof nextId !== "string" || nextId.length === 0)
    ) {
      phaseIssue = issue("invalid_phase", phase, index, "phase version, label, required flag, or transitions are invalid", "authoring");
    } else if (!Number.isSafeInteger(phase.repeatLimit) || phase.repeatLimit < 0 || phase.repeatLimit > 4) {
      phaseIssue = issue("invalid_phase", phase, index, "repeatLimit must be an integer from 0 through 4", "authoring");
    } else {
      phaseIssue = validateSourceRefs(phase, index, options.source);
      if (phaseIssue === null) {
        const enter = parsePhasePredicate(phase.enter, phase, index, "enter");
        const exit = parsePhasePredicate(phase.exit, phase, index, "exit");
        const skip = phase.skip === undefined ? null : parsePhasePredicate(phase.skip, phase, index, "skip");
        if ("issue" in enter) phaseIssue = enter.issue;
        else if ("issue" in exit) phaseIssue = exit.issue;
        else if (skip !== null && "issue" in skip) phaseIssue = skip.issue;
        else if (!Array.isArray(phase.capabilityRequests) || phase.capabilityRequests.some((capability) => !isCapability(capability))) {
          phaseIssue = issue("invalid_phase", phase, index, "capabilityRequests must contain only closed capabilities", "authoring");
        }
      }
    }
    if (phaseIssue !== null) {
      issues.push(phaseIssue);
      if (phase.required) omittedPhaseIds.push(phase.id);
      else issues.push({ ...phaseIssue, code: "optional_phase_omitted", required: false });
      continue;
    }
    validCandidates.push({
      ...candidate,
      sourceStatus: options.source === undefined || options.source === null ? "unverified" : "verified",
    });
  }

  const validIds = new Set(validCandidates.map(({ phase }) => phase.id));
  const compiled: CompiledAgentRuntimePhaseV1[] = [];
  for (const candidate of validCandidates) {
    const { phase, index } = candidate;
    let transitionIssue: AgentRuntimePhaseCompileIssueV1 | null = null;
    for (const nextId of phase.nextPhaseIds) {
      const isSelf = nextId === phase.id;
      const isImmediateNext = nextId === phases[index + 1]?.id;
      if (!validIds.has(nextId)) {
        transitionIssue = issue("unknown_phase", phase, index, `transition references unavailable phase ${nextId}`, "transition");
        break;
      }
      if (!isSelf && !isImmediateNext) {
        transitionIssue = issue("invalid_transition", phase, index, "transitions may target only itself or the immediate next phase", "transition");
        break;
      }
      if (isSelf && phase.repeatLimit === 0) {
        transitionIssue = issue("invalid_transition", phase, index, "self transitions require a positive repeatLimit", "transition");
        break;
      }
    }
    if (transitionIssue !== null) {
      issues.push(transitionIssue);
      if (phase.required) omittedPhaseIds.push(phase.id);
      else issues.push({ ...transitionIssue, code: "optional_phase_omitted", required: false });
      continue;
    }
    const parsedEnter = parseCognitionPredicate(phase.enter);
    const parsedExit = parseCognitionPredicate(phase.exit);
    const parsedSkip = phase.skip === undefined ? undefined : parseCognitionPredicate(phase.skip);
    const normalized: CompiledAgentRuntimePhaseV1 = {
      ...phase,
      enter: parsedEnter,
      exit: parsedExit,
      ...(parsedSkip === undefined ? {} : { skip: parsedSkip }),
      instructionRefs: Object.freeze(phase.instructionRefs.map((ref) => ({ ...ref }))),
      capabilityRequests: Object.freeze([...phase.capabilityRequests]),
      nextPhaseIds: Object.freeze([...phase.nextPhaseIds]),
      index: compiled.length,
      sourceStatus: candidate.sourceStatus,
      sourceIdentity: Object.freeze(phase.instructionRefs.map(sourceIdentity)),
    };
    compiled.push(Object.freeze(normalized));
  }

  const hasRequiredIssue = issues.some((entry) => entry.required && entry.code !== "optional_phase_omitted");
  const status: AgentRuntimePhaseCompileStatusV1 = hasRequiredIssue
    ? "failed"
    : issues.length > 0
      ? "repair_required"
      : "ready";
  return Object.freeze({
    status,
    phases: Object.freeze(compiled),
    issues: Object.freeze(issues),
    omittedPhaseIds: Object.freeze([...new Set(omittedPhaseIds)]),
  });
}

export type AgentRuntimePhaseMachineStatusV1 =
  | "ready"
  | "entered"
  | "completed"
  | "blocked"
  | "failed";

export type AgentRuntimePhaseDecisionStatusV1 =
  | "entered"
  | "skipped"
  | "repeated"
  | "advanced"
  | "completed"
  | "blocked"
  | "failed"
  | "noop";

export type AgentRuntimePhaseConditionResultV1 = "true" | "false" | "invalid" | "omitted";
export type AgentRuntimePhaseCheckpointV1 = "entry" | "exit" | "skip";

export interface AgentRuntimePhaseMachineStateV1 {
  readonly status: AgentRuntimePhaseMachineStatusV1;
  readonly phaseIndex: number | null;
  readonly phaseId: string | null;
  readonly repeatCount: number;
  readonly checkpointRevision: number | null;
  readonly nextPhaseId: string | null;
}

export interface AgentRuntimePhaseDecisionV1 {
  readonly status: AgentRuntimePhaseDecisionStatusV1;
  readonly action: AgentRuntimePhaseDecisionStatusV1;
  readonly phaseId: string | null;
  readonly phaseIndex: number | null;
  readonly checkpoint: AgentRuntimePhaseCheckpointV1;
  readonly revision: number;
  readonly condition: AgentRuntimePhaseConditionResultV1;
  readonly required: boolean;
  readonly repeatCount: number;
  readonly requestedCapabilities: readonly AgentRuntimePhaseCapabilityV1[];
  readonly admittedCapabilities: readonly AgentRuntimePhaseCapabilityV1[];
  readonly reason: string | null;
}

export interface AgentRuntimePhaseInspectionEvidenceV1 {
  readonly version: 1;
  readonly kind: "phase_condition";
  readonly phaseId: string;
  readonly phaseIndex: number;
  readonly phaseLabel: string;
  readonly checkpoint: AgentRuntimePhaseCheckpointV1;
  readonly revision: number;
  readonly condition: AgentRuntimePhaseConditionResultV1;
  readonly required: boolean;
  readonly repeatCount: number;
  readonly status: AgentRuntimePhaseDecisionStatusV1;
  readonly reason: string | null;
  readonly sourceStatus: "verified" | "unverified";
  readonly sourceIdentity: readonly AgentRuntimePhaseSourceIdentityV1[];
  readonly requestedCapabilities: readonly AgentRuntimePhaseCapabilityV1[];
  readonly admittedCapabilities: readonly AgentRuntimePhaseCapabilityV1[];
}

export interface AgentRuntimePhaseCheckpointInputV1 {
  readonly revision: number;
  readonly context: CognitionEvaluationContextV1;
  /** False means the host could not provide a canonical immutable snapshot. */
  readonly snapshotAvailable?: boolean;
}

export interface AgentRuntimePhaseMachineOptionsV1 {
  readonly admittedCapabilities?: readonly AgentRuntimePhaseCapabilityV1[];
}

export interface AgentRuntimePhaseMachineV1 {
  readonly phases: readonly CompiledAgentRuntimePhaseV1[];
  state(): AgentRuntimePhaseMachineStateV1;
  capabilities(): readonly AgentRuntimePhaseCapabilityV1[];
  currentPhase(): CompiledAgentRuntimePhaseV1 | null;
  enter(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1;
  /** Evaluate an exit without changing state or recording evidence. */
  previewExit(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1;
  exit(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1;
  evidence(): readonly AgentRuntimePhaseInspectionEvidenceV1[];
}

interface PredicateCacheEntry {
  readonly revision: number;
  readonly result: AgentRuntimePhaseConditionResultV1;
}

function normalizeAdmittedCapabilities(
  capabilities: readonly AgentRuntimePhaseCapabilityV1[] | undefined,
): readonly AgentRuntimePhaseCapabilityV1[] {
  const result: AgentRuntimePhaseCapabilityV1[] = [];
  const seen = new Set<string>();
  for (const capability of capabilities ?? []) {
    if (isCapability(capability) && !seen.has(capability)) {
      seen.add(capability);
      result.push(capability);
    }
  }
  return Object.freeze(result);
}

function checkpointKey(index: number, checkpoint: AgentRuntimePhaseCheckpointV1): string {
  return `${index}:${checkpoint}`;
}

class AgentRuntimePhaseMachine implements AgentRuntimePhaseMachineV1 {
  readonly phases: readonly CompiledAgentRuntimePhaseV1[];
  private readonly admitted: readonly AgentRuntimePhaseCapabilityV1[];
  private currentIndex = 0;
  private status: AgentRuntimePhaseMachineStatusV1;
  private repeatCount = 0;
  private checkpointRevision: number | null = null;
  private readonly cache = new Map<string, PredicateCacheEntry>();
  private readonly inspection: AgentRuntimePhaseInspectionEvidenceV1[] = [];

  constructor(
    phases: readonly CompiledAgentRuntimePhaseV1[],
    options: AgentRuntimePhaseMachineOptionsV1,
  ) {
    this.phases = Object.freeze([...phases]);
    this.admitted = normalizeAdmittedCapabilities(options.admittedCapabilities);
    this.status = this.phases.length === 0 ? "completed" : "ready";
  }

  state(): AgentRuntimePhaseMachineStateV1 {
    const phase = this.phases[this.currentIndex] ?? null;
    const next = phase === null ? null : this.phases[this.currentIndex + 1]?.id ?? null;
    return Object.freeze({
      status: this.status,
      phaseIndex: phase === null ? null : this.currentIndex,
      phaseId: phase?.id ?? null,
      repeatCount: this.repeatCount,
      checkpointRevision: this.checkpointRevision,
      nextPhaseId: next,
    });
  }

  capabilities(): readonly AgentRuntimePhaseCapabilityV1[] {
    const phase = this.phases[this.currentIndex];
    return phase === undefined
      ? Object.freeze([])
      : intersectAgentRuntimePhaseCapabilities(phase.capabilityRequests, this.admitted);
  }

  currentPhase(): CompiledAgentRuntimePhaseV1 | null {
    return this.phases[this.currentIndex] ?? null;
  }

  evidence(): readonly AgentRuntimePhaseInspectionEvidenceV1[] {
    return Object.freeze(this.inspection.map((entry) => ({
      ...entry,
      sourceIdentity: Object.freeze(entry.sourceIdentity.map((source) => ({ ...source }))),
      requestedCapabilities: Object.freeze([...entry.requestedCapabilities]),
      admittedCapabilities: Object.freeze([...entry.admittedCapabilities]),
    })));
  }
  previewExit(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1 {
    const snapshot = this.snapshot();
    try {
      return this.exit(input);
    } finally {
      this.restore(snapshot);
    }
  }

  enter(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1 {
    const phase = this.phases[this.currentIndex];
    if (phase === undefined || this.status === "completed" || this.status === "failed" || this.status === "blocked") {
      return this.decision("noop", "omitted", input, null, "phase machine is terminal", "entry");
    }
    if (this.status === "entered" && this.checkpointRevision === input.revision) {
      return this.decision("noop", "omitted", input, phase, "entry checkpoint already evaluated", "entry");
    }
    this.checkpointRevision = input.revision;

    if (phase.skip !== undefined) {
      const skip = this.evaluate(phase, "skip", input);
      if (skip === "true") {
        const decision = this.decision("skipped", skip, input, phase, "phase skipped by authored condition", "skip");
        this.record(decision, phase);
        return this.advanceAfter(decision, phase, input);
      }
      if (skip === "false") {
        this.record(this.decision("noop", skip, input, phase, "optional skip predicate was false", "skip"), phase);
      } else if (skip === "invalid") {
        this.record(this.decision("noop", skip, input, phase, "optional skip predicate omitted", "skip"), phase);
      }
    }

    const entered = this.evaluate(phase, "entry", input);
    if (entered === "invalid") {
      if (phase.required) {
        const decision = this.decision("failed", entered, input, phase, "required phase failed closed", "entry");
        this.status = "failed";
        this.record(decision, phase);
        return decision;
      }
      const decision = this.decision("skipped", entered, input, phase, "optional phase omitted", "entry");
      this.record(decision, phase);
      return this.advanceAfter(decision, phase, input);
    }
    if (entered === "false") {
      if (phase.required) {
        const decision = this.decision("blocked", entered, input, phase, "required phase condition not met", "entry");
        this.status = "blocked";
        this.record(decision, phase);
        return decision;
      }
      const decision = this.decision("skipped", entered, input, phase, "optional phase skipped", "entry");
      this.record(decision, phase);
      return this.advanceAfter(decision, phase, input);
    }

    this.status = "entered";
    const decision = this.decision("entered", entered, input, phase, null, "entry");
    this.record(decision, phase);
    return decision;
  }

  exit(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1 {
    const phase = this.phases[this.currentIndex];
    if (phase === undefined || this.status !== "entered") {
      return this.decision("noop", "omitted", input, phase ?? null, "phase is not entered", "exit");
    }
    this.checkpointRevision = input.revision;
    const exited = this.evaluate(phase, "exit", input);
    if (exited === "invalid") {
      if (phase.required) {
        const decision = this.decision("failed", exited, input, phase, "required phase failed closed", "exit");
        this.status = "failed";
        this.record(decision, phase);
        return decision;
      }
      const decision = this.decision("skipped", exited, input, phase, "optional phase omitted", "exit");
      this.record(decision, phase);
      return this.advanceAfter(decision, phase, input);
    }
    if (exited === "false") {
      if (this.repeatCount < phase.repeatLimit) {
        if (phase.nextPhaseIds.length > 0 && !phase.nextPhaseIds.includes(phase.id)) {
          const decision = this.decision("failed", exited, input, phase, "phase cannot repeat", "exit");
          this.status = phase.required ? "failed" : "blocked";
          this.record(decision, phase);
          return decision;
        }
        this.repeatCount += 1;
        this.status = "ready";
        const decision = this.decision("repeated", exited, input, phase, "phase repeats within authored limit", "exit");
        this.record(decision, phase);
        return decision;
      }
      if (phase.required) {
        const decision = this.decision("failed", exited, input, phase, "required phase failed closed at repeat limit", "exit");
        this.status = "failed";
        this.record(decision, phase);
        return decision;
      }
      const decision = this.decision("skipped", exited, input, phase, "optional phase omitted at repeat limit", "exit");
      this.record(decision, phase);
      return this.advanceAfter(decision, phase, input);
    }

    const decision = this.decision("advanced", exited, input, phase, null, "exit");
    this.record(decision, phase);
    return this.advanceAfter(decision, phase, input);
  }
  private snapshot(): {
    readonly currentIndex: number;
    readonly status: AgentRuntimePhaseMachineStatusV1;
    readonly repeatCount: number;
    readonly checkpointRevision: number | null;
    readonly cache: ReadonlyMap<string, PredicateCacheEntry>;
    readonly inspectionLength: number;
  } {
    return {
      currentIndex: this.currentIndex,
      status: this.status,
      repeatCount: this.repeatCount,
      checkpointRevision: this.checkpointRevision,
      cache: new Map(this.cache),
      inspectionLength: this.inspection.length,
    };
  }

  private restore(snapshot: {
    readonly currentIndex: number;
    readonly status: AgentRuntimePhaseMachineStatusV1;
    readonly repeatCount: number;
    readonly checkpointRevision: number | null;
    readonly cache: ReadonlyMap<string, PredicateCacheEntry>;
    readonly inspectionLength: number;
  }): void {
    this.currentIndex = snapshot.currentIndex;
    this.status = snapshot.status;
    this.repeatCount = snapshot.repeatCount;
    this.checkpointRevision = snapshot.checkpointRevision;
    this.cache.clear();
    for (const [key, entry] of snapshot.cache) this.cache.set(key, entry);
    this.inspection.length = snapshot.inspectionLength;
  }

  private evaluate(
    phase: CompiledAgentRuntimePhaseV1,
    checkpoint: AgentRuntimePhaseCheckpointV1,
    input: AgentRuntimePhaseCheckpointInputV1,
  ): AgentRuntimePhaseConditionResultV1 {
    const key = checkpointKey(phase.index, checkpoint);
    const cached = this.cache.get(key);
    if (cached?.revision === input.revision) return cached.result;
    if (input.snapshotAvailable === false) {
      const unavailable: AgentRuntimePhaseConditionResultV1 = "invalid";
      this.cache.set(key, { revision: input.revision, result: unavailable });
      return unavailable;
    }
    const predicate = checkpoint === "entry" ? phase.enter : checkpoint === "exit" ? phase.exit : phase.skip;
    let result: AgentRuntimePhaseConditionResultV1;
    try {
      result = evaluateCognitionPredicate(predicate, input.context) ? "true" : "false";
    } catch {
      result = "invalid";
    }
    this.cache.set(key, { revision: input.revision, result });
    return result;
  }

  private advanceAfter(
    decision: AgentRuntimePhaseDecisionV1,
    phase: CompiledAgentRuntimePhaseV1,
    input: AgentRuntimePhaseCheckpointInputV1,
  ): AgentRuntimePhaseDecisionV1 {
    const next = this.phases[this.currentIndex + 1];
    if (next === undefined) {
      this.status = "completed";
      const completed = this.decision("completed", decision.condition, input, phase, "phase sequence completed", decision.checkpoint);
      this.record(completed, phase);
      return completed;
    }
    if (phase.nextPhaseIds.length > 0 && !phase.nextPhaseIds.includes(next.id)) {
      const failed = this.decision("failed", decision.condition, input, phase, "host refused an arbitrary phase transition", decision.checkpoint);
      this.status = phase.required ? "failed" : "blocked";
      this.record(failed, phase);
      return failed;
    }
    this.currentIndex += 1;
    this.repeatCount = 0;
    this.status = "ready";
    const advanced = this.decision("advanced", decision.condition, input, phase, `advanced to ${next.id}`, decision.checkpoint);
    this.record(advanced, phase);
    return advanced;
  }

  private decision(
    status: AgentRuntimePhaseDecisionStatusV1,
    condition: AgentRuntimePhaseConditionResultV1,
    input: AgentRuntimePhaseCheckpointInputV1,
    phase: CompiledAgentRuntimePhaseV1 | null,
    reason: string | null,
    checkpoint: AgentRuntimePhaseCheckpointV1,
  ): AgentRuntimePhaseDecisionV1 {
    const requested = phase?.capabilityRequests ?? [];
    const admitted = phase === null ? [] : intersectAgentRuntimePhaseCapabilities(requested, this.admitted);
    return Object.freeze({
      status,
      action: status,
      phaseId: phase?.id ?? null,
      phaseIndex: phase?.index ?? null,
      checkpoint,
      revision: input.revision,
      condition,
      required: phase?.required === true,
      repeatCount: this.repeatCount,
      requestedCapabilities: Object.freeze([...requested]),
      admittedCapabilities: admitted,
      reason,
    });
  }

  private record(decision: AgentRuntimePhaseDecisionV1, phase: CompiledAgentRuntimePhaseV1): void {
    this.inspection.push(Object.freeze({
      version: 1,
      kind: "phase_condition",
      phaseId: phase.id,
      phaseIndex: phase.index,
      phaseLabel: phase.label,
      checkpoint: decision.checkpoint,
      revision: decision.revision,
      condition: decision.condition,
      required: phase.required,
      repeatCount: decision.repeatCount,
      status: decision.status,
      reason: decision.reason,
      sourceStatus: phase.sourceStatus,
      sourceIdentity: Object.freeze(phase.sourceIdentity.map((source) => ({ ...source }))),
      requestedCapabilities: Object.freeze([...phase.capabilityRequests]),
      admittedCapabilities: intersectAgentRuntimePhaseCapabilities(phase.capabilityRequests, this.admitted),
    }));
  }
}

export function createAgentRuntimePhaseMachine(
  phases: readonly CompiledAgentRuntimePhaseV1[] | AgentRuntimePhaseCompileResultV1,
  options: AgentRuntimePhaseMachineOptionsV1 = {},
): AgentRuntimePhaseMachineV1 {
  const compiled = "phases" in phases ? phases.phases : phases;
  return new AgentRuntimePhaseMachine(compiled, options);
}
