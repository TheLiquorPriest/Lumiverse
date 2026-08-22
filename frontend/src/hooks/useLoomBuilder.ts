import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useStore } from '@/store'
import { presetsApi } from '@/api/presets'
import { agenticRuntimeApi } from '@/api/agentic-runtime'
import { connectionsApi } from '@/api/connections'
import { ApiError } from '@/api/client'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import {
  createPresetSaveCoordinator,
  flushPresetForGeneration as defaultFlushPresetForGeneration,
  presetSaveCoordinator as defaultPresetSaveCoordinator,
  StalePresetHydrationError,
  type PresetSaveCoordinator,
} from '@/lib/loom/preset-save-coordinator'
import { beginActiveLoomPresetSelection, transitionActiveLoomPreset } from '@/lib/loom/preset-selection-coordinator'
import { getMacroCatalog } from '@/api/macros'
import type { SaveAgenticRuntimeEditorResult } from '@/api/agentic-runtime'
import type {
  AgenticRuntimeSaveDraft,
  LoomPreset,
  PromptBlock,
  LoomConnectionProfile,
  MacroGroup,
  PromptVariableDef,
  PromptVariableValues,
} from '@/lib/loom/types'
import {
  DEFAULT_SAMPLER_OVERRIDES,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_ADVANCED_SETTINGS,
  SAMPLER_PARAMS,
} from '@/lib/loom/constants'
import {
  createNewLoomPreset,
  marshalPreset,
  unmarshalPreset,
  detectSupportedParamsFromProviders,
  getAvailableMacros,
  exportToSTPreset,
  createPortableLoomExportPayload,
  extractPortableAgenticRuntimeEnvelope,
  stripPortableRegexOwnership,
  shouldRollbackImportedPreset,
  toPortableAgentConfigV1,
  sanitizeLumiHubSealedBlocksForExport,
  normalizeCategoryBlockState,
  toggleBlockWithCategoryRules,
  toggleCategoryWithChildren,
  coerceImportedLoomPreset,
  detectImportedPresetKind,
  reconcilePromptVariableValues,
  pruneOrphanPromptVariables,
  validatePromptVariableSchema,
} from '@/lib/loom/service'
import { mergePromptVariableValues } from '@/hooks/preset-profile-prompt-variables'

type LoomPrivateBlockFields = Pick<
  PromptBlock,
  'sealed' | 'sealedKey' | 'sealedSource' | 'sealedOriginPresetId' | 'sealedOriginVersion' | 'sealedSha256'
>

type LoomPrivateBlockChange = {
  blockId: string
  /** Zero-based occurrence among blocks sharing blockId; required for duplicates. */
  occurrence?: number
  patch: Partial<LoomPrivateBlockFields>
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function portableSnapshotKey(value: unknown): string {
  return JSON.stringify(value) ?? ''
}


function normalizeAgentSlotBindings(value: unknown): Record<string, string | null> {
  if (Array.isArray(value)) {
    const output: Record<string, string | null> = {}
    for (const entry of value) {
      if (!isObjectRecord(entry) || typeof entry.slotId !== 'string') continue
      output[entry.slotId] = typeof entry.connectionId === 'string' ? entry.connectionId : null
    }
    return output
  }
  if (!isObjectRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, connectionId]) => (
      connectionId === null || typeof connectionId === 'string'
    )),
  ) as Record<string, string | null>
}

function applyPrivateBlockChange(
  currentBlocks: PromptBlock[],
  nextBlocks: PromptBlock[],
  change: LoomPrivateBlockChange | undefined,
): PromptBlock[] {
  if (!change) return nextBlocks
  const currentMatches = currentBlocks.filter((block) => block.id === change.blockId).length
  const nextMatches = nextBlocks.filter((block) => block.id === change.blockId).length
  const occurrence = change.occurrence
  if (currentMatches > 1) {
    if (!Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence >= currentMatches) {
      throw new Error('LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: duplicate block changes require an exact occurrence')
    }
    if (nextMatches !== currentMatches) {
      throw new Error('LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: duplicate block occurrence count changed')
    }
  } else if (occurrence !== undefined && occurrence !== 0) {
    throw new Error('LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: occurrence must identify the unique block')
  }
  let seen = 0
  let applied = false
  const updated = nextBlocks.map((block) => {
    if (block.id !== change.blockId) return block
    const matches = occurrence === undefined || occurrence === seen
    seen += 1
    if (!matches) return block
    applied = true
    return { ...block, ...change.patch }
  })
  if (!applied) {
    throw new Error('LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: requested block occurrence is absent')
  }
  return updated
}

type LoomBuilderDependencies = {
  presetsApi?: typeof presetsApi
  saveCoordinator?: PresetSaveCoordinator
  flushPresetForGeneration?: typeof defaultFlushPresetForGeneration
}

export function useLoomBuilder(dependencies: LoomBuilderDependencies = {}) {
  const presetApi = dependencies.presetsApi ?? presetsApi
  const presetSaveCoordinator = useMemo(
    () => dependencies.saveCoordinator ?? (
      dependencies.presetsApi
        ? createPresetSaveCoordinator({
            get: (presetId) => presetApi.get(presetId),
            update: (presetId, input) => presetApi.update(presetId, input),
          })
        : defaultPresetSaveCoordinator
    ),
    [dependencies.presetsApi, dependencies.saveCoordinator, presetApi],
  )
  const flushPresetForGeneration = useMemo(
    () => dependencies.flushPresetForGeneration ?? (
      dependencies.presetsApi || dependencies.saveCoordinator
        ? async (presetId: string | undefined) => {
            if (presetId) await presetSaveCoordinator.flush(presetId)
          }
        : defaultFlushPresetForGeneration
    ),
    [
      dependencies.flushPresetForGeneration,
      dependencies.presetsApi,
      dependencies.saveCoordinator,
      presetSaveCoordinator,
    ],
  )
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const loomRegistry = useStore((s) => s.loomRegistry)
  const setActiveLoomPreset = useStore((s) => s.setActiveLoomPreset)
  const setLoomRegistry = useStore((s) => s.setLoomRegistry)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)
  const providers = useStore((s) => s.providers)

  const [activePreset, setActivePreset] = useState<LoomPreset | null>(null)
  const [runtimePresetProfile, setRuntimePresetProfile] = useState<{
    presetId: string
    blockStates: Record<string, boolean>
    promptVariables?: PromptVariableValues
  } | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activePresetRef = useRef<LoomPreset | null>(null)
  const effectiveActivePreset = useMemo(() => {
    if (!activePreset || runtimePresetProfile?.presetId !== activePreset.id) return activePreset
    return {
      ...activePreset,
      blocks: activePreset.blocks.map((block) => (
        block.id in runtimePresetProfile.blockStates
          ? { ...block, enabled: runtimePresetProfile.blockStates[block.id] }
          : block
      )),
      promptVariables: mergePromptVariableValues(
        activePreset.promptVariables,
        runtimePresetProfile.promptVariables,
      ),
    }
  }, [activePreset, runtimePresetProfile])
  const effectiveActivePresetRef = useRef<LoomPreset | null>(effectiveActivePreset)
  effectiveActivePresetRef.current = effectiveActivePreset

  const applyRuntimeBlockProfile = useCallback((
    presetId: string,
    blockStates: Record<string, boolean> | null,
    promptVariables?: PromptVariableValues,
  ) => {
    setRuntimePresetProfile(blockStates
      ? {
          presetId,
          blockStates: { ...blockStates },
          ...(promptVariables ? { promptVariables: structuredClone(promptVariables) } : {}),
        }
      : null)
  }, [])

  // Load active preset when activeLoomPresetId changes. Durable recovery is
  // rebased through the process-wide coordinator so an old local snapshot
  // cannot overwrite unrelated prompt-variable or extension metadata changes.
  useEffect(() => {
    if (!activeLoomPresetId) {
      activePresetRef.current = null
      setActivePreset(null)
      return
    }
    if (activePresetRef.current?.id === activeLoomPresetId) return

    let cancelled = false
    setIsLoading(true)
    const hydration = presetSaveCoordinator.beginHydration(activeLoomPresetId, 'loom-editor')
    presetApi.get(activeLoomPresetId).then((preset) => {
      if (cancelled) {
        presetSaveCoordinator.cancelHydration(hydration)
        return
      }
      const loadedPreset = presetSaveCoordinator.hydrate(unmarshalPreset(preset), hydration)
      activePresetRef.current = loadedPreset
      setActivePreset(loadedPreset)
      setIsLoading(false)
    }).catch((err) => {
      presetSaveCoordinator.cancelHydration(hydration)
      if (cancelled) return
      if (err instanceof StalePresetHydrationError) {
        setIsLoading(false)
        return
      }
      // Retroactive cleanup: if the persisted active preset id points at a row
      // that no longer exists (legacy deletions that didn't cascade), clear it
      // so generation doesn't keep 400ing on a ghost id.
      if (err instanceof ApiError && err.status === 404) {
        presetSaveCoordinator.remove(activeLoomPresetId)
        if (useStore.getState().activeLoomPresetId === activeLoomPresetId) {
          activePresetRef.current = null
          useStore.getState().setActiveLoomPreset(null)
          setActivePreset(null)
        }
        setIsLoading(false)
        return
      }
      console.warn('[LoomBuilder] Failed to load preset:', err)
      setError(err.message)
      setIsLoading(false)
    })
    return () => {
      cancelled = true
      presetSaveCoordinator.cancelHydration(hydration)
    }
  }, [activeLoomPresetId])


  // Refresh registry from API
  const refreshRegistry = useCallback(async () => {
    try {
      const result = await presetApi.listRegistry({ provider: 'loom', limit: 200 })
      const registry = Object.fromEntries(
        result.data.map((p) => [
          p.id,
          {
            name: p.name,
            blockCount: p.block_count,
            updatedAt: p.updated_at,
            isDefault: false,
          },
        ])
      )
      setLoomRegistry(registry)
    } catch (err) {
      console.warn('[LoomBuilder] Failed to refresh registry:', err)
    }
  }, [presetApi, setLoomRegistry])

  // Load registry on mount. The registry is kept in the store across panel
  // open/close cycles, and every mutation path below (create/delete/rename/
  // duplicate/save) already calls `refreshRegistry()` itself, so skip the
  // redundant mount-time fetch when the cache is populated.
  useEffect(() => {
    if (Object.keys(loomRegistry).length > 0) return
    refreshRegistry()
  }, [loomRegistry, refreshRegistry])

  // Create a new preset
  const createPreset = useCallback(async (name: string, description?: string) => {
    const selection = beginActiveLoomPresetSelection()
    setIsLoading(true)
    try {
      const loom = createNewLoomPreset(name, description)
      const created = await presetApi.create(marshalPreset(loom))
      const newLoom = presetSaveCoordinator.hydrate(unmarshalPreset(created))
      await refreshRegistry()
      if (await selection.transition(created.id)) {
        activePresetRef.current = newLoom
        setActivePreset(newLoom)
      }
      return newLoom
    } catch (err: any) {
      selection.cancel()
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [presetApi, presetSaveCoordinator, refreshRegistry])

  const flushPendingPreset = useCallback(async (): Promise<void> => {
    const presetId = activePresetRef.current?.id ?? activeLoomPresetId
    if (!presetId) return
    await flushPresetForGeneration(presetId)
  }, [activeLoomPresetId])

  // Keep this mounted editor synchronized when another owner (the prompt
  // variable modal or a Spindle scoped helper) updates the shared draft.
  useEffect(() => {
    if (!activeLoomPresetId) return
    return presetSaveCoordinator.subscribe(activeLoomPresetId, (preset) => {
      if (useStore.getState().activeLoomPresetId !== preset.id) return
      activePresetRef.current = preset
      setActivePreset(preset)
      setIsLoading(false)
    })
  }, [activeLoomPresetId])

  // Flush pending save on unmount.
  useEffect(() => () => {
    void flushPendingPreset()
  }, [flushPendingPreset])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handlePageExit = () => {
      const presetId = activePresetRef.current?.id
      if (presetId) presetSaveCoordinator.flushBestEffort(presetId)
    }
    window.addEventListener('beforeunload', handlePageExit)
    window.addEventListener('pagehide', handlePageExit)

    return () => {
      window.removeEventListener('beforeunload', handlePageExit)
      window.removeEventListener('pagehide', handlePageExit)
    }
  }, [])

  // BFCache restoration keeps React mounted, so re-read and field-rebase the
  // active preset instead of replaying a stale full-document snapshot.
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      const presetId = activePresetRef.current?.id
      if (!presetId) return
      const hydration = presetSaveCoordinator.beginHydration(presetId, 'loom-editor')
    void presetApi.get(presetId).then((preset) => {
        if (useStore.getState().activeLoomPresetId !== presetId) {
          presetSaveCoordinator.cancelHydration(hydration)
          return
        }
        const restored = presetSaveCoordinator.hydrate(unmarshalPreset(preset), hydration)
        if (activePresetRef.current?.id !== restored.id) return
        activePresetRef.current = restored
        setActivePreset(restored)
      }).catch((err) => {
        presetSaveCoordinator.cancelHydration(hydration)
        if (err instanceof StalePresetHydrationError) return
        console.warn('[LoomBuilder] Failed to rebase restored preset:', err)
      })
    }
    window.addEventListener('pageshow', handlePageShow)
    return () => { window.removeEventListener('pageshow', handlePageShow) }
  }, [])

  // Flush the prior draft before changing the editor target so extension and
  // native edits cannot be delivered to the wrong preset or lost on unmount.
  // All supported manual and automatic selection paths use the same
  // coordinator so the departing draft is flushed before a new id is exposed.
  const selectPreset = useCallback(async (presetId: string | null) => {
    await transitionActiveLoomPreset(presetId)
  }, [])

  // Read activePreset through a ref so saveStructure stays reference-stable
  // across renders. The coordinator remains the authoritative draft owner.
  activePresetRef.current = activePreset?.id === activeLoomPresetId ? activePreset : null

  const updateActivePreset = useCallback((
    updater: (current: LoomPreset) => LoomPreset,
    immediate = false,
  ) => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) return
    const updated = presetSaveCoordinator.mutate(
      current.id,
      current,
      updater,
      { immediate },
    )
    activePresetRef.current = updated
    setActivePreset(updated)
    if (immediate) {
      void presetSaveCoordinator.flush(updated.id).catch((err) => {
        console.warn('[LoomBuilder] Immediate preset save failed:', err)
      })
    }
  }, [])

  const saveStructure = useCallback(async (
    blocks: PromptBlock[],
  ): Promise<boolean> => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) return false
    try {
      const normalizedBlocks = normalizeCategoryBlockState(blocks)
      validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: current.blocks })
      let promptVariables: PromptVariableValues
      try {
        // A strict check distinguishes a clean prior schema from a legacy one.
        // Legacy values are pruned by tolerant name/schema union so native edits
        // do not re-run strict validation against the anomaly they preserve.
        validatePromptVariableSchema(current.blocks)
        promptVariables = reconcilePromptVariableValues(
          current.promptVariables,
          current.blocks,
          normalizedBlocks,
          { legacyBaseline: current.blocks },
        )
      } catch {
        promptVariables = pruneOrphanPromptVariables(current.promptVariables, normalizedBlocks)
      }
      setRuntimePresetProfile((profile) => profile?.presetId === current.id
        ? {
            presetId: current.id,
            blockStates: Object.fromEntries(normalizedBlocks.map((block) => [block.id, block.enabled])),
            promptVariables: profile.promptVariables,
          }
        : profile)
      const updated = presetSaveCoordinator.mutate(
        current.id,
        current,
        (draft) => ({ ...draft, blocks: normalizedBlocks, promptVariables }),
        { immediate: true },
      )
      activePresetRef.current = updated
      setActivePreset(updated)
      await presetSaveCoordinator.flush(updated.id)
      await refreshRegistry()
      return true
    } catch (err) {
      console.warn('[LoomBuilder] Failed to save preset structure:', err)
      return false
    }
  }, [refreshRegistry])

  // Save blocks
  const saveBlocks = useCallback(async (blocks: PromptBlock[]) => {
    await saveStructure(blocks)
  }, [saveStructure])
  const saveAgenticRuntime = useCallback(async (
    draft: AgenticRuntimeSaveDraft,
    promptOrder: PromptBlock[],
    expectedPresetRevision?: number,
  ): Promise<SaveAgenticRuntimeEditorResult> => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) {
      throw new Error('No active preset')
    }
    await presetSaveCoordinator.flush(current.id)
    const flushed = presetSaveCoordinator.getDraft(current.id) ?? activePresetRef.current ?? current
    if (useStore.getState().activeLoomPresetId !== flushed.id) throw new Error('No active preset')
    activePresetRef.current = flushed
    setActivePreset(flushed)
    const normalizedBlocks = normalizeCategoryBlockState(promptOrder)
    if (
      expectedPresetRevision !== undefined
      && (flushed.cacheRevision ?? 0) !== expectedPresetRevision
      && JSON.stringify(normalizedBlocks) !== JSON.stringify(flushed.blocks)
    ) {
      throw new ApiError(409, 'Conflict', { code: 'PRESET_REVISION_CONFLICT' })
    }
    validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: flushed.blocks })
    const editorProjection = await agenticRuntimeApi.getEditor(flushed.id)
    const result = await agenticRuntimeApi.saveEditor(flushed.id, {
      ...draft,
      expectedPresetRevision: flushed.cacheRevision ?? 0,
      expectedConfigRevision: editorProjection.configRevision,
      promptOrder: normalizedBlocks,
    })
    const refreshed = presetSaveCoordinator.hydrate(unmarshalPreset(result.preset))
    if (useStore.getState().activeLoomPresetId !== refreshed.id) return result
    activePresetRef.current = refreshed
    setActivePreset(refreshed)
    await refreshRegistry()
    return result
  }, [refreshRegistry])

  const saveLoomValue = useCallback(async (
    blocks: PromptBlock[],
    promptVariables: PromptVariableValues,
    privateBlockChange?: LoomPrivateBlockChange,
  ) => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) return
    const normalizedBlocks = normalizeCategoryBlockState(blocks)
    validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: current.blocks })
    const nextBlocks = applyPrivateBlockChange(current.blocks, normalizedBlocks, privateBlockChange)
    setRuntimePresetProfile((profile) => profile?.presetId === current.id
      ? {
          presetId: current.id,
          blockStates: Object.fromEntries(nextBlocks.map((block) => [block.id, block.enabled])),
          promptVariables,
        }
      : profile)
    const updated = presetSaveCoordinator.mutate(
      current.id,
      current,
      (draft) => ({
        ...draft,
        blocks: nextBlocks,
        promptVariables,
      }),
      { immediate: true },
    )
    activePresetRef.current = updated
    setActivePreset(updated)
    try {
      await presetSaveCoordinator.flush(updated.id)
      await refreshRegistry()
    } catch (err) {
      console.warn('[LoomBuilder] Failed to save Loom editor value:', err)
      throw err
    }
  }, [refreshRegistry])

  // Rename a preset
  const renamePreset = useCallback(async (presetId: string, newName: string) => {
    let current = presetId === activePresetRef.current?.id ? activePresetRef.current : null
    if (!current) {
      const hydration = presetSaveCoordinator.beginHydration(presetId, 'preset-rename')
      try {
        current = presetSaveCoordinator.hydrate(unmarshalPreset(await presetApi.get(presetId)), hydration)
      } catch (error) {
        presetSaveCoordinator.cancelHydration(hydration)
        throw error
      }
    }
    const updated = presetSaveCoordinator.mutate(
      presetId,
      current,
      (draft) => ({ ...draft, name: newName }),
      { immediate: true },
    )
    if (updated.id === activePresetRef.current?.id) {
      activePresetRef.current = updated
      setActivePreset(updated)
    }
    await presetSaveCoordinator.flush(presetId)
    await refreshRegistry()
  }, [refreshRegistry])

  // Delete a preset
  const deletePreset = useCallback(async (presetId: string) => {
    await flushPresetForGeneration(presetId)
    await presetApi.delete(presetId)
    presetSaveCoordinator.remove(presetId)
    await refreshRegistry()
    // A later coordinated selection may have committed while deletion was in
    // flight. Only clear the live selection when it still names this row.
    if (useStore.getState().activeLoomPresetId === presetId) {
      activePresetRef.current = null
      useStore.getState().setActiveLoomPreset(null)
      setActivePreset(null)
    }
    // Refresh connection profiles so any stale preset_id references (the
    // backend's FK nulls them out on delete) drop from the store.
    try {
      const res = await connectionsApi.list({ limit: 100 })
      useStore.getState().setProfiles(res.data)
    } catch {
      // non-fatal — store just keeps the previous profile list
    }
  }, [refreshRegistry])

  // Duplicate a preset through the authenticated server operation. The
  // endpoint copies normalized Agentic configuration, authored cognition
  // envelope, bindings, and regex companions transactionally; reconstructing
  // a Loom object locally would silently drop those fields.
  const duplicatePreset = useCallback(async (presetId: string, newName: string) => {
    const selection = beginActiveLoomPresetSelection()
    setIsLoading(true)
    try {
      await flushPresetForGeneration(presetId)
      const duplicated = await presetApi.duplicate(presetId, newName)
      const newLoom = presetSaveCoordinator.hydrate(unmarshalPreset(duplicated.preset))
      await refreshRegistry()
      if (await selection.transition(duplicated.preset.id)) {
        activePresetRef.current = newLoom
        setActivePreset(newLoom)
      }
      return newLoom
    } catch (err: unknown) {
      selection.cancel()
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [flushPresetForGeneration, presetApi, presetSaveCoordinator, refreshRegistry])

  // Block manipulation helpers
  const addBlock = useCallback((block: PromptBlock, index?: number) => {
    const current = effectiveActivePresetRef.current
    if (!current) return
    const blocks = [...current.blocks]
    if (typeof index === 'number') {
      blocks.splice(index, 0, block)
    } else {
      blocks.push(block)
    }
    saveBlocks(blocks)
  }, [saveBlocks])

  const removeBlock = useCallback(async (
    blockId: string,
    replacement?: { blocks: PromptBlock[]; promptVariables?: PromptVariableValues },
  ) => {
    const current = effectiveActivePresetRef.current
    if (!current) return
    const sourceBlocks = replacement?.blocks ?? current.blocks
    const blocks = sourceBlocks
      .filter((block) => block.id !== blockId)
      .map((block) => block.group === blockId ? { ...block, group: null } : block)
    const promptVariables = { ...(replacement?.promptVariables ?? current.promptVariables ?? {}) }
    delete promptVariables[blockId]
    await saveLoomValue(blocks, promptVariables)
  }, [saveLoomValue])

  const updateBlock = useCallback((blockId: string, updates: Partial<PromptBlock>): boolean => {
    const current = effectiveActivePresetRef.current
    if (!current) return false
    const blocks = current.blocks.map(b => (
      b.id === blockId ? { ...b, ...updates } : b
    ))
    let normalizedBlocks: PromptBlock[]
    try {
      normalizedBlocks = normalizeCategoryBlockState(blocks)
      validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: current.blocks })
    } catch {
      return false
    }
    void saveBlocks(normalizedBlocks).catch(() => {})
    return true
  }, [saveBlocks])

  const toggleBlock = useCallback((blockId: string) => {
    const current = effectiveActivePresetRef.current
    if (!current) return
    const blocks = toggleBlockWithCategoryRules(current.blocks, blockId)
    saveBlocks(blocks)
  }, [saveBlocks])

  // Blanket category toggle: disable captures each child's enabled state on
  // the category block; enable restores that exact snapshot.
  const toggleCategoryChildren = useCallback((categoryId: string) => {
    const current = effectiveActivePresetRef.current
    if (!current) return
    const blocks = toggleCategoryWithChildren(current.blocks, categoryId)
    saveBlocks(blocks)
  }, [saveBlocks])

  /**
   * Move a variable definition from one block to another, carrying its saved
   * value bucket along. Def and value travel together in a single
   * saveLoomValue so the backend's orphan pruning never sees the value
   * stranded under the old block. A placement binding on the source block
   * that pointed at the moved selector is dropped (the same cleanup
   * cleanPlacementBinding performs on save). Returns false -- without
   * saving -- when the move would create a duplicate name in the target.
   */
  const movePromptVariable = useCallback((
    sourceBlockId: string,
    variable: PromptVariableDef,
    targetBlockId: string,
  ): boolean => {
    const current = effectiveActivePresetRef.current
    if (!current || sourceBlockId === targetBlockId) return false
    const sourceBlock = current.blocks.find((b) => b.id === sourceBlockId)
    const targetBlock = current.blocks.find((b) => b.id === targetBlockId)
    if (!sourceBlock || !targetBlock) return false

    const name = variable.name?.trim()
    if (!name) return false
    if ((targetBlock.variables ?? []).some((v) => v.name?.trim() === name)) return false

    const blocks = current.blocks.map((b) => {
      if (b.id === sourceBlockId) {
        const next: Partial<PromptBlock> = {
          variables: (b.variables ?? []).filter((v) => v.id !== variable.id),
        }
        if (b.placementBinding?.variableId === variable.id) next.placementBinding = undefined
        return { ...b, ...next }
      }
      if (b.id === targetBlockId) {
        return { ...b, variables: [...(b.variables ?? []), variable] }
      }
      return b
    })

    const values = current.promptVariables ?? {}
    const sourceBucket = values[sourceBlockId]
    const savedName = (sourceBlock.variables ?? []).find((v) => v.id === variable.id)?.name?.trim()
    let nextValues = values
    if (sourceBucket) {
      const valueKey = savedName && savedName in sourceBucket
        ? savedName
        : name in sourceBucket
          ? name
          : null
      if (valueKey !== null) {
        const nextSource = { ...sourceBucket }
        const moved = nextSource[valueKey]
        delete nextSource[valueKey]
        nextValues = {
          ...values,
          [sourceBlockId]: nextSource,
          [targetBlockId]: { ...(values[targetBlockId] ?? {}), [name]: moved },
        }
      }
    }

    let normalizedBlocks: PromptBlock[]
    try {
      normalizedBlocks = normalizeCategoryBlockState(blocks)
      validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: current.blocks })
    } catch {
      return false
    }
    void saveLoomValue(normalizedBlocks, nextValues).catch(() => {})
    return true
  }, [saveLoomValue])

  const reorderBlocks = useCallback((fromIndex: number, toIndex: number) => {
    const current = effectiveActivePresetRef.current
    if (!current) return
    const blocks = [...current.blocks]
    const [moved] = blocks.splice(fromIndex, 1)
    blocks.splice(toIndex, 0, moved)
    saveBlocks(blocks)
  }, [saveBlocks])

  // Save sampler overrides — immediate state update, debounced API save
  const saveSamplerOverrides = useCallback((overrides: any) => {
    updateActivePreset((current) => ({
      ...current,
      samplerOverrides: { ...overrides },
      updatedAt: Date.now(),
    }))
  }, [updateActivePreset])

  const savePromptBehavior = useCallback((updates: Record<string, any>) => {
    updateActivePreset((current) => ({
      ...current,
      promptBehavior: { ...(current.promptBehavior || DEFAULT_PROMPT_BEHAVIOR), ...updates },
      updatedAt: Date.now(),
    }))
  }, [updateActivePreset])

  const saveCompletionSettings = useCallback((updates: Record<string, any>) => {
    updateActivePreset((current) => ({
      ...current,
      completionSettings: { ...(current.completionSettings || DEFAULT_COMPLETION_SETTINGS), ...updates },
      updatedAt: Date.now(),
    }))
  }, [updateActivePreset])

  const saveAdvancedSettings = useCallback((updates: Record<string, any>) => {
    updateActivePreset((current) => ({
      ...current,
      advancedSettings: { ...(current.advancedSettings || DEFAULT_ADVANCED_SETTINGS), ...updates },
      updatedAt: Date.now(),
    }))
  }, [updateActivePreset])

  // Persist the full promptVariables map in one shot. Used by the end-user
  // "Configure Prompt Variables" modal — saves are infrequent and user-driven
  // so we bypass the debouncer and wait for the network round-trip so errors
  // surface immediately.
  const savePromptVariableValues = useCallback(async (values: PromptVariableValues) => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) return
    const updated = presetSaveCoordinator.mutate(
      current.id,
      current,
      (draft) => ({ ...draft, promptVariables: values }),
      { immediate: true },
    )
    activePresetRef.current = updated
    setActivePreset(updated)
    try {
      await presetSaveCoordinator.flush(updated.id)
    } catch (err) {
      console.warn('[LoomBuilder] Failed to save prompt variable values:', err)
      throw err
    }
  }, [])

  const persistImportedPreset = useCallback(async (payload: unknown, fileName?: string) => {
    const selection = beginActiveLoomPresetSelection()
    let importedPresetId: string | null = null
    let portableImportCommitted = false
    setIsLoading(true)
    try {
      const fallbackName = fileName?.replace(/\.json$/i, '') || 'Imported Preset'
      const payloadRecord = isObjectRecord(payload) ? payload : null
      const agentRuntime = extractPortableAgenticRuntimeEnvelope(payload)
      portableImportCommitted = agentRuntime !== null
      const sourceRecord = payloadRecord?.type === 'lumiverse_preset'
        && isObjectRecord(payloadRecord.preset)
        ? payloadRecord.preset
        : payloadRecord
      const extensions = sourceRecord && isObjectRecord(sourceRecord.extensions)
        ? sourceRecord.extensions
        : null
      const embeddedRegex = Array.isArray(extensions?.regex_scripts)
        ? extensions.regex_scripts
        : sourceRecord && Array.isArray(sourceRecord.regex_scripts)
          ? sourceRecord.regex_scripts
          : null
      const loom = coerceImportedLoomPreset(payload, fallbackName)
      const presetInput = marshalPreset(loom)
      const portablePresetInput = embeddedRegex === null
        ? presetInput
        : {
            ...presetInput,
            regex_scripts: embeddedRegex as unknown as readonly Record<string, unknown>[],
          }
      const legacyPortableConfig = agentRuntime === null && loom.agentConfig
        ? toPortableAgentConfigV1(loom.agentConfig)
        : null
      let created = agentRuntime
        ? (await presetApi.importPortable({ preset: portablePresetInput, agentRuntime })).preset
        : legacyPortableConfig
          ? (await presetApi.importPortableAgentConfig({
              ...portablePresetInput,
              agent_config: legacyPortableConfig,
            })).preset
          : await presetApi.create(portablePresetInput)
      importedPresetId = created.id

      if (agentRuntime) {
        const editor = await agenticRuntimeApi.getEditor(created.id)
        created = {
          ...created,
          agent_config: editor.config,
          agent_config_review: editor.review,
          agent_context_pack_selections: editor.contextPackSelections.map((selection) => ({
            ...selection,
            label: typeof selection.label === 'string' && selection.label.length > 0
              ? selection.label
              : selection.packId,
            revisionLabel: typeof selection.revisionLabel === 'string' && selection.revisionLabel.length > 0
              ? selection.revisionLabel
              : String(selection.revision),
          })),
          agent_context_rules: editor.contextRules,
          agent_task_templates: editor.taskTemplates,
        }

      }

      const newLoom = presetSaveCoordinator.hydrate(unmarshalPreset(created))
      await refreshRegistry()
      if (!(await selection.transition(created.id))) {
        throw new Error('Imported preset selection was superseded')
      }
      activePresetRef.current = newLoom
      setActivePreset(newLoom)


      return newLoom
    } catch (err: unknown) {
      // Portable import is one backend transaction that also owns newly
      // imported context-pack copies. Never delete that preset after the
      // transaction has committed; a navigation/editor hydration failure must
      // preserve the completed import and its canonical context data.
      if (shouldRollbackImportedPreset(importedPresetId, portableImportCommitted)) {
        try {
          await presetApi.delete(importedPresetId)
        } catch {
          // Cleanup is best-effort for the legacy create-only path.
        }
      }
      selection.cancel()
      setError(err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [presetApi, presetSaveCoordinator, refreshRegistry])

  // Import from legacy preset JSON
  const importFromST = useCallback(async (stData: any, fileName: string) => {
    if (detectImportedPresetKind(stData) === 'loom') {
      toast.warning(i18n.t('panels.loomBuilder.toast.importLoomPresetInstead'), { title: i18n.t('panels.loomBuilder.toast.presetImportTitle') })
      return null
    }
    return persistImportedPreset(stData, fileName)
  }, [persistImportedPreset])

  // Import from file (internal JSON format)
  const importFromFile = useCallback(async (jsonData: any, fileName?: string) => {
    if (detectImportedPresetKind(jsonData) === 'legacy') {
      toast.warning(i18n.t('panels.loomBuilder.toast.importLegacyPresetInstead'), { title: i18n.t('panels.loomBuilder.toast.presetImportTitle') })
      return null
    }
    return persistImportedPreset(jsonData, fileName)
  }, [persistImportedPreset])

  // Export internal JSON. The runtime envelope is fetched from the server
  // after all pending Loom saves settle, so prompt revisions and runtime
  // cognition/context snapshots cannot drift across the export boundary.
  const exportInternal = useCallback(async () => {
    const current = activePresetRef.current ?? activePreset
    if (!current) return null
    const maxAttempts = 2
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await flushPendingPreset()
      const persistedBefore = await presetApi.get(current.id)
      const envelopeBefore = await presetApi.getPortableAgentRuntime(current.id)
      const regexBefore = await regexApi.exportScripts(undefined, { preset_id: current.id })
      const persistedAfter = await presetApi.get(current.id)
      const envelopeAfter = await presetApi.getPortableAgentRuntime(current.id)
      const regexAfter = await regexApi.exportScripts(undefined, { preset_id: current.id })
      const presetStable = persistedBefore.cache_revision === persistedAfter.cache_revision
        && persistedBefore.updated_at === persistedAfter.updated_at
      const envelopeStable = portableSnapshotKey(envelopeBefore) === portableSnapshotKey(envelopeAfter)
      const regexBeforePortable = stripPortableRegexOwnership(regexBefore.scripts)
      const regexAfterPortable = stripPortableRegexOwnership(regexAfter.scripts)
      const regexStable = portableSnapshotKey(regexBeforePortable) === portableSnapshotKey(regexAfterPortable)
      if (!presetStable || !envelopeStable || !regexStable) {
        if (attempt + 1 < maxAttempts) continue
        throw new Error('Portable export changed while it was being read; please retry.')
      }
      const exportPreset = createPortableLoomExportPayload(unmarshalPreset(persistedAfter), envelopeAfter)
      if (regexAfterPortable.length === 0) return exportPreset
      const extensions = isObjectRecord(exportPreset.extensions)
        ? { ...exportPreset.extensions }
        : {}
      return {
        ...exportPreset,
        extensions: {
          ...extensions,
          regex_scripts: regexAfterPortable,
        },
      }
    }
    return null
  }, [activePreset, flushPendingPreset])

  // Export as legacy (SillyTavern) JSON
  const exportLegacy = useCallback(() => {
    if (!activePreset) return null
    return exportToSTPreset(sanitizeLumiHubSealedBlocksForExport(activePreset))
  }, [activePreset])

  // Available macros for the inserter — fetched from API, with local fallback
  const [availableMacros, setAvailableMacros] = useState<MacroGroup[]>(() => getAvailableMacros())

  const refreshMacros = useCallback(() => {
    getMacroCatalog()
      .then((catalog) => {
        const groups: MacroGroup[] = catalog.categories.map((c) => ({
          category: c.category,
          macros: c.macros.map((m) => ({
            name: m.name,
            syntax: m.syntax,
            description: m.description,
            args: m.args,
            returns: m.returns,
          })),
        }))
        // Merge: API macros first, then any local-only groups not in the API response
        const apiCategoryNames = new Set(groups.map((g) => g.category))
        const localOnly = getAvailableMacros().filter((g) => !apiCategoryNames.has(g.category))
        setAvailableMacros([...groups, ...localOnly])
      })
      .catch(() => {
        // Keep local fallback on API failure
      })
  }, [])

  useEffect(() => { refreshMacros() }, [refreshMacros])

  // Connection profile detection from store
  const connectionProfile = useMemo<LoomConnectionProfile>(() => {
    const profile = profiles.find((p) => p.id === activeProfileId && p.review_required !== true)
    if (profile) {
      return {
        mainApi: 'openai',
        source: profile.provider,
        model: profile.model,
        supportedParams: detectSupportedParamsFromProviders(profile.provider, providers),
      }
    }
    return {
      mainApi: 'unknown',
      source: null,
      model: null,
      supportedParams: detectSupportedParamsFromProviders(null, providers),
    }
  }, [activeProfileId, profiles, providers])

  const refreshConnectionProfile = useCallback(() => {
    // Connection profile is derived from store, so no manual refresh is needed.
  }, [])

  return {
    // State
    registry: loomRegistry,
    activePresetId: activeLoomPresetId,
    activePreset: effectiveActivePreset?.id === activeLoomPresetId ? effectiveActivePreset : null,
    isLoading,
    error,
    availableMacros,
    refreshMacros,

    // Connection profile
    connectionProfile,
    refreshConnectionProfile,

    // Sampler constants
    SAMPLER_PARAMS,
    DEFAULT_SAMPLER_OVERRIDES,
    DEFAULT_PROMPT_BEHAVIOR,
    DEFAULT_COMPLETION_SETTINGS,
    DEFAULT_ADVANCED_SETTINGS,

    // Preset CRUD
    createPreset,
    selectPreset,
    saveBlocks,
    saveLoomValue,
    saveAgenticRuntime,
    deletePreset,
    duplicatePreset,
    renamePreset,
    refreshRegistry,

    // Block manipulation
    addBlock,
    removeBlock,
    updateBlock,
    toggleBlock,
    toggleCategoryChildren,
    reorderBlocks,
    movePromptVariable,

    // Sampler settings
    saveSamplerOverrides,

    // Prompt behavior, completion, advanced
    savePromptBehavior,
    saveCompletionSettings,
    saveAdvancedSettings,
    savePromptVariableValues,
    applyRuntimeBlockProfile,
    updatePresetDraft: updateActivePreset,
    flushPresetDraft: flushPendingPreset,

    // Import/Export
    importFromFile,
    importFromST,
    exportInternal,
    exportLegacy,
  }
}
