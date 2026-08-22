import { get, post, type RequestOptions } from './client'
import { flushSettingsNow } from '@/store/slices/settings'
import { flushPresetForGeneration } from '@/lib/loom/preset-save-coordinator'
import {
  AgentRuntimePreflightError,
  getRuntimeSelectionSnapshot,
  isCurrentRuntimeRequest,
  prepareAgentRuntimeRequest,
  resetActiveGenerationMode,
  type PreparedRuntimeRequest,
} from '@/lib/agentRuntimeSelection'
import type { AgentRuntimeMode } from '@/types/effective-runtime'
import type { LoomPromptInspectionV1 } from '@/types/agent-runtime'

/** Generation requests go through prompt assembly + council + embedding calls
 *  which can legitimately take longer than the default 30s client timeout. */
export interface GenerationRequestOptions extends RequestOptions {
  /**
   * Invalidate a display decision resolved before a chat-affecting write (for
   * example, the user's message) and resolve against the new chat revision.
   */
  forceRuntimeRefresh?: boolean
  /**
   * Explicitly route an unsupported generation surface through Response
   * without consuming or clearing the user's Agentic selection.
   */
  forceResponse?: boolean
}

const generationIntentEpochs = new Map<string, number>()
const generationIntentControllers = new Map<string, AbortController>()

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Generation cancelled', 'AbortError')
}
function throwIfGenerationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

function beginGenerationIntent(chatId: string, externalSignal?: AbortSignal): {
  epoch: number
  controller: AbortController
  cleanup: () => void
} {
  generationIntentControllers.get(chatId)?.abort(new DOMException('Superseded generation', 'AbortError'))
  const epoch = (generationIntentEpochs.get(chatId) ?? 0) + 1
  generationIntentEpochs.set(chatId, epoch)
  const controller = new AbortController()
  const onAbort = () => controller.abort(abortReason(externalSignal))
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(abortReason(externalSignal))
    else externalSignal.addEventListener('abort', onAbort, { once: true })
  }
  generationIntentControllers.set(chatId, controller)
  return {
    epoch,
    controller,
    cleanup: () => {
      externalSignal?.removeEventListener('abort', onAbort)
      if (generationIntentControllers.get(chatId) === controller) {
        generationIntentControllers.delete(chatId)
      }
    },
  }
}

function assertGenerationIntent(chatId: string, epoch: number, signal?: AbortSignal): void {
  throwIfGenerationAborted(signal)
  if (generationIntentEpochs.get(chatId) !== epoch) {
    throw new DOMException('Generation cancelled', 'AbortError')
  }
}

/**
 * Fence and abort a preflight or POST that has not yet handed its generation
 * id to the caller. The stop endpoint calls this before targeting a known
 * generation, so an optimistic stop also handles the id-less window.
 */
export function cancelPendingGeneration(chatId: string): void {
  generationIntentEpochs.set(chatId, (generationIntentEpochs.get(chatId) ?? 0) + 1)
  generationIntentControllers.get(chatId)?.abort(new DOMException('Generation cancelled', 'AbortError'))
}

/**
 * Reserve an intent epoch for callers that must preflight before performing a
 * local presentation mutation (for example Response regenerate). The caller
 * passes the returned epoch to dispatchPreparedGeneration; Stop increments the
 * same fence through cancelPendingGeneration.
 */
export function beginPreparedGenerationIntent(chatId: string): number {
  generationIntentControllers.get(chatId)?.abort(new DOMException('Superseded generation', 'AbortError'))
  const epoch = (generationIntentEpochs.get(chatId) ?? 0) + 1
  generationIntentEpochs.set(chatId, epoch)
  return epoch
}

const LONG: RequestOptions = { timeout: 120_000 }

export type GenerationType = 'normal' | 'continue' | 'regenerate' | 'swipe' | 'impersonate' | 'quiet'

export type ImpersonateMode = 'prompts' | 'oneliner' | 'sovereign_hand'

export interface GenerateRequest {
  chat_id: string
  connection_id?: string
  persona_id?: string
  persona_addon_states?: Record<string, boolean>
  preset_id?: string
  force_preset_id?: boolean
  message_id?: string
  continue_from?: string
  force_name?: string
  generation_type?: GenerationType
  /** Target swipe index for swipe generation. */
  swipe_id?: number
  /** Explicit one-turn mode. This never mutates the preset or durable chat override. */
  mode?: AgentRuntimeMode
  /** Opaque one-use token issued by the effective-runtime preflight. */
  runtime_decision_token?: string
  /** Request epoch bound to the one-use runtime decision token. */
  request_epoch?: number
  impersonate_mode?: ImpersonateMode
  /** For impersonate: free-form text from the input box, appended to the impersonation prompt. */
  impersonate_input?: string
  /** Exact input-bar draft snapshot captured when this generation started. */
  user_input?: string
  /** For impersonate: stream to input box instead of creating a message. */
  impersonate_draft?: boolean
  target_character_id?: string
  regen_feedback?: string
  regen_feedback_position?: 'system' | 'user'
  retain_council?: boolean
  /** Dry-run only: reassemble as if this message were absent from history. */
  exclude_message_id?: string
}

export interface GenerationStopResult {
  stopped: boolean
  status: 'accepted' | 'too_late' | 'not_found'
}

export interface GenerateResponse {
  generationId: string
}

export interface QuietGenerateRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  connection_id?: string
  parameters?: Record<string, any>
  /**
   * Optional chat id. When passed to the `/generate/summarize` endpoint, the
   * server registers the job in its summarize-pool so frontends can recover
   * in-flight state via `getSummarizeStatus` and the `SUMMARIZATION_*` WS
   * events.
   */
  chat_id?: string
}

/** Request for the /summarize endpoint — backend fetches messages and builds the prompt. */
export interface SummarizeRequest {
  /** Chat ID to summarize. */
  chat_id: string
  /** Number of recent messages to include in the prompt. */
  message_context: number
  /** Previously stored summary text (may be empty). */
  existingSummary?: string
  /** Active persona / user name. */
  userName: string
  /** Active character name. */
  characterName: string
  /** Optional custom system prompt template. */
  systemPromptOverride?: string | null
  /** Optional custom user prompt template. */
  userPromptOverride?: string | null
  /** Connection profile ID for the LLM call. */
  connection_id?: string
}

export interface SummarizeStatusResponse {
  active: boolean
  generationId?: string
  startedAt?: number
}

export interface RebuildSummaryResponse {
  generationId: string
  totalBatches: number
  totalMessages: number
}

export interface QuietGenerateResponse {
  content: string
  reasoning?: string
  finish_reason: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    provider_raw?: Record<string, unknown>
  }
}

export interface SummarizationPromptDefaults {
  systemPrompt: string
  userPrompt: string
}

export interface DryRunMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  reasoning?: string
  contentParts?: Array<{
    type: string
    count: number
  }>
  __chatHistorySource?: boolean
}

export interface AssemblyBreakdownEntry {
  name: string
  type: string
  role?: string
  content?: string
  blockId?: string
  extensionId?: string
  extensionName?: string
  messageCount?: number
  firstMessageIndex?: number
}

export interface DryRunResponse {
  messages: DryRunMessage[]
  breakdown: AssemblyBreakdownEntry[]
  parameters: Record<string, any>
  assistantPrefill?: string
  model: string
  provider: string
  assemblySurface: 'RESPONSE' | 'WORK'
  loomPromptInspection?: LoomPromptInspectionV1
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    provider_raw?: Record<string, unknown>
  }
  tokenCount?: {
    total_tokens: number
    breakdown: {
      name: string
      type: string
      tokens: number
      role?: string
      extensionId?: string
      extensionName?: string
    }[]
    tokenizer_id: string | null
    tokenizer_name: string | null
  }
  chatHistoryTokens?: number
  worldInfoStats?: {
    totalCandidates: number
    activatedBeforeBudget: number
    activatedAfterBudget: number
    evictedByBudget: number
    evictedByMinPriority: number
    estimatedTokens: number
    recursionPassesUsed: number
    keywordActivated: number
    vectorActivated: number
    totalActivated: number
    queryPreview: string
    vectorRetrieval?: {
      eligibleCount: number
      hitsBeforeThreshold: number
      hitsAfterThreshold: number
      thresholdRejected: number
      hitsAfterRerankCutoff: number
      rerankRejected: number
      topK: number
      blockerMessages: string[]
      timingsMs?: {
        queryBuild: number
        queryEmbed: number
        search: number
        ranking: number
        merge: number
        total: number
      }
    }
  }
  memoryStats?: {
    enabled: boolean
    chunksRetrieved: number
    chunksAvailable: number
    chunksPending: number
    injectionMethod: 'macro' | 'fallback' | 'disabled'
    retrievalMode?: 'vector' | 'recency' | 'empty' | 'disabled'
    retrievedChunks: Array<{
      score: number | null
      tokenEstimate: number
      messageRange: [number, number]
      preview: string
    }>
    queryPreview: string
    settingsSource: 'global' | 'per_chat'
  }
  databankStats?: {
    enabled: boolean
    embeddingsEnabled: boolean
    activeBankCount: number
    activeDatabankIds: string[]
    chunksRetrieved: number
    injectionMethod: 'macro' | 'fallback' | 'none' | 'disabled'
    retrievalState:
      | 'cache_hit'
      | 'awaited_prefetch'
      | 'awaited_direct'
      | 'skipped_no_active_banks'
      | 'skipped_embeddings_disabled'
    retrievedChunks: Array<{
      score: number | null
      tokenEstimate: number
      documentName: string
      databankId: string
      preview: string
    }>
    queryPreview: string
  }
  contextClipStats?: import('@/types/ws-events').ContextClipStats
}

export interface BreakdownResponse {
  entries: {
    name: string
    type: string
    tokens: number
    role?: string
    content?: string
    blockId?: string
    extensionId?: string
    extensionName?: string
    messageCount?: number
    firstMessageIndex?: number
  }[]
  messages?: DryRunMessage[]
  totalTokens: number
  chatHistoryTokens?: number
  maxContext: number
  model: string
  provider: string
  assemblySurface?: 'RESPONSE' | 'WORK'
  loomPromptInspection?: LoomPromptInspectionV1
  parameters?: Record<string, unknown>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    provider_raw?: Record<string, unknown>
  }
  presetName?: string
  tokenizer_name: string | null
}

export interface GenerationStatusResponse {
  active: boolean
  generationId?: string
  status?: 'assembling' | 'council' | 'waiting' | 'streaming' | 'completed' | 'stopped' | 'error' | 'reasoning'
  councilRetryPending?: boolean
  councilToolsFailure?: {
    generationId: string
    chatId: string
    failedTools: {
      memberId: string
      memberName: string
      toolName: string
      toolDisplayName: string
      error?: string
    }[]
    successCount: number
    failedCount: number
  }
  content?: string
  reasoning?: string
  /** Char position where the returned content/reasoning slice begins (0 = full
   *  buffer). Non-zero only when the poll sent matching known lengths. */
  contentOffset?: number
  reasoningOffset?: number
  tokenSeq?: number
  generationType?: string
  targetMessageId?: string
  targetSwipeId?: number
  characterName?: string
  characterId?: string
  model?: string
  startedAt?: number
  reasoningStartedAt?: number
  reasoningDurationMs?: number
  completedMessageId?: string
  completedAt?: number
  error?: string
}

export interface ActiveGenerationEntry {
  generationId: string
  chatId: string
  status: 'assembling' | 'council' | 'waiting' | 'streaming' | 'completed' | 'stopped' | 'error' | 'reasoning'
  generationType: string
  characterName: string
  characterId?: string
  model: string
  startedAt: number
  councilRetryPending: boolean
}

type GenerationPath = '/generate' | '/generate/regenerate' | '/generate/continue'

function impliedGenerationType(path: GenerationPath): GenerationType {
  return path === '/generate/regenerate'
    ? 'regenerate'
    : path === '/generate/continue'
      ? 'continue'
      : 'normal'
}

export async function preflightGeneration(
  path: GenerationPath,
  request: GenerateRequest,
  options: GenerationRequestOptions = {},
): Promise<PreparedRuntimeRequest<GenerateRequest>> {
  throwIfGenerationAborted(options.signal)
  resetActiveGenerationMode(request.chat_id)
  await flushSettingsNow()
  throwIfGenerationAborted(options.signal)
  await flushPresetForGeneration(request.preset_id)
  throwIfGenerationAborted(options.signal)
  return prepareAgentRuntimeRequest({
    ...request,
    generation_type: request.generation_type ?? impliedGenerationType(path),
  }, options)
}

export async function dispatchPreparedGeneration(
  path: GenerationPath,
  prepared: PreparedRuntimeRequest<GenerateRequest>,
  options: GenerationRequestOptions = {},
  intentEpoch?: number,
): Promise<GenerateResponse> {
  assertGenerationIntent(prepared.request.chat_id, intentEpoch ?? (generationIntentEpochs.get(prepared.request.chat_id) ?? 0), options.signal)
  if (prepared.request.mode === 'agentic') {
    const runtimeEpoch = prepared.request.request_epoch
    const selection = getRuntimeSelectionSnapshot(prepared.request.chat_id)
    if (
      typeof runtimeEpoch !== 'number'
      || !isCurrentRuntimeRequest(prepared.request.chat_id, runtimeEpoch)
      || selection.oneTurnMode === 'response'
      || selection.activeGenerationMode !== 'agentic'
    ) {
      throw new AgentRuntimePreflightError('decision_refresh_required', ['decision_refresh_required'])
    }
  }
  const { forceRuntimeRefresh: _forceRuntimeRefresh, forceResponse: _forceResponse, ...requestOptions } = options
  const response = await post<GenerateResponse>(path, prepared.request, { ...LONG, ...requestOptions })
  assertGenerationIntent(prepared.request.chat_id, intentEpoch ?? (generationIntentEpochs.get(prepared.request.chat_id) ?? 0), options.signal)
  if (prepared.request.mode === 'agentic') {
    const runtimeEpoch = prepared.request.request_epoch
    const selection = getRuntimeSelectionSnapshot(prepared.request.chat_id)
    if (
      typeof runtimeEpoch !== 'number'
      || !isCurrentRuntimeRequest(prepared.request.chat_id, runtimeEpoch)
      || selection.oneTurnMode === 'response'
      || selection.activeGenerationMode !== 'agentic'
    ) {
      throw new AgentRuntimePreflightError('decision_refresh_required', ['decision_refresh_required'])
    }
  }
  prepared.commitOneTurnSelection()
  return response
}

async function startPreparedGeneration(
  path: GenerationPath,
  request: GenerateRequest,
  options: GenerationRequestOptions = {},
) {
  const intent = beginGenerationIntent(request.chat_id, options.signal)
  try {
    const intentOptions: GenerationRequestOptions = {
      ...options,
      signal: intent.controller.signal,
    }
    const prepared = await preflightGeneration(path, request, intentOptions)
    assertGenerationIntent(request.chat_id, intent.epoch, intent.controller.signal)
    return await dispatchPreparedGeneration(path, prepared, intentOptions, intent.epoch)
  } catch (error) {
    resetActiveGenerationMode(request.chat_id)
    throw error
  } finally {
    intent.cleanup()
  }
}

export const generateApi = {
  preflightGeneration,
  dispatchPreparedGeneration,
  start(request: GenerateRequest, options?: GenerationRequestOptions) {
    return startPreparedGeneration('/generate', request, options)
  },

  stop(generationId?: string, chatId?: string) {
    // Fence the optimistic preflight/POST window before asking the backend to
    // stop a known generation (or whatever is active for this chat).
    if (chatId) cancelPendingGeneration(chatId)
    // chat_id lets the backend fall back to stopping whatever is actually
    // running for the chat when generation_id is stale (or not yet known).
    const body: Record<string, string> = {}
    if (generationId) body.generation_id = generationId
    if (chatId) body.chat_id = chatId
    return post<GenerationStopResult>('/generate/stop', body)
  },

  regenerate(request: GenerateRequest, options?: GenerationRequestOptions) {
    return startPreparedGeneration('/generate/regenerate', request, options)
  },

  continueGeneration(request: GenerateRequest, options?: GenerationRequestOptions) {
    return startPreparedGeneration('/generate/continue', request, options)
  },

  quiet(request: QuietGenerateRequest) {
    return post<QuietGenerateResponse>('/generate/quiet', request, LONG)
  },

  summarize(request: SummarizeRequest, options: RequestOptions = LONG) {
    return post<QuietGenerateResponse>('/generate/summarize', request, options)
  },

  getSummarizationDefaults() {
    return get<SummarizationPromptDefaults>('/generate/summarize/prompt-defaults')
  },

  getSummarizeStatus(chatId: string) {
    return get<SummarizeStatusResponse>(`/generate/summarize/status/${chatId}`)
  },

  rebuildSummary(chatId: string, batchSize: number, userName: string, options?: {
    system_prompt_override?: string | null
    user_prompt_override?: string | null
    connection_id?: string
  }) {
    return post<RebuildSummaryResponse>('/generate/summarize/rebuild', {
      chat_id: chatId,
      batch_size: batchSize,
      user_name: userName,
      ...options,
    }, LONG)
  },

  async dryRun(request: GenerateRequest) {
    await flushSettingsNow()
    await flushPresetForGeneration(request.preset_id)
    return post<DryRunResponse>('/generate/dry-run', request, LONG)
  },

  getBreakdown(messageId: string) {
    return get<BreakdownResponse>(`/generate/breakdown/${messageId}`)
  },

  getStatus(chatId: string, known?: { generationId: string; contentLen: number; reasoningLen: number }) {
    return get<GenerationStatusResponse>(`/generate/status/${chatId}`, known)
  },

  getActive() {
    return get<ActiveGenerationEntry[]>('/generate/active')
  },

  acknowledge(chatId: string) {
    return post<{ acknowledged: boolean; removed: number; generationIds: string[] }>('/generate/acknowledge', { chatId })
  },

  councilRetry(generationId: string, decision: 'continue' | 'retry') {
    return post<{ resolved: boolean }>('/generate/council-retry', { generation_id: generationId, decision })
  },
}
