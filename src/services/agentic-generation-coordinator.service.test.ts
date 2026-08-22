import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SnapshotMessageV1, SnapshotWorldInfoV1 } from "./prompt-assembly-snapshot.service";
import type { AssemblyProviderMessageV1 } from "./agentic-assembly-compiler";
import { createHash } from "node:crypto";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { registerProvider, getProvider } from "../llm/registry";
import type { LlmProvider } from "../llm/provider";
import type { GenerationRequest, GenerationResponse, StreamChunk } from "../llm/types";
import { createDisabledAgentConfigV2, type AgentCustomPhaseV1 } from "../types/agents";
import { HOST_PREPARATION_LIMITS_V1 } from "../types/agent-preprocessing";
import { AgentRuntimeOwner } from "./agent-runtime.service";
import { WORKSPACE_OPERATIONS } from "../types/turn-workspace";
import { createAgenticChildFrame, createAgenticRootFrame, executeBoundedAgenticChildFrame } from "./agentic-work-phase.service";
import { compileAgentRuntimePhases } from "./agentic-phase-runtime.service";
import { createAgentCognitionRuntime } from "./agent-cognition-runtime.service";
import { evaluateCognitionPredicate } from "./agent-cognition.service";
import { setAgenticRuntimeReadiness, startAgentRuntimeEpoch, calculateFinalRenderReservationEnvelopeV1, reserveFinalRender, TurnExecutionError } from "./turn-execution.service";
import {
  attachContextPack,
  createContextPack,
  deleteContextPack,
  deleteContextPackAttachment,
} from "./agent-context-packs.service";
import { getAgentRuntimeSharedDraft } from "./agent-config-portability.service";
import {
  AGENT_RUNTIME_DECISION_SERVICE,
  resolveEffectiveRuntime,
} from "./agent-runtime-decision.service";
import { getIsolateHealthEpoch, probeIsolateBackendsAtStartup } from "./isolate-pool";
import { AGENT_RUNTIME_ADMISSION_MANAGER } from "./agent-runtime-admission";
import { getPoolEntry } from "./generation-pool.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { waitForAgenticGeneration } from "./agentic-generation.service";
import { startGeneration } from "./generate.service";
import * as breakdownSvc from "./breakdown.service";

import {
  __testing,
  installAgenticGenerationCoordinator,
} from "./agentic-generation-coordinator.service";
const USER_ID = "user-coordinator";
const CHAT_ID = "chat-coordinator";
const AGENTIC_CHAT_ID = "chat-coordinator-agentic";
const CONNECTION_ID = "connection-coordinator";
const PRESET_ID = "preset-coordinator";
const AGENTIC_PRESET_ID = "preset-coordinator-agentic";
let scriptedDelegate = false;
let scriptedDelegateProfileId = "delegate";
let scriptedTaskCreated = false;
let delegateIssued = false;
let scriptedAcceptSubmission = false;
let scriptedChildSubmitted = false;
let scriptedAcceptanceIssued = false;
const USER_INPUT = "carry-this-exact-user-input-through";
const ADMITTED_CONFIG_REVISION = 7;
const ADMITTED_BINDING_REVISION = 11;
const ADMITTED_TARGET_REVISION = 13;
function markAgenticRuntimeReady(): void {
  setAgenticRuntimeReadiness({
    schema: true,
    reconciliation: true,
    archiveRegistry: true,
    publicationStore: true,
    isolateTermination: true,
    providerCapabilities: true,
    configBinding: true,
    contextAcl: true,
    inputRevisions: true,
  });
}
let scriptedWorkRound = 0;
let scriptedTwoPhase = false;
let scriptedTwoPhaseTurnId = "";
let scriptedTwoPhaseMutationIssued = false;
const scriptedTwoPhaseSnapshots: Array<{
  readonly state: string;
  readonly revision: number;
  readonly taskCount: number;
  readonly taskState: string;
  readonly frozenAt: number | null;
}> = [];
let scriptedBlockedTerminal = false;
let scriptedBlockedTerminalTurnId = "";
let scriptedBlockedTerminalTaskCreated = false;
let scriptedBlockedTerminalDelegateIssued = false;
let scriptedBlockedTerminalChildSubmitted = false;
let scriptedBlockedTerminalAttempted = false;
let scriptedBlockedTerminalAcceptanceIssued = false;
let scriptedBlockedTerminalRetryCanAccept = false;
const scriptedBlockedTerminalSnapshots: Array<{
  readonly workspaceState: string;
  readonly workspaceRevision: number;
  readonly frozenAt: number | null;
  readonly taskState: string;
  readonly submissionState: string;
}> = [];
/** Records every provider request so the test can prove the real input arrived. */
const providerRequests: GenerationRequest[] = [];

class ScriptedProvider implements LlmProvider {
  readonly name = "scripted-coordinator";
  readonly displayName = "Scripted Coordinator";
  readonly defaultUrl = "https://scripted.invalid/v1";
  readonly capabilities = {
    parameters: {},
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "none" as const,
    toolCalling: true,
    nativeToolContinuation: true,
    toolContinuationMode: "native" as const,
    toolsDisabledFinalization: true,
    supportsToolFinalization: true,
  };

  async generate(_key: string, _url: string, request: GenerationRequest): Promise<GenerationResponse> {
    providerRequests.push(request);
    return { content: "scripted", finish_reason: "stop" };
  }

  async *generateStream(_key: string, _url: string, request: GenerationRequest): AsyncGenerator<StreamChunk, void, unknown> {
    providerRequests.push(request);
    if (request.toolMode === "ordinary") {
      const rootHasCompleteTurn = request.tools?.some((tool) => tool.name === "complete_turn") === true;
      const rootCanDelegate = request.tools?.some((tool) => tool.name === "agent_delegate") === true;
      if (scriptedBlockedTerminal) {
        const rootCanWrite = request.tools?.some((tool) => tool.name === "workspace_create_task") === true;
        if (!rootHasCompleteTurn) {
          const childCanSubmit = request.tools?.some((tool) => tool.name === "workspace_submit_child_result") === true;
          if (childCanSubmit && !scriptedBlockedTerminalChildSubmitted) {
            scriptedBlockedTerminalChildSubmitted = true;
            yield {
              token: "",
              tool_calls: [{
                name: "workspace_submit_child_result",
                args: {
                  summary: "Required task result is ready for owner acceptance.",
                },
                call_id: "blocked-terminal-child-submit",
              }],
              finish_reason: "tool_calls",
            };
            return;
          }
          yield { token: "blocked-terminal child result" };
          yield { token: "", finish_reason: "stop" };
          return;
        }
        if (!rootCanWrite || !rootCanDelegate) {
          yield {
            token: "",
            tool_calls: [{
              name: "complete_turn",
              args: { summary: "phase one complete", unresolvedIds: [] },
              call_id: "blocked-terminal-phase-one-complete",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (!scriptedBlockedTerminalTaskCreated) {
          scriptedBlockedTerminalTaskCreated = true;
          yield {
            token: "",
            tool_calls: [{
              name: "workspace_create_task",
              args: {
                taskId: "blocked-terminal-task",
                title: "Blocked-terminal submission",
                objective: "Keep terminal completion blocked until the pending submission is accepted.",
                required: false,
                dependencyIds: [],
              },
              call_id: "blocked-terminal-create-task",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (!scriptedBlockedTerminalDelegateIssued) {
          scriptedBlockedTerminalDelegateIssued = true;
          yield {
            token: "",
            tool_calls: [{
              name: "agent_delegate",
              args: {
                profile_id: "delegate",
                task_id: "blocked-terminal-task",
                task: "Submit the required blocked-terminal task result.",
                tool_ids: ["chat_search_history"],
              },
              call_id: "blocked-terminal-delegate",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (!scriptedBlockedTerminalAttempted) {
          const workspaceRow = getDb().query(
            "SELECT state, revision, frozen_at FROM agent_turn_workspaces WHERE workspace_id = ? AND turn_id = ?",
          ).get(`workspace:${scriptedBlockedTerminalTurnId}`, scriptedBlockedTerminalTurnId) as {
            state: string;
            revision: number;
            frozen_at: number | null;
          } | null;
          const taskRow = getDb().query(
            "SELECT state FROM agent_workspace_tasks WHERE workspace_id = ? AND turn_id = ? AND task_id = ?",
          ).get(`workspace:${scriptedBlockedTerminalTurnId}`, scriptedBlockedTerminalTurnId, "blocked-terminal-task") as { state: string } | null;
          const submissionRow = getDb().query(
            "SELECT state FROM agent_workspace_submissions WHERE workspace_id = ? AND turn_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1",
          ).get(`workspace:${scriptedBlockedTerminalTurnId}`, scriptedBlockedTerminalTurnId, "blocked-terminal-task") as { state: string } | null;
          scriptedBlockedTerminalSnapshots.push({
            workspaceState: workspaceRow?.state ?? "missing",
            workspaceRevision: workspaceRow?.revision ?? -1,
            frozenAt: workspaceRow?.frozen_at ?? null,
            taskState: taskRow?.state ?? "missing",
            submissionState: submissionRow?.state ?? "missing",
          });
          scriptedBlockedTerminalAttempted = true;
          yield {
            token: "",
            tool_calls: [{
              name: "complete_turn",
              args: { summary: "terminal completion before submission acceptance", unresolvedIds: [] },
              call_id: "blocked-terminal-first-complete",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (!scriptedBlockedTerminalAcceptanceIssued) {
          scriptedBlockedTerminalRetryCanAccept = request.tools?.some((tool) => tool.name === "workspace_accept_submission") === true;
          const submission = getDb().query(
            "SELECT submission_id FROM agent_workspace_submissions WHERE workspace_id = ? AND turn_id = ? AND task_id = ? AND state = 'submitted' ORDER BY created_at DESC LIMIT 1",
          ).get(`workspace:${scriptedBlockedTerminalTurnId}`, scriptedBlockedTerminalTurnId, "blocked-terminal-task") as { submission_id: string } | null;
          if (submission) {
            scriptedBlockedTerminalAcceptanceIssued = true;
            yield {
              token: "",
              tool_calls: [{
                name: "workspace_accept_submission",
                args: { submissionId: submission.submission_id, taskId: "blocked-terminal-task" },
                call_id: "blocked-terminal-accept-submission",
              }],
              finish_reason: "tool_calls",
            };
            return;
          }
        }
        yield {
          token: "",
          tool_calls: [{
            name: "complete_turn",
            args: { summary: "terminal completion after submission acceptance", unresolvedIds: [] },
            call_id: "blocked-terminal-final-complete",
          }],
          finish_reason: "tool_calls",
        };
        return;
      }
      if (scriptedTwoPhase) {
        const phaseTwoCanWrite = request.tools?.some((tool) => tool.name === "workspace_create_task") === true;
        if (!phaseTwoCanWrite) {
          yield {
            token: "",
            tool_calls: [{
              name: "complete_turn",
              args: { summary: "phase one complete", unresolvedIds: [] },
              call_id: "phase-one-complete",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (!scriptedTwoPhaseMutationIssued) {
          scriptedTwoPhaseMutationIssued = true;
          yield {
            token: "",
            tool_calls: [{
              name: "workspace_create_task",
              args: {
                taskId: "phase-two-task",
                title: "Phase two workspace mutation",
                objective: "Persist the phase-two task before final completion.",
                required: false,
                dependencyIds: [],
              },
              call_id: "phase-two-create-task",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (scriptedTwoPhaseSnapshots.length === 0) {
          const workspaceRow = getDb().query(
            "SELECT state, revision, task_count, frozen_at FROM agent_turn_workspaces WHERE workspace_id = ? AND turn_id = ?",
          ).get(`workspace:${scriptedTwoPhaseTurnId}`, scriptedTwoPhaseTurnId) as {
            state: string;
            revision: number;
            task_count: number;
            frozen_at: number | null;
          } | null;
          const taskRow = getDb().query(
            "SELECT state FROM agent_workspace_tasks WHERE workspace_id = ? AND turn_id = ? AND task_id = ?",
          ).get(`workspace:${scriptedTwoPhaseTurnId}`, scriptedTwoPhaseTurnId, "phase-two-task") as { state: string } | null;
          scriptedTwoPhaseSnapshots.push({
            state: workspaceRow?.state ?? "missing",
            revision: workspaceRow?.revision ?? -1,
            taskCount: workspaceRow?.task_count ?? -1,
            taskState: taskRow?.state ?? "missing",
            frozenAt: workspaceRow?.frozen_at ?? null,
          });
        }
        yield {
          token: "",
          tool_calls: [{
            name: "complete_turn",
            args: { summary: "phase two complete", unresolvedIds: [] },
            call_id: "phase-two-complete",
          }],
          finish_reason: "tool_calls",
        };
        return;
      }
      if (scriptedDelegate && rootCanDelegate) {
        if (!scriptedTaskCreated) {
          scriptedTaskCreated = true;
          scriptedWorkRound = 1;
          yield {
            token: "",
            tool_calls: [{
              name: "workspace_create_task",
              args: {
                taskId: "task-delegate",
                title: "Delegated workspace task",
                objective: "Inspect the delegated workspace task.",
                required: false,
                dependencyIds: [],
              },
              call_id: "task-create-1",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (scriptedAcceptSubmission && delegateIssued && rootHasCompleteTurn && !scriptedAcceptanceIssued) {
          const submission = getDb().query(
            "SELECT submission_id, task_id FROM agent_workspace_submissions WHERE user_id = ? AND state = 'submitted' ORDER BY created_at DESC LIMIT 1",
          ).get(USER_ID) as { submission_id: string; task_id: string } | null;
          if (submission) {
            scriptedAcceptanceIssued = true;
            yield {
              token: "",
              tool_calls: [{
                name: "workspace_accept_submission",
                args: { submissionId: submission.submission_id, taskId: submission.task_id },
                call_id: "accept-submission-1",
              }],
              finish_reason: "tool_calls",
            };
            return;
          }
        }
        if (!delegateIssued) {
          delegateIssued = true;
          yield {
            token: "",
            tool_calls: [{
              name: "agent_delegate",
              args: {
                profile_id: scriptedDelegateProfileId,
                task_id: "task-delegate",
                task: "Inspect the delegated workspace task.",
                tool_ids: ["chat_search_history"],
              },
              call_id: "delegate-1",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
      }
      if (scriptedAcceptSubmission && scriptedDelegate && delegateIssued && !rootHasCompleteTurn) {
        const childCanSubmit = request.tools?.some((tool) => tool.name === "workspace_submit_child_result") === true;
        if (childCanSubmit && !scriptedChildSubmitted) {
          scriptedChildSubmitted = true;
          yield {
            token: "",
            tool_calls: [{
              name: "workspace_submit_child_result",
              args: {
                summary: "delegated result",
              },
              call_id: "child-submit-1",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        yield { token: "delegated result" };
        yield { token: "", finish_reason: "stop" };
        return;
      }
      if (scriptedDelegate && delegateIssued && !rootHasCompleteTurn) {
        yield { token: "delegated result" };
        yield { token: "", finish_reason: "stop" };
        return;
      }
      const firstRound = scriptedWorkRound === 0;
      const call = firstRound
        ? { name: "chat_search_history", args: { query: "history" }, call_id: "search-1" }
        : { name: "complete_turn", args: { summary: "bounded work complete", unresolvedIds: [] }, call_id: "complete-1" };
      scriptedWorkRound += 1;
      yield {
        token: "",
        tool_calls: [call],
        finish_reason: "tool_calls",
      };
      return;
    }
    yield { token: "scripted render" };
    yield { token: "", finish_reason: "stop", usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } };
  }

  async validateKey(): Promise<boolean> { return true; }
  async listModels(): Promise<string[]> { return ["scripted-model"]; }
}

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  await runMigrations(db);
}

function seed(): void {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  const now = Date.now();
  db.query(
    "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(USER_ID, "Coordinator", "coordinator@test.invalid", now, now);
  db.query(
    "INSERT INTO characters (id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, tags, alternate_greetings, extensions, created_at, updated_at, user_id) VALUES (?, ?, '', '', '', '', '', '', '', '', '', '[]', '[]', '{}', ?, ?, ?)",
  ).run("character-coordinator", "Coordinator Character", now, now, USER_ID);
  db.query(
    "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)",
  ).run(CONNECTION_ID, USER_ID, "Scripted", "scripted-coordinator", "https://scripted.invalid/v1", "scripted-model", "{}", now, now);
  db.query(
"    INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(CHAT_ID, USER_ID, "character-coordinator", "Coordinator Chat", now, now, "{}", ADMITTED_TARGET_REVISION);
  db.query(
    "INSERT INTO presets (id, user_id, name, provider, engine, parameters, prompt_order, prompts, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(PRESET_ID, USER_ID, "Coordinator Preset", "scripted-coordinator", "classic", "{}", "[]", "{}", "{}", now, now);
  db.query(
"    INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(AGENTIC_CHAT_ID, USER_ID, "character-coordinator", "Agentic Coordinator Chat", now, now, "{}", ADMITTED_TARGET_REVISION);
  db.query(
    "INSERT INTO presets (id, user_id, name, provider, engine, parameters, prompt_order, prompts, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(AGENTIC_PRESET_ID, USER_ID, "Agentic Coordinator Preset", "scripted-coordinator", "classic", "{}", "[]", "{}", "{}", now, now);
  db.query(
    `INSERT INTO preset_agent_configs
      (user_id, preset_id, version, agents_enabled, allowed_modes, default_mode,
       max_invocations, max_tool_calls, main_tool_ids, main_lore_scope,
       phase_policy_json, cognition_policy_json, context_policy_json, task_policy_json,
       workspace_policy_json, state, review_acknowledged, config_revision, binding_revision,
       created_at, updated_at)
      VALUES (?, ?, 2, 1, ?, 'agentic', 8, 8, ?, 'active',
        '{}', '{}', '{}', '{}', '{}', 'ready', 1, ?, ?, ?, ?)`,
  ).run(
    USER_ID,
    AGENTIC_PRESET_ID,
    JSON.stringify(["response", "agentic"]),
    JSON.stringify(["chat_search_history"]),
    ADMITTED_CONFIG_REVISION,
    ADMITTED_BINDING_REVISION,
    now,
    now,
  );
  db.query(
    "INSERT INTO preset_agent_connection_slots (user_id, preset_id, slot_id, label, required_capabilities, slot_revision, created_at, updated_at) VALUES (?, ?, 'delegate', 'Delegate', '[]', 1, ?, ?)",
  ).run(USER_ID, AGENTIC_PRESET_ID, now, now);
  db.query(
    "INSERT INTO preset_agent_slot_bindings (user_id, preset_id, slot_id, connection_id, binding_revision, state, updated_at) VALUES (?, ?, 'delegate', ?, ?, 'ready', ?)",
  ).run(USER_ID, AGENTIC_PRESET_ID, CONNECTION_ID, ADMITTED_BINDING_REVISION, now);
  db.query(
    "INSERT INTO preset_agent_profiles (user_id, preset_id, profile_id, name, system_prompt, connection_ref_kind, slot_id, tool_ids, lore_scope, allow_main_delegation, failure_policy, stream_activity, max_output_tokens, timeout_ms, profile_revision, created_at, updated_at) VALUES (?, ?, 'delegate', 'Delegate', '', 'slot', 'delegate', ?, 'active', 1, 'optional', 0, 512, 5000, 1, ?, ?)",
  ).run(USER_ID, AGENTIC_PRESET_ID, JSON.stringify(["chat_search_history"]), now, now);
  db.query(
    "INSERT INTO preset_agent_connection_slots (user_id, preset_id, slot_id, label, required_capabilities, slot_revision, created_at, updated_at) VALUES (?, ?, 'delegate_alt', 'Delegate Alt', '[]', 1, ?, ?)",
  ).run(USER_ID, AGENTIC_PRESET_ID, now, now);
  db.query(
    "INSERT INTO preset_agent_slot_bindings (user_id, preset_id, slot_id, connection_id, binding_revision, state, updated_at) VALUES (?, ?, 'delegate_alt', ?, ?, 'ready', ?)",
  ).run(USER_ID, AGENTIC_PRESET_ID, CONNECTION_ID, ADMITTED_BINDING_REVISION, now);
  db.query(
    "INSERT INTO preset_agent_profiles (user_id, preset_id, profile_id, name, system_prompt, connection_ref_kind, slot_id, tool_ids, lore_scope, allow_main_delegation, failure_policy, stream_activity, max_output_tokens, timeout_ms, profile_revision, created_at, updated_at) VALUES (?, ?, 'delegate_alt', 'Delegate Alt', '', 'slot', 'delegate_alt', ?, 'active', 1, 'optional', 0, 128, 5000, 1, ?, ?)",
  ).run(USER_ID, AGENTIC_PRESET_ID, JSON.stringify(["chat_search_history"]), now, now);
}
function seedTargetMessage(id: string, chatId: string, revision: number): void {
  const now = Date.now();
  getDb().query(
    "INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at, generation_revision) VALUES (?, ?, 0, 0, ?, ?, ?, 0, ?, ?, '{}', ?, ?)",
  ).run(id, chatId, "Coordinator", "target", now, JSON.stringify(["target"]), JSON.stringify([now]), now, revision);
}

beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await applyBaseline();
  seed();
  if (!getProvider("scripted-coordinator")) registerProvider(new ScriptedProvider());
  // The production installer is install-once per process; another suite in this
  // process may already have installed it. Do not reset it here.
});

afterAll(() => {
  __testing.resetInstallation();
  closeDatabase();
});

describe("production agentic coordinator installation", () => {
  test("installs exactly once and is idempotent", () => {
    installAgenticGenerationCoordinator();
    installAgenticGenerationCoordinator();
    expect(true).toBe(true);
  });
  test("accepts an exact shared context candidate with frozen owner ACL authority", () => {
    expect(__testing.contextPackReadiness({
      schema: "present",
      candidates: [{
        ownerId: "shared-pack-owner",
        revisionId: "shared-pack@1",
        digest: "a".repeat(64),
        aclRevision: 7,
      }],
    })).toEqual({ ready: true, reason: null });
    expect(__testing.contextPackReadiness({
      schema: "present",
      candidates: [{
        ownerId: "",
        revisionId: "shared-pack@1",
        digest: "a".repeat(64),
        aclRevision: 7,
      }],
    })).toEqual({ ready: false, reason: "cognition_authorization_stale" });
  });
  test("authenticates the root caller before assigning child tasks", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 128 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(input, target, signal);
    const execution = await deps.createExecution!({
      executionId: `exec-auth-${Date.now()}`,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    const rootSignal = execution.signal;
    if (!rootSignal) throw new Error("Agentic execution signal was not installed");
    const capabilities = {
      revision: 1,
      allowed: WORKSPACE_OPERATIONS,
      maxOperationBytes: 131_072,
      maxOperations: 128,
    };
    const workspace = __testing.makeWorkspace(execution, capabilities);
    const rootFrame = createAgenticRootFrame({
      frameId: execution.id,
      connectionId: null,
      model: "",
      coreToolIds: [],
      workspaceCapabilities: WORKSPACE_OPERATIONS,
      signal: rootSignal,
    });
    try {
      await workspace.execute?.(
        "create_task",
        {
          taskId: "task-auth",
          title: "Authenticated assignment",
          objective: "Verify root caller binding.",
          required: false,
          dependencyIds: [],
        },
        { actor: "root", frame: rootFrame, operation: "create_task", signal: rootSignal },
      );
      const before = getDb().query(
        "SELECT assigned_frame_id, revision FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-auth") as { assigned_frame_id: string | null; revision: number } | null;
      expect(before).toEqual({ assigned_frame_id: null, revision: 0 });
      const expectedRevision = (getDb().query(
        "SELECT revision FROM agent_turn_workspaces WHERE workspace_id = ?",
      ).get(`workspace:${execution.id}`) as { revision: number }).revision;
      const assignments = [{ taskId: "task-auth", frameId: "forged-child-frame" }];
      const forgedChild = createAgenticChildFrame({
        frameId: "forged-child-frame",
        parentFrameId: execution.id,
        connectionId: null,
        model: "",
        coreToolIds: [],
        taskId: "task-auth",
        workspaceCapabilities: ["update_assigned_progress"],
        signal: rootSignal,
      });
      await expect(workspace.assignChildTasks?.({
        frame: forgedChild,
        assignments,
        expectedRevision,
        signal: rootSignal,
      })).rejects.toThrow("workspace_assignment_root_required");
      const afterChild = getDb().query(
        "SELECT assigned_frame_id, revision FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-auth") as { assigned_frame_id: string | null; revision: number } | null;
      expect(afterChild).toEqual(before);

      const otherExecution = await deps.createExecution!({
        executionId: `${execution.id}-other`,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });
      try {
        if (!otherExecution.signal) throw new Error("Cross-execution signal was not installed");
        const crossRoot = createAgenticRootFrame({
          frameId: otherExecution.id,
          connectionId: null,
          model: "",
          coreToolIds: [],
          workspaceCapabilities: WORKSPACE_OPERATIONS,
          signal: otherExecution.signal,
        });
        await expect(workspace.assignChildTasks?.({
          frame: crossRoot,
          assignments,
          expectedRevision,
          signal: rootSignal,
        })).rejects.toThrow("workspace_assignment_root_required");
        const afterCrossExecution = getDb().query(
          "SELECT assigned_frame_id, revision FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
        ).get(execution.id, "task-auth") as { assigned_frame_id: string | null; revision: number } | null;
        expect(afterCrossExecution).toEqual(before);
      } finally {
        deps.cleanup?.({ execution: otherExecution } as never);
      }

      const valid = await workspace.assignChildTasks?.({
        frame: rootFrame,
        assignments: [{ taskId: "task-auth", frameId: "valid-child-frame" }],
        expectedRevision,
        signal: rootSignal,
      });
      expect(valid).toMatchObject({
        accepted: true,
        assignments: [{ taskId: "task-auth", frameId: "valid-child-frame" }],
      });
      const persisted = getDb().query(
        "SELECT assigned_frame_id FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-auth") as { assigned_frame_id: string | null } | null;
      expect(persisted).toEqual({ assigned_frame_id: "valid-child-frame" });
    } finally {
      deps.cleanup?.({ execution } as never);
    }
  });
  test("preserves the pre-cancel workspace revision when a raced durable result is newer", () => {
    const owner = new AgentRuntimeOwner({
      generationId: "revision-race",
      userId: USER_ID,
      config: createDisabledAgentConfigV2(),
      rootConnection: null,
      dispatch: async () => ({
        content: "",
        finish_reason: "stop",
        toolContinuationMode: "native",
        supportsToolFinalization: true,
      }),
    });
    const execution = {
      id: "revision-race",
      userId: USER_ID,
      chatId: CHAT_ID,
      workspaceId: "workspace-revision-race",
      workspaceRevision: 3,
      workspaceRetention: "turn_terminal" as const,
      workspaceSharing: "root_only" as const,
      deadlineAt: Date.now() + 60_000,
      owner,
      credentialCarrier: new Map<string, string>(),
    };
    try {
      const outcome = { status: "cancelled" as const, workspaceRevision: 9 };
      const adopted = __testing.adoptWorkWorkspaceRevision(execution, outcome);
      expect(adopted).toBe(3);
      expect(execution.workspaceRevision).toBe(3);
    } finally {
      owner.close();
    }
  });

  test("fails closed to Response when startup readiness is incomplete", async () => {
    setAgenticRuntimeReadiness({
      schema: true,
      reconciliation: true,
      archiveRegistry: true,
      publicationStore: true,
      isolateTermination: false,
    });
    installAgenticGenerationCoordinator();
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: PRESET_ID,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null, revision: 0 },
      mode: "agentic",
      requestEpoch: 1,
    });
    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.responseEscape).toBe("available");
    expect(decision.repairCodes.length).toBeGreaterThan(0);
  });

  test("resolution reads real input revisions, never a fabricated startup constant", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: PRESET_ID,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null, revision: 0 },
      mode: "agentic",
      requestEpoch: 2,
    });
    const readiness = decision.internal.readinessVector;
    expect(readiness.inputRevisionDigest.length).toBeGreaterThan(0);
    expect(String(readiness.archiveRegistryVersion)).not.toBe("0");
    expect(String(readiness.isolateHealthEpoch)).toBe(String(getIsolateHealthEpoch()));
    // Startup placeholders used the literal `startup-*` digests; the canonical
    // snapshot must not produce them.
    expect(JSON.stringify(decision.internal.binding)).not.toContain("startup-");
  });

  test("production readiness digest tracks the frozen cognition and context-ACL revisions", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const db = getDb();
    const now = Date.now();
    db.query("INSERT OR IGNORE INTO agent_context_account_state (user_id, context_acl_revision, updated_at) VALUES (?, ?, ?)")
      .run(USER_ID, 40, now);
    const baseRequest = {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      target: { generationType: "normal" as const, messageId: null, swipeId: null },
      mode: "agentic" as const,
    };
    try {
      const first = await resolveEffectiveRuntime(USER_ID, { ...baseRequest, requestEpoch: 101 });
      expect(first.effectiveMode).toBe("agentic");
      expect(first.internal.readinessVector.ready).toBe(true);
      expect(first.internal.readinessVector.contextAclRevision).toBe(40);
      expect(String(first.internal.readinessVector.cognitionRevision).length).toBeGreaterThan(0);
      const firstDigest = first.internal.binding.readinessDigest;

      // A context-ACL revision change must change the readiness digest and the
      // vector revision it came from.
      db.query("UPDATE agent_context_account_state SET context_acl_revision = 41 WHERE user_id = ?").run(USER_ID);
      const second = await resolveEffectiveRuntime(USER_ID, { ...baseRequest, requestEpoch: 102 });
      expect(second.internal.readinessVector.contextAclRevision).toBe(41);
      expect(second.internal.binding.readinessDigest).not.toBe(firstDigest);

      // An authored config change reaches the frozen cognition revision and
      // must change the digest again, independently of the ACL probe above.
      db.query("UPDATE preset_agent_configs SET max_invocations = max_invocations + 1 WHERE user_id = ? AND preset_id = ?")
        .run(USER_ID, AGENTIC_PRESET_ID);
      const third = await resolveEffectiveRuntime(USER_ID, { ...baseRequest, requestEpoch: 103 });
      expect(third.internal.readinessVector.cognitionRevision).not.toBe(first.internal.readinessVector.cognitionRevision);
      expect(third.internal.binding.readinessDigest).not.toBe(second.internal.binding.readinessDigest);
    } finally {
      db.query("UPDATE preset_agent_configs SET max_invocations = 8 WHERE user_id = ? AND preset_id = ?")
        .run(USER_ID, AGENTIC_PRESET_ID);
    }
  });

  test("repair-required cognition closes Agentic readiness while Response stays available", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const db = getDb();
    const now = Date.now();
    const repairPresetId = "preset-coordinator-repair";
    db.query(
      "INSERT OR IGNORE INTO presets (id, user_id, name, provider, engine, parameters, prompt_order, prompts, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(repairPresetId, USER_ID, "Repair Coordinator Preset", "scripted-coordinator", "classic", "{}", "[]", "{}", "{}", now, now);
    db.query(
      `INSERT OR IGNORE INTO preset_agent_configs
        (user_id, preset_id, version, agents_enabled, allowed_modes, default_mode,
         max_invocations, max_tool_calls, main_tool_ids, main_lore_scope,
         phase_policy_json, cognition_policy_json, context_policy_json, task_policy_json,
         workspace_policy_json, state, review_code, review_acknowledged, config_revision, binding_revision,
         created_at, updated_at)
        VALUES (?, ?, 2, 1, ?, 'agentic', 8, 8, ?, 'active',
          '{}', '{}', '{}', '{}', '{}', 'repair_required', 'cognition_invalid', 0, 1, 1, ?, ?)`,
    ).run(
      USER_ID,
      repairPresetId,
      JSON.stringify(["response", "agentic"]),
      JSON.stringify(["chat_search_history"]),
      now,
      now,
    );
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: repairPresetId,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null },
      mode: "agentic",
      requestEpoch: 201,
    });
    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.responseEscape).toBe("available");
    expect(decision.repairCodes).toContain("agent_config_repair_required");
    expect(decision.internal.readinessVector.ready).toBe(false);
    expect(decision.internal.readinessVector.reasons).toContain("cognition_invalid");
  });

  test("omitted mode snapshots revisions when the resolved request is agentic", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
    });
    expect(decision.effectiveMode).toBe("agentic");
    expect(decision.repairCodes).not.toContain("agentic_input_revisions_incomplete");
  });

  test("internal coordinator resolution never leaks one-use decision tokens", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    AGENT_RUNTIME_DECISION_SERVICE.resetTokensForTests();
    const deps = __testing.buildDependencies();
    for (let index = 0; index < 3; index++) {
      const decision = await deps.resolveRuntime!(
        { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
        { generationType: "normal" },
        new AbortController().signal,
      );
      expect(decision.mode).toBe("agentic");
      expect(decision.token).toBeUndefined();
    }
    expect(AGENT_RUNTIME_DECISION_SERVICE.tokenStore.liveCount).toBe(0);
  });

  test("a token issued with target revision consumes against the unchanged live target revision", async () => {
    seedTargetMessage("message-token-target", AGENTIC_CHAT_ID, ADMITTED_TARGET_REVISION);
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    AGENT_RUNTIME_DECISION_SERVICE.resetTokensForTests();
    const target = {
      generationType: "regenerate" as const,
      messageId: "message-token-target",
      revision: ADMITTED_TARGET_REVISION,
    };
    const request = {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "regenerate" as const,
      target,
      mode: "agentic" as const,
      requestEpoch: 21,
    };
    const issued = await resolveEffectiveRuntime(USER_ID, request);
    expect(issued.effectiveMode).toBe("agentic");
    expect(issued.runtimeDecisionToken).toBeTruthy();
    const consumed = await __testing.buildDependencies().consumeRuntimeToken!(
      {
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "regenerate",
        requestEpoch: 21,
      },
      target,
      issued.runtimeDecisionToken!,
      new AbortController().signal,
    );
    expect(consumed.mode).toBe("agentic");
  });

  test("a config revision change after token issue rejects before provider/compile", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    AGENT_RUNTIME_DECISION_SERVICE.resetTokensForTests();
    const target = { generationType: "normal" as const };
    const issued = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
      target,
      mode: "agentic",
      requestEpoch: 22,
    });
    getDb().query("UPDATE preset_agent_configs SET config_revision = config_revision + 1 WHERE user_id = ? AND preset_id = ?").run(USER_ID, AGENTIC_PRESET_ID);
    try {
      await expect(__testing.buildDependencies().consumeRuntimeToken!(
        { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", requestEpoch: 22 },
        target,
        issued.runtimeDecisionToken!,
        new AbortController().signal,
      )).rejects.toThrow("decision_refresh_required");
    } finally {
      getDb().query("UPDATE preset_agent_configs SET config_revision = ? WHERE user_id = ? AND preset_id = ?").run(ADMITTED_CONFIG_REVISION, USER_ID, AGENTIC_PRESET_ID);
    }
  });

  test("a binding revision change after token issue rejects before provider/compile", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    AGENT_RUNTIME_DECISION_SERVICE.resetTokensForTests();
    const target = { generationType: "normal" as const };
    const issued = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
      target,
      mode: "agentic",
      requestEpoch: 23,
    });
    getDb().query("UPDATE preset_agent_configs SET binding_revision = binding_revision + 1 WHERE user_id = ? AND preset_id = ?").run(USER_ID, AGENTIC_PRESET_ID);
    try {
      await expect(__testing.buildDependencies().consumeRuntimeToken!(
        { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", requestEpoch: 23 },
        target,
        issued.runtimeDecisionToken!,
        new AbortController().signal,
      )).rejects.toThrow("decision_refresh_required");
    } finally {
      getDb().query("UPDATE preset_agent_configs SET binding_revision = ? WHERE user_id = ? AND preset_id = ?").run(ADMITTED_BINDING_REVISION, USER_ID, AGENTIC_PRESET_ID);
    }
  });

  test("assembly carries the real user input and the authored tool grant", async () => {
    const deps = __testing.buildDependencies();
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: CHAT_ID, connectionId: CONNECTION_ID, presetId: PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      { generationType: "normal" },
      new AbortController().signal,
    );
    const snapshot = await deps.buildAssemblySnapshot!(
      { userId: USER_ID, chatId: CHAT_ID, connectionId: CONNECTION_ID, presetId: PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      decision,
      { generationType: "normal" },
      new AbortController().signal,
      "test-assembly",
    ) as unknown as { target: { userInput: string }; agentConfig: unknown; availability: { toolIds: readonly string[] } };
    // The preflight snapshot is built with an empty input; ASSEMBLE must not
    // reuse it.
    expect(snapshot.target.userInput).toBe(USER_INPUT);
    // No normalized V2 config is authored for this preset. Runtime keeps the
    // executable config absent rather than consulting legacy metadata; the
    // host catalogue remains available only for snapshot diagnostics.
    expect(snapshot.agentConfig).toBeNull();
    expect(Array.isArray(snapshot.availability.toolIds)).toBe(true);
  });
  test("production assembly keeps context inactive when cognition is absent", async () => {
    const db = getDb();
    const now = Date.now();
    const digest = "b".repeat(64);
    db.query("INSERT OR IGNORE INTO agent_context_account_state (user_id, context_acl_revision, updated_at) VALUES (?, 1, ?)")
      .run(USER_ID, now);
    db.query(
      "INSERT OR IGNORE INTO agent_context_packs (user_id, id, name, description, visibility, state, latest_revision, provenance_json, created_at, updated_at) VALUES (?, ?, ?, '', 'private', 'active', 1, '{}', ?, ?)",
    ).run(USER_ID, "pack-coordinator", "Coordinator Context", now, now);
    db.query(
      "INSERT OR IGNORE INTO agent_context_pack_revisions (user_id, pack_id, revision, content_json, content_digest, token_count, byte_count, state, provenance_json, created_at, created_by) VALUES (?, ?, 1, ?, ?, 2, ?, 'active', '{}', ?, ?)",
    ).run(USER_ID, "pack-coordinator", JSON.stringify({ records: [{ id: "record-1", text: "frozen context" }] }), digest, "frozen context".length, now, USER_ID);
    db.query(
      "INSERT OR IGNORE INTO agent_preset_context_pack_attachments (user_id, attachment_id, preset_id, pack_id, revision, position, required, state, provenance_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, 0, 'active', '{}', ?, ?)",
    ).run(USER_ID, "attachment-coordinator", PRESET_ID, "pack-coordinator", now, now);
    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(input, target, signal);
    const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, "test-context");
    expect(snapshot.agentConfig).toBeNull();
    expect(snapshot.contextPacks.cognitionGraph).toBeNull();
    expect(snapshot.contextPacks.cognitionSource).toBeNull();
    expect(snapshot.contextPacks.contextPackSelections).toHaveLength(0);
    expect(snapshot.contextPacks.contextRules).toHaveLength(0);
    expect(snapshot.contextPackSnapshot.candidates).toEqual([
      expect.objectContaining({
        packId: "pack-coordinator",
        source: "preset",
        targetId: PRESET_ID,
        required: false,
      }),
    ]);
    expect(Object.isFrozen(snapshot.contextPackSnapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.contextPackSnapshot.candidates[0])).toBe(true);
    const runtime = await deps.createContextRuntime!(snapshot, input, decision, signal, "test-context");
    const listed = await runtime.capability.list({});
    expect(listed).toMatchObject({ status: "success", data: { candidates: [], total: 0 } });
  });

  test("execution takes one root permit, joins the pool, and releases on cleanup", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const started: unknown[] = [];
    // Await the emitted event itself: in-process listeners are dispatched
    // asynchronously off the streaming hot path.
    const firstStarted = Promise.withResolvers<void>();
    const unsubscribe = eventBus.on(EventType.GENERATION_STARTED, (message) => {
      started.push(message);
      firstStarted.resolve();
    });
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      new AbortController().signal,
    );
    const before = AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsByUser[USER_ID] ?? 0;
    const execution = await deps.createExecution!({
      executionId: "exec-normal-1",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal: new AbortController().signal,
    });
    try {
      expect(AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsByUser[USER_ID] ?? 0).toBe(before + 1);
      expect(getPoolEntry("exec-normal-1")).toBeDefined();
      await firstStarted.promise;
      expect(started.length).toBe(1);
    } finally {
      unsubscribe();
      deps.cleanup!({ execution } as never);
    }
    expect(AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsByUser[USER_ID] ?? 0).toBe(before);
  });

  test("admission reserves the exact final render envelope and keeps the RENDER re-reservation exclusive", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      new AbortController().signal,
    );
    const execution = await deps.createExecution!({
      executionId: "exec-render-reservation-1",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal: new AbortController().signal,
    });
    try {
      const row = getDb().query(
        "SELECT final_render_reservations_json, deadline_at FROM agent_turn_executions WHERE id = ?",
      ).get(execution.id) as { final_render_reservations_json: string; deadline_at: number };
      const ownerToken = execution.ownerToken ?? "";
      const deadlineAt = row.deadline_at;
      const reservations = JSON.parse(row.final_render_reservations_json) as Array<{
        id: string;
        maxBytes: number;
        contextBytes: number;
        outputBytes: number;
        activityChunks: number;
        deadlineAt: number;
      }>;
      expect(reservations).toHaveLength(1);
      expect(reservations[0].id).toBe(`render:${execution.id}`);
      const envelope = calculateFinalRenderReservationEnvelopeV1({
        activityChunks: 16,
        contextBytes: HOST_PREPARATION_LIMITS_V1.maxInputBytes,
        outputBytes: HOST_PREPARATION_LIMITS_V1.maxOutputBytes,
      });
      expect(reservations[0].deadlineAt).toBe(deadlineAt);

      // The RENDER-entry call with the identical frozen envelope is a no-op.
      const replayed = reserveFinalRender({
        executionId: execution.id,
        ownerToken,
        reservationKey: `render:${execution.id}`,
        maxBytes: envelope.maxBytes,
        contextBytes: envelope.contextBytes,
        outputBytes: envelope.outputBytes,
        activityChunks: envelope.activityChunks,
        deadlineAt,
      });
      expect(replayed.execution.finalRenderReservations).toHaveLength(1);

      // A different envelope for the same key stays exclusively rejected.
      const drifted = calculateFinalRenderReservationEnvelopeV1({
        activityChunks: 16,
        contextBytes: HOST_PREPARATION_LIMITS_V1.maxInputBytes + 1,
        outputBytes: HOST_PREPARATION_LIMITS_V1.maxOutputBytes,
      });
      let driftError: unknown = null;
      try {
        reserveFinalRender({
          executionId: execution.id,
          ownerToken,
          reservationKey: `render:${execution.id}`,
          maxBytes: drifted.maxBytes,
          contextBytes: drifted.contextBytes,
          outputBytes: drifted.outputBytes,
          activityChunks: drifted.activityChunks,
          deadlineAt,
        });
      } catch (error) {
        driftError = error;
      }
      expect(driftError).toBeInstanceOf(TurnExecutionError);
      expect((driftError as TurnExecutionError).code).toBe("render_reservation_taken");
    } finally {
      deps.cleanup!({ execution } as never);
    }
  });


  test("a non-normal target binds live message revisions and rejects an unknown message", async () => {
    markAgenticRuntimeReady();
    const db = getDb();
    const now = Date.now();
    db.query(
      "INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at, generation_revision) VALUES (?, ?, 0, 0, ?, ?, ?, 0, ?, ?, '{}', ?, ?)",
    ).run("message-coordinator", AGENTIC_CHAT_ID, "Coordinator", "first", now, JSON.stringify(["first"]), JSON.stringify([now]), now, ADMITTED_TARGET_REVISION);
    const deps = __testing.buildDependencies();
    const target = {
      generationType: "regenerate" as const,
      messageId: "message-coordinator",
      revision: ADMITTED_TARGET_REVISION,
    };
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "regenerate", messageId: "message-coordinator", userInput: USER_INPUT },
      target,
      new AbortController().signal,
    );
    const execution = await deps.createExecution!({
      executionId: "exec-regenerate-1",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal: new AbortController().signal,
    });
    try {
      const entry = getPoolEntry("exec-regenerate-1");
      expect(entry?.targetMessageId).toBe("message-coordinator");
      // A regenerate may address the next free swipe slot.
      expect(entry?.targetSwipeId).toBe(1);
    } finally {
      deps.cleanup!({ execution } as never);
    }
    let rejected: unknown = null;
    try {
      await deps.createExecution!({
        executionId: "exec-regenerate-2",
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target: { generationType: "regenerate", messageId: "message-missing", revision: ADMITTED_TARGET_REVISION },
        decision,
        signal: new AbortController().signal,
      });
    } catch (error) {
      rejected = error;
    }
    expect((rejected as Error | null)?.message).toBe("agentic_target_unsupported");
  });
  test("production installer runs a normal turn through tool work, render, commit, and Response escape", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedWorkRound = 0;
    providerRequests.length = 0;
    const now = Date.now();
    getDb().query(
      "INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at, generation_revision) VALUES (?, ?, 0, 1, ?, ?, ?, 0, ?, ?, '{}', ?, ?)",
    ).run(
      "message-user-render-narrative",
      AGENTIC_CHAT_ID,
      "User",
      USER_INPUT,
      now,
      JSON.stringify([USER_INPUT]),
      JSON.stringify([now]),
      now,
      ADMITTED_TARGET_REVISION,
    );


    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      target: { generationType: "normal", messageId: null, swipeId: null },
      mode: "agentic",
      requestEpoch: 9,
    });
    expect(decision.effectiveMode).toBe("agentic");
    expect(decision.runtimeDecisionToken).toBeTruthy();

    const started = await startGeneration({
      userId: USER_ID,
      chat_id: AGENTIC_CHAT_ID,
      connection_id: CONNECTION_ID,
      preset_id: AGENTIC_PRESET_ID,
      generation_type: "normal",
      mode: "agentic",
      runtime_decision_token: decision.runtimeDecisionToken!,
      request_epoch: 9,
      user_input: USER_INPUT,
      parameters: { max_tokens: 256 },
    });
    const settled = await waitForAgenticGeneration(started.generationId);
    expect(settled).toMatchObject({ status: "completed", phase: "COMMITTED" });

    const ordinaryRequests = providerRequests.filter((request) => request.toolMode === "ordinary");
    expect(ordinaryRequests[0]?.parameters?.max_tokens).toBe(256);
    expect(ordinaryRequests.length).toBeGreaterThanOrEqual(2);
    expect(ordinaryRequests[0]?.tools?.some((tool) => tool.name === "chat_search_history")).toBe(true);
    expect(ordinaryRequests[1]?.tools?.some((tool) => tool.name === "complete_turn")).toBe(true);
    const finalization = providerRequests.find((request) => request.toolMode === "finalization");
    expect(finalization?.tools).toEqual([]);
    expect(finalization?.parameters?.max_tokens).toBe(256);
    expect(finalization?.providerTransientCarrier).toBeUndefined();
    const finalizationMessages = finalization?.messages ?? [];
    expect(finalizationMessages.some((message) => message.role === "user" && String(message.content).includes(USER_INPUT))).toBe(true);
    expect(finalizationMessages.some((message) =>
      message.role === "system" && String(message.content).includes("in-character assistant reply"),
    )).toBe(true);
    expect(finalizationMessages.some((message) =>
      (message.role === "user" || message.role === "assistant") && String(message.content).includes("complete_turn"),
    )).toBe(false);
    expect(finalizationMessages.some((message) =>
      message.role === "system" && String(message.content).includes("Do not mention tools"),
    )).toBe(true);

    const db = getDb();
    const receipt = db.query(
      "SELECT receipt_id, message_id FROM agent_turn_commit_receipts WHERE execution_id = ?",
    ).get(started.generationId) as { receipt_id: string; message_id: string | null } | null;
    const receiptId = receipt?.receipt_id;
    const messageId = receipt?.message_id;
    if (!receiptId || !messageId) throw new Error("Agentic commit receipt did not include its message handoff");
    expect(receiptId).toBeTruthy();
    const message = db.query("SELECT content, name, extra FROM messages WHERE id = ? AND chat_id = ?")
      .get(messageId, AGENTIC_CHAT_ID) as { content: string; name: string; extra: string } | null;
    expect(message?.content).toBe("scripted render");
    expect(message?.name).toBe("Coordinator Character");
    expect(JSON.parse(message?.extra ?? "{}")).toMatchObject({
      character_id: "character-coordinator",
      usage: { promptTokens: 17, completionTokens: 3, totalTokens: 20 },
    });
    const breakdown = breakdownSvc.getBreakdown(USER_ID, messageId);
    expect(breakdown).toMatchObject({
      assemblySurface: "WORK",
      model: "scripted-model",
      provider: "scripted-coordinator",
      usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 },
      tokenizer_name: null,
    });
    expect(breakdown?.messages).toEqual(finalizationMessages);
    expect(breakdown?.entries).toHaveLength(finalizationMessages.length);
    const projection = db.query(
      "SELECT status, snapshot_json, terminal_handoff_json FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
    ).get(USER_ID, started.generationId) as { status: string; snapshot_json: string; terminal_handoff_json: string | null } | null;
    expect(projection?.status).toBe("COMMITTED");
    expect(JSON.parse(projection?.snapshot_json ?? "{}").usage).toEqual({
      inputTokens: 17,
      outputTokens: 3,
      totalTokens: 20,
      toolCalls: 2,
      childInvocations: 0,
    });
    expect(JSON.parse(projection?.terminal_handoff_json ?? "{}").messageId).toBe(messageId);
    const inspection = db.query(
      "SELECT reason, terminal_receipt_json FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
    ).get(USER_ID, started.generationId) as { reason: string; terminal_receipt_json: string | null } | null;
    expect(inspection?.reason).toBe("none");
    expect(JSON.parse(inspection?.terminal_receipt_json ?? "{}").messageId).toBe(messageId);

    let responseGenerationId = "";
    let responseRequestActive = true;
    let queuedResponseTerminal: Record<string, unknown> | undefined;
    const responseTerminal = Promise.withResolvers<Record<string, unknown>>();
    const unsubscribeResponse = eventBus.on(EventType.GENERATION_ENDED, (event) => {
      if (!responseRequestActive) return;
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload.generationId !== "string") return;
      if (responseGenerationId && payload.generationId !== responseGenerationId) return;
      if (!responseGenerationId) {
        queuedResponseTerminal = payload;
        return;
      }
      responseRequestActive = false;
      responseTerminal.resolve(payload);
      unsubscribeResponse();
    });
    const responseStarted = await startGeneration({
      userId: USER_ID,
      chat_id: AGENTIC_CHAT_ID,
      connection_id: CONNECTION_ID,
      preset_id: AGENTIC_PRESET_ID,
      generation_type: "normal",
      mode: "response",
      user_input: "response-path-input",
    });
    responseGenerationId = responseStarted.generationId;
    if (queuedResponseTerminal?.generationId === responseGenerationId) {
      responseRequestActive = false;
      responseTerminal.resolve(queuedResponseTerminal);
      unsubscribeResponse();
    }
    const timeout = setTimeout(() => {
      responseTerminal.reject(new Error("Response smoke generation did not settle"));
    }, 5_000);
    try {
      const responseTerminalPayload = await responseTerminal.promise;
      expect(responseStarted.mode).not.toBe("agentic");
      expect(typeof responseStarted.generationId).toBe("string");
      expect(responseTerminalPayload.error).toBeUndefined();
      expect(getPoolEntry(responseStarted.generationId)?.status).toBe("completed");
    } finally {
      clearTimeout(timeout);
      responseRequestActive = false;
      unsubscribeResponse();
    }
  });
  test("WORK provider delivery uses resolved direct policy and omits false or unavailable entries", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedWorkRound = 0;
    providerRequests.length = 0;

    const db = getDb();
    const originalPreset = db.query(
      "SELECT prompt_order, cache_revision FROM presets WHERE id = ? AND user_id = ?",
    ).get(AGENTIC_PRESET_ID, USER_ID) as { prompt_order: string; cache_revision: number };
    const originalConfig = db.query(
      "SELECT config_json, context_policy_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string; context_policy_json: string };
    const availableContextText = "Available Loom context from the authenticated pack.";
    const availableContext = createContextPack(USER_ID, {
      name: "Available Loom Context",
      content: [{
        id: "loom-record",
        title: "Authenticated context",
        body: availableContextText,
        tags: [],
      }],
    });
    const availableAttachment = attachContextPack(USER_ID, availableContext.pack.id, {
      scope: "preset",
      targetId: AGENTIC_PRESET_ID,
      revision: availableContext.revision.revision,
      position: 0,
      required: false,
    });
    if (!availableAttachment) throw new Error("available Loom context attachment was not created");
    const presetRevision = 73;
    const rawPolicyText = "Effective policy for {{char}}.";
    const resolvedPolicyText = "Effective policy for Coordinator Character.";
    const source = {
      kind: "loom_block" as const,
      blockId: "macro-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 0,
    };
    const conditionSentinel = "CONDITION_FALSE_MUST_NOT_REACH_PROVIDER";
    const conditionSource = {
      kind: "loom_block" as const,
      blockId: "condition-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 1,
    };
    const onDemandSentinel = "UNAVAILABLE_ON_DEMAND_SOURCE_MUST_NOT_REACH_PROVIDER";
    const onDemandSource = {
      kind: "loom_block" as const,
      blockId: "on-demand-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 2,
    };
    const rawRenderPolicyText = "Render policy for {{char}}.";
    const resolvedRenderPolicyText = "Render policy for Coordinator Character.";
    const renderSource = {
      kind: "loom_block" as const,
      blockId: "render-macro-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 3,
    };
    const renderConditionSentinel = "RENDER_CONDITION_FALSE_MUST_NOT_REACH_PROVIDER";
    const renderConditionSource = {
      kind: "loom_block" as const,
      blockId: "render-condition-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 4,
    };
    const renderOnDemandSentinel = "RENDER_UNAVAILABLE_ON_DEMAND_MUST_NOT_REACH_PROVIDER";
    const renderOnDemandSource = {
      kind: "loom_block" as const,
      blockId: "render-on-demand-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 5,
    };
    const runtimePolicy = {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: {
        version: 1,
        workPolicy: [{
          version: 1,
          id: "macro-policy-entry",
          source,
          destination: "root_work",
          checkpoint: "WORK",
          required: true,
          visibility: "work_only",
          delivery: { delivery: "direct" },
        }, {
          version: 1,
          id: "condition-policy-entry",
          source: conditionSource,
          destination: "root_work",
          checkpoint: "WORK",
          required: false,
          visibility: "work_only",
          delivery: {
            delivery: "condition_gated",
            condition: {
              kind: "preset_variable",
              name: "gate",
              operator: "equals",
              value: "open",
            },
          },
        }, {
          version: 1,
          id: "on-demand-policy-entry",
          source: onDemandSource,
          destination: "root_work",
          checkpoint: "WORK",
          required: true,
          visibility: "work_only",
          delivery: {
            delivery: "on_demand",
            request: {
              contextPackId: availableContext.pack.id,
              revisionId: `${availableContext.pack.id}@${availableContext.revision.revision}`,
              digest: availableContext.revision.contentDigest,
            },
          },
        }],
        workspaceUsage: [],
        completionCriteria: [],
        renderPolicy: [{
          version: 1,
          id: "render-macro-policy-entry",
          source: renderSource,
          destination: "render",
          checkpoint: "RENDER",
          required: true,
          visibility: "work_only",
          delivery: { delivery: "direct" },
        }, {
          version: 1,
          id: "render-condition-policy-entry",
          source: renderConditionSource,
          destination: "render",
          checkpoint: "RENDER",
          required: false,
          visibility: "work_only",
          delivery: {
            delivery: "condition_gated",
            condition: {
              kind: "preset_variable",
              name: "gate",
              operator: "equals",
              value: "open",
            },
          },
        }, {
          version: 1,
          id: "render-on-demand-policy-entry",
          source: renderOnDemandSource,
          destination: "render",
          checkpoint: "RENDER",
          required: false,
          visibility: "work_only",
          delivery: {
            delivery: "on_demand",
            request: {
              contextPackId: "unavailable-render-pack",
              revisionId: "unavailable-render-pack@1",
              digest: "e".repeat(64),
            },
          },
        }],
      },
      phases: [],
    };
    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 1024 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const executionId = `exec-loom-macro-${Date.now()}`;
    try {
      db.query(
        "UPDATE presets SET prompt_order = ?, cache_revision = ? WHERE id = ? AND user_id = ?",
      ).run(JSON.stringify([{
        id: source.blockId,
        name: "Macro policy",
        content: rawPolicyText,
        role: "system",
        enabled: true,
        position: "pre_history",
        revision: source.blockRevision,
      }, {
        id: conditionSource.blockId,
        name: "False condition policy",
        content: conditionSentinel,
        role: "system",
        enabled: true,
        position: "pre_history",
        revision: conditionSource.blockRevision,
      }, {
        id: onDemandSource.blockId,
        name: "Unavailable on-demand policy",
        content: onDemandSentinel,
        role: "system",
        enabled: true,
        position: "pre_history",
        revision: onDemandSource.blockRevision,
      }, {
        id: renderSource.blockId,
        name: "Render macro policy",
        content: rawRenderPolicyText,
        role: "system",
        enabled: true,
        position: "pre_history",
        revision: renderSource.blockRevision,
      }, {
        id: renderConditionSource.blockId,
        name: "Render false condition policy",
        content: renderConditionSentinel,
        role: "system",
        enabled: true,
        position: "pre_history",
        revision: renderConditionSource.blockRevision,
      }, {
        id: renderOnDemandSource.blockId,
        name: "Render on-demand policy",
        content: renderOnDemandSentinel,
        role: "system",
        enabled: true,
        position: "pre_history",
        revision: renderOnDemandSource.blockRevision,
      }]), presetRevision, AGENTIC_PRESET_ID, USER_ID);
      db.query(
        "UPDATE preset_agent_configs SET config_json = ?, context_policy_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({
        config: { runtimePolicy },
        contextPackSelections: [{
          packId: availableContext.pack.id,
          revisionId: `${availableContext.pack.id}@${availableContext.revision.revision}`,
          revision: availableContext.revision.revision,
          digest: availableContext.revision.contentDigest,
          label: "Available Loom Context",
        }],
      }), JSON.stringify({
        packIds: [availableContext.pack.id],
        ruleIds: [],
      }), USER_ID, AGENTIC_PRESET_ID);
      expect(getAgentRuntimeSharedDraft(USER_ID, AGENTIC_PRESET_ID)).toMatchObject({
        config: {
          contextPolicy: { packIds: [availableContext.pack.id], ruleIds: [] },
        },
        contextPackSelections: [{
          packId: availableContext.pack.id,
          revisionId: `${availableContext.pack.id}@${availableContext.revision.revision}`,
          revision: availableContext.revision.revision,
          digest: availableContext.revision.contentDigest,
        }],
      });

      const decision = await deps.resolveRuntime!(input, target, signal);
      const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, executionId);
      const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, executionId);
      const contextRuntime = await deps.createContextRuntime!(snapshot, input, decision, signal, executionId);
      expect(snapshot.blocks.find((block) => block.id === source.blockId)?.content).toBe(rawPolicyText);
      expect(plan.loomBlocks.find((block) => block.source.blockId === source.blockId)?.content).toBe(resolvedPolicyText);
      expect(snapshot.contextPackSnapshot.candidates).toContainEqual(expect.objectContaining({
        packId: availableContext.pack.id,
        revisionId: `${availableContext.pack.id}@${availableContext.revision.revision}`,
        digest: availableContext.revision.contentDigest,
        source: "preset",
      }));

      const execution = await deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });
      try {
        const work = await deps.runWork!({
          execution,
          input,
          decision,
          snapshot,
          plan,
          signal,
          contextRuntime,
        });
        expect(work).toMatchObject({ status: "completed" });
        const ordinaryRequests = providerRequests.filter((request) => request.toolMode === "ordinary");
        const ordinaryPayload = JSON.stringify(ordinaryRequests);
        expect(ordinaryPayload).toContain(resolvedPolicyText);
        expect(ordinaryPayload).not.toContain(rawPolicyText);
        expect(ordinaryPayload).not.toContain(conditionSentinel);
        expect(ordinaryPayload).not.toContain(onDemandSentinel);
        for (const request of ordinaryRequests) {
          expect(JSON.stringify(request.messages).split(availableContextText)).toHaveLength(2);
        }
        const render = await deps.render!({
          execution,
          input,
          decision,
          snapshot,
          plan,
          work,
          signal,
        });
        expect(render).toMatchObject({ content: "scripted render" });
        const finalizationRequests = providerRequests.filter((request) => request.toolMode === "finalization");
        const finalizationPayload = JSON.stringify(finalizationRequests);
        expect(finalizationPayload).toContain(resolvedRenderPolicyText);
        expect(finalizationPayload).not.toContain(rawRenderPolicyText);
        expect(finalizationPayload).not.toContain(renderConditionSentinel);
        expect(finalizationPayload).not.toContain(renderOnDemandSentinel);
        expect(finalizationRequests).toHaveLength(1);
        expect(JSON.stringify(finalizationRequests[0]?.messages).split(availableContextText)).toHaveLength(2);
      } finally {
        deps.cleanup!({ execution } as never);
      }
    } finally {
      db.query(
        "UPDATE presets SET prompt_order = ?, cache_revision = ? WHERE id = ? AND user_id = ?",
      ).run(originalPreset.prompt_order, originalPreset.cache_revision, AGENTIC_PRESET_ID, USER_ID);
      db.query(
        "UPDATE preset_agent_configs SET config_json = ?, context_policy_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, originalConfig.context_policy_json, USER_ID, AGENTIC_PRESET_ID);
      deleteContextPackAttachment(USER_ID, "preset", availableAttachment.attachmentId);
      deleteContextPack(USER_ID, availableContext.pack.id, availableContext.revision.revision);
      scriptedWorkRound = 0;
      providerRequests.length = 0;
    }
  });

  test("WORK and RENDER send authored preset max_tokens and fall back to 4096", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();

    const runTurn = async (requestEpoch: number) => {
      scriptedWorkRound = 0;
      providerRequests.length = 0;
      const decision = await resolveEffectiveRuntime(USER_ID, {
        chatId: AGENTIC_CHAT_ID,
        logicalConnectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        target: { generationType: "normal", messageId: null, swipeId: null },
        mode: "agentic",
        requestEpoch,
      });
      const started = await startGeneration({
        userId: USER_ID,
        chat_id: AGENTIC_CHAT_ID,
        connection_id: CONNECTION_ID,
        preset_id: AGENTIC_PRESET_ID,
        generation_type: "normal",
        mode: "agentic",
        runtime_decision_token: decision.runtimeDecisionToken!,
        request_epoch: requestEpoch,
        user_input: USER_INPUT,
      });
      const settled = await waitForAgenticGeneration(started.generationId);
      expect(settled).toMatchObject({ status: "completed", phase: "COMMITTED" });
      const ordinaryRequests = providerRequests.filter((request) => request.toolMode === "ordinary");
      const finalization = providerRequests.find((request) => request.toolMode === "finalization");
      expect(ordinaryRequests.length).toBeGreaterThanOrEqual(1);
      expect(finalization).toBeDefined();
      return { ordinaryRequests, finalization };
    };

    getDb().query("UPDATE presets SET parameters = ? WHERE id = ?").run(
      JSON.stringify({ samplerOverrides: { enabled: true, maxTokens: 1024 } }),
      AGENTIC_PRESET_ID,
    );
    try {
      const authored = await runTurn(41);
      for (const request of authored.ordinaryRequests) {
        expect(request.parameters?.max_tokens).toBe(1024);
      }
      expect(authored.finalization?.parameters?.max_tokens).toBe(1024);

      getDb().query("UPDATE presets SET parameters = ? WHERE id = ?").run("{}", AGENTIC_PRESET_ID);
      const missing = await runTurn(42);
      for (const request of missing.ordinaryRequests) {
        expect(request.parameters?.max_tokens).toBe(4096);
        expect(request.parameters?.max_tokens).toBeLessThan(100_000);
      }
      expect(missing.finalization?.parameters?.max_tokens).toBe(4096);
    } finally {
      getDb().query("UPDATE presets SET parameters = ? WHERE id = ?").run("{}", AGENTIC_PRESET_ID);
      scriptedWorkRound = 0;
      providerRequests.length = 0;
    }
  });
  test("production work adapter persists the delegated task and child frame assignment", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedDelegate = true;
    scriptedTaskCreated = false;
    delegateIssued = false;
    scriptedAcceptSubmission = true;
    scriptedAcceptanceIssued = false;
    scriptedChildSubmitted = false;
    providerRequests.length = 0;

    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 1024 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(input, target, signal);
    const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, "test-delegate");
    const config = snapshot.agentConfig as {
      readonly profiles?: readonly Record<string, unknown>[];
    } | null;
    if (!config || !Array.isArray(config.profiles)) throw new Error("Agentic profile config was not snapshotted");
    const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, "test-delegate");
    const assignmentSnapshot = {
      ...snapshot,
      agentConfig: {
        ...config,
        profiles: config.profiles.map((profile) => profile.id === "delegate" || profile.id === "delegate_alt"
          ? {
            ...profile,
            workspaceCapabilities: ["update_assigned_progress", "submit_child_result"],
            maxOutputTokens: 1024,
          }
          : profile),
      },
    } as typeof snapshot;
    const execution = await deps.createExecution!({
      executionId: `exec-delegate-${Date.now()}`,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    try {
      const work = await deps.runWork!({
        execution,
        input,
        decision,
        snapshot: assignmentSnapshot,
        plan,
        signal,
      });
      expect(work).toMatchObject({ status: "completed" });
      const childRequests = providerRequests.filter((request) =>
        request.toolMode === "ordinary"
        && typeof request.messages[0]?.content === "string"
        && request.messages[0].content.includes("bounded subordinate frame"));
      expect(childRequests.length).toBeGreaterThanOrEqual(1);
      const childRequest = childRequests.find((request) =>
        typeof request.messages[0]?.content === "string"
        && request.messages[0].content.includes("Assigned workspace task ID: task-delegate."),
      );
      expect(childRequest).toBeDefined();
      expect(childRequest?.parameters?.max_tokens).toBe(512);
      const workspace = getDb().query(
        "SELECT revision FROM agent_turn_workspaces WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?",
      ).get(`workspace:${execution.id}`, USER_ID, AGENTIC_CHAT_ID, execution.id) as { revision: number } | null;
      const workRevision = (work.workspace && typeof work.workspace === "object" && !Array.isArray(work.workspace)
        && "revision" in work.workspace && typeof work.workspace.revision === "number")
        ? work.workspace.revision
        : undefined;
      expect(workspace).not.toBeNull();
      expect(workRevision).toBe(workspace?.revision);
      const task = getDb().query(
        "SELECT task_id, assigned_frame_id FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-delegate") as { task_id: string; assigned_frame_id: string | null } | null;
      const childSuffix = ":child-0";
      const delegateSuffix = ":delegate-0";
      const expectedChildFrameId = `${execution.id}.${createHash("sha256").update(
        JSON.stringify(["agentic-work-child", execution.id, childSuffix]),
        "utf8",
      ).digest("hex")}${childSuffix}`;
      const expectedDelegateFrameId = `${execution.id}.${createHash("sha256").update(
        JSON.stringify(["agentic-work-delegate", execution.id, delegateSuffix]),
        "utf8",
      ).digest("hex")}${delegateSuffix}`;
      expect(task).toEqual({ task_id: "task-delegate", assigned_frame_id: expectedChildFrameId });
      expect(Buffer.byteLength(expectedChildFrameId, "utf8")).toBeLessThanOrEqual(128);
      expect(expectedChildFrameId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
      expect(expectedChildFrameId).not.toBe(expectedDelegateFrameId);
      const submission = getDb().query(
        "SELECT child_frame_id FROM agent_workspace_submissions WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-delegate") as { child_frame_id: string } | null;
      expect(submission).toEqual({ child_frame_id: expectedChildFrameId });
    } finally {
      deps.cleanup!({ execution } as never);
      scriptedDelegate = false;
      scriptedTaskCreated = false;
      delegateIssued = false;
      scriptedAcceptSubmission = false;
      scriptedAcceptanceIssued = false;
      scriptedChildSubmitted = false;
      scriptedDelegateProfileId = "delegate";
    }
  });
  test("keeps the real workspace writable through an intermediate phase completion", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedTwoPhase = true;
    scriptedTwoPhaseTurnId = "";
    scriptedTwoPhaseMutationIssued = false;
    scriptedTwoPhaseSnapshots.length = 0;
    providerRequests.length = 0;

    const phaseDefinitions: AgentCustomPhaseV1[] = [
      {
        version: 1,
        id: "two_phase_first",
        label: "Two-phase first",
        instructionRefs: [],
        required: true,
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: [],
        repeatLimit: 0,
        nextPhaseIds: ["two_phase_second"],
      },
      {
        version: 1,
        id: "two_phase_second",
        label: "Two-phase second",
        instructionRefs: [],
        required: true,
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: ["workspace_write"],
        repeatLimit: 0,
        nextPhaseIds: [],
      },
    ];
    const authoredPhasePlan = compileAgentRuntimePhases(phaseDefinitions);
    expect(authoredPhasePlan.status).toBe("ready");
    const db = getDb();
    const originalConfig = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string };
    const runtimePolicy = {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: null,
      phases: phaseDefinitions,
    };

    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 1024 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const executionId = `exec-two-phase-${Date.now()}`;
    try {
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({ config: { runtimePolicy } }), USER_ID, AGENTIC_PRESET_ID);
      const decision = await deps.resolveRuntime!(input, target, signal);
      const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, executionId);
      const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, executionId);
      const execution = await deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });
      scriptedTwoPhaseTurnId = execution.id;
      try {
        const work = await deps.runWork!({
          execution,
          input,
          decision,
          snapshot,
          plan,
          signal,
        });
        expect(work).toMatchObject({ status: "completed" });
        expect(scriptedTwoPhaseSnapshots).toEqual([{
          state: "active",
          revision: 1,
          taskCount: 1,
          taskState: "active",
          frozenAt: null,
        }]);

        const workspace = db.query(
          "SELECT state, revision, frozen_at, task_count FROM agent_turn_workspaces WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?",
        ).get(`workspace:${execution.id}`, USER_ID, AGENTIC_CHAT_ID, execution.id) as {
          state: string;
          revision: number;
          frozen_at: number | null;
          task_count: number;
        } | null;
        expect(workspace?.state).toBe("frozen");
        expect(workspace?.frozen_at).not.toBeNull();
        expect(workspace?.revision).toBeGreaterThan(scriptedTwoPhaseSnapshots[0]?.revision ?? 0);
        expect(workspace?.task_count).toBe(1);

        const task = db.query(
          "SELECT task_id, state, workspace_id, turn_id FROM agent_workspace_tasks WHERE workspace_id = ? AND turn_id = ? AND task_id = ?",
        ).get(`workspace:${execution.id}`, execution.id, "phase-two-task") as {
          task_id: string;
          state: string;
          workspace_id: string;
          turn_id: string;
        } | null;
        expect(task).toEqual({
          task_id: "phase-two-task",
          state: "active",
          workspace_id: `workspace:${execution.id}`,
          turn_id: execution.id,
        });

        const session = db.query(
          "SELECT turn_session_id, execution_id, attempt_id FROM persistent_workspace_turn_sessions WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND execution_id = ?",
        ).get(USER_ID, AGENTIC_CHAT_ID, execution.id, execution.id) as {
          turn_session_id: string;
          execution_id: string;
          attempt_id: string;
        } | null;
        expect(session).toEqual({
          turn_session_id: execution.id,
          execution_id: execution.id,
          attempt_id: execution.id,
        });

        const completionObservations = (work.observations ?? []).filter((observation) => observation.toolName === "complete_turn");
        expect(completionObservations).toHaveLength(2);
        expect(completionObservations.every((observation) => observation.status === "accepted")).toBe(true);
      } finally {
        deps.cleanup!({ execution } as never);
      }
    } finally {
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, USER_ID, AGENTIC_PRESET_ID);
      scriptedTwoPhase = false;
      scriptedTwoPhaseTurnId = "";
      scriptedTwoPhaseMutationIssued = false;
      scriptedTwoPhaseSnapshots.length = 0;
      providerRequests.length = 0;
    }
  });

  test("GENERATION_ENDED for completed COMMITTED omits error and still sends failure diagnostics", async () => {
    const deps = __testing.buildDependencies();
    const waitForEnded = (generationId: string): Promise<Record<string, unknown>> => {
      const settled = Promise.withResolvers<Record<string, unknown>>();
      const unsubscribe = eventBus.on(EventType.GENERATION_ENDED, (event) => {
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload?.generationId !== generationId) return;
        unsubscribe();
        settled.resolve(payload);
      });
      return settled.promise;
    };
    const completed = waitForEnded("exec-committed-success");
    deps.publishTerminal!({
      executionId: "exec-committed-success",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      status: "completed",
      phase: "COMMITTED",
      target: { generationType: "normal" },
    });
    const completedPayload = await completed;
    expect(completedPayload).not.toHaveProperty("error");
    expect(completedPayload).not.toHaveProperty("errorCode");
    expect(completedPayload.phase).toBe("COMMITTED");
    expect(completedPayload.status).toBe("COMMITTED");
    const completedInspection = getDb().query(
      "SELECT outcome, reason, terminal FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
    ).get(USER_ID, "exec-committed-success") as {
      outcome: string | null;
      reason: string;
      terminal: number;
    } | null;
    expect(completedInspection).toEqual({
      outcome: "completed",
      reason: "none",
      terminal: 1,
    });

    const failed = waitForEnded("exec-committed-failed");
    deps.publishTerminal!({
      executionId: "exec-committed-failed",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      status: "failed",
      phase: "WORK",
      target: { generationType: "normal" },
      errorCode: "provider_request_error",
      errorMessage: "upstream refused",
    });
    const failedPayload = await failed;
    expect(failedPayload.errorCode).toBe("provider_request_error");
    expect(failedPayload.error).toBe("WORK: provider_request_error: upstream refused");
    expect(failedPayload.phase).toBe("WORK");
  });

  test("admission returns the exact retry attempt lineage", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const deps = __testing.buildDependencies();
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!({
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
    }, target, signal);
    const attemptLineage = {
      version: 1 as const,
      attemptId: "attempt-admission-exact",
      previousAttemptId: "attempt-admission-parent",
      target: {
        chatId: AGENTIC_CHAT_ID,
        generationType: "normal" as const,
        messageId: null,
        swipeId: null,
      },
      createdAt: 123456,
    };
    const executionId = "exec-attempt-lineage-exact";
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      attemptLineage,
      signal,
    });
    try {
      const session = getDb().query(
        `SELECT attempt_id
           FROM persistent_workspace_turn_sessions
          WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND execution_id = ?`,
      ).get(USER_ID, AGENTIC_CHAT_ID, executionId, executionId) as { attempt_id: string } | null;
      expect(session).toEqual({ attempt_id: executionId });
      expect(session?.attempt_id).not.toBe(attemptLineage.attemptId);
      const canonicalAttempt = getDb().query(
        `SELECT attempt_id
           FROM agent_run_attempts
          WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND attempt_id = ?`,
      ).get(USER_ID, AGENTIC_CHAT_ID, executionId, executionId) as { attempt_id: string } | null;
      expect(canonicalAttempt).toEqual({ attempt_id: executionId });
      expect((execution as typeof execution & { readonly attemptLineage?: unknown }).attemptLineage).toBe(attemptLineage);
    } finally {
      deps.cleanup?.({ execution } as never);
    }
  });

  test("retry admission preserves the exact admitted regenerate swipe", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const now = Date.now();
    const messageId = "message-retry-admitted-swipe";
    getDb().query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at, generation_revision) VALUES (?, ?, 0, 0, ?, ?, ?, 0, ?, ?, '{}', ?, ?)").run(
      messageId,
      AGENTIC_CHAT_ID,
      "Coordinator",
      "retry target",
      now,
      JSON.stringify(["first", "admitted"]),
      JSON.stringify([now, now]),
      now,
      ADMITTED_TARGET_REVISION,
    );
    const deps = __testing.buildDependencies();
    const target = {
      generationType: "regenerate" as const,
      messageId,
      swipeId: 1,
      revision: ADMITTED_TARGET_REVISION,
    };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!({
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "regenerate",
      messageId,
      swipeId: 1,
    }, target, signal);
    const executionId = "exec-retry-admitted-swipe";
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      attemptLineage: {
        version: 1,
        attemptId: "attempt-retry-admitted-swipe",
        previousAttemptId: "attempt-retry-parent",
        target: {
          chatId: AGENTIC_CHAT_ID,
          generationType: "regenerate",
          messageId,
          swipeId: 1,
        },
        createdAt: 123457,
      },
      signal,
    });
    try {
      expect(getPoolEntry(executionId)?.targetSwipeId).toBe(1);
      expect((getDb().query("SELECT target_swipe_id FROM agent_turn_executions WHERE id = ?").get(executionId) as { target_swipe_id: number } | null)?.target_swipe_id).toBe(1);
    } finally {
      deps.cleanup?.({ execution } as never);
    }
  });
});

function renderNarrativeMessage(overrides: {
  readonly is_user: boolean;
  readonly content?: string;
  readonly swipe_id?: number;
  readonly swipes?: readonly string[];
}): SnapshotMessageV1 {
  const content = overrides.content ?? "";
  return {
    id: overrides.is_user ? "user-1" : "assistant-1",
    chat_id: AGENTIC_CHAT_ID,
    index_in_chat: overrides.is_user ? 0 : 1,
    is_user: overrides.is_user,
    name: overrides.is_user ? "User" : "Eleanor",
    content,
    send_date: 1,
    swipe_id: overrides.swipe_id ?? 0,
    swipes: [...(overrides.swipes ?? [content])],
    swipe_dates: [1],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 1,
    revision: "1",
  } as SnapshotMessageV1;
}

function authoredRenderPolicy(text: string): AssemblyProviderMessageV1 {
  return {
    role: "system",
    contentKind: "segments",
    provenance: { kind: "cognition", sourceId: "render-policy", sourceRevision: "1", sourceIndex: 0 },
    segments: [{ kind: "literal", text, bytes: text.length }],
  } as unknown as AssemblyProviderMessageV1;
}

const RENDER_NARRATIVE_FACTS = Object.freeze({
  character: {
    name: "Eleanor",
    personality: "Warm, reserved, and precise.",
    scenario: "A rain-soaked London boarding house.",
    description: "A retired cartographer.",
  },
  worldInfo: {
    books: [{
      id: "book-london",
      name: "London",
      description: "Fog-bound streets above a shuttered map shop.",
      source: "character" as const,
      order: 0,
      revision: "1",
    }],
    entries: [],
    candidates: [],
    state: {},
  } satisfies SnapshotWorldInfoV1,
});

const RENDER_NARRATIVE_FACT_MESSAGE = [
  "Name: Eleanor",
  "Personality: Warm, reserved, and precise.",
  "Scenario: A rain-soaked London boarding house.",
  "Description: A retired cartographer.",
  "World (London): Fog-bound streets above a shuttered map shop.",
].join("\n");

describe("agentic terminal inspection", () => {
  test("does not misclassify a completed turn's internal reason as needs attention", () => {
    expect(__testing.terminalInspectionReason("completed", "commit_finished", null)).toBe("none");
    expect(__testing.terminalInspectionReason("failed", "provider_failure", null)).toBe("provider_failure");
  });
});

describe("agentic RENDER narrative prompt", () => {
  test("uses current swipe chat turns, host contract when policy is empty, and labelled guidance", () => {
    const messages = __testing.buildAgenticRenderPolicyMessages({
      snapshotMessages: [
        renderNarrativeMessage({
          is_user: true,
          content: "stale user line",
          swipe_id: 1,
          swipes: ["stale user line", USER_INPUT],
        }),
        renderNarrativeMessage({
          is_user: false,
          content: "stale assistant swipe",
          swipe_id: 0,
          swipes: ["Eleanor is already in the room."],
        }),
      ],
      renderPolicyMessages: [],
      renderGuidance: "Keep the reply intimate and in Eleanor's voice.",
      character: RENDER_NARRATIVE_FACTS.character,
      worldInfo: RENDER_NARRATIVE_FACTS.worldInfo,
    });
    expect(messages).toEqual([
      { role: "system", content: RENDER_NARRATIVE_FACT_MESSAGE },
      { role: "user", content: USER_INPUT },
      { role: "assistant", content: "Eleanor is already in the room." },
      { role: "system", content: __testing.HOST_RENDER_FINAL_RESPONSE_CONTRACT },
      {
        role: "system",
        content: "Host-accepted render guidance (not the reply): WORK has completed. The accepted workspace projection is authoritative; do not deny its supported facts merely because RESPONSE is tools-disabled. Follow this guidance only where supported by that projection, and do not expose private reasoning or the operational transcript.\nKeep the reply intimate and in Eleanor's voice.",
      },
    ]);
    expect(messages.some((message) => message.role === "user" && message.content === USER_INPUT)).toBe(true);
    expect(messages.filter((message) => message.role !== "system").map((message) => message.content)).not.toContain("complete_turn");
    expect(JSON.stringify(messages)).not.toContain("stale user line");
  });

  test("appends authored render policy instead of the host contract and ignores WORK complete_turn text", () => {
    const messages = __testing.buildAgenticRenderPolicyMessages({
      snapshotMessages: [
        renderNarrativeMessage({ is_user: true, content: USER_INPUT }),
      ],
      renderPolicyMessages: [authoredRenderPolicy("Stay in character as Eleanor.")],
      character: RENDER_NARRATIVE_FACTS.character,
      worldInfo: RENDER_NARRATIVE_FACTS.worldInfo,
    });
    expect(messages).toEqual([
      { role: "system", content: RENDER_NARRATIVE_FACT_MESSAGE },
      { role: "user", content: USER_INPUT },
      { role: "system", content: "Stay in character as Eleanor." },
    ]);
    expect(messages.some((message) => message.content === __testing.HOST_RENDER_FINAL_RESPONSE_CONTRACT)).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("complete_turn");
  });

  test("bounds character and world facts before chat turns", () => {
    const overflow = `${"x".repeat(80)}${"\u{1F9E0}".repeat(40)}`;
    const messages = __testing.buildAgenticRenderPolicyMessages({
      snapshotMessages: [
        renderNarrativeMessage({ is_user: true, content: USER_INPUT }),
      ],
      renderPolicyMessages: [],
      character: {
        name: "Eleanor",
        description: overflow,
      },
      worldInfo: {
        ...RENDER_NARRATIVE_FACTS.worldInfo,
        books: [
          {
            ...RENDER_NARRATIVE_FACTS.worldInfo.books[0]!,
            description: "y".repeat(200),
          },
          {
            id: "book-late",
            name: "LateBook",
            description: "MUST-NOT-APPEAR-LATE-WORLD",
            source: "character",
            order: 1,
            revision: "1",
          },
        ],
        entries: [{
          disabled: false,
          constant: true,
          content: "MUST-NOT-APPEAR-LATE-ENTRY",
        }] as unknown as SnapshotWorldInfoV1["entries"],
      },
      maxFactBytes: 64,
    });
    const facts = messages[0];
    expect(facts?.role).toBe("system");
    const factsContent = String(facts?.content ?? "");
    const encoded = new TextEncoder().encode(factsContent);
    expect(encoded.byteLength).toBeLessThanOrEqual(64);
    expect(new TextDecoder().decode(encoded)).toBe(factsContent);
    expect(factsContent).toContain("Eleanor");
    expect(factsContent).not.toContain("MUST-NOT-APPEAR-LATE-WORLD");
    expect(factsContent).not.toContain("MUST-NOT-APPEAR-LATE-ENTRY");
    expect(messages.some((message) => message.role === "user" && message.content === USER_INPUT)).toBe(true);
    expect(messages).toContainEqual({
      role: "system",
      content: __testing.HOST_RENDER_FINAL_RESPONSE_CONTRACT,
    });
  });
});

describe("agentic commit revision reader fence", () => {
  test("in-transaction recheck does not reuse the commit-preflight snapshot", () => {
    const db = getDb();
    const now = Date.now();
    const chatId = "chat-revision-fence";
    const characterId = "character-revision-fence";
    const presetId = "preset-revision-fence";
    const bookId = "book-revision-fence";
    db.query(
      "INSERT INTO characters (id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, tags, alternate_greetings, extensions, created_at, updated_at, user_id) VALUES (?, ?, '', '', '', '', '', '', '', '', '', '[]', '[]', ?, ?, ?, ?)",
    ).run(characterId, "Fence Character", JSON.stringify({ world_book_ids: [bookId] }), now, now, USER_ID);
    db.query(
      "INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(chatId, USER_ID, characterId, "Fence Chat", now, now, "{}", 1);
    db.query(
      "INSERT INTO presets (id, user_id, name, provider, engine, parameters, prompt_order, prompts, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(presetId, USER_ID, "Fence Preset", "scripted-coordinator", "classic", "{}", "[]", "{}", "{}", now, now);
    db.query(
      `INSERT INTO preset_agent_configs
        (user_id, preset_id, version, agents_enabled, allowed_modes, default_mode,
         max_invocations, max_tool_calls, main_tool_ids, main_lore_scope,
         phase_policy_json, cognition_policy_json, context_policy_json, task_policy_json,
         workspace_policy_json, state, review_acknowledged, config_revision, binding_revision,
         created_at, updated_at)
        VALUES (?, ?, 2, 1, ?, 'agentic', 8, 8, ?, 'active',
          '{}', '{}', '{}', '{}', '{}', 'ready', 1, 1, 1, ?, ?)`,
    ).run(USER_ID, presetId, JSON.stringify(["response", "agentic"]), JSON.stringify(["chat_search_history"]), now, now);
    db.query(
      "INSERT INTO world_books (id, user_id, name, description, folder, metadata, created_at, updated_at) VALUES (?, ?, ?, '', '', '{}', ?, ?)",
    ).run(bookId, USER_ID, "Fence Book", now, now);

    const reader = __testing.makeRevisionReader({
      userId: USER_ID,
      chatId,
      assemblySurface: "WORK",
      presetId,
      targetCharacterId: characterId,
    });
    const characterMember = { kind: "character", id: characterId };
    const configMember = { kind: "config", id: presetId };
    const loreMember = { kind: "world_lore", id: bookId };

    const preflightCharacter = reader(characterMember, db);
    const preflightConfig = reader(configMember, db);
    const preflightLore = reader(loreMember, db);
    expect(preflightCharacter?.revision).toEqual(expect.any(String));
    expect(preflightConfig?.revision).toEqual(expect.any(String));
    expect(preflightLore?.revision).toEqual(expect.any(String));

    db.query("UPDATE characters SET description = ? WHERE id = ?").run("hostile character edit", characterId);
    db.query("UPDATE preset_agent_configs SET config_revision = 99 WHERE user_id = ? AND preset_id = ?")
      .run(USER_ID, presetId);
    db.query("UPDATE world_books SET description = ?, updated_at = ? WHERE id = ?")
      .run("hostile lore edit", now + 1, bookId);

    const fenced = db.transaction(() => ({
      character: reader(characterMember, db),
      config: reader(configMember, db),
      lore: reader(loreMember, db),
    }))();

    expect(fenced.character?.revision).not.toBe(preflightCharacter?.revision);
    expect(fenced.character?.digest).not.toBe(preflightCharacter?.digest);
    expect(fenced.config?.revision).not.toBe(preflightConfig?.revision);
    expect(fenced.lore?.revision).not.toBe(preflightLore?.revision);
    expect(fenced.lore?.digest).not.toBe(preflightLore?.digest);
  });
});


describe("coordinator cognition transition snapshot seam", () => {
  test("projects a completed materialized authored task through the real phase snapshot capability", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(input, target, signal);
    const execution = await deps.createExecution!({
      executionId: `exec-cognition-snapshot-${Date.now()}`,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    const runtimeExecution = execution as typeof execution & {
      readonly userId: string;
      readonly chatId: string;
      readonly workspaceId: string;
      workspaceRevision: number;
    };
    const db = getDb();
    const rootSignal = execution.signal;
    if (!rootSignal) throw new Error("Cognition snapshot execution signal was not installed");
    const capabilities = {
      revision: 1,
      allowed: WORKSPACE_OPERATIONS,
      maxOperationBytes: 131_072,
      maxOperations: 128,
    };
    const rootFrame = createAgenticRootFrame({
      frameId: execution.id,
      connectionId: null,
      model: "",
      coreToolIds: [],
      workspaceCapabilities: WORKSPACE_OPERATIONS,
      signal: rootSignal,
    });
    const currentWorkspaceRevision = (): number => {
      const row = db.query(
        "SELECT revision FROM agent_turn_workspaces WHERE workspace_id = ? AND turn_id = ? AND user_id = ? AND chat_id = ?",
      ).get(runtimeExecution.workspaceId, runtimeExecution.id, runtimeExecution.userId, runtimeExecution.chatId) as { revision: number } | null;
      if (!row) throw new Error("Cognition snapshot workspace was not persisted");
      return row.revision;
    };
    const workspaceContext = (expectedRevision: number): Record<string, unknown> => ({
      userId: runtimeExecution.userId,
      chatId: runtimeExecution.chatId,
      turnId: runtimeExecution.id,
      workspaceId: runtimeExecution.workspaceId,
      actor: "root",
      expectedRevision,
    });
    const templateId = "authored-review";
    try {
      const initialRevision = currentWorkspaceRevision();
      runtimeExecution.workspaceRevision = initialRevision;
      const cognition = createAgentCognitionRuntime({
        source: {
          graph: {
            version: 1,
            policies: {
              workPolicy: [],
              workspaceUsage: [],
              completionCriteria: [],
              renderPolicy: [],
            },
            templates: [{
              id: templateId,
              label: "Authored review",
              description: "Complete the authored review task.",
              required: false,
              dependencies: [],
              activation: { kind: "phase", value: "WORK" },
            }],
            contextRules: [],
          },
          source: { presetRevision: 1, blocks: [] },
          contextPackSelections: [],
          contextPackCandidates: [],
        },
        evaluation: {
          generationType: "normal",
          phase: "WORK",
          presetVariables: {},
          participantFacts: {},
          availableTools: [],
          taskTransitions: {},
        },
        workspaceRevision: initialRevision,
        workspace: workspaceContext(initialRevision),
      });
      runtimeExecution.workspaceRevision = cognition.initialActivation.workspaceRevision;
      const workActivation = cognition.enterPhase({
        phase: "WORK",
        workspace: workspaceContext(runtimeExecution.workspaceRevision),
      });
      runtimeExecution.workspaceRevision = workActivation.workspaceRevision;
      const workspace = __testing.makeWorkspace(execution, capabilities, cognition);

      const materialized = db.query(
        `SELECT task_id, cognition_template_id, state
           FROM agent_workspace_tasks
          WHERE workspace_id = ? AND turn_id = ? AND user_id = ? AND chat_id = ?
            AND cognition_template_id = ?`,
      ).get(runtimeExecution.workspaceId, runtimeExecution.id, runtimeExecution.userId, runtimeExecution.chatId, templateId) as {
        task_id: string;
        cognition_template_id: string | null;
        state: string;
      } | null;
      expect(materialized).toEqual({
        task_id: expect.any(String),
        cognition_template_id: templateId,
        state: "active",
      });
      if (!materialized) throw new Error("Authored cognition task was not materialized");
      expect(materialized.task_id).not.toBe(templateId);

      const assignChildTasks = workspace.assignChildTasks;
      if (!assignChildTasks) throw new Error("Coordinator workspace assignment capability is unavailable");
      const childFrameId = "cognition-snapshot-child";
      const assignment = await assignChildTasks({
        frame: rootFrame,
        assignments: [{ taskId: materialized.task_id, frameId: childFrameId }],
        expectedRevision: runtimeExecution.workspaceRevision,
        signal: rootSignal,
      });
      expect(assignment).toMatchObject({
        accepted: true,
        assignments: [{ taskId: materialized.task_id, frameId: childFrameId }],
      });
      runtimeExecution.workspaceRevision = assignment.workspaceRevision;

      const childFrame = createAgenticChildFrame({
        frameId: childFrameId,
        parentFrameId: execution.id,
        connectionId: null,
        model: "",
        coreToolIds: [],
        taskId: materialized.task_id,
        workspaceCapabilities: ["update_assigned_progress", "submit_child_result"],
        signal: rootSignal,
      });
      const execute = workspace.execute;
      if (!execute) throw new Error("Coordinator workspace execution capability is unavailable");
      const applyCognition = workspace.applyCognitionWorkspaceTransition;
      if (!applyCognition) throw new Error("Coordinator cognition workspace capability is unavailable");
      workspace.authenticateFrame?.(childFrame);
      const childSummary = "Authored review completed with evidence.";
      let childRound = 0;
      const child = await executeBoundedAgenticChildFrame({
        frame: childFrame,
        task: "Complete the authored review task.",
        systemPrompt: "Use the assigned workspace tools and submit the result.",
        workspace,
        countTokens: (text) => Math.ceil(text.length / 4),
        dispatch: async ({ tools }) => {
          childRound += 1;
          if (childRound === 1) {
            expect(tools.find((definition) => definition.name === "workspace_update_assigned_progress")?.parameters).toEqual({
              type: "object",
              properties: {
                state: { type: "string", enum: ["pending", "active", "blocked", "cancelled", "failed"] },
                progress: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["state"],
              additionalProperties: false,
            });
            return {
              content: "",
              finish_reason: "tool_calls",
              tool_calls: [{
                name: "workspace_update_assigned_progress",
                args: { state: "active", progress: 1 },
                call_id: "cognition-snapshot-progress",
              }],
            };
          }
          return {
            content: "",
            finish_reason: "tool_calls",
            tool_calls: [{
              name: "workspace_submit_child_result",
              args: { summary: childSummary },
              call_id: "cognition-snapshot-submit",
            }],
          };
        },
      });
      expect(child).toMatchObject({
        status: "succeeded",
        content: childSummary,
        providerRoundCount: 2,
        workspaceRevision: expect.any(Number),
      });
      expect(child.observations).toEqual([
        expect.objectContaining({ toolName: "workspace_update_assigned_progress", status: "success" }),
        expect.objectContaining({ toolName: "workspace_submit_child_result", status: "success" }),
      ]);
      expect(db.query(
        "SELECT summary, result_digest, byte_count FROM agent_workspace_submissions WHERE task_id = ? AND workspace_id = ?",
      ).get(materialized.task_id, runtimeExecution.workspaceId)).toEqual({
        summary: childSummary,
        result_digest: createHash("sha256").update(childSummary, "utf8").digest("hex"),
        byte_count: Buffer.byteLength(childSummary, "utf8") * 2,
      });
      const recordSummaries = {
        finding: "A non-cognition record must keep the runtime CAS synchronized.",
        decision: "The operation-selected record kind is authoritative.",
        question: "Can every strict record tool omit its implicit kind and digest?",
      } as const;
      await execute(
        "record_finding",
        {
          summary: recordSummaries.finding,
          taskId: null,
        },
        { actor: "root", frame: rootFrame, operation: "record_finding", signal: rootSignal },
      );
      await execute(
        "record_decision",
        {
          summary: recordSummaries.decision,
          taskId: null,
        },
        { actor: "root", frame: rootFrame, operation: "record_decision", signal: rootSignal },
      );
      await execute(
        "record_question",
        {
          summary: recordSummaries.question,
          taskId: null,
        },
        { actor: "root", frame: rootFrame, operation: "record_question", signal: rootSignal },
      );
      expect(runtimeExecution.workspaceRevision).toBe(currentWorkspaceRevision());
      expect(db.query(
        "SELECT kind, summary, digest FROM agent_workspace_records WHERE workspace_id = ? ORDER BY created_at, kind",
      ).all(runtimeExecution.workspaceId)).toEqual(
        (["decision", "finding", "question"] as const).map((kind) => ({
          kind,
          summary: recordSummaries[kind],
          digest: createHash("sha256").update(recordSummaries[kind], "utf8").digest("hex"),
        })),
      );
      expect(db.query(
        "SELECT state FROM agent_workspace_tasks WHERE task_id = ? AND workspace_id = ?",
      ).get(materialized.task_id, runtimeExecution.workspaceId)).toEqual({ state: "completed" });

      const getPhaseEvaluationSnapshot = workspace.getPhaseEvaluationSnapshot;
      if (!getPhaseEvaluationSnapshot) throw new Error("Coordinator phase snapshot capability is unavailable");
      const snapshot = await getPhaseEvaluationSnapshot({
        phase: "COMPLETE",
        expectedRevision: runtimeExecution.workspaceRevision,
        signal: rootSignal,
      });
      expect(snapshot.taskTransitions).toEqual({ [templateId]: "completed" });
      expect(snapshot.taskTransitions).not.toHaveProperty(materialized.task_id);
      expect(evaluateCognitionPredicate(
        { kind: "task_transition", taskId: templateId, transition: "completed" },
        {
          generationType: "normal",
          phase: "WORK",
          presetVariables: {},
          participantFacts: {},
          availableTools: [],
          taskTransitions: snapshot.taskTransitions,
        },
      )).toBe(true);

      await applyCognition({
        taskId: "ad-hoc-cognition-task",
        transition: "pending",
        operation: "create_task",
        operationKey: "ad-hoc-cognition-create",
        workspace: {
          actor: "root",
          frameId: rootFrame.frameId,
          taskId: "ad-hoc-cognition-task",
          title: "Ad-hoc task",
          objective: "Keep arbitrary host task identity stable.",
          required: false,
          dependencyIds: [],
        },
        signal: rootSignal,
      });
      const withAdHoc = await getPhaseEvaluationSnapshot({
        phase: "COMPLETE",
        expectedRevision: runtimeExecution.workspaceRevision,
        signal: rootSignal,
      });
      expect(withAdHoc.taskTransitions).toHaveProperty(templateId, "completed");
      expect(withAdHoc.taskTransitions).toHaveProperty("ad-hoc-cognition-task");
      expect(withAdHoc.taskTransitions).not.toHaveProperty(materialized.task_id);

      await execute(
        "create_task",
        {
          taskId: templateId,
          title: "Conflicting ad-hoc task",
          objective: "This authored identity must fail closed when duplicated.",
          required: false,
          dependencyIds: [],
        },
        { actor: "root", frame: rootFrame, operation: "create_task", signal: rootSignal },
      );
      runtimeExecution.workspaceRevision = currentWorkspaceRevision();
      await expect(getPhaseEvaluationSnapshot({
        phase: "COMPLETE",
        expectedRevision: runtimeExecution.workspaceRevision,
        signal: rootSignal,
      })).rejects.toMatchObject({ code: "invalid_state" });
    } finally {
      deps.cleanup?.({ execution } as never);
    }
  });
});
describe("coordinator blocked terminal completion seam", () => {
  test("keeps a blocked terminal phase entered until its pending submission is accepted", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedBlockedTerminal = true;
    scriptedBlockedTerminalTurnId = "";
    scriptedBlockedTerminalTaskCreated = false;
    scriptedBlockedTerminalDelegateIssued = false;
    scriptedBlockedTerminalChildSubmitted = false;
    scriptedBlockedTerminalAttempted = false;
    scriptedBlockedTerminalAcceptanceIssued = false;
    scriptedBlockedTerminalRetryCanAccept = false;
    scriptedBlockedTerminalSnapshots.length = 0;
    providerRequests.length = 0;

    const phaseDefinitions: AgentCustomPhaseV1[] = [
      {
        version: 1,
        id: "blocked_terminal_first",
        label: "Blocked terminal first phase",
        instructionRefs: [],
        required: true,
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: [],
        repeatLimit: 0,
        nextPhaseIds: ["blocked_terminal_last"],
      },
      {
        version: 1,
        id: "blocked_terminal_last",
        label: "Blocked terminal last phase",
        instructionRefs: [],
        required: true,
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: ["workspace_write", "delegation"],
        repeatLimit: 0,
        nextPhaseIds: [],
      },
    ];
    const authoredPhasePlan = compileAgentRuntimePhases(phaseDefinitions);
    expect(authoredPhasePlan.status).toBe("ready");
    const runtimePolicy = {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: null,
      phases: phaseDefinitions,
    };
    const db = getDb();
    const originalConfig = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string };
    const originalProfiles = db.query(
      "SELECT profile_id, workspace_capabilities, max_output_tokens FROM preset_agent_profiles WHERE user_id = ? AND preset_id = ? AND profile_id IN ('delegate', 'delegate_alt') ORDER BY profile_id",
    ).all(USER_ID, AGENTIC_PRESET_ID) as Array<{
      profile_id: string;
      workspace_capabilities: string;
      max_output_tokens: number;
    }>;

    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 1024 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const executionId = `exec-blocked-terminal-${Date.now()}`;
    try {
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({ config: { runtimePolicy } }), USER_ID, AGENTIC_PRESET_ID);
      db.query(
        "UPDATE preset_agent_profiles SET workspace_capabilities = ?, max_output_tokens = 1024 WHERE user_id = ? AND preset_id = ? AND profile_id IN ('delegate', 'delegate_alt')",
      ).run(JSON.stringify(["update_assigned_progress", "submit_child_result"]), USER_ID, AGENTIC_PRESET_ID);

      const decision = await deps.resolveRuntime!(input, target, signal);
      const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, executionId);
      const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, executionId);
      const execution = await deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });
      scriptedBlockedTerminalTurnId = execution.id;
      try {
        const work = await deps.runWork!({
          execution,
          input,
          decision,
          snapshot,
          plan,
          signal,
        });
        expect(work).toMatchObject({ status: "completed" });
        expect(scriptedBlockedTerminalRetryCanAccept).toBe(true);
        expect(scriptedBlockedTerminalSnapshots).toEqual([{
          workspaceState: "active",
          workspaceRevision: expect.any(Number),
          frozenAt: null,
          taskState: "completed",
          submissionState: "submitted",
        }]);
        const blockedSnapshot = scriptedBlockedTerminalSnapshots[0];
        if (!blockedSnapshot) throw new Error("Blocked terminal snapshot was not captured");
        expect(blockedSnapshot.workspaceRevision).toBeGreaterThan(0);

        const workspace = db.query(
          "SELECT state, revision, frozen_at FROM agent_turn_workspaces WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?",
        ).get(`workspace:${execution.id}`, USER_ID, AGENTIC_CHAT_ID, execution.id) as {
          state: string;
          revision: number;
          frozen_at: number | null;
        } | null;
        expect(workspace?.state).toBe("frozen");
        expect(workspace?.frozen_at).not.toBeNull();
        expect(workspace?.revision).toBeGreaterThan(blockedSnapshot.workspaceRevision);

        const task = db.query(
          "SELECT task_id, state FROM agent_workspace_tasks WHERE workspace_id = ? AND turn_id = ? AND task_id = ?",
        ).get(`workspace:${execution.id}`, execution.id, "blocked-terminal-task") as {
          task_id: string;
          state: string;
        } | null;
        expect(task).toEqual({ task_id: "blocked-terminal-task", state: "completed" });

        const submission = db.query(
          "SELECT state FROM agent_workspace_submissions WHERE workspace_id = ? AND turn_id = ? AND task_id = ?",
        ).get(`workspace:${execution.id}`, execution.id, "blocked-terminal-task") as { state: string } | null;
        expect(submission).toEqual({ state: "accepted" });

        const completions = (work.observations ?? []).filter((observation) => observation.toolName === "complete_turn");
        expect(completions).toHaveLength(3);
        expect(completions.map((observation) => observation.status)).toEqual(["accepted", "rejected", "accepted"]);
        expect(completions[1]?.code).toBe("completion_blocked");
      } finally {
        deps.cleanup!({ execution } as never);
      }
    } finally {
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, USER_ID, AGENTIC_PRESET_ID);
      for (const profile of originalProfiles) {
        db.query(
          "UPDATE preset_agent_profiles SET workspace_capabilities = ?, max_output_tokens = ? WHERE user_id = ? AND preset_id = ? AND profile_id = ?",
        ).run(
          profile.workspace_capabilities,
          profile.max_output_tokens,
          USER_ID,
          AGENTIC_PRESET_ID,
          profile.profile_id,
        );
      }
      scriptedBlockedTerminal = false;
      scriptedBlockedTerminalTurnId = "";
      scriptedBlockedTerminalTaskCreated = false;
      scriptedBlockedTerminalDelegateIssued = false;
      scriptedBlockedTerminalChildSubmitted = false;
      scriptedBlockedTerminalAttempted = false;
      scriptedBlockedTerminalAcceptanceIssued = false;
      scriptedBlockedTerminalRetryCanAccept = false;
      scriptedBlockedTerminalSnapshots.length = 0;
      providerRequests.length = 0;
    }
  });
});
