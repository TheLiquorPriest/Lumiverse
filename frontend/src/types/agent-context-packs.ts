export const CONTEXT_PACK_TARGET_TYPES = ['preset', 'chat', 'world_book'] as const
export type ContextPackTargetType = (typeof CONTEXT_PACK_TARGET_TYPES)[number]

export type ContextPackVisibility = 'private' | 'account' | 'restricted'
export type ContextPackState = 'active' | 'disabled' | 'review_required' | 'repair_required'
export type ContextPackPermission = 'read' | 'use' | 'edit'

export interface ContextPackEntryV1 {
  id: string
  title: string
  body: string
  tags: string[]
}

export interface ContextPackProvenanceV1 {
  kind: 'local' | 'portable_import' | 'archive_restore' | 'same_account_duplicate'
}

export interface AgentContextPack {
  id: string
  name: string
  description: string
  visibility: ContextPackVisibility
  state: ContextPackState
  latestRevision: number
  contextAclRevision: number
  provenance: ContextPackProvenanceV1
  createdAt: number
  updatedAt: number
}

export interface AgentContextPackRevision {
  packId: string
  revision: number
  content: ContextPackEntryV1[]
  contentDigest: string
  tokenCount: number
  byteCount: number
  state: ContextPackState
  provenance: ContextPackProvenanceV1
  createdAt: number
}

export interface ContextPackAclEntry {
  principalUserId: string
  permission: ContextPackPermission
  createdAt?: number
  updatedAt?: number
}

export interface ContextPackAttachment {
  attachmentId: string
  scope: ContextPackTargetType
  targetId: string
  packId: string
  revision: number
  position: number
  required: boolean
  state: ContextPackState
  provenance: ContextPackProvenanceV1
  createdAt: number
  updatedAt: number
}

export interface ContextPackDetail {
  pack: AgentContextPack
  revisions: AgentContextPackRevision[]
  acl: ContextPackAclEntry[]
  attachments: ContextPackAttachment[]
  contextAclRevision: number
}

export interface CreateContextPackInput {
  name: string
  description?: string
  visibility?: ContextPackVisibility
  content: ContextPackEntryV1[]
}

export interface UpdateContextPackInput {
  name?: string
  description?: string
  visibility?: ContextPackVisibility
  expectedRevision?: number
}

export interface CreateContextPackRevisionInput {
  content: ContextPackEntryV1[]
  expectedRevision: number
}

export interface AttachContextPackInput {
  scope: ContextPackTargetType
  targetId: string
  revision: number
  position?: number
  required?: boolean
  expectedContextAclRevision: number
}

export interface ReplaceContextPackAclInput {
  expectedContextAclRevision: number
  entries: Array<Pick<ContextPackAclEntry, 'principalUserId' | 'permission'>>
}

export interface ReviewContextPackInput {
  state: 'active' | 'disabled'
  acknowledge: true
  expectedRevision?: number
}

export interface DuplicateContextPackInput {
  name?: string
  description?: string
  preserveAttachments?: boolean
}

export interface PortableContextPackSnapshotV1 {
  portableVersion: 1
  snapshotId: string
  name: string
  description: string
  revision: number
  content: ContextPackEntryV1[]
  contentDigest: string
  tokenCount: number
  byteCount: number
}

export const AGENT_CONTEXT_PACK_PORTABLE_VERSION = 1 as const
export const AGENT_CONTEXT_PACK_MAX_NAME_BYTES = 200
export const AGENT_CONTEXT_PACK_MAX_DESCRIPTION_BYTES = 8 * 1024
export const AGENT_CONTEXT_PACK_MAX_ENTRIES = 256
export const AGENT_CONTEXT_PACK_MAX_ENTRY_ID_BYTES = 128
export const AGENT_CONTEXT_PACK_MAX_ENTRY_TITLE_BYTES = 256
export const AGENT_CONTEXT_PACK_MAX_ENTRY_BODY_BYTES = 256 * 1024
export const AGENT_CONTEXT_PACK_MAX_ENTRY_TAGS = 32
export const AGENT_CONTEXT_PACK_MAX_TAG_BYTES = 64
export const AGENT_CONTEXT_PACK_MAX_TOTAL_BYTES = 4 * 1024 * 1024

const contextPackEncoder = new TextEncoder()
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624,
  0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3,
  0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function contextPackSha256(value: string): string {
  const bytes = contextPackEncoder.encode(value)
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  new DataView(padded.buffer).setUint32(paddedLength - 4, bytes.length * 8, false)

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const words = new Uint32Array(64)
  const view = new DataView(padded.buffer)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false)
    for (let index = 16; index < 64; index += 1) {
      const previous = words[index - 15]
      const secondPrevious = words[index - 2]
      const sigma0 = ((previous >>> 7) | (previous << 25)) ^ ((previous >>> 18) | (previous << 14)) ^ (previous >>> 3)
      const sigma1 = ((secondPrevious >>> 17) | (secondPrevious << 15)) ^ ((secondPrevious >>> 19) | (secondPrevious << 13)) ^ (secondPrevious >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const choose = (e & f) ^ (~e & g)
      const first = (h + sigma1 + choose + SHA256_K[index] + words[index]) >>> 0
      const sigma0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const second = (sigma0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + first) >>> 0
      d = c
      c = b
      b = a
      a = (first + second) >>> 0
    }
    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0
    state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0
    state[7] = (state[7] + h) >>> 0
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('')
}

export class ContextPackValidationError extends Error {
  readonly code = 'CONTEXT_PACK_INVALID' as const
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ContextPackValidationError'
    this.path = path
  }
}

export function utf8Bytes(value: string): number {
  return contextPackEncoder.encode(value).byteLength
}

function ensureContextPackString(value: unknown, path: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new ContextPackValidationError(path, allowEmpty ? 'must be a string' : 'must be a non-empty string')
  }
  if (utf8Bytes(value) > maxBytes) throw new ContextPackValidationError(path, `exceeds ${maxBytes} UTF-8 bytes`)
  return value
}

function normalizeContextPackTags(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ContextPackValidationError(path, 'must be an array')
  if (value.length > AGENT_CONTEXT_PACK_MAX_ENTRY_TAGS) {
    throw new ContextPackValidationError(path, `contains more than ${AGENT_CONTEXT_PACK_MAX_ENTRY_TAGS} tags`)
  }
  const seen = new Set<string>()
  return value.map((tag, index) => {
    const parsed = ensureContextPackString(tag, `${path}[${index}]`, AGENT_CONTEXT_PACK_MAX_TAG_BYTES)
    if (seen.has(parsed)) throw new ContextPackValidationError(`${path}[${index}]`, 'duplicate tag')
    seen.add(parsed)
    return parsed
  })
}

export function normalizeContextPackContent(value: unknown): ContextPackEntryV1[] {
  if (!Array.isArray(value)) throw new ContextPackValidationError('content', 'must be an array')
  if (value.length > AGENT_CONTEXT_PACK_MAX_ENTRIES) {
    throw new ContextPackValidationError('content', `contains more than ${AGENT_CONTEXT_PACK_MAX_ENTRIES} entries`)
  }
  const seen = new Set<string>()
  let totalBytes = 0
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ContextPackValidationError(`content[${index}]`, 'must be an object')
    }
    const object = raw as Record<string, unknown>
    if (Object.keys(object).sort().join(',') !== 'body,id,tags,title') {
      throw new ContextPackValidationError(`content[${index}]`, 'contains unknown or missing fields')
    }
    const id = ensureContextPackString(object.id, `content[${index}].id`, AGENT_CONTEXT_PACK_MAX_ENTRY_ID_BYTES)
    if (seen.has(id)) throw new ContextPackValidationError(`content[${index}].id`, 'duplicate entry id')
    seen.add(id)
    const title = ensureContextPackString(object.title, `content[${index}].title`, AGENT_CONTEXT_PACK_MAX_ENTRY_TITLE_BYTES, true)
    const body = ensureContextPackString(object.body, `content[${index}].body`, AGENT_CONTEXT_PACK_MAX_ENTRY_BODY_BYTES, true)
    const tags = normalizeContextPackTags(object.tags, `content[${index}].tags`)
    totalBytes += utf8Bytes(id) + utf8Bytes(title) + utf8Bytes(body) + tags.reduce((sum, tag) => sum + utf8Bytes(tag), 0)
    if (totalBytes > AGENT_CONTEXT_PACK_MAX_TOTAL_BYTES) {
      throw new ContextPackValidationError('content', `exceeds ${AGENT_CONTEXT_PACK_MAX_TOTAL_BYTES} UTF-8 bytes`)
    }
    return { id, title, body, tags }
  })
}

export function serializeContextPackContent(content: readonly ContextPackEntryV1[]): string {
  return JSON.stringify(content.map((entry) => ({
    id: entry.id,
    title: entry.title,
    body: entry.body,
    tags: [...entry.tags],
  })))
}

export function hashContextPackContent(serializedContent: string): string {
  return contextPackSha256(serializedContent)
}

export function estimateContextPackTokens(serializedContent: string): number {
  return Math.ceil(utf8Bytes(serializedContent) / 4)
}

function hasExactContextPackKeys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected
}

export function createPortableContextPackSnapshotId(contentDigest: string, revision: number, sourceIdentity?: string): string {
  const identity = sourceIdentity === undefined
    ? `${contentDigest}:${revision}`
    : `pack:${sourceIdentity}:${contentDigest}:${revision}`
  const digest = contextPackSha256(identity)
  return sourceIdentity === undefined ? digest : `pack-${digest}`
}

export function parsePortableContextPackSnapshotV1(value: unknown): PortableContextPackSnapshotV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContextPackValidationError('snapshot', 'must be an object')
  }
  const object = value as Record<string, unknown>
  if (!hasExactContextPackKeys(object, 'byteCount,content,contentDigest,description,name,portableVersion,revision,snapshotId,tokenCount')) {
    throw new ContextPackValidationError('snapshot', 'contains unknown or missing fields')
  }
  if (object.portableVersion !== AGENT_CONTEXT_PACK_PORTABLE_VERSION) {
    throw new ContextPackValidationError('snapshot.portableVersion', 'unsupported portable version')
  }
  const name = ensureContextPackString(object.name, 'snapshot.name', AGENT_CONTEXT_PACK_MAX_NAME_BYTES)
  const description = ensureContextPackString(object.description, 'snapshot.description', AGENT_CONTEXT_PACK_MAX_DESCRIPTION_BYTES, true)
  if (!Number.isSafeInteger(object.revision) || (object.revision as number) < 1) {
    throw new ContextPackValidationError('snapshot.revision', 'must be a positive integer')
  }
  const content = normalizeContextPackContent(object.content)
  const serialized = serializeContextPackContent(content)
  const contentDigest = ensureContextPackString(object.contentDigest, 'snapshot.contentDigest', 64)
  if (!/^[0-9a-f]{64}$/.test(contentDigest)) {
    throw new ContextPackValidationError('snapshot.contentDigest', 'must be a lowercase SHA-256 digest')
  }
  if (hashContextPackContent(serialized) !== contentDigest) {
    throw new ContextPackValidationError('snapshot.contentDigest', 'does not match content')
  }
  if (!Number.isSafeInteger(object.byteCount) || object.byteCount !== utf8Bytes(serialized)) {
    throw new ContextPackValidationError('snapshot.byteCount', 'does not match content bytes')
  }
  if (!Number.isSafeInteger(object.tokenCount) || object.tokenCount !== estimateContextPackTokens(serialized)) {
    throw new ContextPackValidationError('snapshot.tokenCount', 'does not match content tokens')
  }
  const snapshotId = ensureContextPackString(object.snapshotId, 'snapshot.snapshotId', 128)
  const legacySnapshotId = createPortableContextPackSnapshotId(contentDigest, object.revision as number)
  if (snapshotId !== legacySnapshotId && !/^pack-[0-9a-f]{64}$/.test(snapshotId)) {
    throw new ContextPackValidationError('snapshot.snapshotId', 'does not match a portable revision identity')
  }
  return {
    portableVersion: AGENT_CONTEXT_PACK_PORTABLE_VERSION,
    snapshotId,
    name,
    description,
    revision: object.revision as number,
    content,
    contentDigest,
    tokenCount: object.tokenCount as number,
    byteCount: object.byteCount as number,
  }
}

export interface ContextPackListResult {
  data: AgentContextPack[]
  contextAclRevision: number
}

export type ContextPackUiErrorCode =
  | 'not_found'
  | 'revision_conflict'
  | 'validation_failed'
  | 'unavailable'

export function contextPackNeedsReview(pack: Pick<AgentContextPack, 'state'>): boolean {
  return pack.state !== 'active'
}
