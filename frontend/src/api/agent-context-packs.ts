import { ApiError, del, get, post, put } from './client'
import type {
  AgentContextPack,
  AgentContextPackRevision,
  AttachContextPackInput,
  ContextPackAclEntry,
  ContextPackAttachment,
  ContextPackDetail,
  ContextPackListResult,
  ContextPackUiErrorCode,
  CreateContextPackInput,
  CreateContextPackRevisionInput,
  DuplicateContextPackInput,
  PortableContextPackSnapshotV1,
  ReplaceContextPackAclInput,
  ReviewContextPackInput,
  UpdateContextPackInput,
  SelectableContextPackRevision,
} from '@/types/agent-context-packs'
import {
  ContextPackValidationError,
  parsePortableContextPackSnapshotV1,
} from '@/types/agent-context-packs'

const ROOT = '/context-packs'
const packPath = (packId: string) => `${ROOT}/${encodeURIComponent(packId)}`
function assertExpectedContextAclRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ContextPackValidationError('expectedContextAclRevision', 'must be a non-negative integer')
  }
}

export function classifyContextPackError(error: unknown): ContextPackUiErrorCode {
  if (error instanceof ContextPackValidationError) return 'validation_failed'
  if (!(error instanceof ApiError)) {
    return (error as { readonly code?: unknown } | null)?.code === 'CONTEXT_PACK_INVALID'
      ? 'validation_failed'
      : 'unavailable'
  }
  if (
    error.body?.code === 'CONTEXT_PACK_REVISION_CONFLICT'
    || error.body?.code === 'CONTEXT_PACK_ACL_REVISION_CONFLICT'
  ) return 'revision_conflict'
  if (error.status === 403 || error.status === 404) return 'not_found'
  if (error.status === 400 || error.status === 422 || error.body?.code === 'CONTEXT_PACK_INVALID') return 'validation_failed'
  return 'unavailable'
}

function toPublicPack(pack: AgentContextPack): AgentContextPack {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    visibility: pack.visibility,
    state: pack.state,
    latestRevision: pack.latestRevision,
    contextAclRevision: pack.contextAclRevision,
    provenance: { kind: pack.provenance.kind },
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt,
  }
}

function toPublicAclEntry(entry: ContextPackAclEntry): ContextPackAclEntry {
  return {
    principalUserId: entry.principalUserId,
    permission: entry.permission,
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
    ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
  }
}

function toPublicRevision(revision: AgentContextPackRevision): AgentContextPackRevision {
  return {
    packId: revision.packId,
    revision: revision.revision,
    content: revision.content.map((entry) => ({ ...entry, tags: [...entry.tags] })),
    contentDigest: revision.contentDigest,
    tokenCount: revision.tokenCount,
    byteCount: revision.byteCount,
    state: revision.state,
    provenance: { kind: revision.provenance.kind },
    createdAt: revision.createdAt,
  }
}

function toPublicAttachment(attachment: ContextPackAttachment): ContextPackAttachment {
  return {
    attachmentId: attachment.attachmentId,
    scope: attachment.scope,
    targetId: attachment.targetId,
    packId: attachment.packId,
    revision: attachment.revision,
    position: attachment.position,
    required: attachment.required,
    state: attachment.state,
    provenance: { kind: attachment.provenance.kind },
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
  }
}

async function getContextPackDetail(packId: string): Promise<ContextPackDetail> {
  const path = packPath(packId)
  const [detail, acl, attachments] = await Promise.all([
    get<{ pack: AgentContextPack; revisions: AgentContextPackRevision[] }>(path, { include_inactive: true }),
    get<{ data: ContextPackAclEntry[] }>(`${path}/acl`),
    get<{ data: ContextPackAttachment[] }>(`${path}/attachments`, { include_inactive: true }),
  ])
  const pack = toPublicPack(detail.pack)
  return {
    pack,
    revisions: detail.revisions.map(toPublicRevision),
    acl: acl.data.map(toPublicAclEntry),
    attachments: attachments.data.map(toPublicAttachment),
    contextAclRevision: pack.contextAclRevision,
  }
}

export const agentContextPacksApi = {
  async list(params?: { limit?: number; offset?: number }) {
    const result = await get<ContextPackListResult>(ROOT, {
      ...params,
      include_disabled: true,
      include_review: true,
    })
    return { ...result, data: result.data.map(toPublicPack) }
  },

  async listSelectable(params?: { limit?: number }) {
    return get<{ data: SelectableContextPackRevision[] }>(`${ROOT}/selectable`, params)
  },

  get(packId: string) {
    return getContextPackDetail(packId)
  },

  async getRevision(packId: string, revision: number) {
    const result = await get<AgentContextPackRevision>(
      `${packPath(packId)}/revisions/${revision}`,
      { include_inactive: true },
    )
    return toPublicRevision(result)
  },

  async importPortable(snapshot: unknown) {
    const parsed = parsePortableContextPackSnapshotV1(snapshot)
    const imported = await post<{ pack: AgentContextPack }>(`${ROOT}/import`, parsed)
    return getContextPackDetail(imported.pack.id)
  },
  async create(input: CreateContextPackInput) {
    const created = await post<{ pack: AgentContextPack; revision: AgentContextPackRevision }>(ROOT, input)
    return getContextPackDetail(created.pack.id)
  },

  async createRevision(packId: string, input: CreateContextPackRevisionInput) {
    await post<AgentContextPackRevision>(`${packPath(packId)}/revisions`, input)
    return getContextPackDetail(packId)
  },

  async update(packId: string, input: UpdateContextPackInput) {
    await put<{ pack: AgentContextPack; contextAclRevision: number }>(packPath(packId), input)
    return getContextPackDetail(packId)
  },

  remove(packId: string, expectedRevision: number) {
    return del<void>(
      `${packPath(packId)}?expected_revision=${encodeURIComponent(String(expectedRevision))}`,
    )
  },

  async attach(packId: string, input: AttachContextPackInput) {
    assertExpectedContextAclRevision(input.expectedContextAclRevision)
    await post<{ attachment: ContextPackAttachment; contextAclRevision: number }>(
      `${packPath(packId)}/attachments`,
      input,
    )
    return getContextPackDetail(packId)
  },

  async detach(packId: string, attachment: ContextPackAttachment, expectedContextAclRevision: number) {
    assertExpectedContextAclRevision(expectedContextAclRevision)
    await del<{ success: true; contextAclRevision: number }>(
      `${packPath(packId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`
        + `?scope=${encodeURIComponent(attachment.scope)}`
        + `&expected_revision=${encodeURIComponent(String(expectedContextAclRevision))}`,
    )
    return getContextPackDetail(packId)
  },

  async replaceAcl(packId: string, input: ReplaceContextPackAclInput) {
    assertExpectedContextAclRevision(input.expectedContextAclRevision)
    await put<{ data: ContextPackAclEntry[]; contextAclRevision: number }>(
      `${packPath(packId)}/acl`,
      input,
    )
    return getContextPackDetail(packId)
  },

  async review(packId: string, input: ReviewContextPackInput) {
    await post<{ pack: AgentContextPack; contextAclRevision: number }>(
      `${packPath(packId)}/review`,
      input,
    )
    return getContextPackDetail(packId)
  },

  exportPortable(packId: string, revision: number) {
    return get<PortableContextPackSnapshotV1>(`${packPath(packId)}/export`, { revision })
  },

  async duplicate(packId: string, input: DuplicateContextPackInput) {
    const duplicate = await post<{
      pack: AgentContextPack
      revisions: AgentContextPackRevision[]
      attachments: ContextPackAttachment[]
    }>(`${packPath(packId)}/duplicate`, input)
    return getContextPackDetail(duplicate.pack.id)
  },
}
