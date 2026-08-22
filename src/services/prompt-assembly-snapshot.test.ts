import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { hashContextPackContent } from "../types/agent-context-packs";
import {
  buildGenerationAssemblySnapshot,
  SnapshotLimitError,
  type GenerationAssemblySnapshotV1,
} from "./prompt-assembly-snapshot.service";
import {
  AssemblyPlanValidationError,
  compileAgentAssemblyPlan,
  materializeAssemblyPlan,
  parseCompileAgentAssemblyRequest,
  validateAssemblyPlanAgainstSnapshotV1,
  validateAssemblyPlanV1,
  validateAssemblySnapshotDataV1,
  SNAPSHOT_DATA_MAX_DEPTH_V1,
  SNAPSHOT_DATA_MAX_NODES_V1,
  type AssemblyMessageSegmentV1,
  type AssemblyPlanV1,
} from "./agentic-assembly-compiler";
import { parseAgenticPreprocessingResponseV1 } from "./agentic-preprocessing-worker-client";
import type { ActiveIsolateJob } from "./isolate-pool";
import { freezeCognitionGraph } from "./agent-cognition.service";
import {
  ContextPackSnapshotAccessError,
  freezeContextPackCandidateSnapshot,
} from "./agent-context-tools.service";
import { encodeCanonicalPlainData } from "../utils/canonical-plain-data";

function schema(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, character_id TEXT, name TEXT NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, generation_revision INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, index_in_chat INTEGER NOT NULL, is_user INTEGER NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, send_date INTEGER NOT NULL, swipe_id INTEGER NOT NULL, swipes TEXT NOT NULL, swipe_dates TEXT NOT NULL, extra TEXT NOT NULL, parent_message_id TEXT, branch_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, generation_revision INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE presets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, engine TEXT NOT NULL, parameters TEXT NOT NULL, prompt_order TEXT NOT NULL, metadata TEXT NOT NULL, prompts TEXT NOT NULL, updated_at INTEGER NOT NULL, cache_revision INTEGER NOT NULL)");
  db.run("CREATE TABLE characters (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, personality TEXT NOT NULL, scenario TEXT NOT NULL, first_mes TEXT NOT NULL, mes_example TEXT NOT NULL, system_prompt TEXT NOT NULL, post_history_instructions TEXT NOT NULL, extensions TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE personas (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, subjective_pronoun TEXT NOT NULL, objective_pronoun TEXT NOT NULL, possessive_pronoun TEXT NOT NULL, reflexive_pronoun TEXT NOT NULL, possessive_pronoun_standalone TEXT NOT NULL, attached_world_book_id TEXT, is_narrator INTEGER NOT NULL, is_default INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE settings (key TEXT NOT NULL, value TEXT NOT NULL, user_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, user_id))");
  db.run("CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, api_url TEXT NOT NULL, model TEXT NOT NULL, preset_id TEXT, is_default INTEGER NOT NULL, has_api_key INTEGER NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE regex_scripts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, find_regex TEXT NOT NULL, replace_string TEXT NOT NULL, actions TEXT NOT NULL, flags TEXT NOT NULL, placement TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT, target TEXT NOT NULL, trim_strings TEXT NOT NULL, disabled INTEGER NOT NULL, sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE world_books (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE world_book_entries (id TEXT PRIMARY KEY, world_book_id TEXT NOT NULL, key TEXT NOT NULL, keysecondary TEXT NOT NULL, content TEXT NOT NULL, comment TEXT NOT NULL, position INTEGER NOT NULL, depth INTEGER NOT NULL, role TEXT, order_value INTEGER NOT NULL, disabled INTEGER NOT NULL, constant INTEGER NOT NULL, sticky INTEGER NOT NULL, cooldown INTEGER NOT NULL, delay INTEGER NOT NULL, vector_index_status TEXT NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)");
  db.run("CREATE TABLE agent_context_account_state (user_id TEXT PRIMARY KEY, context_acl_revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE agent_context_packs (user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, visibility TEXT NOT NULL, state TEXT NOT NULL, latest_revision INTEGER NOT NULL, provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE agent_context_pack_revisions (user_id TEXT NOT NULL, pack_id TEXT NOT NULL, revision INTEGER NOT NULL, content_json TEXT NOT NULL, content_digest TEXT NOT NULL, token_count INTEGER NOT NULL, byte_count INTEGER NOT NULL, state TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL)");
  db.run("CREATE TABLE agent_context_pack_acls (user_id TEXT NOT NULL, pack_id TEXT NOT NULL, principal_user_id TEXT NOT NULL, permission TEXT NOT NULL)");
  db.run("CREATE TABLE agent_preset_context_pack_attachments (user_id TEXT NOT NULL, attachment_id TEXT NOT NULL, preset_id TEXT NOT NULL, pack_id TEXT NOT NULL, revision INTEGER NOT NULL, position INTEGER NOT NULL, required INTEGER NOT NULL, state TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE agent_chat_context_pack_attachments (user_id TEXT NOT NULL, attachment_id TEXT NOT NULL, chat_id TEXT NOT NULL, pack_id TEXT NOT NULL, revision INTEGER NOT NULL, position INTEGER NOT NULL, required INTEGER NOT NULL, state TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE agent_world_book_context_pack_attachments (user_id TEXT NOT NULL, attachment_id TEXT NOT NULL, world_book_id TEXT NOT NULL, pack_id TEXT NOT NULL, revision INTEGER NOT NULL, position INTEGER NOT NULL, required INTEGER NOT NULL, state TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  return db;
}

function config(): Record<string, unknown> {
  return {
    version: 2,
    agentsEnabled: true,
    allowedModes: ["response", "agentic"],
    defaultMode: "agentic",
    maxInvocations: 4,
    maxToolCalls: 4,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles: [{
      id: "writer",
      name: "Writer",
      systemPrompt: "",
      connectionRef: { kind: "inherit_main" },
      toolIds: [],
      loreScope: "active",
      allowMainDelegation: false,
      failurePolicy: "required",
      streamActivity: false,
      maxOutputTokens: 64,
      timeoutMs: 5000,
    }],
    connectionSlots: [],
    phasePolicy: { work: [], render: [] },
    cognitionPolicy: { workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
  };
}
function nestedData(depth: number): Record<string, unknown> {
  // The helper's scalar leaf is one value below its container chain. When
  // placed under a field, the test root and field value add two more levels.
  // Keep those offsets explicit so maxDepth/cap-plus-one exercise the
  // canonical value-frame convention rather than an accidental fixture depth.
  let value: Record<string, unknown> = { leaf: "ok" };
  for (let index = 0; index < depth; index += 1) value = { next: value };
  return value;
}
function contextSnapshot() {
  return freezeContextPackCandidateSnapshot({
    ownerId: "user-1",
    contextAclRevision: 3,
    candidates: [
      {
        ownerId: "user-1",
        packId: "pack-z",
        revisionId: "pack-z@2",
        revision: 2,
        digest: "digest-z",
        label: "Zeta",
        summary: "z",
        source: "chat",
        targetId: "chat-1",
        attachmentId: "attachment-z",
        attachmentRevision: JSON.stringify(["user-1", "pack-z", 2, "chat", "chat-1", "attachment-z", 1, 2, 0, "active"]),
        aclRevision: 3,
        byteCount: 8,
        tokenCount: 2,
        required: false,
        order: 2000,
      },
      {
        ownerId: "user-1",
        packId: "pack-a",
        revisionId: "pack-a@1",
        revision: 1,
        digest: "digest-a",
        label: "Alpha",
        summary: "a",
        source: "preset",
        targetId: "preset-1",
        attachmentId: "attachment-a",
        attachmentRevision: JSON.stringify(["user-1", "pack-a", 1, "preset", "preset-1", "attachment-a", 1, 1, 1, "active"]),
        aclRevision: 3,
        byteCount: 4,
        tokenCount: 1,
        required: true,
        order: 1001,
      },
    ],
  });
}
function cognitionGraph(
  ruleRequired = true,
  packId = "pack-a",
  ruleId = "rule_a",
  revisionId = "pack-a@1",
) {
  return freezeCognitionGraph({
    version: 1,
    policies: { workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
    templates: [],
    contextRules: [{
      id: ruleId,
      packId,
      revisionId,
      required: ruleRequired,
    }],
  }, cognitionSource());
}

function cognitionSource() {
  return { presetRevision: 7, blocks: [] };
}

function seed(db: Database): void {
  const blocks = [
    { id: "producer", name: "Producer", content: "{{agent::writer::as=facts}}Find facts{{/agent}}", role: "user", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
    { id: "consumer", name: "Consumer", content: "Facts: {{agentResult::facts}}", role: "user", enabled: true, position: "post_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
  ];
  db.query("INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("chat-1", "user-1", "char-1", "Chat", JSON.stringify({ chat_world_book_ids: ["book-2"], active_world_info_entry_ids: ["entry-2"], chat_variables: { mood: "calm" } }), 1, 1, 1);
  db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("message-1", "chat-1", 0, 1, "User", "hello", 1, 0, JSON.stringify(["hello"]), JSON.stringify([1]), "{}", null, null, 1, 1, 1);
  db.query("INSERT INTO characters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("char-1", "user-1", "Aria", "desc", "personality", "scenario", "hello", "example", "", "", JSON.stringify({ world_book_ids: ["book-1"] }), 2);
  db.query("INSERT INTO personas VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("persona-1", "user-1", "Me", "", "", "I", "me", "my", "myself", "mine", null, 0, 1, 1);
  db.query("INSERT INTO presets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("preset-1", "user-1", "Preset", "loom", "classic", "{}", JSON.stringify(blocks), "{}", "{}", 3, 7);
  db.query("INSERT INTO connection_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("connection-1", "user-1", "Main", "openai", "http://provider", "model", "preset-1", 1, 1, "{}", 4);
  db.query("INSERT INTO settings VALUES (?, ?, ?, ?)").run("globalWorldBooks", JSON.stringify(["book-1"]), "user-1", 5);
  db.query("INSERT INTO world_books VALUES (?, ?, ?, ?, ?, ?)").run("book-1", "user-1", "Character lore", "", "{}", 2);
  db.query("INSERT INTO world_books VALUES (?, ?, ?, ?, ?, ?)").run("book-2", "user-1", "Chat lore", "", "{}", 2);
  db.query("INSERT INTO world_book_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("entry-1", "book-1", JSON.stringify(["one"]), "[]", "one", "One", 0, 4, "system", 2, 0, 0, 0, 0, 0, "not_enabled", 1, 1);
  db.query("INSERT INTO world_book_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("entry-2", "book-2", JSON.stringify(["two"]), "[]", "two", "Two", 0, 4, "system", 1, 0, 1, 0, 0, 0, "not_enabled", 1, 1);
  db.query("INSERT INTO regex_scripts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("regex-1", "user-1", "safe", "foo", "bar", "[]", "gi", JSON.stringify(["ai_output"]), "global", null, JSON.stringify(["prompt"]), "[]", 0, 0, 1, 1);
  db.query("INSERT INTO regex_scripts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("regex-invalid", "user-1", "invalid", "[", "", "[]", "gi", JSON.stringify(["ai_output"]), "global", null, JSON.stringify(["prompt"]), "[]", 0, 1, 1, 1);
  db.query("INSERT INTO agent_context_account_state VALUES (?, ?, ?)").run("user-1", 3, 1);
  const contextPacks = [
    ["pack-a", "Alpha", "a", "private", "active", 1, "digest-a", 1, 4],
    ["pack-z", "Zeta", "z", "private", "active", 2, "digest-z", 2, 8],
    ["pack-account", "Account", "account", "private", "active", 1, "digest-account", 1, 4],
    ["pack-rule", "Rule", "rule", "private", "active", 2, "digest-rule", 2, 8],
  ] as const;
  for (const [packId, name, description, visibility, state, latestRevision, digest, tokenCount, byteCount] of contextPacks) {
    db.query("INSERT INTO agent_context_packs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "user-1", packId, name, description, visibility, state, latestRevision, JSON.stringify({ kind: "local" }), 1, 1,
    );
    db.query("INSERT INTO agent_context_pack_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "user-1", packId, latestRevision, "[]", digest, tokenCount, byteCount, "active", JSON.stringify({ kind: "local" }), 1, "user-1",
    );
  }
  db.query("INSERT INTO agent_context_pack_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "user-1", "pack-z", 1, "[]", "digest-z-old", 1, 4, "active", JSON.stringify({ kind: "local" }), 1, "user-1",
  );
  db.query("INSERT INTO agent_context_pack_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "user-1", "pack-rule", 1, "[]", "digest-rule-old", 1, 4, "active", JSON.stringify({ kind: "local" }), 1, "user-1",
  );
  db.query("INSERT INTO agent_preset_context_pack_attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "user-1", "attachment-a", "preset-1", "pack-a", 1, 1, 1, "active", JSON.stringify({ kind: "local" }), 1, 1,
  );
  db.query("INSERT INTO agent_chat_context_pack_attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "user-1", "attachment-z", "chat-1", "pack-z", 2, 2, 0, "active", JSON.stringify({ kind: "local" }), 1, 1,
  );
}

function seedCanonicalContextDb(db: Database): void {
  db.run("DELETE FROM agent_preset_context_pack_attachments");
  db.run("DELETE FROM agent_chat_context_pack_attachments");
  db.run("DELETE FROM agent_world_book_context_pack_attachments");
  db.run("DELETE FROM agent_context_pack_acls");
  db.run("DELETE FROM agent_context_pack_revisions");
  db.run("DELETE FROM agent_context_packs");
  db.run("DELETE FROM agent_context_account_state");
  const serialized = "[]";
  const digest = hashContextPackContent(serialized);
  db.query("INSERT INTO agent_context_account_state VALUES (?, ?, ?)").run("user-1", 11, 1);
  db.query("INSERT INTO agent_context_packs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("user-1", "pack-db", "Database Pack", "", "private", "active", 1, JSON.stringify({ kind: "local" }), 1, 1);
  db.query("INSERT INTO agent_context_pack_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("user-1", "pack-db", 1, serialized, digest, 0, 2, "active", JSON.stringify({ kind: "local" }), 1, "user-1");
  db.query("INSERT INTO agent_preset_context_pack_attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("user-1", "attachment-db", "preset-1", "pack-db", 1, 0, 1, "active", JSON.stringify({ kind: "local" }), 1, 1);
}

describe("GenerationAssemblySnapshotV1", () => {
  test("captures one bounded view, complete revisions, deterministic lore, and no extension data", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", connectionId: "connection-1", agentConfig: config(), contextPackSnapshot: contextSnapshot(), contextPackSnapshotSource: "host_prefetched", db });
    expect(snapshot.assemblySurface).toBe("WORK");
    db.query("UPDATE messages SET content = ? WHERE id = ?").run("changed after snapshot", "message-1");
    expect(snapshot.messages[0]?.content).toBe("hello");
    expect(snapshot.worldInfo.entries.map((entry) => entry.id)).toEqual(["entry-1", "entry-2"]);
    expect(snapshot.regexScripts.map((script) => script.id)).toEqual(["regex-1"]);
    expect(snapshot.extensionData).toBeNull();
    expect(snapshot.ambientSpindleData).toBeNull();
    expect(snapshot.inputRevisionSet.entries.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "target", "chat", "message", "preset", "preset_block", "config", "slot_binding", "connection", "endpoint", "credential",
      "persona", "character", "world_lore", "settings", "macro_variables", "regex", "context_pack", "context_attachment", "context_acl", "cognition_policy", "runtime_epoch", "readiness",
    ]));
    db.close();
  });

  test("lowers test caps and rejects oversized input before strict preparation", async () => {
    const db = schema();
    seed(db);
    expect(() => buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", contextPackSnapshot: contextSnapshot(), contextPackSnapshotSource: "host_prefetched", db, limits: { inputBytes: 2 } })).toThrow(SnapshotLimitError);
    db.close();
  });
  test("sorts frozen context candidates and rejects duplicate revisions", async () => {
    const frozen = contextSnapshot();
    expect(frozen.candidates.map((candidate) => candidate.packId)).toEqual(["pack-a", "pack-z"]);
    expect(frozen.candidateInputRevisions.map((revision) => revision.packId)).toEqual(["pack-a", "pack-z"]);
    expect(() => freezeContextPackCandidateSnapshot({
      ownerId: "user-1",
      contextAclRevision: 3,
      candidates: [...frozen.candidates, frozen.candidates[0]!],
    })).toThrow("duplicate context candidate");
  });
  test("rejects forged context scope and stale candidate identity", async () => {
    const db = schema();
    seed(db);
    const original = contextSnapshot();
    const forgedScope = {
      ...original,
      candidates: [
        { ...original.candidates[0]!, targetId: "other-chat" },
        original.candidates[1]!,
      ],
    };
    expect(() => buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      contextPackSnapshot: forgedScope,
      contextPackSnapshotSource: "host_prefetched",
      db,
    })).toThrow(/scope mismatch/i);
    const staleIdentity = {
      ...original,
      candidateInputRevisions: original.candidateInputRevisions.map((revision, index) =>
        index === 0 ? { ...revision, digest: "stale-digest" } : revision),
    };
    expect(() => buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      contextPackSnapshot: staleIdentity,
      contextPackSnapshotSource: "host_prefetched",
      db,
    })).toThrow(/identity mismatch/i);
    seedCanonicalContextDb(db);
    const rebuilt: GenerationAssemblySnapshotV1 = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      contextPackSnapshot: forgedScope,
      db,
    });
    expect(rebuilt?.contextPackSnapshot.candidates.map((candidate) => ({
      packId: candidate.packId,
      source: candidate.source,
      targetId: candidate.targetId,
    }))).toEqual([{ packId: "pack-db", source: "preset", targetId: "preset-1" }]);
    db.close();
  });
  test("fails required selected context packs while allowing optional omissions", async () => {
    const db = schema();
    seed(db);
    const empty = freezeContextPackCandidateSnapshot({
      ownerId: "user-1",
      contextAclRevision: 3,
      candidates: [],
    });
    expect(() => buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: { ...config(), contextPolicy: { ruleIds: [], packIds: ["pack_required"] } },
      contextPackSnapshot: empty,
      contextPackSnapshotSource: "host_prefetched",
      db,
    })).toThrow(ContextPackSnapshotAccessError);
    expect(() => buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      contextPackSelections: [{ packId: "pack-optional", required: false }],
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    })).not.toThrow();
    expect(() => buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      contextPackSelections: [{
        packId: "pack-a",
        revisionId: "pack-a@1",
        revision: 1,
        digest: "stale-digest",
        required: true,
      }],
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    })).toThrow(ContextPackSnapshotAccessError);
    db.close();
  });
  test("freezes canonical context policy selections, source graph, and permitted candidate order", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: { ...config(), contextPolicy: { ruleIds: ["rule_a"], packIds: ["pack-a"] } },
      cognitionGraph: cognitionGraph(),
      cognitionSource: cognitionSource(),
      contextPackSelections: [{
        packId: "pack-a",
        revisionId: "pack-a@1",
        revision: 1,
        digest: "digest-a",
        required: true,
      }],
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    expect(snapshot.contextPacks.candidates.map((candidate) => candidate.packId)).toEqual(["pack-a", "pack-z"]);
    expect(snapshot.contextPacks.contextPackSelections).toEqual([{
      packId: "pack-a",
      revisionId: "pack-a@1",
      revision: 1,
      digest: "digest-a",
      required: true,
    }]);
    expect(snapshot.contextPacks.contextRules.map((rule) => rule.id)).toEqual(["rule_a"]);
    expect(snapshot.contextPacks.cognitionGraph?.contextRules[0]?.revisionId).toBe("pack-a@1");
    expect(snapshot.contextPacks.cognitionSource).toEqual(cognitionSource());
    db.close();
  });

  test("retains optional target attachments while separating direct and inactive rule account requirements", async () => {
    const db = schema();
    seed(db);
    const attached = contextSnapshot();
    const directAccount = {
      ...attached.candidates[0]!,
      packId: "pack-account",
      revisionId: "pack-account@1",
      revision: 1,
      digest: "digest-account",
      source: "account" as const,
      targetId: null,
      attachmentId: null,
      attachmentRevision: null,
      order: 0,
      required: false,
    };
    const ruleAccount = {
      ...attached.candidates[1]!,
      packId: "pack-rule",
      revisionId: "pack-rule@2",
      revision: 2,
      digest: "digest-rule",
      source: "account" as const,
      targetId: null,
      attachmentId: null,
      order: 1,
      attachmentRevision: null,
      required: false,
    };
    const candidates = freezeContextPackCandidateSnapshot({
      ownerId: "user-1",
      contextAclRevision: 3,
      candidates: [...attached.candidates, directAccount, ruleAccount],
    });
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: { ...config(), contextPolicy: { ruleIds: ["rule_rule"], packIds: ["pack-account"] } },
      cognitionGraph: cognitionGraph(true, "pack-rule", "rule_rule", "pack-rule@2"),
      cognitionSource: cognitionSource(),
      contextPackSelections: [
        { packId: "pack-account", revisionId: "pack-account@1", revision: 1, digest: "digest-account", required: false },
        { packId: "pack-rule", revisionId: "pack-rule@2", revision: 2, digest: "digest-rule", required: false },
      ],
      contextPackSnapshot: candidates,
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    expect(snapshot.contextPacks.candidates.map((candidate) => candidate.packId)).toEqual([
      "pack-a", "pack-z", "pack-account", "pack-rule",
    ]);
    expect(snapshot.contextPacks.candidates.find((candidate) => candidate.packId === "pack-a")?.required).toBe(true);
    expect(snapshot.contextPacks.candidates.find((candidate) => candidate.packId === "pack-rule")?.required).toBe(false);
    expect(snapshot.contextPacks.contextRules[0]?.required).toBe(true);
    expect(snapshot.contextPacks.contextPackSelections).toEqual([
      { packId: "pack-account", revisionId: "pack-account@1", revision: 1, digest: "digest-account", required: false },
    ]);
    db.close();
  });

  test("requires authenticated graph/source and host-prefetched candidates for policy", async () => {
    const db = schema();
    seed(db);
    const base = {
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: { ...config(), contextPolicy: { ruleIds: [], packIds: ["pack-a"] } },
      contextPackSelections: [{
        packId: "pack-a",
        revisionId: "pack-a@1",
        revision: 1,
        digest: "digest-a",
        required: true,
      }],
      db,
    };
    expect(() => buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      ...base,
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: undefined,
    })).toThrow(ContextPackSnapshotAccessError);
    expect(() => buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      ...base,
      cognitionGraph: cognitionGraph(),
      cognitionSource: { ...cognitionSource(), presetRevision: 8 },
    })).toThrow(/cognition graph source revision mismatch/i);
    db.close();
  });

  test("accepts account candidates with nullable attachment fields and rejects policy revision mismatches", async () => {
    const db = schema();
    seed(db);
    const accountCandidate = freezeContextPackCandidateSnapshot({
      ownerId: "user-1",
      contextAclRevision: 3,
      candidates: [
        ...contextSnapshot().candidates,
        {
          ...contextSnapshot().candidates[1]!,
          packId: "pack-account",
          revisionId: "pack-account@1",
          revision: 1,
          digest: "digest-account",
          targetId: null,
          attachmentId: null,
          attachmentRevision: null,
          order: 0,
          source: "account",
          required: true,
        },
      ],
    });
    const input = {
      assemblySurface: "WORK" as const,
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: { ...config(), contextPolicy: { ruleIds: [], packIds: ["pack-account"] } },
      contextPackSelections: [{
        packId: "pack-account",
        revisionId: "pack-account@1",
        revision: 1,
        digest: "digest-account",
        required: true,
      }],
      contextPackSnapshot: accountCandidate,
      contextPackSnapshotSource: "host_prefetched" as const,
      db,
    };
    expect(buildGenerationAssemblySnapshot(input).contextPacks.candidates.find((candidate) => candidate.packId === "pack-account")?.attachmentId).toBeNull();
    expect(() => buildGenerationAssemblySnapshot({
      ...input,
      contextPackSelections: [{ ...input.contextPackSelections[0], digest: "wrong" }],
    })).toThrow(ContextPackSnapshotAccessError);
    db.close();
  });

});
async function compiledAssemblyPlan(): Promise<AssemblyPlanV1> {
  const db = schema();
  seed(db);
  const snapshot = buildGenerationAssemblySnapshot({
    assemblySurface: "WORK",
    userId: "user-1",
    chatId: "chat-1",
    presetId: "preset-1",
    agentConfig: config(),
    contextPackSnapshot: contextSnapshot(),
    contextPackSnapshotSource: "host_prefetched",
    db,
  });
  const plan = await compileAgentAssemblyPlan(snapshot);
  db.close();
  return plan;
}
async function compiledAssemblyFixture(): Promise<{ snapshot: GenerationAssemblySnapshotV1; plan: AssemblyPlanV1 }> {
  const db = schema();
  seed(db);
  const snapshot = buildGenerationAssemblySnapshot({
    assemblySurface: "WORK",
    userId: "user-1",
    chatId: "chat-1",
    presetId: "preset-1",
    agentConfig: config(),
    contextPackSnapshot: contextSnapshot(),
    contextPackSnapshotSource: "host_prefetched",
    db,
  });
  const plan = await compileAgentAssemblyPlan(snapshot);
  db.close();
  return { snapshot, plan };
}
function policyEntry(blockId: string, blockIndex = 0): AssemblyPlanV1["loomPolicy"]["workPolicy"][number] {
  return {
    version: 1,
    id: `fixture-${blockId}`,
    source: {
      kind: "loom_block",
      blockId,
      presetRevision: 1,
      blockRevision: 1,
      promptOrder: blockIndex,
    },
    destination: "root_work",
    checkpoint: "WORK",
    required: false,
    visibility: "work_only",
    delivery: { delivery: "direct" },
  };
}
function withWorkPolicyEntries(
  plan: AssemblyPlanV1,
  entries: readonly AssemblyPlanV1["loomPolicy"]["workPolicy"][number][],
): AssemblyPlanV1 {
  return {
    ...plan,
    loomPolicy: {
      ...plan.loomPolicy,
      workPolicy: entries,
    },
  };
}
function literalSegment(text: string): AssemblyMessageSegmentV1 {
  const segment: AssemblyMessageSegmentV1 = {
    kind: "literal",
    text,
    bytes: new TextEncoder().encode(text).byteLength,
  };
  return segment;
}
function policyMessage(blockId: string, blockIndex = 0): AssemblyPlanV1["workPolicyMessages"][number] {
  const text = `policy-${blockId}`;
  const entry = policyEntry(blockId, blockIndex);
  return {
    role: "system",
    blockId,
    blockIndex,
    contentKind: "segments",
    provenance: {
      kind: "cognition",
      sourceId: blockId,
      sourceRevision: "1",
      sourceIndex: blockIndex,
      loom: {
        entryId: entry.id,
        bucket: "workPolicy",
        destination: entry.destination,
        checkpoint: entry.checkpoint,
        source: entry.source,
        delivery: entry.delivery,
        effectiveText: text,
      },
    },
    segments: [literalSegment(text)],
  };
}

describe("strict assembly input boundaries", () => {
  test("accepts only closed AgentConfig V2 and never treats legacy enabled as authority", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    await expect(compileAgentAssemblyPlan({
      snapshot,
      agentConfig: {
        version: 1,
        enabled: true,
        maxInvocations: 4,
        maxToolCalls: 4,
        mainToolIds: [],
        mainLoreScope: "active",
        profiles: [],
      },
    })).rejects.toThrow(AssemblyPlanValidationError);
    await expect(compileAgentAssemblyPlan({
      snapshot,
      agentConfig: { ...config(), unknown: true },
    })).rejects.toThrow(AssemblyPlanValidationError);
    expect((await compileAgentAssemblyPlan(snapshot)).children).toHaveLength(1);
    db.close();
  });

  test("rejects cap-plus-one depth and node data iteratively across snapshot fields", async () => {
    const exactCapDepth = SNAPSHOT_DATA_MAX_DEPTH_V1 - 2;
    const capPlusOneDepth = exactCapDepth + 1;
    for (const field of ["metadata", "extra", "variables"] as const) {
      expect(() => validateAssemblySnapshotDataV1({
        [field]: nestedData(exactCapDepth),
      })).not.toThrow();
      expect(() => validateAssemblySnapshotDataV1({
        [field]: nestedData(capPlusOneDepth),
      })).toThrow(/depth/i);
    }
    expect(() => validateAssemblySnapshotDataV1(
      { metadata: { value: "ok" } },
      { maxNodes: 5 },
    )).not.toThrow();
    expect(() => validateAssemblySnapshotDataV1(
      { metadata: { value: "ok", extra: "cap-plus-one" } },
      { maxNodes: 5 },
    )).toThrow(/nodes/i);
    expect(SNAPSHOT_DATA_MAX_NODES_V1).toBeGreaterThan(5);
  });
  test("uses deterministic key order for canonical snapshot data", async () => {
    expect(encodeCanonicalPlainData({ z: 1, a: { d: 4, b: 2 }, m: [3, 1] })).toBe("{\"a\":{\"b\":2,\"d\":4},\"m\":[3,1],\"z\":1}");
    expect(encodeCanonicalPlainData({ a: 1, z: 2 })).toBe(encodeCanonicalPlainData({ z: 2, a: 1 }));
  });

  test("fails closed when an active regex row carries a repair code", async () => {
    const db = schema();
    seed(db);
    db.run("ALTER TABLE regex_scripts ADD COLUMN validation_error_code TEXT");
    db.query("UPDATE regex_scripts SET validation_error_code = ? WHERE id = ?").run("pattern_too_large", "regex-1");
    expect(() => buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    })).toThrow(/requires_response_mode.*repair/i);
    db.close();
  });
});
describe("strict assembly plan", () => {
  test("orders children, emits direct slots, and substitutes child output once as literal bytes", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), contextPackSnapshot: contextSnapshot(), contextPackSnapshotSource: "host_prefetched", db });
    const plan = await compileAgentAssemblyPlan(snapshot);
    expect(plan.assemblySurface).toBe("WORK");
    const wireSnapshot = JSON.parse(JSON.stringify(snapshot)) as GenerationAssemblySnapshotV1;
    expect((await compileAgentAssemblyPlan(wireSnapshot)).children.map((child) => child.slotIndex)).toEqual([0]);
    expect(plan.children.map((child) => child.slotIndex)).toEqual([0]);
    expect(plan.children[0]?.maxOutputTokens).toBe(64);
    expect(plan.resultSlots[0]?.slotIndex).toBe(0);
    const materialized = materializeAssemblyPlan(plan, ["{{regex_should_not_run}}"], plan.limits);
    const segments = materialized.flatMap((message) => message.segments);
    expect(segments.some((segment) => segment.kind === "literal" && segment.text === "{{regex_should_not_run}}" && segment.text.includes("{{"))).toBe(true);
    db.close();
  });
  test("rejects a Response snapshot at the strict compiler boundary", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    await expect(compileAgentAssemblyPlan({
      ...snapshot,
      assemblySurface: "RESPONSE",
    })).rejects.toThrow(/WORK surface/i);
    db.close();
  });
  test("places in-history blocks at their frozen depth between history boundaries", async () => {
    const db = schema();
    seed(db);
    const initial = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), contextPackSnapshot: contextSnapshot(), contextPackSnapshotSource: "host_prefetched", db });
    const producer = initial.blocks.find((block) => block.id === "producer")!;
    const consumer = initial.blocks.find((block) => block.id === "consumer")!;
    const inHistory = { ...producer, id: "in-history", name: "In history", content: "Between history", position: "in_history" as const, depth: 0 };
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify([producer, inHistory, consumer]), "preset-1");
    const snapshot = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), contextPackSnapshot: contextSnapshot(), contextPackSnapshotSource: "host_prefetched", db });
    const plan = await compileAgentAssemblyPlan(snapshot);
    expect(plan.providerMessages.map((message) => message.blockId ?? "history")).toEqual(["history", "producer", "history", "in-history", "consumer"]);
    db.close();
  });

  test("rejects transformed, recursive, and out-of-order result references", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), contextPackSnapshot: contextSnapshot(), contextPackSnapshotSource: "host_prefetched", db });
    const transformed = {
      ...snapshot,
      blocks: snapshot.blocks.map((block) => block.id === "consumer"
        ? { ...block, content: "{{upper::{{agentResult::facts}}}}" }
        : block),
    };
    await expect(compileAgentAssemblyPlan(transformed)).rejects.toThrow(AssemblyPlanValidationError);
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify([...snapshot.blocks].reverse()), "preset-1");

    const reversed = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), contextPackSnapshot: contextSnapshot(), contextPackSnapshotSource: "host_prefetched", db });
    await expect(compileAgentAssemblyPlan(reversed)).rejects.toThrow(/forward|precede|order/i);
    const recursiveBlocks = snapshot.blocks.map((block) => block.id === "producer"
      ? { ...block, content: "{{agent::writer::as=facts}}{{agentResult::facts}}{{/agent}}" }
      : block);
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(recursiveBlocks), "preset-1");
    const recursive = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), contextPackSnapshot: contextSnapshot(), contextPackSnapshotSource: "host_prefetched", db });
    await expect(compileAgentAssemblyPlan(recursive)).rejects.toThrow(/recursive|result reference|nested_intrinsic/i);
    db.close();
  });
  test("round-trips closed cognition evidence and rejects public text", async () => {
    const plan = await compiledAssemblyPlan();
    const wire = JSON.parse(JSON.stringify(plan)) as AssemblyPlanV1;
    expect(() => validateAssemblyPlanV1(wire, plan.limits)).not.toThrow();
    expect(wire.privateEvidence.cognition).toEqual([]);
    const cognition = {
      kind: "cognition_phase" as const,
      phase: "WORK" as const,
      section: "workPolicy" as const,
      blockId: "policy",
      expectedPresetRevision: 1,
      expectedBlockRevision: 1,
      actualPresetRevision: 1,
      actualBlockRevision: 1,
      order: 0,
      promptOrder: 0,
      decision: "selected" as const,
      ruleSourceRevision: "1:1",
      tokenCost: 1,
      byteCost: 0,
    };
    const forged = {
      ...wire,
      privateEvidence: {
        ...wire.privateEvidence,
        cognition: [{ ...cognition, text: "must-not-cross-wire" }],
      },
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/private cognition|private assembly|cognition activation/i);
  });
  test("rejects escaped macros that restore protected child markers", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    const escapedBlocks = snapshot.blocks.map((block) => block.id === "consumer"
      ? { ...block, content: "\\{\\{agent::writer::as=facts\\}\\}generated\\{\\{/agent\\}\\} {{name}}" }
      : block);
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(escapedBlocks), "preset-1");
    const escapedSnapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    await expect(compileAgentAssemblyPlan(escapedSnapshot)).rejects.toThrow(/generated|result reference|agent marker/i);
    db.close();
  });
  test("rejects prompt regex replacements that generate protected result markers", async () => {
    const db = schema();
    seed(db);
    db.query("UPDATE regex_scripts SET replace_string = ?, placement = ? WHERE id = ?").run("{{agentResult::facts}}", JSON.stringify(["user_input"]), "regex-1");
    const row = db.query<{ prompt_order: string }, ["preset-1"]>("SELECT prompt_order FROM presets WHERE id = ?").get("preset-1");
    const blocks = JSON.parse(row?.prompt_order ?? "[]") as Array<Record<string, unknown>>;
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(blocks.map((block) => block.id === "consumer" ? { ...block, content: "foo" } : block)), "preset-1");
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    await expect(compileAgentAssemblyPlan(snapshot)).rejects.toThrow(/generated_result_reference|generated.*result marker/i);
    db.close();
  });
  test("accepts a transformed block that becomes empty", async () => {
    const db = schema();
    seed(db);
    db.query("UPDATE regex_scripts SET replace_string = ?, placement = ? WHERE id = ?").run("", JSON.stringify(["user_input"]), "regex-1");
    const row = db.query<{ prompt_order: string }, ["preset-1"]>("SELECT prompt_order FROM presets WHERE id = ?").get("preset-1");
    const blocks = JSON.parse(row?.prompt_order ?? "[]") as Array<Record<string, unknown>>;
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(blocks.map((block) => block.id === "consumer" ? { ...block, content: "foo" } : block)), "preset-1");
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    const plan = await compileAgentAssemblyPlan(snapshot);
    expect(plan.providerMessages.some((message) => message.blockId === "consumer")).toBe(false);
    await expect(validateAssemblyPlanAgainstSnapshotV1(plan, snapshot)).resolves.toBeUndefined();
    db.close();
  });
  test("emits one prompt regex action when a script transforms multiple blocks", async () => {
    const db = schema();
    seed(db);
    db.query("UPDATE regex_scripts SET placement = ? WHERE id = ?").run(JSON.stringify(["user_input"]), "regex-1");
    db.query("INSERT INTO regex_scripts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "regex-2", "user-1", "nonmatching", "nope", "bar", "[]", "gi", JSON.stringify(["user_input"]), "global", null,
      JSON.stringify(["prompt"]), "[]", 0, 0, 1, 1,
    );
    const row = db.query<{ prompt_order: string }, ["preset-1"]>("SELECT prompt_order FROM presets WHERE id = ?").get("preset-1");
    const blocks = JSON.parse(row?.prompt_order ?? "[]") as Array<Record<string, unknown>>;
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(
      blocks.map((block) => ({ ...block, content: "foo", role: "user" })),
    ), "preset-1");
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    const plan = await compileAgentAssemblyPlan(snapshot);
    const regexDeltas = plan.deltas.filter((delta) => delta.kind === "regex_action");
    expect(regexDeltas).toHaveLength(1);
    expect(regexDeltas[0]).toMatchObject({ scriptId: "regex-1", operation: "apply" });
    db.close();
  });
  test("persists a world-info cooldown transition when it reaches zero", async () => {
    const db = schema();
    seed(db);
    const metadata = {
      chat_world_book_ids: ["book-2"],
      active_world_info_entry_ids: ["entry-2"],
      chat_variables: { mood: "calm" },
      wi_state: {
        "entry-1": { active: false, stickyLeft: 0, cooldownLeft: 1, delayCount: 0 },
      },
    };
    db.query("UPDATE chats SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), "chat-1");
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    const plan = await compileAgentAssemblyPlan(snapshot);
    const delta = plan.deltas.find((candidate) => candidate.kind === "world_info_state" && candidate.entryId === "entry-1");
    expect(delta).toMatchObject({
      operation: "set_cooldown",
      state: "cooldown",
      afterState: { active: false, stickyLeft: 0, cooldownLeft: 0, delayCount: 0 },
    });
    db.close();
  });

  test("requires trusted snapshot limits for plans received from an isolate", async () => {
    const plan = await compiledAssemblyPlan();
    const trusted = { ...plan.limits, maxInputBytes: 1024 };
    const widened = { ...plan, limits: { ...plan.limits, maxInputBytes: 2048 } };
    expect(() => validateAssemblyPlanV1(widened, trusted)).toThrow(/trusted|limit/i);
  });

  test("binds profile output ceilings to the authenticated snapshot", async () => {
    const { snapshot, plan } = await compiledAssemblyFixture();
    expect(plan.profileOutputLimits).toEqual([{ profileId: "writer", maxOutputTokens: 64 }]);
    const forged = {
      ...plan,
      profileOutputLimits: plan.profileOutputLimits.map((limit) => ({
        ...limit,
        maxOutputTokens: limit.maxOutputTokens + 1,
      })),
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).not.toThrow();
    await expect(validateAssemblyPlanAgainstSnapshotV1(forged, snapshot)).rejects.toThrow(/profile output limits|snapshot/i);
  });

  test("requires one-to-one cognition evidence with exact message accounting", async () => {
    const plan = await compiledAssemblyPlan();
    const message = policyMessage("policy");
    const byteCost = message.segments.reduce((total, segment) => total + (segment.kind === "literal" ? new TextEncoder().encode(segment.text).byteLength : 0), 0);
    const evidence = {
      kind: "cognition_phase" as const,
      phase: "WORK" as const,
      section: "workPolicy" as const,
      blockId: "policy",
      expectedPresetRevision: 1,
      expectedBlockRevision: 1,
      actualPresetRevision: 1,
      actualBlockRevision: 1,
      order: 0,
      promptOrder: 0,
      decision: "selected" as const,
      ruleSourceRevision: "1:1",
      tokenCost: Math.max(1, Math.ceil(byteCost / 4)),
      byteCost,
    };
    const valid = {
      ...withWorkPolicyEntries(plan, [policyEntry("policy")]),
      workPolicyMessages: [message],
      privateEvidence: { ...plan.privateEvidence, cognition: [evidence] },
    };
    expect(() => validateAssemblyPlanV1(valid, plan.limits)).not.toThrow();
    expect(() => validateAssemblyPlanV1({ ...valid, privateEvidence: { ...valid.privateEvidence, cognition: [] } }, plan.limits)).toThrow(/cognition evidence/i);
    expect(() => validateAssemblyPlanV1({
      ...valid,
      privateEvidence: { ...valid.privateEvidence, cognition: [{ ...evidence, byteCost: byteCost + 1 }] },
    }, plan.limits)).toThrow(/cognition evidence|accounting/i);
  });

  test("snapshots unversioned Loom blocks at authoring revision 1 and compiles empty phase policy messages", async () => {
    const db = schema();
    seed(db);
    const policyBlocks = [
      { id: "policy-work", name: "Work", content: "work-policy", role: "system", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "policy-usage", name: "Usage", content: "usage-policy", role: "system", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "policy-complete", name: "Complete", content: "{{loomSummary}}", role: "system", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "policy-render", name: "Render", content: "render-policy", role: "system", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
    ];
    const row = db.query<{ prompt_order: string }, ["preset-1"]>("SELECT prompt_order FROM presets WHERE id = ?").get("preset-1");
    const existing = JSON.parse(row?.prompt_order ?? "[]") as Array<Record<string, unknown>>;
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify([...existing, ...policyBlocks]), "preset-1");
    const source = {
      presetRevision: 7,
      blocks: policyBlocks.map((block, promptOrder) => ({ blockId: block.id, revision: 1, promptOrder: existing.length + promptOrder })),
    };
    const policyEntryFor = (
      bucket: "workPolicy" | "workspaceUsage" | "completionCriteria" | "renderPolicy",
      blockId: string,
      destination: "root_work" | "completion_handoff" | "render",
      checkpoint: "WORK" | "PREPARE_COMMIT" | "RENDER",
      promptOrder: number,
    ) => ({
      version: 1 as const,
      id: `unversioned-${bucket}`,
      source: {
        kind: "loom_block" as const,
        blockId,
        presetRevision: 7,
        blockRevision: 1,
        promptOrder,
      },
      destination,
      checkpoint,
      required: false,
      visibility: "work_only" as const,
      delivery: { delivery: "direct" as const },
    });
    const cognitionPolicy = {
      version: 1 as const,
      workPolicy: [policyEntryFor("workPolicy", "policy-work", "root_work", "WORK", existing.length)],
      workspaceUsage: [policyEntryFor("workspaceUsage", "policy-usage", "root_work", "WORK", existing.length + 1)],
      completionCriteria: [policyEntryFor("completionCriteria", "policy-complete", "completion_handoff", "PREPARE_COMMIT", existing.length + 2)],
      renderPolicy: [policyEntryFor("renderPolicy", "policy-render", "render", "RENDER", existing.length + 3)],
    };
    const graph = freezeCognitionGraph({
      version: 1,
      policies: { workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
      templates: [],
      contextRules: [],
    }, source);
    const canonicalConfig = { ...config() };
    delete canonicalConfig.phasePolicy;
    delete canonicalConfig.cognitionPolicy;
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: {
        ...canonicalConfig,
        runtimePolicy: {
          version: 1,
          authority: "loom",
          scope: "preset",
          defaultMode: "agentic",
          loomPolicy: cognitionPolicy,
        },
      },
      cognitionGraph: graph,
      cognitionSource: source,
      contextPackSnapshot: contextSnapshot(),
      contextPackSnapshotSource: "host_prefetched",
      db,
    });
    expect(snapshot.blocks.filter((block) => block.id.startsWith("policy-")).map((block) => block.revision)).toEqual(["1", "1", "1", "1"]);
    const plan = await compileAgentAssemblyPlan(snapshot);
    expect(plan.loomPolicy).toMatchObject({
      version: 1,
      workPolicy: [{
        destination: "root_work",
        checkpoint: "WORK",
        source: {
          kind: "loom_block",
          blockId: "policy-work",
          presetRevision: 7,
          blockRevision: 1,
          promptOrder: existing.length,
        },
      }],
      workspaceUsage: [{
        destination: "root_work",
        checkpoint: "WORK",
      }],
      completionCriteria: [{
        destination: "completion_handoff",
        checkpoint: "PREPARE_COMMIT",
      }],
      renderPolicy: [{
        destination: "render",
        checkpoint: "RENDER",
      }],
    });
    expect(plan.loomBlocks.map((block) => block.source.blockId)).toEqual([
      "policy-work",
      "policy-usage",
      "policy-complete",
      "policy-render",
    ]);
    expect(plan.workPolicyMessages).toHaveLength(1);
    expect(plan.workspaceUsageMessages).toHaveLength(1);
    expect(plan.completionCriteriaMessages).toHaveLength(1);
    expect(plan.renderPolicyMessages).toHaveLength(1);
    expect(plan.completionCriteriaMessages[0]?.segments).toMatchObject([{ kind: "literal", text: "" }]);
    expect(plan.completionCriteriaMessages[0]?.provenance).toMatchObject({
      kind: "cognition",
      sourceId: "policy-complete",
      sourceRevision: "1",
      sourceIndex: 0,
    });
    expect(() => validateAssemblyPlanV1(plan, plan.limits)).not.toThrow();
    await expect(validateAssemblyPlanAgainstSnapshotV1(plan, snapshot)).resolves.toBeUndefined();
    db.close();
  });

  test("binds result slots to child coordinates and seals as a closed record", async () => {
    const plan = await compiledAssemblyPlan();
    const child = plan.children[0]!;
    const slot = plan.resultSlots[0]!;
    const forgedChild = { ...child, blockIndex: child.blockIndex + 1, producerSeal: "forged" };
    const forgedSlot = { ...slot, producerBlockIndex: slot.producerBlockIndex + 1, producerBlockId: "forged-block", seal: "forged" };
    const forged = {
      ...plan,
      children: [forgedChild],
      childDescriptors: [forgedChild],
      resultSlots: [forgedSlot],
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/child|slot|seal/i);
    expect(() => validateAssemblyPlanV1({
      ...plan,
      resultSlots: [{ ...slot, unexpected: true }],
    }, plan.limits)).toThrow(/result slot|unknown|invalid/i);
  });

  test("rejects protected markers in ordinary provider literals", async () => {
    const plan = await compiledAssemblyPlan();
    const targetIndex = plan.providerMessages.findIndex((message) => message.segments.every((segment) => segment.kind === "literal"));
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const forgedText = "{{agent::forged::as=facts}}{{/agent}}";
    const forgedMessages = plan.providerMessages.map((message, index) => index === targetIndex
      ? {
        ...message,
        segments: [literalSegment(forgedText)],
      }
      : message);
    const forged = { ...plan, messages: forgedMessages, providerMessages: forgedMessages };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/literal|agent marker/i);
  });
  test("rejects combined provider and phase message cap plus one", async () => {
    const plan = await compiledAssemblyPlan();
    const policies = Array.from({ length: 13 }, (_, index) => policyMessage(`cap-${index}`, 100 + index));
    const forged = {
      ...withWorkPolicyEntries(plan, policies.map((_, index) => policyEntry(`cap-${index}`, 100 + index))),
      limits: { ...plan.limits, maxPromptBlocks: 1 },
      workPolicyMessages: policies,
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/message limit/i);
  });

  test("rejects combined provider and phase byte cap plus one", async () => {
    const plan = await compiledAssemblyPlan();
    const providerBytes = plan.providerMessages.reduce((total, message) => total + message.segments.reduce((sum, segment) => sum + (segment.kind === "literal" ? new TextEncoder().encode(segment.text).byteLength : 0), 0), 0);
    const forged = {
      ...withWorkPolicyEntries(plan, [policyEntry("byte-cap")]),
      limits: { ...plan.limits, maxInputBytes: providerBytes },
      workPolicyMessages: [policyMessage("byte-cap")],
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/bytes|limit/i);
  });

  test("binds isolate plans to exact source literals and child coordinates", async () => {
    const { snapshot, plan } = await compiledAssemblyFixture();
    await expect(validateAssemblyPlanAgainstSnapshotV1(plan, snapshot)).resolves.toBeUndefined();
    const blockMessageIndex = plan.providerMessages.findIndex((message) => message.blockIndex !== undefined);
    expect(blockMessageIndex).toBeGreaterThanOrEqual(0);
    const original = plan.providerMessages[blockMessageIndex]!;
    const firstLiteral = original.segments.find((segment) => segment.kind === "literal");
    const forgedText = `${firstLiteral?.text ?? ""} forged literal`;
    const forgedMessages = plan.providerMessages.map((message, index) => index === blockMessageIndex
      ? { ...message, segments: [literalSegment(forgedText)] }
      : message);
    await expect(validateAssemblyPlanAgainstSnapshotV1({ ...plan, messages: forgedMessages, providerMessages: forgedMessages }, snapshot)).rejects.toThrow(/literal|source-bound|seal/i);
    const omitted = plan.providerMessages.filter((_, index) => index !== blockMessageIndex);
    await expect(validateAssemblyPlanAgainstSnapshotV1({ ...plan, messages: omitted, providerMessages: omitted }, snapshot)).rejects.toThrow(/order|source-bound|seal/i);
    if (plan.children.length > 0) {
      const child = plan.children[0]!;
      const forgedChild = { ...child, profileId: `${child.profileId}_forged` };
      const forgedPlan = {
        ...plan,
        children: [forgedChild, ...plan.children.slice(1)],
        childDescriptors: [forgedChild, ...plan.childDescriptors.slice(1)],
        activationEvidence: plan.activationEvidence.map((evidence, index) => index === 0 ? { ...evidence, profileId: forgedChild.profileId } : evidence),
        tokenEvidence: plan.tokenEvidence.map((evidence, index) => index === 0 ? { ...evidence, profileId: forgedChild.profileId } : evidence),
      } as unknown as Parameters<typeof validateAssemblyPlanAgainstSnapshotV1>[0];
      await expect(validateAssemblyPlanAgainstSnapshotV1(forgedPlan, snapshot)).rejects.toThrow(/child|source-bound/i);
    }
  });
  test("binds provider provenance sources and rejects forged provenance", async () => {
    const { snapshot, plan } = await compiledAssemblyFixture();
    const kinds = new Set(plan.providerMessages.map((message) => message.provenance.kind));
    expect(kinds).toEqual(new Set(["block", "history", "world_info"]));
    const withProviderMessages = (providerMessages: typeof plan.providerMessages) => ({
      ...plan,
      messages: providerMessages,
      providerMessages,
    });
    for (const kind of ["block", "history", "world_info"] as const) {
      const index = plan.providerMessages.findIndex((message) => message.provenance.kind === kind);
      expect(index).toBeGreaterThanOrEqual(0);
      const message = plan.providerMessages[index]!;
      const forged = {
        ...message,
        provenance: { ...message.provenance, sourceRevision: `${message.provenance.sourceRevision}-forged` },
      };
      const forgedMessages = plan.providerMessages.map((candidate, candidateIndex) => candidateIndex === index ? forged : candidate);
      await expect(validateAssemblyPlanAgainstSnapshotV1(withProviderMessages(forgedMessages), snapshot)).rejects.toThrow(/source-bound|messages/i);
    }
    const roleIndex = plan.providerMessages.findIndex((message) => message.provenance.kind === "history");
    const roleForged = plan.providerMessages.map((message, candidateIndex) => candidateIndex === roleIndex
      ? { ...message, role: message.role === "user" ? "assistant" as const : "user" as const }
      : message);
    await expect(validateAssemblyPlanAgainstSnapshotV1(withProviderMessages(roleForged), snapshot)).rejects.toThrow(/source-bound|messages|role/i);
    const sourceIndexForged = plan.providerMessages.map((message, candidateIndex) => candidateIndex === roleIndex
      ? { ...message, provenance: { ...message.provenance, sourceIndex: message.provenance.sourceIndex + 1 } }
      : message);
    await expect(validateAssemblyPlanAgainstSnapshotV1(withProviderMessages(sourceIndexForged), snapshot)).rejects.toThrow(/source-bound|messages|index/i);
  });
  test("rejects coerced nested snapshot records before preprocessing", async () => {
    const { snapshot } = await compiledAssemblyFixture();
    const forgedMessage = JSON.parse(JSON.stringify(snapshot)) as GenerationAssemblySnapshotV1;
    const forgedMessageRecord = forgedMessage.messages[0] as unknown as Record<string, unknown>;
    forgedMessageRecord.is_user = "false";
    await expect(compileAgentAssemblyPlan(forgedMessage)).rejects.toThrow(/message\[0\]\.is_user/i);
    const forgedBlock = JSON.parse(JSON.stringify(snapshot)) as GenerationAssemblySnapshotV1;
    const forgedBlockRecord = forgedBlock.blocks[0] as unknown as Record<string, unknown>;
    forgedBlockRecord.enabled = "false";
    await expect(compileAgentAssemblyPlan(forgedBlock)).rejects.toThrow(/block\[0\]\.enabled/i);
  });

  test("worker response validation binds a compiled plan to its requested snapshot", async () => {
    const { snapshot, plan } = await compiledAssemblyFixture();
    const job: ActiveIsolateJob<unknown, unknown> = {
      userId: "user-1",
      operation: "compile_agent_assembly",
      payload: { snapshot },
      requestId: "worker-request",
      deadlineAt: Date.now() + 60_000,
      resolve: () => undefined,
      reject: () => undefined,
      settled: false,
    };
    const result = { ...plan, version: 1 as const, operation: "compile_agent_assembly" as const, requestId: job.requestId };
    const response = { version: 1 as const, type: "result" as const, requestId: job.requestId, result };
    const malformedMessages = result.providerMessages.map((message) => message.blockId === "consumer"
      ? {
        ...message,
        segments: message.segments.map((segment) => segment.kind === "literal"
          ? { ...segment, text: "forged", bytes: 6 }
          : segment),
      }
      : message);
    const malformed = { ...result, providerMessages: malformedMessages, messages: malformedMessages };
    await expect(parseAgenticPreprocessingResponseV1({ ...response, result: malformed }, job)).rejects.toThrow(/worker_malformed|assembly plan/i);
  });

  test("rejects duplicate phase block references across policy sections", async () => {
    const plan = await compiledAssemblyPlan();
    const duplicate = policyMessage("duplicate");
    const forged = {
      ...withWorkPolicyEntries(plan, [policyEntry("duplicate")]),
      workPolicyMessages: [duplicate],
      workspaceUsageMessages: [duplicate],
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/cognition policy|invalid/i);
  });
  test("rejects malformed worker requests before compile dispatch", async () => {
    expect(() => parseCompileAgentAssemblyRequest({
      version: 1,
      operation: "compile_agent_assembly",
      requestId: "request-1",
      snapshot: {},
      unexpected: true,
    })).toThrow(AssemblyPlanValidationError);
    expect(() => parseCompileAgentAssemblyRequest({
      version: 1,
      operation: "prepare_agent_render",
      requestId: "request-1",
      snapshot: {},
    })).toThrow(AssemblyPlanValidationError);
  });
});
