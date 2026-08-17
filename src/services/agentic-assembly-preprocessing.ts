import { buildEnv, type BuildEnvContext } from "../macros/MacroEnv";
import { parse } from "../macros/MacroParser";
import type { AstNode, MacroEnv } from "../macros/types";
import {
  activateWorldInfo,
  normalizeWorldInfoSettings,
  type WiEntryState,
  type WiState,
  type WorldInfoSettings,
} from "./world-info-activation.service";
import type { Message } from "../types/message";
import type { WorldBookEntry, WorldInfoCache } from "../types/world-book";
import {
  createExpansionBudget,
  type ExpansionBudgetV1,
  type PreparationDeltaV1,
  type PreparationLimitsV1,
  type WorldInfoStateDeltaV1,
} from "../types/agent-preprocessing";
import type {
  GenerationAssemblySnapshotV1,
  SnapshotBlockV1,
  SnapshotMessageV1,
  SnapshotRegexScriptV1,
  SnapshotWorldEntryV1,
} from "./prompt-assembly-snapshot.service";
import { runRegexRequest } from "../utils/regex-sandbox-core";
const RESULT_MARKER_RE = /\{\{(?:agent(?:::|Result::)[^}]*)|\/agent\}\}/;
const MAX_MACRO_DEPTH = 64;
const MAX_REGEX_MATCHES = 10_000;

export interface SnapshotWorldPreparationV1 {
  readonly activatedEntries: readonly WorldBookEntry[];
  readonly cache: WorldInfoCache;
  readonly state: WiState;
  readonly stateDeltas: readonly WorldInfoStateDeltaV1[];
  readonly evidence: readonly Readonly<Record<string, unknown>>[];
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function boolValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function scalarMap(value: unknown): Record<string, string | number> {
  const source = record(value);
  const output: Record<string, string | number> = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === "string" || (typeof item === "number" && Number.isFinite(item))) output[key] = item;
    else if (Array.isArray(item)) output[key] = item.filter((entry): entry is string => typeof entry === "string").join(", ");
  }
  return output;
}

function toCharacter(value: Readonly<Record<string, unknown>> | null | undefined): Record<string, unknown> {
  const source = value ?? {};
  const extensions = record(source.extensions);
  return {
    id: stringValue(source.id, "__assistant__"),
    name: stringValue(source.name, "Assistant"),
    avatar_path: null,
    image_id: null,
    description: stringValue(source.description),
    personality: stringValue(source.personality),
    scenario: stringValue(source.scenario),
    first_mes: stringValue(source.first_mes),
    mes_example: stringValue(source.mes_example),
    creator: stringValue(source.creator),
    creator_notes: stringValue(source.creator_notes),
    system_prompt: stringValue(source.system_prompt),
    post_history_instructions: stringValue(source.post_history_instructions),
    folder: "",
    tags: Array.isArray(source.tags) ? source.tags.filter((item): item is string => typeof item === "string") : [],
    alternate_greetings: Array.isArray(source.alternate_greetings)
      ? source.alternate_greetings.filter((item): item is string => typeof item === "string")
      : [],
    extensions: {
      depth_prompt: stringValue(extensions.depth_prompt),
      alternate_character_name: stringValue(extensions.alternate_character_name),
    },
    created_at: numberValue(source.created_at),
    updated_at: numberValue(source.updated_at),
  };
}

function toPersona(value: Readonly<Record<string, unknown>> | null): Record<string, unknown> | null {
  if (!value) return null;
  return {
    id: stringValue(value.id, "persona"),
    name: stringValue(value.name, "User"),
    title: stringValue(value.title),
    description: stringValue(value.description),
    subjective_pronoun: stringValue(value.subjective_pronoun, "they"),
    objective_pronoun: stringValue(value.objective_pronoun, "them"),
    possessive_pronoun: stringValue(value.possessive_pronoun, "their"),
    reflexive_pronoun: stringValue(value.reflexive_pronoun, "themselves"),
    possessive_pronoun_standalone: stringValue(value.possessive_pronoun_standalone, "theirs"),
    avatar_path: null,
    image_id: null,
    attached_world_book_id: typeof value.attached_world_book_id === "string" ? value.attached_world_book_id : null,
    folder: "",
    is_default: boolValue(value.is_default),
    is_narrator: boolValue(value.is_narrator),
    metadata: {},
    created_at: numberValue(value.created_at),
    updated_at: numberValue(value.updated_at),
  };
}

function toMessage(value: SnapshotMessageV1): Record<string, unknown> {
  return {
    id: value.id,
    chat_id: value.chat_id,
    index_in_chat: value.index_in_chat,
    is_user: value.is_user,
    name: value.name,
    content: value.content,
    send_date: value.send_date,
    swipe_id: value.swipe_id,
    swipes: [...value.swipes],
    swipe_dates: [...value.swipe_dates],
    extra: { ...value.extra },
    parent_message_id: value.parent_message_id,
    branch_id: value.branch_id,
    created_at: value.created_at,
  };
}

/** Build only from snapshot-owned plain data; no service or callback is read. */
export function buildSnapshotMacroEnv(snapshot: GenerationAssemblySnapshotV1): MacroEnv {
  const character = toCharacter(snapshot.participants.character);
  const persona = toPersona(snapshot.participants.persona);
  const group = snapshot.participants.group.map((member) => toCharacter(member));
  const chat = {
    id: snapshot.chat.id,
    character_id: snapshot.chat.character_id,
    name: snapshot.chat.name,
    metadata: { ...snapshot.chat.metadata },
    created_at: snapshot.chat.created_at,
    updated_at: snapshot.chat.updated_at,
  };
  const messages = snapshot.messages.map(toMessage);
  const context: BuildEnvContext = {
    character: character as unknown as BuildEnvContext["character"],
    focusedCharacter: character as unknown as BuildEnvContext["character"],
    persona: persona as unknown as BuildEnvContext["persona"],
    chat: chat as unknown as BuildEnvContext["chat"],
    messages: messages as unknown as BuildEnvContext["messages"],
    generationType: snapshot.target.generationType,
    commit: false,
    connection: snapshot.connection as unknown as BuildEnvContext["connection"],
    userId: snapshot.userId,
    groupCharacterNames: group.map((member) => stringValue(member.name, "Character")),
    groupNotMutedNames: group.map((member) => stringValue(member.name, "Character")),
    targetCharacterName: stringValue(character.name, "Assistant"),
    userInput: snapshot.target.userInput,
    dynamicMacros: {},
  };
  const env = buildEnv(context);
  env.commit = false;
  env.dynamicMacros = {};
  const macroVariables = record(snapshot.chat.metadata).macro_variables;
  const globalValues = scalarMap(record(macroVariables).global);
  env.variables.global = new Map(Object.entries(globalValues).map(([key, value]) => [key, String(value)] as [string, string]));
  env.variables.chat = new Map(Object.entries(scalarMap(snapshot.variables.chat)).map(([key, value]) => [key, String(value)] as [string, string]));
  env.variables.local = new Map();
  env.extra.promptVariablesByBlock = {};
  env.extra.promptVariableDefaultsByBlock = {};
  env.extra.promptVariableSelectionsByBlock = {};
  env.extra.promptVariables = {};
  env.extra.promptVariableDefaults = {};
  env.extra.promptVariableSelections = {};
  env.extra.worldInfoOutlets = {};
  env.extra.worldInfoAtMarker = "";
  return env;
}

export function setSnapshotBlockMacroContext(
  env: MacroEnv,
  snapshot: GenerationAssemblySnapshotV1,
  block: SnapshotBlockV1,
): void {
  const rawValues = record(snapshot.variables.preset)[block.id];
  const values = scalarMap(rawValues);
  const defaults: Record<string, string | number> = {};
  const selections: Record<string, string[]> = {};
  for (const definition of block.variables ?? []) {
    const value = definition.defaultValue;
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) defaults[definition.id] = value;
    if (Array.isArray(value)) selections[definition.id] = value.filter((item): item is string => typeof item === "string");
  }
  env.variables.local = new Map(Object.entries(values).map(([key, value]) => [key, String(value)]));
  env.promptBlock = { id: block.id, role: block.role, position: block.position, depth: block.depth };
  env.extra.promptVariablesByBlock = { [block.id]: values };
  env.extra.promptVariableDefaultsByBlock = { [block.id]: defaults };
  env.extra.promptVariableSelectionsByBlock = { [block.id]: selections };
  env.extra.promptVariables = values;
  env.extra.promptVariableDefaults = defaults;
  env.extra.promptVariableSelections = selections;
}

function stableRandom(seedText: string): () => number {
  let state = 0x9e3779b9;
  for (let index = 0; index < seedText.length; index++) state = Math.imul(state ^ seedText.charCodeAt(index), 0x45d9f3b);
  return () => {
    state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
    state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
    state ^= state >>> 16;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function asWorldEntry(entry: SnapshotWorldEntryV1): WorldBookEntry {
  return {
    id: entry.id,
    world_book_id: entry.bookId,
    uid: entry.uid,
    outlet_name: entry.outletName,
    wi_marker: entry.wiMarker,
    wi_marker_side: entry.wiMarkerSide,
    key: [...entry.keys],
    keysecondary: [...entry.secondaryKeys],
    content: entry.content,
    comment: entry.comment,
    position: entry.position,
    depth: entry.depth,
    role: entry.role,
    order_value: entry.orderValue,
    selective: entry.selective,
    constant: entry.constant,
    disabled: entry.disabled,
    group_name: entry.groupName,
    group_override: entry.groupOverride,
    group_weight: entry.groupWeight,
    probability: entry.probability,
    scan_depth: entry.scanDepth,
    exclude_greeting: entry.excludeGreeting,
    case_sensitive: entry.caseSensitive,
    match_whole_words: entry.matchWholeWords,
    automation_id: null,
    use_regex: entry.useRegex,
    prevent_recursion: entry.preventRecursion,
    exclude_recursion: entry.excludeRecursion,
    delay_until_recursion: entry.delayUntilRecursion,
    priority: entry.priority,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    selective_logic: entry.selectiveLogic,
    use_probability: entry.useProbability,
    vectorized: entry.vectorized,
    vector_index_status: entry.vectorIndexStatus as WorldBookEntry["vector_index_status"],
    vector_indexed_at: null,
    vector_index_error: null,
    revision: numberValue(entry.revision),
    extensions: {},
    created_at: 0,
    updated_at: 0,
  };
}

function initialWorldState(snapshot: GenerationAssemblySnapshotV1): WiState {
  const source = record(snapshot.worldInfo.state);
  const state: WiState = {};
  for (const entry of snapshot.worldInfo.entries) {
    const candidate = record(source[entry.uid] ?? source[entry.id]);
    state[entry.uid] = {
      stickyLeft: Math.max(0, numberValue(candidate.stickyLeft ?? candidate.sticky_left)),
      cooldownLeft: Math.max(0, numberValue(candidate.cooldownLeft ?? candidate.cooldown_left)),
      delayCount: Math.max(0, numberValue(candidate.delayCount ?? candidate.delay_count)),
      active: boolValue(candidate.active),
    };
  }
  return state;
}

function stateDelta(
  entry: SnapshotWorldEntryV1,
  before: WiEntryState,
  after: WiEntryState,
): WorldInfoStateDeltaV1 | null {
  const changed = before.active !== after.active
    || before.stickyLeft !== after.stickyLeft
    || before.cooldownLeft !== after.cooldownLeft
    || before.delayCount !== after.delayCount;
  if (!changed) return null;
  const afterState = {
    active: after.active,
    stickyLeft: after.stickyLeft,
    cooldownLeft: after.cooldownLeft,
    delayCount: after.delayCount,
  } as const;
  const operation = after.active
    ? "activate"
    : (after.cooldownLeft > 0 || before.cooldownLeft > 0 ? "set_cooldown" : "deactivate");
  return {
    kind: "world_info_state",
    entryId: entry.id,
    operation,
    state: after.active ? "active" : operation === "set_cooldown" ? "cooldown" : "inactive",
    afterState,
    expectedRevision: entry.revision,
  };
}

/** Recompute keyword/constant WI from the frozen snapshot and deterministic PRNG. */
export function activateSnapshotWorldInfo(
  snapshot: GenerationAssemblySnapshotV1,
): SnapshotWorldPreparationV1 {
  const entries = snapshot.worldInfo.entries.map(asWorldEntry);
  const messages = snapshot.messages
    .filter((message) => message.id !== snapshot.target.excludedMessageId)
    .map(toMessage) as unknown as Message[];
  const before = initialWorldState(snapshot);
  const state: WiState = structuredClone(before);
  const settingsValue = record(snapshot.variables.settings).worldInfoSettings;
  const settings = normalizeWorldInfoSettings(
    settingsValue && typeof settingsValue === "object" && !Array.isArray(settingsValue)
      ? settingsValue as Partial<WorldInfoSettings>
      : {},
  );
  const result = activateWorldInfo({
    entries,
    messages,
    chatTurn: messages.length,
    wiState: state,
    settings,
    random: stableRandom(snapshot.snapshotId),
  });
  const stateDeltas: WorldInfoStateDeltaV1[] = [];
  const evidence: Readonly<Record<string, unknown>>[] = [];
  for (const entry of snapshot.worldInfo.entries) {
    const beforeState = before[entry.uid] ?? { stickyLeft: 0, cooldownLeft: 0, delayCount: 0, active: false };
    const afterState = state[entry.uid] ?? beforeState;
    const delta = stateDelta(entry, beforeState, afterState);
    if (delta) stateDeltas.push(Object.freeze(delta));
    evidence.push(Object.freeze({
      kind: "world_info",
      entryId: entry.id,
      uid: entry.uid,
      activated: result.activatedEntries.some((candidate) => candidate.id === entry.id),
      origin: result.activationProvenanceById.get(entry.id)?.origin ?? "none",
      state: Object.freeze({ ...afterState }),
    }));
  }
  return Object.freeze({
    activatedEntries: Object.freeze(result.activatedEntries.map((entry) => Object.freeze({ ...entry }))),
    cache: result.cache,
    state,
    stateDeltas: Object.freeze(stateDeltas),
    evidence: Object.freeze(evidence),
  });
}

function macroValue(env: MacroEnv, name: string, args: readonly string[]): string {
  const normalized = name.toLowerCase();
  const values = record(env.extra.promptVariables);
  const defaults = record(env.extra.promptVariableDefaults);
  const key = (args[0] ?? "").trim();
  switch (normalized) {
    case "user": return env.names.user;
    case "char":
    case "charname": return env.names.char;
    case "group": return env.names.group;
    case "groupnotmuted":
    case "group_not_muted": return env.names.groupNotMuted;
    case "notchar":
    case "not_char": return env.names.notChar;
    case "chargroupfocused":
    case "charfocused":
    case "char_group_focused": return env.names.charGroupFocused;
    case "groupothers":
    case "group_others": return env.names.groupOthers;
    case "groupmembercount":
    case "group_member_count": return env.names.groupMemberCount;
    case "grouplastspeaker":
    case "group_last_speaker": return env.names.groupLastSpeaker;
    case "groupcardmode":
    case "group_card_mode": return env.names.groupCardMode;
    case "isgroupchat":
    case "is_group_chat": return env.names.isGroupChat;
    case "isnarrator":
    case "is_narrator": return env.names.isNarrator;
    case "input": return env.chat.lastUserMessage;
    case "userinput":
    case "user_input": return stringValue(env.extra.userInput);
    case "model": return env.system.model;
    case "lastgenerationtype":
    case "last_generation_type": return env.system.lastGenerationType;
    case "promptblockrole":
    case "blockrole":
    case "prompt_block_role": return env.promptBlock?.role ?? "";
    case "promptblockposition":
    case "blockposition":
    case "prompt_block_position": return env.promptBlock?.position ?? "";
    case "promptblockdepth":
    case "blockdepth":
    case "prompt_block_depth": return env.promptBlock ? String(env.promptBlock.depth) : "";
    case "outlet": {
      const outlets = record(env.extra.worldInfoOutlets);
      return stringValue(outlets[key.toLowerCase()]);
    }
    case "wi_marker": return stringValue(env.extra.worldInfoAtMarker);
    case "persona_outlet":
    case "personoutlet": {
      const outlets = record(env.extra.personaAddonOutlets);
      return stringValue(outlets[key.toLowerCase()]);
    }
    case "var":
    case "promptvar":
    case "presetvar": {
      if (!key) return "";
      const local = env.variables.local.get(key);
      if (local !== undefined) return local;
      if (Object.prototype.hasOwnProperty.call(values, key)) return String(values[key]);
      if (Object.prototype.hasOwnProperty.call(defaults, key)) return String(defaults[key]);
      return "";
    }
    case "hasvar":
    case "haspromptvar":
    case "haspresetvar": return key && (env.variables.local.has(key) || key in values || key in defaults) ? "true" : "false";
    case "vardefault":
    case "promptvardefault":
    case "presetvardefault": return key && key in defaults ? String(defaults[key]) : "";
    case "getvar": return key ? env.variables.local.get(key) ?? "" : "";
    case "getgvar":
    case "getglobalvar": return key ? env.variables.global.get(key) ?? "" : "";
    case "getchatvar": return key ? env.variables.chat.get(key) ?? "" : "";
    case "name": return env.names.user;
    case "description": return env.character.description;
    case "personality": return env.character.personality;
    case "scenario": return env.character.scenario;
    case "persona": return env.character.persona;
    case "mesexamples":
    case "mes_example": return env.character.mesExamples;
    case "systemprompt": return env.character.systemPrompt;
    case "posthistoryinstructions": return env.character.postHistoryInstructions;
    case "creatornotes": return env.character.creatorNotes;
    case "version": return env.character.version;
    case "creator": return env.character.creator;
    case "firstmessage": return env.character.firstMessage;
    default: throw new Error(`requires_response_mode: unsupported macro ${name}`);
  }
}

function accountMacroResult(value: string, budget: ExpansionBudgetV1): string {
  const resultBytes = utf8Bytes(value);
  budget.accountExpansion(resultBytes, resultBytes);
  budget.reserveOutputBytes(resultBytes);
  return value;
}

function truthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}
function repeatCount(value: string | undefined): number {
  const count = value === undefined || value.trim() === "" ? 0 : Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000) {
    throw new Error("limit_exceeded: repeat count exceeds the strict 1000 resolution ceiling");
  }
  return count;
}

function resolveNodes(nodes: readonly AstNode[], env: MacroEnv, budget: ExpansionBudgetV1, depth: number): string {
  if (depth > MAX_MACRO_DEPTH) throw new Error("requires_response_mode: macro nesting exceeds strict depth");
  const fragments: string[] = [];
  for (const node of nodes) {
    budget.checkAbort();
    if (node.type === "text") {
      fragments.push(node.value);
      continue;
    }
    budget.reserveMacroResolutions();
    const args = node.args.map((arg) => resolveNodes(arg, env, budget, depth + 1));
    if (node.type === "scoped_macro") {
      const name = node.name.toLowerCase();
      if (name === "repeat") {
        const count = repeatCount(args[0]);
        if (count === 0) {
          fragments.push("");
          continue;
        }
        const expansionBefore = budget.cumulativeExpansionBytes;
        const body = resolveNodes(node.body, env, budget, depth + 1);
        const bodyBytes = utf8Bytes(body);
        const resultBytes = bodyBytes * count;
        const nestedExpansion = budget.cumulativeExpansionBytes - expansionBefore;
        const additionalExpansion = nestedExpansion > 0
          ? Math.max(0, resultBytes - bodyBytes)
          : resultBytes;
        budget.preflightOutput(resultBytes);
        budget.preflightExpansion(additionalExpansion, resultBytes);
        const result = body.repeat(count);
        budget.accountExpansion(additionalExpansion, resultBytes);
        fragments.push(result);
        continue;
      }
      const body = resolveNodes(node.body, env, budget, depth + 1);
      if (name === "trim") {
        budget.reserveTrimString();
        fragments.push(accountMacroResult(body.trim(), budget));
      } else if (name === "wrap") {
        if (!body) fragments.push("");
        else {
          const value = `${args[0] ?? ""}${body}${args[1] ?? ""}`;
          fragments.push(accountMacroResult(value, budget));
        }
      } else {
        throw new Error(`requires_response_mode: unsupported scoped macro ${node.name}`);
      }
      continue;
    }
    const name = node.name.toLowerCase();
    if (name === "setvar" || name === "setgvar" || name === "setchatvar" || name === "deletevar" || name === "deletegvar" || name === "deletechatvar") {
      throw new Error(`requires_response_mode: mutable macro ${node.name}`);
    }
    if (name === "upper" || name === "lower" || name === "capitalize" || name === "regex") {
      throw new Error(`requires_response_mode: expanding macro ${node.name} is not snapshot-safe`);
    }
    if (name === "join") {
      const separator = args[0] ?? ", ";
      const items = args.slice(1).map((item) => item.trim()).filter(Boolean);
      budget.reserveTrimString(args.length > 1 ? args.length - 1 : 0);
      const resultBytes = items.reduce((total, item) => total + utf8Bytes(item), utf8Bytes(separator) * Math.max(0, items.length - 1));
      budget.accountExpansion(resultBytes, resultBytes);
      fragments.push(items.join(separator));
      continue;
    }
    if (name === "repeat") {
      const count = repeatCount(args[0]);
      const text = args[1] ?? "";
      const textBytes = utf8Bytes(text);
      const resultBytes = textBytes * count;
      budget.preflightOutput(resultBytes);
      budget.preflightExpansion(resultBytes, resultBytes);
      const result = text.repeat(count);
      budget.accountExpansion(resultBytes, resultBytes);
      fragments.push(result);
      continue;
    }
    if (name === "wrap") {
      const text = args[2] ?? "";
      if (!text) fragments.push("");
      else {
        const resultBytes = utf8Bytes(args[0] ?? "") + utf8Bytes(text) + utf8Bytes(args[1] ?? "");
        budget.accountExpansion(resultBytes, resultBytes);
        fragments.push(`${args[0] ?? ""}${text}${args[1] ?? ""}`);
      }
      continue;
    }
    if (name === "replace") {
      const text = args[2] ?? "";
      const find = args[0] ?? "";
      const replacement = args[1] ?? "";
      if (!find) fragments.push(text);
      else {
        let count = 0;
        for (let offset = 0; ; ) {
          const index = text.indexOf(find, offset);
          if (index < 0) break;
          count++;
          offset = index + find.length;
        }
        const resultBytes = utf8Bytes(text) - count * utf8Bytes(find) + count * utf8Bytes(replacement);
        budget.accountExpansion(resultBytes, resultBytes);
        fragments.push(text.replaceAll(find, replacement));
      }
      continue;
    }
    if (name === "len" || name === "length") {
      fragments.push(accountMacroResult(String((args[0] ?? "").length), budget));
      continue;
    }
    if (name === "substr" || name === "substring") {
      const value = (args[0] ?? "").substring(Number.parseInt(args[1] ?? "0", 10) || 0, args[2] === undefined ? undefined : Number.parseInt(args[2], 10));
      fragments.push(accountMacroResult(value, budget));
      continue;
    }
    if (name === "split") {
      const parts = (args[0] ?? "").split(args[1] ?? ",");
      const index = Number.parseInt(args[2] ?? "0", 10) || 0;
      fragments.push(accountMacroResult(parts[index < 0 ? parts.length + index : index]?.trim() ?? "", budget));
      continue;
    }
    if (name === "if" || name === "unless") {
      const condition = truthy(args.join(" "));
      fragments.push(accountMacroResult(name === "if" ? (condition ? "true" : "") : (condition ? "" : "true"), budget));
      continue;
    }
    fragments.push(accountMacroResult(macroValue(env, node.name, args), budget));
  }
  return fragments.join("");
}

/** Resolve only the ordinary text portions; agent markers are never parsed. */
export function resolveSnapshotMacroText(
  template: string,
  env: MacroEnv,
  budget: ExpansionBudgetV1,
): string {
  if (RESULT_MARKER_RE.test(template)) throw new Error("invalid_input: protected agent marker entered macro resolver");
  if (!template.includes("{{") && !template.includes("<user>") && !template.includes("<char>") && !template.includes("<bot>")) return template;
  let result: string;
  try {
    result = resolveNodes(parse(template), env, budget, 0);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("requires_response_mode:") || error.message.startsWith("invalid_input:"))) throw error;
    throw new Error(`invalid_input: macro resolution failed (${error instanceof Error ? error.message : "unknown"})`);
  }
  if (RESULT_MARKER_RE.test(result)) throw new Error("generated_result_reference: macro generated a protected agent marker");
  budget.noteOutput(result);
  return result.replaceAll("\x01", "{").replaceAll("\x02", "}");
}

function placementMatches(script: SnapshotRegexScriptV1, placement: "user_input" | "ai_output" | "world_info"): boolean {
  return script.target.includes("prompt") && script.placement.length > 0 && script.placement.includes(placement);
}

/** Apply only literal, prompt-target scripts through the bounded pure regex core. */
export function applySnapshotPromptRegex(
  content: string,
  scripts: readonly SnapshotRegexScriptV1[],
  placement: "user_input" | "ai_output" | "world_info",
  limits: PreparationLimitsV1,
  budget: ExpansionBudgetV1,
): string {
  let result = content;
  let compiled = 0;
  for (const script of scripts) {
    if (!placementMatches(script, placement)) continue;
    if (script.actions.length > 0) throw new Error(`requires_response_mode: regex actions are not snapshot-safe (${script.id})`);
    compiled++;
    try {
      const beforeBytes = utf8Bytes(result);
      const transformed = runRegexRequest({
        id: script.id,
        op: "replace",
        pattern: script.findRegex,
        flags: script.flags,
        input: result,
        replacement: script.replaceString,
        limits: {
          maxInputBytes: limits.maxOperationBytes,
          maxOutputBytes: limits.maxOutputBytes,
          maxExpansionBytes: Math.max(0, limits.maxCumulativeExpansionBytes - budget.cumulativeExpansionBytes),
          maxOperationBytes: limits.maxOperationBytes,
          maxMatches: MAX_REGEX_MATCHES,
        },
      }) as string;
      const transformedBytes = utf8Bytes(transformed);
      const growthBytes = Math.max(0, transformedBytes - beforeBytes);
      budget.accountExpansion(growthBytes, growthBytes);
      result = transformed;
      for (const trim of script.trimStrings) {
        budget.reserveTrimString();
        if (trim.length === 0) throw new Error(`limit_exceeded: empty regex trim string (${script.id})`);
        result = result.replaceAll(trim, "");
      }
      budget.noteOutput(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      if (
        message.startsWith("requires_response_mode:")
        || message.startsWith("generated_result_reference:")
        || message.startsWith("invalid_input:")
        || message.startsWith("limit_exceeded:")
      ) {
        throw error;
      }
      throw new Error(`limit_exceeded: regex script ${script.id} failed (${message})`);
    }
    if (RESULT_MARKER_RE.test(result)) throw new Error("generated_result_reference: regex generated a protected agent marker");
  }
  return result;
}

export function createSnapshotExpansionBudget(snapshot: GenerationAssemblySnapshotV1): ExpansionBudgetV1 {
  return createExpansionBudget(snapshot.limits);
}

export function agentMarkersPresent(value: string): boolean {
  return RESULT_MARKER_RE.test(value);
}

export type SnapshotPreparationDeltaV1 = PreparationDeltaV1;
