import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./DatabankPanel.tsx', import.meta.url)).text()

describe('DatabankPanel mutation error contract', () => {
  test('rename reports a visible failure and keeps the store title', () => {
    const start = source.indexOf('const handleRenameDoc = useCallback(')
    const end = source.indexOf('\n  // ── Drag and drop', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)
    expect(body).toContain("t('databankPanel.renameDocFailed')")
    expect(body).toContain('reportMutationError')
    expect(body).toContain('clearMutationErrorIfCurrent(started)')
    expect(body).not.toContain('/* ignore */')
    expect(body).not.toContain('updateDatabankDocument(docId, { name: newName')
  })

  test('successful relevant ops clear mutation error only when still current', () => {
    expect(source).toContain('const beginMutation = useCallback(() => mutationEpochRef.current, [])')
    expect(source).toContain('if (started !== mutationEpochRef.current) return')
    expect(source).toContain('clearMutationErrorIfCurrent(started)')
    expect(source).toContain('reportMutationError(e?.body?.error || e?.message || t(\'databankPanel.deleteDocFailed\'))')

    const loadStart = source.indexOf('const loadDocs = useCallback(')
    const loadEnd = source.indexOf('\n  useEffect(() => {\n    void loadDocs()', loadStart)
    expect(loadStart).toBeGreaterThanOrEqual(0)
    expect(loadEnd).toBeGreaterThan(loadStart)
    const loadDocs = source.slice(loadStart, loadEnd)
    expect(loadDocs).toContain('const started = beginMutation()')
    expect(loadDocs).toContain('clearMutationErrorIfCurrent(started)')
  })
})
