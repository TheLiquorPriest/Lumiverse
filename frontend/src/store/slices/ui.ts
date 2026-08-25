import type { StateCreator } from 'zustand'
import type { UISlice } from '@/types/store'
import { CUSTOM_CSS_DOCK_DEFAULT_SIZE } from '@/lib/custom-css-dock'
import { longMessageExpansionKey } from '@/lib/longMessageCollapse'

let toastCounter = 0
let settingsScrollCounter = 0

export const createUISlice: StateCreator<UISlice> = (set) => ({
  activeModal: null,
  modalProps: {},
  isLoading: false,
  error: null,
  drawerOpen: false,
  drawerTab: null,
  settingsModalOpen: false,
  settingsActiveView: 'display',
  settingsScrollTarget: null,
  portraitPanelOpen: false,
  commandPaletteOpen: false,
  customCSSDockOpen: false,
  customCSSDockSize: CUSTOM_CSS_DOCK_DEFAULT_SIZE,
  customCSSDockSide: 'left',
  customCSSEditorSession: {
    search: '',
    selected: '__global__',
    activeTab: 'css',
    sidebarOpen: true,
    showReference: false,
    showAssets: false,
  },
  toasts: [],
  badgeCount: 0,

  openModal: (name, props = {}) =>
    set({
      activeModal: name,
      modalProps: props,
      ...(name === 'customCSS' ? { customCSSDockOpen: false } : {}),
    }),
  closeModal: () => set({ activeModal: null, modalProps: {} }),

  openCustomCSSDock: () =>
    set({
      customCSSDockOpen: true,
      activeModal: null,
      modalProps: {},
    }),
  closeCustomCSSDock: () => set({ customCSSDockOpen: false }),
  setCustomCSSDockSize: (size) => set({ customCSSDockSize: size }),
  setCustomCSSDockSide: (side) => set({ customCSSDockSide: side }),
  setCustomCSSEditorSession: (patch) =>
    set((state) => ({
      customCSSEditorSession: {
        ...state.customCSSEditorSession,
        ...patch,
      },
    })),

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),

  openDrawer: (tab) =>
    set((state) => ({
      drawerOpen: true,
      drawerTab: tab ?? state.drawerTab,
    })),
  closeDrawer: () => set({ drawerOpen: false }),
  setDrawerTab: (tab) => set({ drawerTab: tab }),

  openSettings: (view = 'display', target) =>
    set({
      settingsModalOpen: true,
      settingsActiveView: view,
      settingsScrollTarget: target ? { ...target, nonce: ++settingsScrollCounter } : null,
    }),
  closeSettings: () => set({ settingsModalOpen: false }),

  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),

  togglePortraitPanel: () =>
    set((state) => ({ portraitPanelOpen: !state.portraitPanelOpen })),

  addToast: (toast) => {
    const id = `toast-${++toastCounter}-${Date.now()}`
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id, dismissible: toast.dismissible ?? true }],
    }))
    return id
  },

  updateToast: (id, update) =>
    set((state) => ({
      toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, ...update, id } : toast)),
    })),

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  clearToasts: () => set({ toasts: [] }),

  incrementBadgeCount: () => set((state) => ({ badgeCount: state.badgeCount + 1 })),
  resetBadgeCount: () => set({ badgeCount: 0 }),

  lastRegenFeedback: {},
  setLastRegenFeedback: (chatId, text) =>
    set((state) => ({
      lastRegenFeedback: { ...state.lastRegenFeedback, [chatId]: text },
    })),

  editingMessageId: null,
  messageEditDraft: null,
  setEditingMessageId: (id) => set((state) => ({
    editingMessageId: id,
    ...(id && state.messageEditDraft?.messageId === id
      ? { messageEditDraft: { ...state.messageEditDraft, focusRequested: true } }
      : {}),
  })),
  beginMessageEdit: (draft) => set({
    editingMessageId: draft.messageId,
    messageEditDraft: {
      ...draft,
      dirty: false,
      focusRequested: true,
    },
  }),
  updateMessageEditDraft: (patch) => set((state) => ({
    messageEditDraft: state.messageEditDraft
      ? { ...state.messageEditDraft, ...patch, dirty: true }
      : null,
  })),
  resumeMessageEdit: () => set((state) => state.messageEditDraft
    ? {
        editingMessageId: state.messageEditDraft.messageId,
        messageEditDraft: { ...state.messageEditDraft, focusRequested: true },
      }
    : {}),
  consumeMessageEditFocusRequest: () => set((state) => ({
    messageEditDraft: state.messageEditDraft
      ? { ...state.messageEditDraft, focusRequested: false }
      : null,
  })),
  clearMessageEdit: () => set({ editingMessageId: null, messageEditDraft: null }),

  highlightedMessageId: null,
  setHighlightedMessageId: (id) => set({ highlightedMessageId: id }),

  expandedLongMessageKeys: [],
  setLongMessageExpanded: (chatId, messageId, expanded) =>
    set((state) => {
      const key = longMessageExpansionKey(chatId, messageId)
      const alreadyExpanded = state.expandedLongMessageKeys.includes(key)
      if (alreadyExpanded === expanded) return state
      return {
        expandedLongMessageKeys: expanded
          ? [...state.expandedLongMessageKeys, key]
          : state.expandedLongMessageKeys.filter((entry) => entry !== key),
      }
    }),
})
