import { createHash } from "node:crypto";
import type {
  AgenticReadinessVectorV1,
  RuntimeRevision,
} from "../types/agent-runtime-decision";
export type { AgenticReadinessVectorV1 } from "../types/agent-runtime-decision";
import {
  COGNITION_MAX_LIST_BYTES,
  COGNITION_MAX_LIST_ITEMS,
  COGNITION_MAX_PREDICATE_DEPTH,
  COGNITION_MAX_PREDICATE_NODES,
  COGNITION_MAX_STRING_BYTES,
  AgentCognitionValidationError,
} from "../types/agent-cognition";
import { freezeCognitionGraph, parseCognitionGraph } from "./agent-cognition.service";

/**
 * Stable owner-facing reasons. These values are deliberately independent of
 * SQL messages, parser wording, and provider errors: a repair UI can safely
 * persist/translate them and the runtime can use exactly one primary reason.
 */
export const COGNITION_REPAIR_CODES = [
  "cognition_invalid",
  "cognition_repair_required",
  "cognition_missing_block_revision",
  "cognition_missing_pack_revision",
  "cognition_deleted_attachment",
  "cognition_predicate_limit_exceeded",
  "cognition_authorization_stale",
  "cognition_import_review_required",
  "cognition_foreign_authority_blocked",
] as const;

export type CognitionRepairCode = (typeof COGNITION_REPAIR_CODES)[number];

/** Stable error codes for explicit repair writes. */
export const COGNITION_REPAIR_WRITE_CODES = [
  "cognition_repair_unauthorized",
  "cognition_repair_confirmation_required",
  "cognition_repair_revision_conflict",
  "cognition_repair_invalid",
] as const;

export type CognitionRepairWriteCode = (typeof COGNITION_REPAIR_WRITE_CODES)[number];

export type CognitionSourceKind = "local" | "legacy" | "imported" | "foreign";

export interface CognitionBlockRevisionRefV1 {
  readonly blockId: string;
  readonly expectedRevision?: RuntimeRevision | null;
  readonly actualRevision?: RuntimeRevision | null;
  readonly exists?: boolean;
  readonly deleted?: boolean;
}

export interface CognitionPackRevisionRefV1 {
  readonly packId: string;
  readonly expectedRevision?: RuntimeRevision | null;
  readonly actualRevision?: RuntimeRevision | null;
  readonly exists?: boolean;
  readonly deleted?: boolean;
  readonly authorized?: boolean;
}

export interface CognitionAttachmentRefV1 {
  readonly attachmentId: string;
  readonly packId?: string | null;
  readonly exists?: boolean;
  readonly deleted?: boolean;
  readonly authorized?: boolean;
  readonly expectedAclRevision?: RuntimeRevision | null;
  readonly actualAclRevision?: RuntimeRevision | null;
}

export interface CognitionPredicateStatsV1 {
  readonly depth?: number;
  readonly nodes?: number;
  readonly stringBytes?: number;
  readonly listBytes?: number;
  readonly listItems?: number;
}

export interface CognitionIntegritySnapshotV1 {
  /** Authenticated owner. A foreign owner is never inferred from payload data. */
  readonly userId: string;
  readonly presetId?: string | null;
  readonly cognition?: unknown;
  /** Frozen source snapshot required to verify Loom block revisions at preflight. */
  readonly cognitionSource?: unknown;
  readonly sourceSnapshot?: unknown;
  readonly source?: CognitionSourceKind;
  readonly sameAccount?: boolean;
  readonly importedReviewRequired?: boolean;
  readonly repairRequired?: boolean;
  readonly expectedCognitionRevision?: RuntimeRevision | null;
  readonly actualCognitionRevision?: RuntimeRevision | null;
  readonly expectedContextAclRevision?: RuntimeRevision | null;
  readonly actualContextAclRevision?: RuntimeRevision | null;
  readonly blockRefs?: readonly CognitionBlockRevisionRefV1[];
  readonly blocks?: readonly CognitionBlockRevisionRefV1[];
  readonly packRefs?: readonly CognitionPackRevisionRefV1[];
  readonly packs?: readonly CognitionPackRevisionRefV1[];
  readonly attachmentRefs?: readonly CognitionAttachmentRefV1[];
  readonly attachments?: readonly CognitionAttachmentRefV1[];
  readonly predicateStats?: CognitionPredicateStatsV1;
}

export interface CognitionIntegrityIssueV1 {
  readonly code: CognitionRepairCode;
  readonly subject?: string;
}

export interface CognitionValidationResultV1 {
  readonly valid: boolean;
  readonly agenticAllowed: boolean;
  /** Response mode is intentionally always available after this check. */
  readonly responseAvailable: true;
  /** One deterministic reason disables Agentic preflight. */
  readonly repairCode: CognitionRepairCode | null;
  readonly issues: readonly CognitionIntegrityIssueV1[];
  /** The authored payload is retained for authenticated repair; never dropped. */
  readonly preserved: true;
  readonly source: CognitionSourceKind;
  readonly importedReviewRequired: boolean;
  readonly scopeRevision: number;
}

export interface CognitionReadinessStateV1 {
  readonly cognitionRevision: RuntimeRevision;
  readonly contextAclRevision: RuntimeRevision;
  readonly scopeRevision: number;
  readonly agenticAllowed: boolean;
  readonly responseAvailable: true;
  readonly repairCode: CognitionRepairCode | null;
  readonly issues: readonly CognitionIntegrityIssueV1[];
}

export interface CognitionRepairRequestV1 {
  readonly authenticatedUserId: string | null | undefined;
  readonly ownerUserId: string;
  readonly explicitAction: "repair_cognition";
  readonly acknowledgement: true;
  readonly expectedScopeRevision: number;
  readonly expectedCognitionRevision?: RuntimeRevision | null;
  readonly expectedContextAclRevision?: RuntimeRevision | null;
}

export interface CognitionRepairResultV1 {
  readonly authorized: true;
  readonly validation: CognitionValidationResultV1;
  /** Repair does not silently activate Agentic; enabling remains a separate action. */
  readonly agenticActivationRequired: true;
}

export class CognitionRepairError extends Error {
  readonly code: CognitionRepairWriteCode;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;

  constructor(
    code: CognitionRepairWriteCode,
    message: string,
    revisions: { expected?: number; actual?: number } = {},
  ) {
    super(message);
    this.name = "CognitionRepairError";
    this.code = code;
    this.expectedRevision = revisions.expected;
    this.actualRevision = revisions.actual;
  }
}

/** Host ceilings for pure cognition input validation. They cannot be raised by authored data. */
export const COGNITION_LIMITS_V1 = Object.freeze({
  maxPredicateDepth: COGNITION_MAX_PREDICATE_DEPTH,
  maxPredicateNodes: COGNITION_MAX_PREDICATE_NODES,
  maxPredicateStringBytes: COGNITION_MAX_STRING_BYTES,
  maxPredicateListBytes: COGNITION_MAX_LIST_BYTES,
  maxPredicateListItems: COGNITION_MAX_LIST_ITEMS,
  maxIssueCount: 64,
});

const REPAIR_PRIORITY: readonly CognitionRepairCode[] = [
  "cognition_invalid",
  "cognition_repair_required",
  "cognition_missing_block_revision",
  "cognition_missing_pack_revision",
  "cognition_deleted_attachment",
  "cognition_predicate_limit_exceeded",
  "cognition_authorization_stale",
  "cognition_foreign_authority_blocked",
  "cognition_import_review_required",
];

const REPAIR_PRIORITY_INDEX = new Map<CognitionRepairCode, number>(
  REPAIR_PRIORITY.map((code, index) => [code, index]),
);
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}


function sameRevision(left: RuntimeRevision | null | undefined, right: RuntimeRevision | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  return Object.is(left, right);
}

function validRevision(value: unknown): value is RuntimeRevision {
  if (typeof value === "string") return value.length > 0 && value.length <= 1024;
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value);
}

function boundedSubject(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= 256 ? value : value.slice(0, 256);
}

function issue(code: CognitionRepairCode, subject?: unknown): CognitionIntegrityIssueV1 {
  const bounded = boundedSubject(subject);
  return bounded ? { code, subject: bounded } : { code };
}

function addIssue(
  issues: CognitionIntegrityIssueV1[],
  code: CognitionRepairCode,
  subject?: unknown,
): void {
  if (issues.length >= COGNITION_LIMITS_V1.maxIssueCount) return;
  const next = issue(code, subject);
  if (issues.some((entry) => entry.code === next.code && entry.subject === next.subject)) return;
  issues.push(next);
}

function primaryRepairCode(issues: readonly CognitionIntegrityIssueV1[]): CognitionRepairCode | null {
  let selected: CognitionRepairCode | null = null;
  let selectedIndex = Number.POSITIVE_INFINITY;
  for (const entry of issues) {
    const index = REPAIR_PRIORITY_INDEX.get(entry.code) ?? Number.POSITIVE_INFINITY;
    if (index < selectedIndex) {
      selected = entry.code;
      selectedIndex = index;
    }
  }
  return selected;
}

function sourceOf(snapshot: CognitionIntegritySnapshotV1): CognitionSourceKind {
  return snapshot.source === "legacy" || snapshot.source === "imported" || snapshot.source === "foreign"
    ? snapshot.source
    : "local";
}

function listOf<T>(first: readonly T[] | undefined, second: readonly T[] | undefined): readonly T[] {
  return first ?? second ?? [];
}

function checkRevisionRef(
  issues: CognitionIntegrityIssueV1[],
  ref: CognitionBlockRevisionRefV1 | CognitionPackRevisionRefV1,
  code: "cognition_missing_block_revision" | "cognition_missing_pack_revision",
): void {
  const subject = "blockId" in ref ? ref.blockId : ref.packId;
  if (typeof subject !== "string" || subject.length === 0) {
    addIssue(issues, "cognition_invalid", subject);
    return;
  }
  if (ref.expectedRevision === undefined || ref.expectedRevision === null || !validRevision(ref.expectedRevision)) {
    addIssue(issues, code, subject);
    return;
  }
  if (ref.exists === false || ref.deleted === true || ref.actualRevision === null || ref.actualRevision === undefined) {
    addIssue(issues, code, subject);
    return;
  }
  if (!validRevision(ref.actualRevision) || !sameRevision(ref.expectedRevision, ref.actualRevision)) {
    addIssue(issues, code, subject);
  }
  if ("authorized" in ref && ref.authorized === false) {
    addIssue(issues, "cognition_authorization_stale", subject);
  }
}

function checkPredicateStats(
  issues: CognitionIntegrityIssueV1[],
  stats: CognitionPredicateStatsV1 | undefined,
): void {
  if (stats === undefined) return;
  if (!isPlainRecord(stats)) {
    addIssue(issues, "cognition_invalid");
    return;
  }
  const limits: readonly [keyof CognitionPredicateStatsV1, number][] = [
    ["depth", COGNITION_LIMITS_V1.maxPredicateDepth],
    ["nodes", COGNITION_LIMITS_V1.maxPredicateNodes],
    ["stringBytes", COGNITION_LIMITS_V1.maxPredicateStringBytes],
    ["listBytes", COGNITION_LIMITS_V1.maxPredicateListBytes],
    ["listItems", COGNITION_LIMITS_V1.maxPredicateListItems],
  ];
  for (const [key, limit] of limits) {
    const value = stats[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      addIssue(issues, "cognition_invalid", key);
      continue;
    }
    if (value > limit) addIssue(issues, "cognition_predicate_limit_exceeded", key);
  }
}
function checkCognitionGraph(
  issues: CognitionIntegrityIssueV1[],
  snapshot: CognitionIntegritySnapshotV1,
): void {
  if (snapshot.cognition === undefined || snapshot.cognition === null || !isPlainRecord(snapshot.cognition)) return;
  const graphKeys = ["version", "policies", "templates", "contextRules"];
  if (!graphKeys.some((key) => Object.prototype.hasOwnProperty.call(snapshot.cognition, key))) return;
  const sourceValue = snapshot.cognitionSource ?? snapshot.sourceSnapshot;
  try {
    const graph = parseCognitionGraph(snapshot.cognition);
    const hasPolicyRefs = Object.values(graph.policies).some((refs) => refs.length > 0);
    if (hasPolicyRefs && sourceValue === undefined) {
      addIssue(issues, "cognition_missing_block_revision", "policies");
      return;
    }
    if (sourceValue !== undefined) freezeCognitionGraph(snapshot.cognition, sourceValue);
  } catch (error) {
    if (!(error instanceof AgentCognitionValidationError)) {
      addIssue(issues, "cognition_invalid", "graph");
      return;
    }
    if (error.code === "limit_exceeded" || error.code === "fixed_point_limit_exceeded") {
      addIssue(issues, "cognition_predicate_limit_exceeded", error.path);
      return;
    }
    if (
      error.code === "revision_mismatch"
      || error.path.startsWith("policies")
      || error.path.startsWith("source")
    ) {
      addIssue(issues, "cognition_missing_block_revision", error.path);
      return;
    }
    addIssue(issues, "cognition_invalid", error.path);
  }
}


/**
 * Validate all host-visible cognition references without resolving ambient
 * state. The caller supplies one frozen snapshot; missing or stale references
 * are repair conditions, never silently removed.
 */
export function validateCognitionIntegrity(
  snapshot: CognitionIntegritySnapshotV1,
  scopeRevision = 0,
): CognitionValidationResultV1 {
  const issues: CognitionIntegrityIssueV1[] = [];
  const source = sourceOf(snapshot);
  if (typeof snapshot.userId !== "string" || snapshot.userId.length === 0) {
    addIssue(issues, "cognition_invalid", "userId");
  }
  if (snapshot.cognition !== undefined && snapshot.cognition !== null && !isPlainRecord(snapshot.cognition)) {
    addIssue(issues, "cognition_invalid", "cognition");
  }
  checkCognitionGraph(issues, snapshot);
  if (
    snapshot.expectedCognitionRevision !== undefined
    && snapshot.expectedCognitionRevision !== null
    && (!validRevision(snapshot.expectedCognitionRevision)
      || !validRevision(snapshot.actualCognitionRevision)
      || !sameRevision(snapshot.expectedCognitionRevision, snapshot.actualCognitionRevision))
  ) {
    addIssue(issues, "cognition_repair_required", "cognitionRevision");
  }
  if (
    snapshot.expectedContextAclRevision !== undefined
    && snapshot.expectedContextAclRevision !== null
    && (!validRevision(snapshot.actualContextAclRevision)
      || !sameRevision(snapshot.expectedContextAclRevision, snapshot.actualContextAclRevision))
  ) {
    addIssue(issues, "cognition_authorization_stale", "contextAclRevision");
  }

  for (const ref of listOf(snapshot.blockRefs, snapshot.blocks)) {
    if (!isPlainRecord(ref)) {
      addIssue(issues, "cognition_invalid", "blockRefs");
      continue;
    }
    checkRevisionRef(issues, ref, "cognition_missing_block_revision");
  }
  for (const ref of listOf(snapshot.packRefs, snapshot.packs)) {
    if (!isPlainRecord(ref)) {
      addIssue(issues, "cognition_invalid", "packRefs");
      continue;
    }
    checkRevisionRef(issues, ref, "cognition_missing_pack_revision");
  }
  for (const ref of listOf(snapshot.attachmentRefs, snapshot.attachments)) {
    if (!isPlainRecord(ref) || typeof ref.attachmentId !== "string" || ref.attachmentId.length === 0) {
      addIssue(issues, "cognition_invalid", "attachmentRefs");
      continue;
    }
    if (ref.exists === false || ref.deleted === true) {
      addIssue(issues, "cognition_deleted_attachment", ref.attachmentId);
    }
    if (ref.authorized === false) {
      addIssue(issues, "cognition_authorization_stale", ref.attachmentId);
    }
    if (
      ref.expectedAclRevision !== undefined
      && ref.expectedAclRevision !== null
      && (!validRevision(ref.actualAclRevision)
        || !sameRevision(ref.expectedAclRevision, ref.actualAclRevision))
    ) {
      addIssue(issues, "cognition_authorization_stale", ref.attachmentId);
    }
  }
  checkPredicateStats(issues, snapshot.predicateStats);

  if (snapshot.repairRequired === true) addIssue(issues, "cognition_repair_required");
  if (snapshot.importedReviewRequired === true) addIssue(issues, "cognition_import_review_required");
  if (source === "legacy" && snapshot.cognition !== undefined && snapshot.cognition !== null) {
    addIssue(issues, "cognition_import_review_required");
  }
  if ((source === "foreign" || (source === "imported" && snapshot.sameAccount !== true)) && snapshot.sameAccount !== true) {
    addIssue(issues, "cognition_foreign_authority_blocked");
  }

  const repairCode = primaryRepairCode(issues);
  return Object.freeze({
    valid: repairCode === null,
    agenticAllowed: repairCode === null,
    responseAvailable: true,
    repairCode,
    issues: Object.freeze(issues.slice()),
    preserved: true,
    source,
    importedReviewRequired: snapshot.importedReviewRequired === true
      || source === "legacy"
      || source === "foreign"
      || (source === "imported" && snapshot.sameAccount !== true),
    scopeRevision: Number.isSafeInteger(scopeRevision) && scopeRevision >= 0 ? scopeRevision : 0,
  });
}

function cloneImportedPayload(raw: unknown): unknown {
  if (!isPlainRecord(raw)) return raw;
  try {
    return structuredClone(raw);
  } catch {
    return { ...raw };
  }
}

export interface ImportedCognitionNormalizationV1 {
  readonly data: unknown;
  readonly source: "legacy" | "imported" | "foreign";
  readonly agentsEnabled: false;
  readonly reviewRequired: true;
  readonly authorityGranted: false;
  readonly liveAttachments: boolean;
  readonly preserved: true;
}

/**
 * Normalize legacy/foreign cognition at every non-archive ingress. Authored
 * fields and references remain available for repair; activation and live
 * attachment authority do not cross the import boundary.
 */
export function normalizeImportedCognition(
  raw: unknown,
  options: {
    source: "legacy" | "imported" | "foreign";
    sameAccount?: boolean;
    authorizedAttachmentIds?: readonly string[];
  } = { source: "foreign" },
): ImportedCognitionNormalizationV1 {
  const cloned = cloneImportedPayload(raw);
  const liveAttachments = options.source === "imported"
    && options.sameAccount === true
    && Array.isArray(options.authorizedAttachmentIds);
  const data = isPlainRecord(cloned)
    ? {
        ...cloned,
        agentsEnabled: false,
        enabled: false,
        reviewRequired: true,
        reviewState: "review_required",
        authorityGranted: false,
        liveAttachments,
      }
    : cloned;
  return Object.freeze({
    data,
    source: options.source,
    agentsEnabled: false,
    reviewRequired: true,
    authorityGranted: false,
    liveAttachments,
    preserved: true,
  });
}

/** Legacy V1 normalization is intentionally the same inert path as foreign import. */
export function normalizeLegacyCognition(raw: unknown): ImportedCognitionNormalizationV1 {
  return normalizeImportedCognition(raw, { source: "legacy" });
}

function requireRepairAuthorization(
  request: CognitionRepairRequestV1,
  current: CognitionReadinessStateV1,
  currentCognitionRevision: RuntimeRevision,
  currentContextAclRevision: RuntimeRevision,
): void {
  if (!request.authenticatedUserId || request.authenticatedUserId !== request.ownerUserId) {
    throw new CognitionRepairError("cognition_repair_unauthorized", "Cognition repair requires the authenticated owner.");
  }
  if (request.explicitAction !== "repair_cognition" || request.acknowledgement !== true) {
    throw new CognitionRepairError("cognition_repair_confirmation_required", "Cognition repair requires explicit acknowledgement.");
  }
  if (!Number.isSafeInteger(request.expectedScopeRevision) || request.expectedScopeRevision < 0 || request.expectedScopeRevision !== current.scopeRevision) {
    throw new CognitionRepairError("cognition_repair_revision_conflict", "Cognition repair revision is stale.", {
      expected: request.expectedScopeRevision,
      actual: current.scopeRevision,
    });
  }
  if (request.expectedCognitionRevision !== undefined && !sameRevision(request.expectedCognitionRevision, currentCognitionRevision)) {
    throw new CognitionRepairError("cognition_repair_revision_conflict", "Cognition changed before repair.", {
      expected: request.expectedScopeRevision,
      actual: current.scopeRevision,
    });
  }
  if (request.expectedContextAclRevision !== undefined && !sameRevision(request.expectedContextAclRevision, currentContextAclRevision)) {
    throw new CognitionRepairError("cognition_repair_revision_conflict", "Context authorization changed before repair.", {
      expected: request.expectedScopeRevision,
      actual: current.scopeRevision,
    });
  }
}

/** Validate a replacement after explicit, owner-authenticated repair preconditions. */
export function repairCognition(
  current: CognitionIntegritySnapshotV1,
  replacement: CognitionIntegritySnapshotV1,
  request: CognitionRepairRequestV1,
  currentState: CognitionReadinessStateV1,
  currentCognitionRevision: RuntimeRevision,
  currentContextAclRevision: RuntimeRevision,
  nextScopeRevision: number,
): CognitionRepairResultV1 {
  requireRepairAuthorization(request, currentState, currentCognitionRevision, currentContextAclRevision);
  if (current.userId !== replacement.userId || current.userId !== request.ownerUserId) {
    throw new CognitionRepairError("cognition_repair_unauthorized", "Cognition ownership changed before repair.");
  }
  const validation = validateCognitionIntegrity(replacement, nextScopeRevision);
  if (validation.source === "foreign" || validation.importedReviewRequired) {
    throw new CognitionRepairError("cognition_repair_invalid", "Imported cognition cannot gain activation authority during repair.");
  }
  return Object.freeze({
    authorized: true,
    validation,
    agenticActivationRequired: true,
  });
}

export interface CognitionIntegrityScopeV1 {
  readonly userId: string;
  readonly presetId?: string | null;
}

interface RegistryEntry {
  readonly scope: CognitionIntegrityScopeV1;
  snapshot: CognitionIntegritySnapshotV1;
  result: CognitionValidationResultV1;
  cognitionRevision: RuntimeRevision;
  contextAclRevision: RuntimeRevision;
  scopeRevision: number;
}

function scopeKey(scope: CognitionIntegrityScopeV1): string {
  return `${scope.userId}\u0000${scope.presetId ?? ""}`;
}

function incrementRevision(previous: number): number {
  return previous >= Number.MAX_SAFE_INTEGER ? previous : previous + 1;
}

export interface ContextInvalidationReasonV1 {
  readonly kind: "acl_revision" | "attachment_revision" | "pack_revision";
  readonly ownerId: string;
  readonly packId?: string;
  readonly revisionId?: string;
}

export interface ContextInvalidationSinkV1 {
  invalidateInput(reason: ContextInvalidationReasonV1): number;
  invalidateReadiness(reason: ContextInvalidationReasonV1): number;
}

function contextReasonMatches(entry: RegistryEntry, reason: ContextInvalidationReasonV1): boolean {
  if (entry.scope.userId !== reason.ownerId) return false;
  if (reason.kind === "acl_revision" && !reason.packId) return true;
  if (reason.kind === "pack_revision" && reason.packId) {
    return listOf(entry.snapshot.packRefs, entry.snapshot.packs).some((pack) => pack.packId === reason.packId);
  }
  if (reason.kind === "attachment_revision" && reason.revisionId) {
    return listOf(entry.snapshot.attachmentRefs, entry.snapshot.attachments).some(
      (attachment) => attachment.attachmentId === reason.revisionId,
    );
  }
  return reason.kind === "acl_revision";
}

function contextReasonKey(reason: ContextInvalidationReasonV1): string {
  return [
    reason.kind,
    reason.ownerId,
    reason.packId ?? "",
    reason.revisionId ?? "",
  ].join("\u0000");
}

/**
 * In-memory invalidation/index used by preset/context mutators. The authored
 * snapshot is retained in each entry; invalidation only appends a repair issue
 * and bumps revisions, so a stale turn cannot regain authority from deletion.
 */
export class CognitionIntegrityRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(
    scope: CognitionIntegrityScopeV1,
    snapshot: CognitionIntegritySnapshotV1,
    expectedScopeRevision?: number,
  ): CognitionValidationResultV1 {
    const key = scopeKey(scope);
    const existing = this.entries.get(key);
    if (existing && expectedScopeRevision !== undefined && expectedScopeRevision !== existing.scopeRevision) {
      throw new CognitionRepairError("cognition_repair_revision_conflict", "Cognition changed before registration.", {
        expected: expectedScopeRevision,
        actual: existing.scopeRevision,
      });
    }
    const nextRevision = existing ? incrementRevision(existing.scopeRevision) : 1;
    const presetMatches = scope.presetId === undefined || scope.presetId === null
      ? snapshot.presetId === undefined || snapshot.presetId === null
      : typeof snapshot.presetId === "string" && snapshot.presetId === scope.presetId;
    const ownershipMatches = snapshot.userId === scope.userId && presetMatches;
    const registeredSnapshot = ownershipMatches
      ? snapshot
      : {
          ...snapshot,
          source: "foreign" as const,
          sameAccount: false,
        };
    const result = validateCognitionIntegrity(registeredSnapshot, nextRevision);
    this.entries.set(key, {
      scope: { userId: scope.userId, presetId: scope.presetId ?? null },
      snapshot: registeredSnapshot,
      result,
      cognitionRevision: registeredSnapshot.actualCognitionRevision ?? nextRevision,
      contextAclRevision: registeredSnapshot.actualContextAclRevision ?? nextRevision,
      scopeRevision: nextRevision,
    });
    return result;
  }

  restore(
    scope: CognitionIntegrityScopeV1,
    snapshot: CognitionIntegritySnapshotV1,
    request: CognitionRepairRequestV1,
  ): CognitionRepairResultV1 {
    const existing = this.requireEntry(scope);
    const currentState = this.readiness(scope);
    const replacementResult = repairCognition(
      existing.snapshot,
      snapshot,
      request,
      currentState,
      existing.cognitionRevision,
      existing.contextAclRevision,
      incrementRevision(existing.scopeRevision),
    );
    const registeredResult = this.register(scope, snapshot, existing.scopeRevision);
    return Object.freeze({
      ...replacementResult,
      validation: registeredResult,
    });
  }

  get(scope: CognitionIntegrityScopeV1): CognitionValidationResultV1 | null {
    return this.entries.get(scopeKey(scope))?.result ?? null;
  }

  readiness(scope: CognitionIntegrityScopeV1): CognitionReadinessStateV1 {
    const entry = this.requireEntry(scope);
    return Object.freeze({
      cognitionRevision: entry.cognitionRevision,
      contextAclRevision: entry.contextAclRevision,
      scopeRevision: entry.scopeRevision,
      agenticAllowed: entry.result.agenticAllowed,
      responseAvailable: true,
      repairCode: entry.result.repairCode,
      issues: entry.result.issues,
    });
  }

  invalidateAttachment(
    scope: CognitionIntegrityScopeV1,
    attachmentId: string,
  ): CognitionValidationResultV1 {
    return this.invalidate(scope, "cognition_deleted_attachment", attachmentId);
  }

  invalidateAuthorization(
    scope: CognitionIntegrityScopeV1,
    subject?: string,
  ): CognitionValidationResultV1 {
    const entry = this.requireEntry(scope);
    entry.contextAclRevision = incrementRevisionNumber(entry.contextAclRevision);
    return this.invalidateEntry(entry, "cognition_authorization_stale", subject);
  }

  invalidatePackRevision(
    scope: CognitionIntegrityScopeV1,
    packId: string,
  ): CognitionValidationResultV1 {
    return this.invalidate(scope, "cognition_missing_pack_revision", packId);
  }

  invalidateBlockRevision(
    scope: CognitionIntegrityScopeV1,
    blockId: string,
  ): CognitionValidationResultV1 {
    return this.invalidate(scope, "cognition_missing_block_revision", blockId);
  }

  invalidate(scope: CognitionIntegrityScopeV1, code: CognitionRepairCode, subject?: string): CognitionValidationResultV1 {
    const entry = this.requireEntry(scope);
    return this.invalidateEntry(entry, code, subject);
  }

  /** Invalidate every attached cognition under an account after an ACL change. */
  invalidateAccountAuthorization(userId: string, subject?: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.scope.userId !== userId) continue;
      entry.contextAclRevision = incrementRevisionNumber(entry.contextAclRevision);
      this.invalidateEntry(entry, "cognition_authorization_stale", subject);
      count += 1;
    }
    return count;
  }

  invalidateContextReason(reason: ContextInvalidationReasonV1): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (!contextReasonMatches(entry, reason)) continue;
      if (reason.kind === "acl_revision") {
        entry.contextAclRevision = incrementRevisionNumber(entry.contextAclRevision);
      }
      const code = reason.kind === "attachment_revision"
        ? "cognition_deleted_attachment"
        : reason.kind === "pack_revision"
          ? "cognition_missing_pack_revision"
          : "cognition_authorization_stale";
      this.invalidateEntry(entry, code, reason.revisionId ?? reason.packId);
      count += 1;
    }
    return count;
  }

  delete(scope: CognitionIntegrityScopeV1): void {
    // Deleting an index entry is not deleting authored cognition. It merely
    // prevents an unregistered/stale projection from being considered ready.
    this.entries.delete(scopeKey(scope));
  }

  private requireEntry(scope: CognitionIntegrityScopeV1): RegistryEntry {
    const entry = this.entries.get(scopeKey(scope));
    if (!entry) {
      throw new CognitionRepairError("cognition_repair_invalid", "Cognition scope is not registered.");
    }
    return entry;
  }

  private invalidateEntry(
    entry: RegistryEntry,
    code: CognitionRepairCode,
    subject?: string,
  ): CognitionValidationResultV1 {
    const issues = entry.result.issues.slice();
    addIssue(issues, code, subject);
    entry.scopeRevision = incrementRevision(entry.scopeRevision);
    entry.cognitionRevision = incrementRevisionNumber(entry.cognitionRevision);
    entry.result = Object.freeze({
      ...entry.result,

      valid: false,
      agenticAllowed: false,
      repairCode: primaryRepairCode(issues),
      issues: Object.freeze(issues),
      scopeRevision: entry.scopeRevision,
    });
    return entry.result;
  }
  getSnapshot(scope: CognitionIntegrityScopeV1): CognitionIntegritySnapshotV1 {
    return this.requireEntry(scope).snapshot;
  }
}


function incrementRevisionNumber(previous: RuntimeRevision): RuntimeRevision {
  return typeof previous === "number" && Number.isSafeInteger(previous)
    ? incrementRevision(previous)
    : `${String(previous)}:invalidated`;
}

export const cognitionIntegrityRegistry = new CognitionIntegrityRegistry();
/** Build a one-turn sink; both callbacks observe one invalidation, not two revisions. */
export function createCognitionContextInvalidationSink(
  registry: CognitionIntegrityRegistry = cognitionIntegrityRegistry,
): ContextInvalidationSinkV1 {
  const seen = new Set<string>();
  const invalidate = (reason: ContextInvalidationReasonV1): number => {
    const key = contextReasonKey(reason);
    if (seen.has(key)) return 0;
    seen.add(key);
    return registry.invalidateContextReason(reason);
  };
  return {
    invalidateInput: invalidate,
    invalidateReadiness: invalidate,
  };
}

/** Convenience hooks for mutators; they preserve data and only invalidate authority. */
export function onCognitionAttachmentDeleted(
  scope: CognitionIntegrityScopeV1,
  attachmentId: string,
): CognitionValidationResultV1 {
  return cognitionIntegrityRegistry.invalidateAttachment(scope, attachmentId);
}

export function onCognitionAuthorizationChanged(
  scope: CognitionIntegrityScopeV1,
  subject?: string,
): CognitionValidationResultV1 {
  return cognitionIntegrityRegistry.invalidateAuthorization(scope, subject);
}

export function onCognitionPackRevisionDeleted(
  scope: CognitionIntegrityScopeV1,
  packId: string,
): CognitionValidationResultV1 {
  return cognitionIntegrityRegistry.invalidatePackRevision(scope, packId);
}

export function onCognitionBlockRevisionDeleted(
  scope: CognitionIntegrityScopeV1,
  blockId: string,
): CognitionValidationResultV1 {
  return cognitionIntegrityRegistry.invalidateBlockRevision(scope, blockId);
}

/*
 * Canonical readiness encoding. Keep this in the integrity service so every
 * admission path (preflight, token consumption, and commit) hashes the same
 * ordered fields and sorted/deduplicated component reasons.
 */
export const AGENTIC_READINESS_VECTOR_KEYS = [
  "schemaEpoch",
  "runtimeEpoch",
  "reconciliationEpoch",
  "archiveRegistryVersion",
  "isolateHealthEpoch",
  "publicationStoreHealthEpoch",
  "providerCapabilityRevision",
  "configRevision",
  "bindingRevision",
  "concreteConnectionRevision",
  "targetRevision",
  "inputRevisionDigest",
  "cognitionRevision",
  "contextAclRevision",
  "killSwitchState",
  "ready",
  "reasons",
] as const;

export type AgenticReadinessReasonV1 = CognitionRepairCode | "schema_unavailable" | "runtime_unavailable" | "reconciliation_required" | "archive_registry_unavailable" | "isolate_unavailable" | "publication_store_unavailable" | "provider_capability_unavailable" | "config_unavailable" | "binding_unavailable" | "connection_unavailable" | "target_unavailable" | "input_revisions_incomplete" | "kill_switch_disabled";

function canonicalReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 256) {
    throw new TypeError("Agentic readiness reasons must be non-empty bounded strings");
  }
  return reason;
}

function canonicalRevisionForReadiness(value: unknown, key: string): RuntimeRevision {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new TypeError(`${key} must be a safe integer revision`);
    return value;
  }
  if (typeof value === "string" && value.length > 0 && value.length <= 1024) return value;
  throw new TypeError(`${key} must be a bounded revision`);
}

/** Return a detached, immutable canonical vector with one sorted reason list. */
export function canonicalizeAgenticReadinessVectorV1(
  vector: AgenticReadinessVectorV1,
): AgenticReadinessVectorV1 {
  if (!vector || typeof vector !== "object") throw new TypeError("Agentic readiness vector is required");
  const canonical: Record<string, unknown> = {};
  for (const key of AGENTIC_READINESS_VECTOR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(vector, key)) throw new TypeError(`Agentic readiness vector is missing ${key}`);
  }
  for (const key of AGENTIC_READINESS_VECTOR_KEYS.slice(0, 14)) {
    canonical[key] = canonicalRevisionForReadiness((vector as unknown as Record<string, unknown>)[key], key);
  }
  const killSwitchState = (vector as AgenticReadinessVectorV1).killSwitchState;
  if (killSwitchState !== "off" && killSwitchState !== "auto" && killSwitchState !== "on") {
    throw new TypeError("Agentic readiness kill switch state is invalid");
  }
  canonical.killSwitchState = killSwitchState;
  if (typeof vector.ready !== "boolean") throw new TypeError("Agentic readiness ready flag is invalid");
  canonical.ready = vector.ready;
  if (!Array.isArray(vector.reasons)) throw new TypeError("Agentic readiness reasons are invalid");
  const reasons = Array.from(new Set(vector.reasons.map(canonicalReason))).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  canonical.reasons = Object.freeze(reasons);
  if (reasons.length > 0) canonical.ready = false;
  return Object.freeze(canonical as unknown as AgenticReadinessVectorV1);
}

/** Stable JSON bytes; keys are written in AGENTIC_READINESS_VECTOR_KEYS order. */
export function encodeAgenticReadinessVectorV1(vector: AgenticReadinessVectorV1): string {
  const canonical = canonicalizeAgenticReadinessVectorV1(vector) as unknown as Record<string, unknown>;
  return `{${AGENTIC_READINESS_VECTOR_KEYS.map((key) => `${JSON.stringify(key)}:${JSON.stringify(canonical[key])}`).join(",")}}`;
}

export function hashAgenticReadinessVectorV1(vector: AgenticReadinessVectorV1): string {
  return createHash("sha256").update(encodeAgenticReadinessVectorV1(vector), "utf8").digest("hex");
}

export const canonicalAgenticReadinessVectorV1 = encodeAgenticReadinessVectorV1;
export const agenticReadinessVectorDigestV1 = hashAgenticReadinessVectorV1;
export const canonicalEncodeAgenticReadinessVectorV1 = encodeAgenticReadinessVectorV1;
export const encodeReadinessVectorV1 = encodeAgenticReadinessVectorV1;
export const hashReadinessVectorV1 = hashAgenticReadinessVectorV1;

/** Merge registry state into readiness without permitting a partial-ready state. */
export function applyCognitionReadinessV1(
  vector: AgenticReadinessVectorV1,
  state: CognitionReadinessStateV1,
): AgenticReadinessVectorV1 {
  const reasons = new Set(vector.reasons);
  if (!state.agenticAllowed && state.repairCode) reasons.add(state.repairCode);
  return canonicalizeAgenticReadinessVectorV1({
    ...vector,
    cognitionRevision: state.cognitionRevision,
    contextAclRevision: state.contextAclRevision,
    ready: vector.ready && state.agenticAllowed,
    reasons: [...reasons],
  });
}
