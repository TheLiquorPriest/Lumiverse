import { del, get, patch, post } from './client'
import {
  normalizeAgentRunInspectionDetailV1,
  normalizeAgentRunInspectionListV1,
  normalizeAgentRunInspectionRetryResponseV1,
} from '@/store/slices/agent-runs'
import type {
  AgentPersistentWorkspaceArtifactV1,
  AgentPersistentWorkspaceCreateInputV1,
  AgentPersistentWorkspaceDeletionResultV1,
  AgentPersistentWorkspaceEditInputV1,
  AgentPersistentWorkspacePublicationInputV1,
  AgentPersistentWorkspacePublicationV1,
  AgentPersistentWorkspaceRecordV1,
  AgentPersistentWorkspaceTaskInputV1,
  AgentPersistentWorkspaceTaskV1,
  AgentPersistentWorkspaceSubmissionV1,
  AgentPersistentWorkspaceTurnSessionV1,
  AgentPersistentWorkspaceV1,
  AgentRunChangesV2,
  AgentRunInspectionDetailV1,
  AgentRunInspectionListV1,
  AgentRunInspectionRetryResponseV1,
  AgentRunPublicV2,
  AgentRunStopResultV2,
  AgentWorkspaceIndexPublicV2,
  AgentWorkspaceSectionPreviewV2,
  AgentWorkspaceSectionV2,
} from '@/types/agent-runs'

function requireInspectionDetail(payload: unknown): AgentRunInspectionDetailV1 {
  const detail = normalizeAgentRunInspectionDetailV1(payload)
  if (!detail) throw new Error('Invalid owner inspection response')
  return detail
}

function requireInspectionList(payload: unknown): AgentRunInspectionListV1 {
  const list = normalizeAgentRunInspectionListV1(payload)
  if (!list) throw new Error('Invalid owner inspection list response')
  return list
}

function requireInspectionRetry(payload: unknown): AgentRunInspectionRetryResponseV1 {
  const response = normalizeAgentRunInspectionRetryResponseV1(payload)
  if (!response) throw new Error('Invalid owner inspection retry response')
  return response
}
const base = '/agent-runs'

export const agentRunsApi = {
  changes(chatId: string, cursor?: string | null) {
    return get<AgentRunChangesV2>(`${base}/changes/${chatId}`, cursor ? { cursor } : undefined)
  },

  status(turnId: string) {
    return get<AgentRunPublicV2>(`${base}/status/${turnId}`)
  },
  async listInspection(chatId: string, params?: { limit?: number; cursor?: string | null }) {
    const payload = await get<unknown>(`${base}/inspection`, { chatId, ...params })
    return requireInspectionList(payload)
  },

  async inspection(attemptId: string, chatId?: string) {
    const payload = await get<unknown>(
      `${base}/${encodeURIComponent(attemptId)}/inspection`,
      chatId ? { chatId } : undefined,
    )
    return requireInspectionDetail(payload)
  },

  async retry(attemptId: string) {
    const payload = await post<unknown>(`${base}/${encodeURIComponent(attemptId)}/retry`, {})
    return requireInspectionRetry(payload)
  },

  workspace(turnId: string) {
    return get<AgentWorkspaceIndexPublicV2>(`${base}/${turnId}/workspace`)
  },
  persistentWorkspace(chatId: string) {
    return get<AgentPersistentWorkspaceV1>(`${base}/workspace`, { chatId })
  },

  createPersistentWorkspace(
    chatId: string,
    input: Omit<AgentPersistentWorkspaceCreateInputV1, 'chatId'>,
  ) {
    return post<AgentPersistentWorkspaceV1>(`${base}/workspace?chatId=${encodeURIComponent(chatId)}`, input)
  },

  persistentWorkspaceById(workspaceId: string, chatId?: string | null) {
    return get<AgentPersistentWorkspaceV1>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}`,
      chatId ? { chatId } : undefined,
    )
  },

  editPersistentWorkspace(workspaceId: string, input: AgentPersistentWorkspaceEditInputV1) {
    return patch<AgentPersistentWorkspaceV1>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}`,
      input,
    )
  },

  deletePersistentWorkspace(workspaceId: string, expectedRevision: number) {
    return del<AgentPersistentWorkspaceDeletionResultV1>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}?expectedRevision=${expectedRevision}`,
    )
  },

  persistentWorkspaceSessions(workspaceId: string) {
    return get<AgentPersistentWorkspaceTurnSessionV1[]>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/sessions`,
    )
  },
  persistentWorkspaceSubmissions(workspaceId: string) {
    return get<AgentPersistentWorkspaceSubmissionV1[]>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/submissions`,
    )
  },

  persistentWorkspaceTasks(workspaceId: string) {
    return get<AgentPersistentWorkspaceTaskV1[]>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/tasks`,
    )
  },

  createPersistentWorkspaceTask(workspaceId: string, input: AgentPersistentWorkspaceTaskInputV1) {
    return post<AgentPersistentWorkspaceTaskV1>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/tasks`,
      input,
    )
  },

  persistentWorkspaceRecords(workspaceId: string) {
    return get<AgentPersistentWorkspaceRecordV1[]>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/records`,
    )
  },

  persistentWorkspaceArtifacts(workspaceId: string) {
    return get<AgentPersistentWorkspaceArtifactV1[]>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/artifacts`,
    )
  },


  persistentWorkspacePublications(workspaceId: string) {
    return get<AgentPersistentWorkspacePublicationV1[]>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/publications`,
    )
  },

  publishPersistentWorkspace(workspaceId: string, input: AgentPersistentWorkspacePublicationInputV1) {
    return post<AgentPersistentWorkspacePublicationV1>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/publications`,
      input,
    )
  },

  deletePersistentWorkspacePublication(
    workspaceId: string,
    publicationId: string,
    expectedRevision: number,
  ) {
    return del<AgentPersistentWorkspaceDeletionResultV1>(
      `${base}/workspace/${encodeURIComponent(workspaceId)}/publications/${encodeURIComponent(publicationId)}?expectedRevision=${expectedRevision}`,
    )
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
