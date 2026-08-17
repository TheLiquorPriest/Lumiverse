import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { create } from 'zustand'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import * as actualReactI18next from 'react-i18next'
import { createInstance } from 'i18next'
import type { ContextPackDetail, ContextPackUiErrorCode } from '@/types/agent-context-packs'
import {
  createPortableContextPackSnapshotId,
  estimateContextPackTokens,
  hashContextPackContent,
  serializeContextPackContent,
  utf8Bytes,
} from '@/types/agent-context-packs'
const importedContent = [{ id: 'main', title: 'Imported', body: 'Imported fact', tags: ['canon'] }]
const importedSerializedContent = serializeContextPackContent(importedContent)
const importedDigest = hashContextPackContent(importedSerializedContent)
const importedSnapshot = {
  portableVersion: 1 as const,
  snapshotId: createPortableContextPackSnapshotId(importedDigest, 1),
  name: 'Imported from file',
  description: 'Review before use',
  revision: 1,
  content: importedContent,
  contentDigest: importedDigest,
  tokenCount: estimateContextPackTokens(importedSerializedContent),
  byteCount: utf8Bytes(importedSerializedContent),
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://lumiverse.test/',
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  navigator: dom.window.navigator,
})
Object.assign(dom.window.HTMLElement.prototype, {
  attachEvent: () => {},
  detachEvent: () => {},
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const foreignDetail: ContextPackDetail = {
  pack: {
    id: 'pack-foreign',
    name: 'Imported canon',
    description: 'Review before use',
    visibility: 'restricted',
    state: 'review_required',
    latestRevision: 1,
    contextAclRevision: 8,
    provenance: { kind: 'portable_import' },
    createdAt: 10,
    updatedAt: 10,
  },
  revisions: [{
    packId: 'pack-foreign',
    revision: 1,
    content: [{ id: 'main', title: 'Canon', body: 'Visible reviewed content', tags: ['canon'] }],
    contentDigest: 'a'.repeat(64),
    tokenCount: 4,
    byteCount: 22,
    state: 'review_required',
    provenance: { kind: 'portable_import' },
    createdAt: 10,
  }],
  acl: [],
  attachments: [],
  contextAclRevision: 8,
}

const activeDetail: ContextPackDetail = {
  ...foreignDetail,
  pack: {
    ...foreignDetail.pack,
    state: 'active',
    provenance: { kind: 'local' },
  },
  revisions: foreignDetail.revisions.map((revision) => ({
    ...revision,
    state: 'active',
    provenance: { kind: 'local' },
  })),
}

const importedDetail: ContextPackDetail = {
  ...foreignDetail,
  pack: {
    ...foreignDetail.pack,
    id: 'pack-imported',
    name: 'Imported from file',
  },
  revisions: foreignDetail.revisions.map((revision) => ({ ...revision, packId: 'pack-imported' })),
}

let targetLoadFailures = 0
let targetLoadAttempts = 0
let targetMalformedMetadata = false
let exportedSnapshots = 0
let downloadedFiles = 0
let importedReceivedSnapshot: unknown = null
let deferImport = false
let releaseImport: (() => void) | null = null

let reviewed = false
const state = {
  contextPacks: [foreignDetail.pack],
  selectedContextPackId: foreignDetail.pack.id,
  selectedContextPack: foreignDetail,
  contextPackAclRevision: 8,
  contextPacksLoading: false,
  contextPackDetailLoading: false,
  contextPackBusyAction: null,
  contextPackError: null as ContextPackUiErrorCode | null,
  loadContextPacks: async () => undefined,
  importContextPack: async (_snapshot: unknown) => null,
  selectContextPack: async () => undefined,
  createContextPack: async () => null,
  updateContextPack: async () => null,
  deleteContextPack: async () => false,
  createContextPackRevision: async () => null,
  attachContextPack: async () => null,
  detachContextPack: async (_packId: string, _attachment: unknown, _expectedContextAclRevision: number) => null,
  replaceContextPackAcl: async () => null,
  reviewContextPack: async (_packId: string, input: { state: string; acknowledge: boolean }) => {
    reviewed = input.state === 'active' && input.acknowledge
    return foreignDetail
  },
  duplicateContextPack: async () => null,
  clearContextPackError: () => undefined,
}

const useStore = create<typeof state>()(() => state)
useStore.setState({
  clearContextPackError: () => useStore.setState({ contextPackError: null }),
})


mock.module('@/store', () => ({ useStore }))
// Preserve the complete module shape for chat activity tests sharing this graph.
mock.module('react-i18next', () => ({ ...actualReactI18next }))
const testI18n = createInstance()
await testI18n.init({
  resources: { en: { settings: {} } },
  lng: 'en',
  fallbackLng: false,
  interpolation: { escapeValue: false },
})
mock.module('@/api/presets', () => ({
  presetsApi: {
    list: async ({ offset = 0, limit = 200 }: { offset?: number; limit?: number } = {}) => {
      targetLoadAttempts += 1
      if (targetLoadFailures > 0) {
        targetLoadFailures -= 1
        throw new Error('target_load_failed')
      }
      if (targetMalformedMetadata) {
        return { data: [{ id: 'preset-1', name: 'Preset one' }], total: 2, limit, offset }
      }
      return { data: [{ id: 'preset-1', name: 'Preset one' }], total: 1, limit, offset }
    },
  },
}))
mock.module('@/api/chats', () => ({
  chatsApi: {
    list: async ({ offset = 0, limit = 200 }: { offset?: number; limit?: number } = {}) => ({ data: [], total: 0, limit, offset }),
    listRecentGrouped: async () => ({ data: [], total: 0 }),
    create: async () => null,
    createTemporary: async () => null,
    deleteTemporary: async () => ({ success: true, deleted: 0 }),
    delete: async () => undefined,
    deleteCharacterChats: async () => ({ success: true, deleted: 0 }),
    patchMetadata: async () => null,
    branch: async () => null,
  },
  messagesApi: { list: async () => ({ data: [], total: 0 }) },
}))
mock.module('@/api/world-books', () => ({
  worldBooksApi: { listAll: async () => [] },
}))
mock.module('@/api/agent-context-packs', () => ({
  agentContextPacksApi: {
    exportPortable: async () => {
      exportedSnapshots += 1
      return { portableVersion: 1, snapshotId: 'snapshot-exported' }
    },
  },
  classifyContextPackError: () => 'unavailable',
}))
mock.module('@/lib/downloads', () => ({
  triggerBlobDownload: () => { downloadedFiles += 1 },
}))

// Import after module mocks so the component binds to the isolated store and API fixtures.
const { default: ContextLibrarySettings } = await import('./ContextLibrarySettings')

function buttonWithText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`Missing button: ${text}`)
  return button
}

beforeEach(() => {
  reviewed = false
  targetLoadFailures = 0
  targetLoadAttempts = 0
  targetMalformedMetadata = false
  exportedSnapshots = 0
  downloadedFiles = 0
  importedReceivedSnapshot = null
  deferImport = false
  releaseImport = null
  useStore.setState({
    contextPacks: [foreignDetail.pack],
    selectedContextPackId: foreignDetail.pack.id,
    selectedContextPack: foreignDetail,
    contextPackAclRevision: 8,
    contextPacksLoading: false,
    contextPackDetailLoading: false,
    contextPackBusyAction: null,
    contextPackError: null,
    deleteContextPack: async () => false,
    importContextPack: async (snapshot: unknown) => {
      importedReceivedSnapshot = snapshot
      if (deferImport) {
        await new Promise<void>((resolve) => { releaseImport = resolve })
      }
      useStore.setState({
        contextPacks: [importedDetail.pack, foreignDetail.pack],
        selectedContextPackId: importedDetail.pack.id,
        selectedContextPack: importedDetail,
        contextPackBusyAction: null,
      })
      return importedDetail
    },
  })
})

describe('Context Library settings', () => {
  test('keeps a foreign pack inspectable but disables use until explicit authenticated review', async () => {
    reviewed = false
    const host = document.getElementById('root') as HTMLDivElement
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <actualReactI18next.I18nextProvider i18n={testI18n}>
          <ContextLibrarySettings />
        </actualReactI18next.I18nextProvider>,
      )
    })

    expect(host.textContent).toContain('Imported canon')
    expect(host.textContent).toContain('Visible reviewed content')
    expect(host.textContent).toContain('contextLibrary.reviewTitle')
    expect(buttonWithText(host, 'contextLibrary.actions.attach').disabled).toBe(true)
    expect(buttonWithText(host, 'contextLibrary.actions.newVersion').disabled).toBe(true)
    expect(host.querySelector('option[value="project"]')).toBeNull()

    const reviewButton = buttonWithText(host, 'contextLibrary.actions.review')
    reviewButton.focus()
    await act(async () => { reviewButton.click() })
    const dialog = host.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    const activateButton = buttonWithText(dialog, 'contextLibrary.dialogs.review.confirm')
    expect(activateButton.disabled).toBe(true)

    const acknowledgement = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => { acknowledgement.click() })
    expect(activateButton.disabled).toBe(false)
    await act(async () => { activateButton.click(); await Promise.resolve() })
    expect(reviewed).toBe(true)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(reviewButton)

    await act(async () => { root.unmount() })
  })

  test('closes stale mutation drafts and requires explicit review after a revision conflict', async () => {
    useStore.setState({
      contextPackError: null,
      selectedContextPackId: foreignDetail.pack.id,
      selectedContextPack: foreignDetail,
    })
    const host = document.getElementById('root') as HTMLDivElement
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <actualReactI18next.I18nextProvider i18n={testI18n}>
          <ContextLibrarySettings />
        </actualReactI18next.I18nextProvider>,
      )
    })

    await act(async () => { buttonWithText(host, 'contextLibrary.actions.edit').click() })
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => { useStore.setState({ contextPackError: 'revision_conflict' }) })

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(buttonWithText(host, 'contextLibrary.actions.create').disabled).toBe(true)
    expect(buttonWithText(host, 'contextLibrary.actions.edit').disabled).toBe(true)
    const reviewLatest = buttonWithText(host, 'contextLibrary.actions.reviewLatest')
    await act(async () => { reviewLatest.click() })
    expect(useStore.getState().contextPackError).toBeNull()
    expect(buttonWithText(host, 'contextLibrary.actions.edit').disabled).toBe(false)

    await act(async () => { root.unmount() })
  })

  test('uses semantic disclosures, a revision table, and no editable control for an immutable revision', async () => {
    const host = document.getElementById('root') as HTMLDivElement
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <actualReactI18next.I18nextProvider i18n={testI18n}>
          <ContextLibrarySettings />
        </actualReactI18next.I18nextProvider>,
      )
    })

    expect(host.querySelectorAll('details')).toHaveLength(3)
    expect(host.querySelector('table caption')?.textContent).toBe('contextLibrary.versionHistoryCaption')
    expect(host.querySelector('pre')?.textContent).toBe('Visible reviewed content')
    expect(host.querySelector('input[value="Visible reviewed content"]')).toBeNull()

    await act(async () => { root.unmount() })
  })

  test('announces failed attachment-target loading and exposes a working retry', async () => {
    targetLoadFailures = 1
    useStore.setState({
      contextPacks: [activeDetail.pack],
      selectedContextPackId: activeDetail.pack.id,
      selectedContextPack: activeDetail,
    })
    const host = document.getElementById('root') as HTMLDivElement
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <actualReactI18next.I18nextProvider i18n={testI18n}>
          <ContextLibrarySettings />
        </actualReactI18next.I18nextProvider>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(targetLoadAttempts).toBe(1)
    await act(async () => { buttonWithText(host, 'contextLibrary.actions.attach').click() })
    const dialog = host.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('contextLibrary.targetLoadError')

    await act(async () => {
      buttonWithText(dialog, 'contextLibrary.actions.retryTargets').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(targetLoadAttempts).toBe(2)
    expect(host.querySelector('[role="status"]')?.textContent).toContain('contextLibrary.targetsLoaded')
    expect((dialog.querySelector('select[required]') as HTMLSelectElement).disabled).toBe(false)

    await act(async () => { root.unmount() })
  })
  test('fails visibly when attachment-target pagination metadata stops making progress', async () => {
    targetMalformedMetadata = true
    useStore.setState({
      contextPacks: [activeDetail.pack],
      selectedContextPackId: activeDetail.pack.id,
      selectedContextPack: activeDetail,
    })
    const host = document.getElementById('root') as HTMLDivElement
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <actualReactI18next.I18nextProvider i18n={testI18n}>
          <ContextLibrarySettings />
        </actualReactI18next.I18nextProvider>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => { buttonWithText(host, 'contextLibrary.actions.attach').click() })
    const dialog = host.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('contextLibrary.targetLoadError')
    await act(async () => { root.unmount() })
  })


  test('moves focus to the pack-list heading when deletion removes the dialog trigger', async () => {
    useStore.setState({
      contextPacks: [activeDetail.pack],
      selectedContextPackId: activeDetail.pack.id,
      selectedContextPack: activeDetail,
      deleteContextPack: async () => {
        useStore.setState({
          contextPacks: [],
          selectedContextPackId: null,
          selectedContextPack: null,
        })
        return true
      },
    })
    const host = document.getElementById('root') as HTMLDivElement
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <actualReactI18next.I18nextProvider i18n={testI18n}>
          <ContextLibrarySettings />
        </actualReactI18next.I18nextProvider>,
      )
    })
    const deleteTrigger = buttonWithText(host, 'contextLibrary.actions.delete')
    deleteTrigger.focus()
    await act(async () => { deleteTrigger.click() })
    const dialog = host.querySelector('[role="dialog"]') as HTMLElement
    await act(async () => {
      buttonWithText(dialog, 'contextLibrary.dialogs.delete.confirm').click()
      await Promise.resolve()
    })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement?.textContent).toBe('contextLibrary.packs')

    await act(async () => { root.unmount() })
  })

  test('exports and imports portable snapshots with progress and selects the imported pack', async () => {
    const host = document.getElementById('root') as HTMLDivElement
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <actualReactI18next.I18nextProvider i18n={testI18n}>
          <ContextLibrarySettings />
        </actualReactI18next.I18nextProvider>,
      )
    })

    await act(async () => {
      buttonWithText(host, 'contextLibrary.actions.export').click()
      await Promise.resolve()
    })
    expect(exportedSnapshots).toBe(1)
    expect(downloadedFiles).toBe(1)
    expect(host.querySelector('[role="status"]')?.textContent).toContain('contextLibrary.exportComplete')

    const fileInput = host.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [{ name: 'invalid.json', text: async () => '{' }],
    })
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('contextLibrary.errors.validation_failed')

    const snapshot = importedSnapshot
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [{ name: 'context-pack.json', text: async () => JSON.stringify(snapshot) }],
    })
    deferImport = true
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(host.querySelector('[role="status"]')?.textContent).toContain('contextLibrary.importing')
    await act(async () => {
      releaseImport?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(importedReceivedSnapshot).toEqual(snapshot)
    expect(useStore.getState().selectedContextPackId).toBe(importedDetail.pack.id)
    expect(host.textContent).toContain('Imported from file')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('contextLibrary.importComplete')

    await act(async () => { root.unmount() })
  })
})
