/// <reference types="bun-types" />

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { Root } from 'react-dom/client'

interface PipelineOutcome {
  result: string
  touchedVars: Set<string>
  cacheable: boolean
}

interface Identity {
  chatId: string
  messageId: string
}

interface HarnessProps {
  content: string
  identity?: Identity
  isStreaming: boolean
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const domWindow = dom.window
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Node: domWindow.Node,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Event: domWindow.Event,
  EventTarget: domWindow.EventTarget,
})

const pendingResults = new Map<string, (outcome: PipelineOutcome) => void>()
const applyDisplayRegexTiered = mock((content: string) => new Promise<PipelineOutcome>((resolve) => {
  pendingResults.set(content, resolve)
}))
const trackInitialDisplayResolve = mock(<T,>(promise: Promise<T>) => promise)
const storeState = {
  regexScripts: [{
    id: 'resolver-lifecycle-regex',
    name: 'Resolver lifecycle regex',
    target: ['display'],
    disabled: false,
    scope: 'global',
    scope_id: null,
    find_regex: 'chunk',
    replace_string: 'resolved',
    flags: 'g',
    placement: [],
    min_depth: null,
    max_depth: null,
    trim_strings: [],
    substitute_macros: 'none',
    metadata: {},
    updated_at: 1,
  }],
  activeCharacterId: 'resolver-lifecycle-character',
  activeGroupCharacterId: null,
  activeChatId: 'resolver-lifecycle-default-chat',
  activePersonaId: null,
  messages: [],
}

mock.module('@/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))
mock.module('@/lib/chatDisplaySettle', () => ({
  trackInitialDisplayResolve,
}))
mock.module('@/lib/regex/pipeline', () => ({ applyDisplayRegexTiered }))
mock.module('@/api/macros', () => ({
  resolveMacrosBatch: async ({ templates }: { templates: Record<string, string> }) => ({ resolved: templates }),
}))
/**
 * Display preprocessing is a pass-through resolver, except for contents parked
 * with `holdPreprocess`, whose round trip stays in flight until
 * `releasePreprocess`. That models the real gap between a store commit and the
 * preprocess response landing.
 */
const heldPreprocess = new Set<string>()
const pendingPreprocess = new Map<string, (value: { content: string; cacheable: boolean }) => void>()

mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => true,
  getDisplayResolverForChat: () => ({
    resolveBody: ({ content }: { content: string }) => (
      heldPreprocess.has(content)
        ? new Promise<{ content: string; cacheable: boolean }>((resolvePreprocess) => {
            pendingPreprocess.set(content, resolvePreprocess)
          })
        : Promise.resolve({ content, cacheable: true })
    ),
    resolveTemplates: async ({ templates }: { templates: Record<string, string> }) => ({ resolved: templates }),
  }),
}))
mock.module('@/api/regex', () => ({ regexApi: { reportPerformance: async () => undefined } }))
mock.module('@/lib/toast', () => ({ toast: { warning: () => undefined } }))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))

const {
  resetDisplayCoalesceForTests,
  resetDisplayRegexCachesForTests,
  setDisplayCoalesceDepsForTests,
  useDisplayRegex,
} = await import('./useDisplayRegex')
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')

function Harness({ content, identity, isStreaming }: HarnessProps) {
  const rendered = useDisplayRegex(
    content,
    false,
    0,
    undefined,
    identity
      ? {
          chatId: identity.chatId,
          messageId: identity.messageId,
          role: 'assistant',
        }
      : undefined,
    isStreaming,
  )
  return createElement('output', null, rendered)
}

function readRendered(host: HTMLDivElement): string {
  return host.textContent ?? ''
}

function configureImmediateCoalescing(): void {
  let now = 1_000
  setDisplayCoalesceDepsForTests({
    now: () => (now += 1_000),
    scheduleTimer: (fn) => {
      let active = true
      queueMicrotask(() => { if (active) fn() })
      return () => { active = false }
    },
  })
}

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0))
  })
}

async function waitForPending(content: string): Promise<void> {
  for (let attempt = 0; attempt < 20 && !pendingResults.has(content); attempt++) {
    await flushReact()
  }
  if (!pendingResults.has(content)) throw new Error(`Resolver did not start for ${content}`)
}

async function settle(content: string, result: string): Promise<void> {
  const resolve = pendingResults.get(content)
  if (!resolve) throw new Error(`No pending resolver for ${content}`)
  pendingResults.delete(content)
  await act(async () => {
    resolve({ result, touchedVars: new Set(), cacheable: true })
    await Promise.resolve()
  })
}

async function render(root: Root, props: HarnessProps): Promise<void> {
  await act(async () => { root.render(createElement(Harness, props)) })
  await waitForPending(props.content)
}

/** Commit a render whose preprocess round trip is still in flight. */
async function renderWhilePreprocessPending(root: Root, props: HarnessProps): Promise<void> {
  await act(async () => { root.render(createElement(Harness, props)) })
  for (let attempt = 0; attempt < 5; attempt++) await flushReact()
}

function holdPreprocess(content: string): void {
  heldPreprocess.add(content)
}

async function releasePreprocess(content: string): Promise<void> {
  heldPreprocess.delete(content)
  const resolvePreprocess = pendingPreprocess.get(content)
  if (!resolvePreprocess) throw new Error(`No held preprocess for ${content}`)
  pendingPreprocess.delete(content)
  await act(async () => {
    resolvePreprocess({ content, cacheable: true })
    await Promise.resolve()
  })
}

async function createHarness(): Promise<{ host: HTMLDivElement; root: Root }> {
  configureImmediateCoalescing()
  const host = document.createElement('div')
  document.body.append(host)
  return { host, root: createRoot(host) }
}

async function destroyHarness(host: HTMLDivElement, root: Root): Promise<void> {
  await act(async () => root.unmount())
  host.remove()
  pendingResults.clear()
  resetDisplayRegexCachesForTests()
  resetDisplayCoalesceForTests()
}

afterEach(() => {
  pendingResults.clear()
  heldPreprocess.clear()
  pendingPreprocess.clear()
  applyDisplayRegexTiered.mockClear()
  trackInitialDisplayResolve.mockClear()
  document.body.replaceChildren()
  resetDisplayRegexCachesForTests()
  resetDisplayCoalesceForTests()
})

afterAll(() => {
  dom.window.close()
})

describe('useDisplayRegex resolver lifecycle', () => {
  test('tracks only the first preprocess and regex keys of an active stream', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-recovery-stream', messageId: 'message-recovery-stream' }

    try {
      await render(root, { content: 'chunk recovery one', identity, isStreaming: true })
      expect(trackInitialDisplayResolve).toHaveBeenCalledTimes(2)
      await settle('chunk recovery one', 'resolved recovery one')

      await render(root, { content: 'chunk recovery one two', identity, isStreaming: true })
      expect(trackInitialDisplayResolve).toHaveBeenCalledTimes(2)
      await settle('chunk recovery one two', 'resolved recovery two')

      await render(root, { content: 'chunk recovery final', identity, isStreaming: false })
      expect(trackInitialDisplayResolve).toHaveBeenCalledTimes(4)
      await settle('chunk recovery final', 'resolved recovery final')
    } finally {
      await destroyHarness(host, root)
    }
  })

  /** **Validates: Requirements 2.5, 2.7, 3.6, 3.8** */
  test('generated same-message settlement orderings carry only the newest resolved value and finalize the latest key', async () => {
    const settlementOrders = [
      ['middle', 'latest'],
      ['latest', 'middle'],
    ] as const

    for (const [caseIndex, settlementOrder] of settlementOrders.entries()) {
      const { host, root } = await createHarness()
      const identity = { chatId: `chat-order-${caseIndex}`, messageId: `message-order-${caseIndex}` }
      const seed = `chunk seed ${caseIndex}`
      const middle = `chunk middle ${caseIndex}`
      const latest = `chunk latest ${caseIndex}`
      const final = `chunk final ${caseIndex}`

      try {
        await render(root, { content: seed, identity, isStreaming: true })
        await settle(seed, `resolved seed ${caseIndex}`)
        expect(readRendered(host)).toBe(`resolved seed ${caseIndex}`)

        await render(root, { content: middle, identity, isStreaming: true })
        expect(readRendered(host)).toBe(`resolved seed ${caseIndex}`)
        await render(root, { content: latest, identity, isStreaming: true })
        expect(readRendered(host)).toBe(`resolved seed ${caseIndex}`)

        let latestSettled = false
        for (const key of settlementOrder) {
          const content = key === 'middle' ? middle : latest
          await settle(content, `resolved ${key} ${caseIndex}`)
          if (key === 'latest') latestSettled = true
          expect(readRendered(host)).toBe(
            latestSettled ? `resolved latest ${caseIndex}` : `resolved seed ${caseIndex}`,
          )
        }

        expect(readRendered(host)).toBe(`resolved latest ${caseIndex}`)
        await render(root, { content: final, identity, isStreaming: false })
        expect(readRendered(host)).toBe(`resolved latest ${caseIndex}`)
        await settle(final, `resolved final ${caseIndex}`)
        expect(readRendered(host)).toBe(`resolved final ${caseIndex}`)
      } finally {
        await destroyHarness(host, root)
      }
    }
  })

  /** **Validates: Requirements 2.5, 2.7, 3.6, 3.8** */
  test('generated chat, message, implicit-identity, and new-stream changes reset resolved carry', async () => {
    const resetCases: Array<{
      name: string
      initialIdentity: Identity
      nextIdentity?: Identity
      initialStreaming: boolean
      nextStreaming: boolean
    }> = [
      {
        name: 'message-change',
        initialIdentity: { chatId: 'chat-message-change', messageId: 'message-before' },
        nextIdentity: { chatId: 'chat-message-change', messageId: 'message-after' },
        initialStreaming: true,
        nextStreaming: true,
      },
      {
        name: 'chat-change',
        initialIdentity: { chatId: 'chat-before', messageId: 'message-chat-change' },
        nextIdentity: { chatId: 'chat-after', messageId: 'message-chat-change' },
        initialStreaming: true,
        nextStreaming: true,
      },
      {
        name: 'implicit-identity',
        initialIdentity: { chatId: 'chat-explicit', messageId: 'message-explicit' },
        nextIdentity: undefined,
        initialStreaming: true,
        nextStreaming: true,
      },
      {
        name: 'new-stream',
        initialIdentity: { chatId: 'chat-new-stream', messageId: 'message-new-stream' },
        nextIdentity: { chatId: 'chat-new-stream', messageId: 'message-new-stream' },
        initialStreaming: false,
        nextStreaming: true,
      },
    ]

    for (const resetCase of resetCases) {
      const { host, root } = await createHarness()
      const initial = `chunk ${resetCase.name} initial`
      const next = `chunk ${resetCase.name} next`

      try {
        await render(root, {
          content: initial,
          identity: resetCase.initialIdentity,
          isStreaming: resetCase.initialStreaming,
        })
        await settle(initial, `resolved ${resetCase.name} initial`)
        expect(readRendered(host)).toBe(`resolved ${resetCase.name} initial`)

        await render(root, {
          content: next,
          identity: resetCase.nextIdentity,
          isStreaming: resetCase.nextStreaming,
        })
        expect(readRendered(host)).toBe(next)
        await settle(next, `resolved ${resetCase.name} next`)
        expect(readRendered(host)).toBe(`resolved ${resetCase.name} next`)
      } finally {
        await destroyHarness(host, root)
      }
    }
  })

  /** **Validates: Requirements 2.5, 2.7, 3.6, 3.8** */
  test('a pending preprocess key keeps the last preprocessed value of the same identity and finalizes the authoritative key', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-preprocess-carry', messageId: 'message-preprocess-carry' }
    const first = 'chunk carry one'
    const second = 'chunk carry one two'
    const authoritative = 'chunk carry one two final'

    try {
      await render(root, { content: first, identity, isStreaming: true })
      await settle(first, 'resolved carry one')
      expect(readRendered(host)).toBe('resolved carry one')

      // Mid-stream flush: the newest preprocess key is in flight, so the
      // unpreprocessed source must never reach the render.
      holdPreprocess(second)
      await renderWhilePreprocessPending(root, { content: second, identity, isStreaming: true })
      expect(readRendered(host)).toBe('resolved carry one')
      await releasePreprocess(second)
      await waitForPending(second)
      expect(readRendered(host)).toBe('resolved carry one')
      await settle(second, 'resolved carry two')
      expect(readRendered(host)).toBe('resolved carry two')

      // Finalization commits a DIFFERENT key than the last streamed chunk, and
      // resolves in two stages (preprocess, then regex). Neither stage may
      // expose unpreprocessed source.
      holdPreprocess(authoritative)
      await renderWhilePreprocessPending(root, { content: authoritative, identity, isStreaming: false })
      expect(readRendered(host)).toBe('resolved carry two')
      await releasePreprocess(authoritative)
      await waitForPending(authoritative)
      expect(readRendered(host)).toBe('resolved carry two')
      await settle(authoritative, 'resolved carry final')
      expect(readRendered(host)).toBe('resolved carry final')
    } finally {
      await destroyHarness(host, root)
    }
  })

  /** **Validates: Requirements 2.5, 2.7, 3.6, 3.8** */
  test('a pending preprocess key never carries a preprocessed value across chat, message, or stream identities', async () => {
    const leakCases: Array<{
      name: string
      initialIdentity: Identity
      nextIdentity: Identity
      initialStreaming: boolean
      nextStreaming: boolean
    }> = [
      {
        name: 'leak-message-change',
        initialIdentity: { chatId: 'chat-leak-message', messageId: 'message-leak-before' },
        nextIdentity: { chatId: 'chat-leak-message', messageId: 'message-leak-after' },
        initialStreaming: true,
        nextStreaming: true,
      },
      {
        name: 'leak-chat-change',
        initialIdentity: { chatId: 'chat-leak-before', messageId: 'message-leak-chat' },
        nextIdentity: { chatId: 'chat-leak-after', messageId: 'message-leak-chat' },
        initialStreaming: true,
        nextStreaming: true,
      },
      {
        name: 'leak-new-stream',
        initialIdentity: { chatId: 'chat-leak-stream', messageId: 'message-leak-stream' },
        nextIdentity: { chatId: 'chat-leak-stream', messageId: 'message-leak-stream' },
        initialStreaming: false,
        nextStreaming: true,
      },
    ]

    for (const leakCase of leakCases) {
      const { host, root } = await createHarness()
      const initial = `chunk ${leakCase.name} initial`
      const next = `chunk ${leakCase.name} next`

      try {
        await render(root, {
          content: initial,
          identity: leakCase.initialIdentity,
          isStreaming: leakCase.initialStreaming,
        })
        await settle(initial, `resolved ${leakCase.name} initial`)
        expect(readRendered(host)).toBe(`resolved ${leakCase.name} initial`)

        holdPreprocess(next)
        await renderWhilePreprocessPending(root, {
          content: next,
          identity: leakCase.nextIdentity,
          isStreaming: leakCase.nextStreaming,
        })
        expect(readRendered(host)).toBe(next)
        expect(readRendered(host)).not.toBe(`resolved ${leakCase.name} initial`)

        await releasePreprocess(next)
        await waitForPending(next)
        await settle(next, `resolved ${leakCase.name} next`)
        expect(readRendered(host)).toBe(`resolved ${leakCase.name} next`)
      } finally {
        await destroyHarness(host, root)
      }
    }
  })
})
