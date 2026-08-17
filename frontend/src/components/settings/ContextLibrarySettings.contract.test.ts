import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import en from '@/i18n/locales/en/settings.json'
import zh from '@/i18n/locales/zh/settings.json'
import zhTw from '@/i18n/locales/zh-TW/settings.json'
import ja from '@/i18n/locales/ja/settings.json'
import fr from '@/i18n/locales/fr/settings.json'
import it from '@/i18n/locales/it/settings.json'

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key))
}

const locales = { en, zh, 'zh-TW': zhTw, ja, fr, it }

describe('Context Library settings contracts', () => {
  test('keeps Agent Runtime and Context Library key sets complete in all six locales', () => {
    const expectedContextKeys = leafKeys(en.contextLibrary).sort()
    const expectedRuntimeKeys = leafKeys(en.agentRuntimeSettings).sort()

    for (const [locale, settings] of Object.entries(locales)) {
      expect(leafKeys(settings.contextLibrary).sort(), `${locale} Context Library keys`).toEqual(expectedContextKeys)
      expect(leafKeys(settings.agentRuntimeSettings).sort(), `${locale} Agent Runtime keys`).toEqual(expectedRuntimeKeys)
      expect(settings.tabs.contextLibrary.shortName).toBeTruthy()
      expect(settings.tabs.agentRuntime.shortName).toBeTruthy()
      expect(settings.contextLibrary.actions.import).toBeTruthy()
      expect(settings.contextLibrary.actions.retryTargets).toBeTruthy()
      expect(settings.contextLibrary.targetLoadError).toBeTruthy()
      expect(settings.contextLibrary.targetsLoaded).toBeTruthy()
      expect(settings.contextLibrary.importing).toBeTruthy()
      expect(settings.contextLibrary.importComplete).toBeTruthy()
    }
  })

  test('localizes the primary labels rather than relying on an English fallback', () => {
    for (const [locale, settings] of Object.entries(locales)) {
      if (locale === 'en') continue
      expect(settings.contextLibrary.title).not.toBe(en.contextLibrary.title)
      expect(settings.agentRuntimeSettings.description).not.toBe(en.agentRuntimeSettings.description)
    }
  })

  test('locks responsive safe-area, mobile-keyboard, reduced-motion, focus, and 44px target contracts', async () => {
    const contextCss = await Bun.file(resolve(import.meta.dir, 'ContextLibrarySettings.module.css')).text()
    const runtimeCss = await Bun.file(resolve(import.meta.dir, 'AgentRuntimeSettings.module.css')).text()

    const tokensCss = await Bun.file(resolve(import.meta.dir, '../../theme/variables.css')).text()
    const settingsModalCss = await Bun.file(resolve(import.meta.dir, '../modals/SettingsModal.module.css')).text()
    const settingsModalSource = await Bun.file(resolve(import.meta.dir, '../modals/SettingsModal.tsx')).text()
    expect(contextCss).toContain('min-height: var(--lumiverse-control-min)')
    expect(contextCss).toContain('min-width: var(--lumiverse-control-min)')
    expect(contextCss).toContain('100dvh')
    expect(contextCss).toContain('env(safe-area-inset-bottom)')
    expect(contextCss).toContain('@media (prefers-reduced-motion: reduce)')
    expect(contextCss).toContain(':focus-visible')
    expect(contextCss).toContain('@container (max-width: 48rem)')
    expect(runtimeCss).toContain('@container (max-width: 36rem)')
    expect(runtimeCss).toContain('@media (prefers-reduced-motion: reduce)')
    expect(tokensCss).toContain('--lumiverse-control-min: 44px')
    expect(settingsModalCss).toMatch(/\.navBtn\s*\{[^}]*min-height: var\(--lumiverse-control-min\)/s)
    expect(settingsModalSource).toContain('useReducedMotion')
    expect(settingsModalSource).toContain('duration: reduceMotion ? 0 : 0.15')
  })

  test('does not add a deferred Tool Library settings surface', () => {
    const deliveredStrings = JSON.stringify({
      contextLibrary: en.contextLibrary,
      agentRuntimeSettings: en.agentRuntimeSettings,
      tabs: { contextLibrary: en.tabs.contextLibrary, agentRuntime: en.tabs.agentRuntime },
    })
    expect(deliveredStrings).not.toContain('Tool Library')
  })
})
