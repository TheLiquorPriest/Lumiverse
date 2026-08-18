import {
  AGENT_INVOCATION_MIN,
  AGENT_TOOL_CALL_MIN,
  WORKSPACE_CAPABILITIES,
  type AgentCapability,
  type AgentConfigRepairItem,
  type AgentConfigV2,
  type AgentContextActivationRule,
  type AgentContextPackSelection,
  type AgentContextPolicyV1,
  type AgentMode,
  type AgentProfileConfigV2,
  type AgentTaskTemplate,
  type AgenticRuntimeSaveDraft,
  type CognitionPredicate,
  type CoreAgentToolId,
  type LoomPreset,
  type PromptBlock,
  type WorkspaceCapability,
} from './types'
import { generateUUID } from '@/lib/uuid'
import { isUnknownRecord } from '@/lib/type-guards'

export const AGENTIC_PREDICATE_MAX_DEPTH = 16
export const AGENTIC_PREDICATE_MAX_NODES = 256
export const AGENTIC_TASK_TEMPLATE_LIMIT = 256
export const AGENTIC_CONTEXT_RULE_LIMIT = 256
export const AGENTIC_LABEL_MAX_LENGTH = 80
export const AGENTIC_DESCRIPTION_MAX_BYTES = 8 * 1024
const UTF8_ENCODER = new TextEncoder()
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const SLOT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}(?:\/[a-z][a-z0-9_-]{0,63})?$/
const POLICY_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const COGNITION_POLICY_KEYS = ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'] as const
type CognitionPolicyKey = (typeof COGNITION_POLICY_KEYS)[number]
const AGENT_MARKER_PATTERN = /\{\{agent::([^{}\s:]+)(?:::as=[^{}\s:]+)?\}\}/g

export function isCanonicalBlockRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

export function getAgentProfileMarkerIds(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const ids: string[] = []
  AGENT_MARKER_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = AGENT_MARKER_PATTERN.exec(value)) !== null) ids.push(match[1]!)
  AGENT_MARKER_PATTERN.lastIndex = 0
  return ids
}

export function rewriteAgentProfileMarkers(value: unknown, previousId: string, nextId: string): unknown {
  if (typeof value !== 'string' || previousId === nextId) return value
  const previousResultName = getAgentResultName(previousId)
  const nextResultName = getAgentResultName(nextId)
  AGENT_MARKER_PATTERN.lastIndex = 0
  const rewritten = value.replace(AGENT_MARKER_PATTERN, (marker, markerId: string) => {
    if (markerId !== previousId) return marker
    return marker.replace(`{{agent::${previousId}`, `{{agent::${nextId}`)
      .replace(`as=${previousResultName}`, `as=${nextResultName}`)
  })
  AGENT_MARKER_PATTERN.lastIndex = 0
  return rewritten
}

/**
 * Remove one profile's generated agent block without leaving a dangling
 * closing marker. Unpaired markers are removed on their own so imported or
 * hand-authored prompt text remains saveable.
 */
export function removeAgentProfileMarkers(value: unknown, profileId: string): unknown {
  if (typeof value !== 'string' || profileId.length === 0) return value
  const escapedId = profileId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const markerSource = `\\{\\{agent::${escapedId}(?:::as=[^{}\\s:]+)?\\}\\}`
  const pairedPattern = new RegExp(`${markerSource}([\\s\\S]*?)\\{\\{/agent\\}\\}`, 'g')
  const markerPattern = new RegExp(markerSource, 'g')
  return value.replace(pairedPattern, '$1').replace(markerPattern, '')
}

export const CORE_AGENT_TOOL_IDS = [
  'lore_list_books',
  'lore_get_book',
  'lore_list_entries',
  'lore_get_entry',
  'lore_search_entries',
  'chat_search_history',
] as const satisfies readonly CoreAgentToolId[]
const AGENT_CAPABILITY_IDS = [
  'generation',
  'streaming',
  'tool_calling',
  'native_tool_continuation',
  'tools_disabled_finalization',
] as const satisfies readonly AgentCapability[]
const AGENT_LORE_SCOPES = ['active', 'all_owned'] as const
const LORE_TOOL_IDS: Record<CoreAgentToolId, boolean> = {
  lore_list_books: true,
  lore_get_book: true,
  lore_list_entries: true,
  lore_get_entry: true,
  lore_search_entries: true,
  chat_search_history: false,
}

export const AGENT_PROFILE_LIMIT = 16
export const AGENT_PROFILE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
export const AGENT_PROFILE_NAME_MAX_LENGTH = 80
export const AGENT_SYSTEM_PROMPT_MAX_BYTES = 32 * 1024
export const AGENT_MAX_OUTPUT_TOKENS_MIN = 64
export const AGENT_MAX_OUTPUT_TOKENS_MAX = 8192
export const AGENT_TIMEOUT_MS_MIN = 5_000
const MILLISECONDS_PER_SECOND = 1_000
export function agentTimeoutMsToSeconds(timeoutMs: number): number {
  return timeoutMs / MILLISECONDS_PER_SECOND
}
export { AGENT_INVOCATION_MIN, AGENT_TOOL_CALL_MIN }
export const AGENT_MODES = ['response', 'agentic'] as const

export function parseAgentTimeoutSecondsInput(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) return Number.NaN
  const timeoutMs = Number(value) * MILLISECONDS_PER_SECOND
  return Number.isSafeInteger(timeoutMs) ? timeoutMs : Number.NaN
}

export function parseAgentMaxInvocationsInput(value: string): number {
  if (!/^\d+$/.test(value)) return Number.NaN
  const maxInvocations = Number(value)
  return Number.isSafeInteger(maxInvocations) && maxInvocations >= AGENT_INVOCATION_MIN
    ? maxInvocations
    : Number.NaN
}

export function parseAgentMaxToolCallsInput(value: string): number {
  if (!/^\d+$/.test(value)) return Number.NaN
  const maxToolCalls = Number(value)
  return Number.isSafeInteger(maxToolCalls) && maxToolCalls >= AGENT_TOOL_CALL_MIN
    ? maxToolCalls
    : Number.NaN
}

export function getAgentResultName(profileId: string): string {
  const validBase = AGENT_PROFILE_ID_PATTERN.test(profileId) ? profileId : 'agent'
  return `${validBase.slice(0, 57).replace(/_+$/g, '') || 'agent'}_result`
}
export function rewriteTaskTransitionReferences(value: unknown, previousId: string, nextId: string): unknown {
  if (!isUnknownRecord(value) || previousId === nextId) return value
  if (value.kind === 'task_transition') {
    return value.taskId === previousId ? { ...value, taskId: nextId } : value
  }
  if (value.kind === 'all' || value.kind === 'any') {
    return Array.isArray(value.children)
      ? { ...value, children: value.children.map((child) => rewriteTaskTransitionReferences(child, previousId, nextId)) }
      : value
  }
  if (value.kind === 'not') {
    return { ...value, child: rewriteTaskTransitionReferences(value.child, previousId, nextId) }
  }
  return value
}

export function createAgentPromptBlock(
  profile: AgentProfileConfigV2,
  taskText: string,
  blockName: string,
): PromptBlock {
  const options: string[] = []
  if (profile.toolIds.length > 0) options.push(`tools=${profile.toolIds.join(',')}`)
  if (profile.streamActivity) options.push('stream')
  const optionSyntax = options.length > 0 ? `::${options.join('::')}` : ''
  return {
    id: generateUUID(),
    name: blockName,
    content: `{{agent::${profile.id}${optionSyntax}}}\n${taskText}\n{{/agent}}`,
    role: 'user',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
  }
}
export type AgenticRuntimeValidationCode =
  | 'invalid_config'
  | 'invalid_modes'
  | 'invalid_default_mode'
  | 'invalid_profile'
  | 'invalid_slot'
  | 'unresolved_slot'
  | 'invalid_block_reference'
  | 'stale_block_revision'
  | 'invalid_predicate'
  | 'predicate_limit_exceeded'
  | 'invalid_task_template'
  | 'invalid_task_policy'
  | 'missing_task_dependency'
  | 'cyclic_task_dependency'
  | 'invalid_context_policy'
  | 'context_policy_reference'
  | 'invalid_context_selection'
  | 'invalid_context_rule'
  | 'missing_context_dependency'
  | 'cyclic_context_dependency'
  | 'missing_context_pack_revision'
  | 'review_acknowledgement_required'
  | 'review_acknowledgement_unknown'

export interface AgenticRuntimeValidationIssue {
  code: AgenticRuntimeValidationCode
  path: string
}

export interface AgenticRuntimeValidationResult {
  valid: boolean
  issues: AgenticRuntimeValidationIssue[]
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
function isCognitionScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)
}

function isCognitionScalarList(value: unknown): value is Array<string | number | boolean> {
  return Array.isArray(value) && value.every((entry) => isCognitionScalar(entry))
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function contextPackRevisionId(packId: string, revision: number): string {
  return `${packId}@${revision}`
}

function isCanonicalContextPackRevisionId(packId: string, revisionId: string): boolean {
  const separator = revisionId.lastIndexOf('@')
  if (separator <= 0 || separator === revisionId.length - 1) return false
  const revision = Number(revisionId.slice(separator + 1))
  return revisionId.slice(0, separator) === packId
    && Number.isSafeInteger(revision)
    && revision >= 1
    && revisionId === contextPackRevisionId(packId, revision)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

export function isAgentContextPolicy(value: unknown): value is AgentContextPolicyV1 {
  if (!isUnknownRecord(value) || !hasOnlyKeys(value, ['ruleIds', 'packIds'])) return false
  return isStringList(value.ruleIds) && isStringList(value.packIds)
}

function isCognitionPredicateShape(value: unknown, depth = 1): value is CognitionPredicate {
  if (!isUnknownRecord(value) || depth > AGENTIC_PREDICATE_MAX_DEPTH) return false
  switch (value.kind) {
    case 'all':
    case 'any':
      return hasOnlyKeys(value, ['kind', 'children'])
        && Array.isArray(value.children)
        && value.children.length > 0
        && value.children.every((child) => isCognitionPredicateShape(child, depth + 1))
    case 'not':
      return hasOnlyKeys(value, ['kind', 'child'])
        && isCognitionPredicateShape(value.child, depth + 1)
    case 'generation_type':
      return hasOnlyKeys(value, ['kind', 'value'])
        && (value.value === 'normal'
          || value.value === 'continue'
          || value.value === 'regenerate'
          || value.value === 'swipe')
    case 'phase':
      return hasOnlyKeys(value, ['kind', 'value'])
        && typeof value.value === 'string'
        && ['ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING', 'COMMITTED',
          'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(value.value)
    case 'preset_variable':
    case 'participant_fact':
      if (typeof value.name !== 'string' || value.name.trim().length === 0) return false
      if (value.operator === 'present') return hasOnlyKeys(value, ['kind', 'name', 'operator'])
      if (value.operator === 'in') {
        return hasOnlyKeys(value, ['kind', 'name', 'operator', 'values'])
          && isCognitionScalarList(value.values)
          && value.values.length > 0
      }
      if (value.operator === 'equals') {
        return hasOnlyKeys(value, ['kind', 'name', 'operator', 'value'])
          && (isCognitionScalar(value.value)
            || Array.isArray(value.value) && value.value.every((entry) => typeof entry === 'string'))
      }
      if (value.operator === 'includes') {
        return hasOnlyKeys(value, ['kind', 'name', 'operator', 'value'])
          && isCognitionScalar(value.value)
      }
      return false
    case 'tool_available':
      return hasOnlyKeys(value, ['kind', 'toolId', 'available'])
        && typeof value.toolId === 'string'
        && value.toolId.trim().length > 0
        && typeof value.available === 'boolean'
    case 'task_transition':
      return hasOnlyKeys(value, ['kind', 'taskId', 'transition'])
        && typeof value.taskId === 'string'
        && POLICY_ID_PATTERN.test(value.taskId)
        && ['pending', 'active', 'blocked', 'submitted', 'accepted', 'done'].includes(String(value.transition))
    default:
      return false
  }
}
export function isAgentTaskTemplate(value: unknown): value is AgentTaskTemplate {
  if (!isUnknownRecord(value)
    || !hasOnlyKeys(value, ['id', 'required', 'dependencies', 'activation', 'label', 'description'])
    || typeof value.id !== 'string'
    || !POLICY_ID_PATTERN.test(value.id)
    || typeof value.required !== 'boolean'
    || value.dependencies !== undefined && (
      !isStringList(value.dependencies)
      || value.dependencies.some((dependency) => !POLICY_ID_PATTERN.test(dependency))
    )
    || value.activation !== undefined && !isCognitionPredicateShape(value.activation)
    || value.label !== undefined && (
      typeof value.label !== 'string'
      || !value.label.trim()
      || value.label.length > AGENTIC_LABEL_MAX_LENGTH
    )
    || value.description !== undefined && (
      typeof value.description !== 'string'
      || UTF8_ENCODER.encode(value.description).byteLength > AGENTIC_DESCRIPTION_MAX_BYTES
    )) {
    return false
  }
  return true
}

export function isAgentContextActivationRule(value: unknown): value is AgentContextActivationRule {
  if (!isUnknownRecord(value)
    || !hasOnlyKeys(value, ['id', 'packId', 'revisionId', 'required', 'dependencies', 'activation'])
    || typeof value.id !== 'string'
    || typeof value.packId !== 'string'
    || typeof value.revisionId !== 'string'
    || !isCanonicalContextPackRevisionId(value.packId, value.revisionId)
    || typeof value.required !== 'boolean') {
    return false
  }
  return (value.dependencies === undefined
    || isStringList(value.dependencies))
    && (value.activation === undefined || isCognitionPredicateShape(value.activation))
}

export function isAgentContextPackSelection(value: unknown): value is AgentContextPackSelection {
  return isUnknownRecord(value)
    && hasOnlyKeys(value, ['packId', 'revisionId', 'revision', 'label', 'revisionLabel', 'digest'])
    && typeof value.packId === 'string'
    && value.packId.length > 0
    && value.packId.length <= 256
    && value.packId === value.packId.trim()
    && typeof value.revisionId === 'string'
    && isCanonicalContextPackRevisionId(value.packId, value.revisionId)
    && typeof value.revision === 'number'
    && Number.isSafeInteger(value.revision)
    && value.revision >= 1
    && value.revisionId === contextPackRevisionId(value.packId, value.revision)
    && (value.label === undefined
      || typeof value.label === 'string' && value.label.length <= AGENTIC_LABEL_MAX_LENGTH)
    && (value.revisionLabel === undefined
      || typeof value.revisionLabel === 'string' && value.revisionLabel.length <= AGENTIC_LABEL_MAX_LENGTH)
    && typeof value.digest === 'string'
    && /^[0-9a-f]{64}$/.test(value.digest)
}

function defaultCognitionPolicy() {
  return {
    workPolicy: [],
    workspaceUsage: [],
    completionCriteria: [],
    renderPolicy: [],
  }
}

export function createDefaultAgentConfigV2(): AgentConfigV2 {
  return {
    version: 2,
    agentsEnabled: false,
    allowedModes: ['response'],
    defaultMode: 'response',
    maxInvocations: 64,
    maxToolCalls: 64,
    mainToolIds: [],
    mainLoreScope: 'active',
    profiles: [],
    connectionSlots: [],
    cognitionPolicy: defaultCognitionPolicy(),
    contextPolicy: { ruleIds: [], packIds: [] },
    taskPolicy: { templateIds: [] },
    workspacePolicy: { retention: 'turn_terminal', sharing: 'view_only' },
  }
}

export function createAgentProfileV2(
  name: string,
  existingIds: Iterable<string>,
): AgentProfileConfigV2 {
  const used = new Set(existingIds)
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64) || 'agent'
  let id = base
  for (let suffix = 2; used.has(id); suffix += 1) {
    const tail = `_${suffix}`
    id = `${base.slice(0, 64 - tail.length)}${tail}`
  }
  return {
    id,
    name,
    systemPrompt: '',
    connectionRef: { kind: 'inherit_main' },
    toolIds: [],
    workspaceCapabilities: [],
    loreScope: 'active',
    allowMainDelegation: false,
    failurePolicy: 'required',
    streamActivity: false,
    maxOutputTokens: 1024,
    timeoutMs: 60_000,
  }
}


export function normalizeAgentConfigForEditor(config: AgentConfigV2): AgentConfigV2 {
  const next: AgentConfigV2 = {
    ...config,
    profiles: Array.isArray(config.profiles)
      ? config.profiles.map((profile) => isUnknownRecord(profile)
        ? {
            ...profile,
            workspaceCapabilities: Array.isArray(profile.workspaceCapabilities)
              ? [...profile.workspaceCapabilities]
              : profile.workspaceCapabilities,
          } as AgentProfileConfigV2
        : profile)
      : [],
  }
  if (next.cognitionPolicy == null) next.cognitionPolicy = defaultCognitionPolicy()
  if (next.contextPolicy == null) next.contextPolicy = { ruleIds: [], packIds: [] }
  if (next.taskPolicy == null) next.taskPolicy = { templateIds: [] }
  if (next.workspacePolicy == null) next.workspacePolicy = { retention: 'turn_terminal', sharing: 'view_only' }
  return next
}

export function createAgenticRuntimeDraft(preset: LoomPreset): AgenticRuntimeSaveDraft {
  const config = normalizeAgentConfigForEditor(
    (isUnknownRecord(preset.agentConfig)
      ? structuredClone(preset.agentConfig)
      : createDefaultAgentConfigV2()) as AgentConfigV2,
  )
  const reviewValue: unknown = preset.agentConfigReview
  const reviewItems = isUnknownRecord(reviewValue) && Array.isArray(reviewValue.items)
    ? reviewValue.items.filter((item): item is AgentConfigRepairItem => isValidRepairItem(item))
    : []
  const slotBindings = isUnknownRecord(preset.agentSlotBindings)
    ? { ...preset.agentSlotBindings }
    : {}
  return {
    config,
    slotBindings,
    contextPackSelections: Array.isArray(preset.agentContextPackSelections)
      ? structuredClone(preset.agentContextPackSelections)
      : [],
    contextRules: Array.isArray(preset.agentContextRules)
      ? structuredClone(preset.agentContextRules)
      : [],
    taskTemplates: Array.isArray(preset.agentTaskTemplates)
      ? structuredClone(preset.agentTaskTemplates)
      : [],
    reviewAcknowledgements: reviewItems
      .filter((item) => item.acknowledged)
      .map((item) => item.id),
  }
}


interface PredicateValidationBudget {
  nodes: number
}

function validatePredicate(
  predicate: CognitionPredicate,
  path: string,
  issues: AgenticRuntimeValidationIssue[],
  budget: PredicateValidationBudget,
  taskTemplateIds?: ReadonlySet<string>,
): void {
  const visit = (current: unknown, currentPath: string, depth: number): void => {
    budget.nodes += 1
    if (depth > AGENTIC_PREDICATE_MAX_DEPTH || budget.nodes > AGENTIC_PREDICATE_MAX_NODES) {
      issues.push({ code: 'predicate_limit_exceeded', path: currentPath })
      return
    }
    if (!isUnknownRecord(current)) {
      issues.push({ code: 'invalid_predicate', path: currentPath })
      return
    }
    if (current.kind === 'all' || current.kind === 'any') {
      if (!Array.isArray(current.children) || current.children.length === 0) {
        issues.push({ code: 'invalid_predicate', path: currentPath })
        return
      }
      current.children.forEach((child, index) => visit(child, `${currentPath}.children.${index}`, depth + 1))
      return
    }
    if (current.kind === 'not') {
      visit(current.child, `${currentPath}.child`, depth + 1)
      return
    }
    if (current.kind === 'preset_variable' || current.kind === 'participant_fact') {
      const name = typeof current.name === 'string' ? current.name.trim() : ''
      const hasScalar = isCognitionScalar(current.value)
      const hasValueList = isCognitionScalarList(current.values) && current.values.length > 0
      const hasEqualsValue = current.operator === 'equals'
        && (hasScalar || Array.isArray(current.value) && current.value.every((entry) => typeof entry === 'string'))
      const hasIncludesValue = current.operator === 'includes' && hasScalar
      if (!name
        || current.operator === 'in' && !hasValueList
        || current.operator === 'equals' && !hasEqualsValue
        || current.operator === 'includes' && !hasIncludesValue
        || current.operator !== 'present'
          && current.operator !== 'in'
          && current.operator !== 'equals'
          && current.operator !== 'includes'
      ) {
        issues.push({ code: 'invalid_predicate', path: currentPath })
      }
      return
    }
    if (current.kind === 'tool_available') {
      if (typeof current.toolId !== 'string' || !current.toolId.trim() || typeof current.available !== 'boolean') {
        issues.push({ code: 'invalid_predicate', path: currentPath })
      }
      return
    }
    if (current.kind === 'task_transition') {
      if (
        typeof current.taskId !== 'string'
        || !POLICY_ID_PATTERN.test(current.taskId)
        || !['pending', 'active', 'blocked', 'submitted', 'accepted', 'done'].includes(String(current.transition))
        || taskTemplateIds !== undefined && !taskTemplateIds.has(current.taskId)
      ) {
        issues.push({ code: 'invalid_predicate', path: currentPath })
      }
      return
    }
    if (current.kind === 'generation_type') {
      if (!['normal', 'continue', 'regenerate', 'swipe'].includes(String(current.value))) {
        issues.push({ code: 'invalid_predicate', path: currentPath })
      }
      return
    }
    if (current.kind === 'phase') {
      if (!['ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING', 'COMMITTED',
        'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(String(current.value))) {
        issues.push({ code: 'invalid_predicate', path: currentPath })
      }
      return
    }
    issues.push({ code: 'invalid_predicate', path: currentPath })
  }
  visit(predicate, path, 1)
}

function isCanonicalWorkspaceCapabilities(value: unknown): value is WorkspaceCapability[] {
  if (value === undefined) return true
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  let previousIndex = -1
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index)) || typeof value[index] !== 'string') return false
    const operationIndex = WORKSPACE_CAPABILITIES.indexOf(value[index] as WorkspaceCapability)
    if (operationIndex < 0 || operationIndex <= previousIndex || seen.has(value[index])) return false
    seen.add(value[index])
    previousIndex = operationIndex
  }
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && (key === 'length' || /^\d+$/.test(key)))
}
function isIndexedArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) return false
  }
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && (key === 'length' || /^\d+$/.test(key)))
}

function isCanonicalCoreToolIds(value: unknown): value is CoreAgentToolId[] {
  if (!isIndexedArray(value)) return false
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string'
      || !CORE_AGENT_TOOL_IDS.includes(entry as CoreAgentToolId)
      || seen.has(entry)) {
      return false
    }
    seen.add(entry)
  }
  return true
}
function isCognitionPolicyShape(value: unknown): value is Record<CognitionPolicyKey, unknown[]> {
  return isUnknownRecord(value)
    && hasOnlyKeys(value, COGNITION_POLICY_KEYS)
    && COGNITION_POLICY_KEYS.every((key) => isIndexedArray(value[key]))
}

function isCanonicalAgentCapabilities(value: unknown): value is AgentCapability[] {
  if (!isIndexedArray(value)) return false
  let previousIndex = -1
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') return false
    const capabilityIndex = AGENT_CAPABILITY_IDS.indexOf(entry as (typeof AGENT_CAPABILITY_IDS)[number])
    if (capabilityIndex < 0 || capabilityIndex <= previousIndex || seen.has(entry)) return false
    seen.add(entry)
    previousIndex = capabilityIndex
  }
  return true
}

function isCanonicalLoreScope(value: unknown): value is (typeof AGENT_LORE_SCOPES)[number] {
  return typeof value === 'string' && AGENT_LORE_SCOPES.includes(value as (typeof AGENT_LORE_SCOPES)[number])
}

function profileHasLoreTool(toolIds: readonly CoreAgentToolId[]): boolean {
  return toolIds.some((toolId) => LORE_TOOL_IDS[toolId] === true)
}

function validateProfiles(
  config: AgentConfigV2,
  draft: AgenticRuntimeSaveDraft,
  issues: AgenticRuntimeValidationIssue[],
): Set<string> {
  const profileIds = new Set<string>()
  const slotIds = new Set<string>()
  const profiles: unknown = (config as unknown as Record<string, unknown>).profiles
  const slots: unknown = (config as unknown as Record<string, unknown>).connectionSlots
  if (!isIndexedArray(profiles)) {
    issues.push({ code: 'invalid_profile', path: 'config.profiles' })
    return profileIds
  }
  if (!isIndexedArray(slots)) {
    issues.push({ code: 'invalid_slot', path: 'config.connectionSlots' })
  } else {
    if (slots.length > AGENT_PROFILE_LIMIT * 2) {
      issues.push({ code: 'invalid_slot', path: 'config.connectionSlots' })
    }
    slots.forEach((value, index) => {
      if (!isUnknownRecord(value)
        || !hasOnlyKeys(value, ['id', 'label', 'requiredCapabilities'])
        || typeof value.id !== 'string'
        || !SLOT_ID_PATTERN.test(value.id)
        || typeof value.label !== 'string'
        || !value.label.trim()
        || value.label.length > AGENT_PROFILE_NAME_MAX_LENGTH
        || !isCanonicalAgentCapabilities(value.requiredCapabilities)) {
        issues.push({ code: 'invalid_slot', path: `config.connectionSlots.${index}` })
        return
      }
      if (slotIds.has(value.id)) {
        issues.push({ code: 'invalid_slot', path: `config.connectionSlots.${index}.id` })
        return
      }
      slotIds.add(value.id)
    })
  }
  if (profiles.length > AGENT_PROFILE_LIMIT) {
    issues.push({ code: 'invalid_profile', path: 'config.profiles' })
  }
  profiles.forEach((rawProfile, index) => {
    const profile = isUnknownRecord(rawProfile) ? rawProfile : {}
    const profileToolIds = profile.toolIds
    const validToolIds = isCanonicalCoreToolIds(profileToolIds)
    const validLoreScope = isCanonicalLoreScope(profile.loreScope)
    const maxOutputTokens = profile.maxOutputTokens
    const timeoutMs = profile.timeoutMs
    const validMaxOutputTokens = typeof maxOutputTokens === 'number'
      && Number.isSafeInteger(maxOutputTokens)
      && maxOutputTokens >= AGENT_MAX_OUTPUT_TOKENS_MIN
      && maxOutputTokens <= AGENT_MAX_OUTPUT_TOKENS_MAX
    const validTimeoutMs = typeof timeoutMs === 'number'
      && Number.isSafeInteger(timeoutMs)
      && timeoutMs >= AGENT_TIMEOUT_MS_MIN
      && timeoutMs % MILLISECONDS_PER_SECOND === 0
    if (typeof profile.id !== 'string'
      || !PROFILE_ID_PATTERN.test(profile.id)
      || profileIds.has(profile.id)
      || typeof profile.name !== 'string'
      || !profile.name.trim()
      || profile.name.length > AGENT_PROFILE_NAME_MAX_LENGTH
      || typeof profile.systemPrompt !== 'string'
      || UTF8_ENCODER.encode(profile.systemPrompt).byteLength > AGENT_SYSTEM_PROMPT_MAX_BYTES
      || !validToolIds
      || !validLoreScope
      || validLoreScope && profile.loreScope === 'all_owned'
        && (!validToolIds || !profileHasLoreTool(profileToolIds))
      || !isCanonicalWorkspaceCapabilities(profile.workspaceCapabilities)
      || typeof profile.allowMainDelegation !== 'boolean'
      || profile.failurePolicy !== 'required' && profile.failurePolicy !== 'optional'
      || typeof profile.streamActivity !== 'boolean'
      || !validMaxOutputTokens
      || !validTimeoutMs) {
      issues.push({ code: 'invalid_profile', path: `config.profiles.${index}` })
    }
    if (typeof profile.id === 'string') profileIds.add(profile.id)
    const connectionRef = profile.connectionRef
    if (!isUnknownRecord(connectionRef) || !hasOnlyKeys(connectionRef, ['kind', 'slotId'])) {
      issues.push({ code: 'invalid_profile', path: `config.profiles.${index}.connectionRef` })
    } else if (connectionRef.kind === 'slot') {
      const slotId = connectionRef.slotId
      if (typeof slotId !== 'string' || !SLOT_ID_PATTERN.test(slotId)) {
        issues.push({ code: 'invalid_profile', path: `config.profiles.${index}.connectionRef` })
      } else if (!slotIds.has(slotId)) {
        issues.push({ code: 'invalid_slot', path: `config.profiles.${index}.connectionRef` })
      } else if (!isUnknownRecord(draft.slotBindings) || !draft.slotBindings[slotId]) {
        issues.push({ code: 'unresolved_slot', path: `slotBindings.${slotId}` })
      }
    } else if (connectionRef.kind !== 'inherit_main') {
      issues.push({ code: 'invalid_profile', path: `config.profiles.${index}.connectionRef` })
    }
  })
  return profileIds
}

function validateCognitionBlocks(
  config: AgentConfigV2,
  blocks: readonly PromptBlock[],
  expectedPresetRevision: number,
  issues: AgenticRuntimeValidationIssue[],
): void {
  const blockById = new Map<string, PromptBlock>()
  for (const candidate of blocks) {
    if (isUnknownRecord(candidate) && typeof candidate.id === 'string') {
      blockById.set(candidate.id, candidate as unknown as PromptBlock)
    }
  }
  const policy: unknown = (config as unknown as Record<string, unknown>).cognitionPolicy
  if (policy === undefined || policy === null) return
  if (!isCognitionPolicyShape(policy)) {
    issues.push({ code: 'invalid_config', path: 'config.cognitionPolicy' })
    return
  }
  for (const groupName of COGNITION_POLICY_KEYS) {
    const refs = policy[groupName]
    refs.forEach((rawRef, index) => {
      const path = `config.cognitionPolicy.${groupName}.${index}`
      if (!isUnknownRecord(rawRef)
        || !hasOnlyKeys(rawRef, ['blockId', 'expectedPresetRevision', 'expectedBlockRevision'])
        || typeof rawRef.blockId !== 'string') {
        issues.push({ code: 'invalid_block_reference', path })
        return
      }
      const ref = rawRef
      const blockId = ref.blockId
      if (typeof blockId !== 'string') {
        issues.push({ code: 'invalid_block_reference', path })
        return
      }
      const block = blockById.get(blockId)
      if (!block || block.marker === 'category') {
        issues.push({ code: 'invalid_block_reference', path })
        return
      }
      const blockRevision: unknown = (block as unknown as Record<string, unknown>).revision
      if (!isNonNegativeSafeInteger(expectedPresetRevision)
        || !isNonNegativeSafeInteger(ref.expectedPresetRevision)
        || !isNonNegativeSafeInteger(ref.expectedBlockRevision)
        || !isCanonicalBlockRevision(blockRevision)) {
        issues.push({ code: 'invalid_block_reference', path })
      } else if (ref.expectedPresetRevision !== expectedPresetRevision
        || ref.expectedBlockRevision !== blockRevision) {
        issues.push({ code: 'stale_block_revision', path })
      }
    })
  }
}
function validatePromptProfileMarkers(
  profileIds: ReadonlySet<string>,
  blocks: readonly PromptBlock[],
  issues: AgenticRuntimeValidationIssue[],
): void {
  blocks.forEach((block, index) => {
    const content = isUnknownRecord(block) ? block.content : undefined
    for (const profileId of getAgentProfileMarkerIds(content)) {
      if (!profileIds.has(profileId)) {
        issues.push({ code: 'invalid_profile', path: `promptOrder.${index}.content` })
      }
    }
  })
}

function validateTaskTemplates(
  templates: readonly unknown[],
  issues: AgenticRuntimeValidationIssue[],
  predicateBudget: PredicateValidationBudget,
): Set<string> {
  if (templates.length > AGENTIC_TASK_TEMPLATE_LIMIT) {
    issues.push({ code: 'invalid_task_template', path: 'taskTemplates' })
  }
  const byId = new Map<string, AgentTaskTemplate>()
  const validTemplates: Array<{ template: AgentTaskTemplate; index: number }> = []
  templates.forEach((value, index) => {
    if (!isAgentTaskTemplate(value)) {
      issues.push({ code: 'invalid_task_template', path: `taskTemplates.${index}` })
      return
    }
    const template = value
    if (byId.has(template.id)) {
      issues.push({ code: 'invalid_task_template', path: `taskTemplates.${index}` })
    }
    byId.set(template.id, template)
    validTemplates.push({ template, index })
  })
  const templateIds = new Set(byId.keys())
  validTemplates.forEach(({ template, index }) => {
    if (template.activation) {
      validatePredicate(template.activation, `taskTemplates.${index}.activation`, issues, predicateBudget, templateIds)
    }
    const dependencies = template.dependencies ?? []
    if (new Set(dependencies).size !== dependencies.length) {
      issues.push({ code: 'invalid_task_template', path: `taskTemplates.${index}.dependencies` })
    }
    dependencies.forEach((dependencyId, dependencyIndex) => {
      if (!byId.has(dependencyId)) {
        issues.push({
          code: 'missing_task_dependency',
          path: `taskTemplates.${index}.dependencies.${dependencyIndex}`,
        })
      }
    })
  })
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const cyclic = byId.get(id)?.dependencies?.some((dependencyId) => visit(dependencyId)) ?? false
    visiting.delete(id)
    visited.add(id)
    return cyclic
  }
  for (const id of byId.keys()) {
    if (visit(id)) {
      issues.push({ code: 'cyclic_task_dependency', path: `taskTemplates.${id}.dependencies` })
      break
    }
  }
  return new Set(byId.keys())
}

function validateTaskPolicy(
  policyValue: unknown,
  templateIds: ReadonlySet<string>,
  issues: AgenticRuntimeValidationIssue[],
): void {
  const policy = policyValue === undefined || policyValue === null
    ? { templateIds: [] }
    : policyValue
  if (!isUnknownRecord(policy)
    || !hasOnlyKeys(policy, ['templateIds'])
    || !isIndexedArray(policy.templateIds)) {
    issues.push({ code: 'invalid_task_policy', path: 'config.taskPolicy' })
    return
  }
  const policyIds = new Set<string>()
  policy.templateIds.forEach((templateId, index) => {
    if (typeof templateId !== 'string'
      || !POLICY_ID_PATTERN.test(templateId)
      || policyIds.has(templateId)
      || !templateIds.has(templateId)) {
      issues.push({ code: 'invalid_task_policy', path: `config.taskPolicy.templateIds.${index}` })
      return
    }
    policyIds.add(templateId)
  })
  templateIds.forEach((templateId) => {
    if (!policyIds.has(templateId)) {
      issues.push({ code: 'invalid_task_policy', path: `taskTemplates.${templateId}` })
    }
  })
}

function validateContextPackSelections(
  selections: readonly unknown[],
  issues: AgenticRuntimeValidationIssue[],
  availableRevisionKeys?: ReadonlySet<string>,
): { keys: Set<string>; packIds: Set<string> } {
  const keys = new Set<string>()
  const packIds = new Set<string>()
  if (selections.length > AGENTIC_CONTEXT_RULE_LIMIT) {
    issues.push({ code: 'invalid_context_selection', path: 'contextPackSelections' })
  }
  selections.forEach((selection, index) => {
    if (!isAgentContextPackSelection(selection)) {
      issues.push({ code: 'invalid_context_selection', path: `contextPackSelections.${index}` })
      return
    }
    const key = `${selection.packId}\u0000${selection.revisionId}`
    if (keys.has(key) || packIds.has(selection.packId)
      || availableRevisionKeys !== undefined && !availableRevisionKeys.has(key)) {
      issues.push({ code: 'invalid_context_selection', path: `contextPackSelections.${index}` })
      return
    }
    keys.add(key)
    packIds.add(selection.packId)
  })
  return { keys, packIds }
}

function validateContextRules(
  rules: readonly unknown[],
  selectedPackKeys: ReadonlySet<string>,
  issues: AgenticRuntimeValidationIssue[],
  predicateBudget: PredicateValidationBudget,
  taskTemplateIds?: ReadonlySet<string>,
): { ids: Set<string>; packIds: Set<string> } {
  const ids = new Set<string>()
  const packIds = new Set<string>()
  const dependencyById = new Map<string, readonly string[]>()
  if (rules.length > AGENTIC_CONTEXT_RULE_LIMIT) {
    issues.push({ code: 'invalid_context_rule', path: 'contextRules' })
  }
  rules.forEach((value, index) => {
    if (!isAgentContextActivationRule(value)) {
      issues.push({ code: 'invalid_context_rule', path: `contextRules.${index}` })
      return
    }
    const rule = value
    if (!POLICY_ID_PATTERN.test(rule.id) || ids.has(rule.id)) {
      issues.push({ code: 'invalid_context_rule', path: `contextRules.${index}` })
    }
    ids.add(rule.id)
    packIds.add(rule.packId)
    const dependencies = rule.dependencies ?? []
    dependencyById.set(rule.id, dependencies)
    if (!selectedPackKeys.has(`${rule.packId}\u0000${rule.revisionId}`)) {
      issues.push({
        code: 'missing_context_pack_revision',
        path: `contextRules.${index}.revisionId`,
      })
    }
    if (new Set(dependencies).size !== dependencies.length) {
      issues.push({ code: 'invalid_context_rule', path: `contextRules.${index}.dependencies` })
    }
    dependencies.forEach((dependencyId, dependencyIndex) => {
      if (!ids.has(dependencyId) && !rules.some((candidate) => (
        isAgentContextActivationRule(candidate) && candidate.id === dependencyId
      ))) {
        issues.push({
          code: 'missing_context_dependency',
          path: `contextRules.${index}.dependencies.${dependencyIndex}`,
        })
      }
    })
    if (rule.activation) {
      validatePredicate(rule.activation, `contextRules.${index}.activation`, issues, predicateBudget, taskTemplateIds)
    }
  })
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const cyclic = dependencyById.get(id)?.some((dependencyId) => visit(dependencyId)) ?? false
    visiting.delete(id)
    visited.add(id)
    return cyclic
  }
  for (const id of dependencyById.keys()) {
    if (visit(id)) {
      issues.push({ code: 'cyclic_context_dependency', path: `contextRules.${id}.dependencies` })
      break
    }
  }
  return { ids, packIds }
}

function validateContextPolicy(
  policyValue: unknown,
  selectedPackIds: ReadonlySet<string>,
  selectedRuleIds: ReadonlySet<string>,
  selectedRulePackIds: ReadonlySet<string>,
  issues: AgenticRuntimeValidationIssue[],
): void {
  const resolvedPolicy = policyValue === undefined || policyValue === null
    ? { ruleIds: [], packIds: [] }
    : policyValue
  if (!isAgentContextPolicy(resolvedPolicy)) {
    issues.push({ code: 'invalid_context_policy', path: 'config.contextPolicy' })
    return
  }
  const policy = resolvedPolicy
  const policyPackIds = new Set<string>()
  policy.packIds.forEach((packId, index) => {
    if (!packId.trim() || policyPackIds.has(packId)) {
      issues.push({ code: 'invalid_context_policy', path: `config.contextPolicy.packIds.${index}` })
    }
    policyPackIds.add(packId)
    if (!selectedPackIds.has(packId)) {
      issues.push({ code: 'context_policy_reference', path: `config.contextPolicy.packIds.${index}` })
    }
  })
  const policyRuleIds = new Set<string>()
  policy.ruleIds.forEach((ruleId, index) => {
    if (!POLICY_ID_PATTERN.test(ruleId) || policyRuleIds.has(ruleId)) {
      issues.push({ code: 'invalid_context_policy', path: `config.contextPolicy.ruleIds.${index}` })
    }
    policyRuleIds.add(ruleId)
    if (!selectedRuleIds.has(ruleId)) {
      issues.push({ code: 'context_policy_reference', path: `config.contextPolicy.ruleIds.${index}` })
    }
  })
  selectedRuleIds.forEach((ruleId) => {
    if (!policyRuleIds.has(ruleId)) {
      issues.push({ code: 'context_policy_reference', path: `contextRules.${ruleId}` })
    }
  })
  selectedPackIds.forEach((packId) => {
    if (!policyPackIds.has(packId) && !selectedRulePackIds.has(packId)) {
      issues.push({ code: 'context_policy_reference', path: `contextPackSelections.${packId}` })
    }
  })
}

export function validateAgenticRuntimeDraft(
  draft: AgenticRuntimeSaveDraft,
  blocks: readonly PromptBlock[],
  expectedPresetRevision: number,
  requiredReviewItemIds: readonly string[] = [],
  availableContextRevisionKeys?: ReadonlySet<string>,
): AgenticRuntimeValidationResult {
  const issues: AgenticRuntimeValidationIssue[] = []
  if (!isUnknownRecord(draft)) return { valid: false, issues: [{ code: 'invalid_config', path: 'draft' }] }
  const rawConfig = draft.config
  if (!isUnknownRecord(rawConfig)) return { valid: false, issues: [{ code: 'invalid_config', path: 'config' }] }
  const config = rawConfig as unknown as AgentConfigV2
  if (config.version !== 2) return { valid: false, issues: [{ code: 'invalid_config', path: 'config' }] }

  const allowedModes = rawConfig.allowedModes
  const modesAreValid = isIndexedArray(allowedModes)
  if (!modesAreValid
    || allowedModes.length === 0
    || allowedModes[0] !== 'response'
    || new Set(allowedModes).size !== allowedModes.length
    || allowedModes.some((mode) => !AGENT_MODES.includes(mode as AgentMode))) {
    issues.push({ code: 'invalid_modes', path: 'config.allowedModes' })
  }
  if (modesAreValid && typeof rawConfig.defaultMode !== 'string') {
    issues.push({ code: 'invalid_default_mode', path: 'config.defaultMode' })
  } else if (modesAreValid && !allowedModes.includes(rawConfig.defaultMode)) {
    issues.push({ code: 'invalid_default_mode', path: 'config.defaultMode' })
  }
  if (typeof rawConfig.agentsEnabled !== 'boolean') {
    issues.push({ code: 'invalid_config', path: 'config.agentsEnabled' })
  } else if (!rawConfig.agentsEnabled && modesAreValid && allowedModes.includes('agentic')) {
    issues.push({ code: 'invalid_modes', path: 'config.allowedModes' })
  }

  const validMainToolIds = isCanonicalCoreToolIds(rawConfig.mainToolIds)
  const validMainLoreScope = isCanonicalLoreScope(rawConfig.mainLoreScope)
  if (!validMainToolIds
    || !validMainLoreScope
    || validMainLoreScope && rawConfig.mainLoreScope === 'all_owned' && !profileHasLoreTool(rawConfig.mainToolIds)) {
    issues.push({ code: 'invalid_config', path: 'config.mainToolIds' })
  }
  const profileIds = validateProfiles(config, draft, issues)
  const promptBlocksAreValid = isIndexedArray(blocks)
  const promptBlocks = promptBlocksAreValid ? blocks : []
  if (!promptBlocksAreValid) {
    issues.push({ code: 'invalid_block_reference', path: 'promptOrder' })
  }
  validatePromptProfileMarkers(profileIds, promptBlocks as PromptBlock[], issues)
  validateCognitionBlocks(config, promptBlocks as PromptBlock[], expectedPresetRevision, issues)

  const predicateBudget: PredicateValidationBudget = { nodes: 0 }
  const taskTemplates = isIndexedArray(draft.taskTemplates) ? draft.taskTemplates : []
  if (!isIndexedArray(draft.taskTemplates)) {
    issues.push({ code: 'invalid_task_template', path: 'taskTemplates' })
  }
  const taskTemplateIds = validateTaskTemplates(taskTemplates, issues, predicateBudget)
  validateTaskPolicy(rawConfig.taskPolicy, taskTemplateIds, issues)

  const contextPackSelections = isIndexedArray(draft.contextPackSelections) ? draft.contextPackSelections : []
  if (!isIndexedArray(draft.contextPackSelections)) {
    issues.push({ code: 'invalid_context_selection', path: 'contextPackSelections' })
  }
  const contextSelections = validateContextPackSelections(
    contextPackSelections,
    issues,
    availableContextRevisionKeys,
  )
  const contextRules = isIndexedArray(draft.contextRules) ? draft.contextRules : []
  if (!isIndexedArray(draft.contextRules)) {
    issues.push({ code: 'invalid_context_rule', path: 'contextRules' })
  }
  const contextRuleResult = validateContextRules(
    contextRules,
    contextSelections.keys,
    issues,
    predicateBudget,
    taskTemplateIds,
  )
  validateContextPolicy(
    rawConfig.contextPolicy,
    contextSelections.packIds,
    contextRuleResult.ids,
    contextRuleResult.packIds,
    issues,
  )
  const acknowledgements = isStringList(draft.reviewAcknowledgements) ? draft.reviewAcknowledgements : []
  if (!isStringList(draft.reviewAcknowledgements)) {
    issues.push({ code: 'review_acknowledgement_unknown', path: 'reviewAcknowledgements' })
  }
  const requiredReviewIds = new Set(requiredReviewItemIds)
  if (acknowledgements.some((id) => !requiredReviewIds.has(id))) {
    issues.push({ code: 'review_acknowledgement_unknown', path: 'reviewAcknowledgements' })
  }
  if (requiredReviewItemIds.some((id) => !acknowledgements.includes(id))) {
    issues.push({ code: 'review_acknowledgement_required', path: 'reviewAcknowledgements' })
  }
  return { valid: issues.length === 0, issues }
}
function isValidRepairItem(value: unknown): value is AgentConfigRepairItem {
  if (!isUnknownRecord(value) || typeof value.id !== 'string' || typeof value.reasonCode !== 'string') return false
  const action = value.action
  if (!isUnknownRecord(action) || typeof action.kind !== 'string') return false
  return ['unresolved_slot', 'stale_slot', 'invalid_rule', 'invalid_pack', 'disabled_import', 'capability_mismatch', 'stale_block'].includes(String(value.kind))
    && ['acknowledge', 'map_slot', 'select_revision', 'edit_rule', 'choose_response'].includes(action.kind)
}

function invalidReviewItem(reasonCode: string): AgentConfigRepairItem {
  return {
    id: `review:${reasonCode}`,
    kind: 'disabled_import',
    label: reasonCode,
    reasonCode,
    action: { kind: 'acknowledge' },
    acknowledged: false,
  }
}

export function getAgenticRuntimeRepairItems(preset: LoomPreset): AgentConfigRepairItem[] {
  const reviewValue: unknown = preset.agentConfigReview
  if (reviewValue === null || reviewValue === undefined) return []
  if (!isUnknownRecord(reviewValue)) return [invalidReviewItem('invalid_review')]

  const reviewState = reviewValue.state
  const stateIsKnown = reviewState === 'ready' || reviewState === 'review_required' || reviewState === 'repair_required'
  const reviewShapeIsValid = stateIsKnown
    && isNonNegativeSafeInteger(reviewValue.revision)
    && (reviewValue.reasonCode === null || typeof reviewValue.reasonCode === 'string')
    && isStringList(reviewValue.unresolvedSlotIds)
    && isStringList(reviewValue.staleSlotIds)
    && Array.isArray(reviewValue.items)
    && reviewValue.items.every((item) => isValidRepairItem(item))
  const projected = Array.isArray(reviewValue.items)
    ? reviewValue.items.filter((item): item is AgentConfigRepairItem => isValidRepairItem(item))
    : []
  if (reviewShapeIsValid && reviewState === 'ready') return []
  if (projected.length > 0) return projected

  const unresolvedSlotIds = isStringList(reviewValue.unresolvedSlotIds) ? reviewValue.unresolvedSlotIds : []
  const staleSlotIds = isStringList(reviewValue.staleSlotIds) ? reviewValue.staleSlotIds : []
  const items: AgentConfigRepairItem[] = []
  unresolvedSlotIds.forEach((slotId) => items.push({
    id: `slot:${slotId}`,
    kind: 'unresolved_slot',
    label: slotId,
    reasonCode: 'unresolved_slot',
    action: { kind: 'map_slot' },
    acknowledged: false,
  }))
  staleSlotIds.forEach((slotId) => items.push({
    id: `stale-slot:${slotId}`,
    kind: 'stale_slot',
    label: slotId,
    reasonCode: 'stale_slot',
    action: { kind: 'map_slot' },
    acknowledged: false,
  }))
  if (items.length > 0) return items

  const reasonCode = typeof reviewValue.reasonCode === 'string' && reviewValue.reasonCode.trim()
    ? reviewValue.reasonCode
    : reviewState === 'repair_required'
      ? 'repair_required'
      : reviewState === 'review_required'
        ? 'review_required'
        : 'invalid_review'
  return [invalidReviewItem(reasonCode)]
}

export function runtimeDraftFingerprint(draft: AgenticRuntimeSaveDraft): string {
  return JSON.stringify(draft)
}
