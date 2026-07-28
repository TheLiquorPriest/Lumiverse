import { describe, expect, test } from "bun:test";
import {
  compileInterceptorMatcher,
  createInterceptorTerminalLease,
  finalizeInterceptorTerminalLeases,
  getRunningExtensions,
  removeRunningExtensionIfHost,
  stopExtension,
} from "./lifecycle";
import type { WorkerHost } from "./worker-host";
import {
  normalizeInterceptorFinalResponse,
  type ValidInterceptorFinalResponse,
} from "./interceptor-final-response";

const guidance = (content: string) => ({
  id: crypto.randomUUID(),
  content,
  role: "system" as const,
});

function makeLease(
  registrationId: string,
  content: string,
  live = () => true,
  deadlineAt?: number,
) {
  return createInterceptorTerminalLease({
    registrationId,
    generationId: "generation-1",
    callbackUserId: "user-1",
    extensionId: registrationId,
    extensionName: registrationId,
    guidance: [guidance(content)],

    isRegistrationLive: live,
    isGenerationLive: live,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  });
}

describe("WorkerHost lifecycle registry", () => {
  test("removes only the exact host that exited", () => {
    const id = `registry-identity-${crypto.randomUUID()}`;
    const staleHost = {} as WorkerHost;
    const replacementHost = {} as WorkerHost;
    const running = getRunningExtensions();
    running.set(id, replacementHost);
    try {
      expect(removeRunningExtensionIfHost(id, staleHost)).toBe(false);
      expect(running.get(id)).toBe(replacementHost);
      expect(removeRunningExtensionIfHost(id, replacementHost)).toBe(true);
      expect(running.has(id)).toBe(false);
    } finally {
      running.delete(id);
    }
  });

  test("removes a host from the registry even when stop fails", async () => {
    const id = `registry-stop-failure-${crypto.randomUUID()}`;
    const host = {
      manifest: { identifier: id, name: "stop failure fixture" },
      stop: async () => {
        throw new Error("stop failed");
      },
    } as unknown as WorkerHost;
    const running = getRunningExtensions();
    running.set(id, host);
    try {
      await expect(stopExtension(id)).rejects.toThrow("stop failed");
      expect(running.has(id)).toBe(false);
    } finally {
      running.delete(id);
    }
  });
});

describe("Interceptor terminal leases", () => {
  test("matches provenance and releases idempotently", () => {
    const matcher = compileInterceptorMatcher({
      generationTypes: ["normal"],
      presetField: { path: ["mode"], oneOf: ["owned"] },
    });
    expect(matcher?.matches({ generationType: "normal", presetMetadata: { mode: "owned" } })).toBe(true);
    expect(matcher?.matches({ generationType: "normal", presetMetadata: { mode: "other" } })).toBe(false);

    const lease = makeLease("registration-1", "guidance");
    expect(lease.isActive()).toBe(true);
    lease.release();
    lease.release();
    lease.revoke();
    expect(lease.isActive()).toBe(false);
  });

  test("aggregates leases in registration order and protects the carrier", async () => {
    const carrier = { role: "assistant" as const, content: "prefill" };
    const first = makeLease("registration-1", "first");
    const second = makeLease("registration-2", "second");
    const result = await finalizeInterceptorTerminalLeases({
      leases: [first, second],
      attemptId: "attempt-1",
      purpose: "terminal-guidance",
      request: { messages: [carrier] },
      carrierIndex: 0,
    });
    expect(result.messages.map((message) => message.content)).toEqual(["first", "second", "prefill"]);
    expect(result.breakdown).toHaveLength(2);
    expect(result.breakdown[0]).toMatchObject({ extensionId: "registration-1" });
    expect(result.breakdown[1]).toMatchObject({ extensionId: "registration-2" });
  });

  test("releases every lease when post-rebudget liveness fails", async () => {
    let live = true;
    const isLive = () => live;
    const first = makeLease("registration-1", "first", isLive);
    const second = makeLease("registration-2", "second", isLive);
    await expect(finalizeInterceptorTerminalLeases({
      leases: [first, second],
      attemptId: "attempt-2",
      purpose: "thread-continuation",
      request: { messages: [{ role: "assistant" as const, content: "carrier" }] },
      carrierIndex: 0,
      rebudget: () => {
        live = false;
        return {};
      },
    })).rejects.toThrow();
    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(false);
  });

  test("rejects a duplicate attempt on the same lease", async () => {
    const lease = makeLease("registration-1", "once");
    const request = { messages: [{ role: "assistant" as const, content: "carrier" }] };
    await lease.finalize({ attemptId: "same", purpose: "terminal-guidance", request });
    await expect(lease.finalize({ attemptId: "same", purpose: "terminal-guidance", request })).rejects.toThrow();
  });

  test("carries host-private final-response state and folds valid supersession", async () => {
    const makeState = (extensionId: string, content: string): ValidInterceptorFinalResponse => {
      const inputMessages = [{ role: "user", content: "ordinary" } as const];
      const outputMessages = [...inputMessages, { role: "system", content: `${extensionId}-fallback` } as const];
      const normalized = normalizeInterceptorFinalResponse({
        result: { content, fallbackMessageIndex: 1 },
        inputMessages,
        outputMessages,
        breakdown: [{ messageIndex: 1, name: `${extensionId} fallback` }],
        permissionGranted: true,
        permissionGuard: () => true,
        extensionId,
        extensionName: extensionId,
        workerId: `worker-${extensionId}`,
        registrationId: `registration-${extensionId}`,
        callbackUserId: "user-1",
        hostGeneration: "generation-1",
      });
      if (!normalized.finalResponse || normalized.finalResponse.status !== "valid") {
        throw new Error("final-response fixture did not normalize");
      }
      return normalized.finalResponse;
    };
    const previous = makeState("first", "first answer");
    const next = makeState("second", "second answer");
    const first = createInterceptorTerminalLease({
      registrationId: "registration-1",
      generationId: "generation-1",
      callbackUserId: "user-1",
      guidance: [],
      finalResponseState: previous,
    });
    const second = createInterceptorTerminalLease({
      registrationId: "registration-2",
      generationId: "generation-1",
      callbackUserId: "user-1",
      guidance: [],
      finalResponseState: next,
    });
    const result = await finalizeInterceptorTerminalLeases({
      leases: [first, second],
      attemptId: "final-response-attempt",
      purpose: "terminal-guidance",
      request: { messages: [{ role: "assistant" as const, content: "carrier" }] },
      carrierIndex: 0,
    });
    expect(result.finalResponse?.status).toBe("valid");
    if (result.finalResponse?.status === "valid") {
      expect(result.finalResponse.extensionId).toBe("second");
      expect(result.finalResponse.supersededResponse?.extensionId).toBe("first");
    }
  });

  test("uses each lease deadline without an aggregate parent deadline", async () => {
    const lease = makeLease(
      "registration-future-deadline",
      "future guidance",
      () => true,
      Date.now() + 60_000,
    );
    const result = await finalizeInterceptorTerminalLeases({
      leases: [lease],
      attemptId: "future-deadline-attempt",
      purpose: "terminal-guidance",
      request: { messages: [{ role: "assistant" as const, content: "carrier" }] },
      carrierIndex: 0,
    });
    expect(result.guidance.map((entry) => entry.content)).toEqual(["future guidance"]);
  });

  test("an expired individual lease rejects and releases the aggregate", async () => {
    const expired = makeLease(
      "registration-expired-deadline",
      "expired guidance",
      () => true,
      Date.now() - 1,
    );
    const future = makeLease(
      "registration-future-deadline-2",
      "future guidance",
      () => true,
      Date.now() + 60_000,
    );
    await expect(finalizeInterceptorTerminalLeases({
      leases: [expired, future],
      attemptId: "expired-deadline-attempt",
      purpose: "terminal-guidance",
      request: { messages: [{ role: "assistant" as const, content: "carrier" }] },
      carrierIndex: 0,
    })).rejects.toThrow("deadline");
    expect(expired.isActive()).toBe(false);
    expect(future.isActive()).toBe(false);
  });

  test("rechecks aggregate permission before each lease attempt and rejects stale finalization", async () => {
    let permission = true;
    const lease = createInterceptorTerminalLease({
      registrationId: "registration-live",
      generationId: "generation-1",
      callbackUserId: "user-1",
      guidance: [],
      permissionGuard: () => permission,
    });
    await expect(finalizeInterceptorTerminalLeases({
      leases: [lease],
      attemptId: "permission-attempt",
      purpose: "terminal-guidance",
      request: { messages: [{ role: "assistant" as const, content: "carrier" }] },
      carrierIndex: 0,
      permissionGuard: () => permission,
      rebudget: () => {
        permission = false;
        return {};
      },
    })).rejects.toThrow("permission");
    expect(lease.isActive()).toBe(false);
  });
});
