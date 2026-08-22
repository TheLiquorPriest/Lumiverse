import { describe, expect, test } from "bun:test";
import {
  runAgenticGeneration,
  requestAgenticGenerationCancellation,
  requestAgenticChatCancellation,
  type AgenticGenerationDependencies,
  type AgenticGenerationInput,
  type AgenticTargetSnapshot,
} from "./agentic-generation.service";
import {
  createAccountContextPackReader,
  createContextToolCapability,
  ContextPackInputRevisionTracker,
} from "./agent-context-tools.service";
import { createCognitionContextInvalidationSink } from "./agent-cognition-integrity.service";
import { HOST_PREPARATION_LIMITS_V1 } from "../types/agent-preprocessing";
import type { AssemblyPlanV1 } from "./agentic-assembly-compiler";
import type { GenerationAssemblySnapshotV1, InputRevisionSetV1Local } from "./prompt-assembly-snapshot.service";
import type { ContextPackCandidateSnapshotV1 } from "./agent-context-tools.service";

const TEST_REVISIONS: InputRevisionSetV1Local = Object.freeze({
  version: 1, revisions: [], digest: "test-revisions", entries: [],
  target: [], chat: [], messages: [], preset: [], blocks: [], config: [], slotBinding: [],
  connection: [], endpoint: [], credential: [], participants: [], worldLore: [], settings: [],
  variables: [], regex: [], context: [], acl: [], cognition: [], readiness: [],
});
const TEST_CONTEXT_SNAPSHOT: ContextPackCandidateSnapshotV1 = Object.freeze({
  version: 1,
  ownerId: "user-1",
  contextAclRevision: 1,
  candidates: [],
  candidateInputRevisions: [],
});

function snapshotFixture(target: AgenticTargetSnapshot, contextPackSnapshot = TEST_CONTEXT_SNAPSHOT): GenerationAssemblySnapshotV1 {
  return {
    version: 1,
    assemblySurface: "WORK",
    snapshotId: "snapshot-test",
    userId: "user-1",
    generationId: "generation-test",
    chatId: "chat-1",
    target: {
      generationType: target.generationType,
      messageId: target.messageId ?? null,
      swipeId: target.swipeId ?? null,
      continueMessageId: null,
      excludedMessageId: null,
      userInput: "",
    },
    chat: { id: "chat-1", character_id: null, name: "Test", created_at: 0, updated_at: 0, metadata: {}, revision: "1" },
    messages: [],
    preset: null,
    blocks: [],
    participants: { persona: null, character: { id: "character-1" }, group: [], availabilityRevision: "1" },
    variables: { preset: {}, chat: {}, settings: {}, revision: "1" },
    regexScripts: [],
    worldInfo: { books: [], entries: [], candidates: [], state: {} },
    contextPacks: {
      schema: "present", contextAclRevision: 1, candidates: [], contextPackSelections: [],
      candidateInputRevisions: [], attachments: [], acl: [], cognitionGraph: null, cognitionSource: null,
      contextRules: [], revision: "1",
    },
    contextPackSnapshot,
    availability: { participantIds: [], toolIds: [], extensionsExcluded: true, ambientSpindleExcluded: true, revision: "1" },
    connection: null,
    agentConfig: null,
    limits: HOST_PREPARATION_LIMITS_V1,
    inputRevisionSet: TEST_REVISIONS,
    revisions: TEST_REVISIONS,
    extensionData: null,
    ambientSpindleData: null,
  };
}

function planFixture(snapshot: GenerationAssemblySnapshotV1): AssemblyPlanV1 {
  const messages: AssemblyPlanV1["messages"] = [];
  return {
    version: 1,
    operation: "compile_agent_assembly",
    assemblySurface: "WORK",
    requestId: "request-test",
    limits: snapshot.limits,
    providerMessages: messages,
    messages,
    children: [],
    childDescriptors: [],
    resultSlots: [],
    activationEvidence: [],
    tokenEvidence: [],
    profileOutputLimits: [],
    seals: [],
    privateEvidence: { activation: [], cognition: [], token: {}, inputRevisionDigest: snapshot.inputRevisionSet.digest },
    deferredDeltas: [],
    deltas: [],
    inputRevisions: snapshot.inputRevisionSet,
    inputRevisionSet: snapshot.inputRevisionSet,
    contextPackSnapshot: snapshot.contextPackSnapshot,
    workPolicyMessages: [],
    customPhasePlan: { status: "ready", phases: [], issues: [], omittedPhaseIds: [] },
    workspaceUsageMessages: [],
    completionCriteriaMessages: [],
    renderPolicyMessages: [],
    loomPolicy: { version: 1, workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
    loomBlocks: [],
    snapshotId: snapshot.snapshotId,
  };
}

function contextRuntimeFixture(snapshot: GenerationAssemblySnapshotV1) {
  const contextSnapshot = snapshot.contextPackSnapshot;
  const reader = createAccountContextPackReader();
  const tracker = new ContextPackInputRevisionTracker();
  const invalidationSink = createCognitionContextInvalidationSink();
  const capability = createContextToolCapability(contextSnapshot, reader, {
    activeCandidates: {
      contextPackRequirements: [],
      newlyActivatedContextPackRequirements: [],
    },
    revisionTracker: tracker,
    invalidationSink,
  });
  return {
    snapshot: contextSnapshot,
    reader,
    tracker,
    capability,
    recheckAtCommit: async () => ({ allowed: true as const }),
  };
}

function input(overrides: Partial<AgenticGenerationInput> = {}): AgenticGenerationInput {
  return {
    userId: "user-1",
    chatId: "chat-1",
    generationType: "normal",
    ...overrides,
  };
}

function dependencies(log: string[], overrides: Partial<AgenticGenerationDependencies> = {}): AgenticGenerationDependencies {
  return {
    resolveRuntime: async () => ({ mode: "agentic", inputRevisions: { chat: 1 } }),
    createExecution: ({ executionId }) => ({ id: executionId }),
    requestCancellation: () => true,
    buildAssemblySnapshot: async (_input, _decision, target) => snapshotFixture(target),
    compileAssemblyPlan: async (snapshot) => planFixture(snapshot),
    runWork: async () => ({ status: "completed", summary: "done", workspace: {} }),
    render: async () => ({ content: "rendered" }),
    prepareRender: async ({ render }) => ({ content: render.content }),
    commit: async () => ({ receiptId: "receipt-1" }),
    createContextRuntime: contextRuntimeFixture,
    transitionExecution: (_execution, _from, to) => { log.push(to); },
    publishTerminal: (event) => { log.push(`terminal:${event.status}`); },
    cleanup: () => { log.push("cleanup"); },
    ...overrides,
  };
}

async function settle(generationId: string): Promise<unknown> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await import("./agentic-generation.service").then((module) => module.waitForAgenticGeneration(generationId));
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Agentic generation did not settle");
}

describe("agentic generation orchestration", () => {
  test("runs the closed phases and commits all four target kinds", async () => {
    for (const generationType of ["normal", "continue", "regenerate", "swipe"] as const) {
      const log: string[] = [];
      const started = await runAgenticGeneration(input({ generationType }), dependencies(log));
      expect(started.status).toBe("streaming");
      const result = await settle(started.generationId) as { status: string; phase: string; receipt?: { receiptId: string } };
      expect(result.status).toBe("completed");
      expect(result.phase).toBe("COMMITTED");
      expect(result.receipt?.receiptId).toBe("receipt-1");
      expect(log).toEqual(["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "terminal:completed", "cleanup"]);
    }
  });
  test("publishes completed orchestration without a failure reason", async () => {
    let terminalReason: string | null | undefined;
    const started = await runAgenticGeneration(input(), dependencies([], {
      publishTerminal: (event) => {
        terminalReason = event.reason;
      },
    }));
    const result = await settle(started.generationId) as { status: string };
    expect(result.status).toBe("completed");
    expect(terminalReason).toBeNull();
  });


  test("does not dispatch provider work or mutate through commit when preflight fails", async () => {
    const calls: string[] = [];
    const started = await runAgenticGeneration(input(), dependencies(calls, {
      buildAssemblySnapshot: async () => { calls.push("snapshot"); throw new Error("invalid_input"); },
      runWork: async () => { calls.push("work"); return { status: "completed" }; },
      commit: async () => { calls.push("commit"); return { receiptId: "never" }; },
    }));
    const result = await settle(started.generationId) as { status: string; errorCode: string };
    expect(result.status).toBe("rejected");
    expect(result.errorCode).toBe("agentic_preflight_failed");
    expect(calls).toEqual(["snapshot", "FAILED", "terminal:rejected", "cleanup"]);
  });

  test("uses internal resolution when UI did not provide a token", async () => {
    let resolved = 0;
    const started = await runAgenticGeneration(input(), dependencies([], {
      resolveRuntime: async () => { resolved += 1; return { mode: "agentic" }; },
    }));
    await settle(started.generationId);
    expect(resolved).toBe(1);
  });
  test("rejects unsupported surfaces without calling decision or provider", async () => {
    let calls = 0;
    await expect(runAgenticGeneration(input({ generationType: "impersonate" }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    await expect(runAgenticGeneration(input({ isImpersonate: true }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    await expect(runAgenticGeneration(input({ isGroupChat: true }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    await expect(runAgenticGeneration(input({ isGroupChat: 1 }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    expect(calls).toBe(0);
    await expect(runAgenticGeneration(input({ regenFeedback: "try again" }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    await expect(runAgenticGeneration(input({ isDryRun: true }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
  });
  test("does not reject a non-impersonation Agentic request", async () => {
    let resolved = 0;
    const started = await runAgenticGeneration(input({ isImpersonate: false }), dependencies([], {
      resolveRuntime: async () => {
        resolved += 1;
        return { mode: "agentic" };
      },
    }));
    await settle(started.generationId);
    expect(resolved).toBe(1);
  });

  test("root Stop is idempotent and prevents downstream dispatch", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let markExecutionCreated!: () => void;
    const executionCreated = new Promise<void>((resolve) => { markExecutionCreated = resolve; });
    let cancellationCalls = 0;
    const calls: string[] = [];
    const started = await runAgenticGeneration(input(), dependencies(calls, {
      createExecution: ({ executionId }) => {
        markExecutionCreated();
        return { id: executionId };
      },
      requestCancellation: () => {
        cancellationCalls += 1;
        return cancellationCalls === 1;
      },
      buildAssemblySnapshot: async (_input, _decision, target) => { await blocked; return snapshotFixture(target); },
    }));
    await executionCreated;
    expect(await requestAgenticGenerationCancellation("user-1", started.generationId)).toBe(true);
    expect(await requestAgenticGenerationCancellation("user-1", started.generationId)).toBe(false);
    release();
    const result = await settle(started.generationId) as { status: string };
    expect(result.status).toBe("cancelled");
    expect(calls).not.toContain("WORK");
  });

  test("user Stop wins the WORK durable CAS before aborting the controller", async () => {
    let markWorkEntered!: () => void;
    const workEntered = new Promise<void>((resolve) => { markWorkEntered = resolve; });
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => { releaseWork = resolve; });
    let workSignal!: AbortSignal;
    let cancellationCalls = 0;
    const started = await runAgenticGeneration(input(), dependencies([], {
      runWork: async ({ signal }) => {
        workSignal = signal;
        markWorkEntered();
        await workGate;
        return { status: "completed", summary: "done", workspace: {} };
      },
      requestCancellation: (_execution, reason) => {
        cancellationCalls += 1;
        expect(reason).toBe("stopped");
        expect(workSignal.aborted).toBe(false);
        return true;
      },
    }));
    await workEntered;
    expect(await requestAgenticChatCancellation("user-1", "chat-1")).toBe(true);
    expect(cancellationCalls).toBe(1);
    expect(workSignal.aborted).toBe(true);
    releaseWork();
    const result = await settle(started.generationId) as { status: string };
    expect(result.status).toBe("cancelled");
  });

  test("Stop returns the durable too_late result without aborting once COMMITTING begins", async () => {
    let markCommitEntered!: () => void;
    const commitEntered = new Promise<void>((resolve) => { markCommitEntered = resolve; });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let commitSignal!: AbortSignal;
    let cancellationCalls = 0;
    const started = await runAgenticGeneration(input(), dependencies([], {
      commit: async ({ signal }) => {
        commitSignal = signal;
        markCommitEntered();
        await commitGate;
        return { receiptId: "receipt-commit" };
      },
      requestCancellation: () => {
        cancellationCalls += 1;
        return "too_late";
      },
    }));
    await commitEntered;
    expect(await requestAgenticGenerationCancellation("user-1", started.generationId)).toBe("too_late");
    expect(cancellationCalls).toBe(1);
    expect(commitSignal.aborted).toBe(false);
    releaseCommit();
    const result = await settle(started.generationId) as { status: string };
    expect(result.status).toBe("completed");
  });
  test("accepted Stop during commit context recheck aborts before durable commit", async () => {
    let markContextEntered!: () => void;
    const contextEntered = new Promise<void>((resolve) => { markContextEntered = resolve; });
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
    let commitCalls = 0;
    let workSignal!: AbortSignal;
    const started = await runAgenticGeneration(input(), dependencies([], {
      createContextRuntime: (snapshot) => {
        const contextSnapshot = snapshot.contextPackSnapshot ?? TEST_CONTEXT_SNAPSHOT;
        const reader = createAccountContextPackReader();
        const tracker = new ContextPackInputRevisionTracker();
        const invalidationSink = createCognitionContextInvalidationSink();
        const capability = createContextToolCapability(contextSnapshot, reader, {
          revisionTracker: tracker,
          invalidationSink,
        });
        return {
          snapshot: contextSnapshot,
          reader,
          tracker,
          capability,
          recheckAtCommit: async () => {
            markContextEntered();
            await contextGate;
            return { allowed: true as const };
          },
        };
      },
      runWork: async ({ signal }) => {
        workSignal = signal;
        return { status: "completed", summary: "done", workspace: {} };
      },
      requestCancellation: (_execution, reason) => {
        expect(reason).toBe("stopped");
        expect(workSignal.aborted).toBe(false);
        return true;
      },
      commit: async () => {
        commitCalls += 1;
        return { receiptId: "should-not-commit" };
      },
    }));
    await contextEntered;
    expect(await requestAgenticGenerationCancellation("user-1", started.generationId)).toBe(true);
    expect(workSignal.aborted).toBe(true);
    releaseContext();
    const result = await settle(started.generationId) as { status: string };
    expect(result.status).toBe("cancelled");
    expect(commitCalls).toBe(0);
  });
  test("default context runtime does not expose frozen candidates without an active cognition view", async () => {
    let observed: unknown;
    const futureCandidate = {
      ownerId: "user-1",
      packId: "future-pack",
      revisionId: "future-pack@1",
      revision: 1,
      digest: "future-digest",
      label: "Future rule pack",
      source: "account" as const,
      targetId: null,
      attachmentId: null,
      attachmentRevision: null,
      aclRevision: 1,
      byteCount: 32,
      tokenCount: 8,
      required: false,
      order: 0,
    };
    const contextPackSnapshot = {
      version: 1 as const,
      ownerId: "user-1",
      contextAclRevision: 1,
      candidates: [futureCandidate],
      candidateInputRevisions: [{
        kind: "context_pack" as const,
        ownerId: "user-1",
        packId: "future-pack",
        revisionId: "future-pack@1",
        revision: 1,
        digest: "future-digest",
        source: "account" as const,
        targetId: null,
        attachmentId: null,
        attachmentRevision: null,
        aclRevision: 1,
      }],
    };
    const started = await runAgenticGeneration(input(), dependencies([], {
      createContextRuntime: undefined,
      buildAssemblySnapshot: async (_input, _decision, target) => snapshotFixture(target, contextPackSnapshot),
      runWork: async ({ contextRuntime }) => {
        observed = await contextRuntime?.capability.list({});
        return { status: "completed", summary: "done", workspace: {} };
      },
    }));
    await settle(started.generationId);
    expect(observed).toMatchObject({ status: "success", toolName: "context_pack_list" });
    expect((observed as { data: { candidates: readonly unknown[] } }).data.candidates).toHaveLength(0);
  });

  test("refused retry admission does not publish a phantom attempt", async () => {
    const { retryAgenticGeneration } = await import("./agentic-generation.service");
    const events: string[] = [];
    const retryDeps = dependencies(events, {
      resolveRuntime: async () => ({ mode: "agentic" as const }),
      createExecution: () => {
        throw new Error("agentic_target_unsupported");
      },
      publishTerminal: () => { events.push("terminal"); },
    });
    await expect(retryAgenticGeneration(input({ generationType: "normal" }), "attempt-previous", retryDeps))
      .rejects.toThrow("agentic_target_unsupported");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).not.toContain("terminal");
  });
});
