import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import type {
  AgentActivityLifecycle,
  AgentActivityNodeKind,
  AgentActivityNodeV1,
  AgentActivityRunV1,
  AgentActivitySnapshotV1,
  AgentActivityToolId,
  AgentActivityUsageV1,
  AgentPublicErrorCode,
} from "../types/agent-runtime";

export const AGENT_ACTIVITY_RUN_MAX_BYTES = 32 * 1024;
export const AGENT_ACTIVITY_RUN_MAX_COUNT = 16;
export const AGENT_ACTIVITY_CHAT_MAX_BYTES = 512 * 1024;

const MAX_ID_BYTES = 256;
const MAX_PROFILE_ID_BYTES = 128;
const MAX_NODES_PER_SNAPSHOT = 128;
const MAX_ERROR_CODES = 64;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const encoder = new TextEncoder();

const LIFECYCLES = new Set<AgentActivityLifecycle>([
  "queued", "running", "completed", "failed", "cancelled", "timed_out",
]);
const NODE_KINDS = new Set<AgentActivityNodeKind>([
  "root_turn", "provider_round", "child_invocation", "tool_attempt",
]);
const TOOL_IDS = new Set<AgentActivityToolId>([
  "lore_list_books", "lore_get_book", "lore_list_entries", "lore_get_entry",
  "lore_search_entries", "chat_search_history", "agent_delegate", "unknown_tool",
]);
const ERROR_CODES = new Set<AgentPublicErrorCode>([
  "capacity_exceeded", "host_child_admission_limit_exceeded", "host_tool_call_limit_exceeded",
  "child_admission_limit_exceeded", "tool_call_limit_exceeded", "logical_provider_request_limit_exceeded",
  "physical_dispatch_attempt_limit_exceeded", "child_output_token_limit_exceeded", "root_wall_clock_limit_exceeded",
  "activity_event_limit_exceeded", "activity_byte_limit_exceeded", "lifecycle_log_record_limit_exceeded",
  "context_limit_exceeded", "initial_input_limit_exceeded", "argument_limit_exceeded", "result_limit_exceeded",
  "continuation_limit_exceeded", "retained_output_limit_exceeded", "materialized_limit_exceeded", "timeout",
  "cancelled", "provider_unavailable", "provider_unsupported", "provider_request_error",
  "provider_tool_calling_unsupported", "provider_tool_continuation_unsupported",
  "provider_tool_finalization_unsupported",
  "provider_protocol_error", "provider_schema_error", "invalid_task", "invalid_profile", "invalid_arguments",
  "batch_rejected", "unknown_tool", "unauthorized", "integrity_error", "internal_error",
]);

export interface PersistAgentActivityRunInput {
  readonly userId: string;
  readonly chatId: string;
  readonly generationId: string;
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
  /** Omit this for setup failures; an empty aggregate snapshot is retained. */
  readonly snapshot?: unknown;
  readonly status?: AgentActivityLifecycle;
}

interface AgentActivityRunRow {
  readonly id: number;
  readonly generation_id: string;
  readonly chat_id: string;
  readonly target_message_id: string | null;
  readonly target_swipe_id: number | null;
  readonly snapshot_json: string;
  readonly byte_size: number;
}

function boundedId(value: unknown, maxBytes = MAX_ID_BYTES): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return encoder.encode(value).byteLength <= maxBytes ? value : null;
}

function boundedNumber(value: unknown, integer = true): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_COUNTER) return null;
  if (integer && !Number.isSafeInteger(value)) return null;
  return integer ? Math.floor(value) : value;
}

function cleanUsage(value: unknown): AgentActivityUsageV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const fields = ["inputTokens", "outputTokens", "totalTokens", "toolCalls", "childInvocations"]
    .map((key) => boundedNumber(source[key]));
  if (fields.some((field) => field === null)) return undefined;
  return {
    inputTokens: fields[0]!, outputTokens: fields[1]!, totalTokens: fields[2]!,
    toolCalls: fields[3]!, childInvocations: fields[4]!,
  };
}

function cleanNode(value: unknown): AgentActivityNodeV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = boundedId(source.id);
  const kind = typeof source.kind === "string" && NODE_KINDS.has(source.kind as AgentActivityNodeKind)
    ? source.kind as AgentActivityNodeKind : null;
  const actor = source.actor === "root" || source.actor === "provider" || source.actor === "child" || source.actor === "tool"
    ? source.actor : null;
  const phase = typeof source.phase === "string" && LIFECYCLES.has(source.phase as AgentActivityLifecycle)
    ? source.phase as AgentActivityLifecycle : null;
  const status = typeof source.status === "string" && LIFECYCLES.has(source.status as AgentActivityLifecycle)
    ? source.status as AgentActivityLifecycle : null;
  const startedAt = boundedNumber(source.startedAt);
  const elapsedMs = boundedNumber(source.elapsedMs);
  if (!id || !kind || !actor || !phase || !status || startedAt === null || elapsedMs === null) return null;
  const profileId = typeof source.profileId === "string" && encoder.encode(source.profileId).byteLength <= MAX_PROFILE_ID_BYTES
    ? source.profileId : undefined;
  const toolId = typeof source.toolId === "string"
    ? TOOL_IDS.has(source.toolId as AgentActivityToolId) ? source.toolId as AgentActivityToolId : "unknown_tool"
    : undefined;
  const roundIndex = boundedNumber(source.roundIndex);
  const continuationMode = source.continuationMode === "ordinary" || source.continuationMode === "finalization" || source.continuationMode === "none"
    ? source.continuationMode : undefined;
  const usage = cleanUsage(source.usage);
  const errorCode = typeof source.errorCode === "string" && ERROR_CODES.has(source.errorCode as AgentPublicErrorCode)
    ? source.errorCode as AgentPublicErrorCode : undefined;
  return {
    id, parentId: source.parentId === null ? null : boundedId(source.parentId), kind, actor, phase, status,
    ...(profileId ? { profileId } : {}), ...(toolId ? { toolId } : {}),
    ...(roundIndex !== null ? { roundIndex } : {}), ...(continuationMode ? { continuationMode } : {}),
    startedAt, elapsedMs, ...(usage ? { usage } : {}), ...(errorCode ? { errorCode } : {}),
  };
}

function cleanErrorCounts(value: unknown): Readonly<Partial<Record<AgentPublicErrorCode, number>>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Partial<Record<AgentPublicErrorCode, number>> = {};
  for (const [code, count] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(result).length >= MAX_ERROR_CODES || !ERROR_CODES.has(code as AgentPublicErrorCode)) continue;
    const normalized = boundedNumber(count);
    if (normalized !== null && normalized > 0) result[code as AgentPublicErrorCode] = normalized;
  }
  return result;
}

function cleanSnapshot(value: unknown, generationId: string, statusOverride?: AgentActivityLifecycle): AgentActivitySnapshotV1 {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rootId = boundedId(source.rootId) ?? generationId;
  const nodes = Array.isArray(source.nodes)
    ? source.nodes.slice(0, MAX_NODES_PER_SNAPSHOT).map(cleanNode).filter((node): node is AgentActivityNodeV1 => node !== null)
    : [];
  const status = statusOverride && LIFECYCLES.has(statusOverride) ? statusOverride
    : typeof source.status === "string" && LIFECYCLES.has(source.status as AgentActivityLifecycle)
      ? source.status as AgentActivityLifecycle : "failed";
  const terminalErrorCode = typeof source.terminalErrorCode === "string" && ERROR_CODES.has(source.terminalErrorCode as AgentPublicErrorCode)
    ? source.terminalErrorCode as AgentPublicErrorCode : undefined;
  return {
    version: 1, rootId, nodes, omittedNodeCount: boundedNumber(source.omittedNodeCount) ?? 0,
    errorCounts: cleanErrorCounts(source.errorCounts),
    usage: cleanUsage(source.usage) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, childInvocations: 0 },
    status, ...(terminalErrorCode ? { terminalErrorCode } : {}),
  };
}

function makeRun(input: PersistAgentActivityRunInput): AgentActivityRunV1 | null {
  const generationId = boundedId(input.generationId);
  if (!boundedId(input.userId) || !boundedId(input.chatId) || !generationId) return null;
  const targetMessageId = input.targetMessageId == null ? null : boundedId(input.targetMessageId);
  if (input.targetMessageId != null && !targetMessageId) return null;
  const targetSwipeId = input.targetSwipeId == null ? null : boundedNumber(input.targetSwipeId);
  if (input.targetSwipeId != null && targetSwipeId === null) return null;
  return {
    version: 1, generationId, chatId: input.chatId, targetMessageId, targetSwipeId,
    snapshot: cleanSnapshot(input.snapshot, generationId, input.status),
  };
}

function serializeRun(run: AgentActivityRunV1): { run: AgentActivityRunV1; json: string; byteSize: number } | null {
  let current = run;
  let json = JSON.stringify(current);
  let byteSize = encoder.encode(json).byteLength;
  if (byteSize <= AGENT_ACTIVITY_RUN_MAX_BYTES) return { run: current, json, byteSize };
  const nodes = [...run.snapshot.nodes];
  let omitted = run.snapshot.omittedNodeCount;
  while (nodes.length > 0 && byteSize > AGENT_ACTIVITY_RUN_MAX_BYTES) {
    nodes.splice(nodes.length > 1 ? 1 : 0, 1);
    omitted++;
    current = { ...run, snapshot: { ...run.snapshot, nodes, omittedNodeCount: omitted } };
    json = JSON.stringify(current);
    byteSize = encoder.encode(json).byteLength;
  }
  return byteSize <= AGENT_ACTIVITY_RUN_MAX_BYTES ? { run: current, json, byteSize } : null;
}

function evictOldestRuns(db: Database, userId: string, chatId: string): void {
  const rows = db.query(
    `SELECT id, byte_size FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? ORDER BY created_at DESC, id DESC`,
  ).all(userId, chatId) as Array<{ id: number; byte_size: number }>;
  let totalBytes = rows.reduce((sum, row) => sum + Math.max(0, row.byte_size), 0);
  let remainingCount = rows.length;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (
      remainingCount <= AGENT_ACTIVITY_RUN_MAX_COUNT &&
      totalBytes <= AGENT_ACTIVITY_CHAT_MAX_BYTES
    ) break;
    const row = rows[index]!;
    db.query("DELETE FROM agent_activity_runs WHERE id = ?").run(row.id);
    remainingCount -= 1;
    totalBytes -= Math.max(0, row.byte_size);
  }
  if (
    remainingCount > AGENT_ACTIVITY_RUN_MAX_COUNT ||
    totalBytes > AGENT_ACTIVITY_CHAT_MAX_BYTES
  ) {
    throw new Error("agent activity eviction failed to enforce bounds");
  }
}

/** Insert the compatibility terminal activity projection into an existing transaction. */
export function persistTerminalAgentActivityRunInTransaction(
  db: Database,
  input: PersistAgentActivityRunInput,
): AgentActivityRunV1 | null {
  const prepared = makeRun(input);
  if (!prepared) return null;
  const serialized = serializeRun(prepared);
  if (!serialized) return null;
  db.query(
    `INSERT INTO agent_activity_runs
      (user_id, chat_id, generation_id, target_message_id, target_swipe_id, snapshot_json, byte_size)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, chat_id, generation_id) DO UPDATE SET
      target_message_id = excluded.target_message_id, target_swipe_id = excluded.target_swipe_id,
      snapshot_json = excluded.snapshot_json, byte_size = excluded.byte_size, created_at = unixepoch()`,
  ).run(
    input.userId,
    input.chatId,
    prepared.generationId,
    prepared.targetMessageId,
    prepared.targetSwipeId,
    serialized.json,
    serialized.byteSize,
  );
  evictOldestRuns(db, input.userId, input.chatId);
  return serialized.run;
}

/** Call exactly once from the terminal CAS winner. The unique key makes retries idempotent. */
export function persistTerminalAgentActivityRun(input: PersistAgentActivityRunInput): AgentActivityRunV1 | null {
  try {
    const db = getDb();
    return db.transaction(() => persistTerminalAgentActivityRunInTransaction(db, input))();
  } catch {
    console.warn("[agent activity] terminal activity persistence unavailable");
    return null;
  }
}

function decodeRow(row: AgentActivityRunRow): AgentActivityRunV1 | null {
  try {
    const parsed = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    return {
      version: 1, generationId: row.generation_id, chatId: row.chat_id,
      targetMessageId: row.target_message_id, targetSwipeId: row.target_swipe_id,
      snapshot: cleanSnapshot(parsed.snapshot, row.generation_id),
    };
  } catch { return null; }
}

export function listAgentActivityRuns(userId: string, chatId: string): AgentActivityRunV1[] {
  if (!boundedId(userId) || !boundedId(chatId)) return [];
  const rows = getDb().query(
    `SELECT id, generation_id, chat_id, target_message_id, target_swipe_id, snapshot_json, byte_size
     FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(userId, chatId, AGENT_ACTIVITY_RUN_MAX_COUNT) as AgentActivityRunRow[];
  return rows.map(decodeRow).filter((run): run is AgentActivityRunV1 => run !== null);
}

export function ownsChatForActivity(userId: string, chatId: string): boolean {
  if (!boundedId(userId) || !boundedId(chatId)) return false;
  return Boolean(getDb().query("SELECT 1 FROM chats WHERE id = ? AND user_id = ? LIMIT 1").get(chatId, userId));
}

export function __test__serializeAgentActivityRun(input: PersistAgentActivityRunInput) {
  const prepared = makeRun(input);
  return prepared ? serializeRun(prepared) : null;
}
