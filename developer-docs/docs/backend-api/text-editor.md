# Text Editor

Open the native Lumiverse expanded text editor modal on the user's frontend. The editor provides full-screen editing with macro syntax highlighting (`{{macros}}` are color-coded and auto-completed). The call blocks until the user closes the editor.

No permission is required. This is a free-tier utility like [Toast Notifications](toast.md).

## Usage

```ts
const result = await spindle.textEditor.open({
  title: 'Edit System Prompt',
  value: currentText,
})

if (!result.cancelled) {
  currentText = result.text
  spindle.toast.success('Prompt updated')
}
```

User dismissal—or an unavailable target user—resolves with `cancelled: true`; confirmation resolves with `cancelled: false`. The Promise can reject when options are invalid, a caller-owned request identity is already active, or the host transport fails.

### Minimal Call

All options are optional — calling with no arguments opens an empty editor with the default title:

```ts
const { text, cancelled } = await spindle.textEditor.open()
```

### With Placeholder

```ts
const result = await spindle.textEditor.open({
  title: 'Author\'s Note',
  placeholder: 'Write context that should be injected near the end of the prompt...',
})
```

## Options

| Field | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | `"Edit Text"` | Modal title displayed at the top of the editor |
| `value` | `string` | `""` | Initial text content pre-filled in the editor |
| `placeholder` | `string` | `""` | Placeholder text shown when the editor is empty |
| `editorRequestId` | `string` | generated | Optional caller-owned 1–128 character ASCII token used with `textEditor.close()` |
| `userId` | `string` | — | Target user ID. Only needed for operator-scoped extensions that serve multiple users. User-scoped extensions can omit this. |

## Result

| Field | Type | Description |
|---|---|---|
| `text` | `string` | The editor contents when the user closed it. If cancelled, this is the original `value`. |
| `cancelled` | `boolean` | `true` if the user dismissed the editor without confirming |

## Behavior

- The editor opens as a **full-screen modal** in the Lumiverse frontend, overlaying the chat view.
- **Macro highlighting** is enabled by default — `{{user}}`, `{{char}}`, `{{random}}` etc. are syntax-colored.
- Only **one text editor** can be open at a time across all extensions. If another extension already has an editor open, the call will wait until the previous editor is closed.
- The editor is rendered by the Lumiverse host — it automatically inherits the user's theme, font scale, and glass mode settings.

## Example: Editable Configuration

```ts
spindle.onFrontendMessage(async (msg) => {
  if (msg.type === 'edit-template') {
    const current = await spindle.userStorage.getText('template.txt', {
      fallback: 'Default template with {{char}} and {{user}}',
    })

    const result = await spindle.textEditor.open({
      title: 'Edit Response Template',
      value: current,
      placeholder: 'Enter your template. Macros like {{char}} will be resolved at runtime.',
    })

    if (!result.cancelled) {
      await spindle.userStorage.setText('template.txt', result.text)
      spindle.toast.success('Template saved')
    }
  }
})
```

## Programmatic cancellation

Long-running workflows should assign a caller-owned request identity when opening
the editor, then close that identity if the workflow is cancelled or times out.
Request identities are 1–128 character ASCII tokens containing letters, digits,
underscores, or hyphens. Closing an unknown or already-settled identity is a safe
no-op.

```ts
const editorRequestId = crypto.randomUUID()
const review = spindle.textEditor.open({
  editorRequestId,
  title: 'Review output',
  value: draft,
})

try {
  return await review
} finally {
  await spindle.textEditor.close(editorRequestId)
}
```

!!! tip "When to use the text editor"
    Use the text editor for any multi-line text that the user might want to carefully compose — prompt templates, system instructions, custom formatting rules, notes. For simple single-line values (names, keys, numbers), a regular HTML `<input>` in your frontend module is more appropriate.
