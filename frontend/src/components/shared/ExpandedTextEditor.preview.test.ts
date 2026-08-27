import { describe, expect, test } from 'bun:test'

const componentSource = await Bun.file(new URL('./ExpandedTextEditor.tsx', import.meta.url)).text()
const cssSource = await Bun.file(new URL('./ExpandedTextEditor.module.css', import.meta.url)).text()

describe('ExpandedTextEditor Markdown preview', () => {
  test('toggles between the editor and the chat Markdown renderer', () => {
    expect(componentSource).toContain("import MessageContent from '@/components/chat/MessageContent'")
    expect(componentSource).toContain("const [showMarkdownPreview, setShowMarkdownPreview] = useState(false)")
    expect(componentSource).toContain('aria-pressed={showMarkdownPreview}')
    expect(componentSource).toContain('<MessageContent')
    expect(componentSource).toContain('disableInterceptors')
  })

  test('keeps the rendered preview scrollable inside the modal body', () => {
    const previewBlock = cssSource.match(/\.markdownPreview\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(previewBlock).toMatch(/overflow:\s*auto/)
    expect(previewBlock).toMatch(/min-height:\s*0/)
  })
})

describe('ExpandedTextEditor mobile editing stability', () => {
  test('focuses programmatically without allowing keyboard presentation to scroll the page', () => {
    expect(componentSource).toContain('textarea.focus({ preventScroll: true })')
    expect(componentSource).toContain("document.documentElement.style.overflow = 'hidden'")
    expect(componentSource).toContain('document.documentElement.style.overflow = rootOverflow')
  })

  test('keeps syntax highlighting enabled on touch-only devices', () => {
    const touchBlock = cssSource.match(/@media \(any-hover: none\)\s*\{([\s\S]*)\n\}/)?.[1] ?? ''
    expect(touchBlock).not.toMatch(/\.highlightPre\s*\{[\s\S]*?display:\s*none/)
    expect(touchBlock).not.toMatch(/\.textareaHighlighted\s*\{[\s\S]*?-webkit-text-fill-color:\s*var\(--lumiverse-text\)/)

    const highlightedTextareaBlock = cssSource.match(/\.textareaHighlighted\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(highlightedTextareaBlock).toMatch(/-webkit-text-fill-color:\s*transparent/)
  })

  test('disables scroll anchoring in the highlighted editor scroller', () => {
    const highlightBlock = cssSource.match(/\.highlightContainer\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(highlightBlock).toMatch(/overflow-anchor:\s*none/)
  })

  test('auto-focuses desktop editors but waits for an explicit tap on touch-only devices', () => {
    expect(componentSource).toContain("window.matchMedia?.('(any-hover: none)').matches")
    expect(componentSource).toContain('shouldFocusSelectionRef.current = shouldAutoFocusExpandedEditor()')
  })

  test('recovers a tapped caret when keyboard presentation would cover it', () => {
    expect(componentSource).toContain('onPointerDown={handleTextareaPointerDown}')
    expect(componentSource).toContain("window.visualViewport?.addEventListener('resize', recoverTappedCaret)")
    expect(componentSource).toContain('tap.target.scrollTop = tap.scrollTop + recovery')
  })

  test('masks only the source textarea while preserving the contextual backdrop', () => {
    expect(componentSource).toContain("source.style.visibility = 'hidden'")
    expect(componentSource).toContain('source.style.visibility = visibility')
    expect(componentSource).toContain('sourceRef={textareaRef}')

    const glassOverlayBlock = cssSource.match(/:global\(\[data-glass\]\) \.overlay\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(glassOverlayBlock).toMatch(/background:\s*var\(--lumiverse-modal-backdrop/)
    expect(glassOverlayBlock).toMatch(/backdrop-filter:/)
  })
})
