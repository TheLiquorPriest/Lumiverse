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
    candidate.config.cognitionPolicy!.workPolicy = [{
      blockId: 'policy-block',
      expectedPresetRevision: 8,
      expectedBlockRevision: 2,
    }]

    const result = validateAgenticRuntimeDraft(candidate, [block(3)], 8)
    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual({ code: 'stale_block_revision', path: 'config.cognitionPolicy.workPolicy.0' })
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
    candidate.config.cognitionPolicy!.workPolicy = [{
      blockId: 'policy-block',
      expectedPresetRevision: 8,
      expectedBlockRevision: 3,
    }]
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
})
