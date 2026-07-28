/// <reference types="bun-types" />

import { afterAll, describe, expect, test } from 'bun:test'

const originalWindow = (globalThis as any).window
const originalDocument = (globalThis as any).document
const originalWebSocket = (globalThis as any).WebSocket
const originalWorker = (globalThis as any).Worker

type Listener = EventListenerOrEventListenerObject

function makeEventTarget() {
  return {
    addEventListener(_type: string, _listener: Listener) {},
    removeEventListener(_type: string, _listener: Listener) {},
  }
}

const documentMock = {
  visibilityState: 'visible' as DocumentVisibilityState,
  hasFocus: () => true,
  ...makeEventTarget(),
}

const windowMock = {
  location: {
    protocol: 'http:',
    host: 'localhost:3000',
  },
  ...makeEventTarget(),
}

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  sent: string[] = []
  closeCalls = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(_url: string) {
    MockWebSocket.instances.push(this)
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {
    this.closeCalls += 1
  }
}

class MockWorker {
  static instances: MockWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  sent: any[] = []

  constructor(_url: URL, _options?: WorkerOptions) {
    MockWorker.instances.push(this)
  }

  postMessage(payload: any) {
    this.sent.push(payload)
  }

  emit(payload: any) {
    this.onmessage?.({ data: payload } as MessageEvent)
  }

  terminate() {}
}

;(globalThis as any).window = windowMock
;(globalThis as any).document = documentMock
;(globalThis as any).WebSocket = MockWebSocket
;(globalThis as any).Worker = MockWorker

const { WebSocketClient, shouldUseHeartbeatWorker, WS_CLOSE } = await import('./client')

afterAll(() => {
  if (originalWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = originalWindow

  if (originalDocument === undefined) delete (globalThis as any).document
  else (globalThis as any).document = originalDocument

  if (originalWebSocket === undefined) delete (globalThis as any).WebSocket
  else (globalThis as any).WebSocket = originalWebSocket

  if (originalWorker === undefined) delete (globalThis as any).Worker
  else (globalThis as any).Worker = originalWorker
})

function makeClient() {
  const client = new WebSocketClient('ws://localhost:3000/api/ws') as any
  client.ws = new MockWebSocket('ws://localhost:3000/api/ws')
  return client
}

describe('WebSocketClient resume watchdog guard', () => {
  test('does not use a heartbeat worker on iOS or iPadOS', () => {
    expect(shouldUseHeartbeatWorker({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
    })).toBe(false)
    expect(shouldUseHeartbeatWorker({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })).toBe(false)
  })

  test('sends the fast watchdog ping on an unsuppressed hidden-to-visible transition', () => {
    const client = makeClient()
    const pingTimeouts: number[] = []

    client.sendPingNow = (timeoutMs: number) => {
      pingTimeouts.push(timeoutMs)
    }
    client.wasVisible = false

    client.sendVisibility()

    expect(pingTimeouts).toEqual([3_000])
  })

  test('suppresses the next fast watchdog ping once when a system modal is expected', () => {
    const client = makeClient()
    const pingTimeouts: number[] = []

    client.sendPingNow = (timeoutMs: number) => {
      pingTimeouts.push(timeoutMs)
    }
    client.wasVisible = false
    client.suppressNextResumePingFor(120_000)

    client.sendVisibility()
    expect(pingTimeouts).toEqual([])

    client.wasVisible = false
    client.sendVisibility()
    expect(pingTimeouts).toEqual([3_000])
  })

  test('uses the worker to schedule and watch the primary socket heartbeat', () => {
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    client.startPing()

    const worker = MockWorker.instances.at(-1)!
    const start = worker.sent.find((message) => message.type === 'start')
    expect(start).toMatchObject({ intervalMs: 30_000, timeoutMs: 10_000 })

    worker.emit({ type: 'ping', generation: start.generation, timeoutMs: 10_000 })
    expect(socket.sent).toEqual([JSON.stringify({ type: 'ping' })])
    expect(worker.sent.at(-1)).toEqual({
      type: 'arm',
      generation: start.generation,
      timeoutMs: 10_000,
    })

    worker.emit({ type: 'timeout', generation: start.generation })
    expect(socket.closeCalls).toBe(1)
    expect(client.ws).toBeNull()
    client.disconnect()
  })

  test('acknowledges primary pongs and ignores stale worker timeouts', () => {
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    client.startPing()
    const worker = MockWorker.instances.at(-1)!
    const firstStart = worker.sent.find((message) => message.type === 'start')
    client.ackHeartbeat()
    expect(worker.sent.at(-1)).toEqual({ type: 'ack', generation: firstStart.generation })

    client.startPing()
    worker.emit({ type: 'timeout', generation: firstStart.generation })
    expect(socket.closeCalls).toBe(0)
    expect(client.ws).toBe(socket)
    client.disconnect()
  })
  test('ignores stale socket messages, opens, errors, and closes after replacement', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws') as any
    client.startPing = () => undefined
    client.stopPing = () => undefined
    client.startVisibilityTracking = () => undefined
    client.stopVisibilityTracking = () => undefined
    const received: string[] = []
    client.on('SPINDLE_TEXT_EDITOR_RESULT', (payload: { requestId: string }) => {
      received.push(payload.requestId)
    })

    client.connect()
    const first = MockWebSocket.instances.at(-1)!
    first.onopen?.()
    client.ws = null
    client.connect()
    const second = MockWebSocket.instances.at(-1)!
    second.onopen?.()

    first.onmessage?.({
      data: JSON.stringify({
        event: 'SPINDLE_TEXT_EDITOR_RESULT',
        payload: { requestId: 'stale' },
      }),
    } as MessageEvent)
    first.onclose?.({ code: 1006, reason: 'stale' } as CloseEvent)
    first.onerror?.(new Event('error'))
    expect(received).toEqual([])

    second.onmessage?.({
      data: JSON.stringify({
        event: 'SPINDLE_TEXT_EDITOR_RESULT',
        payload: { requestId: 'current' },
      }),
    } as MessageEvent)
    expect(received).toEqual(['current'])
    client.disconnect()
  })

  test('returns send acceptance and emits terminal close on explicit disconnect', () => {
    const client = makeClient()
    const closePayloads: Array<{ code: number; reason: string }> = []
    client.on(WS_CLOSE, (payload: { code: number; reason: string }) => {
      closePayloads.push(payload)
    })

    expect(client.send({ type: 'editor-result' })).toBe(true)
    client.disconnect()
    expect(closePayloads).toEqual([{ code: 1000, reason: 'client disconnect' }])
    expect(client.send({ type: 'editor-result' })).toBe(false)
  })
})
