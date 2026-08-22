import type { StateCreator } from 'zustand'
import type {
  AgentPersistentWorkspaceCollectionV1,
  AgentPersistentWorkspaceCollectionsStateV1,
  AppStore,
  AgentRunsSlice,
} from '@/types/store'
import type {
  AgentActivityMilestoneV1,
  AgentActivityNodeStatusV2,
  AgentActivityNodeV2,
  AgentActivityTreeV1,
  AgentCortexReceiptV1,
  AgentCouncilReceiptV1,
  AgentInspectionCapGateV1,
  AgentInspectionCorrelationV1,
  AgentInspectionErrorDetailV1,
  AgentInspectionLifecycleV1,
  AgentInspectionMarkerKindV1,
  AgentInspectionMarkerScopeV1,
  AgentInspectionMarkerV1,
  AgentInspectionReasonV1,
  AgentInspectionSectionAvailabilityV1,
  AgentInspectionSectionIdV1,
  AgentInspectionSectionStateV1,
  AgentInspectionSourceV1,
  AgentInspectionScopeV1,
  AgentInspectionUsageLayerV1,
  AgentInspectionUsageProjectionV1,
  AgentInspectionUsageV1,
  AgentOmissionMarkerV2,
  AgentPersistentWorkspaceArtifactV1,
  AgentPersistentWorkspacePublicationV1,
  AgentPersistentWorkspaceRecordV1,
  AgentRunInspectionStopV1,
  AgentPersistentWorkspaceStateV1,
  AgentPersistentWorkspaceSubmissionV1,
  AgentPersistentWorkspaceTaskV1,
  AgentPersistentWorkspaceTurnSessionV1,
  AgentPersistentWorkspaceV1,
  AgentRunChangeEventV2,
  AgentRunChangesV2,
  AgentRunGenerationTypeV2,
  AgentRunPhaseV2,
  AgentRunInspectionDetailV1,
  AgentRunInspectionListV1,
  AgentRunInspectionRetryResponseV1,
  AgentRunInspectionRetryV1,
  AgentRunInspectionSummaryV1,
  AgentRunOutcomeV2,
  AgentRunPublicErrorCodeV2,
  AgentRunPublicErrorV2,
  AgentRunPublicV2,
  AgentRunRecoveryActionV2,
  AgentRunResyncPageV1,
  AgentRunStatusV2,
  AgentRunTargetV2,
  AgentRunUsageV2,
  AgentWorkspaceEntryPreviewV2,
  AgentWorkspaceIndexPublicV2,
  AgentWorkspaceTaskPreviewV2,
  AgentWorkspaceSectionPreviewV2,
  AgentWorkspaceSectionV2,
  AgentWorkspaceRetentionV2,
  AgentWorkspaceVisibilityV2,
  AgentWorkAttemptLineageV1,
  AgentWorkTargetIdentityV1,
} from '@/types/agent-runs'
import { isUnknownRecord } from '@/lib/type-guards'

const RUN_PHASES: Record<AgentRunPhaseV2, true> = {
  ADMIT: true,
  ASSEMBLE: true,
  WORK: true,
  PREPARE_COMMIT: true,
  RENDER: true,
  COMMIT: true,
  TERMINAL: true,
}
const RUN_STATUSES: Record<AgentRunStatusV2, true> = {
  pending: true,
  running: true,
  waiting: true,
  cancelling: true,
  terminal: true,
}
const RUN_OUTCOMES: Record<AgentRunOutcomeV2, true> = {
  completed: true,
  stopped: true,
  failed: true,
  exhausted: true,
  rejected: true,
}
const GENERATION_TYPES: Record<AgentRunGenerationTypeV2, true> = {
  normal: true,
  continue: true,
  regenerate: true,
  swipe: true,
}
const NODE_KINDS: Record<AgentActivityNodeV2['kind'], true> = {
  root: true,
  provider: true,
  child: true,
  tool: true,
}
const NODE_STATUSES: Record<AgentActivityNodeStatusV2, true> = {
  pending: true,
  running: true,
  completed: true,
  failed: true,
  cancelled: true,
  timed_out: true,
  omitted: true,
}
const CONTINUATION_MODES: Record<NonNullable<AgentActivityNodeV2['continuationMode']>, true> = {
  ordinary: true,
  finalization: true,
  none: true,
}
const WORKSPACE_SECTIONS: Record<AgentWorkspaceSectionV2, true> = {
  objective: true,
  tasks: true,
  records: true,
  submissions: true,
  artifacts: true,
}
const WORKSPACE_RETENTIONS: Record<AgentWorkspaceRetentionV2, true> = {
  operational: true,
  turn_terminal: true,
  chat_lifetime: true,
}
const WORKSPACE_VISIBILITIES: Record<AgentWorkspaceVisibilityV2, true> = {
  owner: true,
  participants: true,
  public: true,
}
const WORKSPACE_TASK_STATES: Record<AgentWorkspaceTaskPreviewV2['state'], true> = {
  pending: true,
  active: true,
  blocked: true,
  completed: true,
  cancelled: true,
  failed: true,
}
const SAFE_TOOL_IDS: Record<string, true> = {
  lore_list_books: true,
  lore_get_book: true,
  lore_list_entries: true,
  lore_get_entry: true,
  lore_search_entries: true,
  chat_search_history: true,
  agent_delegate: true,
  context_pack_list: true,
  context_pack_get: true,
  workspace_read_section: true,
  workspace_read_page: true,
  workspace_create_task: true,
  workspace_update_progress: true,
  workspace_submit_result: true,
  workspace_accept_submission: true,
  workspace_record_finding: true,
  workspace_record_decision: true,
  workspace_record_question: true,
  workspace_attach_artifact: true,
  workspace_propose_publication: true,
  complete_turn: true,
}
const PUBLIC_ERROR_CODES = new Set<string>([
  'capacity_exceeded', 'host_child_admission_limit_exceeded', 'host_tool_call_limit_exceeded',
  'child_admission_limit_exceeded', 'tool_call_limit_exceeded', 'logical_provider_request_limit_exceeded',
  'physical_dispatch_attempt_limit_exceeded', 'child_output_token_limit_exceeded', 'root_wall_clock_limit_exceeded',
  'activity_event_limit_exceeded', 'activity_byte_limit_exceeded', 'lifecycle_log_record_limit_exceeded',
  'context_limit_exceeded', 'initial_input_limit_exceeded', 'argument_limit_exceeded', 'result_limit_exceeded',
  'continuation_limit_exceeded', 'retained_output_limit_exceeded', 'materialized_limit_exceeded', 'timeout',
  'cancelled', 'provider_unavailable', 'provider_unsupported', 'provider_tool_calling_unsupported',
  'provider_tool_continuation_unsupported', 'provider_tool_finalization_unsupported', 'provider_request_error',
  'provider_protocol_error', 'provider_schema_error', 'invalid_task', 'invalid_profile', 'invalid_input', 'invalid_arguments',
  'batch_rejected', 'unknown_tool', 'unauthorized', 'integrity_error', 'internal_error', 'not_found',
  'invalid_request', 'projection_unavailable', 'inspection_unavailable', 'workspace_unavailable',
  'stop_unavailable', 'retry_unavailable', 'target_mismatch', 'stale_target', 'resync_required',
  'recovery_unavailable', 'response_mode_required', 'decision_refresh_required', 'limit_exceeded', 'queue_full',
  'worker_disabled', 'worker_unavailable', 'worker_crashed', 'worker_timed_out', 'worker_malformed',
])
const ERROR_CATEGORIES = new Set(['capacity', 'budget', 'context', 'integrity', 'timeout', 'cancelled', 'provider', 'validation', 'internal'])
const RECOVERY_ACTIONS: Record<AgentRunRecoveryActionV2, true> = {
  retry: true,
  repair: true,
  reselect: true,
  use_response: true,
  resync: true,
  none: true,
}
const TERMINAL_STATUSES: Record<AgentRunStatusV2, boolean> = {
  pending: false,
  running: false,
  waiting: false,
  cancelling: false,
  terminal: true,
}
const MAX_ACTIVITY_NODES = 128
const MAX_WORKSPACE_ENTRIES = 256
const MAX_ID_LENGTH = 256
const MAX_LABEL_LENGTH = 160
const MAX_CURSOR_LENGTH = 2_048
const MAX_INSPECTION_RECORDS = 4_096

function boundedString(value: unknown, maxLength = MAX_ID_LENGTH): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isRunPhase(value: unknown): value is AgentRunPhaseV2 {
  return typeof value === 'string' && Object.hasOwn(RUN_PHASES, value)
}

function isRunStatus(value: unknown): value is AgentRunStatusV2 {
  return typeof value === 'string' && Object.hasOwn(RUN_STATUSES, value)
}
function isRecoveryAction(value: unknown): value is AgentRunRecoveryActionV2 {
  return typeof value === 'string' && Object.hasOwn(RECOVERY_ACTIONS, value)
}
const INSPECTION_LIFECYCLES: Record<AgentInspectionLifecycleV1, true> = {
  ADMIT: true,
  ASSEMBLE: true,
  WORK: true,
  PREPARE_COMMIT: true,
  RENDER: true,
  COMMIT: true,
  TERMINAL: true,
}
const INSPECTION_REASONS: Record<AgentInspectionReasonV1, true> = {
  none: true,
  user_stop: true,
  deadline: true,
  provider_failure: true,
  tool_failure: true,
  required_work_failure: true,
  budget_exhausted: true,
  invalid_input: true,
  stale_input: true,
  unavailable: true,
  needs_attention: true,
  interrupted: true,
  retry_requested: true,
  reconciled: true,
  unknown: true,
}
function isInspectionLifecycle(value: unknown): value is AgentInspectionLifecycleV1 {
  return typeof value === 'string' && Object.hasOwn(INSPECTION_LIFECYCLES, value)
}
function isInspectionReason(value: unknown): value is AgentInspectionReasonV1 {
  return typeof value === 'string' && Object.hasOwn(INSPECTION_REASONS, value)
}
const INSPECTION_MARKER_KINDS: Record<AgentInspectionMarkerKindV1, true> = {
  reconnect_gap: true,
  late_event: true,
  reordered_event: true,
  truncated: true,
  unavailable: true,
  credentials_withheld: true,
  other_user_data_withheld: true,
  recovered_duplicate: true,
}
const INSPECTION_MARKER_SCOPES: Record<AgentInspectionMarkerScopeV1, true> = {
  run: true,
  activity: true,
  transcript: true,
  turn_session: true,
  usage: true,
  prompt: true,
  cortex: true,
  council: true,
  workspace: true,
}
const INSPECTION_AUTHORITIES: Record<AgentInspectionErrorDetailV1['authority'], true> = {
  host: true,
  preset: true,
  provider: true,
  owner: true,
  system: true,
  cortex: true,
  council: true,
}
const INSPECTION_SOURCES: Record<AgentInspectionSourceV1, true> = {
  execution: true,
  projection: true,
  provider: true,
  tool: true,
  host: true,
  recovery: true,
  cortex: true,
  council: true,
  unknown: true,
}
const INSPECTION_SCOPES: Record<AgentInspectionScopeV1, true> = {
  run: true,
  attempt: true,
  turn_session: true,
  target: true,
  phase: true,
  provider: true,
  tool: true,
  usage: true,
  transcript: true,
  cortex: true,
  council: true,
  workspace: true,
}
const ACTIVITY_MILESTONE_KINDS: Record<AgentActivityMilestoneV1['kind'], true> = {
  root: true,
  provider: true,
  child: true,
  tool: true,
  milestone: true,
}
const ACTIVITY_MILESTONE_ACTORS: Record<AgentActivityMilestoneV1['actor'], true> = {
  host: true,
  owner: true,
  provider: true,
  agent: true,
  child: true,
  tool: true,
  cortex: true,
  council: true,
}
const ACTIVITY_MILESTONE_STATUSES: Record<AgentActivityMilestoneV1['status'], true> = {
  pending: true,
  running: true,
  waiting: true,
  cancelling: true,
  terminal: true,
  omitted: true,
}
const ACTIVITY_RECONCILIATIONS: Record<AgentActivityTreeV1['reconciliation'], true> = {
  authoritative: true,
  reconciling: true,
  recovered: true,
  stale: true,
}
function nullableBoundedString(value: unknown): string | null | undefined {
  return value === undefined ? undefined : value === null ? null : boundedString(value)
}
function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  return value === undefined ? undefined : value === null ? null : nonNegativeInteger(value)
}
function isOwn<T extends string>(values: Record<T, true>, value: unknown): value is T {
  return typeof value === 'string' && Object.hasOwn(values, value)
}
function normalizeInspectionCorrelation(value: unknown): AgentInspectionCorrelationV1 | null {
  if (!isUnknownRecord(value)) return null
  const turnSessionId = boundedString(value.turnSessionId)
  const runId = boundedString(value.runId)
  const attemptId = boundedString(value.attemptId)
  const chatId = boundedString(value.chatId)
  const generationId = boundedString(value.generationId)
  const messageId = nullableBoundedString(value.messageId)
  const swipeId = nullableNonNegativeInteger(value.swipeId)
  const actorId = nullableBoundedString(value.actorId)
  const recipientId = nullableBoundedString(value.recipientId)
  const phase = isInspectionLifecycle(value.phase) ? value.phase : null
  const taskId = nullableBoundedString(value.taskId)
  const toolId = nullableBoundedString(value.toolId)
  const parentId = nullableBoundedString(value.parentId)
  const hostCorrelationId = boundedString(value.hostCorrelationId)
  const hostSequence = nonNegativeInteger(value.hostSequence)
  if (!turnSessionId || !runId || !attemptId || !chatId || !generationId || messageId === undefined || swipeId === undefined || actorId === undefined || recipientId === undefined || !phase || taskId === undefined || toolId === undefined || parentId === undefined || !hostCorrelationId || hostSequence === null) return null
  return { turnSessionId, runId, attemptId, chatId, generationId, messageId, swipeId, actorId, recipientId, phase, taskId, toolId, parentId, hostCorrelationId, hostSequence }
}
function normalizeInspectionMarker(value: unknown): AgentInspectionMarkerV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const kind = isOwn(INSPECTION_MARKER_KINDS, value.kind) ? value.kind : null
  const scope = isOwn(INSPECTION_MARKER_SCOPES, value.scope) ? value.scope : null
  const correlation = value.correlation === null ? null : normalizeInspectionCorrelation(value.correlation)
  const firstSequence = nullableNonNegativeInteger(value.firstSequence)
  const lastSequence = nullableNonNegativeInteger(value.lastSequence)
  const recoverable = value.recoverable === null ? null : typeof value.recoverable === 'boolean' ? value.recoverable : undefined
  const detail = value.detail === null ? null : typeof value.detail === 'string' ? value.detail : undefined
  if (!id || !kind || !scope || correlation === null && value.correlation !== null || firstSequence === undefined || lastSequence === undefined || recoverable === undefined || detail === undefined) return null
  return { version: 1, id, kind, scope, correlation, firstSequence, lastSequence, recoverable, detail }
}
function normalizeActivityMilestone(value: unknown): AgentActivityMilestoneV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const parentId = nullableBoundedString(value.parentId)
  const kind = isOwn(ACTIVITY_MILESTONE_KINDS, value.kind) ? value.kind : null
  const actor = isOwn(ACTIVITY_MILESTONE_ACTORS, value.actor) ? value.actor : null
  const phase = isInspectionLifecycle(value.phase) ? value.phase : null
  const status = isOwn(ACTIVITY_MILESTONE_STATUSES, value.status) ? value.status : null
  const label = typeof value.label === 'string' ? value.label : null
  const toolId = nullableBoundedString(value.toolId)
  const taskId = nullableBoundedString(value.taskId)
  const sequence = nonNegativeInteger(value.sequence)
  const startedAt = nonNegativeInteger(value.startedAt)
  const endedAt = nullableNonNegativeInteger(value.endedAt)
  const elapsedMs = nullableNonNegativeInteger(value.elapsedMs)
  const usage = value.usage === null ? null : normalizeInspectionUsageEvidence(value.usage)
  const correlation = normalizeInspectionCorrelation(value.correlation)
  if (!id || parentId === undefined || !kind || !actor || !phase || !status || !label || toolId === undefined || taskId === undefined || sequence === null || startedAt === null || endedAt === undefined || elapsedMs === undefined || usage === null && value.usage !== null || !correlation) return null
  return { version: 1, id, parentId, kind, actor, phase, status, label, toolId, taskId, sequence, startedAt, endedAt, elapsedMs, usage, correlation }
}
function normalizeActivityTree(value: unknown): AgentActivityTreeV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !Array.isArray(value.milestones) || !Array.isArray(value.markers)) return null
  const attempt = normalizeAttempt(value.attempt)
  const lifecycle = isInspectionLifecycle(value.lifecycle) ? value.lifecycle : null
  const status = isRunStatus(value.status) ? value.status : null
  const outcome = value.outcome === null ? null : isRunOutcome(value.outcome) ? value.outcome : undefined
  const reason = isInspectionReason(value.reason) ? value.reason : null
  const revision = nonNegativeInteger(value.revision)
  const startedAt = nonNegativeInteger(value.startedAt)
  const updatedAt = nonNegativeInteger(value.updatedAt)
  const terminalAt = nullableNonNegativeInteger(value.terminalAt)
  const target = normalizeTarget(value.target)
  const usage = normalizeUsage(value.usage)
  const reconciliation = isOwn(ACTIVITY_RECONCILIATIONS, value.reconciliation) ? value.reconciliation : null
  const milestones = value.milestones.map(normalizeActivityMilestone)
  const markers = value.markers.map(normalizeInspectionMarker)
  if (!attempt || !lifecycle || !status || outcome === undefined || !reason || revision === null || startedAt === null || updatedAt === null || terminalAt === undefined || target === undefined || !usage || !reconciliation || milestones.some((item) => item === null) || markers.some((item) => item === null)) return null
  return { version: 1, attempt, lifecycle, status, outcome, reason, revision, startedAt, updatedAt, terminalAt, target, milestones: milestones.filter((item): item is AgentActivityMilestoneV1 => item !== null), usage, markers: markers.filter((item): item is AgentInspectionMarkerV1 => item !== null), reconciliation }
}
const INSPECTION_STOP_STATES: Record<AgentRunInspectionStopV1['state'], true> = {
  accepted: true,
  too_late: true,
  terminal: true,
  failed: true,
  reconciled: true,
}

function isGenerationType(value: unknown): value is AgentRunGenerationTypeV2 {
  return typeof value === 'string' && Object.hasOwn(GENERATION_TYPES, value)
}

function isPublicErrorCode(value: unknown): value is AgentRunPublicErrorCodeV2 {
  return typeof value === 'string' && PUBLIC_ERROR_CODES.has(value)
}

function normalizeUsage(value: unknown): AgentRunUsageV2 | null {
  if (!isUnknownRecord(value)) return null
  const inputTokens = nonNegativeInteger(value.inputTokens)
  const outputTokens = nonNegativeInteger(value.outputTokens)
  const totalTokens = nonNegativeInteger(value.totalTokens)
  const toolCalls = nonNegativeInteger(value.toolCalls)
  const childInvocations = nonNegativeInteger(value.childInvocations)
  if ([inputTokens, outputTokens, totalTokens, toolCalls, childInvocations].some((item) => item === null)) return null
  return { inputTokens, outputTokens, totalTokens, toolCalls, childInvocations }
}

function normalizeOmission(value: unknown): AgentOmissionMarkerV2 | null {
  if (!isUnknownRecord(value)) return null
  const omittedNodeCount = nonNegativeInteger(value.omittedNodeCount)
  const omittedEventCount = nonNegativeInteger(value.omittedEventCount)
  const firstOmittedSequence = value.firstOmittedSequence === null ? null : nonNegativeInteger(value.firstOmittedSequence)
  const lastOmittedSequence = value.lastOmittedSequence === null ? null : nonNegativeInteger(value.lastOmittedSequence)
  if (
    omittedNodeCount === null || omittedEventCount === null
    || firstOmittedSequence === null && value.firstOmittedSequence !== null
    || lastOmittedSequence === null && value.lastOmittedSequence !== null
  ) return null
  return { omittedNodeCount, omittedEventCount, firstOmittedSequence, lastOmittedSequence }
}

function normalizeTarget(value: unknown): AgentRunTargetV2 | null | undefined {
  if (value === null) return null
  if (!isUnknownRecord(value)) return undefined
  const messageId = boundedString(value.messageId)
  const swipeId = nonNegativeInteger(value.swipeId)
  return messageId && swipeId !== null ? { messageId, swipeId } : undefined
}

function normalizeWorkTarget(value: unknown): AgentWorkTargetIdentityV1 | null {
  if (!isUnknownRecord(value)) return null
  const chatId = boundedString(value.chatId)
  const generationType = isGenerationType(value.generationType) ? value.generationType : null
  const messageId = value.messageId === null ? null : boundedString(value.messageId)
  const swipeId = value.swipeId === null ? null : nonNegativeInteger(value.swipeId)
  if (!chatId || !generationType || messageId === null && value.messageId !== null || swipeId === null && value.swipeId !== null) return null
  return { chatId, generationType, messageId, swipeId }
}

function normalizeAttempt(value: unknown): AgentWorkAttemptLineageV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const attemptId = boundedString(value.attemptId)
  const previousAttemptId = value.previousAttemptId === null ? null : boundedString(value.previousAttemptId)
  const target = normalizeWorkTarget(value.target)
  const createdAt = nonNegativeInteger(value.createdAt)
  if (!attemptId || !target || createdAt === null || previousAttemptId === null && value.previousAttemptId !== null) return null
  return { version: 1, attemptId, previousAttemptId, target, createdAt }
}

function normalizeError(value: unknown): AgentRunPublicErrorV2 | undefined {
  if (!isUnknownRecord(value)) return undefined
  const code = isPublicErrorCode(value.code) ? value.code : null
  const category = typeof value.category === 'string' && ERROR_CATEGORIES.has(value.category)
    ? value.category as AgentRunPublicErrorV2['category']
    : null
  const summaryCode = boundedString(value.summaryCode, MAX_LABEL_LENGTH)
  const recoveryAction = isRecoveryAction(value.recoveryAction) ? value.recoveryAction : null
  const target = value.target === null ? null : normalizeWorkTarget(value.target)
  const workPhase = isRunPhase(value.workPhase) ? value.workPhase : null
  const workStatus = isRunStatus(value.workStatus) ? value.workStatus : null
  const workOutcome = value.workOutcome === null ? null : isRunOutcome(value.workOutcome) ? value.workOutcome : undefined
  const omissionCount = nonNegativeInteger(value.omissionCount)
  const inspectionAttemptId = value.inspectionAttemptId === null ? null : boundedString(value.inspectionAttemptId)
  const reason = value.reason === null ? null : boundedString(value.reason, MAX_LABEL_LENGTH)
  if (
    !code || !category || !summaryCode || typeof value.recoveryEligible !== 'boolean' || !recoveryAction
    || target === null && value.target !== null || !workPhase || !workStatus || workOutcome === undefined
    || omissionCount === null || inspectionAttemptId === null && value.inspectionAttemptId !== null
    || reason === null && value.reason !== null
  ) return undefined
  return {
    code,
    category,
    summaryCode,
    recoveryEligible: value.recoveryEligible,
    recoveryAction,
    target,
    workPhase,
    workStatus,
    workOutcome,
    reason,
    omissionCount,
    inspectionAttemptId,
  }
}

function isInspectionErrorCategory(value: unknown): value is AgentInspectionErrorDetailV1['category'] {
  return typeof value === 'string' && ERROR_CATEGORIES.has(value)
}
function normalizeInspectionCapGate(value: unknown): AgentInspectionCapGateV1 | null | undefined {
  if (value === null) return null
  if (!isUnknownRecord(value)) return undefined
  const id = boundedString(value.id)
  const limit = nullableNonNegativeInteger(value.limit)
  const observed = nullableNonNegativeInteger(value.observed)
  const authority = isOwn(INSPECTION_AUTHORITIES, value.authority) ? value.authority : null
  const source = isOwn(INSPECTION_SOURCES, value.source) ? value.source : null
  if (!id || limit === undefined || observed === undefined || !authority || !source || typeof value.exceeded !== 'boolean') return undefined
  return { id, limit, observed, exceeded: value.exceeded, authority, source }
}
function normalizeInspectionErrorDetail(value: unknown): AgentInspectionErrorDetailV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const inspectionAttemptId = boundedString(value.inspectionAttemptId)
  const code = typeof value.code === 'string' ? value.code : null
  const category = isInspectionErrorCategory(value.category) ? value.category : null
  const summaryCode = boundedString(value.summaryCode, MAX_LABEL_LENGTH)
  const causalCode = value.causalCode === null ? null : typeof value.causalCode === 'string' ? value.causalCode : undefined
  const authority = isOwn(INSPECTION_AUTHORITIES, value.authority) ? value.authority : null
  const source = isOwn(INSPECTION_SOURCES, value.source) ? value.source : null
  const scope = isOwn(INSPECTION_SCOPES, value.scope) ? value.scope : null
  const capGate = normalizeInspectionCapGate(value.capGate)
  const target = normalizeWorkTarget(value.target)
  const workPhase = isRunPhase(value.workPhase) ? value.workPhase : null
  const workStatus = isRunStatus(value.workStatus) ? value.workStatus : null
  const workOutcome = value.workOutcome === null ? null : isRunOutcome(value.workOutcome) ? value.workOutcome : undefined
  const reason = value.reason === null ? null : typeof value.reason === 'string' ? value.reason : undefined
  const recoveryAction = isRecoveryAction(value.recoveryAction) ? value.recoveryAction : null
  const omissionCount = nonNegativeInteger(value.omissionCount)
  if (!inspectionAttemptId || code === null || !category || !summaryCode || causalCode === undefined || !authority || !source || !scope || capGate === undefined || !target || !workPhase || !workStatus || workOutcome === undefined || reason === undefined || typeof value.recoveryEligible !== 'boolean' || !recoveryAction || omissionCount === null) return null
  return { version: 1, inspectionAttemptId, code, category, summaryCode, causalCode, authority, source, scope, capGate, target, workPhase, workStatus, workOutcome, reason, recoveryEligible: value.recoveryEligible, recoveryAction, omissionCount }
}
function normalizeInspectionStop(value: unknown): AgentRunInspectionStopV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const state = isOwn(INSPECTION_STOP_STATES, value.state) ? value.state : null
  const requestedAt = nonNegativeInteger(value.requestedAt)
  const receiptAt = nullableNonNegativeInteger(value.receiptAt)
  const correlation = normalizeInspectionCorrelation(value.correlation)
  const reason = isInspectionReason(value.reason) ? value.reason : null
  if (!state || requestedAt === null || receiptAt === undefined || !correlation || !reason) return null
  return { version: 1, state, requestedAt, receiptAt, correlation, reason }
}
function normalizeActivityNode(value: unknown): AgentActivityNodeV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2) return null
  const id = boundedString(value.id)
  const parentId = value.parentId === null ? null : boundedString(value.parentId)
  const kind = typeof value.kind === 'string' && Object.hasOwn(NODE_KINDS, value.kind) ? value.kind as AgentActivityNodeV2['kind'] : null
  const actor = typeof value.actor === 'string' && Object.hasOwn(NODE_KINDS, value.actor) ? value.actor as AgentActivityNodeV2['actor'] : null
  const phase = isRunPhase(value.phase) ? value.phase : null
  const status = typeof value.status === 'string' && Object.hasOwn(NODE_STATUSES, value.status) ? value.status as AgentActivityNodeStatusV2 : null
  const startedAt = nonNegativeInteger(value.startedAt)
  const elapsedMs = nonNegativeInteger(value.elapsedMs)
  const profileId = value.profileId === undefined ? undefined : boundedString(value.profileId, 128)
  const toolId = value.toolId === undefined
    ? undefined
    : typeof value.toolId === 'string' && Object.hasOwn(SAFE_TOOL_IDS, value.toolId)
      ? value.toolId
      : null
  const roundIndex = value.roundIndex === undefined ? undefined : nonNegativeInteger(value.roundIndex)
  const continuationMode = value.continuationMode === undefined
    ? undefined
    : typeof value.continuationMode === 'string' && Object.hasOwn(CONTINUATION_MODES, value.continuationMode)
      ? value.continuationMode as AgentActivityNodeV2['continuationMode']
      : null
  const usage = value.usage === undefined ? undefined : normalizeUsage(value.usage)
  const errorCode = value.errorCode === undefined ? undefined : isPublicErrorCode(value.errorCode) ? value.errorCode : null
  if (
    !id || parentId === null && value.parentId !== null || !kind || !actor || !phase || !status
    || startedAt === null || elapsedMs === null || profileId === null || toolId === null
    || roundIndex === null || continuationMode === null || errorCode === null
    || value.usage !== undefined && usage === null
  ) return null
  const node: AgentActivityNodeV2 = { version: 2, id, parentId, kind, actor, phase, status, startedAt, elapsedMs }
  if (profileId !== undefined) node.profileId = profileId
  if (toolId !== undefined) node.toolId = toolId
  if (roundIndex !== undefined) node.roundIndex = roundIndex
  if (continuationMode !== undefined) node.continuationMode = continuationMode
  if (usage) node.usage = usage
  if (errorCode !== undefined) node.errorCode = errorCode
  return node
}

function normalizeHandoff(value: unknown): AgentRunPublicV2['terminalHandoff'] {
  if (!isUnknownRecord(value) || value.version !== 2 || typeof value.committed !== 'boolean') return undefined
  const messageId = value.messageId === null ? null : boundedString(value.messageId)
  const swipeId = value.swipeId === null ? null : nonNegativeInteger(value.swipeId)
  const messageRevision = value.messageRevision === null ? null : nonNegativeInteger(value.messageRevision)
  const swipeRevision = value.swipeRevision === null ? null : nonNegativeInteger(value.swipeRevision)
  if (messageId === null && value.messageId !== null || swipeId === null && value.swipeId !== null || messageRevision === null && value.messageRevision !== null || swipeRevision === null && value.swipeRevision !== null) return undefined
  return { version: 2, committed: value.committed, messageId, swipeId, messageRevision, swipeRevision }
}

export function normalizeAgentRunPublicV2(value: unknown): AgentRunPublicV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2) return null
  const runId = boundedString(value.runId)
  const turnId = boundedString(value.turnId)
  const generationId = boundedString(value.generationId)
  const chatId = boundedString(value.chatId)
  const generationType = isGenerationType(value.generationType) ? value.generationType : null
  const target = normalizeTarget(value.target)
  const workPhase = isRunPhase(value.workPhase) ? value.workPhase : null
  const workStatus = isRunStatus(value.workStatus) ? value.workStatus : null
  const workOutcome = value.workOutcome === null ? null : isRunOutcome(value.workOutcome) ? value.workOutcome : undefined
  const revision = nonNegativeInteger(value.revision)
  const sequence = nonNegativeInteger(value.sequence)
  const startedAt = nonNegativeInteger(value.startedAt)
  const updatedAt = nonNegativeInteger(value.updatedAt)
  const omissionCount = nonNegativeInteger(value.omissionCount)
  const inspectionAttemptId = boundedString(value.inspectionAttemptId)
  const attemptLineage = normalizeAttempt(value.attemptLineage)
  const usage = normalizeUsage(value.usage)
  const omission = normalizeOmission(value.omission)
  const recoveryAction = isRecoveryAction(value.recoveryAction) ? value.recoveryAction : null
  const reason = value.reason === null ? null : typeof value.reason === 'string' ? value.reason : undefined
  if (
    !runId || !turnId || !generationId || !chatId || !generationType || target === undefined || !workPhase || !workStatus
    || workOutcome === undefined || revision === null || sequence === null || startedAt === null || updatedAt === null || omissionCount === null
    || !inspectionAttemptId || !attemptLineage || !usage || !omission || !Array.isArray(value.activity)
    || typeof value.recoveryEligible !== 'boolean' || !recoveryAction || reason === undefined
  ) return null
  const normalizedActivity = value.activity.map(normalizeActivityNode)
  const activity = normalizedActivity.filter((node): node is AgentActivityNodeV2 => node !== null)
  if (activity.length !== normalizedActivity.length) return null
  const boundedActivity = activity.slice(0, MAX_ACTIVITY_NODES)
  const run: AgentRunPublicV2 = {
    version: 2,
    runId,
    turnId,
    generationId,
    chatId,
    generationType,
    target,
    workPhase,
    workStatus,
    workOutcome,
    recoveryEligible: value.recoveryEligible,
    recoveryAction,
    omissionCount,
    inspectionAttemptId,
    reason,
    attemptLineage,
    revision,
    sequence,
    startedAt,
    updatedAt,
    activity: boundedActivity,
    usage,
    omission: { ...omission, omittedNodeCount: omission.omittedNodeCount + value.activity.length - boundedActivity.length },
  }
  const error = normalizeError(value.error)
  if (value.error !== undefined && !error) return null
  if (error) run.error = error
  const terminalHandoff = normalizeHandoff(value.terminalHandoff)
  if (value.terminalHandoff !== undefined && !terminalHandoff) return null
  if (terminalHandoff) run.terminalHandoff = terminalHandoff
  return run
}

export function normalizeAgentRunChangeEventV2(value: unknown): AgentRunChangeEventV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2) return null
  const chatId = boundedString(value.chatId)
  const sequence = nonNegativeInteger(value.sequence)
  const run = normalizeAgentRunPublicV2(value.run)
  const omission = normalizeOmission(value.omission)
  if (!chatId || sequence === null || !run || !omission || run.chatId !== chatId || run.sequence !== sequence) return null
  return { version: 2, chatId, sequence, run, omission }
}

function normalizeResyncPage(value: unknown): AgentRunResyncPageV1 | undefined {
  if (!isUnknownRecord(value)) return undefined
  const offset = nonNegativeInteger(value.offset)
  const returnedRuns = nonNegativeInteger(value.returnedRuns)
  const totalRuns = nonNegativeInteger(value.totalRuns)
  const snapshotSequence = nonNegativeInteger(value.snapshotSequence)
  const omittedRuns = nonNegativeInteger(value.omittedRuns)
  if (offset === null || returnedRuns === null || totalRuns === null || snapshotSequence === null || omittedRuns === null || typeof value.complete !== 'boolean' || returnedRuns > 16 || omittedRuns !== Math.max(0, totalRuns - offset - returnedRuns)) return undefined
  return { offset, returnedRuns, totalRuns, snapshotSequence, complete: value.complete, omittedRuns }
}

export function normalizeAgentRunChangesV2(value: unknown): AgentRunChangesV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2 || !isUnknownRecord(value.cursor) || value.cursor.version !== 1) return null
  const chatId = boundedString(value.chatId)
  const token = boundedString(value.cursor.token, MAX_CURSOR_LENGTH)
  const lastSequence = nonNegativeInteger(value.lastSequence)
  const cursorSequence = nonNegativeInteger(value.cursorSequence)
  const tailSequence = nonNegativeInteger(value.tailSequence)
  const omission = normalizeOmission(value.omission)
  const resyncPage = value.resyncPage === undefined ? undefined : normalizeResyncPage(value.resyncPage)
  if (!chatId || !token || lastSequence === null || cursorSequence === null || tailSequence === null || lastSequence !== cursorSequence || tailSequence < lastSequence || typeof value.hasMore !== 'boolean' || typeof value.resync !== 'boolean' || value.resyncPage !== undefined && !resyncPage || !Array.isArray(value.runs) || !Array.isArray(value.events) || !omission) return null
  const runs = value.runs.map(normalizeAgentRunPublicV2).filter((run): run is AgentRunPublicV2 => run !== null)
  const events = value.events.map(normalizeAgentRunChangeEventV2).filter((event): event is AgentRunChangeEventV2 => event !== null)
  if (runs.length !== value.runs.length || events.length !== value.events.length) return null
  if (runs.some((run) => run.chatId !== chatId) || events.some((event) => event.chatId !== chatId)) return null
  return { version: 2, chatId, cursor: { version: 1, token }, cursorSequence, lastSequence, tailSequence, hasMore: value.hasMore, resync: value.resync, ...(resyncPage ? { resyncPage } : {}), runs, events, omission }
}

function normalizeWorkspaceRetention(value: unknown): AgentWorkspaceRetentionV2 | null {
  return typeof value === 'string' && Object.hasOwn(WORKSPACE_RETENTIONS, value) ? value as AgentWorkspaceRetentionV2 : null
}
function normalizeWorkspaceVisibility(value: unknown): AgentWorkspaceVisibilityV2 | null {
  return typeof value === 'string' && Object.hasOwn(WORKSPACE_VISIBILITIES, value) ? value as AgentWorkspaceVisibilityV2 : null
}

export function normalizeAgentWorkspaceIndexV2(value: unknown): AgentWorkspaceIndexPublicV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2 || !Array.isArray(value.sections)) return null
  const turnId = boundedString(value.turnId)
  const workspaceRevision = nonNegativeInteger(value.workspaceRevision)
  const omitted = nonNegativeInteger(value.omitted)
  if (!turnId || workspaceRevision === null || omitted === null) return null
  const sections: AgentWorkspaceIndexPublicV2['sections'] = []
  const seen = new Set<AgentWorkspaceSectionV2>()
  for (const raw of value.sections) {
    if (!isUnknownRecord(raw) || typeof raw.section !== 'string' || !Object.hasOwn(WORKSPACE_SECTIONS, raw.section)) return null
    const section = raw.section as AgentWorkspaceSectionV2
    const count = nonNegativeInteger(raw.count)
    const revision = nonNegativeInteger(raw.revision)
    const retention = normalizeWorkspaceRetention(raw.retention)
    const visibility = normalizeWorkspaceVisibility(raw.visibility)
    if (seen.has(section) || count === null || revision === null || !retention || !visibility) return null
    seen.add(section)
    sections.push({ section, count, revision, retention, visibility })
  }
  return { version: 2, turnId, workspaceRevision, sections, omitted }
}

function normalizeWorkspaceEntry(value: unknown): AgentWorkspaceEntryPreviewV2 | null {
  if (!isUnknownRecord(value)) return null
  const id = boundedString(value.id)
  const revision = nonNegativeInteger(value.revision)
  const retention = normalizeWorkspaceRetention(value.retention)
  const visibility = normalizeWorkspaceVisibility(value.visibility)
  if (!id || revision === null || !retention || !visibility || typeof value.kind !== 'string') return null
  const base = { id, revision, retention, visibility }
  if (value.kind === 'task') {
    const title = boundedString(value.title, MAX_LABEL_LENGTH)
    const dependencyCount = nonNegativeInteger(value.dependencyCount)
    if (!title || dependencyCount === null || !isOwn(WORKSPACE_TASK_STATES, value.state) || typeof value.required !== 'boolean' || typeof value.assigned !== 'boolean') return null
    return { ...base, kind: 'task', title, dependencyCount, state: value.state, required: value.required, assigned: value.assigned }
  }
  if (value.kind === 'submission') {
    const taskId = boundedString(value.taskId)
    const profileId = value.profileId === null ? null : boundedString(value.profileId, 128)
    const states = ['submitted', 'accepted', 'rejected']
    if (!taskId || profileId === null && value.profileId !== null || typeof value.state !== 'string' || !states.includes(value.state)) return null
    return { ...base, kind: 'submission', taskId, profileId, state: value.state as 'submitted' | 'accepted' | 'rejected' }
  }
  if (value.kind === 'finding' || value.kind === 'decision' || value.kind === 'question') {
    const title = boundedString(value.title, MAX_LABEL_LENGTH)
    const states = ['active', 'accepted', 'omitted']
    if (!title || typeof value.state !== 'string' || !states.includes(value.state)) return null
    return { ...base, kind: value.kind, title, state: value.state as 'active' | 'accepted' | 'omitted' }
  }
  if (value.kind === 'artifact') {
    const name = boundedString(value.name, MAX_LABEL_LENGTH)
    const mimeType = boundedString(value.mimeType, 128)
    const byteCount = nonNegativeInteger(value.byteCount)
    const digestPrefix = boundedString(value.digestPrefix, 64)
    if (!name || !mimeType || byteCount === null || !digestPrefix || typeof value.published !== 'boolean') return null
    return { ...base, kind: 'artifact', name, mimeType, byteCount, digestPrefix, published: value.published }
  }
  return null
}

export function normalizeAgentWorkspaceSectionV2(value: unknown): AgentWorkspaceSectionPreviewV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2 || !Array.isArray(value.entries)) return null
  const turnId = boundedString(value.turnId)
  const workspaceRevision = nonNegativeInteger(value.workspaceRevision)
  const omitted = nonNegativeInteger(value.omitted)
  const nextPage = value.nextPage === null ? null : boundedString(value.nextPage, MAX_CURSOR_LENGTH)
  if (!turnId || workspaceRevision === null || omitted === null || typeof value.section !== 'string' || !Object.hasOwn(WORKSPACE_SECTIONS, value.section) || nextPage === null && value.nextPage !== null) return null
  const entries = value.entries.slice(0, MAX_WORKSPACE_ENTRIES).map(normalizeWorkspaceEntry).filter((entry): entry is AgentWorkspaceEntryPreviewV2 => entry !== null)
  if (entries.length !== Math.min(value.entries.length, MAX_WORKSPACE_ENTRIES)) return null
  return { version: 2, turnId, section: value.section as AgentWorkspaceSectionV2, workspaceRevision, entries, nextPage, omitted: omitted + value.entries.length - entries.length }
}

function inspectionAvailability(value: unknown): AgentInspectionSectionAvailabilityV1[] | null {
  if (!Array.isArray(value) || value.length !== 9) return null
  const states: Record<AgentInspectionSectionStateV1, true> = { available: true, not_recorded: true, source_deleted: true, unavailable: true, withheld: true }
  const scopes: Record<AgentInspectionSectionIdV1, true> = { run: true, activity: true, transcript: true, turn_session: true, usage: true, prompt: true, cortex: true, council: true, workspace: true }
  const seen = new Set<AgentInspectionSectionIdV1>()
  const normalized: AgentInspectionSectionAvailabilityV1[] = []
  for (const item of value) {
    if (!isUnknownRecord(item) || typeof item.section !== 'string' || !Object.hasOwn(scopes, item.section) || typeof item.state !== 'string' || !Object.hasOwn(states, item.state) || item.reason !== null && !isInspectionReason(item.reason)) return null
    const section = item.section as AgentInspectionSectionIdV1
    if (seen.has(section)) return null
    seen.add(section)
    normalized.push({ section, state: item.state as AgentInspectionSectionStateV1, reason: item.reason as AgentInspectionSectionAvailabilityV1['reason'] })
  }
  return normalized
}

function normalizeInspectionUsageEvidence(value: unknown): AgentInspectionUsageV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const source = typeof value.source === 'string' && ['provider_reported', 'provisional', 'final', 'recovered_duplicate'].includes(value.source) ? value.source : null
  const layer = value.layer === undefined ? undefined : typeof value.layer === 'string' && ['root', 'child', 'provider', 'tool', 'cortex', 'council'].includes(value.layer) ? value.layer : null
  const correlation = value.correlation === null ? null : normalizeInspectionCorrelation(value.correlation)
  const counters = [value.inputTokens, value.outputTokens, value.totalTokens, value.toolCalls, value.childInvocations].map(nonNegativeInteger)
  if (!id || !source || layer === null || counters.some((counter) => counter === null) || typeof value.canonical !== 'boolean' || value.correlation !== null && correlation === null) return null
  return {
    version: 1,
    id,
    source: source as AgentInspectionUsageV1['source'],
    ...(layer ? { layer: layer as AgentInspectionUsageV1['layer'] } : {}),
    correlation,
    inputTokens: counters[0]!,
    outputTokens: counters[1]!,
    totalTokens: counters[2]!,
    toolCalls: counters[3]!,
    childInvocations: counters[4]!,
    canonical: value.canonical,
  }
}

function normalizeInspectionUsageLayer(value: unknown): AgentInspectionUsageLayerV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !Array.isArray(value.evidenceIds)) return null
  const source = typeof value.source === 'string' && ['provider_reported', 'provisional', 'final', 'recovered_duplicate'].includes(value.source) ? value.source : null
  const layer = typeof value.layer === 'string' && ['root', 'child', 'provider', 'tool', 'cortex', 'council'].includes(value.layer) ? value.layer : null
  const correlation = value.correlation === null
    ? null
    : normalizeInspectionCorrelation(value.correlation) ?? undefined
  const counters = [value.inputTokens, value.outputTokens, value.totalTokens, value.toolCalls, value.childInvocations].map(nonNegativeInteger)
  const evidenceIds = value.evidenceIds.slice(0, MAX_INSPECTION_RECORDS).map((id) => boundedString(id)).filter((id): id is string => id !== null)
  if (!source || !layer || correlation === undefined || counters.some((counter) => counter === null) || evidenceIds.length !== value.evidenceIds.length || typeof value.canonical !== 'boolean') return null
  return {
    version: 1,
    source: source as AgentInspectionUsageLayerV1['source'],
    layer: layer as AgentInspectionUsageLayerV1['layer'],
    correlation,
    inputTokens: counters[0]!,
    outputTokens: counters[1]!,
    totalTokens: counters[2]!,
    toolCalls: counters[3]!,
    childInvocations: counters[4]!,
    evidenceIds,
    canonical: value.canonical,
  }
}

function normalizeInspectionUsageProjection(value: unknown): AgentInspectionUsageProjectionV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !Array.isArray(value.layers)) return null
  const inspectionAttemptId = boundedString(value.inspectionAttemptId)
  const totals = normalizeUsage(value.totals)
  const evidenceCount = nonNegativeInteger(value.evidenceCount)
  const omittedEvidenceCount = nonNegativeInteger(value.omittedEvidenceCount)
  const layers: AgentInspectionUsageLayerV1[] = []
  for (const raw of value.layers.slice(0, MAX_INSPECTION_RECORDS)) {
    const layer = normalizeInspectionUsageLayer(raw)
    if (!layer) return null
    layers.push(layer)
  }
  if (!inspectionAttemptId || !totals || evidenceCount === null || omittedEvidenceCount === null) return null
  return { version: 1, inspectionAttemptId, totals, layers, evidenceCount, omittedEvidenceCount }
}

function normalizeInspectionRetry(value: unknown): AgentRunInspectionRetryV1 | null {
  if (!isUnknownRecord(value) || typeof value.allowed !== 'boolean' || !isInspectionReason(value.reason) || typeof value.targetValid !== 'boolean') return null
  const linkedAttemptId = value.linkedAttemptId === null ? null : boundedString(value.linkedAttemptId)
  if (linkedAttemptId === null && value.linkedAttemptId !== null) return null
  return { allowed: value.allowed, reason: value.reason, targetValid: value.targetValid, linkedAttemptId }
}

function normalizeInspectionSummary(value: unknown): AgentRunInspectionSummaryV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !isUnknownRecord(value.attempt) || !isUnknownRecord(value.activity)) return null
  const attempt = normalizeAttempt(value.attempt)
  const lifecycle = isInspectionLifecycle(value.lifecycle) ? value.lifecycle : null
  const status = isRunStatus(value.status) ? value.status : null
  const outcome = value.outcome === null ? null : isRunOutcome(value.outcome) ? value.outcome : undefined
  const reason = isInspectionReason(value.reason) ? value.reason : null
  const target = normalizeTarget(value.target)
  const committedTarget = normalizeTarget(value.committedTarget)
  const hostCorrelationId = boundedString(value.hostCorrelationId)
  const revision = nonNegativeInteger(value.revision)
  const startedAt = nonNegativeInteger(value.startedAt)
  const updatedAt = nonNegativeInteger(value.updatedAt)
  const terminalAt = nullableNonNegativeInteger(value.terminalAt)
  const markerCount = nonNegativeInteger(value.markerCount)
  const transcriptCount = nonNegativeInteger(value.transcriptCount)
  const activity = normalizeActivityTree(value.activity)
  if (!attempt || !lifecycle || !status || outcome === undefined || !reason || target === undefined || committedTarget === undefined || !hostCorrelationId || revision === null || startedAt === null || updatedAt === null || terminalAt === undefined || markerCount === null || transcriptCount === null || typeof value.terminal !== 'boolean' || !activity) return null
  return {
    version: 1,
    attempt,
    hostCorrelationId,
    lifecycle,
    status,
    outcome,
    reason,
    target,
    committedTarget,
    revision,
    startedAt,
    updatedAt,
    terminalAt,
    activity,
    markerCount,
    transcriptCount,
    terminal: value.terminal,
  }
}

export function normalizeAgentRunInspectionDetailV1(value: unknown): AgentRunInspectionDetailV1 | null {
  if (!isUnknownRecord(value) || !Array.isArray(value.transcript) || !Array.isArray(value.turnSession) || !Array.isArray(value.markers) || !Array.isArray(value.usageEvidence) || !Array.isArray(value.promptEvidence) || !Array.isArray(value.cortexReceipts) || !Array.isArray(value.councilReceipts) || !Array.isArray(value.workspaceAssociations) || !Array.isArray(value.sectionAvailability)) return null
  const summary = normalizeInspectionSummary(value)
  const usage = normalizeInspectionUsageProjection(value.usage)
  const retry = normalizeInspectionRetry(value.retry)
  const error = value.error === null ? null : normalizeInspectionErrorDetail(value.error)
  const markers = value.markers.slice(0, MAX_INSPECTION_RECORDS).map(normalizeInspectionMarker)
  const usageEvidence = value.usageEvidence.slice(0, MAX_INSPECTION_RECORDS).map(normalizeInspectionUsageEvidence)
  const stop = value.stop === null ? null : normalizeInspectionStop(value.stop)
  const sectionAvailability = inspectionAvailability(value.sectionAvailability)
  if (!summary || !usage || !retry || !sectionAvailability || value.error !== null && !error || markers.some((item) => item === null) || usageEvidence.some((item) => item === null) || value.stop !== null && !stop) return null
  return {
    ...summary,
    transcript: value.transcript.slice(0, MAX_INSPECTION_RECORDS) as AgentRunInspectionDetailV1['transcript'],
    turnSession: value.turnSession.slice(0, MAX_INSPECTION_RECORDS) as AgentRunInspectionDetailV1['turnSession'],
    markers: markers.filter((item): item is AgentInspectionMarkerV1 => item !== null),
    usageEvidence: usageEvidence.filter((item): item is AgentInspectionUsageV1 => item !== null),
    usage,
    error,
    promptEvidence: value.promptEvidence.slice(0, MAX_INSPECTION_RECORDS) as AgentRunInspectionDetailV1['promptEvidence'],
    cortexReceipts: value.cortexReceipts.slice(0, MAX_INSPECTION_RECORDS) as AgentCortexReceiptV1[],
    councilReceipts: value.councilReceipts.slice(0, MAX_INSPECTION_RECORDS) as AgentCouncilReceiptV1[],
    workspaceAssociations: value.workspaceAssociations.slice(0, MAX_INSPECTION_RECORDS) as AgentRunInspectionDetailV1['workspaceAssociations'],
    stop,
    retry,
    sectionAvailability,
  }
}

export function normalizeAgentRunInspectionRetryResponseV1(value: unknown): AgentRunInspectionRetryResponseV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || typeof value.accepted !== 'boolean' || !isInspectionReason(value.reason)) return null
  const attempt = value.attempt === null ? null : normalizeAttempt(value.attempt)
  if (attempt === null && value.attempt !== null) return null
  const target = value.target === undefined ? undefined : normalizeWorkTarget(value.target)
  if (target === null) return null
  const recoveryAction = value.recoveryAction === undefined ? undefined : isRecoveryAction(value.recoveryAction) ? value.recoveryAction : null
  if (recoveryAction === null) return null
  const inspectionAttemptId: string | null | undefined = value.inspectionAttemptId === undefined ? undefined : value.inspectionAttemptId === null ? null : boundedString(value.inspectionAttemptId)
  if (inspectionAttemptId === null && value.inspectionAttemptId !== null) return null
  const recoveryEligible = value.recoveryEligible === undefined ? undefined : typeof value.recoveryEligible === 'boolean' ? value.recoveryEligible : null
  if (recoveryEligible === null) return null
  const error = value.error === undefined ? undefined : normalizeError(value.error)
  if (value.error !== undefined && !error) return null
  const reason = value.reason
  return { version: 1, accepted: value.accepted, attempt, reason, ...(target ? { target } : {}), ...(recoveryEligible === undefined ? {} : { recoveryEligible }), ...(recoveryAction ? { recoveryAction } : {}), ...(inspectionAttemptId !== undefined ? { inspectionAttemptId } : {}), ...(error ? { error } : {}) }
}

export function normalizeAgentRunInspectionListV1(value: unknown): AgentRunInspectionListV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !Array.isArray(value.runs)) return null
  const chatId = boundedString(value.chatId)
  if (!chatId) return null
  const nextCursor = value.nextCursor === null ? null : boundedString(value.nextCursor, MAX_CURSOR_LENGTH)
  if (nextCursor === null && value.nextCursor !== null) return null
  const runs = value.runs.slice(0, 64).map(normalizeInspectionSummary).filter((run): run is AgentRunInspectionSummaryV1 => run !== null)
  const omission = value.omission === null ? null : normalizeInspectionMarker(value.omission)
  if (value.omission !== null && !omission) return null
  return { version: 1, chatId, runs, nextCursor, omission }
}

export function agentRunProvisionalKey(run: Pick<AgentRunPublicV2, 'chatId' | 'turnId' | 'generationType' | 'target'>): string {
  const target = run.target ? `${run.target.messageId}:${run.target.swipeId}` : 'pending'
  return `${run.chatId}:${run.turnId}:${run.generationType}:${target}`
}
export function agentRunTerminalTargetKey(chatId: string, messageId: string, swipeId: number): string {
  return `${chatId}:${messageId}:${swipeId}`
}
function compareNumber(left: number, right: number): number { return left === right ? 0 : left < right ? -1 : 1 }
function compareText(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1 }
function isTerminalRun(run: AgentRunPublicV2): boolean { return TERMINAL_STATUSES[run.workStatus] }
function isActiveRun(run: AgentRunPublicV2): boolean { return !isTerminalRun(run) }
function compareRunVersion(candidate: AgentRunPublicV2, current: AgentRunPublicV2): number {
  for (const [left, right] of [[candidate.revision, current.revision], [candidate.sequence, current.sequence], [candidate.updatedAt, current.updatedAt], [candidate.startedAt, current.startedAt]] as const) {
    const result = compareNumber(left, right)
    if (result !== 0) return result
  }
  for (const [left, right] of [[candidate.runId, current.runId], [candidate.generationId, current.generationId], [candidate.turnId, current.turnId]] as const) {
    const result = compareText(left, right)
    if (result !== 0) return result
  }
  return 0
}
function compareRunFreshness(candidate: AgentRunPublicV2, current: AgentRunPublicV2): number {
  for (const [left, right] of [[candidate.sequence, current.sequence], [candidate.updatedAt, current.updatedAt], [candidate.startedAt, current.startedAt], [candidate.revision, current.revision]] as const) {
    const result = compareNumber(left, right)
    if (result !== 0) return result
  }
  if (isActiveRun(candidate) !== isActiveRun(current)) return isActiveRun(candidate) ? 1 : -1
  return compareText(candidate.runId, current.runId)
}
function targetRevision(run: AgentRunPublicV2): readonly [number, number] | null {
  const handoff = run.terminalHandoff
  return handoff?.committed && handoff.messageRevision !== null && handoff.swipeRevision !== null ? [handoff.messageRevision, handoff.swipeRevision] : null
}
function compareTargetAuthority(candidate: AgentRunPublicV2, current: AgentRunPublicV2): number {
  const left = targetRevision(candidate)
  const right = targetRevision(current)
  if (left && right) {
    const message = compareNumber(left[0], right[0])
    if (message !== 0) return message
    const swipe = compareNumber(left[1], right[1])
    if (swipe !== 0) return swipe
  }
  return compareRunFreshness(candidate, current)
}
function runTargets(run: AgentRunPublicV2, chatId: string, messageId: string, swipeId: number): boolean {
  if (run.chatId !== chatId) return false
  if (run.target?.messageId === messageId && run.target.swipeId === swipeId) return true
  const handoff = run.terminalHandoff
  return handoff?.committed === true && handoff.messageId === messageId && handoff.swipeId === swipeId
}
function findRunByTurnId(state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey' | 'agentRunTerminalByTarget'>, turnId: string): AgentRunPublicV2 | undefined {
  let selected: AgentRunPublicV2 | undefined
  for (const run of [...Object.values(state.agentRunTerminalByTarget), ...Object.values(state.agentRunProvisionalByKey)]) if (run.turnId === turnId && (!selected || compareRunVersion(run, selected) > 0)) selected = run
  return selected
}
function mergeRun(provisional: Record<string, AgentRunPublicV2>, terminal: Record<string, AgentRunPublicV2>, run: AgentRunPublicV2): void {
  const current = findRunByTurnId({ agentRunProvisionalByKey: provisional, agentRunTerminalByTarget: terminal }, run.turnId)
  if (current && compareRunVersion(run, current) <= 0) return
  if (run.terminalHandoff?.committed && run.terminalHandoff.messageId !== null && run.terminalHandoff.swipeId !== null) {
    const key = agentRunTerminalTargetKey(run.chatId, run.terminalHandoff.messageId, run.terminalHandoff.swipeId)
    const destination = terminal[key]
    if (destination && destination.turnId !== run.turnId && compareTargetAuthority(run, destination) <= 0) return
  }
  for (const [key, value] of Object.entries(provisional)) if (value.turnId === run.turnId) delete provisional[key]
  for (const [key, value] of Object.entries(terminal)) if (value.turnId === run.turnId) delete terminal[key]
  if (run.terminalHandoff?.committed && run.terminalHandoff.messageId !== null && run.terminalHandoff.swipeId !== null) terminal[agentRunTerminalTargetKey(run.chatId, run.terminalHandoff.messageId, run.terminalHandoff.swipeId)] = run
  else provisional[agentRunProvisionalKey(run)] = run
}
function withoutChat<T extends AgentRunPublicV2>(values: Record<string, T>, chatId: string): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([, run]) => run.chatId !== chatId))
}
function workspaceRequestKey(turnId: string, section?: AgentWorkspaceSectionV2): string { return `${turnId}:${section ?? 'index'}` }
function emptyWorkspaceSectionPreview(turnId: string, section: AgentWorkspaceSectionV2, workspaceRevision: number): AgentWorkspaceSectionPreviewV2 {
  return { version: 2, turnId, section, workspaceRevision, entries: [], nextPage: null, omitted: 0 }
}
function normalizePersistentWorkspace(value: unknown): AgentPersistentWorkspaceV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const userId = boundedString(value.userId)
  const chatId = value.chatId === null ? null : boundedString(value.chatId)
  const objective = typeof value.objective === 'string' ? value.objective : null
  const revision = nonNegativeInteger(value.revision)
  const createdAt = nonNegativeInteger(value.createdAt)
  const updatedAt = nonNegativeInteger(value.updatedAt)
  if (!id || !userId || chatId === undefined || objective === null || revision === null || createdAt === null || updatedAt === null || !isUnknownRecord(value.metadata) || !isUnknownRecord(value.progress) || !isUnknownRecord(value.quota) || !isUnknownRecord(value.usage)) return null
  const metadata = value.metadata
  const labels = Array.isArray(metadata.labels) && metadata.labels.every((label) => typeof label === 'string') ? metadata.labels : null
  const progressState = ['not_started', 'in_progress', 'blocked', 'completed'].includes(String(value.progress.state))
  const percent = typeof value.progress.percent === 'number' && Number.isFinite(value.progress.percent) && value.progress.percent >= 0 && value.progress.percent <= 100 ? value.progress.percent : null
  const progressUpdatedAt = nonNegativeInteger(value.progress.updatedAt)
  const quotaValues = ['maxTasks', 'maxRecords', 'maxSubmissions', 'maxArtifacts', 'maxPublications', 'maxBytes'].map((key) => nonNegativeInteger(value.quota[key]))
  const usageValues = ['taskCount', 'recordCount', 'submissionCount', 'artifactCount', 'publicationCount', 'byteCount'].map((key) => nonNegativeInteger(value.usage[key]))
  if (typeof metadata.title !== 'string' || typeof metadata.summary !== 'string' || !labels || typeof metadata.ownerNote !== 'string' || !progressState || percent === null || typeof value.progress.summary !== 'string' || progressUpdatedAt === null || !['active', 'archived'].includes(String(value.state)) || quotaValues.some((item) => item === null) || usageValues.some((item) => item === null)) return null
  return {
    version: 1,
    id,
    userId,
    chatId,
    objective,
    metadata: { title: metadata.title, summary: metadata.summary, labels, ownerNote: metadata.ownerNote },
    progress: { state: value.progress.state as AgentPersistentWorkspaceV1['progress']['state'], percent, summary: value.progress.summary, updatedAt: progressUpdatedAt },
    state: value.state as AgentPersistentWorkspaceV1['state'],
    revision,
    quota: { maxTasks: quotaValues[0]!, maxRecords: quotaValues[1]!, maxSubmissions: quotaValues[2]!, maxArtifacts: quotaValues[3]!, maxPublications: quotaValues[4]!, maxBytes: quotaValues[5]! },
    usage: { taskCount: usageValues[0]!, recordCount: usageValues[1]!, submissionCount: usageValues[2]!, artifactCount: usageValues[3]!, publicationCount: usageValues[4]!, byteCount: usageValues[5]! },
    createdAt,
    updatedAt,
  }
}

type PersistentWorkspaceCollectionItemMapV1 = {
  sessions: AgentPersistentWorkspaceTurnSessionV1
  tasks: AgentPersistentWorkspaceTaskV1
  records: AgentPersistentWorkspaceRecordV1
  artifacts: AgentPersistentWorkspaceArtifactV1
  submissions: AgentPersistentWorkspaceSubmissionV1
  publications: AgentPersistentWorkspacePublicationV1
}
type PersistentWorkspaceCollectionArrayMapV1 = {
  [Collection in AgentPersistentWorkspaceCollectionV1]: PersistentWorkspaceCollectionItemMapV1[Collection][]
}
function isText(value: unknown): value is string { return typeof value === 'string' }
function isNullableText(value: unknown): value is string | null { return value === null || isText(value) }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isText) }
function isNullableNonNegativeInteger(value: unknown): boolean { return value === null || nonNegativeInteger(value) !== null }
function isPersistentWorkspaceProgressShape(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false
  return ['not_started', 'in_progress', 'blocked', 'completed'].includes(String(value.state))
    && typeof value.percent === 'number'
    && Number.isFinite(value.percent)
    && value.percent >= 0
    && value.percent <= 100
    && isText(value.summary)
    && nonNegativeInteger(value.updatedAt) !== null
}
function isPersistentWorkspaceMetadataShape(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false
  return isText(value.title) && isText(value.summary) && isStringArray(value.labels) && isText(value.ownerNote)
}
function isPersistentWorkspaceRecordContentShape(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false
  return isText(value.summary) && isStringArray(value.evidenceIds) && isNullableText(value.provenance)
}
function isPersistentWorkspacePublicationCopyShape(value: unknown): boolean {
  if (!isUnknownRecord(value) || !isText(value.category) || !isText(value.id)) return false
  if (value.category === 'task') {
    return isText(value.title)
      && isText(value.objective)
      && ['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'].includes(String(value.state))
      && typeof value.required === 'boolean'
      && isStringArray(value.dependencyIds)
      && isPersistentWorkspaceProgressShape(value.progress)
      && isText(value.summary)
  }
  if (value.category === 'finding') return isPersistentWorkspaceRecordContentShape(value.content) && isNullableText(value.taskId)
  if (value.category === 'objective') return isText(value.objective) && isPersistentWorkspaceMetadataShape(value.metadata)
  if (value.category === 'artifact') return isText(value.blobDigest) && isText(value.mimeType) && nonNegativeInteger(value.byteCount) !== null && isText(value.provenance)
  return false
}
function hasPersistentWorkspaceCollectionShape(collection: AgentPersistentWorkspaceCollectionV1, item: Record<string, unknown>): boolean {
  const common = boundedString(item.workspaceId)
    && boundedString(item.userId)
    && isNullableText(item.chatId)
    && nonNegativeInteger(item.revision) !== null
    && nonNegativeInteger(item.createdAt) !== null
    && nonNegativeInteger(item.updatedAt) !== null
  if (!common) return false
  if (collection === 'sessions') {
    return boundedString(item.chatId)
      && boundedString(item.turnId)
      && boundedString(item.attemptId)
      && isNullableText(item.executionId)
      && isRunPhase(item.phase)
      && isRunStatus(item.status)
      && (item.outcome === null || isRunOutcome(item.outcome))
      && isNullableNonNegativeInteger(item.terminalAt)
  }
  if (collection === 'tasks') {
    return isNullableText(item.turnSessionId)
      && isText(item.title)
      && isText(item.objective)
      && ['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'].includes(String(item.state))
      && typeof item.required === 'boolean'
      && isStringArray(item.dependencyIds)
      && (item.creator === 'host' || item.creator === 'owner')
      && typeof item.hostAdmitted === 'boolean'
      && isPersistentWorkspaceProgressShape(item.progress)
      && isText(item.summary)
  }
  if (collection === 'records') {
    return isNullableText(item.turnSessionId)
      && (item.chatId === null || boundedString(item.chatId) !== null)
      && (item.kind === 'finding' || item.kind === 'decision' || item.kind === 'question')
      && isPersistentWorkspaceRecordContentShape(item.content)
      && isNullableText(item.taskId)
  }
  if (collection === 'submissions') {
    return isNullableText(item.turnSessionId)
      && boundedString(item.taskId)
      && (item.chatId === null || boundedString(item.chatId) !== null)
      && (item.state === 'submitted' || item.state === 'accepted' || item.state === 'rejected')
      && isText(item.summary)
      && isText(item.resultDigest)
  }
  if (collection === 'artifacts') {
    return isNullableText(item.turnSessionId)
      && (item.chatId === null || boundedString(item.chatId) !== null)
      && isText(item.blobDigest)
      && isText(item.mimeType)
      && nonNegativeInteger(item.byteCount) !== null
      && isText(item.provenance)
  }
  return (item.category === 'task' || item.category === 'finding' || item.category === 'objective' || item.category === 'artifact')
    && boundedString(item.sourceId)
    && nonNegativeInteger(item.sourceRevision) !== null
    && isText(item.sourceDigest)
    && isUnknownRecord(item.sourceProvenance)
    && boundedString(item.sourceProvenance.workspaceId)
    && isNullableText(item.sourceProvenance.turnSessionId)
    && isNullableText(item.sourceProvenance.attemptId)
    && isText(item.sourceProvenance.sourceDigest)
    && isNullableText(item.sourceProvenance.sourceChatId)
    && isNullableText(item.sourceProvenance.sourceMessageId)
    && isNullableNonNegativeInteger(item.sourceProvenance.sourceSwipeId)
    && isNullableNonNegativeInteger(item.sourceProvenance.sourceDeletedAt)
    && isText(item.sourceProvenance.creator)
    && nonNegativeInteger(item.sourceProvenance.capturedAt) !== null
    && nonNegativeInteger(item.sourceCreatedAt) !== null
    && nonNegativeInteger(item.sourceUpdatedAt) !== null
    && isNullableNonNegativeInteger(item.sourceDeletedAt)
    && (item.sourceStatus === 'present' || item.sourceStatus === 'deleted')
    && isUnknownRecord(item.copy)
    && item.copy.category === item.category
    && isPersistentWorkspacePublicationCopyShape(item.copy)
    && isText(item.copyDigest)
    && nonNegativeInteger(item.publishedAt) !== null
    && isText(item.publishedBy)
    && item.revision === 1
}
function isRunOutcome(value: unknown): value is AgentRunOutcomeV2 {
  return typeof value === 'string' && Object.hasOwn(RUN_OUTCOMES, value)
}
function normalizePersistentWorkspaceCollection<C extends AgentPersistentWorkspaceCollectionV1>(
  collection: C,
  value: unknown,
): PersistentWorkspaceCollectionArrayMapV1[C] | null {
  if (!Array.isArray(value)) return null
  const items: unknown[] = []
  for (const item of value) {
    if (!isUnknownRecord(item) || item.version !== 1 || !boundedString(item.id) || !hasPersistentWorkspaceCollectionShape(collection, item)) return null
    items.push(item)
  }
  return items as PersistentWorkspaceCollectionArrayMapV1[C]
}
function emptyPersistentWorkspaceCollections(): AgentPersistentWorkspaceCollectionsStateV1 {
  return {
    sessions: { status: 'idle', items: [], error: null },
    tasks: { status: 'idle', items: [], error: null },
    records: { status: 'idle', items: [], error: null },
    artifacts: { status: 'idle', items: [], error: null },
    submissions: { status: 'idle', items: [], error: null },
    publications: { status: 'idle', items: [], error: null },
  }
}
function readyPersistentWorkspaceCollections(
  current: AgentPersistentWorkspaceCollectionsStateV1,
  collection: AgentPersistentWorkspaceCollectionV1,
  items: PersistentWorkspaceCollectionArrayMapV1[AgentPersistentWorkspaceCollectionV1],
): AgentPersistentWorkspaceCollectionsStateV1 {
  if (collection === 'sessions') return { ...current, sessions: { status: 'ready', items: items as AgentPersistentWorkspaceTurnSessionV1[], error: null } }
  if (collection === 'tasks') return { ...current, tasks: { status: 'ready', items: items as AgentPersistentWorkspaceTaskV1[], error: null } }
  if (collection === 'records') return { ...current, records: { status: 'ready', items: items as AgentPersistentWorkspaceRecordV1[], error: null } }
  if (collection === 'artifacts') return { ...current, artifacts: { status: 'ready', items: items as AgentPersistentWorkspaceArtifactV1[], error: null } }
  if (collection === 'submissions') return { ...current, submissions: { status: 'ready', items: items as AgentPersistentWorkspaceSubmissionV1[], error: null } }
  return { ...current, publications: { status: 'ready', items: items as AgentPersistentWorkspacePublicationV1[], error: null } }
}

export const createAgentRunsSlice: StateCreator<AppStore, [], [], AgentRunsSlice> = (set, get) => ({
  agentRunProvisionalByKey: {},
  agentRunTerminalByTarget: {},
  agentRunCursorByChat: {},
  agentRunLastSequenceByChat: {},
  agentRunCursorSequenceByChat: {},
  agentRunResyncOffsetByChat: {},
  agentRunSyncByChat: {},
  agentRunOmittedEventsByChat: {},
  agentRunRequestEpochByChat: {},
  agentRunInspectionByAttemptId: {},
  agentRunInspectionListByChat: {},
  agentRunInspectionRequestEpochByKey: {},
  agentRunRetryByAttemptId: {},
  agentWorkspaceByTurn: {},
  agentWorkspaceRequestEpochByKey: {},
  agentPersistentWorkspaceByChat: {},
  agentPersistentWorkspaceById: {},
  agentPersistentWorkspaceRequestEpochByKey: {},
  agentPersistentWorkspaceCollectionsById: {},
  agentRuntimeSettingsByChat: {},

  beginAgentRunRestore: (chatId) => {
    const epoch = (get().agentRunRequestEpochByChat[chatId] ?? 0) + 1
    set((state) => ({ agentRunRequestEpochByChat: { ...state.agentRunRequestEpochByChat, [chatId]: epoch }, agentRunSyncByChat: { ...state.agentRunSyncByChat, [chatId]: 'restoring' } }))
    return epoch
  },
  applyAgentRunChanges: (chatId, requestEpoch, payload) => {
    const normalized = normalizeAgentRunChangesV2(payload)
    const state = get()
    if (!normalized || normalized.chatId !== chatId || state.activeChatId !== chatId || state.agentRunRequestEpochByChat[chatId] !== requestEpoch) return false
    set((current) => {
      const consumed = current.agentRunCursorSequenceByChat[chatId] ?? 0
      const incoming = normalized.cursorSequence
      const responseIsOlder = incoming < consumed
      const previousOffset = current.agentRunResyncOffsetByChat[chatId]
      const incomingOffset = normalized.resyncPage?.offset ?? 0
      const pageIsOlder = normalized.resync && previousOffset !== undefined && incomingOffset < previousOffset
      const cursorShouldAdvance = !responseIsOlder && !pageIsOlder && (current.agentRunCursorByChat[chatId] === undefined || incoming >= consumed || normalized.resync && (previousOffset === undefined || incomingOffset >= previousOffset))
      let provisional = { ...current.agentRunProvisionalByKey }
      let terminal = { ...current.agentRunTerminalByTarget }
      if (normalized.resync && incomingOffset === 0 && !pageIsOlder) {
        const preserved = [...Object.values(provisional), ...Object.values(terminal)].filter((run) => run.chatId === chatId && run.sequence >= incoming)
        provisional = withoutChat(provisional, chatId)
        terminal = withoutChat(terminal, chatId)
        preserved.forEach((run) => mergeRun(provisional, terminal, run))
      }
      normalized.runs.forEach((run) => mergeRun(provisional, terminal, run))
      normalized.events.slice().sort((left, right) => left.sequence - right.sequence).forEach((event) => mergeRun(provisional, terminal, event.run))
      const nextConsumed = cursorShouldAdvance ? incoming : consumed
      const nextPublic = Math.max(current.agentRunLastSequenceByChat[chatId] ?? 0, normalized.lastSequence, ...normalized.events.map((event) => event.sequence))
      const incompleteResync = normalized.resync && normalized.resyncPage?.complete === false
      const nextSync = responseIsOlder || pageIsOlder || normalized.hasMore || incompleteResync || nextConsumed < nextPublic ? 'stale' : 'ready'
      const nextOffsets = { ...current.agentRunResyncOffsetByChat }
      if (incompleteResync && cursorShouldAdvance) nextOffsets[chatId] = incomingOffset
      else if (!incompleteResync) delete nextOffsets[chatId]
      return {
        agentRunProvisionalByKey: provisional,
        agentRunTerminalByTarget: terminal,
        agentRunCursorByChat: cursorShouldAdvance ? { ...current.agentRunCursorByChat, [chatId]: normalized.cursor.token } : current.agentRunCursorByChat,
        agentRunLastSequenceByChat: { ...current.agentRunLastSequenceByChat, [chatId]: nextPublic },
        agentRunCursorSequenceByChat: cursorShouldAdvance ? { ...current.agentRunCursorSequenceByChat, [chatId]: incoming } : current.agentRunCursorSequenceByChat,
        agentRunResyncOffsetByChat: nextOffsets,
        agentRunSyncByChat: { ...current.agentRunSyncByChat, [chatId]: nextSync },
        agentRunOmittedEventsByChat: { ...current.agentRunOmittedEventsByChat, [chatId]: Math.max(current.agentRunOmittedEventsByChat[chatId] ?? 0, normalized.omission.omittedEventCount) },
      }
    })
    return true
  },
  failAgentRunRestore: (chatId, requestEpoch) => {
    if (get().agentRunRequestEpochByChat[chatId] !== requestEpoch) return
    set((state) => ({ agentRunSyncByChat: { ...state.agentRunSyncByChat, [chatId]: 'error' } }))
  },
  reconcileAgentRunEvent: (payload) => {
    const event = normalizeAgentRunChangeEventV2(payload)
    if (!event) return 'rejected'
    const currentSequence = get().agentRunLastSequenceByChat[event.chatId] ?? 0
    if (event.sequence <= currentSequence) return 'stale'
    const gap = event.sequence > currentSequence + 1
    set((state) => {
      const provisional = { ...state.agentRunProvisionalByKey }
      const terminal = { ...state.agentRunTerminalByTarget }
      mergeRun(provisional, terminal, event.run)
      return {
        agentRunProvisionalByKey: provisional,
        agentRunTerminalByTarget: terminal,
        agentRunLastSequenceByChat: { ...state.agentRunLastSequenceByChat, [event.chatId]: event.sequence },
        agentRunSyncByChat: { ...state.agentRunSyncByChat, [event.chatId]: gap ? 'stale' : state.agentRunSyncByChat[event.chatId] ?? 'ready' },
        agentRunOmittedEventsByChat: { ...state.agentRunOmittedEventsByChat, [event.chatId]: (state.agentRunOmittedEventsByChat[event.chatId] ?? 0) + event.omission.omittedEventCount + (gap ? event.sequence - currentSequence - 1 : 0) },
      }
    })
    return gap ? 'gap' : 'applied'
  },
  reconcileExactAgentRun: (chatId, payload) => {
    const run = normalizeAgentRunPublicV2(payload)
    if (!run || run.chatId !== chatId || get().activeChatId !== chatId) return false
    set((state) => {
      const provisional = { ...state.agentRunProvisionalByKey }
      const terminal = { ...state.agentRunTerminalByTarget }
      mergeRun(provisional, terminal, run)
      return { agentRunProvisionalByKey: provisional, agentRunTerminalByTarget: terminal }
    })
    return true
  },
  markAgentRunsStale: (chatId) => set((state) => {
    const ids: string[] = chatId ? [chatId] : [...Object.values(state.agentRunProvisionalByKey).map((run) => run.chatId), ...Object.values(state.agentRunTerminalByTarget).map((run) => run.chatId), ...Object.keys(state.agentRunCursorByChat)]
    const sync = { ...state.agentRunSyncByChat }
    ids.forEach((id: string) => { sync[id] = 'stale' })
    return { agentRunSyncByChat: sync }
  }),
  clearAgentRunsForChat: (chatId) => set((state) => {
    const cursor = { ...state.agentRunCursorByChat }
    const sequence = { ...state.agentRunLastSequenceByChat }
    const cursorSequence = { ...state.agentRunCursorSequenceByChat }
    const resyncOffset = { ...state.agentRunResyncOffsetByChat }
    const sync = { ...state.agentRunSyncByChat }
    const omitted = { ...state.agentRunOmittedEventsByChat }
    delete cursor[chatId]; delete sequence[chatId]; delete cursorSequence[chatId]; delete resyncOffset[chatId]; delete sync[chatId]; delete omitted[chatId]
    return { agentRunProvisionalByKey: withoutChat(state.agentRunProvisionalByKey, chatId), agentRunTerminalByTarget: withoutChat(state.agentRunTerminalByTarget, chatId), agentRunCursorByChat: cursor, agentRunLastSequenceByChat: sequence, agentRunCursorSequenceByChat: cursorSequence, agentRunResyncOffsetByChat: resyncOffset, agentRunSyncByChat: sync, agentRunOmittedEventsByChat: omitted }
  }),

  beginAgentRunInspection: (chatId, attemptId) => {
    const key = `${chatId}:${attemptId}`
    const epoch = (get().agentRunInspectionRequestEpochByKey[key] ?? 0) + 1
    set((state) => ({ agentRunInspectionRequestEpochByKey: { ...state.agentRunInspectionRequestEpochByKey, [key]: epoch }, agentRunInspectionByAttemptId: { ...state.agentRunInspectionByAttemptId, [attemptId]: { status: 'loading', availability: 'live', detail: state.agentRunInspectionByAttemptId[attemptId]?.detail ?? null, error: null } } }))
    return epoch
  },
  applyAgentRunInspection: (chatId, attemptId, requestEpoch, payload) => {
    const detail = normalizeAgentRunInspectionDetailV1(payload)
    const key = `${chatId}:${attemptId}`
    if (!detail || detail.attempt.attemptId !== attemptId || detail.attempt.target.chatId !== chatId || get().agentRunInspectionRequestEpochByKey[key] !== requestEpoch) return false
    const availability = detail.activity.reconciliation === 'recovered' ? 'recovered' : detail.terminal ? 'terminal' : 'live'
    set((state) => ({ agentRunInspectionByAttemptId: { ...state.agentRunInspectionByAttemptId, [attemptId]: { status: 'ready', availability, detail, error: null } } }))
    return true
  },
  failAgentRunInspection: (chatId, attemptId, requestEpoch, availability, error) => {
    const key = `${chatId}:${attemptId}`
    if (get().agentRunInspectionRequestEpochByKey[key] !== requestEpoch) return
    set((state) => ({ agentRunInspectionByAttemptId: { ...state.agentRunInspectionByAttemptId, [attemptId]: { status: 'error', availability, detail: state.agentRunInspectionByAttemptId[attemptId]?.detail ?? null, error: error ?? null } } }))
  },
  clearAgentRunInspection: (attemptId) => set((state) => {
    const inspections = { ...state.agentRunInspectionByAttemptId }
    delete inspections[attemptId]
    return { agentRunInspectionByAttemptId: inspections }
  }),
  beginAgentRunInspectionList: (chatId) => {
    const key = `list:${chatId}`
    const epoch = (get().agentRunInspectionRequestEpochByKey[key] ?? 0) + 1
    set((state) => ({ agentRunInspectionRequestEpochByKey: { ...state.agentRunInspectionRequestEpochByKey, [key]: epoch }, agentRunInspectionListByChat: { ...state.agentRunInspectionListByChat, [chatId]: { status: 'loading', list: state.agentRunInspectionListByChat[chatId]?.list ?? null, error: null } } }))
    return epoch
  },
  applyAgentRunInspectionList: (chatId, requestEpoch, payload) => {
    const list = normalizeAgentRunInspectionListV1(payload)
    const key = `list:${chatId}`
    if (!list || list.chatId !== chatId || get().agentRunInspectionRequestEpochByKey[key] !== requestEpoch) return false
    set((state) => ({ agentRunInspectionListByChat: { ...state.agentRunInspectionListByChat, [chatId]: { status: 'ready', list, error: null } } }))
    return true
  },
  failAgentRunInspectionList: (chatId, requestEpoch, error) => {
    if (get().agentRunInspectionRequestEpochByKey[`list:${chatId}`] !== requestEpoch) return
    set((state) => ({ agentRunInspectionListByChat: { ...state.agentRunInspectionListByChat, [chatId]: { status: 'error', list: state.agentRunInspectionListByChat[chatId]?.list ?? null, error: error ?? null } } }))
  },
  beginAgentRunRetry: (attemptId) => set((state) => ({ agentRunRetryByAttemptId: { ...state.agentRunRetryByAttemptId, [attemptId]: { status: 'submitting', response: null, error: null } } })),
  applyAgentRunRetry: (attemptId, payload) => {
    const response = normalizeAgentRunInspectionRetryResponseV1(payload)
    if (!response) return false
    set((state) => ({ agentRunRetryByAttemptId: { ...state.agentRunRetryByAttemptId, [attemptId]: { status: response.accepted ? 'accepted' : 'refused', response, error: null } } }))
    return true
  },
  failAgentRunRetry: (attemptId, error) => set((state) => ({ agentRunRetryByAttemptId: { ...state.agentRunRetryByAttemptId, [attemptId]: { status: 'error', response: null, error: error ?? null } } })),

  beginAgentWorkspaceRequest: (chatId, turnId, section) => {
    const key = workspaceRequestKey(turnId, section)
    const epoch = (get().agentWorkspaceRequestEpochByKey[key] ?? 0) + 1
    set((state) => {
      const previous = state.agentWorkspaceByTurn[turnId]
      const sections = { ...(previous?.sections ?? {}) }
      if (section) sections[section] = { preview: sections[section]?.preview ?? emptyWorkspaceSectionPreview(turnId, section, previous?.index?.workspaceRevision ?? 0), loadingMore: true, error: false }
      return { agentWorkspaceRequestEpochByKey: { ...state.agentWorkspaceRequestEpochByKey, [key]: epoch }, agentWorkspaceByTurn: { ...state.agentWorkspaceByTurn, [turnId]: { chatId, turnId, status: section ? previous?.status ?? 'idle' : 'loading', index: previous?.index ?? null, sections, error: false } } }
    })
    return epoch
  },
  applyAgentWorkspaceIndex: (chatId, turnId, requestEpoch, payload) => {
    const key = workspaceRequestKey(turnId)
    const state = get()
    const index = normalizeAgentWorkspaceIndexV2(payload)
    if (state.agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return false
    const resetPendingRequest = () => {
      set((current) => {
        if (current.agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return {}
        const previous = current.agentWorkspaceByTurn[turnId]
        if (!previous || previous.chatId !== chatId) return {}
        return { agentWorkspaceByTurn: { ...current.agentWorkspaceByTurn, [turnId]: { ...previous, status: 'idle', error: false } } }
      })
    }
    if (!index || index.turnId !== turnId || state.activeChatId !== chatId) {
      resetPendingRequest()
      return false
    }
    let accepted = true
    set((current) => {
      const previous = current.agentWorkspaceByTurn[turnId]
      if (previous?.index && previous.index.workspaceRevision > index.workspaceRevision) {
        accepted = false
        if (previous.chatId !== chatId) return {}
        return { agentWorkspaceByTurn: { ...current.agentWorkspaceByTurn, [turnId]: { ...previous, status: 'idle', error: false } } }
      }
      const sections: NonNullable<typeof previous>['sections'] = {}
      for (const section of ['objective', 'tasks', 'records', 'submissions', 'artifacts'] as const) if (previous?.sections[section] && previous.sections[section]!.preview.workspaceRevision >= index.workspaceRevision) sections[section] = previous.sections[section]!
      return { agentWorkspaceByTurn: { ...current.agentWorkspaceByTurn, [turnId]: { chatId, turnId, status: 'ready', index, sections, error: false } } }
    })
    return accepted
  },
  applyAgentWorkspaceSection: (chatId, turnId, section, requestEpoch, payload, append) => {
    const key = workspaceRequestKey(turnId, section)
    const state = get()
    const preview = normalizeAgentWorkspaceSectionV2(payload)
    const settleSectionRequest = () => {
      set((current) => {
        if (current.agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return {}
        const previous = current.agentWorkspaceByTurn[turnId]
        if (!previous || previous.chatId !== chatId) return {}
        const currentSection = previous.sections[section]
        if (!currentSection) return {}
        return { agentWorkspaceByTurn: { ...current.agentWorkspaceByTurn, [turnId]: { ...previous, sections: { ...previous.sections, [section]: { ...currentSection, loadingMore: false, error: false } } } } }
      })
    }
    if (state.agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return false
    if (!preview || preview.turnId !== turnId || preview.section !== section || state.activeChatId !== chatId) {
      settleSectionRequest()
      return false
    }
    if (state.agentWorkspaceByTurn[turnId]?.index && preview.workspaceRevision < state.agentWorkspaceByTurn[turnId]!.index!.workspaceRevision) {
      settleSectionRequest()
      return false
    }
    let accepted = true
    set((current) => {
      const previous = current.agentWorkspaceByTurn[turnId]
      const currentSection = previous?.sections[section]?.preview
      if (currentSection && currentSection.workspaceRevision > preview.workspaceRevision) {
        accepted = false
        if (!previous || previous.chatId !== chatId) return {}
        const sectionState = previous.sections[section]
        return sectionState
          ? { agentWorkspaceByTurn: { ...current.agentWorkspaceByTurn, [turnId]: { ...previous, sections: { ...previous.sections, [section]: { ...sectionState, loadingMore: false, error: false } } } } }
          : {}
      }
      let nextPreview = preview
      if (append && currentSection?.workspaceRevision === preview.workspaceRevision) {
        const byId = new Map<string, AgentWorkspaceEntryPreviewV2>(currentSection.entries.map((entry) => [entry.id, entry]))
        preview.entries.forEach((entry) => { const existing = byId.get(entry.id); if (!existing || existing.revision < entry.revision) byId.set(entry.id, entry) })
        nextPreview = { ...preview, entries: [...byId.values()] }
      }
      return { agentWorkspaceByTurn: { ...current.agentWorkspaceByTurn, [turnId]: { chatId, turnId, status: previous?.status ?? 'ready', index: previous?.index ?? null, sections: { ...previous?.sections, [section]: { preview: nextPreview, loadingMore: false, error: false } }, error: false } } }
    })
    return accepted
  },
  failAgentWorkspaceRequest: (chatId, turnId, requestEpoch, section) => {
    const key = workspaceRequestKey(turnId, section)
    if (get().agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return
    set((state) => {
      const previous = state.agentWorkspaceByTurn[turnId]
      if (!previous || previous.chatId !== chatId) return {}
      const sections = { ...previous.sections }
      if (section) sections[section] = { preview: sections[section]?.preview ?? emptyWorkspaceSectionPreview(turnId, section, previous.index?.workspaceRevision ?? 0), loadingMore: false, error: true }
      return { agentWorkspaceByTurn: { ...state.agentWorkspaceByTurn, [turnId]: { ...previous, status: section ? previous.status : 'error', sections, error: section ? previous.error : true } } }
    })
  },

  beginPersistentWorkspaceRequest: (scope) => {
    const epoch = (get().agentPersistentWorkspaceRequestEpochByKey[scope] ?? 0) + 1
    set((state) => ({ agentPersistentWorkspaceRequestEpochByKey: { ...state.agentPersistentWorkspaceRequestEpochByKey, [scope]: epoch } }))
    return epoch
  },
  applyPersistentWorkspace: (scope, requestEpoch, payload) => {
    const workspace = normalizePersistentWorkspace(payload)
    if (!workspace || get().agentPersistentWorkspaceRequestEpochByKey[scope] !== requestEpoch) return false
    const current = get().agentPersistentWorkspaceById[workspace.id]
    if (current?.workspace && current.workspace.revision > workspace.revision) return false
    set((state) => ({
      agentPersistentWorkspaceById: {
        ...state.agentPersistentWorkspaceById,
        [workspace.id]: {
          status: 'ready',
          availability: workspace.chatId ? 'attached' : 'detached',
          workspace,
          error: null,
          requestEpoch,
        },
      },
      ...(workspace.chatId ? {
        agentPersistentWorkspaceByChat: {
          ...state.agentPersistentWorkspaceByChat,
          [workspace.chatId]: {
            status: 'ready',
            availability: 'attached',
            workspace,
            error: null,
            requestEpoch,
          },
        },
      } : {}),
      agentPersistentWorkspaceCollectionsById: {
        ...state.agentPersistentWorkspaceCollectionsById,
        [workspace.id]: state.agentPersistentWorkspaceCollectionsById[workspace.id] ?? emptyPersistentWorkspaceCollections(),
      },
    }))
    return true
  },
  failPersistentWorkspaceRequest: (scope, requestEpoch, availability, error) => {
    if (get().agentPersistentWorkspaceRequestEpochByKey[scope] !== requestEpoch) return
    const chatId = scope.startsWith('chat:') ? scope.slice('chat:'.length) : null
    const workspaceId = scope.startsWith('id:') ? scope.slice('id:'.length) : scope
    set((state) => {
      const previous = chatId
        ? state.agentPersistentWorkspaceByChat[chatId]
        : state.agentPersistentWorkspaceById[workspaceId]
      const failure: AgentPersistentWorkspaceStateV1 = {
        status: 'error',
        availability,
        workspace: previous?.workspace ?? null,
        error: error ?? null,
        requestEpoch,
      }
      return chatId
        ? { agentPersistentWorkspaceByChat: { ...state.agentPersistentWorkspaceByChat, [chatId]: failure } }
        : { agentPersistentWorkspaceById: { ...state.agentPersistentWorkspaceById, [workspaceId]: failure } }
    })
  },
  beginPersistentWorkspaceCollection: (workspaceId, collection) => {
    const key = `${workspaceId}:${collection}`
    const epoch = (get().agentPersistentWorkspaceRequestEpochByKey[key] ?? 0) + 1
    set((state) => {
      const current = state.agentPersistentWorkspaceCollectionsById[workspaceId] ?? emptyPersistentWorkspaceCollections()
      return {
        agentPersistentWorkspaceRequestEpochByKey: { ...state.agentPersistentWorkspaceRequestEpochByKey, [key]: epoch },
        agentPersistentWorkspaceCollectionsById: {
          ...state.agentPersistentWorkspaceCollectionsById,
          [workspaceId]: {
            ...current,
            [collection]: { ...current[collection], status: 'loading', error: null },
          },
        },
      }
    })
    return epoch
  },
  applyPersistentWorkspaceCollection: (workspaceId, collection, requestEpoch, payload) => {
    const key = `${workspaceId}:${collection}`
    const items = normalizePersistentWorkspaceCollection(collection, payload)
    if (!items || get().agentPersistentWorkspaceRequestEpochByKey[key] !== requestEpoch) return false
    set((state) => {
      const current = state.agentPersistentWorkspaceCollectionsById[workspaceId] ?? emptyPersistentWorkspaceCollections()
      return {
        agentPersistentWorkspaceCollectionsById: {
          ...state.agentPersistentWorkspaceCollectionsById,
          [workspaceId]: readyPersistentWorkspaceCollections(current, collection, items),
        },
      }
    })
    return true
  },
  failPersistentWorkspaceCollection: (workspaceId, collection, requestEpoch, error) => {
    const key = `${workspaceId}:${collection}`
    if (get().agentPersistentWorkspaceRequestEpochByKey[key] !== requestEpoch) return
    set((state) => {
      const current = state.agentPersistentWorkspaceCollectionsById[workspaceId] ?? emptyPersistentWorkspaceCollections()
      return {
        agentPersistentWorkspaceCollectionsById: {
          ...state.agentPersistentWorkspaceCollectionsById,
          [workspaceId]: {
            ...current,
            [collection]: { ...current[collection], status: 'error', error: error ?? null },
          },
        },
      }
    })
  },
  setAgentRuntimeSettings: (chatId, projection) => set((state) => ({ agentRuntimeSettingsByChat: { ...state.agentRuntimeSettingsByChat, [chatId]: projection } })),
  clearAgentRuntimeSettings: (chatId) => set((state) => { const values = { ...state.agentRuntimeSettingsByChat }; delete values[chatId]; return { agentRuntimeSettingsByChat: values } }),
})

export function selectAgentRunForTarget(state: Pick<AgentRunsSlice, 'agentRunTerminalByTarget'> & Partial<Pick<AgentRunsSlice, 'agentRunProvisionalByKey'>>, chatId: string, messageId: string, swipeId: number): AgentRunPublicV2 | undefined {
  let selected = state.agentRunTerminalByTarget[agentRunTerminalTargetKey(chatId, messageId, swipeId)]
  for (const run of Object.values(state.agentRunProvisionalByKey ?? {})) if (runTargets(run, chatId, messageId, swipeId) && (!selected || compareTargetAuthority(run, selected) > 0)) selected = run
  return selected
}
export function selectAgentRunForTurn(state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey' | 'agentRunTerminalByTarget'>, turnId: string): AgentRunPublicV2 | undefined { return findRunByTurnId(state, turnId) }
export function selectActiveAgentRunForChat(state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey'>, chatId: string, generationId?: string | null): AgentRunPublicV2 | undefined {
  let selected: AgentRunPublicV2 | undefined
  for (const run of Object.values(state.agentRunProvisionalByKey)) if (run.chatId === chatId && isActiveRun(run) && (generationId === undefined || generationId === null || run.generationId === generationId) && (!selected || compareRunFreshness(run, selected) > 0)) selected = run
  return selected
}
export function selectLatestAgentRunForChat(state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey' | 'agentRunTerminalByTarget'>, chatId: string): AgentRunPublicV2 | undefined {
  let selected: AgentRunPublicV2 | undefined
  for (const run of [...Object.values(state.agentRunProvisionalByKey), ...Object.values(state.agentRunTerminalByTarget)]) if (run.chatId === chatId && (!selected || compareRunFreshness(run, selected) > 0)) selected = run
  return selected
}
export function selectAgentRunInspection(state: Pick<AgentRunsSlice, 'agentRunInspectionByAttemptId'>, attemptId: string) { return state.agentRunInspectionByAttemptId[attemptId] }
export function selectAgentRunInspectionList(state: Pick<AgentRunsSlice, 'agentRunInspectionListByChat'>, chatId: string) { return state.agentRunInspectionListByChat[chatId] }
export function selectPersistentWorkspace(state: Pick<AgentRunsSlice, 'agentPersistentWorkspaceByChat' | 'agentPersistentWorkspaceById'>, chatId: string, workspaceId?: string | null) { return workspaceId ? state.agentPersistentWorkspaceById[workspaceId] : state.agentPersistentWorkspaceByChat[chatId] }
export function selectPersistentWorkspaceCollections(state: Pick<AgentRunsSlice, 'agentPersistentWorkspaceCollectionsById'>, workspaceId: string) {
  return state.agentPersistentWorkspaceCollectionsById[workspaceId]
}

export function selectPersistentWorkspaceCollection(
  state: Pick<AgentRunsSlice, 'agentPersistentWorkspaceCollectionsById'>,
  workspaceId: string,
  collection: AgentPersistentWorkspaceCollectionV1,
) {
  return state.agentPersistentWorkspaceCollectionsById[workspaceId]?.[collection]
}
