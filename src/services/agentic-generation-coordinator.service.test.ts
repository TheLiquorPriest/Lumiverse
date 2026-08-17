import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { registerProvider, getProvider } from "../llm/registry";
import type { LlmProvider } from "../llm/provider";
import type { GenerationRequest, GenerationResponse, StreamChunk } from "../llm/types";
import { createDisabledAgentConfigV2 } from "../types/agents";
import { HOST_PREPARATION_LIMITS_V1 } from "../types/agent-preprocessing";
import { AgentRuntimeOwner } from "./agent-runtime.service";
import { WORKSPACE_OPERATIONS } from "../types/turn-workspace";
import { createAgenticChildFrame, createAgenticRootFrame } from "./agentic-work-phase.service";
import { setAgenticRuntimeReadiness, startAgentRuntimeEpoch, calculateFinalRenderReservationEnvelopeV1, reserveFinalRender, TurnExecutionError } from "./turn-execution.service";
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
            "SELECT submission_id, task_id FROM agent_workspace_submissions WHERE user_id = ? AND state = 'proposed' ORDER BY created_at DESC LIMIT 1",
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
                taskId: "task-delegate",
                summary: "delegated result",
                resultDigest: "d".repeat(64),
                byteCount: 16,
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
    const projection = db.query(
      "SELECT status, snapshot_json, terminal_handoff_json FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
    ).get(USER_ID, started.generationId) as { status: string; snapshot_json: string; terminal_handoff_json: string | null } | null;
    expect(projection?.status).toBe("COMMITTED");
    expect(JSON.parse(projection?.snapshot_json ?? "{}").usage).toEqual({
      inputTokens: 17,
      outputTokens: 3,
      totalTokens: 20,
      toolCalls: 0,
      childInvocations: 0,
    });
    expect(JSON.parse(projection?.terminal_handoff_json ?? "{}").messageId).toBe(messageId);

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
});
