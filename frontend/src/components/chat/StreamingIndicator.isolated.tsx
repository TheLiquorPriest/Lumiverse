import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import chat from '@/i18n/locales/en/chat.json'
import type { AgentActivityGeneration } from '@/types/ws-events'
import type { ComponentType } from 'react'
import type { StreamingStatus, StreamingStatusInput } from './StreamingIndicator'

mock.module('@/i18n/resources', () => ({
  I18N_NAMESPACES: ['chat', 'panels', 'modals', 'settings'],
  fallbackLanguagesFor: (lng: string) => [lng],
  loadLanguageBundles: async () => {},
}))

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
;(dom.window as unknown as { matchMedia: Window['matchMedia'] }).matchMedia = () => ({
  matches: false,
  media: '',
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}) as unknown as MediaQueryList
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true


const i18n = createInstance()
let useStore!: typeof import('@/store').useStore
let StreamingIndicator!: typeof import('./StreamingIndicator').default
let deriveStreamingStatus!: typeof import('./StreamingIndicator').deriveStreamingStatus
let root: Root | null = null
let host: HTMLDivElement | null = null

const generationId = 'generation-a'
const chatId = 'chat-a'

function activity(overrides: Partial<AgentActivityGeneration> = {}): AgentActivityGeneration {
  return {
    generationId,
    invocationOrder: ['child-a'],
    invocations: {
      'child-a': {
        invocationId: 'child-a',
        actor: 'child_profile',
        phase: 'started',
        status: 'running',
        startedAt: Date.now(),
        toolName: 'agent_delegate',
        elapsedMs: 0,
      },
    },
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    isStreaming: true,
    activeGenerationId: generationId,
    streamingError: null,
    terminalStatus: null,
    streamingContent: '',
    streamingReasoning: '',
    ...overrides,
  }
}

function setStore(overrides: Record<string, unknown> = {}) {
  useStore.setState({
    activeChatId: chatId,
    activeGenerationId: generationId,
    isStreaming: true,
    streamingError: null,
    lastGenerationTerminalStatus: null,
    streamingContent: '',
    streamingReasoning: '',
    streamingGenerationType: 'normal',
    chatHeads: [{
      generationId,
      chatId,
      characterName: 'Assistant',
      avatarUrl: null,
      status: 'assembling',
      model: 'deepseek-v4-flash',
      provider: 'Deepseek',
      startedAt: Date.now() - 1_000,
    }],
    agentActivityByGeneration: {},
    ...overrides,
  } as never)
}

async function renderIndicator() {
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <StreamingIndicator />
      </I18nextProvider>,
    )
    await Promise.resolve()
  })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    resources: { en: { chat } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
  const store = await import('@/store')
  useStore = store.useStore
  const indicator = await import('./StreamingIndicator')
  StreamingIndicator = indicator.default
  deriveStreamingStatus = indicator.deriveStreamingStatus
})

beforeEach(() => {
  root?.unmount()
  host?.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

describe('StreamingIndicator', () => {
  test('derives normal and Agentic lifecycle states', () => {
    expect(deriveStreamingStatus(input({ activeGenerationId: null }))).toBe('sending')
    expect(deriveStreamingStatus(input({ chatHead: { status: 'assembling' } }))).toBe('queued')
    expect(deriveStreamingStatus(input({ chatHead: { status: 'waiting' } }))).toBe('waiting')
    expect(deriveStreamingStatus(input({ chatHead: { status: 'reasoning' } }))).toBe('reasoning')
    expect(deriveStreamingStatus(input({ chatHead: { status: 'streaming' }, streamingContent: 'hello' }))).toBe('streaming')
    expect(deriveStreamingStatus(input({ agentActivity: activity() }))).toBe('continuation')
    expect(deriveStreamingStatus(input({ isStreaming: false, terminalStatus: 'completed' }))).toBe('completed')
    expect(deriveStreamingStatus(input({ isStreaming: false, streamingError: 'provider failed' }))).toBe('error')
    expect(deriveStreamingStatus(input({ isStreaming: false, terminalStatus: 'stopped' }))).toBe('stopped')
  })
  test('clears a deferred-send error without projecting failure or tearing down the active lifecycle', async () => {
    setStore({
      streamingError: 'stale failure',
      lastGenerationTerminalStatus: 'error',
      lastGenerationProvider: 'Deepseek',
      lastGenerationModel: 'deepseek-v4-flash',
      streamingContent: 'partial',
      streamingReasoning: 'reasoning',
    })

    useStore.getState().setStreamingError(null)

    const cleared = useStore.getState()
    expect(cleared.streamingError).toBeNull()
    expect(cleared.lastGenerationTerminalStatus).toBeNull()
    expect(cleared.isStreaming).toBe(true)
    expect(cleared.activeGenerationId).toBe(generationId)
    expect(cleared.lastGenerationProvider).toBe('Deepseek')
    expect(cleared.lastGenerationModel).toBe('deepseek-v4-flash')
    expect(cleared.streamingContent).toBe('partial')
    expect(cleared.streamingReasoning).toBe('reasoning')

    await renderIndicator()
    const activeIndicator = host?.querySelector('[role="status"]')
    expect(activeIndicator?.getAttribute('data-generation-status')).not.toBe('error')
    expect(activeIndicator?.textContent).not.toContain('Generation failed')

    useStore.getState().setStreamingError('Provider timed out')
    const failed = useStore.getState()
    expect(failed.streamingError).toBe('Provider timed out')
    expect(failed.lastGenerationTerminalStatus).toBe('error')
    expect(failed.isStreaming).toBe(false)
    expect(failed.activeGenerationId).toBeNull()
  })

  test('shows recovered provider identity when in-progress arrives without a started chat head', async () => {
    setStore({
      chatHeads: [],
      activeGenerationId: null,
      isStreaming: false,
      lastGenerationProvider: null,
      lastGenerationModel: null,
    })
    useStore.getState().startStreaming('generation-recovered')
    useStore.getState().setGenerationProviderMetadata({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    useStore.getState().reconcileStreamContent('partial', 0)

    await renderIndicator()
    const indicator = host?.querySelector('[role="status"]')
    expect(indicator?.getAttribute('data-generation-status')).toBe('streaming')
    expect(indicator?.textContent).toContain('Provider deepseek · model deepseek-v4-flash')
  })

  test('shows Council waiting operation and provider metadata', async () => {
    setStore({
      chatHeads: [{
        generationId,
        chatId,
        characterName: 'Assistant',
        avatarUrl: null,
        status: 'waiting',
        model: 'deepseek-v4-flash',
        provider: 'Deepseek',
        connectionLabel: 'council-connection',
        agentOperation: 'council',
        agentLifecycle: 'waiting',
        startedAt: Date.now() - 31_000,
      }],
    })
    const state = useStore.getState()
    expect(state.activeChatId).toBe(chatId)
    expect(state.activeGenerationId).toBe(generationId)
    expect(state.chatHeads).toHaveLength(1)
    const head = state.chatHeads[0]
    expect(head?.chatId).toBe(chatId)
    expect(head?.generationId).toBe(generationId)
    expect(head?.status).toBe('waiting')
    expect(head?.agentOperation).toBe('council')
    expect(head?.agentLifecycle).toBe('waiting')
    expect(head?.startedAt).toBeLessThan(Date.now() - 30_000)
    await renderIndicator()
    const indicator = host?.querySelector('[role="status"]')
    expect(indicator?.getAttribute('data-generation-status')).toBe('waiting')
    expect(indicator?.textContent).toContain('Provider Deepseek · model deepseek-v4-flash')
    expect(indicator?.textContent).toContain('council-connection')
    expect(indicator?.textContent).toContain('Council consultation · Waiting')
    expect(indicator?.textContent).toContain('elapsed 00:31')
    expect(indicator?.textContent).toContain('Still waiting after 30 seconds')
  })

  test('keeps terminal provider failures and stops visible after streaming ends', async () => {
    setStore({
      isStreaming: false,
      activeGenerationId: null,
      streamingError: 'Provider timed out',
      lastGenerationTerminalStatus: 'error',
      lastGenerationProvider: 'Deepseek',
      lastGenerationConnectionLabel: 'agent-root-connection',
      lastGenerationModel: 'deepseek-v4-flash',
      chatHeads: [],
    })
    await renderIndicator()
    let indicator = host?.querySelector('[role="status"]')
    expect(indicator?.getAttribute('data-generation-status')).toBe('error')
    expect(indicator?.textContent).toContain('Generation failed')
    expect(indicator?.textContent).toContain('Provider timed out')
    expect(indicator?.textContent).toContain('Provider Deepseek · model deepseek-v4-flash')
    expect(indicator?.textContent).toContain('agent-root-connection')
    await act(async () => {
      useStore.setState({ streamingError: null, lastGenerationTerminalStatus: 'stopped' } as never)
      await Promise.resolve()
    })
    indicator = host?.querySelector('[role="status"]')
    expect(indicator?.getAttribute('data-generation-status')).toBe('stopped')
    expect(indicator?.textContent).toContain('Generation stopped')
    expect(indicator?.textContent).toContain('Stopped. Retry when ready.')
    expect(indicator?.textContent).toContain('Provider Deepseek · model deepseek-v4-flash')
    expect(indicator?.textContent).toContain('agent-root-connection')
  })
})
