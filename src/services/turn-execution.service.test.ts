import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  __testing,
  beginTurnCommit,
  calculateFinalRenderReservationEnvelopeV1,
  createTurnExecution,
  reserveFinalRender,
  transitionTurnExecution,
  finalizeTurnCommit,
  getAgenticRuntimeStatus,
  isAllowedTurnExecutionTransition,
  reconcileAgentTurns,
  registerAgentTurnReceiptRepair,
  registerAgentTurnTerminalRecovery,
  requestDormantTurnCancellation,
  requestTurnCancellation,
  TURN_EXECUTION_PHASES,
  TURN_EXECUTION_TRANSITIONS,
  type TurnExecutionPhase,
} from "./turn-execution.service";

function createExecutionSchema(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE agent_turn_executions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      branch_id TEXT,
      generation_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_message_id TEXT,
      target_swipe_id INTEGER,
      target_message_index INTEGER,
      target_swipe_count INTEGER,
      target_chat_revision INTEGER NOT NULL,
      target_message_revision INTEGER,
      preset_snapshot_id TEXT,
      config_snapshot_id TEXT,
      config_revision INTEGER NOT NULL,
      concrete_connection_snapshot_id TEXT,
      concrete_connection_revision INTEGER NOT NULL,
      world_lore_snapshot_id TEXT,
      world_lore_revision INTEGER NOT NULL,
      mode TEXT NOT NULL,
      runtime_epoch INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      cancel_requested_at INTEGER,
      state TEXT NOT NULL,
      phase_revision INTEGER NOT NULL,
      cas_revision INTEGER NOT NULL,
      cas_owner TEXT,
      cas_expires_at INTEGER,
      root_ledger_json TEXT NOT NULL,
      frame_capabilities_json TEXT NOT NULL,
      workspace_id TEXT,
      workspace_revision INTEGER NOT NULL,
      commit_key TEXT NOT NULL UNIQUE,
      final_render_reservations_json TEXT NOT NULL,
      terminal_code TEXT,
      retention TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE agent_turn_commit_receipts (
      receipt_id TEXT PRIMARY KEY,
      turn_id TEXT,
      execution_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      chat_id TEXT,
      commit_key TEXT,
      idempotency_key TEXT,
      state TEXT,
      summary_digest TEXT,
      summary_json TEXT,
      committed_at INTEGER
    )
  `);
  return db;
}

function newExecution(db: Database, id: string, deadlineAt = Date.now() + 60_000) {
  return createTurnExecution({
    id,
    userId: "u1",
    chatId: "c1",
    generationId: `${id}-generation`,
    target: "normal",
    targetChatRevision: 0,
    mode: "agentic",
    workspaceId: "ws1",
    deadlineAt,
    expiresAt: deadlineAt + 60_000,
  }, db);
}

function transition(
  db: Database,
  executionId: string,
  ownerToken: string,
  expectedPhase: TurnExecutionPhase,
  nextPhase: TurnExecutionPhase,
) {
  return transitionTurnExecution({
    db,
    executionId,
    ownerToken,
    expectedPhase,
    nextPhase,
  });
}

function moveToCommit(db: Database, executionId: string, ownerToken: string): void {
  transition(db, executionId, ownerToken, "ASSEMBLE", "WORK");
  transition(db, executionId, ownerToken, "WORK", "COMPLETE");
  transition(db, executionId, ownerToken, "COMPLETE", "RENDER");
  transition(db, executionId, ownerToken, "RENDER", "PREPARE_COMMIT");
  beginTurnCommit({ db, executionId, ownerToken });
}

let db: Database;
let previousKillSwitch: string | undefined;

beforeEach(() => {
  db = createExecutionSchema();
  previousKillSwitch = process.env.LUMIVERSE_AGENTIC_RUNTIME;
  registerAgentTurnTerminalRecovery(null);
  __testing.resetRuntimeEpoch(4_000);
  __testing.resetReadiness();
});

afterEach(() => {
  registerAgentTurnTerminalRecovery(null);
  db.close();
  if (previousKillSwitch === undefined) delete process.env.LUMIVERSE_AGENTIC_RUNTIME;
  else process.env.LUMIVERSE_AGENTIC_RUNTIME = previousKillSwitch;
});

describe("closed transition contract", () => {
  test("accepts every table edge and rejects every omitted edge", () => {
    for (const current of TURN_EXECUTION_PHASES) {
      for (const next of TURN_EXECUTION_PHASES) {
        const expected = TURN_EXECUTION_TRANSITIONS[current].includes(next);
        expect(isAllowedTurnExecutionTransition(current, next)).toBe(expected);
      }
    }
  });

  test("creates the durable row before a phase mutation and enforces owner/revision CAS", () => {
    const created = newExecution(db, "cas");
    expect(created.execution.state).toBe("ASSEMBLE");
    expect(created.execution.cas.owner).toBe(created.ownerToken);
    expect(() => transition(db, "cas", "stale-owner", "ASSEMBLE", "WORK")).toThrow("stale_owner");
    transition(db, "cas", created.ownerToken, "ASSEMBLE", "WORK");
    expect(() => transitionTurnExecution({
      db,
      executionId: "cas",
      ownerToken: created.ownerToken,
      expectedPhase: "WORK",
      nextPhase: "COMPLETE",
      expectedRevision: 0,
    })).toThrow("stale_execution");
  });
});

describe("final render reservation envelope", () => {
  test("requires the complete chunk plus terminal projection envelope before CAS", () => {
    const created = newExecution(db, "reservation");
    transition(db, "reservation", created.ownerToken, "ASSEMBLE", "WORK");
    transition(db, "reservation", created.ownerToken, "WORK", "COMPLETE");
    transition(db, "reservation", created.ownerToken, "COMPLETE", "RENDER");
    const envelope = calculateFinalRenderReservationEnvelopeV1({
      activityChunks: 16,
      contextBytes: 8 * 1024,
      outputBytes: 16 * 1024,
    });
    const reserved = reserveFinalRender({
      db,
      executionId: "reservation",
      ownerToken: created.ownerToken,
      reservationKey: "render-reservation",
      maxBytes: envelope.maxBytes,
      contextBytes: envelope.contextBytes,
      outputBytes: envelope.outputBytes,
      activityChunks: envelope.activityChunks,
    });
    expect(reserved.maxBytes).toBe(envelope.maxBytes);
    expect(reserved.execution.finalRenderReservations[0]).toMatchObject({
      activityChunks: 16,
      activityEvents: 17,
      maxBytes: envelope.maxBytes,
    });

    const rejected = newExecution(db, "reservation-cap-plus-one");
    const capEnvelope = calculateFinalRenderReservationEnvelopeV1({
      activityChunks: 16,
      contextBytes: 8 * 1024,
      outputBytes: 16 * 1024,
    });
    expect(() => reserveFinalRender({
      db,
      executionId: "reservation-cap-plus-one",
      ownerToken: rejected.ownerToken,
      reservationKey: "under-counted",
      maxBytes: capEnvelope.maxBytes - 1,
      contextBytes: capEnvelope.contextBytes,
      outputBytes: capEnvelope.outputBytes,
      activityChunks: capEnvelope.activityChunks,
    })).toThrow("undercounts");
    expect(rejected.execution.finalRenderReservations).toHaveLength(0);
  });
});

describe("control races and terminal ownership", () => {
  test("cancellation wins in a reversible phase and deadline wins at its CAS", () => {
    const cancelled = newExecution(db, "cancel");
    const cancellation = requestTurnCancellation({ db, executionId: "cancel", ownerToken: cancelled.ownerToken });
    expect(cancellation.code).toBe("cancelled");
    expect(cancellation.execution.state).toBe("CANCELLED");

    const timedOut = newExecution(db, "deadline", 10);
    const timeoutResult = transition(db, "deadline", timedOut.ownerToken, "ASSEMBLE", "WORK");
    expect(timeoutResult.execution.state).toBe("TIMED_OUT");
  });

  test("dormant cancellation uses the durable ownerless CAS for reversible, late, terminal, and active rows", () => {
    const dormant = newExecution(db, "dormant");
    db.query(
      "UPDATE agent_turn_executions SET state = 'WORK', cas_owner = NULL, cas_expires_at = NULL WHERE id = 'dormant'",
    ).run();
    const cancelled = requestDormantTurnCancellation({
      db,
      executionId: "dormant",
      userId: "u1",
      chatId: "c1",
    });
    expect(cancelled.code).toBe("cancelled");
    expect(cancelled.execution.state).toBe("CANCELLED");
    expect(cancelled.execution.cas.revision).toBe(dormant.execution.cas.revision + 1);
    expect(requestDormantTurnCancellation({
      db,
      executionId: "dormant",
      userId: "u1",
      chatId: "c1",
    }).code).toBe("already_terminal");

    const late = newExecution(db, "dormant-late");
    moveToCommit(db, "dormant-late", late.ownerToken);
    db.query(
      "UPDATE agent_turn_executions SET cas_owner = NULL, cas_expires_at = NULL WHERE id = 'dormant-late'",
    ).run();
    const tooLate = requestDormantTurnCancellation({
      db,
      executionId: "dormant-late",
      userId: "u1",
      chatId: "c1",
    });
    expect(tooLate.code).toBe("too_late");
    expect(tooLate.execution.state).toBe("COMMITTING");

    const terminal = newExecution(db, "dormant-terminal");
    transition(db, "dormant-terminal", terminal.ownerToken, "ASSEMBLE", "FAILED");
    const alreadyTerminal = requestDormantTurnCancellation({
      db,
      executionId: "dormant-terminal",
      userId: "u1",
      chatId: "c1",
    });
    expect(alreadyTerminal.code).toBe("already_terminal");
    expect(alreadyTerminal.execution.state).toBe("FAILED");

    const active = newExecution(db, "dormant-active");
    expect(() => requestDormantTurnCancellation({
      db,
      executionId: "dormant-active",
      userId: "u1",
      chatId: "c1",
    })).toThrow("stale_owner");

    const deadline = newExecution(db, "dormant-deadline", 10);
    db.query(
      "UPDATE agent_turn_executions SET cas_owner = NULL, cas_expires_at = NULL WHERE id = 'dormant-deadline'",
    ).run();
    const timedOut = requestDormantTurnCancellation({
      db,
      executionId: "dormant-deadline",
      userId: "u1",
      chatId: "c1",
      now: 10,
    });
    expect(timedOut.code).toBe("timed_out");
    expect(timedOut.execution.state).toBe("TIMED_OUT");
    expect(timedOut.execution.cas.revision).toBe(deadline.execution.cas.revision + 1);
  });

  test("cancellation is too late after the commit gate", () => {
    const created = newExecution(db, "late");
    moveToCommit(db, "late", created.ownerToken);
    const result = requestTurnCancellation({ db, executionId: "late", ownerToken: created.ownerToken });
    expect(result.code).toBe("too_late");
    expect(result.execution.state).toBe("COMMITTING");
  });

  test("terminal owner emits once and cannot transition again", () => {
    const created = newExecution(db, "terminal");
    const first = transition(db, "terminal", created.ownerToken, "ASSEMBLE", "FAILED");
    expect(first.terminalEventEmitted).toBe(true);
    expect(() => transition(db, "terminal", created.ownerToken, "FAILED", "WORK")).toThrow("already_terminal");
    expect(reconcileAgentTurns(db).failedInterrupted).toBe(0);
  });
});

describe("receipt commit and startup recovery", () => {
  test("binds receipt workspace and target identity to the immutable execution", () => {
    const workspaceMismatch = newExecution(db, "receipt-workspace-mismatch");
    moveToCommit(db, "receipt-workspace-mismatch", workspaceMismatch.ownerToken);
    expect(() => finalizeTurnCommit({
      db,
      executionId: "receipt-workspace-mismatch",
      ownerToken: workspaceMismatch.ownerToken,
      workspaceId: "different-workspace",
    })).toThrow("receipt workspace");
    expect((db.query("SELECT COUNT(*) AS count FROM agent_turn_commit_receipts").get() as { count: number }).count).toBe(0);

    const targeted = createTurnExecution({
      id: "receipt-target-mismatch",
      userId: "u1",
      chatId: "c1",
      generationId: "receipt-target-generation",
      target: { kind: "swipe", messageId: "message-1", swipeId: 1 },
      targetChatRevision: 0,
      mode: "agentic",
      workspaceId: "ws1",
      deadlineAt: Date.now() + 60_000,
      expiresAt: Date.now() + 120_000,
    }, db);
    moveToCommit(db, "receipt-target-mismatch", targeted.ownerToken);
    expect(() => finalizeTurnCommit({
      db,
      executionId: "receipt-target-mismatch",
      ownerToken: targeted.ownerToken,
      messageId: "message-2",
      swipeId: 1,
    })).toThrow("receipt message or swipe");
  });
  test("duplicate commit returns the receipt without a second write", () => {
    const created = newExecution(db, "duplicate");
    moveToCommit(db, "duplicate", created.ownerToken);
    const first = finalizeTurnCommit({ db, executionId: "duplicate", ownerToken: created.ownerToken, summary: { count: 1 } });
    const second = finalizeTurnCommit({ db, executionId: "duplicate", ownerToken: created.ownerToken, summary: { count: 2 } });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect((db.query("SELECT COUNT(*) AS count FROM agent_turn_commit_receipts").get() as { count: number }).count).toBe(1);
  });

  test("a statement failure rolls back the receipt and settles COMMIT_FAILED", () => {
    const created = newExecution(db, "statement-failure");
    moveToCommit(db, "statement-failure", created.ownerToken);
    db.run(`CREATE TRIGGER fail_receipt BEFORE INSERT ON agent_turn_commit_receipts BEGIN SELECT RAISE(ABORT, 'injected statement failure'); END`);
    expect(() => finalizeTurnCommit({ db, executionId: "statement-failure", ownerToken: created.ownerToken })).toThrow();
    const state = db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("statement-failure") as { state: string };
    expect(state.state).toBe("COMMIT_FAILED");
    expect((db.query("SELECT COUNT(*) AS count FROM agent_turn_commit_receipts").get() as { count: number }).count).toBe(0);
  });

  test("receipt-only crash repair commits without replaying provider work", () => {
    const created = newExecution(db, "receipt-crash");
    moveToCommit(db, "receipt-crash", created.ownerToken);
    db.query(`INSERT INTO agent_turn_commit_receipts
      (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id, commit_key, idempotency_key, state, summary_digest, summary_json, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)`)
      .run("receipt-1", "receipt-crash", "receipt-crash", "ws1", "u1", "c1", created.commitKey, created.commitKey, "0".repeat(64), "{}", Date.now());
    const recovered = reconcileAgentTurns(db);
    expect(recovered.committedFromReceipt).toBe(1);
    expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("receipt-crash") as { state: string }).state).toBe("COMMITTED");
    expect(reconcileAgentTurns(db).committedFromReceipt).toBe(0);
  });

  test("expires interrupted turns without invoking provider or projection callbacks", async () => {
    let callbackCount = 0;
    registerAgentTurnReceiptRepair(() => {
      callbackCount++;
    });
    try {
      newExecution(db, "expired", Date.now() - 1_000);
      const recovered = reconcileAgentTurns(db);
      await Promise.resolve();
      expect(recovered.failedInterrupted).toBe(1);
      const row = db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("expired") as { state: string };
      expect(row.state).toBe("FAILED");
      expect(callbackCount).toBe(0);
    } finally {
      registerAgentTurnReceiptRepair(null);
    }
  });

  test("a committing row with no receipt becomes COMMIT_FAILED and startup is idempotent", () => {
    const created = newExecution(db, "no-receipt");
    moveToCommit(db, "no-receipt", created.ownerToken);
    const first = reconcileAgentTurns(db);
    expect(first.commitFailedWithoutReceipt).toBe(1);
    expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("no-receipt") as { state: string }).state).toBe("COMMIT_FAILED");
    const second = reconcileAgentTurns(db);
    expect(second.commitFailedWithoutReceipt).toBe(0);
  });
});

describe("dormant runtime kill switch", () => {
  test("off is fail-closed and auto cannot be raised by incomplete readiness", () => {
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "off";
    expect(getAgenticRuntimeStatus().enabled).toBe(false);
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    expect(getAgenticRuntimeStatus().mode).toBe("auto");
    expect(getAgenticRuntimeStatus().enabled).toBe(false);
  });
});
