import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { SaveAgenticRuntimeEditorResult } from '@/api/agentic-runtime'
import type { Preset } from '@/types/api'
import type {
  AgentConfigRepairItem,
  AgentConfigV2,
  AgenticRuntimeSaveDraft,
  LoomPreset,
  PromptBlock,
} from '@/lib/loom/types'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['Element', globalObject.Element],
  ['HTMLElement', globalObject.HTMLElement],
  ['Node', globalObject.Node],
  ['Event', globalObject.Event],
  ['KeyboardEvent', globalObject.KeyboardEvent],
  ['HTMLInputElement', globalObject.HTMLInputElement],
])
Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  HTMLInputElement: domWindow.HTMLInputElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})

// ReactDOM captures browser globals during module evaluation, so this test installs JSDOM first.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
const mountedRoots = new Set<Root>()

const translation = (key: string) => key
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
let editorContextSelections: unknown[] = []
let editorContextRules: unknown[] = []
let editorTaskTemplates: unknown[] = []
let contextAttachmentRequired: boolean | string = false
let editorReviewAcknowledgements: string[] = []
let editorPresetRevision = 8
let editorConfigRevision = 4
let editorConfig: AgentConfigV2 | null = null
let editorReview: LoomPreset['agentConfigReview'] = null
let editorGetError: Error | null = null

mock.module('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  I18nextProvider: ({ children }: { children?: ReactNode }) => children ?? null,
  Trans: ({ i18nKey, children }: { i18nKey?: string; children?: ReactNode }) => createElement('span', null, children ?? i18nKey),
  useTranslation: () => ({ t: translation, i18n: { language: 'en' } }),
}))
mock.module('@/i18n', () => {
  const i18n = { t: translation }
  return {
    default: i18n,
    initI18n: async () => i18n,
    ensureLanguageLoaded: async () => undefined,
    changeUiLanguage: async () => undefined,
  }
})
mock.module('@/hooks/useIsMobile', () => ({ default: () => false }))
mock.module('@/store', () => ({
  useStore: (selector: (state: { providers: unknown[] }) => unknown) => selector({ providers: [] }),
}))
mock.module('@/components/shared/ConnectionSelect', () => ({
  default: ({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) => createElement(
    'select',
    { value, disabled, onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value) },
    createElement('option', { value: '' }, 'inherit'),
    createElement('option', { value: 'connection-1' }, 'Primary'),
  ),
}))
mock.module('@/components/shared/Toggle', () => ({
  Toggle: {
    Switch: ({ checked, onChange, disabled, 'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy }: {
      checked: boolean
      onChange: (checked: boolean) => void
      disabled?: boolean
      'aria-label'?: string
      'aria-describedby'?: string
    }) => createElement('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': checked,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedBy,
      disabled,
      onClick: () => onChange(!checked),
    }),
    Checkbox: ({ checked, onChange, disabled, label, hint }: {
      checked: boolean
      onChange: (checked: boolean) => void
      disabled?: boolean
      label?: ReactNode
      hint?: ReactNode
    }) => createElement('label', null,
      createElement('input', {
        type: 'checkbox',
        checked,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => onChange(event.currentTarget.checked),
      }),
      label,
      hint,
    ),
  },
}))
mock.module('@/lib/clipboard', () => ({
  getSelectionTextWithin: () => '',
  copyTextToClipboard: async () => undefined,
  copyImageToClipboard: async () => undefined,
}))
mock.module('./AgenticRuntimePanel.module.css', () => ({
  default: new Proxy({}, { get: (_target, property) => String(property) }),
}))
mock.module('@/api/agentic-runtime', () => ({
  agenticRuntimeApi: {
    getEditor: async (presetId: string) => {
      if (editorGetError) throw editorGetError
      return {
        presetId,
        config: editorConfig ?? agentConfig(),
        review: editorReview,
        presetRevision: editorPresetRevision,
        configRevision: editorConfigRevision,
        contextPackSelections: editorContextSelections,
        contextRules: editorContextRules,
        taskTemplates: editorTaskTemplates,
        reviewAcknowledgements: editorReviewAcknowledgements,
        slotBindings: {},
        hostCeilings,
      }
    },
  },
}))
mock.module('@/api/agent-context-packs', () => ({
  classifyContextPackError: () => 'unavailable',
  agentContextPacksApi: {
    list: async () => ({ data: [{ id: 'pack-1', name: 'World rules', state: 'active' }] }),
    get: async () => ({
      pack: { id: 'pack-1', name: 'World rules', state: 'active' },
      revisions: [{ packId: 'pack-1', revision: 3, state: 'active', contentDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
      attachments: [{
        attachmentId: 'attachment-1',
        packId: 'pack-1',
        revision: 3,
        scope: 'preset',
        targetId: 'preset-1',
        required: contextAttachmentRequired,
        state: 'active',
      }, {
        attachmentId: 'attachment-chat',
        packId: 'pack-1',
        revision: 3,
        scope: 'chat',
        targetId: 'chat-elsewhere',
        required: true,
        state: 'active',
      }],
    }),
  },
}))
const {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_CUSTOM_BODY,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_SAMPLER_OVERRIDES,
} = await import('@/lib/loom/constants')
const { createDefaultAgentConfigV2 } = await import('@/lib/loom/agenticRuntime')
const { marshalPreset } = await import('@/lib/loom/service')
const { ApiError } = await import('@/api/client')


// The panel is imported after its dependency mocks to keep this test's module graph isolated.
const { default: AgenticRuntimePanel } = await import('./AgenticRuntimePanel')
mock.restore()

function promptBlock(revision = 3): PromptBlock {
  return {
    id: 'policy-block',
    name: 'Work policy',
    content: 'Use evidence.',
    role: 'system',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    revision,
  }
}

function agentConfig(): AgentConfigV2 {
  return {
    ...createDefaultAgentConfigV2(),
    profiles: [{
      id: 'researcher',
      name: 'Researcher',
      systemPrompt: 'Return concise evidence.',
      connectionRef: { kind: 'inherit_main' },
      toolIds: ['lore_search_entries'],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: true,
      maxOutputTokens: 256,
      timeoutMs: 30_000,
    }],
  }
}

function preset(reviewItems: AgentConfigRepairItem[] = []): LoomPreset {
  return {
    id: 'preset-1',
    name: 'Preset',
    description: '',
    coverUrl: null,
    presetVersion: null,
    lumihubMeta: null,
    passthroughMetadata: {},
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    cacheRevision: 8,
    agentConfig: agentConfig(),
    agentConfigRevision: 4,
    agentConfigReview: reviewItems.length === 0 ? null : {
      state: 'review_required',
      revision: 1,
      reasonCode: 'import_review',
      unresolvedSlotIds: [],
      staleSlotIds: [],
      acknowledged: false,
      items: reviewItems,
    },
    agentSlotBindings: {},
    agentContextPackSelections: [],
    agentContextRules: [],
    agentTaskTemplates: [],
    blocks: [promptBlock()],
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
function wirePreset(loom: LoomPreset): Preset {
  const input = marshalPreset(loom)
  return {
    id: loom.id,
    name: input.name,
    provider: input.provider,
    parameters: input.parameters ?? {},
    prompt_order: input.prompt_order ?? [],
    prompts: input.prompts ?? {},
    metadata: input.metadata ?? {},
    agent_config: loom.agentConfig,
    agent_config_revision: loom.agentConfigRevision,
    agent_config_review: loom.agentConfigReview,
    agent_slot_bindings: loom.agentSlotBindings,
    agent_context_pack_selections: loom.agentContextPackSelections,
    agent_context_rules: loom.agentContextRules,
    agent_task_templates: loom.agentTaskTemplates,
    created_at: loom.createdAt,
    updated_at: loom.updatedAt,
    cache_revision: loom.cacheRevision,
  }
}

function saveResult(
  base: LoomPreset,
  draft: AgenticRuntimeSaveDraft,
  promptOrder: PromptBlock[],
): SaveAgenticRuntimeEditorResult {
  const committed: LoomPreset = {
    ...base,
    blocks: structuredClone(promptOrder),
    agentConfig: structuredClone(draft.config),
    agentConfigRevision: base.agentConfigRevision + 1,
    agentSlotBindings: { ...draft.slotBindings },
    agentContextPackSelections: structuredClone(draft.contextPackSelections),
    agentContextRules: structuredClone(draft.contextRules),
    agentTaskTemplates: structuredClone(draft.taskTemplates),
  }
  return {
    preset: wirePreset(committed),
    editor: {
      presetId: committed.id,
      presetRevision: committed.cacheRevision ?? 0,
      configRevision: committed.agentConfigRevision,
      config: committed.agentConfig,
      review: committed.agentConfigReview,
      slotBindings: committed.agentSlotBindings,
      contextPackSelections: committed.agentContextPackSelections,
      contextRules: committed.agentContextRules,
      taskTemplates: committed.agentTaskTemplates,
      reviewAcknowledgements: [...draft.reviewAcknowledgements],
      hostCeilings,
    },
  }
}


function renderPanel(options: {
  value?: LoomPreset
  onSave?: (draft: AgenticRuntimeSaveDraft, promptOrder: PromptBlock[], expectedPresetRevision?: number) => Promise<SaveAgenticRuntimeEditorResult>
  onDirtyChange?: (dirty: boolean) => void
} = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const value = options.value ?? preset()
  editorConfig = structuredClone(value.agentConfig)
  editorReview = structuredClone(value.agentConfigReview)
  flushSync(() => root.render(createElement(AgenticRuntimePanel, {
    preset: value,
    onSave: options.onSave ?? (async (draft, promptOrder) => saveResult(value, draft, promptOrder)),
    onDirtyChange: options.onDirtyChange ?? (() => {}),
  })))
  mountedRoots.add(root)
  return { container, root }
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(text))
  if (!found) throw new Error(`Button not found: ${text}`)
  return found
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')!.set!
  flushSync(() => {
    input.focus()
    valueSetter.call(input, value)
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true, cancelable: true }))
  })
}
function changeSelect(select: HTMLSelectElement, value: string): void {
  flushSync(() => {
    select.focus()
    select.value = value
    select.dispatchEvent(new domWindow.Event('change', { bubbles: true, cancelable: true }))
  })
}


async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
  })
}

function unmountRoot(root: Root): void {
  if (!mountedRoots.has(root)) return
  flushSync(() => root.unmount())
  mountedRoots.delete(root)
}

afterEach(() => {
  for (const root of [...mountedRoots]) unmountRoot(root)
  document.body.replaceChildren()
  editorContextSelections = []
  editorContextRules = []
  editorTaskTemplates = []
  editorReviewAcknowledgements = []
  editorPresetRevision = 8
  editorConfigRevision = 4
  editorConfig = null
  editorReview = null
  editorGetError = null
})

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('Agentic Runtime shared editor', () => {
  test('keeps one dirty draft across sections and submits config with prompt blocks once', async () => {
    const saves: Array<{ draft: AgenticRuntimeSaveDraft; promptOrder: PromptBlock[]; expectedRevision?: number }> = []
    const dirtyStates: boolean[] = []
    const { container } = renderPanel({
      onSave: async (savedDraft, promptOrder, expectedRevision) => {
        saves.push({ draft: savedDraft, promptOrder, expectedRevision })
        return saveResult(preset(), savedDraft, promptOrder)
      },
      onDirtyChange: (dirty) => { dirtyStates.push(dirty) },
    })
    await settle()

    flushSync(() => button(container, 'sections.agents.nav').click())
    const name = container.querySelector<HTMLInputElement>('input[value="Researcher"]')
    expect(name).not.toBeNull()
    changeInput(name!, 'Evidence analyst')
    expect(dirtyStates.at(-1)).toBe(true)
    expect(saves).toHaveLength(0)

    flushSync(() => button(container, 'sections.tools.nav').click())
    expect(container.textContent).toContain('sections.tools.title')
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(0)

    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves).toHaveLength(1)
    expect(saves[0]?.expectedRevision).toBe(8)
    expect(saves[0]?.draft.config.profiles[0]?.name).toBe('Evidence analyst')
    expect(saves[0]?.draft.config.profiles[0]?.toolIds).toEqual(['lore_search_entries'])
    expect(saves[0]?.promptOrder.map((item) => item.id)).toEqual(['policy-block'])
    expect(dirtyStates.at(-1)).toBe(false)
  })
  test('does not let edits overwrite a save that is already in flight', async () => {
    const submitted: AgenticRuntimeSaveDraft[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const value = preset()
    const { container } = renderPanel({
      onSave: async (draft, promptOrder) => {
        submitted.push(structuredClone(draft))
        await blocked
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    const name = container.querySelector<HTMLInputElement>('input[value="Researcher"]')!
    changeInput(name, 'Evidence analyst')
    flushSync(() => button(container, 'save.action').click())
    await settle()
    changeInput(name, 'Overwritten while saving')
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.config.profiles[0]?.name).toBe('Evidence analyst')
    release()
    await settle()
    expect(container.querySelector<HTMLInputElement>('input[value="Researcher"]')).not.toBeNull()
  })


  test('retains the complete draft and reports an atomic revision conflict', async () => {
    const { container } = renderPanel({
      onSave: async () => { throw new ApiError(409, 'Conflict', { code: 'AGENT_CONFIG_REVISION_CONFLICT' }) },
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    const name = container.querySelector<HTMLInputElement>('input[value="Researcher"]')!
    changeInput(name, 'Unsaved analyst')
    flushSync(() => button(container, 'save.action').click())
    await settle()

    expect(container.textContent).toContain('save.conflict')
    flushSync(() => button(container, 'sections.tools.nav').click())
    flushSync(() => button(container, 'sections.agents.nav').click())
    expect(container.querySelector<HTMLInputElement>('input[value="Unsaved analyst"]')).not.toBeNull()
  })
  test('preserves a dirty draft when an external preset revision refreshes', async () => {
    const value = preset()
    const { container, root } = renderPanel({ value })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    const name = container.querySelector<HTMLInputElement>('input[value="Researcher"]')!
    changeInput(name, 'Unsaved through refresh')

    editorPresetRevision = (value.cacheRevision ?? 0) + 1
    const refreshed = { ...value, cacheRevision: editorPresetRevision }
    flushSync(() => root.render(createElement(AgenticRuntimePanel, {
      preset: refreshed,
      onSave: async (draft, promptOrder) => saveResult(refreshed, draft, promptOrder),
      onDirtyChange: () => {},
    })))
    await settle()

    expect(container.querySelector<HTMLInputElement>('input[value="Unsaved through refresh"]')).not.toBeNull()
    expect(container.textContent).toContain('save.conflict')
  })

  test('keeps every section tab related to the stable panel', async () => {
    const { container } = renderPanel()
    await settle()
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const panel = container.querySelector<HTMLElement>('#agentic-runtime-panel')
    expect(tabs.length).toBeGreaterThan(1)
    expect(panel).not.toBeNull()
    for (const tab of tabs) {
      expect(tab.getAttribute('aria-controls')).toBe('agentic-runtime-panel')
    }
    // The profile rail lives in the Agents section; the panel opens on Activation.
    flushSync(() => button(container, 'sections.agents.nav').click())
    const profileList = container.querySelector<HTMLElement>('[role="list"]')
    expect(profileList?.querySelectorAll('[role="listitem"]').length).toBe(1)
    const toolsTab = tabs.find((tab) => tab.textContent?.includes('sections.tools.nav'))!
    flushSync(() => toolsTab.click())
    expect(panel?.getAttribute('aria-labelledby')).toBe(toolsTab.id)
  })

  test('removes deleted profile markers before save', async () => {
    const value = preset()
    value.blocks = [{
      ...value.blocks[0]!,
      content: '{{agent::researcher::as=researcher_result}}Task text{{/agent}}',
    }]
    const saves: PromptBlock[][] = []
    const { container } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(promptOrder))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.includes('actions.delete'))
    expect(deleteButton).not.toBeNull()
    flushSync(() => deleteButton!.click())
    flushSync(() => button(container, 'save.action').click())
    await settle()

    expect(saves).toHaveLength(1)
    expect(saves[0]?.[0]?.content).toBe('Task text')
    expect(saves[0]?.[0]?.content).not.toContain('{{agent::')
    expect(saves[0]?.[0]?.content).not.toContain('{{/agent}}')
  })


  test('blocks imported activation until every repair item is acknowledged', async () => {
    const repairItems: AgentConfigRepairItem[] = [{
      id: 'import:review',
      kind: 'disabled_import',
      label: 'Imported runtime',
      reasonCode: 'disabled_import',
      action: { kind: 'acknowledge' },
      acknowledged: false,
    }, {
      id: 'capability:review',
      kind: 'capability_mismatch',
      label: 'Local provider',
      reasonCode: 'capability_mismatch',
      action: { kind: 'choose_response' },
      acknowledged: false,
    }]
    const { container } = renderPanel({ value: preset(repairItems) })
    await settle()
    const activationSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(activationSwitch.disabled).toBe(true)
    const activationReasonId = activationSwitch.getAttribute('aria-describedby')
    expect(activationReasonId).toBe('agentic-runtime-activation-review-reason')
    expect(container.querySelector(`#${activationReasonId}`)?.textContent).toContain('activation.reviewDescription')
    const saveButton = button(container, 'save.action')
    expect(saveButton.getAttribute('aria-describedby')).toBe('agentic-runtime-save-validation-reason')
    expect(container.querySelector('#agentic-runtime-save-validation-reason')).not.toBeNull()

    flushSync(() => button(container, 'sections.repair.nav').click())
    const acknowledgements = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(acknowledgements).toHaveLength(2)
    expect(acknowledgements.every((acknowledgement) => !acknowledgement.checked)).toBe(true)
    flushSync(() => acknowledgements.forEach((acknowledgement) => acknowledgement.click()))

    flushSync(() => button(container, 'sections.activation.nav').click())
    expect(container.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false)
  })
  test('clears stale-slot review when a replacement binding is selected', async () => {
    const value = preset([{
      id: 'stale-slot:slot-a',
      kind: 'stale_slot',
      label: 'slot-a',
      reasonCode: 'stale_slot',
      action: { kind: 'map_slot' },
      acknowledged: false,
    }])
    value.agentConfig!.connectionSlots = [{ id: 'slot-a', label: 'Research', requiredCapabilities: [] }]
    value.agentSlotBindings = { 'slot-a': null }
    const { container } = renderPanel({ value })
    await settle()
    flushSync(() => button(container, 'sections.repair.nav').click())
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
    const connection = container.querySelector<HTMLSelectElement>('select')
    expect(connection).not.toBeNull()
    changeSelect(connection!, 'connection-1')
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(button(container, 'save.action').disabled).toBe(false)
  })
  test('edits canonical context references, required semantics, and saves the policy fields', async () => {
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container } = renderPanel({
      onSave: async (draft, promptOrder) => {
        saves.push(draft)
        return saveResult(preset(), draft, promptOrder)
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.context.nav').click())
    const packSelect = container.querySelector<HTMLSelectElement>('select[aria-label="context.addPack"]')
    expect(packSelect).not.toBeNull()
    changeSelect(packSelect!, 'pack-1\u0000pack-1@3')
    await settle()
    expect(container.textContent).toContain('context.scopeLabel')
    expect(container.textContent).toContain('context.attachmentOptional')
    expect(container.textContent).not.toContain('context.attachmentRequired')
    const direct = container.querySelector<HTMLInputElement>('input[aria-label="context.alwaysIncludeFor"]')
    expect(direct).not.toBeNull()
    flushSync(() => direct!.click())
    flushSync(() => button(container, 'context.addRule').click())
    const required = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes('context.required'))
    expect(required).not.toBeNull()
    flushSync(() => required!.click())
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves).toHaveLength(1)
    expect(saves[0]?.config.contextPolicy).toEqual({ ruleIds: ['context_1'], packIds: ['pack-1'] })
    expect(saves[0]?.contextRules[0]).toMatchObject({ packId: 'pack-1', revisionId: 'pack-1@3', required: true })
  })
  test('rewrites context-rule dependencies when a rule ID changes', async () => {
    const value = preset()
    value.agentContextPackSelections = [{
      packId: 'pack-1',
      revisionId: 'pack-1@3',
      revision: 3,
      label: 'World rules',
      digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      revisionLabel: 'Revision 3',
    }]
    value.agentContextRules = [{
      id: 'context_1',
      packId: 'pack-1',
      revisionId: 'pack-1@3',
      required: false,
      dependencies: [],
    }, {
      id: 'context_2',
      packId: 'pack-1',
      revisionId: 'pack-1@3',
      required: false,
      dependencies: ['context_1'],
    }]
    value.agentConfig!.contextPolicy = { ruleIds: ['context_1', 'context_2'], packIds: [] }
    editorContextSelections = structuredClone(value.agentContextPackSelections)
    editorContextRules = structuredClone(value.agentContextRules)
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.context.nav').click())
    expect(container.textContent).toContain('context.revisionLabel')
    expect(container.textContent).not.toContain('Revision 3')
    const ruleIds = [...container.querySelectorAll<HTMLInputElement>('input[aria-label="context.ruleId"]')]
    expect(ruleIds).toHaveLength(2)
    changeInput(ruleIds[0]!, 'context_renamed')
    const dependencyInputs = [...container.querySelectorAll<HTMLInputElement>('input[aria-label^="context.dependency"]')]
    expect(dependencyInputs).toHaveLength(2)
    expect(dependencyInputs.some((input) => input.checked)).toBe(true)
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves[0]?.config.contextPolicy).toEqual({
      ruleIds: ['context_renamed', 'context_2'],
      packIds: [],
    })
    const direct = container.querySelector<HTMLInputElement>('input[aria-label="context.alwaysIncludeFor"]')
    expect(direct).not.toBeNull()
    flushSync(() => direct!.click())
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves[1]?.config.contextPolicy).toEqual({
      ruleIds: ['context_renamed', 'context_2'],
      packIds: ['pack-1'],
    })
  })
  test('resets an edited context policy to its last committed draft', async () => {
    const { container } = renderPanel()
    await settle()
    flushSync(() => button(container, 'sections.context.nav').click())
    const packSelect = container.querySelector<HTMLSelectElement>('select[aria-label="context.addPack"]')!
    changeSelect(packSelect, 'pack-1\u0000pack-1@3')
    await settle()
    flushSync(() => button(container, 'context.addRule').click())
    expect(button(container, 'save.action').disabled).toBe(false)

    flushSync(() => button(container, 'save.reset').click())

    expect(container.querySelectorAll('details')).toHaveLength(0)
    expect(container.querySelectorAll('li')).toHaveLength(0)
    expect(button(container, 'save.action').disabled).toBe(true)
    expect(button(container, 'save.reset').disabled).toBe(true)
  })

  test('quarantines a mismatched imported policy instead of normalizing it on render', async () => {
    const value = preset()
    value.agentConfig!.contextPolicy = { ruleIds: ['missing-rule'], packIds: ['missing-pack'] }
    const { container } = renderPanel({ value })
    await settle()
    flushSync(() => button(container, 'sections.context.nav').click())

    expect(container.textContent).toContain('context.quarantineTitle')
    expect(button(container, 'save.action').disabled).toBe(true)
    expect(container.textContent).toContain('context.repairPolicy')
  })


  test('quarantines malformed imported context values until explicitly discarded', async () => {
    editorContextSelections = [{
      packId: 'pack-1',
      revisionId: 'pack-1@bad',
      revision: 0,
      label: 'Imported',
      revisionLabel: 'bad',
      digest: 'bad',
    }]
    const { container } = renderPanel()
    await settle()
    flushSync(() => button(container, 'sections.context.nav').click())
    expect(container.textContent).toContain('context.quarantineTitle')
    expect(button(container, 'save.action').disabled).toBe(true)
    const discard = container.querySelector<HTMLButtonElement>('[aria-label="context.discardQuarantined"]')
    expect(discard).not.toBeNull()
    flushSync(() => discard!.click())
    expect(container.textContent).not.toContain('context.quarantineTitle')
    expect(button(container, 'save.action').disabled).toBe(false)
  })
  test('repairs task-transition predicates when deleting a task template', async () => {
    const removedTask = { id: 'remove_me', required: true, activation: { kind: 'phase' as const, value: 'WORK' as const } }
    const keeperTask = {
      id: 'keeper',
      required: true,
      activation: {
        kind: 'all' as const,
        children: [
          { kind: 'task_transition' as const, taskId: 'remove_me', transition: 'done' as const },
          { kind: 'phase' as const, value: 'WORK' as const },
        ],
      },
    }
    editorTaskTemplates = [removedTask, keeperTask]
    editorContextSelections = [{
      packId: 'pack-1',
      revisionId: 'pack-1@3',
      revision: 3,
      label: 'World rules',
      revisionLabel: 'Revision 3',
      digest: 'a'.repeat(64),
    }]
    editorContextRules = [{
      id: 'context_rule',
      packId: 'pack-1',
      revisionId: 'pack-1@3',
      required: false,
      activation: {
        kind: 'not' as const,
        child: { kind: 'task_transition' as const, taskId: 'remove_me', transition: 'active' as const },
      },
    }]
    const value = preset()
    value.agentConfig!.taskPolicy = { templateIds: ['remove_me', 'keeper'] }
    value.agentConfig!.contextPolicy = { ruleIds: ['context_rule'], packIds: [] }
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.tasks.nav').click())
    const removeButtons = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .filter((candidate) => candidate.textContent?.includes('tasks.remove'))
    expect(removeButtons).toHaveLength(2)
    flushSync(() => removeButtons[0]!.click())
    expect(button(container, 'save.action').disabled).toBe(false)
    flushSync(() => button(container, 'save.action').click())
    await settle()

    expect(saves).toHaveLength(1)
    expect(saves[0]?.taskTemplates).toEqual([{
      id: 'keeper',
      required: true,
      activation: { kind: 'phase', value: 'WORK' },
    }])
    expect(saves[0]?.contextRules[0]?.activation).toBeUndefined()
  })
  test('quarantines malformed imported task templates until explicitly discarded', async () => {
    editorTaskTemplates = [{ id: 'bad-task', required: true }]
    const value = preset()
    value.agentConfig!.taskPolicy = { templateIds: ['bad-task'] }
    const { container } = renderPanel({ value })
    await settle()
    flushSync(() => button(container, 'sections.tasks.nav').click())
    expect(container.textContent).toContain('tasks.quarantined')
    expect(button(container, 'save.action').disabled).toBe(true)
    const discard = container.querySelector<HTMLButtonElement>('[aria-label="tasks.discardQuarantined"]')
    expect(discard).not.toBeNull()
    flushSync(() => discard!.click())
    expect(container.textContent).not.toContain('tasks.quarantined')
    expect(button(container, 'save.action').disabled).toBe(false)
  })
  test('clears an empty quarantined task id from policy references', async () => {
    editorTaskTemplates = [{ id: '', required: true }]
    const value = preset()
    value.agentConfig!.taskPolicy = { templateIds: [''] }
    const { container } = renderPanel({ value })
    await settle()
    flushSync(() => button(container, 'sections.tasks.nav').click())
    const discard = container.querySelector<HTMLButtonElement>('[aria-label="tasks.discardQuarantined"]')
    expect(discard).not.toBeNull()
    flushSync(() => discard!.click())
    expect(button(container, 'save.action').disabled).toBe(false)
  })
  test('shows unavailable attachment metadata without trusting unknown requiredness', async () => {
    contextAttachmentRequired = 'unknown'
    editorContextSelections = [{
      packId: 'pack-1',
      revisionId: 'pack-1@3',
      revision: 3,
      label: 'World rules',
      digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      revisionLabel: 'Revision 3',
    }]
    const { container } = renderPanel()
    await settle()
    flushSync(() => button(container, 'sections.context.nav').click())
    expect(container.textContent).toContain('context.scopeUnavailable')
    expect(container.textContent).toContain('context.attachmentUnavailable')
    expect(container.textContent).not.toContain('context.scopes.unknown_scope')
  })

  test('hydrates committed revision and policy values from the atomic save response', async () => {
    const committed = structuredClone(preset())
    committed.agentConfig!.profiles[0]!.name = 'Committed analyst'
    committed.agentConfigRevision = 5
    const response: SaveAgenticRuntimeEditorResult = {
      preset: wirePreset(committed),
      editor: {
        presetId: committed.id,
        presetRevision: committed.cacheRevision ?? 0,
        configRevision: committed.agentConfigRevision,
        config: committed.agentConfig,
        review: committed.agentConfigReview,
        slotBindings: committed.agentSlotBindings,
        contextPackSelections: committed.agentContextPackSelections,
        contextRules: committed.agentContextRules,
        taskTemplates: committed.agentTaskTemplates,
        reviewAcknowledgements: [],
        hostCeilings,
      },
    }
    const { container } = renderPanel({
      onSave: async () => response,
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    changeInput(container.querySelector<HTMLInputElement>('input[value="Researcher"]')!, 'Local draft')
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(container.querySelector<HTMLInputElement>('input[value="Committed analyst"]')).not.toBeNull()
    expect(button(container, 'save.action').disabled).toBe(true)
  })
  test('rejects acknowledgement IDs that are not in the server-derived review set', async () => {
    editorReviewAcknowledgements = ['unknown-review-id']
    const item: AgentConfigRepairItem = {
      id: 'import:review',
      kind: 'disabled_import',
      reasonCode: 'disabled_import',
      action: { kind: 'acknowledge' },
    }
    const { container } = renderPanel({ value: preset([item]) })
    await settle()
    expect(container.textContent).toContain('validation.review_acknowledgement_unknown')
    expect(button(container, 'save.action').disabled).toBe(true)
  })


  test('surfaces stale block revisions and never enables a partial save', async () => {
    const value = preset()
    value.agentConfig!.cognitionPolicy!.workPolicy = [{
      blockId: 'policy-block',
      expectedPresetRevision: 8,
      expectedBlockRevision: 2,
    }]
    const { container } = renderPanel({ value })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    changeInput(container.querySelector<HTMLInputElement>('input[value="Researcher"]')!, 'Changed')

    expect(container.textContent).toContain('validation.stale_block_revision')
    expect(button(container, 'save.action').disabled).toBe(true)
  })

  test('preserves explicit number, boolean, and string-list predicate values through editing and save', async () => {
    const activation = {
      kind: 'all' as const,
      children: [
        { kind: 'preset_variable' as const, name: 'priority', operator: 'equals' as const, value: 7 },
        { kind: 'participant_fact' as const, name: 'traits', operator: 'in' as const, values: [true, 3, 'root'] },
        { kind: 'preset_variable' as const, name: 'tags', operator: 'equals' as const, value: ['canon', 'active'] },
      ],
    }
    const template = { id: 'typed_values', required: true, activation }
    const value = preset()
    value.agentTaskTemplates = [structuredClone(template)]
    value.agentConfig!.taskPolicy = { templateIds: [template.id] }
    editorTaskTemplates = [structuredClone(template)]
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.tasks.nav').click())

    const typeControls = [...container.querySelectorAll<HTMLSelectElement>('select[aria-label="predicate.valueType"]')]
    expect(typeControls.map((control) => control.value)).toEqual(['number', 'boolean', 'number', 'string', 'string_list'])
    const numberInputs = [...container.querySelectorAll<HTMLInputElement>('input[type="number"][aria-label="predicate.value"]')]
    changeInput(numberInputs[0]!, '8')
    const booleanValue = [...container.querySelectorAll<HTMLSelectElement>('select[aria-label="predicate.value"]')]
      .find((control) => control.value === 'true')
    expect(booleanValue).not.toBeNull()
    changeSelect(booleanValue!, 'false')

    flushSync(() => button(container, 'save.action').click())
    await settle()

    expect(saves).toHaveLength(1)
    expect(saves[0]?.taskTemplates[0]?.activation).toEqual({
      kind: 'all',
      children: [
        { kind: 'preset_variable', name: 'priority', operator: 'equals', value: 8 },
        { kind: 'participant_fact', name: 'traits', operator: 'in', values: [false, 3, 'root'] },
        { kind: 'preset_variable', name: 'tags', operator: 'equals', value: ['canon', 'active'] },
      ],
    })
  })

  test('supports roving keyboard tabs with focus following selection', async () => {
    const { container } = renderPanel()
    await settle()
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs).toHaveLength(8)
    tabs[0]!.focus()
    flushSync(() => tabs[0]!.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(tabs[1])
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.tabIndex).toBe(0)
  })

  test('does not treat a dormant backend config as invalid or unsavable', async () => {
    const value = preset()
    value.agentConfig = {
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
    }
    editorConfig = structuredClone(value.agentConfig)
    const { container } = renderPanel({ value })
    await settle()
    expect(container.textContent).not.toContain('validation.invalid_config')
    const enable = container.querySelector<HTMLButtonElement>('[aria-label="activation.enable"]')
    expect(enable).not.toBeNull()
    expect(enable!.disabled).toBe(false)
    flushSync(() => enable!.click())
    expect(enable!.getAttribute('aria-checked')).toBe('true')
    const agentic = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.closest('label')?.textContent?.includes('modes.agentic'))
    expect(agentic).not.toBeNull()
    expect(agentic!.disabled).toBe(false)
    flushSync(() => {
      agentic!.checked = true
      agentic!.dispatchEvent(new domWindow.Event('change', { bubbles: true }))
    })
    expect(container.textContent).not.toContain('validation.invalid_config')
    expect(container.textContent).not.toContain('validation.invalid_modes')
  })

  test('lets a new preset enable agents when the editor projection is missing', async () => {
    editorGetError = new ApiError(404, 'Not Found')
    const value = preset()
    value.agentConfig = null
    value.agentConfigRevision = 0
    value.agentConfigReview = null
    const { container } = renderPanel({ value })
    await settle()
    const enable = container.querySelector<HTMLButtonElement>('[aria-label="activation.enable"]')
    expect(enable).not.toBeNull()
    expect(enable!.disabled).toBe(false)
    flushSync(() => enable!.click())
    expect(enable!.getAttribute('aria-checked')).toBe('true')
    expect(container.textContent).not.toContain('validation.invalid_config')
  })

  test('does not treat a failed editor load as a dormant writable draft', async () => {
    editorGetError = new ApiError(500, 'Internal Server Error')
    const value = preset()
    const { container } = renderPanel({ value })
    await settle()
    const enable = container.querySelector<HTMLButtonElement>('[aria-label="activation.enable"]')
    expect(enable).not.toBeNull()
    flushSync(() => enable!.click())
    expect(enable!.getAttribute('aria-checked')).toBe('false')
  })

  test('shows actual runtime ceilings as information and exposes no control that can raise them', async () => {
    const { container } = renderPanel()
    await settle()
    flushSync(() => button(container, 'sections.workspace.nav').click())
    expect(container.textContent).toContain(hostCeilings.childAdmissions.toLocaleString())
    expect(container.textContent).toContain(hostCeilings.rootWallClockMs.toLocaleString())
    expect(container.querySelectorAll('input[type="number"]')).toHaveLength(0)
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(4)
  })
})
