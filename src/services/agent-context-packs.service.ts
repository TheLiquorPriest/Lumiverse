import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { getDb } from "../db/connection";
import { withUserDataMutationSync } from "./user-data/snapshot";
import {
  AGENT_CONTEXT_PACK_MAX_DESCRIPTION_BYTES,
  AGENT_CONTEXT_PACK_MAX_NAME_BYTES,
  AGENT_CONTEXT_PACK_MAX_PROVENANCE_BYTES,
  type AgentContextPack,
  type AgentContextPackRevision,
  type ContextPackAclEntry,
  type ContextPackAttachment,
  type ContextPackAttachmentInput,
  type ContextPackEntryV1,
  type ContextPackListOptions,
  type ContextPackPermission,
  type ContextPackProvenanceV1,
  type ContextPackState,
  type ContextPackTargetScope,
  type ContextPackVisibility,
  type CreateContextPackInput,
  type CreateContextPackRevisionInput,
  type PortableContextPackImportResult,
  type PortableContextPackSnapshotV1,
  ContextPackAclRevisionConflictError,
  ContextPackRevisionConflictError,
  ContextPackValidationError,
  createPortableContextPackSnapshotId,
  estimateContextPackTokens,
  hashContextPackContent,
  normalizeContextPackContent,
  serializeContextPackContent,
  utf8Bytes,
} from "../types/agent-context-packs";

const MAX_LIST_LIMIT = 100;
const MAX_LIST_OFFSET = 100_000;
const MAX_POSITION = 1024;
const CONTEXT_PACK_METADATA_MAX_RETRIES = 3;
const ATTACHMENT_TABLE: Record<ContextPackTargetScope, string> = {
  preset: "agent_preset_context_pack_attachments",
  chat: "agent_chat_context_pack_attachments",
  world_book: "agent_world_book_context_pack_attachments",
};
const TARGET_COLUMN: Record<ContextPackTargetScope, string> = {
  preset: "preset_id",
  chat: "chat_id",
  world_book: "world_book_id",
};
const VALID_VISIBILITIES = new Set<ContextPackVisibility>(["private", "account", "restricted"]);
const VALID_STATES = new Set<ContextPackState>(["active", "disabled", "review_required", "repair_required"]);
const VALID_PERMISSIONS = new Set<ContextPackPermission>(["read", "use", "edit"]);

interface ContextPackRow {
  user_id: string;
  id: string;
  name: string;
  description: string;
  visibility: ContextPackVisibility;
  state: ContextPackState;
  latest_revision: number;
  provenance_json: string;
  created_at: number;
  updated_at: number;
}

interface ContextPackRevisionRow {
  user_id: string;
  pack_id: string;
  revision: number;
  content_json: string;
  content_digest: string;
  token_count: number;
  byte_count: number;
  state: ContextPackState;
  provenance_json: string;
  created_at: number;
  created_by: string;
}

interface ContextPackAttachmentRow {
  user_id: string;
  attachment_id: string;
  target_id: string;
  pack_id: string;
  revision: number;
  position: number;
  required: number;
  state: ContextPackState;
  provenance_json: string;
  created_at: number;
  updated_at: number;
}

export interface ContextPackCreateResult {
  readonly pack: AgentContextPack;
  readonly revision: AgentContextPackRevision;
}

export interface ContextPackDuplicateInput {
  readonly name?: string;
  readonly description?: string;
  readonly preserveAttachments?: boolean;
  readonly selectedAttachments?: readonly {
    scope: ContextPackTargetScope;
    targetId: string;
    revision?: number;
  }[];
}

export interface ContextPackDuplicateResult {
  readonly pack: AgentContextPack;
  readonly revisions: readonly AgentContextPackRevision[];
  readonly attachments: readonly ContextPackAttachment[];
}

export interface ContextPackReviewInput {
  readonly state: Extract<ContextPackState, "active" | "disabled">;
  readonly acknowledge: boolean;
  readonly expectedRevision?: number;
}

export interface ContextPackUpdateInput {
  readonly name?: string;
  readonly description?: string;
  readonly visibility?: ContextPackVisibility;
  readonly state?: ContextPackState;
  readonly expectedRevision?: number;
}

export interface ContextPackCandidate {
  readonly attachment: ContextPackAttachment;
  readonly pack: AgentContextPack;
  readonly revision: AgentContextPackRevision;
}

export interface ContextPackAccessMetadataInput {
  readonly ownerId: string;
  readonly source: ContextPackTargetScope;
  readonly targetId: string;
  readonly attachmentId: string;
  readonly packId: string;
  readonly revision: number;
}

/** Metadata-only exact candidate gate for WORK/COMMIT rechecks.
 * It intentionally does not parse content_json or enumerate sibling candidates.
 */
export interface ContextPackAccessMetadata {
  readonly ownerId: string;
  readonly packId: string;
  readonly revision: number;
  readonly digest: string;
  readonly byteCount: number;
  readonly tokenCount: number;
  readonly aclRevision: number;
  readonly attachmentRevision: string | null;
}

export interface ContextPackCandidateScope {
  readonly scope: ContextPackTargetScope;
  readonly targetId: string;
}

export interface ContextPackCandidateMetadata {
  readonly kind: "candidate";
  readonly ownerId: string;
  readonly attachmentId: string;
  readonly source: ContextPackTargetScope;
  readonly targetId: string;
  readonly packId: string;
  readonly revision: number;
  readonly position: number;
  readonly required: boolean;
  readonly attachmentState: ContextPackState;
  readonly attachmentUpdatedAt: number;
  readonly packName: string;
  readonly packDescription: string;
  readonly packVisibility: ContextPackVisibility;
  readonly packState: ContextPackState;
  readonly latestRevision: number;
  readonly digest: string;
  readonly byteCount: number;
  readonly tokenCount: number;
  readonly revisionState: ContextPackState;
  readonly aclRevision: number;
  readonly attachmentRevision: string;
}

export interface ContextPackCandidateOmission {
  readonly kind: "omission";
  readonly ownerId: string;
  readonly attachmentId: string;
  readonly source: ContextPackTargetScope;
  readonly targetId: string;
  readonly required: true;
  readonly reason: "missing" | "disabled" | "review_required" | "acl_denied" | "revision_missing";
}

export type ContextPackCandidateMetadataResult = ContextPackCandidateMetadata | ContextPackCandidateOmission;
export interface ContextPackAccountCandidateSelection {
  readonly packId: string;
  readonly revision: number;
  readonly digest: string;
  readonly required?: boolean;
  readonly order?: number;
}

export interface ContextPackAccountCandidateMetadata {
  readonly kind: "candidate";
  readonly ownerId: string;
  readonly attachmentId: null;
  readonly source: "account";
  readonly targetId: null;
  readonly packId: string;
  readonly revision: number;
  readonly position: number;
  readonly required: boolean;
  readonly attachmentState: "active";
  readonly attachmentUpdatedAt: number;
  readonly packName: string;
  readonly packDescription: string;
  readonly packVisibility: ContextPackVisibility;
  readonly packState: ContextPackState;
  readonly latestRevision: number;
  readonly digest: string;
  readonly byteCount: number;
  readonly tokenCount: number;
  readonly revisionState: ContextPackState;
  readonly aclRevision: number;
  readonly attachmentRevision: null;
}

export interface ContextPackAccountCandidateOmission {
  readonly kind: "omission";
  readonly ownerId: string;
  readonly attachmentId: null;
  readonly source: "account";
  readonly targetId: null;
  readonly required: true;
  readonly reason: "missing" | "disabled" | "review_required" | "revision_missing";
  readonly packId: string;
}

export type ContextPackAccountCandidateMetadataResult =
  | ContextPackAccountCandidateMetadata
  | ContextPackAccountCandidateOmission;

export interface ContextPackAccountCandidateMetadataSnapshot {
  readonly contextAclRevision: number;
  readonly items: readonly ContextPackAccountCandidateMetadataResult[];
}

export interface ContextPackSelectableRevision {
  readonly ownerId: string;
  readonly source: "owned" | "shared";
  readonly packId: string;
  readonly packName: string;
  readonly packDescription: string;
  readonly revision: number;
  readonly digest: string;
  readonly byteCount: number;
  readonly tokenCount: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || userId.length === 0 || utf8Bytes(userId) > 256) {
    throw new ContextPackValidationError("userId", "must be a non-empty bounded string");
  }
}

function parseJson<T>(raw: string, path: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ContextPackValidationError(path, "contains malformed JSON");
  }
}

function parseProvenance(raw: string, path: string): ContextPackProvenanceV1 {
  const parsed = parseJson<unknown>(raw, path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ContextPackValidationError(path, "must be an object");
  }
  const value = parsed as Record<string, unknown>;
  const kind = value.kind;
  if (kind !== "local" && kind !== "portable_import" && kind !== "archive_restore" && kind !== "same_account_duplicate") {
    throw new ContextPackValidationError(`${path}.kind`, "unsupported provenance kind");
  }
  const allowed = new Set(["kind", "sourceDigest", "sourcePackId", "archiveId"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ContextPackValidationError(path, "contains unknown provenance fields");
  }
  for (const key of ["sourceDigest", "sourcePackId", "archiveId"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0 || utf8Bytes(value[key]) > 4096)) {
      throw new ContextPackValidationError(`${path}.${key}`, "must be a bounded non-empty string");
    }
  }
  return {
    kind,
    ...(typeof value.sourceDigest === "string" ? { sourceDigest: value.sourceDigest } : {}),
    ...(typeof value.sourcePackId === "string" ? { sourcePackId: value.sourcePackId } : {}),
    ...(typeof value.archiveId === "string" ? { archiveId: value.archiveId } : {}),
  };
}

function serializeProvenance(value: ContextPackProvenanceV1 | undefined): string {
  const provenance = value ?? { kind: "local" as const };
  const json = JSON.stringify(provenance);
  if (utf8Bytes(json) > AGENT_CONTEXT_PACK_MAX_PROVENANCE_BYTES) {
    throw new ContextPackValidationError("provenance", "exceeds the bounded provenance limit");
  }
  parseProvenance(json, "provenance");
  return json;
}

function parseVisibility(value: unknown, path = "visibility"): ContextPackVisibility {
  if (typeof value !== "string" || !VALID_VISIBILITIES.has(value as ContextPackVisibility)) {
    throw new ContextPackValidationError(path, "must be private, account, or restricted");
  }
  return value as ContextPackVisibility;
}

function parseState(value: unknown, path = "state"): ContextPackState {
  if (typeof value !== "string" || !VALID_STATES.has(value as ContextPackState)) {
    throw new ContextPackValidationError(path, "contains an unsupported state");
  }
  return value as ContextPackState;
}

function parsePermission(value: unknown, path: string): ContextPackPermission {
  if (typeof value !== "string" || !VALID_PERMISSIONS.has(value as ContextPackPermission)) {
    throw new ContextPackValidationError(path, "must be read, use, or edit");
  }
  return value as ContextPackPermission;
}

function parseName(value: unknown, path = "name"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContextPackValidationError(path, "must be a non-empty string");
  }
  const normalized = value.trim();
  if (utf8Bytes(normalized) > AGENT_CONTEXT_PACK_MAX_NAME_BYTES) {
    throw new ContextPackValidationError(path, `exceeds ${AGENT_CONTEXT_PACK_MAX_NAME_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

function parseDescription(value: unknown, path = "description"): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new ContextPackValidationError(path, "must be a string");
  if (utf8Bytes(value) > AGENT_CONTEXT_PACK_MAX_DESCRIPTION_BYTES) {
    throw new ContextPackValidationError(path, `exceeds ${AGENT_CONTEXT_PACK_MAX_DESCRIPTION_BYTES} UTF-8 bytes`);
  }
  return value;
}

function normalizeInputContent(value: unknown): { content: readonly ContextPackEntryV1[]; serialized: string; digest: string; bytes: number; tokens: number } {
  const content = normalizeContextPackContent(value);
  const serialized = serializeContextPackContent(content);
  const bytes = utf8Bytes(serialized);
  const digest = hashContextPackContent(serialized);
  const tokens = estimateContextPackTokens(serialized);
  return { content, serialized, digest, bytes, tokens };
}

function rowToPack(row: ContextPackRow): AgentContextPack {
  if (!Number.isSafeInteger(row.latest_revision) || row.latest_revision < 0) {
    throw new ContextPackValidationError("latestRevision", "stored revision is outside the safe integer range");
  }
  return {
    userId: row.user_id,
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    state: row.state,
    latestRevision: row.latest_revision,
    contextAclRevision: getContextAclRevision(row.user_id),
    provenance: parseProvenance(row.provenance_json, "provenance"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRevision(row: ContextPackRevisionRow): AgentContextPackRevision {
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new ContextPackValidationError("revision", "stored revision is outside the safe integer range");
  }
  const content = normalizeContextPackContent(parseJson<unknown>(row.content_json, "content"));
  const serialized = serializeContextPackContent(content);
  const expectedTokenCount = estimateContextPackTokens(serialized);
  if (
    hashContextPackContent(serialized) !== row.content_digest
    || utf8Bytes(serialized) !== row.byte_count
    || expectedTokenCount !== row.token_count
  ) {
    throw new ContextPackValidationError("content", "stored revision accounting does not match content");
  }
  return {
    userId: row.user_id,
    packId: row.pack_id,
    revision: row.revision,
    content,
    contentDigest: row.content_digest,
    tokenCount: row.token_count,
    byteCount: row.byte_count,
    state: row.state,
    provenance: parseProvenance(row.provenance_json, "provenance"),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function rowToAttachment(scope: ContextPackTargetScope, row: ContextPackAttachmentRow): ContextPackAttachment {
  return {
    userId: row.user_id,
    attachmentId: row.attachment_id,
    scope,
    targetId: row.target_id,
    packId: row.pack_id,
    revision: row.revision,
    position: row.position,
    required: row.required === 1,
    state: row.state,
    provenance: parseProvenance(row.provenance_json, "provenance"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asSqlBinding(value: unknown): SQLQueryBindings {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  ) return value;
  throw new TypeError("Unsupported context-pack SQLite binding");
}

function runSql(sql: string, ...values: readonly unknown[]): { changes: number } {
  return getDb().query(sql).run(...values.map(asSqlBinding));
}

function ensureAccountState(userId: string): void {
  runSql(`INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
   VALUES (?, 0, ?)
   ON CONFLICT(user_id) DO NOTHING`,
  userId,
  nowSeconds(),);
}

function getContextAclRevision(userId: string, db: Database = getDb()): number {
  const row = db.query(
    "SELECT context_acl_revision FROM agent_context_account_state WHERE user_id = ?",
  ).get(userId) as { context_acl_revision: number } | null;
  return row?.context_acl_revision ?? 0;
}

function parseExpectedRevision(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ContextPackValidationError(path, "must be a non-negative integer");
  }
  return value;
}

function getOwnedPackRow(userId: string, packId: string): ContextPackRow | null {
  return getDb().query(
    "SELECT * FROM agent_context_packs WHERE user_id = ? AND id = ?",
  ).get(userId, packId) as ContextPackRow | null;
}
function getPackRevisionRow(userId: string, packId: string, revision: number): ContextPackRevisionRow | null {
  return getDb().query(
    "SELECT * FROM agent_context_pack_revisions WHERE user_id = ? AND pack_id = ? AND revision = ?",
  ).get(userId, packId, revision) as ContextPackRevisionRow | null;
}


function resolveAccessiblePackOwnerId(
  userId: string,
  packId: string,
  permission: Extract<ContextPackPermission, "read" | "use">,
  db: Database = getDb(),
): string | null {
  const row = db.query(
    `SELECT p.user_id, p.visibility, p.state, a.permission
     FROM agent_context_packs p
     LEFT JOIN agent_context_pack_acls a
       ON a.user_id = p.user_id AND a.pack_id = p.id AND a.principal_user_id = ?
     WHERE p.id = ? AND (p.user_id = ? OR a.principal_user_id = ?)
     LIMIT 1`,
  ).get(userId, packId, userId, userId) as {
    user_id: string;
    visibility: ContextPackVisibility;
    state: ContextPackState;
    permission: ContextPackPermission | null;
  } | null;
  if (!row || row.state !== "active") return null;
  if (row.user_id === userId) return row.user_id;
  if (row.visibility === "private" || !row.permission) return null;
  if (permission === "read" || row.permission === "use" || row.permission === "edit") return row.user_id;
  return null;
}

function canAccessPack(
  userId: string,
  packId: string,
  permission: Extract<ContextPackPermission, "read" | "use">,
): boolean {
  return resolveAccessiblePackOwnerId(userId, packId, permission) !== null;
}

function targetExists(userId: string, scope: ContextPackTargetScope, targetId: string): boolean {
  const table = scope === "preset" ? "presets" : scope === "chat" ? "chats" : "world_books";
  const row = getDb().query(`SELECT 1 AS present FROM ${table} WHERE user_id = ? AND id = ?`).get(userId, targetId) as { present: number } | null;
  return row !== null;
}

function assertAttachmentInput(input: ContextPackAttachmentInput): { scope: ContextPackTargetScope; targetId: string; revision: number; position: number; required: 0 | 1; provenance: string; expectedContextAclRevision?: number } {
  if (!input || typeof input !== "object") throw new ContextPackValidationError("attachment", "must be an object");
  const scope = input.scope;
  if (scope !== "preset" && scope !== "chat" && scope !== "world_book") throw new ContextPackValidationError("scope", "must be preset, chat, or world_book");
  if (typeof input.targetId !== "string" || input.targetId.length === 0 || utf8Bytes(input.targetId) > 256) throw new ContextPackValidationError("targetId", "must be a bounded non-empty string");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new ContextPackValidationError("revision", "must be a positive integer");
  const position = input.position ?? 0;
  if (!Number.isSafeInteger(position) || position < 0 || position > MAX_POSITION) throw new ContextPackValidationError("position", "must be a bounded non-negative integer");
  const required = input.required === true ? 1 : 0;
  const expectedContextAclRevision = input.expectedContextAclRevision === undefined
    ? undefined
    : parseExpectedRevision(input.expectedContextAclRevision, "expectedContextAclRevision");
  return { scope, targetId: input.targetId, revision: input.revision, position, required, provenance: serializeProvenance(input.provenance), expectedContextAclRevision };
}

function withMutation<T>(userId: string, callback: () => T): T {
  assertUserId(userId);
  return withUserDataMutationSync(userId, () => {
    const db = getDb();
    const transaction = db.transaction(callback);
    return transaction();
  });
}

export function getContextAccountRevision(userId: string, db: Database = getDb()): number {
  assertUserId(userId);
  return getContextAclRevision(userId, db);
}

export function createContextPack(userId: string, input: CreateContextPackInput): ContextPackCreateResult {
  assertUserId(userId);
  const name = parseName(input?.name);
  const description = parseDescription(input?.description);
  const visibility = input?.visibility === undefined ? "private" : parseVisibility(input.visibility);
  const content = normalizeInputContent(input?.content);
  const provenance = serializeProvenance(input?.provenance);
  const packId = randomUUID();
  const timestamp = nowSeconds();
  withMutation(userId, () => {
    ensureAccountState(userId);
    runSql(`INSERT INTO agent_context_packs(user_id, id, name, description, visibility, state, latest_revision, provenance_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
    userId,
    packId,
    name,
    description,
    visibility,
    provenance,
    timestamp,
    timestamp,);
    runSql(`INSERT INTO agent_context_pack_revisions(user_id, pack_id, revision, content_json, content_digest, token_count, byte_count, state, provenance_json, created_at, created_by)
     VALUES (?, ?, 1, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    userId,
    packId,
    content.serialized,
    content.digest,
    content.tokens,
    content.bytes,
    provenance,
    timestamp,
    userId,);
  });
  const pack = getContextPack(userId, packId);
  const revision = getContextPackRevision(userId, packId, 1, { includeInactive: true });
  if (!pack || !revision) throw new Error("Context pack creation did not produce a readable revision");
  return { pack, revision };
}

export function listContextPacks(userId: string, options: ContextPackListOptions = {}): readonly AgentContextPack[] {
  assertUserId(userId);
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(options.limit ?? MAX_LIST_LIMIT)));
  const offset = Math.min(MAX_LIST_OFFSET, Math.max(0, Math.trunc(options.offset ?? 0)));
  const filters = ["user_id = ?"];
  const params: SQLQueryBindings[] = [userId];
  if (!options.includeDisabled) filters.push("state <> 'disabled'");
  if (!options.includeReviewRequired) filters.push("state NOT IN ('review_required', 'repair_required')");
  const rows = getDb().query(
    `SELECT * FROM agent_context_packs WHERE ${filters.join(" AND ")}
     ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as ContextPackRow[];
  return rows.map(rowToPack);
}

/**
 * Exact active revisions the caller may use directly in an Agentic preset.
 * Management remains owner-only; this projection exposes no pack content.
 */
export function listSelectableContextPackRevisions(
  userId: string,
  limit = 256,
  db: Database = getDb(),
): readonly ContextPackSelectableRevision[] {
  assertUserId(userId);
  const boundedLimit = Math.min(256, Math.max(1, Math.trunc(limit)));
  const rows = db.query(
    `SELECT
       p.user_id AS owner_id,
       p.id AS pack_id,
       p.name AS pack_name,
       p.description AS pack_description,
       r.revision,
       r.content_digest AS digest,
       r.byte_count,
       r.token_count
     FROM agent_context_packs p
     JOIN agent_context_pack_revisions r
       ON r.user_id = p.user_id AND r.pack_id = p.id
     LEFT JOIN agent_context_pack_acls acl
       ON acl.user_id = p.user_id
      AND acl.pack_id = p.id
      AND acl.principal_user_id = ?
     WHERE p.state = 'active'
       AND r.state = 'active'
       AND (
         p.user_id = ?
         OR (
           p.visibility <> 'private'
           AND acl.permission IN ('use', 'edit')
         )
       )
     ORDER BY CASE WHEN p.user_id = ? THEN 0 ELSE 1 END,
              p.name COLLATE NOCASE ASC,
              p.id ASC,
              r.revision DESC
     LIMIT ?`,
  ).all(userId, userId, userId, boundedLimit) as Array<{
    owner_id: string;
    pack_id: string;
    pack_name: string;
    pack_description: string;
    revision: number;
    digest: string;
    byte_count: number;
    token_count: number;
  }>;
  return Object.freeze(rows.map((row) => Object.freeze({
    ownerId: row.owner_id,
    source: row.owner_id === userId ? "owned" as const : "shared" as const,
    packId: row.pack_id,
    packName: row.pack_name,
    packDescription: row.pack_description,
    revision: row.revision,
    digest: row.digest,
    byteCount: row.byte_count,
    tokenCount: row.token_count,
  })));
}

export function getContextPack(userId: string, packId: string, options: { includeInactive?: boolean } = {}): AgentContextPack | null {
  assertUserId(userId);
  if (typeof packId !== "string" || packId.length === 0) return null;
  const row = getOwnedPackRow(userId, packId);
  if (!row) return null;
  if (!options.includeInactive && row.state !== "active") return null;
  try {
    return rowToPack(row);
  } catch {
    return null;
  }
}

export function updateContextPack(userId: string, packId: string, input: ContextPackUpdateInput): AgentContextPack | null {
  assertUserId(userId);
  const expectedRevision = parseExpectedRevision(input?.expectedRevision, "expectedRevision");
  const existing = getOwnedPackRow(userId, packId);
  if (!existing) return null;
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (input.name !== undefined) { sets.push("name = ?"); params.push(parseName(input.name)); }
  if (input.description !== undefined) { sets.push("description = ?"); params.push(parseDescription(input.description)); }
  if (input.visibility !== undefined) { sets.push("visibility = ?"); params.push(parseVisibility(input.visibility)); }
  if (input.state !== undefined) { sets.push("state = ?"); params.push(parseState(input.state)); }
  let applied = false;
  withMutation(userId, () => {
    const current = getOwnedPackRow(userId, packId);
    if (!current) return;
    if (!Number.isSafeInteger(current.latest_revision) || current.latest_revision < 0) {
      throw new ContextPackValidationError("latestRevision", "stored revision is outside the safe integer range");
    }
    if (current.latest_revision !== expectedRevision) {
      throw new ContextPackRevisionConflictError(expectedRevision, current.latest_revision);
    }
    if (input.state === "active") {
      const latest = getPackRevisionRow(userId, packId, current.latest_revision);
      if (!latest) throw new ContextPackValidationError("revision", "latest revision is missing");
      if (current.state === "review_required" || current.state === "repair_required" || latest.state !== "active") {
        throw new ContextPackValidationError("state", "review-required context packs must be activated through review");
      }
    }
    if (sets.length === 0) {
      applied = true;
      return;
    }
    const updateParams = [...params, nowSeconds(), packId, userId, expectedRevision];
    runSql(
      `UPDATE agent_context_packs
          SET ${sets.join(", ")}, updated_at = ?
        WHERE id = ? AND user_id = ? AND latest_revision = ?`,
      ...updateParams,
    );
    const observed = getOwnedPackRow(userId, packId);
    if (!observed || observed.latest_revision !== expectedRevision) {
      throw new ContextPackRevisionConflictError(expectedRevision, observed?.latest_revision ?? expectedRevision);
    }
    applied = true;
  });
  return applied ? getContextPack(userId, packId, { includeInactive: true }) : null;
}
export function deleteContextPack(userId: string, packId: string, expectedRevision?: number): boolean {
  assertUserId(userId);
  const expected = parseExpectedRevision(expectedRevision, "expectedRevision");
  if (!getOwnedPackRow(userId, packId)) return false;
  let deleted = false;
  withMutation(userId, () => {
    const current = getOwnedPackRow(userId, packId);
    if (!current) return;
    if (!Number.isSafeInteger(current.latest_revision) || current.latest_revision < 0) {
      throw new ContextPackValidationError("latestRevision", "stored revision is outside the safe integer range");
    }
    if (current.latest_revision !== expected) {
      throw new ContextPackRevisionConflictError(expected, current.latest_revision);
    }
    for (const scope of ["preset", "chat", "world_book"] as const) {
      runSql(`DELETE FROM ${ATTACHMENT_TABLE[scope]} WHERE user_id = ? AND pack_id = ?`, userId, packId);
    }
    runSql("DELETE FROM agent_context_pack_acls WHERE user_id = ? AND pack_id = ?", userId, packId);
    runSql("DELETE FROM agent_context_pack_revisions WHERE user_id = ? AND pack_id = ?", userId, packId);
    const result = runSql("DELETE FROM agent_context_packs WHERE user_id = ? AND id = ?", userId, packId);
    if (result.changes > 0) deleted = true;
  });
  return deleted;
}


export function createContextPackRevision(userId: string, packId: string, input: CreateContextPackRevisionInput): AgentContextPackRevision | null {
  assertUserId(userId);
  const content = normalizeInputContent(input?.content);
  const provenance = serializeProvenance(input?.provenance);
  const timestamp = nowSeconds();
  let nextRevision: number | null = null;
  withMutation(userId, () => {
    const existing = getOwnedPackRow(userId, packId);
    if (!existing || existing.state === "disabled" || existing.state === "review_required" || existing.state === "repair_required") return;
    if (!Number.isSafeInteger(existing.latest_revision) || existing.latest_revision < 0 || existing.latest_revision >= Number.MAX_SAFE_INTEGER) {
      throw new ContextPackValidationError("latestRevision", "stored revision is outside the safe integer range");
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== existing.latest_revision) {
      throw new ContextPackRevisionConflictError(input.expectedRevision, existing.latest_revision);
    }
    nextRevision = existing.latest_revision + 1;
    runSql(`INSERT INTO agent_context_pack_revisions(user_id, pack_id, revision, content_json, content_digest, token_count, byte_count, state, provenance_json, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    userId,
    packId,
    nextRevision,
    content.serialized,
    content.digest,
    content.tokens,
    content.bytes,
    provenance,
    timestamp,
    userId,);
    const updated = runSql(
      "UPDATE agent_context_packs SET latest_revision = ?, updated_at = ? WHERE user_id = ? AND id = ? AND latest_revision = ?",
      nextRevision,
      timestamp,
      userId,
      packId,
      existing.latest_revision,
    );
    if (updated.changes !== 1) {
      const observed = getOwnedPackRow(userId, packId);
      throw new ContextPackRevisionConflictError(existing.latest_revision, observed?.latest_revision ?? existing.latest_revision);
    }
  });
  return nextRevision === null
    ? null
    : getContextPackRevision(userId, packId, nextRevision, { includeInactive: true });
}

export function listContextPackRevisions(userId: string, packId: string, options: { includeInactive?: boolean } = {}): readonly AgentContextPackRevision[] {
  assertUserId(userId);
  if (!getOwnedPackRow(userId, packId)) return [];
  const filters = ["user_id = ?", "pack_id = ?"];
  const params: SQLQueryBindings[] = [userId, packId];
  if (!options.includeInactive) filters.push("state = 'active'");
  const rows = getDb().query(
    `SELECT * FROM agent_context_pack_revisions WHERE ${filters.join(" AND ")}
     ORDER BY revision DESC LIMIT 256`,
  ).all(...params) as ContextPackRevisionRow[];
  return rows.flatMap((row) => {
    try { return [rowToRevision(row)]; } catch { return []; }
  });
}

export function getContextPackRevision(userId: string, packId: string, revision: number, options: { includeInactive?: boolean; requireAccess?: ContextPackPermission } = {}): AgentContextPackRevision | null {
  assertUserId(userId);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  const owned = getOwnedPackRow(userId, packId);
  let ownerId: string | null = owned?.user_id ?? null;
  if (!ownerId) {
    const required = options.requireAccess;
    if (!required) return null;
    ownerId = resolveAccessiblePackOwnerId(userId, packId, required === "edit" ? "use" : required);
  }
  if (!ownerId) return null;
  const row = getPackRevisionRow(ownerId, packId, revision);
  if (!row || (!options.includeInactive && row.state !== "active")) return null;
  try { return rowToRevision(row); } catch { return null; }
}

export function getContextPackAcl(userId: string, packId: string): readonly ContextPackAclEntry[] | null {
  assertUserId(userId);
  if (!getOwnedPackRow(userId, packId)) return null;
  const rows = getDb().query(
    `SELECT principal_user_id, permission, created_at, updated_at
     FROM agent_context_pack_acls WHERE user_id = ? AND pack_id = ? ORDER BY principal_user_id ASC`,
  ).all(userId, packId) as Array<{ principal_user_id: string; permission: ContextPackPermission; created_at: number; updated_at: number }>;
  return rows.map((row) => ({ principalUserId: row.principal_user_id, permission: row.permission, createdAt: row.created_at, updatedAt: row.updated_at }));
}

export function setContextPackAcl(userId: string, packId: string, entries: readonly ContextPackAclEntry[], expectedContextAclRevision?: number): readonly ContextPackAclEntry[] | null {
  assertUserId(userId);
  if (!getOwnedPackRow(userId, packId)) return null;
  const expectedRevision = parseExpectedRevision(expectedContextAclRevision, "expectedContextAclRevision");
  if (!Array.isArray(entries) || entries.length > 256) throw new ContextPackValidationError("acl", "contains too many entries");
  const normalized = entries.map((entry, index) => {
    if (!entry || typeof entry.principalUserId !== "string" || entry.principalUserId.length === 0 || utf8Bytes(entry.principalUserId) > 256) throw new ContextPackValidationError(`acl[${index}].principalUserId`, "must be a bounded non-empty string");
    const permission = parsePermission(entry.permission, `acl[${index}].permission`);
    const user = getDb().query("SELECT 1 AS present FROM \"user\" WHERE id = ?").get(entry.principalUserId) as { present: number } | null;
    if (!user) throw new ContextPackValidationError(`acl[${index}].principalUserId`, "user does not exist");
    return { principalUserId: entry.principalUserId, permission };
  }).sort((a, b) => a.principalUserId.localeCompare(b.principalUserId));
  const unique = new Set(normalized.map((entry) => entry.principalUserId));
  if (unique.size !== normalized.length) throw new ContextPackValidationError("acl", "contains duplicate principals");
  const timestamp = nowSeconds();
  const observedRevision = getContextAclRevision(userId);
  if (observedRevision !== expectedRevision) {
    throw new ContextPackAclRevisionConflictError(expectedRevision, observedRevision);
  }
  let applied = false;
  withMutation(userId, () => {
    if (!getOwnedPackRow(userId, packId)) return;
    const actualRevision = getContextAclRevision(userId);
    if (actualRevision !== expectedRevision) {
      throw new ContextPackAclRevisionConflictError(expectedRevision, actualRevision);
    }
    runSql("DELETE FROM agent_context_pack_acls WHERE user_id = ? AND pack_id = ?", userId, packId);
    for (const entry of normalized) {
      runSql(`INSERT INTO agent_context_pack_acls(user_id, pack_id, principal_user_id, permission, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      userId,
      packId,
      entry.principalUserId,
      entry.permission,
      timestamp,
      timestamp,);
    }
    applied = true;
  });
  return applied ? getContextPackAcl(userId, packId) : null;
}

export function reviewContextPack(userId: string, packId: string, input: ContextPackReviewInput): AgentContextPack | null {
  assertUserId(userId);
  if (!input?.acknowledge) throw new ContextPackValidationError("acknowledge", "must be true to change review state");
  const expectedRevision = parseExpectedRevision(input.expectedRevision, "expectedRevision");
  const state = input.state;
  if (state !== "active" && state !== "disabled") throw new ContextPackValidationError("state", "must be active or disabled");
  const existing = getOwnedPackRow(userId, packId);
  if (!existing) return null;
  let applied = false;
  withMutation(userId, () => {
    const current = getOwnedPackRow(userId, packId);
    if (!current) return;
    if (!Number.isSafeInteger(current.latest_revision) || current.latest_revision < 0 || current.latest_revision >= Number.MAX_SAFE_INTEGER) {
      throw new ContextPackValidationError("latestRevision", "stored revision is outside the safe integer range");
    }
    if (current.latest_revision !== expectedRevision) {
      throw new ContextPackRevisionConflictError(expectedRevision, current.latest_revision);
    }
    const latest = getPackRevisionRow(userId, packId, current.latest_revision);
    if (!latest) throw new ContextPackValidationError("revision", "latest revision is missing");
    const validatedLatest = rowToRevision(latest);
    if (current.state === "repair_required" || latest.state === "repair_required") {
      throw new ContextPackValidationError("state", "repair-required context packs must be repaired before review");
    }
    const timestamp = nowSeconds();
    if (state === "active" && latest.state === "review_required") {
      const nextRevision = current.latest_revision + 1;
      runSql(`INSERT INTO agent_context_pack_revisions(
       user_id, pack_id, revision, content_json, content_digest, token_count, byte_count,
       state, provenance_json, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      userId,
      packId,
      nextRevision,
      latest.content_json,
      validatedLatest.contentDigest,
      validatedLatest.tokenCount,
      validatedLatest.byteCount,
      latest.provenance_json,
      timestamp,
      validatedLatest.createdBy,);
      const appended = getPackRevisionRow(userId, packId, nextRevision);
      if (!appended || appended.state !== "active") throw new Error("Context pack review did not append an active revision");
      runSql(
        `UPDATE agent_context_packs
            SET state = 'active', latest_revision = ?, updated_at = ?
          WHERE user_id = ? AND id = ? AND latest_revision = ?`,
        nextRevision,
        timestamp,
        userId,
        packId,
        expectedRevision,
      );
      const observed = getOwnedPackRow(userId, packId);
      if (!observed || observed.latest_revision !== nextRevision || observed.state !== "active") {
        throw new ContextPackRevisionConflictError(expectedRevision, observed?.latest_revision ?? expectedRevision);
      }
      applied = true;
      return;
    }
    if (state === "active" && latest.state !== "active") {
      throw new ContextPackValidationError("state", "only a reviewed active revision can be activated");
    }
    if (state === "active" && current.state === "review_required") {
      throw new ContextPackValidationError("state", "review-required context packs need an active reviewed revision");
    }
    runSql(
      `UPDATE agent_context_packs
          SET state = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND latest_revision = ?`,
      state,
      timestamp,
      userId,
      packId,
      expectedRevision,
    );
    const observed = getOwnedPackRow(userId, packId);
    if (!observed || observed.latest_revision !== expectedRevision || observed.state !== state) {
      throw new ContextPackRevisionConflictError(expectedRevision, observed?.latest_revision ?? expectedRevision);
    }
    applied = true;
  });
  return applied ? getContextPack(userId, packId, { includeInactive: true }) : null;
}

export function attachContextPack(userId: string, packId: string, input: ContextPackAttachmentInput): ContextPackAttachment | null {
  assertUserId(userId);
  const parsed = assertAttachmentInput(input);
  const timestamp = nowSeconds();
  const attachmentId = randomUUID();
  const table = ATTACHMENT_TABLE[parsed.scope];
  const targetColumn = TARGET_COLUMN[parsed.scope];
  let applied = false;
  withMutation(userId, () => {
    const pack = getOwnedPackRow(userId, packId);
    if (!pack) {
      if (resolveAccessiblePackOwnerId(userId, packId, "use")) {
        throw new ContextPackValidationError("packId", "shared context packs must be duplicated before attachment");
      }
      throw new ContextPackValidationError("packId", "context pack is not owned by this user");
    }
    if (pack.state !== "active") {
      throw new ContextPackValidationError("packId", "context pack is not active");
    }
    if (!targetExists(userId, parsed.scope, parsed.targetId)) {
      throw new ContextPackValidationError("targetId", "target does not exist or is not owned by this user");
    }
    const revision = getPackRevisionRow(userId, packId, parsed.revision);
    if (!revision) throw new ContextPackValidationError("revision", "requested revision does not exist");
    if (revision.state !== "active") {
      throw new ContextPackValidationError("revision", "requested revision is not active");
    }
    if (parsed.expectedContextAclRevision !== undefined) {
      const actualRevision = getContextAclRevision(userId);
      if (actualRevision !== parsed.expectedContextAclRevision) {
        throw new ContextPackAclRevisionConflictError(parsed.expectedContextAclRevision, actualRevision);
      }
    }
    const duplicate = getDb().query(
      `SELECT 1 AS present FROM ${table}
       WHERE user_id = ? AND ${targetColumn} = ? AND pack_id = ? AND revision = ? LIMIT 1`,
    ).get(userId, parsed.targetId, packId, parsed.revision) as { present: number } | null;
    if (duplicate) throw new ContextPackValidationError("attachment", "this revision is already attached to the target");
    runSql(`INSERT INTO ${table}(user_id, attachment_id, ${targetColumn}, pack_id, revision, position, required, state, provenance_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    userId,
    attachmentId,
    parsed.targetId,
    packId,
    parsed.revision,
    parsed.position,
    parsed.required,
    parsed.provenance,
    timestamp,
    timestamp,);
    applied = true;
  });
  return applied ? getContextPackAttachment(userId, parsed.scope, attachmentId) : null;
}



export function getContextPackAttachment(userId: string, scope: ContextPackTargetScope, attachmentId: string): ContextPackAttachment | null {
  assertUserId(userId);
  const table = ATTACHMENT_TABLE[scope];
  if (!table || typeof attachmentId !== "string" || attachmentId.length === 0) return null;
  const targetColumn = TARGET_COLUMN[scope];
  const row = getDb().query(
    `SELECT user_id, attachment_id, ${targetColumn} AS target_id, pack_id, revision, position, required, state, provenance_json, created_at, updated_at
     FROM ${table} WHERE user_id = ? AND attachment_id = ?`,
  ).get(userId, attachmentId) as ContextPackAttachmentRow | null;
  return row ? rowToAttachment(scope, row) : null;
}

export function listContextPackAttachments(userId: string, scope: ContextPackTargetScope, targetId: string, options: { includeInactive?: boolean } = {}): readonly ContextPackAttachment[] {
  assertUserId(userId);
  if (!ATTACHMENT_TABLE[scope] || !targetExists(userId, scope, targetId)) return [];
  const table = ATTACHMENT_TABLE[scope];
  const targetColumn = TARGET_COLUMN[scope];
  const conditions = [`user_id = ?`, `${targetColumn} = ?`];
  const params: SQLQueryBindings[] = [userId, targetId];
  if (!options.includeInactive) conditions.push("state = 'active'");
  const rows = getDb().query(
    `SELECT user_id, attachment_id, ${targetColumn} AS target_id, pack_id, revision, position, required, state, provenance_json, created_at, updated_at
     FROM ${table} WHERE ${conditions.join(" AND ")}
     ORDER BY position ASC, attachment_id ASC LIMIT 256`,
  ).all(...params) as ContextPackAttachmentRow[];
  return rows.map((row) => rowToAttachment(scope, row));
}
export function listContextPackAttachmentsForPack(userId: string, packId: string, options: { includeInactive?: boolean } = {}): readonly ContextPackAttachment[] {
  assertUserId(userId);
  if (!getOwnedPackRow(userId, packId)) return [];
  const attachments: ContextPackAttachment[] = [];
  for (const scope of ["preset", "chat", "world_book"] as const) {
    const table = ATTACHMENT_TABLE[scope];
    const targetColumn = TARGET_COLUMN[scope];
    const conditions = ["user_id = ?", "pack_id = ?"];
    const params: SQLQueryBindings[] = [userId, packId];
    if (!options.includeInactive) conditions.push("state = 'active'");
    const rows = getDb().query(
      `SELECT user_id, attachment_id, ${targetColumn} AS target_id, pack_id, revision, position, required, state, provenance_json, created_at, updated_at
       FROM ${table} WHERE ${conditions.join(" AND ")}
       ORDER BY position ASC, attachment_id ASC LIMIT 256`,
    ).all(...params) as ContextPackAttachmentRow[];
    attachments.push(...rows.map((row) => rowToAttachment(scope, row)));
  }
  return attachments.sort((left, right) => left.scope.localeCompare(right.scope) || left.position - right.position || left.attachmentId.localeCompare(right.attachmentId));
}


export function deleteContextPackAttachment(
  userId: string,
  scope: ContextPackTargetScope,
  attachmentId: string,
  expectedContextAclRevision?: number,
): boolean {
  assertUserId(userId);
  const table = ATTACHMENT_TABLE[scope];
  if (!table) return false;
  const expected = expectedContextAclRevision === undefined
    ? undefined
    : parseExpectedRevision(expectedContextAclRevision, "expectedContextAclRevision");
  if (expected !== undefined) {
    const observedRevision = getContextAclRevision(userId);
    if (observedRevision !== expected) {
      throw new ContextPackAclRevisionConflictError(expected, observedRevision);
    }
  }
  let deleted = false;
  withMutation(userId, () => {
    if (expected !== undefined) {
      const actualRevision = getContextAclRevision(userId);
      if (actualRevision !== expected) {
        throw new ContextPackAclRevisionConflictError(expected, actualRevision);
      }
    }
    const result = runSql(`DELETE FROM ${table} WHERE user_id = ? AND attachment_id = ?`,
    userId,
    attachmentId,);
    if (result.changes > 0) deleted = true;
  });
  return deleted;
}

export function readContextPackAccessMetadata(
  userId: string,
  input: ContextPackAccessMetadataInput,
): ContextPackAccessMetadata | null {
  assertUserId(userId);
  if (!input || typeof input !== "object") return null;
  if (typeof input.ownerId !== "string" || input.ownerId.length === 0) return null;
  const table = ATTACHMENT_TABLE[input.source];
  const targetColumn = TARGET_COLUMN[input.source];
  if (!table || !targetColumn) return null;
  if (
    typeof input.targetId !== "string" ||
    input.targetId.length === 0 ||
    typeof input.attachmentId !== "string" ||
    input.attachmentId.length === 0 ||
    typeof input.packId !== "string" ||
    input.packId.length === 0 ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1
  ) return null;
  interface AccessRow {
    owner_id: string;
    pack_id: string;
    revision: number;
    attachment_id: string;
    position: number;
    required: number;
    attachment_state: ContextPackState;
    attachment_updated_at: number;
    visibility: ContextPackVisibility;
    pack_state: ContextPackState;
    digest: string;
    byte_count: number;
    token_count: number;
    revision_state: ContextPackState;
    permission: ContextPackPermission | null;
    acl_revision: number | null;
  }
  const row = getDb().query(
    `SELECT
       a.user_id AS owner_id,
       a.pack_id,
       a.revision,
       a.attachment_id,
       a.position,
       a.required,
       a.state AS attachment_state,
       a.updated_at AS attachment_updated_at,
       p.visibility,
       p.state AS pack_state,
       r.content_digest AS digest,
       r.byte_count,
       r.token_count,
       r.state AS revision_state,
       acl.permission,
       account.context_acl_revision AS acl_revision
     FROM ${table} a
     JOIN agent_context_packs p
       ON p.user_id = a.user_id AND p.id = a.pack_id
     JOIN agent_context_pack_revisions r
       ON r.user_id = a.user_id AND r.pack_id = a.pack_id AND r.revision = a.revision
     LEFT JOIN agent_context_pack_acls acl
       ON acl.user_id = p.user_id AND acl.pack_id = p.id AND acl.principal_user_id = ?
     LEFT JOIN agent_context_account_state account
       ON account.user_id = p.user_id
     WHERE a.user_id = ?
       AND a.attachment_id = ?
       AND a.${targetColumn} = ?
       AND a.pack_id = ?
       AND a.revision = ?
     LIMIT 1`,
  ).get(
    userId,
    input.ownerId,
    input.attachmentId,
    input.targetId,
    input.packId,
    input.revision,
  ) as AccessRow | null;
  if (!row) return null;
  const allowed =
    row.owner_id === userId ||
    (row.visibility !== "private" && (row.permission === "use" || row.permission === "edit"));
  if (!allowed || row.pack_state !== "active" || row.revision_state !== "active" || row.attachment_state !== "active") {
    return null;
  }
  return {
    ownerId: row.owner_id,
    packId: row.pack_id,
    revision: row.revision,
    digest: row.digest,
    byteCount: row.byte_count,
    tokenCount: row.token_count,
    aclRevision: row.acl_revision ?? 0,
    attachmentRevision: JSON.stringify([
      row.owner_id,
      row.pack_id,
      row.revision,
      input.source,
      input.targetId,
      row.attachment_id,
      row.attachment_updated_at,
      row.position,
      row.required ? 1 : 0,
      row.attachment_state,
    ]),
  };
}
export function readContextPackAccountAccessMetadata(
  userId: string,
  packId: string,
  revision: number,
  digest: string,
  db: Database = getDb(),
): ContextPackAccessMetadata | null {
  assertUserId(userId);
  if (
    typeof packId !== "string" ||
    packId.length === 0 ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    return null;
  }
  const ownerId = resolveAccessiblePackOwnerId(userId, packId, "use", db);
  if (!ownerId) return null;
  const row = db.query(
    `SELECT
       p.user_id AS owner_id,
       p.id AS pack_id,
       r.revision,
       r.content_digest AS digest,
       r.byte_count,
       r.token_count,
       p.state AS pack_state,
       r.state AS revision_state,
       account.context_acl_revision AS acl_revision
     FROM agent_context_packs p
     JOIN agent_context_pack_revisions r
       ON r.user_id = p.user_id AND r.pack_id = p.id
     LEFT JOIN agent_context_account_state account
       ON account.user_id = p.user_id
     WHERE p.user_id = ?
       AND p.id = ?
       AND r.revision = ?
       AND r.content_digest = ?
     LIMIT 1`,
  ).get(ownerId, packId, revision, digest) as {
    owner_id: string;
    pack_id: string;
    revision: number;
    digest: string;
    byte_count: number;
    token_count: number;
    pack_state: ContextPackState;
    revision_state: ContextPackState;
    acl_revision: number | null;
  } | null;
  if (!row || row.pack_state !== "active" || row.revision_state !== "active") return null;
  return {
    ownerId: row.owner_id,
    packId: row.pack_id,
    revision: row.revision,
    digest: row.digest,
    byteCount: row.byte_count,
    tokenCount: row.token_count,
    aclRevision: row.acl_revision ?? 0,
    attachmentRevision: null,
  };
}


export function listContextPackAccountCandidateMetadata(
  userId: string,
  selections: readonly ContextPackAccountCandidateSelection[],
  db: Database = getDb(),
): ContextPackAccountCandidateMetadataSnapshot {
  assertUserId(userId);
  if (!Array.isArray(selections) || selections.length > 128) {
    throw new ContextPackValidationError("selections", "too many account context selections");
  }
  const accountRevision = getContextAclRevision(userId, db);
  const items: ContextPackAccountCandidateMetadataResult[] = [];
  const query = db.query(
    `SELECT
       p.id AS pack_id,
       p.name AS pack_name,
       p.description AS pack_description,
       p.visibility AS pack_visibility,
       p.state AS pack_state,
       p.latest_revision AS latest_revision,
       r.revision,
       r.content_digest AS digest,
       r.byte_count,
       r.token_count,
       r.state AS revision_state
     FROM agent_context_packs p
     LEFT JOIN agent_context_pack_revisions r
       ON r.user_id = p.user_id AND r.pack_id = p.id AND r.revision = ?
     WHERE p.user_id = ? AND p.id = ?
     LIMIT 1`,
  );
  selections.forEach((selection, index) => {
    if (!selection || typeof selection !== "object") {
      throw new ContextPackValidationError(`selections[${index}]`, "must be an object");
    }
    const required = selection.required !== false;
    const ownerId = resolveAccessiblePackOwnerId(userId, selection.packId, "use", db);
    const row = ownerId === null ? null : query.get(selection.revision, ownerId, selection.packId) as {
      pack_id: string;
      pack_name: string;
      pack_description: string;
      pack_visibility: ContextPackVisibility;
      pack_state: ContextPackState;
      latest_revision: number;
      revision: number | null;
      digest: string | null;
      byte_count: number | null;
      token_count: number | null;
      revision_state: ContextPackState | null;
    } | null;
    const valid =
      row !== null &&
      row.revision === selection.revision &&
      row.digest === selection.digest &&
      row.pack_state === "active" &&
      row.revision_state === "active";
    if (!valid) {
      if (required) {
        const reason =
          row === null || row.revision === null || row.digest !== selection.digest
            ? "revision_missing"
            : row.pack_state === "active" && row.revision_state === "active"
              ? "missing"
              : row.pack_state === "disabled" || row.revision_state === "disabled"
                ? "disabled"
                : "review_required";
        items.push({
          kind: "omission",
          ownerId: ownerId ?? userId,
          attachmentId: null,
          source: "account",
          targetId: null,
          required: true,
          reason,
          packId: selection.packId,
        });
      }
      return;
    }
    items.push({
      kind: "candidate",
      ownerId: ownerId!,
      attachmentId: null,
      source: "account",
      targetId: null,
      packId: row.pack_id,
      revision: row.revision!,
      position: selection.order ?? index,
      required,
      attachmentState: "active",
      attachmentUpdatedAt: 0,
      packName: row.pack_name,
      packDescription: row.pack_description,
      packVisibility: row.pack_visibility,
      packState: row.pack_state,
      latestRevision: row.latest_revision,
      digest: row.digest!,
      byteCount: row.byte_count ?? 0,
      tokenCount: row.token_count ?? 0,
      revisionState: row.revision_state!,
      aclRevision: getContextAclRevision(ownerId!, db),
      attachmentRevision: null,
    });
  });
  return Object.freeze({
    contextAclRevision: accountRevision,
    items: Object.freeze(items),
  });
}
export interface ContextPackCandidateMetadataSnapshot {
  readonly contextAclRevision: number;
  readonly items: readonly ContextPackCandidateMetadataResult[];
}

/**
 * Return candidate metadata and the ACL epoch from one synchronous SQLite
 * read transaction. A mutation that races the projection makes the snapshot
 * unusable instead of allowing callers to pair rows with a later epoch.
 */
export function listContextPackCandidateMetadata(
  userId: string,
  scopes: readonly ContextPackCandidateScope[],
  maxCandidates = 128,
  db: Database = getDb(),
): ContextPackCandidateMetadataSnapshot {
  assertUserId(userId);
  const readSnapshot = (): ContextPackCandidateMetadataSnapshot => {
    const before = getContextAclRevision(userId, db);
    const items = listContextPackCandidateMetadataUnsafe(userId, scopes, maxCandidates, db);
    const after = getContextAclRevision(userId, db);
    if (before !== after) {
      throw new ContextPackAclRevisionConflictError(before, after);
    }
    return Object.freeze({
      contextAclRevision: after,
      items: Object.freeze(items),
    });
  };
  let lastConflict: ContextPackAclRevisionConflictError | undefined;
  for (let attempt = 0; attempt < CONTEXT_PACK_METADATA_MAX_RETRIES; attempt += 1) {
    try {
      return db.inTransaction ? readSnapshot() : db.transaction(readSnapshot)();
    } catch (error) {
      if (!(error instanceof ContextPackAclRevisionConflictError)) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict ?? new Error("Context-pack metadata snapshot could not be read");
}

function listContextPackCandidateMetadataUnsafe(
  userId: string,
  scopes: readonly ContextPackCandidateScope[],
  maxCandidates = 128,
  db: Database = getDb(),
): readonly ContextPackCandidateMetadataResult[] {
  assertUserId(userId);
  if (!Array.isArray(scopes)) throw new ContextPackValidationError("scopes", "must be an array");
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 128) {
    throw new ContextPackValidationError("maxCandidates", "must be between 1 and 128");
  }
  const scopeRank: Record<ContextPackTargetScope, number> = { preset: 0, chat: 1, world_book: 2 };
  const normalizedScopes = scopes
    .filter((scope): scope is ContextPackCandidateScope => Boolean(scope) && typeof scope === "object")
    .map((scope) => {
      if (!(scope.scope in ATTACHMENT_TABLE)) throw new ContextPackValidationError("scopes.scope", "unsupported scope");
      if (typeof scope.targetId !== "string" || scope.targetId.length === 0 || utf8Bytes(scope.targetId) > 256) {
        throw new ContextPackValidationError("scopes.targetId", "must be a bounded non-empty string");
      }
      return { scope: scope.scope, targetId: scope.targetId };
    })
    .sort((left, right) => scopeRank[left.scope] - scopeRank[right.scope] || left.targetId.localeCompare(right.targetId));
  const seen = new Set<string>();
  const results: ContextPackCandidateMetadataResult[] = [];
  let enumeratedRows = 0;
  interface CandidateRow {
    owner_id: string;
    attachment_id: string;
    target_id: string;
    pack_id: string;
    revision: number;
    position: number;
    required: number;
    attachment_state: ContextPackState;
    attachment_updated_at: number;
    pack_name: string | null;
    pack_description: string | null;
    pack_visibility: ContextPackVisibility | null;
    pack_state: ContextPackState | null;
    latest_revision: number | null;
    digest: string | null;
    byte_count: number | null;
    token_count: number | null;
    revision_state: ContextPackState | null;
    acl_revision: number | null;
  }
  for (const scope of normalizedScopes) {
    const key = `${scope.scope}\u0000${scope.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const table = ATTACHMENT_TABLE[scope.scope];
    const targetColumn = TARGET_COLUMN[scope.scope];
    const rows = db.query(
      `SELECT
         a.user_id AS owner_id,
         a.attachment_id,
         a.${targetColumn} AS target_id,
         a.pack_id,
         a.revision,
         a.position,
         a.required,
         a.state AS attachment_state,
         a.updated_at AS attachment_updated_at,
         p.name AS pack_name,
         p.description AS pack_description,
         p.visibility AS pack_visibility,
         p.state AS pack_state,
         p.latest_revision,
         r.content_digest AS digest,
         r.byte_count,
         r.token_count,
         r.state AS revision_state,
         account.context_acl_revision AS acl_revision
       FROM ${table} a
       LEFT JOIN agent_context_packs p
         ON p.user_id = a.user_id AND p.id = a.pack_id
       LEFT JOIN agent_context_pack_revisions r
         ON r.user_id = a.user_id AND r.pack_id = a.pack_id AND r.revision = a.revision
       LEFT JOIN agent_context_account_state account
         ON account.user_id = a.user_id
       WHERE a.user_id = ?
         AND a.${targetColumn} = ?
       ORDER BY a.required DESC, a.position ASC, a.attachment_id ASC
      LIMIT ?`,
    ).all(userId, scope.targetId, maxCandidates + 1) as CandidateRow[];
    if (rows.length > maxCandidates || enumeratedRows + rows.length > maxCandidates) {
      throw new Error("context candidate limit exceeded");
    }
    enumeratedRows += rows.length;
    for (const row of rows) {
      if (row.required !== 1) {
        if (
          row.pack_name === null ||
          row.pack_state !== "active" ||
          row.revision_state !== "active" ||
          row.digest === null
        ) continue;
      }
      const omissionReason: ContextPackCandidateOmission["reason"] | null =
        row.pack_name === null
          ? "missing"
          : row.digest === null || row.revision_state === null
            ? "revision_missing"
            : row.attachment_state === "disabled" || row.pack_state === "disabled" || row.revision_state === "disabled"
              ? "disabled"
              : row.attachment_state !== "active" || row.pack_state !== "active" || row.revision_state !== "active"
                ? "review_required"
                : null;
      if (omissionReason) {
        if (row.required === 1) {
          results.push({
            kind: "omission",
            ownerId: row.owner_id,
            attachmentId: row.attachment_id,
            source: scope.scope,
            targetId: row.target_id,
            required: true,
            reason: omissionReason,
          });
        }
        continue;
      }
      results.push({
        kind: "candidate",
        ownerId: row.owner_id,
        attachmentId: row.attachment_id,
        source: scope.scope,
        targetId: row.target_id,
        packId: row.pack_id,
        revision: row.revision,
        position: row.position,
        required: row.required === 1,
        attachmentState: row.attachment_state,
        attachmentUpdatedAt: row.attachment_updated_at,
        packName: row.pack_name!,
        packDescription: row.pack_description!,
        packVisibility: row.pack_visibility!,
        packState: row.pack_state!,
        latestRevision: row.latest_revision!,
        digest: row.digest!,
        byteCount: row.byte_count!,
        tokenCount: row.token_count!,
        revisionState: row.revision_state!,
        aclRevision: row.acl_revision ?? 0,
        attachmentRevision: JSON.stringify([
          row.owner_id,
          row.pack_id,
          row.revision,
          scope.scope,
          row.target_id,
          row.attachment_id,
          row.attachment_updated_at,
          row.position,
          row.required ? 1 : 0,
          row.attachment_state,
        ]),
      });
    }
  }
  return results;
}

export function listContextPackCandidates(userId: string, scope: ContextPackTargetScope, targetId: string): readonly ContextPackCandidate[] {
  const attachments = listContextPackAttachments(userId, scope, targetId);
  const candidates: ContextPackCandidate[] = [];
  for (const attachment of attachments) {
    const pack = getContextPack(userId, attachment.packId);
    const revision = getContextPackRevision(userId, attachment.packId, attachment.revision, { requireAccess: "use" });
    if (pack && revision && canAccessPack(userId, attachment.packId, "use")) candidates.push({ attachment, pack, revision });
  }
  return candidates;
}

export function exportContextPack(userId: string, packId: string, revision = 0): PortableContextPackSnapshotV1 | null {
  const pack = getContextPack(userId, packId, { includeInactive: true });
  if (!pack) return null;
  const selectedRevision = revision > 0 ? revision : pack.latestRevision;
  const selected = getContextPackRevision(userId, packId, selectedRevision, { includeInactive: true });
  if (!selected) return null;
  return buildPortableSnapshot(pack, selected);
}

function buildPortableSnapshot(pack: AgentContextPack, revision: AgentContextPackRevision): PortableContextPackSnapshotV1 {
  return {
    portableVersion: 1,
    snapshotId: createPortableContextPackSnapshotId(revision.contentDigest, revision.revision, pack.id),
    name: pack.name,
    description: pack.description,
    revision: revision.revision,
    content: revision.content,
    contentDigest: revision.contentDigest,
    tokenCount: revision.tokenCount,
    byteCount: revision.byteCount,
  };
}

export interface PortablePresetContextPackSelectionV1 {
  readonly packId: string;
  readonly revision: number;
  readonly digest: string;
}

export function buildPortablePresetContextPackSnapshots(
  userId: string,
  presetId: string,
  directSelections: readonly PortablePresetContextPackSelectionV1[] = [],
): readonly PortableContextPackSnapshotV1[] {
  const byPackRevision = new Map<string, PortableContextPackSnapshotV1>();
  const attachments = listContextPackAttachments(userId, "preset", presetId);
  for (const attachment of attachments) {
    const pack = getContextPack(userId, attachment.packId);
    const revision = getContextPackRevision(userId, attachment.packId, attachment.revision);
    if (!pack || !revision) continue;
    byPackRevision.set(`${attachment.packId}\u0000${attachment.revision}`, buildPortableSnapshot(pack, revision));
  }
  for (const selection of directSelections) {
    if (
      !selection
      || typeof selection.packId !== "string"
      || !Number.isSafeInteger(selection.revision)
      || selection.revision < 1
      || typeof selection.digest !== "string"
    ) {
      throw new ContextPackValidationError("contextPackSelections", "contains an invalid exact revision");
    }
    const ownerId = resolveAccessiblePackOwnerId(userId, selection.packId, "read");
    if (!ownerId) throw new ContextPackValidationError("contextPackSelections", "selected revision is not accessible");
    const row = getOwnedPackRow(ownerId, selection.packId);
    const revisionRow = getPackRevisionRow(ownerId, selection.packId, selection.revision);
    if (!row || !revisionRow || row.state !== "active" || revisionRow.state !== "active") {
      throw new ContextPackValidationError("contextPackSelections", "selected revision is not active");
    }
    const pack = rowToPack(row);
    const revision = rowToRevision(revisionRow);
    if (revision.contentDigest !== selection.digest) {
      throw new ContextPackValidationError("contextPackSelections", "selected revision digest does not match");
    }
    byPackRevision.set(`${selection.packId}\u0000${selection.revision}`, buildPortableSnapshot(pack, revision));
  }
  return Object.freeze([...byPackRevision.values()]);
}
export const getPortablePresetContextPackSnapshots = buildPortablePresetContextPackSnapshots;
export function copyPresetContextPackAttachmentsWithDb(
  db: Database,
  userId: string,
  sourcePresetId: string,
  targetPresetId: string,
): void {
  const rows = db.query(
    `SELECT attachment_id, pack_id, revision, position, required, state, provenance_json, created_at, updated_at
       FROM agent_preset_context_pack_attachments
      WHERE user_id = ? AND preset_id = ?
      ORDER BY position ASC, attachment_id ASC`,
  ).all(userId, sourcePresetId) as Array<{
    attachment_id: string;
    pack_id: string;
    revision: number;
    position: number;
    required: number;
    state: ContextPackState;
    provenance_json: string;
    created_at: number;
    updated_at: number;
  }>;
  for (const row of rows) {
    const pack = db.query(
      "SELECT state FROM agent_context_packs WHERE user_id = ? AND id = ?",
    ).get(userId, row.pack_id) as { state: ContextPackState } | null;
    const revision = db.query(
      "SELECT state FROM agent_context_pack_revisions WHERE user_id = ? AND pack_id = ? AND revision = ?",
    ).get(userId, row.pack_id, row.revision) as { state: ContextPackState } | null;
    if (!pack || !revision) continue;
    const state: ContextPackState =
      pack.state === "disabled" || revision.state === "disabled" || row.state === "disabled"
        ? "disabled"
        : pack.state === "active" && revision.state === "active" && row.state === "active"
          ? "active"
          : "review_required";
    db.query(
      `INSERT INTO agent_preset_context_pack_attachments
       (user_id, attachment_id, preset_id, pack_id, revision, position, required, state, provenance_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      randomUUID(),
      targetPresetId,
      row.pack_id,
      row.revision,
      row.position,
      row.required,
      state,
      serializeProvenance({ kind: "same_account_duplicate", sourcePackId: row.pack_id }),
      row.created_at,
      row.updated_at,
    );
  }
}

export function importForeignContextPackWithDb(
  db: Database,
  userId: string,
  snapshot: PortableContextPackSnapshotV1,
  timestamp = nowSeconds(),
): PortableContextPackImportResult {
  assertUserId(userId);
  const normalized = normalizeInputContent(snapshot.content);
  if (normalized.digest !== snapshot.contentDigest || normalized.bytes !== snapshot.byteCount || normalized.tokens !== snapshot.tokenCount) {
    throw new ContextPackValidationError("snapshot", "content accounting does not match the selected revision");
  }
  const name = parseName(snapshot.name);
  const description = parseDescription(snapshot.description);
  const packId = randomUUID();
  const provenance: ContextPackProvenanceV1 = { kind: "portable_import", sourceDigest: snapshot.contentDigest };
  const provenanceJson = serializeProvenance(provenance);
  db.query("INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at) VALUES (?, 0, ?) ON CONFLICT(user_id) DO NOTHING").run(userId, timestamp);
  db.query(`INSERT INTO agent_context_packs(user_id, id, name, description, visibility, state, latest_revision, provenance_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'private', 'review_required', 1, ?, ?, ?)`).run(userId, packId, name, description, provenanceJson, timestamp, timestamp);
  db.query(`INSERT INTO agent_context_pack_revisions(user_id, pack_id, revision, content_json, content_digest, token_count, byte_count, state, provenance_json, created_at, created_by)
    VALUES (?, ?, 1, ?, ?, ?, ?, 'review_required', ?, ?, ?)`).run(userId, packId, normalized.serialized, normalized.digest, normalized.tokens, normalized.bytes, provenanceJson, timestamp, userId);
  const packRow = db.query("SELECT * FROM agent_context_packs WHERE user_id = ? AND id = ?").get(userId, packId) as ContextPackRow | null;
  const revisionRow = db.query("SELECT * FROM agent_context_pack_revisions WHERE user_id = ? AND pack_id = ? AND revision = 1").get(userId, packId) as ContextPackRevisionRow | null;
  if (!packRow || !revisionRow) throw new Error("Foreign context pack import did not produce a readable copy");
  return { pack: rowToPack(packRow), revision: rowToRevision(revisionRow), attached: false, reviewRequired: true };
}

export function importForeignContextPack(userId: string, snapshot: PortableContextPackSnapshotV1): PortableContextPackImportResult {
  assertUserId(userId);
  return withMutation(userId, () => importForeignContextPackWithDb(getDb(), userId, snapshot));
}

export function duplicateContextPack(userId: string, sourcePackId: string, input: ContextPackDuplicateInput = {}): ContextPackDuplicateResult | null {
  assertUserId(userId);
  const source = getOwnedPackRow(userId, sourcePackId);
  if (!source) return null;
  const sourceRevisions = listContextPackRevisions(userId, sourcePackId, { includeInactive: true });
  const latestSource = sourceRevisions.find((revision) => revision.revision === source.latest_revision);
  if (!latestSource) throw new ContextPackValidationError("revision", "latest revision is missing or malformed");
  if (sourceRevisions.length === 0) return null;
  const name = input.name === undefined ? `${source.name} copy` : parseName(input.name);
  const description = input.description === undefined ? source.description : parseDescription(input.description);
  const packId = randomUUID();
  const timestamp = nowSeconds();
  const revisionByNumber = new Map(sourceRevisions.map((revision) => [revision.revision, revision]));
  const attachmentRequests = input.selectedAttachments ?? (input.preserveAttachments ? collectSourceAttachmentRequests(userId, sourcePackId) : []);
  const normalizedRequests = attachmentRequests.map((request) => {
    if (request.scope !== "preset" && request.scope !== "chat" && request.scope !== "world_book") throw new ContextPackValidationError("selectedAttachments.scope", "unsupported scope");
    if (typeof request.targetId !== "string" || request.targetId.length === 0 || !targetExists(userId, request.scope, request.targetId)) throw new ContextPackValidationError("selectedAttachments.targetId", "target is not owned by this user");
    const revision = request.revision ?? source.latest_revision;
    if (!revisionByNumber.has(revision)) throw new ContextPackValidationError("selectedAttachments.revision", "revision does not exist on source pack");
    return { ...request, revision };
  });
  withMutation(userId, () => {
    ensureAccountState(userId);
    if (!Number.isSafeInteger(source.latest_revision) || source.latest_revision < 0 || source.latest_revision >= Number.MAX_SAFE_INTEGER) {
      throw new ContextPackValidationError("latestRevision", "stored revision is outside the safe integer range");
    }
    const duplicatedState = source.state === "active" && latestSource.state !== "active"
      ? latestSource.state === "repair_required" ? "repair_required" : "review_required"
      : source.state;
    runSql(`INSERT INTO agent_context_packs(user_id, id, name, description, visibility, state, latest_revision, provenance_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'private', ?, ?, ?, ?, ?)`,
    userId,
    packId,
    name,
    description,
    duplicatedState,
    source.latest_revision,
    serializeProvenance({ kind: "same_account_duplicate", sourcePackId }),
    timestamp,
    timestamp,);
    for (const revision of sourceRevisions) {
      const revisionProvenance = serializeProvenance({ kind: "same_account_duplicate", sourcePackId });
      runSql(`INSERT INTO agent_context_pack_revisions(user_id, pack_id, revision, content_json, content_digest, token_count, byte_count, state, provenance_json, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      packId,
      revision.revision,
      serializeContextPackContent(revision.content),
      revision.contentDigest,
      revision.tokenCount,
      revision.byteCount,
      revision.state,
      revisionProvenance,
      timestamp,
      userId,);
    }
    if (duplicatedState !== "active") return;
    for (const request of normalizedRequests) {
      const sourceAttachment = getAttachmentForTarget(userId, request.scope, request.targetId, sourcePackId, request.revision);
      if (!sourceAttachment) continue;
      const table = ATTACHMENT_TABLE[request.scope];
      const targetColumn = TARGET_COLUMN[request.scope];
      runSql(`INSERT INTO ${table}(user_id, attachment_id, ${targetColumn}, pack_id, revision, position, required, state, provenance_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      userId,
      randomUUID(),
      request.targetId,
      packId,
      request.revision,
      sourceAttachment.position,
      sourceAttachment.required ? 1 : 0,
      serializeProvenance({ kind: "same_account_duplicate", sourcePackId }),
      timestamp,
      timestamp,);
    }
  });
  const pack = getContextPack(userId, packId, { includeInactive: true });
  if (!pack) throw new Error("Context pack duplicate did not produce a readable pack");
  const revisions = listContextPackRevisions(userId, packId, { includeInactive: true });
  const attachments = ["preset", "chat", "world_book"].flatMap((scope) => listContextPackAttachments(userId, scope as ContextPackTargetScope, "", { includeInactive: true })) as ContextPackAttachment[];
  // Attachment IDs are returned by a direct pack filter below; the target-list
  // helper intentionally requires a concrete target to preserve non-disclosure.
  const rows: ContextPackAttachment[] = [];
  for (const scope of ["preset", "chat", "world_book"] as const) {
    const table = ATTACHMENT_TABLE[scope];
    const targetColumn = TARGET_COLUMN[scope];
    const rawRows = getDb().query(
      `SELECT user_id, attachment_id, ${targetColumn} AS target_id, pack_id, revision, position, required, state, provenance_json, created_at, updated_at
       FROM ${table} WHERE user_id = ? AND pack_id = ? ORDER BY position ASC, attachment_id ASC`,
    ).all(userId, packId) as ContextPackAttachmentRow[];
    rows.push(...rawRows.map((row) => rowToAttachment(scope, row)));
  }
  void attachments;
  return { pack, revisions, attachments: rows };
}

function collectSourceAttachmentRequests(userId: string, packId: string): Array<{ scope: ContextPackTargetScope; targetId: string; revision: number }> {
  const requests: Array<{ scope: ContextPackTargetScope; targetId: string; revision: number }> = [];
  for (const scope of ["preset", "chat", "world_book"] as const) {
    const table = ATTACHMENT_TABLE[scope];
    const targetColumn = TARGET_COLUMN[scope];
    const rows = getDb().query(`SELECT ${targetColumn} AS target_id, revision FROM ${table} WHERE user_id = ? AND pack_id = ? AND state = 'active'`).all(userId, packId) as Array<{ target_id: string; revision: number }>;
    for (const row of rows) requests.push({ scope, targetId: row.target_id, revision: row.revision });
  }
  return requests;
}

function getAttachmentForTarget(userId: string, scope: ContextPackTargetScope, targetId: string, packId: string, revision: number): ContextPackAttachment | null {
  const table = ATTACHMENT_TABLE[scope];
  const targetColumn = TARGET_COLUMN[scope];
  const row = getDb().query(
    `SELECT user_id, attachment_id, ${targetColumn} AS target_id, pack_id, revision, position, required, state, provenance_json, created_at, updated_at
     FROM ${table} WHERE user_id = ? AND ${targetColumn} = ? AND pack_id = ? AND revision = ? AND state = 'active' LIMIT 1`,
  ).get(userId, targetId, packId, revision) as ContextPackAttachmentRow | null;
  return row ? rowToAttachment(scope, row) : null;
}

/** Explicitly remove a pack by disabling it; immutable revisions remain auditable. */
export function disableContextPack(userId: string, packId: string, expectedRevision?: number): boolean {
  const current = getOwnedPackRow(userId, packId);
  if (!current) return false;
  const result = updateContextPack(userId, packId, {
    state: "disabled",
    expectedRevision: expectedRevision ?? current.latest_revision,
  });
  return result !== null;
}

/** Public gate for runtime tools; callers still receive a non-disclosing null. */
export function readContextPackRevisionForUser(userId: string, packId: string, revision: number): AgentContextPackRevision | null {
  if (!canAccessPack(userId, packId, "read")) return null;
  return getContextPackRevision(userId, packId, revision, { requireAccess: "read" });
}

/** Stable digest used by portability and archive provenance checks. */
export function contextPackProvenanceDigest(value: unknown): string {
  const json = JSON.stringify(value);
  return createHash("sha256").update(json, "utf8").digest("hex");
}
