/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test'
import type { AppStore } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { createGenerationSlice } from './generation'
import {
  createSettingsSlice,
  canPersistPortraitDockInitialization,
  flushSettingsNow,
  resetSettingsPersistence,
  shouldReloadSettingsAfterUpdate,
} from './settings'

const original = { getAll: settingsApi.getAll, putMany: settingsApi.putMany }

function store(): AppStore {
  const state = {} as AppStore
  const set = (value: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) => Object.assign(state, typeof value === 'function' ? value(state) : value)
  const get = () => state
  Object.assign(state, createGenerationSlice(set as never, get, {} as never))
  Object.assign(state, createSettingsSlice(set as never, get, {} as never))
  return state
}

function database(rows: Map<string, unknown>) {
  settingsApi.getAll = async () => [...rows].map(([key, value]) => ({ key, value, updated_at: 1 }))
  settingsApi.putMany = async values => {
    for (const [key, value] of Object.entries(values)) rows.set(key, value)
    return Object.entries(values).map(([key, value]) => ({ key, value, updated_at: 1 }))
  }
}

afterEach(() => {
  resetSettingsPersistence()
  settingsApi.getAll = original.getAll
  settingsApi.putMany = original.putMany
})

describe('portrait dock persistence', () => {
  test('restores canonical open state and geometry after reload', async () => {
    const rows = new Map<string, unknown>()
    database(rows)
    const first = store()
    const saved = { ...first.portraitDockSettings, open: true, dockSide: 'left' as const, rect: { x: 24, y: 48, width: 284, height: 412 } }
    first.setSetting('portraitDockSettings', saved)
    await flushSettingsNow()

    const restored = store()
    await restored.loadSettings()
    expect(restored.portraitDockSettings).toEqual(saved)
  })

  test('does not replace canonical geometry with a stale private fallback', async () => {
    const saved = { ...store().portraitDockSettings, open: false, dockSide: 'left' as const, rect: { x: 24, y: 48, width: 284, height: 412 } }
    const rows = new Map<string, unknown>([
      ['portraitDockSettings', saved],
      ['spindle:lumiverse_suite:portrait_dock:portraitDockSettings', { ...saved, open: true, dockSide: 'right', rect: { x: 0, y: 0, width: 360, height: 520 } }],
    ])
    database(rows)
    const restored = store()
    await restored.loadSettings()
    expect(restored.portraitDockSettings).toEqual(saved)
  })

  test('does not PUT a matching private fallback after canonical reload', async () => {
    const saved = { ...store().portraitDockSettings, open: true, dockSide: 'left' as const }
    const rows = new Map<string, unknown>([
      ['portraitDockSettings', saved],
      ['spindle:lumiverse_suite:portrait_dock:portraitDockSettings', saved],
    ])
    database(rows)
    let puts = 0
    settingsApi.putMany = async values => {
      puts += 1
      for (const [key, value] of Object.entries(values)) rows.set(key, value)
      return []
    }

    await store().loadSettings()
    await flushSettingsNow()

    expect(puts).toBe(0)
  })

  test('repairs a mismatched private fallback from the canonical row', async () => {
    const saved = { ...store().portraitDockSettings, open: false, dockSide: 'left' as const }
    const privateKey = 'spindle:lumiverse_suite:portrait_dock:portraitDockSettings'
    const rows = new Map<string, unknown>([
      ['portraitDockSettings', saved],
      [privateKey, { ...saved, open: true, dockSide: 'right' }],
    ])
    database(rows)

    await store().loadSettings()
    await flushSettingsNow()

    expect(rows.get(privateKey)).toEqual(saved)
  })

  test('consumes one matching own websocket echo and reloads for the next or unrelated event', async () => {
    const first = store()
    const saved = { ...first.portraitDockSettings, open: true }
    const privateKey = 'spindle:lumiverse_suite:portrait_dock:portraitDockSettings'
    database(new Map())
    first.setSetting('portraitDockSettings', saved)
    await flushSettingsNow()

    expect(shouldReloadSettingsAfterUpdate({ keys: ['portraitDockSettings', privateKey] })).toBe(false)
    expect(shouldReloadSettingsAfterUpdate({ keys: ['portraitDockSettings', privateKey] })).toBe(true)
    expect(shouldReloadSettingsAfterUpdate({ keys: ['theme'] })).toBe(true)
  })

  test('delayed hydration keeps persisted portrait state when automatic initialization is guarded', async () => {
    const first = store()
    const saved = {
      ...first.portraitDockSettings,
      open: false,
      dockSide: 'left' as const,
      rect: { x: 24, y: 48, width: 284, height: 412 },
    }
    const rows = new Map<string, unknown>([
      ['portraitDockSettings', saved],
      ['spindle:lumiverse_suite:portrait_dock:portraitDockSettings', saved],
    ])
    let release!: () => void
    const delayed = new Promise<void>((resolve) => { release = resolve })
    const puts: Record<string, unknown>[] = []
    settingsApi.getAll = async () => {
      await delayed
      return [...rows].map(([key, value]) => ({ key, value, updated_at: 1 }))
    }
    settingsApi.putMany = async values => {
      puts.push(values)
      return []
    }

    const restored = store()
    const loading = restored.loadSettings()
    expect(restored.fullSettingsLoaded).toBe(false)
    expect(canPersistPortraitDockInitialization(restored.fullSettingsLoaded)).toBe(false)

    // The normal PortraitDock startup effect derives runtime open state here,
    // but the readiness guard prevents it from calling setSetting.
    release()
    await loading
    await flushSettingsNow()

    expect(restored.portraitDockSettings).toEqual(saved)
    expect(puts).toEqual([])
  })

  test('a genuine user edit during a delayed load still wins over the stale server snapshot', async () => {
    const first = store()
    const saved = {
      ...first.portraitDockSettings,
      dockSide: 'left' as const,
      rect: { x: 24, y: 48, width: 284, height: 412 },
    }
    const rows = new Map<string, unknown>([['portraitDockSettings', saved]])
    let release!: () => void
    const delayed = new Promise<void>((resolve) => { release = resolve })
    settingsApi.getAll = async () => {
      await delayed
      return [...rows].map(([key, value]) => ({ key, value, updated_at: 1 }))
    }
    settingsApi.putMany = async values => {
      for (const [key, value] of Object.entries(values)) rows.set(key, value)
      return []
    }

    const restored = store()
    const loading = restored.loadSettings()
    const userEdit = {
      ...restored.portraitDockSettings,
      dockSide: 'right' as const,
      rect: { x: 96, y: 64, width: 320, height: 460 },
    }
    restored.setSetting('portraitDockSettings', userEdit, 'user')
    release()
    await loading

    expect(restored.portraitDockSettings).toEqual(userEdit)
  })

  test('a semantic no-op does not queue a persistence revision', async () => {
    const restored = store()
    let puts = 0
    settingsApi.putMany = async () => {
      puts += 1
      return []
    }

    restored.setSetting('portraitDockSettings', structuredClone(restored.portraitDockSettings), 'portrait-dock-init')
    await flushSettingsNow()

    expect(puts).toBe(0)
  })

  test('skips automatic pre-hydration writes but preserves an explicit interaction', async () => {
    const restored = store()
    const automatic = { ...restored.portraitDockSettings, dockSide: 'right' as const, rememberSizePosition: false }
    restored.setSetting('portraitDockSettings', automatic, 'automatic-sync')
    await flushSettingsNow()
    expect(restored.portraitDockSettings).toEqual(automatic)

    let puts = 0
    settingsApi.putMany = async values => {
      puts += 1
      return Object.entries(values).map(([key, value]) => ({ key, value, updated_at: 1 }))
    }
    restored.setSetting('portraitDockSettings', { ...automatic, dockSide: 'left' }, 'user-interaction')
    await flushSettingsNow()
    expect(puts).toBe(1)
  })
})

describe('long message collapse settings', () => {
  test('defaults to disabled with the comfortable height preset', () => {
    const initial = store()
    expect(initial.longMessageCollapseEnabled).toBe(false)
    expect(initial.longMessageCollapsePreset).toBe('comfortable')
    expect(initial.longMessageCollapseCustomHeight).toBe(500)
    expect(initial.longMessageCollapseDepth).toBe(0)
  })

  test('persists and restores the enable flag and height preset', async () => {
    const rows = new Map<string, unknown>()
    database(rows)
    const first = store()

    first.setSetting('longMessageCollapseEnabled', true)
    first.setSetting('longMessageCollapsePreset', 'custom')
    first.setSetting('longMessageCollapseCustomHeight', 347)
    first.setSetting('longMessageCollapseDepth', 6)
    await flushSettingsNow()

    expect(rows.get('longMessageCollapseEnabled')).toBe(true)
    expect(rows.get('longMessageCollapsePreset')).toBe('custom')
    expect(rows.get('longMessageCollapseCustomHeight')).toBe(347)
    expect(rows.get('longMessageCollapseDepth')).toBe(6)

    const restored = store()
    await restored.loadSettings()
    expect(restored.longMessageCollapseEnabled).toBe(true)
    expect(restored.longMessageCollapsePreset).toBe('custom')
    expect(restored.longMessageCollapseCustomHeight).toBe(347)
    expect(restored.longMessageCollapseDepth).toBe(6)
  })
})
