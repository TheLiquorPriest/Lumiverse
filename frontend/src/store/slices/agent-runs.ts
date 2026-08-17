import type { StateCreator } from 'zustand'
import type { AppStore, AgentRunsSlice } from '@/types/store'
import type {
  AgentActivityNodeStatusV2,
  AgentActivityNodeV2,
  AgentOmissionMarkerV2,
  AgentRunChangedEventV2,
  AgentRunChangesV2,
  AgentRunGenerationTypeV2,
  AgentRunPhaseV2,
  AgentRunPublicV2,
  AgentRunResyncPageV1,
  AgentRunTargetV2,
  AgentRunUsageV2,
  AgentWorkspaceEntryPreviewV2,
  AgentWorkspaceIndexPublicV2,
  AgentWorkspaceRetentionV2,
  AgentWorkspaceSectionPreviewV2,
  AgentWorkspaceSectionV2,
  AgentWorkspaceVisibilityV2,
} from '@/types/agent-runs'
import type { AgentPublicErrorCode } from '@/types/agent-runtime'
import { isUnknownRecord } from '@/lib/type-guards'

const RUN_PHASES: Record<AgentRunPhaseV2, true> = {
  ASSEMBLE: true,
  WORK: true,
  COMPLETE: true,
  RENDER: true,
  PREPARE_COMMIT: true,
  COMMITTING: true,
  COMMITTED: true,
  COMMIT_FAILED: true,
  EXHAUSTED: true,
  FAILED: true,
  CANCELLED: true,
  TIMED_OUT: true,
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
  workspace_record_finding: true,
  workspace_record_decision: true,
  workspace_record_question: true,
  workspace_attach_artifact: true,
  workspace_propose_publication: true,
  complete_turn: true,
  unknown_tool: true,
}
const PUBLIC_ERROR_CODES: Record<AgentPublicErrorCode, true> = {
  capacity_exceeded: true,
  host_child_admission_limit_exceeded: true,
  host_tool_call_limit_exceeded: true,
  child_admission_limit_exceeded: true,
  tool_call_limit_exceeded: true,
  logical_provider_request_limit_exceeded: true,
  physical_dispatch_attempt_limit_exceeded: true,
  child_output_token_limit_exceeded: true,
  root_wall_clock_limit_exceeded: true,
  activity_event_limit_exceeded: true,
  activity_byte_limit_exceeded: true,
  lifecycle_log_record_limit_exceeded: true,
  context_limit_exceeded: true,
  initial_input_limit_exceeded: true,
  argument_limit_exceeded: true,
  result_limit_exceeded: true,
  continuation_limit_exceeded: true,
  retained_output_limit_exceeded: true,
  materialized_limit_exceeded: true,
  timeout: true,
  cancelled: true,
  provider_unavailable: true,
  provider_unsupported: true,
  provider_tool_calling_unsupported: true,
  provider_tool_continuation_unsupported: true,
  provider_tool_finalization_unsupported: true,
  provider_request_error: true,
  provider_protocol_error: true,
  provider_schema_error: true,
  invalid_task: true,
  invalid_profile: true,
  invalid_arguments: true,
  batch_rejected: true,
  unknown_tool: true,
  unauthorized: true,
  integrity_error: true,
  internal_error: true,
}
const TERMINAL_RUN_STATUSES: Record<AgentRunPublicV2['status'], boolean> = {
  ASSEMBLE: false,
  WORK: false,
  COMPLETE: false,
  RENDER: false,
  PREPARE_COMMIT: false,
  COMMITTING: false,
  COMMITTED: true,
  COMMIT_FAILED: true,
  EXHAUSTED: true,
  FAILED: true,
  CANCELLED: true,
  TIMED_OUT: true,
}


const MAX_ACTIVITY_NODES = 512
const MAX_WORKSPACE_ENTRIES = 256
const MAX_ID_LENGTH = 128
const MAX_LABEL_LENGTH = 160
const MAX_CURSOR_LENGTH = 2_048


function boundedString(value: unknown, maxLength = MAX_ID_LENGTH): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null
  return value
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

function normalizeUsage(value: unknown): AgentRunUsageV2 | null {
  if (!isUnknownRecord(value)) return null
  const inputTokens = nonNegativeInteger(value.inputTokens)
  const outputTokens = nonNegativeInteger(value.outputTokens)
  const totalTokens = nonNegativeInteger(value.totalTokens)
  const toolCalls = nonNegativeInteger(value.toolCalls)
  const childInvocations = nonNegativeInteger(value.childInvocations)
  if ([inputTokens, outputTokens, totalTokens, toolCalls, childInvocations].some((part) => part === null)) return null
  return {
    inputTokens: inputTokens!,
    outputTokens: outputTokens!,
    totalTokens: totalTokens!,
    toolCalls: toolCalls!,
    childInvocations: childInvocations!,
  }
}

function normalizeErrorCode(value: unknown): AgentPublicErrorCode | undefined {
  return typeof value === 'string' && Object.hasOwn(PUBLIC_ERROR_CODES, value)
    ? value as AgentPublicErrorCode
    : undefined
}

function normalizeOmission(value: unknown): AgentOmissionMarkerV2 | null {
  if (!isUnknownRecord(value)) return null
  const omittedNodeCount = nonNegativeInteger(value.omittedNodeCount)
  const omittedEventCount = nonNegativeInteger(value.omittedEventCount)
  const firstOmittedSequence = value.firstOmittedSequence === null
    ? null
    : nonNegativeInteger(value.firstOmittedSequence)
  const lastOmittedSequence = value.lastOmittedSequence === null
    ? null
    : nonNegativeInteger(value.lastOmittedSequence)
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
  if (!messageId || swipeId === null) return undefined
  return { messageId, swipeId }
}

function normalizeActivityNode(value: unknown): AgentActivityNodeV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2) return null
  const id = boundedString(value.id)
  const parentId = value.parentId === null ? null : boundedString(value.parentId)
  const phase = value.phase
  const status = value.status
  const kind = value.kind
  const actor = value.actor
  const startedAt = nonNegativeInteger(value.startedAt)
  const elapsedMs = nonNegativeInteger(value.elapsedMs)
  if (
    !id || parentId === null && value.parentId !== null
    || typeof phase !== 'string' || !Object.hasOwn(RUN_PHASES, phase)
    || typeof status !== 'string' || !Object.hasOwn(NODE_STATUSES, status)
    || typeof kind !== 'string' || !Object.hasOwn(NODE_KINDS, kind)
    || typeof actor !== 'string' || !Object.hasOwn(NODE_KINDS, actor)
    || startedAt === null || elapsedMs === null
  ) return null

  const node: AgentActivityNodeV2 = {
    version: 2,
    id,
    parentId,
    kind: kind as AgentActivityNodeV2['kind'],
    actor: actor as AgentActivityNodeV2['actor'],
    phase: phase as AgentRunPhaseV2,
    status: status as AgentActivityNodeStatusV2,
    startedAt,
    elapsedMs,
  }
  if (typeof value.profileId === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.profileId)) {
    node.profileId = value.profileId
  }
  if (typeof value.toolId === 'string') {
    node.toolId = Object.hasOwn(SAFE_TOOL_IDS, value.toolId) ? value.toolId : 'unknown_tool'
  }
  const roundIndex = nonNegativeInteger(value.roundIndex)
  if (roundIndex !== null) node.roundIndex = roundIndex
  if (typeof value.continuationMode === 'string' && Object.hasOwn(CONTINUATION_MODES, value.continuationMode)) {
    node.continuationMode = value.continuationMode as AgentActivityNodeV2['continuationMode']
  }
  const usage = normalizeUsage(value.usage)
  if (usage) node.usage = usage
  const errorCode = normalizeErrorCode(value.errorCode)
  if (errorCode) node.errorCode = errorCode
  return node
}

export function normalizeAgentRunPublicV2(value: unknown): AgentRunPublicV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2) return null
  const runId = boundedString(value.runId)
  const turnId = boundedString(value.turnId)
  const generationId = boundedString(value.generationId)
  const chatId = boundedString(value.chatId)
  const target = normalizeTarget(value.target)
  const revision = nonNegativeInteger(value.revision)
  const sequence = nonNegativeInteger(value.sequence)
  const startedAt = nonNegativeInteger(value.startedAt)
  const updatedAt = nonNegativeInteger(value.updatedAt)
  const usage = normalizeUsage(value.usage)
  const omission = normalizeOmission(value.omission)
  if (
    !runId || !turnId || !generationId || !chatId || target === undefined
    || typeof value.generationType !== 'string'
    || !Object.hasOwn(GENERATION_TYPES, value.generationType)
    || typeof value.status !== 'string' || !Object.hasOwn(RUN_PHASES, value.status)
    || typeof value.phase !== 'string' || !Object.hasOwn(RUN_PHASES, value.phase)
    || revision === null || sequence === null || startedAt === null || updatedAt === null
    || !usage || !omission || !Array.isArray(value.activity)
  ) return null

  const rawNodes = value.activity.slice(0, MAX_ACTIVITY_NODES)
  const activity = rawNodes.map(normalizeActivityNode).filter((node): node is AgentActivityNodeV2 => node !== null)
  const droppedNodes = value.activity.length - activity.length
  const run: AgentRunPublicV2 = {
    version: 2,
    runId,
    turnId,
    generationId,
    chatId,
    generationType: value.generationType as AgentRunGenerationTypeV2,
    target,
    status: value.status as AgentRunPhaseV2,
    phase: value.phase as AgentRunPhaseV2,
    revision,
    sequence,
    startedAt,
    updatedAt,
    activity,
    usage,
    omission: { ...omission, omittedNodeCount: omission.omittedNodeCount + droppedNodes },
  }

  const nestedError = isUnknownRecord(value.error) ? value.error.code : undefined
  const errorCode = normalizeErrorCode(value.errorCode) ?? normalizeErrorCode(nestedError)
  if (errorCode) run.errorCode = errorCode

  if (isUnknownRecord(value.terminalHandoff) && value.terminalHandoff.version === 2) {
    const messageId = boundedString(value.terminalHandoff.messageId)
    const swipeId = nonNegativeInteger(value.terminalHandoff.swipeId)
    const messageRevision = nonNegativeInteger(value.terminalHandoff.messageRevision)
    const swipeRevision = nonNegativeInteger(value.terminalHandoff.swipeRevision)
    if (
      messageId && swipeId !== null && messageRevision !== null && swipeRevision !== null
      && typeof value.terminalHandoff.committed === 'boolean'
    ) {
      run.terminalHandoff = {
        version: 2,
        committed: value.terminalHandoff.committed,
        messageId,
        swipeId,
        messageRevision,
        swipeRevision,
      }
    }
  }
  return run
}

export function normalizeAgentRunChangedEventV2(value: unknown): AgentRunChangedEventV2 | null {
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
  if (
    offset === null
    || returnedRuns === null
    || totalRuns === null
    || snapshotSequence === null
    || omittedRuns === null
    || typeof value.complete !== 'boolean'
    || returnedRuns > 16
    || offset + returnedRuns > totalRuns && value.complete !== true
    || omittedRuns !== Math.max(0, totalRuns - offset - returnedRuns)
  ) return undefined
  return {
    offset,
    returnedRuns,
    totalRuns,
    snapshotSequence,
    complete: value.complete,
    omittedRuns,
  }
}

export function normalizeAgentRunChangesV2(value: unknown): AgentRunChangesV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2 || !isUnknownRecord(value.cursor) || value.cursor.version !== 1) return null
  const chatId = boundedString(value.chatId)
  const token = boundedString(value.cursor.token, MAX_CURSOR_LENGTH)
  const lastSequence = nonNegativeInteger(value.lastSequence)
  const cursorSequence = nonNegativeInteger(value.cursorSequence)
  const tailSequence = nonNegativeInteger(value.tailSequence)
  const hasMore = typeof value.hasMore === 'boolean' ? value.hasMore : null
  const omission = normalizeOmission(value.omission)
  const resyncPage = value.resyncPage === undefined ? undefined : normalizeResyncPage(value.resyncPage)
  if (
    !chatId
    || !token
    || lastSequence === null
    || cursorSequence === null
    || tailSequence === null
    || hasMore === null
    || lastSequence !== cursorSequence
    || tailSequence < lastSequence
    || typeof value.resync !== 'boolean'
    || value.resync && value.resyncPage !== undefined && !resyncPage
    || !Array.isArray(value.runs)
    || !Array.isArray(value.events)
    || !omission
  ) return null
  const runs = value.runs.map(normalizeAgentRunPublicV2).filter((run): run is AgentRunPublicV2 => run !== null)
  const events = value.events
    .map(normalizeAgentRunChangedEventV2)
    .filter((event): event is AgentRunChangedEventV2 => event !== null)
  if (runs.some((run) => run.chatId !== chatId) || events.some((event) => event.chatId !== chatId)) return null
  return {
    version: 2,
    chatId,
    cursor: { version: 1, token },
    cursorSequence,
    lastSequence,
    tailSequence,
    hasMore,
    resync: value.resync,
    ...(resyncPage ? { resyncPage } : {}),
    runs,
    events,
    omission,
  }
}

function normalizeWorkspaceRetention(value: unknown): AgentWorkspaceRetentionV2 | null {
  return typeof value === 'string' && Object.hasOwn(WORKSPACE_RETENTIONS, value)
    ? value as AgentWorkspaceRetentionV2
    : null
}

function normalizeWorkspaceVisibility(value: unknown): AgentWorkspaceVisibilityV2 | null {
  return typeof value === 'string' && Object.hasOwn(WORKSPACE_VISIBILITIES, value)
    ? value as AgentWorkspaceVisibilityV2
    : null
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
    const states = new Set(['active', 'blocked', 'submitted', 'done', 'omitted'])
    if (!title || dependencyCount === null || typeof value.state !== 'string' || !states.has(value.state)) return null
    if (typeof value.required !== 'boolean' || typeof value.assigned !== 'boolean') return null
    return { ...base, kind: 'task', title, dependencyCount, state: value.state as 'active', required: value.required, assigned: value.assigned }
  }
  if (value.kind === 'submission') {
    const taskId = boundedString(value.taskId)
    const profileId = value.profileId === null ? null : boundedString(value.profileId, 64)
    const states = new Set(['proposed', 'accepted', 'rejected', 'omitted'])
    if (!taskId || profileId === null && value.profileId !== null || typeof value.state !== 'string' || !states.has(value.state)) return null
    return { ...base, kind: 'submission', taskId, profileId, state: value.state as 'proposed' }
  }
  if (value.kind === 'finding' || value.kind === 'decision' || value.kind === 'question') {
    const title = boundedString(value.title, MAX_LABEL_LENGTH)
    const states = new Set(['active', 'accepted', 'omitted'])
    if (!title || typeof value.state !== 'string' || !states.has(value.state)) return null
    return { ...base, kind: value.kind, title, state: value.state as 'active' }
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
  if (
    !turnId || workspaceRevision === null || omitted === null
    || typeof value.section !== 'string' || !Object.hasOwn(WORKSPACE_SECTIONS, value.section)
    || nextPage === null && value.nextPage !== null
  ) return null
  const rawEntries = value.entries.slice(0, MAX_WORKSPACE_ENTRIES)
  const entries = rawEntries.map(normalizeWorkspaceEntry).filter((entry): entry is AgentWorkspaceEntryPreviewV2 => entry !== null)
  return {
    version: 2,
    turnId,
    section: value.section as AgentWorkspaceSectionV2,
    workspaceRevision,
    entries,
    nextPage,
    omitted: omitted + value.entries.length - entries.length,
  }
}

export function agentRunProvisionalKey(run: Pick<AgentRunPublicV2, 'chatId' | 'turnId' | 'generationType' | 'target'>): string {
  const target = run.target ? `${run.target.messageId}:${run.target.swipeId}` : 'pending'
  return `${run.chatId}:${run.turnId}:${run.generationType}:${target}`
}

export function agentRunTerminalTargetKey(chatId: string, messageId: string, swipeId: number): string {
  return `${chatId}:${messageId}:${swipeId}`
}

function compareNumber(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function isTerminalRun(run: AgentRunPublicV2): boolean {
  return TERMINAL_RUN_STATUSES[run.status]
}

function isActiveRun(run: AgentRunPublicV2): boolean {
  return !isTerminalRun(run)
}

/** Compare snapshots of one run, where revision is the authoritative version. */
function compareRunVersion(candidate: AgentRunPublicV2, current: AgentRunPublicV2): number {
  for (const [left, right] of [
    [candidate.revision, current.revision],
    [candidate.sequence, current.sequence],
    [candidate.updatedAt, current.updatedAt],
    [candidate.startedAt, current.startedAt],
  ] as const) {
    const comparison = compareNumber(left, right)
    if (comparison !== 0) return comparison
  }
  for (const [left, right] of [
    [candidate.runId, current.runId],
    [candidate.generationId, current.generationId],
    [candidate.turnId, current.turnId],
  ] as const) {
    const comparison = compareText(left, right)
    if (comparison !== 0) return comparison
  }
  return 0
}

/** Compare runs that may compete for one target or the latest chat projection. */
function compareRunFreshness(candidate: AgentRunPublicV2, current: AgentRunPublicV2): number {
  for (const [left, right] of [
    [candidate.sequence, current.sequence],
    [candidate.updatedAt, current.updatedAt],
    [candidate.startedAt, current.startedAt],
    [candidate.revision, current.revision],
  ] as const) {
    const comparison = compareNumber(left, right)
    if (comparison !== 0) return comparison
  }
  const candidateActive = isActiveRun(candidate)
  const currentActive = isActiveRun(current)
  if (candidateActive !== currentActive) return candidateActive ? 1 : -1
  for (const [left, right] of [
    [candidate.runId, current.runId],
    [candidate.generationId, current.generationId],
    [candidate.turnId, current.turnId],
  ] as const) {
    const comparison = compareText(left, right)
    if (comparison !== 0) return comparison
  }
  return 0
}

function targetRevision(run: AgentRunPublicV2): readonly [number, number] | null {
  const handoff = run.terminalHandoff
  return handoff?.committed ? [handoff.messageRevision, handoff.swipeRevision] : null
}

function compareTargetAuthority(candidate: AgentRunPublicV2, current: AgentRunPublicV2): number {
  const candidateRevision = targetRevision(candidate)
  const currentRevision = targetRevision(current)
  if (candidateRevision && currentRevision) {
    const messageComparison = compareNumber(candidateRevision[0], currentRevision[0])
    if (messageComparison !== 0) return messageComparison
    const swipeComparison = compareNumber(candidateRevision[1], currentRevision[1])
    if (swipeComparison !== 0) return swipeComparison
  }
  return compareRunFreshness(candidate, current)
}

function runTargets(run: AgentRunPublicV2, chatId: string, messageId: string, swipeId: number): boolean {
  if (run.chatId !== chatId) return false
  const target = run.target
  if (target?.messageId === messageId && target.swipeId === swipeId) return true
  const handoff = run.terminalHandoff
  return handoff?.committed === true && handoff.messageId === messageId && handoff.swipeId === swipeId
}

function findRunByTurnId(
  state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey' | 'agentRunTerminalByTarget'>,
  turnId: string,
): AgentRunPublicV2 | undefined {
  let selected: AgentRunPublicV2 | undefined
  for (const run of [
    ...Object.values(state.agentRunTerminalByTarget),
    ...Object.values(state.agentRunProvisionalByKey),
  ]) {
    if (run.turnId !== turnId || !selected || compareRunVersion(run, selected) > 0) selected = run
  }
  return selected
}

function mergeRun(
  provisional: Record<string, AgentRunPublicV2>,
  terminal: Record<string, AgentRunPublicV2>,
  run: AgentRunPublicV2,
): void {
  const current = findRunByTurnId({ agentRunProvisionalByKey: provisional, agentRunTerminalByTarget: terminal }, run.turnId)
  if (current && compareRunVersion(run, current) <= 0) return

  if (run.terminalHandoff?.committed) {
    const targetKey = agentRunTerminalTargetKey(run.chatId, run.terminalHandoff.messageId, run.terminalHandoff.swipeId)
    const destination = terminal[targetKey]
    if (
      destination && destination.turnId !== run.turnId
      && compareTargetAuthority(run, destination) <= 0
    ) return
  }

  for (const [key, value] of Object.entries(provisional)) if (value.turnId === run.turnId) delete provisional[key]
  for (const [key, value] of Object.entries(terminal)) if (value.turnId === run.turnId) delete terminal[key]
  if (run.terminalHandoff?.committed) {
    terminal[agentRunTerminalTargetKey(run.chatId, run.terminalHandoff.messageId, run.terminalHandoff.swipeId)] = run
  } else {
    provisional[agentRunProvisionalKey(run)] = run
  }
}

function withoutChat<T extends AgentRunPublicV2>(values: Record<string, T>, chatId: string): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([, run]) => run.chatId !== chatId))
}

function workspaceRequestKey(turnId: string, section?: AgentWorkspaceSectionV2): string {
  return `${turnId}:${section ?? 'index'}`
}

function emptyWorkspaceSectionPreview(
  turnId: string,
  section: AgentWorkspaceSectionV2,
  workspaceRevision: number,
): AgentWorkspaceSectionPreviewV2 {
  return {
    version: 2,
    turnId,
    section,
    workspaceRevision,
    entries: [],
    nextPage: null,
    omitted: 0,
  }
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
  agentWorkspaceByTurn: {},
  agentWorkspaceRequestEpochByKey: {},

  beginAgentRunRestore: (chatId) => {
    const epoch = (get().agentRunRequestEpochByChat[chatId] ?? 0) + 1
    set((state) => ({
      agentRunRequestEpochByChat: { ...state.agentRunRequestEpochByChat, [chatId]: epoch },
      agentRunSyncByChat: { ...state.agentRunSyncByChat, [chatId]: 'restoring' },
    }))
    return epoch
  },

  applyAgentRunChanges: (chatId, requestEpoch, payload) => {
    const normalized = normalizeAgentRunChangesV2(payload)
    const state = get()
    if (
      !normalized || normalized.chatId !== chatId || state.activeChatId !== chatId
      || state.agentRunRequestEpochByChat[chatId] !== requestEpoch
    ) return false

    set((current) => {
      const publicSequence = current.agentRunLastSequenceByChat[chatId] ?? 0
      const consumedSequence = current.agentRunCursorSequenceByChat[chatId] ?? 0
      const incomingSequence = normalized.cursorSequence
      const responseIsOlder = incomingSequence < consumedSequence
      const previousResyncOffset = current.agentRunResyncOffsetByChat[chatId]
      const incomingResyncOffset = normalized.resyncPage?.offset ?? 0
      const pageIsOlder = normalized.resync
        && previousResyncOffset !== undefined
        && incomingResyncOffset < previousResyncOffset
      const cursorShouldAdvance = !responseIsOlder && !pageIsOlder && (
        current.agentRunCursorByChat[chatId] === undefined
        || incomingSequence >= consumedSequence
        || normalized.resync && (
          previousResyncOffset === undefined
          || incomingResyncOffset >= previousResyncOffset
        )
      )
      let provisional = { ...current.agentRunProvisionalByKey }
      let terminal = { ...current.agentRunTerminalByTarget }

      if (normalized.resync && incomingResyncOffset === 0 && !pageIsOlder) {
        // Replace the old snapshot, but preserve projections delivered by a
        // live event while this request was in flight. Their sequence is
        // beyond (or at) the cursor watermark and the next delta will replay
        // them safely from the newly accepted token.
        const preservedRuns = [
          ...Object.values(provisional),
          ...Object.values(terminal),
        ].filter((run) => run.chatId === chatId && run.sequence >= incomingSequence)
        provisional = withoutChat(provisional, chatId)
        terminal = withoutChat(terminal, chatId)
        for (const run of preservedRuns) mergeRun(provisional, terminal, run)
      }

      for (const run of normalized.runs) mergeRun(provisional, terminal, run)
      for (const event of [...normalized.events].sort((a, b) => a.sequence - b.sequence)) {
        mergeRun(provisional, terminal, event.run)
      }

      const nextConsumedSequence = cursorShouldAdvance ? incomingSequence : consumedSequence
      const nextPublicSequence = Math.max(
        publicSequence,
        normalized.lastSequence,
        ...normalized.events.map((event) => event.sequence),
      )
      const resyncIncomplete = normalized.resync && normalized.resyncPage?.complete === false
      const cursorBehindPublic = nextConsumedSequence < nextPublicSequence
      const nextSync = responseIsOlder || pageIsOlder || normalized.hasMore || resyncIncomplete || cursorBehindPublic
        ? 'stale'
        : 'ready'
      const nextOmittedEvents = responseIsOlder
        ? current.agentRunOmittedEventsByChat[chatId] ?? 0
        : Math.max(
            current.agentRunOmittedEventsByChat[chatId] ?? 0,
            normalized.omission.omittedEventCount,
          )
      const nextResyncOffsets = { ...current.agentRunResyncOffsetByChat }
      if (resyncIncomplete && cursorShouldAdvance) {
        nextResyncOffsets[chatId] = incomingResyncOffset
      } else if (!resyncIncomplete) {
        delete nextResyncOffsets[chatId]
      }

      return {
        agentRunProvisionalByKey: provisional,
        agentRunTerminalByTarget: terminal,
        agentRunCursorByChat: cursorShouldAdvance
          ? { ...current.agentRunCursorByChat, [chatId]: normalized.cursor.token }
          : current.agentRunCursorByChat,
        agentRunLastSequenceByChat: {
          ...current.agentRunLastSequenceByChat,
          [chatId]: nextPublicSequence,
        },
        agentRunCursorSequenceByChat: cursorShouldAdvance
          ? { ...current.agentRunCursorSequenceByChat, [chatId]: incomingSequence }
          : current.agentRunCursorSequenceByChat,
        agentRunResyncOffsetByChat: nextResyncOffsets,
        agentRunSyncByChat: { ...current.agentRunSyncByChat, [chatId]: nextSync },
        agentRunOmittedEventsByChat: {
          ...current.agentRunOmittedEventsByChat,
          [chatId]: nextOmittedEvents,
        },
      }
    })
    return true
  },

  failAgentRunRestore: (chatId, requestEpoch) => {
    if (get().agentRunRequestEpochByChat[chatId] !== requestEpoch) return
    set((state) => ({
      agentRunSyncByChat: { ...state.agentRunSyncByChat, [chatId]: 'error' },
    }))
  },

  reconcileAgentRunEvent: (payload) => {
    const event = normalizeAgentRunChangedEventV2(payload)
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
        agentRunSyncByChat: {
          ...state.agentRunSyncByChat,
          [event.chatId]: gap ? 'stale' : state.agentRunSyncByChat[event.chatId] ?? 'ready',
        },
        agentRunOmittedEventsByChat: {
          ...state.agentRunOmittedEventsByChat,
          [event.chatId]: (state.agentRunOmittedEventsByChat[event.chatId] ?? 0)
            + event.omission.omittedEventCount + (gap ? event.sequence - currentSequence - 1 : 0),
        },
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
    const chatIds = chatId
      ? [chatId]
      : new Set([
          ...Object.values(state.agentRunProvisionalByKey).map((run) => run.chatId),
          ...Object.values(state.agentRunTerminalByTarget).map((run) => run.chatId),
          ...Object.keys(state.agentRunCursorByChat),
          ...Object.keys(state.agentRunCursorSequenceByChat),
        ])
    const sync = { ...state.agentRunSyncByChat }
    for (const id of chatIds) sync[id] = 'stale'
    return { agentRunSyncByChat: sync }
  }),

  clearAgentRunsForChat: (chatId) => set((state) => {
    const cursor = { ...state.agentRunCursorByChat }
    const sequence = { ...state.agentRunLastSequenceByChat }
    const cursorSequence = { ...state.agentRunCursorSequenceByChat }
    const resyncOffset = { ...state.agentRunResyncOffsetByChat }
    const sync = { ...state.agentRunSyncByChat }
    const omitted = { ...state.agentRunOmittedEventsByChat }
    delete cursor[chatId]
    delete sequence[chatId]
    delete cursorSequence[chatId]
    delete resyncOffset[chatId]
    delete sync[chatId]
    delete omitted[chatId]
    return {
      agentRunProvisionalByKey: withoutChat(state.agentRunProvisionalByKey, chatId),
      agentRunTerminalByTarget: withoutChat(state.agentRunTerminalByTarget, chatId),
      agentRunCursorByChat: cursor,
      agentRunLastSequenceByChat: sequence,
      agentRunCursorSequenceByChat: cursorSequence,
      agentRunResyncOffsetByChat: resyncOffset,
      agentRunSyncByChat: sync,
      agentRunOmittedEventsByChat: omitted,
    }
  }),

  beginAgentWorkspaceRequest: (chatId, turnId, section) => {
    const key = workspaceRequestKey(turnId, section)
    const epoch = (get().agentWorkspaceRequestEpochByKey[key] ?? 0) + 1
    set((state) => {
      const previous = state.agentWorkspaceByTurn[turnId]
      const sections = { ...(previous?.sections ?? {}) }
      if (section) {
        const previousSection = sections[section]
        if (previousSection || previous?.index) {
          sections[section] = {
            preview: previousSection?.preview
              ?? emptyWorkspaceSectionPreview(turnId, section, previous?.index?.workspaceRevision ?? 0),
            loadingMore: true,
            error: false,
          }
        }
      }
      return {
        agentWorkspaceRequestEpochByKey: { ...state.agentWorkspaceRequestEpochByKey, [key]: epoch },
        agentWorkspaceByTurn: {
          ...state.agentWorkspaceByTurn,
          [turnId]: {
            chatId,
            turnId,
            status: section ? previous?.status ?? 'idle' : 'loading',
            index: previous?.index ?? null,
            sections,
            error: false,
          },
        },
      }
    })
    return epoch
  },

  applyAgentWorkspaceIndex: (chatId, turnId, requestEpoch, payload) => {
    const index = normalizeAgentWorkspaceIndexV2(payload)
    const key = workspaceRequestKey(turnId)
    const state = get()
    if (!index || index.turnId !== turnId) return false
    if (
      state.activeChatId !== chatId
      || state.agentWorkspaceRequestEpochByKey[key] !== requestEpoch
    ) {
      if (state.agentWorkspaceRequestEpochByKey[key] === requestEpoch) {
        const previous = state.agentWorkspaceByTurn[turnId]
        if (previous?.status === 'loading') {
          set((current) => ({
            agentWorkspaceByTurn: {
              ...current.agentWorkspaceByTurn,
              [turnId]: { ...previous, status: 'idle' },
            },
          }))
        }
      }
      return false
    }
    set((current) => {
      const previous = current.agentWorkspaceByTurn[turnId]
      if (previous?.index && previous.index.workspaceRevision > index.workspaceRevision) {
        if (previous.status !== 'loading') return {}
        return {
          agentWorkspaceByTurn: {
            ...current.agentWorkspaceByTurn,
            [turnId]: { ...previous, status: 'ready', error: false },
          },
        }
      }
      const sections: NonNullable<typeof previous>['sections'] = {}
      for (const section of ['objective', 'tasks', 'records', 'submissions', 'artifacts'] as const) {
        const sectionState = previous?.sections[section]
        if (sectionState && sectionState.preview.workspaceRevision >= index.workspaceRevision) {
          sections[section] = sectionState
        }
      }
      return {
        agentWorkspaceByTurn: {
          ...current.agentWorkspaceByTurn,
          [turnId]: { chatId, turnId, status: 'ready', index, sections, error: false },
        },
      }
    })
    return true
  },

  applyAgentWorkspaceSection: (chatId, turnId, section, requestEpoch, payload, append) => {
    const preview = normalizeAgentWorkspaceSectionV2(payload)
    const key = workspaceRequestKey(turnId, section)
    const state = get()
    if (!preview || preview.turnId !== turnId || preview.section !== section) return false
    if (
      state.activeChatId !== chatId
      || state.agentWorkspaceRequestEpochByKey[key] !== requestEpoch
    ) {
      if (state.agentWorkspaceRequestEpochByKey[key] === requestEpoch) {
        const previous = state.agentWorkspaceByTurn[turnId]
        const sectionState = previous?.sections[section]
        if (previous && sectionState?.loadingMore) {
          set((current) => ({
            agentWorkspaceByTurn: {
              ...current.agentWorkspaceByTurn,
              [turnId]: {
                ...previous,
                sections: {
                  ...previous.sections,
                  [section]: { ...sectionState, loadingMore: false },
                },
              },
            },
          }))
        }
      }
      return false
    }
    const workspace = state.agentWorkspaceByTurn[turnId]
    if (workspace?.index && preview.workspaceRevision < workspace.index.workspaceRevision) {
      const sectionState = workspace.sections[section]
      if (sectionState?.loadingMore) {
        set((current) => ({
          agentWorkspaceByTurn: {
            ...current.agentWorkspaceByTurn,
            [turnId]: {
              ...workspace,
              sections: {
                ...workspace.sections,
                [section]: { ...sectionState, loadingMore: false },
              },
            },
          },
        }))
      }
      return false
    }
    set((current) => {
      const previous = current.agentWorkspaceByTurn[turnId]
      const currentSection = previous?.sections[section]?.preview
      if (currentSection && currentSection.workspaceRevision > preview.workspaceRevision) {
        const sectionState = previous?.sections[section]
        if (!previous || !sectionState) return {}
        return {
          agentWorkspaceByTurn: {
            ...current.agentWorkspaceByTurn,
            [turnId]: {
              ...previous,
              sections: {
                ...previous.sections,
                [section]: { ...sectionState, loadingMore: false },
              },
            },
          },
        }
      }
      let nextPreview = preview
      if (append && currentSection?.workspaceRevision === preview.workspaceRevision) {
        const entriesById = new Map<string, AgentWorkspaceEntryPreviewV2>(
          currentSection.entries.map((entry: AgentWorkspaceEntryPreviewV2) => [entry.id, entry]),
        )
        for (const entry of preview.entries) {
          const existing = entriesById.get(entry.id)
          if (!existing || existing.revision < entry.revision) entriesById.set(entry.id, entry)
        }
        nextPreview = { ...preview, entries: [...entriesById.values()] }
      }
      return {
        agentWorkspaceByTurn: {
          ...current.agentWorkspaceByTurn,
          [turnId]: {
            chatId,
            turnId,
            status: previous?.status ?? 'ready',
            index: previous?.index ?? null,
            sections: {
              ...previous?.sections,
              [section]: { preview: nextPreview, loadingMore: false, error: false },
            },
            error: false,
          },
        },
      }
    })
    return true
  },

  failAgentWorkspaceRequest: (chatId, turnId, requestEpoch, section) => {
    const key = workspaceRequestKey(turnId, section)
    if (get().agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return
    set((state) => {
      const previous = state.agentWorkspaceByTurn[turnId]
      if (!previous || previous.chatId !== chatId) return {}
      const sections = { ...previous.sections }
      if (section) {
        const sectionState = sections[section]
        sections[section] = sectionState
          ? { ...sectionState, loadingMore: false, error: true }
          : {
              preview: emptyWorkspaceSectionPreview(
                turnId,
                section,
                previous.index?.workspaceRevision ?? 0,
              ),
              loadingMore: false,
              error: true,
            }
      }
      return {
        agentWorkspaceByTurn: {
          ...state.agentWorkspaceByTurn,
          [turnId]: {
            ...previous,
            status: section ? previous.status : 'error',
            sections,
            error: section ? previous.error : true,
          },
        },
      }
    })
  },
})

export function selectAgentRunForTarget(
  state: Pick<AgentRunsSlice, 'agentRunTerminalByTarget'>
    & Partial<Pick<AgentRunsSlice, 'agentRunProvisionalByKey'>>,
  chatId: string,
  messageId: string,
  swipeId: number,
): AgentRunPublicV2 | undefined {
  const targetKey = agentRunTerminalTargetKey(chatId, messageId, swipeId)
  let selected = state.agentRunTerminalByTarget[targetKey]
  for (const run of Object.values(state.agentRunProvisionalByKey ?? {})) {
    if (!runTargets(run, chatId, messageId, swipeId)) continue
    if (!selected || compareTargetAuthority(run, selected) > 0) selected = run
  }
  return selected
}

export function selectAgentRunForTurn(
  state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey' | 'agentRunTerminalByTarget'>,
  turnId: string,
): AgentRunPublicV2 | undefined {
  return findRunByTurnId(state, turnId)
}

export function selectActiveAgentRunForChat(
  state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey'>,
  chatId: string,
  generationId?: string | null,
): AgentRunPublicV2 | undefined {
  let selected: AgentRunPublicV2 | undefined
  for (const run of Object.values(state.agentRunProvisionalByKey)) {
    if (
      run.chatId !== chatId
      || !isActiveRun(run)
      || generationId !== undefined && generationId !== null && run.generationId !== generationId
    ) continue
    if (!selected || compareRunFreshness(run, selected) > 0) selected = run
  }
  return selected
}

export function selectLatestAgentRunForChat(
  state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey' | 'agentRunTerminalByTarget'>,
  chatId: string,
): AgentRunPublicV2 | undefined {
  let selected: AgentRunPublicV2 | undefined
  for (const run of [
    ...Object.values(state.agentRunProvisionalByKey),
    ...Object.values(state.agentRunTerminalByTarget),
  ]) {
    if (run.chatId !== chatId || !selected || compareRunFreshness(run, selected) > 0) selected = run
  }
  return selected
}
