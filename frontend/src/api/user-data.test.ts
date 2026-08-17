import { afterEach, describe, expect, test } from 'bun:test'
import { userDataApi } from './user-data'
import { USER_DATA_LIMITS, UserDataProtocolError } from '@/types/user-data'

type FakeUpload = { addEventListener: (event: string, handler: (progress: unknown) => void) => void }

class FakeXmlHttpRequest {
  static sendCount = 0
  static constructCount = 0
  readonly upload: FakeUpload = { addEventListener: () => {} }
  status = 201
  statusText = 'Created'
  responseText = JSON.stringify({ jobId: 'job-size-boundary', status: 'queued' })
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXmlHttpRequest.constructCount += 1
  }

  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    FakeXmlHttpRequest.sendCount += 1
    queueMicrotask(() => this.onload?.())
  }
}

const originalXmlHttpRequest = globalThis.XMLHttpRequest

afterEach(() => {
  FakeXmlHttpRequest.sendCount = 0
  FakeXmlHttpRequest.constructCount = 0
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: originalXmlHttpRequest,
  })
})

describe('user-data upload bounds', () => {
  test('accepts the exact archive size cap and sends once', async () => {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      writable: true,
      value: FakeXmlHttpRequest,
    })

    const file = { size: USER_DATA_LIMITS.maxArchiveUploadBytes } as File
    await expect(userDataApi.startImport(file)).resolves.toEqual({ jobId: 'job-size-boundary', status: 'queued' })
    expect(FakeXmlHttpRequest.sendCount).toBe(1)
    expect(FakeXmlHttpRequest.constructCount).toBe(1)
  })

  test('rejects cap plus one before constructing a request', async () => {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      writable: true,
      value: FakeXmlHttpRequest,
    })

    const file = { size: USER_DATA_LIMITS.maxArchiveUploadBytes + 1 } as File
    // bun's rejects modifier supports toThrow/toMatchObject/toBe/toBeInstanceOf,
    // not toSatisfy; assert the rejection shape with the supported pair instead.
    await expect(userDataApi.startImport(file)).rejects.toBeInstanceOf(UserDataProtocolError)
    await expect(userDataApi.startImport(file)).rejects.toMatchObject({ code: 'size' })
    expect(FakeXmlHttpRequest.constructCount).toBe(0)
    expect(FakeXmlHttpRequest.sendCount).toBe(0)
  })
})
