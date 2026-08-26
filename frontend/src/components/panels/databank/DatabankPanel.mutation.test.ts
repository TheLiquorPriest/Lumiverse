import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./DatabankPanel.tsx', import.meta.url)).text()

function sliceBetween(startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle)
  const end = source.indexOf(endNeedle, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('DatabankPanel mutation error wiring', () => {
  test('create mints a token and clears only when current', () => {
    const body = sliceBetween('const handleCreate = useCallback(', '\n  // ── Delete bank')
    expect(body).toContain('const started = mintMutation()')
    expect(body).toContain('clearMutationErrorIfCurrent(started)')
    expect(body).toContain('reportMutationError(started, e.message)')
    expect(body).not.toContain('setError(e.message)')
  })

  test('rename reports failure without writing the attempted title', () => {
    const body = sliceBetween('const handleRenameDoc = useCallback(', '\n  // ── Drag and drop')
    expect(body).toContain('const started = mintMutation()')
    expect(body).toContain("t('databankPanel.renameDocFailed')")
    expect(body).toContain('reportMutationError(started,')
    expect(body).not.toContain('/* ignore */')
    expect(body).not.toContain('updateDatabankDocument(docId, { name: newName')
  })

  test('committed scope reset mints null; Keep Editing does not', () => {
    const reset = sliceBetween(
      'A selected bank belongs to the scope/context in which it was chosen.',
      'DATABANK_DELETED removes the bank',
    )
    expect(reset).toContain('pendingContextResetRef.current = true')
    expect(reset).toContain('setDiscardConfirmOpen(true)')
    expect(reset).toContain('return')
    expect(reset).toContain('clearMutationErrorIfCurrent(mintMutation())')

    const dirtyBranch = reset.slice(
      reset.indexOf('if (editingDirtyRef.current && editingDocIdRef.current)'),
      reset.indexOf('pendingContextResetRef.current = false'),
    )
    expect(dirtyBranch).not.toContain('mintMutation()')
    expect(dirtyBranch).not.toContain('clearMutationErrorIfCurrent')

    const flush = sliceBetween('const flushPendingContextReset = useCallback(', 'const settlePendingContextReset')
    expect(flush).toContain('clearMutationErrorIfCurrent(mintMutation())')

    const keep = sliceBetween('const settlePendingContextReset = useCallback(', 'const loadEditorContent')
    expect(keep).not.toContain('mintMutation')
    expect(keep).not.toContain('clearMutationErrorIfCurrent')
    expect(keep).toContain('pendingContextResetRef.current = false')
  })

  test('loadDocs with no bank after committed reset clears a stale banner', () => {
    const body = sliceBetween('const loadDocs = useCallback(', '\n  useEffect(() => {\n    void loadDocs()')
    expect(body).toContain('if (!selectedDatabankId)')
    expect(body).toContain('if (!editingDocIdRef.current) clearMutationErrorIfCurrent(started)')
  })

})
