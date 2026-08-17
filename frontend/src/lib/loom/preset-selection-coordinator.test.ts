import { describe, expect, test } from 'bun:test'
import { createPresetSelectionCoordinator } from './preset-selection-coordinator-core'
import {
  beginActiveLoomPresetSelection,
  configurePresetSelectionCoordinator,
  registerActiveLoomPresetSelectionBlocker,
} from './preset-selection-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

describe('preset selection coordinator', () => {
  test('flushes the departing preset before exposing the next one', async () => {
    let activePresetId: string | null = 'preset-a'
    const flushed: string[] = []
    const pendingFlush = deferred<void>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async (presetId) => {
        flushed.push(presetId)
        await pendingFlush.promise
      },
    })

    const transition = coordinator.transition('preset-b')
    await Promise.resolve()
    await Promise.resolve()
    expect(activePresetId).toBe('preset-a')
    expect(flushed).toEqual(['preset-a'])

    pendingFlush.resolve()
    await transition
    expect(activePresetId).toBe('preset-b')
  })

  test('does not expose an aborted lifecycle selection after its flush completes', async () => {
    let activePresetId: string | null = 'preset-a'
    const pendingFlush = deferred<void>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => { await pendingFlush.promise },
    })
    const abort = new AbortController()
    const transition = coordinator.transition('preset-b', { signal: abort.signal })
    await Promise.resolve()
    await Promise.resolve()

    abort.abort()
    pendingFlush.resolve()
    await transition

    expect(activePresetId).toBe('preset-a')
  })

  test('ignores a request whose lifecycle was cancelled before it reached selection', async () => {
    let activePresetId: string | null = 'preset-a'
    let flushes = 0
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => { flushes += 1 },
    })
    const abort = new AbortController()
    abort.abort()

    await coordinator.transition('preset-b', { signal: abort.signal })
    expect(activePresetId).toBe('preset-a')
    expect(flushes).toBe(0)
  })

  test('rejects an older asynchronous intent after a later manual selection commits', async () => {
    let activePresetId: string | null = 'preset-a'
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {},
    })

    const createIntent = coordinator.begin()
    expect(await coordinator.transition('preset-b')).toBe(true)
    expect(await createIntent.transition('preset-c')).toBe(false)
    expect(activePresetId).toBe('preset-b')
  })

  test('keeps a manual selection authoritative when a delayed settings read resolves later', async () => {
    let activePresetId: string | null = 'preset-a'
    const pendingManualFlush = deferred<void>()
    const manualFlushStarted = deferred<void>()
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {
        manualFlushStarted.resolve()
        await pendingManualFlush.promise
      },
    })
    const pendingSettingsRead = deferred<string>()
    const settingsSelection = coordinator.begin()
    const delayedSettingsSelection = pendingSettingsRead.promise.then((presetId) => settingsSelection.transition(presetId))
    const manualSelection = coordinator.transition('preset-c')

    await manualFlushStarted.promise
    pendingSettingsRead.resolve('preset-a')
    expect(await delayedSettingsSelection).toBe(false)
    pendingManualFlush.resolve()
    await manualSelection

    expect(activePresetId).toBe('preset-c')
  })


  test('does not expose a stale intermediate target after a later switch request', async () => {
    let activePresetId: string | null = 'preset-a'
    const exposed: (string | null)[] = []
    const firstFlush = deferred<void>()
    let flushes = 0
    const coordinator = createPresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => {
        exposed.push(presetId)
        activePresetId = presetId
      },
      flushPreset: async () => {
        flushes += 1
        if (flushes === 1) await firstFlush.promise
      },
    })

    const staleTransition = coordinator.transition('preset-b')
    await Promise.resolve()
    await Promise.resolve()
    const currentTransition = coordinator.transition('preset-c')
    firstFlush.resolve()
    await Promise.all([staleTransition, currentTransition])

    expect(exposed).toEqual(['preset-c'])
    expect(activePresetId).toBe('preset-c')
  })

  test('replays the latest bound selection after a dirty editor is saved', async () => {
    let activePresetId: string | null = 'preset-a'
    const replayed = deferred<void>()
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => {
        activePresetId = presetId
        replayed.resolve()
      },
      flushPreset: async () => {},
    })
    const blockedTargets: Array<string | null> = []
    const unblock = registerActiveLoomPresetSelectionBlocker((presetId) => {
      blockedTargets.push(presetId)
      return presetId !== activePresetId
    })

    const firstResolution = Promise.resolve('preset-b').then((presetId) => (
      beginActiveLoomPresetSelection().transition(presetId)
    ))
    expect(await firstResolution).toBe(false)
    expect(await beginActiveLoomPresetSelection().transition('preset-c')).toBe(false)
    expect(activePresetId).toBe('preset-a')

    unblock()
    await replayed.promise

    expect(activePresetId).toBe('preset-c')
    expect(blockedTargets).toEqual(['preset-b', 'preset-c'])
  })

  test('drops a blocked replay when its bound-selection lifecycle is cancelled', async () => {
    let activePresetId: string | null = 'preset-a'
    let selectionChanges = 0
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => {
        activePresetId = presetId
        selectionChanges += 1
      },
      flushPreset: async () => {},
    })
    const unblock = registerActiveLoomPresetSelectionBlocker(() => true)
    const selection = beginActiveLoomPresetSelection()

    expect(await selection.transition('stale-preset')).toBe(false)
    selection.cancel()
    unblock()
    await Promise.resolve()

    expect(activePresetId).toBe('preset-a')
    expect(selectionChanges).toBe(0)
  })

  test('cancels a replay in flight when its originating context ends', async () => {
    let activePresetId: string | null = 'preset-a'
    const flushStarted = deferred<void>()
    const releaseFlush = deferred<void>()
    const flushReturned = deferred<void>()
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {
        flushStarted.resolve()
        await releaseFlush.promise
        flushReturned.resolve()
      },
    })
    const unblock = registerActiveLoomPresetSelectionBlocker(() => true)
    const selection = beginActiveLoomPresetSelection()

    expect(await selection.transition('stale-preset')).toBe(false)
    unblock()
    await flushStarted.promise
    selection.cancel()
    releaseFlush.resolve()
    await flushReturned.promise
    await Promise.resolve()

    expect(activePresetId).toBe('preset-a')
  })

  test('does not retain a replay for an already-aborted selection', async () => {
    let activePresetId: string | null = 'preset-a'
    configurePresetSelectionCoordinator({
      getActivePresetId: () => activePresetId,
      setActivePresetId: (presetId) => { activePresetId = presetId },
      flushPreset: async () => {},
    })
    const abort = new AbortController()
    abort.abort()
    const unblock = registerActiveLoomPresetSelectionBlocker(() => true)

    expect(await beginActiveLoomPresetSelection({
      signal: abort.signal,
    }).transition('stale-preset')).toBe(false)
    unblock()
    await Promise.resolve()

    expect(activePresetId).toBe('preset-a')
  })
})
