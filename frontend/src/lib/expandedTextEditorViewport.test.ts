import { describe, expect, test } from 'bun:test'
import { calculateExpandedEditorScrollRecovery } from './expandedTextEditorViewport'

describe('calculateExpandedEditorScrollRecovery', () => {
  test('does not move a tap that remains above the keyboard', () => {
    expect(calculateExpandedEditorScrollRecovery({
      tapClientY: 420,
      visibleViewportHeight: 500,
      renderedScale: 1,
    })).toBe(0)
  })

  test('moves an occluded tap above the keyboard with a caret gutter', () => {
    expect(calculateExpandedEditorScrollRecovery({
      tapClientY: 540,
      visibleViewportHeight: 400,
      renderedScale: 1,
    })).toBe(156)
  })

  test('converts client pixels into scroll units under UI scaling', () => {
    expect(calculateExpandedEditorScrollRecovery({
      tapClientY: 540,
      visibleViewportHeight: 400,
      renderedScale: 1.5,
    })).toBe(104)
  })
})
