import { beforeEach, describe, expect, mock, test } from 'bun:test'

let generationStatus: Record<string, unknown> = { active: false }
const providerMetadataCalls: Array<{ provider?: string | null; model?: string | null }> = []
const streamStarts: string[] = []
const generationStarts: unknown[] = []
const streamingErrors: string[] = []
let generationStart = Promise.withResolvers<{ generationId: string }>()
let currentProvider: string | null = null
let currentModel: string | null = null
const storeState = {
  messages: [] as Array<{ id: string }>,
  activeChatId: null as string | null,
  activeGenerationId: null as string | null,
  isStreaming: false,
  regeneratingMessageId: null as string | null,
  streamingGenerationType: null as string | null,
  streamingSwipeId: null as number | null,
  activeProfileId: null as string | null,
  activePersonaId: null as string | null,
  activeCharacterId: null as string | null,
  activeChatMetadata: null as { temporary?: boolean } | null,
  isGroupChat: false,
  regenFeedback: { enabled: false, position: 'before', format: 'plain' },
  getActivePresetForGeneration: () => null,
  openModal: () => {},
  beginStreaming: (messageId?: string, generationType?: string) => {
    storeState.isStreaming = true
    storeState.regeneratingMessageId = messageId ?? null
    storeState.streamingGenerationType = generationType ?? null
  },
  setStreamingError: (error: string) => streamingErrors.push(error),
  mpRoomId: null as string | null,
  mpIsHost: false,
  mpChatId: null as string | null,
  getStreamBuffers: () => ({ content: '', reasoning: '' }),
  setGenerationProviderMetadata: (metadata: { provider?: string | null; model?: string | null }) => {
    providerMetadataCalls.push(metadata)
    if (metadata.provider !== undefined) currentProvider = metadata.provider
    if (metadata.model !== undefined) currentModel = metadata.model
  },
  startStreaming: (generationId: string) => {
    streamStarts.push(generationId)
    storeState.activeGenerationId = generationId
    storeState.isStreaming = true
    currentProvider = null
    currentModel = null
  },
  setStreamingSwipeId: () => {},
}

mock.module('@/api/generate', () => ({
  generateApi: {
    getStatus: async () => generationStatus,
    start: async (request: unknown) => {
      generationStarts.push(request)
      return generationStart.promise
    },
  },
}))

mock.module('@/i18n', () => ({
  default: { t: (key: string) => key },
}))
mock.module('@/api/chats', () => ({
  messagesApi: { swipe: async () => undefined },
  chatsApi: {},
}))

const mockedUseStore = Object.assign(
  <T>(selector: (state: typeof storeState) => T): T => selector(storeState),
  {
    getState: () => storeState,
    setState: (updates: Record<string, unknown>) => Object.assign(storeState, updates),
  },
)
mock.module('@/store', () => ({ useStore: mockedUseStore }))

// Dynamic import is intentional: the store mock must be registered before
// Bun evaluates the real production authority module and its dependencies.
const {
  acceptGenerationStarted,
  beginGenerationRequest,
  captureGenerationRequest,
  invalidateGenerationRequest,
  isGenerationRequestCurrent,
  recoverPooledGeneration,
  resetGenerationRecoveryGuardsForTests,
} = await import('./generation-recovery')
const { default: useSwipeAction, executeSwipe } = await import('../hooks/useSwipeAction')
const {
  acceptsClientGenerationAuthority,
  beginClientGenerationAuthority,
  stopClientGenerationAuthority,
} = await import('./generation-request-authority')

beforeEach(() => {
  resetGenerationRecoveryGuardsForTests()
  generationStatus = { active: false }
  providerMetadataCalls.length = 0
  streamStarts.length = 0
  generationStarts.length = 0
  streamingErrors.length = 0
  generationStart = Promise.withResolvers<{ generationId: string }>()
  currentProvider = null
  currentModel = null
  Object.assign(storeState, {
    activeChatId: null,
    activeGenerationId: null,
    isStreaming: false,
    mpRoomId: null,
    mpIsHost: false,
    mpChatId: null,
    regeneratingMessageId: null,
    streamingGenerationType: null,
    streamingSwipeId: null,
  })
})

describe('generation authority invalidation', () => {
  test('a late G1 invalidation retires only G1 after G2 starts', () => {
    beginGenerationRequest('chat-a')
    expect(acceptGenerationStarted('chat-a', 'G1')).toBe(true)

    const g2Epoch = beginGenerationRequest('chat-a', 'G1')
    expect(acceptGenerationStarted('chat-a', 'G2')).toBe(true)

    expect(invalidateGenerationRequest('chat-a', 'G1')).toBe(g2Epoch)
    expect(invalidateGenerationRequest('chat-a', 'G1')).toBe(g2Epoch)

    const g2Request = captureGenerationRequest('chat-a')
    expect(g2Request.generationId).toBe('G2')
    expect(isGenerationRequestCurrent(g2Request, 'G2', true)).toBe(true)
    expect(acceptGenerationStarted('chat-a', 'G2')).toBe(true)
    expect(acceptGenerationStarted('chat-a', 'G1')).toBe(false)
  })

  test('invalidating the current generation clears authority and advances once', () => {
    beginGenerationRequest('chat-a')
    expect(acceptGenerationStarted('chat-a', 'G2')).toBe(true)

    const nextEpoch = invalidateGenerationRequest('chat-a', 'G2')
    expect(nextEpoch).toBe(2)
    expect(captureGenerationRequest('chat-a')).toMatchObject({ epoch: nextEpoch, generationId: null })

    expect(invalidateGenerationRequest('chat-a', 'G2')).toBe(nextEpoch)
    expect(isGenerationRequestCurrent({ chatId: 'chat-a', epoch: 1, generationId: 'G2' }, 'G2')).toBe(false)
  })

  test('executeSwipe rejects WS-before-HTTP resurrection after same-chat Stop', async () => {
    storeState.activeChatId = 'chat-a'
    const message = { id: 'assistant-1', is_user: false, swipe_id: 0, swipes: ['first'], extra: {} }
    storeState.messages = [message]
    const authorityId = beginClientGenerationAuthority('chat-a')
    const swipe = executeSwipe(message as never, 'chat-a', 'right')
    await Promise.resolve()
    expect(generationStarts).toHaveLength(1)
    expect(acceptsClientGenerationAuthority('chat-a', authorityId)).toBe(true)
    expect(acceptGenerationStarted('chat-a', 'G-before-http')).toBe(true)

    expect(stopClientGenerationAuthority('chat-a')).toBe(authorityId)
    invalidateGenerationRequest('chat-a', 'G-before-http')
    generationStart.resolve({ generationId: 'G-before-http' })
    await swipe

    expect(storeState.activeChatId).toBe('chat-a')
    expect(streamStarts).toEqual([])
    expect(acceptsClientGenerationAuthority('chat-a', authorityId)).toBe(false)
    expect(acceptGenerationStarted('chat-a', 'G-before-http')).toBe(false)
  })

  test('the real useSwipeAction hook rejects the same Stop ordering', async () => {
    const { JSDOM } = await import('jsdom')
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = React
    const dom = new JSDOM('<div id="root"></div>')
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator })
    storeState.activeChatId = 'chat-a'
    const message = { id: 'assistant-hook', is_user: false, swipe_id: 0, swipes: ['first'], extra: {} }
    storeState.messages = [message]
    let actions: ReturnType<typeof useSwipeAction> | null = null
    const Harness = () => {
      actions = useSwipeAction(message as never, 'chat-a')
      return null
    }
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(async () => { root.render(React.createElement(Harness)) })
    const authorityId = beginClientGenerationAuthority('chat-a')
    actions!.handleRegenerate()
    await Promise.resolve()
    expect(generationStarts).toHaveLength(1)
    expect(acceptGenerationStarted('chat-a', 'G-hook-before-http')).toBe(true)
    expect(stopClientGenerationAuthority('chat-a')).toBe(authorityId)
    invalidateGenerationRequest('chat-a', 'G-hook-before-http')
    generationStart.resolve({ generationId: 'G-hook-before-http' })
    await Bun.sleep(0)
    expect(streamStarts).toEqual([])
    expect(acceptsClientGenerationAuthority('chat-a', authorityId)).toBe(false)
    await act(async () => { root.unmount() })
    dom.window.close()
  })

  test('navigation preserves a deferred swipe and pooled recovery projects it once', async () => {
    storeState.activeChatId = 'chat-a'
    const message = { id: 'assistant-nav', is_user: false, swipe_id: 0, swipes: ['first'], extra: {} }
    storeState.messages = [message]
    const swipe = executeSwipe(message as never, 'chat-a', 'right')
    await Promise.resolve()
    storeState.activeChatId = 'chat-b'
    storeState.isStreaming = false
    generationStart.resolve({ generationId: 'G-background' })
    await swipe
    expect(acceptGenerationStarted('chat-a', 'G-background')).toBe(true)
    expect(streamStarts).toEqual([])

    storeState.activeChatId = 'chat-a'
    storeState.activeGenerationId = null
    generationStatus = { active: true, generationId: 'G-background', status: 'streaming' }
    expect(await recoverPooledGeneration('chat-a')).toBe('applied')
    expect(await recoverPooledGeneration('chat-a')).toBe('applied')
    expect(streamStarts).toEqual(['G-background'])
  })
})
describe('generation status provider identity', () => {
  test('projects the exact provider and model from a current active snapshot', async () => {
    storeState.activeChatId = 'chat-a'
    generationStatus = {
      active: true,
      generationId: 'G-status',
      status: 'assembling',
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
    }

    expect(await recoverPooledGeneration('chat-a')).toBe('applied')
    expect(providerMetadataCalls).toEqual([{
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
    }])
    expect(streamStarts).toEqual(['G-status'])
    expect(currentProvider).toBe('Deepseek')
    expect(currentModel).toBe('deepseek-v4-flash')
  })

  test('clears an absent provider without inferring it from the model', async () => {
    storeState.activeChatId = 'chat-a'
    generationStatus = {
      active: true,
      generationId: 'G-provider-absent',
      status: 'assembling',
      model: 'deepseek-v4-flash',
    }

    expect(await recoverPooledGeneration('chat-a')).toBe('applied')
    expect(providerMetadataCalls).toEqual([{
      provider: null,
      model: 'deepseek-v4-flash',
    }])
    expect(currentProvider).toBeNull()
    expect(currentModel).toBe('deepseek-v4-flash')
  })

  test('does not overwrite identity for inactive or unidentified snapshots', async () => {
    storeState.activeChatId = 'chat-a'
    currentProvider = 'existing-provider'
    currentModel = 'existing-model'
    generationStatus = {
      active: false,
      generationId: 'G-terminal',
      status: 'completed',
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
    }
    expect(await recoverPooledGeneration('chat-a')).toBe('applied')

    generationStatus = {
      active: true,
      status: 'assembling',
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
    }
    expect(await recoverPooledGeneration('chat-a')).toBe('applied')
    expect(providerMetadataCalls).toEqual([])
    expect(currentProvider).toBe('existing-provider')
    expect(currentModel).toBe('existing-model')
  })
})
