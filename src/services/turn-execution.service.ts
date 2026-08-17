import { createHash } from "node:crypto";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { getDb } from "../db/connection";
import { AGENT_ACTIVITY_RUN_MAX_BYTES } from "./agent-activity-runs.service";
import { invalidateFrameCapabilitiesForTurn } from "./turn-workspace.service";

/**
 * Durable turn execution states.  This is intentionally a closed union: adding
 * a phase requires adding it to the transition table and its reconciliation
 * policy below.
 */
export const TURN_EXECUTION_PHASES = [
  "ASSEMBLE",
  "WORK",
  "COMPLETE",
  "RENDER",
  "PREPARE_COMMIT",
  "COMMITTING",
  "COMMITTED",
  "COMMIT_FAILED",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;
export type TurnExecutionPhase = (typeof TURN_EXECUTION_PHASES)[number];
export type TurnExecutionState = TurnExecutionPhase;

export const GENERATION_TARGETS = ["normal", "continue", "regenerate", "swipe"] as const;
export type GenerationTarget = (typeof GENERATION_TARGETS)[number];

export const TERMINAL_TURN_PHASES = [
  "COMMITTED",
  "COMMIT_FAILED",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const satisfies readonly TurnExecutionPhase[];
export type TerminalTurnPhase = (typeof TERMINAL_TURN_PHASES)[number];

export const REVERSIBLE_TURN_PHASES = [
  "ASSEMBLE",
  "WORK",
  "COMPLETE",
  "RENDER",
  "PREPARE_COMMIT",
] as const satisfies readonly TurnExecutionPhase[];

/**
 * The only phase edges accepted by the host.  Failure/cancellation/timeout
 * edges are explicit rather than inferred so a future caller cannot bypass a
 * terminal policy by inventing a new event string.
 */
export const TURN_EXECUTION_TRANSITIONS: Readonly<Record<TurnExecutionPhase, readonly TurnExecutionPhase[]>> = Object.freeze({
  ASSEMBLE: ["WORK", "FAILED", "CANCELLED", "TIMED_OUT"],
  WORK: ["COMPLETE", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT"],
  COMPLETE: ["RENDER", "FAILED", "CANCELLED", "TIMED_OUT"],
  RENDER: ["PREPARE_COMMIT", "FAILED", "CANCELLED", "TIMED_OUT"],
  PREPARE_COMMIT: ["COMMITTING", "FAILED", "CANCELLED", "TIMED_OUT"],
  COMMITTING: ["COMMITTED", "COMMIT_FAILED"],
  COMMITTED: [],
  COMMIT_FAILED: [],
  EXHAUSTED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
});

export function isTurnExecutionPhase(value: unknown): value is TurnExecutionPhase {
  return typeof value === "string" && (TURN_EXECUTION_PHASES as readonly string[]).includes(value);
}

export function isGenerationTarget(value: unknown): value is GenerationTarget {
  return typeof value === "string" && (GENERATION_TARGETS as readonly string[]).includes(value);
}

export function isAllowedTurnExecutionTransition(
  current: TurnExecutionPhase,
  next: TurnExecutionPhase,
): boolean {
  return isTurnExecutionPhase(current) && isTurnExecutionPhase(next)
    && TURN_EXECUTION_TRANSITIONS[current].includes(next);
}

export type TurnExecutionErrorCode =
  | "execution_not_found"
  | "execution_schema_unavailable"
  | "invalid_execution_input"
  | "invalid_transition"
  | "stale_execution"
  | "stale_owner"
  | "lease_conflict"
  | "already_terminal"
  | "too_late"
  | "deadline_exceeded"
  | "cancelled"
  | "commit_key_conflict"
  | "render_reservation_taken"
  | "commit_receipt_missing"
  | "commit_failed"
  | "runtime_disabled"
  | "readiness_unavailable";

export class TurnExecutionError extends Error {
  readonly code: TurnExecutionErrorCode;
  readonly executionId?: string;
  readonly phase?: TurnExecutionPhase;

  constructor(code: TurnExecutionErrorCode, message?: string, details?: {
    executionId?: string;
    phase?: TurnExecutionPhase;
  }) {
    super(message ? `${code}: ${message}` : code);
    this.name = "TurnExecutionError";
    this.code = code;
    this.executionId = details?.executionId;
    this.phase = details?.phase;
  }
}
export interface TurnTargetInput {
  readonly kind?: GenerationTarget;
  readonly target?: GenerationTarget;
  readonly messageId?: string | null;
  readonly swipeId?: number | null;
  readonly messageIndex?: number | null;
  readonly swipeCount?: number | null;
  readonly chatGenerationRevision?: number;
  readonly messageGenerationRevision?: number | null;
  readonly chatId?: string;
  readonly branchId?: string | null;
}
export interface TurnExecutionInput {
  id?: string;
  userId: string;
  chatId: string;
  branchId?: string | null;
  generationId?: string | null;
  target?: GenerationTarget | TurnTargetInput;
  targetKind?: GenerationTarget;
  targetMessageId?: string | null;
  targetSwipeId?: number | null;
  targetMessageIndex?: number | null;
  targetSwipeCount?: number | null;
  targetChatRevision?: number;
  targetMessageRevision?: number | null;
  /** Only stable target identity/revision fields are retained. */
  targetSnapshot?: unknown;
  presetSnapshotId?: string | null;
  presetRevision?: number | null;
  configSnapshotId?: string | null;
  configRevision?: number | null;
  concreteConnectionSnapshotId?: string | null;
  concreteConnectionRevision?: number | null;
  worldLoreSnapshotId?: string | null;
  worldLoreRevision?: number | null;
  mode?: "response" | "agentic";
  runtimeEpoch?: number;
  deadlineAt: number;
  expiresAt?: number | null;
  retention?: "operational" | "turn_terminal";
  rootLedger?: unknown;
  frameCapabilities?: unknown;
  workspaceId?: string | null;
  workspaceRevision?: number;
  ownerToken?: string;
  commitKey?: string;
  /** A signal is a convenience for the host; the signal itself is never persisted. */
  cancelSignal?: AbortSignal;
}

export interface TurnExecutionRecord {
  readonly id: string;
  readonly userId: string;
  readonly chatId: string;
  readonly branchId: string | null;
  readonly generationId: string;
  readonly targetKind: GenerationTarget;
  readonly targetMessageId: string | null;
  readonly targetSwipeId: number | null;
  readonly targetMessageIndex: number | null;
  readonly targetSwipeCount: number | null;
  readonly targetChatRevision: number;
  readonly targetMessageRevision: number | null;
  readonly targetSnapshot: unknown;
  readonly presetSnapshotId: string | null;
  readonly presetRevision: number;
  readonly configSnapshotId: string | null;
  readonly configRevision: number;
  readonly concreteConnectionSnapshotId: string | null;
  readonly concreteConnectionRevision: number;
  readonly worldLoreSnapshotId: string | null;
  readonly worldLoreRevision: number;
  readonly mode: "response" | "agentic";
  readonly phase: TurnExecutionPhase;
  readonly state: TurnExecutionPhase;
  readonly runtimeEpoch: number;
  readonly deadlineAt: number;
  readonly cancelRequested: boolean;
  readonly cancelRequestedAt: number | null;
  readonly workspaceId: string | null;
  readonly rootLedger: unknown;
  readonly frameCapabilities: unknown;
  readonly workspaceRevision: number;
  readonly casRevision: number;
  readonly phaseRevision: number;
  readonly casOwner: string | null;
  readonly leaseExpiresAt: number | null;
  readonly leaseGeneration: number;
  readonly commitKey: string;
  readonly terminalCode: string | null;
  readonly finalRenderReservationKey: string | null;
  readonly finalRenderReservations: readonly FinalRenderReservationRecord[];
  readonly finalRenderReservationReleasedAt: number | null;
  readonly terminalEventId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
  /** Frozen target/revision shape consumed by runtime decision and commit code. */
  readonly target: GenerationTargetRecord;
  readonly frozenRevisions: FrozenExecutionRevisions;
  readonly cas: ExecutionCasRecord;
}

export interface GenerationTargetRecord {
  readonly target: GenerationTarget;
  readonly chatId: string;
  readonly branchId: string | null;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly messageIndex: number | null;
  readonly swipeCount: number | null;
  readonly chatGenerationRevision: number;
  readonly messageGenerationRevision: number | null;
}

export interface FrozenExecutionRevisions {
  readonly target: GenerationTargetRecord;
  readonly presetId: string | null;
  readonly presetRevision: number;
  readonly configId: string | null;
  readonly configRevision: number;
  readonly connectionId: string | null;
  readonly connectionRevision: number;
  readonly worldLoreSnapshotId: string | null;
  readonly worldLoreRevision: number;
  readonly runtimeEpoch: number;
}

export interface ExecutionCasRecord {
  readonly revision: number;
  readonly owner: string | null;
  readonly ownerExpiresAt: number | null;
}

export interface FinalRenderReservationRecord {
  readonly id: string;
  readonly requestCount: 1;
  /** Non-empty provider chunks allowed by RENDER. */
  readonly activityChunks: number;
  /** RENDER chunks plus the one terminal projection event. */
  readonly activityEvents: number;
  readonly contextBytes: number;
  readonly outputBytes: number;
  /** Full context/output plus every terminal projection/receipt payload. */
  readonly maxBytes: number;
  readonly deadlineAt: number;
  readonly revision: number;
  readonly reservedAt: number;
}

export interface CreateTurnExecutionResult {
  readonly execution: TurnExecutionRecord;
  /** Host capability used to CAS this execution until a lease is claimed. */
  readonly ownerToken: string;
  readonly commitKey: string;
}

export interface TransitionTurnExecutionInput {
  executionId: string;
  expectedPhase: TurnExecutionPhase;
  nextPhase: TurnExecutionPhase;
  ownerToken: string;
  expectedRevision?: number;
  reason?: string;
  now?: number;
  db?: Database;
  /** Internal recovery path: the reconciliation lease already resolved controls. */
  ignoreCancellation?: boolean;
}

export interface TransitionTurnExecutionResult {
  readonly execution: TurnExecutionRecord;
  readonly terminalEventEmitted: boolean;
}

export interface ClaimTurnExecutionInput {
  executionId: string;
  ownerToken: string;
  leaseMs?: number;
  db?: Database;
}

export interface FinalRenderReservationInput {
  executionId: string;
  ownerToken: string;
  reservationKey?: string;
  maxBytes: number;
  contextBytes?: number;
  outputBytes?: number;
  activityChunks?: number;
  deadlineAt?: number;
  expectedRevision?: number;
  db?: Database;
}
export interface CommitReceiptInput {
  executionId: string;
  ownerToken?: string;
  /** The receipt is deliberately a bounded summary, not provider output. */
  summary?: unknown;
  receiptId?: string;
  workspaceId?: string;
  idempotencyKey?: string;
  messageId?: string | null;
  swipeId?: number | null;
  artifactRefCount?: number;
  db?: Database;
}

export interface TurnCommitReceipt {
  readonly id: string;
  readonly executionId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly commitKey: string;
  readonly workspaceId: string | null;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly artifactRefCount: number;
  readonly summary: unknown;
  readonly createdAt: number;
}
export interface TurnCommitTransactionInput<T> extends CommitReceiptInput {
  readonly apply: (db: Database) => T;
}

export interface TurnCommitTransactionResult<T> {
  readonly execution: TurnExecutionRecord;
  readonly receipt: TurnCommitReceipt;
  readonly duplicate: boolean;
  readonly value: T | undefined;
}

export interface ReconcileAgentTurnsResult {
  readonly runtimeEpoch: number;
  readonly inspected: number;
  readonly claimed: number;
  readonly failedInterrupted: number;
  readonly committedFromReceipt: number;
  readonly commitFailedWithoutReceipt: number;
  readonly projectionRepairs: number;
  readonly alreadyTerminal: number;
  readonly releasedReservations: number;
}
const MAX_TARGET_SNAPSHOT_BYTES = 8 * 1024;
const MAX_RESERVATION_BYTES = 256 * 1024 * 1024;
const FORBIDDEN_PERSISTED_KEYS = /(?:render[_-]?guidance|completion[_-]?guidance|transcript|carrier|reasoning|credential|secret|password|token|argument|args|result|response|content|body|prose|raw|provider)/i;
const MAX_ID_BYTES = 256;
const MAX_SUMMARY_BYTES = 32 * 1024;
/** Maximum serialized receipt summary written by this service. */
export const AGENTIC_RECEIPT_SUMMARY_BYTES_V1 = MAX_SUMMARY_BYTES;
/**
 * Canonical final-render reservation envelope. The two canonical projection
 * rows (`agent_run_projections` and `agent_chat_events`), the compatibility
 * projection, and the receipt are all written by the terminal transaction.
 * Keep their existing service/schema bounds here so callers cannot reserve
 * only provider output and undercount the durable handoff.
 */
export const AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1 = Object.freeze({
  terminalProjectionEvents: 1,
  projectionRows: 2,
  projectionSnapshotBytes: 64 * 1024,
  projectionHandoffBytes: 4 * 1024,
  projectionOmissionBytes: 4 * 1024,
  compatibilityProjectionBytes: AGENT_ACTIVITY_RUN_MAX_BYTES,
  receiptWrites: 1,
  receiptSummaryBytes: AGENTIC_RECEIPT_SUMMARY_BYTES_V1,
});

export interface FinalRenderReservationEnvelopeV1 {
  readonly activityChunks: number;
  /** Chunks plus the one terminal projection event. */
  readonly activityEvents: number;
  readonly projectionBytes: number;
  readonly compatibilityProjectionBytes: number;
  readonly receiptBytes: number;
  readonly contextBytes: number;
  readonly outputBytes: number;
  readonly maxBytes: number;
  /** Number of bounded durable payload writes accounted by this envelope. */
  readonly durablePayloadWrites: number;
}

function checkedReservationSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
      throw new RangeError("final render reservation exceeds safe integer bounds");
    }
    total += value;
  }
  if (total > MAX_RESERVATION_BYTES) {
    throw new RangeError("final render reservation exceeds host byte ceiling");
  }
  return total;
}

/**
 * Size one final render before the reservation CAS.
 *
 * Formula:
 *   activityEvents = activityChunks + terminalProjectionEvents
 *   projectionBytes = projectionRows *
 *     (projectionSnapshotBytes + projectionHandoffBytes + projectionOmissionBytes)
 *   maxBytes = contextBytes + outputBytes + projectionBytes +
 *     compatibilityProjectionBytes + receiptSummaryBytes
 */
export function calculateFinalRenderReservationEnvelopeV1(input: {
  readonly activityChunks: number;
  readonly contextBytes: number;
  readonly outputBytes: number;
}): FinalRenderReservationEnvelopeV1 {
  const { activityChunks, contextBytes, outputBytes } = input;
  if (
    !Number.isSafeInteger(activityChunks) || activityChunks < 0
    || !Number.isSafeInteger(contextBytes) || contextBytes < 0
    || !Number.isSafeInteger(outputBytes) || outputBytes <= 0
  ) {
    throw new RangeError("final render reservation components are invalid");
  }
  const components = AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1;
  if (activityChunks > Number.MAX_SAFE_INTEGER - components.terminalProjectionEvents) {
    throw new RangeError("final render activity event count exceeds safe integer bounds");
  }
  const projectionBytes = components.projectionRows * (
    components.projectionSnapshotBytes
    + components.projectionHandoffBytes
    + components.projectionOmissionBytes
  );
  const compatibilityProjectionBytes = components.compatibilityProjectionBytes;
  const receiptBytes = components.receiptSummaryBytes;
  const maxBytes = checkedReservationSum([
    contextBytes,
    outputBytes,
    projectionBytes,
    compatibilityProjectionBytes,
    receiptBytes,
  ]);
  return Object.freeze({
    activityChunks,
    activityEvents: activityChunks + components.terminalProjectionEvents,
    projectionBytes,
    compatibilityProjectionBytes,
    receiptBytes,
    contextBytes,
    outputBytes,
    maxBytes,
    durablePayloadWrites: components.projectionRows + 1 + components.receiptWrites,
  });
}

/** Convert the persisted event envelope back to the provider chunk allowance. */
export function finalRenderActivityChunkLimitV1(activityEvents: number): number {
  if (!Number.isSafeInteger(activityEvents) || activityEvents < AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1.terminalProjectionEvents) {
    return -1;
  }
  return activityEvents - AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1.terminalProjectionEvents;
}
const MAX_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_MS = 30 * 1000;
const TERMINAL_PHASE_SET = new Set<TurnExecutionPhase>(TERMINAL_TURN_PHASES);
const REVERSIBLE_PHASE_SET = new Set<TurnExecutionPhase>(REVERSIBLE_TURN_PHASES);

let receiptRepairHandler: ((execution: TurnExecutionRecord, receipt: TurnCommitReceipt) => void | Promise<void>) | null = null;

function nowMs(): number {
  return Date.now();
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedId(value: unknown, field: string, required = false): string | null {
  if (value == null || value === "") {
    if (required) throw new TurnExecutionError("invalid_execution_input", `${field} is required`);
    return null;
  }
  if (typeof value !== "string" || byteLength(value) > MAX_ID_BYTES) {
    throw new TurnExecutionError("invalid_execution_input", `${field} is invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, fallback: number | null = null): number | null {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TurnExecutionError("invalid_execution_input", `${field} is invalid`);
  }
  return value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Keep only bounded scalar metadata.  This is used for ledger/capability and
 * receipt summaries, and intentionally drops fields that could carry model
 * work, tool payloads, credentials, provider carriers, or raw response data.
 */
function scrubSummary(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value == null ? null : undefined;
  if (typeof value === "string") {
    if (byteLength(value) > 256) return value.slice(0, 256);
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, 64)) {
      const clean = scrubSummary(item, depth + 1);
      if (clean !== undefined) out.push(clean);
    }
    return out;
  }
  if (typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 128)) {
    if (FORBIDDEN_PERSISTED_KEYS.test(key)) continue;
    const clean = scrubSummary(item, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function scrubJson(value: unknown, maxBytes: number): string {
  const clean = scrubSummary(value) ?? {};
  let encoded = JSON.stringify(clean);
  if (byteLength(encoded) <= maxBytes) return encoded;
  // A summary is never silently truncated into a syntactically invalid value;
  // drop optional data instead.  The fact that data was omitted is not itself
  // persisted as model content.
  encoded = "{}";
  return encoded;
}

function parseSummary(value: unknown): unknown {
  return scrubSummary(parseJson(value)) ?? {};
}

function hasTable(db: Database, table: string): boolean {
  const row = db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) as { present?: number } | null;
  return !!row?.present;
}

function ensureExecutionTable(db: Database): void {
  if (!hasTable(db, "agent_turn_executions")) {
    throw new TurnExecutionError("execution_schema_unavailable", "agent turn execution schema is unavailable");
  }
}

function tableColumns(db: Database, table: string): Set<string> {
  if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error("invalid table name");
  const rows = db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function quoteColumn(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("invalid column name");
  return `"${name}"`;
}

function firstColumn(columns: Set<string>, ...names: string[]): string | null {
  return names.find((name) => columns.has(name)) ?? null;
}

function addValue(
  columns: Set<string>,
  values: Record<string, unknown>,
  candidates: readonly string[],
  value: unknown,
): void {
  const column = firstColumn(columns, ...candidates);
  if (column && value !== undefined) values[column] = value;
}

function addValues(
  columns: Set<string>,
  values: Record<string, unknown>,
  candidates: readonly string[],
  value: unknown,
): void {
  for (const candidate of candidates) {
    if (columns.has(candidate) && value !== undefined) values[candidate] = value;
  }
}

function insertRow(db: Database, table: string, values: Record<string, unknown>): void {
  const columns = tableColumns(db, table);
  const selected = Object.entries(values).filter(([name, value]) => columns.has(name) && value !== undefined);
  if (selected.length === 0) throw new TurnExecutionError("execution_schema_unavailable", `${table} has no writable columns`);
  const names = selected.map(([name]) => quoteColumn(name)).join(", ");
  const placeholders = selected.map(() => "?").join(", ");
  try {
    db.query(`INSERT INTO ${quoteColumn(table)} (${names}) VALUES (${placeholders})`).run(
      ...(selected.map(([, value]) => value).filter((value): value is SQLQueryBindings => value === null
        || typeof value === "string"
        || typeof value === "number"
        || typeof value === "bigint"
        || typeof value === "boolean"
        || value instanceof Uint8Array)),
    );
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (/unique|constraint/i.test(message) && /commit|execution/i.test(message)) {
      throw new TurnExecutionError("commit_key_conflict", "commit key is already in use");
    }
    throw error;
  }
}
function updateRow(
  db: Database,
  table: string,
  values: Record<string, unknown>,
  where: string,
  params: readonly SQLQueryBindings[],
): number {
  const columns = tableColumns(db, table);
  const selected = Object.entries(values).filter(([name, value]) => columns.has(name) && value !== undefined);
  if (selected.length === 0) return 0;
  const assignments = selected.map(([name]) => `${quoteColumn(name)} = ?`).join(", ");
  const bindings: SQLQueryBindings[] = selected
    .map(([, value]) => value)
    .filter((value): value is SQLQueryBindings => value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "bigint"
      || typeof value === "boolean"
      || value instanceof Uint8Array);
  const result = db.query(`UPDATE ${quoteColumn(table)} SET ${assignments} WHERE ${where}`).run(
    ...bindings,
    ...params,
  ) as { changes?: number };
  return Number(result?.changes ?? 0);
}
function normalizeTarget(input: TurnExecutionInput): GenerationTargetRecord {
  let kind = input.targetKind;
  let messageId = input.targetMessageId ?? null;
  let swipeId = input.targetSwipeId ?? null;
  if (typeof input.target === "string") kind = input.target;
  if (input.target && typeof input.target === "object") {
    kind = input.target.kind ?? input.target.target;
    messageId = input.target.messageId ?? messageId;
    swipeId = input.target.swipeId ?? swipeId;
  }
  if (!isGenerationTarget(kind)) throw new TurnExecutionError("invalid_execution_input", "target must be normal, continue, regenerate, or swipe");
  messageId = boundedId(messageId, "targetMessageId");
  swipeId = boundedInteger(swipeId, "targetSwipeId");
  let messageIndexValue = input.targetMessageIndex;
  let swipeCountValue = input.targetSwipeCount;
  let chatRevisionValue = input.targetChatRevision;
  let messageRevisionValue = input.targetMessageRevision;
  if (input.target && typeof input.target === "object") {
    messageIndexValue = input.target.messageIndex ?? messageIndexValue;
    swipeCountValue = input.target.swipeCount ?? swipeCountValue;
    chatRevisionValue = input.target.chatGenerationRevision ?? chatRevisionValue;
    messageRevisionValue = input.target.messageGenerationRevision ?? messageRevisionValue;
  }
  const messageIndex = boundedInteger(messageIndexValue, "targetMessageIndex");
  const swipeCount = boundedInteger(swipeCountValue, "targetSwipeCount");
  const chatGenerationRevision = boundedInteger(chatRevisionValue, "targetChatRevision", 0) ?? 0;
  const messageGenerationRevision = boundedInteger(messageRevisionValue, "targetMessageRevision");
  if (kind === "swipe" && swipeId == null) {
    throw new TurnExecutionError("invalid_execution_input", "swipe target requires targetSwipeId");
  }
  if (chatGenerationRevision < 0 || (messageIndex != null && messageIndex < 0)
    || (swipeCount != null && swipeCount < 1)
    || (messageGenerationRevision != null && messageGenerationRevision < 0)) {
    throw new TurnExecutionError("invalid_execution_input", "target revisions are invalid");
  }
  return {
    target: kind,
    chatId: input.chatId,
    branchId: boundedId(input.branchId, "branchId"),
    messageId,
    swipeId,
    messageIndex,
    swipeCount,
    chatGenerationRevision,
    messageGenerationRevision,
  };
}

function normalizeInput(input: TurnExecutionInput): {
  userId: string;
  chatId: string;
  deadlineAt: number;
  id: string;
  branchId: string | null;
  generationId: string;
  target: GenerationTargetRecord;
  targetSnapshot: string;
  mode: "response" | "agentic";
  runtimeEpoch: number;
  expiresAt: number;
  retention: "operational" | "turn_terminal";
  rootLedger: string;
  frameCapabilities: string;
  workspaceId: string | null;
  workspaceRevision: number;
  ownerToken: string;
  commitKey: string;
} {
  const userId = boundedId(input.userId, "userId", true)!;
  const chatId = boundedId(input.chatId, "chatId", true)!;
  if (typeof input.deadlineAt !== "number" || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0) {
    throw new TurnExecutionError("invalid_execution_input", "deadlineAt is invalid");
  }
  const id = boundedId(input.id, "id") ?? randomId("turn");
  const target = normalizeTarget(input);
  const targetSnapshotValue = scrubSummary({
    ...(input.targetSnapshot && typeof input.targetSnapshot === "object" ? input.targetSnapshot as Record<string, unknown> : {}),
    branchId: target.branchId,
    messageId: target.messageId,
    swipeId: target.swipeId,
    targetKind: target.target,
    messageIndex: target.messageIndex,
    swipeCount: target.swipeCount,
    chatGenerationRevision: target.chatGenerationRevision,
    messageGenerationRevision: target.messageGenerationRevision,
  });
  const targetSnapshot = scrubJson(targetSnapshotValue, MAX_TARGET_SNAPSHOT_BYTES);
  const mode = input.mode ?? "agentic";
  if (mode !== "agentic" && mode !== "response") throw new TurnExecutionError("invalid_execution_input", "mode is invalid");
  const runtimeEpoch = input.runtimeEpoch ?? getRuntimeEpoch();
  if (!Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < 0) throw new TurnExecutionError("invalid_execution_input", "runtimeEpoch is invalid");
  const retention = input.retention ?? "operational";
  if (retention !== "operational" && retention !== "turn_terminal") {
    throw new TurnExecutionError("invalid_execution_input", "retention is invalid");
  }
  const expiresAt = input.expiresAt == null
    ? Math.max(input.deadlineAt, nowMs() + 24 * 60 * 60 * 1000)
    : boundedInteger(input.expiresAt, "expiresAt");
  if (expiresAt == null || expiresAt < 0) throw new TurnExecutionError("invalid_execution_input", "expiresAt is invalid");
  return {
    userId,
    chatId,
    deadlineAt: input.deadlineAt,
    id,
    branchId: target.branchId,
    generationId: boundedId(input.generationId, "generationId") ?? id,
    target,
    targetSnapshot,
    mode,
    runtimeEpoch,
    expiresAt,
    retention,
    rootLedger: scrubJson(input.rootLedger ?? {}, MAX_SUMMARY_BYTES),
    frameCapabilities: scrubJson(input.frameCapabilities ?? {}, MAX_SUMMARY_BYTES),
    workspaceId: boundedId(input.workspaceId, "workspaceId"),
    workspaceRevision: boundedInteger(input.workspaceRevision, "workspaceRevision", 0) ?? 0,
    ownerToken: boundedId(input.ownerToken, "ownerToken") ?? randomId("owner"),
    commitKey: boundedId(input.commitKey, "commitKey") ?? randomId("commit"),
  };
}

function rawExecution(db: Database, executionId: string): Record<string, unknown> | null {
  const row = db.query(`SELECT * FROM ${quoteColumn("agent_turn_executions")} WHERE id = ? LIMIT 1`).get(executionId) as Record<string, unknown> | null;
  return row ?? null;
}

function rowString(row: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "string") return value;
  }
  return null;
}

function rowNumber(row: Record<string, unknown>, ...names: string[]): number | null {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
  }
  return null;
}

function rowBool(row: Record<string, unknown>, ...names: string[]): boolean {
  const value = rowNumber(row, ...names);
  if (value != null) return value !== 0;
  const string = rowString(row, ...names);
  return string === "true" || string === "1";
}

function rowPhase(row: Record<string, unknown>): TurnExecutionPhase {
  const value = rowString(row, "phase", "state");
  if (!isTurnExecutionPhase(value)) throw new TurnExecutionError("execution_schema_unavailable", "execution contains an unknown phase");
  return value;
}

function parseReservations(value: unknown): FinalRenderReservationRecord[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const reservations: FinalRenderReservationRecord[] = [];
  for (const item of parsed.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const id = boundedId(candidate.id, "reservationId");
    const requestCount = candidate.requestCount === 1 ? 1 : boundedInteger(candidate.requestCount, "requestCount");
    const activityChunks = boundedInteger(candidate.activityChunks, "activityChunks", 0);
    const activityEvents = boundedInteger(candidate.activityEvents, "activityEvents", 1);
    const contextBytes = boundedInteger(candidate.contextBytes, "contextBytes");
    const outputBytes = boundedInteger(candidate.outputBytes, "outputBytes");
    const maxBytes = boundedInteger(candidate.maxBytes, "maxBytes");
    const deadlineAt = boundedInteger(candidate.deadlineAt, "reservationDeadline");
    const revision = boundedInteger(candidate.revision, "reservationRevision");
    const reservedAt = boundedInteger(candidate.reservedAt, "reservedAt");
    if (
      !id || requestCount !== 1 || activityChunks == null || activityEvents == null
      || contextBytes == null || outputBytes == null || maxBytes == null
      || deadlineAt == null || revision == null || reservedAt == null
    ) continue;
    let envelope: FinalRenderReservationEnvelopeV1;
    try {
      envelope = calculateFinalRenderReservationEnvelopeV1({ activityChunks, contextBytes, outputBytes });
    } catch {
      continue;
    }
    if (activityEvents !== envelope.activityEvents || maxBytes !== envelope.maxBytes) continue;
    reservations.push({
      id,
      requestCount: 1,
      activityChunks,
      activityEvents,
      contextBytes,
      outputBytes,
      maxBytes,
      deadlineAt,
      revision,
      reservedAt,
    });
  }
  return reservations;
}

function recordFromRow(row: Record<string, unknown>): TurnExecutionRecord {
  const phase = rowPhase(row);
  const id = rowString(row, "id", "execution_id");
  const userId = rowString(row, "user_id");
  const chatId = rowString(row, "chat_id");
  const commitKey = rowString(row, "commit_key");
  if (!id || !userId || !chatId || !commitKey) throw new TurnExecutionError("execution_schema_unavailable", "execution identity is incomplete");
  if (TERMINAL_PHASE_SET.has(phase)) {
    invalidateFrameCapabilitiesForTurn({ userId, chatId, turnId: id });
  }
  const targetKindValue = rowString(row, "target_kind", "target");
  if (!isGenerationTarget(targetKindValue)) throw new TurnExecutionError("execution_schema_unavailable", "execution target is invalid");
  const targetMessageIndex = rowNumber(row, "target_message_index");
  const targetSwipeCount = rowNumber(row, "target_swipe_count");
  const targetChatRevision = rowNumber(row, "target_chat_revision") ?? 0;
  const targetMessageRevision = rowNumber(row, "target_message_revision");
  const target: GenerationTargetRecord = {
    target: targetKindValue,
    chatId,
    branchId: rowString(row, "branch_id"),
    messageId: rowString(row, "target_message_id", "message_id"),
    swipeId: rowNumber(row, "target_swipe_id", "swipe_id"),
    messageIndex: targetMessageIndex,
    swipeCount: targetSwipeCount,
    chatGenerationRevision: targetChatRevision,
    messageGenerationRevision: targetMessageRevision,
  };
  const presetRevision = rowNumber(row, "preset_revision") ?? 0;
  const configRevision = rowNumber(row, "config_revision") ?? 0;
  const concreteConnectionRevision = rowNumber(row, "concrete_connection_revision", "connection_revision") ?? 0;
  const worldLoreRevision = rowNumber(row, "world_lore_revision", "world_revision") ?? 0;
  const runtimeEpoch = rowNumber(row, "runtime_epoch") ?? 0;
  const casRevision = rowNumber(row, "cas_revision", "revision") ?? 0;
  const phaseRevision = rowNumber(row, "phase_revision") ?? casRevision;
  const cancelRequestedAt = rowNumber(row, "cancel_requested_at");
  const finalRenderReservations = parseReservations(rowString(row, "final_render_reservations_json"));
  const activeReservation = finalRenderReservations[finalRenderReservations.length - 1] ?? null;
  return {
    id,
    userId,
    chatId,
    branchId: target.branchId,
    generationId: rowString(row, "generation_id") ?? id,
    targetKind: targetKindValue,
    targetMessageId: target.messageId,
    targetSwipeId: target.swipeId,
    targetMessageIndex,
    targetSwipeCount,
    targetChatRevision,
    targetMessageRevision,
    targetSnapshot: target,
    presetSnapshotId: rowString(row, "preset_snapshot_id", "preset_id"),
    presetRevision,
    configSnapshotId: rowString(row, "config_snapshot_id", "config_id"),
    configRevision,
    concreteConnectionSnapshotId: rowString(row, "concrete_connection_snapshot_id", "connection_snapshot_id"),
    concreteConnectionRevision,
    worldLoreSnapshotId: rowString(row, "world_lore_snapshot_id", "world_snapshot_id"),
    worldLoreRevision,
    mode: rowString(row, "mode") === "response" ? "response" : "agentic",
    phase,
    state: phase,
    runtimeEpoch,
    deadlineAt: rowNumber(row, "deadline_at", "deadline") ?? 0,
    cancelRequested: cancelRequestedAt != null || rowBool(row, "cancel_requested", "cancellation_requested"),
    cancelRequestedAt,
    workspaceId: rowString(row, "workspace_id"),
    rootLedger: parseSummary(rowString(row, "root_ledger_json", "root_ledger")),
    frameCapabilities: parseSummary(rowString(row, "frame_capabilities_json", "frame_capabilities")),
    workspaceRevision: rowNumber(row, "workspace_revision") ?? 0,
    casRevision,
    phaseRevision,
    casOwner: rowString(row, "cas_owner", "lease_owner", "owner_token"),
    leaseExpiresAt: rowNumber(row, "cas_expires_at", "lease_expires_at", "lease_expires"),
    leaseGeneration: rowNumber(row, "lease_generation") ?? 0,
    commitKey,
    terminalCode: rowString(row, "terminal_code", "error_code"),
    finalRenderReservationKey: activeReservation?.id ?? null,
    finalRenderReservations,
    finalRenderReservationReleasedAt: TERMINAL_PHASE_SET.has(phase) && finalRenderReservations.length === 0
      ? rowNumber(row, "terminal_at")
      : null,
    terminalEventId: rowString(row, "terminal_event_id", "terminal_event_key"),
    createdAt: rowNumber(row, "created_at") ?? 0,
    updatedAt: rowNumber(row, "updated_at") ?? 0,
    terminalAt: rowNumber(row, "terminal_at"),
    target,
    frozenRevisions: {
      target,
      presetId: rowString(row, "preset_snapshot_id", "preset_id"),
      presetRevision,
      configId: rowString(row, "config_snapshot_id", "config_id"),
      configRevision,
      connectionId: rowString(row, "concrete_connection_snapshot_id", "connection_snapshot_id"),
      connectionRevision: concreteConnectionRevision,
      worldLoreSnapshotId: rowString(row, "world_lore_snapshot_id", "world_snapshot_id"),
      worldLoreRevision,
      runtimeEpoch,
    },
    cas: {
      revision: casRevision,
      owner: rowString(row, "cas_owner", "lease_owner", "owner_token"),
      ownerExpiresAt: rowNumber(row, "cas_expires_at", "lease_expires_at", "lease_expires"),
    },
  };
}

function requireExecution(db: Database, executionId: string, userId?: string): { raw: Record<string, unknown>; execution: TurnExecutionRecord } {
  ensureExecutionTable(db);
  const raw = rawExecution(db, executionId);
  if (!raw) throw new TurnExecutionError("execution_not_found", "execution not found", { executionId });
  const execution = recordFromRow(raw);
  if (userId !== undefined && execution.userId !== userId) {
    throw new TurnExecutionError("execution_not_found", "execution not found", { executionId });
  }
  if (TERMINAL_PHASE_SET.has(execution.phase)) {
    invalidateFrameCapabilitiesForTurn({
      userId: execution.userId,
      chatId: execution.chatId,
      turnId: execution.id,
    });
  }
  return { raw, execution };
}

function ownerMatches(execution: TurnExecutionRecord, ownerToken: string): boolean {
  return !!ownerToken && execution.casOwner === ownerToken;
}

function ensureOwner(execution: TurnExecutionRecord, ownerToken: string): void {
  if (!ownerMatches(execution, ownerToken)) {
    throw new TurnExecutionError("stale_owner", "execution lease is not owned by this caller", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
}

function terminalCodeFor(phase: TerminalTurnPhase, reason?: string): string {
  if (reason && byteLength(reason) <= 128) return reason;
  switch (phase) {
    case "FAILED": return "failed";
    case "CANCELLED": return "cancelled";
    case "TIMED_OUT": return "timed_out";
    case "EXHAUSTED": return "exhausted";
    case "COMMIT_FAILED": return "commit_failed";
    case "COMMITTED": return "committed";
  }
}


function updateCas(
  db: Database,
  current: TurnExecutionRecord,
  values: Record<string, unknown>,
  ownerToken: string | null,
  expectedPhase: TurnExecutionPhase,
  expectedRevision: number,
): boolean {
  const columns = tableColumns(db, "agent_turn_executions");
  const where: string[] = ["id = ?"];
  const params: SQLQueryBindings[] = [current.id];
  if (columns.has("phase")) {
    where.push("phase = ?");
    params.push(expectedPhase);
  } else if (columns.has("state")) {
    where.push("state = ?");
    params.push(expectedPhase);
  }
  if (columns.has("cas_revision")) {
    where.push("cas_revision = ?");
    params.push(expectedRevision);
  } else if (columns.has("revision")) {
    where.push("revision = ?");
    params.push(expectedRevision);
  }
  if (ownerToken === null) {
    const ownerColumns = ["cas_owner", "lease_owner", "owner_token"].filter((column) => columns.has(column));
    if (ownerColumns.length === 0) return false;
    for (const column of ownerColumns) where.push(`${column} IS NULL`);
  } else if (columns.has("cas_owner")) {
    where.push("cas_owner = ?");
    params.push(ownerToken);
  } else if (columns.has("lease_owner")) {
    where.push("lease_owner = ?");
    params.push(ownerToken);
  } else if (columns.has("owner_token")) {
    where.push("owner_token = ?");
    params.push(ownerToken);
  } else {
    return false;
  }
  return updateRow(db, "agent_turn_executions", values, where.join(" AND "), params) === 1;
}

function terminalUpdateValues(
  phase: TerminalTurnPhase,
  now: number,
  reason?: string,
): Record<string, unknown> {
  const terminalEventId = randomId("terminal");
  return {
    phase,
    state: phase,
    terminal_code: terminalCodeFor(phase, reason),
    terminal_at: now,
    updated_at: now,
    terminal_event_id: terminalEventId,
    terminal_event_emitted_at: now,
    cancel_requested_at: phase === "CANCELLED" ? now : undefined,
    cas_owner: null,
    lease_owner: null,
    cas_expires_at: null,
    lease_expires_at: null,
    final_render_reservation_key: null,
    final_render_reservation_released_at: now,
    final_render_reservations_json: "[]",
  };
}

function terminalizeWithCas(
  db: Database,
  current: TurnExecutionRecord,
  ownerToken: string | null,
  expectedPhase: TurnExecutionPhase,
  expectedRevision: number,
  phase: TerminalTurnPhase,
  reason?: string,
  now = nowMs(),
): TransitionTurnExecutionResult {
  const values = terminalUpdateValues(phase, now, reason);
  values.cas_revision = current.casRevision + 1;
  values.phase_revision = current.phaseRevision + 1;
  if (!updateCas(db, current, values, ownerToken, expectedPhase, expectedRevision)) {
    const latest = rawExecution(db, current.id);
    if (latest && TERMINAL_PHASE_SET.has(rowPhase(latest))) {
      return { execution: recordFromRow(latest), terminalEventEmitted: false };
    }
    throw new TurnExecutionError("stale_execution", "execution changed before terminal transition", {
      executionId: current.id,
      phase: current.phase,
    });
  }
  const latest = requireExecution(db, current.id).execution;
  return { execution: latest, terminalEventEmitted: true };
}

/** Create the durable row before any generation/chat mutation is permitted. */
export function createTurnExecution(
  input: TurnExecutionInput,
  db: Database = getDb(),
): CreateTurnExecutionResult {
  ensureExecutionTable(db);
  const normalized = normalizeInput(input);
  const columns = tableColumns(db, "agent_turn_executions");
  const now = nowMs();
  const values: Record<string, unknown> = {};
  addValue(columns, values, ["id"], normalized.id);
  addValue(columns, values, ["user_id"], normalized.userId);
  addValue(columns, values, ["chat_id"], normalized.chatId);
  addValue(columns, values, ["branch_id"], normalized.branchId);
  addValue(columns, values, ["generation_id"], normalized.generationId);
  addValue(columns, values, ["target_kind", "target"], normalized.target.target);
  addValue(columns, values, ["target_message_id", "message_id"], normalized.target.messageId);
  addValue(columns, values, ["target_swipe_id", "swipe_id"], normalized.target.swipeId);
  addValue(columns, values, ["target_message_index"], normalized.target.messageIndex);
  addValue(columns, values, ["target_swipe_count"], normalized.target.swipeCount);
  addValue(columns, values, ["target_chat_revision"], normalized.target.chatGenerationRevision);
  addValue(columns, values, ["target_message_revision"], normalized.target.messageGenerationRevision);
  addValue(columns, values, ["target_snapshot_json", "target_snapshot"], normalized.targetSnapshot);
  addValue(columns, values, ["preset_snapshot_id", "preset_id"], boundedId(input.presetSnapshotId, "presetSnapshotId"));
  addValue(columns, values, ["preset_revision"], boundedInteger(input.presetRevision, "presetRevision", 0));
  addValue(columns, values, ["config_snapshot_id", "config_id"], boundedId(input.configSnapshotId, "configSnapshotId"));
  addValue(columns, values, ["config_revision"], boundedInteger(input.configRevision, "configRevision", 0));
  addValue(columns, values, ["concrete_connection_snapshot_id", "connection_snapshot_id"], boundedId(input.concreteConnectionSnapshotId, "concreteConnectionSnapshotId"));
  addValue(columns, values, ["concrete_connection_revision", "connection_revision"], boundedInteger(input.concreteConnectionRevision, "concreteConnectionRevision", 0));
  addValue(columns, values, ["world_lore_snapshot_id", "world_snapshot_id"], boundedId(input.worldLoreSnapshotId, "worldLoreSnapshotId"));
  addValue(columns, values, ["world_lore_revision", "world_revision"], boundedInteger(input.worldLoreRevision, "worldLoreRevision", 0));
  addValue(columns, values, ["mode"], normalized.mode);
  addValues(columns, values, ["phase", "state"], "ASSEMBLE");
  addValue(columns, values, ["runtime_epoch"], normalized.runtimeEpoch);
  addValue(columns, values, ["deadline_at", "deadline"], normalized.deadlineAt);
  addValue(columns, values, ["cancel_requested_at"], null);
  addValues(columns, values, ["cancel_requested", "cancellation_requested"], 0);
  addValue(columns, values, ["workspace_id"], normalized.workspaceId);
  addValue(columns, values, ["root_ledger_json", "root_ledger"], normalized.rootLedger);
  addValue(columns, values, ["frame_capabilities_json", "frame_capabilities"], normalized.frameCapabilities);
  addValue(columns, values, ["workspace_revision"], normalized.workspaceRevision);
  addValue(columns, values, ["cas_revision", "revision"], 0);
  addValue(columns, values, ["phase_revision"], 0);
  addValues(columns, values, ["cas_owner", "lease_owner", "owner_token"], normalized.ownerToken);
  addValue(columns, values, ["lease_generation"], 1);
  addValue(columns, values, ["cas_expires_at", "lease_expires_at", "lease_expires"], now + DEFAULT_LEASE_MS);
  addValue(columns, values, ["commit_key"], normalized.commitKey);
  addValue(columns, values, ["final_render_reservations_json"], "[]");
  addValue(columns, values, ["expires_at"], normalized.expiresAt);
  addValue(columns, values, ["retention"], normalized.retention);
  addValue(columns, values, ["created_at"], now);
  addValue(columns, values, ["updated_at"], now);
  try {
    insertRow(db, "agent_turn_executions", values);
  } catch (error) {
    if (error instanceof TurnExecutionError) throw error;
    const message = String((error as Error)?.message ?? error);
    if (/unique|constraint/i.test(message) && /commit_key/i.test(message)) {
      throw new TurnExecutionError("commit_key_conflict", "commit key is already in use", { executionId: normalized.id });
    }
    throw error;
  }
  const execution = requireExecution(db, normalized.id).execution;
  if (input.cancelSignal) {
    input.cancelSignal.addEventListener("abort", () => {
      try {
        requestTurnCancellation({ executionId: normalized.id, ownerToken: normalized.ownerToken, db });
      } catch {
        // A terminal owner or process restart owns cleanup; abort never retries.
      }
    }, { once: true });
  }
  return { execution, ownerToken: normalized.ownerToken, commitKey: normalized.commitKey };
}

export function getTurnExecution(
  executionId: string,
  userId?: string,
  db: Database = getDb(),
): TurnExecutionRecord | null {
  try {
    return requireExecution(db, executionId, userId).execution;
  } catch (error) {
    if (error instanceof TurnExecutionError && error.code === "execution_not_found") return null;
    throw error;
  }
}

export function claimTurnExecution(
  input: ClaimTurnExecutionInput,
): TurnExecutionRecord {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (TERMINAL_PHASE_SET.has(current.phase)) return current;
  const leaseMs = Math.max(1_000, Math.min(MAX_LEASE_MS, Math.floor(input.leaseMs ?? DEFAULT_LEASE_MS)));
  if (!input.ownerToken || byteLength(input.ownerToken) > MAX_ID_BYTES) {
    throw new TurnExecutionError("invalid_execution_input", "ownerToken is invalid", { executionId: current.id });
  }
  const now = nowMs();
  if (current.casOwner && current.casOwner !== input.ownerToken
    && current.leaseExpiresAt != null && current.leaseExpiresAt > now
    && current.runtimeEpoch === getRuntimeEpoch()) {
    throw new TurnExecutionError("lease_conflict", "execution lease is held by another owner", {
      executionId: current.id,
      phase: current.phase,
    });
  }
  const values: Record<string, unknown> = {
    cas_owner: input.ownerToken,
    lease_owner: input.ownerToken,
    cas_expires_at: now + leaseMs,
    lease_expires_at: now + leaseMs,
    runtime_epoch: getRuntimeEpoch(),
    cas_revision: current.casRevision + 1,
    revision: current.casRevision + 1,
    phase_revision: current.phaseRevision,
    lease_generation: current.leaseGeneration + 1,
    updated_at: now,
  };
  const columns = tableColumns(db, "agent_turn_executions");
  const where = ["id = ?"];
  const params: SQLQueryBindings[] = [current.id];
  if (columns.has("cas_revision")) {
    where.push("cas_revision = ?");
    params.push(current.casRevision);
  } else if (columns.has("revision")) {
    where.push("revision = ?");
    params.push(current.casRevision);
  }
  if (columns.has("phase")) {
    where.push("phase = ?");
    params.push(current.phase);
  } else if (columns.has("state")) {
    where.push("state = ?");
    params.push(current.phase);
  }
  const changes = updateRow(db, "agent_turn_executions", values, where.join(" AND "), params);
  if (changes !== 1) throw new TurnExecutionError("stale_execution", "execution changed before lease claim", { executionId: current.id });
  return requireExecution(db, current.id).execution;
}

export function transitionTurnExecution(input: TransitionTurnExecutionInput): TransitionTurnExecutionResult {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (TERMINAL_PHASE_SET.has(current.phase)) {
    throw new TurnExecutionError("already_terminal", "execution is already terminal", { executionId: current.id, phase: current.phase });
  }
  if (current.phase !== input.expectedPhase) {
    throw new TurnExecutionError("stale_execution", "execution phase no longer matches", { executionId: current.id, phase: current.phase });
  }
  ensureOwner(current, input.ownerToken);
  const expectedRevision = input.expectedRevision ?? current.casRevision;
  if (current.casRevision !== expectedRevision) {
    throw new TurnExecutionError("stale_execution", "execution revision no longer matches", { executionId: current.id, phase: current.phase });
  }
  if (!isAllowedTurnExecutionTransition(input.expectedPhase, input.nextPhase)) {
    throw new TurnExecutionError("invalid_transition", `${input.expectedPhase} cannot transition to ${input.nextPhase}`, {
      executionId: current.id,
      phase: current.phase,
    });
  }
  const now = input.now ?? nowMs();
  if (!input.ignoreCancellation && REVERSIBLE_PHASE_SET.has(current.phase)) {
    if (current.cancelRequested && input.nextPhase !== "CANCELLED") {
      return terminalizeWithCas(db, current, input.ownerToken, current.phase, expectedRevision, "CANCELLED", "cancelled", now);
    }
    if (current.deadlineAt > 0 && now >= current.deadlineAt && input.nextPhase !== "TIMED_OUT") {
      return terminalizeWithCas(db, current, input.ownerToken, current.phase, expectedRevision, "TIMED_OUT", "timed_out", now);
    }
  }
  const terminal = TERMINAL_PHASE_SET.has(input.nextPhase);
  const values: Record<string, unknown> = terminal
    ? {
        ...terminalUpdateValues(input.nextPhase as TerminalTurnPhase, now, input.reason),
        cas_revision: current.casRevision + 1,
        phase_revision: current.phaseRevision + 1,
      }
    : {
        phase: input.nextPhase,
        state: input.nextPhase,
        cas_revision: current.casRevision + 1,
        revision: current.casRevision + 1,
        phase_revision: current.phaseRevision + 1,
        updated_at: now,
      };
  if (!updateCas(db, current, values, input.ownerToken, input.expectedPhase, expectedRevision)) {
    const latest = rawExecution(db, current.id);
    if (latest && TERMINAL_PHASE_SET.has(rowPhase(latest))) {
      throw new TurnExecutionError("already_terminal", "execution became terminal", { executionId: current.id, phase: rowPhase(latest) });
    }
    throw new TurnExecutionError("stale_execution", "execution changed before transition", { executionId: current.id, phase: current.phase });
  }
  return {
    execution: requireExecution(db, current.id).execution,
    terminalEventEmitted: terminal,
  };
}

export type TurnCancellationCode = "cancelled" | "timed_out" | "too_late" | "already_terminal";

export interface TurnCancellationResult {
  readonly execution: TurnExecutionRecord;
  readonly code: TurnCancellationCode;
}

export function requestTurnCancellation(input: {
  executionId: string;
  ownerToken?: string;
  reason?: string;
  now?: number;
  db?: Database;
}): TurnCancellationResult {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (current.phase === "COMMITTING" || current.phase === "COMMITTED") {
    return { execution: current, code: "too_late" };
  }
  if (TERMINAL_PHASE_SET.has(current.phase)) return { execution: current, code: "already_terminal" };
  if (input.ownerToken) ensureOwner(current, input.ownerToken);
  const now = input.now ?? nowMs();
  const target: TerminalTurnPhase = current.deadlineAt > 0 && now >= current.deadlineAt ? "TIMED_OUT" : "CANCELLED";
  const owner = input.ownerToken ?? current.casOwner;
  if (!owner) throw new TurnExecutionError("stale_owner", "execution has no active owner", { executionId: current.id });
  const result = terminalizeWithCas(db, current, owner, current.phase, current.casRevision, target, input.reason ?? (target === "TIMED_OUT" ? "timed_out" : "cancelled"), now);
  return { execution: result.execution, code: target === "TIMED_OUT" ? "timed_out" : "cancelled" };
}

/**
 * Cancel a reversible execution left without a lease after process recovery.
 * The ownerless predicate is part of the same CAS as terminalization; callers
 * cannot cancel a row whose owner changed between the read and the update.
 */
export function requestDormantTurnCancellation(input: {
  executionId: string;
  userId: string;
  chatId: string;
  reason?: string;
  now?: number;
  db?: Database;
}): TurnCancellationResult {
  const db = input.db ?? getDb();
  const required = requireExecution(db, input.executionId);
  const current = required.execution;
  if (current.userId !== input.userId || current.chatId !== input.chatId) {
    throw new TurnExecutionError("execution_not_found", "execution does not belong to the requested owner", {
      executionId: current.id,
    });
  }
  if (current.phase === "COMMITTING" || current.phase === "COMMITTED") {
    return { execution: current, code: "too_late" };
  }
  if (TERMINAL_PHASE_SET.has(current.phase)) {
    return { execution: current, code: "already_terminal" };
  }
  if (!REVERSIBLE_PHASE_SET.has(current.phase)) {
    throw new TurnExecutionError("too_late", "execution is no longer reversible", {
      executionId: current.id,
      phase: current.phase,
    });
  }

  const columns = tableColumns(db, "agent_turn_executions");
  const ownerColumns = ["cas_owner", "lease_owner", "owner_token"].filter((column) => columns.has(column));
  if (ownerColumns.length === 0 || ownerColumns.some((column) => {
    const value = required.raw[column];
    return value !== null && value !== undefined;
  })) {
    throw new TurnExecutionError("stale_owner", "execution has an active owner", {
      executionId: current.id,
      phase: current.phase,
    });
  }

  const now = input.now ?? nowMs();
  const target: TerminalTurnPhase = current.deadlineAt > 0 && now >= current.deadlineAt ? "TIMED_OUT" : "CANCELLED";
  const result = terminalizeWithCas(
    db,
    current,
    null,
    current.phase,
    current.casRevision,
    target,
    input.reason ?? (target === "TIMED_OUT" ? "timed_out" : "cancelled"),
    now,
  );
  const settledCode: TurnCancellationCode = result.execution.phase === "TIMED_OUT"
    ? "timed_out"
    : result.execution.phase === "CANCELLED"
      ? "cancelled"
      : "already_terminal";
  return { execution: result.execution, code: settledCode };
}


export const cancelTurnExecution = requestTurnCancellation;

export function expireTurnExecution(input: {
  executionId: string;
  ownerToken: string;
  now?: number;
  db?: Database;
}): { execution: TurnExecutionRecord; code: "timed_out" | "too_late" | "already_terminal" } {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (current.phase === "COMMITTING" || current.phase === "COMMITTED") return { execution: current, code: "too_late" };
  if (TERMINAL_PHASE_SET.has(current.phase)) return { execution: current, code: "already_terminal" };
  ensureOwner(current, input.ownerToken);
  const now = input.now ?? nowMs();
  if (current.deadlineAt > 0 && now < current.deadlineAt) {
    throw new TurnExecutionError("deadline_exceeded", "execution deadline has not elapsed", { executionId: current.id, phase: current.phase });
  }
  const result = terminalizeWithCas(db, current, input.ownerToken, current.phase, current.casRevision, "TIMED_OUT", "timed_out", now);
  return { execution: result.execution, code: "timed_out" };
}

export function reserveFinalRender(
  input: FinalRenderReservationInput,
): { execution: TurnExecutionRecord; reservationKey: string; maxBytes: number } {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (TERMINAL_PHASE_SET.has(current.phase)) {
    if (current.phase === "COMMITTED") throw new TurnExecutionError("too_late", "execution has already committed", { executionId: current.id, phase: current.phase });
    throw new TurnExecutionError("already_terminal", "execution is already terminal", { executionId: current.id, phase: current.phase });
  }
  ensureOwner(current, input.ownerToken);
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > MAX_RESERVATION_BYTES) {
    throw new TurnExecutionError("invalid_execution_input", "final render reservation is invalid", { executionId: current.id });
  }
  const contextBytes = input.contextBytes ?? 0;
  const outputBytes = input.outputBytes ?? input.maxBytes;
  const activityChunks = input.activityChunks ?? 0;
  let envelope: FinalRenderReservationEnvelopeV1;
  try {
    envelope = calculateFinalRenderReservationEnvelopeV1({ activityChunks, contextBytes, outputBytes });
  } catch {
    throw new TurnExecutionError("invalid_execution_input", "final render reservation is invalid", { executionId: current.id });
  }
  if (input.maxBytes !== envelope.maxBytes) {
    throw new TurnExecutionError("invalid_execution_input", "final render reservation undercounts its durable envelope", { executionId: current.id });
  }
  const key = boundedId(input.reservationKey, "reservationKey") ?? randomId("render");
  const existing = current.finalRenderReservations.find((reservation) => reservation.id === key);
  if (existing) {
    if (
      existing.contextBytes === envelope.contextBytes
      && existing.outputBytes === envelope.outputBytes
      && existing.activityChunks === envelope.activityChunks
      && existing.activityEvents === envelope.activityEvents
      && existing.maxBytes === envelope.maxBytes
    ) {
      return { execution: current, reservationKey: key, maxBytes: existing.maxBytes };
    }
    throw new TurnExecutionError("render_reservation_taken", "final render reservation key is already in use", { executionId: current.id, phase: current.phase });
  }
  if (current.finalRenderReservations.length > 0) {
    throw new TurnExecutionError("render_reservation_taken", "final render is already reserved", { executionId: current.id, phase: current.phase });
  }
  const expectedRevision = input.expectedRevision ?? current.casRevision;
  if (expectedRevision !== current.casRevision) throw new TurnExecutionError("stale_execution", "execution revision no longer matches", { executionId: current.id, phase: current.phase });
  const now = nowMs();
  const reservation: FinalRenderReservationRecord = {
    id: key,
    requestCount: 1,
    activityChunks: envelope.activityChunks,
    activityEvents: envelope.activityEvents,
    contextBytes: envelope.contextBytes,
    outputBytes: envelope.outputBytes,
    maxBytes: envelope.maxBytes,
    deadlineAt: input.deadlineAt ?? current.deadlineAt,
    revision: current.casRevision + 1,
    reservedAt: now,
  };

  const values: Record<string, unknown> = {
    final_render_reservations_json: scrubJson([...current.finalRenderReservations, reservation], 64 * 1024),
    final_render_request_count: 1,
    final_render_context_bytes: envelope.contextBytes,
    final_render_output_bytes: envelope.outputBytes,
    final_render_activity_events: envelope.activityEvents,
    final_render_deadline_at: reservation.deadlineAt,
    cas_revision: current.casRevision + 1,
    revision: current.casRevision + 1,
    updated_at: now,
  };
  if (!updateCas(db, current, values, input.ownerToken, current.phase, expectedRevision)) {
    throw new TurnExecutionError("stale_execution", "execution changed before render reservation", { executionId: current.id, phase: current.phase });
  }
  return { execution: requireExecution(db, current.id).execution, reservationKey: key, maxBytes: envelope.maxBytes };
}

/** CAS-only commit gate for callers that already own the outer transaction. */
export function beginTurnCommitInTransaction(
  db: Database,
  input: { executionId: string; ownerToken: string; expectedRevision?: number },
): TransitionTurnExecutionResult {
  return transitionTurnExecution({
    executionId: input.executionId,
    expectedPhase: "PREPARE_COMMIT",
    nextPhase: "COMMITTING",
    ownerToken: input.ownerToken,
    expectedRevision: input.expectedRevision,
    db,
    ignoreCancellation: false,
  });
}

export function beginTurnCommit(input: {
  executionId: string;
  ownerToken: string;
  expectedRevision?: number;
  db?: Database;
}): TransitionTurnExecutionResult {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (current.phase === "COMMITTED") {
    return { execution: current, terminalEventEmitted: false };
  }
  if (current.phase === "COMMIT_FAILED") throw new TurnExecutionError("already_terminal", "commit already failed", { executionId: current.id, phase: current.phase });
  return transitionTurnExecution({
    executionId: input.executionId,
    expectedPhase: "PREPARE_COMMIT",
    nextPhase: "COMMITTING",
    ownerToken: input.ownerToken,
    expectedRevision: input.expectedRevision,
    db,
  });
}

function receiptTableAvailable(db: Database): boolean {
  return hasTable(db, "agent_turn_commit_receipts");
}

function rawReceipt(db: Database, execution: TurnExecutionRecord): Record<string, unknown> | null {
  if (!receiptTableAvailable(db)) return null;
  const columns = tableColumns(db, "agent_turn_commit_receipts");
  const keyColumn = firstColumn(columns, "execution_id", "turn_id");
  const commitColumn = firstColumn(columns, "commit_key");
  const orderColumn = firstColumn(columns, "receipt_id", "id", keyColumn ?? "execution_id")!;
  if (keyColumn) {
    const row = db.query(`SELECT * FROM ${quoteColumn("agent_turn_commit_receipts")} WHERE ${quoteColumn(keyColumn)} = ? ORDER BY ${quoteColumn(orderColumn)} LIMIT 1`).get(execution.id) as Record<string, unknown> | null;
    if (row) return row;
  }
  if (commitColumn) {
    return db.query(`SELECT * FROM ${quoteColumn("agent_turn_commit_receipts")} WHERE ${quoteColumn(commitColumn)} = ? ORDER BY ${quoteColumn(orderColumn)} LIMIT 1`).get(execution.commitKey) as Record<string, unknown> | null;
  }
  return null;
}

function assertReceiptTarget(
  execution: TurnExecutionRecord,
  workspaceId: string | null,
  messageId: string | null,
  swipeId: number | null,
): void {
  if (workspaceId !== execution.workspaceId) {
    throw new TurnExecutionError("invalid_execution_input", "receipt workspace does not match the immutable execution workspace", { executionId: execution.id, phase: execution.phase });
  }
  if (execution.targetKind === "normal") {
    if (swipeId !== null && swipeId !== 0) {
      throw new TurnExecutionError("invalid_execution_input", "normal receipt swipe does not match the immutable target", { executionId: execution.id, phase: execution.phase });
    }
    return;
  }
  if (messageId !== execution.targetMessageId || swipeId !== execution.targetSwipeId) {
    throw new TurnExecutionError("invalid_execution_input", "receipt message or swipe does not match the immutable execution target", { executionId: execution.id, phase: execution.phase });
  }
}

function receiptFromRow(row: Record<string, unknown>, execution: TurnExecutionRecord): TurnCommitReceipt {
  const id = rowString(row, "id", "receipt_id") ?? `${execution.id}:${execution.commitKey}`;
  const executionId = rowString(row, "execution_id", "turn_id") ?? execution.id;
  const userId = rowString(row, "user_id") ?? execution.userId;
  const chatId = rowString(row, "chat_id") ?? execution.chatId;
  const commitKey = rowString(row, "commit_key") ?? execution.commitKey;
  const workspaceId = rowString(row, "workspace_id") ?? execution.workspaceId;
  const messageId = rowString(row, "message_id") ?? execution.targetMessageId;
  const swipeId = rowNumber(row, "swipe_id") ?? execution.targetSwipeId;
  if (
    executionId !== execution.id
    || userId !== execution.userId
    || chatId !== execution.chatId
    || commitKey !== execution.commitKey
  ) {
    throw new TurnExecutionError("invalid_execution_input", "receipt authority does not match the immutable execution owner", { executionId: execution.id, phase: execution.phase });
  }
  assertReceiptTarget(execution, workspaceId, messageId, swipeId);
  return {
    id,
    executionId,
    userId,
    chatId,
    commitKey,
    workspaceId,
    messageId,
    swipeId,
    artifactRefCount: rowNumber(row, "artifact_ref_count") ?? 0,
    summary: parseSummary(rowString(row, "summary_json", "summary")),
    createdAt: rowNumber(row, "created_at", "committed_at") ?? 0,
  };
}

function writeReceipt(db: Database, execution: TurnExecutionRecord, input: CommitReceiptInput, now: number): TurnCommitReceipt {
  if (!receiptTableAvailable(db)) throw new TurnExecutionError("execution_schema_unavailable", "commit receipt schema is unavailable", { executionId: execution.id });
  const columns = tableColumns(db, "agent_turn_commit_receipts");
  const id = boundedId(input.receiptId, "receiptId") ?? randomId("receipt");
  const summary = scrubJson(input.summary ?? {}, MAX_SUMMARY_BYTES);
  const workspaceId = boundedId(input.workspaceId ?? execution.workspaceId, "workspaceId", true)!;
  const messageId = input.messageId ?? execution.targetMessageId;
  const swipeId = input.swipeId ?? execution.targetSwipeId;
  assertReceiptTarget(execution, workspaceId, messageId, swipeId);
  const idempotencyKey = boundedId(input.idempotencyKey ?? execution.commitKey, "idempotencyKey", true)!;
  const summaryDigest = createHash("sha256").update(summary).digest("hex");
  const values: Record<string, unknown> = {};
  addValue(columns, values, ["id", "receipt_id"], id);
  addValues(columns, values, ["execution_id", "turn_id"], execution.id);
  addValue(columns, values, ["workspace_id"], workspaceId);
  addValue(columns, values, ["user_id"], execution.userId);
  addValue(columns, values, ["chat_id"], execution.chatId);
  addValue(columns, values, ["commit_key"], execution.commitKey);
  addValue(columns, values, ["idempotency_key"], idempotencyKey);
  addValue(columns, values, ["state"], "committed");
  addValue(columns, values, ["summary_digest"], summaryDigest);
  addValue(columns, values, ["summary_json", "summary"], summary);
  addValue(columns, values, ["message_id"], messageId);
  addValue(columns, values, ["swipe_id"], swipeId);
  addValue(columns, values, ["artifact_ref_count"], input.artifactRefCount ?? 0);
  addValue(columns, values, ["workspace_revision"], execution.workspaceRevision);
  addValue(columns, values, ["created_at", "committed_at"], now);
  addValue(columns, values, ["updated_at"], now);
  insertRow(db, "agent_turn_commit_receipts", values);
  const row = rawReceipt(db, execution);
  if (!row) throw new TurnExecutionError("commit_receipt_missing", "commit receipt was not readable after insert", { executionId: execution.id });
  return receiptFromRow(row, execution);
}

function repairCommittedFromReceipt(
  db: Database,
  current: TurnExecutionRecord,
  receipt: TurnCommitReceipt,
  ownerToken: string,
  now: number,
  notifyProjectionRepair = true,
): TurnExecutionRecord {
  if (current.phase === "COMMITTED") return current;
  if (current.phase !== "COMMITTING") throw new TurnExecutionError("invalid_transition", "only COMMITTING executions can be receipt-repaired", { executionId: current.id, phase: current.phase });
  const values = terminalUpdateValues("COMMITTED", now, "committed");
  values.cas_revision = current.casRevision + 1;
  values.phase_revision = current.phaseRevision + 1;
  if (!updateCas(db, current, values, ownerToken, "COMMITTING", current.casRevision)) {
    const latest = requireExecution(db, current.id).execution;
    if (latest.phase === "COMMITTED") return latest;
    throw new TurnExecutionError("stale_execution", "execution changed during receipt repair", { executionId: current.id, phase: current.phase });
  }
  const repaired = requireExecution(db, current.id).execution;
  if (notifyProjectionRepair) void notifyReceiptRepair(repaired, receipt);
  return repaired;
}

/** Register only a projection repairer for an interrupted terminal transition. */
export type AgentTurnTerminalRecoveryHandler = (
  execution: TurnExecutionRecord,
  status: "FAILED" | "COMMIT_FAILED",
) => void;

let terminalRecoveryHandler: AgentTurnTerminalRecoveryHandler | null = null;

export function registerAgentTurnTerminalRecovery(
  handler: AgentTurnTerminalRecoveryHandler | null,
): void {
  terminalRecoveryHandler = handler;
}

/** Register only a projection/handoff repairer. It must not dispatch providers or replay side effects. */
export function registerAgentTurnReceiptRepair(
  handler: ((execution: TurnExecutionRecord, receipt: TurnCommitReceipt) => void | Promise<void>) | null,
): void {
  receiptRepairHandler = handler;
}

async function notifyReceiptRepair(execution: TurnExecutionRecord, receipt: TurnCommitReceipt): Promise<void> {
  if (!receiptRepairHandler) return;
  try {

    await receiptRepairHandler(execution, receipt);
  } catch (error) {
    console.warn("[agent-turn] receipt projection repair failed", error);
  }
}
function invokeTerminalRecovery(execution: TurnExecutionRecord, status: "FAILED" | "COMMIT_FAILED"): void {
  terminalRecoveryHandler?.(execution, status);
}

export function finalizeTurnCommit(input: CommitReceiptInput): { execution: TurnExecutionRecord; receipt: TurnCommitReceipt; duplicate: boolean } {
  const db = input.db ?? getDb();
  let current = requireExecution(db, input.executionId).execution;
  const existing = rawReceipt(db, current);
  if (existing) {
    const receipt = receiptFromRow(existing, current);
    if (current.phase === "COMMITTING") {
      const owner = input.ownerToken ?? current.casOwner;
      if (!owner) throw new TurnExecutionError("stale_owner", "execution has no active owner", { executionId: current.id });
      current = repairCommittedFromReceipt(db, current, receipt, owner, nowMs());
    }
    if (current.phase === "COMMITTED") return { execution: current, receipt, duplicate: true };
  }
  if (current.phase !== "COMMITTING") {
    if (current.phase === "COMMITTED") {
      const receipt = rawReceipt(db, current);
      if (!receipt) throw new TurnExecutionError("commit_receipt_missing", "committed execution has no receipt", { executionId: current.id });
      return { execution: current, receipt: receiptFromRow(receipt, current), duplicate: true };
    }
    throw new TurnExecutionError("invalid_transition", "execution is not committing", { executionId: current.id, phase: current.phase });
  }
  const ownerToken = input.ownerToken ?? current.casOwner;
  if (!ownerToken) throw new TurnExecutionError("stale_owner", "execution has no active owner", { executionId: current.id, phase: current.phase });
  ensureOwner(current, ownerToken);
  const now = nowMs();
  try {
    const result: { value?: { execution: TurnExecutionRecord; receipt: TurnCommitReceipt } } = {};
    db.transaction(() => {
      const inside = requireExecution(db, current.id).execution;
      if (inside.phase !== "COMMITTING") throw new TurnExecutionError("stale_execution", "execution changed before commit", { executionId: inside.id, phase: inside.phase });
      const prior = rawReceipt(db, inside);
      if (prior) {
        const priorReceipt = receiptFromRow(prior, inside);
        result.value = { execution: repairCommittedFromReceipt(db, inside, priorReceipt, ownerToken, now), receipt: priorReceipt };
        return;
      }
      const receipt = writeReceipt(db, inside, input, now);
      const values = terminalUpdateValues("COMMITTED", now, "committed");
      values.cas_revision = inside.casRevision + 1;
      values.phase_revision = inside.phaseRevision + 1;
      if (!updateCas(db, inside, values, ownerToken, "COMMITTING", inside.casRevision)) {
        throw new TurnExecutionError("stale_execution", "execution changed before receipt handoff", { executionId: inside.id, phase: inside.phase });
      }
      result.value = { execution: requireExecution(db, inside.id).execution, receipt };
    })();
    const commitResult = result.value;
    if (!commitResult) throw new TurnExecutionError("commit_failed", "commit transaction produced no result", { executionId: current.id });
    void notifyReceiptRepair(commitResult.execution, commitResult.receipt);
    return { execution: commitResult.execution, receipt: commitResult.receipt, duplicate: false };
  } catch (error) {
    const after = rawExecution(db, current.id);
    const afterExecution = after ? recordFromRow(after) : null;
    if (afterExecution?.phase === "COMMITTED") {
      const row = rawReceipt(db, afterExecution);
      if (row) return { execution: afterExecution, receipt: receiptFromRow(row, afterExecution), duplicate: true };
    }
    // A failed statement rolls back the receipt and all caller transaction
    // work.  Marking COMMIT_FAILED is the only durable mutation after that
    // rollback; it never retries provider/render or chat side effects.
    try { failTurnCommit({ executionId: current.id, ownerToken, reason: "commit_failed", db }); } catch { /* stale owner/restart will reconcile */ }
    if (error instanceof TurnExecutionError) throw error;
    throw new TurnExecutionError("commit_failed", "commit transaction failed", { executionId: current.id, phase: "COMMITTING" });
  }
}

/**
 * Complete the durable part of COMMITTING inside a caller-owned SQLite
 * transaction. The caller must invoke this from its synchronous
 * `db.transaction(() => { ... })` callback; this function never opens,
 * commits, or rolls back a transaction and never emits terminal events.
 *
 * A duplicate receipt is authoritative. It is returned without invoking
 * `apply`, which keeps retries from repeating message, artifact, or projection
 * side effects.
 */
export function finalizeTurnCommitInTransaction<T>(
  db: Database,
  input: TurnCommitTransactionInput<T>,
): TurnCommitTransactionResult<T> {
  const current = requireExecution(db, input.executionId).execution;
  const ownerToken = input.ownerToken ?? current.casOwner;
  if (!ownerToken) throw new TurnExecutionError("stale_owner", "execution has no active owner", { executionId: current.id, phase: current.phase });
  const existing = rawReceipt(db, current);
  if (existing) {
    const receipt = receiptFromRow(existing, current);
    if (current.phase === "COMMITTING") {
      const repairedValues = terminalUpdateValues("COMMITTED", nowMs(), "committed");
      repairedValues.cas_revision = current.casRevision + 1;
      repairedValues.phase_revision = current.phaseRevision + 1;
      if (!updateCas(db, current, repairedValues, ownerToken, "COMMITTING", current.casRevision)) {
        const latest = requireExecution(db, current.id).execution;
        if (latest.phase !== "COMMITTED") throw new TurnExecutionError("stale_execution", "execution changed during receipt repair", { executionId: current.id, phase: current.phase });
        return { execution: latest, receipt, duplicate: true, value: undefined };
      }
      return { execution: requireExecution(db, current.id).execution, receipt, duplicate: true, value: undefined };
    }
    if (current.phase !== "COMMITTED") throw new TurnExecutionError("invalid_transition", "receipt exists for a nonterminal execution", { executionId: current.id, phase: current.phase });
    return { execution: current, receipt, duplicate: true, value: undefined };
  }
  if (current.phase !== "COMMITTING") {
    throw new TurnExecutionError("invalid_transition", "execution is not committing", { executionId: current.id, phase: current.phase });
  }
  ensureOwner(current, ownerToken);
  const value = input.apply(db);
  const now = nowMs();
  const receipt = writeReceipt(db, current, input, now);
  const values = terminalUpdateValues("COMMITTED", now, "committed");
  values.cas_revision = current.casRevision + 1;
  values.phase_revision = current.phaseRevision + 1;
  if (!updateCas(db, current, values, ownerToken, "COMMITTING", current.casRevision)) {
    throw new TurnExecutionError("stale_execution", "execution changed before commit receipt handoff", { executionId: current.id, phase: current.phase });
  }
  return {
    execution: requireExecution(db, current.id).execution,
    receipt,
    duplicate: false,
    value,
  };

}
export function failTurnCommit(input: {
  executionId: string;
  ownerToken: string;
  reason?: string;
  db?: Database;
}): TurnExecutionRecord {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  const existing = rawReceipt(db, current);
  if (existing) {
    return repairCommittedFromReceipt(db, current, receiptFromRow(existing, current), input.ownerToken, nowMs());
  }
  if (current.phase === "COMMIT_FAILED") return current;
  if (current.phase !== "COMMITTING") throw new TurnExecutionError("invalid_transition", "execution is not committing", { executionId: current.id, phase: current.phase });
  ensureOwner(current, input.ownerToken);
  return terminalizeWithCas(db, current, input.ownerToken, "COMMITTING", current.casRevision, "COMMIT_FAILED", input.reason ?? "commit_failed").execution;
}

/** Failure/receipt repair counterpart for an already-open outer transaction. */
export function failTurnCommitInTransaction(
  db: Database,
  input: { executionId: string; ownerToken: string; reason?: string },
): TurnExecutionRecord {
  const current = requireExecution(db, input.executionId).execution;
  const existing = rawReceipt(db, current);
  if (existing) {
    if (current.phase === "COMMITTED") return current;
    if (current.phase !== "COMMITTING") {
      throw new TurnExecutionError("invalid_transition", "receipt exists for a non-committing execution", { executionId: current.id, phase: current.phase });
    }
    return terminalizeWithCas(
      db,
      current,
      input.ownerToken,
      "COMMITTING",
      current.casRevision,
      "COMMITTED",
      "committed",
    ).execution;
  }
  if (current.phase === "COMMIT_FAILED") return current;
  if (current.phase !== "COMMITTING") throw new TurnExecutionError("invalid_transition", "execution is not committing", { executionId: current.id, phase: current.phase });
  ensureOwner(current, input.ownerToken);
  return terminalizeWithCas(
    db,
    current,
    input.ownerToken,
    "COMMITTING",
    current.casRevision,
    "COMMIT_FAILED",
    input.reason ?? "commit_failed",
  ).execution;
}

const SERVER_READINESS_COMPONENTS = [
  "schema",
  "reconciliation",
  "archiveRegistry",
  "isolateTermination",
  "publicationStore",
  "providerCapabilities",
  "configBinding",
  "contextAcl",
  "inputRevisions",
] as const;
const STATIC_READINESS_COMPONENTS = [
  "schema",
  "reconciliation",
  "archiveRegistry",
  "isolateTermination",
  "publicationStore",
] as const;
type ServerReadinessComponent = (typeof SERVER_READINESS_COMPONENTS)[number];

export interface AgenticReadinessVectorV1 {
  readonly schema: boolean;
  readonly reconciliation: boolean;
  readonly archiveRegistry: boolean;
  readonly isolateTermination: boolean;
  readonly publicationStore: boolean;
  readonly providerCapabilities: boolean;
  readonly configBinding: boolean;
  readonly contextAcl: boolean;
  readonly inputRevisions: boolean;
  readonly runtimeEpoch: number;
  readonly reason: string | null;
  readonly digest: string;
}

export interface AgenticRuntimeStatus {
  readonly mode: "off" | "auto";
  readonly enabled: boolean;
  readonly runtimeEpoch: number;
  readonly readiness: AgenticReadinessVectorV1;
}

let runtimeEpoch = Math.max(1, Date.now());
let readiness: Omit<AgenticReadinessVectorV1, "digest" | "reason"> = {
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
};

function readinessDigest(value: Omit<AgenticReadinessVectorV1, "digest" | "reason">): string {
  const canonical = JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  ));
  return createHash("sha256").update(canonical).digest("hex");
}

function readinessReason(value: Omit<AgenticReadinessVectorV1, "digest" | "reason">): string | null {
  for (const component of STATIC_READINESS_COMPONENTS) {
    if (!value[component]) return `${component}_unavailable`;
  }
  return null;
}

export function getRuntimeEpoch(): number {
  return runtimeEpoch;
}

/** Start a new server-owned epoch. User data cannot set or increment this value. */
export function startAgentRuntimeEpoch(): number {
  runtimeEpoch = Math.max(runtimeEpoch + 1, Date.now());
  readiness = { ...readiness, runtimeEpoch };
  return runtimeEpoch;
}

export const beginAgentRuntimeEpoch = startAgentRuntimeEpoch;

export function getAgenticRuntimeMode(): "off" | "auto" {
  return process.env.LUMIVERSE_AGENTIC_RUNTIME === "auto" ? "auto" : "off";
}

export const getAgenticKillSwitch = getAgenticRuntimeMode;

/**
 * Server bootstrap may report component health. The function is intentionally
 * not called from settings/preset/import paths; those paths have no access to
 * readiness authority. Omitted fields remain fail-closed.
 */
export function setAgenticRuntimeReadiness(
  patch: Partial<Record<ServerReadinessComponent, boolean>>,
): AgenticReadinessVectorV1 {
  const next = { ...readiness };
  for (const component of SERVER_READINESS_COMPONENTS) {
    if (patch[component] !== undefined) next[component] = patch[component] === true;
  }
  readiness = next;
  return getAgenticReadiness();
}

export function getAgenticReadiness(): AgenticReadinessVectorV1 {
  const snapshot = { ...readiness };
  return Object.freeze({
    ...snapshot,
    reason: readinessReason(snapshot),
    digest: readinessDigest(snapshot),
  });
}

export function isAgenticRuntimeReady(): boolean {
  const mode = getAgenticRuntimeMode();
  const current = getAgenticReadiness();
  return mode === "auto" && current.reason === null;
}

export function isAgenticRuntimeEnabled(): boolean {
  return isAgenticRuntimeReady();
}

export function getAgenticRuntimeStatus(): AgenticRuntimeStatus {
  return Object.freeze({
    mode: getAgenticRuntimeMode(),
    enabled: isAgenticRuntimeReady(),
    runtimeEpoch,
    readiness: getAgenticReadiness(),
  });
}

/** Test-only reset; no production caller should need to alter server health. */
export const __testing = {
  resetRuntimeEpoch(value?: number): void {
    runtimeEpoch = Number.isSafeInteger(value) && (value as number) > 0 ? value as number : Math.max(1, Date.now());
    readiness = { ...readiness, runtimeEpoch };
  },
  resetReadiness(): void {
    readiness = {
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
    };
  },
};

function claimForReconciliation(db: Database, current: TurnExecutionRecord, ownerToken: string, now: number): TurnExecutionRecord | null {
  if (TERMINAL_PHASE_SET.has(current.phase)) return null;
  const columns = tableColumns(db, "agent_turn_executions");
  const values: Record<string, unknown> = {
    cas_owner: ownerToken,
    lease_owner: ownerToken,
    cas_expires_at: now + DEFAULT_LEASE_MS,
    lease_expires_at: now + DEFAULT_LEASE_MS,
    runtime_epoch: runtimeEpoch,
    lease_generation: current.leaseGeneration + 1,
    cas_revision: current.casRevision + 1,
    revision: current.casRevision + 1,
    phase_revision: current.phaseRevision,
    updated_at: now,
  };
  const where = ["id = ?"];
  const params: SQLQueryBindings[] = [current.id];
  if (columns.has("phase")) {
    where.push("phase = ?");
    params.push(current.phase);
  } else if (columns.has("state")) {
    where.push("state = ?");
    params.push(current.phase);
  }
  if (columns.has("cas_revision")) {
    where.push("cas_revision = ?");
    params.push(current.casRevision);
  } else if (columns.has("revision")) {
    where.push("revision = ?");
    params.push(current.casRevision);
  }
  // The startup reconciler runs before request serving. A row in any
  // nonterminal state is therefore reclaimed regardless of its previous
  // short lease; the phase CAS makes concurrent reconcilers mutually exclusive.
  const changes = updateRow(db, "agent_turn_executions", values, where.join(" AND "), params);
  if (changes !== 1) return null;
  return requireExecution(db, current.id).execution;
}

function projectionNeedsReceiptRepair(db: Database, execution: TurnExecutionRecord): boolean {
  if (!hasTable(db, "agent_run_projections") || !hasTable(db, "agent_chat_events")) return false;
  const row = db.query(
    `SELECT p.status,
            EXISTS(
              SELECT 1 FROM agent_chat_events e
               WHERE e.user_id = p.user_id
                 AND e.chat_id = p.chat_id
                 AND e.turn_id = p.turn_id
                 AND e.sequence = p.sequence
                 AND e.run_revision = p.revision
                 AND e.event_kind = 'terminal'
            ) AS terminal_event_present
       FROM agent_run_projections p
      WHERE p.user_id = ? AND p.chat_id = ? AND p.turn_id = ?
      LIMIT 1`,
  ).get(execution.userId, execution.chatId, execution.id) as {
    status?: unknown;
    terminal_event_present?: number;
  } | null;
  return row?.status !== "COMMITTED" || Number(row?.terminal_event_present ?? 0) !== 1;
}

/**
 * Invoke only the registered durable projection repairer. Production
 * registration is synchronous and runs inside the caller-owned transaction;
 * legacy asynchronous test handlers are detached without allowing a rejected
 * promise to become an unhandled startup failure.
 */
function invokeReceiptRepair(execution: TurnExecutionRecord, receipt: TurnCommitReceipt): void {
  if (!receiptRepairHandler) return;
  const pending = receiptRepairHandler(execution, receipt);
  if (pending) void pending.catch(() => {});
}

/**
 * Startup reconciliation is deliberately receipt-only. It never invokes a
 * provider, renderer, tool, workspace mutator, or generation callback.
 */
export function reconcileAgentTurns(db: Database = getDb()): ReconcileAgentTurnsResult {
  if (!hasTable(db, "agent_turn_executions")) {
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
  const rows = db.query(`SELECT * FROM ${quoteColumn("agent_turn_executions")}`).all() as Array<Record<string, unknown>>;
  const result = {
    runtimeEpoch,
    inspected: rows.length,
    claimed: 0,
    failedInterrupted: 0,
    committedFromReceipt: 0,
    commitFailedWithoutReceipt: 0,
    projectionRepairs: 0,
    alreadyTerminal: 0,
    releasedReservations: 0,
  };
  const now = nowMs();
  for (const raw of rows) {
    let current: TurnExecutionRecord;
    try { current = recordFromRow(raw); } catch { continue; }
    if (TERMINAL_PHASE_SET.has(current.phase)) {
      result.alreadyTerminal++;
      // A process can crash after the receipt/phase transaction but before its
      // projection or websocket handoff is visible. Repair only from the
      // receipt; never re-enter generation or commit side effects.
      if (current.phase === "COMMITTED" && receiptRepairHandler) {
        const receiptRaw = rawReceipt(db, current);
        if (receiptRaw) {
          const receipt = receiptFromRow(receiptRaw, current);
          const needsRepair = projectionNeedsReceiptRepair(db, current);
          try {
            db.transaction(() => {
              const latest = requireExecution(db, current.id).execution;
              invokeReceiptRepair(latest, receipt);
            })();
            if (needsRepair && !projectionNeedsReceiptRepair(db, current)) {
              result.projectionRepairs++;
            }
          } catch {
            // Projection repair remains pending for the next startup epoch.
          }
        }
      }
      continue;
    }
    const ownerToken = randomId("reconcile");
    const claimed = claimForReconciliation(db, current, ownerToken, now);
    if (!claimed) continue;
    result.claimed++;
    if (REVERSIBLE_PHASE_SET.has(claimed.phase)) {
      try {
        let outcome: TransitionTurnExecutionResult | undefined;
        db.transaction(() => {
          const transition = terminalizeWithCas(
            db,
            claimed,
            ownerToken,
            claimed.phase,
            claimed.casRevision,
            "FAILED",
            "process_interrupted",
            now,
          );
          if (transition.terminalEventEmitted) invokeTerminalRecovery(transition.execution, "FAILED");
          outcome = transition;
        })();
        if (outcome?.terminalEventEmitted) result.failedInterrupted++;
        if (claimed.finalRenderReservationKey) result.releasedReservations++;
      } catch {
        // A concurrent owner or projection repair failure rolls back the
        // terminal CAS; the next epoch will inspect the durable row.
      }
      continue;
    }
    if (claimed.phase !== "COMMITTING") continue;
    const receiptRaw = rawReceipt(db, claimed);
    if (receiptRaw) {
      const receipt = receiptFromRow(receiptRaw, claimed);
      const needsRepair = projectionNeedsReceiptRepair(db, claimed);
      try {
        db.transaction(() => {
          const latest = requireExecution(db, claimed.id).execution;
          const repaired = repairCommittedFromReceipt(db, latest, receipt, ownerToken, now, false);
          invokeReceiptRepair(repaired, receipt);
        })();
        result.committedFromReceipt++;
        if (needsRepair && !projectionNeedsReceiptRepair(db, claimed)) {
          result.projectionRepairs++;
        }
        if (claimed.finalRenderReservationKey) result.releasedReservations++;
      } catch {
        // Keep the receipt and COMMITTING row for a later lease epoch. Do not
        // mark COMMIT_FAILED merely because a derived projection is delayed.
      }
    } else {
      try {
        let outcome: TransitionTurnExecutionResult | undefined;
        db.transaction(() => {
          const transition = terminalizeWithCas(
            db,
            claimed,
            ownerToken,
            claimed.phase,
            claimed.casRevision,
            "COMMIT_FAILED",
            "process_interrupted",
            now,
          );
          if (transition.terminalEventEmitted) invokeTerminalRecovery(transition.execution, "COMMIT_FAILED");
          outcome = transition;
        })();
        if (outcome?.terminalEventEmitted) result.commitFailedWithoutReceipt++;
        if (claimed.finalRenderReservationKey) result.releasedReservations++;
      } catch {
        // Another owner or projection repair failure rolls back the CAS; the
        // next epoch will inspect the durable row without replaying work.
      }
    }
  }
  return result;
}

export const reconcileTurnExecutions = reconcileAgentTurns;

export const TURN_EXECUTION_RECONCILIATION = Object.freeze({
  reversible: REVERSIBLE_TURN_PHASES,
  committingWithReceipt: "COMMITTED" as const,
  committingWithoutReceipt: "COMMIT_FAILED" as const,
  providerReplay: false,
  renderReplay: false,
  sideEffectReplay: false,
});
