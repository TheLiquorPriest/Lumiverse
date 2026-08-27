const SUITE_OWNED_COMPOSER_ACTION_IDS = new Set([
  'chat.authors-note',
  'chat.customize-composer',
  'chat.manage',
  'chat.settings',
  'settings',
  'connectionsPicker',
])

/** Returns true for composer entries supplied by Suite or another extension. */
export function isExtensionComposerActionId(id: string): boolean {
  return SUITE_OWNED_COMPOSER_ACTION_IDS.has(id)
    || id.startsWith('spindle:')
    || id.startsWith('input-action:')
    || id.startsWith('ext-cmd-')
    || id.startsWith('ext-tab-')
    || id.startsWith('lumiverse_suite.')
}
