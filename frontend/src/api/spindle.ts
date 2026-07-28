import { get, post, del, put } from './client'
import type {
  ExtensionInfo,
  SpindleHostDescriptorV1,
  SpindleManifest,
  ToolRegistration,
} from 'lumiverse-spindle-types'

const manifestCache = new Map<string, SpindleManifest>()
const manifestInFlight = new Map<string, Promise<SpindleManifest>>()
const manifestGenerations = new Map<string, number>()

function invalidateManifestState(id: string): number {
  const generation = (manifestGenerations.get(id) ?? 0) + 1
  manifestGenerations.set(id, generation)
  manifestCache.delete(id)
  manifestInFlight.delete(id)
  return generation
}
export interface SpindleCompatibilityHandshakeResponse {
  nonce: string
  descriptor: SpindleHostDescriptorV1
  digest: string
}

export interface EphemeralPoolConfig {
  globalMaxBytes: number
  extensionDefaultMaxBytes: number
  extensionMaxOverrides: Record<string, number>
  reservationTtlMs: number
}

export interface EphemeralPoolGlobal {
  maxBytes: number
  usedBytes: number
  reservedBytes: number
  availableBytes: number
}

export interface EphemeralPoolExtensionRow {
  extensionId: string
  identifier: string
  name: string
  enabled: boolean
  hasEphemeralPermission: boolean
  extensionMaxBytes: number
  usedBytes: number
  reservedBytes: number
  availableBytes: number
  fileCount: number
  reservations?: Array<{
    id: string
    sizeBytes: number
    consumedBytes: number
    remainingBytes: number
    createdAt: string
    expiresAt: string
    reason?: string
  }>
}

export interface EphemeralOverviewAdmin {
  config: EphemeralPoolConfig
  global: EphemeralPoolGlobal
  extensions: EphemeralPoolExtensionRow[]
}

export interface EphemeralOverviewMe {
  role: string
  canEditPools: boolean
  global: EphemeralPoolGlobal
  extensions: EphemeralPoolExtensionRow[]
}

export const spindleApi = {
  list() {
    return get<{ extensions: ExtensionInfo[]; isPrivileged: boolean }>('/spindle')
  },

  install(githubUrl: string, branch?: string | null) {
    return post<ExtensionInfo>('/spindle/install', { github_url: githubUrl, branch: branch || undefined })
  },

  listRemoteBranches(githubUrl: string) {
    return post<{ branches: string[] }>('/spindle/branches', { github_url: githubUrl })
  },

  importLocal() {
    return post<{
      imported: ExtensionInfo[]
      skipped: Array<{ identifier?: string; path: string; reason: string }>
    }>('/spindle/import-local')
  },

  async update(id: string) {
    const result = await post<ExtensionInfo>(`/spindle/${id}/update`)
    invalidateManifestState(id)
    return result
  },

  async updateAll() {
    const result = await post<{ started: boolean; total: number }>('/spindle/update-all')
    if (result.started) this.clearManifestCache()
    return result
  },

  getBranches(id: string) {
    return get<{ current: string | null; branches: string[] }>(`/spindle/${id}/branches`)
  },

  async switchBranch(id: string, branch: string) {
    const result = await post<ExtensionInfo>(`/spindle/${id}/switch-branch`, { branch })
    invalidateManifestState(id)
    return result
  },

  async remove(id: string) {
    const result = await del<{ success: boolean }>(`/spindle/${id}`)
    invalidateManifestState(id)
    return result
  },

  async enable(id: string) {
    const result = await post<{ success: boolean }>(`/spindle/${id}/enable`)
    invalidateManifestState(id)
    return result
  },

  async disable(id: string) {
    const result = await post<{ success: boolean }>(`/spindle/${id}/disable`)
    invalidateManifestState(id)
    return result
  },

  async restart(id: string) {
    const result = await post<{ success: boolean }>(`/spindle/${id}/restart`)
    invalidateManifestState(id)
    return result
  },

  getPermissions(id: string) {
    return get<{ requested: string[]; granted: string[] }>(`/spindle/${id}/permissions`)
  },
  compatibilityHandshake(id: string, nonce: string) {
    return post<SpindleCompatibilityHandshakeResponse>(
      `/spindle/${id}/compatibility-handshake`,
      { nonce },
      { timeout: 5_000 },
    )
  },

  setPermissions(id: string, grants: { grant?: string[]; revoke?: string[] }) {
    return post<{ requested: string[]; granted: string[] }>(`/spindle/${id}/permissions`, grants)
  },

  getManifest(id: string, options?: { force?: boolean }) {
    const generation = options?.force
      ? invalidateManifestState(id)
      : manifestGenerations.get(id) ?? 0
    if (!options?.force) {
      const cached = manifestCache.get(id)
      if (cached) return Promise.resolve(cached)

      const pending = manifestInFlight.get(id)
      if (pending) return pending
    }

    const request = get<SpindleManifest>(`/spindle/${id}/manifest`)
      .then((manifest) => {
        if ((manifestGenerations.get(id) ?? 0) === generation) {
          manifestCache.set(id, manifest)
        }
        return manifest
      })
      .finally(() => {
        if (manifestInFlight.get(id) === request) {
          manifestInFlight.delete(id)
        }
      })

    manifestInFlight.set(id, request)
    return request
  },

  clearManifestCache(id?: string) {
    if (id) {
      invalidateManifestState(id)
      return
    }
    const ids = new Set([
      ...manifestGenerations.keys(),
      ...manifestCache.keys(),
      ...manifestInFlight.keys(),
    ])
    for (const extensionId of ids) invalidateManifestState(extensionId)
  },

  getTools() {
    return get<ToolRegistration[]>('/spindle/tools')
  },

  getEphemeralOverviewAdmin() {
    return get<EphemeralOverviewAdmin>('/spindle/ephemeral/overview')
  },

  getEphemeralOverviewMe() {
    return get<EphemeralOverviewMe>('/spindle/ephemeral/overview/me')
  },

  getEphemeralConfig() {
    return get<EphemeralPoolConfig>('/spindle/ephemeral/config')
  },

  setEphemeralConfig(payload: {
    password: string
    globalMaxBytes?: number
    extensionDefaultMaxBytes?: number
    extensionMaxOverrides?: Record<string, number>
    reservationTtlMs?: number
  }) {
    return put<EphemeralPoolConfig>('/spindle/ephemeral/config', payload)
  },
}
