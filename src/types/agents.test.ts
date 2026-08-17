import { describe, expect, test } from "bun:test";
import {
  AGENT_INVOCATION_DEFAULT,
  AGENT_TOOL_CALL_DEFAULT,
  parseLegacyAgentConfigV1,
  parseAgentConfigV2,
} from "./agents";

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "writer",
    name: "Writer",
    systemPrompt: "literal",
    connectionProfileId: null,
    toolIds: ["lore_search_entries"],
    loreScope: "active",
    allowMainDelegation: true,
    failurePolicy: "required",
    streamActivity: true,
    maxOutputTokens: 64,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    maxInvocations: AGENT_INVOCATION_DEFAULT,
    maxToolCalls: AGENT_TOOL_CALL_DEFAULT,
    mainToolIds: ["chat_search_history"],
    mainLoreScope: "active",
    profiles: [profile()],
    ...overrides,
  };
}

describe("agentConfig parser", () => {
  test("returns a defensive normalized copy at exact lower bounds", () => {
    const input = config();
    const parsed = parseLegacyAgentConfigV1(input);
    expect(parsed as unknown).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.profiles).not.toBe(input.profiles);
    expect(parsed.profiles[0]).not.toBe((input.profiles as unknown[])[0]);
  });

  test("normalizes legacy version-1 configs without authored limits", () => {
    const legacy = config();
    delete legacy.maxInvocations;
    delete legacy.maxToolCalls;
    expect(parseLegacyAgentConfigV1(legacy)).toMatchObject({
      maxInvocations: AGENT_INVOCATION_DEFAULT,
      maxToolCalls: AGENT_TOOL_CALL_DEFAULT,
    });
  });

  test("accepts whole-second timeouts beyond the prior cap and rejects invalid values", () => {
    expect(parseLegacyAgentConfigV1(config({
      profiles: [profile({ maxOutputTokens: 8_192, timeoutMs: 300_000 })],
    })).profiles[0]).toMatchObject({ maxOutputTokens: 8_192, timeoutMs: 300_000 });
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ maxOutputTokens: 63 })] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ timeoutMs: 4_000 })] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ timeoutMs: 5_500 })] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({
      profiles: [profile({ timeoutMs: Number.MAX_SAFE_INTEGER + 1 })],
    }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ maxOutputTokens: Number.NaN })] }))).toThrow();
  });

  test("measures system prompts in UTF-8 bytes", () => {
    const exact = "é".repeat(16_384);
    expect(new TextEncoder().encode(exact).byteLength).toBe(32 * 1024);
    expect(parseLegacyAgentConfigV1(config({
      profiles: [profile({ systemPrompt: exact })],
    })).profiles[0]?.systemPrompt).toBe(exact);

    const overByteLimit = "😀".repeat(8_193);
    expect(new TextEncoder().encode(overByteLimit).byteLength).toBeGreaterThan(32 * 1024);
    expect(() => parseLegacyAgentConfigV1(config({
      profiles: [profile({ systemPrompt: overByteLimit })],
    }))).toThrow("UTF-8 bytes");
  });

  test("counts profile name characters by Unicode code point", () => {
    expect(parseLegacyAgentConfigV1(config({ profiles: [profile({ name: "😀".repeat(80) })] })).profiles[0]?.name).toBe("😀".repeat(80));
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ name: "😀".repeat(81) })] }))).toThrow("characters");
  });

  test("rejects unknown keys and duplicate profile/tool IDs", () => {
    expect(() => parseLegacyAgentConfigV1({ ...config(), unexpected: true })).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ unexpected: true })] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ mainToolIds: ["chat_search_history", "chat_search_history"] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile(), profile({ id: "other" })] }))).not.toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile(), profile()] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: Array.from({ length: 17 }, (_, i) => profile({ id: `p_${i}` })) }))).toThrow();
  });
  test("parses only closed V2 config and rejects legacy/prototype-key authority", () => {
    const v2 = {
      version: 2,
      agentsEnabled: true,
      allowedModes: ["response", "agentic"],
      defaultMode: "agentic",
      maxInvocations: 4,
      maxToolCalls: 4,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [],
      connectionSlots: [],
    } as const;
    expect(parseAgentConfigV2(v2)).toMatchObject({ version: 2, agentsEnabled: true });
    expect(() => parseAgentConfigV2({ ...v2, enabled: true })).toThrow();
    expect(() => parseAgentConfigV2({ ...v2, unexpected: true })).toThrow();
    const forged = JSON.parse(JSON.stringify({ ...v2, __proto__: { agentsEnabled: false } })) as Record<string, unknown>;
    Object.defineProperty(forged, "__proto__", { value: { agentsEnabled: false }, enumerable: true });
    expect(() => parseAgentConfigV2(forged)).toThrow(/unknown key/i);
  });

  test("accepts only finite safe authored limits at or above the minimum", () => {
    for (const field of ["maxInvocations", "maxToolCalls"] as const) {
      expect(parseLegacyAgentConfigV1(config({ [field]: 1 }))[field]).toBe(1);
      expect(parseLegacyAgentConfigV1(config({ [field]: Number.MAX_SAFE_INTEGER }))[field])
        .toBe(Number.MAX_SAFE_INTEGER);
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "64", null]) {
        expect(() => parseLegacyAgentConfigV1(config({ [field]: value }))).toThrow();
      }
    }
  });
});
