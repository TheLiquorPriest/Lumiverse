# Lifecycle

## Installation

1. User provides a GitHub URL
2. Lumiverse clones the repo to `{DATA_DIR}/extensions/{identifier}/repo/`
3. Reads and validates `spindle.json`
4. If no `dist/` folder exists, runs `bun build` on `src/backend.ts` and `src/frontend.ts`
5. Extension is registered in the database
6. Backend runtime is started if the extension is enabled

## Enable / Disable

- **Enable:** starts the backend runtime and schedules the frontend module to load
- **Disable:** sends `shutdown` to the backend runtime (5s grace period), tears down the frontend module, unregisters all macros/interceptors/tools/context handlers, and stops any active frontend processes owned by the extension

By default, backend runtimes start in `process` mode. See [Runtime Modes](getting-started/runtime.md) for platform-specific behavior.

## Update

1. Runs `git pull` in the extension's repo directory
2. Re-reads `spindle.json`
3. Rebuilds from source if needed
4. Restarts the backend runtime if the extension was running

## Removal

1. Stops the backend runtime
2. Deletes the database row (cascades permission grants)
3. Deletes the extension directory (repo + storage)

## Startup Order

On Lumiverse boot, all enabled extensions are started after database migrations complete. Extensions should not depend on a specific load order.
---

## WORK Engine lifecycle

The WORK Engine is a strict, single-turn runtime behind the authenticated
generation routes. A request creates one **Turn Session** and one immutable
attempt lineage. The request is admitted only after the server resolves the
authenticated target, runtime mode, concrete provider capability set, frozen
input revisions, and readiness gates. A request that asks for WORK never
silently becomes Response.

### Phase, status, and outcome vocabulary

The public Agent Run lifecycle is:

`ADMIT` → `ASSEMBLE` → `WORK` → `PREPARE_COMMIT` → `RENDER` → `COMMIT` →
`TERMINAL`.

`PREPARE_COMMIT` is the public completion/freeze handoff. At that boundary,
the host has accepted completion and frozen the workspace and render context
that final rendering will consume. These public phases are projections; do not
derive their order from the runtime's similarly named internal states.

The status is one of `pending`, `running`, `waiting`, `cancelling`, or
`terminal`. A terminal Turn Session has one outcome: `completed`, `stopped`,
`failed`, `exhausted`, or `rejected`. `workPhase`, `workStatus`, and
`workOutcome` are independent fields; a client must not infer one from another
or from stream silence.
For every nonterminal execution phase, `workOutcome` is `null`; the status
remains phase-specific (`pending`, `running`, `waiting`, or `cancelling`).
`COMMITTED` is the only successful terminal boundary and projects to
`completed`. `CANCELLED` projects to `stopped`, `TIMED_OUT` (including
`root_wall_clock_limit_exceeded`) projects to `failed`, and `EXHAUSTED`
projects to `exhausted` only for a host-enforced budget or limit exhaustion.


Every public run carries `attemptLineage`:

```ts
{
  version: 1,
  attemptId: string,
  previousAttemptId: string | null,
  target: {
    chatId: string,
    generationType: 'normal' | 'continue' | 'regenerate' | 'swipe',
    messageId: string | null,
    swipeId: number | null,
  },
  createdAt: number,
}
```

The `attemptId` identifies this attempt; a retry creates a new attempt whose
`previousAttemptId` points to the inspected terminal attempt. A refused retry
creates no attempt, projection, or terminal publication.

### Request through terminal behavior

1. **Request:** the authenticated client posts `/api/v1/generate` (or the
   canonical regenerate/continue route) with `chat_id` and an explicit
   `mode`. Omitting `mode` retains the existing Response path.
2. **Admission:** `mode: 'agentic'` consumes the one-use effective-runtime
   decision (or performs the same authenticated resolution when no token is
   supplied). Target, revision, capability, isolate, publication, context,
   and kill-switch changes fail closed.
3. **Assembly:** the host freezes the `GenerationAssemblySnapshotV1` and
   produces an `AssemblyPlanV1`. No provider request or workspace mutation is
   made before the plan passes validation.
4. **WORK:** deterministic child descriptors run in order, then the root
   provider may use only its admitted tool/delegation capabilities. WORK
   notes and private child material are retained only for owner inspection.
5. **Completion handoff and render:** public `PREPARE_COMMIT` marks accepted
   completion and freezes the workspace and render context. Public `RENDER`
   then produces the final response with tools disabled. A tool call in
   finalization is a protocol failure, not another delegation.
6. **Commit or terminal:** public `COMMIT` includes the pure, snapshot-bound
   `prepareRender()` processing and the durable commit attempt. One
   compare-and-set owner decides whether the canonical write can begin. A
   successful durable commit writes the message/swipe and terminal receipt in
   one transaction. Cancellation, deadline, provider failure, required-work
   failure, or exhaustion before that boundary produces a terminal outcome
   without an authoritative chat write.

The immutable execution row is terminal cause authority. Terminal publication
then uses one exact-identity transaction for the persistent Turn Session,
inspection attempt, Agent Run projection, compatibility activity, and terminal
outbox. Only after that transaction commits may the Agentic pool or compatibility
websocket event become terminal. If convergence is interrupted, the original
WORK/COMMIT cause remains unchanged and startup or exact dormant Stop repairs
the durable owner surfaces idempotently without replaying provider work.
This includes failures after durable admission but before workspace setup
finishes. Cleanup releases process resources only. When source-chat deletion
has already removed every chat-owned projection, recovery converges the
surviving detached Turn Session from the terminal execution and emits no chat
event.

Internally, after WORK completes and freezes, the orchestrator enters
`COMPLETE`, enters `RENDER` and calls `render()`, then enters its internal
`PREPARE_COMMIT` state and calls `prepareRender()` before `commit()`.
Those are implementation states and calls, not additional public phases.
Internal `COMPLETE` supplies the public `PREPARE_COMMIT` completion handoff,
and internal `RENDER` supplies public `RENDER`. Internal `PREPARE_COMMIT`,
which calls `prepareRender()`, and `COMMITTING` both project as public `COMMIT`.
They do not insert another public completion handoff after `RENDER`; the durable
commit CAS and transaction remain the only authority for the canonical write.

`POST /api/v1/agent-runs/:turnId/stop` returns `accepted` only while the run
is reversible, `too_late` after the completion boundary, or `terminal` once a
terminal owner has settled it. The compatibility
`POST /api/v1/generate/stop` route returns `{ stopped: boolean, status: "accepted" | "too_late" | "not_found" }`; use the
Agent Run Stop route when the phase distinction matters.
If live terminal publication failed and its in-memory generation registration has
already been released, generic generation Stop resolves the exact owner/chat/turn
execution, repairs its durable terminal surfaces, and only then settles the
visible pool. A mismatched owner or chat cannot invoke this recovery.

### Inspection, recovery, and retention

The authenticated owner follows a run through the Agent Run projection and
owner inspection surfaces, not by interpreting event silence or message text.
Inspection list/detail reads re-check the authenticated owner, chat, attempt,
target, and stored Turn Session identity. A foreign, missing, expired, or
no-longer-visible record is a non-disclosing `404`.

Inspection is layered: summary/activity, Turn Session entries, transcript
records, prompt evidence, Cortex/Council receipts, workspace associations,
usage evidence, and causal error detail are separate retained projections.
Bounded omission markers identify reconnect gaps, truncation, unavailable
layers, withheld credentials, and recovered duplicates. Public run payloads
remain status-only and never contain prompts, work prose, provider carriers,
tool arguments/results, credentials, or private child content.

The inspection service bounds each payload to 64 KiB, each audit record to
128 KiB, each attempt to 4,096 records, and each list response to 64 runs.
These are retention/read bounds, not a promise that every private event is
available. The activity fallback is separately bounded to the newest 16
runs per chat and 512 KiB total.

Recovery is host-owned. `recoveryEligible` and `recoveryAction` are returned
with the run/error projection; clients must not manufacture a retry or repair
action. `POST /api/v1/agent-runs/:attemptId/retry` accepts only an empty body
or `{}` and admits only an owner-scoped terminal attempt with a still-valid
target and retryable outcome (`failed`, `exhausted`, or `stopped`). The `202`
response contains the new attempt lineage only after durable admission.

### Context ownership and prompt handoff

World Books and Databanks remain native, live context systems outside Loom. World Books own lore activation, placement, attachment, editing, and access; Databanks own document attachment, editing, access, semantic retrieval, and explicit `#slug` retrieval. [Context Filters](../../user-docs/docs/presets/context-filters.md) and unrelated native Loom content [packs](../../user-docs/docs/packs/index.md) remain supported. Loom does not copy, pin, or repair these objects.

Loom owns only existing prompt blocks plus **Phased Instructions**. Fixed buckets route work policy and workspace usage to root **WORK** / **WORK**, completion criteria to completion handoff / **PREPARE_COMMIT**, and render policy to tools-disabled **RENDER** / **RENDER**. Conditions fail closed at their owning checkpoint against its immutable snapshot and remain fixed. Custom phases are bounded and current-phase-only with explicit per-child instruction subsets.

Unified owner inspection explains route/order, roles, conditions, source identities and revisions/hashes when recorded, destination-level deduplication, omissions, custom-phase/child-subset receipts, accepted WORK-to-RENDER crossings, and tools/delegation. Unavailable evidence is marked unavailable and never inferred. Only bounded host-accepted findings, accepted task submissions, and explicitly response-shaping completion guidance cross private WORK; ordinary Response preserves the conversation and native World Book/Databank assembly while omitting private WORK. The retired **Context Pack**, **Context Library**, and **Progressive Context** surfaces are unsupported.
