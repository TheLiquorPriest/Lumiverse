import type { AgentPublicErrorCode } from './agent-runtime'

/** Closed, status-only frontend mirror of the authenticated Agentic run projection. */
export type AgentRunPhaseV2 =
  | 'ASSEMBLE'
  | 'WORK'
  | 'COMPLETE'
  | 'RENDER'
  | 'PREPARE_COMMIT'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'COMMIT_FAILED'
  | 'EXHAUSTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'

export type AgentRunStatusV2 = AgentRunPhaseV2
export type AgentRunGenerationTypeV2 = 'normal' | 'continue' | 'regenerate' | 'swipe'
export type AgentActivityNodeKindV2 = 'root' | 'provider' | 'child' | 'tool'
export type AgentActivityNodeStatusV2 =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'omitted'
export type AgentActivityContinuationModeV2 = 'ordinary' | 'finalization' | 'none'

export interface AgentRunTargetV2 {
  messageId: string
  swipeId: number
}

export interface AgentRunUsageV2 {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolCalls: number
  childInvocations: number
}

export interface AgentActivityNodeV2 {
  version: 2
  id: string
  parentId: string | null
  kind: AgentActivityNodeKindV2
  actor: AgentActivityNodeKindV2
  phase: AgentRunPhaseV2
  status: AgentActivityNodeStatusV2
  startedAt: number
  elapsedMs: number
  profileId?: string
  toolId?: string
  roundIndex?: number
  continuationMode?: AgentActivityContinuationModeV2
  usage?: AgentRunUsageV2
  errorCode?: AgentPublicErrorCode
}

export interface AgentOmissionMarkerV2 {
  omittedNodeCount: number
  omittedEventCount: number
  firstOmittedSequence: number | null
  lastOmittedSequence: number | null
}

export interface AgentRunTerminalHandoffV2 {
  version: 2
  committed: boolean
  messageId: string
  swipeId: number
  messageRevision: number
  swipeRevision: number
}

export interface AgentRunPublicV2 {
  version: 2
  runId: string
  turnId: string
  generationId: string
  chatId: string
  generationType: AgentRunGenerationTypeV2
  target: AgentRunTargetV2 | null
  status: AgentRunStatusV2
  phase: AgentRunPhaseV2
  revision: number
  sequence: number
  startedAt: number
  updatedAt: number
  activity: AgentActivityNodeV2[]
  usage: AgentRunUsageV2
  omission: AgentOmissionMarkerV2
  errorCode?: AgentPublicErrorCode
  terminalHandoff?: AgentRunTerminalHandoffV2
}

export interface AgentRunChangedEventV2 {
  version: 2
  chatId: string
  sequence: number
  run: AgentRunPublicV2
  omission: AgentOmissionMarkerV2
}

export interface ChatRunCursorV1 {
  version: 1
  token: string
}

export interface AgentRunResyncPageV1 {
  /** Zero-based page offset in the bounded full-resync snapshot. */
  offset: number
  returnedRuns: number
  totalRuns: number
  snapshotSequence: number
  complete: boolean
  omittedRuns: number
}

export interface AgentRunChangesV2 {
  version: 2
  chatId: string
  cursor: ChatRunCursorV1
  /** Sequence consumed by the signed cursor in `cursor`. */
  cursorSequence: number
  /** Processed sequence; always equal to the signed cursor sequence. */
  lastSequence: number
  /** Highest sequence visible to this read snapshot, not a cursor watermark. */
  tailSequence: number
  /** More events or resync pages remain after this response. */
  hasMore: boolean
  resync: boolean
  resyncPage?: AgentRunResyncPageV1
  runs: AgentRunPublicV2[]
  events: AgentRunChangedEventV2[]
  omission: AgentOmissionMarkerV2
}

export type AgentWorkspaceSectionV2 = 'objective' | 'tasks' | 'records' | 'submissions' | 'artifacts'
export type AgentWorkspaceRetentionV2 = 'operational' | 'turn_terminal' | 'chat_lifetime'
export type AgentWorkspaceVisibilityV2 = 'owner' | 'participants' | 'public'

export interface AgentWorkspaceSectionSummaryV2 {
  section: AgentWorkspaceSectionV2
  count: number
  revision: number
  retention: AgentWorkspaceRetentionV2
  visibility: AgentWorkspaceVisibilityV2
}

export interface AgentWorkspaceIndexPublicV2 {
  version: 2
  turnId: string
  workspaceRevision: number
  sections: AgentWorkspaceSectionSummaryV2[]
  omitted: number
}

interface AgentWorkspaceEntryBaseV2 {
  id: string
  revision: number
  retention: AgentWorkspaceRetentionV2
  visibility: AgentWorkspaceVisibilityV2
}

export interface AgentWorkspaceTaskPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  kind: 'task'
  title: string
  state: 'active' | 'blocked' | 'submitted' | 'done' | 'omitted'
  required: boolean
  assigned: boolean
  dependencyCount: number
}

export interface AgentWorkspaceSubmissionPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  kind: 'submission'
  taskId: string
  profileId: string | null
  state: 'proposed' | 'accepted' | 'rejected' | 'omitted'
}

export interface AgentWorkspaceRecordPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  kind: 'finding' | 'decision' | 'question'
  title: string
  state: 'active' | 'accepted' | 'omitted'
}

export interface AgentWorkspaceArtifactPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  kind: 'artifact'
  name: string
  mimeType: string
  byteCount: number
  digestPrefix: string
  published: boolean
}

export type AgentWorkspaceEntryPreviewV2 =
  | AgentWorkspaceTaskPreviewV2
  | AgentWorkspaceSubmissionPreviewV2
  | AgentWorkspaceRecordPreviewV2
  | AgentWorkspaceArtifactPreviewV2

export interface AgentWorkspaceSectionPreviewV2 {
  version: 2
  turnId: string
  section: AgentWorkspaceSectionV2
  workspaceRevision: number
  entries: AgentWorkspaceEntryPreviewV2[]
  nextPage: string | null
  omitted: number
}

export interface AgentRunStopResultV2 {
  status: 'accepted' | 'too_late' | 'terminal'
  turnId: string
  revision: number
}

export type AgentRunSyncStatus = 'idle' | 'stale' | 'restoring' | 'ready' | 'error'

export interface AgentWorkspaceSectionStateV2 {
  preview: AgentWorkspaceSectionPreviewV2
  loadingMore: boolean
  /** A failed section request keeps an explicit retryable state instead of an endless spinner. */
  error?: boolean
}

export interface AgentWorkspaceViewStateV2 {
  chatId: string
  turnId: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  index: AgentWorkspaceIndexPublicV2 | null
  sections: Partial<Record<AgentWorkspaceSectionV2, AgentWorkspaceSectionStateV2>>
  error: boolean
}
