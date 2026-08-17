import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  activateCognitionAtPoint,
  applyCognitionTaskTransitionInCas,
  completeCognitionFixedPoint,
  createCognitionActivationState,
  compareCognitionUtf8,
  evaluateCognitionPredicate,
  freezeAgentCognitionV1,
  freezeCognitionGraph,
  parseCognitionGraph,
  parseCognitionPredicate,
  parseContextActivationRule,
  parseTaskTemplate,
} from "./agent-cognition.service";
import { createTurnWorkspace, createWorkspaceTask, getTurnWorkspace } from "./turn-workspace.service";
import { createAgentCognitionRuntime } from "./agent-cognition-runtime.service";
import { AgentCognitionRuntimeError } from "../types/agent-cognition-runtime";

import {
  AGENT_COGNITION_VERSION,
  AgentCognitionValidationError,
  COGNITION_MAX_LIST_BYTES,
  COGNITION_MAX_LIST_ITEMS,
  COGNITION_MAX_PREDICATE_DEPTH,
  COGNITION_MAX_PREDICATE_NODES,
  COGNITION_MAX_STRING_BYTES,
  type CognitionEvaluationContextV1,
} from "../types/agent-cognition";
const emptyPolicy = {
  workPolicy: [],
  workspaceUsage: [],
  completionCriteria: [],
  renderPolicy: [],
};

function source(blocks: Array<{ blockId: string; revision: number; promptOrder: number }> = []) {
  return { presetRevision: 7, blocks };
}

function graph(
  templates: unknown[] = [],
  contextRules: unknown[] = [],
  policies: Record<string, unknown> = emptyPolicy,
) {
  return {
    version: AGENT_COGNITION_VERSION,
    policies,
    templates,
    contextRules,
  };
}

function context(overrides: Partial<CognitionEvaluationContextV1> = {}): CognitionEvaluationContextV1 {
  return {
    generationType: "normal",
    phase: "WORK",
    presetVariables: {},
    participantFacts: {},
    availableTools: [],
    taskTransitions: {},
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: AgentCognitionValidationError["code"]): void {
  try {
    action();
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentCognitionValidationError);
    expect((error as AgentCognitionValidationError).code).toBe(code);
  }
}

function notDepth(depth: number): unknown {
  let node: unknown = { kind: "generation_type", value: "normal" };
  for (let index = 1; index < depth; index += 1) node = { kind: "not", child: node };
  return node;
}

describe("agent cognition closed AST", () => {
  test("evaluates every predicate node, operator, and typed input", () => {
    const base = context({
      generationType: "swipe",
      phase: "RENDER",
      presetVariables: { mode: "focused", tags: ["alpha", "beta"], count: 2 },
      participantFacts: { role: "writer", traits: ["quiet", "precise"] },
      availableTools: ["lore_get_book"],
      taskTransitions: { research: "submitted" },
    });
    expect(evaluateCognitionPredicate({ kind: "generation_type", value: "swipe" }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "phase", value: "RENDER" }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "preset_variable", name: "mode", operator: "equals", value: "focused" }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "preset_variable", name: "mode", operator: "in", values: ["other", "focused"] }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "preset_variable", name: "tags", operator: "includes", value: "beta" }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "preset_variable", name: "count", operator: "present" }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "participant_fact", name: "role", operator: "equals", value: "writer" }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "participant_fact", name: "role", operator: "in", values: ["writer"] }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "participant_fact", name: "traits", operator: "includes", value: "quiet" }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "participant_fact", name: "missing", operator: "present" }, base)).toBe(false);
    expect(evaluateCognitionPredicate({ kind: "tool_available", toolId: "lore_get_book", available: true }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "tool_available", toolId: "lore_get_entry", available: false }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "task_transition", taskId: "research", transition: "submitted" }, base)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "all", children: [
      { kind: "generation_type", value: "swipe" },
      { kind: "any", children: [
        { kind: "phase", value: "WORK" },
        { kind: "not", child: { kind: "phase", value: "WORK" } },
      ] },
    ] }, base)).toBe(true);
  });

  test("rejects unknown keys, unsupported dynamic nodes, and macro-bearing text", () => {
    expectCode(() => parseCognitionPredicate({ kind: "phase", value: "WORK", extra: true }), "unknown_key");
    expectCode(() => parseCognitionPredicate({ kind: "regex", pattern: ".*" }), "invalid_value");
    expectCode(() => parseCognitionPredicate({ kind: "preset_variable", name: "x", operator: "equals", value: "{{now}}" }), "invalid_value");
    expectCode(() => parseCognitionGraph({ ...graph(), unknown: true }), "unknown_key");
    expectCode(() => parseCognitionGraph(graph([
      { id: "task", required: false, dependencies: [], activation: { kind: "phase", value: "WORK", unknown: true } },
    ])), "unknown_key");
  });

  test("bounds transition snapshots and safely preserves prototype-looking IDs", () => {
    const variables: Record<string, unknown> = Object.create(null);
    variables.__proto__ = "literal";
    const protectedContext = context({ presetVariables: variables as CognitionEvaluationContextV1["presetVariables"] });
    expect(evaluateCognitionPredicate({ kind: "preset_variable", name: "__proto__", operator: "present" }, protectedContext)).toBe(true);
    const transitions: Record<string, "done"> = Object.create(null);
    for (let index = 0; index <= COGNITION_MAX_LIST_ITEMS; index += 1) transitions[`task-${index}`] = "done";
    expectCode(
      () => evaluateCognitionPredicate(
        { kind: "phase", value: "WORK" },
        context({ taskTransitions: transitions }),
      ),
      "limit_exceeded",
    );
  });

  test("strictly parses task and context rule types", () => {
    expect(parseTaskTemplate({ id: "task", label: "Review", description: "Read evidence", required: true, dependencies: [] })).toMatchObject({
      id: "task",
      label: "Review",
      required: true,
      dependencies: [],
    });
    expect(parseContextActivationRule({ id: "rule", packId: "pack", revisionId: "rev-1", required: false, activation: { kind: "phase", value: "WORK" } })).toMatchObject({
      id: "rule",
      packId: "pack",
      revisionId: "rev-1",
      required: false,
    });
    expectCode(() => parseTaskTemplate({ id: "task", required: false, dependencies: [], extra: true }), "unknown_key");
    expectCode(() => parseContextActivationRule({ id: "rule", packId: "pack", revisionId: "rev-1", required: false, unknown: true }), "unknown_key");
  });

  test("enforces UTF-8 string, list-byte, depth, and node caps including cap plus one", () => {
    const emoji = "🙂";
    expectCode(() => parseCognitionPredicate({ kind: "phase", value: emoji.repeat(Math.ceil(COGNITION_MAX_STRING_BYTES / 4) + 1) }), "invalid_value");
    const tooLong = "x".repeat(COGNITION_MAX_STRING_BYTES + 1);
    expectCode(() => parseCognitionPredicate({ kind: "preset_variable", name: tooLong, operator: "present" }), "limit_exceeded");
    const listValue = "🙂".repeat(Math.floor(COGNITION_MAX_LIST_BYTES / 4) + 1);
    expectCode(() => parseCognitionPredicate({ kind: "preset_variable", name: "tags", operator: "in", values: [listValue] }), "limit_exceeded");
    parseCognitionPredicate(notDepth(COGNITION_MAX_PREDICATE_DEPTH));
    expectCode(() => parseCognitionPredicate(notDepth(COGNITION_MAX_PREDICATE_DEPTH + 1)), "limit_exceeded");
    const tooManyNodes = {
      kind: "all",
      children: Array.from({ length: COGNITION_MAX_PREDICATE_NODES }, () => ({ kind: "phase", value: "WORK" })),
    };
    expectCode(() => parseCognitionPredicate(tooManyNodes), "limit_exceeded");
  });

  test("canonicalizes with deterministic UTF-8 ordering", () => {
    expect(compareCognitionUtf8("a", "🙂")).toBeLessThan(0);
    const left = parseCognitionPredicate({ kind: "all", children: [
      { kind: "phase", value: "WORK" },
      { kind: "generation_type", value: "normal" },
    ] });
    const right = parseCognitionPredicate({ kind: "all", children: [
      { kind: "generation_type", value: "normal" },
      { kind: "phase", value: "WORK" },
    ] });
    expect(left).toEqual(right);
    const parsed = parseCognitionGraph(graph([
      { id: "z", required: false, dependencies: ["a"] },
      { id: "a", required: false, dependencies: [] },
    ]));
    expect(parsed.templates.map((template) => template.id)).toEqual(["a", "z"]);
    expect(parsed.templates[1]?.dependencies).toEqual(["a"]);
  });
});

const RUNTIME_USER = "cognition-runtime-user";
const RUNTIME_CHAT = "cognition-runtime-chat";
const RUNTIME_TURN = "cognition-runtime-turn";
const RUNTIME_WORKSPACE = "cognition-runtime-workspace";

async function applyRuntimeSchema(): Promise<void> {
  const database = getDb();
  database.run("PRAGMA foreign_keys = OFF");
  database.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  database.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "106_agent_turn_workspace.sql")).text());
  database.run("PRAGMA foreign_keys = ON");
}

function seedRuntimeData(): void {
  const database = getDb();
  database.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run(RUNTIME_USER, "Cognition Runtime", "cognition-runtime@example.test");
  database.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("cognition-runtime-character", RUNTIME_USER, "Cognition Runtime Character");
  database.query("INSERT INTO chats (id, user_id, character_id, name) VALUES (?, ?, ?, ?)").run(RUNTIME_CHAT, RUNTIME_USER, "cognition-runtime-character", "Cognition Runtime Chat");
  database.query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
     runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
     commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999, 'ASSEMBLE', '{}', '{}', ?, 9999999999)`)
    .run(RUNTIME_TURN, RUNTIME_USER, RUNTIME_CHAT, "cognition-runtime-generation", "cognition-runtime-commit");
}

function runtimeWorkspaceContext(expectedRevision: number): Record<string, unknown> {
  return {
    userId: RUNTIME_USER,
    chatId: RUNTIME_CHAT,
    turnId: RUNTIME_TURN,
    workspaceId: RUNTIME_WORKSPACE,
    actor: "root",
    expectedRevision,
  };
}

describe("agent cognition graph freeze and activation", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyRuntimeSchema();
    seedRuntimeData();
    createTurnWorkspace({
      userId: RUNTIME_USER,
      chatId: RUNTIME_CHAT,
      turnId: RUNTIME_TURN,
      workspaceId: RUNTIME_WORKSPACE,
      objective: "Cognition runtime objective",
      constraints: [],
      ttlSeconds: 100,
      retention: "operational",
      quota: { maxTasks: 8, maxRecords: 8, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 4096 },
      capabilities: { revision: 1, allowed: ["read_section", "read_page"], maxOperationBytes: 4096, maxOperations: 16 },
    });
  });
  afterEach(() => closeDatabase());
  test("freezes source revisions and orders Loom refs by prompt_order", () => {
    const frozen = freezeCognitionGraph(graph([], [], {
      workPolicy: [
        { blockId: "later", expectedPresetRevision: 7, expectedBlockRevision: 3 },
        { blockId: "first", expectedPresetRevision: 7, expectedBlockRevision: 2 },
      ],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }), source([
      { blockId: "later", revision: 3, promptOrder: 2 },
      { blockId: "first", revision: 2, promptOrder: 1 },
    ]));
    expect(frozen.policies.workPolicy.map((ref) => ref.blockId)).toEqual(["first", "later"]);
    expect(frozen.sourceRevisions).toEqual({
      presetRevision: 7,
      blockRevisions: [
        { blockId: "first", revision: 2 },
        { blockId: "later", revision: 3 },
      ],
    });
    expect(Object.isFrozen(frozen)).toBe(true);
    expectCode(() => freezeCognitionGraph(graph([], [], {
      ...emptyPolicy,
      workPolicy: [{ blockId: "first", expectedPresetRevision: 8, expectedBlockRevision: 2 }],
    }), source([{ blockId: "first", revision: 2, promptOrder: 1 }])), "revision_mismatch");
    expectCode(() => freezeCognitionGraph(graph([], [], {
      ...emptyPolicy,
      workPolicy: [{ blockId: "missing", expectedPresetRevision: 7, expectedBlockRevision: 2 }],
    }), source()), "missing_reference");
  });

  test("rejects missing references and cycles, including required closure", () => {
    expectCode(() => freezeCognitionGraph(graph([
      { id: "required", required: true, dependencies: ["missing"] },
    ]), source()), "missing_reference");
    expectCode(() => freezeCognitionGraph(graph([
      { id: "a", required: true, dependencies: ["b"] },
      { id: "b", required: false, dependencies: ["a"] },
    ]), source()), "cycle");
  });

  test("activates dependency closure append-only in stable ID order", () => {
    const frozen = freezeCognitionGraph(graph([
      { id: "z-parent", required: true, dependencies: ["b-dependency", "a-dependency"], activation: { kind: "phase", value: "WORK" } },
      { id: "b-dependency", required: false, dependencies: ["a-dependency"], activation: { kind: "phase", value: "RENDER" } },
      { id: "a-dependency", required: false, dependencies: [], activation: { kind: "phase", value: "RENDER" } },
    ]), source());
    const empty = createCognitionActivationState(frozen);
    const initial = activateCognitionAtPoint(frozen, empty, context({ phase: "WORK" }), "initial");
    expect(initial.state.activatedTemplateIds).toEqual(["a-dependency", "b-dependency", "z-parent"]);
    expect(initial.state.requiredTemplateIds).toEqual(["a-dependency", "b-dependency", "z-parent"]);
    const later = activateCognitionAtPoint(frozen, initial.state, context({ phase: "RENDER" }), "phase_entry");
    expect(later.state.activatedTemplateIds).toEqual(initial.state.activatedTemplateIds);
    expect(later.newlyActivatedTemplateIds).toEqual([]);
  });

  test("runs task activation inside one CAS and preserves the transition hook contract", () => {
    const frozen = freezeCognitionGraph(graph([
      { id: "task", required: true, dependencies: [], activation: { kind: "task_transition", taskId: "seed", transition: "done" } },
    ]), source());
    const state = createCognitionActivationState(frozen);
    let calls = 0;
    let expectedRevision = -1;
    const result = applyCognitionTaskTransitionInCas(
      frozen,
      state,
      context(),
      "seed",
      "done",
      {
        commit(expected, update) {
          calls += 1;
          expectedRevision = expected;
          const current = { ...state, workspaceRevision: expected };
          return update(current);
        },
      },
    );
    expect(calls).toBe(1);
    expect(expectedRevision).toBe(0);
    expect(result.state.workspaceRevision).toBe(1);
    expect(result.state.activatedTemplateIds).toEqual(["task"]);
    expect(result.activation.point).toBe("task_transition");
  });

  test("rejects forged required closure state and malformed CAS context before commit", () => {
    const frozen = freezeCognitionGraph(graph([
      { id: "optional", required: false, dependencies: [] },
    ]), source());
    const state = createCognitionActivationState(frozen);
    expectCode(() => activateCognitionAtPoint(frozen, {
      ...state,
      activatedTemplateIds: ["optional"],
      requiredTemplateIds: ["optional"],
    }, context(), "initial"), "required_closure_invalid");
    let commits = 0;
    expectCode(() => applyCognitionTaskTransitionInCas(
      frozen,
      state,
      { ...context(), taskTransitions: null as never },
      "seed",
      "done",
      {
        commit() {
          commits += 1;
          return state;
        },
      },
    ), "invalid_type");
    expect(commits).toBe(0);
  });

  test("runs bounded completion fixed point and blocks on a newly required task", () => {
    const frozen = freezeCognitionGraph(graph([
      { id: "review", required: true, dependencies: [], activation: { kind: "phase", value: "COMPLETE" } },
    ]), source());
    const state = createCognitionActivationState(frozen);
    const blocked = completeCognitionFixedPoint(frozen, state, context({ phase: "COMPLETE" }));
    expect(blocked.newlyActivatedTemplateIds).toEqual(["review"]);
    expect(blocked.blockingRequiredTaskIds).toEqual(["review"]);
    expect(blocked.canComplete).toBe(false);
    const accepted = completeCognitionFixedPoint(
      frozen,
      blocked.state,
      context({ phase: "COMPLETE", taskTransitions: { review: "done" } }),
    );
    expect(accepted.blockingRequiredTaskIds).toEqual([]);
    expect(accepted.canComplete).toBe(true);
    expect(accepted.state.activatedTemplateIds).toEqual(blocked.state.activatedTemplateIds);
  });

  test("maps submit and accept transitions into completion predicates", () => {
    const frozen = freezeCognitionGraph(graph([
      { id: "review", required: true, dependencies: [], activation: { kind: "task_transition", taskId: "child", transition: "submitted" } },
    ]), source());
    const state = createCognitionActivationState(frozen);
    const submitted = completeCognitionFixedPoint(
      frozen,
      state,
      context({ phase: "COMPLETE", taskTransitions: { child: "submitted" } }),
    );
    expect(submitted.blockingRequiredTaskIds).toEqual(["review"]);
    expect(submitted.canComplete).toBe(false);
    const accepted = completeCognitionFixedPoint(
      frozen,
      submitted.state,
      context({ phase: "COMPLETE", taskTransitions: { child: "accepted", review: "done" } }),
    );
    expect(accepted.blockingRequiredTaskIds).toEqual([]);
    expect(accepted.canComplete).toBe(true);
  });

  test("builds an authenticated frozen graph from the strict loader", () => {
    const frozen = freezeAgentCognitionV1({
      config: { cognitionPolicy: emptyPolicy },
      contextRules: [{ id: "required-context", packId: "pack", revisionId: "rev", required: true }],
      taskTemplates: [],
      selections: [{ packId: "pack", revisionId: "rev", digest: "a".repeat(64), required: true }],
    }, source());
    expect(frozen?.graph.contextRules.map((rule) => rule.id)).toEqual(["required-context"]);
    expect(frozen?.contextPackSelections[0]?.digest).toBe("a".repeat(64));
    expect(freezeAgentCognitionV1({ config: {}, contextRules: [], taskTemplates: [], selections: [] }, source())).toBeNull();
  });
  test("rehydrates the coordinator frozen graph and snapshot selection metadata", () => {
    const frozen = freezeAgentCognitionV1({
      config: { cognitionPolicy: emptyPolicy },
      contextRules: [],
      taskTemplates: [],
      selections: [{
        packId: "pack",
        revisionId: "pack@1",
        digest: "a".repeat(64),
        required: true,
      }],
    }, source());
    if (!frozen) throw new Error("expected cognition graph");
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: frozen.graph,
        source: source(),
        contextPackSelections: [{
          packId: "pack",
          revisionId: "pack@1",
          revision: 1,
          digest: "a".repeat(64),
          required: true,
        }],
        contextPackCandidates: [{
          packId: "pack",
          revisionId: "pack@1",
          digest: "a".repeat(64),
          source: "account",
          required: true,
        }],
      },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    expect(runtime.graph.contextRules).toEqual([]);
    expect(runtime.source.contextPackSelections).toEqual([{
      packId: "pack",
      revisionId: "pack@1",
      digest: "a".repeat(64),
      required: true,
    }]);
  });


  test("filters unselected context rules while retaining selected dependency closure", async () => {
    const selectedDependency = {
      id: "selected-dependency",
      packId: "selected-dependency-pack",
      revisionId: "selected-dependency@1",
      required: false,
      dependencies: [],
    };
    const selectedRoot = {
      id: "selected-root",
      packId: "selected-root-pack",
      revisionId: "selected-root@1",
      required: false,
      dependencies: ["selected-dependency"],
      activation: { kind: "phase", value: "RENDER" },
    };
    const unselectedRequired = {
      id: "unselected-required",
      packId: "unselected-pack",
      revisionId: "unselected@1",
      required: true,
      dependencies: [],
      activation: { kind: "phase", value: "RENDER" },
    };
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: graph([], [selectedDependency, selectedRoot, unselectedRequired]),
        source: source(),
        contextRules: [selectedRoot],
        contextPackSelections: [],
        contextPackCandidates: [],
      },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    expect(runtime.graph.contextRules.map((rule) => rule.id)).toEqual(["selected-dependency", "selected-root"]);
    expect(runtime.initialActivation.activation.newlyActivatedContextRuleIds).toEqual([]);
    const render = runtime.enterPhase({ phase: "RENDER", workspace: runtimeWorkspaceContext(1) });
    expect(render.activation.newlyActivatedContextRuleIds).toEqual(["selected-dependency", "selected-root"]);
    expect(render.activation.newlyActivatedContextRuleIds).not.toContain("unselected-required");
    const completion = await runtime.acceptCompletionFixedPoint({
      operationKey: "selected-context-completion",
      workspace: runtimeWorkspaceContext(2),
    });
    expect(completion.accepted).toBe(true);
    expect(completion.blockers).toEqual([]);
  });
  test("filters unselected task templates while materializing selected dependency closure", async () => {
    const selectedDependency = { id: "selected-dependency", required: false, dependencies: [], activation: { kind: "phase", value: "COMPLETE" } };
    const selectedRoot = { id: "selected-root", required: false, dependencies: ["selected-dependency"], activation: { kind: "phase", value: "COMPLETE" } };
    const unselectedRequired = { id: "unselected-required", required: true, dependencies: [], activation: { kind: "phase", value: "COMPLETE" } };
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: graph([selectedDependency, selectedRoot, unselectedRequired], []),
        source: source(),
        contextRules: [],
        taskTemplateIds: ["selected-root"],
        contextPackSelections: [],
        contextPackCandidates: [],
      },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    expect(runtime.initialActivation.activation.newlyActivatedTemplateIds).toEqual([]);
    expect(runtime.graph.templates.map((template) => template.id)).toEqual(["selected-dependency", "selected-root"]);
    const completion = await runtime.acceptCompletionFixedPoint({
      operationKey: "selected-task-completion",
      workspace: runtimeWorkspaceContext(1),
    });
    expect(completion.accepted).toBe(true);
    expect(completion.materializedTaskIds).toEqual(["selected-dependency", "selected-root"]);
    expect(completion.blockers).toEqual([]);
  });


  test("keeps attached/direct context active while deferring inactive account rules", async () => {
    const graphValue = graph([], [
      { id: "future", packId: "future-pack", revisionId: "future@1", required: true, activation: { kind: "phase", value: "RENDER" } },
    ]);
    const digestValue = "b".repeat(64);
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: graphValue,
        source: source(),
        contextPackSelections: [{ packId: "direct-pack", revisionId: "direct@1", digest: digestValue, required: true }],
        contextPackCandidates: [
          { packId: "attached-pack", revisionId: "attached@1", digest: digestValue, source: "preset", required: false },
          { packId: "direct-pack", revisionId: "direct@1", digest: digestValue, source: "account", required: false },
          { packId: "future-pack", revisionId: "future@1", digest: digestValue, source: "account", required: false },
        ],
      },
      evaluation: context({ phase: "WORK" }),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    expect(runtime.initialActivation.workspaceRevision).toBe(1);
    expect((await runtime.enterPhase({ phase: "RENDER", workspace: runtimeWorkspaceContext(1) })).contextPackRequirements.map((item) => item.packId)).toEqual(["attached-pack", "direct-pack", "future-pack"]);
  });
  test("applies a task transition atomically and returns the same result on an idempotent retry", async () => {
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: graph([
          { id: "review", required: true, dependencies: [], activation: { kind: "task_transition", taskId: "seed", transition: "pending" } },
        ]),
        source: source(),
        contextPackSelections: [],
        contextPackCandidates: [],
      },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    const workspace = { ...runtimeWorkspaceContext(1), taskId: "seed", title: "Seed task" };
    const first = await runtime.applyWorkspaceTransition({
      taskId: "seed",
      transition: "pending",
      operation: "create_task",
      operationKey: "seed-create",
      workspace,
    });
    const retry = await runtime.applyWorkspaceTransition({
      taskId: "seed",
      transition: "pending",
      operation: "create_task",
      operationKey: "seed-create",
      workspace: { ...workspace, expectedRevision: 2 },
    });
    expect(retry).toBe(first);
    expect(() => runtime.applyWorkspaceTransition({
      taskId: "seed",
      transition: "pending",
      operation: "create_task",
      operationKey: "seed-create",
      workspace: { ...workspace, expectedRevision: 2, title: "Different semantic task" },
    })).toThrow(AgentCognitionRuntimeError);
    expect(first.workspaceRevision).toBe(2);
    expect(first.materializedTaskIds).toEqual(["review"]);
    expect(first.cognition.activation.newlyActivatedTemplateIds).toEqual(["review"]);
    expect(getTurnWorkspace(runtimeWorkspaceContext(2)).revision).toBe(2);
  });
  test("rejects submitted state before the cognition progress adapter runs", () => {
    createWorkspaceTask({
      ...runtimeWorkspaceContext(0),
      taskId: "runtime-progress-task",
      title: "Runtime progress task",
      assignedFrameId: "runtime-progress-child",
    });
    const runtime = createAgentCognitionRuntime({
      source: { graph: graph(), source: source(), contextPackSelections: [], contextPackCandidates: [] },
      evaluation: context(),
      workspaceRevision: 1,
      workspace: runtimeWorkspaceContext(1),
    });
    const error = (() => {
      try {
        runtime.applyWorkspaceTransition({
          taskId: "runtime-progress-task",
          transition: "done",
          operation: "update_assigned_progress",
          workspace: {
            ...runtimeWorkspaceContext(2),
            actor: "child",
            frameId: "runtime-progress-child",
            state: "submitted",
            capabilities: {
              revision: 1,
              allowed: ["update_assigned_progress"],
              maxOperationBytes: 4096,
              maxOperations: 1,
            },
          },
        });
      } catch (caught) {
        return caught;
      }
      throw new Error("expected submitted progress rejection");
    })();
    expect(error).toBeInstanceOf(AgentCognitionRuntimeError);
    expect((error as AgentCognitionRuntimeError).code).toBe("invalid_source");
    expect(getTurnWorkspace(runtimeWorkspaceContext(2)).revision).toBe(2);
    expect(getDb().query("SELECT state FROM agent_workspace_tasks WHERE task_id = ?").get("runtime-progress-task")).toEqual({ state: "active" });
  });
  test("root completion cannot bypass a submitted required task without an accepted child submission", async () => {
    const task = createWorkspaceTask({
      ...runtimeWorkspaceContext(0),
      actor: "host",
      taskId: "runtime-malformed-required",
      title: "Malformed required task",
      required: true,
    });
    const runtime = createAgentCognitionRuntime({
      source: { graph: graph(), source: source(), contextPackSelections: [], contextPackCandidates: [] },
      evaluation: context(),
      workspaceRevision: 1,
      workspace: runtimeWorkspaceContext(1),
    });
    const completion = await runtime.acceptCompletionFixedPoint({
      operationKey: "runtime-malformed-required-completion",
      workspace: runtimeWorkspaceContext(2),
    });
    expect(completion.accepted).toBe(false);
    expect(completion.blockingRequiredTaskIds).toEqual([task.id]);
    expect(getTurnWorkspace(runtimeWorkspaceContext(completion.workspaceRevision)).state).toBe("active");
  });


  test("rejects an aborted transition before the workspace cognition CAS", () => {
    const runtime = createAgentCognitionRuntime({
      source: { graph: graph(), source: source(), contextPackSelections: [], contextPackCandidates: [] },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(() => runtime.applyWorkspaceTransition({
      taskId: "cancelled-task",
      transition: "pending",
      operation: "create_task",
      operationKey: "cancelled-task",
      signal: controller.signal,
      workspace: { ...runtimeWorkspaceContext(1), taskId: "cancelled-task", title: "Cancelled task" },
    })).toThrow("stop");
    expect(getTurnWorkspace(runtimeWorkspaceContext(1)).revision).toBe(1);
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_tasks WHERE workspace_id = ?").get(RUNTIME_WORKSPACE)).toEqual({ count: 0 });
  });

  test("fails required context activation before a task CAS and leaves the workspace unchanged", () => {
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: graph([], [
          { id: "required-task-context", packId: "account-pack", revisionId: "account@1", required: true, activation: { kind: "task_transition", taskId: "seed", transition: "pending" } },
        ]),
        source: source(),
        contextPackSelections: [],
        contextPackCandidates: [],
      },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    expect(() => runtime.applyWorkspaceTransition({
      taskId: "seed",
      transition: "pending",

      operation: "create_task",
      operationKey: "missing-context-seed",
      workspace: { ...runtimeWorkspaceContext(1), taskId: "seed", title: "Seed task" },
    })).toThrow(AgentCognitionRuntimeError);
    expect(getTurnWorkspace(runtimeWorkspaceContext(1)).revision).toBe(1);
  });
  test("orders context requirements by deterministic UTF-8 bytes", () => {
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: graph(),
        source: source(),
        contextPackSelections: [],
        contextPackCandidates: [
          { packId: "🙂", revisionId: "revision", digest: "a".repeat(64), source: "preset" },
          { packId: "a", revisionId: "revision", digest: "b".repeat(64), source: "preset" },
        ],
      },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    expect(runtime.initialActivation.contextPackRequirements.map((requirement) => requirement.packId)).toEqual(["a", "🙂"]);
  });

  test("treats optional context dependencies of required rules as required", () => {
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: graph([], [
          { id: "required-context-root", packId: "required-pack", revisionId: "required@1", required: true, dependencies: ["optional-context-dependency"], activation: { kind: "phase", value: "RENDER" } },
          { id: "optional-context-dependency", packId: "dependency-pack", revisionId: "dependency@1", required: false, dependencies: [], activation: { kind: "phase", value: "RENDER" } },
        ]),
        source: source(),
        contextPackSelections: [],
        contextPackCandidates: [{ packId: "required-pack", revisionId: "required@1", digest: "a".repeat(64), source: "account" }],
      },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    expect(() => runtime.enterPhase({ phase: "RENDER", workspace: runtimeWorkspaceContext(1) })).toThrow(AgentCognitionRuntimeError);
    expect(getTurnWorkspace(runtimeWorkspaceContext(1)).revision).toBe(1);
  });

  test("materializes a newly required render task, blocks completion, and accepts after the task is done", async () => {
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: graph([
          { id: "render-review", required: true, dependencies: [], activation: { kind: "phase", value: "RENDER" } },
          { id: "after-review", required: false, dependencies: [], activation: { kind: "task_transition", taskId: "render-review", transition: "accepted" } },
        ]),
        source: source(),
        contextPackSelections: [],
        contextPackCandidates: [],
      },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    const blocked = await runtime.acceptCompletionFixedPoint({ operationKey: "completion-first", workspace: runtimeWorkspaceContext(1) });
    expect(blocked.accepted).toBe(false);
    expect(blocked.blockingRequiredTaskIds).toEqual(["render-review"]);
    expect(blocked.materializedTaskIds).toEqual(["render-review"]);
    expect(blocked.preCommitActivations.map((activation) => activation.phase)).toEqual(["COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING", "COMMITTED"]);
    expect(getTurnWorkspace(runtimeWorkspaceContext(2)).revision).toBe(2);
    expect(blocked.preCommitActivations.every((activation) => activation.workspaceRevision === 1)).toBe(true);
    getDb().query("UPDATE agent_workspace_tasks SET state = 'submitted' WHERE task_id = ? AND workspace_id = ?").run("render-review", RUNTIME_WORKSPACE);
    const now = Math.floor(Date.now() / 1000);
    getDb().query(`INSERT INTO agent_workspace_submissions
      (submission_id, task_id, workspace_id, turn_id, user_id, chat_id, child_frame_id, state, summary, result_digest, byte_count, retention, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, 1, 'operational', ?, ?, ?)`)
      .run("render-review-submission", "render-review", RUNTIME_WORKSPACE, RUNTIME_TURN, RUNTIME_USER, RUNTIME_CHAT, "render-review-child", "done", "c".repeat(64), now + 100, now, now);
    getDb().query(`INSERT INTO agent_workspace_tasks
      (task_id, workspace_id, turn_id, user_id, chat_id, title, description, state, required, dependencies_json, assigned_frame_id, progress, summary, byte_count, retention, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, '[]', NULL, 0, NULL, 0, 'operational', ?)`)
      .run("other-task", RUNTIME_WORKSPACE, RUNTIME_TURN, RUNTIME_USER, RUNTIME_CHAT, "Other task", "", now + 100);
    const workspaceBeforeReject = getTurnWorkspace(runtimeWorkspaceContext(2));
    const submissionBeforeReject = getDb().query("SELECT state, revision, summary FROM agent_workspace_submissions WHERE submission_id = ?").get("render-review-submission");
    const renderTaskBeforeReject = getDb().query("SELECT state, revision, summary FROM agent_workspace_tasks WHERE task_id = ?").get("render-review");
    const otherTaskBeforeReject = getDb().query("SELECT state, revision, summary FROM agent_workspace_tasks WHERE task_id = ?").get("other-task");
    expect(() => runtime.applyWorkspaceTransition({
      taskId: "other-task",
      transition: "accepted",
      operation: "accept_submission",
      operationKey: "wrong-task-accept",
      workspace: { ...runtimeWorkspaceContext(2), submissionId: "render-review-submission" },
    })).toThrow();
    expect(getTurnWorkspace(runtimeWorkspaceContext(2))).toEqual(workspaceBeforeReject);
    expect(getDb().query("SELECT state, revision, summary FROM agent_workspace_submissions WHERE submission_id = ?").get("render-review-submission")).toEqual(submissionBeforeReject);
    expect(getDb().query("SELECT state, revision, summary FROM agent_workspace_tasks WHERE task_id = ?").get("render-review")).toEqual(renderTaskBeforeReject);
    expect(getDb().query("SELECT state, revision, summary FROM agent_workspace_tasks WHERE task_id = ?").get("other-task")).toEqual(otherTaskBeforeReject);
    const acceptedTask = await runtime.applyWorkspaceTransition({
      taskId: "render-review",
      transition: "accepted",
      operation: "accept_submission",
      operationKey: "render-review-accept",
      workspace: { ...runtimeWorkspaceContext(2), submissionId: "render-review-submission" },
    });
    expect(acceptedTask.workspaceRevision).toBe(3);
    expect(acceptedTask.materializedTaskIds).toEqual(["after-review"]);
    expect(acceptedTask.cognition.activation.newlyActivatedTemplateIds).toEqual(["after-review"]);
    const accepted = await runtime.acceptCompletionFixedPoint({ operationKey: "completion-retry", workspace: runtimeWorkspaceContext(3) });
    expect(accepted.accepted).toBe(true);
    expect(accepted.blockingRequiredTaskIds).toEqual([]);
    expect(accepted.materializedTaskIds).toEqual([]);
    expect(accepted.workspaceRevision).toBe(4);
  });

  test("rejects a cancelled completion before workspace mutation", () => {
    const runtime = createAgentCognitionRuntime({
      source: { graph: graph(), source: source(), contextPackSelections: [], contextPackCandidates: [] },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    const controller = new AbortController();
    controller.abort(new DOMException("cancel", "AbortError"));
    expect(() => runtime.acceptCompletionFixedPoint({
      operationKey: "cancelled-completion",
      signal: controller.signal,
      workspace: runtimeWorkspaceContext(1),
    })).toThrow();
    expect(getTurnWorkspace(runtimeWorkspaceContext(1)).revision).toBe(1);
  });

  test("keeps post-accept render and commit phase entries read-only", async () => {
    const runtime = createAgentCognitionRuntime({
      source: { graph: graph(), source: source(), contextPackSelections: [], contextPackCandidates: [] },
      evaluation: context(),
      workspaceRevision: 0,
      workspace: runtimeWorkspaceContext(0),
    });
    const accepted = await runtime.acceptCompletionFixedPoint({ operationKey: "completion-empty", workspace: { ...runtimeWorkspaceContext(1), completionSummary: "same summary" } });
    expect(await runtime.acceptCompletionFixedPoint({ operationKey: "completion-empty", workspace: { ...runtimeWorkspaceContext(2), completionSummary: "same summary" } })).toBe(accepted);
    expect(() => runtime.acceptCompletionFixedPoint({ operationKey: "completion-empty", workspace: { ...runtimeWorkspaceContext(2), completionSummary: "different semantic completion" } })).toThrow(AgentCognitionRuntimeError);
    expect(accepted.workspaceRevision).toBe(2);
    for (const phase of ["RENDER", "PREPARE_COMMIT", "COMMITTING", "COMMITTED"] as const) {
      const view = await runtime.enterPhase({ phase, workspace: runtimeWorkspaceContext(2) });
      expect(view.workspaceRevision).toBe(2);
      expect(getTurnWorkspace(runtimeWorkspaceContext(2)).revision).toBe(2);
    }
    expect(() => runtime.applyWorkspaceTransition({
      taskId: "late-task",
      transition: "pending",
      operation: "create_task",
      operationKey: "late-task",
      workspace: { ...runtimeWorkspaceContext(2), taskId: "late-task", title: "Late task" },
    })).toThrow(AgentCognitionRuntimeError);
    expect(() => runtime.enterPhase({ phase: "RENDER", workspace: runtimeWorkspaceContext(1) })).toThrow(AgentCognitionRuntimeError);
  });

  test("rejects a cognition revision mismatch before workspace activation", () => {
    expect(() => createAgentCognitionRuntime({
      source: { graph: graph(), source: source(), contextPackSelections: [], contextPackCandidates: [] },
      evaluation: context(),
      workspaceRevision: 1,
      workspace: runtimeWorkspaceContext(0),
    })).toThrow(AgentCognitionRuntimeError);
  });
});
