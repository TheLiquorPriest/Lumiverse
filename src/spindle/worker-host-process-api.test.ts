import { describe, expect, test } from "bun:test";
import type { SpindleManifest } from "lumiverse-spindle-types";
import { WorkerHostProcessApi } from "./worker-host-process-api";

function createApi(installScope: "operator" | "user", installedByUserId: string | null) {
  const messages: Array<Record<string, unknown>> = [];
  const api = new WorkerHostProcessApi({
    extensionId: "extension-id",
    manifest: { identifier: "process_scope_test" } as SpindleManifest,
    installScope,
    installedByUserId,
    storageRootPath: () => "/tmp/process-scope-test",
    post: (message) => messages.push(message as Record<string, unknown>),
    resolve: () => undefined,
    reject: () => undefined,
  });
  const records = api as unknown as {
    frontendProcesses: Map<string, Record<string, unknown>>;
    backendProcesses: Map<string, Record<string, unknown>>;
  };
  return { api, messages, records };
}

function frontendRecord(
  processId: string,
  userId: string,
  state: "starting" | "running" = "running",
  requestId = `request-${processId}`,
): Record<string, unknown> {
  return {
    processId,
    requestId,
    kind: "panel",
    state,
    userId,
    startedAt: "2026-07-27T00:00:00.000Z",
    startupTimer: null,
    heartbeatTimer: null,
    startupTimeoutMs: 1_000,
    heartbeatTimeoutMs: 1_000,
  };
}

function backendRecord(
  processId: string,
  userId: string,
  state: "starting" | "running" = "running",
  requestId = `request-${processId}`,
): Record<string, unknown> {
  return {
    processId,
    requestId,
    entry: "dist/process.js",
    kind: "worker",
    state,
    userId,
    startedAt: "2026-07-27T00:00:00.000Z",
    runtime: {
      postMessage: () => undefined,
      terminate: () => undefined,
    },
    startupTimer: null,
    heartbeatTimer: null,
    stopTimer: null,
    startupTimeoutMs: 1_000,
    heartbeatTimeoutMs: 1_000,
  };
}

describe("WorkerHostProcessApi process ownership", () => {
  test("user-scoped get hides foreign frontend and backend processes", () => {
    const { api, messages, records } = createApi("user", "owner-user");
    records.frontendProcesses.set("foreign-frontend", frontendRecord("foreign-frontend", "other-user"));
    records.backendProcesses.set("foreign-backend", backendRecord("foreign-backend", "other-user"));

    api.handleFrontendProcessGet("frontend-get", "foreign-frontend");
    api.handleBackendProcessGet("backend-get", "foreign-backend");

    expect(messages).toEqual([
      { type: "response", requestId: "frontend-get", result: null },
      { type: "response", requestId: "backend-get", result: null },
    ]);
  });

  test("user-scoped get exposes owned processes", () => {
    const { api, messages, records } = createApi("user", "owner-user");
    records.frontendProcesses.set("owned-frontend", frontendRecord("owned-frontend", "owner-user"));
    records.backendProcesses.set("owned-backend", backendRecord("owned-backend", "owner-user"));

    api.handleFrontendProcessGet("frontend-get", "owned-frontend");
    api.handleBackendProcessGet("backend-get", "owned-backend");

    expect(messages.map((message) => (message.result as { processId?: string } | null)?.processId)).toEqual([
      "owned-frontend",
      "owned-backend",
    ]);
  });

  test("settles frontend ready by record request ID", () => {
    const { api, messages, records } = createApi("user", "owner-user");
    const processId = "frontend-ready";
    const requestId = "frontend-ready-request";
    const record = frontendRecord(processId, "owner-user", "starting", requestId);
    record.heartbeatTimeoutMs = 0;
    records.frontendProcesses.set(processId, record);

    api.handleFrontendProcessEvent(processId, "owner-user", "ready");

    expect(messages.filter((message) => message.type === "response")).toEqual([
      {
        type: "response",
        requestId,
        result: expect.objectContaining({ processId }),
      },
    ]);
    expect(records.frontendProcesses.has(processId)).toBe(true);
  });

  test("settles frontend failure by record request ID and removes the failed record", () => {
    const { api, messages, records } = createApi("user", "owner-user");
    const processId = "frontend-failed";
    const requestId = "frontend-failure-request";
    records.frontendProcesses.set(
      processId,
      frontendRecord(processId, "owner-user", "starting", requestId),
    );

    api.handleFrontendProcessEvent(processId, "owner-user", "fail", "frontend failed");

    expect(messages.filter((message) => message.type === "response")).toEqual([
      { type: "response", requestId, error: "frontend failed" },
    ]);
    expect(records.frontendProcesses.has(processId)).toBe(false);
  });

  test("settles frontend unload cleanup by record request ID and removes the unloaded record", () => {
    const { api, messages, records } = createApi("user", "owner-user");
    const processId = "frontend-unloaded";
    const requestId = "frontend-unload-request";
    records.frontendProcesses.set(
      processId,
      frontendRecord(processId, "owner-user", "starting", requestId),
    );

    api.handleFrontendProcessEvent(processId, "owner-user", "frontend_unloaded");

    expect(messages.filter((message) => message.type === "response")).toEqual([
      {
        type: "response",
        requestId,
        error: "Frontend extension unloaded before the process became ready",
      },
    ]);
    expect(records.frontendProcesses.has(processId)).toBe(false);
  });

  test("settles frontend completion before ready and removes the completed record", () => {
    const { api, messages, records } = createApi("user", "owner-user");
    const processId = "frontend-completed-early";
    const requestId = "frontend-complete-request";
    records.frontendProcesses.set(
      processId,
      frontendRecord(processId, "owner-user", "starting", requestId),
    );

    api.handleFrontendProcessEvent(processId, "owner-user", "complete");

    expect(messages.filter((message) => message.type === "response")).toEqual([
      {
        type: "response",
        requestId,
        error: "Frontend process completed before it became ready",
      },
    ]);
    expect(records.frontendProcesses.has(processId)).toBe(false);
  });

  test("settles frontend stop during startup before removing the stopped record", () => {
    const { api, messages, records } = createApi("user", "owner-user");
    const processId = "frontend-stop-starting";
    const requestId = "frontend-stop-start-request";
    const stopRequestId = "frontend-stop-request";
    records.frontendProcesses.set(
      processId,
      frontendRecord(processId, "owner-user", "starting", requestId),
    );

    api.handleFrontendProcessStop(stopRequestId, processId, { userId: "owner-user" });

    expect(messages.filter((message) => message.type === "response")).toEqual([
      {
        type: "response",
        requestId,
        error: "Frontend process stopped before it became ready",
      },
      { type: "response", requestId: stopRequestId, result: undefined },
    ]);
    expect(records.frontendProcesses.get(processId)?.state).toBe("stopping");

    api.handleFrontendProcessEvent(processId, "owner-user", "complete");
    expect(records.frontendProcesses.has(processId)).toBe(false);
  });

  test("settles backend failure and exit by record request ID and removes terminal records", () => {
    const { api, messages, records } = createApi("user", "owner-user");
    const failedProcessId = "backend-failed";
    const failedRequestId = "backend-failure-request";
    const exitedProcessId = "backend-exited";
    const exitedRequestId = "backend-exit-request";
    records.backendProcesses.set(
      failedProcessId,
      backendRecord(failedProcessId, "owner-user", "starting", failedRequestId),
    );
    records.backendProcesses.set(
      exitedProcessId,
      backendRecord(exitedProcessId, "owner-user", "starting", exitedRequestId),
    );

    api.handleBackendProcessRuntimeMessage(failedProcessId, { type: "fail", error: "backend failed" });
    api.handleBackendProcessRuntimeExit(exitedProcessId, 1, null, new Error("backend exited"));

    expect(messages.filter((message) => message.type === "response")).toEqual([
      { type: "response", requestId: failedRequestId, error: "backend failed" },
      { type: "response", requestId: exitedRequestId, error: "backend exited" },
    ]);
    expect(records.backendProcesses.has(failedProcessId)).toBe(false);
    expect(records.backendProcesses.has(exitedProcessId)).toBe(false);
  });

  test("settles backend stop during startup before removing the stopped record", () => {
    const { api, messages, records } = createApi("user", "owner-user");
    const processId = "backend-stop-starting";
    const requestId = "backend-stop-start-request";
    const stopRequestId = "backend-stop-request";
    records.backendProcesses.set(
      processId,
      backendRecord(processId, "owner-user", "starting", requestId),
    );

    api.handleBackendProcessStop(stopRequestId, processId, { userId: "owner-user" });

    expect(messages.filter((message) => message.type === "response")).toEqual([
      {
        type: "response",
        requestId,
        error: "Backend process stopped before it became ready",
      },
      { type: "response", requestId: stopRequestId, result: undefined },
    ]);
    expect(records.backendProcesses.get(processId)?.state).toBe("stopping");

    api.handleBackendProcessRuntimeMessage(processId, { type: "stopped" });
    expect(records.backendProcesses.has(processId)).toBe(false);
  });

  test("settles pending startup requests during bulk process cleanup", () => {
    const { api, messages, records } = createApi("user", "owner-user");
    const frontendProcessId = "frontend-cleanup";
    const frontendRequestId = "frontend-cleanup-request";
    const backendProcessId = "backend-cleanup";
    const backendRequestId = "backend-cleanup-request";
    records.frontendProcesses.set(
      frontendProcessId,
      frontendRecord(frontendProcessId, "owner-user", "starting", frontendRequestId),
    );
    records.backendProcesses.set(
      backendProcessId,
      backendRecord(backendProcessId, "owner-user", "starting", backendRequestId),
    );

    api.stopAllFrontendProcesses("backend_unloaded");
    api.stopAllBackendProcesses("backend_unloaded");

    expect(messages.filter((message) => message.type === "response")).toEqual([
      {
        type: "response",
        requestId: frontendRequestId,
        error: "Frontend process stopped before it became ready",
      },
      {
        type: "response",
        requestId: backendRequestId,
        error: "Backend process stopped before it became ready",
      },
    ]);
    expect(records.frontendProcesses.size).toBe(0);
    expect(records.backendProcesses.size).toBe(0);
  });
});
