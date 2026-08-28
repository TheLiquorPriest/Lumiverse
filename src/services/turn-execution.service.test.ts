import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  __testing,
  beginTurnCommit,
  calculateFinalRenderReservationEnvelopeV1,
  createTurnExecution,
  expireTurnExecution,
  reserveFinalRender,
  transitionTurnExecution,
  finalizeTurnCommit,
  getAgenticRuntimeStatus,
  getTurnExecution,
  isAllowedTurnExecutionTransition,
  reconcileAgentTurns,
  registerAgentTurnReceiptRepair,
  TURN_EXECUTION_RECONCILIATION,
  registerAgentTurnTerminalRecovery,
  requestDormantTurnCancellation,
  requestTurnCancellation,
  TURN_EXECUTION_PHASES,
  TURN_EXECUTION_TRANSITIONS,
  type TurnExecutionPhase,
} from "./turn-execution.service";
import { reconcileStartupState } from "./startup-recovery.service";

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

function createTerminalRecoverySchema(db: Database): void {
  db.run(`
    CREATE TABLE agent_run_attempts (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      previous_attempt_id TEXT,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      generation_type TEXT NOT NULL,
      target_message_id TEXT,
      target_swipe_id INTEGER,
      lifecycle TEXT NOT NULL DEFAULT 'TERMINAL',
      status TEXT NOT NULL,
      outcome TEXT,
      reason TEXT NOT NULL,
      terminal INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER,
      host_correlation_id TEXT NOT NULL,
      reconciliation_state TEXT NOT NULL,
      terminal_receipt_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, attempt_id)
    )
  `);
  db.run(`
    CREATE TABLE agent_run_projections (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      generation_type TEXT NOT NULL,
      target_message_id TEXT,
      target_swipe_id INTEGER,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      revision INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      terminal_handoff_json TEXT,
      omission_json TEXT,
      PRIMARY KEY(user_id, turn_id)
    )
  `);
  db.run(`
    CREATE TABLE agent_chat_events (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      run_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      snapshot_json TEXT,
      terminal_handoff_json TEXT,
      omission_json TEXT,
      PRIMARY KEY(user_id, chat_id, sequence)
    )
  `);
  db.run(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    )
  `);
  db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run("c1", "u1");
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
  registerAgentTurnReceiptRepair(null);
  __testing.resetRuntimeEpoch(4_000);
  __testing.resetReadiness();
});

afterEach(() => {
  registerAgentTurnTerminalRecovery(null);
  registerAgentTurnReceiptRepair(null);
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
  test("explicit timeout cancellation remains TIMED_OUT before the local deadline elapses", () => {
    const created = newExecution(db, "explicit-timeout", Date.now() + 60_000);
    const result = requestTurnCancellation({
      db,
      executionId: "explicit-timeout",
      ownerToken: created.ownerToken,
      reason: "timed_out",
      now: Date.now(),
    });
    expect(result.code).toBe("timed_out");
    expect(result.execution.phase).toBe("TIMED_OUT");
    expect(result.execution.workOutcome).toBe("failed");
  });

  test("Stop is too late from COMPLETE while deadline expiry remains TIMED_OUT", () => {
    const working = newExecution(db, "stop-work-boundary");
    transition(db, "stop-work-boundary", working.ownerToken, "ASSEMBLE", "WORK");
    expect(requestTurnCancellation({
      db,
      executionId: "stop-work-boundary",
      ownerToken: working.ownerToken,
    })).toMatchObject({ code: "cancelled", execution: { phase: "CANCELLED" } });

    const latePhases = [
      { id: "stop-complete", path: ["WORK", "COMPLETE"] as const },
      { id: "stop-render", path: ["WORK", "COMPLETE", "RENDER"] as const },
      { id: "stop-prepare", path: ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT"] as const },
    ];
    for (const { id, path } of latePhases) {
      const created = newExecution(db, id, Date.now() + 60_000);
      let expected: TurnExecutionPhase = "ASSEMBLE";
      for (const phase of path) {
        transition(db, id, created.ownerToken, expected, phase);
        expected = phase;
      }
      const stopped = requestTurnCancellation({
        db,
        executionId: id,
        ownerToken: created.ownerToken,
        reason: "timed_out",
      });
      expect(stopped.code).toBe("too_late");
      expect(stopped.execution.phase).toBe(expected);
    }

    const dormant = newExecution(db, "stop-dormant-complete");
    transition(db, "stop-dormant-complete", dormant.ownerToken, "ASSEMBLE", "WORK");
    transition(db, "stop-dormant-complete", dormant.ownerToken, "WORK", "COMPLETE");
    db.query(
      "UPDATE agent_turn_executions SET cas_owner = NULL, cas_expires_at = NULL WHERE id = 'stop-dormant-complete'",
    ).run();
    expect(requestDormantTurnCancellation({
      db,
      executionId: "stop-dormant-complete",
      userId: "u1",
      chatId: "c1",
    })).toMatchObject({ code: "too_late", execution: { phase: "COMPLETE" } });

    const deadlineAt = Date.now() + 60_000;
    const expiring = newExecution(db, "deadline-complete", deadlineAt);
    transition(db, "deadline-complete", expiring.ownerToken, "ASSEMBLE", "WORK");
    transition(db, "deadline-complete", expiring.ownerToken, "WORK", "COMPLETE");
    expect(expireTurnExecution({
      db,
      executionId: "deadline-complete",
      ownerToken: expiring.ownerToken,
      now: deadlineAt,
    })).toMatchObject({ code: "timed_out", execution: { phase: "TIMED_OUT" } });
  });
  test("projects active and terminal phases with canonical status/outcome pairs", () => {
    const active = newExecution(db, "projection-active");
    expect(active.execution.workStatus).toBe("running");
    expect(active.execution.workOutcome).toBeNull();
    transition(db, "projection-active", active.ownerToken, "ASSEMBLE", "WORK");
    const waiting = transition(db, "projection-active", active.ownerToken, "WORK", "COMPLETE");
    expect(waiting.execution.workStatus).toBe("waiting");
    expect(waiting.execution.workOutcome).toBeNull();

    const timedOut = newExecution(db, "projection-timeout", 10);
    const timeoutResult = transition(db, "projection-timeout", timedOut.ownerToken, "ASSEMBLE", "WORK");
    expect(timeoutResult.execution.phase).toBe("TIMED_OUT");
    expect(timeoutResult.execution.workOutcome).toBe("failed");

    const exhausted = newExecution(db, "projection-exhausted");
    transition(db, "projection-exhausted", exhausted.ownerToken, "ASSEMBLE", "WORK");
    const exhaustedResult = transitionTurnExecution({
      db,
      executionId: "projection-exhausted",
      ownerToken: exhausted.ownerToken,
      expectedPhase: "WORK",
      nextPhase: "EXHAUSTED",
      reason: "agentic_work_exhausted",
    });
    expect(exhaustedResult.execution.workOutcome).toBe("exhausted");

    const committed = newExecution(db, "projection-committed");
    const work = transition(db, "projection-committed", committed.ownerToken, "ASSEMBLE", "WORK");
    const completionHandoff = transition(db, "projection-committed", committed.ownerToken, "WORK", "COMPLETE");
    const render = transition(db, "projection-committed", committed.ownerToken, "COMPLETE", "RENDER");
    const commitPreparation = transition(db, "projection-committed", committed.ownerToken, "RENDER", "PREPARE_COMMIT");
    const committing = beginTurnCommit({
      db,
      executionId: "projection-committed",
      ownerToken: committed.ownerToken,
    });
    expect([
      committed.execution.workPhase,
      work.execution.workPhase,
      completionHandoff.execution.workPhase,
      render.execution.workPhase,
      commitPreparation.execution.workPhase,
      committing.execution.workPhase,
    ]).toEqual(["ASSEMBLE", "WORK", "PREPARE_COMMIT", "RENDER", "COMMIT", "COMMIT"]);
    expect(commitPreparation.execution.workStatus).toBe("waiting");
    expect(commitPreparation.execution.workOutcome).toBeNull();
    expect(committing.execution.workStatus).toBe("running");
    expect(committing.execution.workOutcome).toBeNull();
    const completed = finalizeTurnCommit({
      db,
      executionId: "projection-committed",
      ownerToken: committed.ownerToken,
    });
    expect(completed.execution.workStatus).toBe("terminal");
    expect(completed.execution.workOutcome).toBe("completed");
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
  test("accepts canonical historical terminal outcome with a status-only projection schema", () => {
    const created = newExecution(db, "legacy-terminal-outcome")
    transition(db, created.execution.id, created.ownerToken, "ASSEMBLE", "FAILED")
    db.run(`
      CREATE TABLE agent_run_attempts (
        user_id TEXT NOT NULL, chat_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        run_id TEXT NOT NULL, turn_id TEXT NOT NULL, generation_id TEXT NOT NULL,
        generation_type TEXT NOT NULL, target_message_id TEXT, target_swipe_id INTEGER,
        status TEXT NOT NULL, outcome TEXT, reason TEXT NOT NULL, terminal INTEGER NOT NULL,
        started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, terminal_at INTEGER,
        host_correlation_id TEXT NOT NULL, reconciliation_state TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE agent_run_projections (
        user_id TEXT, chat_id TEXT, turn_id TEXT, generation_id TEXT, generation_type TEXT,
        target_message_id TEXT, target_swipe_id INTEGER, status TEXT,
        sequence INTEGER, revision INTEGER, snapshot_json TEXT, started_at INTEGER, updated_at INTEGER,
        terminal_handoff_json TEXT, omission_json TEXT
      )
    `)
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, sequence, revision,
      snapshot_json, started_at, updated_at, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run(
        "u1", "c1", created.execution.id, created.execution.generationId, "normal",
        "FAILED", 0, 0,
        JSON.stringify({
          workPhase: "TERMINAL",
          workStatus: "terminal",
          workOutcome: "rejected",
          reason: "invalid_input",
          error: { code: "invalid_input" },
        }),
        Date.now(), Date.now(),
      )
    expect((db.query("PRAGMA table_info(agent_run_projections)").all() as { name: string }[])
      .some((column) => column.name === "phase")).toBe(false);
    db.run(`
      CREATE TABLE agent_chat_events (
        user_id TEXT, chat_id TEXT, turn_id TEXT, sequence INTEGER,
        run_revision INTEGER, event_kind TEXT, started_at INTEGER, updated_at INTEGER
      )
    `)
    db.run(`
      CREATE TABLE agent_run_audit_records (
        record_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL, event_id TEXT, host_sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `)
    db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
    db.query("INSERT INTO chats (id, user_id, started_at, updated_at) VALUES (?, ?, ?, ?)").run("c1", "u1", Date.now(), Date.now())
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(
        "u1", "c1", created.execution.id, created.execution.generationId, created.execution.id,
        created.execution.generationId, "normal", "terminal", "rejected", "needs_attention",
        Date.now(), Date.now(), Date.now(), `agentic:${created.execution.id}`, "authoritative",
      )
    db.query(`INSERT INTO agent_run_audit_records (
      record_id, user_id, chat_id, attempt_id, event_id, host_sequence, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "audit-legacy-terminal-outcome", "u1", "c1", created.execution.id,
        `terminal:failure:${created.execution.id}`, 1, JSON.stringify({
          correlation: { attemptId: created.execution.id, messageId: null, swipeId: null },
          result: { status: "rejected", phase: "FAILED", errorCode: "agentic_preflight_failed" },
          errorReason: "needs_attention",
        }),
      )
    let runnerCalls = 0
    registerAgentTurnTerminalRecovery(() => { runnerCalls++ })
    try {
      const recovered = reconcileAgentTurns(db)
      expect(recovered.complete).toBe(true)
      expect(recovered.alreadyTerminal).toBe(1)
      expect(recovered.projectionRepairs).toBe(0)
      expect(runnerCalls).toBe(0)
    } finally {
      registerAgentTurnTerminalRecovery(null)
    }
  })
  test("uses typed legacy aliases when canonical execution columns are null", () => {
    createTerminalRecoverySchema(db);
    db.run("ALTER TABLE agent_turn_executions ADD COLUMN message_id TEXT");
    db.run("ALTER TABLE agent_turn_executions ADD COLUMN swipe_id INTEGER");
    db.run("ALTER TABLE agent_turn_executions ADD COLUMN error_code TEXT");
    db.run("ALTER TABLE agent_turn_executions ADD COLUMN target_snapshot_json BLOB");
    db.run("ALTER TABLE agent_turn_executions ADD COLUMN target_snapshot TEXT");
    db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, swipes TEXT NOT NULL)");
    db.query("INSERT INTO messages (id, chat_id, swipes) VALUES (?, ?, ?)")
      .run("legacy-message", "c1", JSON.stringify(["legacy swipe"]));

    const created = newExecution(db, "typed-legacy-terminal");
    transition(db, created.execution.id, created.ownerToken, "ASSEMBLE", "FAILED");
    const attemptId = "legacy-attempt-id";
    const targetSnapshot = JSON.stringify({
      attemptLineage: {
        attemptId,
        previousAttemptId: null,
        createdAt: created.execution.createdAt,
      },
    });
    const ignoredBlobSnapshot = new TextEncoder().encode(JSON.stringify({
      attemptLineage: { attemptId: "blob-decoy-attempt" },
    }));
    db.query(`UPDATE agent_turn_executions
      SET target_message_id = NULL, message_id = ?,
          target_swipe_id = NULL, swipe_id = ?,
          terminal_code = NULL, error_code = ?,
          target_snapshot_json = ?, target_snapshot = ?
      WHERE id = ?`)
      .run("legacy-message", 0, "invalid_input", ignoredBlobSnapshot, targetSnapshot, created.execution.id);
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'terminal', 'rejected', 'invalid_input', 1, ?, ?, ?, ?, 'recovered')`)
      .run(
        "u1",
        "c1",
        attemptId,
        created.execution.generationId,
        created.execution.id,
        created.execution.generationId,
        "normal",
        "legacy-message",
        0,
        created.execution.createdAt,
        created.execution.updatedAt,
        created.execution.updatedAt,
        `agentic:${created.execution.id}`,
      );
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, 'normal', ?, ?, 'FAILED', 'FAILED', 1, 1, ?, ?, ?, NULL, ?)`)
      .run(
        "u1",
        "c1",
        created.execution.id,
        created.execution.generationId,
        "legacy-message",
        0,
        created.execution.createdAt,
        created.execution.updatedAt,
        JSON.stringify({ workOutcome: "rejected" }),
        "{}",
      );

    expect((db.query(
      "SELECT typeof(target_snapshot_json) AS type FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id) as { type: string }).type).toBe("blob");
    const decoded = getTurnExecution(created.execution.id, undefined, db);
    if (!decoded) {
      throw new Error("expected typed legacy execution to remain readable");
    }
    expect(decoded.targetMessageId).toBe("legacy-message");
    expect(decoded.targetSwipeId).toBe(0);
    expect(decoded.terminalCode).toBe("invalid_input");
    expect(decoded.workOutcome).toBe("rejected");
    expect(decoded.attemptLineage.attemptId).toBe(attemptId);
    const recovered = reconcileAgentTurns(db);
    expect(recovered.complete).toBe(true);
    expect(recovered.inspected).toBe(0);
    expect(recovered.alreadyTerminal).toBe(0);
  });

  test("does not hide JavaScript-only normalization boundaries from reconciliation", () => {
    createTerminalRecoverySchema(db);
    db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, swipes BLOB NOT NULL)");
    const textSnapshot = JSON.stringify({ workOutcome: "failed" });
    const snapshotBlob = new TextEncoder().encode(textSnapshot);
    const swipesBlob = new TextEncoder().encode(JSON.stringify(["blob swipe"]));
    db.query("INSERT INTO messages (id, chat_id, swipes) VALUES (?, ?, ?)")
      .run("blob-message", "c1", swipesBlob);
    db.query("INSERT INTO messages (id, chat_id, swipes) VALUES (?, ?, ?)")
      .run("fractional-message", "c1", JSON.stringify(["only swipe"]));

    const projectionBlob = newExecution(db, "blob-projection-terminal");
    transition(db, projectionBlob.execution.id, projectionBlob.ownerToken, "ASSEMBLE", "FAILED");
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, 'normal', NULL, NULL, 'terminal', 'failed', 'interrupted', 1, ?, ?, ?, ?, 'authoritative')`)
      .run(
        "u1",
        "c1",
        projectionBlob.execution.id,
        projectionBlob.execution.generationId,
        projectionBlob.execution.id,
        projectionBlob.execution.generationId,
        projectionBlob.execution.createdAt,
        projectionBlob.execution.updatedAt,
        projectionBlob.execution.updatedAt,
        `agentic:${projectionBlob.execution.id}`,
      );
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, 'normal', NULL, NULL, 'FAILED', 'FAILED', 1, 1, ?, ?, ?, NULL, ?)`)
      .run(
        "u1",
        "c1",
        projectionBlob.execution.id,
        projectionBlob.execution.generationId,
        projectionBlob.execution.createdAt,
        projectionBlob.execution.updatedAt,
        snapshotBlob,
        "{}",
      );

    const messageBlob = createTurnExecution({
      id: "blob-message-terminal",
      userId: "u1",
      chatId: "c1",
      generationId: "blob-message-generation",
      target: { kind: "swipe", messageId: "blob-message", swipeId: 0 },
      targetChatRevision: 0,
      mode: "agentic",
      workspaceId: "ws1",
      deadlineAt: Date.now() + 60_000,
      expiresAt: Date.now() + 120_000,
    }, db);
    transition(db, messageBlob.execution.id, messageBlob.ownerToken, "ASSEMBLE", "FAILED");
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, 'swipe', ?, 0, 'terminal', 'failed', 'interrupted', 1, ?, ?, ?, ?, 'authoritative')`)
      .run(
        "u1",
        "c1",
        messageBlob.execution.id,
        messageBlob.execution.generationId,
        messageBlob.execution.id,
        messageBlob.execution.generationId,
        "blob-message",
        messageBlob.execution.createdAt,
        messageBlob.execution.updatedAt,
        messageBlob.execution.updatedAt,
        `agentic:${messageBlob.execution.id}`,
      );
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, 'swipe', ?, 0, 'FAILED', 'FAILED', 1, 2, ?, ?, ?, NULL, ?)`)
      .run(
        "u1",
        "c1",
        messageBlob.execution.id,
        messageBlob.execution.generationId,
        "blob-message",
        messageBlob.execution.createdAt,
        messageBlob.execution.updatedAt,
        textSnapshot,
        "{}",
      );
    const fractional = createTurnExecution({
      id: "fractional-swipe-terminal",
      userId: "u1",
      chatId: "c1",
      generationId: "fractional-swipe-generation",
      target: { kind: "swipe", messageId: "fractional-message", swipeId: 0 },
      targetChatRevision: 0,
      mode: "agentic",
      workspaceId: "ws1",
      deadlineAt: Date.now() + 60_000,
      expiresAt: Date.now() + 120_000,
    }, db);
    transition(db, fractional.execution.id, fractional.ownerToken, "ASSEMBLE", "FAILED");
    db.query("UPDATE agent_turn_executions SET target_swipe_id = ? WHERE id = ?")
      .run(0.5, fractional.execution.id);
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, 'swipe', ?, ?, 'terminal', 'failed', 'interrupted', 1, ?, ?, ?, ?, 'authoritative')`)
      .run(
        "u1",
        "c1",
        fractional.execution.id,
        fractional.execution.generationId,
        fractional.execution.id,
        fractional.execution.generationId,
        "fractional-message",
        0.5,
        fractional.execution.createdAt,
        fractional.execution.updatedAt,
        fractional.execution.updatedAt,
        `agentic:${fractional.execution.id}`,
      );
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, 'swipe', ?, ?, 'FAILED', 'FAILED', 1, 3, ?, ?, ?, NULL, ?)`)
      .run(
        "u1",
        "c1",
        fractional.execution.id,
        fractional.execution.generationId,
        "fractional-message",
        0.5,
        fractional.execution.createdAt,
        fractional.execution.updatedAt,
        textSnapshot,
        "{}",
      );
    const tabWrapped = newExecution(db, "tab-wrapped-terminal-code");
    transition(db, tabWrapped.execution.id, tabWrapped.ownerToken, "ASSEMBLE", "FAILED");
    db.query("UPDATE agent_turn_executions SET terminal_code = ? WHERE id = ?")
      .run("\tinvalid_input\t", tabWrapped.execution.id);
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, 'normal', NULL, NULL, 'terminal', 'failed', 'interrupted', 1, ?, ?, ?, ?, 'authoritative')`)
      .run(
        "u1",
        "c1",
        tabWrapped.execution.id,
        tabWrapped.execution.generationId,
        tabWrapped.execution.id,
        tabWrapped.execution.generationId,
        tabWrapped.execution.createdAt,
        tabWrapped.execution.updatedAt,
        tabWrapped.execution.updatedAt,
        `agentic:${tabWrapped.execution.id}`,
      );
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, 'normal', NULL, NULL, 'FAILED', 'FAILED', 1, 4, ?, ?, ?, NULL, ?)`)
      .run(
        "u1",
        "c1",
        tabWrapped.execution.id,
        tabWrapped.execution.generationId,
        tabWrapped.execution.createdAt,
        tabWrapped.execution.updatedAt,
        textSnapshot,
        "{}",
      );

    expect((db.query(
      "SELECT typeof(snapshot_json) AS type FROM agent_run_projections WHERE turn_id = ?",
    ).get(projectionBlob.execution.id) as { type: string }).type).toBe("blob");
    expect((db.query(
      "SELECT typeof(swipes) AS type FROM messages WHERE id = ?",
    ).get("blob-message") as { type: string }).type).toBe("blob");
    expect((db.query(
      "SELECT typeof(target_swipe_id) AS type FROM agent_turn_executions WHERE id = ?",
    ).get(fractional.execution.id) as { type: string }).type).toBe("real");
    const decodedFractional = getTurnExecution(fractional.execution.id, undefined, db);
    if (!decodedFractional) {
      throw new Error("expected fractional target execution to remain readable");
    }
    expect(decodedFractional.targetSwipeId).toBe(0.5);
    const decodedTabWrapped = getTurnExecution(tabWrapped.execution.id, undefined, db);
    if (!decodedTabWrapped) {
      throw new Error("expected tab-wrapped terminal execution to remain readable");
    }
    expect(decodedTabWrapped.terminalCode).toBe("\tinvalid_input\t");
    expect(decodedTabWrapped.workOutcome).toBe("rejected");
    const recovered = reconcileAgentTurns(db);
    expect(recovered.complete).toBe(false);
    expect(recovered.inspected).toBe(4);
    expect(recovered.alreadyTerminal).toBe(4);
    expect(recovered.projectionRepairs).toBe(0);
  });
  test("receipt repair failure remains incomplete and converges on retry", () => {
    const created = newExecution(db, "receipt-repair-failure");
    moveToCommit(db, "receipt-repair-failure", created.ownerToken);
    db.query(`INSERT INTO agent_turn_commit_receipts
      (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id, commit_key, idempotency_key, state, summary_digest, summary_json, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)`)
      .run(
        "receipt-repair-failure-receipt",
        "receipt-repair-failure",
        "receipt-repair-failure",
        "ws1",
        "u1",
        "c1",
        created.commitKey,
        created.commitKey,
        "0".repeat(64),
        "{}",
        Date.now(),
      );
    registerAgentTurnReceiptRepair(() => {
      throw new Error("injected receipt repair failure");
    });
    try {
      const blocked = reconcileAgentTurns(db);
      expect(blocked.complete).toBe(false);
      expect(blocked.committedFromReceipt).toBe(0);
      expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("receipt-repair-failure") as { state: string }).state).toBe("COMMITTING");
    } finally {
      registerAgentTurnReceiptRepair(null);
    }
    const recovered = reconcileAgentTurns(db);
    expect(recovered.complete).toBe(true);
    expect(recovered.committedFromReceipt).toBe(1);
    expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("receipt-repair-failure") as { state: string }).state).toBe("COMMITTED");
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
  test("scans only candidates and drains large recoverable history in keyset pages", () => {
    for (let index = 0; index < 300; index += 1) {
      const historical = newExecution(db, `historical-terminal-${index}`);
      transition(db, historical.execution.id, historical.ownerToken, "ASSEMBLE", "FAILED");
    }
    for (let index = 0; index < 300; index += 1) {
      newExecution(db, `recoverable-${index}`);
    }
    const candidateCount = (db.query(
      "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE state IN ('ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING')",
    ).get() as { count: number }).count;
    expect(candidateCount).toBe(300);

    const recovered = reconcileAgentTurns(db);
    expect(recovered.inspected).toBe(300);
    expect(recovered.failedInterrupted).toBe(300);
    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE state IN ('ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING')",
    ).get() as { count: number }).count).toBe(0);
  });
  test("skips 2,049 tab/NBSP-padded exact terminal authorities so newer work reaches ready startup", async () => {
    createTerminalRecoverySchema(db);
    const retainedCount = TURN_EXECUTION_RECONCILIATION.maxRows + 1;
    const omissionJson = JSON.stringify({
      omittedNodeCount: 0,
      omittedEventCount: 0,
      firstOmittedSequence: null,
      lastOmittedSequence: null,
    });
    const insertAttempt = db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id,
      generation_id, generation_type, target_message_id, target_swipe_id,
      lifecycle, status, outcome, reason, terminal, started_at, updated_at,
      terminal_at, host_correlation_id, reconciliation_state, created_at
    ) VALUES (?, 'c1', ?, NULL, ?, ?, ?, 'normal', NULL, NULL,
      'TERMINAL', 'terminal', ?, 'interrupted', 1, ?, ?, ?, ?, 'recovered', ?)`);
    const insertProjection = db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, 'c1', ?, ?, 'normal', NULL, NULL, 'FAILED', 'FAILED', 1, ?, ?, ?, ?, NULL, ?)`);
    const insertEvent = db.query(`INSERT INTO agent_chat_events (
      user_id, chat_id, sequence, turn_id, generation_id, run_revision, status,
      event_kind, snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, 'c1', ?, ?, ?, 1, 'FAILED', 'terminal', ?, NULL, ?)`);
    const persistExactTerminal = (
      executionId: string,
      generationId: string,
      sequence: number,
      orderedAt: number,
      settledOutcome = "failed",
    ): void => {
      const snapshot = JSON.stringify({
        version: 2,
        runId: generationId,
        turnId: executionId,
        chatId: "c1",
        generationId,
        generationType: "normal",
        target: null,
        attemptLineage: {
          version: 1,
          attemptId: executionId,
          previousAttemptId: null,
          target: {
            chatId: "c1",
            generationType: "normal",
            messageId: null,
            swipeId: null,
          },
          createdAt: orderedAt,
        },
        revision: 1,
        sequence,
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "failed",
        reason: "failed",
        startedAt: orderedAt,
        updatedAt: orderedAt,
        activity: [],
        terminalHandoff: null,
        omission: JSON.parse(omissionJson),
      });
      insertAttempt.run(
        "u1",
        executionId,
        generationId,
        executionId,
        generationId,
        settledOutcome,
        orderedAt,
        orderedAt,
        orderedAt,
        `agentic:${executionId}`,
        orderedAt,
      );
      insertProjection.run(
        "u1",
        executionId,
        generationId,
        sequence,
        orderedAt,
        orderedAt,
        snapshot,
        omissionJson,
      );
      insertEvent.run("u1", sequence, executionId, generationId, snapshot, omissionJson);
    };

    db.transaction(() => {
      for (let index = 0; index < retainedCount; index += 1) {
        const id = `retained-terminal-${index}`;
        const orderedAt = index + 1;
        const historical = newExecution(db, id);
        transition(db, id, historical.ownerToken, "ASSEMBLE", "FAILED");
        db.query("UPDATE agent_turn_executions SET created_at = ?, updated_at = ? WHERE id = ?")
          .run(orderedAt, orderedAt, id);
        const settledOutcome = index % 2 === 0 ? "\tfailed\t" : "\u00a0failed\u00a0";
        persistExactTerminal(id, historical.execution.generationId, orderedAt, orderedAt, settledOutcome);
      }
    })();

    const interrupted = newExecution(db, "newer-interrupted-work");
    const interruptedAt = retainedCount + 100;
    db.query("UPDATE agent_turn_executions SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(interruptedAt, interruptedAt, interrupted.execution.id);
    persistExactTerminal(
      interrupted.execution.id,
      interrupted.execution.generationId,
      retainedCount + 1,
      interruptedAt,
    );

    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE id LIKE 'retained-terminal-%' AND state = 'FAILED'",
    ).get() as { count: number }).count).toBe(retainedCount);
    const paddedOutcomes = db.query(`
      SELECT
        SUM(CASE WHEN outcome = char(9) || 'failed' || char(9) THEN 1 ELSE 0 END) AS tabs,
        SUM(CASE WHEN outcome = char(160) || 'failed' || char(160) THEN 1 ELSE 0 END) AS nbsps
      FROM agent_run_attempts
      WHERE turn_id LIKE 'retained-terminal-%'
    `).get() as { tabs: number; nbsps: number };
    expect(paddedOutcomes.tabs).toBeGreaterThan(0);
    expect(paddedOutcomes.nbsps).toBeGreaterThan(0);
    expect(paddedOutcomes.tabs + paddedOutcomes.nbsps).toBe(retainedCount);

    const previousPreprocessingWorker = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER;
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER = "true";
    try {
      const startup = await reconcileStartupState(db, {
        reconcileExportStaging: () => ({ inspected: 0, removed: 0, preserved: 0, failures: 0 }),
        reconcileUserDataImports: () => ({
          inspected: 0,
          recovered: 0,
          deferred: 0,
          failed: 0,
          complete: true,
          healthy: true,
        }),
        reconcilePurgeCleanupIntents: () => {},
        reconcileAgentArtifactBlobs: async () => ({
          inspected: 0,
          retained: 0,
          removed: 0,
          stale: 0,
          quarantined: 0,
          bytesRemoved: 0,
        }),
        reconcileAgentTurns: (startupDb) => reconcileAgentTurns(startupDb),
        reconcileAgentRunProjections: () => ({
          inspectedProjections: 0,
          removedProjections: 0,
          inspectedWorkspaces: 0,
          removedWorkspaces: 0,
          preservedChatLifetimeEntries: 0,
          failures: 0,
          healthy: true,
          complete: true,
        }),
        probeIsolateBackendsAtStartup: async () => ({
          epoch: 1,
          worker: "healthy",
          subprocess: "unavailable",
          selected: "worker",
          workerReason: null,
          subprocessReason: "not selected",
          checkedAt: Date.now(),
        }),
        installAgenticGenerationCoordinator: () => {},
      });

      expect(startup.turns.complete).toBe(true);
      expect(startup.turns.inspected).toBe(1);
      expect(startup.turns.failedInterrupted).toBe(1);
      expect(startup.turns.alreadyTerminal).toBe(0);
      expect(startup.turns.projectionRepairs).toBe(0);
      expect(startup.stages.turns.ok).toBe(true);
      expect(startup.readiness.reconciliation).toBe(true);
      expect(startup.readiness.reason).toBeNull();
      expect(getAgenticRuntimeStatus().enabled).toBe(true);
      expect((db.query(
        "SELECT state FROM agent_turn_executions WHERE id = 'newer-interrupted-work'",
      ).get() as { state: string }).state).toBe("FAILED");
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE id LIKE 'retained-terminal-%' AND state = 'FAILED'",
      ).get() as { count: number }).count).toBe(retainedCount);
      const retainedAuthorityCounts = db.query(`
        SELECT
          (SELECT COUNT(*) FROM agent_run_attempts) AS attempts,
          (SELECT COUNT(*) FROM agent_run_projections) AS projections,
          (SELECT COUNT(*) FROM agent_chat_events) AS events
      `).get() as { attempts: number; projections: number; events: number };
      expect(retainedAuthorityCounts).toEqual({
        attempts: retainedCount + 1,
        projections: retainedCount + 1,
        events: retainedCount + 1,
      });
    } finally {
      if (previousPreprocessingWorker === undefined) {
        delete process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER;
      } else {
        process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER = previousPreprocessingWorker;
      }
    }
  });
  test("stops before an expensive row when the recovery deadline expires", () => {
    const first = newExecution(db, "slow-turn-a");
    const second = newExecution(db, "slow-turn-b");
    db.query("UPDATE agent_turn_executions SET created_at = ?, updated_at = ? WHERE id = ?").run(100, 100, first.execution.id);
    db.query("UPDATE agent_turn_executions SET created_at = ?, updated_at = ? WHERE id = ?").run(200, 200, second.execution.id);
    const clockValues = [1_000, 1_000, 1_000, 6_000];
    let clockIndex = 0;
    __testing.setReconciliationClock(() => clockValues[Math.min(clockIndex++, clockValues.length - 1)]!);
    try {
      const blocked = reconcileAgentTurns(db);
      expect(blocked.complete).toBe(false);
      expect(blocked.failedInterrupted).toBe(1);
      expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get(first.execution.id) as { state: string }).state).toBe("FAILED");
      expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get(second.execution.id) as { state: string }).state).toBe("ASSEMBLE");
      __testing.setReconciliationClock(null);
      const recovered = reconcileAgentTurns(db);
      expect(recovered.complete).toBe(true);
      expect(recovered.failedInterrupted).toBe(1);
      expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get(second.execution.id) as { state: string }).state).toBe("FAILED");
    } finally {
      __testing.setReconciliationClock(null);
    }
  });
  test("caps the startup scan while prioritizing receipt-backed commit recovery", () => {
    db.run(`
      CREATE TABLE agent_run_projections (
        user_id TEXT,
        chat_id TEXT,
        turn_id TEXT,
        status TEXT,
        sequence INTEGER,
        revision INTEGER
      )
    `);
    db.run(`
      CREATE TABLE agent_chat_events (
        user_id TEXT,
        chat_id TEXT,
        turn_id TEXT,
        sequence INTEGER,
        run_revision INTEGER,
        event_kind TEXT
      )
    `);
    const prioritized = newExecution(db, "priority-receipt");
    moveToCommit(db, prioritized.execution.id, prioritized.ownerToken);
    db.query(`INSERT INTO agent_turn_commit_receipts
      (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id, commit_key, idempotency_key, state, summary_digest, summary_json, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)`)
      .run(
        "priority-receipt-row",
        prioritized.execution.id,
        prioritized.execution.id,
        "ws1",
        "u1",
        "c1",
        prioritized.execution.commitKey,
        prioritized.execution.commitKey,
        "0".repeat(64),
        "{}",
        Date.now(),
      );
    for (let index = 0; index < TURN_EXECUTION_RECONCILIATION.maxRows + 1; index += 1) {
      newExecution(db, `bounded-recoverable-${index}`);
    }

    const recovered = reconcileAgentTurns(db);
    expect(recovered.complete).toBe(false);
    expect(recovered.inspected).toBeLessThanOrEqual(TURN_EXECUTION_RECONCILIATION.maxRows);
    expect(recovered.committedFromReceipt).toBe(1);
    expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("priority-receipt") as { state: string }).state).toBe("COMMITTED");
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
