import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Keep the production authority module real while supplying only the store
// surface its imported API modules need during these synchronous cases.
mock.module('@/store', () => ({
  useStore: {
    getState: () => ({ activeChatId: null }),
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
  resetGenerationRecoveryGuardsForTests,
} = await import('./generation-recovery')

beforeEach(() => {
  resetGenerationRecoveryGuardsForTests()
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
