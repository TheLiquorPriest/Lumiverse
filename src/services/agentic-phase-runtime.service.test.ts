import { describe, expect, test } from "bun:test";
import type {
  AgentCustomPhaseV1,
  AgentRuntimePhaseCapabilityV1,
} from "../types/agents";
import type {
  CognitionEvaluationContextV1,
  CognitionSourceSnapshotV1,
  LoomPolicySourceV1,
} from "../types/agent-cognition";
import {
  compileAgentRuntimePhases,
  createAgentRuntimePhaseMachine,
  intersectAgentRuntimePhaseCapabilities,
} from "./agentic-phase-runtime.service";

function sourceRef(
  blockId: string,
  blockRevision = 1,
  promptOrder = 0,
  presetRevision = 7,
): LoomPolicySourceV1 {
  return {
    kind: "loom_block",
    blockId,
    presetRevision,
    blockRevision,
    promptOrder,
  };
}

function sourceSnapshot(...refs: readonly LoomPolicySourceV1[]): CognitionSourceSnapshotV1 {
  return {
    presetRevision: 7,
    blocks: refs.map((ref) => ({
      blockId: ref.blockId,
      revision: ref.blockRevision,
      promptOrder: ref.promptOrder,
    })),
  };
}

function phase(overrides: Partial<AgentCustomPhaseV1> = {}): AgentCustomPhaseV1 {
  return {
    version: 1,
    id: "draft",
    label: "Draft",
    instructionRefs: [sourceRef("draft-instructions")],
    required: true,
    enter: { kind: "phase", value: "WORK" },
    exit: { kind: "phase", value: "WORK" },
    capabilityRequests: ["core_retrieval", "workspace_read"],
    repeatLimit: 0,
    nextPhaseIds: [],
    ...overrides,
  };
}

function context(
  overrides: Partial<CognitionEvaluationContextV1> = {},
): CognitionEvaluationContextV1 {
  return {
    generationType: "normal",
    phase: "WORK",
    presetVariables: {},
    participantFacts: {},
    availableTools: [],
    taskTransitions: {},
    ...overrides,
  };
}

function compile(
  phases: readonly AgentCustomPhaseV1[],
  refs: readonly LoomPolicySourceV1[],
) {
  return compileAgentRuntimePhases(phases, { source: sourceSnapshot(...refs) });
}

describe("canonical custom Phased Instructions compiler", () => {
  test("keeps ordered source identities exact and never substitutes stale revisions", () => {
    const firstRefs = [
      sourceRef("later", 4, 3),
      sourceRef("earlier", 2, 1),
    ] as const;
    const secondRef = sourceRef("second", 1, 4);
    const result = compile([
      phase({ id: "first", label: "First", instructionRefs: firstRefs, nextPhaseIds: ["second"] }),
      phase({ id: "second", label: "Second", instructionRefs: [secondRef] }),
    ], [...firstRefs, secondRef]);

    expect(result.status).toBe("ready");
    expect(result.phases.map((item) => item.id)).toEqual(["first", "second"]);
    expect(result.phases.map((item) => item.index)).toEqual([0, 1]);
    expect(result.phases[0]?.sourceStatus).toBe("verified");
    expect(result.phases[0]?.sourceIdentity).toEqual([
      { blockId: "later", presetRevision: 7, blockRevision: 4, promptOrder: 3 },
      { blockId: "earlier", presetRevision: 7, blockRevision: 2, promptOrder: 1 },
    ]);

    const stale = compile([
      phase({ instructionRefs: [sourceRef("draft-instructions", 2)] }),
    ], [sourceRef("draft-instructions", 1)]);
    expect(stale.status).toBe("failed");
    expect(stale.phases).toEqual([]);
    expect(stale.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "stale_source", required: true, source: "revision" }),
    ]));
  });

  test("repairs optional stale phases but fails closed for malformed required phases", () => {
    const optional = compile([
      phase({
        id: "optional",
        required: false,
        instructionRefs: [sourceRef("optional", 2)],
      }),
    ], [sourceRef("optional", 1)]);
    expect(optional.status).toBe("repair_required");
    expect(optional.phases).toEqual([]);
    expect(optional.omittedPhaseIds).toEqual([]);
    expect(optional.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "stale_source", required: false }),
      expect.objectContaining({ code: "optional_phase_omitted", required: false }),
    ]));

    const requiredPredicate = compile([
      phase({ enter: { kind: "script", source: "return true" } as never }),
    ], [sourceRef("draft-instructions")]);
    expect(requiredPredicate.status).toBe("failed");
    expect(requiredPredicate.phases).toEqual([]);
    expect(requiredPredicate.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_predicate", required: true }),
    ]));

    const optionalPredicate = compile([
      phase({
        id: "optional-predicate",
        required: false,
        enter: { kind: "script", source: "return true" } as never,
      }),
    ], [sourceRef("draft-instructions")]);
    expect(optionalPredicate.status).toBe("repair_required");
    expect(optionalPredicate.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_predicate", required: false }),
      expect.objectContaining({ code: "optional_phase_omitted", required: false }),
    ]));
  });

  test("revalidates duplicate IDs, closed capabilities, and arbitrary transitions", () => {
    const duplicate = compile([
      phase({ id: "same" }),
      phase({ id: "same", instructionRefs: [sourceRef("same-2")] }),
    ], [sourceRef("draft-instructions"), sourceRef("same-2")]);
    expect(duplicate.status).toBe("failed");
    expect(duplicate.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_phase_id", required: true }),
    ]));

    const closedCapability = compile([
      phase({ capabilityRequests: ["not-a-capability"] as unknown as AgentRuntimePhaseCapabilityV1[] }),
    ], [sourceRef("draft-instructions")]);
    expect(closedCapability.status).toBe("failed");
    expect(closedCapability.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_phase", required: true }),
    ]));

    const arbitraryJump = compile([
      phase({ id: "one", nextPhaseIds: ["three"], instructionRefs: [sourceRef("one")] }),
      phase({ id: "two", instructionRefs: [sourceRef("two")] }),
      phase({ id: "three", instructionRefs: [sourceRef("three")] }),
    ], [sourceRef("one"), sourceRef("two"), sourceRef("three")]);
    expect(arbitraryJump.status).toBe("failed");
    expect(arbitraryJump.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_transition", phaseId: "one", source: "transition" }),
    ]));
  });
});

describe("canonical custom Phased Instructions machine", () => {
  test("narrows every phase request to already-admitted capabilities", () => {
    expect(intersectAgentRuntimePhaseCapabilities(
      ["core_retrieval", "workspace_write", "cortex"],
      ["core_retrieval", "delegation"],
    )).toEqual(["core_retrieval"]);

    const compiled = compile([
      phase({ capabilityRequests: ["core_retrieval", "workspace_write"] }),
    ], [sourceRef("draft-instructions")]);
    const machine = createAgentRuntimePhaseMachine(compiled, {
      admittedCapabilities: ["core_retrieval", "delegation"],
    });
    expect(machine.capabilities()).toEqual(["core_retrieval"]);

    const decision = machine.enter({ revision: 1, context: context() });
    expect(decision.status).toBe("entered");
    expect(decision.requestedCapabilities).toEqual(["core_retrieval", "workspace_write"]);
    expect(decision.admittedCapabilities).toEqual(["core_retrieval"]);
    expect(machine.evidence()[0]).toMatchObject({
      requestedCapabilities: ["core_retrieval", "workspace_write"],
      admittedCapabilities: ["core_retrieval"],
      sourceStatus: "verified",
    });
  });

  test("evaluates only at entry/exit checkpoints and keeps results sticky per revision", () => {
    const compiled = compile([
      phase({
        enter: { kind: "preset_variable", name: "gate", operator: "equals", value: "open" },
        exit: { kind: "preset_variable", name: "gate", operator: "equals", value: "open" },
        repeatLimit: 1,
        nextPhaseIds: ["draft"],
      }),
    ], [sourceRef("draft-instructions")]);
    const machine = createAgentRuntimePhaseMachine(compiled);

    expect(machine.enter({
      revision: 1,
      context: context({ presetVariables: { gate: "open" } }),
    })).toMatchObject({ status: "entered", condition: "true", checkpoint: "entry" });

    const sameRevision = machine.enter({
      revision: 1,
      context: context({ presetVariables: { gate: "closed" } }),
    });
    expect(sameRevision).toMatchObject({ status: "noop", condition: "omitted" });
    expect(machine.state()).toMatchObject({ status: "entered", repeatCount: 0 });

    expect(machine.exit({
      revision: 1,
      context: context({ presetVariables: { gate: "closed" } }),
    })).toMatchObject({ status: "repeated", condition: "false", checkpoint: "exit" });
    expect(machine.state()).toMatchObject({ status: "ready", repeatCount: 1 });

    const cachedEntry = machine.enter({
      revision: 1,
      context: context({ presetVariables: { gate: "closed" } }),
    });
    expect(cachedEntry).toMatchObject({ status: "entered", condition: "true" });

    const newRevision = machine.enter({
      revision: 2,
      context: context({ presetVariables: { gate: "closed" } }),
    });
    expect(newRevision).toMatchObject({ status: "blocked", condition: "false", checkpoint: "entry" });
    expect(machine.state()).toMatchObject({ status: "blocked", phaseId: "draft" });
  });

  test("enforces the current-phase repeat cap and completes only by ordered advancement", () => {
    const repeatable = compile([
      phase({
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "preset_variable", name: "done", operator: "equals", value: true },
        repeatLimit: 1,
        nextPhaseIds: ["draft"],
      }),
    ], [sourceRef("draft-instructions")]);
    const machine = createAgentRuntimePhaseMachine(repeatable);
    machine.enter({ revision: 1, context: context() });
    expect(machine.exit({ revision: 1, context: context() })).toMatchObject({ status: "repeated" });
    machine.enter({ revision: 2, context: context() });
    expect(machine.exit({ revision: 2, context: context() })).toMatchObject({
      status: "failed",
      condition: "false",
      reason: expect.stringMatching(/repeat/i),
    });
    expect(machine.state().status).toBe("failed");

    const ordered = compile([
      phase({ id: "one", nextPhaseIds: ["two"], instructionRefs: [sourceRef("one")] }),
      phase({ id: "two", instructionRefs: [sourceRef("two")] }),
    ], [sourceRef("one"), sourceRef("two")]);
    const orderedMachine = createAgentRuntimePhaseMachine(ordered);
    expect(orderedMachine.enter({ revision: 1, context: context() }).status).toBe("entered");
    expect(orderedMachine.exit({ revision: 1, context: context() })).toMatchObject({ status: "advanced", phaseId: "one" });
    expect(orderedMachine.state()).toMatchObject({ status: "ready", phaseId: "two", phaseIndex: 1 });
    expect(orderedMachine.enter({ revision: 2, context: context() }).status).toBe("entered");
    expect(orderedMachine.exit({ revision: 2, context: context() })).toMatchObject({ status: "completed", phaseId: "two" });
    expect(orderedMachine.state().status).toBe("completed");
  });

  test("keeps an unsatisfied exit entered when the next phase is not a self-loop", () => {
    const compiled = compile([
      phase({
        id: "exercise",
        exit: { kind: "task_transition", taskId: "evidence", transition: "completed" },
        repeatLimit: 2,
        nextPhaseIds: ["collaborate"],
        instructionRefs: [sourceRef("exercise")],
      }),
      phase({
        id: "collaborate",
        instructionRefs: [sourceRef("collaborate")],
      }),
    ], [sourceRef("exercise"), sourceRef("collaborate")]);
    const machine = createAgentRuntimePhaseMachine(compiled);
    expect(machine.enter({ revision: 1, context: context() }).status).toBe("entered");
    expect(machine.exit({
      revision: 1,
      context: context({ taskTransitions: { evidence: "active" } }),
    })).toMatchObject({
      status: "blocked",
      condition: "false",
      reason: "exit condition not met",
      phaseId: "exercise",
    });
    expect(machine.state()).toMatchObject({ status: "entered", phaseId: "exercise", repeatCount: 0 });
    expect(machine.exit({
      revision: 2,
      context: context({ taskTransitions: { evidence: "completed" } }),
    })).toMatchObject({ status: "advanced", phaseId: "exercise" });
    expect(machine.state()).toMatchObject({ status: "ready", phaseId: "collaborate" });
  });

  test("fails a required exit closed when the host snapshot is absent", () => {
    const compiled = compile([
      phase({
        id: "exercise",
        nextPhaseIds: ["collaborate"],
        instructionRefs: [sourceRef("exercise")],
      }),
      phase({ id: "collaborate", instructionRefs: [sourceRef("collaborate")] }),
    ], [sourceRef("exercise"), sourceRef("collaborate")]);
    const machine = createAgentRuntimePhaseMachine(compiled);
    expect(machine.enter({ revision: 1, context: context() }).status).toBe("entered");
    expect(machine.exit({
      revision: 2,
      snapshotAvailable: false,
      context: context(),
    })).toMatchObject({
      status: "failed",
      condition: "invalid",
      reason: expect.stringMatching(/failed closed/i),
    });
    expect(machine.state().status).toBe("failed");
  });

  test("fails closed when exit would take an illegal phase advance", () => {
    const compiled = compile([
      phase({
        id: "one",
        nextPhaseIds: ["missing"],
        instructionRefs: [sourceRef("one")],
      }),
      phase({ id: "two", instructionRefs: [sourceRef("two")] }),
    ], [sourceRef("one"), sourceRef("two")]);
    const machine = createAgentRuntimePhaseMachine(compiled);
    expect(machine.enter({ revision: 1, context: context() }).status).toBe("entered");
    expect(machine.exit({ revision: 1, context: context() })).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/arbitrary phase transition/i),
    });
    expect(machine.state().status).toBe("failed");
  });



  test("fails required invalid evaluation closed and keeps optional false skips visible", () => {
    const required = compile([
      phase({ id: "required", instructionRefs: [sourceRef("required")] }),
    ], [sourceRef("required")]);
    const requiredMachine = createAgentRuntimePhaseMachine(required);
    const invalidContext = context({ phase: "NOT_A_PHASE" as never });
    expect(requiredMachine.enter({ revision: 1, context: invalidContext })).toMatchObject({
      status: "failed",
      condition: "invalid",
      reason: expect.stringMatching(/failed closed/i),
    });

    const optional = compile([
      phase({
        id: "optional",
        required: false,
        skip: { kind: "preset_variable", name: "skip", operator: "equals", value: true },
        instructionRefs: [sourceRef("optional")],
      }),
    ], [sourceRef("optional")]);
    const optionalMachine = createAgentRuntimePhaseMachine(optional);
    expect(optionalMachine.enter({
      revision: 1,
      context: context({ presetVariables: { skip: false } }),
    })).toMatchObject({ status: "entered", condition: "true" });
    expect(optionalMachine.evidence()).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkpoint: "skip", condition: "false" }),
    ]));
  });

  test("fails closed when the host snapshot is absent and keeps that result sticky", () => {
    const required = compile([
      phase({ id: "required", instructionRefs: [sourceRef("required")] }),
    ], [sourceRef("required")]);
    const requiredMachine = createAgentRuntimePhaseMachine(required);
    expect(requiredMachine.enter({
      revision: 1,
      snapshotAvailable: false,
      context: context(),
    })).toMatchObject({
      status: "failed",
      condition: "invalid",
      reason: expect.stringMatching(/failed closed/i),
    });
    expect(requiredMachine.enter({
      revision: 1,
      context: context(),
    })).toMatchObject({ status: "noop", condition: "omitted" });
    expect(requiredMachine.state().status).toBe("failed");

    const optional = compile([
      phase({
        id: "optional",
        required: false,
        instructionRefs: [sourceRef("optional")],
      }),
    ], [sourceRef("optional")]);
    const optionalMachine = createAgentRuntimePhaseMachine(optional);
    expect(optionalMachine.enter({
      revision: 4,
      snapshotAvailable: false,
      context: context(),
    })).toMatchObject({
      status: "completed",
      condition: "invalid",
    });
    expect(optionalMachine.evidence()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "skipped", condition: "invalid", required: false }),
    ]));
    expect(optionalMachine.state().status).toBe("completed");
  });
});
