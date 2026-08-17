import { get, post, put, del } from './client'
import type { Preset, PresetRegistryItem, CreatePresetInput, UpdatePresetInput, PaginatedResult } from '@/types/api'
import type { PromptBlock } from '@/lib/loom/types'
import type { PortableAgentConfigV1, PortableAgenticRuntimeEnvelopeV1 } from '@/lib/loom/service'
import type { AgentRuntimeHostLimits } from '@/types/agent-runtime'

export interface PortablePresetImportInput {
  preset: CreatePresetInput
  agentRuntime: PortableAgenticRuntimeEnvelopeV1
}

export type PortableAgentConfigPresetImportInput = CreatePresetInput & {
  agent_config: PortableAgentConfigV1
}

export interface PortablePresetImportResult {
  preset: Preset
  agent_config?: Preset['agent_config']
  agent_config_review?: Preset['agent_config_review']
}
export interface PresetDuplicateResult {
  preset: Preset
  agent_config?: Preset['agent_config']
  agent_config_review?: Preset['agent_config_review']
  copiedRegexScriptIds: string[]
}


export interface StashedPromptBlock {
  id: string
  block: Omit<PromptBlock, 'id' | 'enabled' | 'group' | 'stashId'>
  sourcePreset?: { id: string; name: string }
  createdAt: number
  updatedAt: number
}

export const presetsApi = {
  list(params?: { limit?: number; offset?: number; provider?: string }) {
    return get<PaginatedResult<Preset>>('/presets', params)
  },
  getAgentRuntimeLimits() {
    return get<AgentRuntimeHostLimits>('/presets/agent-runtime-limits')
  },

  listRegistry(params?: { limit?: number; offset?: number; provider?: string; engine?: string }) {
    return get<PaginatedResult<PresetRegistryItem>>('/presets/registry', params)
  },

  get(id: string) {
    return get<Preset>(`/presets/${id}`)
  },
  getPortableAgentRuntime(id: string) {
    return get<PortableAgenticRuntimeEnvelopeV1>(`/presets/${id}/agent-runtime/portable`)
  },

  importPortable(input: PortablePresetImportInput) {
    return post<PortablePresetImportResult>('/presets/import-portable', input)
  },
  importPortableAgentConfig(input: PortableAgentConfigPresetImportInput) {
    return post<PortablePresetImportResult>('/presets/agent-config/portable/import', input)
  },


  create(input: CreatePresetInput) {
    return post<Preset>('/presets', input)
  },
  duplicate(id: string, name?: string) {
    return post<PresetDuplicateResult>(`/presets/${id}/duplicate`, name === undefined ? {} : { name })
  },


  update(id: string, input: UpdatePresetInput) {
    return put<Preset>(`/presets/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/presets/${id}`)
  },

  listStash() {
    return get<StashedPromptBlock[]>('/presets/stash')
  },

  addToStash(block: PromptBlock, sourcePresetId?: string) {
    return post<StashedPromptBlock>('/presets/stash', { block, sourcePresetId })
  },

  removeFromStash(id: string) {
    return del<void>(`/presets/stash/${id}`)
  },
}
