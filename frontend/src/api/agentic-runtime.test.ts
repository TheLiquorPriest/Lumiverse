import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { agenticRuntimeApi } from './agentic-runtime'
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_CUSTOM_BODY,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_SAMPLER_OVERRIDES,
} from '@/lib/loom/constants'
import {
  createAgenticRuntimeDraft,
  createDefaultAgentConfigV2,
  createAgentProfileV2,
} from '@/lib/loom/agenticRuntime'
import type {
  AgentConfigV2,
  AgentTaskTemplate,
  AgenticRuntimeQuarantineItem,
  AgenticRuntimeSaveDraft,
  LoomPreset,
  PromptBlock,
} from '@/lib/loom/types'
import type { Preset } from '@/types/api'

type DraftWithQuarantine = AgenticRuntimeSaveDraft & {
  quarantinedProfiles?: AgenticRuntimeQuarantineItem[]
  quarantinedConnectionSlots?: AgenticRuntimeQuarantineItem[]
}

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const requests: Array<{ url: URL; init?: RequestInit }> = []
const hostCeilings = {
  childAdmissions: 64,
  aggregateToolCalls: 64,
  logicalProviderRequests: 32,
  physicalDispatchAttempts: 64,
  childOutputTokens: 16_384,
  rootWallClockMs: 120_000,
  activityEvents: 256,
  activityBytes: 262_144,
  lifecycleLogRecords: 128,
  activeRootsPerUser: 2,
  activeRootsProcess: 8,
  providerDispatchesPerUser: 16,
  providerDispatchesProcess: 64,
  toolExecutionsPerUser: 32,
  toolExecutionsProcess: 128,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function savedPreset(): Preset {
  return {
    id: 'preset-1',
    name: 'Runtime preset',
    provider: 'loom',
    engine: 'classic',
    parameters: {},
    prompt_order: [],
    prompts: {},
    metadata: {},
    created_at: 1,
    updated_at: 1,
    cache_revision: 9,
  }
}

function installApiFixture(editor: unknown = editorProjection()): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push({ url, init })
    const path = url.pathname.replace('/api/v1', '')
    if (path === '/presets/preset-1/agent-config' && init?.method === 'PUT') {
      return json({
        preset: savedPreset(),
        editor: editorProjection(),
      })
    }
    if (path === '/presets/preset-1/agent-config' && (init?.method === undefined || init?.method === 'GET')) {
      return json(editor)
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`)
  }) as unknown as typeof fetch
}

function sourcePreset(agentConfig: AgentConfigV2): LoomPreset {
  return {
    id: 'preset-1',
    name: 'Runtime preset',
    engine: 'classic',
    description: '',
    coverUrl: null,
    presetVersion: null,
    lumihubMeta: null,
    passthroughMetadata: {},
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    cacheRevision: 8,
    agentConfig,
    agentConfigRevision: 4,
    agentConfigReview: null,
    agentSlotBindings: { writer: 'connection-1' },
    agentTaskTemplates: [],
    blocks: [],
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
  }
}

function validConfig(): AgentConfigV2 {
  const config = createDefaultAgentConfigV2()
  config.profiles = [createAgentProfileV2('Researcher', [])]
  config.connectionSlots = [{ id: 'writer', label: 'Writer', requiredCapabilities: [] }]
  return config
}

function editorProjection(slotBindings: unknown = [{ slotId: 'writer', connectionId: 'connection-1' }]): Record<string, unknown> {
  return {
    presetId: 'preset-1',
    presetRevision: 8,
    configRevision: 5,
    config: validConfig(),
    review: null,
    slotBindings,
    taskTemplates: [],
    reviewAcknowledgements: [],
    hostCeilings: { ...hostCeilings },
  }
}

function quarantinedConfig(): AgentConfigV2 {
  const config = createDefaultAgentConfigV2()
  config.profiles = [{ id: 'invalid-profile' }] as never[]
  config.connectionSlots = [{ id: 'invalid-slot', label: 'Invalid slot' }] as never[]
  return config
}

const taskTemplates: AgentTaskTemplate[] = [{ id: 'task-1', required: true }]
const promptOrder: PromptBlock[] = [{
  id: 'block-1',
  name: 'Runtime block',
  content: 'Use the runtime.',
  role: 'system',
  enabled: true,
  position: 'pre_history',
  depth: 0,
  marker: null,
  isLocked: false,
  color: null,
  injectionTrigger: [],
}]

function withAuthorityFields(draft: DraftWithQuarantine): DraftWithQuarantine {
  return {
    ...draft,
    slotBindings: { writer: 'connection-1' },
    taskTemplates,
    reviewAcknowledgements: ['review-1'],
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: { location: { origin: 'http://localhost' } },
    configurable: true,
  })
  requests.length = 0
  installApiFixture()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window')
  } else {
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true })
  }
})

describe('agentic runtime API save boundary', () => {
  test('sends only the strict route allowlist while retaining authority fields for normal and repaired drafts', async () => {
    const normalDraft = withAuthorityFields(
      createAgenticRuntimeDraft(sourcePreset(validConfig())) as DraftWithQuarantine,
    )
    const importedDraft = createAgenticRuntimeDraft(sourcePreset(quarantinedConfig())) as DraftWithQuarantine
    expect(importedDraft.quarantinedProfiles).toEqual([{
      id: 'invalid_profile:0',
      index: 0,
      reasonCode: 'invalid_profile',
    }])
    expect(importedDraft.quarantinedConnectionSlots).toEqual([{
      id: 'invalid_slot:0',
      index: 0,
      reasonCode: 'invalid_slot',
    }])
    const repairedDraftWithQuarantine = withAuthorityFields({
      ...importedDraft,
      config: {
        ...importedDraft.config,
        profiles: [createAgentProfileV2('Repaired researcher', [])],
        connectionSlots: [{ id: 'writer', label: 'Writer', requiredCapabilities: [] }],
      },
    })
    const repairedDraft = withAuthorityFields({
      ...repairedDraftWithQuarantine,
      quarantinedProfiles: [],
      quarantinedConnectionSlots: [],
    })

    for (const draft of [normalDraft, repairedDraftWithQuarantine, repairedDraft]) {
      const quarantinedState = {
        quarantinedProfiles: structuredClone(draft.quarantinedProfiles),
        quarantinedConnectionSlots: structuredClone(draft.quarantinedConnectionSlots),
      }
      await agenticRuntimeApi.saveEditor('preset-1', {
        ...draft,
        expectedPresetRevision: 8,
        expectedConfigRevision: 4,
        promptOrder,
      })

      const request = requests.at(-1)
      expect(request).toBeDefined()
      const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual([
        'config',
        'expectedConfigRevision',
        'expectedPresetRevision',
        'promptOrder',
        'reviewAcknowledgements',
        'slotBindings',
        'taskTemplates',
      ].sort())
      expect(body).toEqual({
        config: draft.config,
        slotBindings: [{ slotId: 'writer', connectionId: 'connection-1' }],
        taskTemplates,
        reviewAcknowledgements: ['review-1'],
        promptOrder,
        expectedPresetRevision: 8,
        expectedConfigRevision: 4,
      })
      expect(body).not.toHaveProperty('quarantinedProfiles')
      expect(body).not.toHaveProperty('quarantinedConnectionSlots')
      expect(draft.quarantinedProfiles).toEqual(quarantinedState.quarantinedProfiles)
      expect(draft.quarantinedConnectionSlots).toEqual(quarantinedState.quarantinedConnectionSlots)
    }
  })
})

describe('agentic runtime API editor projection boundary', () => {
  test('normalizes equivalent array and object slot binding forms identically', async () => {
    installApiFixture(editorProjection([{ slotId: 'writer', connectionId: null }]))
    const arrayProjection = await agenticRuntimeApi.getEditor('preset-1')

    installApiFixture(editorProjection({ writer: null }))
    const objectProjection = await agenticRuntimeApi.getEditor('preset-1')

    expect(arrayProjection).toEqual(objectProjection)
    expect(arrayProjection.slotBindings).toEqual({ writer: null })
    expect(objectProjection.slotBindings).toEqual({ writer: null })
  })

  test('accepts explicit nullable projection fields but rejects missing nullable fields', async () => {
    const valid = editorProjection({ writer: null })
    valid.config = null
    valid.review = null
    installApiFixture(valid)
    const projection = await agenticRuntimeApi.getEditor('preset-1')
    expect(projection.config).toBeNull()
    expect(projection.review).toBeNull()

    for (const key of ['config', 'review'] as const) {
      const malformed = editorProjection({ writer: null })
      delete malformed[key]
      installApiFixture(malformed)
      await expect(agenticRuntimeApi.getEditor('preset-1')).rejects.toThrow()
    }
  })

  test('rejects ambiguous or malformed slot bindings before hydration', async () => {
    const sparse: unknown[] = []
    sparse.length = 1
    const oversizedArray = Array.from({ length: 33 }, (_, index) => ({
      slotId: `slot_${index}`,
      connectionId: null,
    }))
    const oversizedObject = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`slot_${index}`, null]),
    )
    const dangerousObject = JSON.parse('{"__proto__":"connection-1"}') as unknown
    const cases: Array<[string, unknown]> = [
      ['sparse array', sparse],
      ['oversized array', oversizedArray],
      ['oversized object', oversizedObject],
      ['empty slot id', [{ slotId: '', connectionId: null }]],
      ['oversized slot id', [{ slotId: 'a'.repeat(65), connectionId: null }]],
      ['wrong-type slot id', [{ slotId: 7, connectionId: null }]],
      ['duplicate array slot id', [
        { slotId: 'writer', connectionId: null },
        { slotId: 'writer', connectionId: 'connection-1' },
      ]],
      ['empty connection id', [{ slotId: 'writer', connectionId: '' }]],
      ['oversized connection id', [{ slotId: 'writer', connectionId: 'c'.repeat(257) }]],
      ['wrong-type connection id', [{ slotId: 'writer', connectionId: 7 }]],
      ['dangerous object key', dangerousObject],
    ]

    for (const [name, slotBindings] of cases) {
      installApiFixture(editorProjection(slotBindings))
      await expect(agenticRuntimeApi.getEditor('preset-1')).rejects.toThrow()
      expect(name).toBeTruthy()
    }
  })

  test('rejects malformed projection identities, collections, enums, and ceilings atomically', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['wrong preset id', { presetId: 7 }],
      ['negative preset revision', { presetRevision: -1 }],
      ['wrong config revision', { configRevision: '5' }],
      ['wrong task template entry', { taskTemplates: [{ id: 'task-1', required: 'yes' }] }],
      ['wrong acknowledgement entry', { reviewAcknowledgements: [null] }],
      ['wrong host ceiling', { hostCeilings: { ...hostCeilings, childAdmissions: '64' } }],
      ['missing host ceiling', { hostCeilings: {} }],
    ]

    for (const [name, override] of cases) {
      installApiFixture({ ...editorProjection({ writer: null }), ...override })
      await expect(agenticRuntimeApi.getEditor('preset-1')).rejects.toThrow()
      expect(name).toBeTruthy()
    }
  })
  test('hydrates non-null reviews and preserves backend-valid mode ordering', async () => {
    const reviewed = editorProjection({ writer: null })
    reviewed.review = {
      state: 'repair_required',
      revision: 3,
      reasonCode: 'missing_slot',
      unresolvedSlotIds: ['writer'],
      staleSlotIds: [],
      items: [{
        id: 'repair-1',
        kind: 'unresolved_slot',
        reasonCode: 'missing_slot',
        action: { kind: 'map_slot', ref: 'map-slot' },
        acknowledged: false,
      }],
    }
    const reviewedConfig = validConfig()
    reviewedConfig.agentsEnabled = true
    reviewedConfig.allowedModes = ['agentic', 'response']
    reviewedConfig.profiles[0]!.name = 'Review {{draft}}'
    reviewed.config = reviewedConfig
    installApiFixture(reviewed)
    const projection = await agenticRuntimeApi.getEditor('preset-1')
    expect(projection.review?.reasonCode).toBe('missing_slot')
    expect(projection.review?.acknowledged).toBeUndefined()
    expect(projection.config?.allowedModes).toEqual(['agentic', 'response'])
    expect(projection.config?.profiles[0]?.name).toBe('Review {{draft}}')
  })

  test('rejects malformed cross-field runtime and cognition graph references', async () => {
    const configCases: Array<[string, AgentConfigV2]> = []
    const missingSlotConfig = validConfig()
    missingSlotConfig.profiles[0]!.connectionRef = { kind: 'slot', slotId: 'missing' }
    configCases.push(['unknown profile connection slot', missingSlotConfig])

    const unorderedCapabilityConfig = validConfig()
    unorderedCapabilityConfig.connectionSlots[0]!.requiredCapabilities = ['tool_calling', 'generation']
    configCases.push(['unordered connection capabilities', unorderedCapabilityConfig])

    const disabledAgenticConfig = validConfig()
    disabledAgenticConfig.allowedModes = ['response', 'agentic']
    configCases.push(['disabled agentic modes', disabledAgenticConfig])

    const mismatchedPolicyConfig = validConfig()
    mismatchedPolicyConfig.runtimePolicy = {
      ...mismatchedPolicyConfig.runtimePolicy!,
      defaultMode: 'agentic',
    }
    configCases.push(['mismatched runtime policy mode', mismatchedPolicyConfig])

    const duplicatePolicyConfig = validConfig()
    duplicatePolicyConfig.phasePolicy = { work: [], render: [] }
    configCases.push(['duplicate runtime policy authority', duplicatePolicyConfig])


    const cyclicTaskConfig = validConfig()
    cyclicTaskConfig.taskPolicy = { templateIds: ['task-a', 'task-b'] }
    const cyclicTasks = [
      { id: 'task-a', required: true, dependencies: ['task-b'] },
      { id: 'task-b', required: true, dependencies: ['task-a'] },
    ]
    const cyclicProjection = editorProjection({ writer: null })
    cyclicProjection.config = cyclicTaskConfig
    cyclicProjection.taskTemplates = cyclicTasks
    installApiFixture(cyclicProjection)
    await expect(agenticRuntimeApi.getEditor('preset-1')).rejects.toThrow()

    for (const [name, config] of configCases) {
      const malformed = editorProjection({ writer: null })
      malformed.config = config
      installApiFixture(malformed)
      await expect(agenticRuntimeApi.getEditor('preset-1')).rejects.toThrow()
      expect(name).toBeTruthy()
    }
  })
})
