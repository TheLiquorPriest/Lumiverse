import { describe, expect, test } from 'bun:test'
import type {
  AgenticRuntimeSaveDraft,
  LoomPassthroughMetadata,
  LoomPreset,
  PromptBlock,
} from './types'
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_CUSTOM_BODY,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_SAMPLER_OVERRIDES,
} from './constants'
import {
  AGENTIC_CONTEXT_RULE_LIMIT,
  AGENTIC_PREDICATE_MAX_DEPTH,
  AGENTIC_PREDICATE_MAX_NODES,
  AGENTIC_TASK_TEMPLATE_LIMIT,
  AGENT_MAX_OUTPUT_TOKENS_MAX,
  AGENT_SYSTEM_PROMPT_MAX_BYTES,
  AGENT_TIMEOUT_MS_MIN,
  createAgenticRuntimeDraft,
  createDefaultAgentConfigV2,
  createLoomPolicyEntryV1,
  getAgenticRuntimeRepairItems,
  getAgentRuntimePolicyBuckets,
  normalizeAgentConfigForEditor,
  normalizeLoomPolicyBucketsV1,
  parseAgentCustomPhasesV1,
  parseLoomPolicyBucketsV1,
  requiredReviewAcknowledgements,
  setAgentRuntimeCustomPhases,
  setAgentRuntimePolicyBuckets,
  validateAgenticRuntimeDraft,
} from './agenticRuntime'

const block = (revision = 3): PromptBlock => ({
  id: 'policy-block',
  name: 'Work policy',
  content: 'Use the workspace before completing.',
  role: 'system',
  enabled: true,
  position: 'pre_history',
  depth: 0,
  marker: null,
  isLocked: false,
  color: null,
  injectionTrigger: [],
  revision,
})

const draft = (): AgenticRuntimeSaveDraft => ({
  config: createDefaultAgentConfigV2(),
  slotBindings: {},
  contextPackSelections: [],
  contextRules: [],
  taskTemplates: [],
  reviewAcknowledgements: [],
})

const presetWithMetadata = (metadata: LoomPassthroughMetadata): LoomPreset => ({
  id: 'preset-1',
  name: 'Preset',
  description: '',
  coverUrl: null,
  presetVersion: null,
  lumihubMeta: null,
  passthroughMetadata: metadata,
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  cacheRevision: 8,
  agentConfig: null,
  agentConfigRevision: 0,
  agentConfigReview: null,
  agentSlotBindings: {},
  agentContextPackSelections: [],
  agentContextRules: [],
  agentTaskTemplates: [],
  blocks: [block()],
  source: null,
  isDefault: false,
  samplerOverrides: { ...DEFAULT_SAMPLER_OVERRIDES },
  customBody: { ...DEFAULT_CUSTOM_BODY },
  promptBehavior: { ...DEFAULT_PROMPT_BEHAVIOR },
  completionSettings: { ...DEFAULT_COMPLETION_SETTINGS },
  advancedSettings: { ...DEFAULT_ADVANCED_SETTINGS },
  modelProfiles: {},
  lastProfileKey: null,
  promptVariables: {},
})

describe('Agentic Runtime shared draft validation', () => {
  test('does not execute legacy metadata as runtime authority', () => {
    const preset = presetWithMetadata({
      agentConfig: {
        version: 1,
        enabled: true,
        maxInvocations: 6,
        maxToolCalls: 7,
        mainToolIds: ['chat_search_history'],
        mainLoreScope: 'active',
        profiles: [{
          id: 'researcher',
          name: 'Researcher',
          systemPrompt: 'Research.',
          connectionProfileId: 'local-connection',
          toolIds: ['lore_get_entry'],
          loreScope: 'active',
          allowMainDelegation: true,
          failurePolicy: 'required',
          streamActivity: true,
          maxOutputTokens: 256,
          timeoutMs: 30_000,
        }],
      },
    })

    const migrated = createAgenticRuntimeDraft(preset)
    expect(migrated.config.version).toBe(2)
    expect(migrated.config.agentsEnabled).toBe(false)
    expect(migrated.config.allowedModes).toEqual(['response'])
    expect(migrated.config.profiles).toEqual([])
    expect(migrated.config.connectionSlots).toEqual([])
  })

  test('rejects stale block references instead of silently changing phased instructions', () => {
    const candidate = draft()
    const staleEntry = createLoomPolicyEntryV1('workPolicy', block(3), 8, 0)
    candidate.config.runtimePolicy!.loomPolicy = {
      version: 1,
      workPolicy: [{
        ...staleEntry,
        source: { ...staleEntry.source, blockRevision: 2 },
      }],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }

    const result = validateAgenticRuntimeDraft(candidate, [block(3)], 8)
    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual({
      code: 'stale_policy_source',
      path: 'config.runtimePolicy.loomPolicy.workPolicy.0.source',
    })
  })

  test('rejects missing context snapshots and cyclic task dependencies as one draft', () => {
    const candidate = draft()
    candidate.contextRules = [{
      id: 'required-rules',
      packId: 'rules',
      revisionId: 'rules@4',
      required: true,
      activation: { kind: 'phase', value: 'WORK' },
    }]
    candidate.taskTemplates = [
      { id: 'first', required: true, dependencies: ['second'], activation: { kind: 'phase', value: 'WORK' } },
      { id: 'second', required: true, dependencies: ['first'], activation: { kind: 'phase', value: 'WORK' } },
    ]

    const result = validateAgenticRuntimeDraft(candidate, [], 0)
    expect(result.issues.some((issue) => issue.code === 'missing_context_pack_revision')).toBe(true)
    expect(result.issues.some((issue) => issue.code === 'cyclic_task_dependency')).toBe(true)
  })

  test('requires every imported review item before saving or activation', () => {
    const candidate = draft()
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['slot:a', 'pack:b']).issues)
      .toContainEqual({ code: 'review_acknowledgement_required', path: 'reviewAcknowledgements' })
    candidate.config.agentsEnabled = true
    candidate.config.allowedModes = ['response', 'agentic']
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['slot:a', 'pack:b']).issues)
      .toContainEqual({ code: 'review_acknowledgement_required', path: 'reviewAcknowledgements' })

    candidate.reviewAcknowledgements = ['slot:a', 'pack:b']
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['slot:a', 'pack:b']).valid).toBe(true)

    candidate.reviewAcknowledgements = ['slot:a', 'pack:b', 'review:cognition_foreign_authority_blocked']
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['slot:a', 'pack:b']).valid).toBe(true)
    expect(validateAgenticRuntimeDraft(candidate, [], 0, []).valid).toBe(true)
    expect(requiredReviewAcknowledgements(['slot:a', 'pack:b'], candidate.reviewAcknowledgements))
      .toEqual(['slot:a', 'pack:b', 'review:cognition_foreign_authority_blocked'])
    expect(requiredReviewAcknowledgements(['slot:a', 'pack:b', 'review:foreign_import'], ['review:cognition_foreign_authority_blocked']))
      .toEqual(['slot:a', 'pack:b', 'review:foreign_import'])
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['review:cognition_foreign_authority_blocked']).valid).toBe(true)
    candidate.reviewAcknowledgements = []
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['review:cognition_foreign_authority_blocked']).valid).toBe(false)

    const imported = presetWithMetadata({})
    imported.agentConfigReview = {
      state: 'review_required',
      revision: 1,
      reasonCode: 'foreign_import',
      unresolvedSlotIds: ['writer'],
      staleSlotIds: [],
      items: [{
        id: 'slot:writer',
        kind: 'unresolved_slot',
        reasonCode: 'unresolved_slot',
        action: { kind: 'map_slot' },
        acknowledged: false,
      }],
    }
    expect(getAgenticRuntimeRepairItems(imported).map((item) => item.id)).toEqual([
      'slot:writer',
      'review:foreign_import',
    ])

  })

  test('accepts one internally consistent draft containing phase, context, and task policy', () => {
    const candidate = draft()
    candidate.contextPackSelections = [{
      packId: 'world-rules',
      revisionId: 'world-rules@7',
      revision: 7,
      label: 'World rules',
      revisionLabel: '7',
      digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }]
    candidate.contextRules = [{
      id: 'activate_rules',
      packId: 'world-rules',
      revisionId: 'world-rules@7',
      required: true,
      activation: { kind: 'phase', value: 'WORK' },
    }]
    candidate.taskTemplates = [{
      id: 'verify_rules',
      label: 'Verify rules',
      required: true,
      dependencies: [],
      activation: { kind: 'all', children: [
        { kind: 'phase', value: 'WORK' },
        { kind: 'generation_type', value: 'normal' },
      ] },
    }]
    candidate.config.runtimePolicy!.loomPolicy = {
      version: 1,
      workPolicy: [createLoomPolicyEntryV1('workPolicy', block(3), 8, 0)],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
    candidate.config.contextPolicy = { ruleIds: ['activate_rules'], packIds: ['world-rules'] }
    candidate.config.taskPolicy = { templateIds: ['verify_rules'] }

    expect(validateAgenticRuntimeDraft(candidate, [block(3)], 8)).toEqual({ valid: true, issues: [] })
  })
  test('accepts every closed leaf predicate variant without false invalidation', () => {
    const candidate = draft()
    candidate.taskTemplates = [{
      id: 'verify_rules',
      required: true,
      activation: { kind: 'all', children: [
        { kind: 'preset_variable', name: 'mode', operator: 'present' },
        { kind: 'participant_fact', name: 'role', operator: 'equals', value: 'root' },
        { kind: 'tool_available', toolId: 'lore_list_books', available: true },
        { kind: 'task_transition', taskId: 'verify_rules', transition: 'active' },
      ] },
    }]
    candidate.config.taskPolicy = { templateIds: ['verify_rules'] }
    expect(validateAgenticRuntimeDraft(candidate, [], 0).valid).toBe(true)
  })

  test('rejects non-finite predicate numbers before they enter an editor draft', () => {
    const candidate = draft()
    candidate.taskTemplates = [{
      id: 'finite_number',
      required: true,
      activation: { kind: 'preset_variable', name: 'score', operator: 'equals', value: Number.NaN },
    }]
    candidate.config.taskPolicy = { templateIds: ['finite_number'] }
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_task_template', path: 'taskTemplates.0' })
  })

  test('matches backend cognition ceilings at the exact predicate, task, and rule boundaries', () => {
    expect({
      depth: AGENTIC_PREDICATE_MAX_DEPTH,
      nodes: AGENTIC_PREDICATE_MAX_NODES,
      tasks: AGENTIC_TASK_TEMPLATE_LIMIT,
      rules: AGENTIC_CONTEXT_RULE_LIMIT,
    }).toEqual({ depth: 16, nodes: 256, tasks: 256, rules: 256 })

    const nodeBoundary = draft()
    nodeBoundary.taskTemplates = [{
      id: 'node_boundary',
      required: true,
      activation: {
        kind: 'all',
        children: Array.from({ length: AGENTIC_PREDICATE_MAX_NODES - 1 }, () => ({ kind: 'phase' as const, value: 'WORK' as const })),
      },
    }]
    nodeBoundary.config.taskPolicy = { templateIds: ['node_boundary'] }
    expect(validateAgenticRuntimeDraft(nodeBoundary, [], 0).valid).toBe(true)
    const boundaryActivation = nodeBoundary.taskTemplates[0]!.activation
    if (boundaryActivation?.kind !== 'all') throw new Error('Expected all predicate')
    boundaryActivation.children.push({ kind: 'phase', value: 'WORK' })
    expect(validateAgenticRuntimeDraft(nodeBoundary, [], 0).issues.some((issue) => issue.code === 'predicate_limit_exceeded')).toBe(true)

    const taskBoundary = draft()
    taskBoundary.taskTemplates = Array.from({ length: AGENTIC_TASK_TEMPLATE_LIMIT }, (_value, index) => ({
      id: `task_${index}`,
      required: false,
    }))
    taskBoundary.config.taskPolicy = { templateIds: taskBoundary.taskTemplates.map((template) => template.id) }
    expect(validateAgenticRuntimeDraft(taskBoundary, [], 0).valid).toBe(true)
    taskBoundary.taskTemplates.push({ id: 'task_overflow', required: false })
    taskBoundary.config.taskPolicy.templateIds.push('task_overflow')
    expect(validateAgenticRuntimeDraft(taskBoundary, [], 0).issues)
      .toContainEqual({ code: 'invalid_task_template', path: 'taskTemplates' })

    const ruleBoundary = draft()
    ruleBoundary.contextPackSelections = Array.from({ length: AGENTIC_CONTEXT_RULE_LIMIT }, (_value, index) => ({
      packId: `pack_${index}`,
      revisionId: `pack_${index}@1`,
      revision: 1,
      label: `Pack ${index}`,
      revisionLabel: '1',
      digest: 'a'.repeat(64),
    }))
    ruleBoundary.contextRules = ruleBoundary.contextPackSelections.map((selection, index) => ({
      id: `rule_${index}`,
      packId: selection.packId,
      revisionId: selection.revisionId,
      required: false,
    }))
    ruleBoundary.config.contextPolicy = {
      ruleIds: ruleBoundary.contextRules.map((rule) => rule.id),
      packIds: [],
    }
    expect(validateAgenticRuntimeDraft(ruleBoundary, [], 0).valid).toBe(true)
    ruleBoundary.contextPackSelections.push({
      packId: 'pack_overflow',
      revisionId: 'pack_overflow@1',
      revision: 1,
      label: 'Overflow',
      revisionLabel: '1',
      digest: 'b'.repeat(64),
    })
    ruleBoundary.contextRules.push({
      id: 'rule_overflow',
      packId: 'pack_overflow',
      revisionId: 'pack_overflow@1',
      required: false,
    })
    ruleBoundary.config.contextPolicy.ruleIds.push('rule_overflow')
    expect(validateAgenticRuntimeDraft(ruleBoundary, [], 0).issues)
      .toContainEqual({ code: 'invalid_context_rule', path: 'contextRules' })
  })

  test('quarantines malformed context digest and duplicate pack revisions', () => {
    const candidate = draft()
    candidate.contextPackSelections = [{
      packId: 'rules',
      revisionId: 'rules@4',
      revision: 4,
      label: 'Rules',
      revisionLabel: '4',
      digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }, {
      packId: 'rules',
      revisionId: 'rules@5',
      revision: 5,
      label: 'Rules',
      revisionLabel: '5',
      digest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }, {
      packId: 'other',
      revisionId: 'other@1',
      revision: 1,
      label: 'Other',
      revisionLabel: '1',
      digest: 'not-a-digest',
    }]
    const result = validateAgenticRuntimeDraft(candidate, [], 0)
    expect(result.issues).toContainEqual({ code: 'invalid_context_selection', path: 'contextPackSelections.1' })
    expect(result.issues).toContainEqual({ code: 'invalid_context_selection', path: 'contextPackSelections.2' })
  })
  test('quarantines a selected pack that is neither direct nor rule referenced', () => {
    const candidate = draft()
    candidate.contextPackSelections = [{
      packId: 'orphan',
      revisionId: 'orphan@1',
      revision: 1,
      label: 'Orphan',
      revisionLabel: 'Revision 1',
      digest: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    }]
    const result = validateAgenticRuntimeDraft(candidate, [], 0)
    expect(result.issues).toContainEqual({
      code: 'context_policy_reference',
      path: 'contextPackSelections.orphan',
    })
  })

  test('enforces profile ceilings in the shared validator', () => {
    const candidate = draft()
    candidate.config.profiles = [{
      id: 'researcher',
      name: 'Researcher',
      systemPrompt: 'x'.repeat(AGENT_SYSTEM_PROMPT_MAX_BYTES + 1),
      connectionRef: { kind: 'inherit_main' },
      toolIds: [],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: true,
      maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS_MAX + 1,
      timeoutMs: AGENT_TIMEOUT_MS_MIN + 1,
    }]
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_profile', path: 'config.profiles.0' })
  })

  test('accepts declared portable slots and rejects malformed or missing references', () => {
    const candidate = draft()
    candidate.config.connectionSlots = [{
      id: 'writer',
      label: 'Writer connection',
      requiredCapabilities: ['generation', 'streaming'],
    }]
    candidate.config.profiles = [{
      id: 'writer_agent',
      name: 'Writer',
      systemPrompt: '',
      connectionRef: { kind: 'slot', slotId: 'writer' },
      toolIds: [],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: false,
      maxOutputTokens: 256,
      timeoutMs: 30_000,
    }]
    candidate.slotBindings = { writer: 'connection-1' }
    expect(validateAgenticRuntimeDraft(candidate, [], 0)).toEqual({ valid: true, issues: [] })

    candidate.config.connectionSlots = [
      { id: 'writer', label: 'Writer', requiredCapabilities: [] },
      { id: 'writer', label: 'Duplicate', requiredCapabilities: [] },
    ]
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_slot', path: 'config.connectionSlots.1.id' })

    candidate.config.connectionSlots = [{ id: 'writer', label: '', requiredCapabilities: ['unknown'] as never[] }]
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_slot', path: 'config.connectionSlots.0' })

    candidate.config.connectionSlots = []
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_slot', path: 'config.profiles.0.connectionRef' })
  })

  test('rejects unknown closed-set tool, scope, and capability IDs', () => {
    const candidate = draft()
    candidate.config.mainToolIds = ['not_a_core_tool' as never]
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_config', path: 'config.mainToolIds' })

    candidate.config.mainToolIds = []
    candidate.config.profiles = [{
      id: 'researcher',
      name: 'Researcher',
      systemPrompt: '',
      connectionRef: { kind: 'inherit_main' },
      toolIds: ['not_a_core_tool' as never],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: false,
      maxOutputTokens: 256,
      timeoutMs: 30_000,
    }]
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_profile', path: 'config.profiles.0' })

    candidate.config.profiles[0]!.toolIds = []
    candidate.config.profiles[0]!.loreScope = 'unknown' as never
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_profile', path: 'config.profiles.0' })
  })

  test('requires task policy IDs to be the closed set of declared templates', () => {
    const candidate = draft()
    candidate.taskTemplates = [{ id: 'task_1', required: false }]
    candidate.config.taskPolicy = { templateIds: ['missing'] }
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_task_policy', path: 'config.taskPolicy.templateIds.0' })

    candidate.config.taskPolicy = { templateIds: ['task_1', 'task_1'] }
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_task_policy', path: 'config.taskPolicy.templateIds.1' })
    candidate.config.taskPolicy = { templateIds: [] }
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_task_policy', path: 'taskTemplates.task_1' })
  })

  test('accepts a dormant backend config that omits optional policies', () => {
    const sparse = {
      version: 2 as const,
      agentsEnabled: false,
      allowedModes: ['response' as const],
      defaultMode: 'response' as const,
      maxInvocations: 64,
      maxToolCalls: 64,
      mainToolIds: [],
      mainLoreScope: 'active' as const,
      profiles: [],
      connectionSlots: [],
    }
    const candidate = draft()
    candidate.config = sparse
    expect(validateAgenticRuntimeDraft(candidate, [], 0)).toEqual({ valid: true, issues: [] })

    const hydrated = createAgenticRuntimeDraft({
      ...presetWithMetadata({}),
      agentConfig: sparse,
      blocks: [],
    })
    expect(hydrated.config.cognitionPolicy).toBeUndefined()
    expect(validateAgenticRuntimeDraft(hydrated, [], 0)).toEqual({ valid: true, issues: [] })
    expect(normalizeAgentConfigForEditor(sparse).taskPolicy).toEqual({ templateIds: [] })
  })
})
describe('Canonical Loom policy and custom phase contracts', () => {
  const buckets = ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'] as const
  const destinations = {
    workPolicy: 'root_work',
    workspaceUsage: 'root_work',
    completionCriteria: 'completion_handoff',
    renderPolicy: 'render',
  } as const
  const checkpoints = {
    workPolicy: 'WORK',
    workspaceUsage: 'WORK',
    completionCriteria: 'PREPARE_COMMIT',
    renderPolicy: 'RENDER',
  } as const

  const source = (blockId = 'policy-block', promptOrder = 0) => ({
    kind: 'loom_block' as const,
    blockId,
    presetRevision: 8,
    blockRevision: 3,
    promptOrder,
  })

  const policyEntry = (
    bucket: (typeof buckets)[number],
    delivery: Record<string, unknown> = { delivery: 'direct' },
  ) => ({
    version: 1,
    id: `${bucket}-entry`,
    source: source(),
    destination: destinations[bucket],
    checkpoint: checkpoints[bucket],
    required: true,
    visibility: 'work_only' as const,
    delivery,
  })

  const policyDocument = () => ({
    version: 1,
    workPolicy: [policyEntry('workPolicy', { delivery: 'direct' })],
    workspaceUsage: [policyEntry('workspaceUsage', {
      delivery: 'condition_gated',
      condition: { kind: 'phase', value: 'WORK' },
    })],
    completionCriteria: [policyEntry('completionCriteria', {
      delivery: 'on_demand',
      request: {
        contextPackId: 'workspace-rules',
        revisionId: 'workspace-rules@3',
        digest: 'A'.repeat(64),
      },
    })],
    renderPolicy: [policyEntry('renderPolicy', { delivery: 'direct' })],
  })

  const phase = (
    id: string,
    repeatLimit: number,
    nextPhaseIds: string[],
    includeSkip = true,
  ) => {
    const value: Record<string, unknown> = {
      version: 1,
      id,
      label: id,
      instructionRefs: [source()],
      required: true,
      enter: { kind: 'phase', value: 'WORK' },
      exit: { kind: 'phase', value: 'COMPLETE' },
      capabilityRequests: ['workspace_read', 'delegation'],
      repeatLimit,
      nextPhaseIds,
    }
    if (includeSkip) value.skip = { kind: 'phase', value: 'ASSEMBLE' }
    return value
  }

  test('parses the four fixed buckets and all closed delivery forms', () => {
    const parsed = parseLoomPolicyBucketsV1(policyDocument())

    expect(Object.keys(parsed)).toEqual([
      'version',
      'workPolicy',
      'workspaceUsage',
      'completionCriteria',
      'renderPolicy',
    ])
    expect(parsed.workPolicy[0]!.delivery).toEqual({ delivery: 'direct' })
    expect(parsed.workspaceUsage[0]!.delivery).toEqual({
      delivery: 'condition_gated',
      condition: { kind: 'phase', value: 'WORK' },
    })
    expect(parsed.completionCriteria[0]!.delivery).toEqual({
      delivery: 'on_demand',
      request: {
        contextPackId: 'workspace-rules',
        revisionId: 'workspace-rules@3',
        digest: 'a'.repeat(64),
      },
    })
    expect(parsed.renderPolicy[0]!.delivery).toEqual({ delivery: 'direct' })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.workPolicy)).toBe(true)
  })

  test('constructor output obeys fixed routing and canonical source provenance', () => {
    for (const bucket of buckets) {
      const entry = createLoomPolicyEntryV1(bucket, block(3), 8, 0)
      const parsed = parseLoomPolicyBucketsV1({
        version: 1,
        workPolicy: bucket === 'workPolicy' ? [entry] : [],
        workspaceUsage: bucket === 'workspaceUsage' ? [entry] : [],
        completionCriteria: bucket === 'completionCriteria' ? [entry] : [],
        renderPolicy: bucket === 'renderPolicy' ? [entry] : [],
      })

      expect(parsed[bucket]).toEqual([entry])
      expect(entry.source).toEqual(source())
      expect(entry.destination).toBe(destinations[bucket])
      expect(entry.checkpoint).toBe(checkpoints[bucket])
      expect(entry.visibility).toBe('work_only')
      expect(entry.delivery).toEqual({ delivery: 'direct' })
    }
  })

  test('rejects aliases, fifth buckets, and malformed exact references', () => {
    const valid = policyDocument()
    const malformedReference = {
      ...valid,
      workPolicy: [{
        ...valid.workPolicy[0],
        source: { ...valid.workPolicy[0]!.source, phasePolicy: [] },
      }],
    }

    expect(() => parseLoomPolicyBucketsV1(malformedReference)).toThrow(/unknown key/)
    expect(() => parseLoomPolicyBucketsV1({ ...valid, work: [] })).toThrow(/unknown key/)
    expect(() => parseLoomPolicyBucketsV1({ ...valid, fifthBucket: [] })).toThrow(/unknown key/)
    expect(() => parseLoomPolicyBucketsV1({
      ...valid,
      renderPolicy: [{ ...valid.renderPolicy[0], delivery: { delivery: 'conditional' } }],
    })).toThrow(/unsupported delivery/)
  })

  test('rejects sparse policy, phase, predicate, and malformed revision inputs', () => {
    const sparsePolicy = policyDocument() as Record<string, unknown>
    sparsePolicy.workPolicy = new Array(1)
    expect(() => parseLoomPolicyBucketsV1(sparsePolicy)).toThrow(/dense array/)

    const sparsePhases = new Array(1)
    expect(() => parseAgentCustomPhasesV1(sparsePhases)).toThrow(/ordered phases/)

    const sparsePredicate = policyDocument()
    sparsePredicate.workspaceUsage = [policyEntry('workspaceUsage', {
      delivery: 'condition_gated',
      condition: { kind: 'all', children: new Array(1) },
    })]
    expect(() => parseLoomPolicyBucketsV1(sparsePredicate)).toThrow(/invalid predicate/)

    expect(() => createLoomPolicyEntryV1(
      'workPolicy',
      { ...block(3), revision: 0 },
      8,
      0,
    )).toThrow(/positive safe integer/)
    expect(() => parseLoomPolicyBucketsV1({
      ...policyDocument(),
      workPolicy: [{
        ...policyDocument().workPolicy[0],
        source: { ...source(), blockRevision: 0 },
      }],
    })).toThrow(/positive safe integer/)
  })

  test('parses canonical custom phases with optional skip and repeat boundaries', () => {
    const parsed = parseAgentCustomPhasesV1([
      phase('phase_one', 0, []),
      phase('phase_two', 4, [], false),
    ])

    expect(parsed.map((entry) => entry.id)).toEqual(['phase_one', 'phase_two'])
    expect(parsed.map((entry) => entry.repeatLimit)).toEqual([0, 4])
    expect(parsed[0]!.instructionRefs).toEqual([source()])
    expect(parsed[0]!.skip).toEqual({ kind: 'phase', value: 'ASSEMBLE' })
    expect(parsed[1]).not.toHaveProperty('skip')
    expect(Object.keys(parsed[0]!)).toEqual([
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
    ])
  })

  test('rejects duplicate IDs, duplicate or non-exact refs, closed-set capability violations, and bad repeats', () => {
    const canonical = phase('phase_one', 1, ['phase_one'])
    expect(() => parseAgentCustomPhasesV1([
      phase('phase_zero_repeat', 0, ['phase_zero_repeat']),
    ])).toThrow(/config\.runtimePolicy\.phases\.0\.nextPhaseIds: self transition requires repeatLimit greater than zero/)
    expect(() => parseAgentCustomPhasesV1([
      canonical,
      phase('phase_one', 4, ['phase_one']),
    ])).toThrow(/duplicate custom phase id/)

    expect(() => parseAgentCustomPhasesV1([{
      ...canonical,
      instructionRefs: [source(), source()],
    }])).toThrow(/duplicate instruction reference/)
    expect(() => parseAgentCustomPhasesV1([{
      ...canonical,
      instructionRefs: [{ ...source(), legacyAlias: true }],
    }])).toThrow(/unknown key/)
    expect(() => parseAgentCustomPhasesV1([{
      ...canonical,
      capabilityRequests: ['workspace_read', 'workspace_read'],
    }])).toThrow(/duplicate capability request/)
    expect(() => parseAgentCustomPhasesV1([{
      ...canonical,
      capabilityRequests: ['unknown_capability'],
    }])).toThrow(/unsupported capability request/)

    for (const repeatLimit of [-1, 5, 1.5]) {
      expect(() => parseAgentCustomPhasesV1([
        phase('phase_one', repeatLimit, []),
      ])).toThrow(/repeatLimit/)
    }
  })

  test('validates self and immediate-next transitions but rejects a farther jump', () => {
    const candidate = draft()
    const validPhases = parseAgentCustomPhasesV1([
      phase('phase_one', 1, ['phase_one', 'phase_two']),
      phase('phase_two', 4, ['phase_two']),
    ])
    candidate.config.runtimePolicy = {
      version: 1,
      authority: 'loom',
      scope: 'preset',
      defaultMode: 'response',
      loomPolicy: null,
      phases: validPhases,
    }
    expect(validateAgenticRuntimeDraft(candidate, [block(3)], 8)).toEqual({ valid: true, issues: [] })
    candidate.config.runtimePolicy.phases = [
      phase('phase_one', 0, ['phase_one']) as never,
      phase('phase_two', 4, ['phase_two']) as never,
    ]
    expect(validateAgenticRuntimeDraft(candidate, [block(3)], 8).issues)
      .toContainEqual({
        code: 'invalid_policy_entry',
        path: 'config.runtimePolicy.phases.0.repeatLimit',
      })


    candidate.config.runtimePolicy.phases = parseAgentCustomPhasesV1([
      phase('phase_one', 1, ['phase_one', 'phase_three']),
      phase('phase_two', 4, ['phase_two']),
    ])
    expect(validateAgenticRuntimeDraft(candidate, [block(3)], 8).issues)
      .toContainEqual({
        code: 'invalid_policy_entry',
        path: 'config.runtimePolicy.phases.0.nextPhaseIds.1',
      })
  })

  test('normalizes legacy phasePolicy only at ingress into visible global buckets', () => {
    const legacyPhasePolicy = {
      work: [{ blockId: 'policy-block', expectedPresetRevision: 8, expectedBlockRevision: 3 }],
      render: [{ blockId: 'policy-block', expectedPresetRevision: 8, expectedBlockRevision: 3 }],
    }
    const { runtimePolicy: _canonicalRuntimePolicy, ...legacyBase } = createDefaultAgentConfigV2()
    const config = {
      ...legacyBase,
      phasePolicy: legacyPhasePolicy,
    }
    const normalized = getAgentRuntimePolicyBuckets(config, [block(3)])
    const directNormalization = normalizeLoomPolicyBucketsV1(null, [block(3)], legacyPhasePolicy)

    expect(normalized).toEqual(directNormalization)
    expect(Object.keys(normalized)).toEqual([
      'version',
      'workPolicy',
      'workspaceUsage',
      'completionCriteria',
      'renderPolicy',
    ])
    expect(normalized.workPolicy[0]).toMatchObject({
      id: 'legacy-workPolicy-policy-block',
      destination: 'root_work',
      checkpoint: 'WORK',
      delivery: { delivery: 'direct' },
    })
    expect(normalized.renderPolicy[0]).toMatchObject({
      id: 'legacy-renderPolicy-policy-block',
      destination: 'render',
      checkpoint: 'RENDER',
      delivery: { delivery: 'direct' },
    })
    expect(normalized.workspaceUsage).toEqual([])
    expect(normalized.completionCriteria).toEqual([])
    expect(normalized).not.toHaveProperty('work')
    expect(normalized).not.toHaveProperty('render')
    expect(normalized).not.toHaveProperty('phasePolicy')
  })

  test('preserves malformed authored policy and never revives legacy policy beside canonical authority', () => {
    const legacyReference = {
      workPolicy: [{ blockId: 'policy-block', expectedPresetRevision: 8, expectedBlockRevision: 3 }],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
    const malformedRuntimePolicy = {
      version: 1,
      authority: 'loom',
      scope: 'preset',
      defaultMode: 'response',
      loomPolicy: { version: 1, workPolicy: null },
      phases: null,
    }
    const authored = {
      ...createDefaultAgentConfigV2(),
      cognitionPolicy: legacyReference,
      phasePolicy: {
        work: legacyReference.workPolicy,
        render: [],
      },
      runtimePolicy: malformedRuntimePolicy,
    }

    const hydrated = normalizeAgentConfigForEditor(authored as never) as unknown as Record<string, unknown>
    expect(hydrated.runtimePolicy).toEqual(malformedRuntimePolicy)
    expect(hydrated.cognitionPolicy).toEqual(legacyReference)
    expect(hydrated.phasePolicy).toEqual(authored.phasePolicy)
    expect(getAgentRuntimePolicyBuckets(authored, [block(3)])).toEqual({
      version: 1,
      workPolicy: [],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    })
  })

  test('emits runtimePolicy without legacy aliases or an extra bucket', () => {
    const config = createDefaultAgentConfigV2()
    config.phasePolicy = {
      work: [],
      render: [],
    }
    config.cognitionPolicy = {
      workPolicy: [],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
    const policies = parseLoomPolicyBucketsV1(policyDocument())
    const emitted = setAgentRuntimePolicyBuckets(config, policies)

    expect(emitted).not.toHaveProperty('phasePolicy')
    expect(emitted).not.toHaveProperty('cognitionPolicy')
    expect(Object.keys(emitted.runtimePolicy!)).toEqual([
      'version',
      'authority',
      'scope',
      'defaultMode',
      'loomPolicy',
      'phases',
    ])
    expect(Object.keys(emitted.runtimePolicy!.loomPolicy!)).toEqual([
      'version',
      'workPolicy',
      'workspaceUsage',
      'completionCriteria',
      'renderPolicy',
    ])
    expect(emitted.runtimePolicy!.loomPolicy).toEqual(policies)

    const phases = parseAgentCustomPhasesV1([phase('phase_one', 1, ['phase_one'])])
    const emittedPhases = setAgentRuntimeCustomPhases(config, phases)
    expect(emittedPhases).not.toHaveProperty('phasePolicy')
    expect(emittedPhases).not.toHaveProperty('cognitionPolicy')
    expect(Object.keys(emittedPhases.runtimePolicy!)).toEqual([
      'version',
      'authority',
      'scope',
      'defaultMode',
      'loomPolicy',
      'phases',
    ])
    expect(emittedPhases.runtimePolicy!.phases).toEqual(phases)
  })
})
