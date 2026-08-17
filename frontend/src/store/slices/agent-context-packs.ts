import type { StateCreator } from 'zustand'
import type { AgentContextPacksSlice } from '@/types/store'
import type { AgentContextPack, ContextPackDetail } from '@/types/agent-context-packs'
import { agentContextPacksApi, classifyContextPackError } from '@/api/agent-context-packs'

const CONTEXT_PACK_LIST_PAGE_SIZE = 100
const CONTEXT_PACK_MAX_LIST_PAGES = 1_000

interface ActionContext {
  readonly action: string
  readonly actionEpoch: number
  readonly selectedId: string | null
  readonly selectionEpoch: number
}

interface TrackedPack {
  readonly epoch: number
  readonly pack: AgentContextPack | null
}

function actionIsCurrent(
  context: ActionContext,
  selectedId: string | null,
  selectionEpoch: number,
  actionEpoch: number,
): boolean {
  return context.actionEpoch === actionEpoch
    && context.selectionEpoch === selectionEpoch
    && context.selectedId === selectedId
}

function mergePacks(
  current: readonly AgentContextPack[],
  incoming: readonly AgentContextPack[],
  mutationEpochAtStart: number,
  tracked: ReadonlyMap<string, TrackedPack>,
  preserveUnlisted = false,
): AgentContextPack[] {
  const incomingById = new Map(incoming.map((pack) => [pack.id, pack]))
  const merged: AgentContextPack[] = []
  const present = new Set<string>()
  for (const pack of incoming) {
    const latest = tracked.get(pack.id)
    if (latest && latest.epoch > mutationEpochAtStart) {
      if (latest.pack) {
        merged.push(latest.pack)
        present.add(pack.id)
      }
      continue
    }
    merged.push(pack)
    present.add(pack.id)
  }
  for (const pack of current) {
    if (present.has(pack.id)) continue
    const latest = tracked.get(pack.id)
    if (latest && latest.epoch > mutationEpochAtStart) {
      if (latest.pack) merged.push(latest.pack)
      continue
    }
    if (!incomingById.has(pack.id)) {
      if (preserveUnlisted) merged.push(pack)
      continue
    }
    merged.push(pack)
  }
  return merged
}

export const createAgentContextPacksSlice: StateCreator<AgentContextPacksSlice> = (set, get) => {
  let listRequestEpoch = 0
  let detailRequestEpoch = 0
  let selectionEpoch = 0
  let actionEpoch = 0
  let mutationEpoch = 0
  const trackedPacks = new Map<string, TrackedPack>()

  const recordPack = (pack: AgentContextPack) => {
    mutationEpoch += 1
    trackedPacks.set(pack.id, { epoch: mutationEpoch, pack })
  }
  const recordDeletedPack = (packId: string) => {
    mutationEpoch += 1
    trackedPacks.set(packId, { epoch: mutationEpoch, pack: null })
  }
  const beginAction = (action: string): ActionContext => {
    const context = {
      action,
      actionEpoch: ++actionEpoch,
      selectedId: get().selectedContextPackId,
      selectionEpoch,
    }
    set({ contextPackBusyAction: action, contextPackError: null })
    return context
  }
  const actionIsStillCurrent = (context: ActionContext) => actionIsCurrent(
    context,
    get().selectedContextPackId,
    selectionEpoch,
    actionEpoch,
  )
  const applyDetail = (detail: ContextPackDetail, context: ActionContext) => {
    if (!actionIsStillCurrent(context)) return null
    recordPack(detail.pack)
    set((state) => ({
      contextPacks: mergePacks(state.contextPacks, [detail.pack], -1, trackedPacks, true),
      selectedContextPackId: detail.pack.id,
      selectedContextPack: detail,
      contextPackDetailLoading: false,
      contextPackAclRevision: Math.max(state.contextPackAclRevision, detail.contextAclRevision),
      contextPackBusyAction: null,
      contextPackError: null,
    }))
    return detail
  }
  const failAction = (error: unknown, context: ActionContext) => {
    if (!actionIsStillCurrent(context)) return null
    set({ contextPackBusyAction: null, contextPackError: classifyContextPackError(error) })
    return null
  }
  const loadContextPacksInternal = async (origin?: ActionContext): Promise<boolean> => {
    const requestEpoch = ++listRequestEpoch
    ++detailRequestEpoch
    const mutationEpochAtStart = mutationEpoch
    if (!origin || actionIsStillCurrent(origin)) {
      set({
        contextPacksLoading: true,
        contextPackDetailLoading: false,
        ...(origin ? {} : { contextPackError: null }),
      })
    }
    try {
      const pages: AgentContextPack[] = []
      const seenIds = new Set<string>()
      let offset = 0
      for (let page = 0; page < CONTEXT_PACK_MAX_LIST_PAGES; page += 1) {
        const result = await agentContextPacksApi.list({
          limit: CONTEXT_PACK_LIST_PAGE_SIZE,
          offset,
        })
        if (
          requestEpoch !== listRequestEpoch
          || (origin !== undefined && !actionIsStillCurrent(origin))
        ) return false
        if (
          !result
          || !Array.isArray(result.data)
          || !Number.isSafeInteger(result.contextAclRevision)
          || result.contextAclRevision < 0
          || result.data.length > CONTEXT_PACK_LIST_PAGE_SIZE
        ) throw new Error('malformed context pack list page')
        for (const pack of result.data) {
          if (!pack || typeof pack.id !== 'string' || pack.id.length === 0 || seenIds.has(pack.id)) {
            throw new Error('context pack list page did not make unique progress')
          }
          seenIds.add(pack.id)
        }
        pages.push(...result.data)
        if (result.data.length < CONTEXT_PACK_LIST_PAGE_SIZE) {
          const merged = mergePacks(get().contextPacks, pages, mutationEpochAtStart, trackedPacks)
          set((state) => ({
            contextPacks: merged,
            contextPackAclRevision: Math.max(state.contextPackAclRevision, result.contextAclRevision),
            contextPacksLoading: false,
            contextPackDetailLoading: false,
            ...(origin ? {} : { contextPackError: null }),
          }))
          return true
        }
        const nextOffset = offset + result.data.length
        if (nextOffset <= offset) throw new Error('context pack list pagination made no progress')
        offset = nextOffset
      }
      throw new Error('context pack list exceeds the bounded page limit')
    } catch (error) {
      if (
        requestEpoch !== listRequestEpoch
        || (origin !== undefined && !actionIsStillCurrent(origin))
      ) return false
      set({
        contextPacksLoading: false,
        contextPackDetailLoading: false,
        ...(origin ? { contextPackBusyAction: null } : {}),
        contextPackError: classifyContextPackError(error),
      })
      return false
    }
  }
  const refreshAfterRevisionConflict = async (packId: string, context: ActionContext) => {
    if (!actionIsStillCurrent(context)) return false
    if (!await loadContextPacksInternal(context) || !actionIsStillCurrent(context)) return false
    const selectedId = packId || context.selectedId
    if (selectedId && get().selectedContextPackId === selectedId) {
      const detailEpoch = ++detailRequestEpoch
      try {
        const detail = await agentContextPacksApi.get(selectedId)
        if (
          detailEpoch !== detailRequestEpoch
          || !actionIsStillCurrent(context)
          || get().selectedContextPackId !== selectedId
        ) return false
        recordPack(detail.pack)
        set((state) => ({
          selectedContextPack: detail,
          contextPackDetailLoading: false,
          contextPackAclRevision: Math.max(state.contextPackAclRevision, detail.contextAclRevision),
        }))
      } catch {
        if (!actionIsStillCurrent(context)) return false
      }
    }
    if (!actionIsStillCurrent(context)) return false
    set({ contextPackBusyAction: null, contextPackError: 'revision_conflict' })
    return true
  }
  const handleRevisionConflict = async (error: unknown, packId: string | undefined, context: ActionContext) => {
    if (classifyContextPackError(error) !== 'revision_conflict') return false
    await refreshAfterRevisionConflict(packId ?? '', context)
    return true
  }

  return {
    contextPacks: [],
    selectedContextPackId: null,
    selectedContextPack: null,
    contextPackAclRevision: 0,
    contextPacksLoading: false,
    contextPackDetailLoading: false,
    contextPackBusyAction: null,
    contextPackError: null,

    loadContextPacks: async () => {
      await loadContextPacksInternal()
    },

    selectContextPack: async (packId) => {
      const requestEpoch = ++detailRequestEpoch
      const currentSelectionEpoch = ++selectionEpoch
      if (!packId) {
        set({
          selectedContextPackId: null,
          selectedContextPack: null,
          contextPackDetailLoading: false,
          contextPackBusyAction: null,
          contextPackError: null,
        })
        return
      }
      set({
        selectedContextPackId: packId,
        selectedContextPack: null,
        contextPackDetailLoading: true,
        contextPackBusyAction: null,
        contextPackError: null,
      })
      try {
        const detail = await agentContextPacksApi.get(packId)
        if (
          requestEpoch !== detailRequestEpoch
          || currentSelectionEpoch !== selectionEpoch
          || get().selectedContextPackId !== packId
        ) return
        recordPack(detail.pack)
        set((state) => ({
          contextPacks: mergePacks(state.contextPacks, [detail.pack], -1, trackedPacks, true),
          selectedContextPack: detail,
          contextPackAclRevision: Math.max(state.contextPackAclRevision, detail.contextAclRevision),
          contextPackDetailLoading: false,
        }))
      } catch (error) {
        if (
          requestEpoch !== detailRequestEpoch
          || currentSelectionEpoch !== selectionEpoch
          || get().selectedContextPackId !== packId
        ) return
        set({
          selectedContextPackId: null,
          selectedContextPack: null,
          contextPackDetailLoading: false,
          contextPackError: classifyContextPackError(error),
        })
      }
    },

    createContextPack: async (input) => {
      const context = beginAction('create')
      try {
        return applyDetail(await agentContextPacksApi.create(input), context)
      } catch (error) {
        if (await handleRevisionConflict(error, undefined, context)) return null
        return failAction(error, context)
      }
    },

    importContextPack: async (snapshot) => {
      const context = beginAction('import')
      try {
        return applyDetail(await agentContextPacksApi.importPortable(snapshot), context)
      } catch (error) {
        if (await handleRevisionConflict(error, undefined, context)) return null
        return failAction(error, context)
      }
    },

    updateContextPack: async (packId, input) => {
      const context = beginAction('update')
      try {
        return applyDetail(await agentContextPacksApi.update(packId, input), context)
      } catch (error) {
        if (await handleRevisionConflict(error, packId, context)) return null
        return failAction(error, context)
      }
    },

    deleteContextPack: async (packId, expectedRevision) => {
      const context = beginAction('delete')
      try {
        await agentContextPacksApi.remove(packId, expectedRevision)
        const stillCurrent = actionIsStillCurrent(context)
        recordDeletedPack(packId)
        if (!stillCurrent) return true
        set((state) => ({
          contextPacks: state.contextPacks.filter((pack) => pack.id !== packId),
          ...(state.selectedContextPackId === packId ? {
            selectedContextPackId: null,
            selectedContextPack: null,
            contextPackDetailLoading: false,
          } : {}),
          contextPackBusyAction: null,
          contextPackError: null,
        }))
        return true
      } catch (error) {
        if (await handleRevisionConflict(error, packId, context)) return false
        failAction(error, context)
        return false
      }
    },

    createContextPackRevision: async (packId, input) => {
      const context = beginAction('revision')
      try {
        return applyDetail(await agentContextPacksApi.createRevision(packId, input), context)
      } catch (error) {
        if (await handleRevisionConflict(error, packId, context)) return null
        return failAction(error, context)
      }
    },

    attachContextPack: async (packId, input) => {
      const context = beginAction('attach')
      try {
        return applyDetail(await agentContextPacksApi.attach(packId, input), context)
      } catch (error) {
        if (await handleRevisionConflict(error, packId, context)) return null
        return failAction(error, context)
      }
    },

    detachContextPack: async (packId, attachment, expectedContextAclRevision) => {
      const context = beginAction('detach')
      try {
        return applyDetail(await agentContextPacksApi.detach(packId, attachment, expectedContextAclRevision), context)
      } catch (error) {
        if (await handleRevisionConflict(error, packId, context)) return null
        return failAction(error, context)
      }
    },

    replaceContextPackAcl: async (packId, input) => {
      const context = beginAction('acl')
      try {
        return applyDetail(await agentContextPacksApi.replaceAcl(packId, input), context)
      } catch (error) {
        if (await handleRevisionConflict(error, packId, context)) return null
        return failAction(error, context)
      }
    },

    reviewContextPack: async (packId, input) => {
      const context = beginAction('review')
      try {
        return applyDetail(await agentContextPacksApi.review(packId, input), context)
      } catch (error) {
        if (await handleRevisionConflict(error, packId, context)) return null
        return failAction(error, context)
      }
    },

    duplicateContextPack: async (packId, input) => {
      const context = beginAction('duplicate')
      try {
        return applyDetail(await agentContextPacksApi.duplicate(packId, input), context)
      } catch (error) {
        if (await handleRevisionConflict(error, packId, context)) return null
        return failAction(error, context)
      }
    },

    clearContextPackError: () => set({ contextPackError: null }),
  }
}
