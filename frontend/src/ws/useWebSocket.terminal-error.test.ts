/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const requestedKeys: string[] = []
const translations: Record<string, string> = {}
const testI18n = {
  t(key: string | readonly string[]) {
    const normalizedKey = typeof key === 'string' ? key : key[0]
    requestedKeys.push(normalizedKey)
    return translations[normalizedKey] ?? normalizedKey
  },
}

mock.module('@/i18n', () => ({
  default: testI18n,
  UI_LANGUAGE_STORAGE_KEY: 'lumiverse-ui-language',
  initI18n: async () => testI18n,
  ensureLanguageLoaded: async () => {},
  changeUiLanguage: async () => {},
}))
mock.module('@/lib/cssModuleRegistry', () => ({
  CSS_MODULE_REGISTRY: [],
  generateSelector: () => '',
}))
mock.module('@/router', () => ({
  router: {
    navigate: async () => {},
  },
}))
mock.module('@/api/auth', () => ({
  authClient: {
    signIn: { username: async () => ({ data: null, error: null }) },
    signOut: async () => {},
    getSession: async () => ({ data: null }),
  },
  getAuthErrorMessage: () => 'Authentication failed',
  readAuthErrorResponseMeta: async () => null,
}))

const { formatTerminalGenerationError } = await import('./useWebSocket')

beforeEach(() => {
  requestedKeys.length = 0
  for (const key of Object.keys(translations)) delete translations[key]
})

function installTranslations(values: Readonly<Record<string, string>>): void {
  Object.assign(translations, values)
}

describe('terminal generation error formatting', () => {
  test('uses the canonical runtime error namespace for a mapped error', () => {
    installTranslations({
      'chat.agentRuntime.errors.agentic_provider_failure': 'Localized provider failure',
    })

    expect(formatTerminalGenerationError({
      agentError: { code: 'agentic_provider_failure' },
    })).toBe('Localized provider failure')
    expect(requestedKeys).toEqual([
      'chat.agentRuntime.errors.agentic_provider_failure',
    ])
  })

  test('falls back to the canonical internal error without consulting activity labels', () => {
    installTranslations({
      'chat.agentRuntime.errors.agentic_internal_error': 'Localized internal failure',
    })

    expect(formatTerminalGenerationError({
      agentError: { code: 'future_agent_error' },
    })).toBe('Localized internal failure')
    expect(requestedKeys).toEqual([
      'chat.agentRuntime.errors.future_agent_error',
      'chat.agentRuntime.errors.agentic_internal_error',
    ])
    expect(requestedKeys.some((key) => key.includes('agentActivity.errors'))).toBeFalse()
  })
})
