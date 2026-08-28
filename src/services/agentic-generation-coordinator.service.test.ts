import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { compileAgentAssemblyPlan, type AssemblyMessageSegmentV1, type AssemblyProviderMessageV1 } from "./agentic-assembly-compiler";
import { createHash } from "node:crypto";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { registerProvider, getProvider } from "../llm/registry";
import type { LlmProvider } from "../llm/provider";
import type { GenerationRequest, GenerationResponse, StreamChunk } from "../llm/types";
import { createDisabledAgentConfigV2, type AgentCustomPhaseV1 } from "../types/agents";
import { HOST_PREPARATION_LIMITS_V1 } from "../types/agent-preprocessing";
import type { CognitionActivationResultV1, CognitionActivationStateV1 } from "../types/agent-cognition";
import type { CognitionRuntimeActivationV1 } from "../types/agent-cognition-runtime";
import { AgentRuntimeOwner } from "./agent-runtime.service";
import type { FrozenConcreteConnectionV1 } from "../types/agent-runtime-decision";
import { WORKSPACE_OPERATIONS } from "../types/turn-workspace";
import { createAgenticChildFrame, createAgenticRootFrame, executeBoundedAgenticChildFrame, type AgenticWorkProviderRequest } from "./agentic-work-phase.service";
import { compileAgentRuntimePhases } from "./agentic-phase-runtime.service";
import { createAgentCognitionRuntime } from "./agent-cognition-runtime.service";
import { evaluateCognitionPredicate } from "./agent-cognition.service";
import {
  setAgenticRuntimeReadiness,
  startAgentRuntimeEpoch,
  calculateFinalRenderReservationEnvelopeV1,
  finalRenderActivityChunksFromHostLimitsV1,
  createTurnExecution,
  finalizeTurnCommit,
  reconcileAgentTurns,
  reserveFinalRender,
  transitionTurnExecution,
  TurnExecutionError,
} from "./turn-execution.service";
import {
  AGENT_RUNTIME_DECISION_SERVICE,
  canonicalRuntimeCapabilityDigest,
  resolveEffectiveRuntime,
} from "./agent-runtime-decision.service";
import { getIsolateHealthEpoch, probeIsolateBackendsAtStartup } from "./isolate-pool";
import { AGENT_RUNTIME_ADMISSION_MANAGER } from "./agent-runtime-admission";
import { getAgentRuntimeHostLimits } from "./agent-runtime-limits";
import { appendPoolContent, completePool, createPoolEntry, errorPool, getPoolEntry, removePoolEntry } from "./generation-pool.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { runAgenticGeneration, waitForAgenticGeneration } from "./agentic-generation.service";
import { startGeneration, stopGeneration } from "./generate.service";
import * as breakdownSvc from "./breakdown.service";
import { createAgentInspectionWriter, getAgentRunInspection, type AgentInspectionWriterV1 } from "./agent-activity-runs.service";
import { getAgentRun } from "./agent-run-projection.service";
import { deleteChat } from "./chats.service";
import { generateRoutes } from "../routes/generate.routes";

import * as tokenizerService from "./tokenizer.service";
import { encodeCanonicalPlainData } from "../utils/canonical-plain-data";
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
const boundProviderDispatches: Array<{
  readonly provider: string;
  readonly url: string;
  readonly request: GenerationRequest;
}> = [];

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
type InspectionProviderScenario = "success" | "throw_after_yield" | "abort_after_yield" | "timeout_after_yield" | "receive_cap" | "output_cap";
let inspectionProviderScenario: InspectionProviderScenario = "success";
let inspectionProviderYielded: (() => void) | undefined;
class InspectionLifecycleProvider implements LlmProvider {
  readonly name = "inspection-lifecycle-provider";
  readonly displayName = "Inspection lifecycle provider";
  readonly defaultUrl = "https://inspection-lifecycle.invalid/v1";
  readonly capabilities = new ScriptedProvider().capabilities;

  async generate(): Promise<GenerationResponse> {
    return { content: "unused", finish_reason: "stop" };
  }

  async *generateStream(key: string, _url: string, request: GenerationRequest): AsyncGenerator<StreamChunk, void, unknown> {
    yield { token: "partial" };
    inspectionProviderYielded?.();
    if (inspectionProviderScenario === "throw_after_yield") throw new Error("provider-secret:" + key);
    if (inspectionProviderScenario === "timeout_after_yield") throw new DOMException("provider-secret:" + key, "TimeoutError");
    if (inspectionProviderScenario === "abort_after_yield") {
      await new Promise<void>(() => {});
      return;
    }
    if (inspectionProviderScenario === "receive_cap") {
      yield { token: "x".repeat(1024) };
      return;
    }
    yield {
      token: inspectionProviderScenario === "output_cap" ? " capped-output" : " success",
      finish_reason: "stop",
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    };
  }

  async validateKey(): Promise<boolean> { return true; }
  async listModels(): Promise<string[]> { return ["inspection-model"]; }
}
class BoundScriptedProvider implements LlmProvider {
  readonly displayName: string;
  readonly capabilities = new ScriptedProvider().capabilities;
  private readonly delegate = new ScriptedProvider();

  constructor(
    readonly name: string,
    readonly defaultUrl: string,
    readonly model: string,
    readonly usage: NonNullable<GenerationResponse["usage"]>,
  ) {
    this.displayName = name;
  }

  async generate(key: string, url: string, request: GenerationRequest): Promise<GenerationResponse> {
    boundProviderDispatches.push({ provider: this.name, url, request });
    return { ...(await this.delegate.generate(key, url, request)), usage: this.usage };
  }

  async *generateStream(key: string, url: string, request: GenerationRequest): AsyncGenerator<StreamChunk, void, unknown> {
    boundProviderDispatches.push({ provider: this.name, url, request });
    const isBoundedChild = request.messages.some((message) =>
      typeof message.content === "string" && message.content.includes("bounded subordinate frame"));
    if (isBoundedChild) {
      yield { token: "bound child output from " + this.name };
      yield { token: "", finish_reason: "stop", usage: this.usage };
      return;
    }
    for await (const chunk of this.delegate.generateStream(key, url, request)) {
      yield chunk.finish_reason ? { ...chunk, usage: this.usage } : chunk;
    }
  }

  async validateKey(): Promise<boolean> { return true; }
  async listModels(): Promise<string[]> { return [this.model]; }
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
    "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)",
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
       phase_policy_json, cognition_policy_json, task_policy_json,
       workspace_policy_json, state, review_acknowledged, config_revision, binding_revision,
       created_at, updated_at)
      VALUES (?, ?, 2, 1, ?, 'agentic', 8, 8, ?, 'active',
        '{}', '{}', '{}', '{}', 'ready', 1, ?, ?, ?, ?)`,
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

function seedTransientAgenticChat(id: string): void {
  const now = Date.now();
  getDb().query(
    "INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, USER_ID, "character-coordinator", "Transient Agentic Coordinator Chat", now, now, "{}", ADMITTED_TARGET_REVISION);
}

function seedTargetMessage(id: string, chatId: string, revision: number): void {
  const now = Date.now();
  getDb().query(
    "INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at, generation_revision) VALUES (?, ?, 0, 0, ?, ?, ?, 0, ?, ?, '{}', ?, ?)",
  ).run(id, chatId, "Coordinator", "target", now, JSON.stringify(["target"]), JSON.stringify([now]), now, revision);
}
function seedCommittedExecution(id: string, chatId = AGENTIC_CHAT_ID): void {
  const messageId = "message:" + id;
  seedTargetMessage(messageId, chatId, 0);
  const created = createTurnExecution({
    id,
    userId: USER_ID,
    chatId,
    generationId: id,
    target: { kind: "normal" },
    mode: "agentic",
    runtimeEpoch: 1,
    deadlineAt: Date.now() + 60_000,
    workspaceId: `workspace:${id}`,
    rootLedger: {},
    frameCapabilities: {},
  });
  let current = created.execution;
  for (const nextPhase of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
    current = transitionTurnExecution({
      executionId: id,
      ownerToken: created.ownerToken,
      expectedPhase: current.phase,
      nextPhase,
      ignoreCancellation: true,
    }).execution;
  }
  finalizeTurnCommit({
    executionId: id,
    ownerToken: created.ownerToken,
    receiptId: `receipt:${id}`,
    messageId,
    swipeId: 0,
    summary: { source: "coordinator-test" },
  });
}


beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await applyBaseline();
  seed();
  if (!getProvider("scripted-coordinator")) registerProvider(new ScriptedProvider());
  if (!getProvider("inspection-lifecycle-provider")) registerProvider(new InspectionLifecycleProvider());
  if (!getProvider("scripted-child-a")) {
    registerProvider(new BoundScriptedProvider(
      "scripted-child-a",
      "https://child-a.invalid/v1",
      "child-model-a",
      { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24 },
    ));
  }
  if (!getProvider("scripted-child-b")) {
    registerProvider(new BoundScriptedProvider(
      "scripted-child-b",
      "https://child-b.invalid/v1",
      "child-model-b",
      { prompt_tokens: 17, completion_tokens: 19, total_tokens: 36 },
    ));
  }
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
  test("publishes canonical nonterminal phases but leaves terminal publication to the cause owner", async () => {
    const executionId = `exec-public-phase-order-${Date.now()}`;
    createTurnExecution({
      id: executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationId: executionId,
      target: { kind: "normal" },
      mode: "agentic",
      runtimeEpoch: 1,
      deadlineAt: Date.now() + 60_000,
      workspaceId: `workspace:${executionId}`,
      rootLedger: {},
      frameCapabilities: {},
    });
    const publishPhase = __testing.buildDependencies().publishPhase;
    if (!publishPhase) throw new Error("phase publication authority is unavailable");

    const observed: Array<{ phase: string; status: string; outcome: string | null }> = [];
    for (const event of [
      { phase: "WORK", workPhase: "WORK", workStatus: "running" },
      { phase: "COMPLETE", workPhase: "PREPARE_COMMIT", workStatus: "waiting" },
      { phase: "RENDER", workPhase: "RENDER", workStatus: "running" },
      { phase: "PREPARE_COMMIT", workPhase: "COMMIT", workStatus: "waiting" },
      { phase: "COMMITTING", workPhase: "COMMIT", workStatus: "running" },
    ] as const) {
      await publishPhase({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        ...event,
        workOutcome: null,
        reason: null,
        target: { generationType: "normal" },
      });
      const projection = getAgentRun(USER_ID, executionId);
      if (!projection) throw new Error("phase projection was not persisted");
      observed.push({
        phase: projection.workPhase,
        status: projection.workStatus,
        outcome: projection.workOutcome,
      });
    }

    expect(observed).toEqual([
      { phase: "WORK", status: "running", outcome: null },
      { phase: "PREPARE_COMMIT", status: "waiting", outcome: null },
      { phase: "RENDER", status: "running", outcome: null },
      { phase: "COMMIT", status: "waiting", outcome: null },
      { phase: "COMMIT", status: "running", outcome: null },
    ]);

    await publishPhase({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      phase: "FAILED",
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
      reason: "failed",
      target: { generationType: "normal" },
    });
    expect(getAgentRun(USER_ID, executionId)).toMatchObject({
      workPhase: "COMMIT",
      workStatus: "running",
      workOutcome: null,
    });
  });

  test("maps the retained Turn Session through public COMMIT during normal preparation", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const chatId = `chat-retained-phase-order-${Date.now()}`;
    seedTransientAgenticChat(chatId);
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      {
        userId: USER_ID,
        chatId,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        userInput: USER_INPUT,
      },
      target,
      signal,
    );
    const executionId = `exec-retained-phase-order-${Date.now()}`;
    let execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId,
      target,
      decision,
      signal,
    });
    const observed: Array<{ phase: string; status: string; outcome: string | null }> = [];

    try {
      for (const next of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
        const expected = execution.phase;
        if (!expected) throw new Error("retained session execution phase is unavailable");
        const transitioned = await deps.transitionExecution!(execution, expected, next);
        if (!transitioned) throw new Error("retained session transition did not return its execution");
        execution = transitioned;
        const session = getDb().query(
          "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
        ).get(USER_ID, executionId) as { phase: string; status: string; outcome: string | null } | null;
        if (!session) throw new Error("retained Turn Session was not persisted");
        observed.push(session);
      }

      expect(observed).toEqual([
        { phase: "WORK", status: "running", outcome: null },
        { phase: "PREPARE_COMMIT", status: "waiting", outcome: null },
        { phase: "RENDER", status: "running", outcome: null },
        { phase: "COMMIT", status: "waiting", outcome: null },
        { phase: "COMMIT", status: "running", outcome: null },
      ]);
    } finally {
      const durablePhase = await deps.readExecutionPhase!(execution);
      if (durablePhase === "COMMITTING") {
        const failed = await deps.transitionExecution!(
          { ...execution, phase: durablePhase },
          durablePhase,
          "COMMIT_FAILED",
          "test_cleanup",
        );
        if (failed) execution = failed;
      } else if (
        durablePhase === "ASSEMBLE"
        || durablePhase === "WORK"
        || durablePhase === "COMPLETE"
        || durablePhase === "RENDER"
        || durablePhase === "PREPARE_COMMIT"
      ) {
        const failed = await deps.transitionExecution!(
          { ...execution, phase: durablePhase },
          durablePhase,
          "FAILED",
          "test_cleanup",
        );
        if (failed) execution = failed;
      }
      deps.cleanup!({ execution, phase: execution.phase, status: "failed" } as never);
    }
  });

  test("retains COMMIT/waiting when render preparation fails before terminal publication", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const chatId = `chat-preparation-failure-${Date.now()}`;
    seedTransientAgenticChat(chatId);
    scriptedWorkRound = 0;
    const preparationBoundaries: Array<{ phase: string; status: string; outcome: string | null }> = [];
    let preparationExecutionId = "";
    const generationInput = {
      userId: USER_ID,
      chatId,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: "forced preparation failure",
      parameters: { max_tokens: 64 },
    };
    const admittedDecision = {
      ...await deps.resolveRuntime!(
        generationInput,
        { generationType: "normal", revision: ADMITTED_TARGET_REVISION },
        new AbortController().signal,
      ),
      mode: "agentic" as const,
    };

    const started = await runAgenticGeneration(generationInput, {
      ...deps,
      resolveRuntime: async () => admittedDecision,
      buildAssemblySnapshot: async () => ({}) as never,
      compileAssemblyPlan: async () => ({}) as never,
      runWork: async () => ({ status: "completed" }),
      render: async () => ({ content: "prepared render" }),
      prepareRender: async ({ execution }) => {
        preparationExecutionId = execution.id;
        const boundary = getDb().query(
          "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
        ).get(USER_ID, execution.id) as { phase: string; status: string; outcome: string | null } | null;
        if (!boundary) throw new Error("missing retained preparation boundary");
        preparationBoundaries.push(boundary);
        throw new Error("forced_render_preparation_failure");
      },
    });
    const settled = await waitForAgenticGeneration(started.generationId);

    expect(preparationExecutionId).toBe(started.generationId);
    expect(preparationBoundaries).toEqual([{
      phase: "COMMIT",
      status: "waiting",
      outcome: null,
    }]);
    expect(settled).toMatchObject({ status: "failed", phase: "FAILED" });
    expect(getDb().query(
      "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
    ).get(USER_ID, started.generationId)).toEqual({
      phase: "TERMINAL",
      status: "terminal",
      outcome: "failed",
    });

    const chronology = getAgentRunInspection(USER_ID, started.generationId, chatId)?.transcript ?? [];
    const renderIndex = chronology.findIndex(({ id }) => id === `phase:${started.generationId}:RENDER`);
    const preparationIndex = chronology.findIndex(({ id }) => id === `phase:${started.generationId}:PREPARE_COMMIT`);
    expect(renderIndex).toBeGreaterThanOrEqual(0);
    expect(preparationIndex).toBeGreaterThan(renderIndex);
    expect(chronology[renderIndex]?.correlation.phase).toBe("RENDER");
    expect(chronology[preparationIndex]?.correlation.phase).toBe("COMMIT");
  });

  test("records every child provider stream outcome exactly once without leaking secrets", async () => {
    const capabilities = new InspectionLifecycleProvider().capabilities;
    const connection = {
      logicalId: "inspection-connection",
      concreteId: "inspection-connection",
      label: "Inspection connection",
      provider: "inspection-lifecycle-provider",
      model: "inspection-model",
      effectiveEndpoint: "https://inspection-lifecycle.invalid/v1",
      endpointRevision: "endpoint-frozen",
      credentialSecretRef: "credential-ref-frozen",
      credentialRevision: "credential-frozen",
      candidateRevision: "candidate-frozen",
      revision: "connection-frozen",
      fingerprint: "source-fingerprint-frozen",
      capabilityDigest: canonicalRuntimeCapabilityDigest(capabilities),
      capabilities,
    } satisfies FrozenConcreteConnectionV1;
    const records: Array<{ kind: string; value: Record<string, unknown>; state: unknown }> = [];
    const writer: AgentInspectionWriterV1 = {
      record: (kind, value, state) => {
        records.push({ kind, value: value as Record<string, unknown>, state });
        return null;
      },
    };
    const authoredCorrelation = __testing.createChildInspectionCorrelation(writer);
    authoredCorrelation.writer!.record("policy", {
      id: "work:child-policy:generated-authored",
      kind: "policy",
      actor: "host",
      recipient: "child",
    });
    expect(records).toHaveLength(0);
    authoredCorrelation.bind("generated-authored", "authored-task-id");
    expect(records[0]?.value.correlation).toEqual({ taskId: "authored-task-id" });
    records.length = 0;
    authoredCorrelation.writer!.record("transcript", {
      id: "tool:work:0:collision-id",
      kind: "delegation",
      actor: "agent",
      recipient: "host",
      correlation: { toolId: "agent_delegate", taskId: "authored-task-a" },
    });
    authoredCorrelation.writer!.record("transcript", {
      id: "work:task:1:authored-task",
      kind: "task",
      actor: "agent",
      recipient: "host",
      correlation: { taskId: "collision-id" },
    });
    expect(records.at(-1)?.value.correlation).toEqual({ taskId: "collision-id" });
    records.length = 0;

    const activityNodes: Array<{ readonly id: string; readonly actor: string; readonly taskId?: string }> = [];
    __testing.recordPublicWorkActivity({
      recordActivityNode: (node) => activityNodes.push({ id: node.id, actor: node.actor, ...(node.taskId ? { taskId: node.taskId } : {}) }),
    }, {
      observations: [{
        sequence: 0,
        callId: "authored-task-a",
        correlationId: "authored-task-a",
        toolName: "workspace_create_task",
        status: "success",
        resultBytes: 0,
      }],
      childResults: [{
        childId: "generated-collision-child",
        profileId: "delegate",
        slotIndex: 0,
        required: true,
        status: "succeeded",
        outputBytes: 1,
      }],
    }, "generation-collision", new Map([["generated-collision-child", "authored-task-a"]]));
    expect(activityNodes).toEqual([
      { id: "authored-task-a", actor: "tool" },
      { id: "task:authored-task-a", actor: "child", taskId: "authored-task-a" },
    ]);
    const intrinsicCorrelation = __testing.createChildInspectionCorrelation(writer);
    intrinsicCorrelation.writer!.record("policy", {
      id: "work:child-policy:generated-intrinsic",
      kind: "policy",
      actor: "host",
      recipient: "child",
    });
    intrinsicCorrelation.bind("generated-intrinsic");
    expect(records[0]?.value.correlation).toEqual({ taskId: "generated-intrinsic" });
    records.length = 0;
    const makeRequest = (controller: AbortController, receiveLimitBytes = 4096): AgenticWorkProviderRequest => ({
      frame: createAgenticChildFrame({
        frameId: "inspection-child-frame",
        parentFrameId: "inspection-root-frame",
        provider: connection.provider,
        connectionId: connection.concreteId,
        model: connection.model,
        coreToolIds: [],
        taskId: "authored-task-id",
        workspaceCapabilities: [],
        signal: controller.signal,
      }),
      connectionId: connection.concreteId,
      model: connection.model,
      messages: [{ role: "user", content: "bounded provider lifecycle" }],
      receiveLimitBytes,
      publishedOutputLimitBytes: 4096,
      tools: [],
      toolMode: "ordinary",
      maxOutputTokens: 32,
      roundIndex: 0,
      signal: controller.signal,
    });
    const outputCapLedger = {
      reserveProviderDispatch: () => ({
        logical: { consume() {}, release() {} },
        physical: { consume() {}, release() {} },
      }),
      acquireProviderPermit: () => ({}),
      releaseOperationPermit() {},
      remaining: () => 0,
      charge: () => false,
    } as unknown as NonNullable<Parameters<typeof __testing.makeWorkProvider>[3]>;
    const dispatch = (request: AgenticWorkProviderRequest, ledger?: typeof outputCapLedger) =>
      __testing.makeWorkProvider(
        USER_ID,
        connection,
        undefined,
        ledger,
        "RAW_CREDENTIAL_SENTINEL",
        (providerRequest, outcome) => __testing.recordChildProviderExchange(
          writer,
          providerRequest,
          outcome,
          connection,
          ADMITTED_CONFIG_REVISION,
          "delegate",
          "generated-child-id",
        ),
      )(request);
    const assertSingleFailure = (reason: string, code: string): void => {
      const exchanges = records.filter((record) => record.kind === "provider_exchange");
      expect(exchanges).toHaveLength(1);
      expect(records.filter((record) => record.kind === "usage")).toHaveLength(0);
      const exchange = exchanges[0]!.value;
      expect(exchange).not.toHaveProperty("content");
      expect(exchange.errorReason).toBe(reason);
      expect(JSON.parse(String(exchange.result))).toEqual(expect.objectContaining({ code }));
      expect(exchange.provider).toEqual({
        adapter: "agentic-work",
        providerId: connection.provider,
        modelId: connection.model,
        connectionId: connection.concreteId,
        configRevision: ADMITTED_CONFIG_REVISION,
        connectionRevision: connection.candidateRevision,
        fingerprint: connection.fingerprint,
      });
      expect(exchange.correlation).toEqual({
        taskId: "authored-task-id",
        parentId: "inspection-root-frame",
      });
      const encoded = JSON.stringify(records);
      expect(encoded).not.toContain("RAW_CREDENTIAL_SENTINEL");
      expect(encoded).not.toContain("provider-secret");
      expect(encoded).not.toContain("abort-secret");
    };

    inspectionProviderScenario = "success";
    await dispatch(makeRequest(new AbortController()));
    expect(records.filter((record) => record.kind === "provider_exchange")).toHaveLength(1);
    expect(records.filter((record) => record.kind === "usage")).toHaveLength(1);
    records.length = 0;

    for (const [scenario, reason, code, receiveLimitBytes, ledger] of [
      ["throw_after_yield", "provider_failure", "provider_failure", 4096, undefined],
      ["timeout_after_yield", "provider_failure", "provider_failure", 4096, undefined],
      ["receive_cap", "budget_exhausted", "limit_exceeded", 32, undefined],
      ["output_cap", "budget_exhausted", "child_output_limit_exceeded", 4096, outputCapLedger],
    ] as const) {
      inspectionProviderScenario = scenario;
      await expect(dispatch(makeRequest(new AbortController(), receiveLimitBytes), ledger)).rejects.toBeDefined();
      assertSingleFailure(reason, code);
      records.length = 0;
    }
    inspectionProviderScenario = "success";
    await expect(dispatch({ ...makeRequest(new AbortController()), publishedOutputLimitBytes: 1 })).rejects.toBeDefined();
    assertSingleFailure("budget_exhausted", "child_output_limit_exceeded");
    records.length = 0;

    inspectionProviderScenario = "abort_after_yield";
    const controller = new AbortController();
    const yielded = new Promise<void>((resolve) => { inspectionProviderYielded = resolve; });
    const pending = dispatch(makeRequest(controller));
    await yielded;
    controller.abort(new DOMException("abort-secret", "AbortError"));
    await expect(pending).rejects.toBeDefined();
    assertSingleFailure("interrupted", "cancelled");
    inspectionProviderYielded = undefined;
    inspectionProviderScenario = "success";
    const persistedAttemptId = "inspection-provider-failure-persisted";
    const persistedWriter = createAgentInspectionWriter({
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      attemptId: persistedAttemptId,
      runId: persistedAttemptId,
      turnSessionId: persistedAttemptId,
      generationId: persistedAttemptId,
      generationType: "normal",
      hostCorrelationId: persistedAttemptId,
      lifecycle: "WORK",
      status: "running",
    });
    const persistedDispatch = (request: AgenticWorkProviderRequest) =>
      __testing.makeWorkProvider(
        USER_ID,
        connection,
        undefined,
        undefined,
        "RAW_CREDENTIAL_SENTINEL",
        (providerRequest, outcome) => __testing.recordChildProviderExchange(
          persistedWriter,
          providerRequest,
          outcome,
          connection,
          ADMITTED_CONFIG_REVISION,
          "delegate",
          "generated-child-id",
        ),
      )(request);
    inspectionProviderScenario = "throw_after_yield";
    await expect(persistedDispatch(makeRequest(new AbortController()))).rejects.toBeDefined();
    const persistedInspection = getAgentRunInspection(USER_ID, persistedAttemptId, AGENTIC_CHAT_ID);
    expect(persistedInspection?.transcript.filter((record) => record.kind === "provider_exchange")).toHaveLength(1);
    expect(JSON.stringify(persistedInspection)).not.toContain("RAW_CREDENTIAL_SENTINEL");
    expect(JSON.stringify(persistedInspection)).not.toContain("provider-secret");
    inspectionProviderScenario = "success";
  });

  test("bounds persistent recovery while prioritizing receipt-backed committed sessions", () => {
    const db = getDb();
    const workspaceId = "workspace:persistent-recovery-budget";
    const priorityExecutionId = "persistent-recovery-priority-execution";
    const now = Date.now();
    const maxRows = __testing.persistentRecoveryLimits.maxRows;
    db.query(
      "INSERT INTO persistent_workspaces (workspace_id, user_id, chat_id, objective) VALUES (?, ?, ?, ?)",
    ).run(workspaceId, USER_ID, AGENTIC_CHAT_ID, "bounded recovery");
    seedCommittedExecution(priorityExecutionId);
    const insertSession = db.query(`
      INSERT INTO persistent_workspace_turn_sessions (
        turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
        execution_id, phase, status, outcome, reason, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertSession.run(
      "persistent-recovery-priority-session",
      workspaceId,
      USER_ID,
      AGENTIC_CHAT_ID,
      priorityExecutionId,
      priorityExecutionId,
      priorityExecutionId,
      "WORK",
      "running",
      null,
      "none",
      0,
      now,
      now,
    );
    for (let index = 0; index < maxRows + 1; index += 1) {
      const id = `persistent-recovery-overflow-${index}`;
      insertSession.run(
        id,
        workspaceId,
        USER_ID,
        AGENTIC_CHAT_ID,
        `persistent-recovery-turn-${index}`,
        `persistent-recovery-attempt-${index}`,
        null,
        "WORK",
        "running",
        null,
        "none",
        0,
        now,
        now,
      );
    }
    try {
      const recovery = __testing.reconcilePersistentWorkspaceSessions();
      expect(recovery.complete).toBe(false);
      expect(recovery.inspected).toBeLessThanOrEqual(maxRows);
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get("persistent-recovery-priority-session")).toEqual({
        phase: "TERMINAL",
        status: "terminal",
        outcome: "completed",
      });
      expect((db.query(
        "SELECT COUNT(*) AS count FROM persistent_workspace_turn_sessions WHERE workspace_id = ? AND status <> 'terminal'",
      ).get(workspaceId) as { count: number }).count).toBeGreaterThan(0);
    } finally {
      db.query("DELETE FROM persistent_workspace_turn_sessions WHERE workspace_id = ?").run(workspaceId);
      db.query("DELETE FROM persistent_workspaces WHERE workspace_id = ?").run(workspaceId);
      db.query("DELETE FROM agent_turn_commit_receipts WHERE execution_id = ?").run(priorityExecutionId);
      db.query("DELETE FROM agent_turn_executions WHERE id = ?").run(priorityExecutionId);
      db.query("DELETE FROM agent_turn_workspaces WHERE turn_id = ?").run(priorityExecutionId);
    }
  });

  test("fails coordinator installation closed when persistent recovery is incomplete", () => {
    const db = getDb();
    __testing.resetInstallation();
    db.run("ALTER TABLE agent_turn_commit_receipts RENAME TO agent_turn_commit_receipts_unavailable");
    try {
      expect(() => installAgenticGenerationCoordinator()).toThrow("persistent session recovery incomplete");
    } finally {
      db.run("ALTER TABLE agent_turn_commit_receipts_unavailable RENAME TO agent_turn_commit_receipts");
      __testing.resetInstallation();
      installAgenticGenerationCoordinator();
    }
  });
  test("rolls back the persistent session when receipt projection repair fails", () => {
    const db = getDb();
    const workspaceId = "workspace:persistent-recovery-projection-failure";
    const executionId = "persistent-recovery-projection-failure-execution";
    const sessionId = "persistent-recovery-projection-failure-session";
    const now = Date.now();
    db.query(
      "INSERT INTO persistent_workspaces (workspace_id, user_id, chat_id, objective) VALUES (?, ?, ?, ?)",
    ).run(workspaceId, USER_ID, AGENTIC_CHAT_ID, "projection failure");
    seedCommittedExecution(executionId);
    db.query(`
      INSERT INTO persistent_workspace_turn_sessions (
        turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
        execution_id, phase, status, outcome, reason, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'WORK', 'running', NULL, 'none', 0, ?, ?)
    `).run(
      sessionId,
      workspaceId,
      USER_ID,
      AGENTIC_CHAT_ID,
      executionId,
      executionId,
      executionId,
      now,
      now,
    );
    db.run(`
      CREATE TRIGGER persistent_recovery_projection_failure_insert
      BEFORE INSERT ON agent_run_projections
      BEGIN
        SELECT RAISE(ABORT, 'injected persistent receipt projection failure');
      END
    `);
    db.run(`
      CREATE TRIGGER persistent_recovery_projection_failure_update
      BEFORE UPDATE ON agent_run_projections
      BEGIN
        SELECT RAISE(ABORT, 'injected persistent receipt projection failure');
      END
    `);
    try {
      const recovery = __testing.reconcilePersistentWorkspaceSessions();
      expect(recovery.complete).toBe(false);
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get(sessionId)).toEqual({
        phase: "WORK",
        status: "running",
        outcome: null,
      });
    } finally {
      db.run("DROP TRIGGER persistent_recovery_projection_failure_insert");
      db.run("DROP TRIGGER persistent_recovery_projection_failure_update");
      db.query("DELETE FROM persistent_workspace_turn_sessions WHERE workspace_id = ?").run(workspaceId);
      db.query("DELETE FROM persistent_workspaces WHERE workspace_id = ?").run(workspaceId);
      db.query("DELETE FROM agent_turn_commit_receipts WHERE execution_id = ?").run(executionId);
      db.query("DELETE FROM agent_turn_executions WHERE id = ?").run(executionId);
      db.query("DELETE FROM agent_turn_workspaces WHERE turn_id = ?").run(executionId);
    }
  });
  test("never invents terminal outcomes for persistent sessions without an execution owner", () => {
    const db = getDb();
    const workspaceId = "workspace:persistent-recovery-slow-clock";
    const firstSessionId = "persistent-recovery-slow-a";
    const secondSessionId = "persistent-recovery-slow-b";
    db.query(
      "INSERT INTO persistent_workspaces (workspace_id, user_id, chat_id, objective) VALUES (?, ?, ?, ?)",
    ).run(workspaceId, USER_ID, AGENTIC_CHAT_ID, "slow recovery");
    const insertSession = db.query(`
      INSERT INTO persistent_workspace_turn_sessions (
        turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
        execution_id, phase, status, outcome, reason, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'WORK', 'running', NULL, 'none', 0, ?, ?)
    `);
    insertSession.run(
      firstSessionId,
      workspaceId,
      USER_ID,
      AGENTIC_CHAT_ID,
      "persistent-recovery-slow-turn-a",
      "persistent-recovery-slow-attempt-a",
      100,
      100,
    );
    insertSession.run(
      secondSessionId,
      workspaceId,
      USER_ID,
      AGENTIC_CHAT_ID,
      "persistent-recovery-slow-turn-b",
      "persistent-recovery-slow-attempt-b",
      200,
      200,
    );
    const clockValues = [1_000, 1_000, 1_000, 6_000];
    let clockIndex = 0;
    __testing.setPersistentRecoveryClock(() => clockValues[Math.min(clockIndex++, clockValues.length - 1)]!);
    try {
      const blocked = __testing.reconcilePersistentWorkspaceSessions();
      expect(blocked.complete).toBe(false);
      expect(blocked.recovered).toBe(0);
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get(firstSessionId)).toEqual({
        phase: "WORK",
        status: "running",
        outcome: null,
      });
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get(secondSessionId)).toEqual({
        phase: "WORK",
        status: "running",
        outcome: null,
      });
      __testing.setPersistentRecoveryClock(null);
      const recovered = __testing.reconcilePersistentWorkspaceSessions();
      expect(recovered.complete).toBe(false);
      expect(recovered.recovered).toBe(0);
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get(secondSessionId)).toEqual({
        phase: "WORK",
        status: "running",
        outcome: null,
      });
    } finally {
      __testing.setPersistentRecoveryClock(null);
      db.query("DELETE FROM persistent_workspace_turn_sessions WHERE workspace_id = ?").run(workspaceId);
      db.query("DELETE FROM persistent_workspaces WHERE workspace_id = ?").run(workspaceId);
    }
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
        provider: "scripted-coordinator",
        connectionId: CONNECTION_ID,
        model: "scripted-model",
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
      const createdRoot = await workspace.execute?.(
        "create_task",
        {
          taskId: "root-result-auth",
          title: "Root result task",
          objective: "Verify root-only completion.",
          dependencyIds: [],
        },
        { actor: "root", frame: rootFrame, operation: "create_task", signal: rootSignal },
      );
      expect(createdRoot).toMatchObject({
        result: expect.objectContaining({ id: "root-result-auth" }),
      });
      const rootResultChild = createAgenticChildFrame({
        frameId: "root-result-child",
        parentFrameId: execution.id,
        provider: "scripted-coordinator",
        connectionId: CONNECTION_ID,
        model: "scripted-model",
        coreToolIds: [],
        taskId: "root-result-auth",
        workspaceCapabilities: ["submit_child_result"],
        signal: rootSignal,
      });
      await expect(workspace.execute?.(
        "submit_root_result",
        { taskId: "root-result-auth", summary: "Child cannot complete a root task.", state: "completed" },
        { actor: "child", frame: rootResultChild, operation: "submit_root_result", signal: rootSignal },
      )).rejects.toThrow();
      const rootResult = await workspace.execute?.(
        "submit_root_result",
        { taskId: "root-result-auth", summary: "Root completed its own task.", state: "completed" },
        { actor: "root", frame: rootFrame, operation: "submit_root_result", signal: rootSignal },
      );
      expect(rootResult).toMatchObject({
        result: expect.objectContaining({ id: "root-result-auth" }),
      });
      expect(getDb().query(
        "SELECT state, assigned_frame_id FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "root-result-auth")).toEqual({ state: "completed", assigned_frame_id: null });
      const settled = await workspace.settleAssignedTask?.({
        taskId: "task-auth",
        frameId: "valid-child-frame",
        state: "failed",
        operationKey: "coordinator-test-settlement",
        signal: rootSignal,
      });
      expect(settled).toMatchObject({ accepted: true });
      expect(getDb().query(
        "SELECT state, assigned_frame_id FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-auth")).toEqual({ state: "failed", assigned_frame_id: "valid-child-frame" });
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

  test("production readiness digest tracks the frozen cognition revision", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const db = getDb();
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
      expect(String(first.internal.readinessVector.cognitionRevision).length).toBeGreaterThan(0);
      const firstCognitionRevision = first.internal.readinessVector.cognitionRevision;
      const firstDigest = first.internal.binding.readinessDigest;

      db.query("UPDATE preset_agent_configs SET max_invocations = max_invocations + 1 WHERE user_id = ? AND preset_id = ?")
        .run(USER_ID, AGENTIC_PRESET_ID);
      const second = await resolveEffectiveRuntime(USER_ID, { ...baseRequest, requestEpoch: 102 });
      expect(second.internal.readinessVector.cognitionRevision).not.toBe(firstCognitionRevision);
      expect(second.internal.binding.readinessDigest).not.toBe(firstDigest);
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
         phase_policy_json, cognition_policy_json, task_policy_json,
         workspace_policy_json, state, review_code, review_acknowledged, config_revision, binding_revision,
         created_at, updated_at)
        VALUES (?, ?, 2, 1, ?, 'agentic', 8, 8, ?, 'active',
          '{}', '{}', '{}', '{}', 'repair_required', 'cognition_invalid', 0, 1, 1, ?, ?)`,
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

  test("explicit Response stays available without Agentic capability poison", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null },
      mode: "response",
      requestEpoch: 202,
    });
    expect(decision.requestedMode).toBe("response");
    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.ready).toBe(true);
    expect(decision.capabilityReadiness.required).toEqual([]);
    expect(decision.capabilityReadiness.missing).toEqual([]);
    expect(decision.capabilityReadiness.repairCodes).not.toEqual(expect.arrayContaining([
      "input_revisions_incomplete",
      "agentic_input_revisions_incomplete",
      "provider_capability_unavailable",
    ]));
    expect(decision.repairCodes).not.toEqual(expect.arrayContaining([
      "input_revisions_incomplete",
      "agentic_input_revisions_incomplete",
    ]));
    expect(decision.runtimePolicy.availability.state).toBe("available");
    expect(decision.runtimePolicy.availability.reasonCode).toBeNull();
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
      )).rejects.toMatchObject({
        name: "AgenticGenerationError",
        code: "decision_refresh_required",
        message: "decision_refresh_required: config_revision",
      });
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
      )).rejects.toMatchObject({
        name: "AgenticGenerationError",
        code: "decision_refresh_required",
        message: "decision_refresh_required: binding_revision",
      });
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
  test("admits differently ordered World Info projections before provider without weakening source revision fences", async () => {
    const db = getDb();
    const bookId = "book-runtime-world-authority";
    // Native World Info retains insertion order for equal order_value rows,
    // while admission's fallback query uses the ID tie-breaker. These IDs
    // deliberately make the two projections traverse the same sources in
    // opposite orders.
    const firstEntryId = "entry-runtime-world-authority-z";
    const secondEntryId = "entry-runtime-world-authority-a";
    const character = db.query("SELECT extensions FROM characters WHERE id = ?").get("character-coordinator") as { extensions: string };
    const now = Date.now();
    db.query(
      "INSERT INTO world_books (id, user_id, name, description, folder, metadata, created_at, updated_at) VALUES (?, ?, ?, '', '', '{}', ?, ?)",
    ).run(bookId, USER_ID, "Runtime World Authority", now, now);
    const insertEntry = db.query(
      "INSERT INTO world_book_entries (id, world_book_id, uid, key, content, constant, disabled, vectorized, revision, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, 1, 0, 0, 1, ?, ?)",
    );
    insertEntry.run(firstEntryId, bookId, firstEntryId, "First constant source", now, now);
    insertEntry.run(secondEntryId, bookId, secondEntryId, "Second constant source", now, now);
    db.query("UPDATE characters SET extensions = ? WHERE id = ?")
      .run(JSON.stringify({ world_book_ids: [bookId] }), "character-coordinator");

    try {
      const providerRequestsBefore = providerRequests.length;
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
      const snapshot = await deps.buildAssemblySnapshot!(
        input,
        decision,
        target,
        signal,
        "test-world-derived-activation",
      );
      expect(snapshot.worldInfo.entries.map((entry) => [entry.id, entry.activated])).toEqual([
        [firstEntryId, true],
        [secondEntryId, true],
      ]);
      expect(providerRequests).toHaveLength(providerRequestsBefore);

      db.query("UPDATE world_book_entries SET revision = revision + 1 WHERE id = ?").run(secondEntryId);
      await expect(deps.buildAssemblySnapshot!(
        input,
        decision,
        target,
        signal,
        "test-world-stale-source",
      )).rejects.toMatchObject({
        name: "AgenticGenerationError",
        code: "agentic_revision_conflict",
        message: "stale_input_revision",
      });
      expect(providerRequests).toHaveLength(providerRequestsBefore);
    } finally {
      db.query("UPDATE characters SET extensions = ? WHERE id = ?")
        .run(character.extensions, "character-coordinator");
      db.query("DELETE FROM world_book_entries WHERE world_book_id = ?").run(bookId);
      db.query("DELETE FROM world_books WHERE id = ?").run(bookId);
    }
  });
  test("production assembly keeps cognition inactive when no Loom source is authored", async () => {
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
    const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, "test-cognition");
    expect(snapshot.agentConfig).toBeNull();
    expect(snapshot.agentCognition).toMatchObject({
      schema: "present",
      cognitionGraph: null,
      cognitionSource: null,
    });
    expect(snapshot.agentCognition.revision).toEqual(expect.any(String));
  });

  test("projects frozen provider through the first Agentic event and elapsed-zero recovery polls", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const firstStarted = Promise.withResolvers<Record<string, unknown>>();
    const unsubscribe = eventBus.on(EventType.GENERATION_STARTED, (message) => {
      if (message.payload?.chatId === AGENTIC_CHAT_ID) {
        firstStarted.resolve(message.payload as Record<string, unknown>);
      }
    });
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      new AbortController().signal,
    );
    const before = AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsByUser[USER_ID] ?? 0;
    const providerRequestsBefore = providerRequests.length;
    const execution = await deps.createExecution!({
      executionId: "exec-normal-1",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal: new AbortController().signal,
    });
    try {
      const startedPayload = await firstStarted.promise;
      expect(startedPayload).toMatchObject({
        generationId: "exec-normal-1",
        chatId: AGENTIC_CHAT_ID,
        generationType: "normal",
        provider: "scripted-coordinator",
        model: "scripted-model",
      });
      expect(providerRequests).toHaveLength(providerRequestsBefore);
      expect(AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsByUser[USER_ID] ?? 0).toBe(before + 1);
      expect(getPoolEntry("exec-normal-1")).toMatchObject({
        generationId: "exec-normal-1",
        chatId: AGENTIC_CHAT_ID,
        status: "assembling",
        provider: "scripted-coordinator",
        model: "scripted-model",
      });

      const pollingApp = new Hono<{ Variables: { userId: string } }>();
      pollingApp.use("*", async (c, next) => {
        c.set("userId", USER_ID);
        await next();
      });
      pollingApp.route("/generate", generateRoutes);
      const [statusResponse, activeResponse] = await Promise.all([
        pollingApp.request(`http://localhost/generate/status/${AGENTIC_CHAT_ID}`),
        pollingApp.request("http://localhost/generate/active"),
      ]);
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({
        active: true,
        generationId: "exec-normal-1",
        status: "assembling",
        provider: "scripted-coordinator",
        model: "scripted-model",
      });
      expect(activeResponse.status).toBe(200);
      expect(await activeResponse.json()).toContainEqual(expect.objectContaining({
        generationId: "exec-normal-1",
        chatId: AGENTIC_CHAT_ID,
        status: "assembling",
        provider: "scripted-coordinator",
        model: "scripted-model",
      }));

      const persistentWorkspace = getDb().query(
        "SELECT workspace_id, revision FROM persistent_workspaces WHERE user_id = ? AND chat_id = ?",
      ).get(USER_ID, AGENTIC_CHAT_ID) as { workspace_id: string; revision: number } | null;
      const linkedInspection = getAgentRunInspection(USER_ID, execution.id, AGENTIC_CHAT_ID);
      const linkedAssociation = linkedInspection?.workspaceAssociations.find(({ relation }) => relation === "linked");
      expect(persistentWorkspace).not.toBeNull();
      expect(linkedAssociation).toMatchObject({
        id: "workspace:linked:exec-normal-1",
        version: 1,
        workspaceId: persistentWorkspace?.workspace_id,
        workspaceRevision: persistentWorkspace?.revision,
        relation: "linked",
        objectKind: "objective",
        objectId: null,
        sourceRevision: persistentWorkspace?.revision,
        sourceDeleted: false,
        provenanceDigest: null,
      });
      const runtimeWorkspace = getDb().query(
        "SELECT workspace_id FROM agent_turn_workspaces WHERE turn_id = ? AND user_id = ? AND chat_id = ?",
      ).get(execution.id, USER_ID, AGENTIC_CHAT_ID) as { workspace_id: string } | null;
      expect(runtimeWorkspace).toEqual({ workspace_id: `workspace:${execution.id}` });
      expect(linkedAssociation?.workspaceId).not.toBe(runtimeWorkspace?.workspace_id);
    } finally {
      unsubscribe();
      deps.cleanup!({ execution } as never);
    }
    expect(AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsByUser[USER_ID] ?? 0).toBe(before);
  });

  test("terminalizes the host-owned persistent session after its source chat is deleted", async () => {
    const db = getDb();
    const chatId = `chat-coordinator-detached-${Date.now()}`;
    const now = Date.now();
    db.query(
      "INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(chatId, USER_ID, "character-coordinator", "Detached Coordinator Chat", now, now, "{}", ADMITTED_TARGET_REVISION);
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      signal,
    );
    const executionId = `exec-persistent-detached-${Date.now()}`;
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId,
      target,
      decision,
      signal,
    });
    try {
      db.run("PRAGMA foreign_keys = ON");
      try {
        expect(deleteChat(USER_ID, chatId)).toBe(true);
      } finally {
        db.run("PRAGMA foreign_keys = OFF");
      }
      transitionTurnExecution({
        executionId,
        ownerToken: execution.ownerToken!,
        expectedPhase: execution.phase!,
        nextPhase: "CANCELLED",
        reason: "agentic_cancelled",
      });
      deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId,
        status: "cancelled",
        phase: "CANCELLED",
        target,
        errorCode: "agentic_cancelled",
      });
      const session = db.query(
        "SELECT chat_id, phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, executionId) as {
        chat_id: string | null;
        phase: string;
        status: string;
        outcome: string | null;
      } | null;
      expect(session).toEqual({
        chat_id: null,
        phase: "TERMINAL",
        status: "terminal",
        outcome: "stopped",
      });
    } finally {
      deps.cleanup!({
        execution,
        phase: "CANCELLED",
        status: "cancelled",
      } as never);
    }
  });
  test("restart recovery converges the persistent session after a transient terminal transaction failure", async () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      new AbortController().signal,
    );
    const executionId = `exec-persistent-recovery-${Date.now()}`;
    const gate = `agentic_terminal_recovery_gate_${Date.now()}`;
    const trigger = `agentic_terminal_recovery_trigger_${Date.now()}`;
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal: new AbortController().signal,
    });
    db.run(`CREATE TABLE ${gate} (blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)))`);
    db.query(`INSERT INTO ${gate} (blocked) VALUES (?)`).run(1);
    db.run(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE ON persistent_workspace_turn_sessions
      WHEN (SELECT blocked FROM ${gate} LIMIT 1) = 1
      BEGIN
        SELECT RAISE(ABORT, 'transient persistent session failure');
      END
    `);
    try {
      transitionTurnExecution({
        executionId,
        ownerToken: execution.ownerToken!,
        expectedPhase: execution.phase!,
        nextPhase: "FAILED",
        reason: "agentic_internal_error",
      });
      expect(() => deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "failed",
        phase: "FAILED",
        target,
        errorCode: "agentic_internal_error",
      })).toThrow();
      deps.cleanup!({ execution, phase: "FAILED", status: "failed" } as never);
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?",
      ).get(executionId, USER_ID)).toMatchObject({
        phase: "ADMIT",
        status: "pending",
        outcome: null,
      });
      db.query(`UPDATE ${gate} SET blocked = 0`).run();
      __testing.resetInstallation();
      installAgenticGenerationCoordinator();
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?",
      ).get(executionId, USER_ID)).toMatchObject({
        phase: "TERMINAL",
        status: "terminal",
        outcome: "failed",
      });
    } finally {
      db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
      db.run(`DROP TABLE IF EXISTS ${gate}`);
    }
  });


  test("terminalizes the persistent admission session when workspace creation fails", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      signal,
    );
    const executionId = `exec-persistent-admission-failure-${Date.now()}`;
    getDb().run(`
      CREATE TRIGGER reject_agentic_workspace_admission
      BEFORE INSERT ON agent_turn_workspaces
      BEGIN
        SELECT RAISE(ABORT, 'workspace admission rejected');
      END
    `);
    try {
      await expect(deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      })).rejects.toThrow();
    } finally {
      getDb().run("DROP TRIGGER reject_agentic_workspace_admission");
    }
    try {
      const before = getDb().query(
        "SELECT phase, status, outcome, revision FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ? AND chat_id = ?",
      ).get(executionId, USER_ID, AGENTIC_CHAT_ID);
      expect(before).toMatchObject({ phase: "ADMIT", status: "pending", outcome: null, revision: 0 });
      deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "failed",
        phase: "FAILED",
        target,
        errorCode: "agentic_internal_error",
      });
      expect(getDb().query(
        "SELECT phase, status, outcome, revision FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ? AND chat_id = ?",
      ).get(executionId, USER_ID, AGENTIC_CHAT_ID)).toMatchObject({
        phase: "TERMINAL",
        status: "terminal",
        outcome: "failed",
        revision: 1,
      });
      const inspection = getAgentRunInspection(USER_ID, executionId, AGENTIC_CHAT_ID);
      expect(inspection).toMatchObject({ status: "terminal", outcome: "failed" });
      expect(inspection?.workspaceAssociations).toHaveLength(1);
      expect(inspection?.workspaceAssociations[0]).toMatchObject({
        id: "workspace:linked:" + executionId,
        relation: "linked",
      });
      expect(getAgentRun(USER_ID, executionId, AGENTIC_CHAT_ID)).toMatchObject({
        workStatus: "terminal",
        workOutcome: "failed",
      });
    } finally {
      deps.cleanup!({ executionId, phase: "FAILED", status: "failed" } as never);
      getDb().query("DELETE FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?")
        .run(executionId, USER_ID);
      getDb().query("DELETE FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?")
        .run(USER_ID, executionId);
      getDb().query("DELETE FROM agent_turn_executions WHERE user_id = ? AND id = ?")
        .run(USER_ID, executionId);
    }
  });
  test("records a failed persistent session when admission is aborted by a timeout", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const controller = new AbortController();
    controller.abort(new DOMException("Agentic root deadline", "TimeoutError"));
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      controller.signal,
    );
    const executionId = `exec-persistent-admission-timeout-${Date.now()}`;
    getDb().run(`
      CREATE TRIGGER reject_agentic_timeout_workspace_admission
      BEFORE INSERT ON agent_turn_workspaces
      BEGIN
        SELECT RAISE(ABORT, 'workspace admission rejected after timeout');
      END
    `);
    try {
      await expect(deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal: controller.signal,
      })).rejects.toThrow();
    } finally {
      getDb().run("DROP TRIGGER reject_agentic_timeout_workspace_admission");
    }
    try {
      expect(getDb().query(
        "SELECT phase, status, outcome, revision FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?",
      ).get(executionId, USER_ID)).toMatchObject({ phase: "ADMIT", status: "pending", outcome: null, revision: 0 });
      deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "timed_out",
        phase: "TIMED_OUT",
        target,
        errorCode: "agentic_timed_out",
      });
      expect(getDb().query(
        "SELECT phase, status, outcome, revision FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?",
      ).get(executionId, USER_ID)).toMatchObject({
        phase: "TERMINAL",
        status: "terminal",
        outcome: "failed",
        revision: 1,
      });
      expect(getAgentRunInspection(USER_ID, executionId, AGENTIC_CHAT_ID)).toMatchObject({
        status: "terminal",
        outcome: "failed",
        reason: "deadline",
      });
      const run = getAgentRun(USER_ID, executionId, AGENTIC_CHAT_ID);
      expect(run).toMatchObject({
        workStatus: "terminal",
        workOutcome: "failed",
      });
      expect(run?.error?.code).not.toBe("projection_unavailable");
    } finally {
      deps.cleanup!({ executionId, phase: "TIMED_OUT", status: "timed_out" } as never);
      getDb().query("DELETE FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?")
        .run(executionId, USER_ID);
      getDb().query("DELETE FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?")
        .run(USER_ID, executionId);
      getDb().query("DELETE FROM agent_turn_executions WHERE user_id = ? AND id = ?")
        .run(USER_ID, executionId);
    }
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
      const activityChunks = finalRenderActivityChunksFromHostLimitsV1(
        getAgentRuntimeHostLimits().activityEvents,
      );
      const envelope = calculateFinalRenderReservationEnvelopeV1({
        activityChunks,
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
        activityChunks,
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
  test("production installer persists one canonical COMMIT chronology through a live Agentic turn and recovered inspection", async () => {
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
    const persistentWorkspace = db.query(
      "SELECT workspace_id, revision FROM persistent_workspaces WHERE user_id = ? AND chat_id = ?",
    ).get(USER_ID, AGENTIC_CHAT_ID) as { workspace_id: string; revision: number } | null;
    const workspaceInspection = getAgentRunInspection(USER_ID, started.generationId, AGENTIC_CHAT_ID);
    const workspaceAssociations = (workspaceInspection?.workspaceAssociations ?? []).map((association) => ({
      id: association.id,
      relation: association.relation,
      workspaceId: association.workspaceId,
      workspaceRevision: association.workspaceRevision,
    }));
    expect(persistentWorkspace).not.toBeNull();
    expect(workspaceAssociations).toHaveLength(3);
    const linkedAssociation = workspaceAssociations.find(({ id }) => id === `workspace:linked:${started.generationId}`);
    const publicationAssociation = workspaceAssociations.find(({ id }) => id === `workspace:publication:${started.generationId}`);
    expect(linkedAssociation).toMatchObject({
      id: `workspace:linked:${started.generationId}`,
      relation: "linked",
      workspaceId: persistentWorkspace?.workspace_id,
    });
    expect(publicationAssociation).toMatchObject({
      id: `workspace:publication:${started.generationId}`,
      relation: "published",
      workspaceId: persistentWorkspace?.workspace_id,
      workspaceRevision: persistentWorkspace?.revision,
    });
    const runtimeWorkspace = db.query(
      "SELECT workspace_id, revision FROM agent_turn_workspaces WHERE turn_id = ? AND user_id = ? AND chat_id = ?",
    ).get(started.generationId, USER_ID, AGENTIC_CHAT_ID) as { workspace_id: string; revision: number } | null;
    expect(runtimeWorkspace).not.toBeNull();
    const workAssociation = workspaceAssociations.find(({ id }) =>
      id === `workspace:work:${started.generationId}:${persistentWorkspace?.revision}`,
    );
    expect(workAssociation).toMatchObject({
      id: `workspace:work:${started.generationId}:${persistentWorkspace?.revision}`,
      relation: "linked",
      workspaceId: persistentWorkspace?.workspace_id,
      workspaceRevision: persistentWorkspace?.revision,
    });
    expect(workspaceAssociations.every(({ workspaceId }) =>
      workspaceId === persistentWorkspace?.workspace_id
      && workspaceId !== `workspace:${started.generationId}`,
    )).toBe(true);
    const commitMilestoneId = `phase:${started.generationId}:COMMIT`;
    const prepareMilestoneId = `phase:${started.generationId}:PREPARE_COMMIT`;
    const renderMilestoneId = `phase:${started.generationId}:RENDER`;
    const completionMilestoneId = `phase:${started.generationId}:COMPLETE`;
    const liveChronology = workspaceInspection?.transcript ?? [];
    const liveCompletionMilestone = liveChronology.find(({ id }) => id === completionMilestoneId);
    const liveRenderMilestone = liveChronology.find(({ id }) => id === renderMilestoneId);
    const livePrepareMilestone = liveChronology.find(({ id }) => id === prepareMilestoneId);
    const liveCommitMilestones = liveChronology.filter(({ id }) => id === commitMilestoneId);
    expect(liveCompletionMilestone?.correlation.phase).toBe("PREPARE_COMMIT");
    expect(liveRenderMilestone?.correlation.phase).toBe("RENDER");
    expect(livePrepareMilestone?.correlation.phase).toBe("COMMIT");
    expect(liveRenderMilestone!.correlation.hostSequence).toBeGreaterThan(
      liveCompletionMilestone!.correlation.hostSequence,
    );
    expect(livePrepareMilestone!.correlation.hostSequence).toBeGreaterThan(
      liveRenderMilestone!.correlation.hostSequence,
    );
    expect(liveCommitMilestones).toHaveLength(1);
    expect(liveCommitMilestones[0]?.correlation.phase).toBe("COMMIT");
    expect(liveCommitMilestones[0]!.correlation.hostSequence).toBeGreaterThan(
      livePrepareMilestone!.correlation.hostSequence,
    );
    expect(liveChronology.at(-1)?.id).toBe(commitMilestoneId);

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
    __testing.resetInstallation();
    installAgenticGenerationCoordinator();
    const recoveredInspection = getAgentRunInspection(USER_ID, started.generationId, AGENTIC_CHAT_ID);
    const recoveredChronology = recoveredInspection?.transcript ?? [];
    const recoveredCompletionMilestone = recoveredChronology.find(({ id }) => id === completionMilestoneId);
    const recoveredRenderMilestone = recoveredChronology.find(({ id }) => id === renderMilestoneId);
    const recoveredPrepareMilestone = recoveredChronology.find(({ id }) => id === prepareMilestoneId);
    const recoveredCommitMilestones = recoveredChronology.filter(({ id }) => id === commitMilestoneId);
    expect(recoveredCompletionMilestone?.correlation.phase).toBe("PREPARE_COMMIT");
    expect(recoveredRenderMilestone?.correlation.phase).toBe("RENDER");
    expect(recoveredRenderMilestone!.correlation.hostSequence).toBeGreaterThan(
      recoveredCompletionMilestone!.correlation.hostSequence,
    );
    expect(recoveredPrepareMilestone!.correlation.hostSequence).toBeGreaterThan(
      recoveredRenderMilestone!.correlation.hostSequence,
    );
    expect(recoveredCommitMilestones).toHaveLength(1);
    expect(recoveredCommitMilestones[0]?.correlation.phase).toBe("COMMIT");
    expect(recoveredCommitMilestones[0]!.correlation.hostSequence).toBeGreaterThan(
      recoveredPrepareMilestone!.correlation.hostSequence,
    );
    expect(recoveredChronology.at(-1)?.id).toBe(commitMilestoneId);
  });
  test("COMMITTED continued swipe emits the exact durable content after its projection", async () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    const executionId = "exec-terminal-continue-" + Date.now();
    const messageId = "message-terminal-continue-" + Date.now();
    const prefix = "durable continued prefix";
    const provisionalSuffix = " prepared suffix";
    const committedContent = prefix + provisionalSuffix;
    seedTargetMessage(messageId, AGENTIC_CHAT_ID, ADMITTED_TARGET_REVISION);
    const now = Date.now();
    db.query(
      "UPDATE messages SET content = ?, swipe_id = 1, swipes = ?, swipe_dates = ? WHERE id = ? AND chat_id = ?",
    ).run(
      prefix,
      JSON.stringify(["untouched alternative", prefix]),
      JSON.stringify([now, now]),
      messageId,
      AGENTIC_CHAT_ID,
    );
    const target = {
      generationType: "continue" as const,
      messageId,
      swipeId: 1,
      revision: ADMITTED_TARGET_REVISION,
    };
    const created = createTurnExecution({
      id: executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationId: executionId,
      target: {
        kind: "continue",
        messageId,
        swipeId: 1,
        messageIndex: 0,
        swipeCount: 2,
        chatGenerationRevision: ADMITTED_TARGET_REVISION,
        messageGenerationRevision: ADMITTED_TARGET_REVISION,
      },
      mode: "agentic",
      runtimeEpoch: 1,
      deadlineAt: Date.now() + 60_000,
      workspaceId: "workspace:" + executionId,
      rootLedger: {},
      frameCapabilities: {},
    });
    const execution = created.execution;
    const ownerToken = created.ownerToken;
    createPoolEntry({
      generationId: executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationType: "continue",
      characterName: "Coordinator",
      model: "scripted-model",
      targetMessageId: messageId,
      targetSwipeId: 1,
    });
    appendPoolContent(executionId, provisionalSuffix);
    let currentPhase = execution.phase;
    for (const nextPhase of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
      currentPhase = transitionTurnExecution({
        executionId,
        ownerToken,
        expectedPhase: currentPhase,
        nextPhase,
        ignoreCancellation: true,
      }).execution.phase;
    }
    db.query(
      "UPDATE messages SET content = ?, swipe_id = 1, swipes = ?, generation_revision = generation_revision + 1 WHERE id = ? AND chat_id = ?",
    ).run(
      committedContent,
      JSON.stringify(["untouched alternative", committedContent]),
      messageId,
      AGENTIC_CHAT_ID,
    );
    finalizeTurnCommit({
      executionId,
      ownerToken,
      receiptId: "receipt:" + executionId,
      messageId,
      swipeId: 1,
      summary: { source: "continued-swipe-terminal-test" },
    });

    const order: string[] = [];
    const ended = Promise.withResolvers<Record<string, unknown>>();
    const removeProjection = eventBus.onInternal(EventType.AGENT_RUN_CHANGED, (event) => {
      const payload = event.payload as { readonly run?: { readonly turnId?: unknown } } | undefined;
      if (payload?.run?.turnId === executionId) order.push("projection");
    });
    const removeTerminal = eventBus.on(EventType.GENERATION_ENDED, (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload?.generationId !== executionId) return;
      order.push("terminal");
      ended.resolve(payload);
    });
    const timeout = setTimeout(() => ended.reject(new Error("continued-swipe terminal event missing")), 2_000);
    try {
      deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "completed",
        phase: "COMMITTED",
        target,
      });
      const payload = await ended.promise;
      expect(payload).toMatchObject({
        generationId: executionId,
        chatId: AGENTIC_CHAT_ID,
        messageId,
        targetMessageId: messageId,
        targetSwipeId: 1,
        content: committedContent,
        phase: "COMMITTED",
        status: "COMMITTED",
      });
      expect(payload.content).not.toBe(provisionalSuffix);
      expect(order).toEqual(["projection", "terminal"]);
      expect(getPoolEntry(executionId)).toMatchObject({
        status: "completed",
        content: provisionalSuffix,
        completedMessageId: messageId,
        targetMessageId: messageId,
        targetSwipeId: 1,
      });
      const durable = db.query(
        "SELECT content, swipe_id, swipes FROM messages WHERE id = ? AND chat_id = ?",
      ).get(messageId, AGENTIC_CHAT_ID) as { content: string; swipe_id: number; swipes: string } | null;
      expect(durable).not.toBeNull();
      expect(durable?.content).toBe(committedContent);
      expect(durable?.swipe_id).toBe(1);
      expect(JSON.parse(durable?.swipes ?? "[]")).toEqual(["untouched alternative", committedContent]);
    } finally {
      clearTimeout(timeout);
      removeProjection();
      removeTerminal();
      deps.cleanup!({ execution, phase: "COMMITTED", status: "completed" } as never);
      removePoolEntry(executionId);
    }
  });
  test("COMMITTED terminal fails closed when the receipt swipe cannot resolve", () => {
    const deps = __testing.buildDependencies();
    const executionId = "exec-terminal-invalid-swipe-" + Date.now();
    const messageId = "message-terminal-invalid-swipe-" + Date.now();
    seedTargetMessage(messageId, AGENTIC_CHAT_ID, ADMITTED_TARGET_REVISION);
    const created = createTurnExecution({
      id: executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationId: executionId,
      target: {
        kind: "continue",
        messageId,
        swipeId: 9,
        messageIndex: 0,
        swipeCount: 10,
        chatGenerationRevision: ADMITTED_TARGET_REVISION,
        messageGenerationRevision: ADMITTED_TARGET_REVISION,
      },
      mode: "agentic",
      runtimeEpoch: 1,
      deadlineAt: Date.now() + 60_000,
      workspaceId: "workspace:" + executionId,
      rootLedger: {},
      frameCapabilities: {},
    });
    let current = created.execution;
    for (const nextPhase of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
      current = transitionTurnExecution({
        executionId,
        ownerToken: created.ownerToken,
        expectedPhase: current.phase,
        nextPhase,
        ignoreCancellation: true,
      }).execution;
    }
    finalizeTurnCommit({
      executionId,
      ownerToken: created.ownerToken,
      receiptId: "receipt:" + executionId,
      messageId,
      swipeId: 9,
      summary: { source: "invalid-terminal-swipe-test" },
    });
    createPoolEntry({
      generationId: executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationType: "continue",
      characterName: "Coordinator",
      model: "scripted-model",
      targetMessageId: messageId,
      targetSwipeId: 9,
    });
    appendPoolContent(executionId, "provisional content must not be committed");
    const ended: string[] = [];
    const removeEnded = eventBus.on(EventType.GENERATION_ENDED, (event) => {
      const payload = event.payload as { readonly generationId?: unknown } | undefined;
      if (payload?.generationId === executionId) ended.push(executionId);
    });
    try {
      expect(() => deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "completed",
        phase: "COMMITTED",
        target: { generationType: "continue", messageId, swipeId: 9 },
      })).toThrow("committed_terminal_message_integrity_failed");
      expect(ended).toEqual([]);
      expect(getPoolEntry(executionId)?.content).toBe("provisional content must not be committed");
      expect(getPoolEntry(executionId)?.status).not.toBe("completed");
    } finally {
      removeEnded();
      removePoolEntry(executionId);
    }
  });
  test("freezes custom phase instruction sources and rejects ambiguous prompt block IDs", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();

    const db = getDb();
    const originalPreset = db.query(
      "SELECT prompt_order, cache_revision FROM presets WHERE id = ? AND user_id = ?",
    ).get(AGENTIC_PRESET_ID, USER_ID) as { prompt_order: string; cache_revision: number };
    const originalConfig = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string };
    const presetRevision = 73;
    const phaseSource = {
      kind: "loom_block" as const,
      blockId: "__proto__",
      presetRevision,
      blockRevision: 1,
      promptOrder: 0,
    };
    const phaseDefinitions: AgentCustomPhaseV1[] = [{
      version: 1,
      id: "snapshot_source",
      label: "Snapshot phase",
      instructionRefs: [phaseSource],
      childInstructionSubsets: [],
      required: true,
      enter: { kind: "phase", value: "WORK" },
      exit: { kind: "phase", value: "COMPLETE" },
      capabilityRequests: [],
      repeatLimit: 0,
      nextPhaseIds: [],
    }];
    const missingPhaseSource = compileAgentRuntimePhases(phaseDefinitions, {
      source: {
        presetRevision,
        blocks: [],
      },
    });
    expect(missingPhaseSource).toMatchObject({
      status: "failed",
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "stale_source",
          phaseId: "snapshot_source",
          phaseIndex: 0,
          required: true,
          source: "revision",
          detail: "source block __proto__ revision or order is stale",
        }),
      ]),
    });
    const runtimePolicy = {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: null,
      phases: phaseDefinitions,
    };
    const blocks = [{
      id: phaseSource.blockId,
      name: "Snapshot phase",
      content: "Snapshot phase instructions.",
      role: "system",
      enabled: true,
      position: "pre_history",
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      revision: phaseSource.blockRevision,
    }];
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
    const executionId = `exec-phase-source-${Date.now()}`;
    try {
      db.query(
        "UPDATE presets SET prompt_order = ?, cache_revision = ? WHERE id = ? AND user_id = ?",
      ).run(JSON.stringify(blocks), presetRevision, AGENTIC_PRESET_ID, USER_ID);
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({ config: { runtimePolicy } }), USER_ID, AGENTIC_PRESET_ID);

      const deps = __testing.buildDependencies();
      const decision = await deps.resolveRuntime!(input, target, signal);
      const ambiguousBlocks = [{
        ...blocks[0],
        content: "Ambiguous duplicate phase instructions.",
        revision: phaseSource.blockRevision + 1,
      }, blocks[0]];
      db.query(
        "UPDATE presets SET prompt_order = ? WHERE id = ? AND user_id = ?",
      ).run(JSON.stringify(ambiguousBlocks), AGENTIC_PRESET_ID, USER_ID);
      await expect(
        deps.buildAssemblySnapshot!(input, decision, target, signal, executionId),
      ).rejects.toThrow("cognition block identity is ambiguous: __proto__");
      db.query(
        "UPDATE presets SET prompt_order = ? WHERE id = ? AND user_id = ?",
      ).run(JSON.stringify(blocks), AGENTIC_PRESET_ID, USER_ID);
      const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, executionId);
      expect(snapshot.agentCognition.cognitionSource?.blocks).toEqual([
        { blockId: phaseSource.blockId, revision: 1, promptOrder: 0 },
      ]);

      const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, executionId);
      expect(plan.customPhasePlan).toMatchObject({
        status: "ready",
        phases: [expect.objectContaining({
          id: "snapshot_source",
          sourceStatus: "verified",
          sourceIdentity: [{
            blockId: phaseSource.blockId,
            presetRevision,
            blockRevision: phaseSource.blockRevision,
            promptOrder: phaseSource.promptOrder,
          }],
        })],
      });
      const staleSource = { ...phaseSource, blockRevision: phaseSource.blockRevision + 1 };
      const optionalPhaseDefinitions: AgentCustomPhaseV1[] = [
        {
          ...phaseDefinitions[0]!,
          id: "optional_stale",
          label: "Optional stale",
          required: false,
          instructionRefs: [staleSource],
        },
        {
          ...phaseDefinitions[0]!,
          id: "optional_missing",
          label: "Optional missing",
          required: false,
          instructionRefs: [{ ...staleSource, blockId: "missing-phase-block" }],
        },
      ];
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({
        config: {
          runtimePolicy: {
            ...runtimePolicy,
            phases: optionalPhaseDefinitions,
          },
        },
      }), USER_ID, AGENTIC_PRESET_ID);
      const optionalDecision = await deps.resolveRuntime!(input, target, signal);
      const optionalSnapshot = await deps.buildAssemblySnapshot!(input, optionalDecision, target, signal, `${executionId}-optional`);
      expect(optionalSnapshot.agentCognition.cognitionSource?.blocks).toEqual([]);
      const optionalPlan = compileAgentRuntimePhases(optionalPhaseDefinitions, {
        source: optionalSnapshot.agentCognition.cognitionSource,
      });
      expect(optionalPlan).toMatchObject({
        status: "repair_required",
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "optional_phase_omitted", phaseId: "optional_stale", required: false }),
          expect.objectContaining({ code: "optional_phase_omitted", phaseId: "optional_missing", required: false }),
        ]),
      });

      const requiredPhaseDefinitions: AgentCustomPhaseV1[] = [
        {
          ...phaseDefinitions[0]!,
          id: "required_stale",
          label: "Required stale",
          required: true,
          instructionRefs: [staleSource],
        },
        {
          ...phaseDefinitions[0]!,
          id: "required_missing",
          label: "Required missing",
          required: true,
          instructionRefs: [{ ...staleSource, blockId: "missing-required-phase-block" }],
        },
      ];
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({
        config: {
          runtimePolicy: {
            ...runtimePolicy,
            phases: requiredPhaseDefinitions,
          },
        },
      }), USER_ID, AGENTIC_PRESET_ID);
      const requiredDecision = await deps.resolveRuntime!(input, target, signal);
      const requiredSnapshot = await deps.buildAssemblySnapshot!(input, requiredDecision, target, signal, `${executionId}-required`);
      expect(requiredSnapshot.agentCognition.cognitionSource?.blocks).toEqual([]);
      const requiredPlan = compileAgentRuntimePhases(requiredPhaseDefinitions, {
        source: requiredSnapshot.agentCognition.cognitionSource,
      });
      expect(requiredPlan).toMatchObject({
        status: "failed",
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "stale_source", phaseId: "required_stale", required: true }),
          expect.objectContaining({ code: "stale_source", phaseId: "required_missing", required: true }),
        ]),
      });
    } finally {
      db.query(
        "UPDATE presets SET prompt_order = ?, cache_revision = ? WHERE id = ? AND user_id = ?",
      ).run(originalPreset.prompt_order, originalPreset.cache_revision, AGENTIC_PRESET_ID, USER_ID);
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, USER_ID, AGENTIC_PRESET_ID);
    }
  });
  test("WORK and RENDER deliver resolved direct Loom policy and omit false conditions", async () => {
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
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string };
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
    const rawRenderPolicyText = "Render policy for {{char}}.";
    const resolvedRenderPolicyText = "Render policy for Coordinator Character.";
    const renderSource = {
      kind: "loom_block" as const,
      blockId: "render-macro-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 2,
    };
    const renderConditionSentinel = "RENDER_CONDITION_FALSE_MUST_NOT_REACH_PROVIDER";
    const renderConditionSource = {
      kind: "loom_block" as const,
      blockId: "render-condition-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 3,
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
        }, {
          version: 1,
          id: "condition-policy-entry",
          source: conditionSource,
          destination: "root_work",
          checkpoint: "WORK",
          required: false,
          visibility: "work_only",
          condition: {
            kind: "preset_variable",
            name: "gate",
            operator: "equals",
            value: "open",
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
        }, {
          version: 1,
          id: "render-condition-policy-entry",
          source: renderConditionSource,
          destination: "render",
          checkpoint: "RENDER",
          required: false,
          visibility: "work_only",
          condition: {
            kind: "preset_variable",
            name: "gate",
            operator: "equals",
            value: "open",
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
      }]), presetRevision, AGENTIC_PRESET_ID, USER_ID);
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({ config: { runtimePolicy } }), USER_ID, AGENTIC_PRESET_ID);

      const decision = await deps.resolveRuntime!(input, target, signal);
      const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, executionId);
      const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, executionId);
      expect(snapshot.blocks.find((block) => block.id === source.blockId)?.content).toBe(rawPolicyText);
      expect(plan.loomBlocks.find((block) => block.source.blockId === source.blockId)?.content).toBe(resolvedPolicyText);

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
        });
        expect(work).toMatchObject({ status: "completed" });
        const ordinaryRequests = providerRequests.filter((request) => request.toolMode === "ordinary");
        const ordinaryPayload = JSON.stringify(ordinaryRequests);
        expect(ordinaryPayload).toContain(resolvedPolicyText);
        expect(ordinaryPayload).not.toContain(rawPolicyText);
        expect(ordinaryPayload).not.toContain(conditionSentinel);

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
        expect(finalizationRequests).toHaveLength(1);
      } finally {
        deps.cleanup!({ execution } as never);
      }
    } finally {
      db.query(
        "UPDATE presets SET prompt_order = ?, cache_revision = ? WHERE id = ? AND user_id = ?",
      ).run(originalPreset.prompt_order, originalPreset.cache_revision, AGENTIC_PRESET_ID, USER_ID);
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, USER_ID, AGENTIC_PRESET_ID);
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
  test("production work adapter preserves exact delegated child workspace grants", async () => {
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
    const writeProfileRuntime = getDb().query(
      "UPDATE preset_agent_profiles SET workspace_capabilities = ?, max_output_tokens = ? WHERE user_id = ? AND preset_id = ? AND profile_id = ?",
    );
    writeProfileRuntime.run(
      JSON.stringify(["update_assigned_progress", "submit_child_result"]),
      1024,
      USER_ID,
      AGENTIC_PRESET_ID,
      "delegate",
    );
    writeProfileRuntime.run(JSON.stringify([]), 1024, USER_ID, AGENTIC_PRESET_ID, "delegate_alt");
    const decision = await deps.resolveRuntime!(input, target, signal);
    const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, "test-delegate");
    const config = snapshot.agentConfig as {
      readonly profiles?: readonly Record<string, unknown>[];
    } | null;
    if (!config || !Array.isArray(config.profiles)) throw new Error("Agentic profile config was not snapshotted");
    expect(config.profiles.find((profile) => profile.id === "delegate")).toMatchObject({
      workspaceCapabilities: ["update_assigned_progress", "submit_child_result"],
      maxOutputTokens: 1024,
    });
    expect(config.profiles.find((profile) => profile.id === "delegate_alt")).toMatchObject({
      workspaceCapabilities: [],
      maxOutputTokens: 1024,
    });
    const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, "test-delegate");
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
        snapshot,
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
      expect(childRequest?.tools
        ?.filter((tool) => tool.name.startsWith("workspace_"))
        .map((tool) => tool.name)).toEqual([
        "workspace_update_assigned_progress",
        "workspace_submit_child_result",
      ]);
      expect(childRequest?.parameters?.max_tokens).toBe(1024);
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
      const inspection = getAgentRunInspection(USER_ID, execution.id, AGENTIC_CHAT_ID);
      const frozenDelegate = (decision.internal as {
        readonly childConnections?: Readonly<Record<string, {
          readonly concreteId?: string | null;
          readonly candidateRevision?: string | number | null;
          readonly fingerprint?: string | null;
        }>>;
      }).childConnections?.delegate;
      const childExchanges = inspection?.transcript.filter((record) =>
        record.kind === "provider_exchange" && record.recipient === "child") ?? [];
      expect(childExchanges.length).toBeGreaterThanOrEqual(1);
      for (const exchange of childExchanges) {
        expect(exchange.correlation.taskId).toBe("task-delegate");
        expect(exchange.provider).toEqual({
          adapter: "agentic-work",
          providerId: "scripted-coordinator",
          modelId: "scripted-model",
          connectionId: frozenDelegate?.concreteId ?? null,
          configRevision: ADMITTED_CONFIG_REVISION,
          connectionRevision: frozenDelegate?.candidateRevision ?? null,
          fingerprint: frozenDelegate?.fingerprint ?? null,
        });
        expect(JSON.parse(exchange.arguments ?? "{}")).toMatchObject({
          profileId: "delegate",
          connectionId: frozenDelegate?.concreteId,
          configRevision: ADMITTED_CONFIG_REVISION,
          sourceFingerprint: frozenDelegate?.fingerprint,
        });
      }
      const correlatedDelegation = inspection?.transcript.filter((record) => record.kind === "delegation") ?? [];
      expect(correlatedDelegation.length).toBeGreaterThanOrEqual(2);
      expect(correlatedDelegation.every((record) => record.correlation.taskId === "task-delegate")).toBe(true);
      const childLifecycle = inspection?.transcript.filter((record) =>
        record.kind === "child_result") ?? [];
      expect(childLifecycle.length).toBeGreaterThanOrEqual(1);
      expect(childLifecycle.every((record) => record.correlation.taskId === "task-delegate")).toBe(true);
      expect(inspection?.activity.milestones.some((node) =>
        node.id === "projection:task:task-delegate" && node.actor === "child")).toBe(true);
      expect(inspection?.activity.milestones.some((node) =>
        node.id === "projection:" + expectedChildFrameId || node.id === "projection:" + expectedDelegateFrameId)).toBe(false);
      scriptedTaskCreated = false;
      delegateIssued = false;
      scriptedAcceptanceIssued = false;
      scriptedChildSubmitted = false;
      scriptedDelegateProfileId = "delegate_alt";
      scriptedWorkRound = 0;
      providerRequests.length = 0;
      const emptyExecution = await deps.createExecution!({
        executionId: `exec-delegate-empty-${Date.now()}`,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });
      try {
        const emptyWork = await deps.runWork!({
          execution: emptyExecution,
          input,
          decision,
          snapshot,
          plan,
          signal,
        });
        expect(emptyWork).toMatchObject({
          status: "failed",
          errorCode: "child_schedule_invalid",
        });
        const emptyChildRequest = providerRequests.find((request) =>
          request.toolMode === "ordinary"
          && typeof request.messages[0]?.content === "string"
          && request.messages[0].content.includes("Assigned workspace task ID: task-delegate."),
        );
        expect(emptyChildRequest).toBeUndefined();
      } finally {
        deps.cleanup!({ execution: emptyExecution } as never);
      }
    } finally {
      deps.cleanup!({ execution } as never);
      scriptedDelegate = false;
      scriptedTaskCreated = false;
      delegateIssued = false;
      scriptedAcceptSubmission = false;
      scriptedAcceptanceIssued = false;
      scriptedChildSubmitted = false;
      scriptedWorkRound = 0;
      scriptedDelegateProfileId = "delegate";
      writeProfileRuntime.run(JSON.stringify([]), 512, USER_ID, AGENTIC_PRESET_ID, "delegate");
      writeProfileRuntime.run(JSON.stringify([]), 128, USER_ID, AGENTIC_PRESET_ID, "delegate_alt");
    }
  });
  test("keeps heterogeneous child provider, connection, model, tokenizer, usage, activity, and inspection identity exact", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    const db = getDb();
    const now = Date.now();
    const childConnectionIds = ["connection-child-a", "connection-child-b"] as const;
    const originalBindings = db.query(
      "SELECT slot_id, connection_id FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? AND slot_id IN ('delegate', 'delegate_alt') ORDER BY slot_id",
    ).all(USER_ID, AGENTIC_PRESET_ID) as Array<{ slot_id: string; connection_id: string }>;
    const originalProfiles = db.query(
      "SELECT profile_id, workspace_capabilities, max_output_tokens FROM preset_agent_profiles WHERE user_id = ? AND preset_id = ? AND profile_id IN ('delegate', 'delegate_alt') ORDER BY profile_id",
    ).all(USER_ID, AGENTIC_PRESET_ID) as Array<{
      profile_id: string;
      workspace_capabilities: string;
      max_output_tokens: number;
    }>;
    db.query(
      "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, '{}', ?, ?)",
    ).run(childConnectionIds[0], USER_ID, "Child A", "scripted-child-a", "https://child-a.invalid/v1", "child-model-a", now, now);
    db.query(
      "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, '{}', ?, ?)",
    ).run(childConnectionIds[1], USER_ID, "Child B", "scripted-child-b", "https://child-b.invalid/v1", "child-model-b", now + 1, now + 1);
    db.query(
      "UPDATE preset_agent_slot_bindings SET connection_id = ?, updated_at = ? WHERE user_id = ? AND preset_id = ? AND slot_id = 'delegate'",
    ).run(childConnectionIds[0], now, USER_ID, AGENTIC_PRESET_ID);
    db.query(
      "UPDATE preset_agent_slot_bindings SET connection_id = ?, updated_at = ? WHERE user_id = ? AND preset_id = ? AND slot_id = 'delegate_alt'",
    ).run(childConnectionIds[1], now + 1, USER_ID, AGENTIC_PRESET_ID);
    db.query(
      "UPDATE preset_agent_profiles SET workspace_capabilities = ?, max_output_tokens = 1024 WHERE user_id = ? AND preset_id = ? AND profile_id IN ('delegate', 'delegate_alt')",
    ).run(JSON.stringify(["update_assigned_progress", "submit_child_result"]), USER_ID, AGENTIC_PRESET_ID);

    const tokenizerModels: string[] = [];
    const resolveCounter = tokenizerService.resolveCounter;
    const tokenizerSpy = spyOn(tokenizerService, "resolveCounter").mockImplementation(async (model) => {
      tokenizerModels.push(model);
      return resolveCounter(model);
    });
    const expectedByProfile = {
      delegate: {
        provider: "scripted-child-a",
        connectionId: childConnectionIds[0],
        endpoint: "https://child-a.invalid/v1",
        model: "child-model-a",
        totalTokens: 24,
      },
      delegate_alt: {
        provider: "scripted-child-b",
        connectionId: childConnectionIds[1],
        endpoint: "https://child-b.invalid/v1",
        model: "child-model-b",
        totalTokens: 36,
      },
    } as const;
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
    try {
      const decision = await deps.resolveRuntime!(input, target, signal);
      const internal = decision.internal as {
        readonly childConnections?: Readonly<Record<string, {
          readonly concreteId?: string;
          readonly provider?: string;
          readonly effectiveEndpoint?: string;
          readonly model?: string | null;
          readonly candidateRevision?: string | number;
          readonly fingerprint?: string | null;
        }>>;
      };
      const childConnections = internal.childConnections;
      if (!childConnections) throw new Error("Child connections were not frozen");
      expect({
        concreteId: childConnections.delegate?.concreteId,
        provider: childConnections.delegate?.provider,
        endpoint: childConnections.delegate?.effectiveEndpoint,
        model: childConnections.delegate?.model,
      }).toEqual({
        concreteId: childConnectionIds[0],
        provider: expectedByProfile.delegate.provider,
        endpoint: expectedByProfile.delegate.endpoint,
        model: expectedByProfile.delegate.model,
      });
      expect({
        concreteId: childConnections.delegate_alt?.concreteId,
        provider: childConnections.delegate_alt?.provider,
        endpoint: childConnections.delegate_alt?.effectiveEndpoint,
        model: childConnections.delegate_alt?.model,
      }).toEqual({
        concreteId: childConnectionIds[1],
        provider: expectedByProfile.delegate_alt.provider,
        endpoint: expectedByProfile.delegate_alt.endpoint,
        model: expectedByProfile.delegate_alt.model,
      });
      const baseSnapshot = await deps.buildAssemblySnapshot!(
        input,
        decision,
        target,
        signal,
        "test-heterogeneous-children",
      );
      const scheduledBlocks = [
        {
          id: "heterogeneous-child-a",
          name: "Heterogeneous child A",
          content: "{{agent::delegate::as=heterogeneous_child_a_result}}child a{{/agent}}",
          role: "user" as const,
          enabled: true,
          position: "pre_history" as const,
          depth: 0,
          marker: null,
          isLocked: false,
          color: null,
          injectionTrigger: [],
          group: null,
          sealed: false,
          order: baseSnapshot.blocks.length,
          revision: "1",
        },
        {
          id: "heterogeneous-child-b",
          name: "Heterogeneous child B",
          content: "{{agent::delegate_alt::as=heterogeneous_child_b_result}}child b{{/agent}}",
          role: "user" as const,
          enabled: true,
          position: "pre_history" as const,
          depth: 0,
          marker: null,
          isLocked: false,
          color: null,
          injectionTrigger: [],
          group: null,
          sealed: false,
          order: baseSnapshot.blocks.length + 1,
          revision: "1",
        },
      ] as const;
      const snapshotCandidate = {
        ...baseSnapshot,
        snapshotId: "",
        generationId: "test-heterogeneous-children",
        blocks: [...baseSnapshot.blocks, ...scheduledBlocks],
      };
      const {
        snapshotId: _snapshotId,
        inputRevisionSet: _inputRevisionSet,
        revisions: _revisions,
        ...snapshotBase
      } = snapshotCandidate;
      const snapshot = {
        ...snapshotCandidate,
        snapshotId: createHash("sha256")
          .update(encodeCanonicalPlainData({ base: snapshotBase, revisions: snapshotCandidate.revisions }), "utf8")
          .digest("hex"),
      } as typeof baseSnapshot;
      const plan = await compileAgentAssemblyPlan(snapshot);
      expect(plan.children.map((child) => child.profileId)).toEqual(["delegate", "delegate_alt"]);

      scriptedDelegate = false;
      scriptedWorkRound = 0;
      boundProviderDispatches.length = 0;
      providerRequests.length = 0;
      const execution = await deps.createExecution!({
        executionId: "exec-heterogeneous-scheduled-" + Date.now(),
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });
      try {
        const work = await deps.runWork!({ execution, input, decision, snapshot, plan, signal });
        expect(work).toMatchObject({ status: "completed" });
        expect(boundProviderDispatches).toHaveLength(2);
        const inspection = getAgentRunInspection(USER_ID, execution.id, AGENTIC_CHAT_ID);
        for (const profileId of ["delegate", "delegate_alt"] as const) {
          const expected = expectedByProfile[profileId];
          const plannedChild = plan.children.find((child) => child.profileId === profileId);
          expect(plannedChild).toBeDefined();
          const dispatches = boundProviderDispatches.filter((dispatch) => dispatch.provider === expected.provider);
          expect(dispatches).toHaveLength(1);
          expect(dispatches[0]).toMatchObject({ provider: expected.provider, url: expected.endpoint });
          expect(dispatches[0]?.request.model).toBe(expected.model);
          expect(dispatches[0]?.request.model).not.toBe("scripted-model");
          expect(tokenizerModels).toContain(expected.model);

          const childExchange = inspection?.transcript.find((record) =>
            record.kind === "provider_exchange"
            && record.recipient === "child"
            && record.provider?.providerId === expected.provider);
          expect(childExchange?.provider).toEqual({
            adapter: "agentic-work",
            providerId: expected.provider,
            modelId: expected.model,
            connectionId: expected.connectionId,
            configRevision: ADMITTED_CONFIG_REVISION,
            connectionRevision: childConnections[profileId]?.candidateRevision ?? null,
            fingerprint: childConnections[profileId]?.fingerprint ?? null,
          });
          expect(childExchange?.correlation.taskId).toBe(plannedChild!.childId);
          const exchangeArguments = JSON.parse(childExchange?.arguments ?? "{}");
          expect(exchangeArguments).toMatchObject({
            profileId,
            provider: expected.provider,
            connectionId: expected.connectionId,
            model: expected.model,
            configRevision: ADMITTED_CONFIG_REVISION,
            sourceFingerprint: childConnections[profileId]?.fingerprint,
          });
          const childUsage = inspection?.usageEvidence.find((usage) =>
            usage.layer === "child"
            && usage.source === "provider_reported"
            && usage.totalTokens === expected.totalTokens);
          expect(childUsage).toMatchObject({
            inputTokens: profileId === "delegate" ? 11 : 17,
            outputTokens: profileId === "delegate" ? 13 : 19,
            totalTokens: expected.totalTokens,
            canonical: false,
          });
          expect(childUsage?.correlation?.taskId).toBe(plannedChild!.childId);
          const intrinsicLifecycle = inspection?.transcript.filter((record) =>
            record.kind === "child_result" && record.id.includes(plannedChild!.childId)) ?? [];
          expect(intrinsicLifecycle.length).toBeGreaterThanOrEqual(1);
          expect(intrinsicLifecycle.every((record) =>
            record.correlation.taskId === plannedChild!.childId)).toBe(true);
          const childActivity = inspection?.activity.milestones.find((activity) =>
            activity.actor === "child"
            && activity.id === "projection:task:" + childExchange?.correlation.taskId);
          expect(childActivity).toMatchObject({ kind: "child", actor: "child" });
        }
        expect(tokenizerModels).toContain("scripted-model");
        expect(tokenizerModels).toContain("child-model-a");
        expect(tokenizerModels).toContain("child-model-b");
      } finally {
        deps.cleanup!({ execution } as never);
      }
      const malformedDecisions = [
        {
          ...decision,
          internal: {
            ...internal,
            childConnections: { delegate: childConnections.delegate },
          },
        },
        {
          ...decision,
          internal: {
            ...internal,
            childConnections: {
              ...childConnections,
              delegate_alt: { ...childConnections.delegate_alt, model: null },
            },
          },
        },
      ] as unknown as readonly [typeof decision, typeof decision];
      for (const [index, malformedDecision] of malformedDecisions.entries()) {
        boundProviderDispatches.length = 0;
        providerRequests.length = 0;
        const execution = await deps.createExecution!({
          executionId: "exec-incomplete-child-" + index + "-" + Date.now(),
          userId: USER_ID,
          chatId: AGENTIC_CHAT_ID,
          target,
          decision,
          signal,
        });
        try {
          await expect(deps.runWork!({
            execution,
            input,
            decision: malformedDecision,
            snapshot,
            plan,
            signal,
          })).rejects.toMatchObject({ code: "decision_refresh_required", phase: "WORK" });
          expect(boundProviderDispatches).toHaveLength(0);
          expect(providerRequests).toHaveLength(0);
        } finally {
          deps.cleanup!({ execution } as never);
        }
      }
    } finally {
      tokenizerSpy.mockRestore();
      for (const binding of originalBindings) {
        db.query(
          "UPDATE preset_agent_slot_bindings SET connection_id = ?, updated_at = ? WHERE user_id = ? AND preset_id = ? AND slot_id = ?",
        ).run(binding.connection_id, Date.now(), USER_ID, AGENTIC_PRESET_ID, binding.slot_id);
      }
      for (const profile of originalProfiles) {
        db.query(
          "UPDATE preset_agent_profiles SET workspace_capabilities = ?, max_output_tokens = ? WHERE user_id = ? AND preset_id = ? AND profile_id = ?",
        ).run(profile.workspace_capabilities, profile.max_output_tokens, USER_ID, AGENTIC_PRESET_ID, profile.profile_id);
      }
      db.query("DELETE FROM connection_profiles WHERE user_id = ? AND id IN (?, ?)")
        .run(USER_ID, childConnectionIds[0], childConnectionIds[1]);
      scriptedDelegate = false;
      scriptedDelegateProfileId = "delegate";
      scriptedTaskCreated = false;
      delegateIssued = false;
      scriptedAcceptSubmission = false;
      scriptedAcceptanceIssued = false;
      scriptedChildSubmitted = false;
      scriptedWorkRound = 0;
      boundProviderDispatches.length = 0;
      providerRequests.length = 0;
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
        childInstructionSubsets: [],
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
        childInstructionSubsets: [],
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
          revision: 3,
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
        expect(completionObservations.map((observation) => observation.status)).toEqual(["success", "accepted"]);
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
    seedCommittedExecution("exec-committed-success");
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
    expect(completedPayload.content).toBe("target");
    expect(completedPayload.messageId).toBe("message:exec-committed-success");
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

    createPoolEntry({
      generationId: "exec-committed-failed",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationType: "normal",
      characterName: "Coordinator",
      model: "scripted-model",
    });
    appendPoolContent("exec-committed-failed", "provisional failure output");
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
    expect(failedPayload.error).toBe("FAILED: provider_request_error: upstream refused");
    expect(failedPayload.phase).toBe("FAILED");
    expect(failedPayload.content).toBe("provisional failure output");
    removePoolEntry("exec-committed-failed");
  });

  test("terminal inspection and projection are emitted before GENERATION_ENDED", async () => {
    const deps = __testing.buildDependencies();
    const executionId = `exec-terminal-order-${Date.now()}`;
    seedCommittedExecution(executionId);
    const order: string[] = [];
    const settled = Promise.withResolvers<void>();
    const maybeSettled = (): void => {
      if (order.length === 3) settled.resolve();
    };
    const removeProjection = eventBus.onInternal(EventType.AGENT_RUN_CHANGED, (event) => {
      const payload = event.payload as { readonly run?: { readonly turnId?: unknown } } | undefined;
      if (payload?.run?.turnId === executionId) {
        const inspection = getDb().query(
          "SELECT outcome FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
        ).get(USER_ID, executionId) as { outcome: string | null } | null;
        if (inspection?.outcome === "completed") order.push("inspection");
        order.push("projection");
        maybeSettled();
      }
    });
    const removeTerminal = eventBus.on(EventType.GENERATION_ENDED, (event) => {
      const payload = event.payload as { readonly generationId?: unknown } | undefined;
      if (payload?.generationId === executionId) {
        order.push("terminal");
        maybeSettled();
      }
    });
    try {
      deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "completed",
        phase: "COMMITTED",
        target: { generationType: "normal" },
      });
      await settled.promise;
    } finally {
      removeProjection();
      removeTerminal();
    }
    expect(order).toEqual(["inspection", "projection", "terminal"]);
  });
  test("terminal convergence rolls back every derived plane and retries without a synthetic cause", () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    const executionId = "exec-terminal-atomic-" + Date.now();
    const trigger = "agentic_projection_failure_" + Date.now();
    const ended: string[] = [];
    seedCommittedExecution(executionId);
    const removeEnded = eventBus.on(EventType.GENERATION_ENDED, (emitted) => {
      const payload = emitted.payload as { readonly generationId?: unknown } | undefined;
      if (payload?.generationId === executionId) ended.push(executionId);
    });
    const event = {
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      status: "completed" as const,
      phase: "COMMITTED" as const,
      target: { generationType: "normal" as const },
    };
    db.run(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON agent_run_projections
      BEGIN
        SELECT RAISE(ABORT, 'projection write unavailable');
      END
    `);
    try {
      expect(() => deps.publishTerminal!(event)).toThrow();
      expect(db.query(
        "SELECT status FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      expect(db.query(
        "SELECT outcome FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
      ).get(USER_ID, executionId)).not.toMatchObject({ outcome: "completed" });
      expect(ended).toEqual([]);
    } finally {
      db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
    }

    try {
      deps.publishTerminal!(event);
      const projection = db.query(
        "SELECT status, snapshot_json FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId) as { status: string; snapshot_json: string } | null;
      expect(projection?.status).toBe("COMMITTED");
      expect(JSON.parse(projection?.snapshot_json ?? "{}")).not.toHaveProperty("error.code", "projection_unavailable");
      expect(db.query(
        "SELECT status, outcome FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
      ).get(USER_ID, executionId)).toMatchObject({ status: "terminal", outcome: "completed" });
      expect(ended).toEqual([executionId]);
    } finally {
      removeEnded();
    }
  });

  test("startup reconstructs every noncommitted terminal projection after inspection or projection loss", () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    const terminalCases = [
      { suffix: "commit-failed", status: "completed", eventPhase: "COMMITTED", projectionStatus: "COMMIT_FAILED", outcome: "failed" },
      { suffix: "cancelled", status: "cancelled", eventPhase: "CANCELLED", projectionStatus: "CANCELLED", outcome: "stopped" },
      { suffix: "timed-out", status: "timed_out", eventPhase: "TIMED_OUT", projectionStatus: "TIMED_OUT", outcome: "failed" },
      { suffix: "exhausted", status: "exhausted", eventPhase: "EXHAUSTED", projectionStatus: "EXHAUSTED", outcome: "exhausted" },
      { suffix: "rejected", status: "rejected", eventPhase: "FAILED", projectionStatus: "FAILED", outcome: "rejected", errorCode: "invalid_input" },
      { suffix: "failed", status: "failed", eventPhase: "FAILED", projectionStatus: "FAILED", outcome: "failed", errorCode: "provider_request_error" },
    ] as const;
    const recoveryModes = ["inspection", "projection"] as const;
    let sequence = 0;

    for (const recoveryMode of recoveryModes) {
      for (const terminalCase of terminalCases) {
        const executionId = `exec-terminal-startup-${recoveryMode}-${terminalCase.suffix}-${Date.now()}-${sequence++}`;
        const trigger = `agentic_terminal_startup_${recoveryMode}_${sequence}`;
        const event = {
          executionId,
          userId: USER_ID,
          chatId: AGENTIC_CHAT_ID,
          status: terminalCase.status,
          phase: terminalCase.eventPhase,
          target: { generationType: "normal" as const },
          ...("errorCode" in terminalCase ? { errorCode: terminalCase.errorCode } : {}),
        } as const;
        if (recoveryMode === "inspection") {
          db.run(`
            CREATE TRIGGER ${trigger}
            BEFORE INSERT ON agent_run_attempts
            BEGIN
              SELECT RAISE(ABORT, 'terminal inspection unavailable');
            END
          `);
        } else {
          db.run(`
            CREATE TRIGGER ${trigger}
            BEFORE INSERT ON agent_run_projections
            BEGIN
              SELECT RAISE(ABORT, 'terminal projection unavailable');
            END
          `);
        }
        try {
          expect(() => deps.publishTerminal!(event)).toThrow();
        } finally {
          db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
        }

        expect(db.query(
          "SELECT status FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND turn_id = ?",
        ).get(USER_ID, AGENTIC_CHAT_ID, executionId)).toBeNull();
        const first = reconcileAgentTurns(db);
        expect(first.complete).toBe(true);
        expect(db.query(
          "SELECT state FROM agent_turn_executions WHERE user_id = ? AND id = ?",
        ).get(USER_ID, executionId)).toEqual({ state: terminalCase.projectionStatus });
        const projection = db.query(
          "SELECT status, snapshot_json FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND turn_id = ?",
        ).get(USER_ID, AGENTIC_CHAT_ID, executionId) as { status: string; snapshot_json: string } | null;
        expect(projection?.status).toBe(terminalCase.projectionStatus);
        expect(JSON.parse(projection?.snapshot_json ?? "{}")).toMatchObject({
          workPhase: "TERMINAL",
          workStatus: "terminal",
          workOutcome: terminalCase.outcome,
        });
        const inspection = getAgentRunInspection(USER_ID, executionId, AGENTIC_CHAT_ID);
        expect(inspection).toMatchObject({
          terminal: true,
          outcome: terminalCase.outcome,
        });
        const eventCount = (db.query(
          "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND event_kind = 'terminal'",
        ).get(USER_ID, AGENTIC_CHAT_ID, executionId) as { count: number }).count;
        const snapshot = projection?.snapshot_json;
        const second = reconcileAgentTurns(db);
        expect(second.complete).toBe(true);
        const replayedProjection = db.query(
          "SELECT snapshot_json FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND turn_id = ?",
        ).get(USER_ID, AGENTIC_CHAT_ID, executionId) as { snapshot_json: string } | null;
        expect(replayedProjection?.snapshot_json).toBe(snapshot);
        expect((db.query(
          "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND event_kind = 'terminal'",
        ).get(USER_ID, AGENTIC_CHAT_ID, executionId) as { count: number }).count).toBe(eventCount);
      }
    }
  });

  test("terminal inspection failure defers every derived surface and pool settlement", async () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      {
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        userInput: USER_INPUT,
      },
      target,
      signal,
    );
    const executionId = `exec-terminal-inspection-failure-${Date.now()}`;
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    const ownerToken = execution.ownerToken;
    const initialPhase = execution.phase;
    if (ownerToken === undefined || initialPhase === undefined) {
      throw new Error("coordinator test execution did not return durable ownership");
    }
    errorPool(executionId, "watchdog fired before durable terminal convergence");
    expect(getPoolEntry(executionId)?.status).not.toBe("error");
    let currentPhase = initialPhase;
    for (const nextPhase of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
      currentPhase = transitionTurnExecution({
        executionId,
        ownerToken,
        expectedPhase: currentPhase,
        nextPhase,
        ignoreCancellation: true,
      }).execution.phase;
    }
    const committedMessageId = "message:" + executionId;
    seedTargetMessage(committedMessageId, AGENTIC_CHAT_ID, 0);
    finalizeTurnCommit({
      executionId,
      ownerToken,
      receiptId: `receipt:${executionId}`,
      messageId: committedMessageId,
      swipeId: 0,
      summary: { source: "coordinator-test" },
    });
    const trigger = `agentic_terminal_inspection_failure_${Date.now()}`;
    const event = {
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      status: "completed" as const,
      phase: "COMMITTED" as const,
      target: { generationType: "normal" as const },
    };
    db.run(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE ON agent_run_attempts
      WHEN NEW.outcome = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'terminal inspection unavailable');
      END
    `);
    try {
      expect(() => deps.publishTerminal!(event)).toThrow();
      expect(db.query(
        "SELECT status, snapshot_json FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, executionId)).toMatchObject({
        phase: "ADMIT",
        status: "pending",
        outcome: null,
      });
      expect(db.query(
        "SELECT state FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(USER_ID, executionId)).toMatchObject({ state: "COMMITTED" });
      expect(db.query(
        "SELECT receipt_id FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, executionId)).toMatchObject({ receipt_id: `receipt:${executionId}` });
      errorPool(executionId, "watchdog fired after execution but before durable projections");
      expect(getPoolEntry(executionId)?.status).not.toBe("error");
    } finally {
      db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
      deps.cleanup!({
        execution,
        phase: "COMMITTED",
        status: "completed",
      } as never);
    }
    expect(db.query(
      "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
    ).get(USER_ID, executionId)).toMatchObject({
      phase: "ADMIT",
      status: "pending",
      outcome: null,
    });
    const recovery = __testing.reconcilePersistentWorkspaceSessions();
    expect(recovery.complete).toBe(true);
    expect(db.query(
      "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
    ).get(USER_ID, executionId)).toMatchObject({
      phase: "TERMINAL",
      status: "terminal",
      outcome: "completed",
    });
    expect(db.query(
      "SELECT status FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
    ).get(USER_ID, executionId)).toMatchObject({ status: "COMMITTED" });
    expect(db.query(
      "SELECT status, outcome FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
    ).get(USER_ID, executionId)).toMatchObject({ status: "terminal", outcome: "completed" });
    completePool(executionId, committedMessageId);
    expect(getPoolEntry(executionId)).toMatchObject({
      status: "completed",
      completedMessageId: committedMessageId,
    });
  });
  test("generic Stop repairs a publish fault through the exact dormant owner", async () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      signal,
    );
    const executionId = "exec-generic-stop-recovery-" + Date.now();
    const trigger = "agentic_generic_stop_projection_failure_" + Date.now();
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    if (!execution.ownerToken || !execution.phase) throw new Error("durable execution ownership unavailable");
    transitionTurnExecution({
      executionId,
      ownerToken: execution.ownerToken,
      expectedPhase: execution.phase,
      nextPhase: "FAILED",
      reason: "agentic_provider_failure",
    });
    db.run(
      "CREATE TRIGGER " + trigger + " BEFORE INSERT ON agent_run_projections " +
      "BEGIN SELECT RAISE(ABORT, 'projection write unavailable'); END",
    );
    try {
      expect(() => deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "failed",
        phase: "FAILED",
        target,
        errorCode: "agentic_provider_failure",
      })).toThrow();
    } finally {
      db.run("DROP TRIGGER IF EXISTS " + trigger);
      deps.cleanup!({ execution, executionId, phase: "FAILED", status: "failed" } as never);
    }
    try {
      expect(await stopGeneration("user-other", executionId, AGENTIC_CHAT_ID)).toBe(false);
      expect(await stopGeneration(USER_ID, executionId, "chat-other")).toBe(false);
      expect(db.query(
        "SELECT status FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      const terminalStop = await stopGeneration(USER_ID, executionId, AGENTIC_CHAT_ID);
      expect(terminalStop).toMatchObject({
        status: "terminal",
        generationId: executionId,
        run: {
          status: "terminal",
          turnId: executionId,
          workStatus: "terminal",
          workOutcome: "failed",
          reason: "provider_failure",
        },
      });
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, executionId)).toMatchObject({ phase: "TERMINAL", status: "terminal", outcome: "failed" });
      expect(db.query(
        "SELECT status, outcome, reason FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
      ).get(USER_ID, executionId)).toMatchObject({ status: "terminal", outcome: "failed", reason: "provider_failure" });
      expect(db.query(
        "SELECT status FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND turn_id = ?",
      ).get(USER_ID, AGENTIC_CHAT_ID, executionId)).toMatchObject({ status: "FAILED" });
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND event_kind = 'terminal'",
      ).get(USER_ID, AGENTIC_CHAT_ID, executionId) as { count: number }).count).toBe(1);
      expect(getPoolEntry(executionId)?.status).toBe("error");
    } finally {
      removePoolEntry(executionId);
    }
  });

  test("failed terminal convergence leaves only the durable execution cause and emits nothing", () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    const executionId = `exec-terminal-reconcile-failure-${Date.now()}`;
    const trigger = `agentic_projection_failure_${Date.now()}`;
    const ended: string[] = [];
    const removeEnded = eventBus.on(EventType.GENERATION_ENDED, (event) => {
      const payload = event.payload as { readonly generationId?: unknown } | undefined;
      if (payload?.generationId === executionId) ended.push(executionId);
    });
    db.run(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON agent_run_projections
      BEGIN
        SELECT RAISE(ABORT, 'projection write unavailable');
      END
    `);
    const event = {
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      status: "completed" as const,
      phase: "COMMITTED" as const,
      target: { generationType: "normal" as const },
    };
    try {
      expect(() => deps.publishTerminal!(event)).toThrow();
      expect(db.query(
        "SELECT status FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      expect(db.query(
        "SELECT state, terminal_code FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(USER_ID, executionId)).toMatchObject({
        state: "COMMIT_FAILED",
        terminal_code: "agentic_commit_failed",
      });
      expect(db.query(
        "SELECT status, outcome FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      expect(ended).toEqual([]);
    } finally {
      db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
      removeEnded();
    }
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

type RenderMessageSourceKind = "block" | "history" | "world_info" | "cognition" | "databank";

function renderLiteralSegments(text: string): readonly AssemblyMessageSegmentV1[] {
  return [{ kind: "literal", text, bytes: Buffer.byteLength(text, "utf8") }];
}

function assembledRenderMessage(
  role: AssemblyProviderMessageV1["role"],
  text: string,
  kind: RenderMessageSourceKind,
  sourceId: string,
): AssemblyProviderMessageV1 {
  return {
    role,
    contentKind: "segments",
    provenance: { kind, sourceId, sourceRevision: "1", sourceIndex: 0 },
    segments: renderLiteralSegments(text),
  };
}

function authoredRenderPolicy(text: string): AssemblyProviderMessageV1 {
  return assembledRenderMessage("system", text, "cognition", "render-policy");
}

function loomTaggedRenderMessage(text: string): AssemblyProviderMessageV1 {
  return {
    role: "system",
    contentKind: "segments",
    provenance: {
      kind: "block",
      sourceId: "loom-render-block",
      sourceRevision: "1",
      sourceIndex: 0,
      loom: {
        entryId: "loom-render",
        bucket: "renderPolicy",
        destination: "render",
        checkpoint: "RENDER",
        source: {
          kind: "loom_block",
          blockId: "loom-render-block",
          presetRevision: 1,
          blockRevision: 1,
          promptOrder: 0,
        },
        effectiveText: text,
      },
    },
    segments: renderLiteralSegments(text),
  };
}

const RENDER_NARRATIVE_FACT_MESSAGE = [
  "Name: Eleanor",
  "Personality: Warm, reserved, and precise.",
  "Scenario: A rain-soaked London boarding house.",
  "Description: A retired cartographer.",
  "World (London): Fog-bound streets above a shuttered map shop.",
].join("\n");

const COMPLETION_HANDOFF_MESSAGE = [
  "Host-accepted completion handoff (not the reply):",
  "WORK has completed. Treat the accepted workspace findings/submissions as additional host-accepted evidence alongside the supplied conversation and native World Info/Databank context. Never infer or expose private WORK records, reasoning, completion evidence, unresolved item IDs, or the operational transcript.",
].join("\n");

describe("agentic render crossings", () => {
  test("records only accepted handoff identities and explicit render guidance", () => {
    const records: unknown[] = [];
    const writer = {
      record: (_kind: string, value?: unknown) => {
        records.push(value);
        return null;
      },
    } as unknown as Parameters<typeof __testing.recordRenderCrossings>[0];
    __testing.recordRenderCrossings(writer, {
      renderGuidance: "Tell the user the accepted result.",
      workspaceContextProjection: {
        version: 1,
        sourceWorkspaceRevision: 9,
        mandatory: [
          { kind: "objective", id: "objective-1", text: "private objective", sourceRevision: 1 },
          { kind: "finding", id: "finding-7", text: "accepted finding", sourceRevision: 4 },
        ],
        optional: [
          { kind: "accepted_submission", id: "submission-2", text: "accepted submission", sourceRevision: 5 },
          { kind: "optional_task", id: "task-3", text: "private task", sourceRevision: 6 },
        ],
        omissions: [],
        literal: "",
        utf8Bytes: 0,
      },
    }, "generation-1");
    expect(records).toHaveLength(3);
    expect(records).toEqual([
      expect.objectContaining({
        sourceId: "finding-7",
        sourceRevision: 4,
        destination: "render",
        renderCrossing: expect.objectContaining({
          kind: "accepted_finding",
          sourceId: "finding-7",
          sourceRevision: 4,
          content: "accepted finding",
        }),
      }),
      expect.objectContaining({
        sourceId: "submission-2",
        sourceRevision: 5,
        renderCrossing: expect.objectContaining({
          kind: "accepted_submission",
          sourceId: "submission-2",
          sourceRevision: 5,
          content: "accepted submission",
        }),
      }),
      expect.objectContaining({
        sourceId: "completion-guidance:generation-1",
        sourceRevision: 0,
        renderCrossing: expect.objectContaining({
          kind: "completion_guidance",
          sourceRevision: null,
          content: "Tell the user the accepted result.",
        }),
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("private objective");
    expect(JSON.stringify(records)).not.toContain("private task");
  });
});

describe("agentic terminal inspection", () => {
  test("does not misclassify a completed turn's internal reason as needs attention", () => {
    expect(__testing.terminalInspectionReason("completed", "commit_finished", null)).toBe("none");
    expect(__testing.terminalInspectionReason("failed", "provider_failure", null)).toBe("provider_failure");
  });
});

describe("agentic RENDER narrative prompt", () => {
  test("uses only strict native ASSEMBLE messages, adds the completion handoff, and falls back to the host contract", () => {
    const renderGuidance = "Keep the reply intimate and in Eleanor's voice.";
    const messages = __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [
        assembledRenderMessage("system", RENDER_NARRATIVE_FACT_MESSAGE, "world_info", "world-london"),
        assembledRenderMessage("user", USER_INPUT, "history", "user-1"),
        assembledRenderMessage("assistant", "Eleanor is already in the room.", "history", "assistant-1"),
      ],
      renderPolicyMessages: [],
      renderGuidance,
    });
    expect(messages).toEqual([
      { role: "system", content: RENDER_NARRATIVE_FACT_MESSAGE },
      { role: "user", content: USER_INPUT },
      { role: "assistant", content: "Eleanor is already in the room." },
      {
        role: "system",
        content: `${COMPLETION_HANDOFF_MESSAGE}\nRender guidance:\n${renderGuidance}`,
      },
      { role: "system", content: __testing.HOST_RENDER_FINAL_RESPONSE_CONTRACT },
    ]);
    expect(messages.filter((message) => message.role !== "system").map((message) => message.content)).not.toContain("complete_turn");
  });

  test("preserves authenticated image and audio as typed multipart in finalization messages", () => {
    const nativeUserMessage: AssemblyProviderMessageV1 = {
      ...assembledRenderMessage("user", "Review these files", "history", "user-media"),
      segments: [
        ...renderLiteralSegments("Review these files"),
        {
          kind: "media",
          mediaType: "image",
          mediaId: "image-1",
          mimeType: "image/png",
          byteLength: 8,
          sha256: "a".repeat(64),
          bytes: 0,
        },
        {
          kind: "media",
          mediaType: "audio",
          mediaId: "audio-1",
          mimeType: "audio/wav",
          byteLength: 12,
          sha256: "b".repeat(64),
          bytes: 0,
        },
      ],
    };
    const messages = __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [nativeUserMessage],
      materializeMedia: (segment) => segment.mediaType === "image"
        ? { type: "image", data: `sealed:${segment.mediaId}`, mime_type: segment.mimeType }
        : { type: "audio", data: `sealed:${segment.mediaId}`, mime_type: segment.mimeType },
      renderPolicyMessages: [],
      renderGuidance: null,
    });

    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Review these files" },
        { type: "image", data: "sealed:image-1", mime_type: "image/png" },
        { type: "audio", data: "sealed:audio-1", mime_type: "audio/wav" },
      ],
    });
    expect(JSON.stringify(messages)).not.toContain("(attached)");
  });
  test("appends authored render policy instead of the host contract and excludes WORK-only messages", () => {
    const messages = __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [
        assembledRenderMessage("system", RENDER_NARRATIVE_FACT_MESSAGE, "world_info", "world-london"),
        assembledRenderMessage("user", USER_INPUT, "history", "user-1"),
        authoredRenderPolicy("MUST-NOT-APPEAR-complete_turn"),
      ],
      renderGuidance: null,
      renderPolicyMessages: [authoredRenderPolicy("Stay in character as Eleanor.")],
    });
    expect(messages).toEqual([
      { role: "system", content: RENDER_NARRATIVE_FACT_MESSAGE },
      { role: "user", content: USER_INPUT },
      { role: "system", content: COMPLETION_HANDOFF_MESSAGE },
      { role: "system", content: "Stay in character as Eleanor." },
    ]);
    expect(messages.some((message) => message.content === __testing.HOST_RENDER_FINAL_RESPONSE_CONTRACT)).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("complete_turn");
  });

  test("filters non-native, Loom-tagged, and non-narrative ASSEMBLE messages", () => {
    const messages = __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [
        assembledRenderMessage("system", "Native preset context.", "block", "preset-block"),
        assembledRenderMessage("user", USER_INPUT, "history", "user-1"),
        assembledRenderMessage("assistant", "Native world continuation.", "world_info", "world-1"),
        assembledRenderMessage("system", "Native databank context.", "databank", "databank-1"),
        authoredRenderPolicy("MUST-NOT-APPEAR-COGNITION"),
        loomTaggedRenderMessage("MUST-NOT-APPEAR-LOOM"),
        assembledRenderMessage("tool", "MUST-NOT-APPEAR-TOOL", "history", "tool-1"),
        assembledRenderMessage("developer", "MUST-NOT-APPEAR-DEVELOPER", "history", "developer-1"),
      ],
      renderGuidance: null,
      renderPolicyMessages: [],
    });
    expect(messages).toEqual([
      { role: "system", content: "Native preset context." },
      { role: "user", content: USER_INPUT },
      { role: "assistant", content: "Native world continuation." },
      { role: "system", content: "Native databank context." },
      { role: "system", content: COMPLETION_HANDOFF_MESSAGE },
      { role: "system", content: __testing.HOST_RENDER_FINAL_RESPONSE_CONTRACT },
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("MUST-NOT-APPEAR-COGNITION");
    expect(serialized).not.toContain("MUST-NOT-APPEAR-LOOM");
    expect(serialized).not.toContain("MUST-NOT-APPEAR-TOOL");
    expect(serialized).not.toContain("MUST-NOT-APPEAR-DEVELOPER");
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
         phase_policy_json, cognition_policy_json, task_policy_json,
         workspace_policy_json, state, review_acknowledged, config_revision, binding_revision,
         created_at, updated_at)
        VALUES (?, ?, 2, 1, ?, 'agentic', 8, 8, ?, 'active',
          '{}', '{}', '{}', '{}', 'ready', 1, 1, 1, ?, ?)`,
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
  test("acknowledges nested cognition settlement results and preserves committed requirements", async () => {
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
      executionId: `exec-cognition-settlement-${Date.now()}`,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    const executionSignal = execution.signal;
    if (!executionSignal) throw new Error("Cognition settlement execution signal was not installed");
    const seenTransitions: Array<{ readonly operation: string; readonly operationKey?: string; readonly actor?: unknown }> = [];
    const cognitionState: CognitionActivationStateV1 = {
      version: 1,
      workspaceRevision: 1,
      activatedTemplateIds: [],
      requiredTemplateIds: [],
    };
    const cognitionActivation: CognitionActivationResultV1 = {
      point: "task_transition",
      state: cognitionState,
      newlyActivatedTemplateIds: [],
      newlyRequiredTemplateIds: [],
    };
    const cognition: CognitionRuntimeActivationV1 = {
      phase: "WORK",
      state: cognitionState,
      activation: cognitionActivation,
      promptBlocks: { phase: "WORK", refs: [] },
      sourceRevisions: { presetRevision: 1, blockRevisions: [] },
      sourceDigest: "coordinator-settlement-test",
      workspaceRevision: 1,
    };
    const cognitionRuntime: Parameters<typeof __testing.makeWorkspace>[2] = {
      acceptCompletionFixedPoint: () => {
        throw new Error("Settlement test unexpectedly requested cognition completion");
      },
      adoptWorkspaceMutationRevision: () => {
        throw new Error("Settlement test unexpectedly adopted a non-cognition mutation");
      },
      applyWorkspaceTransition: (transition) => {
        seenTransitions.push({
          operation: transition.operation,
          operationKey: transition.operationKey,
          actor: transition.workspace.actor,
        });
        return {
          workspaceRevision: 1,
          state: cognitionState,
          activation: cognitionActivation,
          taskId: "settlement-task",
          transition: "failed",
          materializedTaskIds: [],
          cognition,
        };
      },
    };
    try {
      const workspace = __testing.makeWorkspace(execution, {
        revision: 1,
        allowed: WORKSPACE_OPERATIONS,
        maxOperationBytes: 131_072,
        maxOperations: 128,
      }, cognitionRuntime);
      const settle = workspace.settleAssignedTask;
      if (!settle) throw new Error("Coordinator settlement capability is unavailable");
      const result = await settle({
        taskId: "settlement-task",
        frameId: "settlement-child",
        state: "failed",
        operationKey: "raw-settlement-call",
        signal: executionSignal,
      });
      expect(result).toMatchObject({ accepted: true, workspaceRevision: 1 });
      expect(seenTransitions).toEqual([{
        operation: "settle_child_failure",
        operationKey: "raw-settlement-call",
        actor: "host",
      }]);
    } finally {
      deps.cleanup?.({ execution } as never);
    }
  });
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
          },
          source: { presetRevision: 1, blocks: [] },
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
        provider: "scripted-coordinator",
        connectionId: CONNECTION_ID,
        model: "scripted-model",
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
        childInstructionSubsets: [],
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
        childInstructionSubsets: [],
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
        expect(completions.map((observation) => observation.status)).toEqual(["success", "rejected", "accepted"]);
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
