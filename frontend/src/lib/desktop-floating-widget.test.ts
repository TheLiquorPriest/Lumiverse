import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const originalWindow = globalThis.window

beforeAll(() => {
  Object.assign(globalThis, { window: {} })
})

afterAll(() => {
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.assign(globalThis, { window: originalWindow })
})

describe('desktop floating widget catalog', () => {
  test('does not publish widgets owned by disabled or backend-only extensions', async () => {
    const { buildDesktopFloatingWidgetCatalog } = await import('./desktop-floating-widget')
    const widget = (id: string, extensionId: string) => ({
      id,
      extensionId,
      visible: true,
      width: 320,
      height: 180,
      chromeless: false,
    })
    const extension = (id: string, enabled: boolean, hasFrontend: boolean) => ({
      id,
      name: id,
      enabled,
      has_frontend: hasFrontend,
    })

    const catalog = buildDesktopFloatingWidgetCatalog(
      [widget('disabled-widget', 'disabled'), widget('backend-widget', 'backend'), widget('active-widget', 'active')] as never,
      [extension('disabled', false, true), extension('backend', true, false), extension('active', true, true)] as never,
    )

    expect(catalog.map((entry) => entry.id)).toEqual(['active-widget'])
  })
})
