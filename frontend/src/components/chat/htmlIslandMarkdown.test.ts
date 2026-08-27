/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { processMarkdownInHtmlIsland } from './htmlIslandMarkdown'

function render(html: string): string {
  return processMarkdownInHtmlIsland(html, {
    renderBlockText: (markdown) => `<block>${markdown.trim()}</block>`,
    renderInlineText: (markdown) => `<inline>${markdown.trim()}</inline>`,
  })
}

describe('processMarkdownInHtmlIsland', () => {
  test('keeps markdown inside span-based code editor rows inline', () => {
    const html = [
      '<div style="background:#1e1e2e;">',
      '  <span style="color:#6c7086;"># flatten nested response</span><br>',
      '</div>',
    ].join('')

    expect(render(html)).toContain('<span style="color:#6c7086;"><inline># flatten nested response</inline></span><br>')
    expect(render(html)).not.toContain('<block># flatten nested response</block>')
  })

  test('still allows block markdown in block containers', () => {
    expect(render('<div># heading</div>')).toBe('<div><block># heading</block></div>')
  })

  test('treats paragraph text as inline markdown to avoid invalid nested blocks', () => {
    expect(render('<p># heading</p>')).toBe('<p><inline># heading</inline></p>')
  })

  test('does not parse text inside pre/code/script blocks', () => {
    expect(render('<pre># heading</pre>')).toBe('<pre># heading</pre>')
    expect(render('<code>**bold**</code>')).toBe('<code>**bold**</code>')
    expect(render('<script># heading</script>')).toBe('<script># heading</script>')
  })

  test('does not parse text inside svg subtrees', () => {
    expect(render('<svg><text>*bold*</text></svg>')).toBe('<svg><text>*bold*</text></svg>')
  })

  test('unknown pseudo-tags do not flip following prose to inline', () => {
    const html = '<div><close>\n\n## NPC\n\n*intro*</div>'
    expect(render(html)).toContain('<block>## NPC\n\n*intro*</block>')
  })

  test('unreplaced card markers with payloads do not become markdown context', () => {
    const html = '<div><Name: evan | Background: heropng>\n\n## HEROES</div>'
    expect(render(html)).toContain('<block>## HEROES</block>')
  })

  test('stray unknown close tags do not pop known containers', () => {
    const html = '<div></wiki># heading</div>'
    expect(render(html)).toBe('<div></wiki><block># heading</block></div>')
  })

  test('form is sanitizer-forbidden and does not become markdown context', () => {
    expect(render('<div><form>## heading</div>')).toContain('<block>## heading</block>')
  })
})
