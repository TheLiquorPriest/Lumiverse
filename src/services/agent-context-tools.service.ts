import { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import type { AgentInspectionWriterV1 } from "./agent-activity-runs.service";
import {
  getContextAccountRevision,
  listContextPackAccountCandidateMetadata,
  listContextPackCandidateMetadata,
  readContextPackAccessMetadata,
  readContextPackAccountAccessMetadata,
  readContextPackRevisionForUser,
} from "./agent-context-packs.service";
import type {
  ContextPackAccountCandidateMetadata,
  ContextPackAccountCandidateMetadataSnapshot,
  ContextPackAccountCandidateOmission,
  ContextPackCandidateMetadata,
  ContextPackCandidateMetadataSnapshot,
  ContextPackCandidateOmission,
  ContextPackCandidateScope,
} from "./agent-context-packs.service";
import type { ContextPackTargetScope } from "../types/agent-context-packs";
import {
  AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES,
  AGENT_RESULT_MAX_BYTES,
  utf8ByteLength,
} from "./agent-runtime-accounting";

/** Context candidates are frozen at ASSEMBLE; WORK cannot widen this set. */
export const CONTEXT_PACK_CANDIDATE_MAX = 128;
export const CONTEXT_PACK_SCOPE_MAX = 64;
export const CONTEXT_PACK_LIST_LIMIT_MAX = 32;
export const CONTEXT_PACK_GET_LIMIT_MAX = 16;
export const CONTEXT_PACK_RECORD_MAX = 512;
export const CONTEXT_PACK_ID_MAX_BYTES = 128;
export const CONTEXT_PACK_LABEL_MAX_BYTES = 512;
export const CONTEXT_PACK_REVISION_MAX_BYTES = 4 * 1024;
export const CONTEXT_PACK_DESCRIPTION_MAX_BYTES = 8 * 1024;
export const CONTEXT_PACK_RECORD_ID_MAX_BYTES = 128;
export const CONTEXT_PACK_RECORD_MAX_BYTES = 64 * 1024;
export const CONTEXT_PACK_RESULT_MAX_BYTES = AGENT_RESULT_MAX_BYTES;
export const CONTEXT_PACK_CONTEXT_MAX_BYTES = AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES;
export const CONTEXT_PACK_PAGE_OFFSET_MAX = 1_000_000;
/** Active cognition requirements are append-only for the lifetime of a turn. */
export interface ContextPackActivationRequirementV1 {
  readonly ruleId: string | null;
  readonly source: "attachment" | "rule" | "direct";
  readonly packId: string;
  readonly revisionId: string;
  readonly digest: string | null;
  readonly required: boolean;
}

export interface ContextPackActiveCandidateSetV1 {
  readonly contextPackRequirements: readonly ContextPackActivationRequirementV1[];
  readonly newlyActivatedContextPackRequirements?: readonly ContextPackActivationRequirementV1[];
}

type ContextRevision = number | string;
export type ContextPackSource = "account" | "preset" | "chat" | "world_book";
export type ContextPackRequirement = "required" | "optional";
export type ContextToolId = "context_pack_list" | "context_pack_get";

export type ContextPackTargetId = string | null;
export type ContextPackAttachmentId = string | null;

export type ContextToolErrorCode =
  | "invalid_arguments"
  | "context_pack_not_found"
  | "context_access_denied"
  | "context_access_invalidated"
  | "context_pack_limit_exceeded"
  | "cancelled"
  | "internal_error";

export interface ContextPackCandidateV1 {
  readonly ownerId: string;
  readonly packId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly label: string;
  readonly summary?: string;
  readonly source: ContextPackSource;
  readonly targetId: ContextPackTargetId;
  readonly attachmentId: ContextPackAttachmentId;
  readonly attachmentRevision: ContextRevision | null;
  readonly aclRevision: ContextRevision;
  readonly byteCount: number;
  readonly tokenCount: number;
  /** Policy requirement is frozen by the host, never model-authored. */
  readonly required: boolean;
  /** Stable policy/attachment order from the ASSEMBLE snapshot. */
  readonly order: number;
}

export type ContextPackCandidateInputV1 = Omit<ContextPackCandidateV1, "order" | "required"> & {
  readonly required?: boolean;
  readonly order?: number;
};

export interface ContextPackRecordV1 {
  readonly id: string;
  /** Literal authored/context bytes; never macro- or regex-processed. */
  readonly text: string;
  /** Optional whole-record fields retained by the account-store adapter. */
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly digest?: string;
}

export interface ContextPackRevisionContentV1 {
  readonly ownerId: string;
  readonly packId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly records: readonly ContextPackRecordV1[];
}

export interface ContextPackInputRevisionV1 {
  readonly kind: "context_pack";
  readonly ownerId: string;
  readonly packId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly source: ContextPackSource;
  readonly targetId: ContextPackTargetId;
  readonly attachmentId: ContextPackAttachmentId;
  readonly attachmentRevision: ContextRevision | null;
  readonly aclRevision: ContextRevision;
}


export interface ContextPackCandidateSnapshotV1 {
  readonly version: 1;
  readonly ownerId: string;
  readonly contextAclRevision: ContextRevision;
  readonly candidates: readonly ContextPackCandidateV1[];
  /** Complete frozen candidate identity set to merge into InputRevisionSetV1. */
  readonly candidateInputRevisions: readonly ContextPackInputRevisionV1[];
}

export interface ContextPackCandidateSnapshotInput {
  readonly ownerId: string;
  readonly contextAclRevision: ContextRevision;
  readonly candidates: readonly ContextPackCandidateInputV1[];
}

export interface ContextPackRevisionTracker {
  add(revision: ContextPackInputRevisionV1): void;
  snapshot(): readonly ContextPackInputRevisionV1[];
}

/** Mutable only by the host after an authorized get. */
export class ContextPackInputRevisionTracker implements ContextPackRevisionTracker {
  private readonly revisions = new Map<string, ContextPackInputRevisionV1>();

  add(revision: ContextPackInputRevisionV1): void {
    const normalized = normalizeInputRevision(revision);
    const key = inputRevisionKey(normalized);
    const previous = this.revisions.get(key);
    if (previous && !sameInputRevision(previous, normalized)) {
      throw new Error("context pack input revision conflict");
    }
    this.revisions.set(key, normalized);
  }

  snapshot(): readonly ContextPackInputRevisionV1[] {
    const values = [...this.revisions.values()]
      .sort(compareInputRevisions)
      .map((revision) => Object.freeze({ ...revision }));
    return Object.freeze(values);
  }
}

export interface ContextPackAccessRequestV1 {
  readonly ownerId: string;
  readonly candidate: ContextPackCandidateV1;
  readonly operation: "list" | "get" | "commit";
  readonly signal?: AbortSignal;
}

export interface ContextPackAccessResultV1 {
  readonly allowed: boolean;
  /** Returned values let the gate detect attachment/ACL changes without exposing them. */
  readonly aclRevision?: ContextRevision;
  readonly attachmentRevision?: ContextRevision | null;
}

export interface ContextPackReadRequestV1 {
  readonly ownerId: string;
  readonly candidate: ContextPackCandidateV1;
  readonly signal?: AbortSignal;
}

/** Revision identity used by COMMIT; it never carries record bytes. */
export interface ContextPackRevisionIdentityV1 {
  readonly ownerId: string;
  readonly packId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly digest: string;
}

/** Adapter implemented by the account-owned context-pack service. */
export interface ContextPackReaderV1 {
  currentAclRevision(ownerId: string, signal?: AbortSignal): Promise<ContextRevision>;
  checkAccess(request: ContextPackAccessRequestV1): Promise<ContextPackAccessResultV1>;
  readRevision(request: ContextPackReadRequestV1): Promise<ContextPackRevisionContentV1 | null>;
  currentRevisionIdentity?(
    request: ContextPackReadRequestV1,
  ): Promise<ContextPackRevisionIdentityV1 | null>;
}

export interface ContextInvalidationReasonV1 {
  readonly kind: "acl_revision" | "attachment_revision" | "pack_revision";
  readonly ownerId: string;
  readonly packId?: string;
  /** Pack revision ID for pack_revision; attachment ID for attachment_revision. */
  readonly revisionId?: string;
}

export interface ContextInvalidationSinkV1 {
  /** Invalidate frozen InputRevisionSet and any one-turn decision. */
  invalidateInput(reason: ContextInvalidationReasonV1): void;
  /** Invalidate Agentic readiness; called once per frozen turn. */
  invalidateReadiness(reason: ContextInvalidationReasonV1): void;
}

export type ContextGateDecisionV1 =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly errorCode: ContextToolErrorCode;
      readonly nonDisclosure: boolean;
    };

/**
 * Central operation gate for frozen candidates. It is separate from CRUD and
 * is used for list, pre-read get, and the post-read ACL check.
 */
export class ContextPackAclOperationGate {
  private invalidated = false;

  public constructor(
    private readonly snapshot: ContextPackCandidateSnapshotV1,
    private readonly reader: ContextPackReaderV1,
    private readonly sink: ContextInvalidationSinkV1,
  ) {}

  get wasInvalidated(): boolean {
    return this.invalidated;
  }

  /** Check account-wide ACL revision without returning candidate metadata. */
  async checkSnapshot(signal?: AbortSignal): Promise<ContextGateDecisionV1> {
    if (signal?.aborted) return cancelledDecision();
    if (this.invalidated) return invalidatedDecision();
    let current: ContextRevision;
    try {
      current = await this.reader.currentAclRevision(this.snapshot.ownerId, signal);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return cancelledDecision();
      return internalDecision();
    }
    if (!sameRevision(current, this.snapshot.contextAclRevision)) {
      this.invalidate({ kind: "acl_revision", ownerId: this.snapshot.ownerId });
      return invalidatedDecision();
    }
    if (signal?.aborted) return cancelledDecision();
    return { allowed: true };
  }

  async authorize(
    candidate: ContextPackCandidateV1,
    requirement: ContextPackRequirement,
    operation: "list" | "get" | "commit",
    signal?: AbortSignal,
  ): Promise<ContextGateDecisionV1> {
    const snapshotDecision = await this.checkSnapshot(signal);
    if (!snapshotDecision.allowed) {
      if (snapshotDecision.errorCode === "cancelled" || snapshotDecision.errorCode === "internal_error") {
        return snapshotDecision;
      }
      return requirement === "required" ? snapshotDecision : nonDisclosureDecision();
    }
    if (signal?.aborted) return cancelledDecision();

    let access: ContextPackAccessResultV1;
    try {
      access = await this.reader.checkAccess({
        ownerId: this.snapshot.ownerId,
        candidate,
        operation,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return cancelledDecision();
      return internalDecision();
    }
    if (access.aclRevision !== undefined && !sameRevision(access.aclRevision, candidate.aclRevision)) {
      this.invalidate({
        kind: "acl_revision",
        ownerId: this.snapshot.ownerId,
        packId: candidate.packId,
        revisionId: candidate.revisionId,
      });
      return requirement === "required" ? invalidatedDecision() : nonDisclosureDecision();
    }
    if (
      candidate.source !== "account" &&
      candidate.attachmentId !== null &&
      access.attachmentRevision !== undefined &&
      !sameRevision(access.attachmentRevision, candidate.attachmentRevision)
    ) {
      this.invalidate({
        kind: "attachment_revision",
        ownerId: this.snapshot.ownerId,
        packId: candidate.packId,
        revisionId: candidate.attachmentId,
      });
      return requirement === "required" ? invalidatedDecision() : nonDisclosureDecision();
    }
    if (!access.allowed) {
      // A frozen candidate becoming unavailable is an invalidating change even
      // when this particular operation is optional.
      this.invalidate({
        kind: "acl_revision",
        ownerId: this.snapshot.ownerId,
        packId: candidate.packId,
        revisionId: candidate.revisionId,
      });
      return requirement === "required" ? invalidatedDecision() : nonDisclosureDecision();
    }
    return { allowed: true };
  }

  /** Mark a frozen revision that disappeared or changed digest as stale. */
  markRevisionInvalidated(candidate: ContextPackCandidateV1): void {
    this.markInputRevisionInvalidated(candidateInputRevision(candidate));
  }

  markInputRevisionInvalidated(revision: ContextPackInputRevisionV1): void {
    this.invalidate({
      kind: "pack_revision",
      ownerId: revision.ownerId,
      packId: revision.packId,
      revisionId: revision.revisionId,
    });
  }

  private invalidate(reason: ContextInvalidationReasonV1): void {
    if (this.invalidated) return;
    this.invalidated = true;
    this.sink?.invalidateInput(Object.freeze({ ...reason }));
    this.sink?.invalidateReadiness(Object.freeze({ ...reason }));
  }
}

export interface ContextPackToolBudgetV1 {
  tryReserve(resultBytes: number, contextBytes: number): boolean;
  readonly resultBytes: number;
  readonly contextBytes: number;
}

export interface ContextPackToolBudgetOptionsV1 {
  readonly maxResultBytes?: number;
  readonly maxContextBytes?: number;
}

/** Shared per-turn accounting for context-pack tool results and literal bytes. */
export class ContextPackToolBudget implements ContextPackToolBudgetV1 {
  private readonly resultLimit: number;
  private readonly contextLimit: number;
  private _resultBytes = 0;
  private _contextBytes = 0;

  public constructor(options: ContextPackToolBudgetOptionsV1 = {}) {
    this.resultLimit = boundedLimit(options.maxResultBytes, CONTEXT_PACK_RESULT_MAX_BYTES);
    this.contextLimit = boundedLimit(options.maxContextBytes, CONTEXT_PACK_CONTEXT_MAX_BYTES);
  }

  get resultBytes(): number {
    return this._resultBytes;
  }

  get contextBytes(): number {
    return this._contextBytes;
  }

  tryReserve(resultBytes: number, contextBytes: number): boolean {
    if (
      !Number.isSafeInteger(resultBytes) ||
      resultBytes < 0 ||
      !Number.isSafeInteger(contextBytes) ||
      contextBytes < 0
    ) {
      return false;
    }
    if (this._resultBytes + resultBytes > this.resultLimit) return false;
    if (this._contextBytes + contextBytes > this.contextLimit) return false;
    this._resultBytes += resultBytes;
    this._contextBytes += contextBytes;
    return true;
  }
}

export interface ContextToolInvocationOptionsV1 {
  readonly requirementFor?: (candidate: ContextPackCandidateV1) => ContextPackRequirement;
  readonly budget?: ContextPackToolBudgetV1;
  readonly revisionTracker?: ContextPackRevisionTracker;
  /** Required host sink invalidating InputRevisionSet and readiness on stale access. */
  readonly invalidationSink: ContextInvalidationSinkV1;
  /** Reuse one gate for WORK and the final COMMIT recheck. */
  readonly operationGate?: ContextPackAclOperationGate;
  /** Cognition-activated subset; omitted only for legacy callers that expose all frozen candidates. */
  readonly activeCandidates?: ContextPackActiveCandidateSetV1;
  /** Owner-only causal inspection; never exposed to the model. */
  readonly inspection?: AgentInspectionWriterV1;
}

/** Narrow capability injected into WORK; no database or callback chain is exposed. */
export interface ContextToolCapability {
  readonly operationGate: ContextPackAclOperationGate;
  readonly list: (args: unknown, signal?: AbortSignal) => Promise<ContextToolResult>;
  readonly get: (args: unknown, signal?: AbortSignal) => Promise<ContextToolResult>;
}

export interface ContextToolResult {
  readonly status: "success" | "error";
  readonly toolName: ContextToolId;
  readonly data?: unknown;
  readonly errorCode?: ContextToolErrorCode;
  readonly message?: string;
}

interface ParsedPage {
  readonly limit: number;
  readonly offset: number;
}

interface ParsedGet extends ParsedPage {
  readonly packId: string;
  readonly revisionId: string;
  readonly revision: number;
}

interface ContextPackListData {
  readonly candidates: readonly ContextPackMetadataV1[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly truncated: boolean;
}

interface ContextPackGetData {
  readonly packId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly records: readonly ContextPackRecordV1[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly truncated: boolean;
}

export interface ContextPackMetadataV1 {
  readonly packId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly label: string;
  readonly summary?: string;
  readonly source: ContextPackSource;
  readonly targetId: ContextPackTargetId;
  readonly attachmentId: ContextPackAttachmentId;
  readonly byteCount: number;
  readonly tokenCount: number;
}

export function freezeContextPackCandidateSnapshot(
  input: ContextPackCandidateSnapshotInput,
): ContextPackCandidateSnapshotV1 {
  const ownerId = boundedIdentifier(input.ownerId, "ownerId");
  const contextAclRevision = normalizeRevision(input.contextAclRevision, "contextAclRevision");
  if (!Array.isArray(input.candidates)) throw new Error("context candidates must be an array");
  if (input.candidates.length > CONTEXT_PACK_CANDIDATE_MAX) {
    throw new Error("context candidate limit exceeded");
  }

  const seen = new Set<string>();
  const candidates = input.candidates.map((candidate, index) => {
    const normalized = normalizeCandidate(candidate, ownerId, index);
    const key = candidateKey(normalized);
    if (seen.has(key)) {
      throw new Error("duplicate context candidate");
    }
    seen.add(key);
    return Object.freeze(normalized);
  });
  candidates.sort(compareCandidates);
  const frozenCandidates = Object.freeze(candidates);
  const candidateInputRevisions = Object.freeze(
    frozenCandidates.map((candidate) => Object.freeze(candidateInputRevision(candidate))),
  );
  return Object.freeze({
    version: 1 as const,
    ownerId,
    contextAclRevision,
    candidates: frozenCandidates,
    candidateInputRevisions,
  });
}
export interface ContextPackSnapshotScopeV1 {
  readonly scope: ContextPackTargetScope;
  readonly targetId: string;
}
export class ContextPackSnapshotAccessError extends Error {
  readonly code = "context_access_invalidated" as const;

  constructor(message: string) {
    super(message);
    this.name = "ContextPackSnapshotAccessError";
  }
}

/** Freeze the account service's currently attached, use-authorized candidates. */
export function snapshotContextPackCandidates(
  ownerId: string,
  scopes: readonly ContextPackSnapshotScopeV1[],
  db: Database = getDb(),
): ContextPackCandidateSnapshotV1 {
  const normalizedOwnerId = boundedIdentifier(ownerId, "ownerId");
  if (!Array.isArray(scopes) || scopes.length > CONTEXT_PACK_SCOPE_MAX) {
    throw new Error("context scope limit exceeded");
  }
  const normalizedScopes = scopes.map((scope, index) => {
    if (!scope || typeof scope !== "object") throw new Error(`invalid context scope ${index}`);
    if (scope.scope !== "preset" && scope.scope !== "chat" && scope.scope !== "world_book") {
      throw new Error(`invalid context scope ${index}`);
    }
    return Object.freeze({
      scope: scope.scope,
      targetId: boundedIdentifier(scope.targetId, `scopes[${index}].targetId`),
    });
  });
  const seenScopes = new Set<string>();
  const candidateScopes: ContextPackCandidateScope[] = [];
  for (const scope of normalizedScopes) {
    const scopeKey = JSON.stringify([scope.scope, scope.targetId]);
    if (seenScopes.has(scopeKey)) continue;
    seenScopes.add(scopeKey);
    candidateScopes.push(scope);
  }
  const metadataSnapshots: readonly ContextPackCandidateMetadataSnapshot[] =
    candidateScopes.length === 0
      ? [listContextPackCandidateMetadata(normalizedOwnerId, [], CONTEXT_PACK_CANDIDATE_MAX, db)]
      : candidateScopes.map((scope) =>
          listContextPackCandidateMetadata(
            normalizedOwnerId,
            [scope],
            CONTEXT_PACK_CANDIDATE_MAX,
            db,
          ),
        );
  const contextAclRevision = metadataSnapshots[0]?.contextAclRevision ?? 0;
  if (metadataSnapshots.some((snapshot) => snapshot.contextAclRevision !== contextAclRevision)) {
    throw new ContextPackSnapshotAccessError("context ACL changed during snapshot");
  }
  const metadata = metadataSnapshots.flatMap((snapshot) => snapshot.items);
  if (metadata.some(
    (item) => item.kind === "candidate" && item.aclRevision !== contextAclRevision,
  )) {
    throw new ContextPackSnapshotAccessError("context ACL changed during snapshot");
  }
  const requiredOmission = metadata.find(
    (item): item is ContextPackCandidateOmission => item.kind === "omission",
  );
  if (requiredOmission) {
    throw new ContextPackSnapshotAccessError("required context attachment is unavailable");
  }
  const candidateMetadata = metadata.filter(
    (item): item is ContextPackCandidateMetadata => item.kind === "candidate",
  );
  if (candidateMetadata.length > CONTEXT_PACK_CANDIDATE_MAX) {
    throw new Error("context candidate limit exceeded");
  }
  const candidates = candidateMetadata.map((candidate, index) => runtimeCandidateFromMetadata(candidate, index));
  return freezeContextPackCandidateSnapshot({
    ownerId: normalizedOwnerId,
    contextAclRevision,
    candidates,
  });
}

/** Build the narrow, owner-bound reader used by WORK list/get. */
export function createAccountContextPackReader(): ContextPackReaderV1 {
  return {
    currentAclRevision(ownerId, _signal) {
      return Promise.resolve(getContextAccountRevision(ownerId));
    },
    checkAccess({ ownerId, candidate }) {
      const access = readCandidateAccess(ownerId, candidate);
      if (!access) return Promise.resolve({ allowed: false });
      return Promise.resolve({
        allowed: true,
        aclRevision: access.aclRevision,
        attachmentRevision: access.attachmentRevision,
      });
    },
    currentRevisionIdentity({ ownerId, candidate }) {
      const access = readCandidateAccess(ownerId, candidate);
      if (!access) return Promise.resolve(null);
      return Promise.resolve({
        ownerId: access.ownerId,
        packId: access.packId,
        revisionId: contextPackRevisionId(access.packId, access.revision),
        revision: access.revision,
        digest: access.digest,
      });
    },
    readRevision({ ownerId, candidate }) {
      const revision = readContextPackRevisionForUser(ownerId, candidate.packId, candidate.revision);
      if (!revision || revision.contentDigest !== candidate.digest) return Promise.resolve(null);
      const records = revision.content.map((entry) =>
        Object.freeze({
          id: entry.id,
          text: entry.body,
          title: entry.title,
          tags: Object.freeze([...entry.tags]),
        }),
      );
      return Promise.resolve({
        ownerId: revision.userId,
        packId: revision.packId,
        revisionId: contextPackRevisionId(revision.packId, revision.revision),
        revision: revision.revision,
        digest: revision.contentDigest,
        records: Object.freeze(records),
      });
    },
  };
}
export interface ContextPackAccountCandidateSelectionV1 {
  readonly packId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly required?: boolean;
  readonly order?: number;
}

/** Freeze exact account-owned selections; no latest-revision fallback is allowed. */
export function snapshotContextPackAccountCandidates(
  ownerId: string,
  selections: readonly ContextPackAccountCandidateSelectionV1[],
  db: Database = getDb(),
): ContextPackCandidateSnapshotV1 {
  const normalizedOwnerId = boundedIdentifier(ownerId, "ownerId");
  if (!Array.isArray(selections) || selections.length > CONTEXT_PACK_CANDIDATE_MAX) {
    throw new Error("account context candidate limit exceeded");
  }
  const normalizedSelections = selections.map((selection, index) => {
    if (!selection || typeof selection !== "object") {
      throw new ContextPackSnapshotAccessError(`invalid account context selection ${index}`);
    }
    const packId = boundedIdentifier(selection.packId, `selections[${index}].packId`);
    const revision = boundedPositiveInteger(selection.revision, `selections[${index}].revision`);
    const revisionId = boundedIdentifier(selection.revisionId, `selections[${index}].revisionId`);
    if (revisionId !== contextPackRevisionId(packId, revision)) {
      throw new ContextPackSnapshotAccessError("account context revision identity mismatch");
    }
    const digest = boundedDigest(selection.digest, `selections[${index}].digest`);
    return Object.freeze({
      packId,
      revision,
      revisionId,
      digest,
      required: selection.required !== false,
      order: selection.order ?? index,
    });
  });
  const metadataSnapshot: ContextPackAccountCandidateMetadataSnapshot =
    listContextPackAccountCandidateMetadata(
      normalizedOwnerId,
      normalizedSelections.map(({ packId, revision, digest, required, order }) => ({
        packId,
        revision,
        digest,
        required,
        order,
      })),
      db,
    );
  if (getContextAccountRevision(normalizedOwnerId, db) !== metadataSnapshot.contextAclRevision) {
    throw new ContextPackSnapshotAccessError("context ACL changed during snapshot");
  }
  const requiredOmission = metadataSnapshot.items.find(
    (item): item is ContextPackAccountCandidateOmission => item.kind === "omission",
  );
  if (requiredOmission) {
    throw new ContextPackSnapshotAccessError("required account context pack is unavailable");
  }
  const candidates = metadataSnapshot.items
    .filter((item): item is ContextPackAccountCandidateMetadata => item.kind === "candidate")
    .map((candidate) => {
      const selection = normalizedSelections.find(
        (item) => item.packId === candidate.packId && item.revision === candidate.revision,
      );
      if (!selection || candidate.digest !== selection.digest) {
        throw new ContextPackSnapshotAccessError("account context revision identity mismatch");
      }
      return runtimeAccountCandidateFromMetadata(candidate, selection);
    });
  return freezeContextPackCandidateSnapshot({
    ownerId: normalizedOwnerId,
    contextAclRevision: metadataSnapshot.contextAclRevision,
    candidates,
  });
}


export function contextPackRevisionId(packId: string, revision: number): string {
  return `${packId}@${revision}`;
}

function runtimeCandidateFromMetadata(
  candidate: ContextPackCandidateMetadata,
  fallbackOrder: number,
): ContextPackCandidateInputV1 {
  return {
    ownerId: candidate.ownerId,
    packId: candidate.packId,

    revisionId: contextPackRevisionId(candidate.packId, candidate.revision),
    revision: candidate.revision,
    digest: candidate.digest,
    label: candidate.packName,
    summary: candidate.packDescription,
    source: candidate.source,
    targetId: candidate.targetId,
    attachmentId: candidate.attachmentId,
    attachmentRevision: candidate.attachmentRevision,
    aclRevision: candidate.aclRevision,
    byteCount: candidate.byteCount,
    tokenCount: candidate.tokenCount,
    required: candidate.required,
    order: candidate.position * 1_000 + fallbackOrder,
  };
}
function runtimeAccountCandidateFromMetadata(
  candidate: ContextPackAccountCandidateMetadata,
  selection: ContextPackAccountCandidateSelectionV1,
): ContextPackCandidateInputV1 {
  if (candidate.digest !== selection.digest || candidate.revision !== selection.revision) {
    throw new ContextPackSnapshotAccessError("account context revision identity mismatch");
  }
  return {
    ownerId: candidate.ownerId,
    packId: candidate.packId,
    revisionId: selection.revisionId,
    revision: candidate.revision,
    digest: candidate.digest,
    label: candidate.packName,
    summary: candidate.packDescription,
    source: "account",
    targetId: null,
    attachmentId: null,
    attachmentRevision: null,
    aclRevision: candidate.aclRevision,
    byteCount: candidate.byteCount,
    tokenCount: candidate.tokenCount,
    required: candidate.required,
    order: candidate.position,
  };
}

function readCandidateAccess(
  ownerId: string,
  candidate: ContextPackCandidateV1,
): ReturnType<typeof readContextPackAccessMetadata> {
  if (candidate.source === "account") {
    return readContextPackAccountAccessMetadata(
      ownerId,
      candidate.packId,
      candidate.revision,
      candidate.digest,
    );
  }
  if (candidate.targetId === null || candidate.attachmentId === null) return null;
  return readContextPackAccessMetadata(ownerId, {
    ownerId: candidate.ownerId,
    source: candidate.source,
    targetId: candidate.targetId,
    attachmentId: candidate.attachmentId,
    packId: candidate.packId,
    revision: candidate.revision,
  });
}
/** Merge host-prefetched attachment and cognition-selected candidates atomically. */
export function mergeContextPackCandidateSnapshots(
  snapshots: readonly ContextPackCandidateSnapshotV1[],
): ContextPackCandidateSnapshotV1 {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error("context candidate snapshots are required");
  }
  const first = snapshots[0];
  if (!first) throw new Error("context candidate snapshots are required");
  const candidates: ContextPackCandidateInputV1[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot || snapshot.version !== 1) throw new Error("invalid context candidate snapshot");
    if (
      snapshot.ownerId !== first.ownerId ||
      !sameRevision(snapshot.contextAclRevision, first.contextAclRevision)
    ) {
      throw new ContextPackSnapshotAccessError("context candidate snapshots changed during merge");
    }
    candidates.push(...snapshot.candidates);
  }
  return freezeContextPackCandidateSnapshot({
    ownerId: first.ownerId,
    contextAclRevision: first.contextAclRevision,
    candidates,
  });
}
export interface HostPrefetchedAgentContextSnapshotInputV1 {
  readonly ownerId: string;
  readonly targetScopes: readonly ContextPackSnapshotScopeV1[];
  /** Exact frozen cognition selections; attached candidates are covered locally. */
  readonly selections: readonly ContextPackAccountCandidateSelectionV1[];
  readonly db?: Database;
}

/** Build one authenticated, ACL-consistent candidate snapshot for ASSEMBLE. */
export function buildHostPrefetchedAgentContextSnapshot(
  input: HostPrefetchedAgentContextSnapshotInputV1,
): ContextPackCandidateSnapshotV1 {
  if (!input || typeof input !== "object") throw new Error("context snapshot input is required");
  const ownerId = boundedIdentifier(input.ownerId, "ownerId");
  if (!Array.isArray(input.selections) || input.selections.length > CONTEXT_PACK_CANDIDATE_MAX) {
    throw new Error("context selection limit exceeded");
  }
  const db = input.db ?? getDb();
  const attachments = snapshotContextPackCandidates(ownerId, input.targetScopes, db);
  const uncovered: ContextPackAccountCandidateSelectionV1[] = [];
  const selectionPolicies = new Map<string, { required: boolean; order: number }>();
  for (const [index, selection] of input.selections.entries()) {
    if (!selection || typeof selection !== "object") {
      throw new ContextPackSnapshotAccessError(`invalid context selection ${index}`);
    }
    const packId = boundedIdentifier(selection.packId, `selections[${index}].packId`);
    const revision = boundedPositiveInteger(selection.revision, `selections[${index}].revision`);
    const revisionId = boundedIdentifier(selection.revisionId, `selections[${index}].revisionId`);
    const digest = boundedDigest(selection.digest, `selections[${index}].digest`);
    if (revisionId !== contextPackRevisionId(packId, revision)) {
      throw new ContextPackSnapshotAccessError("context revision identity mismatch");
    }
    const selectionKey = `${packId}\u0000${revisionId}\u0000${digest}`;
    const required = selection.required !== false;
    const order = selection.order ?? index;
    if (selectionPolicies.has(selectionKey)) {
      throw new ContextPackSnapshotAccessError("duplicate context selection");
    }
    selectionPolicies.set(selectionKey, { required, order });
    const attachedRevisions = attachments.candidates.filter(
      (candidate) => candidate.packId === packId && candidate.revisionId === revisionId,
    );
    if (attachedRevisions.length > 0) {
      if (!attachedRevisions.some((candidate) => candidate.digest === digest)) {
        throw new ContextPackSnapshotAccessError("context revision identity mismatch");
      }
      continue;
    }
    uncovered.push(Object.freeze({
      packId,
      revisionId,
      revision,
      digest,
      // Preserve policy requiredness through metadata lookup. Optional
      // cognition-rule candidates may be absent without aborting ASSEMBLE.
      required,
      order,
    }));
  }
  const account = snapshotContextPackAccountCandidates(ownerId, uncovered, db);
  const accountCandidates = account.candidates.map((candidate) => {
    const policy = selectionPolicies.get(contextCandidateActivationKey(candidate));
    if (!policy) throw new ContextPackSnapshotAccessError("account context selection disappeared");
    return Object.freeze({ ...candidate, required: policy.required, order: policy.order });
  });
  const accountPolicySnapshot = freezeContextPackCandidateSnapshot({
    ownerId,
    contextAclRevision: account.contextAclRevision,
    candidates: accountCandidates,
  });
  return mergeContextPackCandidateSnapshots([attachments, accountPolicySnapshot]);
}





function contextActivationKey(requirement: ContextPackActivationRequirementV1): string {
  return `${requirement.packId}\u0000${requirement.revisionId}`;
}

function contextCandidateActivationKey(candidate: ContextPackCandidateV1): string {
  return `${candidate.packId}\u0000${candidate.revisionId}\u0000${candidate.digest}`;
}

function normalizeActiveCandidateRequirement(
  requirement: unknown,
): ContextPackActivationRequirementV1 {
  if (!requirement || typeof requirement !== "object") {
    throw new Error("invalid active context candidate");
  }
  const value = requirement as Partial<ContextPackActivationRequirementV1>;
  if (value.source !== "attachment" && value.source !== "rule" && value.source !== "direct") {
    throw new Error("invalid active context source");
  }
  if (value.source === "rule") {
    if (typeof value.ruleId !== "string") throw new Error("active rule context requires ruleId");
  } else if (value.ruleId !== null) {
    throw new Error("non-rule active context cannot carry ruleId");
  }
  const ruleId = value.ruleId === null ? null : boundedIdentifier(value.ruleId, "active.ruleId");
  const packId = boundedIdentifier(value.packId, "active.packId");
  const revisionId = boundedIdentifier(value.revisionId, "active.revisionId");
  const digest = value.digest === null ? null : boundedDigest(value.digest, "active.digest");
  if (typeof value.required !== "boolean") throw new Error("invalid active context requirement");
  return Object.freeze({
    ruleId,
    source: value.source,
    packId,
    revisionId,
    digest,
    required: value.required,
  });
}

function sameActiveCandidateRequirement(
  left: ContextPackActivationRequirementV1,
  right: ContextPackActivationRequirementV1,
): boolean {
  return (
    left.ruleId === right.ruleId &&
    left.source === right.source &&
    left.packId === right.packId &&
    left.revisionId === right.revisionId &&
    left.digest === right.digest &&
    left.required === right.required
  );
}

function normalizeActiveCandidateSet(
  active: ContextPackActiveCandidateSetV1 | undefined,
): ReadonlyMap<string, ContextPackActivationRequirementV1> | undefined {
  if (!active) return undefined;
  if (!Array.isArray(active.contextPackRequirements) || active.contextPackRequirements.length > CONTEXT_PACK_CANDIDATE_MAX) {
    throw new Error("active context candidate limit exceeded");
  }
  if (
    active.newlyActivatedContextPackRequirements !== undefined &&
    (!Array.isArray(active.newlyActivatedContextPackRequirements) ||
      active.newlyActivatedContextPackRequirements.length > CONTEXT_PACK_CANDIDATE_MAX)
  ) {
    throw new Error("active context candidate limit exceeded");
  }
  const entries = new Map<string, ContextPackActivationRequirementV1>();
  for (const rawRequirement of active.contextPackRequirements) {
    const requirement = normalizeActiveCandidateRequirement(rawRequirement);
    const key = contextActivationKey(requirement);
    if (entries.has(key)) throw new Error("duplicate active context candidate");
    entries.set(key, requirement);
  }
  for (const rawRequirement of active.newlyActivatedContextPackRequirements ?? []) {
    const requirement = normalizeActiveCandidateRequirement(rawRequirement);
    const key = contextActivationKey(requirement);
    const prior = entries.get(key);
    if (!prior || !sameActiveCandidateRequirement(prior, requirement)) {
      throw new Error("new active context candidate is not an exact append-only entry");
    }
  }
  return entries;
}

type ContextInspectionWriter = {
  readonly record: (kind: "tool" | "condition", value?: unknown, state?: unknown) => unknown;
};

const CONTEXT_INSPECTION_SECRET_KEY = /(?:secret|credential|password|authorization|token|api[_-]?key|private[_-]?key)/i;

function contextInspectionRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeContextInspectionValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[bounded]";
  if (typeof value === "string") return value.length > 16_384 ? `${value.slice(0, 16_384)}…` : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => safeContextInspectionValue(item, depth + 1));
  if (!contextInspectionRecord(value)) return "[unavailable]";
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[-\s]/g, "_");
    if (
      CONTEXT_INSPECTION_SECRET_KEY.test(normalized)
      || normalized === "otheruserdata"
      || normalized === "other_user_data"
    ) continue;
    result[key] = safeContextInspectionValue(item, depth + 1);
  }
  return result;
}

function contextInspectionJson(value: unknown): string {
  try {
    const json = JSON.stringify(safeContextInspectionValue(value));
    if (typeof json !== "string") return "[unavailable]";
    return json.length > 16_384 ? `${json.slice(0, 16_384)}…` : json;
  } catch {
    return "[unavailable]";
  }
}

function contextInspectionRecordId(value: unknown): string | undefined {
  if (!contextInspectionRecord(value) || !Array.isArray(value.transcript)) return undefined;
  const record = value.transcript[value.transcript.length - 1];
  return contextInspectionRecord(record) && typeof record.id === "string" ? record.id : undefined;
}

function contextInspectionErrorReason(errorCode: ContextToolErrorCode | undefined): string | undefined {
  if (!errorCode) return undefined;
  if (errorCode === "cancelled") return "interrupted";
  if (errorCode === "invalid_arguments") return "invalid_input";
  if (errorCode === "context_access_invalidated") return "stale_input";
  if (errorCode === "context_pack_limit_exceeded") return "budget_exhausted";
  if (errorCode === "context_pack_not_found" || errorCode === "context_access_denied") return "unavailable";
  return "tool_failure";
}

function recordContextCondition(
  writer: ContextInspectionWriter | undefined,
  toolName: ContextToolId,
  parentId: string | undefined,
  value: unknown,
): void {
  try {
    writer?.record("condition", {
      ...(parentId ? { id: `${parentId}:condition` } : {}),
      kind: "condition",
      actor: "host",
      recipient: "tool",
      toolId: toolName,
      content: `context gate decision: ${toolName}`,
      result: contextInspectionJson(value),
      correlation: {
        actorId: "host",
        recipientId: "tool",
        toolId: toolName,
        ...(parentId ? { parentId } : {}),
      },
    });
  } catch {
    // Inspection persistence must not change the authorized tool result.
  }
}


async function traceContextToolCall(
  writer: ContextInspectionWriter | undefined,
  toolName: ContextToolId,
  args: unknown,
  invoke: () => Promise<ContextToolResult>,
): Promise<ContextToolResult> {
  let requestId: string | undefined;
  try {
    requestId = contextInspectionRecordId(writer?.record("tool", {
      kind: "tool",
      actor: "agent",
      recipient: "tool",
      toolId: toolName,
      content: `tool request: ${toolName}`,
      arguments: contextInspectionJson(args),
      correlation: { actorId: "agent", recipientId: "tool", toolId: toolName },
    }));
  } catch {
    requestId = undefined;
  }
  try {
    const result = await invoke();
    try {
      writer?.record("tool", {
        ...(requestId ? { id: `${requestId}:result` } : {}),
        kind: "tool",
        actor: "tool",
        recipient: "agent",
        toolId: toolName,
        content: `tool result: ${toolName}`,
        result: contextInspectionJson(result),
        correlation: {
          actorId: "tool",
          recipientId: "agent",
          toolId: toolName,
          ...(requestId ? { parentId: requestId } : {}),
        },
        ...(result.errorCode ? { errorReason: contextInspectionErrorReason(result.errorCode) } : {}),
      });
    } catch {
      // Inspection persistence must not change the authorized tool result.
    }
    recordContextCondition(writer, toolName, requestId, {
      status: result.status,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
    return result;
  } catch (error) {
    try {
      writer?.record("tool", {
        ...(requestId ? { id: `${requestId}:error` } : {}),
        kind: "tool",
        actor: "tool",
        recipient: "agent",
        toolId: toolName,
        result: contextInspectionJson(error instanceof Error ? { name: error.name } : { type: typeof error }),
        errorReason: "tool_failure",
        correlation: {
          actorId: "tool",
          recipientId: "agent",
          toolId: toolName,
          ...(requestId ? { parentId: requestId } : {}),
        },
      });
    } catch {
      // Inspection persistence must not change the authorized tool error.
    }
    recordContextCondition(writer, toolName, requestId, {
      status: "error",
      error: error instanceof Error ? { name: error.name } : { type: typeof error },
    });
    throw error;
  }
}

export function createContextToolCapability(
  snapshot: ContextPackCandidateSnapshotV1,
  reader: ContextPackReaderV1,
  options: ContextToolInvocationOptionsV1,
): ContextToolCapability {
  const gate =
    options.operationGate ?? new ContextPackAclOperationGate(snapshot, reader, options.invalidationSink);
  const activeRequirements = normalizeActiveCandidateSet(options.activeCandidates);
  const activeRequirementFor = (candidate: ContextPackCandidateV1): ContextPackActivationRequirementV1 | undefined => {
    const requirement = activeRequirements?.get(`${candidate.packId}\u0000${candidate.revisionId}`);
    if (!requirement) return undefined;
    if (requirement.digest !== null && requirement.digest !== candidate.digest) return undefined;
    if (
      candidate.source === "account" &&
      (requirement.source === "attachment" || requirement.source === "rule")
    ) {
      return undefined;
    }
    return requirement;
  };
  const requirementFor =
    options.requirementFor ??
    ((candidate: ContextPackCandidateV1) => (candidate.required ? "required" : "optional"));
  const budget = options.budget ?? new ContextPackToolBudget();
  const writer = (options as ContextToolInvocationOptionsV1 & {
    readonly inspection?: ContextInspectionWriter;
  }).inspection;
  return Object.freeze({
    operationGate: gate,
    list: (args: unknown, signal?: AbortSignal): Promise<ContextToolResult> =>
      traceContextToolCall(writer, "context_pack_list", args, async () => {
      const parsed = parsePage(args, CONTEXT_PACK_LIST_LIMIT_MAX);
      if (!parsed) return errorResult("context_pack_list", "invalid_arguments");
      const page = parsed;
      if (activeRequirements && activeRequirements.size === 0) {
        const data: ContextPackListData = {
          candidates: Object.freeze([]),
          total: 0,
          limit: page.limit,
          offset: page.offset,
          truncated: false,
        };
        return reserveAndSuccess("context_pack_list", data, 0, budget);
      }
      const snapshotDecision = await gate.checkSnapshot(signal);
      if (!snapshotDecision.allowed) return mapGateResult("context_pack_list", snapshotDecision, "optional");
      const visible: ContextPackCandidateV1[] = [];
      for (const candidate of snapshot.candidates) {
        if (activeRequirements && !activeRequirementFor(candidate)) continue;
        const decision = await gate.authorize(candidate, "optional", "list", signal);
        if (!decision.allowed) {
          if (decision.errorCode === "cancelled" || decision.errorCode === "internal_error") {
            return mapGateResult("context_pack_list", decision, "optional");
          }
          continue;
        }
        visible.push(candidate);
      }
      const finalSnapshotDecision = await gate.checkSnapshot(signal);
      if (!finalSnapshotDecision.allowed) {
        return mapGateResult("context_pack_list", finalSnapshotDecision, "optional");
      }
      // Do not return a partial list after an ACL/attachment race.
      if (gate.wasInvalidated) return notFoundResult("context_pack_list");
      const pageItems = visible.slice(page.offset, page.offset + page.limit);
      const data: ContextPackListData = {
        candidates: Object.freeze(pageItems.map(projectMetadata)),
        total: visible.length,
        limit: page.limit,
        offset: page.offset,
        truncated: page.offset + pageItems.length < visible.length,
      };
      console.error("[agentic] context_pack_list", { total: data.total, packIds: pageItems.map((item) => item.packId) });
      return reserveAndSuccess("context_pack_list", data, 0, budget);
      }),

    get: (args: unknown, signal?: AbortSignal): Promise<ContextToolResult> =>
      traceContextToolCall(writer, "context_pack_get", args, async () => {
      const parsed = parseGet(args);
      if (!parsed) {
        console.error("[agentic] context_pack_get invalid_arguments", args);
        return errorResult("context_pack_get", "invalid_arguments");
      }
      if (signal?.aborted) return errorResult("context_pack_get", "cancelled");
      const candidate = snapshot.candidates.find(
        (item) =>
          item.packId === parsed.packId &&
          item.revisionId === parsed.revisionId &&
          item.revision === parsed.revision &&
          (!activeRequirements || activeRequirementFor(item) !== undefined),
      );
      if (!candidate) {
        console.error("[agentic] context_pack_get not_found", parsed);
        return notFoundResult("context_pack_get");
      }
      const activeRequirement = activeRequirementFor(candidate);
      const requirement = candidate.required || activeRequirement?.required || requirementFor(candidate) === "required"
        ? "required"
        : "optional";
      const before = await gate.authorize(candidate, requirement, "get", signal);
      if (!before.allowed) return mapGateResult("context_pack_get", before, requirement);
      if (signal?.aborted) return errorResult("context_pack_get", "cancelled");

      let content: ContextPackRevisionContentV1 | null;
      try {
        content = await reader.readRevision({ ownerId: snapshot.ownerId, candidate, signal });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return errorResult("context_pack_get", "cancelled");
        return errorResult("context_pack_get", "internal_error");
      }
      if (!content) {
        gate.markRevisionInvalidated(candidate);
        return requirement === "required"
          ? errorResult("context_pack_get", "context_access_invalidated")
          : notFoundResult("context_pack_get");
      }

      // This check is intentionally after the read and before any bytes are returned.
      const after = await gate.authorize(candidate, requirement, "get", signal);
      if (!after.allowed) return mapGateResult("context_pack_get", after, requirement);
      const validation = validateContent(content, candidate);
      if (!validation.valid) {
        if (validation.invalidated) {
          gate.markRevisionInvalidated(candidate);
          return requirement === "required"
            ? errorResult("context_pack_get", "context_access_invalidated")
            : notFoundResult("context_pack_get");
        }
        return errorResult(
          "context_pack_get",
          validation.limitExceeded ? "context_pack_limit_exceeded" : "internal_error",
        );
      }
      const pageItems = validation.records.slice(parsed.offset, parsed.offset + parsed.limit);
      const contextBytes = pageItems.reduce((total, record) => total + recordByteCount(record), 0);
      const data: ContextPackGetData = {
        packId: candidate.packId,
        revisionId: candidate.revisionId,
        revision: candidate.revision,
        digest: candidate.digest,
        records: Object.freeze(pageItems.map((record) => Object.freeze({ ...record }))),
        total: validation.records.length,
        limit: parsed.limit,
        offset: parsed.offset,
        truncated: parsed.offset + pageItems.length < validation.records.length,
      };
      const result = reserveAndSuccess("context_pack_get", data, contextBytes, budget);
      if (result.status === "success") options.revisionTracker?.add(candidateInputRevision(candidate));
      return result;
      }),
  });
}

/** Recheck every consumed pack revision immediately before COMMIT. */
export async function recheckContextPackInputRevisionsAtCommit(
  snapshot: ContextPackCandidateSnapshotV1,
  reader: ContextPackReaderV1,
  tracker: ContextPackRevisionTracker,
  invalidationSink: ContextInvalidationSinkV1,
  signal?: AbortSignal,
  operationGate?: ContextPackAclOperationGate,
): Promise<ContextGateDecisionV1> {
  const gate =
    operationGate ?? new ContextPackAclOperationGate(snapshot, reader, invalidationSink);
  const snapshotDecision = await gate.checkSnapshot(signal);
  if (!snapshotDecision.allowed) return snapshotDecision;
  for (const revision of tracker.snapshot()) {
    const candidate = snapshot.candidates.find(
      (item) =>
        item.ownerId === revision.ownerId &&
        item.packId === revision.packId &&
        item.revisionId === revision.revisionId &&
        item.revision === revision.revision &&
        item.digest === revision.digest &&
        item.attachmentId === revision.attachmentId &&
        sameRevision(item.attachmentRevision, revision.attachmentRevision) &&
        sameRevision(item.aclRevision, revision.aclRevision),
    );
    if (!candidate) {
      gate.markInputRevisionInvalidated(revision);
      return invalidatedDecision();
    }
    const decision = await gate.authorize(candidate, "required", "commit", signal);
    if (!decision.allowed) return decision;
    let identity: ContextPackRevisionIdentityV1 | null;
    try {
      if (reader.currentRevisionIdentity) {
        identity = await reader.currentRevisionIdentity({
          ownerId: snapshot.ownerId,
          candidate,
          signal,
        });
      } else {
        const content = await reader.readRevision({
          ownerId: snapshot.ownerId,
          candidate,
          signal,
        });
        identity = content ? revisionIdentityFromContent(content) : null;
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return cancelledDecision();
      return internalDecision();
    }
    if (!identity || !sameRevisionIdentity(identity, candidate)) {
      gate.markRevisionInvalidated(candidate);
      return invalidatedDecision();
    }
    const postIdentity = await gate.authorize(candidate, "required", "commit", signal);
    if (!postIdentity.allowed) return postIdentity;
  }
  return { allowed: true };
}

function normalizeCandidate(
  candidate: ContextPackCandidateInputV1,
  ownerId: string,
  fallbackOrder: number,
): ContextPackCandidateV1 {
  if (!candidate || typeof candidate !== "object") throw new Error("invalid context candidate");
  const candidateOwner = boundedIdentifier(candidate.ownerId, "candidate.ownerId");
  const source = candidate.source;
  if (source !== "account" && candidateOwner !== ownerId) {
    throw new Error("context candidate owner mismatch");
  }
  const summary =
    candidate.summary === undefined
      ? undefined
      : boundedText(candidate.summary, CONTEXT_PACK_DESCRIPTION_MAX_BYTES, "candidate.summary");
  if (source !== "account" && source !== "preset" && source !== "chat" && source !== "world_book") {
    throw new Error("invalid context candidate source");
  }
  const isAccount = source === "account";
  if (isAccount) {
    if (candidate.targetId !== null || candidate.attachmentId !== null || candidate.attachmentRevision !== null) {
      throw new Error("account context candidate cannot have an attachment or target");
    }
  } else if (
    typeof candidate.targetId !== "string" ||
    typeof candidate.attachmentId !== "string" ||
    candidate.attachmentRevision === null
  ) {
    throw new Error("attached context candidate requires target and attachment identity");
  }
  const required = candidate.required === undefined ? false : candidate.required;
  if (typeof required !== "boolean") throw new Error("invalid candidate.required");
  const order = candidate.order === undefined ? fallbackOrder : boundedCount(candidate.order, "candidate.order");
  const packId = boundedIdentifier(candidate.packId, "candidate.packId");
  const revision = boundedPositiveInteger(candidate.revision, "candidate.revision");
  const revisionId = boundedIdentifier(candidate.revisionId, "candidate.revisionId");
  if (isAccount && revisionId !== contextPackRevisionId(packId, revision)) {
    throw new Error("account context revision identity mismatch");
  }
  const digest = boundedDigest(candidate.digest, "candidate.digest");
  return {
    ownerId: candidateOwner,
    packId,
    revisionId,
    revision,
    digest,
    label: boundedText(candidate.label, CONTEXT_PACK_LABEL_MAX_BYTES, "candidate.label"),
    ...(summary === undefined ? {} : { summary }),
    source,
    targetId: isAccount ? null : boundedIdentifier(candidate.targetId, "candidate.targetId"),
    attachmentId: isAccount ? null : boundedIdentifier(candidate.attachmentId, "candidate.attachmentId"),
    attachmentRevision: isAccount
      ? null
      : normalizeRevision(candidate.attachmentRevision, "candidate.attachmentRevision"),
    aclRevision: normalizeRevision(candidate.aclRevision, "candidate.aclRevision"),
    byteCount: boundedCount(candidate.byteCount, "candidate.byteCount"),
    tokenCount: boundedCount(candidate.tokenCount, "candidate.tokenCount"),
    required,
    order,
  };
}

function normalizeInputRevision(revision: ContextPackInputRevisionV1): ContextPackInputRevisionV1 {
  const source = revision.source;
  if (source !== "account" && source !== "preset" && source !== "chat" && source !== "world_book") {
    throw new Error("invalid revision.source");
  }
  const isAccount = source === "account";
  if (isAccount) {
    if (revision.targetId !== null || revision.attachmentId !== null || revision.attachmentRevision !== null) {
      throw new Error("account revision cannot have attachment or target");
    }
  } else if (
    typeof revision.targetId !== "string" ||
    typeof revision.attachmentId !== "string" ||
    revision.attachmentRevision === null
  ) {
    throw new Error("attached revision requires target and attachment identity");
  }
  const ownerId = boundedIdentifier(revision.ownerId, "revision.ownerId");
  const packId = boundedIdentifier(revision.packId, "revision.packId");
  const revisionId = boundedIdentifier(revision.revisionId, "revision.revisionId");
  const revisionNumber = boundedPositiveInteger(revision.revision, "revision.revision");
  if (isAccount && revisionId !== contextPackRevisionId(packId, revisionNumber)) {
    throw new Error("account context revision identity mismatch");
  }
  const digest = boundedDigest(revision.digest, "revision.digest");
  return Object.freeze({
    kind: "context_pack" as const,
    ownerId,
    packId,
    revisionId,
    revision: revisionNumber,
    digest,
    source,
    targetId: isAccount ? null : boundedIdentifier(revision.targetId, "revision.targetId"),
    attachmentId: isAccount ? null : boundedIdentifier(revision.attachmentId, "revision.attachmentId"),
    attachmentRevision: isAccount
      ? null
      : normalizeRevision(revision.attachmentRevision, "revision.attachmentRevision"),
    aclRevision: normalizeRevision(revision.aclRevision, "revision.aclRevision"),
  });
}

function candidateInputRevision(candidate: ContextPackCandidateV1): ContextPackInputRevisionV1 {
  return normalizeInputRevision({
    kind: "context_pack",
    ownerId: candidate.ownerId,
    packId: candidate.packId,
    revisionId: candidate.revisionId,
    revision: candidate.revision,
    digest: candidate.digest,
    source: candidate.source,
    targetId: candidate.targetId,
    attachmentId: candidate.attachmentId,
    attachmentRevision: candidate.attachmentRevision,
    aclRevision: candidate.aclRevision,
  });
}
function revisionIdentityFromContent(
  content: ContextPackRevisionContentV1,
): ContextPackRevisionIdentityV1 {
  return Object.freeze({
    ownerId: content.ownerId,
    packId: content.packId,
    revisionId: content.revisionId,
    revision: content.revision,
    digest: content.digest,
  });
}

function sameRevisionIdentity(
  identity: ContextPackRevisionIdentityV1,
  candidate: ContextPackCandidateV1,
): boolean {
  return (
    identity.ownerId === candidate.ownerId &&
    identity.packId === candidate.packId &&
    identity.revisionId === candidate.revisionId &&
    identity.revision === candidate.revision &&
    identity.digest === candidate.digest
  );
}
function validateContent(
  content: ContextPackRevisionContentV1,
  candidate: ContextPackCandidateV1,
):
  | { valid: true; records: readonly ContextPackRecordV1[] }
  | { valid: false; invalidated: boolean; limitExceeded: boolean } {
  if (
    content.ownerId !== candidate.ownerId ||
    content.packId !== candidate.packId ||
    content.revisionId !== candidate.revisionId ||
    content.revision !== candidate.revision ||
    content.digest !== candidate.digest
  ) {
    return { valid: false, invalidated: true, limitExceeded: false };
  }
  if (!Array.isArray(content.records)) {
    return { valid: false, invalidated: false, limitExceeded: true };
  }
  if (content.records.length > CONTEXT_PACK_RECORD_MAX) {
    return { valid: false, invalidated: false, limitExceeded: true };
  }
  try {
    const seen = new Set<string>();
    const records: ContextPackRecordV1[] = [];
    for (const record of content.records) {
      if (!record || typeof record !== "object") {
        return { valid: false, invalidated: false, limitExceeded: false };
      }
      const id = boundedIdentifier(record.id, "record.id", CONTEXT_PACK_RECORD_ID_MAX_BYTES);
      if (seen.has(id)) return { valid: false, invalidated: false, limitExceeded: false };
      seen.add(id);
      if (typeof record.text !== "string" || utf8ByteLength(record.text) > CONTEXT_PACK_RECORD_MAX_BYTES) {
        return { valid: false, invalidated: false, limitExceeded: true };
      }
      const text = boundedText(record.text, CONTEXT_PACK_RECORD_MAX_BYTES, "record.text");
      const title =
        record.title === undefined
          ? undefined
          : boundedText(record.title, CONTEXT_PACK_LABEL_MAX_BYTES, "record.title");
      const tags = record.tags === undefined ? undefined : boundedTags(record.tags);
      const digest = record.digest === undefined ? undefined : boundedDigest(record.digest, "record.digest");
      records.push(
        Object.freeze({
          id,
          text,
          ...(title === undefined ? {} : { title }),
          ...(tags === undefined ? {} : { tags }),
          ...(digest === undefined ? {} : { digest }),
        }),
      );
    }
    return { valid: true, records: Object.freeze(records) };
  } catch {
    return { valid: false, invalidated: false, limitExceeded: false };
  }
}

function parsePage(value: unknown, maxLimit: number): ParsedPage | null {
  const record = plainRecord(value);
  if (!record || !exactKeys(record, ["limit", "offset"])) return null;
  const limit = record.limit === undefined ? 20 : parseInteger(record.limit, 1, maxLimit);
  const offset = record.offset === undefined ? 0 : parseInteger(record.offset, 0, CONTEXT_PACK_PAGE_OFFSET_MAX);
  if (limit === null || offset === null) return null;
  return { limit, offset };
}
function boundedTags(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("invalid record.tags");
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of value) {
    const normalized = boundedText(tag, 64, "record.tags");
    if (seen.has(normalized)) throw new Error("duplicate record.tags");
    seen.add(normalized);
    tags.push(normalized);
  }
  return Object.freeze(tags);
}

function recordByteCount(record: ContextPackRecordV1): number {
  let bytes =
    utf8ByteLength(record.id) +
    utf8ByteLength(record.text) +
    (record.digest === undefined ? 0 : utf8ByteLength(record.digest));
  if (record.title !== undefined) bytes += utf8ByteLength(record.title);
  if (record.tags !== undefined) {
    for (const tag of record.tags) bytes += utf8ByteLength(tag);
  }
  return bytes;
}

function parseGet(value: unknown): ParsedGet | null {
  const record = plainRecord(value);
  if (!record) return null;
  if (!exactKeys(record, ["pack_id", "revision_id", "revision", "limit", "offset", "packId", "revisionId"])) return null;
  const packId = parseIdentifier(record.pack_id ?? record.packId);
  const revisionId = parseIdentifier(record.revision_id ?? record.revisionId);
  const revision = parseInteger(record.revision, 1, Number.MAX_SAFE_INTEGER);
  const limit = record.limit === undefined ? 16 : parseInteger(record.limit, 1, CONTEXT_PACK_GET_LIMIT_MAX);
  const offset = record.offset === undefined ? 0 : parseInteger(record.offset, 0, CONTEXT_PACK_PAGE_OFFSET_MAX);
  if (!packId || !revisionId || revision === null || limit === null || offset === null) return null;
  return { packId, revisionId, revision, limit, offset };
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.every((key) => allowed.includes(key));
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function projectMetadata(candidate: ContextPackCandidateV1): ContextPackMetadataV1 {
  return Object.freeze({
    packId: candidate.packId,
    revisionId: candidate.revisionId,
    revision: candidate.revision,
    digest: candidate.digest,
    label: candidate.label,
    ...(candidate.summary === undefined ? {} : { summary: candidate.summary }),
    source: candidate.source,
    targetId: candidate.targetId,
    attachmentId: candidate.attachmentId,
    byteCount: candidate.byteCount,
    tokenCount: candidate.tokenCount,
  });
}

function reserveAndSuccess(
  toolName: ContextToolId,
  data: unknown,
  contextBytes: number,
  budget: ContextPackToolBudgetV1,
): ContextToolResult {
  let resultBytes: number;
  try {
    resultBytes = utf8ByteLength(JSON.stringify(data));
  } catch {
    return errorResult(toolName, "internal_error");
  }
  if (!budget.tryReserve(resultBytes, contextBytes)) {
    return errorResult(toolName, "context_pack_limit_exceeded");
  }
  return Object.freeze({ status: "success" as const, toolName, data });
}

function mapGateResult(
  toolName: ContextToolId,
  decision: Exclude<ContextGateDecisionV1, { allowed: true }>,
  requirement: ContextPackRequirement,
): ContextToolResult {
  if (decision.errorCode === "cancelled") return errorResult(toolName, "cancelled");
  if (decision.errorCode === "internal_error") return errorResult(toolName, "internal_error");
  if (decision.errorCode === "context_access_invalidated") {
    return requirement === "required" ? errorResult(toolName, "context_access_invalidated") : notFoundResult(toolName);
  }
  if (decision.errorCode === "context_access_denied") {
    return requirement === "required" ? errorResult(toolName, "context_access_denied") : notFoundResult(toolName);
  }
  return errorResult(toolName, decision.errorCode);
}

function errorResult(toolName: ContextToolId, errorCode: ContextToolErrorCode): ContextToolResult {
  const message =
    errorCode === "context_pack_not_found"
      ? "Context pack is unavailable."
      : errorCode === "context_access_invalidated"
        ? "Context access changed during this turn."
        : errorCode === "context_access_denied"
          ? "Context access is not authorized."
          : errorCode === "context_pack_limit_exceeded"
            ? "Context pack limits were exceeded."
            : undefined;
  return Object.freeze({
    status: "error" as const,
    toolName,
    errorCode,
    ...(message === undefined ? {} : { message }),
  });
}

function notFoundResult(toolName: ContextToolId): ContextToolResult {
  return errorResult(toolName, "context_pack_not_found");
}

function cancelledDecision(): ContextGateDecisionV1 {
  return { allowed: false, errorCode: "cancelled", nonDisclosure: false };
}

function internalDecision(): ContextGateDecisionV1 {
  return { allowed: false, errorCode: "internal_error", nonDisclosure: false };
}

function invalidatedDecision(): ContextGateDecisionV1 {
  return { allowed: false, errorCode: "context_access_invalidated", nonDisclosure: true };
}


function nonDisclosureDecision(): ContextGateDecisionV1 {
  return { allowed: false, errorCode: "context_pack_not_found", nonDisclosure: true };
}

function candidateKey(candidate: ContextPackCandidateV1): string {
  return JSON.stringify([candidate.packId, candidate.revisionId, candidate.attachmentId]);
}


function inputRevisionKey(revision: ContextPackInputRevisionV1): string {
  return JSON.stringify([revision.ownerId, revision.packId, revision.revisionId, revision.attachmentId]);
}

function sameInputRevision(
  left: ContextPackInputRevisionV1,
  right: ContextPackInputRevisionV1,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.packId === right.packId &&
    left.revisionId === right.revisionId &&
    left.revision === right.revision &&
    left.digest === right.digest &&
    left.attachmentId === right.attachmentId &&
    sameRevision(left.attachmentRevision, right.attachmentRevision) &&
    sameRevision(left.aclRevision, right.aclRevision)
  );
}

function compareInputRevisions(
  left: ContextPackInputRevisionV1,
  right: ContextPackInputRevisionV1,
): number {
  return (
    left.packId.localeCompare(right.packId) ||
    left.revisionId.localeCompare(right.revisionId) ||
    (left.attachmentId ?? "").localeCompare(right.attachmentId ?? "")
  );
}

function compareCandidates(left: ContextPackCandidateV1, right: ContextPackCandidateV1): number {
  const leftCategory = left.source === "account" ? 1 : 0;
  const rightCategory = right.source === "account" ? 1 : 0;
  return leftCategory - rightCategory
    || left.order - right.order
    || candidateKey(left).localeCompare(candidateKey(right));
}

function sameRevision(left: ContextRevision | null, right: ContextRevision | null): boolean {
  return left === null || right === null
    ? left === right
    : typeof left === typeof right && left === right;
}

function normalizeRevision(value: unknown, path: string): ContextRevision {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${path}`);
    return value;
  }
  if (typeof value === "string" && value.length > 0 && utf8ByteLength(value) <= CONTEXT_PACK_REVISION_MAX_BYTES) {
    return value;
  }
  throw new Error(`invalid ${path}`);
}

function boundedIdentifier(value: unknown, path: string, maxBytes = CONTEXT_PACK_ID_MAX_BYTES): string {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > maxBytes) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function parseIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > CONTEXT_PACK_ID_MAX_BYTES) {
    return null;
  }
  return value;
}

function boundedText(value: unknown, maxBytes: number, path: string): string {
  if (typeof value !== "string" || utf8ByteLength(value) > maxBytes) throw new Error(`invalid ${path}`);
  return value;
}

function boundedDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > 128) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function boundedPositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`invalid ${path}`);
  return value as number;
}

function boundedCount(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_648) {
    throw new Error(`invalid ${path}`);
  }
  return value as number;
}

function parseInteger(value: unknown, min: number, max: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : null;
}

function boundedLimit(value: number | undefined, maximum: number): number {
  const selected = value ?? maximum;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > maximum) {
    throw new Error("context pack budget exceeds host ceiling");
  }
  return selected;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "aborted");
}
