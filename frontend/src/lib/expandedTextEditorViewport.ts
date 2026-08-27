export const EXPANDED_EDITOR_CARET_GUTTER = 16

interface ExpandedEditorScrollRecoveryInput {
  tapClientY: number
  visibleViewportHeight: number
  renderedScale: number
}

/**
 * Translate visual-viewport occlusion into the textarea's unscaled scroll
 * coordinates. CSS zoom means client pixels and scrollTop units can differ.
 */
export function calculateExpandedEditorScrollRecovery({
  tapClientY,
  visibleViewportHeight,
  renderedScale,
}: ExpandedEditorScrollRecoveryInput): number {
  const safeBottom = Math.max(0, visibleViewportHeight - EXPANDED_EDITOR_CARET_GUTTER)
  const occludedClientPixels = Math.max(0, tapClientY - safeBottom)
  const scale = Number.isFinite(renderedScale) && renderedScale > 0 ? renderedScale : 1
  return occludedClientPixels / scale
}
