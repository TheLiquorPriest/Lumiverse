import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { ApiError } from '@/api/client'
import type { AgentContextPacksSlice } from '@/types/store'
import type {
  AgentContextPack,
  ContextPackAttachment,
  ContextPackDetail,
} from '@/types/agent-context-packs'
type ContextPackTestStore = UseBoundStore<StoreApi<AgentContextPacksSlice>>

let listImpl: (params?: { limit?: number; offset?: number }) => Promise<{ data: AgentContextPack[]; contextAclRevision: number }>
let getImpl: (packId: string) => Promise<ContextPackDetail>
let mutationImpl: (operation: string, args: unknown[]) => Promise<ContextPackDetail | void>
mock.module('@/api/agent-context-packs', () => ({
  agentContextPacksApi: {
    list: (params?: { limit?: number; offset?: number }) => listImpl(params),
    get: (packId: string) => getImpl(packId),
    create: (...args: unknown[]) => mutationImpl('create', args),
    importPortable: (...args: unknown[]) => mutationImpl('import', args),
    update: (...args: unknown[]) => mutationImpl('update', args),
    remove: (...args: unknown[]) => mutationImpl('remove', args),
    createRevision: (...args: unknown[]) => mutationImpl('revision', args),
    attach: (...args: unknown[]) => mutationImpl('attach', args),
    detach: (...args: unknown[]) => mutationImpl('detach', args),
    replaceAcl: (...args: unknown[]) => mutationImpl('acl', args),
    review: (...args: unknown[]) => mutationImpl('review', args),
    duplicate: (...args: unknown[]) => mutationImpl('duplicate', args),
  },
  classifyContextPackError: (error: unknown) => error instanceof ApiError && error.status === 409
    ? 'revision_conflict'
    : error instanceof ApiError && (error.status === 400 || error.status === 422)
      ? 'validation_failed'
      : 'unavailable',
}))

// Import after the API mock so this test exercises the slice against deferred responses.
const { createAgentContextPacksSlice } = await import('./agent-context-packs')
const pack: AgentContextPack = {
  id: 'pack-1',
  name: 'Canon',
  description: 'Facts',
  visibility: 'private',
  state: 'active',
  latestRevision: 1,
  contextAclRevision: 1,
  provenance: { kind: 'local' },
  createdAt: 1,
  updatedAt: 1,
}
const packB: AgentContextPack = {
  ...pack,
  id: 'pack-2',
  name: 'Second',
}

const attachment: ContextPackAttachment = {
  attachmentId: 'attachment-1',
  scope: 'preset',
  targetId: 'preset-1',
  packId: pack.id,
  revision: 1,
  position: 0,
  required: false,
  state: 'active',
  provenance: { kind: 'local' },
  createdAt: 1,
  updatedAt: 1,
}
function detailForPack(packValue: AgentContextPack, contextAclRevision = packValue.contextAclRevision): ContextPackDetail {
  return {
    pack: { ...packValue, contextAclRevision },
    revisions: [{
      packId: packValue.id,
      revision: 1,
      content: [{ id: 'main', title: 'Canon', body: 'Fact', tags: [] }],
      contentDigest: 'a'.repeat(64),
      tokenCount: 1,
      byteCount: 4,
      state: 'active',
      provenance: { kind: 'local' },
      createdAt: 1,
    }],
    acl: [],
    attachments: [{ ...attachment, packId: packValue.id }],
    contextAclRevision,
  }
}

function detail(contextAclRevision: number): ContextPackDetail {
  return detailForPack(pack, contextAclRevision)
}

function createHarness() {
  return create<AgentContextPacksSlice>()((set, get, api) => createAgentContextPacksSlice(set, get, api))
}

beforeEach(() => {
  listImpl = async () => ({ data: [pack], contextAclRevision: 1 })
  getImpl = async () => detail(1)
  mutationImpl = async () => detail(1)
})

describe('agent context pack request sequencing', () => {
  test('ignores a detail response invalidated by a newer list reload', async () => {
    let releaseDetail!: (value: ContextPackDetail) => void
    const pendingDetail = new Promise<ContextPackDetail>((resolve) => { releaseDetail = resolve })
    getImpl = async () => pendingDetail
    listImpl = async () => ({ data: [pack], contextAclRevision: 7 })
    const store = createHarness()

    const detailRequest = store.getState().selectContextPack(pack.id)
    await store.getState().loadContextPacks()
    expect(store.getState().contextPackAclRevision).toBe(7)

    releaseDetail(detail(2))
    await detailRequest

    expect(store.getState().contextPackAclRevision).toBe(7)
    expect(store.getState().selectedContextPack).toBeNull()
    expect(store.getState().contextPackDetailLoading).toBe(false)
  })

  test('loads every bounded backend page instead of requesting an oversized page', async () => {
    const all = Array.from({ length: 205 }, (_, index) => ({
      ...pack,
      id: `pack-${index}`,
      name: `Pack ${index}`,
    }))
    const calls: Array<{ limit?: number; offset?: number }> = []
    listImpl = async (params) => {
      calls.push(params ?? {})
      const offset = params?.offset ?? 0
      const limit = params?.limit ?? 100
      return { data: all.slice(offset, offset + limit), contextAclRevision: 3 }
    }
    const store = createHarness()
    await store.getState().loadContextPacks()
    expect(calls).toEqual([
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
      { limit: 100, offset: 200 },
    ])
    expect(store.getState().contextPacks).toHaveLength(205)
  })

  test('does not let a late A response replace the selected B detail', async () => {
    let releaseA!: (value: ContextPackDetail) => void
    let releaseB!: (value: ContextPackDetail) => void
    const pendingA = new Promise<ContextPackDetail>((resolve) => { releaseA = resolve })
    const pendingB = new Promise<ContextPackDetail>((resolve) => { releaseB = resolve })
    getImpl = async (packId) => packId === pack.id ? pendingA : pendingB
    const store = createHarness()

    const requestA = store.getState().selectContextPack(pack.id)
    const requestB = store.getState().selectContextPack(packB.id)
    releaseB(detailForPack(packB, 9))
    await requestB
    releaseA(detail(8))
    await requestA

    expect(store.getState().selectedContextPackId).toBe(packB.id)
    expect(store.getState().selectedContextPack?.pack.id).toBe(packB.id)
    expect(store.getState().contextPackAclRevision).toBe(9)
  })
  test('does not let a stale conflict refresh overwrite a newer mutation success', async () => {
    let releaseList!: (value: { data: AgentContextPack[]; contextAclRevision: number }) => void
    let refreshStarted!: () => void
    const pendingList = new Promise<{ data: AgentContextPack[]; contextAclRevision: number }>((resolve) => {
      releaseList = resolve
    })
    const refreshReady = new Promise<void>((resolve) => { refreshStarted = resolve })
    let mutationCalls = 0
    mutationImpl = async () => {
      mutationCalls += 1
      if (mutationCalls === 1) {
        throw new ApiError(409, 'Conflict', { code: 'CONTEXT_PACK_REVISION_CONFLICT' })
      }
      return detailForPack({ ...pack, name: 'Newer success' }, 6)
    }
    listImpl = async () => {
      refreshStarted()
      return pendingList
    }
    getImpl = async () => detail(5)
    const store = createHarness()
    store.setState({ selectedContextPackId: pack.id, selectedContextPack: detail(1) })

    const staleConflict = store.getState().updateContextPack(pack.id, { name: 'Stale', expectedRevision: 1 })
    await refreshReady
    await store.getState().updateContextPack(pack.id, { name: 'Newer', expectedRevision: 1 })
    expect(store.getState().selectedContextPack?.pack.name).toBe('Newer success')

    releaseList({ data: [pack], contextAclRevision: 7 })
    await staleConflict
    expect(store.getState().selectedContextPack?.pack.name).toBe('Newer success')
    expect(store.getState().contextPackError).toBeNull()
  })

  test('fails a repeated context-pack page visibly instead of accepting duplicate progress', async () => {
    listImpl = async () => ({
      data: Array.from({ length: 100 }, () => pack),
      contextAclRevision: 2,
    })
    const store = createHarness()
    await store.getState().loadContextPacks()
    expect(store.getState().contextPacksLoading).toBe(false)
    expect(store.getState().contextPackError).toBe('unavailable')
  })


  test('authoritatively refreshes list and selected detail after every mutation conflict', async () => {
    const operations: Array<{
      name: string
      run: (store: ContextPackTestStore) => Promise<unknown>
    }> = [
      { name: 'create', run: (store) => store.getState().createContextPack({ name: 'New', visibility: 'private', content: [{ id: 'main', title: '', body: 'Fact', tags: [] }] }) },
      { name: 'update', run: (store) => store.getState().updateContextPack(pack.id, { name: 'Renamed', expectedRevision: 1 }) },
      { name: 'remove', run: (store) => store.getState().deleteContextPack(pack.id, 1) },
      { name: 'revision', run: (store) => store.getState().createContextPackRevision(pack.id, { expectedRevision: 1, content: [{ id: 'main', title: '', body: 'New', tags: [] }] }) },
      { name: 'attach', run: (store) => store.getState().attachContextPack(pack.id, { scope: 'preset', targetId: 'preset-1', revision: 1, required: false, expectedContextAclRevision: 4 }) },
      { name: 'detach', run: (store) => store.getState().detachContextPack(pack.id, attachment, 4) },
      { name: 'acl', run: (store) => store.getState().replaceContextPackAcl(pack.id, { expectedContextAclRevision: 4, entries: [] }) },
      { name: 'review', run: (store) => store.getState().reviewContextPack(pack.id, { state: 'active', acknowledge: true, expectedRevision: 1 }) },
      { name: 'duplicate', run: (store) => store.getState().duplicateContextPack(pack.id, { name: 'Copy', preserveAttachments: false }) },
    ]

    for (const operation of operations) {
      const mutationCalls: string[] = []
      let listCalls = 0
      let detailCalls = 0
      mutationImpl = async (name) => {
        mutationCalls.push(name)
        throw new ApiError(409, 'Conflict', { code: 'CONTEXT_PACK_REVISION_CONFLICT' })
      }
      listImpl = async () => {
        listCalls += 1
        return { data: [pack], contextAclRevision: 5 }
      }
      getImpl = async () => {
        detailCalls += 1
        return detail(5)
      }
      const store = createHarness()
      store.setState({ selectedContextPackId: pack.id, contextPackAclRevision: 4 })

      await operation.run(store)

      expect(mutationCalls).toEqual([operation.name])
      expect(listCalls).toBe(1)
      expect(detailCalls).toBe(1)
      expect(store.getState().contextPackAclRevision).toBe(5)
      expect(store.getState().selectedContextPack?.contextAclRevision).toBe(5)
      expect(store.getState().contextPackError).toBe('revision_conflict')
    }
  })
})
