import type { ToolDefinition } from "../llm/types";
import type { Message } from "../types/message";
import type {
  AgentLoreScope,
  AgentLoreSource,
  AgentOwnedLoreReader,
  AgentSnapshotBook,
  AgentSnapshotChatMessage,
  AgentSnapshotEntry,
  AgentToolNames,
  AgentToolResult,
  AgentToolSnapshot,
  CoreAgentToolId,
} from "../types/agents";
import type { WorldBookEntry } from "../types/world-book";

import { isLoomInjectedMessageForSearch } from "./chats.service";
import {
  isAgentLoreSearchMatch,
  rankAgentLoreSearch,
} from "./agent-lore-relevance";
const TOOL_PAGE_DEFAULT = 20;
const TOOL_PAGE_MAX = 50;
const TOOL_SELECTOR_MAX_BYTES = 512;
export const AGENT_TOOL_RESULT_MAX_BYTES = 64 * 1024;


export interface AgentToolSnapshotInput {
  rootUserId: string;
  chatId: string;
  books: ReadonlyArray<{
    id: string;
    name: string;
    description?: string;
    folder?: string;
    source: AgentLoreSource;
    active?: boolean;
  }>;
  entries: readonly WorldBookEntry[];
  activatedEntries?: readonly WorldBookEntry[];
  bookNames?: ReadonlyMap<string, string>;
  bookSources?: ReadonlyMap<string, AgentLoreSource>;
  messages: readonly Message[];
  excludedMessageIds?: ReadonlySet<string>;
  names: AgentToolNames;
  ownedLore?: AgentOwnedLoreReader;
  signal?: AbortSignal;
}

export interface AgentToolGrant {
  toolIds: readonly CoreAgentToolId[];
  loreScope: AgentLoreScope;
}

export interface AgentToolExecutionContext {
  snapshot: AgentToolSnapshot;
  grant: AgentToolGrant;
  signal?: AbortSignal;
}

interface PageEnvelope<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
}

interface ParsedPage {
  limit: number;
  offset: number;
}

interface ParsedCommon extends ParsedPage {
  scope: AgentLoreScope;
  format: "json" | "text";
}

interface ParsedBookSelector {
  bookId?: string;
  bookName?: string;
}

type BookResolution =
  | { status: "found"; book: AgentSnapshotBook }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: Array<{ id: string; name: string }> };

interface CoreAgentToolCatalogEntry {
  definition: ToolDefinition;
  execute: (
    args: unknown,
    context: AgentToolExecutionContext,
  ) => Promise<AgentToolResult>;
}

function freezeArray<T>(values: T[]): readonly T[] {
  for (const value of values) {
    if (value && typeof value === "object") Object.freeze(value);
  }
  return Object.freeze(values);
}

function projectChatMessages(
  messages: readonly Message[],
  excludedMessageIds: ReadonlySet<string>,
): readonly AgentSnapshotChatMessage[] {
  const projected: AgentSnapshotChatMessage[] = [];
  for (const message of messages) {
    if (excludedMessageIds.has(message.id)) continue;
    if (message.extra?.hidden === true || isLoomInjectedMessageForSearch(message.extra)) continue;
    const swipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
    const activeSwipe = Array.isArray(message.swipes)
      ? message.swipes[swipeId]
      : undefined;
    projected.push({
      id: message.id,
      indexInChat: message.index_in_chat,
      role: message.is_user ? "user" : "assistant",
      name: message.name,
      content: typeof activeSwipe === "string" ? activeSwipe : message.content,
    });
  }
  return freezeArray(projected);
}

export function createAgentToolSnapshot(input: AgentToolSnapshotInput): AgentToolSnapshot {
  const activatedById = new Map(
    (input.activatedEntries ?? []).map((entry) => [entry.id, entry] as const),
  );
  const activatedIds = new Set(activatedById.keys());
  const books = input.books.map((book) => ({
    id: book.id,
    name: book.name,
    description: book.description ?? "",
    folder: book.folder ?? "",
    source: book.source,
    active: book.active !== false,
  }));
  const knownBookIds = new Set(books.map((book) => book.id));
  const entries: AgentSnapshotEntry[] = [];
  for (const sourceEntry of input.entries) {
    if (sourceEntry.disabled) continue;
    const finalizedEntry = activatedById.get(sourceEntry.id) ?? sourceEntry;
    const bookId = sourceEntry.world_book_id;
    const bookName = input.bookNames?.get(bookId) ?? books.find((book) => book.id === bookId)?.name ?? "Injected lore";
    const bookSource = input.bookSources?.get(bookId) ?? books.find((book) => book.id === bookId)?.source ?? "injected";
    if (!knownBookIds.has(bookId)) {
      books.push({
        id: bookId,
        name: bookName,
        description: "",
        folder: "",
        source: bookSource,
        active: true,
      });
      knownBookIds.add(bookId);
    }
    entries.push({
      id: sourceEntry.id,
      bookId,
      bookName,
      bookSource,
      comment: sourceEntry.comment,
      keys: Object.freeze([...sourceEntry.key]),
      secondaryKeys: Object.freeze([...sourceEntry.keysecondary]),
      content: finalizedEntry.content,
      position: finalizedEntry.position,
      depth: finalizedEntry.depth,
      role: finalizedEntry.role,
      activated: activatedIds.has(sourceEntry.id),
    });
  }

  const snapshot: AgentToolSnapshot = {
    rootUserId: input.rootUserId,
    chatId: input.chatId,
    books: freezeArray(books),
    entries: freezeArray(entries),
    chatMessages: projectChatMessages(
      input.messages,
      input.excludedMessageIds ?? new Set<string>(),
    ),
    names: Object.freeze({ ...input.names }),
    ...(input.ownedLore
      ? { ownedLore: Object.freeze({ ...input.ownedLore }) }
      : {}),
    signal: input.signal,
  };
  return Object.freeze(snapshot);
}

const SAFE_NAME_MACROS: Readonly<Record<string, keyof AgentToolNames>> = Object.freeze({
  user: "user",
  char: "char",
  charname: "char",
  group: "group",
  groupnotmuted: "groupNotMuted",
  group_not_muted: "groupNotMuted",
  notchar: "notChar",
  not_char: "notChar",
  isgroupchat: "isGroupChat",
  is_group_chat: "isGroupChat",
  groupothers: "groupOthers",
  group_others: "groupOthers",
  groupmembercount: "groupMemberCount",
  group_member_count: "groupMemberCount",
});

export function renderAgentLoreText(text: string, names: Readonly<AgentToolNames>): string {
  return text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (original, rawName: string) => {
    const key = SAFE_NAME_MACROS[rawName.toLowerCase()];
    return key ? names[key] : original;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error("invalid_arguments");
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key)) throw new Error("invalid_arguments");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new Error("invalid_arguments");
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error("invalid_arguments");
  }
  return value;
}

function optionalString(
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > TOOL_SELECTOR_MAX_BYTES) {
    throw new Error("invalid_arguments");
  }
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed.length === 0) throw new Error("invalid_arguments");
  return trimmed;
}

function parsePage(record: Record<string, unknown>): ParsedPage {
  const rawLimit = record.limit ?? TOOL_PAGE_DEFAULT;
  const rawOffset = record.offset ?? 0;
  if (!Number.isSafeInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > TOOL_PAGE_MAX) {
    throw new Error("invalid_arguments");
  }
  if (!Number.isSafeInteger(rawOffset) || (rawOffset as number) < 0) {
    throw new Error("invalid_arguments");
  }
  return { limit: rawLimit as number, offset: rawOffset as number };
}

function parseScope(value: unknown): AgentLoreScope {
  if (value === undefined || value === "active") return "active";
  if (value === "all_owned") return "all_owned";
  throw new Error("invalid_arguments");
}

function parseFormat(value: unknown): "json" | "text" {
  if (value === undefined || value === "json") return "json";
  if (value === "text") return "text";
  throw new Error("invalid_arguments");
}

function parseCommon(record: Record<string, unknown>): ParsedCommon {
  return {
    ...parsePage(record),
    scope: parseScope(record.scope),
    format: parseFormat(record.format),
  };
}

function parseBookSelector(record: Record<string, unknown>): ParsedBookSelector {
  const bookId = optionalString(record.book_id);
  const bookName = optionalString(record.book_name);
  if ((bookId ? 1 : 0) + (bookName ? 1 : 0) !== 1) throw new Error("invalid_arguments");
  return { bookId, bookName };
}

function assertScope(scope: AgentLoreScope, grant: AgentToolGrant): void {
  if (scope === "all_owned" && grant.loreScope !== "all_owned") {
    throw new Error("unauthorized");
  }
}

function checkAbort(
  snapshot: AgentToolSnapshot,
  signal?: AbortSignal,
): void {
  if (signal?.aborted || snapshot.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function page<T>(data: T[], total: number, parsed: ParsedPage): PageEnvelope<T> {
  return {
    data,
    total,
    limit: parsed.limit,
    offset: parsed.offset,
    truncated: parsed.offset + data.length < total,
  };
}
/**
 * Search identity fields before secondary keys and content. Lower ranks are
 * more relevant; callers retain the original snapshot index for ties.
 */
function rankActiveLoreEntry(entry: AgentSnapshotEntry, query: string): number {
  return rankAgentLoreSearch({
    comment: entry.comment,
    primaryKeys: entry.keys,
    secondaryKeys: entry.secondaryKeys,
    content: entry.content,
  }, query);
}

function requireOwnedLoreReader(snapshot: AgentToolSnapshot): AgentOwnedLoreReader {
  if (!snapshot.ownedLore) throw new Error("internal_error");
  return snapshot.ownedLore;
}

function ownedPage<T>(
  result: {
    data: readonly T[];
    total: number;
    limit: number;
    offset: number;
    truncated: boolean;
  },
): PageEnvelope<T> {
  return {
    data: [...result.data],
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    truncated: result.truncated,
  };
}


function resolveBook(
  snapshot: AgentToolSnapshot,
  scope: AgentLoreScope,
  selector: ParsedBookSelector,
): BookResolution {
  if (scope === "all_owned") {
    const reader = requireOwnedLoreReader(snapshot);
    if (selector.bookId) {
      const book = reader.getBook(selector.bookId);
      return book ? { status: "found", book } : { status: "not_found" };
    }
    const resolution = reader.resolveBookName(selector.bookName!);
    if (resolution.total === 0) return { status: "not_found" };
    if (resolution.total === 1) {
      const candidate = resolution.candidates[0];
      const book = candidate ? reader.getBook(candidate.id) : null;
      return book ? { status: "found", book } : { status: "not_found" };
    }
    return {
      status: "ambiguous",
      candidates: resolution.candidates.map(({ id, name }) => ({ id, name })),
    };
  }

  const books = snapshot.books.filter((book) => book.active);
  if (selector.bookId) {
    const book = books.find((candidate) => candidate.id === selector.bookId);
    return book ? { status: "found", book } : { status: "not_found" };
  }
  const normalized = selector.bookName?.toLocaleLowerCase() ?? "";
  const matches = books.filter(
    (book) => book.name.toLocaleLowerCase() === normalized,
  );
  if (matches.length === 1) return { status: "found", book: matches[0] };
  if (matches.length === 0) return { status: "not_found" };
  return {
    status: "ambiguous",
    candidates: matches.map(({ id, name }) => ({ id, name })),
  };
}

function projectBook(book: AgentSnapshotBook): Record<string, unknown> {
  return {
    id: book.id,
    name: book.name,
    description: book.description,
    folder: book.folder,
    source: book.source,
    active: book.active,
  };
}

function projectEntry(
  entry: AgentSnapshotEntry,
  names: Readonly<AgentToolNames>,
  renderContent: boolean,
): Record<string, unknown> {
  return {
    id: entry.id,
    book_id: entry.bookId,
    book_name: entry.bookName,
    source: entry.bookSource,
    comment: entry.comment,
    keys: [...entry.keys],
    secondary_keys: [...entry.secondaryKeys],
    content: renderContent
      ? renderAgentLoreText(entry.content, names)
      : entry.content,
    position: entry.position,
    depth: entry.depth,
    role: entry.role,
    activated: entry.activated,
  };
}

function textPage(
  title: string,
  envelope: PageEnvelope<Record<string, unknown>>,
): string {
  const rows = envelope.data.map((row) => JSON.stringify(row));
  return [
    title,
    ...rows,
    JSON.stringify({
      total: envelope.total,
      limit: envelope.limit,
      offset: envelope.offset,
      truncated: envelope.truncated,
    }),
  ].join("\n");
}

function ok(toolName: CoreAgentToolId, data: unknown): AgentToolResult {
  return { status: "success", toolName, data };
}

function failure(
  toolName: CoreAgentToolId,
  errorCode: NonNullable<AgentToolResult["errorCode"]>,
  message: string,
  data?: unknown,
): AgentToolResult {
  return { status: "error", toolName, errorCode, message, data };
}

async function executeLoreListBooks(
  args: unknown,
  context: AgentToolExecutionContext,
): Promise<AgentToolResult> {
  const toolName = "lore_list_books" as const;
  const record = parseRecord(args, ["scope", "folder", "query", "limit", "offset", "format"]);
  const parsed = parseCommon(record);
  assertScope(parsed.scope, context.grant);
  const folder = optionalString(record.folder, { allowEmpty: true });
  const query = optionalString(record.query);
  checkAbort(context.snapshot, context.signal);

  let envelope: PageEnvelope<Record<string, unknown>>;
  if (parsed.scope === "all_owned") {
    const reader = requireOwnedLoreReader(context.snapshot);
    const ownedBooks = reader.listBooks({
      limit: parsed.limit,
      offset: parsed.offset,
      ...(folder !== undefined ? { folder } : {}),
      ...(query !== undefined ? { query } : {}),
    });
    envelope = {
      ...ownedPage(ownedBooks),
      data: ownedBooks.data.map(projectBook),
    };
  } else {
    const normalizedQuery = query?.toLocaleLowerCase();
    const filtered = context.snapshot.books.filter((book) => (
      book.active &&
      (folder === undefined || book.folder === folder) &&
      (normalizedQuery === undefined ||
        book.name.toLocaleLowerCase().includes(normalizedQuery) ||
        book.description.toLocaleLowerCase().includes(normalizedQuery))
    ));
    envelope = page(
      filtered
        .slice(parsed.offset, parsed.offset + parsed.limit)
        .map(projectBook),
      filtered.length,
      parsed,
    );
  }
  checkAbort(context.snapshot, context.signal);
  return ok(toolName, parsed.format === "text" ? textPage("Lore books", envelope) : envelope);
}

async function executeLoreListEntries(
  args: unknown,
  context: AgentToolExecutionContext,
  includeBook: boolean,
): Promise<AgentToolResult> {
  const toolName = includeBook ? "lore_get_book" as const : "lore_list_entries" as const;
  const record = parseRecord(args, ["book_id", "book_name", "scope", "limit", "offset", "format"]);
  const parsed = parseCommon(record);
  const selector = parseBookSelector(record);
  assertScope(parsed.scope, context.grant);
  checkAbort(context.snapshot, context.signal);
  const resolution = resolveBook(context.snapshot, parsed.scope, selector);
  if (resolution.status === "not_found") return failure(toolName, "not_found", "Lore book not found");
  if (resolution.status === "ambiguous") {
    return failure(toolName, "ambiguous", "Lore book name is ambiguous; retry with book_id", resolution.candidates);
  }

  let envelope: PageEnvelope<Record<string, unknown>>;
  if (parsed.scope === "all_owned") {
    const reader = requireOwnedLoreReader(context.snapshot);
    const ownedEntries = reader.listEntries({
      bookId: resolution.book.id,
      limit: parsed.limit,
      offset: parsed.offset,
    });
    envelope = {
      ...ownedPage(ownedEntries),
      data: ownedEntries.data.map((entry) => projectEntry(
        entry,
        context.snapshot.names,
        parsed.format === "text",
      )),
    };
  } else {
    const matches = context.snapshot.entries.filter(
      (entry) => entry.bookId === resolution.book.id,
    );
    const entries = matches
      .slice(parsed.offset, parsed.offset + parsed.limit)
      .map((entry) => projectEntry(
        entry,
        context.snapshot.names,
        parsed.format === "text",
      ));
    envelope = page(entries, matches.length, parsed);
  }
  const data = includeBook
    ? { book: projectBook(resolution.book), entries: envelope }
    : envelope;
  checkAbort(context.snapshot, context.signal);
  if (parsed.format === "text") {
    return ok(toolName, `${JSON.stringify(projectBook(resolution.book))}\n${textPage("Lore entries", envelope)}`);
  }
  return ok(toolName, data);
}

async function executeLoreGetEntry(
  args: unknown,
  context: AgentToolExecutionContext,
): Promise<AgentToolResult> {
  const toolName = "lore_get_entry" as const;
  const record = parseRecord(args, ["entry_id", "scope", "format"], ["entry_id"]);
  const entryId = optionalString(record.entry_id);
  const scope = parseScope(record.scope);
  const format = parseFormat(record.format);
  assertScope(scope, context.grant);
  checkAbort(context.snapshot, context.signal);

  const entry = scope === "all_owned"
    ? requireOwnedLoreReader(context.snapshot).getEntry(entryId!)
    : context.snapshot.entries.find((candidate) => candidate.id === entryId) ?? null;
  const book = entry
    ? scope === "all_owned"
      ? requireOwnedLoreReader(context.snapshot).getBook(entry.bookId)
      : context.snapshot.books.find((candidate) => candidate.id === entry.bookId)
    : undefined;
  const data =
    entry && book && (scope === "all_owned" || book.active)
      ? projectEntry(entry, context.snapshot.names, format === "text")
      : null;
  checkAbort(context.snapshot, context.signal);
  if (!data) return failure(toolName, "not_found", "Lore entry not found");
  return ok(toolName, format === "text" ? JSON.stringify(data) : data);
}

async function executeLoreSearchEntries(
  args: unknown,
  context: AgentToolExecutionContext,
): Promise<AgentToolResult> {
  const toolName = "lore_search_entries" as const;
  const record = parseRecord(
    args,
    ["query", "book_id", "book_name", "scope", "limit", "offset", "format"],
    ["query"],
  );
  const parsed = parseCommon(record);
  const query = optionalString(record.query) ?? "";
  const hasSelector = record.book_id !== undefined || record.book_name !== undefined;
  const selector = hasSelector ? parseBookSelector(record) : undefined;
  assertScope(parsed.scope, context.grant);
  checkAbort(context.snapshot, context.signal);

  let bookId: string | undefined;
  if (selector) {
    const resolution = resolveBook(context.snapshot, parsed.scope, selector);
    if (resolution.status === "not_found") return failure(toolName, "not_found", "Lore book not found");
    if (resolution.status === "ambiguous") {
      return failure(toolName, "ambiguous", "Lore book name is ambiguous; retry with book_id", resolution.candidates);
    }
    bookId = resolution.book.id;
  }

  let envelope: PageEnvelope<Record<string, unknown>>;
  if (parsed.scope === "all_owned") {
    const owned = requireOwnedLoreReader(context.snapshot).searchEntries({
      query,
      limit: parsed.limit,
      offset: parsed.offset,
      ...(bookId !== undefined ? { bookId } : {}),
    });
    envelope = {
      ...ownedPage(owned),
      data: owned.data.map((entry) => projectEntry(
        entry,
        context.snapshot.names,
        parsed.format === "text",
      )),
    };
  } else {
    const activeBookIds = new Set(
      context.snapshot.books
        .filter((book) => book.active)
        .map((book) => book.id),
    );
    const rankedMatches = context.snapshot.entries
      .filter((entry) => (
        activeBookIds.has(entry.bookId) &&
        (bookId === undefined || entry.bookId === bookId)
      ))
      .map((entry, index) => ({
        entry,
        index,
        rank: rankActiveLoreEntry(entry, query),
      }))
      .filter(({ rank }) => isAgentLoreSearchMatch(rank))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map(({ entry }) => entry);
    envelope = page(
      rankedMatches
        .slice(parsed.offset, parsed.offset + parsed.limit)
        .map((entry) => projectEntry(
          entry,
          context.snapshot.names,
          parsed.format === "text",
        )),
      rankedMatches.length,
      parsed,
    );
  }
  checkAbort(context.snapshot, context.signal);
  return ok(toolName, parsed.format === "text" ? textPage("Lore search results", envelope) : envelope);
}

async function executeChatSearchHistory(
  args: unknown,
  context: AgentToolExecutionContext,
): Promise<AgentToolResult> {
  const toolName = "chat_search_history" as const;
  const record = parseRecord(args, ["query", "role", "limit", "offset", "format"], ["query"]);
  const query = optionalString(record.query) ?? "";
  const role = record.role;
  if (role !== undefined && role !== "user" && role !== "assistant") throw new Error("invalid_arguments");
  const format = parseFormat(record.format);
  const parsed = parsePage(record);
  checkAbort(context.snapshot, context.signal);
  const normalized = query.toLocaleLowerCase();
  const matches = context.snapshot.chatMessages.filter((message) => (
    (role === undefined || message.role === role) &&
    message.content.toLocaleLowerCase().includes(normalized)
  ));
  const envelope = page(
    matches.slice(parsed.offset, parsed.offset + parsed.limit).map((message) => ({
      id: message.id,
      index_in_chat: message.indexInChat,
      role: message.role,
      name: message.name,
      content: message.content,
    })),
    matches.length,
    parsed,
  );
  checkAbort(context.snapshot, context.signal);
  return ok(toolName, format === "text" ? textPage("Chat history results", envelope) : envelope);
}

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function bookSelectorSchema(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...schema(properties),
    oneOf: [
      { required: ["book_id"], not: { required: ["book_name"] } },
      { required: ["book_name"], not: { required: ["book_id"] } },
    ],
  };
}
function optionalBookSelectorSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    ...schema(properties, required),
    oneOf: [
      {
        not: {
          anyOf: [
            { required: ["book_id"] },
            { required: ["book_name"] },
          ],
        },
      },
      { required: ["book_id"], not: { required: ["book_name"] } },
      { required: ["book_name"], not: { required: ["book_id"] } },
    ],
  };
}

const SCOPE_SCHEMA = { type: "string", enum: ["active", "all_owned"] };
const FORMAT_SCHEMA = { type: "string", enum: ["json", "text"] };
const LIMIT_SCHEMA = { type: "integer", minimum: 1, maximum: TOOL_PAGE_MAX };
const OFFSET_SCHEMA = { type: "integer", minimum: 0 };
const STRING_SCHEMA = { type: "string", minLength: 1, maxLength: TOOL_SELECTOR_MAX_BYTES };

export const CORE_AGENT_TOOL_CATALOG: Readonly<Record<CoreAgentToolId, CoreAgentToolCatalogEntry>> = Object.freeze({
  lore_list_books: {
    definition: {
      name: "lore_list_books",
      description: "List lore books within the authorized active or all-owned scope.",
      strict: true,
      parameters: schema({
        scope: SCOPE_SCHEMA,
        folder: { type: "string", maxLength: TOOL_SELECTOR_MAX_BYTES },
        query: STRING_SCHEMA,
        limit: LIMIT_SCHEMA,
        offset: OFFSET_SCHEMA,
        format: FORMAT_SCHEMA,
      }),
    },
    execute: executeLoreListBooks,
  },
  lore_get_book: {
    definition: {
      name: "lore_get_book",
      description: "Get one lore book and one bounded page of its enabled entries.",
      strict: true,
      parameters: bookSelectorSchema({
        book_id: STRING_SCHEMA,
        book_name: STRING_SCHEMA,
        scope: SCOPE_SCHEMA,
        limit: LIMIT_SCHEMA,
        offset: OFFSET_SCHEMA,
        format: FORMAT_SCHEMA,
      }),
    },
    execute: (args, context) => executeLoreListEntries(args, context, true),
  },
  lore_list_entries: {
    definition: {
      name: "lore_list_entries",
      description: "List a bounded page of enabled entries in one lore book.",
      strict: true,
      parameters: bookSelectorSchema({
        book_id: STRING_SCHEMA,
        book_name: STRING_SCHEMA,
        scope: SCOPE_SCHEMA,
        limit: LIMIT_SCHEMA,
        offset: OFFSET_SCHEMA,
        format: FORMAT_SCHEMA,
      }),
    },
    execute: (args, context) => executeLoreListEntries(args, context, false),
  },
  lore_get_entry: {
    definition: {
      name: "lore_get_entry",
      description: "Get one enabled lore entry by its documented entry ID.",
      strict: true,
      parameters: schema({
        entry_id: STRING_SCHEMA,
        scope: SCOPE_SCHEMA,
        format: FORMAT_SCHEMA,
      }, ["entry_id"]),
    },
    execute: executeLoreGetEntry,
  },
  lore_search_entries: {
    definition: {
      name: "lore_search_entries",
      description: "Search the authorized enabled lore corpus. Active results include entries with activated=false when they are in the generation snapshot; results rank identity matches before secondary keys and content.",
      strict: true,
      parameters: optionalBookSelectorSchema({
        query: STRING_SCHEMA,
        book_id: STRING_SCHEMA,
        book_name: STRING_SCHEMA,
        scope: SCOPE_SCHEMA,
        limit: LIMIT_SCHEMA,
        offset: OFFSET_SCHEMA,
        format: FORMAT_SCHEMA,
      }, ["query"]),
    },
    execute: executeLoreSearchEntries,
  },
  chat_search_history: {
    definition: {
      name: "chat_search_history",
      description: "Search the immutable current-generation chat transcript.",
      strict: true,
      parameters: schema({
        query: STRING_SCHEMA,
        role: { type: "string", enum: ["user", "assistant"] },
        limit: LIMIT_SCHEMA,
        offset: OFFSET_SCHEMA,
        format: FORMAT_SCHEMA,
      }, ["query"]),
    },
    execute: executeChatSearchHistory,
  },
});

export function getCoreAgentToolDefinitions(
  toolIds: readonly CoreAgentToolId[],
): ToolDefinition[] {
  return toolIds.map((toolId) =>
    structuredClone(CORE_AGENT_TOOL_CATALOG[toolId].definition),
  );
}

export async function executeCoreAgentTool(
  toolId: CoreAgentToolId,
  args: unknown,
  context: AgentToolExecutionContext,
): Promise<AgentToolResult> {
  if (!context.grant.toolIds.includes(toolId)) {
    return failure(toolId, "unauthorized", "Tool is not authorized");
  }
  try {
    const result = await CORE_AGENT_TOOL_CATALOG[toolId].execute(args, context);
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > AGENT_TOOL_RESULT_MAX_BYTES) {
      return failure(toolId, "limit_exceeded", "Tool result exceeds the response limit");
    }
    return result;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return failure(toolId, "cancelled", "Tool call was cancelled");
    }
    if (
      error instanceof Error &&
      (
        error.message === "agent_tool_limit_exceeded" ||
        ("code" in error && error.code === "agent_tool_limit_exceeded")
      )
    ) {
      return failure(toolId, "limit_exceeded", "Tool result exceeds the response limit");
    }
    if (error instanceof Error && error.message === "unauthorized") {
      return failure(toolId, "unauthorized", "Requested scope is not authorized");
    }
    if (error instanceof Error && error.message === "invalid_arguments") {
      return failure(toolId, "invalid_arguments", "Tool arguments are invalid");
    }
    return failure(toolId, "internal_error", "Tool execution failed");
  }
}
