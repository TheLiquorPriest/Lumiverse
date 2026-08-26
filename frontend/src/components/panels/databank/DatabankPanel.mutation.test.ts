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
    expect(body).toContain("reportMutationError(started, t('databankPanel.renameDocFailed'))")
    expect(body).not.toContain('e?.body?.error')
    expect(body).not.toContain('e?.message')
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
    expect(remote).toContain('classifyNullTransition(previous)')
    expect(remote).toContain('lastSelectedBankIdRef.current')
    expect(remote).not.toContain('committedContextResetRef')

    const body = sliceBetween('const loadDocs = useCallback(', '\n  useEffect(() => {\n    void loadDocs()')
    expect(body).toContain('if (mutationGateRef.current.holdingRemoteRemoval()) return')
    expect(body).toContain("reportMutationError(started, t('databankPanel.remoteDocumentRemoved'), 'remote-removal')")
    const noBank = body.slice(body.indexOf('if (!selectedDatabankId)'), body.indexOf('const switchedBank'))
    expect(noBank).toContain('if (mutationGateRef.current.holdingRemoteRemoval()) return')
    expect(noBank).not.toContain('mintMutation()')
  })

  test('local delete and empty selector never publish remoteDatabankRemoved', () => {
    const del = sliceBetween('const handleDeleteBank = useCallback(', '\n  // ── Update bank details')
    expect(del).toContain('beginLocalDeselect(deletedId)')
    expect(del.indexOf('beginLocalDeselect(deletedId)')).toBeLessThan(del.indexOf('setSelectedDatabankId(null)'))
    expect(del).toContain('clearMutationErrorIfCurrent(started)')
    expect(del).not.toContain('remoteDatabankRemoved')

    const select = sliceBetween('{/* Bank selector bar */}', '<option value="">{t(\'databankPanel.selectDatabank\')}</option>')
    expect(select).toContain('if (!next)')
    expect(select).toContain('beginLocalDeselect(selectedDatabankId)')
    expect(select).toContain('localDeselectRef.current.clear()')
    expect(select).toContain('clearMutationErrorIfCurrent(mintMutation())')
    expect(select).not.toContain('remoteDatabankRemoved')

    const remote = sliceBetween(
      'DATABANK_DELETED removes the bank and nulls selection.',
      'const loadDocs = useCallback(',
    )
    expect(remote).toContain("classifyNullTransition(previous) === 'local'")
    expect(remote).toContain("reportMutationError(mintMutation(), t('databankPanel.remoteDatabankRemoved'), 'remote-removal')")
    expect(remote.indexOf("classifyNullTransition(previous) === 'local'")).toBeLessThan(
      remote.indexOf("reportMutationError(mintMutation(), t('databankPanel.remoteDatabankRemoved'), 'remote-removal')"),
    )
  })

  test('deferred local delete preserves a later other-bank selection', () => {
    const del = sliceBetween('const handleDeleteBank = useCallback(', '\n  // ── Update bank details')
    expect(del).toContain('const deletedId = selectedDatabankIdRef.current')
    expect(del.indexOf('await databankApi.delete(deletedId)')).toBeGreaterThan(del.indexOf('const deletedId = selectedDatabankIdRef.current'))
    expect(del).toContain('const stillSelected = selectedDatabankIdRef.current === deletedId')
    expect(del.indexOf('await databankApi.delete(deletedId)')).toBeLessThan(del.indexOf('const stillSelected'))
    expect(del).toContain('if (stillSelected)')
    expect(del).toContain('beginLocalDeselect(deletedId)')
    expect(del).toContain('setSelectedDatabankId(null)')
    expect(del).toContain('localDeselectRef.current.clear()')
    expect(del.indexOf('if (stillSelected)')).toBeLessThan(del.indexOf('setSelectedDatabankId(null)'))
    expect(del.indexOf('} else {')).toBeLessThan(del.indexOf('localDeselectRef.current.clear()'))
    expect(del).not.toContain('remoteDatabankRemoved')
    expect(del).not.toContain('await databankApi.delete(selectedDatabankId)')

  })


  test('delete document reports localized copy not API body', () => {
    const body = sliceBetween('const handleDeleteDoc = useCallback(', '\n  const handleReprocessDoc')
    expect(body).toContain("reportMutationError(started, t('databankPanel.deleteDocFailed'))")
    expect(body).not.toContain('e?.body?.error')
    expect(body).not.toContain('e?.message')
  })




})
