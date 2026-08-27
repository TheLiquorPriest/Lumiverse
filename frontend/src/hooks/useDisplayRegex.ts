import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import { trackInitialDisplayResolve } from '@/lib/chatDisplaySettle'
import { applyDisplayRegexTiered } from '@/lib/regex/pipeline'
import { resolveMacrosBatch } from '@/api/macros'
import { isDisplayChatOwned, getDisplayResolverForChat } from '@/lib/spindle/display-resolver-registry'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import type { DisplayMacroContext } from '@/lib/resolveDisplayMacros'
import type { RegexScript } from '@/types/regex'
import type { Message } from '@/types/api'

interface ResolvedDisplayRegexTemplates {
  resolvedFindPatterns: Map<string, string>
  resolvedReplacements: Map<string, string>
}

interface DisplayRegexCacheEntry {
  value?: ResolvedDisplayRegexTemplates
  promise?: Promise<ResolvedDisplayRegexTemplates>
  touchedVars?: ReadonlySet<string>
}

interface DisplayRegexContentCacheEntry {
  value?: string
  promise?: Promise<string>
  touchedVars?: ReadonlySet<string>
  messageId?: string
}

export interface DisplayPreprocessOpts {
  messageId: string
  role: 'user' | 'assistant' | 'system'
  chatId?: string
  depth?: number
  messageIndex?: number
  dynamicMacros?: Record<string, string>
}

interface ResolvedTemplatesState {
  key: string
  value: ResolvedDisplayRegexTemplates
}

interface ResolvedContentState {
  key: string
  value: string
}

interface SlowRegexReport {
  script: RegexScript
  elapsedMs: number
  timedOut: boolean
  thresholdMs: number
}

interface DisplayPreprocessBody {
  messageId: string
  role: string
  rawContent: string
  depth?: number
  messageIndex?: number
  dynamicMacros?: Record<string, string>
}

interface DisplayPreprocessOutcome {
  content: string
  ok: boolean
  touchedVars?: readonly string[]
  cacheable?: boolean
}

interface PendingDisplayPreprocess {
  body: DisplayPreprocessBody
  resolve: (value: string) => void
}

const displayRegexResolutionCache = new Map<string, DisplayRegexCacheEntry>()
const displayRegexContentCache = new Map<string, DisplayRegexContentCacheEntry>()
const displayPreprocessCache = new Map<string, { value?: string; promise?: Promise<DisplayPreprocessOutcome>; touchedVars?: ReadonlySet<string>; messageId?: string }>()
const DISPLAY_PREPROCESS_CACHE_MAX = 500
const DISPLAY_REGEX_CONTENT_CACHE_MAX = 300

// FIFO eviction for displayRegexContentCache; streaming inserts one key per
// chunk with full content embedded, so the map needs a hard size bound.
function evictDisplayRegexContentCacheOverflow(): void {
  if (displayRegexContentCache.size <= DISPLAY_REGEX_CONTENT_CACHE_MAX) return
  const drop = displayRegexContentCache.size - DISPLAY_REGEX_CONTENT_CACHE_MAX
  let i = 0
  for (const k of displayRegexContentCache.keys()) {
    if (i++ >= drop) break
    displayRegexContentCache.delete(k)
  }
}
const displayRegexCacheListeners = new Set<() => void>()
let displayRegexGlobalCv = 0
const displayRegexPerMessageCv = new Map<string, number>()
const slowDisplayRegexToastKeys = new Set<string>()
const recoveredDisplayRegexReportKeys = new Set<string>()
const displayPreprocessQueues = new Map<string, PendingDisplayPreprocess[]>()
const DISPLAY_PREPROCESS_BATCH_MAX = 64
const DISPLAY_PREPROCESS_BATCH_DELAY_MS = 8
let displayPreprocessFlushTimer: number | null = null

// Trailing-edge coalescing for per-token streaming re-resolution. Rapid
// content updates for the SAME message collapse into at most one resolver
// round-trip per window; the leading call still runs immediately so
// single-shot resolves (initial mount, generation end, invalidations while
// idle) never gain latency. The final update of a burst always flushes on the
// trailing timer, so settled content is guaranteed to resolve.
const DISPLAY_RESOLVE_COALESCE_MS = 180
interface DisplayCoalesceState {
  lastRun: number
  // Cancel handle for the armed trailing timer, or null when no timer is live.
  cancelTimer: (() => void) | null
  pending: (() => void) | null
}
const displayCoalesceStates = new Map<string, DisplayCoalesceState>()
const DISPLAY_COALESCE_STATE_MAX = 512

// Injectable clock/timer so unit tests can drive the trailing edge without
// real time. Production default uses the host window timers.
export interface DisplayCoalesceDeps {
  now(): number
  scheduleTimer(fn: () => void, ms: number): () => void
}
let displayCoalesceDeps: DisplayCoalesceDeps | null = null
function getDisplayCoalesceDeps(): DisplayCoalesceDeps {
  if (!displayCoalesceDeps) {
    displayCoalesceDeps = {
      now: () => Date.now(),
      scheduleTimer: (fn, ms) => {
        const id = window.setTimeout(fn, ms)
        return () => window.clearTimeout(id)
      },
    }
  }
  return displayCoalesceDeps
}

export function setDisplayCoalesceDepsForTests(deps: DisplayCoalesceDeps): void {
  displayCoalesceDeps = deps
}

export function resetDisplayCoalesceForTests(): void {
  displayCoalesceDeps = null
  displayCoalesceStates.clear()
}

function pruneDisplayCoalesceStates(): void {
  if (displayCoalesceStates.size <= DISPLAY_COALESCE_STATE_MAX) return
  const now = Date.now()
  for (const [key, st] of displayCoalesceStates) {
    if (displayCoalesceStates.size <= DISPLAY_COALESCE_STATE_MAX / 2) break
    if (st.cancelTimer === null && st.pending === null && now - st.lastRun > 60_000) {
      displayCoalesceStates.delete(key)
    }
  }
}

export function scheduleCoalescedDisplayResolve(key: string | null, run: () => void): () => void {
  if (!key) {
    run()
    return () => {}
  }
  const deps = getDisplayCoalesceDeps()
  let st = displayCoalesceStates.get(key)
  if (!st) {
    st = { lastRun: 0, cancelTimer: null, pending: null }
    displayCoalesceStates.set(key, st)
    pruneDisplayCoalesceStates()
  }
  const now = deps.now()
  if (st.cancelTimer === null && now - st.lastRun >= DISPLAY_RESOLVE_COALESCE_MS) {
    st.lastRun = now
    run()
    return () => {}
  }
  // Mid-burst: keep only the newest work item; the trailing timer executes it.
  st.pending = run
  if (st.cancelTimer === null) {
    st.cancelTimer = deps.scheduleTimer(() => {
      st.cancelTimer = null
      const pendingWork = st.pending
      st.pending = null
      st.lastRun = deps.now()
      pendingWork?.()
    }, DISPLAY_RESOLVE_COALESCE_MS - (now - st.lastRun))
  }
  return () => {
    // Effect cleanup (re-render with new deps or unmount): drop this closure,
    // but leave any timer alive for the next effect run to re-arm against.
    if (st.pending === run) st.pending = null
  }
}

/**
 * The chat reveal gate only needs the first display pass for a live message.
 * Every later streaming flush has a distinct cache key, but treating each of
 * those keys as another "initial" resolve keeps recovery chats hidden for as
 * long as tokens continue to arrive. Keep idle/finalized resolves fully
 * tracked, while registering exactly one key for each message stream.
 *
 * Preprocessing and regex application each use their own instance so the
 * reveal still waits for both stages of the first recovered frame.
 */
function useDisplaySettleTracker(
  chatId: string | null,
  messageId: string | null,
  isStreaming: boolean,
) {
  const identity = chatId && messageId ? `${chatId}\u0000${messageId}` : null
  const stateRef = useRef({
    identity,
    wasStreaming: isStreaming,
    trackedCurrentStream: false,
  })
  const state = stateRef.current

  if (state.identity !== identity || (!state.wasStreaming && isStreaming)) {
    state.identity = identity
    state.trackedCurrentStream = false
  }
  state.wasStreaming = isStreaming

  return useCallback(<T,>(promise: Promise<T>): Promise<T> => {
    if (isStreaming) {
      if (stateRef.current.trackedCurrentStream) return promise
      stateRef.current.trackedCurrentStream = true
    }
    return trackInitialDisplayResolve(promise, chatId)
  }, [chatId, isStreaming])
}

function bumpGlobalCv(): void {
  displayRegexGlobalCv += 1
  for (const listener of displayRegexCacheListeners) listener()
}

function bumpPerMessageCv(messageId: string): void {
  displayRegexPerMessageCv.set(messageId, (displayRegexPerMessageCv.get(messageId) ?? 0) + 1)
  for (const listener of displayRegexCacheListeners) listener()
}

function formatElapsedMs(elapsedMs: number): string {
  if (elapsedMs >= 1000) return `${(elapsedMs / 1000).toFixed(1)}s`
  return `${Math.round(elapsedMs)}ms`
}

function reportSlowDisplayRegex(script: RegexScript, elapsedMs: number, timedOut: boolean, thresholdMs: number): void {
  const versionKey = `${script.id}:${script.updated_at}`
  // A newly slow run needs a later recovery report, even if this version had
  // previously recovered during the current page session.
  recoveredDisplayRegexReportKeys.delete(versionKey)
  if (!slowDisplayRegexToastKeys.has(versionKey)) {
    slowDisplayRegexToastKeys.add(versionKey)
    toast.warning(
      timedOut
        ? i18n.t('panels:regexPanel.slowDisplayTimedOut', { name: script.name })
        : i18n.t('panels:regexPanel.slowDisplaySlow', { name: script.name, duration: formatElapsedMs(elapsedMs) }),
      { title: i18n.t('panels:regexPanel.slowDisplayTitle'), duration: 7000 },
    )
  }

  void regexApi.reportPerformance(script.id, {
    elapsed_ms: elapsedMs,
    timed_out: timedOut,
    threshold_ms: thresholdMs,
    source: 'display_client',
  }).catch(() => {})
}

function reportRecoveredDisplayRegex(script: RegexScript, elapsedMs: number, thresholdMs: number): void {
  const versionKey = `${script.id}:${script.updated_at}`
  if (recoveredDisplayRegexReportKeys.has(versionKey)) return
  recoveredDisplayRegexReportKeys.add(versionKey)

  void regexApi.reportPerformance(script.id, {
    elapsed_ms: elapsedMs,
    threshold_ms: thresholdMs,
    source: 'display_client',
  }).catch(() => {
    // Keep retrying on a future render if this recovery report was not saved.
    recoveredDisplayRegexReportKeys.delete(versionKey)
  })
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16)
}

async function resolveTemplatesWithResolver(
  templates: Record<string, string>,
  ctx: { chatId?: string; characterId?: string; personaId?: string },
): Promise<{ resolved: Record<string, string>; touched_vars?: Record<string, string[]>; cacheable?: Record<string, boolean> }> {
  if (ctx.chatId && isDisplayChatOwned(ctx.chatId)) {
    const resolver = getDisplayResolverForChat(ctx.chatId)
    if (resolver) {
      try {
        const local = await resolver.resolveTemplates({
          templates,
          context: {
            chatId: ctx.chatId,
            characterId: ctx.characterId,
            personaId: ctx.personaId,
            isUser: false,
            depth: 0,
          },
        })
        if (local) {
          return {
            resolved: local.resolved,
            ...(local.touchedVars ? { touched_vars: local.touchedVars } : {}),
            ...(local.cacheable ? { cacheable: local.cacheable } : {}),
          }
        }
        console.error(`[display] resolver.resolveTemplates returned null for owned chat=${ctx.chatId}; showing raw (no backend fallback)`)
      } catch (err) {
        console.error(`[display] resolver.resolveTemplates threw for owned chat=${ctx.chatId}; showing raw (no backend fallback)`, err)
      }
    }
    return { resolved: { ...templates } }
  }
  return resolveMacrosBatch({
    templates,
    chat_id: ctx.chatId,
    character_id: ctx.characterId,
    persona_id: ctx.personaId,
  })
}

async function fetchDisplayPreprocessBatch(
  chatId: string,
  bodies: DisplayPreprocessBody[],
): Promise<string[]> {
  try {
    const res = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}/display-preprocess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: bodies }),
      credentials: 'include',
    })
    if (!res.ok) return bodies.map((body) => body.rawContent)
    const json = (await res.json()) as { items?: Array<{ content?: unknown }> }
    if (!Array.isArray(json.items)) return bodies.map((body) => body.rawContent)
    return bodies.map((body, index) => {
      const content = json.items?.[index]?.content
      return typeof content === 'string' ? content : body.rawContent
    })
  } catch {
    return bodies.map((body) => body.rawContent)
  }
}

function flushDisplayPreprocessQueue(): void {
  displayPreprocessFlushTimer = null

  for (const [chatId, queue] of displayPreprocessQueues) {
    displayPreprocessQueues.delete(chatId)
    for (let i = 0; i < queue.length; i += DISPLAY_PREPROCESS_BATCH_MAX) {
      const batch = queue.slice(i, i + DISPLAY_PREPROCESS_BATCH_MAX)
      void fetchDisplayPreprocessBatch(chatId, batch.map((item) => item.body))
        .then((contents) => {
          batch.forEach((item, index) => item.resolve(contents[index] ?? item.body.rawContent))
        })
    }
  }
}

function enqueueDisplayPreprocess(chatId: string, body: DisplayPreprocessBody): Promise<string> {
  return new Promise((resolve) => {
    const queue = displayPreprocessQueues.get(chatId)
    if (queue) queue.push({ body, resolve })
    else displayPreprocessQueues.set(chatId, [{ body, resolve }])

    if (displayPreprocessFlushTimer === null) {
      displayPreprocessFlushTimer = window.setTimeout(flushDisplayPreprocessQueue, DISPLAY_PREPROCESS_BATCH_DELAY_MS)
    }
  })
}

export function fetchDisplayPreprocess(chatId: string, body: DisplayPreprocessBody): Promise<DisplayPreprocessOutcome> {
  if (isDisplayChatOwned(chatId)) {
    const resolver = getDisplayResolverForChat(chatId)
    if (resolver) {
      return resolver
        .resolveBody({
          content: body.rawContent,
          context: {
            chatId,
            isUser: body.role === 'user',
            depth: body.depth ?? 0,
            messageId: body.messageId,
            role: body.role,
            ...(typeof body.messageIndex === 'number' ? { messageIndex: body.messageIndex } : {}),
            ...(body.dynamicMacros ? { dynamicMacros: body.dynamicMacros } : {}),
          },
        })
        .then((local) => {
          if (local) {
            return {
              content: local.content,
              ok: true,
              ...(Array.isArray(local.touchedVars) && local.touchedVars.length > 0
                ? { touchedVars: local.touchedVars }
                : {}),
              cacheable: local.cacheable !== false,
            }
          }
          console.error(`[display] resolver.resolveBody returned null for owned chat=${chatId}; showing raw (no backend fallback)`)
          return { content: body.rawContent, ok: false }
        })
        .catch((err: unknown) => {
          console.error(`[display] resolver.resolveBody threw for owned chat=${chatId}; showing raw (no backend fallback)`, err)
          return { content: body.rawContent, ok: false }
        })
    }
    return Promise.resolve({ content: body.rawContent, ok: false })
  }
  return enqueueDisplayPreprocess(chatId, body).then((content) => ({ content, ok: true }))
}

interface DisplayPreprocessedState {
  value: string
  // False while the preprocess is pending or an owning resolver failed.
  ready: boolean
  // False while `value` is a same-identity carry of an OLDER content's
  // preprocess output, i.e. the newest key is still in flight.
  settled: boolean
}

function useDisplayPreprocessedState(
  content: string,
  chatId: string | null,
  opts: DisplayPreprocessOpts | undefined,
  isStreaming = false,
): DisplayPreprocessedState {
  const messageIdForSnapshot = opts?.messageId ?? null
  const trackForDisplaySettle = useDisplaySettleTracker(
    chatId,
    messageIdForSnapshot,
    isStreaming,
  )
  const getSnapshotForThisMessage = useCallback(
    () => getDisplayRegexCacheSnapshot(messageIdForSnapshot),
    [messageIdForSnapshot],
  )
  const cvSnapshot = useSyncExternalStore(
    subscribeDisplayRegexCache,
    getSnapshotForThisMessage,
    getSnapshotForThisMessage,
  )

  const key = useMemo(() => {
    if (!opts?.messageId || !chatId) return null
    return `${chatId}|${opts.messageId}|${opts.role}|${opts.depth ?? 0}|${opts.messageIndex ?? -1}|${JSON.stringify(opts.dynamicMacros ?? {})}|${content.length}|${fnv1a(content)}`
  }, [content, opts?.messageId, opts?.role, opts?.depth, opts?.messageIndex, opts?.dynamicMacros, chatId])

  const cached = key ? displayPreprocessCache.get(key)?.value : undefined
  const [state, setState] = useState<{ key: string; value: string; ok: boolean } | null>(() =>
    key && cached !== undefined ? { key, value: cached, ok: true } : null,
  )

  const lastRef = useRef<{ raw: string; value: string } | null>(null)
  if (key && cached !== undefined) lastRef.current = { raw: content, value: cached }
  else if (key && state?.key === key && state.ok) lastRef.current = { raw: content, value: state.value }

  // Same-(chat, message, stream) continuity carry. `lastRef` above only serves
  // an EXACT raw match, so it can never serve a newer input: every content
  // change (each streaming flush, and the streaming -> final commit when the
  // saved row differs from the last streamed chunk) would otherwise commit
  // UNPREPROCESSED source until the async round trip lands. The carry keeps the
  // newest already-preprocessed value of THIS message on screen while the newest
  // key is pending, and is dropped when the chat/message identity changes or a
  // new stream begins, so preprocessed text can never cross identities.
  const carryRef = useRef<{ chatId: string | null; messageId: string | null; value: string } | null>(null)
  const carryIdentityRef = useRef<{ chatId: string | null; messageId: string | null }>({
    chatId,
    messageId: messageIdForSnapshot,
  })
  const wasStreamingRef = useRef(isStreaming)
  const finalKeyPendingRef = useRef(false)
  if (
    carryIdentityRef.current.chatId !== chatId
    || carryIdentityRef.current.messageId !== messageIdForSnapshot
  ) {
    carryIdentityRef.current = { chatId, messageId: messageIdForSnapshot }
    carryRef.current = null
    finalKeyPendingRef.current = false
  }
  if (!wasStreamingRef.current && isStreaming) {
    carryRef.current = null
    finalKeyPendingRef.current = false
  } else if (wasStreamingRef.current && !isStreaming) {
    // One-shot latch for the finalization commit, whose authoritative content
    // is a different key than the last streamed chunk.
    finalKeyPendingRef.current = true
  }
  wasStreamingRef.current = isStreaming
  const rememberCarry = (value: string): void => {
    carryRef.current = { chatId, messageId: messageIdForSnapshot, value }
  }

  useEffect(() => {
    if (!key || !opts?.messageId || !chatId) {
      setState((cur) => (cur === null ? cur : null))
      return
    }
    let cancelled = false
    const apply = (next: DisplayPreprocessOutcome) => {
      if (!cancelled) setState({ key, value: next.content, ok: next.ok })
    }
    const run = () => {
      const existing = displayPreprocessCache.get(key)
      if (existing?.value !== undefined) {
        apply({ content: existing.value, ok: true })
        return
      }
      if (!existing?.promise) {
        const messageIdForEntry = opts.messageId
        let assignedPromise: Promise<DisplayPreprocessOutcome>
        const promise = fetchDisplayPreprocess(chatId, {
          messageId: opts.messageId,
          role: opts.role,
          rawContent: content,
          ...(typeof opts.depth === 'number' ? { depth: opts.depth } : {}),
          ...(typeof opts.messageIndex === 'number' ? { messageIndex: opts.messageIndex } : {}),
          ...(opts.dynamicMacros ? { dynamicMacros: opts.dynamicMacros } : {}),
        })
          .then((next) => {
            if (displayPreprocessCache.get(key)?.promise === assignedPromise) {
              if (next.ok && next.cacheable !== false) {
                displayPreprocessCache.set(key, {
                  value: next.content,
                  messageId: messageIdForEntry,
                  ...(next.touchedVars && next.touchedVars.length > 0
                    ? { touchedVars: new Set(next.touchedVars) }
                    : {}),
                })
                if (displayPreprocessCache.size > DISPLAY_PREPROCESS_CACHE_MAX) {
                  const drop = displayPreprocessCache.size - DISPLAY_PREPROCESS_CACHE_MAX
                  let i = 0
                  for (const k of displayPreprocessCache.keys()) {
                    if (i++ >= drop) break
                    displayPreprocessCache.delete(k)
                  }
                }
              } else {
                displayPreprocessCache.delete(key)
              }
            }
            return next
          })
          .catch(() => {
            if (displayPreprocessCache.get(key)?.promise === assignedPromise) {
              displayPreprocessCache.delete(key)
            }
            return { content, ok: false }
          })
        // Scope the pending count to THIS chat, and only count the first key of
        // an active stream. Recovery can commit a new content key every 32ms;
        // those continuity updates must not indefinitely postpone chat reveal.
        assignedPromise = trackForDisplaySettle(promise)
        displayPreprocessCache.set(key, { promise: assignedPromise, messageId: messageIdForEntry })
      }
      displayPreprocessCache.get(key)?.promise?.then(apply)
    }
    // Coalesce per-token churn of the same message into one resolve per window.
    const cancelCoalesce = scheduleCoalescedDisplayResolve(`${chatId}|${opts.messageId}|pre`, run)
    return () => { cancelled = true; cancelCoalesce() }
  }, [
    key,
    opts?.messageId,
    opts?.role,
    opts?.depth,
    opts?.messageIndex,
    opts?.dynamicMacros,
    chatId,
    content,
    cvSnapshot,
    trackForDisplaySettle,
  ])

  if (!key) return { value: content, ready: true, settled: true }
  if (cached !== undefined) {
    rememberCarry(cached)
    return { value: cached, ready: true, settled: true }
  }
  if (state?.key === key) {
    if (state.ok) rememberCarry(state.value)
    return { value: state.value, ready: state.ok, settled: true }
  }
  if (lastRef.current?.raw === content) return { value: lastRef.current.value, ready: true, settled: true }
  const carried = carryRef.current
  if (
    carried !== null
    && carried.chatId === chatId
    && carried.messageId === messageIdForSnapshot
    && (isStreaming || finalKeyPendingRef.current)
    && content.length > 0
  ) {
    // Preprocessed, just one key behind. The stream buffer is append-only, so
    // this always contains the previously visible prefix.
    return { value: carried.value, ready: true, settled: false }
  }
  return { value: content, ready: false, settled: false }
}

export function useDisplayPreprocessed(
  content: string,
  chatId: string | null,
  opts: DisplayPreprocessOpts | undefined,
): string {
  return useDisplayPreprocessedState(content, chatId, opts).value
}

const RAW_MACRO_RE = /\{\{(?!\s*(?:user|char|bot|notChar|not_char|charName)\s*\}\})/i

// id→index lookup shared across every mounted message card, built once per
// messages-array identity. The previous per-card findIndex selector was
// O(messages) per card per store update — O(n²) on chat open.
const messageIndexMaps = new WeakMap<readonly Message[], Map<string, number>>()
const previousSameRoleMaps = new WeakMap<
  readonly Message[],
  Map<string, string | undefined>
>()

function getMessageIndex(messages: readonly Message[], messageId: string): number {
  let map = messageIndexMaps.get(messages)
  if (!map) {
    map = new Map()
    for (let i = 0; i < messages.length; i++) map.set(messages[i]!.id, i)
    messageIndexMaps.set(messages, map)
  }
  return map.get(messageId) ?? -1
}

function getPreviousSameRoleContent(
  messages: readonly Message[],
  messageId: string,
): string | undefined {
  let map = previousSameRoleMaps.get(messages)
  if (!map) {
    map = new Map()
    const greeting = messages[0]?.content
    let previousUser: string | undefined
    let previousAssistant: string | undefined
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!
      map.set(
        message.id,
        index === 0
          ? undefined
          : message.is_user
            ? previousUser ?? greeting
            : previousAssistant ?? greeting,
      )
      if (message.is_user) previousUser = message.content
      else previousAssistant = message.content
    }
    previousSameRoleMaps.set(messages, map)
  }
  return map.get(messageId)
}

/** Quick check for macro syntax in a string. */
function hasMacroSyntax(s: string): boolean {
  return s.includes('{{') || s.includes('<USER>') || s.includes('<BOT>') || s.includes('<CHAR>')
}

function createEmptyResolvedTemplates(): ResolvedDisplayRegexTemplates {
  return {
    resolvedFindPatterns: new Map(),
    resolvedReplacements: new Map(),
  }
}

const EMPTY_RESOLVED_TEMPLATES = createEmptyResolvedTemplates()

function subscribeDisplayRegexCache(listener: () => void): () => void {
  displayRegexCacheListeners.add(listener)
  return () => displayRegexCacheListeners.delete(listener)
}

function getDisplayRegexCacheSnapshot(messageId: string | null): string {
  const perMsg = messageId ? (displayRegexPerMessageCv.get(messageId) ?? 0) : 0
  return `${displayRegexGlobalCv}|${perMsg}`
}

export function invalidateDisplayRegexCache(): void {
  displayRegexResolutionCache.clear()
  displayRegexContentCache.clear()
  displayPreprocessCache.clear()
  bumpGlobalCv()
}

export function invalidateDisplayRegexCacheForMessage(messageId: string): void {
  let removed = 0
  for (const [key, entry] of displayRegexContentCache) {
    if (entry.messageId === messageId) { displayRegexContentCache.delete(key); removed++ }
  }
  for (const [key, entry] of displayPreprocessCache) {
    if (entry.messageId === messageId) { displayPreprocessCache.delete(key); removed++ }
  }
  if (removed > 0) bumpPerMessageCv(messageId)
}

export function invalidateDisplayRegexCacheForVars(changedVars: ReadonlySet<string>): void {
  if (changedVars.size === 0) return
  const affectedMessages = new Set<string>()
  for (const [key, entry] of displayRegexContentCache) {
    const fp = entry.touchedVars
    // Entries without touchedVars are dependency-free (output depends only on
    // their cache key), so var-scoped invalidation cannot affect them.
    if (!fp) continue
    for (const v of fp) {
      if (changedVars.has(v)) {
        displayRegexContentCache.delete(key)
        if (entry.messageId) affectedMessages.add(entry.messageId)
        break
      }
    }
  }
  for (const [key, entry] of displayPreprocessCache) {
    const fp = entry.touchedVars
    if (!fp) continue
    for (const v of fp) {
      if (changedVars.has(v)) {
        displayPreprocessCache.delete(key)
        if (entry.messageId) affectedMessages.add(entry.messageId)
        break
      }
    }
  }
  // Selective clear by touchedVars
  for (const [key, entry] of displayRegexResolutionCache) {
    const fp = entry.touchedVars
    if (!fp) { displayRegexResolutionCache.delete(key); continue }
    for (const v of fp) {
      if (changedVars.has(v)) { displayRegexResolutionCache.delete(key); break }
    }
  }
  for (const messageId of affectedMessages) bumpPerMessageCv(messageId)
  bumpGlobalCv()
}

export function seedDisplayPreprocessEntryForTests(entry: {
  key: string
  value: string
  messageId?: string
  touchedVars?: Iterable<string>
}): void {
  displayPreprocessCache.set(entry.key, {
    value: entry.value,
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(entry.touchedVars ? { touchedVars: new Set(entry.touchedVars) } : {}),
  })
}

export function getDisplayPreprocessCacheStatsForTests(): { size: number } {
  return { size: displayPreprocessCache.size }
}

export function seedDisplayContentEntryForTests(entry: {
  key: string
  value: string
  messageId?: string
  touchedVars?: Iterable<string>
}): void {
  displayRegexContentCache.set(entry.key, {
    value: entry.value,
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(entry.touchedVars ? { touchedVars: new Set(entry.touchedVars) } : {}),
  })
  evictDisplayRegexContentCacheOverflow()
}

export function getDisplayContentCacheStatsForTests(): { size: number; hasKey(key: string): boolean } {
  return { size: displayRegexContentCache.size, hasKey: (k) => displayRegexContentCache.has(k) }
}

export function resetDisplayRegexCachesForTests(): void {
  displayPreprocessCache.clear()
  displayRegexContentCache.clear()
  displayRegexResolutionCache.clear()
  displayRegexPerMessageCv.clear()
}

async function resolveMacrosBatchChunked(
  templates: Record<string, string>,
  context: {
    chat_id?: string
    character_id?: string
    persona_id?: string
  },
): Promise<Record<string, string>> {
  const entries = Object.entries(templates)
  if (entries.length === 0) return {}

  const chunkPromises: Array<Promise<Record<string, string>>> = []
  for (let i = 0; i < entries.length; i += 100) {
    chunkPromises.push(
      resolveMacrosBatch({
        templates: Object.fromEntries(entries.slice(i, i + 100)),
        ...context,
      }).then((res) => res.resolved),
    )
  }

  const chunks = await Promise.all(chunkPromises)
  return Object.assign({}, ...chunks)
}

export function useDisplayRegex(
  rawContent: string,
  isUser: boolean,
  depth: number,
  macroCtx?: DisplayMacroContext,
  preprocessOpts?: DisplayPreprocessOpts,
  isStreaming = false,
): string {
  const regexScripts = useStore((s) => s.regexScripts)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const scopedChatId = preprocessOpts?.chatId ?? activeChatId
  const activePersonaId = useStore((s) => s.activePersonaId)
  const messageIndex = useStore((s) => {
    if (!preprocessOpts?.messageId) return -1
    return getMessageIndex(s.messages, preprocessOpts.messageId)
  })
  const messageIdForSnapshot = preprocessOpts?.messageId ?? null
  const trackContentForDisplaySettle = useDisplaySettleTracker(
    scopedChatId,
    messageIdForSnapshot,
    isStreaming,
  )
  const getSnapshotForThisMessage = useCallback(
    () => getDisplayRegexCacheSnapshot(messageIdForSnapshot),
    [messageIdForSnapshot],
  )
  const cvSnapshot = useSyncExternalStore(
    subscribeDisplayRegexCache,
    getSnapshotForThisMessage,
    getSnapshotForThisMessage,
  )

  const dynamicMacros = useMemo(() => {
    if (messageIndex < 0) return undefined
    return { chat_index: String(messageIndex) }
  }, [messageIndex])
  const macroCharacterId = activeGroupCharacterId ?? activeCharacterId

  const displayPreprocessOpts = useMemo(
    () => preprocessOpts
      ? {
          ...preprocessOpts,
          depth,
          ...(messageIndex >= 0 ? { messageIndex } : {}),
          ...(dynamicMacros ? { dynamicMacros } : {}),
        }
      : undefined,
    [preprocessOpts, depth, messageIndex, dynamicMacros],
  )
  const {
    value: content,
    ready: preprocessReady,
    settled: preprocessSettled,
  } = useDisplayPreprocessedState(
    rawContent,
    scopedChatId,
    displayPreprocessOpts,
    isStreaming,
  )
  const pendingSlowReportsRef = useRef<SlowRegexReport[]>([])
  const pendingRecoveredReportsRef = useRef<SlowRegexReport[]>([])

  const displayOwned = !!scopedChatId && isDisplayChatOwned(scopedChatId)
  // When an extension owns display, regex runs on preprocessed content only.
  const regexGated = displayOwned && !preprocessReady

  const displayScripts = useMemo(
    () =>
      regexScripts.filter(
        (s) =>
          s.target.includes('display') &&
          !s.disabled &&
          (s.scope === 'global' ||
            (s.scope === 'character' && s.scope_id === activeCharacterId) ||
            (s.scope === 'chat' && s.scope_id === scopedChatId)),
      ),
    [regexScripts, activeCharacterId, scopedChatId],
  )
  const needsPreviousContent = useMemo(
    () => displayScripts.some(
      (script) =>
        Array.isArray(script.metadata?.match_actions)
        && script.metadata.match_actions.includes('repeat_back'),
    ),
    [displayScripts],
  )
  const previousContent = useStore((s) => {
    if (!needsPreviousContent || !preprocessOpts?.messageId) return undefined
    return getPreviousSameRoleContent(s.messages, preprocessOpts.messageId)
  })

  // Collect display scripts that need backend macro resolution
  const scriptsNeedingResolution = useMemo(
    () =>
      displayScripts.filter(
        (s) =>
          s.substitute_macros !== 'none'
          && (
            hasMacroSyntax(s.find_regex)
            || (
              s.substitute_macros !== 'find'
              && hasMacroSyntax(s.replace_string)
            )
          ),
      ),
    [displayScripts],
  )

  // Pre-resolve find patterns and non-raw replacement strings via the backend macro engine.
  // Raw replacements stay per-match so capture groups remain available before macro evaluation.
  const templateCacheKey = useMemo(() => {
    const templates: Record<string, string> = {}
    for (const s of scriptsNeedingResolution) {
      if (hasMacroSyntax(s.find_regex)) {
        templates[`find:${s.id}`] = s.find_regex
      }
      if (
        s.substitute_macros !== 'none'
        && s.substitute_macros !== 'find'
        && s.substitute_macros !== 'raw'
        && s.substitute_macros !== 'after'
        && hasMacroSyntax(s.replace_string)
      ) {
        templates[`replace:${s.id}`] = s.replace_string
      }
    }

    const templateEntries = Object.entries(templates)
    if (templateEntries.length === 0) return null

    return JSON.stringify({
      scopedChatId,
      macroCharacterId,
      activePersonaId,
      scripts: scriptsNeedingResolution.map((s) => [
        s.id,
        s.updated_at,
        s.find_regex,
        s.replace_string,
        s.substitute_macros,
      ]),
    })
  }, [scriptsNeedingResolution, scopedChatId, macroCharacterId, activePersonaId])

  const cachedTemplates = templateCacheKey ? displayRegexResolutionCache.get(templateCacheKey)?.value : undefined
  const [resolvedTemplatesState, setResolvedTemplatesState] = useState<ResolvedTemplatesState | null>(() => (
    templateCacheKey && cachedTemplates ? { key: templateCacheKey, value: cachedTemplates } : null
  ))

  const resolvedTemplates = cachedTemplates
    ?? (resolvedTemplatesState?.key === templateCacheKey ? resolvedTemplatesState.value : undefined)
    ?? EMPTY_RESOLVED_TEMPLATES

  const [resolvedContentState, setResolvedContentState] = useState<ResolvedContentState | null>(null)

  useEffect(() => {
    if (!templateCacheKey) {
      setResolvedTemplatesState((current) => current === null ? current : null)
      return
    }

    const templates: Record<string, string> = {}
    for (const s of scriptsNeedingResolution) {
      if (hasMacroSyntax(s.find_regex)) {
        templates[`find:${s.id}`] = s.find_regex
      }
      if (
        s.substitute_macros !== 'none'
        && s.substitute_macros !== 'find'
        && s.substitute_macros !== 'raw'
        && s.substitute_macros !== 'after'
        && hasMacroSyntax(s.replace_string)
      ) {
        templates[`replace:${s.id}`] = s.replace_string
      }
    }

    const templateEntries = Object.entries(templates)
    if (templateEntries.length === 0) {
      setResolvedTemplatesState((current) => current === null ? current : null)
      return
    }

    let cancelled = false

    const applyResolvedTemplates = (next: ResolvedDisplayRegexTemplates) => {
      if (!cancelled) setResolvedTemplatesState({ key: templateCacheKey, value: next })
    }

    const cached = displayRegexResolutionCache.get(templateCacheKey)
    if (cached?.value) {
      applyResolvedTemplates(cached.value)
      return () => { cancelled = true }
    }

    if (!cached?.promise) {
      let assignedPromise: Promise<ResolvedDisplayRegexTemplates>
      const promise = resolveTemplatesWithResolver(templates, {
        chatId: scopedChatId ?? undefined,
        characterId: macroCharacterId ?? undefined,
        personaId: activePersonaId ?? undefined,
      })
        .then((res) => {
          const next = createEmptyResolvedTemplates()
          for (const [key, value] of Object.entries(res.resolved)) {
            if (key.startsWith('find:')) {
              next.resolvedFindPatterns.set(key.slice(5), value)
            } else if (key.startsWith('replace:')) {
              next.resolvedReplacements.set(key.slice(8), value)
            }
          }
          let agg: Set<string> | null = res.touched_vars ? new Set<string>() : null
          if (agg && res.touched_vars) {
            for (const arr of Object.values(res.touched_vars)) for (const v of arr) agg.add(v)
          }
          if (res.cacheable && Object.values(res.cacheable).some((c) => c === false)) agg = null
          if (displayRegexResolutionCache.get(templateCacheKey)?.promise === assignedPromise) {
            displayRegexResolutionCache.set(templateCacheKey, agg ? { value: next, touchedVars: agg } : { value: next })
          }
          return next
        })
        .catch(() => {
          if (displayRegexResolutionCache.get(templateCacheKey)?.promise === assignedPromise) {
            displayRegexResolutionCache.delete(templateCacheKey)
          }
          return createEmptyResolvedTemplates()
        })
      assignedPromise = trackInitialDisplayResolve(promise, scopedChatId)
      displayRegexResolutionCache.set(templateCacheKey, { promise: assignedPromise })
    }

    displayRegexResolutionCache.get(templateCacheKey)?.promise?.then(applyResolvedTemplates)

    return () => { cancelled = true }
  }, [scriptsNeedingResolution, templateCacheKey, scopedChatId, macroCharacterId, activePersonaId, cvSnapshot])

  // Async pipeline engagement: all user-authored scripts route through the
  // isolated effect-driven promise chain. Render-phase sync work applies none;
  // pending renders carry the previous resolved value forward (no blank flash)
  // and raw text shows only on a first render with no cache.
  const hasAsyncMacroScripts = useMemo(
    () => displayOwned || displayScripts.length > 0,
    [displayOwned, displayScripts],
  )

  const fallbackContent = content

  useEffect(() => {
    const reports = pendingSlowReportsRef.current
    if (reports.length === 0) return
    pendingSlowReportsRef.current = []
    for (const report of reports) {
      reportSlowDisplayRegex(report.script, report.elapsedMs, report.timedOut, report.thresholdMs)
    }
  }, [fallbackContent, resolvedContentState])

  useEffect(() => {
    const reports = pendingRecoveredReportsRef.current
    if (reports.length === 0) return
    pendingRecoveredReportsRef.current = []
    for (const report of reports) {
      reportRecoveredDisplayRegex(report.script, report.elapsedMs, report.thresholdMs)
    }
  }, [fallbackContent, resolvedContentState])

  const resolvedTemplateKey = useMemo(
    () => JSON.stringify({
      find: Array.from(resolvedTemplates.resolvedFindPatterns.entries()),
      replace: Array.from(resolvedTemplates.resolvedReplacements.entries()),
    }),
    [resolvedTemplates],
  )

  const contentCacheKey = useMemo(() => {
    if (displayScripts.length === 0 || !hasAsyncMacroScripts || regexGated) return null

    return JSON.stringify({
      scopedChatId,
      macroCharacterId,
      activePersonaId,
      isUser,
      depth,
      userName: macroCtx?.userName ?? null,
      charName: macroCtx?.charName ?? null,
      content,
      resolvedTemplateKey,
      dynamicMacros: dynamicMacros ?? null,
      previousContent: previousContent ?? null,
      scripts: displayScripts.map((s) => [
        s.id,
        s.updated_at,
        s.find_regex,
        s.replace_string,
        s.flags,
        s.placement,
        s.min_depth,
        s.max_depth,
        s.trim_strings,
        s.substitute_macros,
        s.metadata?.match_actions,
        s.metadata?.repeat_position,
        s.metadata?.repeat_raw_match,
      ]),
    })
  }, [
    displayScripts,
    hasAsyncMacroScripts,
    scopedChatId,
    macroCharacterId,
    activePersonaId,
    isUser,
    depth,
    macroCtx,
    content,
    resolvedTemplateKey,
    dynamicMacros,
    previousContent,
    regexGated,
  ])

  const cachedResolvedContent = contentCacheKey ? displayRegexContentCache.get(contentCacheKey)?.value : undefined

  useEffect(() => {
    if (!contentCacheKey) {
      setResolvedContentState((current) => current === null ? current : null)
      return
    }

    let cancelled = false
    const applyResolvedContent = (next: string) => {
      if (!cancelled) setResolvedContentState({ key: contentCacheKey, value: next })
    }

    const run = () => {
      const cached = displayRegexContentCache.get(contentCacheKey)
      if (cached?.value !== undefined) {
        applyResolvedContent(cached.value)
        return
      }

      if (!cached?.promise) {
        // Captured once so the .then/.catch handlers can verify the cache
        // entry hasn't been replaced or invalidated by a CHAT_CHANGED in flight.
        // Without this guard, an invalidation between the initial set and the
        // resolve would let the stale fetch result clobber the live key.
        let assignedPromise: Promise<string>
        const slowReports: SlowRegexReport[] = []
        const recoveredReports: SlowRegexReport[] = []
        pendingSlowReportsRef.current = slowReports
        pendingRecoveredReportsRef.current = recoveredReports
        const promise = applyDisplayRegexTiered(
          content,
          displayScripts,
          {
            isUser,
            depth,
            chatId: scopedChatId ?? undefined,
            characterId: macroCharacterId ?? undefined,
            personaId: activePersonaId ?? undefined,
            macroCtx,
            resolvedFindPatterns: resolvedTemplates.resolvedFindPatterns,
            resolvedReplacements: resolvedTemplates.resolvedReplacements,
            dynamicMacros,
            ...(preprocessOpts?.messageId ? { messageId: preprocessOpts.messageId } : {}),
            ...(messageIndex >= 0 ? { messageIndex } : {}),
            ...(previousContent !== undefined ? { previousContent } : {}),
            ...(preprocessOpts?.role ? { role: preprocessOpts.role } : {}),
          },
          (templates) => resolveMacrosBatchChunked(templates, {
            chat_id: scopedChatId ?? undefined,
            character_id: macroCharacterId ?? undefined,
            persona_id: activePersonaId ?? undefined,
          }),
          {
            onSlowRegex: ({ script, elapsedMs, timedOut, thresholdMs }) => {
              slowReports.push({ script, elapsedMs, timedOut, thresholdMs })
            },
            onRecoveredRegex: ({ script, elapsedMs, timedOut, thresholdMs }) => {
              recoveredReports.push({ script, elapsedMs, timedOut, thresholdMs })
            },
          },
        )
          .then(({ result: next, touchedVars, cacheable }) => {
            if (displayRegexContentCache.get(contentCacheKey)?.promise === assignedPromise) {
              if (cacheable !== false) {
                displayRegexContentCache.set(contentCacheKey, {
                  value: next,
                  ...(touchedVars ? { touchedVars } : {}),
                  ...(preprocessOpts?.messageId ? { messageId: preprocessOpts.messageId } : {}),
                })
                evictDisplayRegexContentCacheOverflow()
              } else {
                displayRegexContentCache.delete(contentCacheKey)
              }
            }
            return next
          })
          .catch(() => {
            if (displayRegexContentCache.get(contentCacheKey)?.promise === assignedPromise) {
              displayRegexContentCache.delete(contentCacheKey)
            }
            return fallbackContent
          })
        assignedPromise = trackContentForDisplaySettle(promise)
        displayRegexContentCache.set(contentCacheKey, {
          promise: assignedPromise,
          ...(preprocessOpts?.messageId ? { messageId: preprocessOpts.messageId } : {}),
        })
      }

      displayRegexContentCache.get(contentCacheKey)?.promise?.then(applyResolvedContent)
    }
    // Coalesce per-token churn of the same message into one apply pass per window.
    const cancelCoalesce = scheduleCoalescedDisplayResolve(
      preprocessOpts?.messageId && scopedChatId ? `${scopedChatId}|${preprocessOpts.messageId}|apply` : null,
      run,
    )
    return () => { cancelled = true; cancelCoalesce() }
  }, [
    content,
    isUser,
    depth,
    macroCtx,
    fallbackContent,
    displayScripts,
    hasAsyncMacroScripts,
    resolvedTemplateKey,
    resolvedTemplates,
    scopedChatId,
    macroCharacterId,
    activePersonaId,
    contentCacheKey,
    dynamicMacros,
    messageIndex,
    previousContent,
    cvSnapshot,
    preprocessOpts?.messageId,
    preprocessOpts?.role,
    trackContentForDisplaySettle,
  ])

  // Carry the previous resolved value forward across cv-bumps and per-chunk
  // content churn so the sync fallback's raw {{...}} doesn't flash through
  // during the async re-resolve window.
  const messageId = preprocessOpts?.messageId ?? null
  const lastResolvedRef = useRef<{
    chatId: string | null
    messageId: string | null
    contentKey: string | null
    content: string
    value: string
  } | null>(null)
  const carryIdentityRef = useRef({ chatId: scopedChatId, messageId })
  const wasStreamingRef = useRef(isStreaming)
  const finalStreamKeyPendingRef = useRef(false)
  const identityChanged = carryIdentityRef.current.chatId !== scopedChatId
    || carryIdentityRef.current.messageId !== messageId
  if (identityChanged) {
    carryIdentityRef.current = { chatId: scopedChatId, messageId }
    lastResolvedRef.current = null
    finalStreamKeyPendingRef.current = false
  }
  if (!wasStreamingRef.current && isStreaming) {
    lastResolvedRef.current = null
    finalStreamKeyPendingRef.current = false
  } else if (wasStreamingRef.current && !isStreaming) {
    finalStreamKeyPendingRef.current = true
  }
  wasStreamingRef.current = isStreaming

  const liveResolved = cachedResolvedContent
    ?? (resolvedContentState?.key === contentCacheKey ? resolvedContentState.value : undefined)
  if (liveResolved !== undefined) {
    lastResolvedRef.current = {
      chatId: scopedChatId,
      messageId,
      contentKey: contentCacheKey,
      content,
      value: liveResolved,
    }
    // Finalization produces TWO sequential keys (preprocess, then regex). The
    // one-shot latch must survive the first of them, otherwise the newest
    // preprocess key lands with no carry available and commits raw source.
    if (!isStreaming && preprocessSettled) finalStreamKeyPendingRef.current = false
  }
  const stale = lastResolvedRef.current
  const staleMatchesIdentity = !!stale
    && stale.chatId === scopedChatId
    && stale.messageId === messageId
  const legacyStaleResolved = staleMatchesIdentity
    && (stale.content === content || RAW_MACRO_RE.test(fallbackContent))
    ? stale.value
    : undefined
  const newerStreamingKeyPending = staleMatchesIdentity
    && scopedChatId !== null
    && messageId !== null
    && (isStreaming || finalStreamKeyPendingRef.current)
    && liveResolved === undefined
    && contentCacheKey !== null
    && stale.contentKey !== contentCacheKey
  const staleResolved = legacyStaleResolved
    ?? (newerStreamingKeyPending ? stale.value : undefined)

  // No stale to carry forward (first render of a streaming bubble), so raw input renders cleaner than panel HTML with unresolved macros.
  if (liveResolved === undefined && staleResolved === undefined && RAW_MACRO_RE.test(fallbackContent)) {
    return content
  }

  return liveResolved ?? staleResolved ?? fallbackContent
}
