import { agentRunsApi } from '@/api/agent-runs'
import { useStore } from '@/store'
import type { AgentWorkspaceSectionV2 } from '@/types/agent-runs'

const runRecoveryInFlight = new Map<string, Promise<void>>()
const workspaceIndexInFlight = new Map<string, Promise<void>>()
const workspaceSectionInFlight = new Map<string, Promise<void>>()
const MAX_RUN_RECOVERY_PAGES = 64

/** Restore one chat from its opaque cursor without replacing a newer chat/request epoch. */
export function recoverAgentRuns(chatId: string): Promise<void> {
  if (!chatId) return Promise.resolve()
  const existing = runRecoveryInFlight.get(chatId)
  if (existing) return existing

  const state = useStore.getState()
  const requestEpoch = state.beginAgentRunRestore(chatId)
  const request = (async () => {
    let cursor = useStore.getState().agentRunCursorByChat[chatId] ?? null
    for (let page = 0; page < MAX_RUN_RECOVERY_PAGES; page += 1) {
      const payload = await agentRunsApi.changes(chatId, cursor)
      const applied = useStore.getState().applyAgentRunChanges(chatId, requestEpoch, payload)
      if (!applied) return
      const current = useStore.getState()
      const incompleteResync = payload.resync
        && payload.resyncPage?.complete === false
      const cursorBehindPublic = (
        (current.agentRunCursorSequenceByChat[chatId] ?? 0)
        < (current.agentRunLastSequenceByChat[chatId] ?? 0)
      )
      if (!payload.hasMore && !incompleteResync && !cursorBehindPublic) return
      const nextCursor = current.agentRunCursorByChat[chatId] ?? cursor
      if (!nextCursor || nextCursor === cursor && !incompleteResync && !payload.hasMore) return
      cursor = nextCursor
    }
  })()
    .catch(() => {
      useStore.getState().failAgentRunRestore(chatId, requestEpoch)
    })
    .finally(() => {
      runRecoveryInFlight.delete(chatId)
    })
  runRecoveryInFlight.set(chatId, request)
  return request
}

/** Fetch the workspace index separately from activity; no workspace bytes enter run events. */
export function loadAgentWorkspace(chatId: string, turnId: string): Promise<void> {
  const key = `${chatId}:${turnId}`
  const existing = workspaceIndexInFlight.get(key)
  if (existing) return existing

  const requestEpoch = useStore.getState().beginAgentWorkspaceRequest(chatId, turnId)
  const request = agentRunsApi.workspace(turnId)
    .then((payload) => {
      useStore.getState().applyAgentWorkspaceIndex(chatId, turnId, requestEpoch, payload)
    })
    .catch(() => {
      useStore.getState().failAgentWorkspaceRequest(chatId, turnId, requestEpoch)
    })
    .finally(() => {
      workspaceIndexInFlight.delete(key)
    })
  workspaceIndexInFlight.set(key, request)
  return request
}

export function loadAgentWorkspaceSection(
  chatId: string,
  turnId: string,
  section: AgentWorkspaceSectionV2,
  append = false,
): Promise<void> {
  const state = useStore.getState()
  const page = append ? state.agentWorkspaceByTurn[turnId]?.sections[section]?.preview.nextPage ?? null : null
  const revision = state.agentWorkspaceByTurn[turnId]?.index?.workspaceRevision
  const key = `${chatId}:${turnId}:${section}:revision:${revision ?? 'none'}${append ? `:page:${page ?? 'none'}` : ':index'}`
  const existing = workspaceSectionInFlight.get(key)
  if (existing) return existing
  if (append && !page) return Promise.resolve()
  const requestEpoch = state.beginAgentWorkspaceRequest(chatId, turnId, section)
  const request = agentRunsApi.workspaceSection(turnId, section, page, revision)
    .then((payload) => {
      useStore.getState().applyAgentWorkspaceSection(
        chatId,
        turnId,
        section,
        requestEpoch,
        payload,
        append,
      )
    })
    .catch(() => {
      useStore.getState().failAgentWorkspaceRequest(chatId, turnId, requestEpoch, section)
    })
    .finally(() => {
      workspaceSectionInFlight.delete(key)
    })
  workspaceSectionInFlight.set(key, request)
  return request
}
