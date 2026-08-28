import { generateApi } from '@/api/generate'
import type { GenerateRequest, GenerateResponse, GenerationRequestOptions } from '@/api/generate'
import { messagesApi, chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import type { GenerationRequestAuthority } from '@/types/store'
import { yieldToBrowser } from '@/lib/spindle/browser-scheduler'

export interface GenerationRequestEpoch {
  chatId: string
  epoch: number
  requestAuthorityId: string | null
  generationId: string | null
}

export interface GenerationRequestIntent {
  generationType?: string
  targetMessageId?: string | null
  targetSwipeId?: number | null
  requestAuthorityId?: string | null
}

function isLiveRequest(authority: GenerationRequestAuthority | undefined): authority is GenerationRequestAuthority {
  return authority?.status === 'pending' || authority?.status === 'queued' || authority?.status === 'working'
}

/** Publish the sole reactive per-chat request authority synchronously. */
export function beginGenerationRequest(
  chatId: string,
  intentOrPrevious: GenerationRequestIntent | string = {},
): number {
  const intent = typeof intentOrPrevious === 'string' ? {} : intentOrPrevious
  const authority = useStore.getState().beginGenerationRequest(chatId, {
    generationType: intent.generationType ?? 'normal',
    targetMessageId: intent.targetMessageId,
    targetSwipeId: intent.targetSwipeId,
    requestAuthorityId: intent.requestAuthorityId,
  })
  return authority.epoch
}

export function invalidateGenerationRequest(chatId: string, generationId?: string | null): number {
  const state = useStore.getState()
  const current = state.generationRequests[chatId]
  if (!current) return 0
  if (generationId && current.generationId && current.generationId !== generationId) return current.epoch
  state.settleGenerationRequest(chatId, 'stopped', generationId)
  return current.epoch
}

export function acceptGenerationStarted(
  chatId: string,
  generationId: string,
  requestAuthorityId?: string,
  status: 'queued' | 'working' = 'queued',
): boolean {
  if (!chatId || !generationId) return false
  return useStore.getState().acceptGenerationRequest(
    chatId,
    generationId,
    requestAuthorityId,
    status,
  )
}

export function acceptGenerationEnded(
  chatId: string,
  generationId: string,
  status: 'completed' | 'stopped' | 'error' = 'completed',
  requestAuthorityId?: string,
): boolean {
  if (!chatId || !generationId) return false
  return useStore.getState().settleGenerationRequest(
    chatId,
    status,
    generationId,
    requestAuthorityId,
  )
}

export function captureGenerationRequest(
  chatId: string,
  observedGenerationId?: string | null,
): GenerationRequestEpoch {
  let authority = useStore.getState().generationRequests[chatId]
  if (observedGenerationId && !authority) {
    useStore.getState().acceptGenerationRequest(chatId, observedGenerationId)
    authority = useStore.getState().generationRequests[chatId]
  }
  return {
    chatId,
    epoch: authority?.epoch ?? 0,
    requestAuthorityId: authority?.requestAuthorityId ?? null,
    generationId: observedGenerationId ?? authority?.generationId ?? null,
  }
}

export function isGenerationRequestCurrent(
  request: GenerationRequestEpoch,
  generationId?: string | null,
  active = false,
): boolean {
  const authority = useStore.getState().generationRequests[request.chatId]
  if (!authority || authority.epoch !== request.epoch) return false
  if (authority.requestAuthorityId !== request.requestAuthorityId) return false
  if (generationId && request.generationId && generationId !== request.generationId) return false
  if (generationId && authority.retiredGenerationIds.includes(generationId)) return false
  if (active && !isLiveRequest(authority)) return false
  if (active && generationId && authority.generationId && authority.generationId !== generationId) return false
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
 * Start a UI-owned generation through the store authority. If the caller
 * already published its request before an earlier write, that exact authority
 * is carried through runtime resolution, HTTP admission, Stop, and WS events.
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

  const existing = initial.generationRequests[request.chat_id]
  const authority = isLiveRequest(existing)
    && request.request_authority_id !== undefined
    && existing.requestAuthorityId === request.request_authority_id
    ? existing
    : initial.beginGenerationRequest(request.chat_id, {
        generationType: request.generation_type ?? 'normal',
        targetMessageId: request.message_id ?? null,
        targetSwipeId: request.swipe_id ?? null,
        requestAuthorityId: request.request_authority_id,
      })
  const generationRequest = captureGenerationRequest(request.chat_id)
  const admittedRequest: GenerateRequest = {
    ...request,
    request_authority_id: authority.requestAuthorityId ?? undefined,
  }
  const controller = authority.abortController
  if (!controller) throw new DOMException('Generation cancelled', 'AbortError')
  const onExternalAbort = () => controller.abort(
    options.signal?.reason ?? new DOMException('Generation cancelled', 'AbortError'),
  )
  if (options.signal?.aborted) onExternalAbort()
  else options.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const requestOptions: GenerationRequestOptions = { ...options, signal: controller.signal }

  try {
    // The request authority is the human's Stop surface before either runtime
    // preflight or backend admission has an ID. Give React one shared paint
    // boundary to commit it, then re-check the same authority and signal.
    await yieldToBrowser({ when: 'paint' })
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new DOMException('Generation cancelled', 'AbortError')
    }
    if (!isGenerationRequestCurrent(generationRequest, undefined, true)) {
      throw new DOMException('Generation cancelled', 'AbortError')
    }
    const response = path === 'regenerate'
      ? await generateApi.regenerate(admittedRequest, requestOptions)
      : path === 'continue'
        ? await generateApi.continueGeneration(admittedRequest, requestOptions)
        : await generateApi.start(admittedRequest, requestOptions)

    if (
      !isGenerationRequestCurrent(generationRequest, response.generationId, true)
      || !acceptGenerationStarted(
        request.chat_id,
        response.generationId,
        authority.requestAuthorityId ?? undefined,
      )
    ) {
      invalidateGenerationRequest(request.chat_id, response.generationId)
      throw new DOMException('Generation cancelled', 'AbortError')
    }
    return response
  } catch (error) {
    const status = error instanceof DOMException && error.name === 'AbortError'
      ? 'stopped'
      : 'error'
    useStore.getState().settleGenerationRequest(
      request.chat_id,
      status,
      undefined,
      authority.requestAuthorityId ?? undefined,
    )
    throw error
  } finally {
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

export function resetGenerationRecoveryGuardsForTests(): void {
  useStore.setState({ generationRequests: {} })
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
  // Chat exit keeps one frozen stream frame mounted for its short animation.
  // Recovery must not resume writes into that fading subtree.
  if (state.streamingNavigationPaused) return 'ignored'

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
  if (request.epoch > 0 && !isGenerationRequestCurrent(request, genStatus.generationId, genStatus.active)) return 'stale'

  // A fenced active pool snapshot identifies this exact lifecycle. Wire the
  // lifecycle first because startStreaming clears prior-run metadata, then
  // project provider/model verbatim without guessing from the model name.
  if (genStatus.active && genStatus.generationId) {
    const status = genStatus.status === 'assembling' || genStatus.status === 'waiting'
      ? 'queued'
      : 'working'
    if (!acceptGenerationStarted(
      chatId,
      genStatus.generationId,
      genStatus.requestAuthorityId,
      status,
    )) return 'stale'
    if (!latest.isStreaming || latest.activeGenerationId !== genStatus.generationId) {
      latest.startStreaming(
        genStatus.generationId,
        genStatus.targetMessageId,
        genStatus.status === 'council' ? undefined : getLocalStreamingType(genStatus.generationType),
      )
    }
    latest.setGenerationProviderMetadata({
      provider: genStatus.provider ?? null,
      model: genStatus.model ?? null,
    })
    latest.setStreamingSwipeId(genStatus.targetSwipeId ?? null)
  }

  if (
    genStatus.active &&
    genStatus.generationId &&
    genStatus.status === 'council' &&
    genStatus.councilRetryPending &&
    genStatus.councilToolsFailure
  ) {
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

    // An inactive pool may no longer retain the retired generation ID. The
    // captured authority epoch still fences this response against a newer run.
    const sameGeneration =
      genStatus.generationId == null ||
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
