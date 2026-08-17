import { generateApi } from '@/api/generate'
import type { GenerateRequest, GenerateResponse, GenerationRequestOptions } from '@/api/generate'
import { messagesApi, chatsApi } from '@/api/chats'
import { useStore } from '@/store'
/**
 * Per-chat generation authority. Store streaming fields are intentionally not
 * sufficient during stop→regenerate: G2 is optimistic while G1 HTTP/WS work
 * may still resolve with `activeGenerationId === null`.
 */
interface GenerationAuthority {
  epoch: number
  currentGenerationId: string | null
  retiredGenerationIds: Set<string>
  terminalGenerationIds: Set<string>
}

export interface GenerationRequestEpoch {
  chatId: string
  epoch: number
  generationId: string | null
}

const generationAuthorities = new Map<string, GenerationAuthority>()
const MAX_GENERATION_HISTORY = 32

function getGenerationAuthority(chatId: string): GenerationAuthority {
  let authority = generationAuthorities.get(chatId)
  if (!authority) {
    authority = {
      epoch: 0,
      currentGenerationId: null,
      retiredGenerationIds: new Set(),
      terminalGenerationIds: new Set(),
    }
    generationAuthorities.set(chatId, authority)
  }
  return authority
}

function rememberGenerationId(set: Set<string>, generationId: string): void {
  if (!generationId) return
  set.add(generationId)
  while (set.size > MAX_GENERATION_HISTORY) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

export function beginGenerationRequest(chatId: string, previousGenerationId?: string | null): number {
  if (!chatId) return 0
  const authority = getGenerationAuthority(chatId)
  const previous = previousGenerationId ?? authority.currentGenerationId
  if (previous) {
    rememberGenerationId(authority.retiredGenerationIds, previous)
    rememberGenerationId(authority.terminalGenerationIds, previous)
  }
  authority.currentGenerationId = null
  authority.epoch += 1
  return authority.epoch
}

export function invalidateGenerationRequest(chatId: string, generationId?: string | null): number {
  if (!chatId) return 0
  const authority = getGenerationAuthority(chatId)
  const current = generationId ?? authority.currentGenerationId
  if (current) {
    rememberGenerationId(authority.retiredGenerationIds, current)
    rememberGenerationId(authority.terminalGenerationIds, current)
  }
  authority.currentGenerationId = null
  authority.epoch += 1
  return authority.epoch
}

export function acceptGenerationStarted(chatId: string, generationId: string): boolean {
  if (!chatId || !generationId) return false
  const authority = getGenerationAuthority(chatId)
  if (
    authority.retiredGenerationIds.has(generationId) ||
    authority.terminalGenerationIds.has(generationId)
  ) return false
  if (authority.currentGenerationId === generationId) return true
  if (authority.currentGenerationId) {
    rememberGenerationId(authority.retiredGenerationIds, authority.currentGenerationId)
    authority.epoch += 1
  }
  authority.currentGenerationId = generationId
  return true
}

export function acceptGenerationEnded(chatId: string, generationId: string): boolean {
  if (!chatId || !generationId) return false
  const authority = getGenerationAuthority(chatId)
  if (authority.retiredGenerationIds.has(generationId)) return false
  if (!authority.currentGenerationId || authority.currentGenerationId !== generationId) return false
  rememberGenerationId(authority.terminalGenerationIds, generationId)
  return true
}

export function captureGenerationRequest(
  chatId: string,
  observedGenerationId?: string | null,
): GenerationRequestEpoch {
  const authority = getGenerationAuthority(chatId)
  if (observedGenerationId && !authority.currentGenerationId) {
    if (
      !authority.retiredGenerationIds.has(observedGenerationId) &&
      !authority.terminalGenerationIds.has(observedGenerationId)
    ) {
      authority.currentGenerationId = observedGenerationId
    }
  }
  return {
    chatId,
    epoch: authority.epoch,
    generationId: observedGenerationId ?? authority.currentGenerationId,
  }
}

export function isGenerationRequestCurrent(
  request: GenerationRequestEpoch,
  generationId?: string | null,
  active = false,
): boolean {
  if (!request.chatId) return false
  const authority = getGenerationAuthority(request.chatId)
  if (authority.epoch !== request.epoch) return false
  if (generationId && request.generationId && generationId !== request.generationId) return false
  if (generationId && authority.retiredGenerationIds.has(generationId)) return false
  if (active && generationId && authority.currentGenerationId && authority.currentGenerationId !== generationId) return false
  return true
}
export function isGenerationRequestCurrentForChat(
  request: GenerationRequestEpoch,
  generationId?: string | null,
  active = false,
): boolean {
  return useStore.getState().activeChatId === request.chatId
    && isGenerationRequestCurrent(request, generationId, active)
}

export type RecoveredGenerationPath = 'start' | 'regenerate' | 'continue'

/**
 * Start every UI-owned generation through one authority fence. The API client
 * protects the runtime decision token and pending HTTP intent; this wrapper
 * additionally protects the store's generation epoch and active-chat scope so
 * a late response cannot resurrect streaming after Stop or navigation.
 */
export async function startGenerationWithRecovery(
  path: RecoveredGenerationPath,
  request: GenerateRequest,
  options: GenerationRequestOptions = {},
): Promise<GenerateResponse> {
  const initial = useStore.getState()
  if (initial.activeChatId !== request.chat_id) {
    throw new DOMException('Generation cancelled', 'AbortError')
  }

  const requestEpoch = beginGenerationRequest(request.chat_id, initial.activeGenerationId)
  const generationRequest = captureGenerationRequest(request.chat_id)
  const response = path === 'regenerate'
    ? await generateApi.regenerate(request, options)
    : path === 'continue'
      ? await generateApi.continueGeneration(request, options)
      : await generateApi.start(request, options)

  const latest = useStore.getState()
  if (
    latest.activeChatId !== request.chat_id
    || generationRequest.epoch !== requestEpoch
    || !isGenerationRequestCurrent(generationRequest, response.generationId, true)
    || !acceptGenerationStarted(request.chat_id, response.generationId)
  ) {
    invalidateGenerationRequest(request.chat_id, response.generationId)
    throw new DOMException('Generation cancelled', 'AbortError')
  }
  return response
}


export function resetGenerationRecoveryGuardsForTests(): void {
  generationAuthorities.clear()
  gapRecoveryStates.clear()
}

const agentActivityRecoveryInFlight = new Map<string, Promise<void>>()

/** Fetch terminal status-only runs once per chat at a time and merge idempotently. */
export function recoverAgentActivityRuns(chatId: string): Promise<void> {
  if (!chatId) return Promise.resolve()
  const existing = agentActivityRecoveryInFlight.get(chatId)
  if (existing) return existing
  const request = chatsApi.listAgentActivityRuns(chatId)
    .then((response) => {
      const state = useStore.getState()
      if (state.activeChatId === chatId && Array.isArray(response.runs)) {
        state.mergeAgentActivityRuns(response.runs)
      }
    })
    .catch(() => { /* activity recovery is best effort */ })
    .finally(() => {
      agentActivityRecoveryInFlight.delete(chatId)
    })
  agentActivityRecoveryInFlight.set(chatId, request)
  return request
}
function getLocalStreamingType(generationType?: string) {
  return generationType === 'impersonate' ? 'impersonate_draft' : generationType
}

/**
 * Poll the backend generation pool for a chat and re-sync local streaming
 * state. Safe to call repeatedly — the pool is authoritative and cumulative,
 * and `reconcileStreamContent/Reasoning` apply snapshots monotonically (a
 * snapshot that raced newer live WS tokens can never rewind the buffer).
 *
 * When already streaming the same generation, the local buffer lengths are
 * sent with the poll so the server returns only the unseen tail (delta)
 * instead of re-shipping the full accumulated content every time.
 *
 * Triggered on: initial chat load, tab becoming visible, WS reconnect, a
 * lightweight watchdog poll while a generation is active, and immediately
 * when a live segment's offset reveals a gap in the local buffer.
 */
export type GenerationRecoveryOutcome = 'applied' | 'stale' | 'ignored' | 'failed'

export async function recoverPooledGeneration(chatId: string): Promise<GenerationRecoveryOutcome> {
  if (!chatId) return 'ignored'
  const state = useStore.getState()
  if (state.activeChatId !== chatId) return 'ignored'
  if (state.mpRoomId && !state.mpIsHost && state.mpChatId === chatId) return 'ignored'

  const request = captureGenerationRequest(chatId, state.activeGenerationId)

  let known: { generationId: string; contentLen: number; reasoningLen: number } | undefined
  if (state.isStreaming && state.activeGenerationId) {
    const buffers = state.getStreamBuffers()
    known = {
      generationId: state.activeGenerationId,
      contentLen: buffers.content.length,
      reasoningLen: buffers.reasoning.length,
    }
  }

  let genStatus
  try {
    genStatus = await generateApi.getStatus(chatId, known)
  } catch {
    return 'failed'
  }

  const latest = useStore.getState()
  if (latest.activeChatId !== chatId) return 'ignored'
  if (!isGenerationRequestCurrent(request, genStatus.generationId, genStatus.active)) return 'stale'

  if (
    genStatus.active &&
    genStatus.generationId &&
    genStatus.status === 'council' &&
    genStatus.councilRetryPending &&
    genStatus.councilToolsFailure
  ) {
    if (!acceptGenerationStarted(chatId, genStatus.generationId)) return 'stale'
    latest.startStreaming(genStatus.generationId, genStatus.targetMessageId)
    latest.setStreamingSwipeId(genStatus.targetSwipeId ?? null)
    latest.setCouncilExecuting(false)
    const existingFailure = latest.councilToolsFailure
    if (existingFailure?.generationId !== genStatus.generationId) {
      latest.setCouncilToolsFailure(genStatus.councilToolsFailure)
      const { showCouncilRetryModal } = await import('@/hooks/useCouncilEvents')
      const current = useStore.getState()
      if (
        current.activeChatId === chatId &&
        isGenerationRequestCurrent(request, genStatus.generationId, true)
      ) {
        showCouncilRetryModal(genStatus.councilToolsFailure)
      }
    }
    return 'applied'
  }

  if (genStatus.active && genStatus.generationId && (genStatus.status === 'streaming' || genStatus.status === 'reasoning')) {
    if (!acceptGenerationStarted(chatId, genStatus.generationId)) return 'stale'
    latest.startStreaming(genStatus.generationId, genStatus.targetMessageId, getLocalStreamingType(genStatus.generationType))
    latest.setStreamingSwipeId(genStatus.targetSwipeId ?? null)
    if (genStatus.content) latest.reconcileStreamContent(genStatus.content, genStatus.contentOffset ?? 0)
    if (genStatus.reasoning) latest.reconcileStreamReasoning(genStatus.reasoning, genStatus.reasoningOffset ?? 0)
    if (genStatus.reasoningDurationMs) {
      useStore.setState({ streamingReasoningDuration: genStatus.reasoningDurationMs })
    } else if (genStatus.reasoningStartedAt) {
      latest.setStreamingReasoningStartedAt(genStatus.reasoningStartedAt)
    }
    return 'applied'
  }

  if (genStatus.active && genStatus.generationId) {
    if (!acceptGenerationStarted(chatId, genStatus.generationId)) return 'stale'
    latest.startStreaming(genStatus.generationId, genStatus.targetMessageId, getLocalStreamingType(genStatus.generationType))
    latest.setStreamingSwipeId(genStatus.targetSwipeId ?? null)
    return 'applied'
  }

  if (!genStatus.active) {
    if (!isGenerationRequestCurrent(request, genStatus.generationId, false)) return 'stale'
    const completedImpersonateDraft =
      genStatus.status === 'completed' &&
      genStatus.generationType === 'impersonate' &&
      !genStatus.completedMessageId

    let draftContent: string | null = null
    if (completedImpersonateDraft && typeof genStatus.content === 'string') {
      const offset = genStatus.contentOffset ?? 0
      draftContent = offset > 0
        ? latest.getStreamBuffers().content.slice(0, offset) + genStatus.content
        : genStatus.content
    }

    const sameGeneration =
      (!latest.activeGenerationId && !request.generationId) ||
      latest.activeGenerationId === genStatus.generationId ||
      (!!request.generationId && request.generationId === genStatus.generationId)
    if (latest.isStreaming && sameGeneration) {
      if (genStatus.error) {
        latest.setStreamingError(genStatus.error)
      } else if (completedImpersonateDraft || genStatus.completedMessageId) {
        latest.endStreaming()
      } else {
        latest.stopStreaming()
      }
    }

    if (draftContent != null) {
      if (!isGenerationRequestCurrent(request, genStatus.generationId, false)) return 'stale'
      latest.setImpersonateDraftContent(draftContent)
      return 'applied'
    }
    if (!genStatus.completedMessageId) return 'applied'

    const pageSize = latest.messagesPerPage || 50
    try {
      const fresh = await messagesApi.list(chatId, { limit: pageSize, tail: true })
      const after = useStore.getState()
      if (
        after.activeChatId === chatId &&
        isGenerationRequestCurrent(request, genStatus.generationId, false)
      ) {
        after.setMessages(fresh.data, fresh.total)
      }
    } catch {
      return 'failed'
    }
  }
  return 'applied'
}

// ── Gap recovery ─────────────────────────────────────────────────────────────
// Fired when a live WS segment's offset is ahead of the local buffer (we
interface GapRecoveryState {
  inFlight: boolean
  followUpQueued: boolean
  followUpAttempted: boolean
}

const gapRecoveryStates = new Map<string, GapRecoveryState>()

function getGapRecoveryState(chatId: string): GapRecoveryState {
  let state = gapRecoveryStates.get(chatId)
  if (!state) {
    state = { inFlight: false, followUpQueued: false, followUpAttempted: false }
    gapRecoveryStates.set(chatId, state)
  }
  return state
}

function runGapRecovery(chatId: string, state: GapRecoveryState): void {
  state.inFlight = true
  recoverPooledGeneration(chatId)
    .catch((): GenerationRecoveryOutcome => 'failed')
    .then((outcome) => {
      if (outcome === 'stale' && state.followUpQueued && !state.followUpAttempted) {
        state.followUpAttempted = true
        state.followUpQueued = false
        return recoverPooledGeneration(chatId)
      }
      return outcome
    })
    .catch(() => { /* best-effort */ })
    .finally(() => {
      state.inFlight = false
      state.followUpQueued = false
      state.followUpAttempted = false
      gapRecoveryStates.delete(chatId)
    })
}

export function requestStreamGapRecovery(chatId: string): void {
  if (!chatId) return
  const state = getGapRecoveryState(chatId)
  if (state.inFlight) {
    // One additional request is enough to observe the generation that may
    // become authoritative while the first status response is in flight.
    state.followUpQueued = true
    return
  }
  runGapRecovery(chatId, state)
}
