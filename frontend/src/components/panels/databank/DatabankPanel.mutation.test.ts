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

  test('remote bank delete publishes current removal and follow-on loadDocs does not mint or clear', () => {
    const remote = sliceBetween(
      'DATABANK_DELETED removes the bank and nulls selection.',
      'const loadDocs = useCallback(',
    )
    expect(remote).toContain("reportMutationError(mintMutation(), t('databankPanel.remoteDatabankRemoved'), 'remote-removal')")
    expect(remote).toContain('committedContextResetRef.current')
    expect(remote).toContain('lastSelectedBankIdRef.current')

    const body = sliceBetween('const loadDocs = useCallback(', '\n  useEffect(() => {\n    void loadDocs()')
    expect(body).toContain('if (mutationGateRef.current.holdingRemoteRemoval()) return')
    expect(body).toContain("reportMutationError(started, t('databankPanel.remoteDocumentRemoved'), 'remote-removal')")
    const noBank = body.slice(body.indexOf('if (!selectedDatabankId)'), body.indexOf('if (mutationGateRef.current.holdingRemoteRemoval()) {'))
    expect(noBank).toContain('if (mutationGateRef.current.holdingRemoteRemoval()) return')
    expect(noBank).not.toMatch(/mintMutation\(\)[\s\S]*holdingRemoteRemoval/)
  })

  test('local delete and empty selector never publish remoteDatabankRemoved', () => {
    const del = sliceBetween('const handleDeleteBank = useCallback(', '\n  // ── Update bank details')
    expect(del).toContain('beginLocalDeselect()')
    expect(del.indexOf('beginLocalDeselect()')).toBeLessThan(del.indexOf('removeDatabank(selectedDatabankId)'))
    expect(del).toContain('clearMutationErrorIfCurrent(started)')
    expect(del).not.toContain('remoteDatabankRemoved')

    const select = sliceBetween('{/* Bank selector bar */}', '<option value="">{t(\'databankPanel.selectDatabank\')}</option>')
    expect(select).toContain('if (!next)')
    expect(select).toContain('beginLocalDeselect()')
    expect(select).toContain('clearMutationErrorIfCurrent(mintMutation())')
    expect(select).not.toContain('remoteDatabankRemoved')

    const remote = sliceBetween(
      'DATABANK_DELETED removes the bank and nulls selection.',
      'const loadDocs = useCallback(',
    )
    expect(remote).toContain('if (committedContextResetRef.current)')
    expect(remote).toContain("reportMutationError(mintMutation(), t('databankPanel.remoteDatabankRemoved'), 'remote-removal')")
    expect(remote.indexOf('if (committedContextResetRef.current)')).toBeLessThan(
      remote.indexOf("reportMutationError(mintMutation(), t('databankPanel.remoteDatabankRemoved'), 'remote-removal')"),
    )
  })



})
