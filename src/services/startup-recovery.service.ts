import type { Database } from "bun:sqlite";
import {
  reconcileAgentArtifactBlobs,
  type ArtifactReconcileResult,
} from "./agent-artifact-blobs.service";
import {
  probeIsolateBackendsAtStartup,
  shutdownRegexIsolatePool,
  type IsolateHealthSnapshotV1,
} from "./isolate-pool";
import {
  shutdownAgenticPreprocessingPool,
} from "./agentic-preprocessing-worker-client";
import { shutdownPromptAssemblyWorkerPool } from "./prompt-assembly-worker-client";
import { reconcileStaleExportStaging, type ExportStagingReconcileResult } from "./user-data/export.service";
import { reconcileUserDataImports } from "./user-data/import.service";
import { reconcilePurgeCleanupIntents } from "./user-data/purge.service";
import { installAgenticGenerationCoordinator } from "./agentic-generation-coordinator.service";
import {
  reconcileAgentTurns,
  registerAgentTurnReceiptRepair,
  registerAgentTurnTerminalRecovery,
  setAgenticRuntimeReadiness,
  startAgentRuntimeEpoch,
  type AgenticReadinessVectorV1,
  type ReconcileAgentTurnsResult,
} from "./turn-execution.service";
import {
  reconcileAgentRunProjections,
  repairAgentRunProjectionFromInterruptedExecution,
  repairAgentRunProjectionFromReceipt,
  type AgentRunProjectionReconcileResult,
} from "./agent-run-projection.service";

export type StartupRecoveryStage = "imports" | "artifacts" | "turns" | "projections" | "isolate" | "readiness" | "coordinator";

export type StartupStageFailureCode = "stage_failed" | "unhealthy";

export type StartupStageOutcome =
  | {
      readonly ok: true;
      readonly status: "completed";
      readonly errorCode: null;
    }
  | {
      readonly ok: false;
      readonly status: "failed";
      readonly errorCode: StartupStageFailureCode;
    };

export interface StartupRecoveryStages {
  readonly imports: StartupStageOutcome;
  readonly artifacts: StartupStageOutcome;
  readonly turns: StartupStageOutcome;
  readonly projections: StartupStageOutcome;
  readonly isolate: StartupStageOutcome;
  readonly readiness: StartupStageOutcome;
  readonly coordinator: StartupStageOutcome;
}

export interface StartupRecoveryResult {
  readonly runtimeEpoch: number;
  /**
   * Import recovery does not currently expose counts. Keep this field as
   * `void` for existing startup consumers; `stages.imports` carries its
   * fail-closed outcome.
   */
  readonly imports: void;
  /**
   * These existing result shapes are retained for startup telemetry. A
   * failed stage returns an all-zero conservative sentinel and its
   * `stages` outcome is failed; zero never means that the stage inspected
   * zero rows successfully.
   */
  readonly artifacts: ArtifactReconcileResult;
  readonly turns: ReconcileAgentTurnsResult;
  readonly projections: AgentRunProjectionReconcileResult;
  readonly stages: StartupRecoveryStages;
  readonly isolate: IsolateHealthSnapshotV1;
  readonly readiness: AgenticReadinessVectorV1;
}
export interface StartupRecoveryDependencies {
  readonly startAgentRuntimeEpoch?: () => number;
  readonly reconcileUserDataImports?: () => void | Promise<void>;
  readonly reconcileExportStaging?: () => ExportStagingReconcileResult;
  readonly reconcilePurgeCleanupIntents?: () => void;
  readonly reconcileAgentArtifactBlobs?: (options: { readonly db: Database }) => Promise<ArtifactReconcileResult>;
  readonly reconcileAgentTurns?: (db: Database) => ReconcileAgentTurnsResult;
  readonly reconcileAgentRunProjections?: (db: Database) => AgentRunProjectionReconcileResult;
  readonly probeIsolateBackendsAtStartup?: () => Promise<IsolateHealthSnapshotV1>;
  readonly setAgenticRuntimeReadiness?: (
    patch: Partial<Record<"schema" | "reconciliation" | "archiveRegistry" | "isolateTermination" | "publicationStore", boolean>>,
  ) => AgenticReadinessVectorV1;
  readonly installAgenticGenerationCoordinator?: () => void;
}

const defaultDependencies: Required<StartupRecoveryDependencies> = {
  startAgentRuntimeEpoch,
  reconcileUserDataImports,
  reconcileExportStaging: reconcileStaleExportStaging,
  reconcilePurgeCleanupIntents,
  reconcileAgentArtifactBlobs,
  reconcileAgentTurns,
  reconcileAgentRunProjections,
  probeIsolateBackendsAtStartup,
  setAgenticRuntimeReadiness,
  installAgenticGenerationCoordinator,
};

function completedStage(): StartupStageOutcome {
  return { ok: true, status: "completed", errorCode: null };
}

function failedStage(errorCode: StartupStageFailureCode = "stage_failed"): StartupStageOutcome {
  return { ok: false, status: "failed", errorCode };
}

/**
 * Log only a stable stage/code pair. Recovery exceptions may contain provider,
 * path, or credential data and are intentionally never emitted at startup.
 */
function logStageFailure(stage: StartupRecoveryStage, errorCode: StartupStageFailureCode): void {
  console.error(`[startup] ${stage} recovery failed (${errorCode})`);
}

function emptyArtifactReconcileResult(): ArtifactReconcileResult {
  return {
    inspected: 0,
    retained: 0,
    removed: 0,
    stale: 0,
    quarantined: 0,
    bytesRemoved: 0,
  };
}

function emptyTurnReconcileResult(runtimeEpoch: number): ReconcileAgentTurnsResult {
  return {
    runtimeEpoch,
    inspected: 0,
    claimed: 0,
    failedInterrupted: 0,
    committedFromReceipt: 0,
    commitFailedWithoutReceipt: 0,
    projectionRepairs: 0,
    alreadyTerminal: 0,
    releasedReservations: 0,
  };
}

function emptyProjectionReconcileResult(): AgentRunProjectionReconcileResult {
  return {
    inspectedProjections: 0,
    removedProjections: 0,
    inspectedWorkspaces: 0,
    removedWorkspaces: 0,
    preservedChatLifetimeEntries: 0,
    failures: 0,
    healthy: false,
  };
}

function unavailableIsolateHealth(): IsolateHealthSnapshotV1 {
  const checkedAt = Date.now();
  return {
    epoch: 0,
    worker: "unavailable",
    subprocess: "unavailable",
    selected: "unavailable",
    workerReason: "startup probe failed",
    subprocessReason: "startup probe failed",
    checkedAt,
  };
}

function failClosedReadiness(runtimeEpoch: number): AgenticReadinessVectorV1 {
  return {
    schema: false,
    reconciliation: false,
    archiveRegistry: false,
    isolateTermination: false,
    publicationStore: false,
    providerCapabilities: false,
    configBinding: false,
    contextAcl: false,
    inputRevisions: false,
    runtimeEpoch,
    reason: "startup_readiness_unavailable",
    digest: "startup_readiness_unavailable",
  };
}

function closeReadinessForAgenticFailure(): void {
  try {
    setAgenticRuntimeReadiness({
      schema: false,
      reconciliation: false,
      archiveRegistry: false,
      isolateTermination: false,
      publicationStore: false,
      providerCapabilities: false,
      configBinding: false,
      contextAcl: false,
      inputRevisions: false,
    });
  } catch {
    // The typed fail-closed return remains authoritative for this startup call.
  }
}
/**
 * Install the production terminal recovery hook before the turn stage. The
 * handler writes only the redacted public projection and event outbox inside
 * the reconciler's transaction; it cannot dispatch providers or runtime
 * callbacks.
 */
function installProductionTerminalRecovery(db: Database): void {
  registerAgentTurnTerminalRecovery((execution, status) => {
    repairAgentRunProjectionFromInterruptedExecution(db, execution, status);
  });
}

/**
 * Install the production receipt repairer before the turn stage. The handler
 * is projection-only and is invoked from reconcileAgentTurns inside its
 * caller-owned SQLite transaction; it cannot dispatch generation side effects.
 */
function installProductionReceiptRepairer(db: Database): void {
  registerAgentTurnReceiptRepair((execution, receipt) => {
    repairAgentRunProjectionFromReceipt(db, execution, receipt);
  });
}
/**
 * Reconcile durable state in one fixed order before any route, provider, or
 * extension module is allowed to start. Import recovery owns its own lease and
 * archive invariant; artifact recovery owns its journal; turn recovery repairs
 * receipts and the public projection only. None of these stages dispatches a
 * provider or publishes a websocket event.
 */
export async function reconcileStartupState(
  db: Database,
  dependencies: StartupRecoveryDependencies = {},
): Promise<StartupRecoveryResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const runtimeEpoch = deps.startAgentRuntimeEpoch();

  // Keep these calls intentionally sequential. A turn can reference an
  // artifact and an import can change the archive-owned filesystem; startup
  // must settle each authority before the next authority examines it. Every
  // recovery stage is isolated so a failed authority cannot prevent Response
  // startup or the later safe recovery/probe stages.
  let imports: void = undefined;
  let importsReady = false;
  let exportStagingReady = false;
  try {
    deps.reconcileExportStaging();
    exportStagingReady = true;
  } catch {
    logStageFailure("imports", "stage_failed");
  }
  try {
    imports = await deps.reconcileUserDataImports();
    importsReady = exportStagingReady;
    if (!importsReady) logStageFailure("imports", "stage_failed");
  } catch {
    logStageFailure("imports", "stage_failed");
  }

  let artifacts = emptyArtifactReconcileResult();
  let artifactsReady = false;
  let artifactFailureCode: StartupStageFailureCode = "stage_failed";
  try {
    deps.reconcilePurgeCleanupIntents();
    artifacts = await deps.reconcileAgentArtifactBlobs({ db });
    // A user skipped behind its lifecycle fence leaves durable journal rows
    // unreconciled: readiness stays false until a retry converges.
    if (artifacts.healthy === false) {
      artifactFailureCode = "unhealthy";
      logStageFailure("artifacts", artifactFailureCode);
    } else {
      artifactsReady = true;
    }
  } catch {
    logStageFailure("artifacts", artifactFailureCode);
  }

  let turns = emptyTurnReconcileResult(runtimeEpoch);
  let turnsReady = false;
  try {
    installProductionTerminalRecovery(db);
    installProductionReceiptRepairer(db);
    turns = deps.reconcileAgentTurns(db);
    turnsReady = true;
  } catch {
    logStageFailure("turns", "stage_failed");
  } finally {
    // Interrupted-terminal recovery is a startup-only hook. Receipt repair
    // remains installed for the runtime's durable commit handoff.
    registerAgentTurnTerminalRecovery(null);
  }

  let projections = emptyProjectionReconcileResult();
  let projectionsReady = false;
  let projectionFailureCode: StartupStageFailureCode = "stage_failed";
  try {
    projections = deps.reconcileAgentRunProjections(db);
    if (projections.healthy) {
      projectionsReady = true;
    } else {
      projectionFailureCode = "unhealthy";
      logStageFailure("projections", projectionFailureCode);
    }
  } catch {
    logStageFailure("projections", projectionFailureCode);
  }

  let isolate = unavailableIsolateHealth();
  let isolateReady = false;
  let isolateOutcome: StartupStageOutcome = failedStage();
  try {
    isolate = await deps.probeIsolateBackendsAtStartup();
    const selectedBackendHealthy = isolate.selected === "worker"
      ? isolate.worker === "healthy"
      : isolate.selected === "subprocess"
        ? isolate.subprocess === "healthy"
        : false;
    isolateReady = selectedBackendHealthy
      && process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER !== "false";
    if (isolateReady) {
      isolateOutcome = completedStage();
    } else {
      isolateOutcome = failedStage("unhealthy");
      logStageFailure("isolate", "unhealthy");
    }
  } catch {
    logStageFailure("isolate", "stage_failed");
  }

  const readinessPatch = {
    schema: true,
    archiveRegistry: importsReady,
    reconciliation: importsReady && artifactsReady && turnsReady && projectionsReady,
    publicationStore: artifactsReady,
    isolateTermination: isolateReady,
  } satisfies Partial<Record<"schema" | "reconciliation" | "archiveRegistry" | "isolateTermination" | "publicationStore", boolean>>;
  let readiness = failClosedReadiness(runtimeEpoch);
  let readinessOutcome: StartupStageOutcome = failedStage();
  try {
    readiness = deps.setAgenticRuntimeReadiness(readinessPatch);
    readinessOutcome = completedStage();
  } catch {
    logStageFailure("readiness", "stage_failed");
    closeReadinessForAgenticFailure();
  }

  let coordinatorOutcome: StartupStageOutcome = completedStage();
  try {
    deps.installAgenticGenerationCoordinator();
  } catch {
    logStageFailure("coordinator", "stage_failed");
    closeReadinessForAgenticFailure();
    readiness = failClosedReadiness(runtimeEpoch);
    coordinatorOutcome = failedStage();
  }
  if (isolateOutcome.ok && !readiness.isolateTermination) {
    isolateOutcome = failedStage("unhealthy");
  }

  const stages: StartupRecoveryStages = {
    imports: importsReady ? completedStage() : failedStage(),
    artifacts: artifactsReady ? completedStage() : failedStage(artifactFailureCode),
    turns: turnsReady ? completedStage() : failedStage(),
    projections: projectionsReady ? completedStage() : failedStage(projectionFailureCode),
    isolate: isolateOutcome,
    readiness: readinessOutcome,
    coordinator: coordinatorOutcome,
  };
  return {
    runtimeEpoch,
    imports,
    artifacts,
    turns,
    projections,
    stages,
    isolate,
    readiness,
  };
}

export interface StartupIsolateShutdownDependencies {
  readonly shutdownPromptAssemblyWorkerPool?: () => Promise<void>;
  readonly shutdownAgenticPreprocessingPool?: () => Promise<void>;
  readonly shutdownRegexIsolatePool?: () => Promise<void>;
}

const defaultShutdownDependencies: Required<StartupIsolateShutdownDependencies> = {
  shutdownPromptAssemblyWorkerPool,
  shutdownAgenticPreprocessingPool,
  shutdownRegexIsolatePool,
};

/**
 * Terminate every isolate pool, including subprocess process trees. All pools
 * are attempted even when one backend reports an exit error so graceful
 * shutdown never leaves a later pool running.
 */
export async function shutdownIsolatePools(
  dependencies: StartupIsolateShutdownDependencies = {},
): Promise<void> {
  const deps = { ...defaultShutdownDependencies, ...dependencies };
  await Promise.allSettled([
    deps.shutdownPromptAssemblyWorkerPool(),
    deps.shutdownAgenticPreprocessingPool(),
    deps.shutdownRegexIsolatePool(),
  ]);
}

export function summarizeIsolateHealth(snapshot: IsolateHealthSnapshotV1): string {
  if (process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER === "false") {
    return "disabled by LUMIVERSE_AGENTIC_PREPROCESSING_WORKER";
  }
  const reason = snapshot.selected === "unavailable"
    ? (snapshot.workerReason ?? snapshot.subprocessReason ?? "no healthy terminable backend")
    : `selected=${snapshot.selected}`;
  return reason.slice(0, 256);
}
