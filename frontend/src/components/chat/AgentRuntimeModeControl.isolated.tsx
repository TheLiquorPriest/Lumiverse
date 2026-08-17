import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import * as actualReactI18next from 'react-i18next'
import type { EffectiveRuntimeState } from '@/hooks/useEffectiveRuntime'

const selectCalls: string[] = []
const overrideCalls: Array<string | null> = []

const readyDecision: NonNullable<EffectiveRuntimeState['decision']> = {
  version: 1,
  chatId: 'chat-1',
  target: { generationType: 'normal' },
  connection: {
    id: 'connection-1',
    label: 'Primary',
    provider: 'provider',
    model: 'model',
    revision: 1,
    endpointRevision: 1,
    credentialRevision: 1,
    candidateRevision: 1,
  },
  preset: { id: 'preset-1', label: 'Preset', revision: 1, source: 'chat' },
  agentsEnabled: true,
  allowedModes: ['response', 'agentic'],
  defaultMode: 'response',
  requestedMode: 'response',
  effectiveMode: 'response',
  chatOverride: null,
  capabilityReadiness: {
    ready: true,
    sameDomain: true,
    required: ['generation'],
    missing: [],
    repairCodes: [],
    responseEscape: 'available',
  },
  repairCodes: [],
}

let hookState: EffectiveRuntimeState

mock.module('@/hooks/useEffectiveRuntime', () => ({
  useEffectiveRuntime: () => hookState,
}))
// Keep every react-i18next export available to tests that share this module
// graph; only a complete pass-through mock is needed for this focused seam.
mock.module('react-i18next', () => ({ ...actualReactI18next }))
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['navigator', globalObject.navigator],
  ['Node', globalObject.Node],
  ['Element', globalObject.Element],
  ['HTMLElement', globalObject.HTMLElement],
  ['SVGElement', globalObject.SVGElement],
  ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})

// The hook and translation mocks must be installed before the component captures them.
const { default: AgentRuntimeModeControl } = await import('./AgentRuntimeModeControl')
const { createRoot } = await import('react-dom/client')
mock.restore()
const mountedRoots = new Set<Root>()

function baseState(overrides: Partial<EffectiveRuntimeState> = {}): EffectiveRuntimeState {
  return {
    decision: readyDecision,
    mode: 'response',
    oneTurnMode: null,
    loading: false,
    savingOverride: false,
    error: null,
    canShowSelector: true,
    repairCategories: [],
    selectOneTurnMode(mode) {
      selectCalls.push(mode)
    },
    async saveChatOverride(mode) {
      overrideCalls.push(mode)
    },
    async refresh() {},
    ...overrides,
  }
}

async function renderControl(): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mountedRoots.add(root)
  await act(async () => {
    root.render(<AgentRuntimeModeControl chatId="chat-1" generationType="normal" />)
  })
  return { host, root }
}

beforeEach(() => {
  hookState = baseState()
  selectCalls.length = 0
  overrideCalls.length = 0
})

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => root.unmount())
  }
  mountedRoots.clear()
  document.body.replaceChildren()
})

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
  dom.window.close()
})

describe('AgentRuntimeModeControl', () => {
  test('hides Agentic controls until both modes and the complete readiness union are ready', async () => {
    hookState = baseState({ canShowSelector: false, decision: null })
    const { host } = await renderControl()
    expect(host.querySelector('input[value="agentic"]')).toBeNull()
    expect(host.textContent).toBe('')
  })

  test('defaults to Response and keeps the one-turn choice separate from the durable override', async () => {
    const { host } = await renderControl()
    const response = host.querySelector<HTMLInputElement>('input[value="response"]')
    const agentic = host.querySelector<HTMLInputElement>('input[value="agentic"]')
    expect(response?.checked).toBeTrue()
    expect(agentic?.checked).toBeFalse()

    await act(async () => agentic?.click())
    expect(selectCalls).toEqual(['agentic'])
    expect(overrideCalls).toEqual([])

    selectCalls.length = 0
    const durable = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useForChat'))
    await act(async () => durable?.click())
    expect(overrideCalls).toEqual(['response'])
    expect(selectCalls).toEqual([])
  })

  test('shows stable repair categories and requires an explicit Response escape', async () => {
    hookState = baseState({
      decision: {
        ...readyDecision,
        effectiveMode: 'response',
        capabilityReadiness: {
          ...readyDecision.capabilityReadiness,
          ready: false,
          repairCodes: ['agentic_slot_unresolved', 'agentic_domain_mismatch'],
        },
        repairCodes: ['agentic_readiness_unavailable'],
      },
      oneTurnMode: 'agentic',
      mode: 'agentic',
      canShowSelector: false,
      repairCategories: ['slot', 'isolate', 'egress'],
    })
    const { host } = await renderControl()

    expect(host.querySelector('input[value="agentic"]')).toBeNull()
    expect(host.textContent).toContain('agentRuntime.repair.slot')
    expect(host.textContent).toContain('agentRuntime.repair.isolate')
    expect(host.textContent).toContain('agentRuntime.repair.egress')
    expect(selectCalls).toEqual([])

    const responseEscape = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useResponse'))
    responseEscape?.focus()
    expect(document.activeElement).toBe(responseEscape)
    await act(async () => responseEscape?.click())
    expect(selectCalls).toEqual(['response'])
  })

  test('uses semantic radio controls and one atomic polite announcement region', async () => {
    const { host } = await renderControl()
    expect(host.querySelector('fieldset')).not.toBeNull()
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(2)
    const liveRegions = host.querySelectorAll('[role="status"][aria-live="polite"][aria-atomic="true"]')
    expect(liveRegions).toHaveLength(1)
  })
})
