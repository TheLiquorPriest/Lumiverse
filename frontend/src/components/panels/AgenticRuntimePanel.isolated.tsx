import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { SaveAgenticRuntimeEditorResult } from '@/api/agentic-runtime'
import type { Preset } from '@/types/api'
import type {
  AgentConfigRepairItem,
  AgentCustomPhaseV1,
  AgentConfigV2,
  AgenticRuntimeSaveDraft,
  AgentRuntimePolicyV1,
  CognitionPredicate,
  LoomPreset,
  PromptBlock,
} from '@/lib/loom/types'
import type { LoomPolicyEntryV1, LoomPolicySourceV1 } from '@/types/agent-runtime'

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
let editorTaskTemplates: unknown[] = []
let editorReviewAcknowledgements: string[] = []
let editorPresetRevision = 8
let editorConfigRevision = 4
let editorConfig: AgentConfigV2 | null = null
let editorReview: LoomPreset['agentConfigReview'] = null
let editorGetError: Error | null = null
let editorProjectionInvalid = false
let editorGetGate: Promise<void> | null = null



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
      if (editorGetGate) await editorGetGate
      if (editorGetError) throw editorGetError
      return {
        presetId,
        config: editorProjectionInvalid ? null : editorConfig ?? agentConfig(),
        review: editorReview,
        presetRevision: editorPresetRevision,
        configRevision: editorConfigRevision,
        taskTemplates: editorTaskTemplates,
        reviewAcknowledgements: editorReviewAcknowledgements,
        slotBindings: {},
        hostCeilings,
      }
    },
  },
}))
const {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_CUSTOM_BODY,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_SAMPLER_OVERRIDES,
} = await import('@/lib/loom/constants')
const {
  createDefaultAgentConfigV2,
  prepareAgentConfigForRuntimeSave,
} = await import('@/lib/loom/agenticRuntime')
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
function loomSource(): LoomPolicySourceV1 {
  return {
    kind: 'loom_block',
    blockId: 'policy-block',
    presetRevision: 8,
    blockRevision: 3,
    promptOrder: 0,
  }
}

function customPhase(
  id: string,
  overrides: Partial<AgentCustomPhaseV1> = {},
): AgentCustomPhaseV1 {
  return {
    version: 1,
    id,
    label: id,
    instructionRefs: [],
    childInstructionSubsets: [],
    required: true,
    enter: { kind: 'phase', value: 'WORK' },
    exit: { kind: 'phase', value: 'COMPLETE' },
    capabilityRequests: [],
    repeatLimit: 0,
    nextPhaseIds: [],
    ...overrides,
  }
}

function workPolicyEntry(condition?: CognitionPredicate): LoomPolicyEntryV1 {
  return {
    version: 1,
    id: 'work-policy-entry',
    source: loomSource(),
    destination: 'root_work',
    checkpoint: 'WORK',
    required: true,
    visibility: 'work_only',
    ...(condition === undefined ? {} : { condition }),
  }
}

function runtimePolicy(
  phases: readonly AgentCustomPhaseV1[] = [],
  workPolicy: readonly LoomPolicyEntryV1[] = [],
): AgentRuntimePolicyV1 {
  return {
    version: 1,
    authority: 'loom',
    scope: 'preset',
    defaultMode: 'response',
    loomPolicy: {
      version: 1,
      workPolicy,
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    },
    phases,
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
    engine: loom.engine,
    parameters: input.parameters ?? {},
    prompt_order: input.prompt_order ?? [],
    prompts: input.prompts ?? {},
    metadata: input.metadata ?? {},
    agent_config: loom.agentConfig,
    agent_config_revision: loom.agentConfigRevision,
    agent_config_review: loom.agentConfigReview,
    agent_slot_bindings: loom.agentSlotBindings,
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
    cacheRevision: (base.cacheRevision ?? 0) + 1,
    blocks: structuredClone(promptOrder),
    agentConfig: structuredClone(prepareAgentConfigForRuntimeSave(
      draft.config,
      promptOrder,
      base.cacheRevision ?? 0,
    )),
    agentConfigRevision: base.agentConfigRevision + 1,
    agentSlotBindings: { ...draft.slotBindings },
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
      taskTemplates: committed.agentTaskTemplates,
      reviewAcknowledgements: [...draft.reviewAcknowledgements],
      hostCeilings,
    },
  }
}

function reloadResult(base: LoomPreset): SaveAgenticRuntimeEditorResult {
  return {
    preset: wirePreset(base),
    editor: {
      presetId: base.id,
      presetRevision: base.cacheRevision ?? 0,
      configRevision: base.agentConfigRevision,
      config: structuredClone(base.agentConfig ?? createDefaultAgentConfigV2()),
      review: structuredClone(base.agentConfigReview),
      slotBindings: { ...base.agentSlotBindings },
      taskTemplates: structuredClone(base.agentTaskTemplates),
      reviewAcknowledgements: [],
      hostCeilings,
    },
  }
}


function renderPanel(options: {
  value?: LoomPreset
  onSave?: (
    draft: AgenticRuntimeSaveDraft,
    promptOrder: PromptBlock[],
    expectedIdentity: { presetId: string; presetRevision: number; configRevision: number },
    acceptSnapshot: (result: SaveAgenticRuntimeEditorResult) => boolean,
  ) => Promise<SaveAgenticRuntimeEditorResult>
  onReload?: () => Promise<SaveAgenticRuntimeEditorResult>
  onDirtyChange?: (dirty: boolean) => void
} = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const value = options.value ?? preset()
  editorPresetRevision = value.cacheRevision ?? 0
  editorConfigRevision = value.agentConfigRevision
  editorConfig = structuredClone(value.agentConfig)
  editorReview = structuredClone(value.agentConfigReview)
  flushSync(() => root.render(createElement(AgenticRuntimePanel, {
    preset: value,
    onSave: options.onSave ?? (async (draft, promptOrder) => saveResult(value, draft, promptOrder)),
    onDirtyChange: options.onDirtyChange ?? (() => {}),
    onReload: options.onReload ?? (async () => reloadResult(value)),
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
  editorTaskTemplates = []
  editorReviewAcknowledgements = []
  editorPresetRevision = 8
  editorConfigRevision = 4
  editorConfig = null
  editorReview = null
  editorProjectionInvalid = false
  editorGetError = null
  editorGetGate = null

})

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('Agentic Runtime shared editor', () => {
  test('keeps native World Info and Databank visibly outside Loom ownership', async () => {
    const { container } = renderPanel()
    await settle()

    const notice = container.querySelector<HTMLElement>('[role="note"]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('nativeContextNotice')
  })

  test('keeps one dirty draft across sections and submits config with prompt blocks once', async () => {
    const saves: Array<{
      draft: AgenticRuntimeSaveDraft
      promptOrder: PromptBlock[]
      expectedIdentity: { presetId: string; presetRevision: number; configRevision: number }
    }> = []
    const dirtyStates: boolean[] = []
    const { container } = renderPanel({
      onSave: async (savedDraft, promptOrder, expectedIdentity) => {
        saves.push({ draft: savedDraft, promptOrder, expectedIdentity })
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
    expect(saves[0]?.expectedIdentity).toEqual({
      presetId: 'preset-1',
      presetRevision: 8,
      configRevision: 4,
    })
    expect(saves[0]?.draft.config.profiles[0]?.name).toBe('Evidence analyst')
    expect(saves[0]?.draft.config.profiles[0]?.toolIds).toEqual(['lore_search_entries'])
    expect(saves[0]?.promptOrder.map((item) => item.id)).toEqual(['policy-block'])
    expect(dirtyStates.at(-1)).toBe(false)
  })

  test('accepts its own saved revision before parent hydration and still conflicts on a later writer', async () => {
    const value = preset()
    value.agentConfig!.maxToolCalls = 63
    const dirtyStates: boolean[] = []
    let root!: Root
    let committed!: LoomPreset
    const onSave = async (
      draft: AgenticRuntimeSaveDraft,
      nextPromptOrder: PromptBlock[],
      _expectedIdentity: { presetId: string; presetRevision: number; configRevision: number },
      acceptSnapshot: (result: SaveAgenticRuntimeEditorResult) => boolean,
    ) => {
      await Promise.resolve()
      const result = saveResult(value, draft, nextPromptOrder)
      committed = {
        ...value,
        blocks: structuredClone(nextPromptOrder),
        cacheRevision: result.editor.presetRevision,
        agentConfigRevision: result.editor.configRevision,
        agentConfig: structuredClone(result.editor.config),
        agentConfigReview: structuredClone(result.editor.review),
        agentSlotBindings: { ...result.editor.slotBindings },
        agentTaskTemplates: structuredClone(result.editor.taskTemplates),
      }
      editorPresetRevision = result.editor.presetRevision
      editorConfigRevision = result.editor.configRevision
      editorConfig = structuredClone(result.editor.config)
      editorReview = structuredClone(result.editor.review)
      expect(acceptSnapshot(result)).toBe(true)
      flushSync(() => root.render(createElement(AgenticRuntimePanel, {
        preset: committed,
        onSave,
        onReload: async () => reloadResult(committed),
        onDirtyChange: (dirty) => { dirtyStates.push(dirty) },
      })))
      return result
    }
    const rendered = renderPanel({
      value,
      onSave,
      onDirtyChange: (dirty) => { dirtyStates.push(dirty) },
    })
    root = rendered.root
    const { container } = rendered
    await settle()

    flushSync(() => button(container, 'sections.tools.nav').click())
    const maxToolCalls = container.querySelector<HTMLInputElement>('#agents-max-tool-calls')!
    changeInput(maxToolCalls, '62')
    flushSync(() => button(container, 'save.action').click())
    await settle()

    expect(container.textContent).toContain('save.saved')
    expect(container.textContent).not.toContain('save.conflict')
    expect(container.textContent).not.toContain('save.reviewLatest')
    expect(maxToolCalls.value).toBe('62')
    expect(dirtyStates.at(-1)).toBe(false)

    changeInput(maxToolCalls, '61')
    const externalConfig = structuredClone(committed.agentConfig!)
    externalConfig.maxToolCalls = 60
    const external = {
      ...committed,
      cacheRevision: (committed.cacheRevision ?? 0) + 1,
      agentConfigRevision: committed.agentConfigRevision + 1,
      agentConfig: externalConfig,
    }
    editorPresetRevision = external.cacheRevision ?? 0
    editorConfigRevision = external.agentConfigRevision
    editorConfig = structuredClone(external.agentConfig)
    flushSync(() => root.render(createElement(AgenticRuntimePanel, {
      preset: external,
      onSave,
      onReload: async () => reloadResult(external),
      onDirtyChange: (dirty) => { dirtyStates.push(dirty) },
    })))
    await settle()

    expect(maxToolCalls.value).toBe('61')
    expect(container.textContent).toContain('save.conflict')
    expect(container.textContent).toContain('save.reviewLatest')
    expect(dirtyStates.at(-1)).toBe(true)
  })

  test('fences draft and numeric edits while a save is already in flight', async () => {
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
    expect(name.disabled).toBe(true)
    changeInput(name, 'Overwritten while saving')
    flushSync(() => button(container, 'sections.tools.nav').click())
    const maxInvocations = container.querySelector<HTMLInputElement>('#agents-max-invocations')!
    expect(maxInvocations.disabled).toBe(true)
    changeInput(maxInvocations, '72')
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.config.profiles[0]?.name).toBe('Evidence analyst')
    expect(submitted[0]?.config.maxInvocations).toBe(64)
    release()
    await settle()
    expect(maxInvocations.value).toBe('64')
    flushSync(() => button(container, 'sections.agents.nav').click())
    expect(name.value).toBe('Evidence analyst')
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
      onReload: async () => reloadResult(refreshed),
      onDirtyChange: () => {},
    })))
    await settle()

    expect(container.querySelector<HTMLInputElement>('input[value="Unsaved through refresh"]')).not.toBeNull()
    expect(container.textContent).toContain('save.conflict')
  })

  test('keeps four fixed Loom buckets with optional typed conditions', async () => {
    const value = preset()
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const panel = container.querySelector<HTMLElement>('#agentic-runtime-panel')
    expect(tabs).toHaveLength(7)
    expect(panel).not.toBeNull()
    for (const tab of tabs) {
      expect(tab.getAttribute('aria-controls')).toBe('agentic-runtime-panel')
    }
    flushSync(() => button(container, 'sections.agents.nav').click())
    expect(container.querySelector<HTMLElement>('[role="list"]')?.querySelectorAll('[role="listitem"]').length).toBe(1)
    const toolsTab = tabs.find((tab) => tab.textContent?.includes('sections.tools.nav'))!
    flushSync(() => toolsTab.click())
    expect(panel?.getAttribute('aria-labelledby')).toBe(toolsTab.id)
    flushSync(() => button(container, 'sections.phases.nav').click())
    for (const policyKey of ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy']) {
      expect(container.textContent).toContain(`phases.${policyKey}.title`)
    }
    const blockToggle = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.closest('label')?.textContent?.includes('Work policy'))
    expect(blockToggle).not.toBeNull()
    flushSync(() => blockToggle!.click())
    const conditionToggle = container.querySelector<HTMLInputElement>('input[aria-label="phases.conditionFor"]')
    expect(conditionToggle).not.toBeNull()
    expect(conditionToggle!.checked).toBe(false)
    flushSync(() => conditionToggle!.click())
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves[0]?.config.runtimePolicy?.loomPolicy.workPolicy[0]?.condition).toEqual({
      kind: 'phase',
      value: 'WORK',
    })
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

  test('canonicalizes workspace capabilities regardless of selection order', async () => {
    const value = preset()
    value.agentConfig!.profiles[0]!.workspaceCapabilities = []
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    const capability = (key: string) => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.closest('label')?.textContent?.includes(`agentRun.tools.${key}`))
    const readPage = capability('workspace_read_page')
    const readSection = capability('workspace_read_section')
    expect(readPage).not.toBeNull()
    expect(readSection).not.toBeNull()
    flushSync(() => readPage!.click())
    flushSync(() => readSection!.click())
    flushSync(() => button(container, 'save.action').click())
    await settle()

    expect(saves).toHaveLength(1)
    expect(saves[0]?.config.profiles[0]?.workspaceCapabilities).toEqual(['read_section', 'read_page'])
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
  test('repairs task-transition predicates when deleting a task template', async () => {
    const removedTask = { id: 'remove_me', required: true, activation: { kind: 'phase' as const, value: 'WORK' as const } }
    const keeperTask = {
      id: 'keeper',
      required: true,
      activation: {
        kind: 'all' as const,
        children: [
          { kind: 'task_transition' as const, taskId: 'remove_me', transition: 'completed' as const },
          { kind: 'phase' as const, value: 'WORK' as const },
        ],
      },
    }
    const emptyAnyTask = {
      id: 'empty_any',
      required: false,
      activation: {
        kind: 'any' as const,
        children: [{ kind: 'task_transition' as const, taskId: 'remove_me', transition: 'failed' as const }],
      },
    }
    const emptyAllTask = {
      id: 'empty_all',
      required: false,
      activation: {
        kind: 'all' as const,
        children: [{ kind: 'task_transition' as const, taskId: 'remove_me', transition: 'failed' as const }],
      },
    }
    editorTaskTemplates = [removedTask, keeperTask, emptyAnyTask, emptyAllTask]
    const runtimeTaskPhase = customPhase('phase_task_refs', {
      enter: {
        kind: 'all',
        children: [
          { kind: 'task_transition', taskId: 'remove_me', transition: 'active' },
          { kind: 'task_transition', taskId: 'keeper', transition: 'active' },
        ],
      },
      exit: {
        kind: 'any',
        children: [{ kind: 'task_transition', taskId: 'remove_me', transition: 'failed' }],
      },
      skip: {
        kind: 'all',
        children: [
          { kind: 'task_transition', taskId: 'remove_me', transition: 'active' },
          { kind: 'task_transition', taskId: 'keeper', transition: 'completed' },
        ],
      },
    })
    const runtimeTaskPolicyEntry = workPolicyEntry({
      kind: 'all',
      children: [
        { kind: 'task_transition', taskId: 'remove_me', transition: 'active' },
        { kind: 'task_transition', taskId: 'keeper', transition: 'completed' },
      ],
    })
    const value = preset()
    value.agentConfig!.runtimePolicy = runtimePolicy([runtimeTaskPhase], [runtimeTaskPolicyEntry])
    value.agentConfig!.taskPolicy = { templateIds: ['remove_me', 'keeper', 'empty_any', 'empty_all'] }
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
    expect(removeButtons).toHaveLength(4)
    flushSync(() => removeButtons[0]!.click())
    expect(button(container, 'save.action').disabled).toBe(false)
    flushSync(() => button(container, 'save.action').click())
    await settle()

    expect(saves).toHaveLength(1)
    expect(saves[0]?.taskTemplates).toEqual([
      {
        id: 'keeper',
        required: true,
        activation: { kind: 'all', children: [{ kind: 'phase', value: 'WORK' }] },
      },
      {
        id: 'empty_any',
        required: false,
        activation: { kind: 'any', children: [] },
      },
      {
        id: 'empty_all',
        required: false,
        activation: { kind: 'all', children: [] },
      },
    ])
    expect(saves[0]?.config.runtimePolicy?.phases[0]?.enter).toEqual({
      kind: 'all',
      children: [{ kind: 'task_transition', taskId: 'keeper', transition: 'active' }],
    })
    expect(saves[0]?.config.runtimePolicy?.phases[0]?.exit).toEqual({
      kind: 'any',
      children: [],
    })
    expect(saves[0]?.config.runtimePolicy?.phases[0]?.skip).toEqual({
      kind: 'all',
      children: [{ kind: 'task_transition', taskId: 'keeper', transition: 'completed' }],
    })
    expect(saves[0]?.config.runtimePolicy?.loomPolicy?.workPolicy[0]?.condition).toEqual({
      kind: 'all',
      children: [{ kind: 'task_transition', taskId: 'keeper', transition: 'completed' }],
    })
  })
  test('removes a third enter-condition child and persists the original pair', async () => {
    const originalEnter = {
      kind: 'all' as const,
      children: [
        { kind: 'generation_type' as const, value: 'normal' as const },
        { kind: 'phase' as const, value: 'WORK' as const },
      ],
    }
    const contaminatedEnter = {
      ...originalEnter,
      children: [
        ...originalEnter.children,
        { kind: 'preset_variable' as const, name: 'variable', operator: 'present' as const },
      ],
    }
    const value = preset()
    value.agentConfig!.runtimePolicy = runtimePolicy([
      customPhase('snapshot_exact_inputs', {
        label: 'Snapshot exact inputs',
        enter: contaminatedEnter,
      }),
    ])
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container, root } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.phases.nav').click())

    const enterFieldset = [...container.querySelectorAll('fieldset')].find((fieldset) => (
      fieldset.querySelector(':scope > legend')?.textContent === 'customPhases.enter'
    ))
    expect(enterFieldset).not.toBeNull()
    const childRows = [...enterFieldset!.querySelectorAll<HTMLElement>('.predicateChild')]
    expect(childRows).toHaveLength(3)
    const thirdRemove = childRows[2]!.querySelector<HTMLButtonElement>('[aria-label="predicate.remove"]')
    expect(thirdRemove).not.toBeNull()
    expect(thirdRemove!.disabled).toBe(false)
    flushSync(() => thirdRemove!.click())

    expect(enterFieldset!.querySelectorAll('.predicateChild')).toHaveLength(2)
    expect(button(container, 'save.action').disabled).toBe(false)
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves).toHaveLength(1)
    expect(saves[0]?.config.runtimePolicy?.phases[0]?.enter).toEqual(originalEnter)

    const reloaded = structuredClone(value)
    reloaded.agentConfig = structuredClone(saves[0]!.config)
    reloaded.cacheRevision = (value.cacheRevision ?? 0) + 1
    reloaded.agentConfigRevision = value.agentConfigRevision + 1
    unmountRoot(root)
    const remounted = renderPanel({ value: reloaded })
    await settle()
    flushSync(() => button(remounted.container, 'sections.phases.nav').click())
    const reloadedEnter = [...remounted.container.querySelectorAll('fieldset')].find((fieldset) => (
      fieldset.querySelector(':scope > legend')?.textContent === 'customPhases.enter'
    ))
    expect(reloadedEnter?.querySelectorAll('.predicateChild')).toHaveLength(2)
    expect(button(remounted.container, 'save.action').disabled).toBe(true)
  })
  test('disables predicate remove until the editor hydrates', async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    editorGetGate = promise
    const originalEnter = {
      kind: 'all' as const,
      children: [
        { kind: 'generation_type' as const, value: 'normal' as const },
        { kind: 'phase' as const, value: 'WORK' as const },
      ],
    }
    const value = preset()
    value.agentConfig!.runtimePolicy = runtimePolicy([
      customPhase('snapshot_exact_inputs', {
        label: 'Snapshot exact inputs',
        enter: {
          ...originalEnter,
          children: [
            ...originalEnter.children,
            { kind: 'preset_variable' as const, name: 'variable', operator: 'present' as const },
          ],
        },
      }),
    ])
    const { container } = renderPanel({ value })
    expect(container.textContent).toContain('load.loading')
    expect(container.querySelector('[aria-label="predicate.remove"]')).toBeNull()
    expect(button(container, 'save.action').disabled).toBe(true)

    resolve()
    await settle()
    expect(container.textContent).toContain('save.saved')
    flushSync(() => button(container, 'sections.phases.nav').click())
    const enterFieldset = [...container.querySelectorAll('fieldset')].find((fieldset) => (
      fieldset.querySelector(':scope > legend')?.textContent === 'customPhases.enter'
    ))
    expect(enterFieldset).not.toBeNull()
    const childRows = [...enterFieldset!.querySelectorAll<HTMLElement>('.predicateChild')]
    expect(childRows).toHaveLength(3)
    const thirdRemove = childRows[2]!.querySelector<HTMLButtonElement>('[aria-label="predicate.remove"]')
    expect(thirdRemove).not.toBeNull()
    expect(thirdRemove!.disabled).toBe(false)
    flushSync(() => thirdRemove!.click())
    expect(enterFieldset!.querySelectorAll('.predicateChild')).toHaveLength(2)
    expect(button(container, 'save.action').disabled).toBe(false)
  })
  test('recovers a post-save stale shell so the third enter child can be removed', async () => {
    const originalEnter = {
      kind: 'all' as const,
      children: [
        { kind: 'generation_type' as const, value: 'normal' as const },
        { kind: 'phase' as const, value: 'WORK' as const },
      ],
    }
    const value = preset()
    value.agentConfig!.runtimePolicy = runtimePolicy([
      customPhase('snapshot_exact_inputs', {
        label: 'Snapshot exact inputs',
        enter: originalEnter,
      }),
    ])
    const saves: AgenticRuntimeSaveDraft[] = []
    let latestResult: SaveAgenticRuntimeEditorResult | null = null
    const { container, root } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        latestResult = saveResult(value, draft, promptOrder)
        return latestResult
      },
      onReload: async () => {
        const committed = latestResult
        if (!committed) throw new Error('Expected a committed editor snapshot')
        editorPresetRevision = committed.editor.presetRevision
        editorConfigRevision = committed.editor.configRevision
        editorConfig = structuredClone(committed.editor.config)
        const refreshed = structuredClone(value)
        refreshed.agentConfig = structuredClone(committed.editor.config)
        refreshed.cacheRevision = committed.editor.presetRevision
        refreshed.agentConfigRevision = committed.editor.configRevision
        flushSync(() => root.render(createElement(AgenticRuntimePanel, {
          preset: refreshed,
          onSave: async (draft, promptOrder) => {
            saves.push(structuredClone(draft))
            latestResult = saveResult(refreshed, draft, promptOrder)
            return latestResult
          },
          onReload: async () => reloadResult(refreshed),
          onDirtyChange: () => {},
        })))
        return committed
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.phases.nav').click())
    const enterFieldset = () => [...container.querySelectorAll('fieldset')].find((fieldset) => (
      fieldset.querySelector(':scope > legend')?.textContent === 'customPhases.enter'
    ))
    flushSync(() => {
      const add = [...enterFieldset()!.querySelectorAll('button')].find((candidate) => (
        candidate.textContent?.includes('predicate.add')
      ))
      add!.click()
    })
    const addedRows = [...enterFieldset()!.querySelectorAll<HTMLElement>('.predicateChild')]
    expect(addedRows).toHaveLength(3)
    const thirdKind = addedRows[2]!.querySelector<HTMLSelectElement>('select')
    expect(thirdKind).not.toBeNull()
    changeSelect(thirdKind!, 'preset_variable')
    flushSync(() => button(container, 'save.action').click())
    await settle()

    expect(saves).toHaveLength(1)
    expect(container.textContent).toContain('save.saved')
    expect(container.textContent).not.toContain('load.loading')
    const recoveredRows = [...enterFieldset()!.querySelectorAll<HTMLElement>('.predicateChild')]
    expect(recoveredRows).toHaveLength(3)
    const recoveredRemove = recoveredRows[2]!.querySelector<HTMLButtonElement>('[aria-label="predicate.remove"]')
    expect(recoveredRemove).not.toBeNull()
    expect(recoveredRemove!.disabled).toBe(false)
    flushSync(() => recoveredRemove!.click())
    expect(enterFieldset()!.querySelectorAll('.predicateChild')).toHaveLength(2)
    expect(button(container, 'save.action').disabled).toBe(false)
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves).toHaveLength(2)
    expect(saves[1]?.config.runtimePolicy?.phases[0]?.enter).toEqual(originalEnter)

  })



  test('quarantines malformed imported task templates until explicitly discarded', async () => {
    editorTaskTemplates = [{
      id: 'bad_task',
      required: true,
      activation: { kind: 'invalid' },
    }]
    const value = preset()
    value.agentConfig!.taskPolicy = { templateIds: ['bad_task'] }
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
  test('repairs runtime task predicates when discarding a quarantined task template', async () => {
    editorTaskTemplates = [
      { id: 'bad_task', required: true, activation: { kind: 'invalid' } },
      { id: 'keeper', required: true, activation: { kind: 'phase', value: 'WORK' } },
    ]
    const value = preset()
    value.agentConfig!.taskPolicy = { templateIds: ['bad_task', 'keeper'] }
    value.agentConfig!.runtimePolicy = runtimePolicy([
      customPhase('phase_quarantine', {
        enter: {
          kind: 'all',
          children: [
            { kind: 'task_transition', taskId: 'bad_task', transition: 'active' },
            { kind: 'task_transition', taskId: 'keeper', transition: 'active' },
          ],
        },
      }),
    ], [
      workPolicyEntry({
        kind: 'any',
        children: [{ kind: 'task_transition', taskId: 'bad_task', transition: 'failed' }],
      }),
    ])
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
    const discard = container.querySelector<HTMLButtonElement>('[aria-label="tasks.discardQuarantined"]')
    expect(discard).not.toBeNull()
    await act(async () => {
      discard!.click()
    })
    await settle()
    await act(async () => {
      button(container, 'save.action').click()
    })
    await settle()

    expect(saves).toHaveLength(1)
    expect(saves[0]?.taskTemplates).toEqual([
      { id: 'keeper', required: true, activation: { kind: 'phase', value: 'WORK' } },
    ])
    expect(saves[0]?.config.taskPolicy).toEqual({ templateIds: ['keeper'] })
    expect(saves[0]?.config.runtimePolicy?.phases[0]?.enter).toEqual({
      kind: 'all',
      children: [{ kind: 'task_transition', taskId: 'keeper', transition: 'active' }],
    })
    expect(saves[0]?.config.runtimePolicy?.loomPolicy?.workPolicy[0]?.condition).toEqual({
      kind: 'any',
      children: [],
    })
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

  test('hydrates committed revision and policy values from the atomic save response', async () => {
    const committed = structuredClone(preset())
    committed.agentConfig!.profiles[0]!.name = 'Committed analyst'
    committed.cacheRevision = (committed.cacheRevision ?? 0) + 1
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
  test('does not let an unknown acknowledgement satisfy a server-derived review item', async () => {
    editorReviewAcknowledgements = ['unknown-review-id']
    const item: AgentConfigRepairItem = {
      id: 'import:review',
      kind: 'disabled_import',
      reasonCode: 'disabled_import',
      action: { kind: 'acknowledge' },
    }
    const { container } = renderPanel({ value: preset([item]) })
    await settle()
    expect(container.textContent).toContain('validation.review_acknowledgement_required')
    expect(button(container, 'save.action').disabled).toBe(true)
  })


  test('surfaces stale canonical Loom sources and never enables a partial save', async () => {
    const value = preset()
    const staleEntry = workPolicyEntry()
    value.agentConfig!.runtimePolicy = runtimePolicy([], [{
      ...staleEntry,
      source: {
        ...staleEntry.source,
        blockRevision: 2,
      },
    }])
    const { container } = renderPanel({ value })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    changeInput(container.querySelector<HTMLInputElement>('input[value="Researcher"]')!, 'Changed')

    expect(container.textContent).toContain('validation.stale_policy_source')
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
  test('preserves malformed runtime policy through unrelated edits until explicit discard', async () => {
    const value = preset()
    value.agentConfig!.runtimePolicy = {
      version: 1,
      authority: 'loom',
      scope: 'preset',
      defaultMode: 'response',
      loomPolicy: null,
      phases: [{ invalid: true }],
    } as unknown as AgentRuntimePolicyV1
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()

    flushSync(() => button(container, 'sections.agents.nav').click())
    changeInput(container.querySelector<HTMLInputElement>('input[value="Researcher"]')!, 'Preserved edit')
    flushSync(() => button(container, 'sections.repair.nav').click())
    expect(container.textContent).toContain('config.runtimePolicy.phases')
    expect(button(container, 'save.action').disabled).toBe(true)

    flushSync(() => button(container, 'repair.actions.discard').click())
    expect(container.textContent).not.toContain('validation.invalid_runtime_policy')
    flushSync(() => button(container, 'save.action').click())
    await settle()

    expect(saves).toHaveLength(1)
    expect(saves[0]?.config.profiles[0]?.name).toBe('Preserved edit')
    expect(saves[0]?.config.runtimePolicy?.phases).toEqual([])
  })

  test('rewrites custom-phase and Loom policy task references when a task ID changes', async () => {
    const value = preset()
    const task = {
      id: 'old_task',
      label: 'Old task',
      required: true,
      activation: { kind: 'phase' as const, value: 'WORK' as const },
    }
    value.agentTaskTemplates = [task]
    value.agentConfig!.taskPolicy = { templateIds: [task.id] }
    value.agentConfig!.runtimePolicy = runtimePolicy([
      customPhase('phase_one', {
        enter: { kind: 'task_transition', taskId: task.id, transition: 'active' },
      }),
    ], [
      workPolicyEntry({
        kind: 'task_transition',
        taskId: task.id,
        transition: 'completed',
      }),
    ])
    editorTaskTemplates = [structuredClone(task)]
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
    changeInput(container.querySelector<HTMLInputElement>('input[value="old_task"]')!, 'renamed_task')
    flushSync(() => button(container, 'save.action').click())
    await settle()

    expect(saves).toHaveLength(1)
    expect(saves[0]?.config.runtimePolicy?.phases[0]?.enter).toEqual({
      kind: 'task_transition',
      taskId: 'renamed_task',
      transition: 'active',
    })
    expect(saves[0]?.config.runtimePolicy?.loomPolicy?.workPolicy[0]?.condition).toEqual({
      kind: 'task_transition',
      taskId: 'renamed_task',
      transition: 'completed',
    })
  })


  test('shows automatic phase transitions and custom instructions in Response omission', async () => {
    const value = preset()
    value.agentConfig!.runtimePolicy = runtimePolicy([
      customPhase('phase_one', {
        label: 'First phase',
        instructionRefs: [loomSource()],
      }),
      customPhase('phase_two', { label: 'Second phase' }),
    ])
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()

    flushSync(() => button(container, 'sections.phases.nav').click())
    expect(container.textContent).toContain('phases.responseOmissionPhaseInstruction')
    expect(container.textContent).toContain('customPhases.transitionAutomatic')
    expect(container.textContent).toContain('customPhases.transitionAutomaticNext')
    flushSync(() => button(container, 'customPhases.useExplicitTransitions').click())
    const explicitNext = [...container.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.textContent?.includes('customPhases.nextTarget'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(explicitNext?.checked).toBe(true)

    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves[0]?.config.runtimePolicy?.phases[0]?.nextPhaseIds).toEqual(['phase_two'])
  })


  test('supports roving keyboard tabs with focus following selection', async () => {
    const { container } = renderPanel()
    await settle()
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs).toHaveLength(7)
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

  test('keeps the intentional local fallback for a missing editor projection', async () => {
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
    expect(container.textContent).not.toContain('load.error')
    expect(container.textContent).toContain('save.saved')
    flushSync(() => enable!.click())
    expect(enable!.getAttribute('aria-checked')).toBe('true')
    expect(container.textContent).not.toContain('validation.invalid_config')
  })

  test('fails closed with a visible retry for a clean editor load failure', async () => {
    editorGetError = new ApiError(500, 'Internal Server Error')
    const value = preset()
    const { container } = renderPanel({ value })
    await settle()
    expect(container.textContent).toContain('load.error')
    expect(container.textContent).toContain('load.retry')
    expect(container.textContent).not.toContain('save.saved')
    expect(container.querySelector('[role="tab"]')).toBeNull()
    expect(container.querySelector<HTMLInputElement>('input[value="Researcher"]')).toBeNull()
    expect(button(container, 'save.action').disabled).toBe(true)
  })

  test('preserves dirty conflict semantics while showing a non-404 load failure', async () => {
    const value = preset()
    const dirtyStates: boolean[] = []
    const { container, root } = renderPanel({
      value,
      onDirtyChange: (dirty) => { dirtyStates.push(dirty) },
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    const name = container.querySelector<HTMLInputElement>('input[value="Researcher"]')!
    changeInput(name, 'Unsaved analyst')
    expect(dirtyStates.at(-1)).toBe(true)

    editorGetError = new ApiError(500, 'Internal Server Error')
    const refreshed = { ...value, cacheRevision: (value.cacheRevision ?? 0) + 1 }
    flushSync(() => root.render(createElement(AgenticRuntimePanel, {
      preset: refreshed,
      onSave: async (draft, promptOrder) => saveResult(refreshed, draft, promptOrder),
      onReload: async () => reloadResult(refreshed),
      onDirtyChange: (dirty) => { dirtyStates.push(dirty) },
    })))
    await settle()

    expect(container.textContent).toContain('load.error')
    expect(container.textContent).toContain('save.conflict')
    expect(container.querySelector<HTMLInputElement>('input[value="Unsaved analyst"]')).toBeNull()
    expect(button(container, 'save.action').disabled).toBe(true)
    expect(dirtyStates.at(-1)).toBe(true)
  })

  test('retries a failed editor load and restores the hydrated save state', async () => {
    editorGetError = new ApiError(500, 'Internal Server Error')
    const value = preset()
    const { container } = renderPanel({ value })
    await settle()
    expect(container.textContent).toContain('load.error')

    editorGetError = null
    flushSync(() => button(container, 'load.retry').click())
    await settle()

    expect(container.querySelector('[role="tab"]')).not.toBeNull()
    expect(container.textContent).not.toContain('load.error')
    expect(container.textContent).toContain('save.saved')
    const enable = container.querySelector<HTMLButtonElement>('[aria-label="activation.enable"]')
    expect(enable).not.toBeNull()
    expect(enable!.disabled).toBe(false)
  })

  test('fails closed when the editor projection is structurally invalid', async () => {
    editorProjectionInvalid = true
    const value = preset()
    const { container } = renderPanel({ value })
    await settle()

    expect(container.textContent).toContain('load.error')
    expect(container.textContent).toContain('load.retry')
    expect(container.textContent).not.toContain('save.saved')
    expect(container.querySelector('[role="tab"]')).toBeNull()
    expect(button(container, 'save.action').disabled).toBe(true)
  })

  test('preserves a dirty 404 conflict until an exact reload is available', async () => {
    const value = preset()
    const dirtyStates: boolean[] = []
    const { container, root } = renderPanel({
      value,
      onDirtyChange: (dirty) => { dirtyStates.push(dirty) },
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    const name = container.querySelector<HTMLInputElement>('input[value="Researcher"]')!
    changeInput(name, 'Unsaved analyst')

    editorGetError = new ApiError(404, 'Not Found')
    const refreshed = { ...value, cacheRevision: (value.cacheRevision ?? 0) + 1 }
    flushSync(() => root.render(createElement(AgenticRuntimePanel, {
      preset: refreshed,
      onSave: async (draft, promptOrder) => saveResult(refreshed, draft, promptOrder),
      onReload: async () => reloadResult(refreshed),
      onDirtyChange: (dirty) => { dirtyStates.push(dirty) },
    })))
    await settle()

    expect(container.textContent).toContain('load.error')
    expect(container.textContent).toContain('save.conflict')
    expect(container.textContent).toContain('save.reloadLatest')
    expect(container.querySelector('[role="tab"]')).toBeNull()
    expect(button(container, 'save.reset').disabled).toBe(true)
    expect(dirtyStates.at(-1)).toBe(true)

    flushSync(() => button(container, 'save.reloadLatest').click())
    await settle()
    expect(container.querySelector('[role="tab"]')).not.toBeNull()
    expect(container.textContent).toContain('save.saved')
    expect(container.textContent).not.toContain('load.error')
    expect(dirtyStates.at(-1)).toBe(false)
  })

  test('hides the previous hydrated editor immediately when the preset changes', async () => {
    const value = preset()
    const { container, root } = renderPanel({ value })
    await settle()
    expect(container.textContent).toContain('save.saved')

    editorGetError = new ApiError(500, 'Internal Server Error')
    const refreshed = { ...value, id: `${value.id}-next` }
    flushSync(() => root.render(createElement(AgenticRuntimePanel, {
      preset: refreshed,
      onSave: async (draft, promptOrder) => saveResult(refreshed, draft, promptOrder),
      onReload: async () => reloadResult(refreshed),
      onDirtyChange: () => {},
    })))

    expect(container.querySelector('[role="tab"]')).toBeNull()
    expect(container.textContent).not.toContain('save.saved')
    expect(button(container, 'save.action').disabled).toBe(true)
    await settle()
    expect(container.textContent).toContain('load.error')
  })

  test('rejects a mismatched Retry pair and keeps the editor closed', async () => {
    editorGetError = new ApiError(500, 'Internal Server Error')
    const value = preset()
    const { container } = renderPanel({
      value,
      onReload: async () => {
        const mismatched = reloadResult(value)
        mismatched.preset = {
          ...mismatched.preset,
          agent_config_revision: mismatched.editor.configRevision + 1,
        }
        return mismatched
      },
    })
    await settle()
    expect(container.textContent).toContain('load.error')

    flushSync(() => button(container, 'load.retry').click())
    await settle()

    expect(container.querySelector('[role="tab"]')).toBeNull()
    expect(container.textContent).toContain('load.error')
    expect(container.textContent).toContain('save.reloadError')
    expect(button(container, 'save.action').disabled).toBe(true)
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

  test('updates nested All/Any leaf selects without rewriting siblings', async () => {
    const evidence = { id: 'evidence', required: true, activation: { kind: 'phase' as const, value: 'WORK' as const } }
    const keeper = { id: 'keeper', required: true, activation: { kind: 'phase' as const, value: 'WORK' as const } }
    editorTaskTemplates = [evidence, keeper]
    const enter = {
      kind: 'all' as const,
      children: [
        { kind: 'generation_type' as const, value: 'normal' as const },
        { kind: 'phase' as const, value: 'WORK' as const },
        {
          kind: 'any' as const,
          children: [
            { kind: 'task_transition' as const, taskId: 'evidence', transition: 'active' as const },
            { kind: 'task_transition' as const, taskId: 'keeper', transition: 'failed' as const },
          ],
        },
      ],
    }
    const value = preset()
    value.agentConfig!.runtimePolicy = runtimePolicy([
      customPhase('typed_checkpoints', { enter }),
    ])
    value.agentConfig!.taskPolicy = { templateIds: ['evidence', 'keeper'] }
    const dirtyStates: boolean[] = []
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container, root } = renderPanel({
      value,
      onDirtyChange: (dirty) => { dirtyStates.push(dirty) },
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.phases.nav').click())
    const enterFieldset = [...container.querySelectorAll('fieldset')].find((fieldset) => (
      fieldset.querySelector(':scope > legend')?.textContent === 'customPhases.enter'
    ))
    expect(enterFieldset).not.toBeNull()
    const generationType = enterFieldset!.querySelector<HTMLSelectElement>('select[aria-label="predicate.generationType"]')
    const currentPhase = enterFieldset!.querySelector<HTMLSelectElement>('select[aria-label="predicate.phase"]')
    const transitions = [...enterFieldset!.querySelectorAll<HTMLSelectElement>('select[aria-label="predicate.transition"]')]
    expect(generationType?.value).toBe('normal')
    expect(currentPhase?.value).toBe('WORK')
    expect(transitions.map((control) => control.value)).toEqual(['active', 'failed'])

    changeSelect(generationType!, 'continue')
    changeSelect(currentPhase!, 'COMPLETE')
    changeSelect(transitions[0]!, 'completed')

    expect(dirtyStates.at(-1)).toBe(true)
    expect(button(container, 'save.action').disabled).toBe(false)
    expect(enterFieldset!.querySelector<HTMLSelectElement>('select[aria-label="predicate.generationType"]')?.value).toBe('continue')
    expect(enterFieldset!.querySelector<HTMLSelectElement>('select[aria-label="predicate.phase"]')?.value).toBe('COMPLETE')
    expect([...enterFieldset!.querySelectorAll<HTMLSelectElement>('select[aria-label="predicate.transition"]')].map((control) => control.value)).toEqual(['completed', 'failed'])
    expect([...enterFieldset!.querySelectorAll<HTMLSelectElement>('select[aria-label="predicate.task"]')].map((control) => control.value)).toEqual(['evidence', 'keeper'])

    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves).toHaveLength(1)
    expect(saves[0]?.config.runtimePolicy?.phases[0]?.enter).toEqual({
      kind: 'all',
      children: [
        { kind: 'generation_type', value: 'continue' },
        { kind: 'phase', value: 'COMPLETE' },
        {
          kind: 'any',
          children: [
            { kind: 'task_transition', taskId: 'evidence', transition: 'completed' },
            { kind: 'task_transition', taskId: 'keeper', transition: 'failed' },
          ],
        },
      ],
    })

    const reloaded = structuredClone(value)
    reloaded.agentConfig = structuredClone(saves[0]!.config)
    reloaded.cacheRevision = (value.cacheRevision ?? 0) + 1
    reloaded.agentConfigRevision = value.agentConfigRevision + 1
    unmountRoot(root)
    const remounted = renderPanel({ value: reloaded })
    await settle()
    flushSync(() => button(remounted.container, 'sections.phases.nav').click())
    const reloadedEnter = [...remounted.container.querySelectorAll('fieldset')].find((fieldset) => (
      fieldset.querySelector(':scope > legend')?.textContent === 'customPhases.enter'
    ))
    expect(reloadedEnter?.querySelector<HTMLSelectElement>('select[aria-label="predicate.generationType"]')?.value).toBe('continue')
    expect(reloadedEnter?.querySelector<HTMLSelectElement>('select[aria-label="predicate.phase"]')?.value).toBe('COMPLETE')
    expect([...reloadedEnter!.querySelectorAll<HTMLSelectElement>('select[aria-label="predicate.transition"]')].map((control) => control.value)).toEqual(['completed', 'failed'])
    expect(button(remounted.container, 'save.action').disabled).toBe(true)
  })

  test('authors a new nested task_transition completed leaf without rewriting All siblings', async () => {
    const evidence = { id: 'evidence', required: true, activation: { kind: 'phase' as const, value: 'WORK' as const } }
    editorTaskTemplates = [evidence]
    const originalEnter = {
      kind: 'all' as const,
      children: [
        { kind: 'generation_type' as const, value: 'normal' as const },
        { kind: 'phase' as const, value: 'WORK' as const },
      ],
    }
    const value = preset()
    value.agentConfig!.runtimePolicy = runtimePolicy([
      customPhase('completed_only', { enter: originalEnter, exit: originalEnter }),
    ])
    value.agentConfig!.taskPolicy = { templateIds: ['evidence'] }
    const saves: AgenticRuntimeSaveDraft[] = []
    const { container } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => {
        saves.push(structuredClone(draft))
        return saveResult(value, draft, promptOrder)
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.phases.nav').click())
    const exitFieldset = [...container.querySelectorAll('fieldset')].find((fieldset) => (
      fieldset.querySelector(':scope > legend')?.textContent === 'customPhases.exit'
    ))
    expect(exitFieldset).not.toBeNull()
    flushSync(() => {
      const add = [...exitFieldset!.querySelectorAll('button')].find((candidate) => (
        candidate.textContent?.includes('predicate.add')
      ))
      add!.click()
    })
    const childRows = [...exitFieldset!.querySelectorAll<HTMLElement>('.predicateChild')]
    expect(childRows).toHaveLength(3)
    const addedKind = childRows[2]!.querySelector<HTMLSelectElement>('select')
    expect(addedKind).not.toBeNull()
    changeSelect(addedKind!, 'task_transition')
    const addedTask = childRows[2]!.querySelector<HTMLSelectElement>('select[aria-label="predicate.task"]')
    const addedTransition = childRows[2]!.querySelector<HTMLSelectElement>('select[aria-label="predicate.transition"]')
    expect(addedTask).not.toBeNull()
    expect(addedTransition?.value).toBe('active')
    changeSelect(addedTask!, 'evidence')
    changeSelect(addedTransition!, 'completed')

    expect(exitFieldset!.querySelector<HTMLSelectElement>('select[aria-label="predicate.generationType"]')?.value).toBe('normal')
    expect(exitFieldset!.querySelector<HTMLSelectElement>('select[aria-label="predicate.phase"]')?.value).toBe('WORK')
    expect(childRows[2]!.querySelector<HTMLSelectElement>('select[aria-label="predicate.transition"]')?.value).toBe('completed')
    expect(button(container, 'save.action').disabled).toBe(false)
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves).toHaveLength(1)
    expect(saves[0]?.config.runtimePolicy?.phases[0]?.enter).toEqual(originalEnter)
    expect(saves[0]?.config.runtimePolicy?.phases[0]?.exit).toEqual({
      kind: 'all',
      children: [
        { kind: 'generation_type', value: 'normal' },
        { kind: 'phase', value: 'WORK' },
        { kind: 'task_transition', taskId: 'evidence', transition: 'completed' },
      ],
    })
  })

  test('resets local post-save edits without synthesizing an external conflict', async () => {
    const value = preset()
    const { container } = renderPanel({
      value,
      onSave: async (draft, promptOrder) => saveResult(value, draft, promptOrder),
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    changeInput(container.querySelector<HTMLInputElement>('input[value="Researcher"]')!, 'Saved analyst')
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(container.querySelector('input[value="Saved analyst"]')).not.toBeNull()

    changeInput(container.querySelector<HTMLInputElement>('input[value="Saved analyst"]')!, 'Unsaved analyst')
    expect(container.textContent).toContain('save.unsaved')
    expect(button(container, 'save.reset').disabled).toBe(false)
    flushSync(() => button(container, 'save.reset').click())

    expect(container.textContent).not.toContain('save.conflict')
    expect(container.textContent).not.toContain('save.reloadingLatest')
    expect(container.textContent).toContain('save.saved')
    expect(container.querySelector('input[value="Saved analyst"]')).not.toBeNull()
    expect(container.querySelector('input[value="Unsaved analyst"]')).toBeNull()
    expect(button(container, 'save.action').disabled).toBe(true)
  })

  test('keeps a genuine 409 conflict after local Reset draft', async () => {
    const value = preset()
    const { container } = renderPanel({
      value,
      onSave: async () => {
        throw new ApiError(409, 'Conflict')
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    changeInput(container.querySelector<HTMLInputElement>('input[value="Researcher"]')!, 'Unsaved analyst')
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(container.textContent).toContain('save.conflict')

    expect(button(container, 'save.reset').disabled).toBe(false)
    flushSync(() => button(container, 'save.reset').click())
    expect(container.textContent).toContain('save.conflict')
    expect(container.textContent).not.toContain('save.reloadingLatest')
    expect(button(container, 'save.action').disabled).toBe(true)
    expect(container.querySelector('input[value="Researcher"]')).not.toBeNull()
  })

  test('rejects a mismatched Reload latest pair and stays in conflict', async () => {
    const value = preset()
    const { container } = renderPanel({
      value,
      onSave: async () => {
        throw new ApiError(409, 'Conflict')
      },
      onReload: async () => {
        const mismatched = reloadResult(value)
        mismatched.preset = {
          ...mismatched.preset,
          cache_revision: mismatched.editor.presetRevision + 1,
        }
        return mismatched
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    changeInput(container.querySelector<HTMLInputElement>('input[value="Researcher"]')!, 'Unsaved analyst')
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(container.textContent).toContain('save.conflict')

    flushSync(() => button(container, 'save.reloadLatest').click())
    await settle()
    expect(container.textContent).not.toContain('save.reloadingLatest')
    expect(container.textContent).toContain('save.reloadError')
    expect(container.textContent).toContain('save.conflict')
    expect(container.querySelector('input[value="Unsaved analyst"]')).not.toBeNull()
  })

  test('Reload latest applies one exact prompt/config pair to the next save', async () => {
    const value = preset()
    const latestConfig = agentConfig()
    latestConfig.profiles[0]!.name = 'Latest analyst'
    const latestBlock = {
      ...promptBlock(7),
      name: 'Latest policy block',
      content: 'Use the latest prompt only.',
    }
    const latest: LoomPreset = {
      ...value,
      blocks: [latestBlock],
      agentConfig: latestConfig,
      cacheRevision: 9,
      agentConfigRevision: 5,
    }
    const saves: Array<{ draft: AgenticRuntimeSaveDraft; promptOrder: PromptBlock[] }> = []
    let root: Root
    const onSave = async (draft: AgenticRuntimeSaveDraft, promptOrder: PromptBlock[]) => {
      if (saves.length === 0 && draft.config.profiles[0]?.name === 'Unsaved analyst') {
        throw new ApiError(409, 'Conflict')
      }
      saves.push({ draft: structuredClone(draft), promptOrder: structuredClone(promptOrder) })
      return saveResult(latest, draft, promptOrder)
    }
    const onReload = async () => {
      editorPresetRevision = 9
      editorConfigRevision = 5
      editorConfig = structuredClone(latest.agentConfig)
      const result = reloadResult(latest)
      flushSync(() => root.render(createElement(AgenticRuntimePanel, {
        preset: latest,
        onSave,
        onReload: async () => reloadResult(latest),
        onDirtyChange: () => {},
      })))
      return result
    }
    const rendered = renderPanel({ value, onSave, onReload })
    root = rendered.root
    const { container } = rendered
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    changeInput(container.querySelector<HTMLInputElement>('input[value="Researcher"]')!, 'Unsaved analyst')
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(container.textContent).toContain('save.conflict')

    flushSync(() => button(container, 'save.reloadLatest').click())
    await settle()
    expect(container.textContent).not.toContain('save.reloadingLatest')
    expect(container.textContent).not.toContain('save.conflict')
    expect(container.textContent).toContain('save.saved')
    expect(container.querySelector('input[value="Unsaved analyst"]')).toBeNull()
    const latestName = container.querySelector<HTMLInputElement>('input[value="Latest analyst"]')
    expect(latestName).not.toBeNull()

    changeInput(latestName!, 'Post reload edit')
    flushSync(() => button(container, 'save.action').click())
    await settle()
    expect(saves).toHaveLength(1)
    expect(saves[0]?.draft.config.profiles[0]?.name).toBe('Post reload edit')
    expect(saves[0]?.promptOrder).toHaveLength(1)
    expect(saves[0]?.promptOrder[0]).toMatchObject(latestBlock)
  })

  test('failed reload latest leaves an actionable error and stays in conflict', async () => {
    const value = preset()
    const { container } = renderPanel({
      value,
      onSave: async () => {
        throw new ApiError(409, 'Conflict')
      },
      onReload: async () => {
        throw new Error('canonical reload failed')
      },
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    changeInput(container.querySelector<HTMLInputElement>('input[value="Researcher"]')!, 'Unsaved analyst')
    flushSync(() => button(container, 'save.action').click())
    await settle()

    flushSync(() => button(container, 'save.reloadLatest').click())
    await settle()
    expect(container.textContent).not.toContain('save.reloadingLatest')
    expect(container.textContent).toContain('save.reloadError')
    expect(container.textContent).toContain('save.conflict')
    expect(container.querySelector('input[value="Unsaved analyst"]')).not.toBeNull()
  })

  test('stale reload completion cannot overwrite a newer preset editor', async () => {
    const value = preset()
    let releaseReload: ((snapshot: SaveAgenticRuntimeEditorResult) => void) | undefined
    const { container, root } = renderPanel({
      value,
      onSave: async () => {
        throw new ApiError(409, 'Conflict')
      },
      onReload: () => new Promise<SaveAgenticRuntimeEditorResult>((resolve) => {
        releaseReload = resolve
      }),
    })
    await settle()
    flushSync(() => button(container, 'sections.agents.nav').click())
    changeInput(container.querySelector<HTMLInputElement>('input[value="Researcher"]')!, 'Unsaved analyst')
    flushSync(() => button(container, 'save.action').click())
    await settle()
    flushSync(() => button(container, 'save.reloadLatest').click())
    expect(container.textContent).toContain('save.reloadingLatest')

    const next = { ...preset(), id: 'preset-2', name: 'Other preset' }
    editorPresetRevision = 8
    editorConfigRevision = 4
    editorConfig = structuredClone(next.agentConfig)
    flushSync(() => root.render(createElement(AgenticRuntimePanel, {
      preset: next,
      onSave: async (draft, promptOrder) => saveResult(next, draft, promptOrder),
      onReload: async () => reloadResult(next),
      onDirtyChange: () => {},
    })))
    await settle()
    expect(container.textContent).not.toContain('save.reloadingLatest')
    releaseReload?.({
      preset: wirePreset({ ...value, cacheRevision: 9, agentConfigRevision: 5 }),
      editor: {
        presetId: value.id,
        presetRevision: 9,
        configRevision: 5,
        config: value.agentConfig,
        review: value.agentConfigReview,
        slotBindings: {},
        taskTemplates: [],
        reviewAcknowledgements: [],
        hostCeilings,
      },
    })
    await settle()

    expect(container.textContent).not.toContain('save.reloadingLatest')
    expect(container.textContent).not.toContain('save.reloadError')
    expect(container.querySelector('input[value="Unsaved analyst"]')).not.toBeNull()
  })



})
