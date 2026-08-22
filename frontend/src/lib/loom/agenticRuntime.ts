import {
  AGENT_CUSTOM_PHASE_CAPABILITIES,
  AGENT_INVOCATION_MIN,
  AGENT_TOOL_CALL_MIN,
  WORKSPACE_CAPABILITIES,
  type AgentCapability,
  type AgentCognitionPolicy,
  type AgentConfigRepairItem,
  type AgentCustomPhaseV1,
  type AgentPromptBlockRef,
  type AgentConfigV2,
  type AgentContextActivationRule,
  type AgentContextPackSelection,
  type AgentContextPolicyV1,
  type AgentMode,
  type AgentProfileConfigV2,
  type AgentRuntimePolicyV1,
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
import type {
  LoomOnDemandRequestV1,
  LoomOnDemandRetrievalStatusV1,
  LoomPolicyBucketV1,
  LoomPolicyBucketsV1,
  LoomPolicyCheckpointV1,
  LoomPolicyDeliveryV1,
  LoomPolicyDestinationV1,
  LoomPolicyEntryV1,
  LoomPolicySourceV1,
  LoomPromptInspectionBlockV1,
  LoomPromptInspectionContextPackV1,
  LoomPromptInspectionInputV1,
  LoomPromptInspectionItemV1,
  LoomPromptInspectionOutcomeV1,
  LoomPromptInspectionV1,
  LoomResponsePolicyOmissionV1,
  LoomResponsePolicyPhaseInstructionV1,
} from '@/types/agent-runtime'

export const AGENTIC_PREDICATE_MAX_DEPTH = 16
export const AGENTIC_PREDICATE_MAX_NODES = 256
export const AGENTIC_TASK_TEMPLATE_LIMIT = 256
export const AGENTIC_CONTEXT_RULE_LIMIT = 256
export const AGENTIC_CUSTOM_PHASE_LIMIT = 64
export const AGENTIC_LOOM_POLICY_BUCKET_LIMIT = 64
export const AGENTIC_LOOM_POLICY_LIMIT = 128
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


function promptBlockRevision(block: PromptBlock, path: string): number {
  if (block.revision === undefined) return 1
  if (!isCanonicalBlockRevision(block.revision)) {
    return loomPolicyError(path, 'must be a positive safe integer')
  }
  return block.revision
}
const LOOM_POLICY_BUCKET_ORDER = ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'] as const
const LOOM_POLICY_DESTINATION_BY_BUCKET: Record<LoomPolicyBucketV1, LoomPolicyDestinationV1> = {
  workPolicy: 'root_work',
  workspaceUsage: 'root_work',
  completionCriteria: 'completion_handoff',
  renderPolicy: 'render',
}
const LOOM_POLICY_CHECKPOINT_BY_BUCKET: Record<LoomPolicyBucketV1, LoomPolicyCheckpointV1> = {
  workPolicy: 'WORK',
  workspaceUsage: 'WORK',
  completionCriteria: 'PREPARE_COMMIT',
  renderPolicy: 'RENDER',
}
const LOOM_POLICY_CHECKPOINT_RANK: Record<LoomPolicyCheckpointV1, number> = {
  ASSEMBLE: 0,
  WORK: 1,
  PREPARE_COMMIT: 2,
  RENDER: 3,
}
export const LOOM_RESPONSE_OMISSION_MAX_PHASE_INSTRUCTIONS = 4096

function loomPolicyError(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

function loomPolicyRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) return loomPolicyError(path, 'must be an object')
  return value
}

function loomPolicyExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) if (!allowed.has(key)) loomPolicyError(`${path}.${key}`, 'unknown key')
}

function loomPolicyString(value: unknown, path: string, maxBytes = 4 * 1024): string {
  if (typeof value !== 'string' || value.length === 0 || UTF8_ENCODER.encode(value).byteLength > maxBytes) {
    return loomPolicyError(path, 'must be a bounded non-empty string')
  }
  return value
}

function loomPolicyRevision(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return loomPolicyError(path, 'must be a non-negative safe integer')
  return value
}

function loomPolicyBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return loomPolicyError(path, 'must be a boolean')
  return value
}

function parseLoomPolicySourceV1(value: unknown, path: string): LoomPolicySourceV1 {
  const object = loomPolicyRecord(value, path)
  loomPolicyExactKeys(object, ['kind', 'blockId', 'presetRevision', 'blockRevision', 'promptOrder'], path)
  if (object.kind !== 'loom_block') loomPolicyError(`${path}.kind`, 'unsupported source kind')
  const blockRevision = loomPolicyRevision(object.blockRevision, `${path}.blockRevision`)
  if (!isCanonicalBlockRevision(blockRevision)) {
    loomPolicyError(`${path}.blockRevision`, 'must be a positive safe integer')
  }
  return {
    kind: 'loom_block',
    blockId: loomPolicyString(object.blockId, `${path}.blockId`, 256),
    presetRevision: loomPolicyRevision(object.presetRevision, `${path}.presetRevision`),
    blockRevision,
    promptOrder: loomPolicyRevision(object.promptOrder, `${path}.promptOrder`),
  }
}
function parseLoomResponsePolicyPhaseInstructionV1(
  value: unknown,
  path: string,
): LoomResponsePolicyPhaseInstructionV1 {
  const object = loomPolicyRecord(value, path)
  loomPolicyExactKeys(object, ['phaseId', 'source'], path)
  const phaseId = loomPolicyString(object.phaseId, `${path}.phaseId`, 64)
  if (!POLICY_ID_PATTERN.test(phaseId)) loomPolicyError(`${path}.phaseId`, 'must use a stable lowercase identifier')
  return {
    phaseId,
    source: parseLoomPolicySourceV1(object.source, `${path}.source`),
  }
}

export function parseLoomResponsePolicyOmissionV1(value: unknown): LoomResponsePolicyOmissionV1 {
  const object = loomPolicyRecord(value, 'responseOmission')
  loomPolicyExactKeys(object, [
    'version',
    'surface',
    'visibility',
    'reason',
    'omittedEntryIds',
    'source',
    'omittedPhaseInstructions',
  ], 'responseOmission')
  if (object.version !== 1) loomPolicyError('responseOmission.version', 'unsupported Loom policy version')
  if (object.surface !== 'RESPONSE') loomPolicyError('responseOmission.surface', 'must be RESPONSE')
  if (object.visibility !== 'work_only') loomPolicyError('responseOmission.visibility', 'must be work_only')
  if (object.reason !== 'work_only') loomPolicyError('responseOmission.reason', 'must be work_only')
  if (!isIndexedArray(object.omittedEntryIds) || object.omittedEntryIds.length > 128) {
    loomPolicyError('responseOmission.omittedEntryIds', 'must contain at most 128 entries')
  }
  const omittedEntryIds = object.omittedEntryIds.map((entryId, index) => (
    loomPolicyString(entryId, `responseOmission.omittedEntryIds[${index}]`, 256)
  ))
  if (new Set(omittedEntryIds).size !== omittedEntryIds.length) {
    loomPolicyError('responseOmission.omittedEntryIds', 'contains duplicate entry ids')
  }
  if (!isIndexedArray(object.source) || object.source.length > 128) {
    loomPolicyError('responseOmission.source', 'must contain at most 128 sources')
  }
  const source = object.source.map((value, index) => (
    parseLoomPolicySourceV1(value, `responseOmission.source[${index}]`)
  ))
  if (source.length !== omittedEntryIds.length) {
    loomPolicyError('responseOmission', 'omittedEntryIds and source must preserve one-to-one order')
  }
  if (!isIndexedArray(object.omittedPhaseInstructions)
    || object.omittedPhaseInstructions.length > LOOM_RESPONSE_OMISSION_MAX_PHASE_INSTRUCTIONS) {
    loomPolicyError(
      'responseOmission.omittedPhaseInstructions',
      `must contain at most ${LOOM_RESPONSE_OMISSION_MAX_PHASE_INSTRUCTIONS} entries`,
    )
  }
  const omittedPhaseInstructions = object.omittedPhaseInstructions.map((instruction, index) => (
    parseLoomResponsePolicyPhaseInstructionV1(
      instruction,
      `responseOmission.omittedPhaseInstructions[${index}]`,
    )
  ))
  return Object.freeze({
    version: 1,
    surface: 'RESPONSE',
    visibility: 'work_only',
    reason: 'work_only',
    omittedEntryIds: Object.freeze(omittedEntryIds),
    source: Object.freeze(source),
    omittedPhaseInstructions: Object.freeze(omittedPhaseInstructions),
  })
}

function parseLoomOnDemandRequestV1(value: unknown, path: string): LoomOnDemandRequestV1 {
  const object = loomPolicyRecord(value, path)
  loomPolicyExactKeys(object, ['contextPackId', 'revisionId', 'digest'], path)
  const digest = loomPolicyString(object.digest, `${path}.digest`, 128).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(digest)) loomPolicyError(`${path}.digest`, 'must be a SHA-256 digest')
  return {
    contextPackId: loomPolicyString(object.contextPackId, `${path}.contextPackId`, 256),
    revisionId: loomPolicyString(object.revisionId, `${path}.revisionId`, 256),
    digest,
  }
}

function parseLoomPolicyDeliveryV1(value: unknown, path: string): LoomPolicyDeliveryV1 {
  const object = loomPolicyRecord(value, path)
  if (object.delivery === 'direct') {
    loomPolicyExactKeys(object, ['delivery'], path)
    return { delivery: 'direct' }
  }
  if (object.delivery === 'condition_gated') {
    loomPolicyExactKeys(object, ['delivery', 'condition'], path)
    if (!isCognitionPredicateShape(object.condition)) loomPolicyError(`${path}.condition`, 'invalid predicate')
    return { delivery: 'condition_gated', condition: object.condition }
  }
  if (object.delivery === 'on_demand') {
    loomPolicyExactKeys(object, ['delivery', 'request'], path)
    return { delivery: 'on_demand', request: parseLoomOnDemandRequestV1(object.request, `${path}.request`) }
  }
  return loomPolicyError(`${path}.delivery`, 'unsupported delivery')
}

function parseLoomPolicyEntryV1(value: unknown, path: string, bucket: LoomPolicyBucketV1): LoomPolicyEntryV1 {
  const object = loomPolicyRecord(value, path)
  loomPolicyExactKeys(object, ['version', 'id', 'source', 'destination', 'checkpoint', 'required', 'visibility', 'delivery'], path)
  if (object.version !== 1) loomPolicyError(`${path}.version`, 'unsupported Loom policy version')
  const destination = object.destination
  if (destination !== LOOM_POLICY_DESTINATION_BY_BUCKET[bucket]) loomPolicyError(`${path}.destination`, 'destination is not valid for its bucket')
  if (typeof object.checkpoint !== 'string' || !Object.hasOwn(LOOM_POLICY_CHECKPOINT_RANK, object.checkpoint)) {
    loomPolicyError(`${path}.checkpoint`, 'unsupported checkpoint')
  }
  if (object.checkpoint !== LOOM_POLICY_CHECKPOINT_BY_BUCKET[bucket]) {
    loomPolicyError(`${path}.checkpoint`, 'checkpoint is not valid for its bucket')
  }
  if (object.visibility !== 'work_only') loomPolicyError(`${path}.visibility`, 'unsupported policy visibility')
  return {
    version: 1,
    id: loomPolicyString(object.id, `${path}.id`, 256),
    source: parseLoomPolicySourceV1(object.source, `${path}.source`),
    destination: destination as LoomPolicyDestinationV1,
    checkpoint: object.checkpoint as LoomPolicyCheckpointV1,
    required: loomPolicyBoolean(object.required, `${path}.required`),
    visibility: 'work_only',
    delivery: parseLoomPolicyDeliveryV1(object.delivery, `${path}.delivery`),
  }
}

function sortLoomPolicyEntriesV1(entries: readonly LoomPolicyEntryV1[]): LoomPolicyEntryV1[] {
  return [...entries].sort((left, right) =>
    left.source.promptOrder - right.source.promptOrder
    || left.source.blockId.localeCompare(right.source.blockId)
    || left.id.localeCompare(right.id))
}

export function parseLoomPolicyBucketsV1(value: unknown): LoomPolicyBucketsV1 {
  const object = loomPolicyRecord(value, 'policies')
  loomPolicyExactKeys(object, ['version', ...LOOM_POLICY_BUCKET_ORDER], 'policies')
  if (object.version !== 1) loomPolicyError('policies.version', 'unsupported Loom policy version')
  const entriesByBucket = Object.fromEntries(LOOM_POLICY_BUCKET_ORDER.map((bucket) => {
    const raw = object[bucket]
    if (!isIndexedArray(raw)) loomPolicyError(`policies.${bucket}`, 'must be a dense array')
    if (raw.length > AGENTIC_LOOM_POLICY_BUCKET_LIMIT) loomPolicyError(`policies.${bucket}`, 'contains too many policy entries')
    return [bucket, sortLoomPolicyEntriesV1(raw.map((entry, index) => parseLoomPolicyEntryV1(entry, `policies.${bucket}[${index}]`, bucket)))]
  })) as Record<LoomPolicyBucketV1, LoomPolicyEntryV1[]>
  const ids = new Set<string>()
  for (const bucket of LOOM_POLICY_BUCKET_ORDER) {
    for (const entry of entriesByBucket[bucket]) {
      if (ids.has(entry.id)) loomPolicyError(`policies.${bucket}`, 'duplicate policy id')
      ids.add(entry.id)
    }
  }
  if (ids.size > AGENTIC_LOOM_POLICY_LIMIT) loomPolicyError('policies', 'contains too many policy entries')
  return Object.freeze({
    version: 1,
    workPolicy: Object.freeze(entriesByBucket.workPolicy),
    workspaceUsage: Object.freeze(entriesByBucket.workspaceUsage),
    completionCriteria: Object.freeze(entriesByBucket.completionCriteria),
    renderPolicy: Object.freeze(entriesByBucket.renderPolicy),
  })
}
const CUSTOM_PHASE_CAPABILITY_SET = new Set<string>(AGENT_CUSTOM_PHASE_CAPABILITIES)

function parseAgentCustomPhaseV1(value: unknown, path: string): AgentCustomPhaseV1 {
  const object = loomPolicyRecord(value, path)
  loomPolicyExactKeys(object, [
    'version',
    'id',
    'label',
    'instructionRefs',
    'required',
    'enter',
    'exit',
    'skip',
    'capabilityRequests',
    'repeatLimit',
    'nextPhaseIds',
  ], path)
  if (object.version !== 1) loomPolicyError(`${path}.version`, 'unsupported custom phase version')
  const id = loomPolicyString(object.id, `${path}.id`, 64)
  if (!POLICY_ID_PATTERN.test(id)) loomPolicyError(`${path}.id`, 'must use a stable lowercase identifier')
  const label = loomPolicyString(object.label, `${path}.label`, AGENTIC_LABEL_MAX_LENGTH)
  if (!isIndexedArray(object.instructionRefs) || object.instructionRefs.length > 64) {
    loomPolicyError(`${path}.instructionRefs`, 'must contain at most 64 exact Loom block references')
  }
  const instructionRefs = object.instructionRefs.map((ref, index) => (
    parseLoomPolicySourceV1(ref, `${path}.instructionRefs[${index}]`)
  ))
  const sourceKeys = new Set<string>()
  instructionRefs.forEach((source, index) => {
    const key = `${source.blockId}\u0000${source.presetRevision}\u0000${source.blockRevision}\u0000${source.promptOrder}`
    if (sourceKeys.has(key)) loomPolicyError(`${path}.instructionRefs[${index}]`, 'duplicate instruction reference')
    sourceKeys.add(key)
  })
  const required = loomPolicyBoolean(object.required, `${path}.required`)
  const enter = isCognitionPredicateShape(object.enter)
    ? object.enter
    : loomPolicyError(`${path}.enter`, 'invalid predicate')
  const exit = isCognitionPredicateShape(object.exit)
    ? object.exit
    : loomPolicyError(`${path}.exit`, 'invalid predicate')
  const skipValue = object.skip
  const skip = skipValue === undefined
    ? undefined
    : isCognitionPredicateShape(skipValue)
      ? skipValue
      : loomPolicyError(`${path}.skip`, 'invalid predicate')
  if (!isIndexedArray(object.capabilityRequests) || object.capabilityRequests.length > AGENT_CUSTOM_PHASE_CAPABILITIES.length) {
    loomPolicyError(`${path}.capabilityRequests`, 'must contain only closed capability requests')
  }
  const capabilityRequests = object.capabilityRequests.map((capability, index) => {
    if (typeof capability !== 'string' || !CUSTOM_PHASE_CAPABILITY_SET.has(capability)) {
      return loomPolicyError(`${path}.capabilityRequests[${index}]`, 'unsupported capability request')
    }
    return capability as AgentCustomPhaseV1['capabilityRequests'][number]
  })
  if (new Set(capabilityRequests).size !== capabilityRequests.length) {
    loomPolicyError(`${path}.capabilityRequests`, 'duplicate capability request')
  }
  if (typeof object.repeatLimit !== 'number'
    || !Number.isSafeInteger(object.repeatLimit)
    || object.repeatLimit < 0
    || object.repeatLimit > 4) {
    loomPolicyError(`${path}.repeatLimit`, 'must be an integer from 0 through 4')
  }
  if (!isIndexedArray(object.nextPhaseIds) || object.nextPhaseIds.length > 2) {
    loomPolicyError(`${path}.nextPhaseIds`, 'must contain at most self and the immediate next phase')
  }
  const nextPhaseIds = object.nextPhaseIds.map((phaseId, index) => {
    const idValue = loomPolicyString(phaseId, `${path}.nextPhaseIds[${index}]`, 64)
    if (!POLICY_ID_PATTERN.test(idValue)) loomPolicyError(`${path}.nextPhaseIds[${index}]`, 'must use a stable lowercase identifier')
    return idValue
  })
  if (new Set(nextPhaseIds).size !== nextPhaseIds.length) {
    loomPolicyError(`${path}.nextPhaseIds`, 'duplicate next phase id')
  }
  if (nextPhaseIds.includes(id) && object.repeatLimit === 0) {
    loomPolicyError(`${path}.nextPhaseIds`, 'self transition requires repeatLimit greater than zero')
  }
  return {
    version: 1,
    id,
    label,
    instructionRefs,
    required,
    enter,
    exit,
    ...(skip === undefined ? {} : { skip }),
    capabilityRequests,
    repeatLimit: object.repeatLimit,
    nextPhaseIds,
  }
}

export function parseAgentCustomPhasesV1(value: unknown): readonly AgentCustomPhaseV1[] {
  if (!isIndexedArray(value) || value.length > AGENTIC_CUSTOM_PHASE_LIMIT) {
    loomPolicyError('config.runtimePolicy.phases', `must contain at most ${AGENTIC_CUSTOM_PHASE_LIMIT} ordered phases`)
  }
  const phases = value.map((phase, index) => parseAgentCustomPhaseV1(phase, `config.runtimePolicy.phases.${index}`))
  const ids = new Set<string>()
  phases.forEach((phase, index) => {
    if (ids.has(phase.id)) loomPolicyError(`config.runtimePolicy.phases.${index}.id`, 'duplicate custom phase id')
    ids.add(phase.id)
  })
  return Object.freeze(phases)
}

function refsToLoomPolicyBuckets(
  refs: AgentCognitionPolicy,
  blocks: readonly PromptBlock[],
  legacy = false,
): LoomPolicyBucketsV1 {
  const sourceById = new Map(blocks.map((block, index) => [block.id, {
    kind: 'loom_block' as const,
    blockId: block.id,
    presetRevision: 0,
    blockRevision: promptBlockRevision(block, `blocks[${index}].revision`),
    promptOrder: index,
  }]))
  const convert = (bucket: LoomPolicyBucketV1): LoomPolicyEntryV1[] => {
    const refsForBucket = refs[bucket] ?? []
    return sortLoomPolicyEntriesV1(refsForBucket.map((ref, index) => {
      const source = sourceById.get(ref.blockId)
      if (!source) loomPolicyError(`${bucket}[${index}].blockId`, 'source block is unavailable')
      return {
        version: 1,
        id: `${legacy ? 'legacy-' : ''}${bucket}-${ref.blockId}`,
        source: {
          ...source,
          presetRevision: ref.expectedPresetRevision,
          blockRevision: ref.expectedBlockRevision,
        },
        destination: LOOM_POLICY_DESTINATION_BY_BUCKET[bucket],
        checkpoint: LOOM_POLICY_CHECKPOINT_BY_BUCKET[bucket],
        required: true,
        visibility: 'work_only',
        delivery: { delivery: 'direct' },
      }
    }))
  }
  return {
    version: 1,
    workPolicy: convert('workPolicy'),
    workspaceUsage: convert('workspaceUsage'),
    completionCriteria: convert('completionCriteria'),
    renderPolicy: convert('renderPolicy'),
  }
}

export function normalizeLegacyLoomPolicyV1(value: unknown): AgentCognitionPolicy {
  const object = loomPolicyRecord(value, 'config.phasePolicy')
  loomPolicyExactKeys(object, ['work', 'render'], 'config.phasePolicy')
  if (!isIndexedArray(object.work) || !isIndexedArray(object.render)) {
    loomPolicyError('config.phasePolicy', 'work and render must be dense arrays')
  }
  if (!object.work.every(isCognitionPolicyRef) || !object.render.every(isCognitionPolicyRef)) {
    loomPolicyError('config.phasePolicy', 'work and render must contain exact block references')
  }
  return {
    workPolicy: object.work,
    workspaceUsage: [],
    completionCriteria: [],
    renderPolicy: object.render,
  }
}

export const normalizeLegacyPhasePolicyV1 = normalizeLegacyLoomPolicyV1
export function normalizeLoomPolicyBucketsV1(
  value: unknown,
  sourceBlocks: readonly PromptBlock[],
  legacyPhasePolicyValue?: unknown,
): LoomPolicyBucketsV1 {
  const parsed = isUnknownRecord(value) && value.version === 1
    ? parseLoomPolicyBucketsV1(value)
    : refsToLoomPolicyBuckets((isCognitionPolicyShape(value) ? value : defaultCognitionPolicy()) as AgentCognitionPolicy, sourceBlocks)
  const legacy = legacyPhasePolicyValue === undefined || legacyPhasePolicyValue === null
    ? undefined
    : refsToLoomPolicyBuckets(normalizeLegacyLoomPolicyV1(legacyPhasePolicyValue), sourceBlocks, true)
  const merged = Object.fromEntries(LOOM_POLICY_BUCKET_ORDER.map((bucket) => [
    bucket,
    sortLoomPolicyEntriesV1([...(parsed[bucket] ?? []), ...(legacy?.[bucket] ?? [])]),
  ])) as Record<LoomPolicyBucketV1, LoomPolicyEntryV1[]>
  return Object.freeze({
    version: 1,
    workPolicy: Object.freeze(merged.workPolicy),
    workspaceUsage: Object.freeze(merged.workspaceUsage),
    completionCriteria: Object.freeze(merged.completionCriteria),
    renderPolicy: Object.freeze(merged.renderPolicy),
  })
}

export const normalizeLoomPolicyBuckets = normalizeLoomPolicyBucketsV1

function loomSourceKey(source: LoomPolicySourceV1): string {
  return `${source.blockId}\u0000${source.presetRevision}\u0000${source.blockRevision}\u0000${source.promptOrder}`
}

function loomContextKey(request: LoomOnDemandRequestV1): string {
  return `${request.contextPackId}\u0000${request.revisionId}\u0000${request.digest}`
}

function loomValuesEqual(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((item, index) => item === right[index])
    : left === right
}

function evaluateLoomPredicate(predicate: CognitionPredicate, evaluation: NonNullable<LoomPromptInspectionInputV1['evaluation']>): boolean {
  switch (predicate.kind) {
    case 'all':
      return predicate.children.every((child) => evaluateLoomPredicate(child, evaluation))
    case 'any':
      return predicate.children.some((child) => evaluateLoomPredicate(child, evaluation))
    case 'not':
      return !evaluateLoomPredicate(predicate.child, evaluation)
    case 'generation_type':
      return predicate.value === evaluation.generationType
    case 'phase':
      return predicate.value === evaluation.phase
    case 'tool_available':
      return evaluation.availableTools.includes(predicate.toolId) === predicate.available
    case 'task_transition':
      return evaluation.taskTransitions[predicate.taskId] === predicate.transition
    case 'preset_variable':
    case 'participant_fact': {
      const values = predicate.kind === 'preset_variable' ? evaluation.presetVariables : evaluation.participantFacts
      const current = values[predicate.name]
      if (predicate.operator === 'present') return current !== undefined
      if (predicate.operator === 'equals') return loomValuesEqual(current, predicate.value)
      if (predicate.operator === 'in') return predicate.values.some((value) => loomValuesEqual(current, value))
      return Array.isArray(current) && typeof predicate.value === 'string' && current.includes(predicate.value)
    }
  }
}

function loomInspectionItem(
  entry: LoomPolicyEntryV1,
  bucket: LoomPolicyBucketV1,
  outcome: LoomPromptInspectionOutcomeV1,
  effectiveText: string | null,
  retrievalStatus?: LoomOnDemandRetrievalStatusV1,
): LoomPromptInspectionItemV1 {
  return {
    entryId: entry.id,
    bucket,
    destination: entry.destination,
    checkpoint: entry.checkpoint,
    source: entry.source,
    delivery: entry.delivery,
    effectiveText,
    ...(retrievalStatus === undefined ? {} : { retrievalStatus }),
    outcome,
  }
}

export function inspectLoomPromptPoliciesV1(
  policiesValue: unknown,
  input: LoomPromptInspectionInputV1,
): LoomPromptInspectionV1 {
  const policies = parseLoomPolicyBucketsV1(policiesValue)
  const sourceBlocks = new Map<string, LoomPromptInspectionBlockV1>()
  for (const block of input.blocks) sourceBlocks.set(loomSourceKey(block.source), block)
  const contextPacks = new Map<string, LoomPromptInspectionContextPackV1>()
  for (const pack of input.contextPacks) {
    const { content: _content, ...request } = pack
    contextPacks.set(loomContextKey(request), pack)
  }
  const items: LoomPromptInspectionItemV1[] = []
  const effectiveEntryIds: string[] = []
  const kept = new Map<string, string>()
  for (const bucket of LOOM_POLICY_BUCKET_ORDER) {
    for (const entry of policies[bucket]) {
      if (input.surface === 'RESPONSE') {
        items.push(loomInspectionItem(entry, bucket, { status: 'omitted', reason: 'response_mode' }, null))
        continue
      }
      if (LOOM_POLICY_CHECKPOINT_RANK[input.checkpoint] < LOOM_POLICY_CHECKPOINT_RANK[entry.checkpoint]) {
        items.push(loomInspectionItem(entry, bucket, { status: 'skipped', reason: 'checkpoint_not_reached' }, null))
        continue
      }
      const block = sourceBlocks.get(loomSourceKey(entry.source))
      if (!block) {
        items.push(loomInspectionItem(entry, bucket, { status: 'rejected', reason: entry.required ? 'required_source_unavailable' : 'stale_source' }, null))
        continue
      }
      let effectiveText: string | null = block.content
      let retrievalStatus: LoomOnDemandRetrievalStatusV1 | undefined
      if (entry.delivery.delivery === 'condition_gated') {
        if (!input.evaluation) {
          items.push(loomInspectionItem(entry, bucket, entry.required
            ? { status: 'rejected', reason: 'required_source_unavailable' }
            : { status: 'skipped', reason: 'condition_not_met' }, effectiveText))
          continue
        }
        if (!evaluateLoomPredicate(entry.delivery.condition, input.evaluation)) {
          items.push(loomInspectionItem(entry, bucket, { status: 'skipped', reason: 'condition_not_met' }, effectiveText))
          continue
        }
      } else if (entry.delivery.delivery === 'on_demand') {
        const request = entry.delivery.request
        const exact = contextPacks.get(loomContextKey(request))
        if (!exact) {
          retrievalStatus = [...contextPacks.values()].some((pack) =>
            pack.contextPackId === request.contextPackId && pack.revisionId === request.revisionId)
            ? 'stale'
            : 'unavailable'
          items.push(loomInspectionItem(entry, bucket, entry.required
            ? { status: 'rejected', reason: 'required_source_unavailable' }
            : { status: 'skipped', reason: 'on_demand_unavailable' }, null, retrievalStatus))
          continue
        }
        retrievalStatus = 'available'
        effectiveText = exact.content
      }
      const dedupKey = `${entry.destination}\u0000${loomSourceKey(entry.source)}`
      const keptEntryId = kept.get(dedupKey)
      if (keptEntryId) {
        items.push(loomInspectionItem(entry, bucket, {
          status: 'deduplicated',
          keptEntryId,
          destination: entry.destination,
        }, effectiveText, retrievalStatus))
        continue
      }
      kept.set(dedupKey, entry.id)
      effectiveEntryIds.push(entry.id)
      items.push(loomInspectionItem(entry, bucket, {
        status: 'included',
        effectiveIndex: effectiveEntryIds.length - 1,
      }, effectiveText, retrievalStatus))
    }
  }
  const responseOmission: LoomResponsePolicyOmissionV1 | undefined = input.surface === 'RESPONSE'
    ? parseLoomResponsePolicyOmissionV1({
      version: 1,
      surface: 'RESPONSE',
      visibility: 'work_only',
      reason: 'work_only',
      omittedEntryIds: items.map((item) => item.entryId),
      source: items.map((item) => item.source),
      omittedPhaseInstructions: [],
    })
    : undefined
  return Object.freeze({
    version: 1,
    surface: input.surface,
    checkpoint: input.checkpoint,
    items: Object.freeze(items),
    effectiveEntryIds: Object.freeze(effectiveEntryIds),
    ...(responseOmission === undefined ? {} : { responseOmission }),
  })
}

export const inspectLoomPrompt = inspectLoomPromptPoliciesV1

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
  | 'invalid_runtime_policy'
  | 'invalid_policy_entry'
  | 'stale_policy_source'
  | 'missing_policy_context'
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
  return isIndexedArray(value) && value.every((entry) => typeof entry === 'string')
}
function isCognitionScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)
}

function isCognitionScalarList(value: unknown): value is Array<string | number | boolean> {
  return isIndexedArray(value) && value.every((entry) => isCognitionScalar(entry))
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
        && isIndexedArray(value.children)
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
            || isIndexedArray(value.value) && value.value.every((entry) => typeof entry === 'string'))
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
        && ['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'].includes(String(value.transition))
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
const COGNITION_POLICY_REF_KEYS = ['blockId', 'expectedPresetRevision', 'expectedBlockRevision'] as const

function isCognitionPolicyRef(value: unknown): value is AgentPromptBlockRef {
  return isUnknownRecord(value)
    && hasOnlyKeys(value, COGNITION_POLICY_REF_KEYS)
    && typeof value.blockId === 'string'
    && value.blockId.length > 0
    && !/\s/.test(value.blockId)
    && isNonNegativeSafeInteger(value.expectedPresetRevision)
    && isNonNegativeSafeInteger(value.expectedBlockRevision)
}

export function createLoomPolicyEntryV1(
  bucket: LoomPolicyBucketV1,
  block: PromptBlock,
  presetRevision: number,
  promptOrder: number,
  existing?: LoomPolicyEntryV1,
): LoomPolicyEntryV1 {
  const blockRevision = promptBlockRevision(block, `block.${block.id}.revision`)
  return {
    version: 1,
    id: existing?.id ?? `${bucket}-${block.id}`,
    source: {
      kind: 'loom_block',
      blockId: block.id,
      presetRevision,
      blockRevision,
      promptOrder,
    },
    destination: LOOM_POLICY_DESTINATION_BY_BUCKET[bucket],
    checkpoint: LOOM_POLICY_CHECKPOINT_BY_BUCKET[bucket],
    required: existing?.required ?? true,
    visibility: 'work_only',
    delivery: existing?.delivery ?? { delivery: 'direct' },
  }
}

export function getAgentRuntimePolicyBuckets(
  config: AgentConfigV2 | unknown,
  sourceBlocks: readonly PromptBlock[],
): LoomPolicyBucketsV1 {
  const rawConfig = isUnknownRecord(config) ? config : {}
  if (Object.hasOwn(rawConfig, 'runtimePolicy')) {
    const rawRuntimePolicy = rawConfig.runtimePolicy
    if (isUnknownRecord(rawRuntimePolicy)
      && rawRuntimePolicy.loomPolicy !== null
      && rawRuntimePolicy.loomPolicy !== undefined) {
      try {
        return normalizeLoomPolicyBucketsV1(rawRuntimePolicy.loomPolicy, sourceBlocks)
      } catch {
        // Validation retains the malformed canonical value for explicit repair.
      }
    }
    return {
      version: 1,
      workPolicy: [],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
  }
  try {
    return normalizeLoomPolicyBucketsV1(rawConfig.cognitionPolicy, sourceBlocks, rawConfig.phasePolicy)
  } catch {
    return {
      version: 1,
      workPolicy: [],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
  }
}

export function getAgentRuntimeCustomPhases(
  config: AgentConfigV2 | unknown,
): readonly AgentCustomPhaseV1[] {
  const rawConfig = isUnknownRecord(config) ? config : {}
  const rawRuntimePolicy = rawConfig.runtimePolicy
  if (!isUnknownRecord(rawRuntimePolicy) || !Array.isArray(rawRuntimePolicy.phases)) return []
  try {
    return parseAgentCustomPhasesV1(rawRuntimePolicy.phases)
  } catch {
    return []
  }
}

export function setAgentRuntimeCustomPhases(
  config: AgentConfigV2,
  phases: readonly AgentCustomPhaseV1[],
): AgentConfigV2 {
  const rawConfig = config as unknown as Record<string, unknown>
  const rawRuntimePolicy = rawConfig.runtimePolicy
  const loomPolicy = isUnknownRecord(rawRuntimePolicy)
    && (rawRuntimePolicy.loomPolicy === null || isUnknownRecord(rawRuntimePolicy.loomPolicy))
    ? rawRuntimePolicy.loomPolicy as LoomPolicyBucketsV1 | null
    : null
  const {
    cognitionPolicy: _legacyCognitionPolicy,
    phasePolicy: _legacyPhasePolicy,
    ...withoutLegacyPolicy
  } = rawConfig
  const runtimePolicy: AgentRuntimePolicyV1 = {
    version: 1,
    authority: 'loom',
    scope: 'preset',
    defaultMode: config.defaultMode,
    loomPolicy,
    phases,
  }
  return {
    ...withoutLegacyPolicy,
    runtimePolicy,
  } as AgentConfigV2
}

export function setAgentRuntimePolicyBuckets(
  config: AgentConfigV2,
  buckets: LoomPolicyBucketsV1,
): AgentConfigV2 {
  const rawConfig = config as unknown as Record<string, unknown>
  const rawRuntimePolicy = rawConfig.runtimePolicy
  const phases = isUnknownRecord(rawRuntimePolicy) && Array.isArray(rawRuntimePolicy.phases)
    ? rawRuntimePolicy.phases as readonly AgentCustomPhaseV1[]
    : []
  const {
    cognitionPolicy: _legacyCognitionPolicy,
    phasePolicy: _legacyPhasePolicy,
    ...withoutLegacyPolicy
  } = rawConfig
  const runtimePolicy: AgentRuntimePolicyV1 = {
    version: 1,
    authority: 'loom',
    scope: 'preset',
    defaultMode: config.defaultMode,
    loomPolicy: buckets,
    phases,
  }
  return {
    ...withoutLegacyPolicy,
    runtimePolicy,
  } as AgentConfigV2
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
    runtimePolicy: {
      version: 1,
      authority: 'loom',
      scope: 'preset',
      defaultMode: 'response',
      loomPolicy: {
        version: 1,
        workPolicy: [],
        workspaceUsage: [],
        completionCriteria: [],
        renderPolicy: [],
      },
      phases: [],
    },
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
  const raw = config as unknown as Record<string, unknown>
  const next = {
    ...raw,
    profiles: isIndexedArray(raw.profiles)
      ? raw.profiles.map((profile) => isUnknownRecord(profile)
        ? {
            ...profile,
            workspaceCapabilities: isIndexedArray(profile.workspaceCapabilities)
              ? [...profile.workspaceCapabilities]
              : profile.workspaceCapabilities,
          }
        : profile)
      : raw.profiles,
  } as AgentConfigV2
  if (!Object.hasOwn(raw, 'contextPolicy')) next.contextPolicy = { ruleIds: [], packIds: [] }
  if (!Object.hasOwn(raw, 'taskPolicy')) next.taskPolicy = { templateIds: [] }
  if (!Object.hasOwn(raw, 'workspacePolicy')) {
    next.workspacePolicy = { retention: 'turn_terminal', sharing: 'view_only' }
  }
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
      if (!isIndexedArray(current.children) || current.children.length === 0) {
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
        && (hasScalar || isIndexedArray(current.value) && current.value.every((entry) => typeof entry === 'string'))
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
        || !['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'].includes(String(current.transition))
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

function validateRuntimePolicy(
  config: AgentConfigV2,
  blocks: readonly PromptBlock[],
  expectedPresetRevision: number,
  contextSelections: readonly unknown[],
  availableContextRevisionKeys: ReadonlySet<string> | undefined,
  predicateBudget: PredicateValidationBudget,
  issues: AgenticRuntimeValidationIssue[],
  taskTemplateIds?: ReadonlySet<string>,
): void {
  const rawConfig = config as unknown as Record<string, unknown>
  const value = rawConfig.runtimePolicy
  if (value === undefined || value === null) return
  if (!isUnknownRecord(value)
    || !hasOnlyKeys(value, ['version', 'authority', 'scope', 'defaultMode', 'loomPolicy', 'phases'])
    || value.version !== 1
    || value.authority !== 'loom'
    || value.scope !== 'preset'
    || value.defaultMode !== config.defaultMode
    || (value.loomPolicy !== null && !isUnknownRecord(value.loomPolicy))
    || !isIndexedArray(value.phases)) {
    issues.push({ code: 'invalid_runtime_policy', path: 'config.runtimePolicy' })
    return
  }
  let phases: readonly AgentCustomPhaseV1[]
  try {
    phases = parseAgentCustomPhasesV1(value.phases)
  } catch {
    const invalidSelfLoopIndexes = value.phases.flatMap((phase, index) => {
      if (!isUnknownRecord(phase)
        || typeof phase.id !== 'string'
        || phase.repeatLimit !== 0
        || !Array.isArray(phase.nextPhaseIds)
        || !phase.nextPhaseIds.some((phaseId) => phaseId === phase.id)) {
        return []
      }
      return [index]
    })
    if (invalidSelfLoopIndexes.length > 0) {
      invalidSelfLoopIndexes.forEach((index) => {
        issues.push({
          code: 'invalid_policy_entry',
          path: `config.runtimePolicy.phases.${index}.repeatLimit`,
        })
      })
    } else {
      issues.push({ code: 'invalid_runtime_policy', path: 'config.runtimePolicy.phases' })
    }
    return
  }
  let policies: LoomPolicyBucketsV1 | null = null
  if (value.loomPolicy !== null) {
    try {
      policies = parseLoomPolicyBucketsV1(value.loomPolicy)
    } catch {
      issues.push({ code: 'invalid_runtime_policy', path: 'config.runtimePolicy.loomPolicy' })
      return
    }
  }
  const blocksById = new Map<string, { block: PromptBlock; promptOrder: number }>()
  blocks.forEach((block, promptOrder) => {
    if (typeof block.id === 'string') blocksById.set(block.id, { block, promptOrder })
  })
  const selections = contextSelections.filter(isAgentContextPackSelection)
  phases.forEach((phase, index) => {
    const path = `config.runtimePolicy.phases.${index}`
    const nextPhaseId = phases[index + 1]?.id
    phase.instructionRefs.forEach((source, refIndex) => {
      const current = blocksById.get(source.blockId)
      const sourcePath = `${path}.instructionRefs.${refIndex}`
      if (!current || current.block.marker === 'category') {
        issues.push({ code: 'invalid_policy_entry', path: sourcePath })
        return
      }
      if (current.block.revision !== undefined && !isCanonicalBlockRevision(current.block.revision)) {
        issues.push({ code: 'invalid_policy_entry', path: sourcePath })
        return
      }
      const blockRevision = current.block.revision ?? 1
      if (source.presetRevision !== expectedPresetRevision
        || source.blockRevision !== blockRevision
        || source.promptOrder !== current.promptOrder) {
        issues.push({ code: 'stale_policy_source', path: sourcePath })
      }
    })
    validatePredicate(phase.enter, `${path}.enter`, issues, predicateBudget, taskTemplateIds)
    validatePredicate(phase.exit, `${path}.exit`, issues, predicateBudget, taskTemplateIds)
    if (phase.skip !== undefined) {
      validatePredicate(phase.skip, `${path}.skip`, issues, predicateBudget, taskTemplateIds)
    }
    if (phase.nextPhaseIds.includes(phase.id) && phase.repeatLimit === 0) {
      issues.push({ code: 'invalid_policy_entry', path: `${path}.repeatLimit` })
    }
    phase.nextPhaseIds.forEach((candidate, nextIndex) => {
      if (candidate !== phase.id && candidate !== nextPhaseId) {
        issues.push({ code: 'invalid_policy_entry', path: `${path}.nextPhaseIds.${nextIndex}` })
      }
    })
  })
  if (policies === null) return
  for (const bucket of LOOM_POLICY_BUCKET_ORDER) {
    policies[bucket].forEach((entry, index) => {
      const path = `config.runtimePolicy.loomPolicy.${bucket}.${index}`
      const source = blocksById.get(entry.source.blockId)
      if (!source || source.block.marker === 'category') {
        issues.push({ code: 'invalid_policy_entry', path })
        return
      }
      if (source.block.revision !== undefined && !isCanonicalBlockRevision(source.block.revision)) {
        issues.push({ code: 'invalid_policy_entry', path })
        return
      }
      const currentBlockRevision = source.block.revision ?? 1
      if (entry.source.presetRevision !== expectedPresetRevision
        || entry.source.blockRevision !== currentBlockRevision
        || entry.source.promptOrder !== source.promptOrder) {
        issues.push({ code: 'stale_policy_source', path: `${path}.source` })
      }
      if (entry.delivery.delivery === 'condition_gated') {
        validatePredicate(entry.delivery.condition, `${path}.delivery.condition`, issues, predicateBudget, taskTemplateIds)
      } else if (entry.delivery.delivery === 'on_demand') {
        const request = entry.delivery.request
        const selection = selections.find((candidate) => (
          candidate.packId === request.contextPackId
          && candidate.revisionId === request.revisionId
          && candidate.digest === request.digest
        ))
        const key = `${request.contextPackId}\u0000${request.revisionId}`
        if (!selection || availableContextRevisionKeys !== undefined && !availableContextRevisionKeys.has(key)) {
          issues.push({ code: 'missing_policy_context', path: `${path}.delivery.request` })
        }
      }
    })
  }
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
      const rawRevision = (block as unknown as Record<string, unknown>).revision
      const blockRevision = isCanonicalBlockRevision(rawRevision) ? rawRevision : rawRevision === undefined ? 1 : null
      if (!isNonNegativeSafeInteger(expectedPresetRevision)
        || !isNonNegativeSafeInteger(ref.expectedPresetRevision)
        || !isNonNegativeSafeInteger(ref.expectedBlockRevision)
        || blockRevision === null) {
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

export const INHERITED_IMPORT_REVIEW_ACKNOWLEDGEMENTS: Record<string, true> = {
  'review:foreign_import': true,
  'review:cognition_foreign_authority_blocked': true,
}

export function requiredReviewAcknowledgements(
  liveRequiredReviewIds: readonly string[],
  acknowledgements: readonly string[],
): string[] {
  const liveIncludesImportReview = liveRequiredReviewIds.some((id) => INHERITED_IMPORT_REVIEW_ACKNOWLEDGEMENTS[id] === true)
  if (liveIncludesImportReview) return [...liveRequiredReviewIds]
  const leftover = acknowledgements.filter((id) => INHERITED_IMPORT_REVIEW_ACKNOWLEDGEMENTS[id] === true)
  if (leftover.length === 0) return [...liveRequiredReviewIds]
  return [...new Set([...liveRequiredReviewIds, ...leftover])]
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
  validateRuntimePolicy(
    config,
    promptBlocks as PromptBlock[],
    expectedPresetRevision,
    contextPackSelections,
    availableContextRevisionKeys,
    predicateBudget,
    issues,
    taskTemplateIds,
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
  // Live required ids are fail-closed. Leftover inherited import acknowledgements
  // remain required when they are still the only record of that review.
  const effectiveRequiredReviewIds = requiredReviewAcknowledgements(requiredReviewItemIds, acknowledgements)
  if (effectiveRequiredReviewIds.some((id) => !acknowledgements.includes(id))) {
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
  const importItem = typeof reviewValue.reasonCode === 'string'
    && (reviewValue.reasonCode === 'foreign_import' || reviewValue.reasonCode === 'cognition_foreign_authority_blocked')
    ? invalidReviewItem(reviewValue.reasonCode)
    : null
  const withInheritedImportReview = (items: AgentConfigRepairItem[]): AgentConfigRepairItem[] => {
    if (!importItem || items.some((item) => item.id === importItem.id)) return items
    return [...items, importItem]
  }
  if (projected.length > 0) return withInheritedImportReview(projected)

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
  if (items.length > 0) return withInheritedImportReview(items)

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
