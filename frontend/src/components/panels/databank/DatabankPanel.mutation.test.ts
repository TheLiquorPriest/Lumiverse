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
})
