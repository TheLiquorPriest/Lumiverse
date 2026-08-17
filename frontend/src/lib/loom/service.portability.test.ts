import { describe, expect, test } from 'bun:test'
import type { AgentConfigV2, LoomPreset } from './types'
import type {
  PortableAgentConfigV1,
  PortableAgenticRuntimeEnvelopeV1,
} from './service'
import {
  coerceImportedLoomPreset,
  createNewLoomPreset,
  createPortableLoomExportPayload,
  extractPortableAgenticRuntimeEnvelope,
  marshalPreset,
  parsePortableAgenticRuntimeEnvelope,
  shouldRollbackImportedPreset,
  stripPortableRegexOwnership,
  unmarshalPreset,
} from './service'
import type { Preset } from '@/types/api'
import {
  createPortableContextPackSnapshotId,
  estimateContextPackTokens,
  hashContextPackContent,
  parsePortableContextPackSnapshotV1,
  serializeContextPackContent,
  utf8Bytes,
} from '@/types/agent-context-packs'

const snapshotContent = [{ id: 'fact-1', title: 'Fact', body: 'Literal fact', tags: ['canon'] }]
const serializedSnapshotContent = serializeContextPackContent(snapshotContent)
const digest = hashContextPackContent(serializedSnapshotContent)
const snapshotId = createPortableContextPackSnapshotId(digest, 2)
const snapshotByteCount = utf8Bytes(serializedSnapshotContent)
const snapshotTokenCount = estimateContextPackTokens(serializedSnapshotContent)

function portableConfig(): PortableAgentConfigV1 {
  return {
    portableVersion: 1,
    agentsEnabled: true,
    allowedModes: ['response', 'agentic'],
    defaultMode: 'agentic',
    maxInvocations: 4,
    maxToolCalls: 8,
    mainToolIds: ['chat_search_history'],
    mainLoreScope: 'active',
    profiles: [{
      id: 'writer',
      name: 'Writer',
      systemPrompt: 'Write the answer.',
      connectionRef: { kind: 'slot', slotId: 'writer' },
      toolIds: [],
      workspaceCapabilities: [],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: true,
      maxOutputTokens: 256,
      timeoutMs: 5_000,
    }],
    connectionSlots: [{
      id: 'writer',
      label: 'Writer connection',
      requiredCapabilities: ['generation', 'streaming'],
    }],
  }
}

function envelope(): PortableAgenticRuntimeEnvelopeV1 {
  return {
    version: 1,
    agentConfig: portableConfig(),
    contextPacks: [{
      portableVersion: 1,
      snapshotId,
      name: 'Facts',
      description: 'Portable facts',
      revision: 2,
      content: snapshotContent,
      contentDigest: digest,
      tokenCount: snapshotTokenCount,
      byteCount: snapshotByteCount,
    }],
    contextSelections: [{
      packSnapshotId: snapshotId,
      revisionId: `${snapshotId}@2`,
      digest,
    }],
    contextRules: [{
      id: 'facts-rule',
      packId: snapshotId,
      revisionId: `${snapshotId}@2`,
      required: true,
    }],
    taskTemplates: [{ id: 'write', required: true, label: 'Write' }],
  }
}

function localPreset(): LoomPreset {
  const preset = createNewLoomPreset('Portable')
  const localConfig: AgentConfigV2 = {
    version: 2,
    agentsEnabled: true,
    allowedModes: ['response', 'agentic'],
    defaultMode: 'agentic',
    maxInvocations: 4,
    maxToolCalls: 8,
    mainToolIds: ['chat_search_history'],
    mainLoreScope: 'active',
    profiles: [{
      id: 'writer',
      name: 'Writer',
      systemPrompt: 'Write the answer.',
      connectionRef: { kind: 'slot', slotId: 'writer' },
      toolIds: [],
      workspaceCapabilities: [],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: true,
      maxOutputTokens: 256,
      timeoutMs: 5_000,
    }],
    connectionSlots: [{ id: 'writer', label: 'Writer', requiredCapabilities: ['generation', 'streaming'] }],
  }
  preset.agentConfig = localConfig
  preset.agentSlotBindings = { writer: 'local-connection-id' }
  preset.agentConfigReview = {
    state: 'ready',
    revision: 4,
    reasonCode: null,
    unresolvedSlotIds: [],
    staleSlotIds: [],
    acknowledged: true,
    items: [],
  }
  preset.passthroughMetadata = {
    agentConfig: {
      version: 1,
      enabled: true,
      maxInvocations: 4,
      maxToolCalls: 8,
      mainToolIds: [],
      mainLoreScope: 'active',
      profiles: [],
    },
    agentConfigReviewRequired: true,
    extension: { preserve: true },
  }
  return preset
}

describe('Loom portable Agentic runtime adapter', () => {
  test('exports the canonical V2 envelope without local IDs, bindings, or legacy metadata', () => {
    const payload = createPortableLoomExportPayload(localPreset(), envelope())
    const metadata = payload.passthroughMetadata as Record<string, unknown>

    expect(payload.agentRuntime).toEqual(envelope())
    expect(payload).not.toHaveProperty('agentConfig')
    expect(payload).not.toHaveProperty('agentSlotBindings')
    expect(payload).not.toHaveProperty('agentConfigReview')
    expect(metadata).not.toHaveProperty('agentConfig')
    expect(metadata).not.toHaveProperty('agentConfigReviewRequired')
    expect(JSON.stringify(payload)).not.toContain('local-connection-id')
    expect(metadata.extension).toEqual({ preserve: true })
  })
  test('strips source-local preset ownership from regex companions', () => {
    const scripts = stripPortableRegexOwnership([{
      name: 'local',
      preset_id: 'source-preset',
      presetId: 'source-preset-camel',
      find_regex: 'x',
    }])
    expect(scripts[0]).not.toHaveProperty('preset_id')
    expect(scripts[0]).not.toHaveProperty('presetId')
    expect(scripts[0].find_regex).toBe('x')
  })
  test('uses the strict shared context snapshot parser with UTF-8 accounting', () => {
    const unicodeContent = [{ id: '事实', title: '', body: '😀', tags: ['事实'] }]
    const serialized = serializeContextPackContent(unicodeContent)
    const contentDigest = hashContextPackContent(serialized)
    const snapshot = {
      portableVersion: 1 as const,
      snapshotId: createPortableContextPackSnapshotId(contentDigest, 1),
      name: '事实',
      description: '',
      revision: 1,
      content: unicodeContent,
      contentDigest,
      tokenCount: estimateContextPackTokens(serialized),
      byteCount: utf8Bytes(serialized),
    }
    expect(parsePortableContextPackSnapshotV1(snapshot).byteCount).toBe(utf8Bytes(serialized))
    expect(() => parsePortableContextPackSnapshotV1({ ...snapshot, byteCount: serialized.length })).toThrow()
    expect(() => parsePortableContextPackSnapshotV1({ ...snapshot, contentDigest: 'b'.repeat(64) })).toThrow()
  })

  test('does not delete a committed portable import after hydration or selection failure', () => {
    expect(shouldRollbackImportedPreset('imported-preset', true)).toBe(false)
    expect(shouldRollbackImportedPreset('created-preset', false)).toBe(true)
    expect(shouldRollbackImportedPreset(null, true)).toBe(false)
  })

  test('accepts server-authored foreign slots and preserves the returned disabled review state', () => {
    const foreign = envelope()
    const parsed = parsePortableAgenticRuntimeEnvelope(foreign)
    expect(parsed.agentConfig?.profiles[0]?.connectionRef).toEqual({ kind: 'slot', slotId: 'writer' })
    expect(parsed.agentConfig?.profiles[0]).not.toHaveProperty('connectionProfileId')

    const preset: Preset = {
      id: 'foreign-preset',
      name: 'Foreign',
      provider: 'loom',
      parameters: {},
      prompt_order: [],
      prompts: {},
      metadata: {},
      agent_config: {
        ...localPreset().agentConfig!,
        agentsEnabled: false,
        allowedModes: ['response'],
        defaultMode: 'response',
      },
      agent_config_review: {
        state: 'review_required',
        revision: 1,
        reasonCode: 'foreign_import',
        unresolvedSlotIds: ['writer'],
        staleSlotIds: [],
        acknowledged: false,
        items: [],
      },
      created_at: 1,
      updated_at: 1,
    }
    const imported = unmarshalPreset(preset)
    expect(imported.agentConfig?.agentsEnabled).toBe(false)
    expect(imported.agentConfig?.allowedModes).toEqual(['response'])
    expect(imported.agentConfigReview?.unresolvedSlotIds).toEqual(['writer'])
  })

  test('fails closed when the envelope is malformed or contains a local binding', () => {
    const valid = envelope()
    expect(() => parsePortableAgenticRuntimeEnvelope({ ...valid, version: 2 })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    expect(() => parsePortableAgenticRuntimeEnvelope({
      ...valid,
      agentConfig: {
        ...valid.agentConfig,
        profiles: [{
          ...valid.agentConfig!.profiles[0],
          connectionProfileId: 'local-profile-id',
        },
        ],
      },
    })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    expect(() => extractPortableAgenticRuntimeEnvelope({
      ...localPreset(),
      agentRuntime: { ...valid, contextPacks: [{ ...valid.contextPacks[0], byteCount: -1 }] },
    })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })

  test('keeps a no-envelope internal import on the Response-compatible path', () => {
    const responseOnly = { ...localPreset(), passthroughMetadata: { extension: { preserve: true } } }
    delete (responseOnly as unknown as Record<string, unknown>).agentConfig
    delete (responseOnly as unknown as Record<string, unknown>).agentSlotBindings
    delete (responseOnly as unknown as Record<string, unknown>).agentConfigReview
    const imported = coerceImportedLoomPreset(responseOnly, 'Fallback')
    const request = marshalPreset(imported)
    expect(extractPortableAgenticRuntimeEnvelope(responseOnly)).toBeNull()
    expect(request.metadata).not.toHaveProperty('agentConfig')
    expect(request.metadata).not.toHaveProperty('agentConfigReviewRequired')
  })
  test('does not resurrect legacy metadata when a canonical portable envelope is present', () => {
    const payload = createPortableLoomExportPayload(localPreset(), envelope())
    payload.passthroughMetadata = {
      agentConfig: {
        version: 1,
        enabled: true,
        maxInvocations: 1,
        maxToolCalls: 1,
        mainToolIds: [],
        mainLoreScope: 'active',
        profiles: [],
      },
      extension: { preserve: true },
    }

    const imported = coerceImportedLoomPreset(payload, 'Fallback')
    expect(imported.agentConfig).toBeNull()
    const metadata = marshalPreset(imported).metadata!
    expect(metadata.agentConfig).toBeUndefined()
    expect(metadata.extension).toEqual({ preserve: true })
  })
  test('keeps canonical top-level V2 config over obsolete metadata.agentConfig', () => {
    const canonicalConfig = localPreset().agentConfig!
    const imported = coerceImportedLoomPreset({
      ...localPreset(),
      agentConfig: canonicalConfig,
      passthroughMetadata: {
        agentConfig: {
          version: 1,
          enabled: false,
          maxInvocations: 1,
          maxToolCalls: 1,
          mainToolIds: [],
          mainLoreScope: 'active',
          profiles: [],
        },
        extension: { preserve: true },
      },
    }, 'Fallback')

    expect(imported.agentConfig).toEqual(canonicalConfig)
    expect(imported.passthroughMetadata).toEqual({ extension: { preserve: true } })
  })
})
