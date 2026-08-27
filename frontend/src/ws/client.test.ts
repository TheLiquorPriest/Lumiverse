/// <reference types="bun-types" />

import { afterAll, describe, expect, jest, test } from 'bun:test'

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
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  sent: string[] = []
  closeCalls = 0

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

const { WebSocketClient, shouldUseHeartbeatWorker } = await import('./client')

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

  test('keeps the heartbeat worker available on Android', () => {
    expect(shouldUseHeartbeatWorker({
      userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 Chrome/140 Mobile',
      platform: 'Linux armv8l',
      maxTouchPoints: 5,
    })).toBe(true)
  })

  test('sends the fast watchdog ping on an unsuppressed hidden-to-visible transition', () => {
    const client = makeClient()
    const pingTimeouts: number[] = []

    client.sendPingNow = (timeoutMs: number) => {
      pingTimeouts.push(timeoutMs)
    }
    client.wasVisible = false

    client.sendVisibility()

    expect(pingTimeouts).toEqual([15_000])
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
    expect(pingTimeouts).toEqual([15_000])
  })

  test('uses the worker to schedule and watch the primary socket heartbeat', () => {
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    client.startPing()

    const worker = MockWorker.instances.at(-1)!
    const start = worker.sent.find((message) => message.type === 'start')
    expect(start).toMatchObject({ intervalMs: 30_000, timeoutMs: 15_000 })

    worker.emit({ type: 'ping', generation: start.generation, timeoutMs: 15_000 })
    expect(socket.sent).toEqual([JSON.stringify({ type: 'ping' })])
    expect(worker.sent.at(-1)).toEqual({
      type: 'arm',
      generation: start.generation,
      timeoutMs: 15_000,
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

  test('invalidates a heartbeat deadline while the PWA is backgrounded', () => {
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    client.startPing()
    const worker = MockWorker.instances.at(-1)!
    const start = worker.sent.find((message) => message.type === 'start')

    client.pauseForBackground()
    worker.emit({ type: 'timeout', generation: start.generation })

    expect(socket.closeCalls).toBe(0)
    expect(client.ws).toBe(socket)
    client.disconnect()
  })

  test('requires an ID-correlated pong to complete foreground recovery', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws') as any
    client.connect()
    const socket = MockWebSocket.instances.at(-1)!
    ;(socket as any).onopen?.({} as Event)
    const events: string[] = []
    client.on('__ws_resume_recovery_start', () => events.push('start'))
    client.on('__ws_resume_recovery_complete', () => events.push('complete'))

    client.pauseForBackground()
    client.resumeFromBackground()
    const worker = MockWorker.instances.at(-1)!
    const resumePing = worker.sent.find((message) => message.type === 'ping-now' && message.resumeProof)
    expect(resumePing).toMatchObject({ timeoutMs: 15_000, resumeProof: true })

    worker.emit({ type: 'ping', generation: resumePing.generation, timeoutMs: 15_000, resumeProof: true })
    const frame = JSON.parse(socket.sent.at(-1)!)
    expect(frame).toMatchObject({ type: 'ping' })
    expect(typeof frame.id).toBe('string')

    ;(socket as any).onmessage({ data: JSON.stringify({ type: 'pong', id: frame.id }) })
    expect(events).toEqual(['start', 'complete'])
    client.disconnect()
  })

  test('abandons a socket that remains CONNECTING beyond the handshake deadline', () => {
    jest.useFakeTimers()
    const client = new WebSocketClient('ws://localhost:3000/api/ws') as any
    const closes: any[] = []
    client.on('__ws_close', (payload: any) => closes.push(payload))

    try {
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!
      socket.readyState = MockWebSocket.CONNECTING

      jest.advanceTimersByTime(14_999)
      expect(socket.closeCalls).toBe(0)

      jest.advanceTimersByTime(1)
      expect(socket.closeCalls).toBe(1)
      expect(client.ws).toBeNull()
      expect(closes).toEqual([{ code: 1006, reason: 'connection timeout' }])
    } finally {
      client.disconnect()
      jest.useRealTimers()
    }
  })

  test('releases the transport on freeze and starts a fresh foreground recovery', () => {
    jest.useFakeTimers()
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    const events: string[] = []
    client.on('__ws_resume_recovery_start', () => events.push('start'))

    try {
      client.pauseForBackground()
      client.suspendTransport('page frozen')

      expect(socket.closeCalls).toBe(1)
      expect(client.ws).toBeNull()

      client.resumeFromBackground()
      expect(events).toEqual(['start'])
      jest.advanceTimersByTime(249)
      expect(client.ws).toBeNull()
      jest.advanceTimersByTime(1)
      expect(client.ws).toBe(MockWebSocket.instances.at(-1))
    } finally {
      client.disconnect()
      jest.useRealTimers()
    }
  })

  test('starts recovery when foregrounding finds no socket even if a hidden event was missed', () => {
    jest.useFakeTimers()
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    const events: string[] = []
    client.on('__ws_resume_recovery_start', () => events.push('start'))

    try {
      client.abandonSocket(socket)
      client.recoverConnectionOnForeground('focus')
      expect(events).toEqual(['start'])
      jest.advanceTimersByTime(250)
      expect(client.ws).toBe(MockWebSocket.instances.at(-1))
    } finally {
      client.disconnect()
      jest.useRealTimers()
    }
  })

  test('uses a timer gap to probe an OPEN socket when lifecycle events were missed', () => {
    jest.useFakeTimers()
    const client = makeClient()
    const events: string[] = []
    client.on('__ws_resume_recovery_start', () => events.push('start'))

    try {
      client.lastLifecycleTick = Date.now() - 20_000
      client.checkForWakeGap()

      expect(events).toEqual(['start'])
      const worker = MockWorker.instances.at(-1)!
      expect(worker.sent.some((message) => (
        message.type === 'ping-now'
        && message.timeoutMs === 15_000
        && message.resumeProof === true
      ))).toBe(true)
    } finally {
      client.disconnect()
      jest.useRealTimers()
    }
  })
})

describe('WebSocketClient Spindle console logging', () => {
  test('can suppress routine Spindle events without suppressing other WebSocket diagnostics', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    const originalDebug = console.debug
    const logged: unknown[][] = []
    console.debug = (...args: unknown[]) => { logged.push(args) }

    try {
      client.setSpindleInfoLogging(false)
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!

      ;(socket as any).onmessage({ data: JSON.stringify({ event: 'SPINDLE_RUNTIME_STATS', payload: {} }) })
      ;(socket as any).onmessage({ data: JSON.stringify({ event: 'MESSAGE_SENT', payload: {} }) })

      expect(logged).toEqual([['[WS] ←', 'MESSAGE_SENT', {}]])
    } finally {
      console.debug = originalDebug
      client.disconnect()
    }
  })
})
