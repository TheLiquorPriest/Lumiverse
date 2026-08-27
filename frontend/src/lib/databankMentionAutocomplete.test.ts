import { afterEach, describe, expect, test, vi } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  DatabankAutocompleteCoordinator,
  getDatabankMentionAtCaret,
} from './databankMentionAutocomplete'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  return Promise.withResolvers<T>()
}

async function settlePromise(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function createTextarea() {
  const dom = new JSDOM('<!doctype html><html><body><textarea></textarea></body></html>')
  const textarea = dom.window.document.querySelector('textarea')!
  const dispatchInput = (value: string, caret = value.length) => {
    textarea.value = value
    textarea.setSelectionRange(caret, caret)
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  }
  return { dom, textarea, dispatchInput }
}

afterEach(() => vi.useRealTimers())

describe('databank mention autocomplete', () => {
  test('detects the # query at the JSDOM textarea input caret', () => {
    const { dom, textarea, dispatchInput } = createTextarea()
    let detected: { query: string; startIndex: number } | null = null
    textarea.addEventListener('input', (event) => {
      detected = getDatabankMentionAtCaret(event.currentTarget as unknown as HTMLTextAreaElement)
    })

    const value = 'Look up #ar007 before answering'
    const caret = value.indexOf(' before')
    dispatchInput(value, caret)
    expect(detected).toEqual({ query: 'ar007', startIndex: value.indexOf('#') })

    dispatchInput('embedded#ar007')
    expect(detected).toBeNull()
    dispatchInput('empty #')
    expect(detected).toBeNull()

    dom.window.close()
  })

  test('debounces before dispatch and clears when the textarea has no query', async () => {
    const { dom, textarea, dispatchInput } = createTextarea()
    vi.useFakeTimers()
    const coordinator = new DatabankAutocompleteCoordinator({ delayMs: 200 })
    const requested: string[] = []
    let visible = ['previous']
    let clearCount = 0

    textarea.addEventListener('input', (event) => {
      const mention = getDatabankMentionAtCaret(event.currentTarget as unknown as HTMLTextAreaElement)
      coordinator.schedule({
        query: mention?.query ?? null,
        contextKey: 'chat:persisted',
        request: async (query) => {
          requested.push(query)
          return [query]
        },
        onSuccess: (results) => { visible = results },
        onError: () => { visible = [] },
        onClear: () => {
          clearCount += 1
          visible = []
        },
      })
    })

    dispatchInput('#a')
    dispatchInput('#ar007')
    vi.advanceTimersByTime(199)
    expect(requested).toEqual([])
    vi.advanceTimersByTime(1)
    await settlePromise()
    expect(requested).toEqual(['ar007'])
    expect(visible).toEqual(['ar007'])

    dispatchInput('plain text')
    expect(visible).toEqual([])
    expect(clearCount).toBe(1)

    coordinator.dispose()
    dom.window.close()
  })

  test('stale empty success and error cannot erase the latest textarea result', async () => {
    const { dom, textarea, dispatchInput } = createTextarea()
    vi.useFakeTimers()
    const coordinator = new DatabankAutocompleteCoordinator({ delayMs: 200 })
    const pending = new Map<string, Deferred<string[]>>()
    const signals = new Map<string, AbortSignal>()
    const requestCounts = new Map<string, number>()
    let visible: string[] = []
    let publishedErrors = 0

    textarea.addEventListener('input', (event) => {
      const mention = getDatabankMentionAtCaret(event.currentTarget as unknown as HTMLTextAreaElement)
      coordinator.schedule({
        query: mention?.query ?? null,
        contextKey: 'chat:persisted',
        request: (query, signal) => {
          requestCounts.set(query, (requestCounts.get(query) ?? 0) + 1)
          signals.set(query, signal)
          return pending.get(query)!.promise
        },
        onSuccess: (results) => { visible = results },
        onError: () => {
          publishedErrors += 1
          visible = []
        },
        onClear: () => { visible = [] },
      })
    })

    const staleEmpty = deferred<string[]>()
    const current = deferred<string[]>()
    pending.set('a', staleEmpty)
    pending.set('ar007', current)
    dispatchInput('#a')
    vi.advanceTimersByTime(200)
    await settlePromise()
    dispatchInput('#ar007')
    expect(signals.get('a')?.aborted).toBe(true)
    vi.advanceTimersByTime(200)
    await settlePromise()

    current.resolve(['AR-007 source'])
    await settlePromise()
    expect(visible).toEqual(['AR-007 source'])
    staleEmpty.resolve([])
    await settlePromise()
    expect(visible).toEqual(['AR-007 source'])

    const staleError = deferred<string[]>()
    const latest = deferred<string[]>()
    pending.set('broken', staleError)
    pending.set('ar007-final', latest)
    dispatchInput('#broken')
    vi.advanceTimersByTime(200)
    await settlePromise()
    dispatchInput('#ar007-final')
    expect(signals.get('broken')?.aborted).toBe(true)
    vi.advanceTimersByTime(200)
    await settlePromise()

    latest.resolve(['Final AR-007 source'])
    await settlePromise()
    expect(visible).toEqual(['Final AR-007 source'])
    staleError.reject(new Error('stale failure'))
    await settlePromise()
    expect(visible).toEqual(['Final AR-007 source'])
    expect(publishedErrors).toBe(0)
    expect(Object.fromEntries(requestCounts)).toEqual({
      a: 1,
      ar007: 1,
      broken: 1,
      'ar007-final': 1,
    })

    coordinator.dispose()
    dom.window.close()
  })

  test('dispose aborts and fences the active request', async () => {
    vi.useFakeTimers()
    const coordinator = new DatabankAutocompleteCoordinator({ delayMs: 200 })
    const pending = deferred<string[]>()
    let signal: AbortSignal | null = null
    let published = false

    coordinator.schedule({
      query: 'ar007',
      contextKey: 'chat:old',
      request: (_query, requestSignal) => {
        signal = requestSignal
        return pending.promise
      },
      onSuccess: () => { published = true },
      onError: () => { published = true },
      onClear: () => { published = true },
    })
    vi.advanceTimersByTime(200)
    await settlePromise()
    coordinator.dispose()
    expect(signal?.aborted).toBe(true)

    pending.resolve(['late'])
    await settlePromise()
    expect(published).toBe(false)
  })
})
