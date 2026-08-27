import { beforeEach, describe, expect, mock, test } from 'bun:test'

let generationStatus: Record<string, unknown> = { active: false }
const providerMetadataCalls: Array<{ provider?: string | null; model?: string | null }> = []
const streamStarts: string[] = []
let currentProvider: string | null = null
let currentModel: string | null = null
const storeState = {
  activeChatId: null as string | null,
  activeGenerationId: null as string | null,
  isStreaming: false,
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
    currentProvider = null
    currentModel = null
  },
  setStreamingSwipeId: () => {},
}

mock.module('@/api/generate', () => ({
  generateApi: {
    getStatus: async () => generationStatus,
  },
}))

mock.module('@/store', () => ({
  useStore: {
    getState: () => storeState,
    setState: (updates: Record<string, unknown>) => Object.assign(storeState, updates),
  },
}))

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

beforeEach(() => {
  resetGenerationRecoveryGuardsForTests()
  generationStatus = { active: false }
  providerMetadataCalls.length = 0
  streamStarts.length = 0
  currentProvider = null
  currentModel = null
  Object.assign(storeState, {
    activeChatId: null,
    activeGenerationId: null,
    isStreaming: false,
    mpRoomId: null,
    mpIsHost: false,
    mpChatId: null,
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
