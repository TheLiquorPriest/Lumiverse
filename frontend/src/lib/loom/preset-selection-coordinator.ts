import {
  createPresetSelectionCoordinator,
  type PresetSelectionAdapter,
  type PresetSelectionCoordinator,
  type PresetSelectionRequest,
  type PresetSelectionTransitionOptions,
} from './preset-selection-coordinator-core'

export {
  createPresetSelectionCoordinator,
  type PresetSelectionAdapter,
  type PresetSelectionCoordinator,
  type PresetSelectionTransitionOptions,
  type PresetSelectionRequest,
} from './preset-selection-coordinator-core'

export type ActiveLoomPresetSelectionBlocker = (presetId: string | null) => boolean

let presetSelectionCoordinator: PresetSelectionCoordinator | null = null
let unconfiguredWarningLogged = false
const activeSelectionBlockers = new Set<ActiveLoomPresetSelectionBlocker>()
let blockedSelectionReplay: {
  owner: symbol
  presetId: string | null
  signal: AbortSignal
  dispose: () => void
} | null = null

function isActiveLoomPresetSelectionBlocked(presetId: string | null): boolean {
  for (const blocker of activeSelectionBlockers) {
    if (blocker(presetId)) return true
  }
  return false
}

export function registerActiveLoomPresetSelectionBlocker(
  blocker: ActiveLoomPresetSelectionBlocker,
): () => void {
  activeSelectionBlockers.add(blocker)
  return () => {
    activeSelectionBlockers.delete(blocker)
    if (activeSelectionBlockers.size > 0 || !blockedSelectionReplay) return
    const replay = blockedSelectionReplay
    blockedSelectionReplay = null
    if (replay.signal.aborted) {
      replay.dispose()
      return
    }
    void getPresetSelectionCoordinator()
      .transition(replay.presetId, { signal: replay.signal })
      .catch(() => {})
      .finally(replay.dispose)
  }
}

function createNoOpPresetSelectionCoordinator(): PresetSelectionCoordinator {
  return {
    begin: () => ({
      transition: async () => false,
      cancel() {},
    }),
    transition: async () => false,
  }
}

export function configurePresetSelectionCoordinator(adapter: PresetSelectionAdapter): void {
  presetSelectionCoordinator = createPresetSelectionCoordinator(adapter)
}

function getPresetSelectionCoordinator(): PresetSelectionCoordinator {
  if (!presetSelectionCoordinator) {
    if (!unconfiguredWarningLogged) {
      unconfiguredWarningLogged = true
      console.warn(
        '[preset-selection] Coordinator not configured; using no-op fallback. ' +
        'This is expected in tests and SSR, but the app root should call configurePresetSelectionCoordinator.',
      )
    }
    return createNoOpPresetSelectionCoordinator()
  }
  return presetSelectionCoordinator
}

export function beginActiveLoomPresetSelection(
  options?: PresetSelectionTransitionOptions,
): PresetSelectionRequest {
  const request = getPresetSelectionCoordinator().begin(options)
  if (options?.signal?.aborted) return request
  const owner = Symbol('preset-selection-request')
  const replayAbort = new AbortController()
  const dispose = () => options?.signal?.removeEventListener('abort', abortReplay)
  const clearReplay = () => {
    if (blockedSelectionReplay?.owner === owner) blockedSelectionReplay = null
    dispose()
  }
  const abortReplay = () => {
    replayAbort.abort(options?.signal?.reason)
    clearReplay()
  }
  options?.signal?.addEventListener('abort', abortReplay, { once: true })
  return {
    transition(presetId) {
      if (options?.signal?.aborted) {
        dispose()
        return Promise.resolve(false)
      }
      if (isActiveLoomPresetSelectionBlocked(presetId)) {
        blockedSelectionReplay?.dispose()
        blockedSelectionReplay = {
          owner,
          presetId,
          signal: replayAbort.signal,
          dispose,
        }
        request.cancel()
        return Promise.resolve(false)
      }
      return request.transition(presetId).finally(dispose)
    },
    cancel() {
      request.cancel()
      replayAbort.abort()
      clearReplay()
    },
  }
}

export function transitionActiveLoomPreset(
  presetId: string | null,
  options?: PresetSelectionTransitionOptions,
): Promise<boolean> {
  return beginActiveLoomPresetSelection(options).transition(presetId)
}
