import { describe, expect, test } from 'bun:test'
import type { Preset } from '@/types/api'
import type { AgentConfigV2 } from './types'
import { createDefaultAgentConfigV2 } from './agenticRuntime'
import {
  coerceImportedLoomPreset,
  marshalPreset,
  marshalUpdate,
  unmarshalPreset,
} from './service'
function rawPreset(metadata: Record<string, unknown>, overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'preset-1',
    name: 'Metadata test',
    provider: 'loom',
    parameters: {},
    prompt_order: [],
    prompts: {},
    metadata,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  }
}

describe('Loom extension metadata preservation', () => {
  test('defaults trim-incomplete-words to off for existing presets', () => {
    expect(unmarshalPreset(rawPreset({})).advancedSettings.trimIncompleteWords).toBe(false)
  })

  test('round-trips unknown namespaced metadata without allowing it to override core fields', () => {
    const loom = unmarshalPreset(rawPreset({
      description: 'Core description',
      agentic_preset_composer: { mode: 'parallel', threads: ['a', 'b'] },
      _lumiverse_lumihub_id: 'hub-1',
    }))

    expect(loom.passthroughMetadata.agentic_preset_composer).toEqual({
      mode: 'parallel',
      threads: ['a', 'b'],
    })

    loom.passthroughMetadata.description = 'Attempted override'
    const metadata = marshalUpdate(loom).metadata!
    expect(metadata.description).toBe('Core description')
    expect(metadata.agentic_preset_composer).toEqual({ mode: 'parallel', threads: ['a', 'b'] })
    expect(metadata._lumiverse_lumihub_id).toBe('hub-1')
  })

  test('survives the internal export/import shape', () => {
    const loom = unmarshalPreset(rawPreset({
      agentic_preset_composer: { version: 1, pipelines: [{ id: 'main' }] },
    }))
    const exported = JSON.parse(JSON.stringify(loom))
    const imported = coerceImportedLoomPreset(exported, 'Fallback')
    expect(marshalPreset(imported).metadata?.agentic_preset_composer).toEqual({
      version: 1,
      pipelines: [{ id: 'main' }],
    })
  })

  test("normalizes draft tool-call limits during import/export without creating absent metadata", () => {
    const legacyConfig = {
      version: 1,
      enabled: true,
      maxInvocations: 64,
      mainToolIds: [],
      mainLoreScope: 'active',
      profiles: [],
    }
    const legacy = coerceImportedLoomPreset(rawPreset({
      agentConfig: legacyConfig,
      extensionData: { keep: true },
    }), 'Fallback')
    expect(legacy.agentConfig).toMatchObject({
      agentsEnabled: false,
      maxToolCalls: 64,
    })
    expect(marshalPreset(legacy).metadata?.extensionData).toEqual({ keep: true })

    for (const maxToolCalls of [1, 64, Number.MAX_SAFE_INTEGER]) {
      const imported = coerceImportedLoomPreset(rawPreset({
        agentConfig: { ...legacyConfig, maxToolCalls },
      }), 'Fallback')
      expect(imported.agentConfig).toMatchObject({
        agentsEnabled: false,
        maxToolCalls,
      })
    }

    const noAgentMetadata = unmarshalPreset(rawPreset({ extensionData: { keep: true } }))
    expect(marshalPreset(noAgentMetadata).metadata).not.toHaveProperty('agentConfig')
  })
  test('migrates imported agent config without dropping unknown metadata', () => {
    const imported = coerceImportedLoomPreset(rawPreset({
      agentConfig: {
        version: 1,
        enabled: true,
        mainToolIds: ['chat_search_history'],
        mainLoreScope: 'active',
        profiles: [{
          id: 'writer',
          name: 'Writer',
          systemPrompt: 'literal',
          connectionProfileId: null,
          toolIds: ['lore_search_entries'],
          loreScope: 'active',
          allowMainDelegation: false,
          failurePolicy: 'optional',
          streamActivity: false,
          maxOutputTokens: 64,
          timeoutMs: 5000,
        }],
      },
      unknown_extension: { keep: true },
    }), 'Fallback')
    const metadata = marshalPreset(imported).metadata!
    expect(metadata.agentConfig).toBeUndefined()
    expect(imported.agentConfig).toMatchObject({
      version: 2,
      agentsEnabled: false,
      maxInvocations: 64,
      maxToolCalls: 64,
    })

    expect(metadata.agentConfigReviewRequired).toBeUndefined()
    expect(metadata.unknown_extension).toEqual({ keep: true })
  })
  test('requires review before enabling an imported config that was already disabled', () => {
    const imported = coerceImportedLoomPreset(rawPreset({
      agentConfig: {
        version: 1,
        enabled: false,
        maxInvocations: 128,
        maxToolCalls: 256,
        mainToolIds: ['chat_search_history'],
        mainLoreScope: 'active',
        profiles: [{
          id: 'writer',
          name: 'Writer',
          systemPrompt: 'literal',
          connectionProfileId: null,
          toolIds: ['lore_search_entries'],
          loreScope: 'active',
          allowMainDelegation: false,
          failurePolicy: 'optional',
          streamActivity: false,
          maxOutputTokens: 64,
          timeoutMs: 5000,
        }],
      },
      unknown_extension: { keep: true },
    }), 'Fallback')
    const metadata = marshalPreset(imported).metadata!
    expect(metadata.agentConfig).toBeUndefined()
    expect(imported.agentConfig).toMatchObject({
      agentsEnabled: false,
      maxInvocations: 128,
      maxToolCalls: 256,
    })
    expect(metadata.agentConfigReviewRequired).toBeUndefined()
    expect(metadata.unknown_extension).toEqual({ keep: true })
  })
  test('keeps canonical top-level V2 config over obsolete metadata.agentConfig', () => {
    const legacyConfig = {
      version: 1,
      enabled: true,
      maxInvocations: 1,
      maxToolCalls: 1,
      mainToolIds: [],
      mainLoreScope: 'active',
      profiles: [],
    }
    const canonicalConfig: AgentConfigV2 = {
      ...createDefaultAgentConfigV2(),
      agentsEnabled: true,
      allowedModes: ['response', 'agentic'],
      defaultMode: 'agentic',
      maxInvocations: 9,
      maxToolCalls: 11,
    }
    const imported = coerceImportedLoomPreset(rawPreset(
      { agentConfig: legacyConfig, extension: { keep: true } },
      { agent_config: canonicalConfig },
    ), 'Fallback')

    expect(imported.agentConfig).toMatchObject({
      version: 2,
      agentsEnabled: true,
      defaultMode: 'agentic',
      maxInvocations: 9,
      maxToolCalls: 11,
    })
    const metadata = marshalPreset(imported).metadata!
    expect(metadata.agentConfig).toBeUndefined()
    expect(metadata.extension).toEqual({ keep: true })
  })

  test('rejects an invalid imported config instead of preserving executable metadata', () => {
    expect(() => coerceImportedLoomPreset(rawPreset({
      agentConfig: {
        version: 1,
        enabled: false,
        mainToolIds: ['not_a_tool'],
        mainLoreScope: 'active',
        profiles: [],
      },
    }), 'Fallback')).toThrow('metadata.agentConfig: invalid configuration')
  })

  test('rejects invalid or unknown imported invocation-limit fields', () => {
    for (const maxInvocations of [0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => coerceImportedLoomPreset(rawPreset({
        agentConfig: {
          version: 1,
          enabled: false,
          maxInvocations,
          mainToolIds: [],
          mainLoreScope: 'active',
          profiles: [],
        },
      }), 'Fallback')).toThrow('metadata.agentConfig: invalid configuration')
    }
    for (const maxToolCalls of [0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => coerceImportedLoomPreset(rawPreset({
        agentConfig: {
          version: 1,
          enabled: false,
          maxToolCalls,
          mainToolIds: [],
          mainLoreScope: 'active',
          profiles: [],
        },
      }), 'Fallback')).toThrow('metadata.agentConfig: invalid configuration')
    }

    expect(() => coerceImportedLoomPreset(rawPreset({
      agentConfig: {
        version: 1,
        enabled: false,
        maxInvocations: 64,
        invocationCeiling: 64,
        toolCallCeiling: 64,
        mainToolIds: [],
        mainLoreScope: 'active',
        profiles: [],
      },
    }), 'Fallback')).toThrow('metadata.agentConfig: invalid configuration')
  })


})
