import { describe, expect, test } from "bun:test";
import {
  HOST_PREPARATION_LIMITS_V1,
  type RenderPreparationInputV1,
} from "../types/agent-preprocessing";
import {
  assertPairedAssemblyResultsV1,
  PairedAssemblyAdmissionV1,
  parseAgenticPreprocessingResponseV1,
} from "./agentic-preprocessing-worker-client";
import type { AssemblyPlanV1 as CompilerAssemblyPlanV1 } from "./agentic-assembly-compiler";
import { IsolatePoolError, type ActiveIsolateJob } from "./isolate-pool";

const revisions = {
  version: 1 as const,
  revisions: [],
  digest: "frozen-inputs",
};

function makeInput(maxOutputBytes: number): RenderPreparationInputV1 {
  return {
    version: 1,
    operation: "prepare_agent_render",
    requestId: "caller-request",
    limits: { ...HOST_PREPARATION_LIMITS_V1, maxOutputBytes },
    turnId: "turn-1",
    target: { kind: "normal" },
    content: { kind: "text", text: "input" },
    sourceMessages: [],
    swipes: [],
    macroSnapshot: {
      local: [],
      global: [],
      chat: [],
      promptVariables: [],
    },
    regexScripts: [],
    formatting: {
      stripGuidedReasoning: true,
      healFormatting: true,
      preserveProviderReasoning: true,
    },
    inputRevisions: revisions,
    deltas: [],
  };
}

function makeJob(input: RenderPreparationInputV1): ActiveIsolateJob<unknown, unknown> {
  return {
    userId: "user-1",
    operation: "prepare_agent_render",
    payload: input,
    requestId: "job-request",
    resolve: () => undefined,
    reject: () => undefined,
    settled: false,
  };
}

function makeResponse(input: RenderPreparationInputV1, requestId: string, content: string): Record<string, unknown> {
  return {
    version: 1,
    type: "result",
    requestId,
    result: {
      version: 1,
      operation: "prepare_agent_render",
      requestId,
      content: { kind: "text", text: content },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      macroVariableDeltas: [],
      sourceMessageDeltas: [],
      chatMetadataDeltas: [{
        kind: "chat_metadata",
        key: "generated_message",
        operation: "set",
        value: content,
      }],
      regexActionDeltas: [],
      worldInfoStateDeltas: [],
      inputRevisions: input.inputRevisions,
    },
  };
}

function expectMalformed(run: () => unknown): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(IsolatePoolError);
  expect((failure as IsolatePoolError).code).toBe("worker_malformed");
}

describe("agentic preprocessing worker render response validation", () => {
  test("accepts output exactly at the trusted UTF-8 cap", () => {
    const input = makeInput(4);
    const job = makeJob(input);
    const response = makeResponse(input, job.requestId, "😀");

    expect(parseAgenticPreprocessingResponseV1(response, job)).toEqual(response.result);
  });

  test("rejects forged output at cap plus one byte", () => {
    const input = makeInput(4);
    const job = makeJob(input);
    expectMalformed(() => parseAgenticPreprocessingResponseV1(makeResponse(input, job.requestId, "😀a"), job));
  });

  test("rejects unknown result fields before accepting expanded DTOs", () => {
    const input = makeInput(4);
    const job = makeJob(input);
    const response = makeResponse(input, job.requestId, "😀");
    const result = response.result as Record<string, unknown>;
    result.forgedField = "unexpected";
    expectMalformed(() => parseAgenticPreprocessingResponseV1(response, job));
  });
  test("rejects forged revision and target bindings", () => {
    const input = makeInput(4);
    const job = makeJob(input);
    const revisionResponse = makeResponse(input, job.requestId, "😀");
    (revisionResponse.result as Record<string, unknown>).inputRevisions = {
      ...input.inputRevisions,
      digest: "forged",
    };
    expectMalformed(() => parseAgenticPreprocessingResponseV1(revisionResponse, job));

    const targetResponse = makeResponse(input, job.requestId, "😀");
    const metadata = (targetResponse.result as Record<string, unknown>).chatMetadataDeltas as Array<Record<string, unknown>>;
    metadata[0]!.key = "message:forged:continue";
    expectMalformed(() => parseAgenticPreprocessingResponseV1(targetResponse, job));
  });
  test("accepts a caller request id distinct from the wire id but rejects forged wire ids", () => {
    const input = makeInput(4);
    const job = makeJob(input);
    expect(parseAgenticPreprocessingResponseV1(makeResponse(input, job.requestId, "😀"), job)).toBeTruthy();
    expectMalformed(() => parseAgenticPreprocessingResponseV1(makeResponse(input, "forged-wire-id", "😀"), job));
  });
});

function pairedPlan(requestId: string): CompilerAssemblyPlanV1 {
  const messages = [
    {
      role: "user",
      contentKind: "segments",
      provenance: { kind: "history", sourceId: "message-1", sourceRevision: "1", sourceIndex: 0 },
      segments: [{ kind: "literal", text: "history", bytes: 7 }],
    },
    {
      role: "system",
      contentKind: "segments",
      provenance: { kind: "world_info", sourceId: "entry-1", sourceRevision: "2", sourceIndex: 0 },
      segments: [{ kind: "literal", text: "world", bytes: 5 }],
    },
    {
      role: "system",
      contentKind: "segments",
      provenance: { kind: "block", sourceId: "block-1", sourceRevision: "3", sourceIndex: 0 },
      segments: [{ kind: "literal", text: "block", bytes: 5 }],
    },
  ];
  return {
    version: 1,
    operation: "compile_agent_assembly",
    requestId,
    limits: HOST_PREPARATION_LIMITS_V1,
    messages,
    providerMessages: messages,
    children: [],
    childDescriptors: [],
    resultSlots: [],
    activationEvidence: [],
    tokenEvidence: [],
    inputRevisions: revisions,
    inputRevisionSet: revisions,
    contextPackSnapshot: { revision: 1, candidates: [] },
    workPolicyMessages: [],
    workspaceUsageMessages: [],
    completionCriteriaMessages: [],
    renderPolicyMessages: [],
    deltas: [],
    deferredDeltas: [],
    seals: [],
    privateEvidence: {
      activation: [],
      cognition: [],
      token: {},
      inputRevisionDigest: revisions.digest,
    },
    snapshotId: "snapshot-1",
  } as unknown as CompilerAssemblyPlanV1;
}

describe("paired Agentic assembly verification", () => {
  test("accepts only the isolate-specific request id difference", () => {
    expect(() => assertPairedAssemblyResultsV1(
      pairedPlan("primary-request"),
      pairedPlan("verifier-request"),
    )).not.toThrow();
  });

  test("rejects every semantic difference in the independently compiled plan", () => {
    const mutations: Array<(plan: Record<string, unknown>) => void> = [
      (plan) => { plan.limits = { ...HOST_PREPARATION_LIMITS_V1, maxPromptBlocks: HOST_PREPARATION_LIMITS_V1.maxPromptBlocks - 1 }; },
      (plan) => { plan.providerMessages = (plan.providerMessages as unknown[]).slice(1); },
      (plan) => { plan.providerMessages = [...(plan.providerMessages as unknown[])].reverse(); },
      (plan) => {
        const messages = structuredClone(plan.providerMessages as Array<Record<string, unknown>>);
        const segments = messages[0]!.segments as Array<Record<string, unknown>>;
        segments[0] = { ...segments[0], text: "forged", bytes: 6 };
        plan.providerMessages = messages;
      },
      (plan) => { plan.workPolicyMessages = [{ forged: true }]; },
      (plan) => { plan.privateEvidence = { forged: true }; },
      (plan) => { plan.deltas = [{ kind: "forged" }]; },
      (plan) => { plan.deferredDeltas = [{ kind: "forged" }]; },
      (plan) => { plan.inputRevisions = { ...revisions, digest: "forged" }; },
      (plan) => { plan.snapshotId = "forged"; },
    ];
    for (const mutate of mutations) {
      const primary = pairedPlan("primary-request");
      const verifier = structuredClone(pairedPlan("verifier-request"));
      mutate(verifier as unknown as Record<string, unknown>);
      expectMalformed(() => assertPairedAssemblyResultsV1(primary, verifier));
    }
  });

  test("admits one active pair plus two queued pairs per user", () => {
    const admission = new PairedAssemblyAdmissionV1();
    const pairCapacity = Math.floor(
      HOST_PREPARATION_LIMITS_V1.maxQueuedJobsPerUser / 2,
    ) + 1;
    const releases = Array.from(
      { length: pairCapacity },
      () => admission.acquire("user-1"),
    );
    expect(releases.every((release) => typeof release === "function")).toBe(true);
    expect(admission.acquire("user-1")).toBeNull();
    releases[0]!();
    const replacement = admission.acquire("user-1");
    expect(typeof replacement).toBe("function");
    expect(admission.acquire("user-1")).toBeNull();
    replacement!();
    for (const release of releases.slice(1)) release!();
    const recovered = admission.acquire("user-1");
    expect(typeof recovered).toBe("function");
    recovered!();
  });
});
