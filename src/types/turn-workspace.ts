import type {
  FinalRenderReservationV1,
  TurnExecutionStateV1,
} from "./turn-execution";

/** Workspace records are intentionally retained summaries, never raw work data. */
export type WorkspaceRetentionV1 = "operational" | "turn_terminal" | "chat_lifetime";
export type WorkspaceRetention = WorkspaceRetentionV1;

/** Child work is host-controlled and has no implicit completion state. */
export const WORKSPACE_TASK_STATES = ["active", "blocked", "submitted"] as const;
export type WorkspaceTaskStateV1 = (typeof WORKSPACE_TASK_STATES)[number];
export type WorkspaceTaskState = WorkspaceTaskStateV1;

export const WORKSPACE_RECORD_KINDS = ["finding", "decision", "question"] as const;
export type WorkspaceRecordKindV1 = (typeof WORKSPACE_RECORD_KINDS)[number];
export type WorkspaceRecordKind = WorkspaceRecordKindV1;

export const WORKSPACE_SUBMISSION_STATES = ["proposed", "accepted", "rejected"] as const;
export type WorkspaceSubmissionStateV1 = (typeof WORKSPACE_SUBMISSION_STATES)[number];

export const WORKSPACE_ARTIFACT_PUBLICATION_STATES = [
  "attached",
  "proposed",
  "published",
] as const;
export type WorkspaceArtifactPublicationStateV1 =
  (typeof WORKSPACE_ARTIFACT_PUBLICATION_STATES)[number];

/** Closed operation vocabulary exposed to a granted frame. */
export const WORKSPACE_OPERATIONS = [
  "read_section",
  "read_page",
  "create_task",
  "update_assigned_progress",
  "submit_child_result",
  "accept_submission",
  "record_finding",
  "record_decision",
  "record_question",
  "attach_artifact",
  "propose_publication",
] as const;
export type WorkspaceOperationKindV1 = (typeof WORKSPACE_OPERATIONS)[number];
export type WorkspaceOperationKind = WorkspaceOperationKindV1;

/**
 * Per-frame host grants. A false capability is an authorization failure, not a
 * request to silently downgrade the operation.
 */
export interface WorkspaceOperationCapabilitiesV1 {
  readonly revision: number;
  readonly allowed: readonly WorkspaceOperationKindV1[];
  readonly maxOperationBytes: number;
  readonly maxOperations: number;
}
export type WorkspaceFieldCapabilitiesV1 = WorkspaceOperationCapabilitiesV1;

export interface WorkspaceQuotaV1 {
  readonly maxTasks: number;
  readonly maxRecords: number;
  readonly maxSubmissions: number;
  readonly maxArtifacts: number;
  readonly maxBytes: number;
}

export interface WorkspaceUsageV1 {
  readonly taskCount: number;
  readonly recordCount: number;
  readonly submissionCount: number;
  readonly artifactCount: number;
  readonly byteCount: number;
}

export type WorkspaceStateV1 = "active" | "frozen" | "expired";

/** Immutable objective and constraints supplied by the host at turn creation. */
export interface TurnWorkspaceV1 {
  readonly id: string;
  readonly turnId: string;
  readonly executionId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly state: WorkspaceStateV1;
  readonly revision: number;
  readonly quota: WorkspaceQuotaV1;
  readonly usage: WorkspaceUsageV1;
  readonly retention: WorkspaceRetentionV1;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly frozenAt: number | null;
}
export type TurnWorkspaceRecordV1 = TurnWorkspaceV1;
export type TurnWorkspace = TurnWorkspaceV1;

export interface WorkspaceTaskV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly turnId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly title: string;
  readonly objective: string;
  readonly state: WorkspaceTaskStateV1;
  /** Model-created tasks must always be false; only the host may require work. */
  readonly required: boolean;
  readonly dependencyIds: readonly string[];
  readonly assignedFrameId: string | null;
  readonly progress: number;
  readonly summary: string | null;
  readonly revision: number;
  readonly retention: WorkspaceRetentionV1;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type WorkspaceTask = WorkspaceTaskV1;

export interface WorkspaceRecordV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly turnId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly kind: WorkspaceRecordKindV1;
  readonly summary: string;
  readonly digest: string;
  readonly taskId: string | null;
  readonly sourceFrameId: string | null;
  readonly byteCount: number;
  readonly revision: number;
  readonly retention: WorkspaceRetentionV1;
  readonly expiresAt: number;
  readonly createdAt: number;
}
export type WorkspaceRecord = WorkspaceRecordV1;

export interface WorkspaceSubmissionV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly childFrameId: string;
  readonly state: WorkspaceSubmissionStateV1;
  readonly summary: string;
  readonly resultDigest: string;
  readonly byteCount: number;
  readonly revision: number;
  readonly retention: WorkspaceRetentionV1;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type WorkspaceSubmission = WorkspaceSubmissionV1;

export type WorkspaceArtifactProvenanceV1 = "host" | "root" | "child";

export interface WorkspaceArtifactReferenceV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly turnId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly blobDigest: string;
  readonly mimeType: string;
  readonly byteCount: number;
  readonly provenance: WorkspaceArtifactProvenanceV1;
  readonly sourceFrameId: string | null;
  readonly sourceTaskId: string | null;
  readonly publicationState: WorkspaceArtifactPublicationStateV1;
  readonly retention: WorkspaceRetentionV1;
  readonly revision: number;
  readonly expiresAt: number;
  readonly createdAt: number;
}
export type WorkspaceArtifact = WorkspaceArtifactReferenceV1;

/** Immutable content-addressed artifact metadata; bytes live in the blob store. */
export interface AgentArtifactBlobV1 {
  readonly digest: string;
  readonly userId: string;
  readonly byteCount: number;
  readonly mimeType: string;
  readonly storagePath: string;
  readonly publishedReferenceCount: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type ArtifactBlobJournalStateV1 = "pending" | "installed" | "removed";

export interface AgentArtifactBlobJournalV1 {
  readonly id: string;
  readonly blobDigest: string;
  readonly userId: string;
  readonly turnId: string;
  readonly creatorToken: string;
  readonly fenceGeneration: number;
  readonly stagedPath: string;
  readonly finalPath: string;
  readonly state: ArtifactBlobJournalStateV1;
  readonly observedIdentity: string | null;
  readonly byteCount: number;
  readonly digest: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkspaceCommitReceiptV1 {
  readonly id: string;
  readonly turnId: string;
  readonly executionId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly commitKey: string;
  readonly idempotencyKey: string;
  readonly state: "committed";
  readonly summaryDigest: string;
  readonly summary: string;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly artifactRefCount: number;
  readonly committedAt: number;
}

export interface PublishedWorkspaceArtifactV1 {
  readonly id: string;
  readonly receiptId: string;
  readonly sourceArtifactId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly blobDigest: string;
  readonly storagePath: string;
  readonly mimeType: string;
  readonly byteCount: number;
  readonly digest: string;
  readonly retention: "chat_lifetime";
  readonly revision: number;
  readonly createdAt: number;
}

/** A public handoff contains only bounded identifiers and counts. */
export interface WorkspaceTerminalHandoffV1 {
  readonly workspaceId: string;
  readonly state: Extract<WorkspaceStateV1, "frozen" | "expired">;
  readonly revision: number;
  readonly executionState: TurnExecutionStateV1;
  readonly usage: WorkspaceUsageV1;
  readonly finalRenderReservations: readonly FinalRenderReservationV1[];
}
