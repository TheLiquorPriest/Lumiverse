import type { Database } from "bun:sqlite";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { env } from "../env";
import { getDb } from "../db/connection";
import { eventBus, type BufferedEvent } from "../ws/bus";
import { EventType } from "../ws/events";
import {
  persistTerminalAgentActivityRunInTransaction,
  type PersistAgentActivityRunInput,
} from "./agent-activity-runs.service";
import {
  AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1,
  requestDormantTurnCancellation,
  type TurnCancellationResult,
  type TurnCommitReceipt,
  type TurnExecutionRecord,
} from "./turn-execution.service";
import type {
  AgentActivityNodeV2,
  AgentActivityNodeKindV2,
  AgentActivityNodeActorV2,
  AgentActivityNodeStatusV2,
  AgentActivityUsageV2,
  AgentOmissionMarkerV2,
  AgentRunChangeEventV2,
  AgentRunChangesV2,
  AgentRunGenerationTypeV1,
  AgentRunPublicStatusV2,
  AgentRunPublicV2,
  AgentRunStopResponseV2,
  AgentRunStopResultV2,
  AgentRunTargetV1,
  AgentTerminalHandoffV2,
  AgentWorkspaceEntryPreviewV2,
  AgentWorkspaceIndexV2,
  AgentWorkspacePreviewV2,
  AgentWorkspaceRetentionV2,
  AgentWorkspaceSectionIdV2,
  AgentWorkspaceVisibilityV2,
  ChatRunCursorV1,
} from "../types/agent-run-projection";
const AGENT_RUN_CHANGED = "AGENT_RUN_CHANGED" as EventType;

const encoder = new TextEncoder();
const MAX_ID_BYTES = 256;
const MAX_NODE_ID_BYTES = 256;
const MAX_PROFILE_BYTES = 128;
const MAX_TOOL_BYTES = 128;
const MAX_NODES = 128;
const MAX_EVENTS = 128;
const MAX_RUNS = 16;
const MAX_WORKSPACE_ENTRIES = 64;
const MAX_CURSOR_BYTES = 2048;
const CURSOR_TTL_SECONDS = 5 * 60;
const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_RECONCILIATION_ROWS = 256;
const TERMINAL_STATUS_SQL = "'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT'";
const SWIPE_EXPIRY_THRESHOLD = 100_000_000_000;
const TERMINAL_OUTBOX_LEASE_SECONDS = 30;
const TERMINAL_OUTBOX_PROCESS_ID = randomUUID();
const MAX_EMITTED_EVENT_KEYS = 2048;
const MAX_OUTBOX_REPLAY_BATCHES = 256;

function expiryToMilliseconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  // Execution rows use milliseconds. Accept legacy second-based rows as well:
  // values below this threshold cannot represent a contemporary millisecond
  // timestamp and are interpreted as Unix seconds.
  return value < SWIPE_EXPIRY_THRESHOLD ? value * 1000 : value;
}

function isExpiredAt(value: unknown, now = Date.now()): boolean {
  const expiresAt = expiryToMilliseconds(value);
  return expiresAt !== null && expiresAt <= now;
}

const PUBLIC_STATUSES = new Set<AgentRunPublicStatusV2>([
  "ASSEMBLE", "WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING",
  "COMMITTED", "COMMIT_FAILED", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT",
]);
const LIFECYCLE_STATUS_MAP: Readonly<Record<string, AgentRunPublicStatusV2>> = Object.freeze({
  queued: "ASSEMBLE",
  running: "WORK",
  completed: "COMMITTED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  timed_out: "TIMED_OUT",
});
const GENERATION_TYPES = new Set<AgentRunGenerationTypeV1>([
  "normal", "continue", "regenerate", "swipe",
]);
const TERMINAL_STATUSES = new Set<AgentRunPublicStatusV2>([
  "COMMITTED", "COMMIT_FAILED", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT",
]);
const PUBLIC_ERROR_CODES: ReadonlySet<string> = new Set([
  "capacity_exceeded",
  "host_child_admission_limit_exceeded",
  "host_tool_call_limit_exceeded",
  "child_admission_limit_exceeded",
  "tool_call_limit_exceeded",
  "logical_provider_request_limit_exceeded",
  "physical_dispatch_attempt_limit_exceeded",
  "child_output_token_limit_exceeded",
  "root_wall_clock_limit_exceeded",
  "activity_event_limit_exceeded",
  "activity_byte_limit_exceeded",
  "lifecycle_log_record_limit_exceeded",
  "context_limit_exceeded",
  "initial_input_limit_exceeded",
  "argument_limit_exceeded",
  "result_limit_exceeded",
  "continuation_limit_exceeded",
  "retained_output_limit_exceeded",
  "materialized_limit_exceeded",
  "timeout",
  "cancelled",
  "provider_unavailable",
  "provider_unsupported",
  "provider_tool_calling_unsupported",
  "provider_tool_continuation_unsupported",
  "provider_tool_finalization_unsupported",
  "provider_request_error",
  "provider_protocol_error",
  "provider_schema_error",
  "invalid_task",
  "invalid_profile",
  "invalid_arguments",
  "batch_rejected",
  "unknown_tool",
  "unauthorized",
  "integrity_error",
  "internal_error",
  "decision_refresh_required",
  "requires_response_mode",
  "invalid_input",
  "limit_exceeded",
  "queue_full",
  "worker_disabled",
  "worker_unavailable",
  "worker_crashed",
  "worker_timed_out",
  "worker_malformed",
] as const);
const TOO_LATE_STATUSES = new Set<AgentRunPublicStatusV2>([
  "COMMITTING", "COMMITTED",
]);
const NODE_KINDS = new Set<AgentActivityNodeKindV2>(["root", "provider", "child", "tool"]);
const NODE_ACTORS = new Set<AgentActivityNodeActorV2>(["root", "provider", "child", "tool"]);
const NODE_STATUSES = new Set<AgentActivityNodeStatusV2>([
  "pending", "running", "completed", "failed", "cancelled", "timed_out", "omitted",
]);
const WORKSPACE_SECTIONS: readonly AgentWorkspaceSectionIdV2[] = [
  "objective", "tasks", "records", "submissions", "artifacts",
];
const RETENTIONS = new Set<AgentWorkspaceRetentionV2>([
  "operational", "turn_terminal", "chat_lifetime",
]);
const VISIBILITIES = new Set<AgentWorkspaceVisibilityV2>([
  "owner", "participants", "public",
]);

export interface AgentRunProjectionInputV2 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly generationId: string;
  readonly generationType: AgentRunGenerationTypeV1;
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
  readonly status: AgentRunPublicStatusV2;
  readonly revision?: number;
  readonly startedAt?: number;
  readonly updatedAt?: number;
  readonly activity?: unknown;
  readonly usage?: unknown;
  readonly error?: { readonly code?: unknown; readonly retryable?: unknown } | null;
  readonly terminalHandoff?: Partial<AgentTerminalHandoffV2> | null;
  readonly omission?: Partial<AgentOmissionMarkerV2> | null;
  /** Optional already-redacted V1 activity input for compatibility storage. */
  readonly compatibilitySnapshot?: unknown;
  /** Internal receipt repair may replace a stale non-committed terminal projection. */
  readonly receiptRepair?: boolean;
  /** Startup terminalization may replace a stale terminal snapshot atomically. */
  readonly recoveryRepair?: boolean;
}

export interface AgentRunProjectionCommitResult {
  readonly run: AgentRunPublicV2;
  readonly sequence: number;
  readonly revision: number;
  readonly event: BufferedEvent;
  readonly changed?: boolean;
}

interface StoredProjectionRow {
  readonly user_id: string;
  readonly chat_id: string;
  readonly turn_id: string;
  readonly generation_id: string;
  readonly generation_type: string;
  readonly target_message_id: string | null;
  readonly target_swipe_id: number | null;
  readonly status: string;
  readonly phase: string;
  readonly revision: number;
  readonly sequence: number;
  readonly started_at: number;
  readonly updated_at: number;
  readonly snapshot_json: string;
  readonly terminal_handoff_json: string | null;
  readonly omission_json: string;
}

interface StoredEventRow {
  readonly sequence: number;
  readonly turn_id: string;
  readonly run_revision: number;
  readonly status: string;
  readonly snapshot_json: string;
  readonly terminal_handoff_json: string | null;
  readonly omission_json: string;
}

interface CursorClaims {
  readonly v: 1;
  readonly u: string;
  readonly c: string;
  readonly s: number;
  readonly e: number;
  /** Full-resync run-page offset. Presence keeps the token in resync mode. */
  readonly p?: number;
}

export interface AgentRunStopContextV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly generationId: string;
}

export type AgentRunStopHandler = (context: AgentRunStopContextV1) => AgentRunStopResultV2;

/** Raised when durable cancellation cannot be proven for a nonterminal execution. */
export class AgentRunStopUnavailableError extends Error {
  readonly code = "live_cancellation_unavailable" as const;

  constructor(turnId: string) {
    super(`live cancellation handler is not registered for ${turnId}`);
    this.name = "AgentRunStopUnavailableError";
  }
}

interface StoredExecutionControlRow {
  readonly expires_at: number | null;
  readonly state?: string | null;
  readonly phase?: string | null;
  readonly cas_owner?: string | null;
  readonly lease_owner?: string | null;
  readonly owner_token?: string | null;
  readonly [key: string]: unknown;
}

const stopHandlers = new Map<string, AgentRunStopHandler>();

function boundedText(value: unknown, maxBytes = MAX_ID_BYTES): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return encoder.encode(value).byteLength <= maxBytes ? value : null;
}

interface AgentRunStopTransactionResult {
  readonly status: AgentRunStopResultV2;
  readonly revision: number;
  readonly event?: BufferedEvent;
  readonly changed?: boolean;
}
function safePublicErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && PUBLIC_ERROR_CODES.has(value) ? value : undefined;
}

function boundedId(value: unknown, maxBytes = MAX_ID_BYTES): string | null {
  return boundedText(value, maxBytes);
}

function boundedCounter(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_COUNTER) {
    return fallback;
  }
  return value;
}

function boundedBytesJson(value: unknown, maxBytes: number): string | null {
  try {
    const json = JSON.stringify(value);
    return encoder.encode(json).byteLength <= maxBytes ? json : null;
  } catch {
    return null;
  }
}

function normalizeStatus(value: unknown): AgentRunPublicStatusV2 {
  if (typeof value !== "string") return "FAILED";
  if (PUBLIC_STATUSES.has(value as AgentRunPublicStatusV2)) return value as AgentRunPublicStatusV2;
  return LIFECYCLE_STATUS_MAP[value] ?? "FAILED";
}

function normalizeGenerationType(value: unknown): AgentRunGenerationTypeV1 | null {
  return typeof value === "string" && GENERATION_TYPES.has(value as AgentRunGenerationTypeV1)
    ? value as AgentRunGenerationTypeV1
    : null;
}

function normalizeUsage(value: unknown): AgentActivityUsageV2 {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    inputTokens: boundedCounter(source.inputTokens),
    outputTokens: boundedCounter(source.outputTokens),
    totalTokens: boundedCounter(source.totalTokens),
    toolCalls: boundedCounter(source.toolCalls),
    childInvocations: boundedCounter(source.childInvocations),
  };
}

function normalizeNodeStatus(value: unknown): AgentActivityNodeStatusV2 {
  if (typeof value === "string" && NODE_STATUSES.has(value as AgentActivityNodeStatusV2)) {
    return value as AgentActivityNodeStatusV2;
  }
  if (value === "queued") return "pending";
  return "omitted";
}

function normalizeNodeKind(value: unknown): AgentActivityNodeKindV2 {
  if (typeof value === "string" && NODE_KINDS.has(value as AgentActivityNodeKindV2)) {
    return value as AgentActivityNodeKindV2;
  }
  if (value === "root_turn") return "root";
  if (value === "provider_round") return "provider";
  if (value === "child_invocation") return "child";
  if (value === "tool_attempt") return "tool";
  return "tool";
}

function normalizeNodeActor(value: unknown, kind: AgentActivityNodeKindV2): AgentActivityNodeActorV2 {
  if (typeof value === "string" && NODE_ACTORS.has(value as AgentActivityNodeActorV2)) {
    return value as AgentActivityNodeActorV2;
  }
  return kind;
}

function normalizeNode(value: unknown, fallbackIndex: number, phase: AgentRunPublicStatusV2): AgentActivityNodeV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = boundedId(source.id, MAX_NODE_ID_BYTES) ?? `omitted-${fallbackIndex}`;
  const kind = normalizeNodeKind(source.kind);
  const actor = normalizeNodeActor(source.actor, kind);
  const parentId = source.parentId === null ? null : boundedId(source.parentId, MAX_NODE_ID_BYTES);
  const nodePhase = normalizeStatus(source.phase ?? phase);
  const status = normalizeNodeStatus(source.status);
  const startedAt = boundedCounter(source.startedAt);
  const elapsedMs = boundedCounter(source.elapsedMs);
  const profileId = boundedText(source.profileId, MAX_PROFILE_BYTES);
  const toolId = boundedText(source.toolId, MAX_TOOL_BYTES);
  const roundIndex = source.roundIndex === undefined ? undefined : boundedCounter(source.roundIndex);
  const continuationMode = source.continuationMode === "ordinary" || source.continuationMode === "finalization" || source.continuationMode === "none"
    ? source.continuationMode : undefined;
  const usage = source.usage === undefined ? undefined : normalizeUsage(source.usage);
  const errorCode = safePublicErrorCode(source.errorCode);
  return {
    version: 2,
    id,
    parentId,
    kind,
    actor,
    phase: nodePhase,
    status,
    startedAt,
    elapsedMs,
    ...(profileId ? { profileId } : {}),
    ...(toolId ? { toolId } : {}),
    ...(roundIndex !== undefined ? { roundIndex } : {}),
    ...(continuationMode ? { continuationMode } : {}),
    ...(usage ? { usage } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function normalizeOmission(value: unknown): AgentOmissionMarkerV2 {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const first = source.firstOmittedSequence === null || source.firstOmittedSequence === undefined
    ? null : boundedCounter(source.firstOmittedSequence);
  const last = source.lastOmittedSequence === null || source.lastOmittedSequence === undefined
    ? null : boundedCounter(source.lastOmittedSequence);
  return {
    omittedNodeCount: boundedCounter(source.omittedNodeCount),
    omittedEventCount: boundedCounter(source.omittedEventCount),
    firstOmittedSequence: first,
    lastOmittedSequence: last,
  };
}

function normalizeHandoff(value: unknown): AgentTerminalHandoffV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const messageId = source.messageId === null || source.messageId === undefined
    ? null : boundedId(source.messageId);
  const swipeId = source.swipeId === null || source.swipeId === undefined
    ? null : boundedCounter(source.swipeId);
  const messageRevision = source.messageRevision === null || source.messageRevision === undefined
    ? null : boundedCounter(source.messageRevision);
  const swipeRevision = source.swipeRevision === null || source.swipeRevision === undefined
    ? null : boundedCounter(source.swipeRevision);
  if (messageId === null && swipeId !== null) return undefined;
  return {
    version: 2,
    committed: source.committed === true,
    messageId,
    swipeId,
    messageRevision,
    swipeRevision,
  };
}

function normalizeTarget(messageId: unknown, swipeId: unknown): AgentRunTargetV1 | null {
  const normalizedMessageId = messageId === null || messageId === undefined ? null : boundedId(messageId);
  if (messageId !== null && messageId !== undefined && !normalizedMessageId) return null;
  if (normalizedMessageId === null) return null;
  const normalizedSwipeId = boundedCounter(swipeId, 0);
  return { messageId: normalizedMessageId, swipeId: normalizedSwipeId };
}

function mapCompatibilityLifecycle(status: AgentRunPublicStatusV2): "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out" {
  if (status === "ASSEMBLE") return "queued";
  if (status === "WORK" || status === "COMPLETE" || status === "RENDER" || status === "PREPARE_COMMIT" || status === "COMMITTING") return "running";
  if (status === "COMMITTED") return "completed";
  if (status === "CANCELLED") return "cancelled";
  if (status === "TIMED_OUT") return "timed_out";
  return "failed";
}

function compatibilitySnapshot(run: AgentRunPublicV2): PersistAgentActivityRunInput["snapshot"] {
  const lifecycle = mapCompatibilityLifecycle(run.status);
  return {
    version: 1,
    rootId: run.runId,
    nodes: run.activity.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      kind: node.kind === "root" ? "root_turn" : node.kind === "provider" ? "provider_round" : node.kind === "child" ? "child_invocation" : "tool_attempt",
      actor: node.actor,
      phase: lifecycle,
      status: node.status === "completed" ? "completed" : node.status === "cancelled" ? "cancelled" : node.status === "timed_out" ? "timed_out" : node.status === "failed" ? "failed" : lifecycle,
      startedAt: node.startedAt,
      elapsedMs: node.elapsedMs,
      ...(node.profileId ? { profileId: node.profileId } : {}),
      ...(node.toolId ? { toolId: node.toolId } : {}),
      ...(node.roundIndex !== undefined ? { roundIndex: node.roundIndex } : {}),
      ...(node.continuationMode ? { continuationMode: node.continuationMode } : {}),
      ...(node.usage ? { usage: node.usage } : {}),
      ...(node.errorCode ? { errorCode: node.errorCode } : {}),
    })),
    omittedNodeCount: run.omission.omittedNodeCount,
    errorCounts: run.error ? { [run.error.code]: 1 } : {},
    usage: run.usage,
    status: lifecycle,
    ...(run.error ? { terminalErrorCode: run.error.code } : {}),
  };
}

function normalizeRun(
  input: AgentRunProjectionInputV2,
  sequence: number,
  revision: number,
  existing?: AgentRunPublicV2,
): AgentRunPublicV2 | null {
  const userId = boundedId(input.userId);
  const chatId = boundedId(input.chatId);
  const turnId = boundedId(input.turnId);
  const generationId = boundedId(input.generationId);
  const generationType = normalizeGenerationType(input.generationType);
  if (!userId || !chatId || !turnId || !generationId || !generationType) return null;
  const status = normalizeStatus(input.status);
  const target = normalizeTarget(input.targetMessageId, input.targetSwipeId);
  const fallbackStartedAt = boundedCounter(input.startedAt, existing?.startedAt ?? Math.floor(Date.now() / 1000));
  const defaultStatus: AgentActivityNodeStatusV2 = status === "COMMITTED"
    ? "completed"
    : status === "CANCELLED"
      ? "cancelled"
      : status === "TIMED_OUT"
        ? "timed_out"
        : status === "COMMIT_FAILED" || status === "FAILED" || status === "EXHAUSTED"
          ? "failed"
          : "completed";
  const sourceActivity = Array.isArray(input.activity) && input.activity.length > 0
    ? input.activity
    : existing?.activity?.length
      ? existing.activity
      : [{
        id: `root:${turnId}`,
        parentId: null,
        kind: "root",
        actor: "root",
        phase: status,
        status: defaultStatus,
        startedAt: fallbackStartedAt,
        elapsedMs: 0,
      }];
  const activity: AgentActivityNodeV2[] = [];
  for (let index = 0; index < Math.min(sourceActivity.length, MAX_NODES); index += 1) {
    const node = normalizeNode(sourceActivity[index], index, status);
    if (node) activity.push(node);
  }
  const normalizedOmittedNodeCount = boundedCounter(
    (input.omission && typeof input.omission.omittedNodeCount === "number"
      ? input.omission.omittedNodeCount : 0)
      + Math.max(0, sourceActivity.length - MAX_NODES),
  );
  const omission: AgentOmissionMarkerV2 = {
    ...normalizeOmission(input.omission),
    omittedNodeCount: normalizedOmittedNodeCount,
  };
  const startedAt = fallbackStartedAt;
  const updatedAt = boundedCounter(input.updatedAt, existing?.updatedAt ?? fallbackStartedAt);
  const errorSource = input.error && typeof input.error === "object" ? input.error : null;
  const errorCode = errorSource ? safePublicErrorCode(errorSource.code) : undefined;
  const handoff = normalizeHandoff(input.terminalHandoff);
  const mutableActivity = [...activity];
  let omittedNodeCount = omission.omittedNodeCount;
  const makeRun = (): AgentRunPublicV2 => ({
    version: 2,
    runId: turnId,
    turnId,
    generationId,
    chatId,
    generationType,
    target,
    status,
    phase: status,
    revision,
    sequence,
    startedAt,
    updatedAt,
    activity: mutableActivity,
    usage: normalizeUsage(input.usage),
    omission: { ...omission, omittedNodeCount },
    ...(errorCode ? { error: { code: errorCode, retryable: errorSource?.retryable === true } } : {}),
    ...(handoff ? { terminalHandoff: handoff } : {}),
  });
  let run = makeRun();
  let json = JSON.stringify(run);
  while (encoder.encode(json).byteLength > 65536 && mutableActivity.length > 0) {
    mutableActivity.splice(mutableActivity.length > 1 ? 1 : 0, 1);
    omittedNodeCount += 1;
    run = makeRun();
    json = JSON.stringify(run);
  }
  return encoder.encode(json).byteLength <= 65536 ? run : null;
}

function parseStoredRun(row: StoredProjectionRow): AgentRunPublicV2 | null {
  try {
    const parsed = JSON.parse(row.snapshot_json) as AgentRunPublicV2;
    const generationType = normalizeGenerationType(parsed.generationType ?? row.generation_type);
    if (!generationType) return null;
    const safe = normalizeRun({
      userId: row.user_id,
      chatId: row.chat_id,
      turnId: row.turn_id,
      generationId: row.generation_id,
      generationType,
      targetMessageId: row.target_message_id,
      targetSwipeId: row.target_swipe_id,
      status: normalizeStatus(row.status),
      revision: row.revision,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      activity: parsed.activity,
      usage: parsed.usage,
      error: parsed.error,
      terminalHandoff: parsed.terminalHandoff,
      omission: JSON.parse(row.omission_json),
    }, row.sequence, row.revision);
    return safe;
  } catch {
    return null;
  }
}

function parseStoredEvent(
  db: Database,
  userId: string,
  row: StoredEventRow,
  chatId: string,
): { run: AgentRunPublicV2; omission: AgentOmissionMarkerV2 } | null {
  try {
    const parsed = JSON.parse(row.snapshot_json) as AgentRunPublicV2;
    const generationType = normalizeGenerationType(parsed.generationType);
    if (!generationType) return null;
    const messageId = parsed.target?.messageId ?? null;
    const swipeId = parsed.target?.swipeId ?? null;
    if (!assertStoredTarget(db, chatId, messageId, swipeId)) return null;
    const run = normalizeRun({
      userId,
      chatId,
      turnId: row.turn_id,
      generationId: parsed.generationId,
      generationType,
      targetMessageId: messageId,
      targetSwipeId: swipeId,
      status: normalizeStatus(row.status),
      revision: row.run_revision,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      activity: parsed.activity,
      usage: parsed.usage,
      error: parsed.error,
      terminalHandoff: parsed.terminalHandoff,
      omission: JSON.parse(row.omission_json),
    }, row.sequence, row.run_revision);
    if (!run) return null;
    return { run, omission: run.omission };
  } catch {
    return null;
  }
}

function projectionKey(userId: string, chatId: string, turnId: string): string {
  return `${userId}\u0000${chatId}\u0000${turnId}`;
}

function tableExists(db: Database, table: string): boolean {
  try {
    return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  } catch {
    return false;
  }
}

function validId(value: unknown): value is string {
  return boundedId(value) !== null;
}

function assertOwnedChat(db: Database, userId: string, chatId: string): boolean {
  return Boolean(db.query("SELECT 1 FROM chats WHERE id = ? AND user_id = ? LIMIT 1").get(chatId, userId));
}

function parseSwipes(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function messageHasSwipe(
  db: Database,
  chatId: string,
  messageId: string,
  swipeId: number | null | undefined,
): boolean {
  const row = db.query(
    "SELECT swipes FROM messages WHERE id = ? AND chat_id = ? LIMIT 1",
  ).get(messageId, chatId) as { swipes?: unknown } | null;
  if (!row) return false;
  if (swipeId === null || swipeId === undefined) return true;
  if (!Number.isSafeInteger(swipeId) || swipeId < 0) return false;
  const swipes = parseSwipes(row.swipes);
  return swipes !== null && swipeId < swipes.length;
}

function assertStoredTarget(
  db: Database,
  chatId: string,
  messageId: string | null,
  swipeId: number | null,
): boolean {
  if (messageId === null) return swipeId === null;
  if (!validId(messageId)) return false;
  return messageHasSwipe(db, chatId, messageId, swipeId);
}

function executionControlRow(
  db: Database,
  userId: string,
  chatId: string,
  turnId: string,
): StoredExecutionControlRow | null {
  if (!tableExists(db, "agent_turn_executions")) return null;
  try {
    return db.query(
      `SELECT *
         FROM agent_turn_executions
        WHERE user_id = ? AND chat_id = ? AND id = ?
        LIMIT 1`,
    ).get(userId, chatId, turnId) as StoredExecutionControlRow | null;
  } catch {
    return null;
  }
}

function executionReadVisible(db: Database, row: StoredExecutionControlRow | null): boolean {
  // A missing execution table is a legacy compatibility mode. Once the table
  // exists, a projection without its owner-scoped execution is not readable.
  return row === null ? !tableExists(db, "agent_turn_executions") : !isExpiredAt(row.expires_at);
}

function executionStatus(row: StoredExecutionControlRow | null): AgentRunPublicStatusV2 | null {
  const value = row?.phase ?? row?.state;
  return typeof value === "string" && PUBLIC_STATUSES.has(value as AgentRunPublicStatusV2)
    ? value as AgentRunPublicStatusV2
    : null;
}

function stopTerminalError(status: AgentRunPublicStatusV2): { code: string; retryable: boolean } | null {
  if (status === "CANCELLED") return { code: "cancelled", retryable: true };
  if (status === "TIMED_OUT") return { code: "timeout", retryable: true };
  if (status === "EXHAUSTED") return { code: "limit_exceeded", retryable: true };
  if (status === "FAILED" || status === "COMMIT_FAILED") return { code: "internal_error", retryable: true };
  return null;
}

function terminalActivityNodes(
  activity: readonly AgentActivityNodeV2[],
  status: AgentRunPublicStatusV2,
): readonly AgentActivityNodeV2[] {
  const terminalNodeStatus: AgentActivityNodeStatusV2 = status === "TIMED_OUT"
    ? "timed_out"
    : status === "CANCELLED"
      ? "cancelled"
      : status === "COMMITTED"
        ? "completed"
        : "failed";
  return activity.map((node) => ({
    ...node,
    phase: isTerminal(node.phase) ? node.phase : status,
    status: node.status === "pending" || node.status === "running" ? terminalNodeStatus : node.status,
  }));
}

function appendDurableTerminalProjection(
  db: Database,
  userId: string,
  run: AgentRunPublicV2,
  status: AgentRunPublicStatusV2,
): AgentRunProjectionCommitResult {
  return appendAgentRunSnapshot(db, {
    userId,
    chatId: run.chatId,
    turnId: run.turnId,
    generationId: run.generationId,
    generationType: run.generationType,
    targetMessageId: run.target?.messageId ?? null,
    targetSwipeId: run.target?.swipeId ?? null,
    status,
    revision: run.revision + 1,
    activity: terminalActivityNodes(run.activity, status),
    usage: run.usage,
    omission: run.omission,
    error: stopTerminalError(status),
    terminalHandoff: run.terminalHandoff ?? null,
  });
}


function workspaceExpired(retention: AgentWorkspaceRetentionV2, expiresAt: unknown, now = Math.floor(Date.now() / 1000)): boolean {
  if (retention === "chat_lifetime") return false;
  return typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now;
}

function workspaceChildVisible(row: Record<string, unknown>, now = Math.floor(Date.now() / 1000)): boolean {
  return !workspaceExpired(workspacePolicy(row.retention), row.expires_at, now);
}

function assertOwnedTarget(db: Database, input: AgentRunProjectionInputV2): boolean {
  if (!validId(input.userId) || !validId(input.chatId)) return false;
  if (!assertOwnedChat(db, input.userId, input.chatId)) return false;
  if (input.targetSwipeId !== undefined && input.targetSwipeId !== null
    && (!Number.isSafeInteger(input.targetSwipeId) || input.targetSwipeId < 0)) return false;
  if (input.targetMessageId === undefined || input.targetMessageId === null) {
    return input.targetSwipeId === undefined || input.targetSwipeId === null;
  }
  if (!validId(input.targetMessageId)) return false;
  // normalizeTarget() defaults a message target to swipe zero. Validate that
  // concrete stored association now, not only when the run is later read.
  return messageHasSwipe(db, input.chatId, input.targetMessageId, input.targetSwipeId ?? 0);
}

function getProjectionRow(db: Database, userId: string, chatId: string, turnId: string): StoredProjectionRow | null {
  return db.query(
    `SELECT user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
            target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
            snapshot_json, terminal_handoff_json, omission_json
       FROM agent_run_projections
      WHERE user_id = ? AND chat_id = ? AND turn_id = ?
      LIMIT 1`,
  ).get(userId, chatId, turnId) as StoredProjectionRow | null;
}

function getProjectionByTurn(db: Database, userId: string, turnId: string): StoredProjectionRow | null {
  return db.query(
    `SELECT user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
            target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
            snapshot_json, terminal_handoff_json, omission_json
       FROM agent_run_projections
      WHERE user_id = ? AND turn_id = ?
      LIMIT 1`,
  ).get(userId, turnId) as StoredProjectionRow | null;
}
function hasDurableTerminalEvent(db: Database, userId: string, run: AgentRunPublicV2): boolean {
  if (!tableExists(db, "agent_chat_events")) return false;
  const row = db.query(
    `SELECT 1 AS present
       FROM agent_chat_events
      WHERE user_id = ? AND chat_id = ? AND turn_id = ?
        AND sequence = ? AND run_revision = ? AND event_kind = 'terminal'
      LIMIT 1`,
  ).get(userId, run.chatId, run.turnId, run.sequence, run.revision) as { present?: number } | null;
  return Number(row?.present ?? 0) === 1;
}

function allocateChatSequence(db: Database, userId: string, chatId: string): number {
  db.query(
    `INSERT INTO agent_chat_event_sequences (user_id, chat_id, last_sequence, updated_at)
     VALUES (?, ?, 1, unixepoch())
     ON CONFLICT(user_id, chat_id) DO UPDATE SET
       last_sequence = agent_chat_event_sequences.last_sequence + 1,
       updated_at = unixepoch()`,
  ).run(userId, chatId);
  const row = db.query(
    "SELECT last_sequence FROM agent_chat_event_sequences WHERE user_id = ? AND chat_id = ?",
  ).get(userId, chatId) as { last_sequence: number } | null;
  if (!row || !Number.isSafeInteger(row.last_sequence) || row.last_sequence < 1) {
    throw new Error("agent chat event sequence allocation failed");
  }
  return row.last_sequence;
}

function isTerminal(status: AgentRunPublicStatusV2): boolean {
  return TERMINAL_STATUSES.has(status);
}

function persistCompatibilityProjection(db: Database, input: AgentRunProjectionInputV2, run: AgentRunPublicV2): void {
  if (!isTerminal(run.status)) return;
  const snapshot = input.compatibilitySnapshot ?? compatibilitySnapshot(run);
  persistTerminalAgentActivityRunInTransaction(db, {
    userId: input.userId,
    chatId: input.chatId,
    generationId: input.generationId,
    targetMessageId: run.target?.messageId ?? null,
    targetSwipeId: run.target?.swipeId ?? null,
    snapshot,
    status: mapCompatibilityLifecycle(run.status),
  });
}

function eventForRun(run: AgentRunPublicV2, userId?: string): BufferedEvent {
  const eventPayload = {
    version: 2 as const,
    chatId: run.chatId,
    sequence: run.sequence,
    run,
    omission: run.omission,
  };
  return {
    event: AGENT_RUN_CHANGED,
    payload: eventPayload,
    userId,
  };
}

const emittedAgentRunEventKeys = new Set<string>();

function emittedEventKey(event: BufferedEvent): string | null {
  if (event.event !== AGENT_RUN_CHANGED || !event.userId) return null;
  const payload = event.payload;
  const chatId = payload && typeof payload === "object" && typeof payload.chatId === "string"
    ? payload.chatId
    : null;
  const sequence = payload && typeof payload === "object" && Number.isSafeInteger(payload.sequence)
    ? payload.sequence
    : null;
  if (!chatId || sequence === null || sequence < 1) return null;
  return `${event.userId}\u0000${chatId}\u0000${sequence}`;
}

function terminalOutboxIdentity(event: BufferedEvent): { userId: string; chatId: string; sequence: number } | null {
  const key = emittedEventKey(event);
  if (!key || !event.userId || !event.payload || typeof event.payload !== "object") return null;
  const payload = event.payload as Record<string, unknown>;
  const run = payload.run;
  if (!run || typeof run !== "object" || !isTerminal((run as Record<string, unknown>).status as AgentRunPublicStatusV2)) return null;
  const chatId = typeof payload.chatId === "string" ? payload.chatId : null;
  const sequence = Number.isSafeInteger(payload.sequence) ? payload.sequence as number : null;
  if (!chatId || sequence === null || sequence < 1) return null;
  return { userId: event.userId, chatId, sequence };
}

function hasTerminalOutboxDeliveryColumns(db: Database): boolean {
  if (!tableExists(db, "agent_chat_events")) return false;
  try {
    const columns = new Set((db.query("PRAGMA table_info('agent_chat_events')").all() as Array<{ name?: unknown }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === "string"));
    return columns.has("delivery_state")
      && columns.has("delivery_attempts")
      && columns.has("delivery_lease_token")
      && columns.has("delivery_lease_expires_at")
      && columns.has("delivered_at");
  } catch {
    return false;
  }
}
function resetTerminalOutboxLeases(db: Database, userId?: string): void {
  if (!hasTerminalOutboxDeliveryColumns(db)) return;
  const now = Math.floor(Date.now() / 1000);
  const processPrefix = `${TERMINAL_OUTBOX_PROCESS_ID}:`;
  const scope = userId ? " AND user_id = ?" : "";
  const bindings = userId
    ? [now, processPrefix, processPrefix, userId]
    : [now, processPrefix, processPrefix];
  db.query(
    `UPDATE agent_chat_events
        SET delivery_state = 'pending',
            delivery_lease_token = NULL,
            delivery_lease_expires_at = NULL
      WHERE event_kind = 'terminal'
        AND delivery_state = 'leased'
        AND (
          delivery_lease_expires_at IS NULL
          OR delivery_lease_expires_at <= ?
          OR delivery_lease_token IS NULL
          OR substr(delivery_lease_token, 1, length(?)) <> ?
        )${scope}`,
  ).run(...bindings);
}

function terminalOutboxLeaseToken(): string {
  return `${TERMINAL_OUTBOX_PROCESS_ID}:${randomUUID()}`;
}

/**
 * Claim one durable terminal outbox row. A lease is a retry fence: a clean
 * process restart skips rows marked delivered, while a crash before the
 * delivered marker leaves an expired lease that can be claimed again.
 */
function claimTerminalOutboxEvent(
  event: BufferedEvent,
  db: Database,
): { identity: { userId: string; chatId: string; sequence: number }; token: string } | false | null {
  const identity = terminalOutboxIdentity(event);
  if (!identity) return null;
  if (!hasTerminalOutboxDeliveryColumns(db)) return null;
  const row = db.query(
    `SELECT delivery_state, delivery_attempts, delivery_lease_expires_at
       FROM agent_chat_events
      WHERE user_id = ? AND chat_id = ? AND sequence = ? AND event_kind = 'terminal'
      LIMIT 1`,
  ).get(identity.userId, identity.chatId, identity.sequence) as {
    delivery_state?: unknown;
    delivery_attempts?: unknown;
    delivery_lease_expires_at?: unknown;
  } | null;
  if (!row) return null;
  if (row.delivery_state === "delivered") return false;
  const now = Math.floor(Date.now() / 1000);
  const attempts = Number(row.delivery_attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= 100_000) return false;
  const token = terminalOutboxLeaseToken();
  const claimed = db.query(
    `UPDATE agent_chat_events
        SET delivery_state = 'leased',
            delivery_attempts = delivery_attempts + 1,
            delivery_lease_token = ?,
            delivery_lease_expires_at = ?
      WHERE user_id = ? AND chat_id = ? AND sequence = ?
        AND event_kind = 'terminal'
        AND delivery_state <> 'delivered'
        AND (delivery_state = 'pending' OR (delivery_state = 'leased' AND delivery_lease_expires_at <= ?))`,
  ).run(token, now + TERMINAL_OUTBOX_LEASE_SECONDS, identity.userId, identity.chatId, identity.sequence, now);
  return claimed.changes === 1 ? { identity, token } : false;

}
function markTerminalOutboxDelivered(
  identity: { userId: string; chatId: string; sequence: number },
  token: string,
  db: Database,
): boolean {
  if (!hasTerminalOutboxDeliveryColumns(db)) return true;
  const result = db.query(
    `UPDATE agent_chat_events
        SET delivery_state = 'delivered',
            delivered_at = unixepoch(),
            delivery_lease_token = NULL,
            delivery_lease_expires_at = NULL
      WHERE user_id = ? AND chat_id = ? AND sequence = ?
        AND event_kind = 'terminal'
        AND delivery_state = 'leased'
        AND delivery_lease_token = ?`,
  ).run(identity.userId, identity.chatId, identity.sequence, token);
  return result.changes === 1;
}
function releaseTerminalOutboxLease(
  identity: { userId: string; chatId: string; sequence: number },
  token: string,
  db: Database,
): void {
  if (!hasTerminalOutboxDeliveryColumns(db)) return;
  db.query(
    `UPDATE agent_chat_events
        SET delivery_state = 'pending',
            delivery_lease_token = NULL,
            delivery_lease_expires_at = NULL
      WHERE user_id = ? AND chat_id = ? AND sequence = ?
        AND event_kind = 'terminal'
        AND delivery_state = 'leased'
        AND delivery_lease_token = ?`,
  ).run(identity.userId, identity.chatId, identity.sequence, token);
}

function rememberEmittedEventKey(key: string): void {
  if (emittedAgentRunEventKeys.size >= MAX_EMITTED_EVENT_KEYS) {
    const oldest = emittedAgentRunEventKeys.values().next().value;
    if (typeof oldest === "string") emittedAgentRunEventKeys.delete(oldest);
  }
  emittedAgentRunEventKeys.add(key);
}

/**
 * Publish an already-durable Agent run event once per process. Terminal rows
 * use the SQLite outbox marker as the restart-safe idempotency authority.
 */
export function emitAgentRunProjectionEvent(event: BufferedEvent, db: Database = getDb()): boolean {
  const key = emittedEventKey(event);
  if (key && emittedAgentRunEventKeys.has(key)) return false;
  const claim = claimTerminalOutboxEvent(event, db);
  if (claim === false) return false;
  let accepted = false;
  try {
    accepted = eventBus.emit(event.event, event.payload, event.userId, event.options);
  } catch {
    if (claim) releaseTerminalOutboxLease(claim.identity, claim.token, db);
    return false;
  }
  if (claim && !accepted) {
    releaseTerminalOutboxLease(claim.identity, claim.token, db);
    return false;
  }
  if (claim && !markTerminalOutboxDelivered(claim.identity, claim.token, db)) return false;
  if (key) rememberEmittedEventKey(key);
  return !claim || accepted;
}
function epochSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return Math.floor(Date.now() / 1000);
  return value >= 100_000_000_000 ? Math.floor(value / 1000) : value;
}

/**
 * Rebuild the public terminal handoff from a durable commit receipt. This is
 * intentionally limited to receipt-owned identifiers and a bounded root
 * chronology; it never reads or replays render guidance, work notes, provider
 * output, or any other transient frame data. Callers that need the phase
 * transition and projection to be atomic must invoke this inside their
 * SQLite transaction.
 */
export function repairAgentRunProjectionFromReceipt(
  db: Database,
  execution: Pick<
    TurnExecutionRecord,
    | "id"
    | "userId"
    | "chatId"
    | "generationId"
    | "targetKind"
    | "targetMessageId"
    | "targetSwipeId"
    | "targetMessageRevision"
    | "createdAt"
    | "updatedAt"
  >,
  receipt: Pick<TurnCommitReceipt, "messageId" | "swipeId" | "createdAt">,
): AgentRunProjectionCommitResult {
  if (!tableExists(db, "agent_run_projections") || !tableExists(db, "agent_chat_events")) {
    throw new Error("agent run projection schema is unavailable");
  }
  const messageId = receipt.messageId ?? execution.targetMessageId;
  const swipeId = messageId === null
    ? null
    : receipt.swipeId ?? execution.targetSwipeId ?? 0;
  let committedRevision: number | null = null;
  if (messageId !== null && tableExists(db, "messages")) {
    const row = db.query(
      "SELECT generation_revision FROM messages WHERE id = ? AND chat_id = ? LIMIT 1",
    ).get(messageId, execution.chatId) as { generation_revision?: unknown } | null;
    if (row && Number.isSafeInteger(Number(row.generation_revision)) && Number(row.generation_revision) >= 0) {
      committedRevision = Number(row.generation_revision);
    }
  }
  const messageRevision = messageId === null
    ? null
    : committedRevision ?? execution.targetMessageRevision ?? 0;
  const swipeRevision = swipeId === null ? null : messageRevision;
  const timestamp = epochSeconds(receipt.createdAt || execution.updatedAt || execution.createdAt);
  const revision = getProjectionRow(db, execution.userId, execution.chatId, execution.id)?.revision;
  return publishAgentRunCommit(db, {
    userId: execution.userId,
    chatId: execution.chatId,
    turnId: execution.id,
    generationId: execution.generationId,
    generationType: execution.targetKind,
    targetMessageId: messageId,
    targetSwipeId: swipeId,
    status: "COMMITTED",
    ...(revision !== undefined ? { revision: revision + 1 } : {}),
    startedAt: epochSeconds(execution.createdAt),
    updatedAt: timestamp,
    activity: [],
    terminalHandoff: {
      committed: true,
      messageId,
      swipeId,
      messageRevision,
      swipeRevision,
    },
    receiptRepair: true,
  });
}
/**
 * Append the terminal public projection for a startup-interrupted execution.
 * This helper is called from the turn reconciler's transaction and consumes
 * only durable execution/projection fields; it never invokes runtime code.
 */
export function repairAgentRunProjectionFromInterruptedExecution(
  db: Database,
  execution: Pick<
    TurnExecutionRecord,
    | "id"
    | "userId"
    | "chatId"
    | "generationId"
    | "targetKind"
    | "targetMessageId"
    | "targetSwipeId"
    | "createdAt"
    | "updatedAt"
  >,
  status: "FAILED" | "COMMIT_FAILED",
): AgentRunProjectionCommitResult {
  if (!tableExists(db, "agent_run_projections") || !tableExists(db, "agent_chat_events")) {
    throw new Error("agent run projection schema is unavailable");
  }
  const existingRow = getProjectionByTurn(db, execution.userId, execution.id);
  const existing = existingRow ? parseStoredRun(existingRow) : null;
  const requestedMessageId = existing?.target?.messageId ?? execution.targetMessageId;
  const requestedSwipeId = existing?.target?.swipeId ?? execution.targetSwipeId;
  const targetValid = assertStoredTarget(db, execution.chatId, requestedMessageId, requestedSwipeId);
  const targetMessageId = targetValid ? requestedMessageId : null;
  const targetSwipeId = targetMessageId === null ? null : requestedSwipeId ?? 0;
  return publishAgentRunCommit(db, {
    userId: execution.userId,
    chatId: execution.chatId,
    turnId: execution.id,
    generationId: execution.generationId,
    generationType: execution.targetKind,
    targetMessageId,
    targetSwipeId,
    status,
    revision: (existing?.revision ?? 0) + 1,
    startedAt: epochSeconds(existing?.startedAt ?? execution.createdAt),
    updatedAt: epochSeconds(execution.updatedAt),
    activity: existing?.activity ?? [],
    usage: existing?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      childInvocations: 0,
    },
    omission: existing?.omission ?? emptyOmission(),
    error: { code: "internal_error", retryable: true },
    terminalHandoff: null,
    recoveryRepair: true,
  });
}


/**
 * Append one status snapshot inside the caller-owned synchronous SQLite
 * transaction. No provider, tool, callback, or websocket operation occurs
 * before the outer transaction commits.
 */
export function appendAgentRunSnapshot(
  db: Database,
  input: AgentRunProjectionInputV2,
): AgentRunProjectionCommitResult {
  return writeProjection(db, input);
}

/** Terminal commit hook. The compatibility activity projection is written in this same transaction. */
export function publishAgentRunCommit(
  db: Database,
  input: AgentRunProjectionInputV2,
): AgentRunProjectionCommitResult {
  if (!isTerminal(input.status)) {
    throw new Error("agent run commit hook requires a terminal status");
  }
  return writeProjection(db, input);
}

function writeProjection(db: Database, input: AgentRunProjectionInputV2): AgentRunProjectionCommitResult {
  if ((input.targetMessageId !== undefined && input.targetMessageId !== null && !validId(input.targetMessageId))
    || (input.targetSwipeId !== undefined && input.targetSwipeId !== null && (
      !Number.isSafeInteger(input.targetSwipeId) || input.targetSwipeId < 0
    ))) {
    throw new Error("agent run target association mismatch");
  }
  if (!assertOwnedTarget(db, input)) throw new Error("agent run projection ownership mismatch");
  const existingRow = getProjectionRow(db, input.userId, input.chatId, input.turnId);
  const existing = existingRow ? (parseStoredRun(existingRow) ?? undefined) : undefined;
  const receiptRepairNeeded = input.receiptRepair === true && !!existing && (
    existing.status !== "COMMITTED" || !hasDurableTerminalEvent(db, input.userId, existing)
  );
  const recoveryRepairNeeded = input.recoveryRepair === true && !!existing && existing.status !== input.status;
  if (existing && (
    (input.revision !== undefined && input.revision <= existing.revision)
    || (isTerminal(existing.status) && !receiptRepairNeeded && !recoveryRepairNeeded)
  )) {
    return {
      run: existing,
      sequence: existing.sequence,
      revision: existing.revision,
      event: eventForRun(existing, input.userId),
      changed: false,
    };
  }
  const revision = input.revision === undefined
    ? (existing?.revision ?? 0) + 1
    : Math.max(1, Math.floor(input.revision));
  if (existing && revision <= existing.revision) {
    return {
      run: existing,
      sequence: existing.sequence,
      revision: existing.revision,
      event: eventForRun(existing, input.userId),
      changed: false,
    };
  }
  const sequence = allocateChatSequence(db, input.userId, input.chatId);
  const run = normalizeRun(input, sequence, revision, existing);
  if (!run) throw new Error("invalid agent run projection");
  const snapshotJson = boundedBytesJson(run, AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1.projectionSnapshotBytes);
  const handoffJson = run.terminalHandoff
    ? boundedBytesJson(run.terminalHandoff, AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1.projectionHandoffBytes)
    : null;
  const omissionJson = boundedBytesJson(run.omission, AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1.projectionOmissionBytes);
  if (!snapshotJson || !omissionJson || (run.terminalHandoff && !handoffJson)) {
    throw new Error("agent run projection exceeds storage bounds");
  }
  db.query(
    `INSERT INTO agent_run_projections
      (user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,

       target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
       snapshot_json, terminal_handoff_json, omission_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, turn_id) DO UPDATE SET
       generation_id = excluded.generation_id,
       generation_type = excluded.generation_type,
       target_message_id = excluded.target_message_id,
       target_swipe_id = excluded.target_swipe_id,
       status = excluded.status,
       phase = excluded.phase,
       revision = excluded.revision,
       sequence = excluded.sequence,
       started_at = excluded.started_at,
       updated_at = excluded.updated_at,
       snapshot_json = excluded.snapshot_json,
       terminal_handoff_json = excluded.terminal_handoff_json,
       omission_json = excluded.omission_json`,
  ).run(
    input.userId,
    input.chatId,
    input.turnId,
    run.generationId,
    run.generationType,
    run.target?.messageId ?? null,
    run.target?.swipeId ?? null,
    run.status,
    run.phase,
    run.revision,
    run.sequence,
    run.startedAt,
    run.updatedAt,
    snapshotJson,
    handoffJson,
    omissionJson,
  );
  const eventKind = isTerminal(run.status) ? "terminal" : run.omission.omittedEventCount > 0 || run.omission.omittedNodeCount > 0 ? "omission" : "snapshot";
  db.query(
    `INSERT INTO agent_chat_events
      (user_id, chat_id, sequence, turn_id, generation_id, run_revision, status,
       event_kind, snapshot_json, terminal_handoff_json, omission_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.userId,
    input.chatId,
    run.sequence,
    run.turnId,
    run.generationId,
    run.revision,
    run.status,
    eventKind,
    snapshotJson,
    handoffJson,
    omissionJson,
  );
  persistCompatibilityProjection(db, input, run);
  const event = eventForRun(run, input.userId);
  return { run, sequence, revision, event, changed: true };
}

/** Wrap a projection transaction and flush its websocket handoff only after commit. */
export function withAgentRunProjectionTransaction<T>(
  callback: (db: Database) => T,
): T {
  const db = getDb();
  const buffered = eventBus.withBufferedEvents(() => db.transaction(() => {
    const value = callback(db);
    const candidate = value as unknown as { readonly event?: BufferedEvent; readonly changed?: boolean };
    const projectionEvent = candidate?.event;
    if (candidate?.changed !== false && projectionEvent?.event === AGENT_RUN_CHANGED) {
      eventBus.emit(
        projectionEvent.event,
        projectionEvent.payload,
        projectionEvent.userId,
        projectionEvent.options,
      );
    }
    return value;
  })());
  for (const event of buffered.events) {
    emitAgentRunProjectionEvent(event, db);
  }
  return buffered.value;
}
export interface AgentRunEventReplayResult {
  readonly inspected: number;
  readonly emitted: number;
  readonly skipped: number;
}

/**
 * Replay the durable terminal-event outbox after the EventBus has a live
 * server. Event sequence/revision is the stable idempotency key, so a crash
 * after SQLite commit and before websocket publication never reruns commit
 * side effects and repeat startup reconciliation is harmless.
 */
function drainPendingAgentRunEvents(
  db: Database,
  userId: string | undefined,
  options: { readonly maxRows?: number },
): AgentRunEventReplayResult {
  if (!tableExists(db, "agent_chat_events") || !tableExists(db, "agent_run_projections")) {
    return { inspected: 0, emitted: 0, skipped: 0 };
  }
  if (userId !== undefined && !validId(userId)) {
    return { inspected: 0, emitted: 0, skipped: 0 };
  }
  const requested = options.maxRows;
  const maxRows = typeof requested === "number" && Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, MAX_RECONCILIATION_ROWS))
    : MAX_RECONCILIATION_ROWS;
  resetTerminalOutboxLeases(db, userId);
  let inspected = 0;
  let emitted = 0;
  let skipped = 0;
  for (let batch = 0; batch < MAX_OUTBOX_REPLAY_BATCHES; batch += 1) {
    const emittedBeforeBatch = emitted;
    const scope = userId === undefined ? "" : " AND e.user_id = ?";
    const query = `SELECT e.user_id, e.chat_id, e.sequence, e.turn_id, e.run_revision, e.status,
              e.snapshot_json, e.terminal_handoff_json, e.omission_json
         FROM agent_chat_events e
         JOIN agent_run_projections p
           ON p.user_id = e.user_id AND p.chat_id = e.chat_id
          AND p.turn_id = e.turn_id AND p.sequence = e.sequence
          AND p.revision = e.run_revision
        WHERE e.event_kind = 'terminal'
          AND e.delivery_state <> 'delivered'${scope}
        ORDER BY e.sequence ASC
        LIMIT ?`;
    const rows = db.query(query).all(
      ...(userId === undefined ? [maxRows] : [userId, maxRows]),
    ) as Array<StoredEventRow & { user_id: string; chat_id: string }>;
    if (rows.length === 0) break;
    inspected += rows.length;
    for (const row of rows) {
      const parsed = parseStoredEvent(db, row.user_id, row, row.chat_id);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      if (emitAgentRunProjectionEvent(eventForRun(parsed.run, row.user_id), db)) emitted += 1;
    }
    if (emitted === emittedBeforeBatch && rows.length === maxRows) break;
    if (rows.length < maxRows) break;
  }
  return { inspected, emitted, skipped };
}

/**
 * Drain one authenticated user's terminal outbox after the socket has joined
 * that user's topic. Previous-process and expired leases for this user are
 * reset; a current-process lease remains fenced.
 */
export function drainPendingAgentRunEventsForUser(
  userId: string,
  db: Database = getDb(),
  options: { readonly maxRows?: number } = {},
): AgentRunEventReplayResult {
  return drainPendingAgentRunEvents(db, userId, options);
}

/** Compatibility helper for focused recovery tests and explicit all-user repair. */
export function replayPendingAgentRunEvents(
  db: Database = getDb(),
  options: { readonly maxRows?: number } = {},
): AgentRunEventReplayResult {
  return drainPendingAgentRunEvents(db, undefined, options);
}

/**
 * Cursor signing key. Chat cursors are the only owner-bound tokens this
 * service issues, so an unavailable application auth secret must fail closed:
 * a shared static fallback would make every cursor forgeable if the startup
 * identity derivation that populates `env.authSecret` ever regressed.
 */
function cursorKey(): Buffer | null {
  const configured = env.authSecret || process.env.AUTH_SECRET || "";
  return configured.length === 0 ? null : Buffer.from(configured, "utf8");
}

function encodeCursorPayload(claims: CursorClaims): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

function signCursor(signingInput: string, key: Buffer): string {
  return createHmac("sha256", key).update(signingInput).digest("base64url");
}

function mintCursor(
  userId: string,
  chatId: string,
  lastSequence: number,
  now = Math.floor(Date.now() / 1000),
  resyncOffset?: number,
): ChatRunCursorV1 {
  // No signing key means no cursor: minting an unsigned or statically signed
  // token would hand the caller a forgeable watermark.
  const key = cursorKey();
  if (!key) throw new Error("agent run cursor signing key is unavailable");
  const claims: CursorClaims = {
    v: 1,
    u: userId,
    c: chatId,
    s: lastSequence,
    e: now + CURSOR_TTL_SECONDS,
    ...(resyncOffset === undefined ? {} : { p: resyncOffset }),
  };
  const signingInput = `v1.${encodeCursorPayload(claims)}`;
  return { version: 1, token: `${signingInput}.${signCursor(signingInput, key)}` };
}

function invalidCursorClaims(): CursorClaims {
  return { v: 1, u: "", c: "", s: 0, e: 0 };
}

function decodeCursor(token: unknown): { claims: CursorClaims; reason: "ok" | "expired" | "invalid" } {
  if (typeof token !== "string" || token.length === 0 || encoder.encode(token).byteLength > MAX_CURSOR_BYTES) {
    return { claims: invalidCursorClaims(), reason: "invalid" };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) {
    return { claims: invalidCursorClaims(), reason: "invalid" };
  }
  const key = cursorKey();
  if (!key) return { claims: invalidCursorClaims(), reason: "invalid" };
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signCursor(signingInput, key), "utf8");
  const provided = Buffer.from(parts[2]!, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { claims: invalidCursorClaims(), reason: "invalid" };
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Partial<CursorClaims>;
    if (
      claims.v !== 1
      || typeof claims.u !== "string"
      || typeof claims.c !== "string"
      || typeof claims.s !== "number"
      || typeof claims.e !== "number"
      || claims.p !== undefined && typeof claims.p !== "number"
    ) {
      throw new Error("invalid cursor claims");
    }
    if (
      !Number.isSafeInteger(claims.s) || claims.s < 0
      || !Number.isSafeInteger(claims.e)
      || claims.p !== undefined && (!Number.isSafeInteger(claims.p) || claims.p < 0)
    ) {
      throw new Error("invalid cursor bounds");
    }
    return {
      claims: claims as CursorClaims,
      reason: Math.floor(Date.now() / 1000) >= claims.e ? "expired" : "ok",
    };
  } catch {
    return { claims: invalidCursorClaims(), reason: "invalid" };
  }
}

function emptyOmission(): AgentOmissionMarkerV2 {
  return { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null };
}

function mergeOmission(a: AgentOmissionMarkerV2, b: AgentOmissionMarkerV2): AgentOmissionMarkerV2 {
  const omittedNodeCount = Math.min(MAX_SAFE_COUNTER, a.omittedNodeCount + b.omittedNodeCount);
  const omittedEventCount = Math.min(MAX_SAFE_COUNTER, a.omittedEventCount + b.omittedEventCount);
  return {
    omittedNodeCount,
    omittedEventCount,
    firstOmittedSequence: a.firstOmittedSequence ?? b.firstOmittedSequence,
    lastOmittedSequence: b.lastOmittedSequence ?? a.lastOmittedSequence,
  };
}

function sequenceBounds(db: Database, userId: string, chatId: string): { last: number; first: number | null } {
  const sequence = db.query(
    "SELECT last_sequence FROM agent_chat_event_sequences WHERE user_id = ? AND chat_id = ?",
  ).get(userId, chatId) as { last_sequence: number } | null;
  const first = tableExists(db, "agent_turn_executions")
    ? db.query(
      `SELECT MIN(e.sequence) AS first_sequence
         FROM agent_chat_events e
         JOIN agent_turn_executions t
           ON t.user_id = e.user_id AND t.id = e.turn_id AND t.chat_id = e.chat_id
        WHERE e.user_id = ? AND e.chat_id = ?
          AND CASE WHEN t.expires_at < 100000000000 THEN t.expires_at * 1000 ELSE t.expires_at END > ?`,
    ).get(userId, chatId, Date.now()) as { first_sequence: number | null } | null
    : db.query(
      "SELECT MIN(sequence) AS first_sequence FROM agent_chat_events WHERE user_id = ? AND chat_id = ?",
    ).get(userId, chatId) as { first_sequence: number | null } | null;
  return { last: sequence?.last_sequence ?? 0, first: first?.first_sequence ?? null };
}

interface CurrentRunsPage {
  readonly runs: AgentRunPublicV2[];
  readonly totalRuns: number;
}

function listCurrentRuns(
  db: Database,
  userId: string,
  chatId: string,
  snapshotSequence: number,
  offset = 0,
): CurrentRunsPage {
  const safeOffset = Math.max(0, Math.min(MAX_SAFE_COUNTER, Math.floor(offset)));
  const nowMilliseconds = Date.now();
  const withExecution = tableExists(db, "agent_turn_executions");
  const rows = withExecution
    ? db.query(
      `SELECT p.user_id, p.chat_id, p.turn_id, p.generation_id, p.generation_type,
              p.target_message_id, p.target_swipe_id, p.status, p.phase, p.revision,
              p.sequence, p.started_at, p.updated_at, p.snapshot_json,
              p.terminal_handoff_json, p.omission_json
         FROM agent_run_projections p
         JOIN agent_turn_executions t
           ON t.user_id = p.user_id AND t.id = p.turn_id AND t.chat_id = p.chat_id
        WHERE p.user_id = ? AND p.chat_id = ? AND p.sequence <= ?
          AND CASE WHEN t.expires_at < 100000000000 THEN t.expires_at * 1000 ELSE t.expires_at END > ?
        ORDER BY p.updated_at DESC, p.turn_id DESC
        LIMIT ? OFFSET ?`,
    ).all(userId, chatId, snapshotSequence, nowMilliseconds, MAX_RUNS, safeOffset) as StoredProjectionRow[]
    : db.query(
      `SELECT user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
              target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
              snapshot_json, terminal_handoff_json, omission_json
         FROM agent_run_projections
        WHERE user_id = ? AND chat_id = ? AND sequence <= ?
        ORDER BY updated_at DESC, turn_id DESC
        LIMIT ? OFFSET ?`,
    ).all(userId, chatId, snapshotSequence, MAX_RUNS, safeOffset) as StoredProjectionRow[];
  const runs = rows
    .filter((row) => assertStoredTarget(db, row.chat_id, row.target_message_id, row.target_swipe_id))
    .map(parseStoredRun)
    .filter((run): run is AgentRunPublicV2 => run !== null);
  const totalRuns = withExecution
    ? Number((db.query(
      `SELECT COUNT(*) AS total
         FROM agent_run_projections p
         JOIN agent_turn_executions t
           ON t.user_id = p.user_id AND t.id = p.turn_id AND t.chat_id = p.chat_id
        WHERE p.user_id = ? AND p.chat_id = ? AND p.sequence <= ?
          AND CASE WHEN t.expires_at < 100000000000 THEN t.expires_at * 1000 ELSE t.expires_at END > ?`,
    ).get(userId, chatId, snapshotSequence, nowMilliseconds) as { total?: unknown } | null)?.total ?? 0)
    : Number((db.query(
      "SELECT COUNT(*) AS total FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND sequence <= ?",
    ).get(userId, chatId, snapshotSequence) as { total?: unknown } | null)?.total ?? 0);
  return {
    runs,
    totalRuns: Number.isSafeInteger(totalRuns) && totalRuns >= 0 ? totalRuns : runs.length,
  };
}

export function getAgentRunChanges(userId: string, chatId: string, cursorToken?: unknown): AgentRunChangesV2 | null {
  const db = getDb();
  return db.transaction(() => {
    if (!validId(userId) || !validId(chatId) || !assertOwnedChat(db, userId, chatId)) return null;
    const decoded = decodeCursor(cursorToken);
    const bounds = sequenceBounds(db, userId, chatId);
    const cursorMatches = decoded.reason === "ok"
      && decoded.claims.u === userId
      && decoded.claims.c === chatId;
    const cursorSequence = cursorMatches ? decoded.claims.s : 0;
    const pagedResync = cursorMatches && decoded.claims.p !== undefined;
    const resyncOffset = pagedResync ? decoded.claims.p! : 0;
    const retentionGap = cursorMatches && bounds.first !== null && cursorSequence + 1 < bounds.first;
    const cursorAhead = cursorMatches && cursorSequence > bounds.last;
    const resync = !cursorMatches
      || decoded.reason === "expired"
      || retentionGap
      || cursorAhead
      || pagedResync;
    let combinedOmission: AgentOmissionMarkerV2 = resync
      && cursorMatches
      && bounds.first !== null
      && cursorSequence + 1 < bounds.first
      ? {
          ...emptyOmission(),
          omittedEventCount: bounds.first - cursorSequence - 1,
          firstOmittedSequence: cursorSequence + 1,
          lastOmittedSequence: bounds.first - 1,
        }
      : emptyOmission();
    const events: AgentRunChangeEventV2[] = [];

    if (resync) {
      // A paged resync keeps the event watermark from its first page. Events
      // that arrive while pages are fetched are deliberately left for the
      // first ordinary delta after the final page, so no live event can be
      // hidden behind a page token.
      const snapshotSequence = pagedResync ? Math.min(cursorSequence, bounds.last) : bounds.last;
      const page = listCurrentRuns(db, userId, chatId, snapshotSequence, resyncOffset);
      const complete = resyncOffset + page.runs.length >= page.totalRuns;
      const nextOffset = complete ? undefined : resyncOffset + MAX_RUNS;
      const nextCursor = mintCursor(userId, chatId, snapshotSequence, undefined, nextOffset);
      return {
        version: 2 as const,
        chatId,
        cursor: nextCursor,
        cursorSequence: snapshotSequence,
        lastSequence: snapshotSequence,
        tailSequence: bounds.last,
        hasMore: !complete || snapshotSequence < bounds.last,
        resync: true,
        resyncPage: {
          offset: resyncOffset,
          returnedRuns: page.runs.length,
          totalRuns: page.totalRuns,
          snapshotSequence,
          complete,
          omittedRuns: Math.max(0, page.totalRuns - resyncOffset - page.runs.length),
        },
        runs: page.runs,
        events,
        omission: combinedOmission,
      };
    }

    let nextSequence = cursorSequence;
    if (bounds.last > cursorSequence) {
      const rows = tableExists(db, "agent_turn_executions")
        ? db.query(
          `SELECT e.sequence, e.turn_id, e.run_revision, e.status, e.snapshot_json,
                  e.terminal_handoff_json, e.omission_json
             FROM agent_chat_events e
             JOIN agent_turn_executions t
               ON t.user_id = e.user_id AND t.id = e.turn_id AND t.chat_id = e.chat_id
            WHERE e.user_id = ? AND e.chat_id = ? AND e.sequence > ?
              AND CASE WHEN t.expires_at < 100000000000 THEN t.expires_at * 1000 ELSE t.expires_at END > ?
            ORDER BY e.sequence ASC
            LIMIT ?`,
        ).all(userId, chatId, cursorSequence, Date.now(), MAX_EVENTS) as StoredEventRow[]
        : db.query(
          `SELECT sequence, turn_id, run_revision, status, snapshot_json, terminal_handoff_json, omission_json
             FROM agent_chat_events
            WHERE user_id = ? AND chat_id = ? AND sequence > ?
            ORDER BY sequence ASC
            LIMIT ?`,
        ).all(userId, chatId, cursorSequence, MAX_EVENTS) as StoredEventRow[];
      let expectedSequence = cursorSequence + 1;
      for (const row of rows) {
        if (row.sequence > expectedSequence) {
          combinedOmission = mergeOmission(combinedOmission, {
            ...emptyOmission(),
            omittedEventCount: row.sequence - expectedSequence,
            firstOmittedSequence: expectedSequence,
            lastOmittedSequence: row.sequence - 1,
          });
        }
        const event = parseStoredEvent(db, userId, row, chatId);
        if (!event) {
          combinedOmission = mergeOmission(combinedOmission, {
            ...emptyOmission(),
            omittedEventCount: 1,
            firstOmittedSequence: row.sequence,
            lastOmittedSequence: row.sequence,
          });
        } else {
          events.push({ version: 2, chatId, sequence: row.sequence, run: event.run, omission: event.omission });
          combinedOmission = mergeOmission(combinedOmission, event.omission);
        }
        expectedSequence = row.sequence + 1;
      }
      if (rows.length === 0) {
        combinedOmission = mergeOmission(combinedOmission, {
          ...emptyOmission(),
          omittedEventCount: bounds.last - cursorSequence,
          firstOmittedSequence: cursorSequence + 1,
          lastOmittedSequence: bounds.last,
        });
        nextSequence = bounds.last;
      } else {
        nextSequence = rows[rows.length - 1]!.sequence;
      }
    }
    const nextCursor = mintCursor(userId, chatId, nextSequence);
    return {
      version: 2 as const,
      chatId,
      cursor: nextCursor,
      cursorSequence: nextSequence,
      lastSequence: nextSequence,
      tailSequence: bounds.last,
      hasMore: nextSequence < bounds.last,
      resync: false,
      runs: [],
      events,
      omission: combinedOmission,
    };
  })();
}

export function getAgentRun(userId: string, turnId: string, chatId?: string): AgentRunPublicV2 | null {
  const db = getDb();
  return db.transaction(() => {
    if (!validId(userId) || !validId(turnId) || (chatId !== undefined && !validId(chatId))) return null;
    const row = getProjectionByTurn(db, userId, turnId);
    if (!row || (chatId !== undefined && row.chat_id !== chatId) || !assertOwnedChat(db, userId, row.chat_id)) return null;
    if (!executionReadVisible(db, executionControlRow(db, userId, row.chat_id, turnId))) return null;
    if (!assertStoredTarget(db, row.chat_id, row.target_message_id, row.target_swipe_id)) return null;
    return parseStoredRun(row);
  })();
}

export function listAgentRunChangesForChat(userId: string, chatId: string, cursorToken?: unknown): AgentRunChangesV2 | null {
  return getAgentRunChanges(userId, chatId, cursorToken);
}

function workspaceRow(db: Database, userId: string, turnId: string): Record<string, unknown> | null {
  if (!tableExists(db, "agent_turn_workspaces") || !tableExists(db, "agent_turn_executions")
    || !validId(userId) || !validId(turnId)) return null;
  // Join through the owned execution so a forged workspace chat_id cannot
  // widen a turn lookup to another chat.
  const row = db.query(
    `SELECT w.workspace_id, w.turn_id, w.user_id, w.chat_id, w.revision, w.retention, w.expires_at,
            w.task_count, w.record_count, w.submission_count, w.artifact_count, w.byte_count
       FROM agent_turn_workspaces w
       JOIN agent_turn_executions e
         ON e.user_id = w.user_id AND e.id = w.turn_id AND e.chat_id = w.chat_id
      WHERE w.user_id = ? AND w.turn_id = ?
      LIMIT 1`,
  ).get(userId, turnId) as Record<string, unknown> | null;
  if (!row || workspaceExpired(workspacePolicy(row.retention), row.expires_at)) return null;
  return row;
}

function workspacePolicy(value: unknown): AgentWorkspaceRetentionV2 {
  return typeof value === "string" && RETENTIONS.has(value as AgentWorkspaceRetentionV2)
    ? value as AgentWorkspaceRetentionV2 : "operational";
}

function workspaceVisibility(value: unknown): AgentWorkspaceVisibilityV2 {
  if (value === "participants" || value === "public") return value;
  return "owner";
}

function workspaceCount(db: Database, table: string, userId: string, turnId: string, chatId: string, fallback: unknown): number {
  if (!tableExists(db, table)) return boundedCounter(fallback);
  try {
    const row = db.query(
      `SELECT COUNT(*) AS count
         FROM "${table}"
        WHERE user_id = ? AND turn_id = ? AND chat_id = ?
          AND (retention = 'chat_lifetime' OR expires_at > ?)`,
    ).get(userId, turnId, chatId, Math.floor(Date.now() / 1000)) as { count: number } | null;
    return boundedCounter(row?.count, boundedCounter(fallback));
  } catch {
    return boundedCounter(fallback);
  }
}


export function getWorkspaceIndex(userId: string, turnId: string): AgentWorkspaceIndexV2 | null {
  const db = getDb();
  if (!validId(userId) || !validId(turnId)) return null;
  const workspace = workspaceRow(db, userId, turnId);
  if (!workspace) return null;
  const chatId = workspace.chat_id;
  if (!validId(chatId)) return null;
  const execution = executionControlRow(db, userId, chatId, turnId);
  if (!execution || !executionReadVisible(db, execution)) return null;
  const retention = workspacePolicy(workspace.retention);
  const sections: AgentWorkspaceIndexV2["sections"] = [
    { section: "objective", count: 1, revision: boundedCounter(workspace.revision), retention, visibility: "owner" },
    { section: "tasks", count: workspaceCount(db, "agent_workspace_tasks", userId, turnId, chatId, workspace.task_count), revision: boundedCounter(workspace.revision), retention, visibility: "owner" },
    { section: "records", count: workspaceCount(db, "agent_workspace_records", userId, turnId, chatId, workspace.record_count), revision: boundedCounter(workspace.revision), retention, visibility: "owner" },
    { section: "submissions", count: workspaceCount(db, "agent_workspace_submissions", userId, turnId, chatId, workspace.submission_count), revision: boundedCounter(workspace.revision), retention, visibility: "owner" },
    { section: "artifacts", count: workspaceCount(db, "agent_workspace_artifacts", userId, turnId, chatId, workspace.artifact_count), revision: boundedCounter(workspace.revision), retention, visibility: "owner" },
  ];
  return { version: 2, turnId, workspaceRevision: boundedCounter(workspace.revision), sections, omitted: 0 };
}

function safePreviewId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) ? value : null;
}

function parseDependencies(value: unknown): number {
  if (typeof value !== "string") return 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? Math.min(parsed.length, 100000) : 0;
  } catch {
    return 0;
  }
}

function buildWorkspaceEntries(
  section: AgentWorkspaceSectionIdV2,
  rows: Array<Record<string, unknown>>,
  retention: AgentWorkspaceRetentionV2,
): AgentWorkspaceEntryPreviewV2[] {
  const result: AgentWorkspaceEntryPreviewV2[] = [];
  for (const row of rows.slice(0, MAX_WORKSPACE_ENTRIES)) {
    const id = safePreviewId(row.id);
    if (!workspaceChildVisible(row)) continue;
    if (!id) continue;
    const revision = boundedCounter(row.revision);
    const rowRetention = workspacePolicy(row.retention ?? retention);
    const visibility = workspaceVisibility(row.visibility);
    if (section === "tasks") {
      result.push({
        kind: "task", id, revision, retention: rowRetention, visibility,
        // Do not expose authored task prose. The UI receives a stable label.
        title: `Task ${id.slice(0, 8)}`,
        state: row.state === "blocked" || row.state === "submitted" || row.state === "done" ? row.state : "active",
        required: row.required === 1,
        assigned: typeof row.assigned_frame_id === "string" && row.assigned_frame_id.length > 0,
        dependencyCount: parseDependencies(row.dependencies_json),
      });
    } else if (section === "submissions") {
      const state = row.state === "accepted" || row.state === "rejected" ? row.state : "proposed";
      result.push({
        kind: "submission", id, revision, retention: rowRetention, visibility,
        taskId: safePreviewId(row.task_id) ?? "unknown-task",
        profileId: safePreviewId(row.child_frame_id), state,
      });
    } else if (section === "records") {
      const kind = row.kind === "finding" || row.kind === "decision" || row.kind === "question" ? row.kind : "finding";
      result.push({
        kind, id, revision, retention: rowRetention, visibility,
        title: kind,
        state: row.state === "accepted" ? "accepted" : "active",
      });
    } else if (section === "artifacts") {
      const digest = typeof row.digest === "string" && /^[0-9a-fA-F]{64}$/.test(row.digest)
        ? row.digest : null;
      const mimeType = typeof row.mime_type === "string"
        && row.mime_type.length <= 255
        && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(row.mime_type)
        ? row.mime_type : null;
      const publicationState = row.publication_state === "attached"
        || row.publication_state === "proposed"
        || row.publication_state === "published"
        ? row.publication_state : null;
      const byteCount = boundedCounter(row.byte_count, -1);
      if (!digest || !mimeType || !publicationState || byteCount < 0) continue;
      result.push({
        kind: "artifact", id, revision, retention: rowRetention, visibility,
        name: `Artifact ${id.slice(0, 8)}`, mimeType, byteCount,
        digestPrefix: digest.slice(0, 12),
        published: publicationState === "published",
      });
    }
  }
  return result;
}

export function getWorkspacePreview(
  userId: string,
  turnId: string,
  section: AgentWorkspaceSectionIdV2,
  page = 0,
  expectedRevision?: number,
): AgentWorkspacePreviewV2 | null {
  if (!validId(userId) || !validId(turnId) || !WORKSPACE_SECTIONS.includes(section)
    || !Number.isSafeInteger(page) || page < 0
    || (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) return null;
  const index = getWorkspaceIndex(userId, turnId);
  if (!index) return null;
  if (expectedRevision !== undefined && expectedRevision !== index.workspaceRevision) return null;
  const db = getDb();
  const workspace = workspaceRow(db, userId, turnId);
  if (!workspace || !validId(workspace.chat_id)) return null;
  const chatId = workspace.chat_id;
  const revision = index.workspaceRevision;
  if (section === "objective") {
    return { version: 2, turnId, section, workspaceRevision: revision, entries: [], nextPage: null, omitted: 0 };
  }
  const table = section === "tasks" ? "agent_workspace_tasks"
    : section === "records" ? "agent_workspace_records"
      : section === "submissions" ? "agent_workspace_submissions" : "agent_workspace_artifacts";
  const safePage = Math.min(page, 100000);
  const columns = section === "tasks"
    ? "task_id AS id, state, required, assigned_frame_id, dependencies_json, revision, retention, expires_at, updated_at"
    : section === "records"
      ? "record_id AS id, kind, revision, retention, expires_at, updated_at"
      : section === "submissions"
        ? "submission_id AS id, task_id, child_frame_id, state, revision, retention, expires_at, updated_at"
        : "artifact_id AS id, blob_digest AS digest, mime_type, byte_count, publication_state, revision, retention, expires_at, updated_at";
  const rows = db.query(
    `SELECT ${columns}
       FROM "${table}"
      WHERE user_id = ? AND turn_id = ? AND chat_id = ?
        AND (retention = 'chat_lifetime' OR expires_at > unixepoch())
      ORDER BY updated_at ASC, rowid ASC
      LIMIT ? OFFSET ?`,
  ).all(userId, turnId, chatId, MAX_WORKSPACE_ENTRIES + 1, safePage * MAX_WORKSPACE_ENTRIES) as Array<Record<string, unknown>>;
  const entries = buildWorkspaceEntries(section, rows, workspacePolicy(workspace.retention));
  const hasNext = rows.length > MAX_WORKSPACE_ENTRIES;
  return {
    version: 2,
    turnId,
    section,
    workspaceRevision: revision,
    entries: entries.slice(0, MAX_WORKSPACE_ENTRIES),
    nextPage: hasNext ? String(safePage + 1) : null,
    omitted: Math.max(0, rows.length - entries.length),
  };
}

export interface AgentRunProjectionReconcileResult {
  readonly inspectedProjections: number;
  readonly removedProjections: number;
  readonly inspectedWorkspaces: number;
  readonly removedWorkspaces: number;
  readonly preservedChatLifetimeEntries: number;
  readonly failures: number;
  readonly healthy: boolean;
}

export interface AgentRunProjectionReconcileOptions {
  readonly maxRows?: number;
  readonly nowMilliseconds?: number;
  readonly nowSeconds?: number;
}

/**
 * Reconcile only expired operational projections and turn-terminal workspace
 * rows. Chat-lifetime workspace entries and published artifact rows are never
 * deleted by this pass.
 */
export function reconcileAgentRunProjections(
  db: Database = getDb(),
  options: AgentRunProjectionReconcileOptions = {},
): AgentRunProjectionReconcileResult {
  const maxRows = typeof options.maxRows === "number" && Number.isSafeInteger(options.maxRows)
    ? Math.max(1, Math.min(options.maxRows, MAX_RECONCILIATION_ROWS))
    : MAX_RECONCILIATION_ROWS;
  const nowMilliseconds = options.nowMilliseconds ?? Date.now();
  const nowSeconds = options.nowSeconds ?? Math.floor(nowMilliseconds / 1000);
  let inspectedProjections = 0;
  let removedProjections = 0;
  let inspectedWorkspaces = 0;
  let removedWorkspaces = 0;
  let preservedChatLifetimeEntries = 0;
  let failures = 0;

  if (tableExists(db, "agent_run_projections") && tableExists(db, "agent_turn_executions")) {
    const candidates = db.query(
      `SELECT p.user_id, p.turn_id, e.expires_at
         FROM agent_run_projections p
         JOIN agent_turn_executions e
           ON e.user_id = p.user_id AND e.id = p.turn_id AND e.chat_id = p.chat_id
        ORDER BY p.updated_at ASC, p.turn_id ASC
        LIMIT ?`,
    ).all(maxRows) as Array<{ user_id: string; turn_id: string; expires_at: number | null }>;
    inspectedProjections = candidates.length;
    for (const candidate of candidates) {
      if (!isExpiredAt(candidate.expires_at, nowMilliseconds)) continue;
      try {
        const deleted = db.transaction(() => {
          if (tableExists(db, "agent_chat_events")) {
            db.query("DELETE FROM agent_chat_events WHERE user_id = ? AND turn_id = ?")
              .run(candidate.user_id, candidate.turn_id);
          }
          return db.query(
            `DELETE FROM agent_run_projections
              WHERE user_id = ? AND turn_id = ?`,
          ).run(candidate.user_id, candidate.turn_id).changes;
        })();
        removedProjections += deleted;
      } catch {
        failures += 1;
      }
    }
  }

  if (tableExists(db, "agent_turn_workspaces")) {
    const workspaces = db.query(
      `SELECT workspace_id, user_id
         FROM agent_turn_workspaces
        WHERE retention = 'turn_terminal' AND expires_at > 0 AND expires_at <= ?
        ORDER BY expires_at ASC, workspace_id ASC
        LIMIT ?`,
    ).all(nowSeconds, maxRows) as Array<{ workspace_id: string; user_id: string }>;
    inspectedWorkspaces = workspaces.length;
    const childTables = [
      "agent_workspace_tasks",
      "agent_workspace_records",
      "agent_workspace_submissions",
      "agent_workspace_artifacts",
    ] as const;
    for (const workspace of workspaces) {
      try {
        const outcome = db.transaction(() => {
          let preserved = 0;
          for (const table of childTables) {
            if (!tableExists(db, table)) continue;
            const row = db.query(
              `SELECT COUNT(*) AS count
                 FROM "${table}"
                WHERE user_id = ? AND workspace_id = ? AND retention = 'chat_lifetime'`,
            ).get(workspace.user_id, workspace.workspace_id) as { count?: unknown } | null;
            preserved += boundedCounter(row?.count);
            db.query(
              `DELETE FROM "${table}"
                WHERE user_id = ? AND workspace_id = ? AND retention <> 'chat_lifetime'`,
            ).run(workspace.user_id, workspace.workspace_id);
          }
          if (preserved > 0) {
            db.query(
              `UPDATE agent_turn_workspaces
                  SET state = 'expired', updated_at = ?
                WHERE user_id = ? AND workspace_id = ?`,
            ).run(nowSeconds, workspace.user_id, workspace.workspace_id);
            return { removed: 0, preserved };
          }
          const removed = db.query(
            "DELETE FROM agent_turn_workspaces WHERE user_id = ? AND workspace_id = ? AND retention = 'turn_terminal'",
          ).run(workspace.user_id, workspace.workspace_id).changes;
          return { removed, preserved: 0 };
        })();
        removedWorkspaces += outcome.removed;
        preservedChatLifetimeEntries += outcome.preserved;
      } catch {
        failures += 1;
      }
    }
  }

  return {
    inspectedProjections,
    removedProjections,
    inspectedWorkspaces,
    removedWorkspaces,
    preservedChatLifetimeEntries,
    failures,
    healthy: failures === 0,
  };
}

export function registerAgentRunStopHandler(
  userId: string,
  chatId: string,
  turnId: string,
  handler: AgentRunStopHandler,
): () => void {
  if (!validId(userId) || !validId(chatId) || !validId(turnId) || typeof handler !== "function") {
    throw new TypeError("invalid Agent Run stop handler registration");
  }
  const key = projectionKey(userId, chatId, turnId);
  stopHandlers.set(key, handler);
  return () => {
    if (stopHandlers.get(key) === handler) stopHandlers.delete(key);
  };
}

export function requestAgentRunStop(userId: string, chatId: string, turnId: string): AgentRunStopResponseV2 | null {
  if (!validId(userId) || !validId(chatId) || !validId(turnId)) return null;
  const db = getDb();
  const run = getAgentRun(userId, turnId, chatId);
  if (!run) return null;

  const initialControl = executionControlRow(db, userId, chatId, turnId);
  const initialDurableStatus = executionStatus(initialControl);
  if (initialControl && !initialDurableStatus) throw new AgentRunStopUnavailableError(turnId);
  if (TOO_LATE_STATUSES.has(run.status)) {
    if (initialDurableStatus && initialDurableStatus !== run.status) {
      throw new AgentRunStopUnavailableError(turnId);
    }
    return { version: 2, status: "too_late", turnId, revision: run.revision };
  }
  if (isTerminal(run.status)) {
    if (initialDurableStatus && initialDurableStatus !== run.status) {
      throw new AgentRunStopUnavailableError(turnId);
    }
    return { version: 2, status: "terminal", turnId, revision: run.revision };
  }

  const handler = stopHandlers.get(projectionKey(userId, chatId, turnId));
  if (handler) {
    const status = handler({ userId, chatId, turnId, generationId: run.generationId });
    if (status !== "accepted" && status !== "too_late" && status !== "terminal") {
      throw new Error("invalid Agent Run stop handler result");
    }
    return { version: 2, status, turnId, revision: getAgentRun(userId, turnId, chatId)?.revision ?? run.revision };
  }

  const result = withAgentRunProjectionTransaction((transactionDb) => {
    const control = executionControlRow(transactionDb, userId, chatId, turnId);
    const durableStatus = executionStatus(control);
    if (!control || !durableStatus) throw new AgentRunStopUnavailableError(turnId);

    const publishTerminal = (
      status: AgentRunPublicStatusV2,
      responseStatus: "accepted" | "terminal",
    ): AgentRunStopTransactionResult => {
      const latestRun = getAgentRun(userId, turnId, chatId);
      if (!latestRun) throw new AgentRunStopUnavailableError(turnId);
      if (isTerminal(latestRun.status)) {
        if (latestRun.status !== status) throw new AgentRunStopUnavailableError(turnId);
        return { status: "terminal", revision: latestRun.revision, changed: false };
      }
      const projection = appendDurableTerminalProjection(transactionDb, userId, latestRun, status);
      return {
        status: responseStatus,
        revision: projection.revision,
        event: projection.event,
        changed: projection.changed,
      };
    };

    if (TOO_LATE_STATUSES.has(durableStatus)) {
      return { status: "too_late" as const, revision: run.revision };
    }
    if (isTerminal(durableStatus)) {
      return publishTerminal(durableStatus, "terminal");
    }

    let durableResult: TurnCancellationResult;
    try {
      durableResult = requestDormantTurnCancellation({
        executionId: turnId,
        userId,
        chatId,
        db: transactionDb,
      });
    } catch {
      throw new AgentRunStopUnavailableError(turnId);
    }
    if (durableResult.code === "too_late") {
      return { status: "too_late" as const, revision: run.revision };
    }
    if (durableResult.code === "already_terminal") {
      if (!isTerminal(durableResult.execution.phase)) {
        throw new AgentRunStopUnavailableError(turnId);
      }
      return publishTerminal(durableResult.execution.phase, "terminal");
    }
    if (durableResult.code !== "cancelled" && durableResult.code !== "timed_out") {
      throw new AgentRunStopUnavailableError(turnId);
    }
    if (!isTerminal(durableResult.execution.phase)) {
      throw new AgentRunStopUnavailableError(turnId);
    }
    return publishTerminal(durableResult.execution.phase, "accepted");
  });
  return { version: 2, status: result.status, turnId, revision: result.revision };
}

export function __test__mintChatRunCursor(userId: string, chatId: string, lastSequence: number, now?: number): ChatRunCursorV1 {
  return mintCursor(userId, chatId, lastSequence, now);
}

export function __test__decodeChatRunCursor(token: string): { claims: CursorClaims; reason: "ok" | "expired" | "invalid" } {
  return decodeCursor(token);
}
