import { get, put } from './client'
import type { Preset } from '@/types/api'
import type {
  AgentConfigReview,
  AgentConfigV2,
  AgentContextActivationRule,
  AgentContextPackSelection,
  AgentTaskTemplate,
  AgenticRuntimeHostCeilings,
  AgenticRuntimeSaveDraft,
  PromptBlock,
} from '@/lib/loom/types'

export interface AgenticRuntimeEditorProjection {
  presetId: string
  presetRevision: number
  configRevision: number
  config: AgentConfigV2 | null
  review: AgentConfigReview | null
  slotBindings: Record<string, string | null>
  contextPackSelections: AgentContextPackSelection[]
  contextRules: AgentContextActivationRule[]
  taskTemplates: AgentTaskTemplate[]
  reviewAcknowledgements: string[]
  hostCeilings: AgenticRuntimeHostCeilings
}

export interface SaveAgenticRuntimeEditorResult {
  preset: Preset
  editor: AgenticRuntimeEditorProjection
}

interface AgenticRuntimeSlotBindingWire {
  slotId: string
  connectionId: string | null
}

function normalizeSlotBindings(value: unknown): Record<string, string | null> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
      const row = entry as Record<string, unknown>
      if (typeof row.slotId !== 'string' || row.slotId.length === 0) return []
      if (row.connectionId !== null && typeof row.connectionId !== 'string' && row.connectionId !== undefined) return []
      return [[row.slotId, row.connectionId == null ? null : row.connectionId] as [string, string | null]]
    })) as Record<string, string | null>
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([slotId, connectionId]) => (
    typeof connectionId === 'string' || connectionId === null ? [[slotId, connectionId] as [string, string | null]] : []
  ))) as Record<string, string | null>
}

function serializeSlotBindings(value: Record<string, string | null>): AgenticRuntimeSlotBindingWire[] {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slotId, connectionId]) => ({ slotId, connectionId }))
}

function normalizeEditorProjection(projection: AgenticRuntimeEditorProjection & { slotBindings?: unknown }): AgenticRuntimeEditorProjection {
  return { ...projection, slotBindings: normalizeSlotBindings(projection.slotBindings) }
}

function normalizeEditorResult(result: SaveAgenticRuntimeEditorResult & { editor: AgenticRuntimeEditorProjection & { slotBindings?: unknown } }): SaveAgenticRuntimeEditorResult {
  return { ...result, editor: normalizeEditorProjection(result.editor) }
}

export interface SaveAgenticRuntimeEditorInput extends AgenticRuntimeSaveDraft {
  expectedPresetRevision: number
  expectedConfigRevision: number
  promptOrder: PromptBlock[]
}

export const agenticRuntimeApi = {
  async getEditor(presetId: string) {
    const projection = await get<AgenticRuntimeEditorProjection & { slotBindings?: unknown }>(`/presets/${presetId}/agent-config`)
    return normalizeEditorProjection(projection)
  },

  async saveEditor(presetId: string, input: SaveAgenticRuntimeEditorInput) {
    const { slotBindings, ...rest } = input
    const result = await put<SaveAgenticRuntimeEditorResult & { editor: AgenticRuntimeEditorProjection & { slotBindings?: unknown } }>(
      `/presets/${presetId}/agent-config`,
      { ...rest, slotBindings: serializeSlotBindings(slotBindings) },
    )
    return normalizeEditorResult(result)
  },
}
