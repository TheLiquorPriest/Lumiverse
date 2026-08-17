import { createHash } from "node:crypto";

export const AGENT_CONTEXT_PACK_PORTABLE_VERSION = 1 as const;
export const AGENT_CONTEXT_PACK_MAX_NAME_BYTES = 200;
export const AGENT_CONTEXT_PACK_MAX_DESCRIPTION_BYTES = 8 * 1024;
export const AGENT_CONTEXT_PACK_MAX_ENTRIES = 256;
export const AGENT_CONTEXT_PACK_MAX_ENTRY_ID_BYTES = 128;
export const AGENT_CONTEXT_PACK_MAX_ENTRY_TITLE_BYTES = 256;
export const AGENT_CONTEXT_PACK_MAX_ENTRY_BODY_BYTES = 256 * 1024;
export const AGENT_CONTEXT_PACK_MAX_ENTRY_TAGS = 32;
export const AGENT_CONTEXT_PACK_MAX_TAG_BYTES = 64;
export const AGENT_CONTEXT_PACK_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const AGENT_CONTEXT_PACK_MAX_PROVENANCE_BYTES = 16 * 1024;

const encoder = new TextEncoder();

export type ContextPackVisibility = "private" | "account" | "restricted";
export type ContextPackState = "active" | "disabled" | "review_required" | "repair_required";
export type ContextPackRevisionState = ContextPackState;
export type ContextPackPermission = "read" | "use" | "edit";
export type ContextPackTargetScope = "preset" | "chat" | "world_book";

export interface ContextPackEntryV1 {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

export interface ContextPackProvenanceV1 {
  readonly kind: "local" | "portable_import" | "archive_restore" | "same_account_duplicate";
  readonly sourceDigest?: string;
  readonly sourcePackId?: string;
  readonly archiveId?: string;
}

export interface AgentContextPack {
  readonly userId: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: ContextPackVisibility;
  readonly state: ContextPackState;
  readonly latestRevision: number;
  readonly contextAclRevision: number;
  readonly provenance: ContextPackProvenanceV1;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentContextPackRevision {
  readonly userId: string;
  readonly packId: string;
  readonly revision: number;
  readonly content: readonly ContextPackEntryV1[];
  readonly contentDigest: string;
  readonly tokenCount: number;
  readonly byteCount: number;
  readonly state: ContextPackRevisionState;
  readonly provenance: ContextPackProvenanceV1;
  readonly createdAt: number;
  readonly createdBy: string;
}

export interface ContextPackAclEntry {
  readonly principalUserId: string;
  readonly permission: ContextPackPermission;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface ContextPackAttachment {
  readonly userId: string;
  readonly attachmentId: string;
  readonly scope: ContextPackTargetScope;
  readonly targetId: string;
  readonly packId: string;
  readonly revision: number;
  readonly position: number;
  readonly required: boolean;
  readonly state: ContextPackState;
  readonly provenance: ContextPackProvenanceV1;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Portable bytes contain a selected immutable revision, never ACLs or live attachments. */
export interface PortableContextPackSnapshotV1 {
  readonly portableVersion: typeof AGENT_CONTEXT_PACK_PORTABLE_VERSION;
  readonly snapshotId: string;
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  readonly content: readonly ContextPackEntryV1[];
  readonly contentDigest: string;
  readonly tokenCount: number;
  readonly byteCount: number;
}

export interface PortableContextPackImportResult {
  readonly pack: AgentContextPack;
  readonly revision: AgentContextPackRevision;
  readonly attached: false;
  readonly reviewRequired: true;
}

export interface CreateContextPackInput {
  readonly name: string;
  readonly description?: string;
  readonly visibility?: ContextPackVisibility;
  readonly content: unknown;
  readonly provenance?: ContextPackProvenanceV1;
}

export interface CreateContextPackRevisionInput {
  readonly content: unknown;
  readonly expectedRevision?: number;
  readonly provenance?: ContextPackProvenanceV1;
}

export interface ContextPackAttachmentInput {
  readonly scope: ContextPackTargetScope;
  readonly targetId: string;
  readonly revision: number;
  readonly position?: number;
  readonly required?: boolean;
  readonly provenance?: ContextPackProvenanceV1;
  readonly expectedContextAclRevision?: number;
}

export interface ContextPackListOptions {
  readonly includeDisabled?: boolean;
  readonly includeReviewRequired?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export class ContextPackValidationError extends Error {
  readonly code = "CONTEXT_PACK_INVALID" as const;
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ContextPackValidationError";
    this.path = path;
  }
}

export class ContextPackRevisionConflictError extends Error {
  readonly code = "CONTEXT_PACK_REVISION_CONFLICT" as const;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Context pack changed since revision ${expectedRevision}; current revision is ${actualRevision}`);
    this.name = "ContextPackRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}
export class ContextPackAclRevisionConflictError extends Error {
  readonly code = "CONTEXT_PACK_ACL_REVISION_CONFLICT" as const;
  readonly expectedContextAclRevision: number;
  readonly actualContextAclRevision: number;

  constructor(expectedContextAclRevision: number, actualContextAclRevision: number) {
    super(`Context pack access changed since account revision ${expectedContextAclRevision}; current revision is ${actualContextAclRevision}`);
    this.name = "ContextPackAclRevisionConflictError";
    this.expectedContextAclRevision = expectedContextAclRevision;
    this.actualContextAclRevision = actualContextAclRevision;
  }
}


export class ContextPackImmutableError extends Error {
  readonly code = "CONTEXT_PACK_REVISION_IMMUTABLE" as const;

  constructor() {
    super("Context pack revisions are immutable; create a new revision");
    this.name = "ContextPackImmutableError";
  }
}

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function ensureString(value: unknown, path: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new ContextPackValidationError(path, allowEmpty ? "must be a string" : "must be a non-empty string");
  }
  const bytes = utf8Bytes(value);
  if (bytes > maxBytes) throw new ContextPackValidationError(path, `exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

function parseTags(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new ContextPackValidationError(path, "must be an array");
  if (value.length > AGENT_CONTEXT_PACK_MAX_ENTRY_TAGS) {
    throw new ContextPackValidationError(path, `contains more than ${AGENT_CONTEXT_PACK_MAX_ENTRY_TAGS} tags`);
  }
  const seen = new Set<string>();
  return value.map((tag, index) => {
    const parsed = ensureString(tag, `${path}[${index}]`, AGENT_CONTEXT_PACK_MAX_TAG_BYTES);
    if (seen.has(parsed)) throw new ContextPackValidationError(`${path}[${index}]`, "duplicate tag");
    seen.add(parsed);
    return parsed;
  });
}

export function normalizeContextPackContent(value: unknown): readonly ContextPackEntryV1[] {
  if (!Array.isArray(value)) throw new ContextPackValidationError("content", "must be an array");
  if (value.length > AGENT_CONTEXT_PACK_MAX_ENTRIES) {
    throw new ContextPackValidationError("content", `contains more than ${AGENT_CONTEXT_PACK_MAX_ENTRIES} entries`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const entries = value.map((raw, index): ContextPackEntryV1 => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ContextPackValidationError(`content[${index}]`, "must be an object");
    }
    const object = raw as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (keys.join(",") !== "body,id,tags,title") {
      throw new ContextPackValidationError(`content[${index}]`, "contains unknown or missing fields");
    }
    const id = ensureString(object.id, `content[${index}].id`, AGENT_CONTEXT_PACK_MAX_ENTRY_ID_BYTES);
    if (seen.has(id)) throw new ContextPackValidationError(`content[${index}].id`, "duplicate entry id");
    seen.add(id);
    const title = ensureString(object.title, `content[${index}].title`, AGENT_CONTEXT_PACK_MAX_ENTRY_TITLE_BYTES, true);
    const body = ensureString(object.body, `content[${index}].body`, AGENT_CONTEXT_PACK_MAX_ENTRY_BODY_BYTES, true);
    const tags = parseTags(object.tags, `content[${index}].tags`);
    totalBytes += utf8Bytes(id) + utf8Bytes(title) + utf8Bytes(body) + tags.reduce((sum, tag) => sum + utf8Bytes(tag), 0);
    if (totalBytes > AGENT_CONTEXT_PACK_MAX_TOTAL_BYTES) {
      throw new ContextPackValidationError("content", `exceeds ${AGENT_CONTEXT_PACK_MAX_TOTAL_BYTES} UTF-8 bytes`);
    }
    return { id, title, body, tags };
  });
  return entries;
}

export function serializeContextPackContent(content: readonly ContextPackEntryV1[]): string {
  // normalizeContextPackContent fixes field order and rejects extra keys. Keep
  // this JSON shape stable: its bytes are the content-addressed revision.
  return JSON.stringify(content.map((entry) => ({
    id: entry.id,
    title: entry.title,
    body: entry.body,
    tags: [...entry.tags],
  })));
}

export function hashContextPackContent(serializedContent: string): string {
  return createHash("sha256").update(serializedContent, "utf8").digest("hex");
}

export function estimateContextPackTokens(serializedContent: string): number {
  return Math.ceil(utf8Bytes(serializedContent) / 4);
}

export function parsePortableContextPackSnapshotV1(value: unknown): PortableContextPackSnapshotV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextPackValidationError("snapshot", "must be an object");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const expected = "byteCount,content,contentDigest,description,name,portableVersion,revision,snapshotId,tokenCount";
  if (keys.join(",") !== expected) {
    throw new ContextPackValidationError("snapshot", "contains unknown or missing fields");
  }
  if (object.portableVersion !== AGENT_CONTEXT_PACK_PORTABLE_VERSION) {
    throw new ContextPackValidationError("snapshot.portableVersion", "unsupported portable version");
  }
  const name = ensureString(object.name, "snapshot.name", AGENT_CONTEXT_PACK_MAX_NAME_BYTES);
  const description = ensureString(object.description, "snapshot.description", AGENT_CONTEXT_PACK_MAX_DESCRIPTION_BYTES, true);
  const revision = object.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new ContextPackValidationError("snapshot.revision", "must be a positive integer");
  }
  const content = normalizeContextPackContent(object.content);
  const serialized = serializeContextPackContent(content);
  const contentDigest = ensureString(object.contentDigest, "snapshot.contentDigest", 64);
  if (!/^[0-9a-f]{64}$/.test(contentDigest)) {
    throw new ContextPackValidationError("snapshot.contentDigest", "must be a lowercase SHA-256 digest");
  }
  if (hashContextPackContent(serialized) !== contentDigest) {
    throw new ContextPackValidationError("snapshot.contentDigest", "does not match content");
  }
  const byteCount = object.byteCount;
  const tokenCount = object.tokenCount;
  if (!Number.isSafeInteger(byteCount) || byteCount !== utf8Bytes(serialized)) {
    throw new ContextPackValidationError("snapshot.byteCount", "does not match content bytes");
  }
  if (!Number.isSafeInteger(tokenCount) || tokenCount !== estimateContextPackTokens(serialized)) {
    throw new ContextPackValidationError("snapshot.tokenCount", "does not match content tokens");
  }
  const snapshotId = ensureString(object.snapshotId, "snapshot.snapshotId", 128);
  const legacySnapshotId = createPortableContextPackSnapshotId(contentDigest, revision as number);
  if (snapshotId !== legacySnapshotId && !/^pack-[0-9a-f]{64}$/.test(snapshotId)) {
    throw new ContextPackValidationError("snapshot.snapshotId", "does not match a portable revision identity");
  }
  return {
    portableVersion: AGENT_CONTEXT_PACK_PORTABLE_VERSION,
    snapshotId,
    name,
    description,
    revision: revision as number,
    content,
    contentDigest,
    tokenCount: tokenCount as number,
    byteCount: byteCount as number,
  };
}

export function createPortableContextPackSnapshotId(
  contentDigest: string,
  revision: number,
  sourceIdentity?: string,
): string {
  const identity = sourceIdentity === undefined
    ? `${contentDigest}:${revision}`
    : `pack:${sourceIdentity}:${contentDigest}:${revision}`;
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return sourceIdentity === undefined ? digest : `pack-${digest}`;
}
