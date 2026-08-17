import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as presetsSvc from "../services/presets.service";
import type { Preset } from "../types/preset";
import {
  assertSpindlePresetMutationSafe,
  projectSpindlePreset,
  SpindlePresetReservedKeyError,
  WorkerHostStateApi,
} from "./worker-host-state-api";

type WorkerResponse = {
  type: "response";
  requestId: string;
  result?: unknown;
  error?: string;
};

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

function presetFixture(): Preset {
  return {
    id: "preset-1",
    name: "Ordinary preset",
    provider: "loom",
    engine: "classic",
    parameters: { temperature: 0.7 },
    prompt_order: [{ id: "block-1", name: "System" }],
    prompts: { completionSettings: { enabled: true } },
    metadata: {
      description: "keep me",
      AgentConfig: "case-sensitive ordinary metadata",
      agentConfig: { enabled: true },
      agentConfigReviewRequired: true,
      agentConfigReview: { state: "review_required" },
      agent_config: { enabled: true },
      agent_config_review: { state: "review_required" },
      portableAgentConfig: { agentsEnabled: true },
      agentRuntime: { agentConfig: { agentsEnabled: true } },
    } as unknown as Preset["metadata"],
    agent_config: { agentsEnabled: true } as Preset["agent_config"],
    agent_config_revision: 4,
    agent_config_review: { state: "ready" } as Preset["agent_config_review"],
    cache_revision: 8,
    created_at: 100,
    updated_at: 200,
  } as unknown as Preset;
}

function makeApi(responses: WorkerResponse[]): WorkerHostStateApi {
  return new WorkerHostStateApi({
    getChatOwnerId: () => null,
    enforceScopedUser: () => {},
    resolveEffectiveUserId: () => "user-1",
    hasPermission: () => true,
    postResponse: (response) => responses.push(response),
  });
}

describe("Spindle preset reserved authority boundary", () => {
  test("rejects exact top-level authority keys and known import aliases", () => {
    const keys = [
      "agent_config",
      "agent_config_revision",
      "agent_config_review",
      "agent_config_review_required",
      "agentConfig",
      "agentConfigRevision",
      "agentConfigReview",
      "agentConfigReviewRequired",
      "portableAgentConfig",
      "portable_agent_config",
      "agentRuntime",
      "agent_runtime",
    ];

    for (const key of keys) {
      expect(() => assertSpindlePresetMutationSafe({ name: "safe", provider: "loom", [key]: {} })).toThrow(
        new SpindlePresetReservedKeyError(key),
      );
    }

    // Reservation is exact-keyed, not a broad case-insensitive filter.
    expect(() => assertSpindlePresetMutationSafe({
      name: "safe",
      provider: "loom",
      AgentConfig: "ordinary top-level extension data",
    })).not.toThrow();
  });

  test("rejects nested legacy metadata markers without stripping ordinary writes", () => {
    const metadataKeys = [
      "agentConfig",
      "agentConfigRevision",
      "agentConfigReviewRequired",
      "agentConfigReview",
      "agent_config",
      "agent_config_revision",
      "agent_config_review",
      "agent_config_review_required",
      "portableAgentConfig",
      "portable_agent_config",
      "agentRuntime",
      "agent_runtime",
    ];

    for (const key of metadataKeys) {
      expect(() => assertSpindlePresetMutationSafe({
        name: "safe",
        provider: "loom",
        metadata: { [key]: { enabled: true } },
      })).toThrow(`metadata.${key}`);
    }

    expect(() => assertSpindlePresetMutationSafe({
      name: "safe",
      provider: "loom",
      metadata: { AgentConfig: "ordinary case-sensitive metadata" },
    })).not.toThrow();
  });

  test("projects ordinary DTO fields while omitting normalized config and reserved markers", () => {
    const preset = presetFixture();
    expect(projectSpindlePreset(preset)).toEqual({
      id: preset.id,
      name: preset.name,
      provider: preset.provider,
      engine: preset.engine,
      parameters: preset.parameters,
      prompt_order: preset.prompt_order,
      prompts: preset.prompts,
      metadata: {
        description: "keep me",
        AgentConfig: "case-sensitive ordinary metadata",
      },
      cache_revision: preset.cache_revision,
      created_at: preset.created_at,
      updated_at: preset.updated_at,
    });
  });

  test("rejects create and update authority writes before presets service", () => {
    const create = spyOn(presetsSvc, "createPreset");
    const update = spyOn(presetsSvc, "updatePreset");
    spies.push(create, update);
    const responses: WorkerResponse[] = [];
    const api = makeApi(responses);

    api.dispatch({
      type: "presets_create",
      requestId: "create",
      input: { name: "unsafe", provider: "loom", metadata: { agentConfig: { enabled: true } } },
    });
    api.dispatch({
      type: "presets_update",
      requestId: "update",
      presetId: "preset-1",
      input: { expected_cache_revision: 8, agent_config_review: { state: "ready" } },
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(responses).toHaveLength(2);
    expect(responses[0]?.error).toContain("metadata.agentConfig");
    expect(responses[1]?.error).toContain("agent_config_review");
  });

  test("redacts list/get/create/update results while preserving ordinary delete behavior", () => {
    const preset = presetFixture();
    spies.push(
      spyOn(presetsSvc, "listPresets").mockReturnValue({ data: [preset], total: 1, limit: 50, offset: 0 }),
      spyOn(presetsSvc, "getPreset").mockReturnValue(preset),
      spyOn(presetsSvc, "createPreset").mockReturnValue(preset),
      spyOn(presetsSvc, "updatePreset").mockReturnValue(preset),
      spyOn(presetsSvc, "deletePreset").mockReturnValue(true),
    );
    const responses: WorkerResponse[] = [];
    const api = makeApi(responses);

    api.dispatch({ type: "presets_list", requestId: "list" });
    api.dispatch({ type: "presets_get", requestId: "get", presetId: preset.id });
    api.dispatch({
      type: "presets_create",
      requestId: "create",
      input: { name: "ordinary", provider: "loom" },
    });
    api.dispatch({
      type: "presets_update",
      requestId: "update",
      presetId: preset.id,
      input: { expected_cache_revision: preset.cache_revision },
    });
    api.dispatch({ type: "presets_delete", requestId: "delete", presetId: preset.id });

    const expected = projectSpindlePreset(preset);
    expect(responses.find((response) => response.requestId === "list")?.result).toEqual({ data: [expected], total: 1 });
    expect(responses.find((response) => response.requestId === "get")?.result).toEqual(expected);
    expect(responses.find((response) => response.requestId === "create")?.result).toEqual(expected);
    expect(responses.find((response) => response.requestId === "update")?.result).toEqual(expected);
    expect(responses.find((response) => response.requestId === "delete")?.result).toBe(true);

    for (const response of responses) {
      if (response.requestId === "delete") continue;
      const result = response.requestId === "list"
        ? (response.result as { data: Array<Record<string, unknown>> }).data[0]
        : response.result as Record<string, unknown>;
      expect(result).not.toHaveProperty("agent_config");
      expect(result).not.toHaveProperty("agent_config_review");
      expect(result).not.toHaveProperty("agent_config_revision");
      expect((result.metadata as Record<string, unknown>)).not.toHaveProperty("agentConfig");
      expect((result.metadata as Record<string, unknown>)).not.toHaveProperty("agentConfigReviewRequired");
      expect((result.metadata as Record<string, unknown>)).not.toHaveProperty("agentConfigReview");
    }
  });
});
