import type { StateCreator } from 'zustand'
import type { AppStore, ConnectionsSlice } from '@/types/store'
import type { ConnectionProfile } from '@/types/api'
import { settingsApi } from '@/api/settings'
import { areReasoningSettingsEqual, normalizeReasoningSettingsForProvider } from '@/lib/reasoning-binding'
import { REASONING_DEFAULTS, clearDirtyKey } from './settings'
import { normalizeConnectionsOrder, reorderProfiles } from './connections-order-merge'

export const createConnectionsSlice: StateCreator<AppStore, [], [], ConnectionsSlice> = (set, get) => ({
  profiles: [],
  activeProfileId: null,

  setProfiles: (profiles) =>
    set((state) => {
      const nextProfiles = reorderProfiles(profiles, normalizeConnectionsOrder(state.connectionsOrder).llm)
      const active = state.activeProfileId
        ? nextProfiles.find((profile) => profile.id === state.activeProfileId)
        : null
      return {
        profiles: nextProfiles,
        activeProfileId: active?.review_required === true ? null : active?.id ?? null,
      }
    }),
  setActiveProfile: (id) => {
    const state = get()
    const oldProfile = state.activeProfileId
      ? state.profiles.find((p) => p.id === state.activeProfileId)
      : null
    const requestedProfile = id
      ? state.profiles.find((p) => p.id === id)
      : null
    // Selection is a closed operation: unknown and review-required IDs both
    // resolve to no active profile rather than persisting an unusable ID.
    const nextId = requestedProfile?.review_required === true ? null : requestedProfile?.id ?? null
    const newProfile = nextId
      ? state.profiles.find((p) => p.id === nextId)
      : null

    set({ activeProfileId: nextId })
    settingsApi.put('activeProfileId', nextId).catch(() => {})

    // Apply or restore reasoning settings based on profile bindings
    const newBindings = newProfile?.metadata?.reasoningBindings?.settings
    const oldBindings = oldProfile?.metadata?.reasoningBindings?.settings

    if (newBindings) {
      // Switching TO a bound profile: apply its reasoning settings
      const normalizedBindings = normalizeReasoningSettingsForProvider(newBindings, newProfile?.provider, newProfile?.model)
      set({ reasoningSettings: normalizedBindings } as any)
      settingsApi.put('reasoningSettings', normalizedBindings).catch(() => {})
      clearDirtyKey('reasoningSettings')
    } else if (oldBindings) {
      // Switching FROM a bound profile TO an unbound one: restore defaults
      set({ reasoningSettings: { ...REASONING_DEFAULTS } } as any)
      settingsApi.put('reasoningSettings', { ...REASONING_DEFAULTS }).catch(() => {})
      clearDirtyKey('reasoningSettings')
    } else if (newProfile) {
      // Switching between unbound profiles: keep the current settings, but map
      // provider-specific effort tiers onto the new provider's supported scale.
      const normalizedCurrent = normalizeReasoningSettingsForProvider(state.reasoningSettings, newProfile.provider, newProfile.model)
      if (!areReasoningSettingsEqual(normalizedCurrent, state.reasoningSettings)) {
        set({ reasoningSettings: normalizedCurrent } as any)
        settingsApi.put('reasoningSettings', normalizedCurrent).catch(() => {})
        clearDirtyKey('reasoningSettings')
      }
    }

    // Apply or restore promptBias ("Start Reply With") when bound on the profile
    const newBoundPromptBias = newProfile?.metadata?.reasoningBindings?.promptBias
    const oldBoundPromptBias = oldProfile?.metadata?.reasoningBindings?.promptBias
    if (typeof newBoundPromptBias === 'string') {
      set({ promptBias: newBoundPromptBias } as any)
      settingsApi.put('promptBias', newBoundPromptBias).catch(() => {})
      clearDirtyKey('promptBias')
    } else if (typeof oldBoundPromptBias === 'string') {
      set({ promptBias: '' } as any)
      settingsApi.put('promptBias', '').catch(() => {})
      clearDirtyKey('promptBias')
    }
  },

  addProfile: (profile) => set((state) => {
    const connectionsOrder = normalizeConnectionsOrder(state.connectionsOrder)
    const order = connectionsOrder.llm
    const existingIndex = state.profiles.findIndex((candidate) => candidate.id === profile.id)
    const nextProfiles = existingIndex === -1
      ? [...state.profiles, profile]
      : state.profiles.map((candidate, index) => index === existingIndex ? profile : candidate)
    const active = nextProfiles.find((candidate) => candidate.id === state.activeProfileId)
    return {
      // A connection mutation is delivered both over WebSocket and in the
      // initiating request's REST response. Either can arrive first, so treat
      // adding an already-known id as an update instead of creating two rows.
      profiles: nextProfiles,
      activeProfileId: active?.review_required === true ? null : active?.id ?? null,
      connectionsOrder: {
        ...connectionsOrder,
        llm: order.includes(profile.id) ? order : [...order, profile.id],
      },
    }
  }),
  updateProfile: (id, updates) =>
    set((state) => {
      const profiles = state.profiles.map((p) => (p.id === id ? { ...p, ...updates } : p))
      const active = profiles.find((p) => p.id === state.activeProfileId)
      return {
        profiles,
        activeProfileId: active?.review_required === true ? null : active?.id ?? null,
      }
    }),
  removeProfile: (id) => {
    const state = get()
    const wasActive = state.activeProfileId === id
    const removedProfile = wasActive ? state.profiles.find((p) => p.id === id) : null

    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
      activeProfileId: s.activeProfileId === id ? null : s.activeProfileId,
    }))

    // If the removed profile was active and had reasoning bindings, restore defaults
    if (wasActive && removedProfile?.metadata?.reasoningBindings?.settings) {
      set({ reasoningSettings: { ...REASONING_DEFAULTS } } as any)
      settingsApi.put('reasoningSettings', { ...REASONING_DEFAULTS }).catch(() => {})
      clearDirtyKey('reasoningSettings')
    }
    if (wasActive && typeof removedProfile?.metadata?.reasoningBindings?.promptBias === 'string') {
      set({ promptBias: '' } as any)
      settingsApi.put('promptBias', '').catch(() => {})
      clearDirtyKey('promptBias')
    }
  },

  applyProfileOrder: (orderedIds) =>
    set((state) => ({
      profiles: orderedIds
        .map((id) => state.profiles.find((p) => p.id === id))
        .filter((p): p is ConnectionProfile => Boolean(p)),
    })),

  providers: [],
  setProviders: (providers) => set({ providers }),
})
