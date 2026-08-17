import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { ApiError } from './client'
import { agentContextPacksApi, classifyContextPackError } from './agent-context-packs'
import { CONTEXT_PACK_TARGET_TYPES } from '@/types/agent-context-packs'
import type { ContextPackAttachment } from '@/types/agent-context-packs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document })

const pack = {
  userId: 'private-owner-id',
  id: 'pack-1',
  name: 'Canon',
  description: 'Stable facts',
  visibility: 'private',
  state: 'active',
  latestRevision: 1,
  contextAclRevision: 4,
  provenance: { kind: 'portable_import', sourceDigest: 'private-source-digest', archiveId: 'private-archive-id' },
  createdAt: 10,
  updatedAt: 10,
}
const revision = {
  userId: 'private-owner-id',
  packId: 'pack-1',
  revision: 1,
  content: [{ id: 'main', title: 'Canon', body: 'Fact', tags: [] }],
  contentDigest: 'a'.repeat(64),
  tokenCount: 2,
  byteCount: 8,
  state: 'active',
  provenance: { kind: 'portable_import', sourcePackId: 'private-source-pack-id' },
  createdAt: 10,
  createdBy: 'private-owner-id',
}
const attachment = {
  userId: 'private-owner-id',
  attachmentId: 'attachment-1',
  scope: 'preset',
  targetId: 'preset-1',
  packId: 'pack-1',
  revision: 1,
  position: 0,
  required: true,
  state: 'active',
  provenance: { kind: 'portable_import', archiveId: 'private-archive-id' },
  createdAt: 10,
  updatedAt: 10,
} satisfies ContextPackAttachment & {
  userId: string
  provenance: ContextPackAttachment['provenance'] & { archiveId: string }
}
const aclEntry = {
  userId: 'private-owner-id',
  packId: 'pack-1',
  principalUserId: 'principal-1',
  permission: 'use',
  createdAt: 10,
  updatedAt: 10,
}


const originalFetch = globalThis.fetch
const requests: Array<{ url: URL; init?: RequestInit }> = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installApiFixture(): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push({ url, init })
    const path = url.pathname.replace('/api/v1', '')
    if (path === '/context-packs/pack-1' && (!init?.method || init.method === 'GET')) {
      return json({ pack, revisions: [revision] })
    }
    if (path === '/context-packs/pack-1/acl' && (!init?.method || init.method === 'GET')) {
      return json({ data: [aclEntry] })
    }
    if (path === '/context-packs/pack-1/attachments' && (!init?.method || init.method === 'GET')) {
      return json({ data: [attachment] })
    }
    if (path === '/context-packs' && (!init?.method || init.method === 'GET')) {
      return json({ data: [pack], contextAclRevision: 4 })
    }
    if (path === '/context-packs' && init?.method === 'POST') {
      return json({ pack, revision }, 201)
    }
    if (path === '/context-packs/pack-1' && init?.method === 'PUT') {
      return json({ pack, contextAclRevision: 4 })
    }
    if (path === '/context-packs/pack-1/revisions' && init?.method === 'POST') {
      return json(revision, 201)
    }
    if (path === '/context-packs/pack-1/attachments' && init?.method === 'POST') {
      return json({ attachment, contextAclRevision: 5 }, 201)
    }
    if (path === '/context-packs/pack-1/attachments/attachment-1' && init?.method === 'DELETE') {
      return json({ success: true, contextAclRevision: 5 })
    }
    if (path === '/context-packs/pack-1/acl' && init?.method === 'PUT') {
      return json({ data: [], contextAclRevision: 5 })
    }
    if (path === '/context-packs/pack-1/review' && init?.method === 'POST') {
      return json({ pack, contextAclRevision: 5 })
    }
    if (path === '/context-packs/pack-1/duplicate' && init?.method === 'POST') {
      return json({ pack, revisions: [revision], attachments: [] }, 201)
    }
    if (path === '/context-packs/pack-1/export') {
      return json({
        portableVersion: 1,
        snapshotId: 'snapshot',
        name: 'Canon',
        description: 'Stable facts',
        revision: 1,
        content: revision.content,
        contentDigest: revision.contentDigest,
        tokenCount: 2,
        byteCount: 8,
      })
    }
    if (path === '/context-packs/pack-1' && init?.method === 'DELETE') return new Response(null, { status: 204 })
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`)
  }) as unknown as typeof fetch
}

beforeEach(() => {
  requests.length = 0
  installApiFixture()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('agent context pack API', () => {
  test('lists inactive review items and hydrates detail without target-scoped authority guesses', async () => {
    const list = await agentContextPacksApi.list({ limit: 20 })
    const detail = await agentContextPacksApi.get('pack-1')

    expect(list.contextAclRevision).toBe(4)
    expect(detail.pack.id).toBe('pack-1')
    expect(detail.revisions[0]?.content[0]?.body).toBe('Fact')
    expect(detail.attachments[0]?.attachmentId).toBe('attachment-1')
    expect(detail.pack).not.toHaveProperty('userId')
    expect(detail.revisions[0]).not.toHaveProperty('createdBy')
    expect(detail.attachments[0]).not.toHaveProperty('userId')
    expect(detail.acl[0]).not.toHaveProperty('userId')
    expect(detail.acl[0]).not.toHaveProperty('packId')
    expect(detail.pack.provenance).toEqual({ kind: 'portable_import' })
    expect(list.data[0]?.provenance).toEqual({ kind: 'portable_import' })
    expect(detail.revisions[0]?.provenance).toEqual({ kind: 'portable_import' })
    expect(detail.attachments[0]?.provenance).toEqual({ kind: 'portable_import' })
    const listRequest = requests.find((request) => request.url.pathname.endsWith('/context-packs'))
    expect(listRequest?.url.searchParams.get('include_disabled')).toBe('true')
    expect(listRequest?.url.searchParams.get('include_review')).toBe('true')
    expect(requests.some((request) => request.url.pathname.endsWith('/pack-1/attachments') && !request.url.searchParams.has('target_id'))).toBe(true)
  })
  test('rejects malformed portable snapshots before sending an import request', async () => {
    await expect(agentContextPacksApi.importPortable({ portableVersion: 1 })).rejects.toMatchObject({
      code: 'CONTEXT_PACK_INVALID',
    })
    expect(requests.some((request) => request.url.pathname.endsWith('/context-packs/import'))).toBe(false)
  })

  test('creates an immutable first revision and sends optimistic revision preconditions', async () => {
    await agentContextPacksApi.create({
      name: 'Canon',
      visibility: 'private',
      content: revision.content,
    })
    await agentContextPacksApi.update('pack-1', {
      name: 'Canon renamed',
      expectedRevision: 1,
    })
    await agentContextPacksApi.createRevision('pack-1', {
      expectedRevision: 1,
      content: [{ id: 'main', title: 'Canon', body: 'New fact', tags: [] }],
    })

    const createRequest = requests.find((request) => request.url.pathname.endsWith('/context-packs') && request.init?.method === 'POST')
    const revisionRequest = requests.find((request) => request.url.pathname.endsWith('/pack-1/revisions') && request.init?.method === 'POST')
    expect(JSON.parse(String(createRequest?.init?.body)).content).toEqual(revision.content)
    expect(JSON.parse(String(revisionRequest?.init?.body)).expectedRevision).toBe(1)
    const updateRequest = requests.find((request) => request.url.pathname.endsWith('/pack-1') && request.init?.method === 'PUT')
    expect(JSON.parse(String(updateRequest?.init?.body))).toMatchObject({
      name: 'Canon renamed',
      expectedRevision: 1,
    })
    expect(requests.some((request) => request.init?.method === 'PUT' && request.url.pathname.includes('/revisions/'))).toBe(false)
  })

  test('supports each owned attachment scope and never exposes a project scope', async () => {
    expect(CONTEXT_PACK_TARGET_TYPES).toEqual(['preset', 'chat', 'world_book'])
    expect(CONTEXT_PACK_TARGET_TYPES).not.toContain('project' as never)

    for (const scope of CONTEXT_PACK_TARGET_TYPES) {
      await agentContextPacksApi.attach('pack-1', {
        scope,
        targetId: `${scope}-1`,
        revision: 1,
        required: scope === 'preset',
        expectedContextAclRevision: 4,
      })
    }
    const bodies = requests
      .filter((request) => request.url.pathname.endsWith('/pack-1/attachments') && request.init?.method === 'POST')
      .map((request) => JSON.parse(String(request.init?.body)))
    expect(bodies.map((body) => body.scope)).toEqual(['preset', 'chat', 'world_book'])
    expect(bodies.map((body) => body.expectedContextAclRevision)).toEqual([4, 4, 4])
  })

  test('sends the observed context ACL revision for attachment detach', async () => {
    await agentContextPacksApi.detach('pack-1', attachment, 4)

    const request = requests.find(
      (item) => item.url.pathname.endsWith('/pack-1/attachments/attachment-1') && item.init?.method === 'DELETE',
    )
    expect(request?.url.searchParams.get('scope')).toBe('preset')
    expect(request?.url.searchParams.get('expected_revision')).toBe('4')
  })

  test('carries ACL revisions, explicit review, portable export, duplicate, and delete contracts', async () => {
    await agentContextPacksApi.replaceAcl('pack-1', {
      expectedContextAclRevision: 4,
      entries: [{ principalUserId: 'user-2', permission: 'use' }],
    })
    await agentContextPacksApi.review('pack-1', {
      state: 'active',
      acknowledge: true,
      expectedRevision: 1,
    })
    await agentContextPacksApi.exportPortable('pack-1', 1)
    await agentContextPacksApi.duplicate('pack-1', { name: 'Canon copy', preserveAttachments: true })
    await agentContextPacksApi.remove('pack-1', 1)

    const bodyFor = (suffix: string, method: string) => JSON.parse(String(
      requests.find((request) => request.url.pathname.endsWith(suffix) && request.init?.method === method)?.init?.body,
    ))
    expect(bodyFor('/pack-1/acl', 'PUT').expectedContextAclRevision).toBe(4)
    expect(bodyFor('/pack-1/review', 'POST')).toMatchObject({ acknowledge: true, state: 'active' })
    expect(bodyFor('/pack-1/duplicate', 'POST').preserveAttachments).toBe(true)
    expect(requests.find((request) => request.url.pathname.endsWith('/pack-1/export'))?.url.searchParams.get('revision')).toBe('1')
    expect(requests.find((request) => request.init?.method === 'DELETE')?.url.searchParams.get('expected_revision')).toBe('1')
  })

  test('collapses unauthorized and foreign ownership failures into the non-disclosing not-found state', () => {
    expect(classifyContextPackError(new ApiError(403, 'Forbidden', { error: 'owner mismatch' }))).toBe('not_found')
    expect(classifyContextPackError(new ApiError(404, 'Not Found', { error: 'Not found' }))).toBe('not_found')
    expect(classifyContextPackError(new ApiError(409, 'Conflict', { code: 'CONTEXT_PACK_REVISION_CONFLICT' }))).toBe('revision_conflict')
    expect(classifyContextPackError(new ApiError(400, 'Bad Request', { code: 'CONTEXT_PACK_INVALID' }))).toBe('validation_failed')
  })
})
