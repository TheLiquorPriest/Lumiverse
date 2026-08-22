import type { CognitionWorkspaceActivationFactoryV1 } from "../types/agent-cognition-runtime";
import type { WorkspaceArtifactReferenceV1, WorkspaceOperationCapabilitiesV1 } from "../types/turn-workspace";
import type { CognitionActivationResultV1, CognitionTaskTransition } from "../types/agent-cognition";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { publishArtifactCommit } from "./agent-artifact-blobs.service";
import { requestDormantTurnCancellation } from "./turn-execution.service";
import {
  acceptWorkspaceSubmission,
  getActiveFrameCapabilityCountForTests,
  measureWorkspaceOperationBytesV1,
  WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS,
  WORKSPACE_MAX_TASK_ASSIGNMENTS,
  WORKSPACE_OBJECTIVE_MAX_BYTES,
  TurnWorkspaceError,
  assignChildTasks,
  attachWorkspaceArtifactReference,
  createPersistentWorkspace,
  createPersistentWorkspaceHostAuthority,
  createPersistentWorkspaceHostTask,
  createPersistentWorkspaceTask,
  createPersistentWorkspaceHostTurnSession,
  createTurnWorkspace,
  createWorkspaceTask,
  deletePersistentWorkspace,
  deletePersistentWorkspacePublication,
  ensurePersistentWorkspaceForChat,
  ensurePersistentWorkspaceHost,
  freezeFrameCapabilities,
  freezeTurnWorkspace,
  freezeWorkspaceForCompletionV1,
  getPersistentWorkspace,
  getPersistentWorkspaceById,
  getPersistentWorkspaceForChat,
  getTurnWorkspace,
  getWorkspaceCompletionGatesV1,
  listPersistentWorkspacePublications,
  previewWorkspaceForCompletionV1,
  proposeWorkspacePublication,
  publishPersistentWorkspaceSelection,
  publishWorkspaceArtifact,
  recordWorkspaceRecord,
  readTurnWorkspaceSection,
  submitWorkspaceChildResult,
  updatePersistentWorkspaceHostTurnSession,
  updateWorkspaceTaskProgress,
  updateWorkspaceTaskProgressWithCognition,
  updateWorkspaceTaskPolicy,
  type WorkspaceErrorCode,
} from "./turn-workspace.service";
import * as workspaceService from "./turn-workspace.service";

const USER = "workspace-user";
const OTHER_USER = "workspace-other";
const CHAT = "workspace-chat";
const OTHER_CHAT = "workspace-other-chat";
const ARTIFACT_BYTES = Uint8Array.from([97, 98, 99]);
const BLOB_DIGEST = createHash("sha256").update(ARTIFACT_BYTES).digest("hex");
const CREATOR_TOKEN = "workspace-creator";
let artifactRoot = "";
let artifactPath = "";
const TURN = "workspace-turn";
const OTHER_TURN = "workspace-other-turn";
const TURN_A = "workspace-turn-a";
const TURN_B = "workspace-turn-b";

async function applySchema(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = ON");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "106_agent_turn_workspace.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "115_work_alpha1_workspace.sql")).text());
}

function seed(): void {
  const db = getDb();
  artifactRoot = mkdtempSync(join(tmpdir(), "lumiverse-workspace-artifact-"));
  artifactPath = join(artifactRoot, "artifact");
  writeFileSync(artifactPath, ARTIFACT_BYTES);
  const artifactStat = statSync(artifactPath);
  const artifactIdentity = `${Number(artifactStat.dev)}:${Number(artifactStat.ino)}:${Number(artifactStat.size)}:${Math.trunc(Number(artifactStat.mtimeMs) * 1000)}`;
  const observedIdentity = JSON.stringify({ before: null, after: artifactIdentity, createdByUs: true });
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run(USER, "Workspace user", "workspace@example.test");
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run(OTHER_USER, "Other user", "other-workspace@example.test");
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("workspace-character", USER, "Workspace character");
  db.query("INSERT INTO chats (id, user_id, character_id, name) VALUES (?, ?, ?, ?)").run(CHAT, USER, "workspace-character", "Workspace chat");
  db.query("INSERT INTO chats (id, user_id, character_id, name) VALUES (?, ?, ?, ?)").run(OTHER_CHAT, USER, "workspace-character", "Other workspace chat");
  db.query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
     runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
     commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999, 'ASSEMBLE', '{}', '{}', ?, 9999999999)`)
    .run(TURN, USER, CHAT, "workspace-generation", "workspace-commit");
  db.query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
     runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
     commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999, 'ASSEMBLE', '{}', '{}', ?, 9999999999)`)
    .run(OTHER_TURN, USER, OTHER_CHAT, "workspace-generation-other", "workspace-commit-other");
  db.query(`INSERT INTO agent_artifact_blobs
    (digest, user_id, byte_count, mime_type, storage_path, provenance_json, expires_at)
    VALUES (?, ?, 3, 'text/plain', ?, '{}', 9999999999)`)
    .run(BLOB_DIGEST, USER, artifactPath);
  db.query(`INSERT INTO agent_artifact_blob_journal
    (journal_id, blob_digest, user_id, turn_id, creator_token, fence_generation,
     staged_path, final_path, state, observed_identity, byte_count, digest)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'installed', ?, 3, ?)`)
    .run("workspace-journal", BLOB_DIGEST, USER, TURN, "workspace-creator", artifactPath, artifactPath, observedIdentity, BLOB_DIGEST);
}

function insertTurnExecution(turnId: string, generationId: string, commitKey: string, chatId = CHAT): void {
  getDb().query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
     runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
     commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999, 'ASSEMBLE', '{}', '{}', ?, 9999999999)`)
    .run(turnId, USER, chatId, generationId, commitKey);
}
type TurnAttemptOptions = {
  readonly chatId?: string;
  readonly attemptId?: string;
  readonly previousAttemptId?: string | null;
  readonly runId?: string;
  readonly generationId?: string;
  readonly generationType?: "normal" | "continue" | "regenerate" | "swipe";
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
};

function insertTurnAttempt(turnId: string, options: TurnAttemptOptions = {}): void {
  const {
    chatId = CHAT,
    attemptId = turnId,
    previousAttemptId = null,
    runId = `${turnId}-run`,
    generationId = `${turnId}-generation`,
    generationType = "normal",
    targetMessageId = null,
    targetSwipeId = null,
  } = options;
  getDb().query(`INSERT INTO agent_run_attempts
    (user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id,
     generation_id, generation_type, target_message_id, target_swipe_id,
     lifecycle, status, outcome, reason, terminal, started_at, updated_at,
     terminal_at, host_correlation_id, reconciliation_state, terminal_receipt_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ASSEMBLE', 'running', NULL, 'none',
            0, 1, 1, NULL, ?, 'authoritative', NULL)`)
    .run(
      USER,
      chatId,
      attemptId,
      previousAttemptId,
      runId,
      turnId,
      generationId,
      generationType,
      targetMessageId,
      targetSwipeId,
      `workspace-attempt:${attemptId}`,
    );
}


function rootContext(workspaceId: string, revision: number) {
  return { userId: USER, chatId: CHAT, turnId: TURN, workspaceId, actor: "root" as const, expectedRevision: revision };
}
function hostContext(workspaceId: string, revision: number) {
  return { ...rootContext(workspaceId, revision), actor: "host" as const };
}
const childCapabilities = {
  revision: 1,
  allowed: ["read_section", "read_page", "update_assigned_progress", "submit_child_result", "record_finding", "record_decision", "record_question", "attach_artifact", "propose_publication"] as const,
  maxOperationBytes: 64 * 1024,
  maxOperations: 32,
};
function childContext(workspaceId: string, revision: number, frameId = "child-frame") {
  freezeFrameCapabilities({
    userId: USER,
    chatId: CHAT,
    turnId: TURN,
    workspaceId,
    frameId,
    capabilities: childCapabilities,
  });
  return { userId: USER, chatId: CHAT, turnId: TURN, workspaceId, actor: "child" as const, frameId, expectedRevision: revision };
}

function boundedChildContext(
  workspaceId: string,
  revision: number,
  frameId: string,
  capabilities: WorkspaceOperationCapabilitiesV1,
) {
  freezeFrameCapabilities({
    userId: USER,
    chatId: CHAT,
    turnId: TURN,
    workspaceId,
    frameId,
    capabilities,
  });
  return { userId: USER, chatId: CHAT, turnId: TURN, workspaceId, actor: "child" as const, frameId, expectedRevision: revision };
}
function workspace(id = "workspace-1", turnId = TURN, objective = "Keep the objective immutable") {
  return createTurnWorkspace({
    userId: USER,
    chatId: CHAT,
    turnId,
    workspaceId: id,
    objective,
    constraints: ["Use only bounded retained summaries"],
    retention: "operational",
    ttlSeconds: 100,
    quota: { maxTasks: 8, maxRecords: 8, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 2048 },
    capabilities: { revision: 1, allowed: ["read_section", "read_page", "create_task", "update_assigned_progress", "submit_child_result", "record_finding", "record_decision", "record_question", "attach_artifact", "propose_publication"], maxOperationBytes: 131072, maxOperations: 128 },
  });
}
function otherWorkspace(id = "workspace-other") {
  return createTurnWorkspace({
    userId: USER,
    chatId: OTHER_CHAT,
    turnId: OTHER_TURN,
    workspaceId: id,
    objective: "Keep the objective immutable",
    constraints: ["Use only bounded retained summaries"],
    retention: "operational",
    ttlSeconds: 100,
    quota: { maxTasks: 8, maxRecords: 8, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 2048 },
    capabilities: { revision: 1, allowed: ["read_section", "read_page", "create_task", "update_assigned_progress", "submit_child_result", "record_finding", "record_decision", "record_question", "attach_artifact", "propose_publication"], maxOperationBytes: 131072, maxOperations: 128 },
  });
}
function otherRootContext(workspaceId: string, revision: number) {
  return { userId: USER, chatId: OTHER_CHAT, turnId: OTHER_TURN, workspaceId, actor: "root" as const, expectedRevision: revision };
}

type PersistentFixtureOptions = Omit<TurnAttemptOptions, "chatId"> & {
  readonly turnId?: string;
  readonly executionId?: string | null;
};

function persistentFixture(id: string, options: PersistentFixtureOptions = {}) {
  const { turnId = TURN, executionId = turnId, ...attempt } = options;
  insertTurnAttempt(turnId, attempt);
  workspace(id, turnId);
  const persistent = createPersistentWorkspace({ userId: USER, chatId: CHAT, workspaceId: id, objective: "persistent placeholder" });
  const session = createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
    userId: USER,
    chatId: CHAT,
    workspaceId: id,
    turnSessionId: `${id}-session`,
    turnId,
    attemptId: attempt.attemptId ?? turnId,
    executionId,
    expectedRevision: persistent.revision,
  });
  return { persistent, session };
}
function insertOperationalTask(workspaceId: string, taskId = "publication-task", turnId = TURN, chatId = CHAT): void {
  getDb().query(`INSERT INTO agent_workspace_tasks
    (task_id, workspace_id, turn_id, user_id, chat_id, title, description, state,
     required, dependencies_json, progress, summary, byte_count, revision,
     retention, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, '[]', 0.5, ?, 32, 4, 'turn_terminal', 9999999999, 10, 20)`)
    .run(taskId, workspaceId, turnId, USER, chatId, "Published task", "Task objective", "Task summary");
}

function insertOperationalFinding(workspaceId: string, recordId = "publication-finding", summary = "Published finding"): void {
  getDb().query(`INSERT INTO agent_workspace_records
    (record_id, workspace_id, turn_id, user_id, chat_id, kind, summary, digest,
     task_id, source_frame_id, byte_count, revision, retention, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'finding', ?, ?, NULL, 'frame-publication', 32, 3, 'turn_terminal', 9999999999, 11)`)
    .run(recordId, workspaceId, TURN, USER, CHAT, summary, createHash("sha256").update(summary, "utf8").digest("hex"));
}

function insertOperationalArtifact(workspaceId: string, artifactId = "publication-artifact"): void {
  getDb().query(`INSERT INTO agent_workspace_artifacts
    (artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
     byte_count, provenance_json, source_frame_id, source_task_id, publication_state,
     retention, revision, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'text/plain', 3, ?, NULL, NULL, 'published',
            'turn_terminal', 5, 9999999999, 12, 22)`)
    .run(artifactId, workspaceId, TURN, USER, CHAT, BLOB_DIGEST, JSON.stringify({ source: "host" }));
}

function persistentPublicationInput(workspaceId: string, expectedRevision: number, category: string, sourceId: string, sourceRevision?: number) {
  return {
    actor: { kind: "owner" as const, userId: USER },
    userId: USER,
    chatId: CHAT,
    workspaceId,
    expectedRevision,
    category,
    sourceId,
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
  };
}
function expectWorkspaceError(code: WorkspaceErrorCode, callback: () => unknown): void {
  try { callback(); } catch (error) {
    expect(error).toBeInstanceOf(TurnWorkspaceError);
    expect((error as TurnWorkspaceError).code).toBe(code);
    return;
  }
  throw new Error(`expected workspace error ${code}`);
}
function cognitionProgressFactory(taskId: string, transition: CognitionTaskTransition, workspaceRevision: number): CognitionWorkspaceActivationFactoryV1 {
  const state = Object.freeze({
    version: 1 as const,
    workspaceRevision,
    activatedTemplateIds: [] as readonly string[],
    activatedContextRuleIds: [] as readonly string[],
    requiredTemplateIds: [] as readonly string[],
    requiredContextRuleIds: [] as readonly string[],
  });
  const activation: CognitionActivationResultV1 = Object.freeze({
    point: "task_transition",
    state,
    newlyActivatedTemplateIds: [],
    newlyActivatedContextRuleIds: [],
    newlyRequiredTemplateIds: [],
    newlyRequiredContextRuleIds: [],
  });
  return {
    state,
    update: (current) => ({
      taskId,
      transition,
      state: Object.freeze({ ...current, workspaceRevision: current.workspaceRevision + 1 }),
      activation: Object.freeze({ ...activation, state: current }),
      materializeTemplates: [],
    }),
  };
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await applySchema();
  seed();
});
afterEach(() => {
  closeDatabase();
  if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
  artifactRoot = "";
  artifactPath = "";
});

describe("turn workspace validators and CAS operations", () => {
  test("enforces owner/child permissions and stale workspace revisions", () => {
    const created = workspace();
    const task = createWorkspaceTask({ ...rootContext(created.id, created.revision), title: "Assigned work" });
    expect(task.required).toBe(false);
    expectWorkspaceError("forbidden", () => createWorkspaceTask({ ...rootContext(created.id, created.revision + 1), title: "Required without host", required: true }));
    expectWorkspaceError("stale_revision", () => createWorkspaceTask({ ...rootContext(created.id, created.revision), title: "Stale writer" }));
    expectWorkspaceError("child_confinement", () => updateWorkspaceTaskProgress({ ...childContext(created.id, created.revision + 1), taskId: task.id, state: "blocked" }));
    expectWorkspaceError("not_found", () => getTurnWorkspace({ ...rootContext(created.id, created.revision), userId: OTHER_USER }));
  });
  test("child progress cannot complete a task", () => {
    const created = workspace("progress-submission-boundary");
    const task = createWorkspaceTask({
      ...hostContext(created.id, created.revision),
      taskId: "progress-boundary-task",
      title: "Progress boundary",
      assignedFrameId: "progress-boundary-child",
    });
    expectWorkspaceError("invalid_state", () => updateWorkspaceTaskProgress({
      ...childContext(created.id, created.revision + 1, "progress-boundary-child"),
      taskId: task.id,
      state: "completed",
      progress: 1,
    }));
    expect(getDb().query("SELECT state FROM agent_workspace_tasks WHERE task_id = ?").get(task.id)).toEqual({ state: "active" });
    expect(getTurnWorkspace(rootContext(created.id, created.revision + 1)).revision).toBe(created.revision + 1);
  });


  test("freezes per-frame capabilities and prevents capability widening", () => {
    const created = workspace();
    const frame = childContext(created.id, created.revision);
    freezeFrameCapabilities({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      frameId: frame.frameId!,
      capabilities: childCapabilities,
    });
    expectWorkspaceError("forbidden", () => freezeFrameCapabilities({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      frameId: frame.frameId!,
      capabilities: { ...childCapabilities, allowed: ["read_section"] },
    }));
    expectWorkspaceError("capability_denied", () => createWorkspaceTask({ ...frame, title: "child task" }));
    const page = readTurnWorkspaceSection({ ...frame, section: "summary", page: 0, pageSize: 10 });
    expect(page.workspace.revision).toBe(created.revision);
  });
  test("rejects forged child grants and cross-turn frame reuse", () => {
    const first = workspace("frame-scope-first");
    const frame = childContext(first.id, first.revision, "reused-frame");
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: first.id,
      actor: "child",
      frameId: "forged-frame",
      expectedRevision: first.revision,
      capabilities: childCapabilities,
      section: "summary",
      page: 0,
      pageSize: 10,
    }));
    const second = createTurnWorkspace({
      userId: USER,
      chatId: OTHER_CHAT,
      turnId: OTHER_TURN,
      workspaceId: "frame-scope-second",
      objective: "Second turn",
      constraints: [],
      retention: "operational",
      ttlSeconds: 100,
      quota: { maxTasks: 8, maxRecords: 8, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 2048 },
      capabilities: { revision: 1, allowed: ["read_section"], maxOperationBytes: 131072, maxOperations: 128 },
    });
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection({
      userId: USER,
      chatId: OTHER_CHAT,
      turnId: OTHER_TURN,
      workspaceId: second.id,
      actor: "child",
      frameId: frame.frameId,
      expectedRevision: second.revision,
      section: "summary",
      page: 0,
      pageSize: 10,
    }));
  });

  test("charges exactly one operation and rejects cap plus one without consuming it", () => {
    const created = workspace("frame-operation-cap");
    const frameId = "bounded-operation-frame";
    const request = {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      actor: "child" as const,
      frameId,
      expectedRevision: created.revision,
      section: "summary" as const,
      page: 0,
      pageSize: 10,
    };
    const maxOperationBytes = measureWorkspaceOperationBytesV1(request);
    const frame = boundedChildContext(created.id, created.revision, frameId, {
      revision: 1,
      allowed: ["read_section"],
      maxOperationBytes,
      maxOperations: 1,
    });
    expect(readTurnWorkspaceSection(request)).toMatchObject({ section: "summary" });
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection({ ...request, ...frame }));
    expect(getActiveFrameCapabilityCountForTests()).toBe(1);
  });

  test("rejects an oversized UTF-8 request without consuming the operation", () => {
    const created = workspace("frame-operation-bytes");
    const frameId = "bounded-byte-frame";
    const request = {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      actor: "child" as const,
      frameId,
      expectedRevision: created.revision,
      section: "summary" as const,
      page: 0,
      pageSize: 10,
    };
    const maxOperationBytes = measureWorkspaceOperationBytesV1(request);
    const frame = boundedChildContext(created.id, created.revision, frameId, {
      revision: 1,
      allowed: ["read_section"],
      maxOperationBytes,
      maxOperations: 1,
    });
    const oversized = { ...request, pageSize: 100 };
    expect(measureWorkspaceOperationBytesV1(oversized)).toBeGreaterThan(maxOperationBytes);
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection(oversized));
    expect(readTurnWorkspaceSection({ ...request, ...frame })).toMatchObject({ section: "summary" });
  });

  test("admits only one concurrent request at the last frame operation", async () => {
    const created = workspace("frame-operation-race");
    const frameId = "last-operation-frame";
    const request = {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      actor: "child" as const,
      frameId,
      expectedRevision: created.revision,
      section: "summary" as const,
      page: 0,
      pageSize: 10,
    };
    const maxOperationBytes = measureWorkspaceOperationBytesV1(request);
    const frame = boundedChildContext(created.id, created.revision, frameId, {
      revision: 1,
      allowed: ["read_section"],
      maxOperationBytes,
      maxOperations: 1,
    });
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => readTurnWorkspaceSection({ ...request, ...frame })),
      Promise.resolve().then(() => readTurnWorkspaceSection({ ...request, ...frame })),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((attempts.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "capability_denied" });
  });

  test("removes grants on terminal cleanup and rejects stale frames", () => {
    const created = workspace("frame-terminal-cleanup");
    const frameId = "terminal-cleanup-frame";
    const request = {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      actor: "child" as const,
      frameId,
      expectedRevision: created.revision,
      section: "summary" as const,
      page: 0,
      pageSize: 10,
    };
    boundedChildContext(created.id, created.revision, frameId, {
      revision: 1,
      allowed: ["read_section"],
      maxOperationBytes: measureWorkspaceOperationBytesV1(request),
      maxOperations: 2,
    });
    expect(getActiveFrameCapabilityCountForTests()).toBe(1);
    requestDormantTurnCancellation({ executionId: TURN, userId: USER, chatId: CHAT });
    expect(getActiveFrameCapabilityCountForTests()).toBe(0);
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection(request));
  });

  test("removes grants when the workspace expires", () => {
    const created = workspace("frame-expiry-cleanup");
    const frameId = "expiry-cleanup-frame";
    const request = {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      actor: "child" as const,
      frameId,
      expectedRevision: created.revision,
      section: "summary" as const,
      page: 0,
      pageSize: 10,
    };
    boundedChildContext(created.id, created.revision, frameId, {
      revision: 1,
      allowed: ["read_section"],
      maxOperationBytes: measureWorkspaceOperationBytesV1(request),
      maxOperations: 2,
    });
    getDb().query("UPDATE agent_turn_workspaces SET expires_at = ? WHERE workspace_id = ?").run(Math.floor(Date.now() / 1000) - 1, created.id);
    expect(getTurnWorkspace(rootContext(created.id, created.revision)).state).toBe("expired");
    expect(getActiveFrameCapabilityCountForTests()).toBe(0);
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection(request));
  });
  test("public workspace data excludes CAS and capability internals", () => {
    const created = workspace("public-redaction");
    const snapshot = getTurnWorkspace(rootContext(created.id, created.revision));
    expect(snapshot).not.toHaveProperty("casOwner");
    expect(snapshot).not.toHaveProperty("leaseOwner");
    expect(snapshot).not.toHaveProperty("operationCapabilities");
    expect(JSON.stringify(snapshot)).not.toContain("maxOperationBytes");
  });
  test("persists only pending, active, and blocked cognition progress", () => {
    const created = workspace();
    const task = createWorkspaceTask({ ...rootContext(created.id, created.revision), taskId: "cognition-progress-task", title: "Cognition progress", assignedFrameId: "child-frame" });
    let revision = created.revision + 1;
    for (const item of [
      { state: "blocked" as const, transition: "blocked" as const },
      { state: "active" as const, transition: "active" as const },
      { state: "active" as const, transition: "pending" as const },
    ]) {
      const result = updateWorkspaceTaskProgressWithCognition(
        { ...childContext(created.id, revision), taskId: task.id, state: item.state, progress: 0.5 },
        cognitionProgressFactory(task.id, item.transition, revision),
      );
      expect(result.workspaceRevision).toBe(revision + 1);
      const row = getDb().query("SELECT state FROM agent_workspace_tasks WHERE task_id = ? AND workspace_id = ?").get(task.id, created.id) as { state: string } | null;
      expect(row?.state).toBe(item.transition);
      revision += 1;
    }
    expectWorkspaceError("invalid_state", () => updateWorkspaceTaskProgressWithCognition(
      { ...childContext(created.id, revision), taskId: task.id, state: "completed", progress: 1 },
      cognitionProgressFactory(task.id, "completed", revision),
    ));
    expect(getDb().query("SELECT state FROM agent_workspace_tasks WHERE task_id = ? AND workspace_id = ?").get(task.id, created.id)).toEqual({ state: "pending" });
    expect(getTurnWorkspace(rootContext(created.id, revision)).revision).toBe(revision);
  });

  test("rejects dependency cycles and duplicate stable identifiers", () => {
    const created = workspace();
    const a = createWorkspaceTask({ ...rootContext(created.id, 0), taskId: "task-a", title: "A" });
    const b = createWorkspaceTask({ ...rootContext(created.id, 1), taskId: "task-b", title: "B", dependencyIds: [a.id] });
    expectWorkspaceError("dependency_cycle", () => updateWorkspaceTaskPolicy({ ...rootContext(created.id, 2), taskId: a.id, dependencyIds: [b.id] }));
    expectWorkspaceError("duplicate_id", () => createWorkspaceTask({ ...rootContext(created.id, 2), taskId: "task-b", title: "Duplicate" }));
  });
  test("scopes a colliding model task id to the current turn", () => {
    const first = workspace("workspace-task-id-first");
    const created = createWorkspaceTask({
      ...rootContext(first.id, first.revision),
      taskId: "honesty-pack-review-4",
      title: "Review Honesty Coverage Pack",
    });
    expect(created.id).toBe("honesty-pack-review-4");
    const second = otherWorkspace("workspace-task-id-second");
    const reused = createWorkspaceTask({
      ...otherRootContext(second.id, second.revision),
      taskId: "honesty-pack-review-4",
      title: "Review Honesty Coverage Pack again",
    });
    expect(reused.id).toBe(`${OTHER_TURN}:honesty-pack-review-4`);
    expect(reused.title).toBe("Review Honesty Coverage Pack again");
    expectWorkspaceError("duplicate_id", () => createWorkspaceTask({
      ...otherRootContext(second.id, second.revision + 1),
      taskId: "honesty-pack-review-4",
      title: "Same turn collision",
    }));
  });
  test("recomputes task policy footprints at the maxBytes boundary", () => {
    const created = workspace("task-policy-byte-cap");
    const dependency = createWorkspaceTask({
      ...rootContext(created.id, created.revision),
      taskId: "policy-dependency",
      title: "Dependency",
    });
    const target = createWorkspaceTask({
      ...rootContext(created.id, created.revision + 1),
      taskId: "policy-target",
      title: "Target",
    });
    const before = getDb().query(
      "SELECT byte_count FROM agent_turn_workspaces WHERE workspace_id = ?",
    ).get(created.id) as { byte_count: number };
    const targetBefore = getDb().query(
      "SELECT byte_count, dependencies_json FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(target.id) as { byte_count: number; dependencies_json: string };
    const oldDependencyBytes = new TextEncoder().encode(targetBefore.dependencies_json).byteLength;
    const newDependencyBytes = new TextEncoder().encode(JSON.stringify([dependency.id])).byteLength;
    const delta = newDependencyBytes - oldDependencyBytes;
    expect(delta).toBeGreaterThan(0);

    getDb().query("UPDATE agent_turn_workspaces SET quota_bytes = ? WHERE workspace_id = ?")
      .run(before.byte_count + delta - 1, created.id);
    expectWorkspaceError("quota_exceeded", () => updateWorkspaceTaskPolicy({
      ...rootContext(created.id, 2),
      taskId: target.id,
      dependencyIds: [dependency.id],
    }));
    expect(getTurnWorkspace(rootContext(created.id, 2)).usage.byteCount).toBe(before.byte_count);
    expect(getDb().query(
      "SELECT dependencies_json, byte_count FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(target.id)).toEqual(targetBefore);

    getDb().query("UPDATE agent_turn_workspaces SET quota_bytes = ? WHERE workspace_id = ?")
      .run(before.byte_count + delta, created.id);
    const updated = updateWorkspaceTaskPolicy({
      ...rootContext(created.id, 2),
      taskId: target.id,
      dependencyIds: [dependency.id],
    });
    expect(updated.dependencyIds).toEqual([dependency.id]);
    expect(getDb().query(
      "SELECT dependencies_json, byte_count FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(target.id)).toEqual({
      dependencies_json: JSON.stringify([dependency.id]),
      byte_count: targetBefore.byte_count + delta,
    });
    expect(getTurnWorkspace(rootContext(created.id, 3)).usage.byteCount).toBe(before.byte_count + delta);
  });

  test("record admission repairs stale counters from current task rows", () => {
    const created = workspace("record-current-accounting");
    const task = createWorkspaceTask({
      ...rootContext(created.id, created.revision),
      taskId: "accounting-task",
      title: "Accounting task",
    });
    const taskRow = getDb().query(
      "SELECT byte_count FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(task.id) as { byte_count: number };
    const summary = "current accounting";
    const summaryBytes = new TextEncoder().encode(summary).byteLength;
    getDb().query(
      "UPDATE agent_turn_workspaces SET byte_count = 0, quota_bytes = ? WHERE workspace_id = ?",
    ).run(taskRow.byte_count + summaryBytes, created.id);

    const record = recordWorkspaceRecord({
      ...rootContext(created.id, 1),
      kind: "finding",
      summary,
      digest: "e".repeat(64),
      taskId: null,
    });
    expect(record.summary).toBe(summary);
    expect(getTurnWorkspace(rootContext(created.id, 2)).usage.byteCount)
      .toBe(taskRow.byte_count + summaryBytes);
  });
  test("submission and artifact admissions rebuild stale workspace byte counters", () => {
    const created = workspace("submission-artifact-current-accounting");
    const task = createWorkspaceTask({
      ...rootContext(created.id, created.revision),
      taskId: "submission-accounting-task",
      title: "Submission task",
      assignedFrameId: "child-frame",
    });
    const taskRow = getDb().query(
      "SELECT byte_count FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(task.id) as { byte_count: number };
    const summary = "submitted result";
    const submissionBytes = 7 + new TextEncoder().encode(summary).byteLength;
    getDb().query(
      "UPDATE agent_turn_workspaces SET byte_count = 0, quota_bytes = ? WHERE workspace_id = ?",
    ).run(taskRow.byte_count + submissionBytes, created.id);

    const submitted = submitWorkspaceChildResult({
      ...childContext(created.id, 1),
      taskId: task.id,
      summary,
      resultDigest: "f".repeat(64),
      byteCount: 7,
    });
    expect(submitted.state).toBe("completed");
    expect(getDb().query("SELECT state FROM agent_workspace_submissions WHERE task_id = ?").get(task.id)).toEqual({ state: "submitted" });
    expect(getTurnWorkspace(rootContext(created.id, 2)).usage.byteCount)
      .toBe(taskRow.byte_count + submissionBytes);

    const artifactBytes = 3;
    getDb().query(
      "UPDATE agent_turn_workspaces SET byte_count = 0, quota_bytes = ? WHERE workspace_id = ?",
    ).run(taskRow.byte_count + submissionBytes + artifactBytes, created.id);
    const artifact = attachWorkspaceArtifactReference({
      ...rootContext(created.id, 2),
      creatorToken: CREATOR_TOKEN,
      blobDigest: BLOB_DIGEST,
      byteCount: artifactBytes,
      mimeType: "text/plain",
      provenance: "root",
      taskId: null,
    });
    expect(artifact.byteCount).toBe(artifactBytes);
    expect(getTurnWorkspace(rootContext(created.id, 3)).usage.byteCount)
      .toBe(taskRow.byte_count + submissionBytes + artifactBytes);
  });

  test("assigns an accepted dependency batch atomically to exact child frames", () => {
    const created = workspace();
    const prerequisite = createWorkspaceTask({ ...rootContext(created.id, 0), taskId: "assignment-prerequisite", title: "Prerequisite", assignedFrameId: "prerequisite-frame" });
    const submitted = submitWorkspaceChildResult({ ...childContext(created.id, 1, "prerequisite-frame"), taskId: prerequisite.id, summary: "accepted prerequisite", resultDigest: "d".repeat(64), byteCount: 8 });
    const submissionRow = getDb().query("SELECT submission_id, state FROM agent_workspace_submissions WHERE task_id = ?").get(prerequisite.id) as { submission_id: string; state: string } | null;
    expect(submitted.state).toBe("completed");
    expect(submissionRow?.state).toBe("submitted");
    const accepted = acceptWorkspaceSubmission({ ...hostContext(created.id, 2), submissionId: submissionRow?.submission_id });
    expect(accepted.state).toBe("accepted");
    const dependent = createWorkspaceTask({ ...rootContext(created.id, 3), taskId: "assignment-dependent", title: "Dependent", dependencyIds: [prerequisite.id] });
    const independent = createWorkspaceTask({ ...rootContext(created.id, 4), taskId: "assignment-independent", title: "Independent" });
    const result = assignChildTasks({
      ...hostContext(created.id, 5),
      assignments: [
        { taskId: dependent.id, frameId: "child-frame-dependent" },
        { taskId: independent.id, frameId: "child-frame-independent" },
      ],
    });
    expect(result.workspaceRevision).toBe(6);
    expect(result.tasks.map((task) => [task.id, task.assignedFrameId])).toEqual([
      ["assignment-dependent", "child-frame-dependent"],
      ["assignment-independent", "child-frame-independent"],
    ]);
    expect(getTurnWorkspace({ ...rootContext(created.id, 6) }).revision).toBe(6);
    expectWorkspaceError("stale_revision", () => assignChildTasks({
      ...hostContext(created.id, 5),
      assignments: [{ taskId: dependent.id, frameId: "stale-frame" }],
    }));
  });

  test("rejects unaccepted dependencies and rolls back the complete assignment batch", () => {
    const created = workspace();
    const prerequisite = createWorkspaceTask({ ...rootContext(created.id, 0), taskId: "order-prerequisite", title: "Prerequisite" });
    const dependent = createWorkspaceTask({ ...rootContext(created.id, 1), taskId: "order-dependent", title: "Dependent", dependencyIds: [prerequisite.id] });
    expectWorkspaceError("dependency_cycle", () => assignChildTasks({
      ...hostContext(created.id, 2),
      assignments: [
        { taskId: prerequisite.id, frameId: "order-prerequisite-frame" },
        { taskId: dependent.id, frameId: "order-dependent-frame" },
      ],
    }));
    expect(getTurnWorkspace({ ...rootContext(created.id, 2) }).revision).toBe(2);
    const rows = getDb().query("SELECT task_id, assigned_frame_id FROM agent_workspace_tasks WHERE workspace_id = ? ORDER BY task_id").all(created.id) as Array<{ task_id: string; assigned_frame_id: string | null }>;
    expect(rows).toEqual([
      { task_id: "order-dependent", assigned_frame_id: null },
      { task_id: "order-prerequisite", assigned_frame_id: null },
    ]);
  });

  test("rejects missing, duplicate, already-assigned, and oversized assignment batches without mutation", () => {
    const created = workspace();
    const assigned = createWorkspaceTask({ ...rootContext(created.id, 0), taskId: "already-assigned", title: "Assigned", assignedFrameId: "existing-frame" });
    const open = createWorkspaceTask({ ...rootContext(created.id, 1), taskId: "open-assignment", title: "Open" });
    expectWorkspaceError("not_found", () => assignChildTasks({
      ...hostContext(created.id, 2),
      assignments: [
        { taskId: open.id, frameId: "open-frame" },
        { taskId: "missing-assignment", frameId: "missing-frame" },
      ],
    }));
    expectWorkspaceError("duplicate_id", () => assignChildTasks({
      ...hostContext(created.id, 2),
      assignments: [
        { taskId: open.id, frameId: "same-frame" },
        { taskId: assigned.id, frameId: "same-frame" },
      ],
    }));
    expectWorkspaceError("task_assignment_conflict", () => assignChildTasks({
      ...hostContext(created.id, 2),
      assignments: [{ taskId: assigned.id, frameId: "new-frame" }],
    }));
    expectWorkspaceError("quota_exceeded", () => assignChildTasks({
      ...hostContext(created.id, 2),
      assignments: Array.from({ length: WORKSPACE_MAX_TASK_ASSIGNMENTS + 1 }, (_, index) => ({ taskId: `oversized-${index}`, frameId: `oversized-frame-${index}` })),
    }));
    expect(getTurnWorkspace({ ...rootContext(created.id, 2) }).revision).toBe(2);
    expect(getTurnWorkspace({ ...rootContext(created.id, 2) }).state).toBe("active");
  });


  test("enforces UTF-8 objective and retention caps at cap plus one", () => {
    const objective = "😀".repeat(Math.floor(WORKSPACE_OBJECTIVE_MAX_BYTES / 4));
    const created = createTurnWorkspace({ userId: USER, chatId: CHAT, turnId: TURN, workspaceId: "utf8-workspace", objective, constraints: [], retention: "chat_lifetime", capabilities: { revision: 1, allowed: [], maxOperationBytes: 1, maxOperations: 1 } });
    expect(created.objective).toBe(objective);
    expectWorkspaceError("quota_exceeded", () => createTurnWorkspace({ userId: USER, chatId: CHAT, turnId: TURN, workspaceId: "utf8-too-large", objective: `${objective}😀`, constraints: [], retention: "chat_lifetime", capabilities: { revision: 1, allowed: [], maxOperationBytes: 1, maxOperations: 1 } }));
    expectWorkspaceError("invalid_input", () => createTurnWorkspace({ userId: USER, chatId: CHAT, turnId: TURN, workspaceId: "ttl-too-large", objective: "x", constraints: [], retention: "operational", ttlSeconds: WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS + 1, capabilities: { revision: 1, allowed: [], maxOperationBytes: 1, maxOperations: 1 } }));
  });

  test("accepts a child submission, freezes atomically, and rejects later writes", () => {
    const created = workspace();
    const task = createWorkspaceTask({ ...rootContext(created.id, 0), taskId: "required-task", title: "Child task", assignedFrameId: "child-frame" });
    const progressed = updateWorkspaceTaskProgress({ ...childContext(created.id, 1), taskId: task.id, state: "blocked", progress: 0.5 });
    expect(progressed.state).toBe("blocked");
    const submitted = submitWorkspaceChildResult({ ...childContext(created.id, 2), taskId: task.id, summary: "bounded child summary", resultDigest: "b".repeat(64), byteCount: 22 });
    expect(submitted.state).toBe("completed");
    const submissionRow = getDb().query("SELECT submission_id, state FROM agent_workspace_submissions WHERE task_id = ?").get(task.id) as { submission_id: string; state: string } | null;
    expect(submissionRow?.state).toBe("submitted");
    const accepted = acceptWorkspaceSubmission({ ...hostContext(created.id, 3), submissionId: submissionRow?.submission_id });
    expect(accepted.state).toBe("accepted");
    const frozen = freezeTurnWorkspace(rootContext(created.id, 4));
    expect(frozen.state).toBe("frozen");
    expectWorkspaceError("workspace_frozen", () => recordWorkspaceRecord({ ...rootContext(created.id, frozen.revision), kind: "finding", summary: "too late", digest: "c".repeat(64), taskId: null }));
  });
  test("rechecks persisted required tasks and pending submissions before the freeze CAS", () => {
    const created = workspace("completion-gate-race");
    const required = createWorkspaceTask({
      ...hostContext(created.id, 0),
      taskId: "completion-required",
      title: "Required completion task",
      required: true,
      assignedFrameId: "completion-child",
    });
    const blocked = freezeWorkspaceForCompletionV1(rootContext(created.id, 1));
    expect(blocked).toEqual({ workspaceRevision: 1, accepted: false });
    expect(getTurnWorkspace(rootContext(created.id, 1)).state).toBe("active");
    expect(getWorkspaceCompletionGatesV1(rootContext(created.id, 1)).openRequiredTaskIds).toEqual([required.id]);

    const submitted = submitWorkspaceChildResult({
      ...childContext(created.id, 1, "completion-child"),
      taskId: required.id,
      summary: "bounded completion result",
      resultDigest: "e".repeat(64),
      byteCount: 28,
    });
    expect(submitted.state).toBe("completed");
    expect(getDb().query("SELECT state FROM agent_workspace_submissions WHERE task_id = ?").get(required.id)).toEqual({ state: "submitted" });
    const pending = freezeWorkspaceForCompletionV1(rootContext(created.id, 2));
    expect(pending).toEqual({ workspaceRevision: 2, accepted: false });
    expect(getWorkspaceCompletionGatesV1(rootContext(created.id, 2)).pendingSubmissionCount).toBe(1);

    const submissionRow = getDb().query("SELECT submission_id FROM agent_workspace_submissions WHERE task_id = ?").get(required.id) as { submission_id: string } | null;
    acceptWorkspaceSubmission({ ...hostContext(created.id, 2), submissionId: submissionRow?.submission_id });
    const exactPreview = previewWorkspaceForCompletionV1(rootContext(created.id, 3));
    const accepted = freezeWorkspaceForCompletionV1(rootContext(created.id, 3), {
      prepare: (candidate) => (
        candidate.accepted === exactPreview.accepted
        && candidate.workspaceRevision === exactPreview.workspaceRevision
      ),
    });
    expect(accepted).toEqual({ workspaceRevision: 4, accepted: true });
    expect(getTurnWorkspace(rootContext(created.id, 4)).state).toBe("frozen");
  });
  test("blocked required tasks remain completion blockers without an accepted submission", () => {
    const created = workspace("completion-blocked-required");
    const required = createWorkspaceTask({
      ...hostContext(created.id, created.revision),
      taskId: "blocked-required-task",
      title: "Blocked required task",
      required: true,
      assignedFrameId: "blocked-required-child",
    });
    getDb().query("UPDATE agent_workspace_tasks SET state = 'blocked' WHERE task_id = ? AND workspace_id = ?").run(required.id, created.id);

    const gates = getWorkspaceCompletionGatesV1(rootContext(created.id, created.revision + 1));
    expect(gates).toMatchObject({
      accepted: false,
      openRequiredTaskIds: [required.id],
      pendingSubmissionCount: 0,
    });
    expect(previewWorkspaceForCompletionV1(rootContext(created.id, created.revision + 1))).toEqual({
      workspaceRevision: created.revision + 1,
      accepted: false,
    });
    expect(freezeWorkspaceForCompletionV1(rootContext(created.id, created.revision + 1))).toEqual({
      workspaceRevision: created.revision + 1,
      accepted: false,
    });
    expect(getTurnWorkspace(rootContext(created.id, created.revision + 1)).state).toBe("active");
  });

  test("previews immutable completion and rejects stale preparation", () => {
    const created = workspace("completion-preview");
    const preview = previewWorkspaceForCompletionV1(rootContext(created.id, 0));
    expect(Object.isFrozen(preview)).toBe(true);
    expect(preview).toEqual({ workspaceRevision: 1, accepted: true });
    const task = createWorkspaceTask({
      ...hostContext(created.id, 0),
      taskId: "preview-required",
      title: "Required after preview",
      required: true,
    });
    expect(task.id).toBe("preview-required");
    expectWorkspaceError("completion_preparation_failed", () => freezeWorkspaceForCompletionV1(
      rootContext(created.id, 1),
      {
        prepare: (candidate) => (
          candidate.accepted === preview.accepted
          && candidate.workspaceRevision === preview.workspaceRevision
        ),
      },
    ));
    expect(getTurnWorkspace(rootContext(created.id, 1)).state).toBe("active");
    const fresh = previewWorkspaceForCompletionV1(rootContext(created.id, 1));
    expect(fresh).toEqual({ workspaceRevision: 1, accepted: false });
    expect(freezeWorkspaceForCompletionV1(rootContext(created.id, 1))).toEqual(fresh);
    expect(getTurnWorkspace(rootContext(created.id, 1)).state).toBe("active");
  });

  test("persists only redacted workspace records and artifact references", () => {
    const created = workspace();
    const finding = recordWorkspaceRecord({ ...rootContext(created.id, 0), kind: "finding", summary: "bounded finding", digest: "c".repeat(64), taskId: null });
    expect(finding.summary).toBe("bounded finding");
    const artifact = attachWorkspaceArtifactReference({ ...rootContext(created.id, 1), blobDigest: BLOB_DIGEST, byteCount: 3, mimeType: "text/plain", provenance: "root", creatorToken: CREATOR_TOKEN, taskId: null });
    expect(artifact.blobDigest).toBe(BLOB_DIGEST);
    expectWorkspaceError("invalid_input", () => recordWorkspaceRecord({ ...rootContext(created.id, 2), kind: "finding", summary: "x", digest: "d".repeat(64), taskId: null, prose: "private work prose" }));
    const dbText = [getDb().query("SELECT * FROM agent_turn_workspaces").all(), getDb().query("SELECT * FROM agent_workspace_tasks").all(), getDb().query("SELECT * FROM agent_workspace_records").all(), getDb().query("SELECT * FROM agent_workspace_artifacts").all()].map((rows) => JSON.stringify(rows)).join("\n");
    expect(dbText).not.toContain("private work prose");
    expect(dbText).not.toContain("tool arguments");
    expect(getDb().query("SELECT record_id FROM agent_workspace_records WHERE record_id = ?").get(finding.id)).toBeTruthy();
    expect(getDb().query("SELECT artifact_id FROM agent_workspace_artifacts WHERE artifact_id = ?").get(artifact.id)).toBeTruthy();
  });
  test("closes cleanup-before-attach and attach-before-cleanup ordering", () => {
    const created = workspace("artifact-race-before");
    getDb().query("UPDATE agent_artifact_blob_journal SET state = 'removed' WHERE journal_id = ?").run("workspace-journal");
    expectWorkspaceError("not_found", () => attachWorkspaceArtifactReference({ ...rootContext(created.id, 0), blobDigest: BLOB_DIGEST, byteCount: 3, mimeType: "text/plain", provenance: "root", creatorToken: CREATOR_TOKEN, taskId: null }));

    getDb().query("UPDATE agent_artifact_blob_journal SET state = 'installed' WHERE journal_id = ?").run("workspace-journal");
    const artifact = attachWorkspaceArtifactReference({ ...rootContext(created.id, 0), blobDigest: BLOB_DIGEST, byteCount: 3, mimeType: "text/plain", provenance: "root", creatorToken: CREATOR_TOKEN, taskId: null });
    const claim = getDb().query(`UPDATE agent_artifact_blob_journal
      SET state = 'removed'
      WHERE journal_id = ? AND state = 'installed'
        AND NOT EXISTS (
          SELECT 1 FROM agent_workspace_artifacts
          WHERE user_id = ? AND blob_digest = ?
        )`).run("workspace-journal", USER, BLOB_DIGEST);
    expect(claim.changes).toBe(0);
    expect(getDb().query("SELECT artifact_id FROM agent_workspace_artifacts WHERE artifact_id = ?").get(artifact.id)).toBeTruthy();
    expect(getDb().query("SELECT state FROM agent_artifact_blob_journal WHERE journal_id = ?").get("workspace-journal")).toEqual({ state: "installed" });
  });
  test("rejects workspace artifact publication before a committed receipt", () => {
    const created = workspace("publish-receipt-required");
    const artifact = attachWorkspaceArtifactReference({
      ...rootContext(created.id, 0),
      blobDigest: BLOB_DIGEST,
      byteCount: 3,
      mimeType: "text/plain",
      provenance: "root",
      creatorToken: CREATOR_TOKEN,
      taskId: null,
    });
    proposeWorkspacePublication({ ...rootContext(created.id, 1), artifactId: artifact.id });
    const frozen = freezeTurnWorkspace(hostContext(created.id, 2));
    expectWorkspaceError("forbidden", () => publishWorkspaceArtifact({
      ...rootContext(created.id, frozen.revision),
      artifactId: artifact.id,
    }));
    expect(getDb().query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(artifact.id)).toEqual({ publication_state: "proposed" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE source_artifact_id = ?").get(artifact.id)).toEqual({ count: 0 });
  });

  test("attach-only artifacts stay ephemeral", () => {
    const attachedWorkspace = workspace("publish-attach-only");
    const attached = attachWorkspaceArtifactReference({
      ...rootContext(attachedWorkspace.id, 0),
      blobDigest: BLOB_DIGEST,
      byteCount: 3,
      mimeType: "text/plain",
      provenance: "root",
      taskId: null,
      creatorToken: CREATOR_TOKEN,
    });
    const attachedFrozen = freezeTurnWorkspace(hostContext(attachedWorkspace.id, 1));
    getDb().query(
      `INSERT INTO agent_turn_commit_receipts
        (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id,
         commit_key, idempotency_key, summary_digest, summary_json, artifact_ref_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("receipt-attach-only", TURN, TURN, attachedWorkspace.id, USER, CHAT, "commit-attach-only", "idempotency-attach-only", "c".repeat(64), "{}", 0);
    expectWorkspaceError("forbidden", () => publishWorkspaceArtifact({
      ...rootContext(attachedWorkspace.id, attachedFrozen.revision),
      artifactId: attached.id,
      receiptId: "receipt-attach-only",
    }));
    expect(getDb().query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(attached.id)).toEqual({ publication_state: "attached" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE source_artifact_id = ?").get(attached.id)).toEqual({ count: 0 });
  });

  test("rejects exported publication of proposed artifacts", () => {
    const proposedWorkspace = workspace("publish-explicit-proposal");
    const proposed = attachWorkspaceArtifactReference({
      ...rootContext(proposedWorkspace.id, 0),
      blobDigest: BLOB_DIGEST,
      byteCount: 3,
      mimeType: "text/plain",
      provenance: "root",
      taskId: null,
      creatorToken: CREATOR_TOKEN,
    });
    proposeWorkspacePublication({ ...rootContext(proposedWorkspace.id, 1), artifactId: proposed.id });
    const proposedFrozen = freezeTurnWorkspace(hostContext(proposedWorkspace.id, 2));
    expectWorkspaceError("forbidden", () => publishWorkspaceArtifact({
      ...rootContext(proposedWorkspace.id, proposedFrozen.revision),
      artifactId: proposed.id,
      receiptId: "receipt-explicit-proposal",
    }));
    expect(getDb().query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(proposed.id)).toEqual({ publication_state: "proposed" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE source_artifact_id = ?").get(proposed.id)).toEqual({ count: 0 });
  });

  test("publishes a frozen workspace artifact through canonical commit and permits exact replay", () => {
    const created = workspace("publish-receipt-valid");
    const artifact = attachWorkspaceArtifactReference({
      ...rootContext(created.id, 0),
      blobDigest: BLOB_DIGEST,
      byteCount: 3,
      mimeType: "text/plain",
      provenance: "root",
      taskId: null,
      creatorToken: CREATOR_TOKEN,
    });
    proposeWorkspacePublication({ ...rootContext(created.id, 1), artifactId: artifact.id });
    const frozen = freezeTurnWorkspace(hostContext(created.id, 2));
    getDb().query(
      `INSERT INTO agent_turn_commit_receipts
        (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id,
         commit_key, idempotency_key, summary_digest, summary_json, artifact_ref_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("receipt-publish-valid", TURN, TURN, created.id, USER, CHAT, "commit-publish-valid", "idempotency-publish-valid", "b".repeat(64), "{}", 1);
    getDb().transaction(() => publishArtifactCommit(getDb(), {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      executionId: TURN,
      workspaceId: created.id,
      commitKey: "commit-publish-valid",
      receiptId: "receipt-publish-valid",
      targetMessageId: null,
      targetSwipeId: null,
      refs: [{
        digest: BLOB_DIGEST,
        byteCount: 3,
        mimeType: "text/plain",
        provenance: "root",
        retention: "chat_lifetime",
        messageId: null,
        swipeId: null,
        workspaceArtifactId: artifact.id,
      }],
      assertFence: () => {},
    }))();
    expect(getDb().query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(artifact.id)).toEqual({ publication_state: "published" });
    expect(publishWorkspaceArtifact({
      ...rootContext(created.id, frozen.revision),
      artifactId: artifact.id,
      receiptId: "receipt-publish-valid",
    }).publicationState).toBe("published");
    expectWorkspaceError("forbidden", () => publishWorkspaceArtifact({
      ...rootContext(created.id, frozen.revision),
      artifactId: artifact.id,
      receiptId: "receipt-publish-wrong",
    }));
  });

  test("publishes distinct operational objective selections at one source revision", () => {
    insertTurnExecution(TURN_A, "workspace-generation-a", "workspace-commit-a");
    insertTurnExecution(TURN_B, "workspace-generation-b", "workspace-commit-b");
    insertTurnAttempt(TURN_A);
    insertTurnAttempt(TURN_B);
    const operationalA = workspace("operational-objective-a", TURN_A, "Objective A");
    const operationalB = workspace("operational-objective-b", TURN_B, "Objective B");
    const persistent = createPersistentWorkspace({
      userId: USER,
      chatId: CHAT,
      workspaceId: "stable-objective-workspace",
      objective: "Stable objective",
    });
    const sessionA = createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: persistent.id,
      turnSessionId: "objective-session-a",
      turnId: TURN_A,
      attemptId: TURN_A,
      executionId: TURN_A,
      expectedRevision: persistent.revision,
    });
    const sessionB = createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: persistent.id,
      turnSessionId: "objective-session-b",
      turnId: TURN_B,
      attemptId: TURN_B,
      executionId: TURN_B,
      expectedRevision: persistent.revision,
    });
    const first = publishPersistentWorkspaceSelection(
      persistentPublicationInput(persistent.id, persistent.revision, "objective", operationalA.id, 0),
    );
    const second = publishPersistentWorkspaceSelection(
      persistentPublicationInput(persistent.id, first.revision, "objective", operationalB.id, 0),
    );
    expect(first.sourceId).toBe(operationalA.id);
    expect(first.sourceRevision).toBe(0);
    expect(first.sourceProvenance.turnSessionId).toBe(sessionA.id);
    expect(first.copy).toMatchObject({ category: "objective", id: operationalA.id, objective: "Objective A" });
    expect(second.sourceId).toBe(operationalB.id);
    expect(second.sourceRevision).toBe(0);
    expect(second.sourceProvenance.turnSessionId).toBe(sessionB.id);
    expect(second.copy).toMatchObject({ category: "objective", id: operationalB.id, objective: "Objective B" });
    expect(first.id).not.toBe(second.id);
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?").get(persistent.id)).toEqual({ count: 2 });
  });
  test("publishes turn-scoped sources through stable workspace sessions", () => {
    insertTurnExecution(TURN_A, "workspace-generation-a", "workspace-commit-a");
    insertTurnExecution(TURN_B, "workspace-generation-b", "workspace-commit-b");
    insertTurnAttempt(TURN_A);
    insertTurnAttempt(TURN_B);
    const operationalA = workspace("operational-turn-a", TURN_A);
    const operationalB = workspace("operational-turn-b", TURN_B);
    const persistent = createPersistentWorkspace({
      userId: USER,
      chatId: CHAT,
      workspaceId: "stable-two-turn-workspace",
      objective: "Stable workspace",
    });
    const sessionA = createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: persistent.id,
      turnSessionId: "stable-turn-session-a",
      turnId: TURN_A,
      attemptId: TURN_A,
      executionId: TURN_A,
      expectedRevision: persistent.revision,
    });
    const sessionB = createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: persistent.id,
      turnSessionId: "stable-turn-session-b",
      turnId: TURN_B,
      attemptId: TURN_B,
      executionId: TURN_B,
      expectedRevision: persistent.revision,
    });
    insertOperationalTask(operationalA.id, "stable-turn-task-a", TURN_A);
    insertOperationalTask(operationalB.id, "stable-turn-task-b", TURN_B);

    const first = publishPersistentWorkspaceSelection(
      persistentPublicationInput(persistent.id, persistent.revision, "task", "stable-turn-task-a", 4),
    );
    const second = publishPersistentWorkspaceSelection(
      persistentPublicationInput(persistent.id, first.revision, "task", "stable-turn-task-b", 4),
    );
    expect(first.sourceProvenance.turnSessionId).toBe(sessionA.id);
    expect(second.sourceProvenance.turnSessionId).toBe(sessionB.id);
    expect(first.copy).toMatchObject({ category: "task", id: "stable-turn-task-a" });
    expect(second.copy).toMatchObject({ category: "task", id: "stable-turn-task-b" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?").get(persistent.id)).toEqual({ count: 2 });
  });


  test("publishes an exact operational task revision", () => {
    const fixture = persistentFixture("publication-task");
    insertOperationalTask(fixture.persistent.id);
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", "publication-task", 4),
    );
    expect(publication.copy).toMatchObject({ category: "task", id: "publication-task", title: "Published task", objective: "Task objective", summary: "Task summary" });
    expect(publication.sourceCreatedAt).toBe(10);
    expect(publication.sourceUpdatedAt).toBe(20);
    expect(publication.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("publishes an exact operational finding revision and excludes submission-shaped content", () => {
    const fixture = persistentFixture("publication-finding");
    insertOperationalFinding(fixture.persistent.id);
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", "publication-finding", 3),
    );
    expect(publication.copy).toMatchObject({
      category: "finding",
      id: "publication-finding",
      content: { summary: "Published finding", evidenceIds: [], provenance: "frame-publication" },
    });
    expect(publication.sourceCreatedAt).toBe(11);
    expect(publication.sourceUpdatedAt).toBe(11);
    expect(JSON.stringify(publication.copy)).not.toContain("submission");
  });

  test("publishes an exact operational artifact revision with blob provenance", () => {
    const fixture = persistentFixture("publication-artifact");
    insertOperationalArtifact(fixture.persistent.id);
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "publication-artifact", 5),
    );
    expect(publication.copy).toMatchObject({ category: "artifact", id: "publication-artifact", blobDigest: BLOB_DIGEST, mimeType: "text/plain", byteCount: 3 });
    expect(publication.sourceCreatedAt).toBe(12);
    expect(publication.sourceUpdatedAt).toBe(22);
    expect(publication.sourceDigest).toBe(BLOB_DIGEST);
  });
  test("acquires one blob reference for an artifact copy and keeps idempotent replay at one", () => {
    const fixture = persistentFixture("publication-artifact-refcount");
    insertOperationalArtifact(fixture.persistent.id, "publication-artifact-refcount-source");
    const input = persistentPublicationInput(
      fixture.persistent.id,
      fixture.persistent.revision,
      "artifact",
      "publication-artifact-refcount-source",
      5,
    );
    const first = publishPersistentWorkspaceSelection(input);
    expect(first.copy).toMatchObject({ category: "artifact", blobDigest: BLOB_DIGEST });
    expect(getDb().query("SELECT published_reference_count FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 1 });
    const second = publishPersistentWorkspaceSelection(input);
    expect(second.id).toBe(first.id);
    expect(getDb().query("SELECT published_reference_count FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 1 });
  });
  test("deletes an artifact publication without deleting its retained blob bytes", () => {
    const fixture = persistentFixture("publication-artifact-delete");
    insertOperationalArtifact(fixture.persistent.id, "publication-artifact-delete-source");
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "publication-artifact-delete-source", 5),
    );
    const deleted = deletePersistentWorkspacePublication({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: 1,
      publicationId: publication.id,
    });
    expect(deleted).toMatchObject({ id: fixture.persistent.id, revision: 2, chatId: CHAT });
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?").get(fixture.persistent.id)).toEqual({ count: 0 });
    expect(getDb().query("SELECT published_reference_count, storage_path FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 0, storage_path: artifactPath });
    expect(statSync(artifactPath).size).toBe(ARTIFACT_BYTES.length);
  });

  test("deletes a workspace as an owner-scoped authority and releases publication references", () => {
    const fixture = persistentFixture("workspace-delete-authority");
    insertOperationalArtifact(fixture.persistent.id, "workspace-delete-artifact-source");
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "workspace-delete-artifact-source", 5),
    );
    const current = getPersistentWorkspaceForChat({ userId: USER, chatId: CHAT });
    const deleted = deletePersistentWorkspace({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: current.revision,
    });
    expect(deleted).toEqual({ workspaceId: fixture.persistent.id, deleted: true, publicationCount: 1 });
    expect(getDb().query("SELECT 1 FROM persistent_workspaces WHERE workspace_id = ?").get(fixture.persistent.id)).toBeNull();
    expect(getDb().query("SELECT published_reference_count, storage_path FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 0, storage_path: artifactPath });
    expect(statSync(artifactPath).size).toBe(ARTIFACT_BYTES.length);
    expect(publication.copy).toMatchObject({ category: "artifact", blobDigest: BLOB_DIGEST });
  });

  test("rejects an artifact copy when its immutable bytes are missing", () => {
    const fixture = persistentFixture("publication-artifact-missing-bytes");
    insertOperationalArtifact(fixture.persistent.id, "publication-artifact-missing-source");
    rmSync(artifactPath, { force: true });
    expect(() => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "publication-artifact-missing-source", 5),
    )).toThrow();
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?").get(fixture.persistent.id)).toEqual({ count: 0 });
    expect(getDb().query("SELECT published_reference_count FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 0 });
  });

  test("rejects submission and unknown publication categories", () => {
    const fixture = persistentFixture("publication-category-rejection");
    expectWorkspaceError("invalid_input", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "submission", "submission-1"),
    ));
    expectWorkspaceError("invalid_input", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "transcript", "transcript-1"),
    ));
  });

  test("rejects stale source revisions and owner/session mismatches", () => {
    const fixture = persistentFixture("publication-association");
    insertOperationalTask(fixture.persistent.id, "publication-association-task");
    expectWorkspaceError("stale_revision", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", "publication-association-task", 3),
    ));
    expectWorkspaceError("not_found", () => publishPersistentWorkspaceSelection({
      ...persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", "publication-association-task", 4),
      actor: { kind: "owner" as const, userId: OTHER_USER },
      userId: OTHER_USER,
    }));
    getDb().query("UPDATE agent_workspace_tasks SET turn_id = ? WHERE task_id = ?").run(OTHER_TURN, "publication-association-task");
    expectWorkspaceError("not_found", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", "publication-association-task", 4),
    ));
  });

  test("replays the same publication idempotently without a second content row", () => {
    const fixture = persistentFixture("publication-idempotency");
    insertOperationalFinding(fixture.persistent.id, "publication-idempotent-finding");
    const first = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", "publication-idempotent-finding", 3),
    );
    const second = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", "publication-idempotent-finding", 3),
    );
    expect(second.id).toBe(first.id);
    expect(second.copy).toEqual(first.copy);
    expect(second.sourceProvenance).toEqual(first.sourceProvenance);
    expect(getDb().query("SELECT revision FROM persistent_workspaces WHERE workspace_id = ?").get(fixture.persistent.id)).toEqual({ revision: 1 });
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?").get(fixture.persistent.id)).toEqual({ count: 1 });
    insertOperationalTask(fixture.persistent.id, "publication-idempotent-task");
    expectWorkspaceError("stale_revision", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", "publication-idempotent-task", 4),
    ));
  });

  test("keeps owner ad-hoc tasks optional and requires opaque host authority for admission", () => {
    const fixture = persistentFixture("persistent-task-authority");
    const ownerScope = {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
    };
    const optional = createPersistentWorkspaceTask(ownerScope, {
      id: "owner-optional-task",
      title: "Optional owner task",
      objective: "Owner-provided bounded work",
      required: false,
    });
    const current = getPersistentWorkspaceForChat({ userId: USER, chatId: CHAT });
    expect(optional).toMatchObject({ required: false, creator: "owner", hostAdmitted: false });
    expectWorkspaceError("forbidden", () => createPersistentWorkspaceTask(
      { ...ownerScope, expectedRevision: optional.revision + 1 },
      { title: "Required without host", required: true },
    ));
    expectWorkspaceError("invalid_input", () => createPersistentWorkspaceTask(
      { ...ownerScope, expectedRevision: optional.revision },
      { title: "Forged host task", required: true, creator: "host", hostAdmitted: true } as unknown,
    ));

    const authority = createPersistentWorkspaceHostAuthority();
    expect(Object.isFrozen(authority)).toBe(true);
    expectWorkspaceError("forbidden", () => createPersistentWorkspaceHostTask(
      JSON.parse(JSON.stringify(authority)),
      {
        ...ownerScope,
        expectedRevision: optional.revision,
        title: "Cloned authority",
        required: true,
      },
    ));
    const admitted = createPersistentWorkspaceHostTask(authority, {
      ...ownerScope,
      expectedRevision: current.revision,
      id: "host-required-task",
      title: "Host-required task",
      required: true,
    });
    expect(admitted).toMatchObject({ required: true, creator: "host", hostAdmitted: true });
  });

  test("derives publication attribution from the authenticated actor", () => {
    const fixture = persistentFixture("publication-attribution");
    insertOperationalFinding(fixture.persistent.id, "publication-owner-finding", "Owner finding");
    const ownerPublication = publishPersistentWorkspaceSelection(
      { kind: "owner", userId: USER },
      {
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        expectedRevision: fixture.persistent.revision,
        category: "finding",
        sourceId: "publication-owner-finding",
        sourceRevision: 3,
      },
    );
    expect(ownerPublication.publishedBy).toBe(`owner:${USER}`);
    expect(ownerPublication.sourceProvenance.creator).toBe(`owner:${USER}`);
    expectWorkspaceError("invalid_input", () => publishPersistentWorkspaceSelection({
      ...persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", "publication-owner-finding", 3),
      publishedBy: "attacker",
    } as unknown));

    insertOperationalFinding(fixture.persistent.id, "publication-host-finding", "Host finding");
    const hostPublication = publishPersistentWorkspaceSelection(
      { kind: "host", authority: createPersistentWorkspaceHostAuthority() },
      {
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        expectedRevision: ownerPublication.revision,
        category: "finding",
        sourceId: "publication-host-finding",
        sourceRevision: 3,
      },
    );
    expect(hostPublication.publishedBy).toBe("host");
    expect(hostPublication.sourceProvenance.creator).toBe("host");
  });

  test("reads an immutable publication after deleting its source message, swipe, source, and chat", () => {
    const sourceMessageId = "publication-deletion-message";
    getDb().query(
      "INSERT INTO messages (id, chat_id, index_in_chat, content, swipe_id, swipes) VALUES (?, ?, 0, ?, 0, ?)",
    ).run(sourceMessageId, CHAT, "Published source message", JSON.stringify(["Published source swipe"]));
    getDb().query(
      "UPDATE agent_turn_executions SET target_message_id = ?, target_swipe_id = 0 WHERE id = ?",
    ).run(sourceMessageId, TURN);
    const fixture = persistentFixture("publication-deletion-survival", {
      targetMessageId: sourceMessageId,
      targetSwipeId: 0,
    });
    insertOperationalArtifact(fixture.persistent.id, "publication-deletion-artifact");
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "publication-deletion-artifact", 5),
    );
    expect(publication.sourceProvenance).toMatchObject({ sourceMessageId, sourceSwipeId: 0 });

    getDb().query(
      "UPDATE agent_turn_executions SET target_message_id = NULL, target_swipe_id = NULL WHERE id = ?",
    ).run(TURN);
    getDb().query("UPDATE messages SET swipes = '[]' WHERE id = ?").run(sourceMessageId);
    getDb().query("DELETE FROM messages WHERE id = ?").run(sourceMessageId);
    getDb().query("DELETE FROM agent_workspace_artifacts WHERE artifact_id = ?").run("publication-deletion-artifact");
    getDb().query("DELETE FROM chats WHERE id = ?").run(CHAT);
    expect(getDb().query("PRAGMA foreign_key_check").all()).toEqual([]);

    const listed = listPersistentWorkspacePublications({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: 1,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(publication.id);
    expect(listed[0]?.sourceStatus).toBe("deleted");
    expect(listed[0]?.copy).toEqual(publication.copy);
    expect(listed[0]?.sourceDeletedAt).toEqual(expect.any(Number));
    expect(listed[0]?.sourceProvenance).toMatchObject({
      sourceChatId: CHAT,
      sourceMessageId,
      sourceSwipeId: 0,
      sourceDeletedAt: listed[0]?.sourceDeletedAt,
    });
    expect(getPersistentWorkspace({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: 1,
    })).toMatchObject({ id: fixture.persistent.id, chatId: null, state: "archived" });
    expectWorkspaceError("not_found", () => createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      turnSessionId: "detached-session",
      turnId: TURN,
      attemptId: TURN,
      expectedRevision: 1,
    }));
    expect(getDb().query(
      "SELECT published_reference_count, storage_path FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?",
    ).get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 1, storage_path: artifactPath });
    expect(statSync(artifactPath).size).toBe(ARTIFACT_BYTES.length);
  });
  test("keeps one stable workspace per owner chat across concurrent host admissions", async () => {
    const admissions = await Promise.all(
      Array.from({ length: 8 }, (_, index) => Promise.resolve().then(() => (
        index === 0
          ? ensurePersistentWorkspaceForChat({
            userId: USER,
            chatId: CHAT,
            workspaceId: "chat-stable-workspace",
            objective: "Stable chat workspace",
          })
          : ensurePersistentWorkspaceHost(createPersistentWorkspaceHostAuthority(), {
            userId: USER,
            chatId: CHAT,
            objective: `turn ${index}`,
          })
      ))),
    );
    expect(new Set(admissions.map((workspace) => workspace.id))).toEqual(new Set(["chat-stable-workspace"]));
    expect(admissions.every((workspace) => workspace.chatId === CHAT)).toBe(true);
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspaces WHERE user_id = ? AND chat_id = ?").get(USER, CHAT)).toEqual({ count: 1 });
    expect(ensurePersistentWorkspaceForChat({
      userId: USER,
      chatId: CHAT,
      objective: "A later turn cannot replace the stable objective",
    })).toMatchObject({
      id: "chat-stable-workspace",
      objective: "Stable chat workspace",
    });
  });

  test("keeps persistent identity and reads fenced to the authenticated owner and chat", () => {
    const fixture = persistentFixture("persistent-scope-fence");
    expect(getPersistentWorkspaceById({ userId: USER, workspaceId: fixture.persistent.id }).id).toBe(fixture.persistent.id);
    expectWorkspaceError("not_found", () => getPersistentWorkspaceById({
      userId: OTHER_USER,
      workspaceId: fixture.persistent.id,
    }));
    expectWorkspaceError("not_found", () => getPersistentWorkspace({
      userId: USER,
      chatId: OTHER_CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
    }));
    expectWorkspaceError("not_found", () => getPersistentWorkspace({
      userId: USER,
      chatId: CHAT,
      workspaceId: "persistent-scope-missing",
      expectedRevision: fixture.persistent.revision,
    }));
  });

  test("terminal turn sessions are monotonic, immutable, and idempotent", () => {
    const fixture = persistentFixture("persistent-terminal-session");
    const authority = createPersistentWorkspaceHostAuthority();
    const running = updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
      turnSessionId: fixture.session.id,
      phase: "WORK",
      status: "running",
    });
    expect(running).toMatchObject({ phase: "WORK", status: "running", outcome: null, revision: 1, terminalAt: null });

    const terminal = updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
      turnSessionId: fixture.session.id,
      phase: "TERMINAL",
      status: "terminal",
      outcome: "completed",
    });
    expect(terminal).toMatchObject({ phase: "TERMINAL", status: "terminal", outcome: "completed", revision: 2 });
    expect(terminal.terminalAt).toEqual(expect.any(Number));
    expect(Object.isFrozen(terminal)).toBe(true);

    const replay = updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
      turnSessionId: fixture.session.id,
      phase: "TERMINAL",
      status: "terminal",
      outcome: "completed",
    });
    expect(replay).toEqual(terminal);
    expectWorkspaceError("invalid_state", () => updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
      turnSessionId: fixture.session.id,
      phase: "TERMINAL",
      status: "terminal",
      outcome: "failed",
    }));
    expectWorkspaceError("invalid_state", () => updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
      turnSessionId: fixture.session.id,
      phase: "WORK",
      status: "running",
    }));
    expect(getDb().query(
      "SELECT phase, status, outcome, revision FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
    ).get(fixture.session.id)).toEqual({
      phase: "TERMINAL",
      status: "terminal",
      outcome: "completed",
      revision: 2,
    });
  });

  test("keeps publication provenance and copies immutable after publication", () => {
    const fixture = persistentFixture("persistent-publication-immutability");
    insertOperationalFinding(fixture.persistent.id, "immutable-publication-finding", "Immutable published finding");
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", "immutable-publication-finding", 3),
    );
    expect(Object.isFrozen(publication)).toBe(true);
    expect(Object.isFrozen(publication.copy)).toBe(true);
    expect(publication.sourceProvenance).toMatchObject({
      workspaceId: fixture.persistent.id,
      turnSessionId: fixture.session.id,
      attemptId: TURN,
      sourceChatId: CHAT,
      sourceMessageId: null,
      sourceSwipeId: null,
      sourceDeletedAt: null,
      creator: `owner:${USER}`,
    });
    expect(publication.sourceStatus).toBe("present");
    expect(() => getDb().query(
      "UPDATE persistent_workspace_publications SET published_by = ? WHERE publication_id = ?",
    ).run("attacker", publication.id)).toThrow(/immutable/);
    expect(getDb().query(
      "SELECT published_by, copy_digest, revision FROM persistent_workspace_publications WHERE publication_id = ?",
    ).get(publication.id)).toEqual({
      published_by: `owner:${USER}`,
      copy_digest: publication.copyDigest,
      revision: 1,
    });
  });

  test("does not expose direct session mutation helpers or accept forged host authority", () => {
    expect(Object.hasOwn(workspaceService, "createPersistentWorkspaceTurnSession")).toBe(false);
    expect(Object.hasOwn(workspaceService, "updatePersistentWorkspaceTurnSession")).toBe(false);
    const fixture = persistentFixture("persistent-authority-surface");
    const authority = createPersistentWorkspaceHostAuthority();
    expectWorkspaceError("forbidden", () => createPersistentWorkspaceHostTurnSession(
      JSON.parse(JSON.stringify(authority)),
      {
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        turnSessionId: "forged-session",
        turnId: "forged-turn",
        attemptId: "forged-attempt",
        expectedRevision: fixture.persistent.revision,
      },
    ));
  });
});
