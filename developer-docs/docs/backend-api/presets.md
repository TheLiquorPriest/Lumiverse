# Presets

!!! warning "Permission required: `presets`"

Full CRUD access to the user's generation presets and their prompt blocks. Use this for extensions that manage Loom presets, inspect prompt assembly structure, or batch-edit blocks and categories.

## Shape

Presets are stored as one record with several JSON fields:

- `parameters` stores sampler/custom-body settings and other provider parameters.
- `prompt_order` stores the ordered prompt block list.
- `prompts` stores prompt behavior, completion settings, and advanced prompt settings.
- `metadata` stores Loom metadata such as description, source, model profiles, default status, and prompt variable values.

Prompt categories are not separate records. A category is a structural prompt block where `marker === 'category'`. Its children are the following non-category prompt blocks until the next category block. Use `spindle.presets.categories.list()` when you want this grouping precomputed by the host.

## Normalized Agent runtime configuration

Agent runtime configuration is not generic preset metadata. The authenticated
preset service stores one normalized V2 projection in
`preset_agent_configs`, `preset_agent_profiles`,
`preset_agent_connection_slots`, and `preset_agent_slot_bindings`.
`Preset.agent_config` is the safe projection of that preset-owned data and
`Preset.agent_config_review` reports review/repair state and items; it does not
by itself decide executability. The durable chat override lives separately in
`chat_agent_mode_overrides` and is resolved by the runtime decision service.
Runtime executability additionally requires enabled/allowed mode, host
ceilings, concrete capabilities, revisions/readiness, and kill-switch health.
The runtime reads this projection through `agent-config-portability.service.ts`;
it does not select a connection from `metadata` or from a
`connectionProfileId` field.

The closed authored shape is `AgentConfigV2`:

```ts
{
  version: 2,
  agentsEnabled: boolean,
  allowedModes: ['response'] | ['agentic', 'response'] | ['response', 'agentic'],
  defaultMode: 'response' | 'agentic',
  maxInvocations: number,
  maxToolCalls: number,
  mainToolIds: CoreAgentToolId[],
  mainLoreScope: AgentLoreScope,
  profiles: [{
    id: string,
    name: string,
    systemPrompt: string,
    connectionRef:
      | { kind: 'inherit_main' }
      | { kind: 'slot', slotId: string },
    toolIds: CoreAgentToolId[],
    loreScope: AgentLoreScope,
    allowMainDelegation: boolean,
    failurePolicy: 'required' | 'optional',
    streamActivity: boolean,
    maxOutputTokens: number,
    timeoutMs: number,
  }],
  connectionSlots: [{
    id: string,
    label: string,
    requiredCapabilities: [
      'generation' | 'streaming' | 'tool_calling' |
      'native_tool_continuation' | 'tools_disabled_finalization',
    ][],
  }],
  phasePolicy?: { work: AgentPromptBlockRefV1[], render: AgentPromptBlockRefV1[] },
  cognitionPolicy?: AgentCognitionPolicyV1,
  contextPolicy?: AgentContextPolicyV1,
  taskPolicy?: AgentTaskPolicyV1,
  workspacePolicy?: { retention: 'turn_terminal' | 'chat_lifetime', sharing: 'root_only' | 'view_only' },
  runtimePolicy?: AgentRuntimePolicyV1,
}
```

### Canonical Loom authoring and assembly

The executable Loom authoring record is
`AgentConfigV2.runtimePolicy`, not preset metadata or the legacy
`cognitionPolicy`. Its current shape is:

```ts
runtimePolicy: {
  version: 1,
  authority: 'loom',
  scope: 'preset',
  defaultMode: 'response' | 'agentic',
  loomPolicy: {
    version: 1,
    workPolicy: LoomPolicyEntryV1[],
    workspaceUsage: LoomPolicyEntryV1[],
    completionCriteria: LoomPolicyEntryV1[],
    renderPolicy: LoomPolicyEntryV1[],
  } | null,
  phases: readonly AgentCustomPhaseV1[],
}
```

Each `LoomPolicyEntryV1` is closed:

```ts
{
  version: 1,
  id: string,
  source: {
    kind: 'loom_block',
    blockId: string,
    presetRevision: number,
    blockRevision: number,
    promptOrder: number,
  },
  destination: 'root_work' | 'completion_handoff' | 'render',
  checkpoint: 'ASSEMBLE' | 'WORK' | 'PREPARE_COMMIT' | 'RENDER',
  required: boolean,
  visibility: 'work_only',
  delivery:
    | { delivery: 'direct' }
    | { delivery: 'condition_gated', condition: CognitionPredicateV1 }
    | {
        delivery: 'on_demand',
        request: { contextPackId: string, revisionId: string, digest: string },
      },
}
```

Routing is fixed: `workPolicy` and `workspaceUsage` feed `root_work` at
`WORK`; `completionCriteria` feeds `completion_handoff` at
`PREPARE_COMMIT`; and `renderPolicy` feeds `render` at `RENDER`. The host
freezes each source revision before assembly. The **Phased Instructions**
editor is the single authoring surface for these fixed Loom policy buckets,
custom runtime phases, and context delivery. `phasePolicy` remains a legacy
compatibility field for imported records; it is not a second editor or
authority. No live `cognitionPolicy`, metadata alias, or extension callback can
replace the canonical Loom record.

The authenticated assembly surface is explicit (`RESPONSE` or `WORK`) and is
carried by the frozen snapshot and `AssemblyPlanV1`; it is never inferred from
the presence of policy entries. Response assembly omits every
`visibility: 'work_only'` entry. Owner inspection receives typed
`LoomPromptInspectionV1` items and a `responseOmission` record instead of
silently presenting WORK material as Response content.

`GET /api/v1/presets/:id/agent-config`, the shared-draft save, and the
portable runtime envelope preserve `runtimePolicy.loomPolicy` verbatim
through their revision fences. The normalized authenticated projection is
the only executable authority.

---


`allowedModes` is ordered, unique, always contains `response`, and
`defaultMode` must be allowed. A profile refers to an authored preset-scoped
slot or explicitly inherits the root connection. A slot binding is the only
place that stores a local `connection_id`, and it carries a binding revision
and `ready | review_required | repair_required` state.
Capabilities and host ceilings are checked again when the runtime resolves the
concrete connection; authored values cannot raise process limits.

`AgentConfigV2` in the normalized tables is the only executable authority.
Ordinary preset create/update DTOs accept only exact top-level
`agent_config` V2. They reject V1 and scrub all runtime-looking metadata keys,
including `metadata.agentConfig`, review aliases, portable aliases, and
runtime-envelope aliases, without interpreting them. Explicit database
migration, user-data archive, preset-file, and LumiHub import boundaries may
parse legacy V1 exactly once, normalize it, and remove the legacy carriers.
Normal preset reads project only normalized tables; no metadata alias is
executable.

Version-1 migration is deliberately Response-only:

- absent config, marker-only metadata, or V1 `enabled: false` becomes
  `agentsEnabled: false`, `allowedModes: ['response']`,
  `defaultMode: 'response'`, and `ready` state;
- a structurally valid V1 `enabled: true` preserves authored
  profiles/tools/limits but remains Response-only; no V1 row enables Agentic;
- a local direct profile binding becomes deterministic slot
  `profile/<profileId>`; a `null` binding becomes `inherit_main`;
- malformed legacy config becomes inert `repair_required` with a bounded
  repair reason; an unresolved foreign/stale binding becomes inert
  `review_required` until it is mapped and acknowledged.

Loom/LumiHub imports have two explicit paths. If the exported object (or its
embedded `preset`) contains `agentRuntime`, the installer strictly parses the
`PortablePresetRuntimeEnvelopeV1` before writing and atomically imports the
preset, normalized config, portable Context Pack snapshots, selections, rules,
and task templates. This complete-runtime path preserves authored policy but
imports it disabled, Response-only, and review-required; it cannot grant
activation or local bindings. If no envelope is present, the explicit legacy
import path strictly parses `metadata.agentConfig`, migrates it to a portable
V2 payload, and sends it through the same transactional importer. Legacy
authored settings remain preserved but disabled, Response-only, and
review-required. In both paths metadata is not executable runtime authority;
normalized authenticated config routes remain the runtime source.

Same-account duplicate copies the preset, normalized config, authorized slot
bindings, regex companions, and the validated authored runtime envelope
(`contextPackSelections`, `contextRules`, `taskTemplates`, and
`reviewAcknowledgements`). It does not clone the Context Library graph; the
copied same-account references continue to point at the already-authorized
pack revisions. Foreign import never copies local bindings.
### Authenticated config and portability routes

These routes are mounted under `/api/v1/presets` and are the server authority
for normalized config:

| Method | Endpoint | Contract |
|---|---|---|
| `GET` | `/:id/agent-config` | Returns the editor object directly (not a `{ preset, editor }` wrapper): `presetId`, `presetRevision`, `configRevision`, `config: AgentConfigV2`, `review`, `slotBindings`, `contextPackSelections`, `contextRules`, `taskTemplates`, `hostCeilings`, and `reviewAcknowledgements`. Missing/foreign presets return `404`. |
| `PUT` | `/:id/agent-config` | Atomically saves the closed body keys `config`, `slotBindings`, `contextPackSelections`, `contextRules`, `taskTemplates`, `reviewAcknowledgements`, `promptOrder`, `expectedPresetRevision`, and `expectedConfigRevision`; unknown or malformed bodies return `400`, while a missing revision precondition returns `428`. |
| `GET` | `/:id/agent-runtime/portable` | Returns the complete `PortablePresetRuntimeEnvelopeV1`: portable config, Context Pack snapshots/selections, context rules, and task templates. It contains no local bindings or credentials. |
| `POST` | `/import-portable` | Accepts `{ preset: PortablePresetPayload, agentRuntime: PortablePresetRuntimeEnvelopeV1 }` and atomically imports the complete preset/runtime/context graph in disabled, Response-only, review-required state (`201`). |
| `GET` | `/:id/agent-config/portable` | Returns config-only `PortableAgentConfigV1` with no local bindings or credentials. |
| `POST` | `/agent-config/portable/import` | Creates a foreign preset/config from a config-only `PortablePresetPayload` in inert review-required state (`201`); it does not carry the Context Library graph. |
| `POST` | `/:id/duplicate` | Same-account transactional duplicate of the preset, normalized config, authorized bindings, regex companions, and validated authored runtime envelope; Context Library rows are referenced, not cloned. |
| `POST` | `/:id/agent-runtime/repair-acknowledgement` | Record `{ reasonCode, expectedPresetRevision }` for an authenticated owner. The revision is CAS-protected; the response is a separate `repair/review` acknowledgement and does not select a runtime mode. |

| `GET` | `/agent-runtime-limits` | Returns effective process ceilings; it cannot be used to raise them. |

The shared-draft save requires both preset and config revision preconditions.
It updates prompt order and normalized config in one transaction and rejects
unknown or malformed bodies with `400`. Omitting either
`expectedPresetRevision` or `expectedConfigRevision` returns `428`; stale
preconditions return the route's conflict response. A preset update must
provide `expected_cache_revision`; callers that include top-level
`agent_config` are still normalized through the same server authority. Use
`PUT /api/v1/presets/:id/agent-config` when changing config, slots, cognition,
context, tasks, and blocks together.

The durable per-chat mode override is separate from the preset. `PUT
 /api/v1/chats/:id/agent-mode` accepts exactly:

```ts
{ mode: 'response' | 'agentic', expectedRevision: number }
```

The revision precondition is required on every write; use `0` for the first
write. A stale revision is rejected rather than merged. The response is
`{ chatId, mode, revision, state, appliesTo: 'next_turn' }`.
`DELETE /api/v1/chats/:id/agent-mode` accepts exactly
`{ expectedRevision: number }` and returns the same response shape with
`mode: null`. Both changes apply to the next Turn Session, including while
another generation is active; they do not alter the current run.

The durable override is not included in portable config, LumiHub data, or
archives. One-turn choices and decision tokens are never persisted in a
preset. `POST /api/v1/presets/:id/agent-runtime/repair-acknowledgement`
accepts exactly `{ reasonCode: string, expectedPresetRevision: string |
number }` and returns `{ presetId, presetRevision, reasonCode,
acknowledgedAt, revision, scope: 'repair/review', state: 'acknowledged' }`.
The acknowledgement records owner review for the preset revision; it does
not grant a missing capability, select a mode, or bypass readiness.

### Extension boundary

The `spindle.presets.*` extension methods continue to manage ordinary preset
CRUD and prompt blocks. Extensions must preserve unknown metadata keys, but
must not treat the legacy keys as consent or attempt to implement runtime
resolution. The normalized Agent runtime routes above are authenticated
server operations. Agentic execution exposes no extension Tool Library, MCP,
Council, or generic Spindle callback surface; those remain Response-only.

## Usage

```ts
// List presets (paginated)
const { data, total } = await spindle.presets.list({ limit: 20, offset: 0 })

// Get a single preset
const preset = await spindle.presets.get('preset-id')
if (preset) {
  spindle.log.info(`Found preset: ${preset.name}`)
}

// Create a minimal Loom-style preset
const newPreset = await spindle.presets.create({
  name: 'My Extension Preset',
  provider: 'loom',
  engine: 'classic',
  parameters: {},
  prompt_order: [],
  prompts: {},
  metadata: { description: 'Created by my extension' },
})

// Update the preset metadata using the revision returned by create/get.
const updated = await spindle.presets.update(newPreset.id, {
  expected_cache_revision: newPreset.cache_revision,
  metadata: {
    ...newPreset.metadata,
    description: 'Updated description',
  },
})

// Delete the preset
const deleted = await spindle.presets.delete(newPreset.id)
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `list(options?)` | `Promise<{ data: UserPresetDTO[], total: number }>` | List presets. Options: `{ limit?, offset? }`. Defaults: limit 50, max 200. |
| `get(presetId)` | `Promise<UserPresetDTO \| null>` | Get a preset by ID. Returns `null` if not found. |
| `create(input)` | `Promise<UserPresetDTO>` | Create a new preset. `name` and `provider` are required. |
| `update(presetId, input)` | `Promise<UserPresetDTO>` | Update a preset. `expected_cache_revision` is required; pass the `cache_revision` from the read/create response. |
| `delete(presetId)` | `Promise<boolean>` | Delete a preset. Returns `true` if deleted. |

## UserPresetDTO

```ts
{
  id: string
  name: string
  provider: string
  engine: string
  parameters: Record<string, unknown>
  prompt_order: PromptBlockDTO[]
  prompts: Record<string, unknown>
  metadata: Record<string, unknown> // reserved runtime keys are scrubbed
  cache_revision: number
  created_at: number   // unix epoch seconds
  updated_at: number
}
```

`UserPresetDTO` is the extension wire shape and does not include normalized
Agent runtime configuration. Use the authenticated
`/api/v1/presets/:id/agent-config` and portability routes above for V2 config,
bindings; extension CRUD cannot grant or resolve Agentic execution.

## UserPresetCreateDTO


| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Preset name |
| `provider` | `string` | Yes | Preset provider, usually `loom` for native Lumiverse presets |
| `engine` | `string` | No | Engine identifier. Defaults to `classic` |
| `parameters` | `Record<string, unknown>` | No | Provider parameters and Loom sampler/custom-body settings |
| `prompt_order` | `PromptBlockDTO[]` | No | Ordered prompt blocks, including structural category markers |
| `prompts` | `Record<string, unknown>` | No | Prompt behavior, completion settings, and advanced settings |
| `metadata` | `Record<string, unknown>` | No | Preset metadata and extension-specific data; reserved Agent runtime keys are import-only and are scrubbed |

## UserPresetUpdateDTO

`expected_cache_revision` is required and must be the `cache_revision` returned by
the most recent `get`, `list`, `create`, or successful `update` response. All
other fields from `UserPresetCreateDTO` are optional, including `name` and
`provider`.

!!! note "Prompt variable cleanup"
    When `prompt_order` or `metadata` is updated, Lumiverse prunes stale `metadata.promptVariables` entries that no longer correspond to a variable definition on a block. This matches the built-in preset editor behavior.

---

## Prompt Blocks

Prompt blocks are managed through `spindle.presets.blocks`. Block operations update the parent preset's `prompt_order` and trigger the normal preset update flow.

### Block Usage

```ts
// List blocks in order
const blocks = await spindle.presets.blocks.list('preset-id')

// Get a single block
const block = await spindle.presets.blocks.get('preset-id', 'block-id')

// Append a new system block
const newBlock = await spindle.presets.blocks.create('preset-id', {
  name: 'Style Guide',
  content: 'Write with concise, vivid prose.',
  role: 'system',
  position: 'pre_history',
  enabled: true,
})

// Insert a category marker at the start of the preset
const category = await spindle.presets.blocks.create(
  'preset-id',
  {
    name: 'Tone',
    marker: 'category',
    categoryMode: 'radio',
    content: '',
  },
  { index: 0 },
)

// Update a block
const updatedBlock = await spindle.presets.blocks.update('preset-id', newBlock.id, {
  enabled: false,
})

// Delete a block
const blockDeleted = await spindle.presets.blocks.delete('preset-id', newBlock.id)
```

### Block Methods

| Method | Returns | Description |
|---|---|---|
| `list(presetId)` | `Promise<PromptBlockDTO[]>` | Return the preset's ordered prompt blocks. |
| `get(presetId, blockId)` | `Promise<PromptBlockDTO \| null>` | Get a block by ID. Returns `null` if not found. |
| `create(presetId, input, options?)` | `Promise<PromptBlockDTO>` | Create a prompt block. `options.index` inserts at a specific zero-based position; omitted appends. |
| `update(presetId, blockId, input)` | `Promise<PromptBlockDTO>` | Update a block. All fields except `id` are optional. |
| `delete(presetId, blockId)` | `Promise<boolean>` | Delete a block. Returns `true` if deleted. |

### PromptBlockDTO

```ts
{
  id: string
  name: string
  content: string
  role: 'system' | 'user' | 'assistant' | 'user_append' | 'assistant_append'
  enabled: boolean
  position: 'pre_history' | 'post_history' | 'in_history'
  depth: number
  marker: string | null
  isLocked: boolean
  color: string | null
  injectionTrigger: string[]
  group: string | null
  categoryMode?: 'radio' | 'checkbox' | null
  variables?: PromptVariableDefDTO[]
}
```

### PromptBlockCreateDTO / PromptBlockUpdateDTO

`PromptBlockCreateDTO` accepts any subset of `PromptBlockDTO`. Missing fields are defaulted by the host. `PromptBlockUpdateDTO` accepts any subset except `id`; the existing block ID is preserved.

Common fields:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Human-readable block label |
| `content` | `string` | Prompt text for normal blocks; usually empty for marker blocks |
| `role` | `'system' \| 'user' \| 'assistant' \| 'user_append' \| 'assistant_append'` | Message role or append injection tag |
| `enabled` | `boolean` | Whether the block participates in prompt assembly |
| `position` | `'pre_history' \| 'post_history' \| 'in_history'` | Where the block injects relative to chat history |
| `depth` | `number` | Depth when `position` is `in_history` |
| `marker` | `string \| null` | Structural marker. Use `'category'` for category headers |
| `categoryMode` | `'radio' \| 'checkbox' \| null` | Category selection mode; meaningful only on category marker blocks |
| `variables` | `PromptVariableDefDTO[]` | Prompt variable definitions for this block |

Prompt-variable names are scoped to their defining block while Lumiverse renders
that block. If another block defines the same name, `{{var::name}}`,
`{{getvar::name}}`, and `{{.name}}` still resolve the current block's own saved
instance. Runtime `{{setvar::name::value}}` writes remain effective for the rest
of that block and the outer local-variable scope is restored afterward.

When a chat, persona, character, connection, or default preset profile is
active, its saved prompt-variable values are overrides rather than a complete
replacement. Blocks and variable keys absent from the profile inherit the
current values in `metadata.promptVariables`; bindings created before profile
variable snapshots therefore continue to use the preset configuration.

Lumiverse evaluates preset blocks and prompt settings itself; macro
interceptors do not receive the complete preset template. If a block references
a character field such as `{{description}}` or `{{system}}`, that field is
offered to interceptors separately. `ctx.sourceHint` identifies which field was
provided. This keeps preset variables and system macros stable while still
allowing extensions to process character content. Regex scripts attached to a
preset follow the same rule. Character fields receive the same local, chat, and
global variables available at their original position in the preset.

---

## Categories

Use `spindle.presets.categories.list()` to get category grouping without reimplementing Lumiverse's grouping rules.

```ts
const groups = await spindle.presets.categories.list('preset-id')

for (const group of groups) {
  const label = group.categoryBlock?.name ?? 'Uncategorized'
  spindle.log.info(`${label}: ${group.children.length} blocks`)
}
```

### Category Methods

| Method | Returns | Description |
|---|---|---|
| `list(presetId)` | `Promise<PromptBlockCategoryGroupDTO[]>` | Return category groups derived from the preset's ordered blocks. |

### PromptBlockCategoryGroupDTO

```ts
{
  categoryBlock: PromptBlockDTO | null
  children: PromptBlockDTO[]
}
```

The first group can have `categoryBlock: null` when normal blocks appear before the first category marker.

## User Scoping

For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, pass `userId` as the final argument or inside the options object where supported.

```ts
// Operator-scoped extension targeting a specific user
const { data } = await spindle.presets.list({ userId: 'user-id' })
const block = await spindle.presets.blocks.create(
  'preset-id',
  { name: 'Operator Note', content: '...' },
  { userId: 'user-id' },
)
```

## Best Practices

- Treat `parameters`, `prompts`, and `metadata` as owned by the preset editor unless you intentionally manage those fields.
- Namespace extension-specific metadata under your extension identifier to avoid collisions.
- Prefer block CRUD for localized prompt edits instead of rewriting the entire `prompt_order` array.
- Use `categories.list()` for UI or analytics; create/update/delete category headers through `blocks.*`.
- Check `spindle.permissions.has('presets')` before showing preset-management UI.
