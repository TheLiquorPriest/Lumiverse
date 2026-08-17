import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import {
  WORKSPACE_OPERATIONS,
  WORKSPACE_RECORD_KINDS,
  WORKSPACE_SUBMISSION_STATES,
  WORKSPACE_TASK_STATES,
  type TurnWorkspaceV1,
  type WorkspaceArtifactProvenanceV1,
  type WorkspaceArtifactReferenceV1,
  type WorkspaceOperationCapabilitiesV1,
  type WorkspaceOperationKindV1,
  type WorkspaceRecordKindV1,
  type WorkspaceRecordV1,
  type WorkspaceRetentionV1,
  type WorkspaceStateV1,
  type WorkspaceSubmissionV1,
  type WorkspaceTaskStateV1,
  type WorkspaceTaskV1,
  type WorkspaceUsageV1,
} from "../types/turn-workspace";
import { utf8ByteLength } from "./agent-runtime-accounting";
import { ArtifactBlobError, assertArtifactAttachable, publishArtifactCommit, withArtifactDeletionFence } from "./agent-artifact-blobs.service";
import type {
  CognitionActivationStateV1,
  CognitionTaskTransition,
  TaskTemplateV1,
} from "../types/agent-cognition";
import type {
  CognitionWorkspaceActivationFactoryV1,
  CognitionWorkspaceActivationUpdateV1,
  CognitionWorkspaceCommitResultV1,
  CognitionWorkspaceCompletionFactoryV1,
  CognitionWorkspaceCompletionResultV1,
  CognitionWorkspaceCompletionUpdateV1,
  CognitionWorkspacePhaseFactoryV1,
  CognitionWorkspacePhaseResultV1,
} from "../types/agent-cognition-runtime";
export const WORKSPACE_ID_MAX_BYTES = 128;
export const WORKSPACE_OBJECTIVE_MAX_BYTES = 65_536;
export const WORKSPACE_CONSTRAINT_MAX_BYTES = 8_192;
export const WORKSPACE_CONSTRAINTS_MAX_BYTES = 131_072;
export const WORKSPACE_TASK_TITLE_MAX_BYTES = 4_096;
export const WORKSPACE_TASK_SUMMARY_MAX_BYTES = 65_536;
export const WORKSPACE_RECORD_SUMMARY_MAX_BYTES = 65_536;
export const WORKSPACE_SUBMISSION_SUMMARY_MAX_BYTES = 65_536;
export const WORKSPACE_MAX_TASKS = 256;
export const WORKSPACE_MAX_TASK_ASSIGNMENTS = WORKSPACE_MAX_TASKS;
export const WORKSPACE_MAX_RECORDS = 1_024;
export const WORKSPACE_MAX_SUBMISSIONS = 1_024;
export const WORKSPACE_MAX_ARTIFACTS = 256;
export const WORKSPACE_MAX_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_MAX_PAGE_SIZE = 100;
export const WORKSPACE_MAX_DEPENDENCIES = 64;
export const WORKSPACE_MAX_REFERENCE_IDS = 128;
export const WORKSPACE_MAX_OPERATION_BYTES = 131_072;
export const WORKSPACE_MAX_OPERATIONS = 128;
export const WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS = 24 * 60 * 60;
export const WORKSPACE_MAX_TERMINAL_TTL_SECONDS = 30 * 24 * 60 * 60;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[0-9a-fA-F]{64}$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const PRIVATE_KEY = /(?:transcript|carrier|reasoning|credential|secret|raw[_-]?(?:tool|peer)|tool[_-]?(?:argument|args|result)|work[_-]?prose)/i;
const RETENTION = new Set<WorkspaceRetentionV1>(["operational", "turn_terminal", "chat_lifetime"]);
const STATES = new Set<WorkspaceTaskStateV1>(WORKSPACE_TASK_STATES);
const KINDS = new Set<WorkspaceRecordKindV1>(WORKSPACE_RECORD_KINDS);
const OPERATIONS = new Set<WorkspaceOperationKindV1>(WORKSPACE_OPERATIONS);
const PROVENANCE = new Set<WorkspaceArtifactProvenanceV1>(["host", "root", "child"]);
/**
 * Closed public section vocabulary for owner-bound workspace reads.
 * The service remains the authority for authorization and redaction.
 */
export type WorkspaceReadSection =
  | "objective"
  | "constraints"
  | "tasks"
  | "records"
  | "submissions"
  | "artifacts"
  | "summary";

/** Public workspace snapshot returned by every workspace read/mutation. */
export type WorkspaceSnapshotV1 = TurnWorkspaceV1;

interface ActiveFrameCapabilityGrant {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly frameId: string;
  readonly workspaceExpiresAt: number;
  readonly capabilities: WorkspaceOperationCapabilitiesV1;
  operationsUsed: number;
}

/**
 * Child grants are intentionally process-local, but their lifetime is bounded
 * by the authoritative workspace/turn lifecycle. A grant is never admitted
 * for a terminal or expired workspace and is explicitly removed by the turn
 * terminal transition/recovery hooks below.
 */
const frameCapabilities = new Map<string, ActiveFrameCapabilityGrant>();
let frameCapabilitiesDatabase: Database | null = null;

const TERMINAL_TURN_STATES = new Set([
  "COMMITTED",
  "COMMIT_FAILED",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

type WorkspaceActor = "host" | "root" | "child";
export interface WorkspaceFrameContextV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly actor: WorkspaceActor;
  readonly frameId?: string;
  readonly expectedRevision: number;
  readonly capabilities?: WorkspaceOperationCapabilitiesV1;
  readonly fieldCapabilities?: WorkspaceOperationCapabilitiesV1;
}
export interface WorkspaceFrameCapabilityGrantV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly frameId: string;
  readonly capabilities: WorkspaceOperationCapabilitiesV1;
}

export interface CreateWorkspaceInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly workspaceId?: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly retention: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
  readonly quota: WorkspaceQuotaInputV1;
  readonly capabilities: WorkspaceOperationCapabilitiesV1;
}

export interface WorkspaceQuotaInputV1 {
  readonly maxTasks: number;
  readonly maxRecords: number;
  readonly maxSubmissions: number;
  readonly maxArtifacts: number;
  readonly maxBytes: number;
}

export interface ReadWorkspaceSectionInputV1 extends WorkspaceFrameContextV1 {
  readonly section: WorkspaceReadSection;
  readonly page: number;
  readonly pageSize: number;
}

export interface CreateWorkspaceTaskInputV1 extends WorkspaceFrameContextV1 {
  readonly taskId?: string;
  readonly title: string;
  readonly objective?: string;
  readonly required?: boolean;
  readonly dependencyIds: readonly string[];
  readonly assignedFrameId: string | null;
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}

export interface UpdateWorkspaceTaskPolicyInputV1 extends WorkspaceFrameContextV1 {
  readonly taskId: string;
  readonly required?: boolean;
  readonly dependencyIds?: readonly string[];
  readonly assignedFrameId?: string | null;
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}
export interface WorkspaceTaskAssignmentV1 {
  readonly taskId: string;
  readonly frameId: string;
}

/**
 * Host/root-only assignment of already materialized tasks to exact child
 * frames. This is a control-plane operation and is intentionally absent from
 * the model-visible workspace operation vocabulary.
 */
export interface AssignWorkspaceTasksInputV1 extends WorkspaceFrameContextV1 {
  readonly assignments: readonly WorkspaceTaskAssignmentV1[];
}

export interface AssignWorkspaceTasksResultV1 {
  readonly workspaceRevision: number;
  readonly tasks: readonly WorkspaceTaskV1[];
}


export interface UpdateWorkspaceTaskProgressInputV1 extends WorkspaceFrameContextV1 {
  readonly taskId: string;
  readonly state: WorkspaceTaskStateV1;
  readonly progress?: number;
}

export interface SubmitWorkspaceChildResultInputV1 extends WorkspaceFrameContextV1 {
  readonly taskId: string;
  readonly summary: string;
  readonly resultDigest: string;
  readonly byteCount: number;
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}

export interface AcceptWorkspaceSubmissionInputV1 extends WorkspaceFrameContextV1 { readonly submissionId: string; }

export interface RecordWorkspaceRecordInputV1 extends WorkspaceFrameContextV1 {
  readonly kind: WorkspaceRecordKindV1;
  readonly summary: string;
  readonly digest: string;
  readonly taskId: string | null;
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}

export interface AttachWorkspaceArtifactInputV1 extends WorkspaceFrameContextV1 {
  readonly artifactId?: string;
  readonly blobDigest: string;
  readonly byteCount: number;
  readonly mimeType: string;
  readonly provenance: WorkspaceArtifactProvenanceV1;
  readonly creatorToken: string;
  readonly taskId: string | null;
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}

export interface ProposeWorkspacePublicationInputV1 extends WorkspaceFrameContextV1 { readonly artifactId: string; }
export interface PublishWorkspaceArtifactInputV1 extends WorkspaceFrameContextV1 {
  readonly artifactId: string;
  readonly receiptId?: string;
  readonly storagePath?: string;
  readonly messageId?: string | null;
  readonly swipeId?: number | null;
}
export interface WorkspaceCompletionMetadataInputV1 extends WorkspaceFrameContextV1 {
  readonly completionCode: string;
  readonly requiredTaskCount?: number;
  readonly acceptedSubmissionCount?: number;
}

export interface WorkspaceSectionPageV1 {
  readonly workspace: WorkspaceSnapshotV1;
  readonly section: WorkspaceReadSection;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly items: readonly unknown[];
}

export interface WorkspaceCompletionGatesV1 {
  readonly workspaceRevision: number;
  readonly accepted: boolean;
  readonly requiredTaskCount: number;
  readonly openRequiredTaskIds: readonly string[];
  readonly pendingSubmissionCount: number;
}

export interface WorkspaceCompletionPreviewV1 {
  readonly accepted: boolean;
  readonly workspaceRevision: number;
}

export interface WorkspaceCompletionPreparedAcceptanceV1 {
  /**
   * Synchronous host-owned acknowledgement. It runs inside the SQLite
   * transaction after the completion gates are re-read and before updateRow.
   */
  readonly prepare: (candidate: WorkspaceCompletionPreviewV1) => boolean;
}

export type WorkspaceErrorCode =
  | "invalid_input" | "not_found" | "forbidden" | "capability_denied" | "stale_revision"
  | "workspace_frozen" | "quota_exceeded" | "dependency_cycle" | "invalid_retention"
  | "invalid_state" | "invalid_id" | "child_confinement" | "duplicate_id"
  | "task_assignment_conflict"
  | "schema_unavailable" | "submission_rejected" | "completion_preparation_failed";

export class TurnWorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly details?: Readonly<Record<string, string | number>>;
  constructor(code: WorkspaceErrorCode, message: string, details?: Record<string, string | number>) {
    super(message);
    this.name = "TurnWorkspaceError";
    this.code = code;
    this.details = details ? Object.freeze({ ...details }) : undefined;
  }
}

function fail(code: WorkspaceErrorCode, message: string, details?: Record<string, string | number>): never {
  throw new TurnWorkspaceError(code, message, details);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function assertKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail("invalid_input", `${path}.${key} is not permitted`);
}
function assertNoPrivateFields(value: unknown, path = "value", depth = 0): void {
  if (depth > 12) fail("invalid_input", `${path} is too deeply nested`);
  if (Array.isArray(value)) {
    if (value.length > WORKSPACE_MAX_REFERENCE_IDS) fail("quota_exceeded", `${path} contains too many entries`);
    value.forEach((item, index) => assertNoPrivateFields(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) fail("invalid_input", `${path}.${key} is private runtime material`);
    assertNoPrivateFields(child, `${path}.${key}`, depth + 1);
  }
}
function stringValue(value: unknown, path: string, maxBytes: number, nonEmpty = true): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) fail("invalid_input", `${path} must be a string`);
  const bytes = utf8ByteLength(value);
  if (bytes > maxBytes) fail("quota_exceeded", `${path} exceeds its UTF-8 byte limit`, { limit: maxBytes, observed: bytes });
  return value;
}
function idValue(value: unknown, path: string): string {
  const id = stringValue(value, path, WORKSPACE_ID_MAX_BYTES);
  if (!SAFE_ID.test(id)) fail("invalid_id", `${path} is not a stable identifier`);
  return id;
}
function nullableId(value: unknown, path: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return idValue(value, path);
}
function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail("invalid_input", `${path} must be an integer in [${min}, ${max}]`);
  return value as number;
}
function finiteNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail("invalid_input", `${path} must be a number in [${min}, ${max}]`);
  return value;
}
function identifierList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length > WORKSPACE_MAX_DEPENDENCIES) fail("invalid_input", `${path} must be a bounded identifier array`);
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((item, index) => {
    const id = idValue(item, `${path}[${index}]`);
    if (seen.has(id)) fail("invalid_input", `${path} contains duplicate identifiers`);
    seen.add(id);
    result.push(id);
  });
  return Object.freeze(result);
}
function retentionValue(value: unknown, ttlValue: unknown, now = Math.floor(Date.now() / 1000)): { retention: WorkspaceRetentionV1; expiresAt: number } {
  if (typeof value !== "string" || !RETENTION.has(value as WorkspaceRetentionV1)) fail("invalid_retention", "unknown retention policy");
  const retention = value as WorkspaceRetentionV1;
  if (retention === "chat_lifetime") {
    if (ttlValue !== undefined && ttlValue !== null) fail("invalid_retention", "chat-lifetime retention cannot have a TTL");
    return { retention, expiresAt: 0 };
  }
  const maximum = retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS;
  return { retention, expiresAt: now + integer(ttlValue, "ttlSeconds", 1, maximum) };
}
function quotaValue(value: unknown): WorkspaceQuotaInputV1 {
  if (value !== undefined && !isRecord(value)) fail("invalid_input", "quota must be an object");
  const source = (value ?? {}) as Record<string, unknown>;
  assertKeys(source, ["maxTasks", "maxRecords", "maxSubmissions", "maxArtifacts", "maxBytes"], "quota");
  return Object.freeze({
    maxTasks: integer(source.maxTasks ?? WORKSPACE_MAX_TASKS, "quota.maxTasks", 0, WORKSPACE_MAX_TASKS),
    maxRecords: integer(source.maxRecords ?? WORKSPACE_MAX_RECORDS, "quota.maxRecords", 0, WORKSPACE_MAX_RECORDS),
    maxSubmissions: integer(source.maxSubmissions ?? WORKSPACE_MAX_SUBMISSIONS, "quota.maxSubmissions", 0, WORKSPACE_MAX_SUBMISSIONS),
    maxArtifacts: integer(source.maxArtifacts ?? WORKSPACE_MAX_ARTIFACTS, "quota.maxArtifacts", 0, WORKSPACE_MAX_ARTIFACTS),
    maxBytes: integer(source.maxBytes ?? WORKSPACE_MAX_BYTES, "quota.maxBytes", 0, WORKSPACE_MAX_BYTES),
  });
}
function capabilityValue(value: unknown, actor: WorkspaceActor): WorkspaceOperationCapabilitiesV1 {
  if (value !== undefined && !isRecord(value)) fail("invalid_input", "capabilities must be an object");
  const source = (value ?? {}) as Record<string, unknown>;
  assertKeys(source, ["revision", "allowed", "maxOperationBytes", "maxOperations"], "capabilities");
  const rawAllowed = source.allowed ?? (actor === "host" || actor === "root" ? [...WORKSPACE_OPERATIONS] : []);
  if (!Array.isArray(rawAllowed)) fail("invalid_input", "capabilities.allowed must be an array");
  const seen = new Set<WorkspaceOperationKindV1>();
  const allowed: WorkspaceOperationKindV1[] = [];
  for (const item of rawAllowed) {
    if (typeof item !== "string" || !OPERATIONS.has(item as WorkspaceOperationKindV1) || seen.has(item as WorkspaceOperationKindV1)) fail("invalid_input", "capabilities.allowed contains an unknown or duplicate operation");
    seen.add(item as WorkspaceOperationKindV1);
    allowed.push(item as WorkspaceOperationKindV1);
  }
  return Object.freeze({
    revision: integer(source.revision ?? 1, "capabilities.revision", 0, Number.MAX_SAFE_INTEGER),
    allowed: Object.freeze(allowed),
    maxOperationBytes: integer(source.maxOperationBytes ?? WORKSPACE_MAX_OPERATION_BYTES, "capabilities.maxOperationBytes", 0, WORKSPACE_MAX_OPERATION_BYTES),
    maxOperations: integer(source.maxOperations ?? WORKSPACE_MAX_OPERATIONS, "capabilities.maxOperations", 0, WORKSPACE_MAX_OPERATIONS),
  });
}
function expectedRevision(value: Record<string, unknown>): number {
  return integer(value.expectedRevision ?? value.revision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER);
}
function contextValue(value: unknown, strict = false): WorkspaceFrameContextV1 {
  if (!isRecord(value)) fail("invalid_input", "workspace context must be an object");
  if (strict) assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities"], "context");
  assertNoPrivateFields(value);
  const actor = value.actor;
  if (actor !== "host" && actor !== "root" && actor !== "child") fail("invalid_input", "context.actor is invalid");
  if (actor === "child" && (value.capabilities !== undefined || value.fieldCapabilities !== undefined)) {
    fail("capability_denied", "child capability grants are host-issued");
  }
  const result: WorkspaceFrameContextV1 = Object.freeze({
    userId: idValue(value.userId, "userId"),
    chatId: idValue(value.chatId, "chatId"),
    turnId: idValue(value.turnId, "turnId"),
    workspaceId: idValue(value.workspaceId, "workspaceId"),
    actor,
    frameId: value.frameId === undefined ? undefined : idValue(value.frameId, "frameId"),
    expectedRevision: expectedRevision(value),
  });
  if (actor === "child" && !result.frameId) fail("child_confinement", "child operations require frameId");
  return result;
}

export function validateWorkspaceCapabilities(value: unknown, actor: WorkspaceActor = "child"): WorkspaceOperationCapabilitiesV1 {
  assertNoPrivateFields(value);
  return capabilityValue(value, actor);
}
export function validateCreateWorkspaceInput(value: unknown, now = Math.floor(Date.now() / 1000)): CreateWorkspaceInputV1 {
  if (!isRecord(value)) fail("invalid_input", "workspace input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "objective", "constraints", "retention", "ttlSeconds", "quota", "capabilities"], "workspace");
  assertNoPrivateFields(value);
  if (!Array.isArray(value.constraints) || value.constraints.length > 256) fail("invalid_input", "constraints must be a bounded array");
  let bytes = 0;
  const constraints: string[] = [];
  value.constraints.forEach((item, index) => {
    const constraint = stringValue(item, `constraints[${index}]`, WORKSPACE_CONSTRAINT_MAX_BYTES);
    bytes += utf8ByteLength(constraint);
    constraints.push(constraint);
  });
  if (bytes > WORKSPACE_CONSTRAINTS_MAX_BYTES) fail("quota_exceeded", "constraints exceed aggregate UTF-8 limit");
  const policy = retentionValue(value.retention, value.ttlSeconds, now);
  return Object.freeze({
    userId: idValue(value.userId, "userId"),
    chatId: idValue(value.chatId, "chatId"),
    turnId: idValue(value.turnId, "turnId"),
    workspaceId: value.workspaceId === undefined ? undefined : idValue(value.workspaceId, "workspaceId"),
    objective: stringValue(value.objective, "objective", WORKSPACE_OBJECTIVE_MAX_BYTES),
    constraints: Object.freeze(constraints),
    retention: policy.retention,
    ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS),
    quota: quotaValue(value.quota),
    capabilities: capabilityValue(value.capabilities, "root"),
  });
}
export function validateReadWorkspaceSectionInput(value: unknown): ReadWorkspaceSectionInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "read input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "section", "page", "pageSize"], "read");
  const section = value.section;
  if (typeof section !== "string" || !["objective", "constraints", "tasks", "records", "submissions", "artifacts", "summary"].includes(section)) fail("invalid_input", "section is invalid");
  return Object.freeze({ ...parsed, section: section as WorkspaceReadSection, page: integer(value.page ?? 0, "page", 0, Number.MAX_SAFE_INTEGER), pageSize: integer(value.pageSize ?? WORKSPACE_MAX_PAGE_SIZE, "pageSize", 1, WORKSPACE_MAX_PAGE_SIZE) });
}
export function validateAssignWorkspaceTasksInput(value: unknown): AssignWorkspaceTasksInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "task assignment input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "assignments"], "taskAssignment");
  if (!Array.isArray(value.assignments) || value.assignments.length === 0) {
    fail("invalid_input", `assignments must contain 1-${WORKSPACE_MAX_TASK_ASSIGNMENTS} entries`);
  }
  if (value.assignments.length > WORKSPACE_MAX_TASK_ASSIGNMENTS) {
    fail("quota_exceeded", `assignments exceed the ${WORKSPACE_MAX_TASK_ASSIGNMENTS}-task assignment quota`);
  }
  const taskIds = new Set<string>();
  const frameIds = new Set<string>();
  const assignments: WorkspaceTaskAssignmentV1[] = [];
  value.assignments.forEach((entry, index) => {
    if (!isRecord(entry)) fail("invalid_input", `assignments[${index}] must be an object`);
    assertKeys(entry, ["taskId", "frameId"], `assignments[${index}]`);
    const taskId = idValue(entry.taskId, `assignments[${index}].taskId`);
    const frameId = idValue(entry.frameId, `assignments[${index}].frameId`);
    if (taskIds.has(taskId) || frameIds.has(frameId)) fail("duplicate_id", "task assignments must contain unique task and frame identifiers");
    taskIds.add(taskId);
    frameIds.add(frameId);
    assignments.push(Object.freeze({ taskId, frameId }));
  });
  return Object.freeze({ ...parsed, assignments: Object.freeze(assignments) });
}
export function validateCreateWorkspaceTaskInput(value: unknown): CreateWorkspaceTaskInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "task input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "taskId", "title", "objective", "required", "dependencyIds", "assignedFrameId", "retention", "ttlSeconds"], "task");
  if (value.required !== undefined && typeof value.required !== "boolean") fail("invalid_input", "required must be boolean");
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  return Object.freeze({ ...parsed, taskId: value.taskId === undefined ? undefined : idValue(value.taskId, "taskId"), title: stringValue(value.title, "title", WORKSPACE_TASK_TITLE_MAX_BYTES), objective: value.objective === undefined ? undefined : stringValue(value.objective, "objective", WORKSPACE_TASK_SUMMARY_MAX_BYTES), required: value.required ?? false, dependencyIds: identifierList(value.dependencyIds ?? [], "dependencyIds"), assignedFrameId: nullableId(value.assignedFrameId, "assignedFrameId") ?? null, retention: policy?.retention, ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS) });
}
export function validateUpdateWorkspaceTaskPolicyInput(value: unknown): UpdateWorkspaceTaskPolicyInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "task policy input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "taskId", "required", "dependencyIds", "assignedFrameId", "retention", "ttlSeconds"], "taskPolicy");
  if (value.required !== undefined && typeof value.required !== "boolean") fail("invalid_input", "required must be boolean");
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  return Object.freeze({ ...parsed, taskId: idValue(value.taskId, "taskId"), required: value.required as boolean | undefined, dependencyIds: value.dependencyIds === undefined ? undefined : identifierList(value.dependencyIds, "dependencyIds"), assignedFrameId: value.assignedFrameId === undefined ? undefined : nullableId(value.assignedFrameId, "assignedFrameId") ?? null, retention: policy?.retention, ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS) });
}
export function validateUpdateWorkspaceTaskProgressInput(value: unknown): UpdateWorkspaceTaskProgressInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "progress input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "taskId", "state", "progress", "progressPercent", "summary"], "progress");
  if (parsed.actor !== "child") fail("forbidden", "only assigned children update progress");
  if (typeof value.state !== "string" || !STATES.has(value.state as WorkspaceTaskStateV1)) fail("invalid_state", "task state is invalid");
  if (value.state === "submitted") fail("invalid_state", "child progress cannot submit a task; submit a child result instead");
  if (value.summary !== undefined) fail("invalid_input", "child progress cannot persist work prose");
  const progress = value.progress !== undefined ? finiteNumber(value.progress, "progress", 0, 1) : value.progressPercent !== undefined ? finiteNumber(value.progressPercent, "progressPercent", 0, 100) / 100 : undefined;
  return Object.freeze({ ...parsed, taskId: idValue(value.taskId, "taskId"), state: value.state as WorkspaceTaskStateV1, progress });
}
export function validateSubmitWorkspaceChildResultInput(value: unknown): SubmitWorkspaceChildResultInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "submission input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "taskId", "summary", "resultDigest", "byteCount", "retention", "ttlSeconds"], "submission");
  if (parsed.actor !== "child") fail("forbidden", "only children submit child results");
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  const resultDigest = stringValue(value.resultDigest, "resultDigest", 64);
  if (!DIGEST.test(resultDigest)) fail("invalid_input", "resultDigest must be SHA-256");
  return Object.freeze({ ...parsed, taskId: idValue(value.taskId, "taskId"), summary: stringValue(value.summary, "summary", WORKSPACE_SUBMISSION_SUMMARY_MAX_BYTES), resultDigest, byteCount: integer(value.byteCount ?? 0, "byteCount", 0, WORKSPACE_MAX_BYTES), retention: policy?.retention, ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS) });
}
export function validateAcceptWorkspaceSubmissionInput(value: unknown): AcceptWorkspaceSubmissionInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "submission acceptance input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "submissionId"], "acceptSubmission");
  return Object.freeze({ ...parsed, submissionId: idValue(value.submissionId, "submissionId") });
}
function summaryDigest(summary: string): string { return createHash("sha256").update(summary, "utf8").digest("hex"); }
export function validateRecordWorkspaceRecordInput(value: unknown): RecordWorkspaceRecordInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "record input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "kind", "summary", "digest", "taskId", "retention", "ttlSeconds"], "record");
  if (typeof value.kind !== "string" || !KINDS.has(value.kind as WorkspaceRecordKindV1)) fail("invalid_input", "record kind is invalid");
  const summary = stringValue(value.summary, "summary", WORKSPACE_RECORD_SUMMARY_MAX_BYTES);
  const digest = value.digest === undefined ? summaryDigest(summary) : stringValue(value.digest, "digest", 64);
  if (!DIGEST.test(digest)) fail("invalid_input", "record digest must be SHA-256");
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  return Object.freeze({ ...parsed, kind: value.kind as WorkspaceRecordKindV1, summary, digest, taskId: nullableId(value.taskId, "taskId") ?? null, retention: policy?.retention, ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS) });
}
export function validateAttachWorkspaceArtifactInput(value: unknown): AttachWorkspaceArtifactInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "artifact input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "artifactId", "blobDigest", "byteCount", "mimeType", "provenance", "creatorToken", "taskId", "retention", "ttlSeconds"], "artifact");
  const blobDigest = stringValue(value.blobDigest, "blobDigest", 64);
  if (!DIGEST.test(blobDigest)) fail("invalid_input", "blobDigest must be SHA-256");
  const mimeType = stringValue(value.mimeType, "mimeType", 255);
  if (!MIME.test(mimeType)) fail("invalid_input", "artifact MIME type is invalid");
  if (typeof value.provenance !== "string" || !PROVENANCE.has(value.provenance as WorkspaceArtifactProvenanceV1)) fail("invalid_input", "artifact provenance is invalid");
  const creatorToken = stringValue(value.creatorToken, "creatorToken", 256);
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  return Object.freeze({ ...parsed, artifactId: value.artifactId === undefined ? undefined : idValue(value.artifactId, "artifactId"), blobDigest, byteCount: integer(value.byteCount, "byteCount", 0, WORKSPACE_MAX_BYTES), mimeType, provenance: value.provenance as WorkspaceArtifactProvenanceV1, creatorToken, taskId: nullableId(value.taskId, "taskId") ?? null, retention: policy?.retention, ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS) });
}
export function validateProposeWorkspacePublicationInput(value: unknown): ProposeWorkspacePublicationInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "publication input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "artifactId"], "publication");
  return Object.freeze({ ...parsed, artifactId: idValue(value.artifactId, "artifactId") });
}
export function validatePublishWorkspaceArtifactInput(value: unknown): PublishWorkspaceArtifactInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "publish input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "artifactId", "receiptId", "storagePath", "messageId", "swipeId"], "publish");
  return Object.freeze({ ...parsed, artifactId: idValue(value.artifactId, "artifactId"), receiptId: value.receiptId === undefined ? undefined : idValue(value.receiptId, "receiptId"), storagePath: value.storagePath === undefined ? undefined : stringValue(value.storagePath, "storagePath", 4096), messageId: value.messageId === undefined ? undefined : nullableId(value.messageId, "messageId") ?? null, swipeId: value.swipeId === undefined ? undefined : integer(value.swipeId, "swipeId", 0, Number.MAX_SAFE_INTEGER) });
}
export function validateWorkspaceCompletionMetadataInput(value: unknown): WorkspaceCompletionMetadataInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "completion metadata input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "completionCode", "requiredTaskCount", "acceptedSubmissionCount"], "completion");
  return Object.freeze({ ...parsed, completionCode: stringValue(value.completionCode, "completionCode", 128), requiredTaskCount: value.requiredTaskCount === undefined ? undefined : integer(value.requiredTaskCount, "requiredTaskCount", 0, WORKSPACE_MAX_TASKS), acceptedSubmissionCount: value.acceptedSubmissionCount === undefined ? undefined : integer(value.acceptedSubmissionCount, "acceptedSubmissionCount", 0, WORKSPACE_MAX_SUBMISSIONS) });
}

function tableExists(database: Database, table: string): boolean { return !!database.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table); }
function quoteIdentifier(identifier: string): string { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error("unsafe SQL identifier"); return `"${identifier}"`; }
function tableColumns(database: Database, table: string): Set<string> {
  if (!tableExists(database, table)) fail("schema_unavailable", `${table} is unavailable`);
  return new Set((database.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map((row) => row.name));
}
type SqlValue = string | number | bigint | boolean | null | Uint8Array;
function sqlValue(value: unknown): SqlValue { if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value instanceof Uint8Array) return value; fail("invalid_input", "workspace SQL value is not scalar"); }
function insertRow(database: Database, table: string, values: Record<string, unknown>, required: readonly string[]): void {
  const available = tableColumns(database, table);
  const selected = Object.entries(values).filter(([key, value]) => value !== undefined && available.has(key));
  for (const key of required) if (available.has(key) && !selected.some(([name]) => name === key)) fail("schema_unavailable", `${table}.${key} was not supplied`);
  if (!selected.length) fail("schema_unavailable", `${table} has no writable columns`);
  database.query(`INSERT INTO ${quoteIdentifier(table)} (${selected.map(([key]) => quoteIdentifier(key)).join(", ")}) VALUES (${selected.map(() => "?").join(", ")})`).run(...selected.map(([, value]) => sqlValue(value)));
}
function updateRow(database: Database, table: string, values: Record<string, unknown>, where: Record<string, unknown>): number {
  const available = tableColumns(database, table);
  const set = Object.entries(values).filter(([key, value]) => value !== undefined && available.has(key));
  const predicates = Object.entries(where).filter(([key, value]) => value !== undefined && available.has(key));
  if (!set.length || !predicates.length) fail("schema_unavailable", `${table} cannot be updated safely`);
  return database.query(`UPDATE ${quoteIdentifier(table)} SET ${set.map(([key]) => `${quoteIdentifier(key)} = ?`).join(", ")} WHERE ${predicates.map(([key]) => `${quoteIdentifier(key)} = ?`).join(" AND ")}`).run(...set.map(([, value]) => sqlValue(value)), ...predicates.map(([, value]) => sqlValue(value))).changes;
}
function rowString(row: Record<string, unknown>, names: readonly string[], fallback = ""): string { for (const name of names) if (typeof row[name] === "string") return row[name] as string; return fallback; }
function rowNumber(row: Record<string, unknown>, names: readonly string[], fallback = 0): number { for (const name of names) if (typeof row[name] === "number" && Number.isFinite(row[name])) return row[name] as number; return fallback; }
function rowNullableString(row: Record<string, unknown>, names: readonly string[]): string | null { for (const name of names) if (row[name] === null) return null; for (const name of names) if (typeof row[name] === "string") return row[name] as string; return null; }
function jsonArray(value: unknown): string[] { if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string"); if (typeof value !== "string") return []; try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []; } catch { return []; } }
function deepFreeze<T>(value: T): T { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; if (Array.isArray(value)) value.forEach((child) => deepFreeze(child)); else Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child)); return Object.freeze(value); }

/**
 * Measure the exact UTF-8 bytes charged for a workspace request. JSON
 * serialization is deliberate: JavaScript string/code-unit length is not a
 * wire-size measure for non-ASCII input.
 */
export function measureWorkspaceOperationBytesV1(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("invalid_input", "workspace operation request is not serializable");
  }
  if (serialized === undefined) fail("invalid_input", "workspace operation request is not serializable");
  return utf8ByteLength(serialized);
}

interface WorkspaceRow {
  readonly workspaceId: string; readonly turnId: string; readonly executionId: string; readonly userId: string; readonly chatId: string;
  readonly objective: string; readonly constraints: readonly string[]; readonly state: WorkspaceStateV1; readonly revision: number;
  readonly caps: WorkspaceOperationCapabilitiesV1; readonly retention: WorkspaceRetentionV1; readonly expiresAt: number;
  readonly quota: WorkspaceQuotaInputV1; readonly usage: WorkspaceUsageV1; readonly frozenAt: number | null; readonly createdAt: number; readonly updatedAt: number;
  readonly turnActive: boolean;
}
function findWorkspace(workspaceId: string, userId: string, chatId: string, turnId: string): WorkspaceRow | null {
  const database = getDb();
  ensureFrameCapabilityDatabase(database);
  purgeExpiredFrameCapabilities();
  if (!tableExists(database, "agent_turn_workspaces")) return null;
  const raw = database.query("SELECT * FROM agent_turn_workspaces WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?").get(workspaceId, userId, chatId, turnId) as Record<string, unknown> | null;
  if (!raw) {
    invalidateFrameCapabilitiesForTurn({ userId, chatId, turnId });
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = rowNumber(raw, ["expires_at"]);
  const persistedState = rowString(raw, ["state"], "active") as WorkspaceStateV1;
  const state = persistedState === "active" && expiresAt > 0 && expiresAt <= now ? "expired" : persistedState;
  if (state !== "active" && state !== "frozen" && state !== "expired") fail("invalid_state", "workspace state is invalid");
  if (state !== "active") invalidateFrameCapabilitiesForTurn({ userId, chatId, turnId });
  const executionId = rowString(raw, ["execution_id"], turnId);
  let turnActive = true;
  if (tableExists(database, "agent_turn_executions")) {
    const executionColumns = tableColumns(database, "agent_turn_executions");
    const phaseColumn = executionColumns.has("phase") ? "phase" : "state";
    const cancelColumn = executionColumns.has("cancel_requested_at") ? "cancel_requested_at" : null;
    const deadlineColumn = executionColumns.has("deadline_at") ? "deadline_at" : null;
    const execution = database.query(
      `SELECT ${quoteIdentifier(phaseColumn)} AS phase, ${cancelColumn ? `${quoteIdentifier(cancelColumn)} AS cancel_requested_at` : "NULL AS cancel_requested_at"}, ${deadlineColumn ? `${quoteIdentifier(deadlineColumn)} AS deadline_at` : "0 AS deadline_at"} FROM agent_turn_executions WHERE id = ? AND id = ? AND user_id = ? AND chat_id = ?`,
    ).get(executionId, turnId, userId, chatId) as Record<string, unknown> | null;
    const executionState = rowString(execution ?? {}, ["phase", "state"]);
    const deadlineAt = rowNumber(execution ?? {}, ["deadline_at"]);
    turnActive = !!execution
      && !TERMINAL_TURN_STATES.has(executionState)
      && (execution.cancel_requested_at === null || execution.cancel_requested_at === undefined)
      && (deadlineAt <= 0 || deadlineAt > now);
    if (!turnActive) invalidateFrameCapabilitiesForTurn({ userId, chatId, turnId });
  }
  let constraints: string[];
  try { const parsed: unknown = JSON.parse(rowString(raw, ["constraints_json"], "[]")); constraints = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []; } catch { fail("invalid_input", "workspace constraints are invalid"); }
  return {
    workspaceId, turnId, executionId, userId, chatId, objective: rowString(raw, ["objective"]), constraints,
    state, revision: rowNumber(raw, ["revision"]), caps: JSON.parse(rowString(raw, ["operation_caps_json"], "{}")) as WorkspaceOperationCapabilitiesV1,
    retention: rowString(raw, ["retention"], "operational") as WorkspaceRetentionV1, expiresAt,
    quota: { maxTasks: rowNumber(raw, ["quota_tasks"]), maxRecords: rowNumber(raw, ["quota_records"]), maxSubmissions: rowNumber(raw, ["quota_submissions"]), maxArtifacts: rowNumber(raw, ["quota_artifacts"]), maxBytes: rowNumber(raw, ["quota_bytes"]) },
    usage: { taskCount: rowNumber(raw, ["task_count"]), recordCount: rowNumber(raw, ["record_count"]), submissionCount: rowNumber(raw, ["submission_count"]), artifactCount: rowNumber(raw, ["artifact_count"]), byteCount: rowNumber(raw, ["byte_count"]) },
    frozenAt: raw.frozen_at === null || raw.frozen_at === undefined ? null : rowNumber(raw, ["frozen_at"]), createdAt: rowNumber(raw, ["created_at"]), updatedAt: rowNumber(raw, ["updated_at"]), turnActive,
  };
}
function requireWorkspace(input: WorkspaceFrameContextV1): WorkspaceRow {
  const row = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
  if (!row) fail("not_found", "workspace was not found");
  if (row.revision !== input.expectedRevision) fail("stale_revision", "workspace revision is stale", { expected: input.expectedRevision, actual: row.revision });
  return row;
}
function requireWritable(input: WorkspaceFrameContextV1): WorkspaceRow {
  const row = requireWorkspace(input);
  if (row.state === "frozen" || row.state === "expired" || (row.expiresAt > 0 && row.expiresAt <= Math.floor(Date.now() / 1000))) fail("workspace_frozen", "workspace is not writable");
  return row;
}
function frameCapabilityKey(value: Pick<WorkspaceFrameCapabilityGrantV1, "userId" | "chatId" | "turnId" | "workspaceId" | "frameId">): string {
  return JSON.stringify([value.userId, value.chatId, value.turnId, value.workspaceId, value.frameId]);
}

function ensureFrameCapabilityDatabase(database: Database): void {
  if (frameCapabilitiesDatabase === database) return;
  frameCapabilities.clear();
  frameCapabilitiesDatabase = database;
}

/** Remove all grants tied to one exact authenticated turn authority tuple. */
export function invalidateFrameCapabilitiesForTurn(
  value: Pick<WorkspaceFrameCapabilityGrantV1, "userId" | "chatId" | "turnId">,
): void {
  for (const [key, grant] of frameCapabilities) {
    if (grant.userId === value.userId && grant.chatId === value.chatId && grant.turnId === value.turnId) {
      frameCapabilities.delete(key);
    }
  }
}

/** Purge grants whose workspace TTL has elapsed. */
export function purgeExpiredFrameCapabilities(now = Math.floor(Date.now() / 1000)): void {
  for (const [key, grant] of frameCapabilities) {
    if (grant.workspaceExpiresAt > 0 && grant.workspaceExpiresAt <= now) frameCapabilities.delete(key);
  }
}

/** Narrow observability used by focused lifecycle tests; no grant data escapes. */
export function getActiveFrameCapabilityCountForTests(): number {
  return frameCapabilities.size;
}

function requireCapability(input: WorkspaceFrameContextV1, operation: WorkspaceOperationKindV1, rawRequest: unknown): void {
  if (input.actor === "host" || input.actor === "root") return;
  const frameId = input.frameId;
  if (!frameId) fail("child_confinement", "child operations require frameId");
  const database = getDb();
  ensureFrameCapabilityDatabase(database);
  purgeExpiredFrameCapabilities();
  const key = frameCapabilityKey({
    userId: input.userId,
    chatId: input.chatId,
    turnId: input.turnId,
    workspaceId: input.workspaceId,
    frameId,
  });
  const grant = frameCapabilities.get(key);
  if (!grant) fail("capability_denied", "frame capabilities are not frozen");
  const caps = grant.capabilities;
  if (!caps.allowed.includes(operation)) fail("capability_denied", `frame lacks ${operation} capability`);
  const operationBytes = measureWorkspaceOperationBytesV1(rawRequest);
  if (caps.maxOperationBytes < 1 || operationBytes > caps.maxOperationBytes) {
    fail("capability_denied", "workspace operation exceeds the frame byte budget", {
      limit: caps.maxOperationBytes,
      observed: operationBytes,
    });
  }
  if (caps.maxOperations < 1 || grant.operationsUsed >= caps.maxOperations) {
    fail("capability_denied", "frame operation budget is exhausted", {
      limit: caps.maxOperations,
      observed: grant.operationsUsed + 1,
    });
  }
  // Bun executes these synchronous workspace operations atomically on the
  // event loop. Increment before the protected read/write/action so a
  // concurrent last-operation race admits exactly one attempt.
  grant.operationsUsed += 1;
}
function validateFrameCapabilityGrant(value: unknown): WorkspaceFrameCapabilityGrantV1 {
  if (!isRecord(value)) fail("invalid_input", "frame capability grant must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "frameId", "capabilities"], "frameCapabilityGrant");
  assertNoPrivateFields(value);
  return Object.freeze({
    userId: idValue(value.userId, "userId"),
    chatId: idValue(value.chatId, "chatId"),
    turnId: idValue(value.turnId, "turnId"),
    workspaceId: idValue(value.workspaceId, "workspaceId"),
    frameId: idValue(value.frameId, "frameId"),
    capabilities: capabilityValue(value.capabilities, "child"),
  });
}
/**
 * Freeze a host-issued child grant against the complete authority tuple.
 * Child/model input never reaches this function; it can only use a grant
 * already registered by the trusted coordinator.
 */
export function freezeFrameCapabilities(raw: unknown): WorkspaceOperationCapabilitiesV1 {
  const input = validateFrameCapabilityGrant(raw);
  const row = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
  if (!row) fail("not_found", "workspace was not found");
  if (!row.turnActive || row.state !== "active" || row.expiresAt > 0 && row.expiresAt <= Math.floor(Date.now() / 1000)) {
    invalidateFrameCapabilitiesForTurn(input);
    fail("workspace_frozen", "frame capabilities require an active workspace turn");
  }
  const workspaceCaps = capabilityValue(row.caps, "root");
  if (
    input.capabilities.revision > workspaceCaps.revision
    || input.capabilities.maxOperationBytes > workspaceCaps.maxOperationBytes
    || input.capabilities.maxOperations > workspaceCaps.maxOperations
    || input.capabilities.allowed.some((operation) => !workspaceCaps.allowed.includes(operation))
  ) {
    fail("forbidden", "frame capabilities exceed the workspace grant");
  }
  const key = frameCapabilityKey(input);
  const old = frameCapabilities.get(key);
  const encoded = JSON.stringify(input.capabilities);
  if (old !== undefined) {
    if (JSON.stringify(old.capabilities) !== encoded) fail("forbidden", "frame capabilities are already frozen");
    return deepFreeze({ ...old.capabilities });
  }
  frameCapabilities.set(key, {
    userId: input.userId,
    chatId: input.chatId,
    turnId: input.turnId,
    workspaceId: input.workspaceId,
    frameId: input.frameId,
    workspaceExpiresAt: row.expiresAt,
    capabilities: input.capabilities,
    operationsUsed: 0,
  });
  return deepFreeze({ ...input.capabilities });
}
function publicWorkspace(row: WorkspaceRow): WorkspaceSnapshotV1 {
  return deepFreeze({ id: row.workspaceId, turnId: row.turnId, executionId: row.executionId, userId: row.userId, chatId: row.chatId, objective: row.objective, constraints: [...row.constraints], state: row.state, revision: row.revision, quota: { ...row.quota }, usage: { ...row.usage }, retention: row.retention, expiresAt: row.expiresAt, createdAt: row.createdAt, updatedAt: row.updatedAt, frozenAt: row.frozenAt });
}
function listWorkspaceRows(table: string, row: WorkspaceRow): Array<Record<string, unknown>> {
  const database = getDb();
  if (!tableExists(database, table)) fail("schema_unavailable", `${table} is unavailable`);
  return database.query(`SELECT * FROM ${quoteIdentifier(table)} WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?`).all(row.workspaceId, row.userId, row.chatId, row.turnId) as Array<Record<string, unknown>>;
}
function serializedTaskFootprintV1(title: string, objective: string, dependencies: readonly string[]): number {
  return utf8ByteLength(title)
    + utf8ByteLength(objective)
    + utf8ByteLength(JSON.stringify(dependencies));
}

function taskFootprintFromRow(raw: Record<string, unknown>): number {
  return serializedTaskFootprintV1(
    rowString(raw, ["title"]),
    rowString(raw, ["description", "title"]),
    jsonArray(raw.dependencies_json),
  );
}

/**
 * Rebuild usage from the rows that are authoritative for a workspace. The
 * denormalized counters are still updated for fast reads, but admissions must
 * never trust a stale counter after another CAS writer has committed.
 */
function currentWorkspaceUsage(database: Database, row: WorkspaceRow): WorkspaceUsageV1 {
  const rows = (table: string): Array<Record<string, unknown>> => {
    if (!tableExists(database, table)) return [];
    return database.query(
      `SELECT * FROM ${quoteIdentifier(table)}
       WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?`,
    ).all(row.workspaceId, row.userId, row.chatId, row.turnId) as Array<Record<string, unknown>>;
  };
  const tasks = rows("agent_workspace_tasks");
  const records = rows("agent_workspace_records");
  const submissions = rows("agent_workspace_submissions");
  const artifacts = rows("agent_workspace_artifacts");
  const rowBytes = (candidate: Record<string, unknown>): number => Math.max(0, rowNumber(candidate, ["byte_count"]));
  const byteCount = tasks.reduce((total, task) => total + taskFootprintFromRow(task), 0)
    + records.reduce((total, record) => total + rowBytes(record), 0)
    + submissions.reduce((total, submission) => total + rowBytes(submission), 0)
    + artifacts.reduce((total, artifact) => total + rowBytes(artifact), 0);
  return {
    taskCount: tasks.length,
    recordCount: records.length,
    submissionCount: submissions.length,
    artifactCount: artifacts.length,
    byteCount,
  };
}

function currentWorkspaceForMutation(row: WorkspaceRow): WorkspaceRow {
  const current = findWorkspace(row.workspaceId, row.userId, row.chatId, row.turnId);
  if (!current || current.revision !== row.revision) fail("stale_revision", "workspace revision changed before mutation");
  return current;
}

function taskFromRow(raw: Record<string, unknown>): WorkspaceTaskV1 {
  const state = rowString(raw, ["state"]) as WorkspaceTaskStateV1;
  if (!STATES.has(state)) fail("invalid_state", "task state is invalid");
  return deepFreeze({
    id: rowString(raw, ["task_id"]),
    workspaceId: rowString(raw, ["workspace_id"]),
    turnId: rowString(raw, ["turn_id"]),
    userId: rowString(raw, ["user_id"]),
    chatId: rowString(raw, ["chat_id"]),
    title: rowString(raw, ["title"]),
    objective: rowString(raw, ["description", "title"]),
    state,
    required: rowNumber(raw, ["required"]) === 1,
    dependencyIds: Object.freeze(jsonArray(raw.dependencies_json)),
    assignedFrameId: rowNullableString(raw, ["assigned_frame_id"]),
    progress: Math.max(0, Math.min(1, rowNumber(raw, ["progress"]))),
    summary: rowNullableString(raw, ["summary"]),
    revision: rowNumber(raw, ["revision"]),
    retention: rowString(raw, ["retention"], "operational") as WorkspaceRetentionV1,
    expiresAt: rowNumber(raw, ["expires_at"]),
    createdAt: rowNumber(raw, ["created_at"]),
    updatedAt: rowNumber(raw, ["updated_at"]),
  });
}
function taskById(row: WorkspaceRow, taskId: string): WorkspaceTaskV1 {
  const found = listWorkspaceRows("agent_workspace_tasks", row).find((candidate) => rowString(candidate, ["task_id"]) === taskId);
  if (!found) fail("not_found", "task was not found");
  return taskFromRow(found);
}
function recordFromRow(raw: Record<string, unknown>): WorkspaceRecordV1 {
  const kind = rowString(raw, ["kind"]) as WorkspaceRecordKindV1;
  if (!KINDS.has(kind)) fail("invalid_input", "record kind is invalid");
  return deepFreeze({ id: rowString(raw, ["record_id"]), workspaceId: rowString(raw, ["workspace_id"]), turnId: rowString(raw, ["turn_id"]), userId: rowString(raw, ["user_id"]), chatId: rowString(raw, ["chat_id"]), kind, summary: rowString(raw, ["summary"]), digest: rowString(raw, ["digest"]), taskId: rowNullableString(raw, ["task_id"]), sourceFrameId: rowNullableString(raw, ["source_frame_id"]), byteCount: rowNumber(raw, ["byte_count"]), revision: rowNumber(raw, ["revision"]), retention: rowString(raw, ["retention"], "operational") as WorkspaceRetentionV1, expiresAt: rowNumber(raw, ["expires_at"]), createdAt: rowNumber(raw, ["created_at"]) });
}
function recordById(row: WorkspaceRow, recordId: string): WorkspaceRecordV1 {
  const found = listWorkspaceRows("agent_workspace_records", row).find((candidate) => rowString(candidate, ["record_id"]) === recordId);
  if (!found) fail("not_found", "record was not found");
  return recordFromRow(found);
}
function submissionFromRow(raw: Record<string, unknown>): WorkspaceSubmissionV1 {
  const state = rowString(raw, ["state"]) as WorkspaceSubmissionV1["state"];
  if (!(WORKSPACE_SUBMISSION_STATES as readonly string[]).includes(state)) fail("invalid_state", "submission state is invalid");
  return deepFreeze({ id: rowString(raw, ["submission_id"]), workspaceId: rowString(raw, ["workspace_id"]), turnId: rowString(raw, ["turn_id"]), taskId: rowString(raw, ["task_id"]), userId: rowString(raw, ["user_id"]), chatId: rowString(raw, ["chat_id"]), childFrameId: rowString(raw, ["child_frame_id"]), state, summary: rowString(raw, ["summary"]), resultDigest: rowString(raw, ["result_digest"]), byteCount: rowNumber(raw, ["byte_count"]), revision: rowNumber(raw, ["revision"]), retention: rowString(raw, ["retention"], "operational") as WorkspaceRetentionV1, expiresAt: rowNumber(raw, ["expires_at"]), createdAt: rowNumber(raw, ["created_at"]), updatedAt: rowNumber(raw, ["updated_at"]) });
}
function submissionById(row: WorkspaceRow, id: string): WorkspaceSubmissionV1 {
  const found = listWorkspaceRows("agent_workspace_submissions", row).find((candidate) => rowString(candidate, ["submission_id"]) === id);
  if (!found) fail("not_found", "submission was not found");
  return submissionFromRow(found);
}
function artifactFromRow(raw: Record<string, unknown>): WorkspaceArtifactReferenceV1 {
  const state = rowString(raw, ["publication_state"], "attached") as WorkspaceArtifactReferenceV1["publicationState"];
  if (state !== "attached" && state !== "proposed" && state !== "published") fail("invalid_state", "artifact publication state is invalid");
  let provenance: WorkspaceArtifactProvenanceV1 = "host";
  try { const parsed: unknown = JSON.parse(rowString(raw, ["provenance_json"], "\"host\"")); if (typeof parsed === "string" && PROVENANCE.has(parsed as WorkspaceArtifactProvenanceV1)) provenance = parsed as WorkspaceArtifactProvenanceV1; } catch { /* do not expose malformed provenance */ }
  return deepFreeze({ id: rowString(raw, ["artifact_id"]), workspaceId: rowString(raw, ["workspace_id"]), turnId: rowString(raw, ["turn_id"]), userId: rowString(raw, ["user_id"]), chatId: rowString(raw, ["chat_id"]), blobDigest: rowString(raw, ["blob_digest"]), mimeType: rowString(raw, ["mime_type"]), byteCount: rowNumber(raw, ["byte_count"]), provenance, sourceFrameId: rowNullableString(raw, ["source_frame_id"]), sourceTaskId: rowNullableString(raw, ["source_task_id"]), publicationState: state, retention: rowString(raw, ["retention"], "operational") as WorkspaceRetentionV1, revision: rowNumber(raw, ["revision"]), expiresAt: rowNumber(raw, ["expires_at"]), createdAt: rowNumber(raw, ["created_at"]) });
}
function artifactById(row: WorkspaceRow, artifactId: string): WorkspaceArtifactReferenceV1 {
  const found = listWorkspaceRows("agent_workspace_artifacts", row).find((candidate) => rowString(candidate, ["artifact_id"]) === artifactId);
  if (!found) fail("not_found", "artifact was not found");
  return artifactFromRow(found);
}
function assertAssignedChild(input: WorkspaceFrameContextV1, task: WorkspaceTaskV1): void {
  if (input.actor !== "child" || !input.frameId || task.assignedFrameId !== input.frameId) fail("child_confinement", "child may only mutate its assigned task");
}
function assertAcyclic(row: WorkspaceRow, taskId: string, dependencies: readonly string[]): void {
  if (dependencies.includes(taskId)) fail("dependency_cycle", "task cannot depend on itself");
  const graph = new Map<string, readonly string[]>();
  for (const candidate of listWorkspaceRows("agent_workspace_tasks", row)) graph.set(rowString(candidate, ["task_id"]), jsonArray(candidate.dependencies_json));
  graph.set(taskId, dependencies);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail("dependency_cycle", "workspace dependencies must be acyclic");
    if (visited.has(id)) return;
    if (!graph.has(id)) fail("invalid_input", "task dependency does not exist");
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}
function mutateWorkspace(row: WorkspaceRow, operation: () => void): number {
  getDb().transaction(operation)();
  return row.revision + 1;
}
function casWorkspace(row: WorkspaceRow, values: Record<string, unknown>): void {
  const changed = updateRow(getDb(), "agent_turn_workspaces", { ...values, revision: row.revision + 1, updated_at: values.updated_at ?? Math.floor(Date.now() / 1000) }, { workspace_id: row.workspaceId, turn_id: row.turnId, execution_id: row.executionId, user_id: row.userId, chat_id: row.chatId, revision: row.revision });
  if (changed !== 1) fail("stale_revision", "workspace revision is stale");
}

export function createTurnWorkspace(raw: unknown): WorkspaceSnapshotV1 {
  const input = validateCreateWorkspaceInput(raw);
  const database = getDb();
  if (!tableExists(database, "agent_turn_workspaces")) fail("schema_unavailable", "workspace schema is unavailable");
  if (tableExists(database, "agent_turn_executions") && !database.query("SELECT 1 AS present FROM agent_turn_executions WHERE id = ? AND user_id = ? AND chat_id = ?").get(input.turnId, input.userId, input.chatId)) fail("not_found", "turn execution was not found");
  const workspaceId = input.workspaceId ?? crypto.randomUUID();
  idValue(workspaceId, "workspaceId");
  if (findWorkspace(workspaceId, input.userId, input.chatId, input.turnId)) fail("duplicate_id", "workspace identifier is already in use");
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = input.retention === "chat_lifetime" ? 0 : now + (input.ttlSeconds ?? 0);
  database.transaction(() => {
    insertRow(database, "agent_turn_workspaces", {
      workspace_id: workspaceId, turn_id: input.turnId, execution_id: input.turnId, user_id: input.userId, chat_id: input.chatId,
      objective: input.objective, constraints_json: JSON.stringify(input.constraints), state: "active", revision: 0, cas_owner: null, cas_expires_at: null,
      operation_caps_json: JSON.stringify(input.capabilities), field_caps_json: JSON.stringify(input.capabilities), retention: input.retention, expires_at: expiresAt,
      quota_tasks: input.quota.maxTasks, quota_records: input.quota.maxRecords, quota_submissions: input.quota.maxSubmissions, quota_artifacts: input.quota.maxArtifacts, quota_bytes: input.quota.maxBytes,
      task_count: 0, record_count: 0, submission_count: 0, artifact_count: 0, byte_count: 0, created_at: now, updated_at: now, frozen_at: null,
    }, ["workspace_id", "turn_id", "execution_id", "user_id", "chat_id"]);
    if (tableExists(database, "agent_turn_executions") && updateRow(database, "agent_turn_executions", { workspace_id: workspaceId, workspace_revision: 0, updated_at: now }, { id: input.turnId, user_id: input.userId, chat_id: input.chatId }) !== 1) fail("stale_revision", "turn execution changed while creating workspace");
  })();
  return getTurnWorkspace({ userId: input.userId, chatId: input.chatId, turnId: input.turnId, workspaceId, actor: "root", expectedRevision: 0 });
}
export function getTurnWorkspace(raw: unknown): WorkspaceSnapshotV1 {
  return publicWorkspace(requireWorkspace(contextValue(raw, true)));
}

/**
 * Read the persisted workspace CAS revision without supplying an expected
 * revision. This is used only after an operation whose response omitted its
 * public revision; callers must use the returned value verbatim rather than
 * deriving a revision from an in-memory counter.
 */
export function getCurrentWorkspaceRevisionV1(raw: unknown): number {
  if (!isRecord(raw)) fail("invalid_input", "workspace identity must be an object");
  assertKeys(raw, ["userId", "chatId", "turnId", "workspaceId"], "workspaceIdentity");
  assertNoPrivateFields(raw);
  const userId = idValue(raw.userId, "userId");
  const chatId = idValue(raw.chatId, "chatId");
  const turnId = idValue(raw.turnId, "turnId");
  const workspaceId = idValue(raw.workspaceId, "workspaceId");
  const row = findWorkspace(workspaceId, userId, chatId, turnId);
  if (!row) fail("not_found", "workspace was not found");
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) fail("invalid_state", "workspace revision is malformed");
  return row.revision;
}
export function readTurnWorkspaceSection(raw: unknown): WorkspaceSectionPageV1 {
  const input = validateReadWorkspaceSectionInput(raw);
  const row = requireWorkspace(input);
  requireCapability(input, input.page > 0 ? "read_page" : "read_section", raw);
  const workspace = publicWorkspace(row);
  if (input.section === "objective") return { workspace, section: input.section, page: input.page, pageSize: input.pageSize, total: 1, items: [{ objective: workspace.objective }] };
  if (input.section === "constraints") return { workspace, section: input.section, page: input.page, pageSize: input.pageSize, total: workspace.constraints.length, items: workspace.constraints.slice(input.page * input.pageSize, (input.page + 1) * input.pageSize).map((constraint: string) => ({ constraint })) };
  if (input.section === "summary") return { workspace, section: input.section, page: input.page, pageSize: input.pageSize, total: 1, items: [{ usage: workspace.usage, state: workspace.state, revision: workspace.revision }] };
  const table = input.section === "tasks" ? "agent_workspace_tasks" : input.section === "records" ? "agent_workspace_records" : input.section === "submissions" ? "agent_workspace_submissions" : "agent_workspace_artifacts";
  const rows = listWorkspaceRows(table, row);
  const items = rows.map((candidate) => input.section === "tasks" ? taskFromRow(candidate) : input.section === "records" ? recordFromRow(candidate) : input.section === "submissions" ? submissionFromRow(candidate) : artifactFromRow(candidate));
  return { workspace, section: input.section, page: input.page, pageSize: input.pageSize, total: items.length, items: items.slice(input.page * input.pageSize, (input.page + 1) * input.pageSize) };
}
export function createWorkspaceTask(raw: unknown): WorkspaceTaskV1 {
  const input = validateCreateWorkspaceTaskInput(raw);
  if (input.required && input.actor !== "host") fail("forbidden", "root-created tasks must be optional");
  const row = requireWritable(input);
  requireCapability(input, "create_task", raw);
  if (input.actor === "child") fail("forbidden", "children cannot create tasks");

  const taskId = input.taskId ?? crypto.randomUUID();
  idValue(taskId, "taskId");
  const objective = input.objective ?? input.title;
  const dependenciesJson = JSON.stringify(input.dependencyIds);
  const byteCount = serializedTaskFootprintV1(input.title, objective, input.dependencyIds);
  const now = Math.floor(Date.now() / 1000);
  const policy = input.retention === undefined
    ? { retention: row.retention, expiresAt: row.expiresAt }
    : retentionValue(input.retention, input.ttlSeconds, now);
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    const usage = currentWorkspaceUsage(getDb(), current);
    if (usage.taskCount >= current.quota.maxTasks) {
      fail("quota_exceeded", "task quota exceeded", { limit: current.quota.maxTasks, observed: usage.taskCount + 1 });
    }
    if (usage.byteCount + byteCount > current.quota.maxBytes) fail("quota_exceeded", "workspace byte quota exceeded");
    if (listWorkspaceRows("agent_workspace_tasks", current).some((candidate) => rowString(candidate, ["task_id"]) === taskId)) {
      fail("duplicate_id", "task identifier is already in use");
    }
    assertAcyclic(current, taskId, input.dependencyIds);
    insertRow(getDb(), "agent_workspace_tasks", {
      task_id: taskId,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      title: input.title,
      description: objective,
      state: "active",
      required: input.required ? 1 : 0,
      dependencies_json: dependenciesJson,
      assigned_frame_id: input.assignedFrameId,
      progress: 0,
      summary: null,
      byte_count: byteCount,
      revision: 0,
      cas_owner: null,
      cas_expires_at: null,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
      updated_at: now,
    }, ["task_id", "workspace_id", "turn_id", "user_id", "chat_id", "title", "description", "retention", "expires_at"]);
    casWorkspace(current, {
      task_count: usage.taskCount + 1,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + byteCount,
      updated_at: now,
    });
  });
  return taskById(row, taskId);
}
/**
 * Assign already materialized cognition tasks to host-generated child frames.
 * This control-plane operation deliberately is not part of WORK's model-visible
 * operation vocabulary. Validation happens for the complete batch before any
 * row is updated; the workspace CAS and task updates share one transaction.
 */
export function assignChildTasks(raw: unknown): AssignWorkspaceTasksResultV1 {
  const input = validateAssignWorkspaceTasksInput(raw);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root assign child tasks");
  requireCapability(input, "create_task", raw);
  const initial = requireWritable(input);
  let committedRevision = -1;
  let assignedIds: readonly string[] = [];
  const database = getDb();
  database.transaction(() => {
    const row = requireWorkspace(input);
    if (row.state === "frozen" || row.state === "expired" || (row.expiresAt > 0 && row.expiresAt <= Math.floor(Date.now() / 1000))) {
      fail("workspace_frozen", "workspace is not writable");
    }
    const taskRows = listWorkspaceRows("agent_workspace_tasks", row);
    const tasksById = new Map(taskRows.map((candidate) => {
      const task = taskFromRow(candidate);
      return [task.id, task] as const;
    }));
    const submissionsByTask = new Map<string, Set<string>>();
    for (const candidate of listWorkspaceRows("agent_workspace_submissions", row)) {
      const taskId = rowString(candidate, ["task_id"]);
      const state = rowString(candidate, ["state"]);
      const states = submissionsByTask.get(taskId) ?? new Set<string>();
      states.add(state);
      submissionsByTask.set(taskId, states);
    }
    const now = Math.floor(Date.now() / 1000);
    const assignments: Array<{ task: WorkspaceTaskV1; frameId: string }> = [];
    for (const assignment of input.assignments) {
      const task = tasksById.get(assignment.taskId);
      if (!task) fail("not_found", `task ${assignment.taskId} was not found`);
      if (task.state === "submitted") fail("invalid_state", `task ${task.id} is not open`);
      if (task.expiresAt > 0 && task.expiresAt <= now) fail("invalid_state", `task ${task.id} has expired`);
      if (task.assignedFrameId !== null) fail("task_assignment_conflict", `task ${task.id} is already assigned`);
      const frameOwner = taskRows.find((candidate) => rowNullableString(candidate, ["assigned_frame_id"]) === assignment.frameId);
      if (frameOwner && rowString(frameOwner, ["task_id"]) !== task.id) fail("task_assignment_conflict", `frame ${assignment.frameId} is already assigned`);
      assertAcyclic(row, task.id, task.dependencyIds);
      for (const dependencyId of task.dependencyIds) {
        const dependency = tasksById.get(dependencyId);
        if (!dependency) fail("invalid_input", `task ${task.id} dependency ${dependencyId} does not exist`);
        const dependencyStates = submissionsByTask.get(dependency.id);
        if (dependency.state !== "submitted" || !dependencyStates?.has("accepted")) {
          fail("dependency_cycle", `task ${task.id} dependency ${dependency.id} is not accepted`);
        }
      }
      assignments.push({ task, frameId: assignment.frameId });
    }
    for (const { task, frameId } of assignments) {
      if (updateRow(database, "agent_workspace_tasks", {
        assigned_frame_id: frameId,
        revision: task.revision + 1,
        updated_at: now,
      }, {
        task_id: task.id,
        workspace_id: row.workspaceId,
        turn_id: row.turnId,
        user_id: row.userId,
        chat_id: row.chatId,
        revision: task.revision,
      }) !== 1) fail("stale_revision", `task ${task.id} changed during assignment`);
    }
    casWorkspace(row, { updated_at: now });
    committedRevision = row.revision + 1;
    assignedIds = Object.freeze(assignments.map(({ task }) => task.id));
  })();
  if (committedRevision < 0 || initial.revision !== input.expectedRevision) fail("stale_revision", "workspace assignment did not commit");
  const committed = requireWorkspace({ ...input, expectedRevision: committedRevision });
  const taskByIdAfterCommit = new Map(listWorkspaceRows("agent_workspace_tasks", committed).map((candidate) => {
    const task = taskFromRow(candidate);
    return [task.id, task] as const;
  }));
  return Object.freeze({
    workspaceRevision: committedRevision,
    tasks: Object.freeze(assignedIds.map((taskId) => {
      const task = taskByIdAfterCommit.get(taskId);
      if (!task) fail("not_found", `assigned task ${taskId} disappeared`);
      return task;
    })),
  });
}

/** Descriptive alias for callers that name the control-plane operation. */
export const assignWorkspaceTaskFrames = assignChildTasks;
export function updateWorkspaceTaskPolicy(raw: unknown): WorkspaceTaskV1 {
  const input = validateUpdateWorkspaceTaskPolicyInput(raw);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root change task policy");
  requireCapability(input, "create_task", raw);
  const task = taskById(row, input.taskId);
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    const currentTask = taskById(current, task.id);
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");
    const dependencies = input.dependencyIds ?? currentTask.dependencyIds;
    assertAcyclic(current, currentTask.id, dependencies);
    const oldByteCount = serializedTaskFootprintV1(currentTask.title, currentTask.objective, currentTask.dependencyIds);
    const newByteCount = serializedTaskFootprintV1(currentTask.title, currentTask.objective, dependencies);
    const usage = currentWorkspaceUsage(getDb(), current);
    const nextByteCount = usage.byteCount - oldByteCount + newByteCount;
    if (nextByteCount > current.quota.maxBytes) fail("quota_exceeded", "workspace byte quota exceeded");
    const now = Math.floor(Date.now() / 1000);
    const values: Record<string, unknown> = {
      byte_count: newByteCount,
      updated_at: now,
      revision: currentTask.revision + 1,
    };
    if (input.required !== undefined) values.required = input.required ? 1 : 0;
    if (input.dependencyIds !== undefined) values.dependencies_json = JSON.stringify(dependencies);
    if (input.assignedFrameId !== undefined) values.assigned_frame_id = input.assignedFrameId;
    if (input.retention !== undefined) {
      const policy = retentionValue(input.retention, input.ttlSeconds, now);
      values.retention = policy.retention;
      values.expires_at = policy.expiresAt;
    }
    if (updateRow(getDb(), "agent_workspace_tasks", values, {
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: currentTask.revision,
    }) !== 1) fail("stale_revision", "task revision is stale");
    casWorkspace(current, {
      task_count: usage.taskCount,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      byte_count: nextByteCount,
      updated_at: now,
    });
  });
  return taskById(row, task.id);
}
export function updateWorkspaceTaskProgress(raw: unknown): WorkspaceTaskV1 {
  const input = validateUpdateWorkspaceTaskProgressInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "update_assigned_progress", raw);
  const task = taskById(row, input.taskId);
  assertAssignedChild(input, task);
  mutateWorkspace(row, () => {
    if (updateRow(getDb(), "agent_workspace_tasks", { state: input.state, progress: input.progress, revision: task.revision + 1, updated_at: Math.floor(Date.now() / 1000) }, { task_id: task.id, workspace_id: row.workspaceId, turn_id: row.turnId, user_id: row.userId, chat_id: row.chatId, revision: task.revision }) !== 1) fail("stale_revision", "task revision is stale");
    casWorkspace(row, { updated_at: Math.floor(Date.now() / 1000) });
  });
  return taskById(row, task.id);
}
export function submitWorkspaceChildResult(raw: unknown): WorkspaceTaskV1 {
  const input = validateSubmitWorkspaceChildResultInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "submit_child_result", raw);
  const task = taskById(row, input.taskId);
  assertAssignedChild(input, task);
  const submissionBytes = input.byteCount + utf8ByteLength(input.summary);
  const submissionId = crypto.randomUUID();
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    const currentTask = taskById(current, task.id);
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");
    assertAssignedChild(input, currentTask);
    if (currentTask.state === "submitted" && listWorkspaceRows("agent_workspace_submissions", current).some((candidate) => rowString(candidate, ["task_id"]) === currentTask.id)) {
      fail("submission_rejected", "task already has a submitted result");
    }
    const usage = currentWorkspaceUsage(getDb(), current);
    if (usage.submissionCount >= current.quota.maxSubmissions || usage.byteCount + submissionBytes > current.quota.maxBytes) {
      fail("quota_exceeded", "submission quota exceeded");
    }
    const now = Math.floor(Date.now() / 1000);
    const policy = input.retention === undefined
      ? { retention: current.retention, expiresAt: current.expiresAt }
      : retentionValue(input.retention, input.ttlSeconds, now);
    insertRow(getDb(), "agent_workspace_submissions", {
      submission_id: submissionId,
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      child_frame_id: input.frameId,
      state: "proposed",
      summary: input.summary,
      result_digest: input.resultDigest,
      byte_count: submissionBytes,
      revision: 0,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
      updated_at: now,
    }, ["submission_id", "task_id", "workspace_id", "turn_id", "user_id", "chat_id", "child_frame_id", "state", "summary", "result_digest", "byte_count", "retention", "expires_at"]);
    if (updateRow(getDb(), "agent_workspace_tasks", {
      state: "submitted",
      progress: 1,
      revision: currentTask.revision + 1,
      updated_at: now,
    }, {
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: currentTask.revision,
    }) !== 1) fail("stale_revision", "task revision is stale");
    casWorkspace(current, {
      task_count: usage.taskCount,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount + 1,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + submissionBytes,
      updated_at: now,
    });
  });
  return taskById(row, task.id);
}
export function acceptWorkspaceSubmission(raw: unknown): WorkspaceSubmissionV1 {
  const input = validateAcceptWorkspaceSubmissionInput(raw);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root accept submissions");
  const submission = submissionById(row, input.submissionId);
  if (submission.state === "accepted") return submission;
  mutateWorkspace(row, () => {
    if (updateRow(getDb(), "agent_workspace_submissions", { state: "accepted", revision: submission.revision + 1, updated_at: Math.floor(Date.now() / 1000) }, { submission_id: submission.id, workspace_id: row.workspaceId, turn_id: row.turnId, user_id: row.userId, chat_id: row.chatId, revision: submission.revision }) !== 1) fail("stale_revision", "submission revision is stale");
    const task = taskById(row, submission.taskId);
    if (updateRow(getDb(), "agent_workspace_tasks", { summary: submission.summary, revision: task.revision + 1, updated_at: Math.floor(Date.now() / 1000) }, { task_id: task.id, workspace_id: row.workspaceId, turn_id: row.turnId, user_id: row.userId, chat_id: row.chatId, revision: task.revision }) !== 1) fail("stale_revision", "task revision is stale");
    casWorkspace(row, { updated_at: Math.floor(Date.now() / 1000) });
  });
  return submissionById(row, input.submissionId);
}
export function recordWorkspaceRecord(raw: unknown): WorkspaceRecordV1 {
  const input = validateRecordWorkspaceRecordInput(raw);
  const row = requireWritable(input);
  requireCapability(input, input.kind === "finding" ? "record_finding" : input.kind === "decision" ? "record_decision" : "record_question", raw);
  const byteCount = utf8ByteLength(input.summary);
  const recordId = crypto.randomUUID();
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    if (input.actor === "child") {
      if (!input.taskId) fail("child_confinement", "child records must name an assigned task");
      assertAssignedChild(input, taskById(current, input.taskId));
    }
    const usage = currentWorkspaceUsage(getDb(), current);
    if (usage.recordCount >= current.quota.maxRecords || usage.byteCount + byteCount > current.quota.maxBytes) {
      fail("quota_exceeded", "workspace record quota exceeded");
    }
    if (listWorkspaceRows("agent_workspace_records", current).some((candidate) => rowString(candidate, ["kind"]) === input.kind && rowString(candidate, ["digest"]) === input.digest)) {
      fail("duplicate_id", "record digest is already present");
    }
    const now = Math.floor(Date.now() / 1000);
    const policy = input.retention === undefined
      ? { retention: current.retention, expiresAt: current.expiresAt }
      : retentionValue(input.retention, input.ttlSeconds, now);
    insertRow(getDb(), "agent_workspace_records", {
      record_id: recordId,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      kind: input.kind,
      summary: input.summary,
      digest: input.digest,
      task_id: input.taskId,
      source_frame_id: input.frameId,
      byte_count: byteCount,
      revision: 0,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
    }, ["record_id", "workspace_id", "turn_id", "user_id", "chat_id", "kind", "summary", "digest", "byte_count", "retention", "expires_at"]);
    casWorkspace(current, {
      task_count: usage.taskCount,
      record_count: usage.recordCount + 1,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + byteCount,
      updated_at: now,
    });
  });
  return recordById(row, recordId);
}
export function attachWorkspaceArtifactReference(raw: unknown): WorkspaceArtifactReferenceV1 {
  const input = validateAttachWorkspaceArtifactInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "attach_artifact", raw);
  if (input.actor === "child") {
    if (!input.taskId) fail("child_confinement", "child artifacts must name an assigned task");
    assertAssignedChild(input, taskById(row, input.taskId));
    if (input.provenance !== "child") fail("child_confinement", "child artifacts must carry child provenance");
  }
  const database = getDb();
  const artifactId = input.artifactId ?? crypto.randomUUID();
  idValue(artifactId, "artifactId");
  withArtifactDeletionFence(input.userId, input.blobDigest, (deletionFence) => {
    mutateWorkspace(row, () => {
      const current = currentWorkspaceForMutation(row);
      if (input.actor === "child") {
        if (!input.taskId) fail("child_confinement", "child artifacts must name an assigned task");
        assertAssignedChild(input, taskById(current, input.taskId));
      }
      const usage = currentWorkspaceUsage(database, current);
      if (usage.artifactCount >= current.quota.maxArtifacts || usage.byteCount + input.byteCount > current.quota.maxBytes) {
        fail("quota_exceeded", "workspace artifact quota exceeded");
      }
      if (listWorkspaceRows("agent_workspace_artifacts", current).some((candidate) => rowString(candidate, ["artifact_id"]) === artifactId || rowString(candidate, ["blob_digest"]) === input.blobDigest)) {
        fail("duplicate_id", "artifact reference is already attached");
      }
      const assertFence = (): void => {
        const latest = findWorkspace(current.workspaceId, current.userId, current.chatId, current.turnId);
        if (!latest || latest.revision !== current.revision) fail("stale_revision", "workspace revision changed while attaching artifact");
      };
      try {
        assertArtifactAttachable(database, {
          userId: current.userId,
          turnId: current.turnId,
          digest: input.blobDigest,
          byteCount: input.byteCount,
          mimeType: input.mimeType,
          assertFence,
          deletionFence,
          creatorToken: input.creatorToken,
        });
      } catch (error) {
        if (error instanceof TurnWorkspaceError) throw error;
        if (error instanceof ArtifactBlobError && error.code === "artifact_file_mismatch") fail("invalid_input", error.message);
        fail("not_found", error instanceof Error ? error.message : "artifact blob is not attachable");
      }
      const now = Math.floor(Date.now() / 1000);
      const policy = input.retention === undefined
        ? { retention: current.retention, expiresAt: current.expiresAt }
        : retentionValue(input.retention, input.ttlSeconds, now);
      insertRow(database, "agent_workspace_artifacts", {
        artifact_id: artifactId,
        workspace_id: current.workspaceId,
        turn_id: current.turnId,
        user_id: current.userId,
        chat_id: current.chatId,
        blob_digest: input.blobDigest,
        mime_type: input.mimeType,
        byte_count: input.byteCount,
        provenance_json: JSON.stringify(input.provenance),
        source_frame_id: input.frameId,
        source_task_id: input.taskId,
        publication_state: "attached",
        retention: policy.retention,
        revision: 0,
        expires_at: policy.expiresAt,
        created_at: now,
        updated_at: now,
      }, ["artifact_id", "workspace_id", "turn_id", "user_id", "chat_id", "blob_digest", "mime_type", "byte_count", "provenance_json", "publication_state", "retention", "expires_at"]);
      casWorkspace(current, {
        task_count: usage.taskCount,
        record_count: usage.recordCount,
        submission_count: usage.submissionCount,
        artifact_count: usage.artifactCount + 1,
        byte_count: usage.byteCount + input.byteCount,
        updated_at: now,
      });
    });
  });
  return artifactById(row, artifactId);
}
export function proposeWorkspacePublication(raw: unknown): WorkspaceArtifactReferenceV1 {
  const input = validateProposeWorkspacePublicationInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "propose_publication", raw);
  const artifact = artifactById(row, input.artifactId);
  if (artifact.publicationState === "published") return artifact;
  mutateWorkspace(row, () => {
    if (updateRow(getDb(), "agent_workspace_artifacts", { publication_state: "proposed", revision: artifact.revision + 1, updated_at: Math.floor(Date.now() / 1000) }, { artifact_id: artifact.id, workspace_id: row.workspaceId, turn_id: row.turnId, user_id: row.userId, chat_id: row.chatId, revision: artifact.revision }) !== 1) fail("stale_revision", "artifact revision is stale");
    casWorkspace(row, { updated_at: Math.floor(Date.now() / 1000) });
  });
  return artifactById(row, artifact.id);
}
export function publishWorkspaceArtifact(raw: unknown): WorkspaceArtifactReferenceV1 {
  const input = validatePublishWorkspaceArtifactInput(raw);
  const row = requireWorkspace(input);
  if (row.state !== "frozen") fail("forbidden", "workspace must be frozen before publication");
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root publish artifacts");
  const receiptId = input.receiptId;
  if (!receiptId) fail("forbidden", "a committed receipt is required for artifact publication");
  const database = getDb();
  if (!tableExists(database, "agent_turn_commit_receipts")) {
    fail("forbidden", "committed receipt storage is unavailable");
  }
  const receipt = database.query(
    "SELECT commit_key, message_id, swipe_id FROM agent_turn_commit_receipts WHERE receipt_id = ? AND state = 'committed' AND turn_id = ? AND execution_id = ? AND workspace_id = ? AND user_id = ? AND chat_id = ? LIMIT 1",
  ).get(receiptId, row.turnId, row.executionId, row.workspaceId, row.userId, row.chatId) as { commit_key?: unknown; message_id?: unknown; swipe_id?: unknown } | null;
  if (!receipt || typeof receipt.commit_key !== "string" || receipt.commit_key.length === 0) {
    fail("forbidden", "publication receipt is not valid for this workspace");
  }
  const messageId = input.messageId === undefined
    ? (receipt.message_id == null ? null : String(receipt.message_id))
    : input.messageId;
  const swipeId = input.swipeId === undefined
    ? (receipt.swipe_id == null ? null : Number(receipt.swipe_id))
    : input.swipeId;
  if ((receipt.message_id == null ? messageId !== null : messageId !== String(receipt.message_id))
    || (receipt.swipe_id == null ? swipeId !== null : swipeId !== Number(receipt.swipe_id))) {
    fail("forbidden", "publication target does not match its committed receipt");
  }
  const artifact = artifactById(row, input.artifactId);
  if (artifact.publicationState !== "published") fail("forbidden", "artifact publication must be performed by the canonical commit coordinator");
  return withArtifactDeletionFence(row.userId, artifact.blobDigest, (deletionFence) => {
    const creator = database.query(
      "SELECT creator_token FROM agent_artifact_blob_journal WHERE user_id = ? AND turn_id = ? AND blob_digest = ? AND state = 'installed' LIMIT 1",
    ).get(row.userId, row.turnId, artifact.blobDigest) as { creator_token?: unknown } | null;
    if (!creator || typeof creator.creator_token !== "string" || creator.creator_token.length === 0) {
      fail("forbidden", "published artifact creator proof is unavailable");
    }
    try {
      assertArtifactAttachable(database, {
        userId: row.userId,
        turnId: row.turnId,
        digest: artifact.blobDigest,
        byteCount: artifact.byteCount,
        mimeType: artifact.mimeType,
        assertFence: () => {
          const latest = findWorkspace(row.workspaceId, row.userId, row.chatId, row.turnId);
          if (!latest || latest.revision !== row.revision) fail("stale_revision", "workspace revision changed while checking artifact");
        },
        deletionFence,
        creatorToken: creator.creator_token,
      });
    } catch (error) {
      if (error instanceof TurnWorkspaceError) throw error;
      fail("forbidden", "published artifact bytes are unavailable");
    }
    const existing = database.query(
      "SELECT receipt_id, message_id, swipe_id FROM agent_published_workspace_artifacts WHERE user_id = ? AND chat_id = ? AND source_artifact_id = ? AND blob_digest = ? LIMIT 1",
    ).get(row.userId, row.chatId, artifact.id, artifact.blobDigest) as { receipt_id?: unknown; message_id?: unknown; swipe_id?: unknown } | null;
    if (!existing
      || String(existing.receipt_id) !== receiptId
      || (existing.message_id == null ? messageId !== null : String(existing.message_id) !== messageId)
      || (existing.swipe_id == null ? swipeId !== null : Number(existing.swipe_id) !== swipeId)) {
      fail("forbidden", "published artifact reference does not match its committed receipt");
    }
    return artifact;
    });
}
export function freezeTurnWorkspace(raw: unknown): WorkspaceSnapshotV1 {
  const input = contextValue(raw, true);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root freeze workspaces");
  const next = mutateWorkspace(row, () => casWorkspace(row, { state: "frozen", frozen_at: Math.floor(Date.now() / 1000), updated_at: Math.floor(Date.now() / 1000) }));
  return getTurnWorkspace({ ...input, expectedRevision: next });
}
export function setWorkspaceCompletionMetadata(raw: unknown): WorkspaceSnapshotV1 {
  const input = validateWorkspaceCompletionMetadataInput(raw);
  const row = requireWorkspace(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root set completion metadata");
  if (row.state !== "frozen") fail("forbidden", "completion metadata requires a frozen workspace");
  const next = mutateWorkspace(row, () => {
    if (tableExists(getDb(), "agent_turn_executions")) updateRow(getDb(), "agent_turn_executions", { terminal_code: input.completionCode, updated_at: Math.floor(Date.now() / 1000) }, { id: row.executionId, user_id: row.userId, chat_id: row.chatId });
    casWorkspace(row, { updated_at: Math.floor(Date.now() / 1000) });
  });
  return getTurnWorkspace({ ...input, expectedRevision: next });
}
function hasAcceptedSubmissionForTask(
  taskId: string,
  submissions: readonly WorkspaceSubmissionV1[],
): boolean {
  if (taskId.length === 0) return false;
  return submissions.some((submission) => submission.taskId === taskId && submission.state === "accepted");
}

function hasAcceptedSubmissionRow(
  taskId: string,
  submissions: readonly Record<string, unknown>[],
): boolean {
  if (taskId.length === 0) return false;
  return submissions.some((submission) =>
    rowString(submission, ["task_id"]) === taskId
    && rowString(submission, ["state"]) === "accepted"
  );
}

function taskCompletionAccepted(
  task: WorkspaceTaskV1,
  submissions: readonly WorkspaceSubmissionV1[],
): boolean {
  return task.state === "submitted" && hasAcceptedSubmissionForTask(task.id, submissions);
}

function taskRowCompletionAccepted(
  task: Record<string, unknown>,
  submissions: readonly Record<string, unknown>[],
): boolean {
  return rowString(task, ["state"]) === "submitted"
    && hasAcceptedSubmissionRow(rowString(task, ["task_id"]), submissions);
}

export function listRequiredOpenWorkspaceTasks(raw: unknown): readonly WorkspaceTaskV1[] {
  const input = contextValue(raw, true);
  const row = requireWorkspace(input);
  requireCapability(input, "read_section", raw);
  const submissions = listWorkspaceRows("agent_workspace_submissions", row).map(submissionFromRow);
  return listWorkspaceRows("agent_workspace_tasks", row)
    .map(taskFromRow)
    .filter((task) => task.required && !taskCompletionAccepted(task, submissions));
}
function planWorkspaceCompletion(
  row: WorkspaceRow,
  tasks: readonly WorkspaceTaskV1[],
  submissions: readonly WorkspaceSubmissionV1[],
): WorkspaceCompletionGatesV1 {
  const open = tasks.filter((task) => task.required && !taskCompletionAccepted(task, submissions));
  const pending = submissions.filter((submission) => submission.state === "proposed");
  return Object.freeze({
    workspaceRevision: row.revision,
    accepted: row.state !== "expired" && open.length === 0 && pending.length === 0,
    requiredTaskCount: tasks.filter((task) => task.required).length,
    openRequiredTaskIds: Object.freeze(open.map((task) => task.id)),
    pendingSubmissionCount: pending.length,
  });
}

export function getWorkspaceCompletionGatesV1(raw: unknown): WorkspaceCompletionGatesV1 {
  const input = contextValue(raw, true);
  const row = requireWorkspace(input);
  const database = getDb();
  let gates: WorkspaceCompletionGatesV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace changed while reading completion gates");
    gates = planWorkspaceCompletion(
      current,
      listWorkspaceRows("agent_workspace_tasks", current).map(taskFromRow),
      listWorkspaceRows("agent_workspace_submissions", current).map(submissionFromRow),
    );
  })();
  if (!gates) fail("stale_revision", "completion gate snapshot did not complete");
  return gates;
}

export function previewWorkspaceForCompletionV1(raw: unknown): WorkspaceCompletionPreviewV1 {
  const input = contextValue(raw, true);
  const row = requireWorkspace(input);
  const database = getDb();
  let result: WorkspaceCompletionPreviewV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace changed before completion preview");
    const gates = planWorkspaceCompletion(
      current,
      listWorkspaceRows("agent_workspace_tasks", current).map(taskFromRow),
      listWorkspaceRows("agent_workspace_submissions", current).map(submissionFromRow),
    );
    result = Object.freeze({
      accepted: gates.accepted,
      workspaceRevision: gates.accepted ? current.revision + 1 : current.revision,
    });
  })();
  if (!result) fail("stale_revision", "completion preview transaction did not complete");
  return result;
}

export function freezeWorkspaceForCompletionV1(
  raw: unknown,
  preparedAcceptance?: WorkspaceCompletionPreparedAcceptanceV1,
): WorkspaceCompletionPreviewV1 {
  const input = contextValue(raw, true);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root freeze workspaces");
  const database = getDb();
  let result: WorkspaceCompletionPreviewV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace changed before completion freeze");
    const gates = planWorkspaceCompletion(
      current,
      listWorkspaceRows("agent_workspace_tasks", current).map(taskFromRow),
      listWorkspaceRows("agent_workspace_submissions", current).map(submissionFromRow),
    );
    const candidate = Object.freeze({
      accepted: gates.accepted,
      workspaceRevision: gates.accepted ? current.revision + 1 : current.revision,
    });
    if (preparedAcceptance) {
      try {
        if (preparedAcceptance.prepare(candidate) !== true) {
          fail("completion_preparation_failed", "Completion handoff was not acknowledged");
        }
      } catch (error) {
        if (error instanceof TurnWorkspaceError) throw error;
        fail("completion_preparation_failed", "Completion handoff preparation failed");
      }
    }
    if (!candidate.accepted) {
      result = candidate;
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (updateRow(database, "agent_turn_workspaces", {
      state: "frozen",
      frozen_at: now,
      revision: candidate.workspaceRevision,
      updated_at: now,
    }, {
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      execution_id: current.executionId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: current.revision,
    }) !== 1) fail("stale_revision", "workspace changed during completion freeze");
    result = candidate;
  })();
  if (!result) fail("stale_revision", "completion freeze transaction did not complete");
  return result;
}
function cognitionTaskState(transition: CognitionTaskTransition): WorkspaceTaskStateV1 {
  if (transition === "blocked") return "blocked";
  if (transition === "pending" || transition === "active") return "active";
  fail("invalid_state", "cognition progress cannot submit a task; submit a child result instead");
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface CognitionMaterializationPlanV1 {
  readonly templates: readonly TaskTemplateV1[];
  readonly ids: readonly string[];
  readonly taskCount: number;
  readonly byteCount: number;
}

function planCognitionTemplates(
  row: WorkspaceRow,
  templates: readonly TaskTemplateV1[],
  rows: readonly Record<string, unknown>[],
): CognitionMaterializationPlanV1 {
  const usage = currentWorkspaceUsage(getDb(), row);
  const existing = new Map(rows.map((candidate) => [rowString(candidate, ["task_id"]), candidate] as const));
  const inserted: TaskTemplateV1[] = [];
  let bytesAdded = 0;
  for (const template of templates) {
    const taskId = idValue(template.id, "cognition.taskId");
    const title = template.label ?? taskId;
    const objective = template.description ?? title;
    const previous = existing.get(taskId);
    if (previous) {
      const previousTitle = rowString(previous, ["title"]);
      const previousDescription = rowString(previous, ["description"]);
      const previousDependencies = jsonArray(previous.dependencies_json);
      if (
        rowNumber(previous, ["required"]) !== (template.required ? 1 : 0)
        || previousTitle !== title
        || previousDescription !== objective
        || !sameIds(previousDependencies, template.dependencies ?? [])
      ) {
        fail("duplicate_id", `cognition task ${taskId} conflicts with an existing workspace task`);
      }
      continue;
    }
    const byteCount = utf8ByteLength(title) + utf8ByteLength(objective) + utf8ByteLength(JSON.stringify(template.dependencies ?? []));
    if (usage.taskCount + inserted.length + 1 > row.quota.maxTasks) fail("quota_exceeded", "cognition task quota exceeded");
    if (usage.byteCount + bytesAdded + byteCount > row.quota.maxBytes) fail("quota_exceeded", "cognition task byte quota exceeded");
    inserted.push(template);
    existing.set(taskId, { task_id: taskId, required: template.required ? 1 : 0, title, description: objective, dependencies_json: JSON.stringify(template.dependencies ?? []) });
    bytesAdded += byteCount;
  }
  return Object.freeze({
    templates: Object.freeze([...inserted]),
    ids: Object.freeze(inserted.map((template) => idValue(template.id, "cognition.taskId"))),
    taskCount: inserted.length,
    byteCount: bytesAdded,
  });
}

function materializeCognitionTemplates(
  database: Database,
  row: WorkspaceRow,
  templates: readonly TaskTemplateV1[],
  now: number,
  planned?: CognitionMaterializationPlanV1,
): CognitionMaterializationPlanV1 {
  const plan = planned ?? planCognitionTemplates(
    row,
    templates,
    listWorkspaceRows("agent_workspace_tasks", row),
  );
  if (!sameIds(plan.ids, planCognitionTemplates(row, templates, listWorkspaceRows("agent_workspace_tasks", row)).ids)) {
    fail("stale_revision", "cognition task materialization plan changed before commit");
  }
  for (const template of plan.templates) {
    const taskId = idValue(template.id, "cognition.taskId");
    const title = template.label ?? taskId;
    const objective = template.description ?? title;
    insertRow(database, "agent_workspace_tasks", {
      task_id: taskId,
      workspace_id: row.workspaceId,
      turn_id: row.turnId,
      user_id: row.userId,
      chat_id: row.chatId,
      title,
      description: objective,
      state: "active",
      required: template.required ? 1 : 0,
      dependencies_json: JSON.stringify(template.dependencies ?? []),
      assigned_frame_id: null,
      progress: 0,
      summary: null,
      byte_count: utf8ByteLength(title) + utf8ByteLength(objective) + utf8ByteLength(JSON.stringify(template.dependencies ?? [])),
      revision: 0,
      cas_owner: null,
      cas_expires_at: null,
      retention: row.retention,
      expires_at: row.expiresAt,
      created_at: now,
      updated_at: now,
    }, ["task_id", "workspace_id", "turn_id", "user_id", "chat_id", "title", "description", "retention", "expires_at"]);
  }
  return plan;
}

function cognitionUpdateValues(
  row: WorkspaceRow,
  update: CognitionWorkspaceActivationUpdateV1,
  now: number,
): { readonly state: CognitionActivationStateV1; readonly materializedTaskIds: readonly string[]; readonly revision: number } {
  if (update.state.workspaceRevision !== row.revision + 1) fail("stale_revision", "cognition activation revision does not match workspace CAS");
  if (update.activation.state.workspaceRevision !== row.revision) fail("stale_revision", "cognition activation observed a stale workspace revision");
  const database = getDb();
  const usage = currentWorkspaceUsage(database, row);
  const materialized = materializeCognitionTemplates(database, row, update.materializeTemplates, now);
  const nextRevision = row.revision + 1;
  const changed = updateRow(database, "agent_turn_workspaces", {
    task_count: usage.taskCount + materialized.taskCount,
    record_count: usage.recordCount,
    submission_count: usage.submissionCount,
    artifact_count: usage.artifactCount,
    byte_count: usage.byteCount + materialized.byteCount,
    revision: nextRevision,
    updated_at: now,
  }, {
    workspace_id: row.workspaceId,
    turn_id: row.turnId,
    execution_id: row.executionId,
    user_id: row.userId,
    chat_id: row.chatId,
    revision: row.revision,
  });
  if (changed !== 1) fail("stale_revision", "workspace revision changed during cognition activation");
  return Object.freeze({ state: update.state, materializedTaskIds: materialized.ids, revision: nextRevision });
}

function requireCognitionWorkspaceUpdate(
  row: WorkspaceRow,
  update: CognitionWorkspaceActivationUpdateV1,
): void {
  if (update.taskId.length === 0 || update.transition.length === 0) fail("invalid_input", "cognition transition is incomplete");
  if (update.activation.state.workspaceRevision !== row.revision) fail("stale_revision", "cognition activation observed a stale workspace revision");
}

function cognitionActivationUpdate(
  row: WorkspaceRow,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceActivationUpdateV1 {
  if (factory.state.workspaceRevision !== row.revision) fail("stale_revision", "cognition factory state is stale for workspace CAS");
  return factory.update(factory.state);
}

/**
 * Persist a phase-entry cognition activation under the workspace owner/revision
 * fence. The factory is pure; no runtime state is published until this
 * transaction commits.
 */
export function activateWorkspaceCognitionAtPhase(
  raw: unknown,
  factory: CognitionWorkspacePhaseFactoryV1,
): CognitionWorkspacePhaseResultV1 {
  const input = contextValue(raw, true);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root activate cognition phases");
  if (factory.state.workspaceRevision !== row.revision) fail("stale_revision", "cognition phase state is stale for workspace CAS");
  const database = getDb();
  let result: CognitionWorkspacePhaseResultV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace revision changed during cognition phase activation");
    const update = factory.update(factory.state);
    const now = Math.floor(Date.now() / 1000);
    const usage = currentWorkspaceUsage(database, current);
    const materialized = materializeCognitionTemplates(database, current, update.materializeTemplates, now);
    const nextRevision = current.revision + 1;
    const changed = updateRow(database, "agent_turn_workspaces", {
      task_count: usage.taskCount + materialized.taskCount,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + materialized.byteCount,
      revision: nextRevision,
      updated_at: now,
    }, {
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      execution_id: current.executionId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: current.revision,
    });
    if (changed !== 1) fail("stale_revision", "workspace revision changed during cognition phase activation");
    result = Object.freeze({
      workspaceRevision: nextRevision,
      state: update.state,
      activation: update.activation,
      materializedTaskIds: materialized.ids,
    });
  })();
  if (!result) fail("stale_revision", "cognition phase activation transaction did not commit");
  return result;
}

function cognitionCompletionUpdate(
  row: WorkspaceRow,
  factory: CognitionWorkspaceCompletionFactoryV1,
): CognitionWorkspaceCompletionUpdateV1 {
  if (factory.state.workspaceRevision !== row.revision) fail("stale_revision", "cognition completion factory state is stale for workspace CAS");
  return factory.update(factory.state);
}

export interface CognitionWorkspaceCompletionPreviewV1 {
  readonly candidate: CognitionWorkspaceCompletionResultV1;
  readonly materialization: CognitionMaterializationPlanV1;
}

function planCognitionCompletion(
  row: WorkspaceRow,
  update: CognitionWorkspaceCompletionUpdateV1,
  tasks: readonly Record<string, unknown>[],
  submissions: readonly Record<string, unknown>[],
): CognitionWorkspaceCompletionPreviewV1 {
  const materialization = planCognitionTemplates(row, update.materializeTemplates, tasks);
  const taskRows = [
    ...tasks,
    ...materialization.templates.map((template) => ({
      task_id: idValue(template.id, "cognition.taskId"),
      required: template.required ? 1 : 0,
      state: "active",
    })),
  ];
  const openRequiredTaskIds = taskRows
    .filter((task) => rowNumber(task, ["required"]) === 1 && !taskRowCompletionAccepted(task, submissions))
    .map((task) => rowString(task, ["task_id"]))
    .sort();
  const pendingSubmissions = submissions.filter((submission) => rowString(submission, ["state"]) === "proposed");
  const blockingRequiredTaskIds = Object.freeze([...new Set([...openRequiredTaskIds, ...update.blockingRequiredTaskIds])]);
  const accepted = update.accepted && blockingRequiredTaskIds.length === 0 && pendingSubmissions.length === 0;
  const nextRevision = row.revision + 1;
  return Object.freeze({
    materialization,
    candidate: Object.freeze({
      workspaceRevision: nextRevision,
      state: Object.freeze({ ...update.state, workspaceRevision: nextRevision }),
      activation: update.activation,
      accepted,
      blockingRequiredTaskIds,
      blockingContextRequirements: update.blockingContextRequirements,
      materializedTaskIds: materialization.ids,
    }),
  });
}

/**
 * Read-only completion preview. It uses the same materialization/gate planner
 * as the committing freeze path and performs no workspace mutation.
 */
export function previewWorkspaceCompletionWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceCompletionFactoryV1,
): CognitionWorkspaceCompletionPreviewV1 {
  const input = contextValue(raw, true);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root preview workspaces");
  const database = getDb();
  let preview: CognitionWorkspaceCompletionPreviewV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== input.expectedRevision) fail("stale_revision", "workspace revision changed before cognition completion preview");
    const update = cognitionCompletionUpdate(current, factory);
    preview = planCognitionCompletion(
      current,
      update,
      listWorkspaceRows("agent_workspace_tasks", current),
      listWorkspaceRows("agent_workspace_submissions", current),
    );
  })();
  if (!preview) fail("stale_revision", "cognition completion preview did not complete");
  return preview;
}

export interface CognitionWorkspacePreparedAcceptanceV1 {
  /**
   * Build the private handoff from the exact transaction candidate. This runs
   * synchronously after cognition task materialization and before updateRow.
   */
  readonly prepare: (
    candidate: CognitionWorkspaceCompletionResultV1,
  ) => {
    readonly candidate: CognitionWorkspaceCompletionResultV1;
    readonly bundle: unknown;
  };
}

function freezePreparedValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) value.forEach((entry) => freezePreparedValue(entry));
    else Object.values(value as Record<string, unknown>).forEach((entry) => freezePreparedValue(entry));
    Object.freeze(value);
  }
  return value;
}

function clonePreparedValue<T>(value: T): T {
  try {
    return freezePreparedValue(structuredClone(value));
  } catch {
    fail("completion_preparation_failed", "Completion handoff bundle is not cloneable");
  }
}


export function createWorkspaceTaskWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceCommitResultV1 {
  const input = validateCreateWorkspaceTaskInput(raw);
  if (input.required && input.actor !== "host") fail("forbidden", "root-created tasks must be optional");
  const row = requireWritable(input);
  requireCapability(input, "create_task", raw);
  if (input.actor === "child") fail("forbidden", "children cannot create tasks");
  const taskId = input.taskId ?? crypto.randomUUID();
  idValue(taskId, "taskId");
  if (listWorkspaceRows("agent_workspace_tasks", row).some((candidate) => rowString(candidate, ["task_id"]) === taskId)) fail("duplicate_id", "task identifier is already in use");
  assertAcyclic(row, taskId, input.dependencyIds);
  const now = Math.floor(Date.now() / 1000);
  const policy = input.retention === undefined ? { retention: row.retention, expiresAt: row.expiresAt } : retentionValue(input.retention, input.ttlSeconds, now);
  const objective = input.objective ?? input.title;
  const byteCount = utf8ByteLength(input.title) + utf8ByteLength(objective) + utf8ByteLength(JSON.stringify(input.dependencyIds));
  const database = getDb();
  let result: CognitionWorkspaceCommitResultV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace revision changed before cognition task creation");
    const currentTasks = listWorkspaceRows("agent_workspace_tasks", current);
    if (currentTasks.some((candidate) => rowString(candidate, ["task_id"]) === taskId)) fail("duplicate_id", "task identifier is already in use");
    const usage = currentWorkspaceUsage(database, current);
    if (usage.taskCount >= current.quota.maxTasks) {
      fail("quota_exceeded", "task quota exceeded", { limit: current.quota.maxTasks, observed: usage.taskCount + 1 });
    }
    if (usage.byteCount + byteCount > current.quota.maxBytes) fail("quota_exceeded", "workspace byte quota exceeded");
    insertRow(database, "agent_workspace_tasks", {
      task_id: taskId,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      title: input.title,
      description: objective,
      state: "active",
      required: input.required ? 1 : 0,
      dependencies_json: JSON.stringify(input.dependencyIds),
      assigned_frame_id: input.assignedFrameId,
      progress: 0,
      summary: null,
      byte_count: byteCount,
      revision: 0,
      cas_owner: null,
      cas_expires_at: null,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
      updated_at: now,
    }, ["task_id", "workspace_id", "turn_id", "user_id", "chat_id", "title", "description", "retention", "expires_at"]);
    const update = cognitionActivationUpdate(current, factory);
    const committed = cognitionUpdateValues(current, update, now);
    result = Object.freeze({
      workspaceRevision: committed.revision,
      state: committed.state,
      activation: update.activation,
      materializedTaskIds: committed.materializedTaskIds,
      taskId: update.taskId,
      transition: update.transition,
      ...(update.operationKey ? { operationKey: update.operationKey } : {}),
    });
  })();
  if (!result) fail("stale_revision", "cognition task creation transaction did not commit");
  return result;
}

export function updateWorkspaceTaskProgressWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceCommitResultV1 {
  const input = validateUpdateWorkspaceTaskProgressInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "update_assigned_progress", raw);
  const task = taskById(row, input.taskId);
  assertAssignedChild(input, task);
  const database = getDb();
  let result: CognitionWorkspaceCommitResultV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace revision changed before cognition transition");
    const now = Math.floor(Date.now() / 1000);
    const update = cognitionActivationUpdate(current, factory);
    if (update.taskId !== task.id) fail("invalid_input", "cognition transition task does not match persisted task");
    requireCognitionWorkspaceUpdate(current, update);
    const nextTaskState = cognitionTaskState(update.transition);
    if (updateRow(database, "agent_workspace_tasks", {
      state: nextTaskState,
      progress: input.progress ?? task.progress,
      revision: task.revision + 1,
      updated_at: now,
    }, {
      task_id: task.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: task.revision,
    }) !== 1) fail("stale_revision", "task revision changed before cognition transition");
    const committed = cognitionUpdateValues(current, update, now);
    result = Object.freeze({
      workspaceRevision: committed.revision,
      state: committed.state,
      activation: update.activation,
      materializedTaskIds: committed.materializedTaskIds,
      taskId: update.taskId,
      transition: update.transition,
      ...(update.operationKey ? { operationKey: update.operationKey } : {}),
    });
  })();
  if (!result) fail("stale_revision", "cognition workspace transaction did not commit");
  return result;
}

export function submitWorkspaceChildResultWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceCommitResultV1 {
  const input = validateSubmitWorkspaceChildResultInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "submit_child_result", raw);
  const task = taskById(row, input.taskId);
  assertAssignedChild(input, task);
  const submissionBytes = input.byteCount + utf8ByteLength(input.summary);
  const database = getDb();
  let result: CognitionWorkspaceCommitResultV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace revision changed before cognition submission");
    const usage = currentWorkspaceUsage(database, current);
    if (usage.submissionCount >= current.quota.maxSubmissions || usage.byteCount + submissionBytes > current.quota.maxBytes) {
      fail("quota_exceeded", "submission quota exceeded");
    }
    if (task.state === "submitted" && listWorkspaceRows("agent_workspace_submissions", current).some((candidate) => rowString(candidate, ["task_id"]) === task.id)) fail("submission_rejected", "task already has a submitted result");
    const now = Math.floor(Date.now() / 1000);
    const policy = input.retention === undefined ? { retention: current.retention, expiresAt: current.expiresAt } : retentionValue(input.retention, input.ttlSeconds, now);
    insertRow(database, "agent_workspace_submissions", {
      submission_id: crypto.randomUUID(),
      task_id: task.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      child_frame_id: input.frameId,
      state: "proposed",
      summary: input.summary,
      result_digest: input.resultDigest,
      byte_count: submissionBytes,
      revision: 0,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
      updated_at: now,
    }, ["submission_id", "task_id", "workspace_id", "turn_id", "user_id", "chat_id", "child_frame_id", "state", "summary", "result_digest", "byte_count", "retention", "expires_at"]);
    if (updateRow(database, "agent_workspace_tasks", { state: "submitted", progress: 1, revision: task.revision + 1, updated_at: now }, { task_id: task.id, workspace_id: current.workspaceId, turn_id: current.turnId, user_id: current.userId, chat_id: current.chatId, revision: task.revision }) !== 1) fail("stale_revision", "task revision changed before cognition submission");
    const update = cognitionActivationUpdate(current, factory);
    if (update.taskId !== task.id) fail("invalid_input", "cognition submission task does not match persisted task");
    requireCognitionWorkspaceUpdate(current, update);
    const committed = cognitionUpdateValues(current, update, now);
    result = Object.freeze({ workspaceRevision: committed.revision, state: committed.state, activation: update.activation, materializedTaskIds: committed.materializedTaskIds, taskId: update.taskId, transition: update.transition, ...(update.operationKey ? { operationKey: update.operationKey } : {}) });
  })();
  if (!result) fail("stale_revision", "cognition submission transaction did not commit");
  return result;
}

export function acceptWorkspaceSubmissionWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceCommitResultV1 {
  const input = validateAcceptWorkspaceSubmissionInput(raw);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root accept submissions");
  const submission = submissionById(row, input.submissionId);
  const database = getDb();
  let result: CognitionWorkspaceCommitResultV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace revision changed before cognition acceptance");
    const now = Math.floor(Date.now() / 1000);
    if (submission.state !== "accepted" && updateRow(database, "agent_workspace_submissions", { state: "accepted", revision: submission.revision + 1, updated_at: now }, { submission_id: submission.id, workspace_id: current.workspaceId, turn_id: current.turnId, user_id: current.userId, chat_id: current.chatId, revision: submission.revision }) !== 1) fail("stale_revision", "submission revision changed before cognition acceptance");
    const task = taskById(current, submission.taskId);
    if (submission.state !== "accepted" && updateRow(database, "agent_workspace_tasks", { summary: submission.summary, revision: task.revision + 1, updated_at: now }, { task_id: task.id, workspace_id: current.workspaceId, turn_id: current.turnId, user_id: current.userId, chat_id: current.chatId, revision: task.revision }) !== 1) fail("stale_revision", "task revision changed before cognition acceptance");
    const update = cognitionActivationUpdate(current, factory);
    if (update.taskId !== submission.taskId) fail("invalid_input", "cognition acceptance task does not match persisted submission task");
    requireCognitionWorkspaceUpdate(current, update);
    const committed = cognitionUpdateValues(current, update, now);
    result = Object.freeze({ workspaceRevision: committed.revision, state: committed.state, activation: update.activation, materializedTaskIds: committed.materializedTaskIds, taskId: update.taskId, transition: update.transition, ...(update.operationKey ? { operationKey: update.operationKey } : {}) });
  })();
  if (!result) fail("stale_revision", "cognition acceptance transaction did not commit");
  return result;
}

function completionCandidateMatches(
  expected: CognitionWorkspaceCompletionResultV1,
  actual: CognitionWorkspaceCompletionResultV1,
): boolean {
  try {
    return expected.workspaceRevision === actual.workspaceRevision
      && expected.accepted === actual.accepted
      && JSON.stringify(expected.state) === JSON.stringify(actual.state)
      && JSON.stringify(expected.activation) === JSON.stringify(actual.activation)
      && JSON.stringify(expected.blockingRequiredTaskIds) === JSON.stringify(actual.blockingRequiredTaskIds)
      && JSON.stringify(expected.blockingContextRequirements) === JSON.stringify(actual.blockingContextRequirements)
      && JSON.stringify(expected.materializedTaskIds) === JSON.stringify(actual.materializedTaskIds);
  } catch {
    return false;
  }
}


export function freezeWorkspaceForCompletionWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceCompletionFactoryV1,
  preparedAcceptance?: CognitionWorkspacePreparedAcceptanceV1,
): CognitionWorkspaceCompletionResultV1 {
  const input = contextValue(raw, true);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root freeze workspaces");
  const database = getDb();
  let result: CognitionWorkspaceCompletionResultV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace revision changed before cognition completion");
    const update = cognitionCompletionUpdate(current, factory);
    if (update.state.workspaceRevision !== current.revision + 1) fail("stale_revision", "cognition completion revision does not match workspace CAS");
    const preview = planCognitionCompletion(
      current,
      update,
      listWorkspaceRows("agent_workspace_tasks", current),
      listWorkspaceRows("agent_workspace_submissions", current),
    );
    const candidate = preview.candidate;
    const now = Math.floor(Date.now() / 1000);
    const usage = currentWorkspaceUsage(database, current);
    const materialized = materializeCognitionTemplates(
      database,
      current,
      update.materializeTemplates,
      now,
      preview.materialization,
    );
    if (!sameIds(materialized.ids, candidate.materializedTaskIds)) fail("stale_revision", "cognition completion materialization changed before commit");
    let acknowledgedBundle: unknown;
    if (candidate.accepted && preparedAcceptance) {
      try {
        const prepared = preparedAcceptance.prepare(candidate);
        if (!prepared || !completionCandidateMatches(prepared.candidate, candidate)) {
          fail("completion_preparation_failed", "Prepared completion candidate no longer matches the workspace CAS");
        }
        acknowledgedBundle = clonePreparedValue(prepared.bundle);
      } catch (error) {
        if (error instanceof TurnWorkspaceError) throw error;
        fail("completion_preparation_failed", "Completion handoff preparation failed");
      }
    }
    if (updateRow(database, "agent_turn_workspaces", {
      state: candidate.accepted ? "frozen" : "active",
      frozen_at: candidate.accepted ? now : null,
      task_count: usage.taskCount + materialized.taskCount,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + materialized.byteCount,
      revision: candidate.workspaceRevision,
      updated_at: now,
    }, {
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      execution_id: current.executionId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: current.revision,
    }) !== 1) fail("stale_revision", "workspace changed during cognition completion");
    result = Object.freeze({
      ...candidate,
      ...(candidate.accepted && preparedAcceptance ? {
        preparedAcceptance: Object.freeze({
          candidate,
          bundle: acknowledgedBundle,
        }),
      } : {}),
    });
  })();
  if (!result) fail("stale_revision", "cognition completion transaction did not commit");
  return result;
}
