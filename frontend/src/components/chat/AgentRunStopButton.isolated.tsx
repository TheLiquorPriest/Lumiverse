import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import * as actualReactI18next from 'react-i18next'
import { createInstance } from 'i18next'
import type { AgentRunStopResultV2 } from '@/types/agent-runs'
const stopCalls: Array<{ turnId: string; input?: { generationId?: string; chatId?: string } }> = []
const pendingStops: Array<{
  promise: Promise<AgentRunStopResultV2>
  resolve(value: AgentRunStopResultV2): void
  reject(reason?: unknown): void
}> = []

mock.module('@/api/agent-runs', () => ({
  agentRunsApi: {
    stop(turnId: string, input?: { generationId?: string; chatId?: string }) {
      stopCalls.push({ turnId, input })
      const pending = Promise.withResolvers<AgentRunStopResultV2>()
      pendingStops.push(pending)
      return pending.promise
    },
  },
}))
// Preserve the complete module shape for Activity tests sharing this graph.
mock.module('react-i18next', () => ({ ...actualReactI18next }))
const testI18n = createInstance()
await testI18n.init({
  resources: { en: { chat: {} } },
  lng: 'en',
  fallbackLng: false,
  interpolation: { escapeValue: false },
})
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

// The API mock must be installed before the component captures it.
const { default: AgentRunStopButton } = await import('./AgentRunStopButton')
const { createRoot } = await import('react-dom/client')
mock.restore()
const mountedRoots = new Set<Root>()

async function renderStopButton(terminal = false): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mountedRoots.add(root)
  await act(async () => {
    root.render(
      <actualReactI18next.I18nextProvider i18n={testI18n}>
        <AgentRunStopButton
          turnId="turn-1"
          chatId="chat-1"
          generationId="generation-1"
          terminal={terminal}
        />
      </actualReactI18next.I18nextProvider>,
    )
  })
  return { host, root }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  stopCalls.length = 0
  pendingStops.length = 0
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

describe('AgentRunStopButton', () => {
  test('targets the exact root once, immediately shows Stopping, and disables duplicates', async () => {
    const { host } = await renderStopButton()
    const button = host.querySelector('button')!

    await act(async () => {
      button.click()
      button.click()
    })

    expect(stopCalls).toEqual([{
      turnId: 'turn-1',
      input: { chatId: 'chat-1', generationId: 'generation-1' },
    }])
    expect(button.disabled).toBeTrue()
    expect(button.textContent).toContain('agentRuntime.stop.stopping')

    await act(async () => {
      pendingStops[0].resolve({ status: 'accepted', turnId: 'turn-1', revision: 2 })
      await settle()
    })
    expect(button.disabled).toBeTrue()
    expect(button.dataset.stopState).toBe('stopping')
  })

  test('enables a retry after request failure', async () => {
    const { host } = await renderStopButton()
    const button = host.querySelector('button')!
    await act(async () => button.click())
    await act(async () => {
      pendingStops[0].reject(new Error('network'))
      await settle()
    })

    expect(button.disabled).toBeFalse()
    expect(button.textContent).toContain('agentRuntime.stop.retry')

    await act(async () => button.click())
    expect(stopCalls).toHaveLength(2)
  })

  test('renders too_late explicitly and leaves the action disabled', async () => {
    const { host } = await renderStopButton()
    const button = host.querySelector('button')!
    await act(async () => button.click())
    await act(async () => {
      pendingStops[0].resolve({ status: 'too_late', turnId: 'turn-1', revision: 3 })
      await settle()
    })

    expect(button.dataset.stopState).toBe('too_late')
    expect(button.textContent).toContain('agentRuntime.stop.tooLate')
    expect(button.disabled).toBeTrue()
  })

  test('does not create a second live region beside the chat-level run announcer', async () => {
    const { host } = await renderStopButton(true)
    const button = host.querySelector('button')!
    expect(button.dataset.stopState).toBe('terminal')
    expect(button.disabled).toBeTrue()
    expect(host.querySelector('[role="status"]')).toBeNull()
  })
})
