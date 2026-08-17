import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AgentRuntimeDecisionService,
  RuntimeDecisionTokenStore,
  normalizeEffectiveRuntimeRequest,
  toPublicRuntimeDecision,
  type RuntimeDecisionDependencies,
} from "./agent-runtime-decision.service";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import type {
  AgenticReadinessVectorV1,
  EffectiveRuntimeRequestV1,
  FrozenConcreteConnectionV1,
  InputRevisionSetV1,
} from "../types/agent-runtime-decision";

type FakeConnection = FrozenConcreteConnectionV1 & { presetId?: string | null };

const USER_ID = "user-a";
const CHAT_ID = "chat-a";
const fullRevisions: InputRevisionSetV1 = {
  target: 1,
  chat: 2,
  message: 3,
  preset: 4,
  block: 5,
  config: 6,
  binding: 7,
  connection: 8,
  endpoint: 9,
  credential: 10,
  persona: 11,
  character: 12,
  group: 13,
  world: 14,
  lore: 15,
  settings: 16,
  macro: 17,
  regex: 18,
  context: 19,
  acl: 20,
  cognition: 21,
  readiness: 22,
};

function connection(id: string, overrides: Partial<FakeConnection> = {}): FakeConnection {
  return {
    logicalId: id,
    concreteId: id,
    label: id,
    provider: "test-provider",
    model: "test-model",
    endpointRevision: `endpoint-${id}`,
    credentialSecretRef: `secret-${id}`,
    credentialRevision: `credential-${id}`,
    candidateRevision: `candidate-${id}`,
    revision: `revision-${id}`,
    fingerprint: "domain-a",
    capabilities: {
      streaming: true,
      toolCalling: true,
      toolsDisabledFinalization: true,
      nativeToolContinuation: true,
      toolContinuationMode: "native",
    },
    ...overrides,
    effectiveEndpoint: overrides.effectiveEndpoint ?? null,
  };
}

type TestPreset = {
  id: string;
  name?: string;
  cache_revision?: number;
  agent_config?: unknown;
};

function request(overrides: Partial<EffectiveRuntimeRequestV1> = {}): EffectiveRuntimeRequestV1 {
  return {
    chatId: CHAT_ID,
    logicalConnectionId: "root",
    presetId: "preset-default",
    mode: "agentic",
    generationType: "normal",
    requestEpoch: 1,
    inputRevisions: fullRevisions,
    readinessVector: readiness(),
    ...overrides,
  };
}

function readiness(overrides: Partial<AgenticReadinessVectorV1> = {}): AgenticReadinessVectorV1 {
  return {
    schemaEpoch: 1,
    runtimeEpoch: 1,
    reconciliationEpoch: 1,
    archiveRegistryVersion: 1,
    isolateHealthEpoch: 1,
    publicationStoreHealthEpoch: 1,
    providerCapabilityRevision: 1,
    configRevision: 1,
    bindingRevision: 1,
    concreteConnectionRevision: 1,
    targetRevision: 1,
    inputRevisionDigest: "snapshot",
    cognitionRevision: 1,
    contextAclRevision: 1,
    killSwitchState: "auto",
    ready: true,
    reasons: [],
    ...overrides,
  };
}

function makeService(options: {
  chat?: Record<string, unknown>;
  preset?: TestPreset | null;
  connections?: Record<string, FakeConnection>;
  override?: { mode: "response" | "agentic" | null; revision: number; state: "ready" | "review_required" | "repair_required" } | null;
  resolveCouncilProfile?: RuntimeDecisionDependencies["resolveCouncilProfile"];
  now?: () => number;
} = {}) {
  const chat = {
    id: CHAT_ID,
    character_id: "character-a",
    metadata: {},
    ...options.chat,
  };
  const preset = options.preset === null ? null : options.preset ?? {
    id: "preset-default",
    name: "Default",
    cache_revision: 3,
    agent_config: {
      version: 2,
      agentsEnabled: true,
      allowedModes: ["response", "agentic"],
      defaultMode: "response",
      maxInvocations: 8,
      maxToolCalls: 8,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [],
      connectionSlots: [],
      slotBindings: {},
    },
  };
  const connections = options.connections ?? { root: connection("root") };
  let override = options.override ?? null;
  const tokenStore = new RuntimeDecisionTokenStore(options.now ?? (() => 1_000), { ttlMs: 60_000 });
  return new AgentRuntimeDecisionService({
    now: options.now ?? (() => 1_000),
    tokenStore,
    dependencies: {
      getChat: () => chat,
      getPreset: (_userId, presetId) => preset && preset.id === presetId ? preset : null,
      getPresetAgentConfig: (_userId, presetId) => {
        if (!preset || preset.id !== presetId || !preset.agent_config || typeof preset.agent_config !== "object") return null;
        const config = preset.agent_config as Record<string, unknown>;
        const rawBindings = config.slotBindings;
        const { slotBindings: _slotBindings, ...authoredConfig } = config;
        const bindings = rawBindings && typeof rawBindings === "object" && !Array.isArray(rawBindings)
          ? Object.entries(rawBindings as Record<string, unknown>).map(([slotId, connectionId]) => ({
            slotId,
            connectionId: typeof connectionId === "string" ? connectionId : null,
            bindingRevision: 1,
            state: "ready" as const,
          }))
          : [];
        return {
          config: authoredConfig,
          review: { state: "ready" as const, unresolvedSlotIds: [], staleSlotIds: [], acknowledged: false },
          configRevision: 1,
          bindings,
        };
      },
      resolveProfile: () => ({ preset_id: preset?.id ?? null, source: "chat", binding: null }),
      ...(options.resolveCouncilProfile ? { resolveCouncilProfile: options.resolveCouncilProfile } : {}),
      resolvePersona: () => ({ id: "persona-a" }),
      resolveConcreteConnection: async (_userId, logicalId) => logicalId ? connections[logicalId] ?? null : null,
      getChatAgentModeOverride: () => override,
      setChatAgentModeOverride: (_userId, _chatId, mode, expectedRevision) => {
        if (expectedRevision !== undefined && override && expectedRevision !== override.revision) {
          throw new Error("stale");
        }
        const revision = (override?.revision ?? 0) + 1;
        override = { mode, revision, state: "ready" };
        return { chatId: CHAT_ID, mode, revision, state: "ready" };
      },
    },
  });
}

describe("AgentRuntimeDecisionService", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
  });

  afterEach(() => {
    closeDatabase();
  });

  test("resolves chat precedence and skips character bindings for groups", async () => {
    const calls: Array<{ characterId: string | null; isGroup?: boolean }> = [];
    const service = makeService({ chat: { metadata: { group: true, character_ids: ["character-a"] } } });
    const resolved = await new AgentRuntimeDecisionService({
      dependencies: {
        getChat: () => ({ id: CHAT_ID, character_id: "character-a", metadata: { group: true, character_ids: ["character-a"] } }),
        getPreset: (_userId, id) => id === "chat-preset" ? { id, name: "Chat" } : null,
        resolveConcreteConnection: () => Promise.resolve(connection("root")),
        resolveProfile: (_userId, _fallback, _chatId, characterId, options) => {
          calls.push({ characterId, isGroup: options.isGroup });
          return { preset_id: "chat-preset", source: "chat" };
        },
        resolvePersona: () => null,
        getChatAgentModeOverride: () => null,
        setChatAgentModeOverride: () => ({ chatId: CHAT_ID, mode: null, revision: 1, state: "ready" }),
      },
    }).resolve(USER_ID, request({ mode: "response" }));

    expect(resolved.preset.id).toBe("chat-preset");
    expect(calls).toEqual([{ characterId: "character-a", isGroup: true }]);
    expect(service).toBeDefined();
  });

  test("forced preset and no-preset chat bypass the profile chain", async () => {
    let profileCalls = 0;
    const service = makeService({
      chat: { metadata: { no_preset: true } },
      preset: { id: "forced", name: "Forced", agent_config: { version: 2, agentsEnabled: true, allowedModes: ["response", "agentic"], defaultMode: "agentic", profiles: [], connectionSlots: [] } },
    });
    const decision = await new AgentRuntimeDecisionService({
      dependencies: {
        getChat: () => ({ id: CHAT_ID, metadata: { no_preset: true } }),
        getPreset: (_userId, id) => id === "forced" ? { id, name: "Forced" } : null,
        resolveConcreteConnection: () => Promise.resolve(connection("root")),
        resolveProfile: () => { profileCalls++; return { preset_id: "forced" }; },
        resolvePersona: () => null,
        getChatAgentModeOverride: () => null,
        setChatAgentModeOverride: () => ({ chatId: CHAT_ID, mode: null, revision: 1, state: "ready" }),
      },
    }).resolve(USER_ID, request({ presetId: "forced", forcePresetId: true, mode: "response" }));

    expect(decision.preset.id).toBeNull();
    expect(profileCalls).toBe(0);
    expect(service).toBeDefined();
  });

  test("issues an opaque token and rejects mismatch, replay, expiry, and revision races", async () => {
    let now = 1_000;
    const connections = { root: connection("root") };
    const service = makeService({ connections, now: () => now });
    const issued = await service.resolve(USER_ID, request());
    expect(issued.effectiveMode).toBe("agentic");
    expect(issued.runtimeDecisionToken).toMatch(/^lvrd_[A-Za-z0-9_-]+$/);
    expect(issued.runtimeDecisionExpiresAt).toBe(61_000);

    const mismatched = await service.consume(USER_ID, issued.runtimeDecisionToken!, request({ chatId: "other-chat" }));
    expect(mismatched).toEqual({ accepted: false, code: "decision_refresh_required", decision: null });
    const replayed = await service.consume(USER_ID, issued.runtimeDecisionToken!, request());
    expect(replayed.accepted).toBe(false);

    const issuedAgain = await service.resolve(USER_ID, request());
    connections.root = connection("root", { candidateRevision: "changed" });
    const stale = await service.consume(USER_ID, issuedAgain.runtimeDecisionToken!, request());
    expect(stale).toEqual({ accepted: false, code: "decision_refresh_required", decision: null });

    const issuedExpired = await service.resolve(USER_ID, request());
    now = 61_001;
    const expired = await service.consume(USER_ID, issuedExpired.runtimeDecisionToken!, request());
    expect(expired.accepted).toBe(false);
  });

  test("rejects legacy group metadata before issuing an Agentic token", async () => {
    const decision = await makeService({
      chat: { metadata: { group: 1 } },
    }).resolve(USER_ID, request());

    expect(decision.effectiveMode).toBe("response");
    expect(decision.runtimeDecisionToken).toBeNull();
    expect(decision.repairCodes).toContain("agentic_target_unsupported");
  });

  test("rejects an active owner-scoped Council profile without metadata flags", async () => {
    const decision = await makeService({
      resolveCouncilProfile: () => ({
        council_settings: {
          councilMode: true,
          members: [{ tools: [] }],
        },
      }),
    }).resolve(USER_ID, request());

    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.ready).toBe(false);
    expect(decision.runtimeDecisionToken).toBeNull();
    expect(decision.repairCodes).toContain("agentic_target_unsupported");
  });

  test("accepts legacy root continuation while rejecting unsupported root continuation", async () => {
    const unsupported = await makeService({
      connections: {
        root: connection("root", {
          capabilities: {
            streaming: true,
            toolCalling: true,
            toolsDisabledFinalization: true,
          },
        }),
      },
    }).resolve(USER_ID, request());

    expect(unsupported.effectiveMode).toBe("response");
    expect(unsupported.capabilityReadiness.ready).toBe(false);
    expect(unsupported.capabilityReadiness.missing).toContain("native_tool_continuation");
    expect(unsupported.repairCodes).toContain("agentic_capability_missing_native_tool_continuation");

    const legacy = await makeService({
      connections: {
        root: connection("root", {
          capabilities: {
            streaming: true,
            toolCalling: true,
            toolsDisabledFinalization: true,
            nativeToolContinuation: true,
            toolContinuationMode: "legacy",
          },
        }),
      },
    }).resolve(USER_ID, request());
    expect(legacy.effectiveMode).toBe("agentic");
    expect(legacy.capabilityReadiness.ready).toBe(true);
    expect(legacy.capabilityReadiness.missing).not.toContain("native_tool_continuation");
    expect(legacy.repairCodes).not.toContain("agentic_capability_missing_native_tool_continuation");
  });

  test("returns an explicit Response escape for slot, capability, and domain failures", async () => {
    const preset = {
      id: "preset-default",
      name: "Agentic",
      agent_config: {
        version: 2,
        agentsEnabled: true,
        allowedModes: ["response", "agentic"],
        defaultMode: "agentic",
        maxInvocations: 8,
        maxToolCalls: 8,
        mainToolIds: [],
        mainLoreScope: "active",
        profiles: [{
          id: "writer",
          name: "Writer",
          systemPrompt: "",
          connectionRef: { kind: "slot", slotId: "profile/writer" },
          toolIds: [],
          workspaceCapabilities: [],
          loreScope: "active",
          allowMainDelegation: false,
          failurePolicy: "required",
          streamActivity: false,
          maxOutputTokens: 64,
          timeoutMs: 5_000,
        }],
        connectionSlots: [{ id: "profile/writer", label: "Writer", requiredCapabilities: ["tool_calling"] }],
        slotBindings: { "profile/writer": "child" },
      },
    };
    const service = makeService({
      preset,
      connections: {
        root: connection("root"),
        child: connection("child", { fingerprint: "domain-b", capabilities: { streaming: true } }),
      },
    });
    const decision = await service.resolve(USER_ID, request());
    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.responseEscape).toBe("available");
    expect(decision.repairCodes).toEqual(expect.arrayContaining([
      "agentic_domain_mismatch",
      "agentic_capability_missing_tool_calling",
      "agentic_response_escape",
    ]));
  });

  test("public projection redacts credential references and trust fingerprints", async () => {
    const service = makeService();
    const decision = await service.resolve(USER_ID, request({ mode: "response" }));
    const publicProjection = toPublicRuntimeDecision(decision);
    const serialized = JSON.stringify(publicProjection);
    expect(serialized).not.toContain("secret-root");
    expect(serialized).not.toContain("domain-a");
    expect((publicProjection as unknown as Record<string, unknown>).internal).toBeUndefined();
  });
});

describe("effective runtime request DTO", () => {
  test("rejects unknown fields and malformed nested revisions instead of silently dropping them", () => {
    expect(() => normalizeEffectiveRuntimeRequest({ chatId: CHAT_ID, unexpected: true })).toThrow("request.unexpected is not allowed");
    expect(() => normalizeEffectiveRuntimeRequest({ chatId: CHAT_ID, target: { generationType: "normal", extra: true } })).toThrow("target.extra is not allowed");
    expect(() => normalizeEffectiveRuntimeRequest({ chatId: CHAT_ID, inputRevisions: { chat: {} } })).toThrow("inputRevisions.chat must be a revision");
  });

  test("accepts the documented aliases only when they agree and preserves a closed target", () => {
    const parsed = normalizeEffectiveRuntimeRequest({
      chat_id: CHAT_ID,
      connection_id: "logical",
      generation_type: "swipe",
      target: { generationType: "swipe", message_id: "message-1", swipeId: 2, revision: 7 },
      input_revisions: { chat: 3, message: null },
    });
    expect(parsed).toMatchObject({
      chatId: CHAT_ID,
      logicalConnectionId: "logical",
      generationType: "swipe",
      target: { generationType: "swipe", messageId: "message-1", swipeId: 2, revision: 7 },
      inputRevisions: { chat: 3, message: null },
    });
    expect(() => normalizeEffectiveRuntimeRequest({ chatId: CHAT_ID, chat_id: "different" })).toThrow("chatId has conflicting aliases");
  });
});
