# REST API Reference

Lumiverse exposes authenticated core HTTP routes under `/api/v1`. The
authenticated session supplies `userId`; callers must not send a substitute
owner ID. A missing or mismatched owner/chat/preset/turn returns the existing
non-disclosing `404 { "error": "Not found" }` response where noted below.

The Agentic surfaces are strict opt-in APIs. They do not change the existing
Response generation contract, and they do not expose credentials, endpoint
URLs, trust-domain fingerprints, private work prose, reasoning, provider
carriers, raw tool arguments/results, or private child content.

## Settings API

Use the settings endpoints when you need to inspect or update persisted host
preferences.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/settings` | List all settings as `{ key, value, updated_at }[]` |
| `GET` | `/api/v1/settings/:key` | Get a single setting row |
| `PUT` | `/api/v1/settings` | Bulk upsert settings from a flat `{ key: value }` object |
| `PUT` | `/api/v1/settings/:key` | Upsert one setting from `{ value }` |
| `DELETE` | `/api/v1/settings/:key` | Delete a single setting row |

### Landing Page Display Settings

The landing page layout is controlled by persisted display settings:

| Key | Type | Description |
|---|---|---|
| `landingPageLayoutMode` | `'cards' \| 'compact'` | Switches the home screen between the existing card gallery and the compact adaptive recent-chat list. |
| `landingPageChatsDisplayed` | `number` | Controls the recent-chat batch size loaded per request. |

```bash
# Switch the landing page to the compact adaptive list view
curl -X PUT http://localhost:7860/api/v1/settings/landingPageLayoutMode \
  -H 'Content-Type: application/json' \
  -d '{ "value": "compact" }'

# Or update multiple display settings in one request
curl -X PUT http://localhost:7860/api/v1/settings \
  -H 'Content-Type: application/json' \
  -d '{
    "landingPageLayoutMode": "compact",
    "landingPageChatsDisplayed": 24
  }'
```

## Agentic runtime decision

### `POST /api/v1/generate/effective-runtime`

Resolve the effective concrete connection, preset/config, target, mode,
capability readiness, and one-turn decision token. The authenticated request
uses this closed camelCase shape:

```ts
{
  chatId: string,
  logicalConnectionId?: string | null,
  presetId?: string | null,
  forcePresetId?: boolean,
  personaId?: string | null,
  targetCharacterId?: string | null,
  generationType?: 'normal' | 'continue' | 'regenerate' | 'swipe',
  messageId?: string | null,
  swipeId?: number | null,
  target?: {
    generationType: 'normal' | 'continue' | 'regenerate' | 'swipe',
    messageId?: string | null,
    swipeId?: number | null,
    targetCharacterId?: string | null,
  } | null,
  mode?: 'response' | 'agentic',
  requestEpoch?: string | number,
  inputRevisions?: Partial<InputRevisionSetV1>,
  readinessVector?: Partial<AgenticReadinessVectorV1>,
}
```

The body is closed: unknown fields and conflicting values are
`400 invalid_request`. Branch and revision fields are server-owned; clients
must not copy them from a previous projection. The server freezes the
authoritative target and complete revision digest before issuing a token.

`mode` is the authenticated one-turn selection and may be
`'response'` or `'agentic'`. `transientSelection` and
`transient_selection` are internal runtime-policy fields, not public request
fields; sending either is rejected with `400 invalid_request`.


The response is the closed `EffectiveRuntimePublicResponseV1` projection:

```ts
{
  version: 1,
  chatId: string,
  target: GenerationTargetV1,
  connection: {
    id: string | null,
    label: string | null,
    provider: string | null,
    model: string | null,
    revision: string | number | null,
    endpointRevision: string | number | null,
    credentialRevision: string | number | null,
    candidateRevision: string | number | null,
  },
  preset: {
    id: string | null,
    label: string | null,
    revision: string | number | null,
    source: 'chat' | 'persona' | 'character' | 'connection' |
      'default' | 'forced' | 'none',
  },
  agentsEnabled: boolean,
  allowedModes: ('response' | 'agentic')[],
  defaultMode: 'response' | 'agentic',
  requestedMode: 'response' | 'agentic',
  effectiveMode: 'response' | 'agentic',
  runtimePolicy: LoomRuntimePolicyV1,
  chatOverride: {
    mode: 'response' | 'agentic' | null,
    revision: number,
    state: 'ready' | 'review_required' | 'repair_required',
    reviewCode?: string | null,
    acknowledged?: boolean,
  } | null,
  capabilityReadiness: {
    ready: boolean,
    sameDomain: boolean,
    required: string[],
    missing: string[],
    repairCodes: string[],
    responseEscape: 'available',
  },
  repairCodes: string[],
  runtimeDecisionToken: string | null,
  runtimeDecisionExpiresAt: number | null,
}
```

The public projection contains safe labels and revisions only. The internal
candidate contains the normalized endpoint, credential reference, and
trust-domain fingerprint and is never serialized. Readiness requires
generation, streaming, tool calling, native tool continuation, tools-disabled
finalization, complete input revisions, same-domain root/child connections,
valid slots/context/cognition, healthy terminable preprocessing, healthy
publication storage, and the current readiness vector.

The effective mode has explicit precedence:
authenticated one-turn selection, ready durable chat override, reviewed
preset default, then Response fallback. If Agentic is unavailable,
`effectiveMode: 'response'` is only a reported Response escape; it does not
authorize a request that asked for Agentic to downgrade. The caller must
submit `mode: 'response'`. A binding, target, context, isolate, publication,
startup, or runtime epoch change invalidates the decision and requires a new
preflight.

`AgenticReadinessVectorV1` is digest-bound. Its invalidation fields include
`schemaEpoch`, `runtimeEpoch`, `reconciliationEpoch`,
`archiveRegistryVersion`, `isolateHealthEpoch`,
`publicationStoreHealthEpoch`, `providerCapabilityRevision`,
`configRevision`, `bindingRevision`, `concreteConnectionRevision`,
`targetRevision`, `inputRevisionDigest`, `cognitionRevision`, and
`contextAclRevision`; it also carries `killSwitchState`, `ready`, and bounded
`reasons`.



### `PUT /api/v1/chats/:id/agent-mode`

Set the durable chat override without changing the preset. The body is
exactly:

```ts
{ mode: 'response' | 'agentic', expectedRevision: number }
```

The response is `{ chatId, mode, revision, state, appliesTo: 'next_turn' }`.
The write is a revision CAS and applies to the next Turn Session, including
while another generation is active; it does not alter the current run.

`DELETE /api/v1/chats/:id/agent-mode` resets the override. Its body is
exactly `{ expectedRevision: number }` and it returns the same response shape
with `mode: null`. A missing precondition returns
`428 AGENT_CHAT_MODE_REVISION_REQUIRED`; malformed input returns
`400 INVALID_REQUEST`; a stale expected revision returns
`409 AGENT_CHAT_MODE_REVISION_CONFLICT` with current revision/mode/state
details. A missing or foreign chat is the non-disclosing
`404 { error: 'Not found', code: 'NOT_FOUND' }`. One-turn decision tokens are
never persisted.

## Preset Agent runtime and portability routes

The normalized `AgentConfigV2` projection is the only executable preset
authority. Ordinary preset create/update DTOs accept only the exact top-level
`agent_config` V2 shape; V1 is rejected. Runtime-looking metadata keys,
including `metadata.agentConfig`, all review aliases, portable aliases, and
runtime-envelope aliases, are scrubbed rather than interpreted. Legacy V1 is
parsed only at the explicit archive, preset-file, and LumiHub import/migration
boundaries, then written once as disabled, Response-only normalized V2.
Portable config uses `PortableAgentConfigV1`; this is the portable wire
version for authored V2 data, not executable V1 configuration. It carries
authored slot IDs and policy but never local connection IDs, credentials,
bindings, grants, or one-turn authority.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/presets/:id/agent-config` | Return the shared V2 editor object directly (not a `{ preset, editor }` wrapper): `presetId`, `presetRevision`, `configRevision`, `config`, `review`, `slotBindings`, context/task selections, `hostCeilings`, and `reviewAcknowledgements`. Missing/foreign presets return `404`. |
| `PUT` | `/api/v1/presets/:id/agent-config` | Atomically save `config`, `slotBindings`, `contextPackSelections`, `contextRules`, `taskTemplates`, `reviewAcknowledgements`, `promptOrder`, `expectedPresetRevision`, and `expectedConfigRevision`. Unknown or malformed bodies return `400`; a missing revision precondition returns `428`. |
| `GET` | `/api/v1/presets/:id/agent-runtime/portable` | Return the complete `PortablePresetRuntimeEnvelopeV1`: portable config, Context Pack snapshots/selections, context rules, and task templates, without local bindings or credentials. |
| `POST` | `/api/v1/presets/import-portable` | Accept `{ preset: PortablePresetPayload, agentRuntime: PortablePresetRuntimeEnvelopeV1 }` and atomically import the complete preset/runtime/context graph as disabled, response-only, and review-required. |
| `GET` | `/api/v1/presets/:id/agent-config/portable` | Return config-only `PortableAgentConfigV1` without local bindings or credentials. |
| `POST` | `/api/v1/presets/agent-config/portable/import` | Accept a config-only `PortablePresetPayload`; create a foreign preset/config as disabled, response-only, and review-required until local slot review. |
| `POST` | `/api/v1/presets/:id/duplicate` | Same-account transactional duplicate of preset, normalized config, authorized bindings, regex companions, and the validated authored runtime envelope; Context Library rows are referenced, not cloned. |
| `POST` | `/api/v1/presets/:id/agent-runtime/repair-acknowledgement` | Record a revision-fenced owner review `{ reasonCode, expectedPresetRevision }`; returns the persisted acknowledgement and never grants mode/capability authority. |
| `GET` | `/api/v1/presets/agent-runtime-limits` | Read immutable effective host ceilings. |

The `PUT /api/v1/presets/:id/agent-config` body is closed: unknown keys and
malformed values are rejected with `400`, and omitting either revision
precondition is rejected with `428`. Stale preconditions are conflicts, not
merges. The duplicate operation is the frontend/editor path; callers must not
marshal a Loom preset locally when duplicating because that omits normalized
Agentic state and authored cognition selections.

`AgentConfigV2.runtimePolicy.loomPolicy` is the canonical four-bucket Loom
authoring record (`workPolicy`, `workspaceUsage`, `completionCriteria`,
`renderPolicy`). Its source revisions, fixed destinations/checkpoints,
delivery policy, and `visibility: 'work_only'` are preserved by the config
and portable routes. Response assembly omits WORK-only entries; owner
inspection reports typed Loom outcomes and Response omission provenance.

`GET /api/v1/presets/agent-runtime-limits` returns the immutable
`AgentRuntimeHostLimits` object with exactly these numeric fields:
`childAdmissions`, `aggregateToolCalls`, `logicalProviderRequests`,
`physicalDispatchAttempts`, `childOutputTokens`, `rootWallClockMs`,
`activityEvents`, `activityBytes`, `lifecycleLogRecords`,
`activeRootsPerUser`, `activeRootsProcess`, `providerDispatchesPerUser`,
`providerDispatchesProcess`, `toolExecutionsPerUser`, and
`toolExecutionsProcess`. Values are read once from process settings; authored
config can be edited above a ceiling but is non-executable until lowered.
Root, provider, and tool admission each has independent atomic per-user and
process counters. The manager retains the admission kind, observed counts,
and applicable user/process ceilings for diagnostics, but those internals are
not exposed as a public HTTP payload. If an asynchronous Agentic phase
encounters an untyped capacity exception, the public terminal projection is
`agentic_internal_error`; admission fails closed and never downgrades to
Response.

V2 migration creates one normalized row per owned preset. A missing legacy
config is `ready`, disabled, and Response-only. A structurally valid V1
config preserves `enabled` as `agentsEnabled` but is still Response-only
(`allowedModes: ['response']`, `defaultMode: 'response'`); a valid disabled V1
config is therefore `ready`, not a repair state. A malformed/stale legacy
config is inert, disabled, and `repair_required` with
`invalid_legacy_config`; a foreign direct binding is disabled and
`review_required` with `foreign_connection`.
Local direct profile bindings become deterministic slot `profile/<profileId>`,
and `null` means `inherit_main`. Imported or repaired configs cannot activate
until all review items are explicitly acknowledged and required slots resolve.

## Generation routes

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/generate` | Start a normal or Agentic generation. `chat_id` is required. |
| `POST` | `/api/v1/generate/regenerate` | Same contract, forcing `generation_type: 'regenerate'`. |
| `POST` | `/api/v1/generate/continue` | Same contract, forcing `generation_type: 'continue'`. |
| `POST` | `/api/v1/generate/stop` | Stop by `generation_id`, falling back to active `chat_id` generations if that ID is stale; with no generation ID, prefer `chat_id`; with neither, stop all user generations. |
| `GET` | `/api/v1/generate/active` | Existing active-generation compatibility view. |
| `GET` | `/api/v1/generate/status/:chatId` | Existing chat generation status view. |
| `POST` | `/api/v1/generate/acknowledge` | Acknowledge compatibility generation status for `{ chatId }`. |

The common generation body is the existing `GenerateInput` shape. Agentic
requests add explicit fields:

```ts
{
  chat_id: string,
  connection_id?: string,
  persona_id?: string,
  preset_id?: string,
  force_preset_id?: boolean,
  message_id?: string,
  swipe_id?: number,
  target_character_id?: string,
  generation_type?: 'normal' | 'continue' | 'regenerate' | 'swipe',
  mode?: 'response' | 'agentic',
  runtime_decision_token?: string,
  request_epoch?: number, // exact requestEpoch from effective-runtime
  parameters?: Record<string, unknown>,
  user_input?: string,
  signal?: never, // the HTTP request's AbortSignal is used by the server
}
```

When `runtime_decision_token` is supplied, `request_epoch` must echo the exact
preflight epoch; the token is consumed once even when this binding check fails.
The server reconstructs the requested target from the generation type,
message/swipe, and character fields. It binds that identity plus the
authoritative chat/message/branch/target revisions through
`inputRevisionDigest` and the durable target CAS; callers do not copy internal
branch or revision fields into this generation body.

`mode` omitted preserves the existing Response path. `mode: 'agentic'` never
falls back to Response after admission; it consumes the one-use token (or
performs the identical internal resolution when no token is supplied), then
fails closed if the decision, target, readiness vector, provider, slot,
isolate, ACL, or input revisions no longer match. The initial Agentic response
is `{ generationId, status: 'streaming', mode: 'agentic', phase: 'ASSEMBLE',
responseModeAvailable: true }`. The closed `AgenticFailureCode` union is
`agentic_unsupported_surface`, `agentic_runtime_unavailable`,
`agentic_preflight_failed`, `decision_refresh_required`,
`agentic_protocol_failure`, `agentic_work_exhausted`, `agentic_cancelled`,
`agentic_timed_out`, `agentic_commit_failed`, `agentic_revision_conflict`,
`agentic_provider_failure`, and `agentic_internal_error`; the route includes
`responseModeAvailable: true` but never switches modes.

`startAgenticGeneration` returns that initial response before ASSEMBLE/WORK
phase work begins. A synchronously thrown `AgenticGenerationError` is mapped
by the HTTP route to `409` only for `decision_refresh_required`, `503` for
`agentic_runtime_unavailable`, and `400` for other closed codes. After the
initial response, WORK, RENDER, commit, cancellation, deadline, and provider
failures settle asynchronously through the Agent Run projection and terminal
compatibility event; they are not returned by a later generation HTTP
response. Read their final status and error code from those authenticated
projection/event surfaces.
Agentic accepts only `normal`, `continue`, `regenerate`, and `swipe` on a
single-character, non-multiplayer, non-Council chat. `continue` requires an
owner-scoped message and extends the currently viewed swipe when `swipeId` is
omitted; `regenerate` requires an owner-scoped message, defaults to the
currently viewed swipe, and may target the next free swipe slot to append when
that slot is requested; `swipe` requires an owner-scoped message, defaults to
the next free swipe slot, and appends an alternative. Groups, multiplayer,
Council, Council tools, `impersonate`, `quiet`, raw/batch generation,
extension callbacks, MCP tools, and generic Spindle tools remain
Response/direct surfaces.

Response-mode generation retains the existing provider message, tool
continuation, prompt/response transform, reasoning, usage, partial Stop, and
message persistence behavior. Agentic provider work notes, reasoning, and
carriers are memory-only and are destroyed at settlement. The turn workspace
retains only bounded host-controlled records and artifact metadata for its
view-only projection; the final atomic commit is the only canonical chat
output.

## Agent Run projection and workspace routes


| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/agent-runs/changes/:chatId` | Return cursor delta/full-resync `AgentRunChangesV2`. |
| `GET` | `/api/v1/agent-runs/status/:turnId` | Return exact `AgentRunPublicV2` by Turn Session ID. |
| `GET` | `/api/v1/agent-runs/inspection?chatId=...` | Return owner-scoped `AgentRunInspectionListV1`; `limit` is 1–64 and `cursor` is a decimal offset. |
| `GET` | `/api/v1/agent-runs/:attemptId/inspection` | Return owner-scoped `AgentRunInspectionDetailV1`. |
| `POST` | `/api/v1/agent-runs/:attemptId/retry` | Admit a strict retry; body must be empty or `{}`. |
| `GET` | `/api/v1/agent-runs/:turnId/workspace` | Return the redacted Turn Session workspace index. |
| `GET` | `/api/v1/agent-runs/:turnId/workspace/:section` | Return one redacted page for `objective`, `tasks`, `records`, `submissions`, or `artifacts`. |
| `POST` | `/api/v1/agent-runs/:turnId/stop` | Request exact root Stop and return `accepted`, `too_late`, or `terminal`. |

Send the opaque, versioned integrity-protected cursor as `?cursor=...` or
`x-agent-run-cursor`. The server binds it to the authenticated owner/chat and
the last strictly increasing chat event sequence. `revision` is monotonic
run state, not a chat cursor. An expired cursor returns one bounded
full-resync snapshot and a fresh cursor; clients must not infer failure from
missing events or silence. Exact status, inspection, and workspace reads
recheck owner, chat, attempt/turn, target-message/swipe ownership, and
visibility. Missing, foreign, expired, or no-longer-retained data is the
same non-disclosing `404`.

`AgentRunPublicV2` exposes versioned run/turn/chat IDs, target and generation
type, `workPhase`, `workStatus`, `workOutcome`, recovery fields,
`attemptLineage`, revision/sequence/timestamps, bounded activity, aggregate
usage, omission markers, and (after commit) the terminal message/swipe
handoff. Public run errors use `{ version: 2, error: AgentRunPublicErrorV2 }`
with `code`, `category`, `summaryCode`, `recoveryEligible`,
`recoveryAction`, target/phase/status/outcome, reason, omission count, and
inspection attempt ID. No public projection exposes prompts, WORK prose,
reasoning, tool arguments/results, credentials, provider carriers, or private
child content.

`AgentRunInspectionListV1` returns bounded summaries with attempt lineage,
host correlation, lifecycle/status/outcome/reason, target, revision and
timestamps, activity, marker/transcript counts, terminal state, and a
`nextCursor` plus one omission marker when applicable. The detail DTO adds
private `transcript`, `turnSession`, `markers`, `usageEvidence`, layered
`usage`, causal `error`, `promptEvidence` (including `loomInspection`),
`cortexReceipts`, `councilReceipts`, `workspaceAssociations`, and stop/retry
inspection records. These fields are owner-inspection data; the public run
projection remains status-only.

`POST /api/v1/agent-runs/:attemptId/retry` accepts only an empty body or `{}`.
Owner-scoped preflight requires a terminal attempt with outcome `failed`,
`exhausted`, or `stopped`, a still-valid target, and available WORK
admission. Refusals are typed `404 not_found`, `409 target_mismatch`,
`stale_target`, or `response_mode_required`, or `503 retry_unavailable` /
`recovery_unavailable` as applicable. Accepted returns `202` only after
durable admission:

```ts
{
  version: 1,
  accepted: true,
  attempt: {
    version: 1,
    attemptId: string,
    previousAttemptId: string,
    target: { chatId, generationType, messageId, swipeId },
    createdAt: number,
  },
  reason: 'none',
  target,
  recoveryEligible: false,
  recoveryAction: 'none',
  inspectionAttemptId: string,
}
```

No refused retry creates a phantom attempt, projection, or terminal message.

### View-only workspace and Stop

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/agent-runs/:turnId/workspace` | Redacted section index with counts, revisions, retention, visibility, and omission count. |
| `GET` | `/api/v1/agent-runs/:turnId/workspace/:section` | View one page of `objective`, `tasks`, `records`, `submissions`, or `artifacts`; accepts `page` and optional `revision`. |
| `POST` | `/api/v1/agent-runs/:turnId/stop` | Exact root Stop; verifies the owned Turn Session and returns `accepted`, `too_late`, or `terminal`. |

The workspace page is a redacted `AgentWorkspacePreviewV2`, not a transcript:
it contains section/page counts, revisions, retention/visibility, omission
metadata, and bounded record summaries only. It does not contain objective
prose, constraints, notes, child content, provider reasoning, tool arguments
or results, credentials, carriers, or raw artifacts. Invalid section/page or
revision values are `400`; a missing, expired, hidden, or cross-owner
turn/workspace is the non-disclosing `404`. `POST .../:turnId/stop` verifies
the owned execution and returns `accepted`, `too_late`, or `terminal`; it never
exposes child controls.

## Persistent Workspace routes

The persistent workspace is separate from the redacted Turn Session workspace
above. It is a stable, structured owner record that may outlive a Turn Session
and may be detached from its chat. It is not a canonical chat transcript and
does not grant WORK, tool, child, or commit authority.

All routes below are authenticated. The session supplies `userId`; the
`chatId` query and `workspaceId` path are the only routing scope. Body fields
such as `userId`, `chatId`, `actor`, `publisher`, `creator`, `authority`, or
`hostAdmitted` are ignored as authority. A foreign workspace or a workspace
whose chat does not match the requested chat is the same non-disclosing `404`.

| Method | Endpoint | Result |
|---|---|---|
| `GET` | `/api/v1/agent-runs/workspace?chatId=...` | Read the persistent workspace attached to the authenticated owner's chat. |
| `POST` | `/api/v1/agent-runs/workspace?chatId=...` | Create or ensure the persistent workspace for the authenticated owner/chat (`201`). |
| `GET` | `/api/v1/agent-runs/workspace/:workspaceId` | Read one owner-scoped workspace; an optional `chatId` query verifies its live attachment. |
| `GET` | `/api/v1/agent-runs/workspace/:workspaceId/sessions` | List retained Turn Session associations. |
| `GET` | `/api/v1/agent-runs/workspace/:workspaceId/tasks` | List persistent tasks. |
| `GET` | `/api/v1/agent-runs/workspace/:workspaceId/records` | List findings, decisions, and questions. |
| `GET` | `/api/v1/agent-runs/workspace/:workspaceId/artifacts` | List attached artifact metadata. |
| `GET` | `/api/v1/agent-runs/workspace/:workspaceId/submissions` | List persistent child submissions with `submitted`, `accepted`, or `rejected` state. This is a read-only owner projection. |
| `GET` | `/api/v1/agent-runs/workspace/:workspaceId/publications` | List independent publication copies. |
| `PATCH` | `/api/v1/agent-runs/workspace/:workspaceId` | Update owner-editable workspace fields with `expectedRevision`. |
| `POST` | `/api/v1/agent-runs/workspace/:workspaceId/tasks` | Create an owner task with `expectedRevision` (`201`). |
| `POST` | `/api/v1/agent-runs/workspace/:workspaceId/publications` | Publish an owner-selected workspace item with `expectedRevision` (`201`). |
| `DELETE` | `/api/v1/agent-runs/workspace/:workspaceId/publications/:publicationId` | Delete a publication copy with `expectedRevision`. |
| `DELETE` | `/api/v1/agent-runs/workspace/:workspaceId` | Delete the workspace with `expectedRevision`. |

The owner mutation bodies use these closed shapes (server-owned identity and
authority fields are not client inputs):

```ts
// POST /workspace?chatId=...
{
  objective?: string,
  metadata?: Partial<PersistentWorkspaceMetadataV1>,
  progress?: Partial<PersistentWorkspaceProgressV1>,
  quota?: Partial<PersistentWorkspaceQuotaV1>,
}

// PATCH /workspace/:workspaceId
{
  expectedRevision: number,
  objective?: string,
  metadata?: Partial<PersistentWorkspaceMetadataV1>,
  progress?: Partial<PersistentWorkspaceProgressV1>,
  record?: {
    kind: 'finding' | 'decision' | 'question',
    summary: string,
    evidenceIds?: string[],
    provenance?: string | null,
    taskId?: string | null,
    turnSessionId?: string | null,
  },
}

// POST /workspace/:workspaceId/tasks
{
  expectedRevision: number,
  title: string,
  objective?: string,
  state?: 'pending' | 'active' | 'blocked' | 'completed' | 'cancelled' | 'failed',
  required?: false,
  dependencyIds?: string[],
  turnSessionId?: string | null,
}

// POST /workspace/:workspaceId/publications
{
  expectedRevision: number,
  category: 'task' | 'finding' | 'objective' | 'artifact',
  sourceId: string,
  sourceRevision?: number,
  sourceDigest?: string,
}

// DELETE .../publications/:publicationId and DELETE .../:workspaceId
{ expectedRevision: number }
```
Create and edit return `PersistentWorkspaceV1`; task creation returns
`PersistentWorkspaceTaskV1`; publication creation returns
`PersistentWorkspacePublicationV1`. Deleting a publication returns the
updated workspace, while deleting a workspace returns its deletion result.
These operations never return a canonical chat message.

The `PersistentWorkspaceV1` record includes its stable `id`, nullable live
`chatId`, objective and metadata, progress, active/archived state, monotonic
`revision`, created/updated timestamps, quota, and usage counters. Its child
resources are versioned and revisioned: Turn Session associations, tasks,
records, submissions, artifact metadata, and publications. Submissions are
read-only through this owner route; WORK admission controls their creation and
acceptance.
Owner tasks cannot be marked as required; required host-admitted work is
created and validated by the WORK host authority instead.

Every mutation is a revision compare-and-set. A malformed request or missing
revision is `400`; a stale revision or assignment race is `409
stale_workspace_revision`; a frozen workspace is `409 workspace_frozen`; a
quota breach is `413 workspace_quota_exceeded`; and a capability/authority
failure is `403 workspace_forbidden`. No mutation is silently merged.

The chat attachment is live source state, not the workspace's identity. Chat
deletion detaches the workspace and preserves its stable record; source
provenance records the detached/deleted state. A publication is an independent
bounded copy with source digest and provenance (including the originating
workspace/Turn Session/attempt and message/swipe identity when available).
Publication copies are noncanonical: they do not become chat messages, do not
rewrite source workspace records, and do not confer WORK authority.

## Context Library API

Context packs are account-owned, immutable-revision data with optional
attachments to a `preset`, `chat`, or `world_book` target. There is no project
scope. CRUD, attachment, ACL, export, and duplicate operations are
owner-scoped: the authenticated owner is derived from the session, and
non-owner or cross-owner access returns the same non-disclosing `404 Not found`.
Agentic context retrieval additionally rechecks the frozen candidate's ACL.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/context-packs` | List packs; query `include_disabled`, `include_review`, `limit`, `offset`. Returns `{ data, contextAclRevision }`. |
| `POST` | `/api/v1/context-packs` | Create `{ name, description?, visibility?, content, provenance? }`; returns `{ pack, revision }` (`201`). |
| `POST` | `/api/v1/context-packs/import` | Import an exact `PortableContextPackSnapshotV1`; returns `{ pack, revision, attached: false, reviewRequired: true }` (`201`). |
| `GET` | `/api/v1/context-packs/:packId` | Return `{ pack, revisions }`. |
| `PUT` | `/api/v1/context-packs/:packId` | Update with `{ name?, description?, visibility?, state?, expectedRevision }`; returns `{ pack, contextAclRevision }`. |
| `DELETE` | `/api/v1/context-packs/:packId` | Delete with required `?expected_revision=...`; returns `{ success, contextAclRevision }`. |
| `GET` | `/api/v1/context-packs/:packId/revisions` | List immutable revisions in `{ data }`; `include_inactive=true` is optional. |
| `POST` | `/api/v1/context-packs/:packId/revisions` | Create `{ content, expectedRevision?, provenance? }`; returns the revision (`201`). |
| `GET` | `/api/v1/context-packs/:packId/revisions/:revision` | Read one exact revision. |
| `GET` | `/api/v1/context-packs/:packId/acl` | Read ACL entries in `{ data }`. |
| `PUT` | `/api/v1/context-packs/:packId/acl` | Set `{ entries, expectedContextAclRevision }`; returns `{ data, contextAclRevision }`. |
| `POST` | `/api/v1/context-packs/:packId/review` | Set `{ state: 'active' | 'disabled', acknowledge: true, expectedRevision }`; returns `{ pack, contextAclRevision }`. |
| `GET` | `/api/v1/context-packs/:packId/attachments` | List attachments in `{ data }`; filter by `scope` and `target_id`. |
| `POST` | `/api/v1/context-packs/:packId/attachments` | Attach `{ scope: 'preset' | 'chat' | 'world_book', targetId, revision, position?, required?, provenance?, expectedContextAclRevision? }`; returns `{ attachment, contextAclRevision }` (`201`). |
| `DELETE` | `/api/v1/context-packs/:packId/attachments/:attachmentId` | Delete with required `scope` and `?expected_revision=...`; returns `{ success, contextAclRevision }`. |
| `GET` | `/api/v1/context-packs/:packId/export` | Export one selected immutable revision as `PortableContextPackSnapshotV1`; optional `?revision=...`. |
| `POST` | `/api/v1/context-packs/:packId/duplicate` | Duplicate with `{ name?, description?, preserveAttachments?, selectedAttachments? }`; returns `{ pack, revisions, attachments }` (`201`). |

`content` is an array of `ContextPackEntryV1` records
`{ id, title, body, tags }`. It is capped at 256 entries, 4 MiB total UTF-8
bytes, 128 bytes per ID, 256 bytes per title, 256 KiB per body, 32 tags per
entry, and 64 bytes per tag. Pack names are capped at 200 bytes,
descriptions at 8 KiB, and serialized provenance at 16 KiB. `provenance` is
the closed `{ kind: 'local' | 'portable_import' | 'archive_restore' |
'same_account_duplicate', sourceDigest?, sourcePackId?, archiveId? }`
shape; unknown keys are invalid.

ACL `entries` are `{ principalUserId, permission }` records, where permission
is `read | use | edit`; the authenticated owner remains the authority and
ACL writes are revision-CAS protected. Portable snapshots contain one selected
immutable revision and its content digest/counts, never ACLs or live
attachments.

`visibility` is `private | account | restricted`; pack/revision/attachment
`state` is `active | disabled | review_required | repair_required`. ACL
entries use `permission: 'read' | 'use' | 'edit'`. `review` accepts only
`active` or `disabled` with `acknowledge: true`; `expectedRevision` is
required for update/review, while attachment and ACL writes use the account
`expectedContextAclRevision` CAS. Revision/delete operations use their stated
`expectedRevision`/`expected_revision` precondition. Unknown or malformed
body/query values are `400` (`CONTEXT_PACK_INVALID`); missing/hidden owner
data is the non-disclosing `404`; stale pack or ACL revisions are `409` with
`CONTEXT_PACK_REVISION_CONFLICT` or `CONTEXT_PACK_ACL_REVISION_CONFLICT` and
the expected/actual revision fields.

Revision content is bounded and content-addressed by `contentDigest`,
`byteCount`, and `tokenCount`; revisions are immutable. ACL/revision/attachment
changes increment `contextAclRevision` and invalidate outstanding Agentic
decisions. During Agentic WORK, the reserved `context_pack_list` returns only
bounded metadata from the ASSEMBLE-frozen candidate set, and
`context_pack_get` requires an exact pack/revision and rechecks ACL before and
after reading bounded literal pages. A required access race fails the turn
closed; an optional denial returns one correlated non-disclosing observation.
Neither tool can run macros, mutate ACLs, or widen the candidate set.

The reserved Agentic WORK tools use closed envelopes (not REST request bodies):

```ts
context_pack_list({ limit?: number, offset?: number })
// success: { status: 'success', toolName: 'context_pack_list',
//   data: { candidates, total, limit, offset, truncated } }

context_pack_get({
  pack_id: string, revision_id: string, revision: number,
  limit?: number, offset?: number,
})
// success: { status: 'success', toolName: 'context_pack_get',
//   data: { packId, revisionId, revision, digest, records,
//           total, limit, offset, truncated } }
```

`context_pack_list` defaults to `limit: 20` and caps it at 32; `get` defaults
to 16 and caps it at 16. Both use a non-negative bounded `offset`, reject
unknown keys, and return `{ status: 'error', toolName, errorCode, message? }`
for `invalid_arguments`, `context_pack_not_found`,
`context_access_denied`, `context_access_invalidated`,
`context_pack_limit_exceeded`, `cancelled`, or `internal_error`. The frozen
candidate sources are account, preset, chat, and `world_book`; WORK cannot
widen them. A required candidate access/revision invalidation fails closed;
an optional denial or invalidation returns one correlated
`context_pack_not_found` observation without disclosing why.

## Standard generation compatibility events

Agentic runs also use the existing authenticated WebSocket/event bus:

| Event | Public compatibility payload |
|---|---|
| `GENERATION_STARTED` | `{ generationId, chatId, model, targetMessageId, targetSwipeId, generationType }`. |
| `STREAM_TOKEN_RECEIVED` | `{ generationId, chatId, token, seq, startSeq, offset }` for provisional final-render tokens only. It is not WORK prose, reasoning, tool data, or child output. |
| `MESSAGE_SENT` / `MESSAGE_EDITED` | `{ chatId, message }`, emitted only after the atomic commit; this is the canonical committed message handoff. |
| `GENERATION_ENDED` | `{ generationId, chatId, messageId?, content, targetMessageId?, targetSwipeId?, error? }` for terminal compatibility state. `content` is provisional stream content; `error` is the stable error code when present. |
| `GENERATION_STOPPED` | The same terminal field shape as `GENERATION_ENDED`, emitted for cancellation. |

Only `MESSAGE_SENT`/`MESSAGE_EDITED` carries the canonical committed message;
terminal `content` is not a persistence guarantee. Phase chronology and
activity-tree details come from Agent Run cursor projections. Events never
carry private WORK content, provider reasoning, tool arguments/results,
credentials, or child transcript. Unknown future projection events must be
ignored without treating the run as failed.


## Spindle extension endpoints

Extensions can also be managed via the HTTP API. These endpoints do not grant
their callbacks or tools to the strict Agentic runtime.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/spindle` | List all installed extensions |
| `POST` | `/api/v1/spindle/install` | Install from `{ github_url }` |
| `POST` | `/api/v1/spindle/:id/update` | Pull latest + rebuild |
| `DELETE` | `/api/v1/spindle/:id` | Remove extension |
| `POST` | `/api/v1/spindle/:id/enable` | Enable + start worker |
| `POST` | `/api/v1/spindle/:id/disable` | Disable + stop worker |
| `GET` | `/api/v1/spindle/:id/permissions` | Get requested and granted permissions |
| `POST` | `/api/v1/spindle/:id/permissions` | Grant/revoke: `{ grant: [...], revoke: [...] }` |
| `GET` | `/api/v1/spindle/:id/manifest` | Get parsed `spindle.json` |
| `GET` | `/api/v1/spindle/tools` | List all registered LLM tools for Response/direct surfaces |
| `GET` | `/api/v1/spindle/:id/frontend` | Serve frontend JS bundle |

### Install

```bash
curl -X POST http://localhost:7860/api/v1/spindle/install \
  -H 'Content-Type: application/json' \
  -d '{ "github_url": "https://github.com/you/my-extension" }'
```

`:id` in the routes below is the installed extension's database UUID, not
its manifest identifier. Obtain it from `GET /api/v1/spindle` (or the
`import-local` result) before issuing management calls.

```bash
# View permissions
curl http://localhost:7860/api/v1/spindle/${EXTENSION_ID}/permissions
# Grant permissions
curl -X POST http://localhost:7860/api/v1/spindle/${EXTENSION_ID}/permissions \
  -H 'Content-Type: application/json' \
  -d '{ "grant": ["generation", "interceptor"] }'

# Revoke permissions
curl -X POST http://localhost:7860/api/v1/spindle/${EXTENSION_ID}/permissions \
  -H 'Content-Type: application/json' \
  -d '{ "revoke": ["cors_proxy"] }'
```

### Enable / Disable

```bash
# Enable
curl -X POST http://localhost:7860/api/v1/spindle/${EXTENSION_ID}/enable

# Disable
curl -X POST http://localhost:7860/api/v1/spindle/${EXTENSION_ID}/disable
```

### Update and remove

```bash
curl -X POST http://localhost:7860/api/v1/spindle/${EXTENSION_ID}/update
curl -X DELETE http://localhost:7860/api/v1/spindle/${EXTENSION_ID}
```

## Implementation anchors

- `src/app.ts`: authenticated route mounting for `/api/v1/generate`,
  `/api/v1/chats`, `/api/v1/presets`, `/api/v1/agent-runs`, and
  `/api/v1/context-packs`.
- `src/routes/generate.routes.ts` and
  `src/services/agent-runtime-decision.service.ts`: effective-runtime
  normalization, generation body, mode errors, and stop compatibility.
- `src/routes/agent-runs.routes.ts`,
  `src/services/agent-run-projection.service.ts`, and
  `src/types/agent-run-projection.ts`: opaque chat cursors, redacted run DTOs,
  view-only workspace pages, and exact root Stop.
- `src/routes/agent-context-packs.routes.ts`,
  `src/services/agent-context-packs.service.ts`, and
  `src/types/agent-context-packs.ts`: owner-scoped Context Library,
  immutable revisions, ACL revisions, portable snapshots, and conflict codes.
- `src/ws/events.ts` and
  `src/services/agentic-generation-coordinator.service.ts`: standard
  compatibility event names and post-commit message handoff.
