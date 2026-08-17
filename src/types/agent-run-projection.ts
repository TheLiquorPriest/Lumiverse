/**
 * Authenticated, status-only projection contracts for Agentic turns.
 *
 * These types are deliberately closed. Public payloads are assembled from
 * allowlisted fields by the projection service; callers must not spread model,
 * provider, tool, workspace, or metadata objects into these DTOs.
 */

export type AgentRunPublicStatusV2 =
  | "ASSEMBLE"
  | "WORK"
  | "COMPLETE"
  | "RENDER"
  | "PREPARE_COMMIT"
  | "COMMITTING"
  | "COMMITTED"
  | "COMMIT_FAILED"
  | "EXHAUSTED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export type AgentRunGenerationTypeV1 = "normal" | "continue" | "regenerate" | "swipe";

export type AgentActivityNodeKindV2 = "root" | "provider" | "child" | "tool";
export type AgentActivityNodeActorV2 = "root" | "provider" | "child" | "tool";
export type AgentActivityNodeStatusV2 =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "omitted";

export interface AgentActivityUsageV2 {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly childInvocations: number;
}

/** A bounded status-only node. It has no task, prompt, argument, result, or carrier fields. */
export interface AgentActivityNodeV2 {
  readonly version: 2;
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: AgentActivityNodeKindV2;
  readonly actor: AgentActivityNodeActorV2;
  readonly phase: AgentRunPublicStatusV2;
  readonly status: AgentActivityNodeStatusV2;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly profileId?: string;
  readonly toolId?: string;
  readonly roundIndex?: number;
  readonly continuationMode?: "ordinary" | "finalization" | "none";
  readonly usage?: AgentActivityUsageV2;
  readonly errorCode?: string;
}

export interface AgentOmissionMarkerV2 {
  readonly omittedNodeCount: number;
  readonly omittedEventCount: number;
  readonly firstOmittedSequence: number | null;
  readonly lastOmittedSequence: number | null;
}

export interface AgentRunTargetV1 {
  readonly messageId: string;
  readonly swipeId: number;
}

/** The only durable generation handoff exposed after an atomic commit. */
export interface AgentTerminalHandoffV2 {
  readonly version: 2;
  readonly committed: boolean;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly messageRevision: number | null;
  readonly swipeRevision: number | null;
}

export interface AgentRunPublicErrorV2 {
  readonly code: string;
  readonly retryable: boolean;
}

export interface AgentRunPublicV2 {
  readonly version: 2;
  readonly runId: string;
  readonly turnId: string;
  readonly generationId: string;
  readonly chatId: string;
  readonly generationType: AgentRunGenerationTypeV1;
  readonly target: AgentRunTargetV1 | null;
  readonly status: AgentRunPublicStatusV2;
  readonly phase: AgentRunPublicStatusV2;
  readonly revision: number;
  /** The chat event sequence that carried this snapshot; it is not a run cursor. */
  readonly sequence: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly activity: readonly AgentActivityNodeV2[];
  readonly usage: AgentActivityUsageV2;
  readonly omission: AgentOmissionMarkerV2;
  readonly error?: AgentRunPublicErrorV2;
  readonly terminalHandoff?: AgentTerminalHandoffV2;
}

export type AgentWorkspaceSectionIdV2 =
  | "objective"
  | "tasks"
  | "records"
  | "submissions"
  | "artifacts";

export type AgentWorkspaceRetentionV2 = "operational" | "turn_terminal" | "chat_lifetime";
export type AgentWorkspaceVisibilityV2 = "owner" | "participants" | "public";

export interface AgentWorkspaceSectionIndexV2 {
  readonly section: AgentWorkspaceSectionIdV2;
  readonly count: number;
  readonly revision: number;
  readonly retention: AgentWorkspaceRetentionV2;
  readonly visibility: AgentWorkspaceVisibilityV2;
}

/** Redacted workspace index: counts and policy only, never workspace prose. */
export interface AgentWorkspaceIndexV2 {
  readonly version: 2;
  readonly turnId: string;
  readonly workspaceRevision: number;
  readonly sections: readonly AgentWorkspaceSectionIndexV2[];
  readonly omitted: number;
}

export interface AgentWorkspaceEntryBaseV2 {
  readonly id: string;
  readonly revision: number;
  readonly retention: AgentWorkspaceRetentionV2;
  readonly visibility: AgentWorkspaceVisibilityV2;
}

export interface AgentWorkspaceTaskPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  readonly kind: "task";
  readonly title: string;
  readonly state: "active" | "blocked" | "submitted" | "done" | "omitted";
  readonly required: boolean;
  readonly assigned: boolean;
  readonly dependencyCount: number;
}

export interface AgentWorkspaceSubmissionPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  readonly kind: "submission";
  readonly taskId: string;
  readonly profileId: string | null;
  readonly state: "proposed" | "accepted" | "rejected" | "omitted";
}

export interface AgentWorkspaceRecordPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  readonly kind: "finding" | "decision" | "question";
  readonly title: string;
  readonly state: "active" | "accepted" | "omitted";
}

export interface AgentWorkspaceArtifactPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  readonly kind: "artifact";
  readonly name: string;
  readonly mimeType: string;
  readonly byteCount: number;
  readonly digestPrefix: string;
  readonly published: boolean;
}

export type AgentWorkspaceEntryPreviewV2 =
  | AgentWorkspaceTaskPreviewV2
  | AgentWorkspaceSubmissionPreviewV2
  | AgentWorkspaceRecordPreviewV2
  | AgentWorkspaceArtifactPreviewV2;

/** View-only page DTO. It never carries objective, constraints, notes, or child content. */
export interface AgentWorkspacePreviewV2 {
  readonly version: 2;
  readonly turnId: string;
  readonly section: AgentWorkspaceSectionIdV2;
  readonly workspaceRevision: number;
  readonly entries: readonly AgentWorkspaceEntryPreviewV2[];
  readonly nextPage: string | null;
  readonly omitted: number;
}

/** Opaque integrity-protected cursor. The token is never decoded by clients. */
export interface ChatRunCursorV1 {
  readonly version: 1;
  readonly token: string;
}

export interface AgentRunResyncPageV1 {
  /** Zero-based page offset in the bounded full-resync snapshot. */
  readonly offset: number;
  /** Number of runs visible in this response. */
  readonly returnedRuns: number;
  /** Number of runs in the bounded snapshot at its event watermark. */
  readonly totalRuns: number;
  /** Event sequence at which this resync snapshot was taken. */
  readonly snapshotSequence: number;
  /** False until the response contains every run in that snapshot. */
  readonly complete: boolean;
  /** Runs not returned yet; this is not an event omission. */
  readonly omittedRuns: number;
}

export interface AgentRunChangeEventV2 {
  readonly version: 2;
  readonly chatId: string;
  readonly sequence: number;
  readonly run: AgentRunPublicV2;
  readonly omission: AgentOmissionMarkerV2;
}

export interface AgentRunChangesV2 {
  readonly version: 2;
  readonly chatId: string;
  readonly cursor: ChatRunCursorV1;
  /** Sequence consumed by the signed cursor in `cursor`. */
  readonly cursorSequence: number;
  /** Processed sequence; always equal to the signed cursor sequence. */
  readonly lastSequence: number;
  /** Highest sequence visible to this read snapshot, not a cursor watermark. */
  readonly tailSequence: number;
  /** More events or resync pages remain after this response. */
  readonly hasMore: boolean;
  readonly resync: boolean;
  readonly resyncPage?: AgentRunResyncPageV1;
  readonly runs: readonly AgentRunPublicV2[];
  readonly events: readonly AgentRunChangeEventV2[];
  readonly omission: AgentOmissionMarkerV2;
}

export type AgentRunStopResultV2 = "accepted" | "too_late" | "terminal";

export interface AgentRunStopResponseV2 {
  readonly version: 2;
  readonly status: AgentRunStopResultV2;
  readonly turnId: string;
  readonly revision: number;
}
