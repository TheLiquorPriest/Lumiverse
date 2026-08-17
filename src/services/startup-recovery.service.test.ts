import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  reconcileStartupState,
  shutdownIsolatePools,
  summarizeIsolateHealth,
  type StartupRecoveryStage,
  type StartupRecoveryDependencies,
} from "./startup-recovery.service";
import type { AgenticReadinessVectorV1 } from "./turn-execution.service";
import type { IsolateHealthSnapshotV1 } from "./isolate-pool";

const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function readiness(overrides: Partial<AgenticReadinessVectorV1> = {}): AgenticReadinessVectorV1 {
  return {
    schema: true,
    reconciliation: true,
    archiveRegistry: true,
    isolateTermination: false,
    publicationStore: true,
    providerCapabilities: false,
    configBinding: false,
    contextAcl: false,
    inputRevisions: false,
    runtimeEpoch: 17,
    reason: "isolateTermination_unavailable",
    digest: "digest",
    ...overrides,
  };
}

function isolate(selected: IsolateHealthSnapshotV1["selected"]): IsolateHealthSnapshotV1 {
  return {
    epoch: 3,
    worker: selected === "worker" ? "healthy" : "unavailable",
    subprocess: selected === "subprocess" ? "healthy" : "unavailable",
    selected,
    workerReason: selected === "worker" ? null : "worker unavailable",
    subprocessReason: selected === "subprocess" ? null : "subprocess unavailable",
    checkedAt: Date.now(),
  };
}

async function captureConsoleErrors<T>(
  operation: () => Promise<T>,
): Promise<{ readonly result: T; readonly errors: readonly string[] }> {
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(" "));
  };
  try {
    return { result: await operation(), errors };
  } finally {
    console.error = originalError;
  }
}
function healthyRecoveryDependencies(
  overrides: Partial<StartupRecoveryDependencies> = {},
): StartupRecoveryDependencies {
  return {
    startAgentRuntimeEpoch: () => 18,
    reconcileUserDataImports: () => {},
    reconcileAgentArtifactBlobs: async () => ({
      inspected: 0,
      retained: 0,
      removed: 0,
      stale: 0,
      quarantined: 0,
      bytesRemoved: 0,
    }),
    reconcileAgentTurns: () => ({
      runtimeEpoch: 18,
      inspected: 0,
      claimed: 0,
      failedInterrupted: 0,
      committedFromReceipt: 0,
      commitFailedWithoutReceipt: 0,
      projectionRepairs: 0,
      alreadyTerminal: 0,
      releasedReservations: 0,
    }),
    reconcileAgentRunProjections: () => ({
      inspectedProjections: 0,
      removedProjections: 0,
      inspectedWorkspaces: 0,
      removedWorkspaces: 0,
      preservedChatLifetimeEntries: 0,
      failures: 0,
      healthy: true,
    }),
    probeIsolateBackendsAtStartup: async () => isolate("worker"),
    setAgenticRuntimeReadiness: (patch) => readiness(patch),
    installAgenticGenerationCoordinator: () => {},
    ...overrides,
  };
}


describe("startup recovery sequencing", () => {
  test("settles every authority before probing isolate readiness", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const calls: string[] = [];
    const artifactResult = {
      inspected: 1,
      retained: 0,
      removed: 1,
      stale: 2,
      quarantined: 1,
      bytesRemoved: 8,
    } as const;
    const turnResult = {
      runtimeEpoch: 17,
      inspected: 1,
      claimed: 1,
      failedInterrupted: 1,
      committedFromReceipt: 0,
      commitFailedWithoutReceipt: 0,
      projectionRepairs: 0,
      alreadyTerminal: 0,
      releasedReservations: 1,
    } as const;
    const projectionResult = {
      inspectedProjections: 1,
      removedProjections: 0,
      inspectedWorkspaces: 1,
      removedWorkspaces: 0,
      preservedChatLifetimeEntries: 1,
      failures: 0,
      healthy: true,
    } as const;
    const readinessPatches: Array<Partial<Record<"schema" | "reconciliation" | "archiveRegistry" | "isolateTermination" | "publicationStore", boolean>>> = [];
    const result = await reconcileStartupState(db, {
      startAgentRuntimeEpoch: () => {
        calls.push("epoch");
        return 17;
      },
      reconcileUserDataImports: () => {
        calls.push("imports");
      },
      reconcilePurgeCleanupIntents: () => {
        calls.push("purge-intents");
      },
      reconcileAgentArtifactBlobs: async () => {
        calls.push("artifacts");
        return artifactResult;
      },
      reconcileAgentTurns: () => {
        calls.push("turns");
        return turnResult;
      },
      reconcileAgentRunProjections: () => {
        calls.push("projections");
        return projectionResult;
      },
      probeIsolateBackendsAtStartup: async () => {
        calls.push("probe");
        return isolate("unavailable");
      },
      setAgenticRuntimeReadiness: (patch) => {
        calls.push("readiness");
        readinessPatches.push(patch);
        return readiness({ isolateTermination: patch.isolateTermination === true });
      },
      installAgenticGenerationCoordinator: () => {
        calls.push("install");
      },
    });

    expect(calls).toEqual(["epoch", "imports", "purge-intents", "artifacts", "turns", "projections", "probe", "readiness", "install"]);
    expect(result.runtimeEpoch).toBe(17);
    expect(result.artifacts).toEqual(artifactResult);
    expect(result.turns).toEqual(turnResult);
    expect(result.readiness).toMatchObject({
      archiveRegistry: true,
      reconciliation: true,
      publicationStore: true,
      isolateTermination: false,
    });
    expect(result.stages).toEqual({
      imports: { ok: true, status: "completed", errorCode: null },
      artifacts: { ok: true, status: "completed", errorCode: null },
      turns: { ok: true, status: "completed", errorCode: null },
      projections: { ok: true, status: "completed", errorCode: null },
      isolate: { ok: false, status: "failed", errorCode: "unhealthy" },
      readiness: { ok: true, status: "completed", errorCode: null },
      coordinator: { ok: true, status: "completed", errorCode: null },
    });
    const observedReadinessPatch = readinessPatches[0];
    if (!observedReadinessPatch) throw new Error("startup readiness callback was not invoked");
    expect(observedReadinessPatch).toEqual({
      schema: true,
      archiveRegistry: true,
      reconciliation: true,
      publicationStore: true,
      isolateTermination: false,
    });
    expect(summarizeIsolateHealth(result.isolate)).toBe("worker unavailable");
  });
  test("runs export staging reconciliation before imports and fails closed on scan errors", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const calls: string[] = [];
    let readinessPatch: Partial<Record<"schema" | "reconciliation" | "archiveRegistry" | "isolateTermination" | "publicationStore", boolean>> = {};
    const result = await reconcileStartupState(db, healthyRecoveryDependencies({
      reconcileExportStaging: () => {
        calls.push("export-staging");
        throw new Error("scan failed");
      },
      reconcileUserDataImports: () => {
        calls.push("imports");
      },
      setAgenticRuntimeReadiness: (patch) => {
        readinessPatch = patch;
        return readiness(patch);
      },
    }));

    expect(calls).toEqual(["export-staging", "imports"]);
    expect(result.stages.imports).toEqual({ ok: false, status: "failed", errorCode: "stage_failed" });
    expect(readinessPatch.archiveRegistry).toBe(false);
    expect(readinessPatch.reconciliation).toBe(false);
  });

  test("keeps Agentic readiness closed when no terminable backend is available", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const result = await reconcileStartupState(db, {
      startAgentRuntimeEpoch: () => 18,
      reconcileUserDataImports: () => {},
      reconcileAgentArtifactBlobs: async () => ({ inspected: 0, retained: 0, removed: 0, stale: 0, quarantined: 0, bytesRemoved: 0 }),
      reconcileAgentTurns: () => ({
        runtimeEpoch: 18,
        inspected: 0,
        claimed: 0,
        failedInterrupted: 0,
        committedFromReceipt: 0,
        commitFailedWithoutReceipt: 0,
        projectionRepairs: 0,
        alreadyTerminal: 0,
        releasedReservations: 0,
      }),
      reconcileAgentRunProjections: () => ({
        inspectedProjections: 0,
        removedProjections: 0,
        inspectedWorkspaces: 0,
        removedWorkspaces: 0,
        preservedChatLifetimeEntries: 0,
        failures: 0,
        healthy: true,
      }),
      probeIsolateBackendsAtStartup: async () => isolate("unavailable"),
      installAgenticGenerationCoordinator: () => {},
      setAgenticRuntimeReadiness: (patch) => readiness({ isolateTermination: patch.isolateTermination === true }),
    });
    expect(result.isolate.selected).toBe("unavailable");
    expect(result.readiness.reason).toBe("isolateTermination_unavailable");
    expect(result.stages.projections).toEqual({ ok: true, status: "completed", errorCode: null });
    expect(result.stages.isolate).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
  });
  test("marks required isolate startup unhealthy when preprocessing is disabled", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const previous = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER;
    process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER = "false";
    try {
      const result = await reconcileStartupState(db, {
        startAgentRuntimeEpoch: () => 18,
        reconcileUserDataImports: () => {},
        reconcileAgentArtifactBlobs: async () => ({
          inspected: 0,
          retained: 0,
          removed: 0,
          stale: 0,
          quarantined: 0,
          bytesRemoved: 0,
        }),
        reconcileAgentTurns: () => ({
          runtimeEpoch: 18,
          inspected: 0,
          claimed: 0,
          failedInterrupted: 0,
          committedFromReceipt: 0,
          commitFailedWithoutReceipt: 0,
          projectionRepairs: 0,
          alreadyTerminal: 0,
          releasedReservations: 0,
        }),
        reconcileAgentRunProjections: () => ({
          inspectedProjections: 0,
          removedProjections: 0,
          inspectedWorkspaces: 0,
          removedWorkspaces: 0,
          preservedChatLifetimeEntries: 0,
          failures: 0,
          healthy: true,
        }),
        probeIsolateBackendsAtStartup: async () => isolate("worker"),
        setAgenticRuntimeReadiness: (patch) => readiness(patch),
        installAgenticGenerationCoordinator: () => {},
      });
      expect(result.isolate.selected).toBe("worker");
      expect(result.readiness.isolateTermination).toBe(false);
      expect(result.stages.isolate).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    } finally {
      if (previous === undefined) delete process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER;
      else process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER = previous;
    }
  });
  test("keeps publication readiness closed when artifact reconciliation leaves pending users", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const captured = await captureConsoleErrors(() => reconcileStartupState(db, healthyRecoveryDependencies({
      reconcileAgentArtifactBlobs: async () => ({
        inspected: 2,
        retained: 2,
        removed: 0,
        stale: 0,
        quarantined: 0,
        bytesRemoved: 0,
        pendingUsers: 1,
        pendingOverflow: false,
        healthy: false,
      }),
    })));
    expect(captured.errors).toContain("[startup] artifacts recovery failed (unhealthy)");
    expect(captured.result.stages.artifacts).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    expect(captured.result.readiness.publicationStore).toBe(false);
    expect(captured.result.readiness.reconciliation).toBe(false);
  });

  test("marks isolate recovery unhealthy when readiness closes isolate termination", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const isolateReady = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER !== "false";
    const captured = await captureConsoleErrors(() => reconcileStartupState(db, healthyRecoveryDependencies({
      setAgenticRuntimeReadiness: () => {
        throw new Error("private readiness failure");
      },
    })));
    expect(captured.errors).toEqual([
      ...(isolateReady ? [] : ["[startup] isolate recovery failed (unhealthy)"]),
      "[startup] readiness recovery failed (stage_failed)",
    ]);
    expect(captured.result.readiness.isolateTermination).toBe(false);
    expect(captured.result.stages.isolate).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    expect(captured.result.stages.readiness).toEqual({ ok: false, status: "failed", errorCode: "stage_failed" });
  });

  test("marks isolate recovery unhealthy when coordinator closes readiness", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const isolateReady = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER !== "false";
    const captured = await captureConsoleErrors(() => reconcileStartupState(db, healthyRecoveryDependencies({
      installAgenticGenerationCoordinator: () => {
        throw new Error("private coordinator failure");
      },
    })));
    expect(captured.errors).toEqual([
      ...(isolateReady ? [] : ["[startup] isolate recovery failed (unhealthy)"]),
      "[startup] coordinator recovery failed (stage_failed)",
    ]);
    expect(captured.result.readiness.isolateTermination).toBe(false);
    expect(captured.result.stages.isolate).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    expect(captured.result.stages.readiness).toEqual({ ok: true, status: "completed", errorCode: null });
    expect(captured.result.stages.coordinator).toEqual({ ok: false, status: "failed", errorCode: "stage_failed" });
  });



  test("closes reconciliation and logs a stable outcome for unhealthy projections", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const calls: string[] = [];
    const isolateReady = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER !== "false";
    const captured = await captureConsoleErrors(() => reconcileStartupState(db, {
      startAgentRuntimeEpoch: () => {
        calls.push("epoch");
        return 18;
      },
      reconcileUserDataImports: () => {
        calls.push("imports");
      },
      reconcileAgentArtifactBlobs: async () => {
        calls.push("artifacts");
        return { inspected: 3, retained: 1, removed: 1, stale: 1, quarantined: 1, bytesRemoved: 4 };
      },
      reconcileAgentTurns: () => {
        calls.push("turns");
        return {
          runtimeEpoch: 18,
          inspected: 1,
          claimed: 0,
          failedInterrupted: 0,
          committedFromReceipt: 0,
          commitFailedWithoutReceipt: 0,
          projectionRepairs: 0,
          alreadyTerminal: 1,
          releasedReservations: 0,
        };
      },
      reconcileAgentRunProjections: () => {
        calls.push("projections");
        return {
          inspectedProjections: 3,
          removedProjections: 1,
          inspectedWorkspaces: 2,
          removedWorkspaces: 0,
          preservedChatLifetimeEntries: 0,
          failures: 1,
          healthy: false,
        };
      },
      probeIsolateBackendsAtStartup: async () => {
        calls.push("probe");
        return isolate("subprocess");
      },
      setAgenticRuntimeReadiness: (patch) => {
        calls.push("readiness");
        return readiness(patch);
      },
      installAgenticGenerationCoordinator: () => {
        calls.push("install");
      },
    }));
    const result = captured.result;

    expect(calls).toEqual(["epoch", "imports", "artifacts", "turns", "projections", "probe", "readiness", "install"]);
    expect(captured.errors).toEqual([
      "[startup] projections recovery failed (unhealthy)",
      ...(isolateReady ? [] : ["[startup] isolate recovery failed (unhealthy)"]),
    ]);
    expect(result.projections).toEqual({
      inspectedProjections: 3,
      removedProjections: 1,
      inspectedWorkspaces: 2,
      removedWorkspaces: 0,
      preservedChatLifetimeEntries: 0,
      failures: 1,
      healthy: false,
    });
    expect(result.readiness).toMatchObject({
      archiveRegistry: true,
      publicationStore: true,
      reconciliation: false,
      isolateTermination: isolateReady,
    });
    expect(result.stages.projections).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    expect(result.stages.isolate).toEqual(
      isolateReady
        ? { ok: true, status: "completed", errorCode: null }
        : { ok: false, status: "failed", errorCode: "unhealthy" },
    );
    expect(result.stages.readiness).toEqual({ ok: true, status: "completed", errorCode: null });
    expect(result.stages.coordinator).toEqual({ ok: true, status: "completed", errorCode: null });
  });

  const recoveryStages: readonly StartupRecoveryStage[] = ["imports", "artifacts", "turns", "projections"];
  for (const failedStage of recoveryStages) {
    test(`continues after ${failedStage} failure and keeps readiness fail-closed`, async () => {
      const db = new Database(":memory:");
      dbs.push(db);
      const calls: string[] = [];
      const isolateReady = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER !== "false";
      let readinessPatch: Partial<Record<"schema" | "reconciliation" | "archiveRegistry" | "isolateTermination" | "publicationStore", boolean>> | undefined;
      const fail = (stage: StartupRecoveryStage): void => {
        calls.push(stage);
        if (failedStage === stage) throw new Error(`private ${stage} failure`);
      };
      const captured = await captureConsoleErrors(
        () => reconcileStartupState(db, {
        startAgentRuntimeEpoch: () => {
          calls.push("epoch");
          return 19;
        },
        reconcileUserDataImports: () => {
          fail("imports");
        },
        reconcileAgentArtifactBlobs: async () => {
          fail("artifacts");
          return { inspected: 2, retained: 2, removed: 0, stale: 0, quarantined: 0, bytesRemoved: 0 };
        },
        reconcileAgentTurns: () => {
          fail("turns");
          return {
            runtimeEpoch: 19,
            inspected: 2,
            claimed: 0,
            failedInterrupted: 0,
            committedFromReceipt: 0,
            commitFailedWithoutReceipt: 0,
            projectionRepairs: 0,
            alreadyTerminal: 2,
            releasedReservations: 0,
          };
        },
        reconcileAgentRunProjections: () => {
          fail("projections");
          return {
            inspectedProjections: 2,
            removedProjections: 0,
            inspectedWorkspaces: 2,
            removedWorkspaces: 0,
            preservedChatLifetimeEntries: 0,
            failures: 0,
            healthy: true,
          };
        },
        probeIsolateBackendsAtStartup: async () => {
          calls.push("probe");
          return isolate("subprocess");
        },
        setAgenticRuntimeReadiness: (patch) => {
          calls.push("readiness");
          readinessPatch = patch;
          return readiness(patch);
        },
        installAgenticGenerationCoordinator: () => {
          calls.push("install");
        },
      }));
      const result = captured.result;
      expect(captured.errors).toEqual([
        `[startup] ${failedStage} recovery failed (stage_failed)`,
        ...(isolateReady ? [] : ["[startup] isolate recovery failed (unhealthy)"]),
      ]);
      expect(captured.errors.join(" ")).not.toContain("private");

      expect(calls).toEqual(["epoch", "imports", "artifacts", "turns", "projections", "probe", "readiness", "install"]);
      expect(readinessPatch).toEqual({
        schema: true,
        archiveRegistry: failedStage !== "imports",
        reconciliation: false,
        isolateTermination: isolateReady,
        publicationStore: failedStage !== "artifacts",
      });
      expect(result.readiness.archiveRegistry).toBe(failedStage !== "imports");
      expect(result.readiness.publicationStore).toBe(failedStage !== "artifacts");
      expect(result.readiness.reconciliation).toBe(false);
      expect(result.readiness.isolateTermination).toBe(isolateReady);
      expect(result.stages[failedStage]).toEqual({
        ok: false,
        status: "failed",
        errorCode: "stage_failed",
      });
      for (const stage of recoveryStages) {
        if (stage !== failedStage) expect(result.stages[stage]).toEqual({ ok: true, status: "completed", errorCode: null });
      }

      expect(result.stages.isolate).toEqual(
        isolateReady
          ? { ok: true, status: "completed", errorCode: null }
          : { ok: false, status: "failed", errorCode: "unhealthy" },
      );
      for (const stage of ["readiness", "coordinator"] as const) {
        expect(result.stages[stage]).toEqual({ ok: true, status: "completed", errorCode: null });
      }
      if (failedStage === "artifacts") {
        expect(result.artifacts).toEqual({
          inspected: 0,
          retained: 0,
          removed: 0,
          stale: 0,
          quarantined: 0,
          bytesRemoved: 0,
        });
      }
      if (failedStage === "turns") {
        expect(result.turns).toEqual({
          runtimeEpoch: 19,
          inspected: 0,
          claimed: 0,
          failedInterrupted: 0,
          committedFromReceipt: 0,
          commitFailedWithoutReceipt: 0,
          projectionRepairs: 0,
          alreadyTerminal: 0,
          releasedReservations: 0,
        });
      }
      if (failedStage === "projections") {
        expect(result.projections).toEqual({
          inspectedProjections: 0,
          removedProjections: 0,
          inspectedWorkspaces: 0,
          removedWorkspaces: 0,
          preservedChatLifetimeEntries: 0,
          failures: 0,
          healthy: false,
        });
      }
    });
  }
});

describe("startup isolate shutdown", () => {
  test("attempts every pool even when one termination rejects", async () => {
    const calls: string[] = [];
    await shutdownIsolatePools({
      shutdownPromptAssemblyWorkerPool: async () => {
        calls.push("prompt");
      },
      shutdownAgenticPreprocessingPool: async () => {
        calls.push("agentic");
        throw new Error("worker exit failed");
      },
      shutdownRegexIsolatePool: async () => {
        calls.push("regex");
      },
    });
    expect(calls.sort()).toEqual(["agentic", "prompt", "regex"]);
  });
});
