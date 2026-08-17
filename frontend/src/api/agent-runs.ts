import { get, post } from './client'
import type {
  AgentRunChangesV2,
  AgentRunPublicV2,
  AgentRunStopResultV2,
  AgentWorkspaceIndexPublicV2,
  AgentWorkspaceSectionPreviewV2,
  AgentWorkspaceSectionV2,
} from '@/types/agent-runs'

const base = '/agent-runs'

export const agentRunsApi = {
  changes(chatId: string, cursor?: string | null) {
    return get<AgentRunChangesV2>(`${base}/changes/${chatId}`, cursor ? { cursor } : undefined)
  },

  status(turnId: string) {
    return get<AgentRunPublicV2>(`${base}/status/${turnId}`)
  },

  workspace(turnId: string) {
    return get<AgentWorkspaceIndexPublicV2>(`${base}/${turnId}/workspace`)
  },

  workspaceSection(
    turnId: string,
    section: AgentWorkspaceSectionV2,
    page?: string | null,
    revision?: number,
  ) {
    return get<AgentWorkspaceSectionPreviewV2>(
      `${base}/${turnId}/workspace/${section}`,
      page || revision !== undefined ? { ...(page ? { page } : {}), ...(revision !== undefined ? { revision } : {}) } : undefined,
    )
  },

  stop(turnId: string, input?: { generationId?: string; chatId?: string }) {
    return post<AgentRunStopResultV2>(`${base}/${turnId}/stop`, input ?? {})
  },
}
