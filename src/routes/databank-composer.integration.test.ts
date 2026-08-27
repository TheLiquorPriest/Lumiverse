import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { JSDOM } from "jsdom";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { chatsRoutes } from "./chats.routes";
import { databankRoutes } from "./databank.routes";

interface AutocompleteResult {
  slug: string;
  name: string;
  databankId: string;
  databankName: string;
}

const frontendSourceDir = join(import.meta.dir, "..", "..", "frontend", "src");
const { databankApi } = await import(join(frontendSourceDir, "api", "databank.ts"));
const {
  DatabankAutocompleteCoordinator,
  getDatabankMentionAtCaret,
} = await import(join(frontendSourceDir, "lib", "databankMentionAutocomplete.ts"));

const USER_ID = "ar007-composer-user";
const FOREIGN_USER_ID = "ar007-composer-foreign-user";
const CHARACTER_ID = "ar007-composer-character";
const UNRELATED_CHAT_ID = "ar007-unrelated-chat";

const ATTACHED_BANK_ID = "ar007-attached-bank";
const GLOBAL_BANK_ID = "ar007-global-bank";
const DISABLED_BANK_ID = "ar007-disabled-bank";
const FOREIGN_BANK_ID = "ar007-foreign-bank";
const NON_READY_BANK_ID = "ar007-non-ready-bank";

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", USER_ID);
  await next();
});
app.route("/api/v1/chats", chatsRoutes);
app.route("/api/v1/databanks", databankRoutes);

interface SeedDocumentInput {
  bankId: string;
  userId: string;
  name: string;
  slug: string;
  scope: "global" | "chat";
  scopeId: string | null;
  enabled: boolean;
  status: "ready" | "processing";
}

function seedBankWithDocument(input: SeedDocumentInput): void {
  const now = 1_700_000_000;
  const documentId = `${input.bankId}-document`;
  const content = `Content for ${input.slug}.`;

  getDb().query(
    `INSERT INTO databanks (
      id, user_id, name, description, scope, scope_id, enabled, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, '', ?, ?, ?, '{}', ?, ?)`,
  ).run(
    input.bankId,
    input.userId,
    `${input.name} Bank`,
    input.scope,
    input.scopeId,
    input.enabled ? 1 : 0,
    now,
    now,
  );

  getDb().query(
    `INSERT INTO databank_documents (
      id, databank_id, user_id, name, slug, file_path, mime_type, file_size,
      content_hash, total_chunks, status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'text/plain', ?, ?, 1, ?, '{}', ?, ?)`,
  ).run(
    documentId,
    input.bankId,
    input.userId,
    input.name,
    input.slug,
    `/test/${documentId}.txt`,
    content.length,
    `${documentId}-hash`,
    input.status,
    now,
    now,
  );

  getDb().query(
    `INSERT INTO databank_chunks (
      id, document_id, databank_id, user_id, chunk_index, content, token_count,
      metadata, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, 8, '{}', ?)`,
  ).run(
    `${documentId}-chunk`,
    documentId,
    input.bankId,
    input.userId,
    content,
    now,
  );
}

let dom: JSDOM;
let originalFetchDescriptor: PropertyDescriptor | undefined;
let originalWindowDescriptor: PropertyDescriptor | undefined;
let autocompleteRequestUrl: URL | null;
let autocompleteCacheControl: string | null;

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());

  getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(
    USER_ID,
    "AR007 Composer User",
    "ar007-composer@example.test",
  );
  getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(
    FOREIGN_USER_ID,
    "AR007 Foreign User",
    "ar007-foreign@example.test",
  );
  getDb().query(
    "INSERT INTO characters (id, name, extensions, user_id) VALUES (?, ?, '{}', ?)",
  ).run(CHARACTER_ID, "AR007 Character", USER_ID);

  seedBankWithDocument({
    bankId: ATTACHED_BANK_ID,
    userId: USER_ID,
    name: "AR007 Attached",
    slug: "ar007-attached",
    scope: "chat",
    scopeId: UNRELATED_CHAT_ID,
    enabled: true,
    status: "ready",
  });
  seedBankWithDocument({
    bankId: GLOBAL_BANK_ID,
    userId: USER_ID,
    name: "AR007 Global",
    slug: "ar007-global",
    scope: "global",
    scopeId: null,
    enabled: true,
    status: "ready",
  });
  seedBankWithDocument({
    bankId: DISABLED_BANK_ID,
    userId: USER_ID,
    name: "AR007 Disabled",
    slug: "ar007-disabled",
    scope: "chat",
    scopeId: UNRELATED_CHAT_ID,
    enabled: false,
    status: "ready",
  });
  seedBankWithDocument({
    bankId: FOREIGN_BANK_ID,
    userId: FOREIGN_USER_ID,
    name: "AR007 Foreign",
    slug: "ar007-foreign",
    scope: "chat",
    scopeId: UNRELATED_CHAT_ID,
    enabled: true,
    status: "ready",
  });
  seedBankWithDocument({
    bankId: NON_READY_BANK_ID,
    userId: USER_ID,
    name: "AR007 Processing",
    slug: "ar007-processing",
    scope: "global",
    scopeId: null,
    enabled: true,
    status: "processing",
  });

  dom = new JSDOM("<!doctype html><html><body><textarea></textarea></body></html>", {
    url: "http://lumiverse.test/chat",
  });
  originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: dom.window,
  });

  originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  autocompleteRequestUrl = null;
  autocompleteCacheControl = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await app.fetch(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/databanks/mentions/autocomplete") {
        autocompleteRequestUrl = url;
        autocompleteCacheControl = response.headers.get("Cache-Control");
      }
      return response;
    },
  });
});

afterEach(() => {
  if (originalFetchDescriptor) {
    Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "fetch");
  }
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
  dom.window.close();
  closeDatabase();
});

describe("persisted-chat databank composer autocomplete", () => {
  test("reloads chat attachments and offers only enabled READY attached and global documents", async () => {
    const createResponse = await app.request("/api/v1/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        character_id: CHARACTER_ID,
        name: "AR007 persisted composer chat",
      }),
    });
    expect(createResponse.status).toBe(201);
    const createdChat = await createResponse.json() as { id: string };

    const attachmentIds = [ATTACHED_BANK_ID, DISABLED_BANK_ID, FOREIGN_BANK_ID];
    const attachResponse = await app.request(`/api/v1/chats/${createdChat.id}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_databank_ids: attachmentIds }),
    });
    expect(attachResponse.status).toBe(200);

    const reloadResponse = await app.request(`/api/v1/chats/${createdChat.id}`);
    expect(reloadResponse.status).toBe(200);
    const reloadedChat = await reloadResponse.json() as {
      id: string;
      metadata: { chat_databank_ids?: string[] };
    };
    expect(reloadedChat.metadata.chat_databank_ids).toEqual(attachmentIds);

    const textarea = dom.window.document.querySelector("textarea");
    if (!textarea) throw new Error("JSDOM textarea was not created");

    const coordinator = new DatabankAutocompleteCoordinator({ delayMs: 0 });
    const detectedMentions: Array<{ query: string; startIndex: number } | null> = [];
    let resolveResults!: (value: AutocompleteResult[]) => void;
    let rejectResults!: (error: unknown) => void;
    const resultsPromise = new Promise<AutocompleteResult[]>((resolve, reject) => {
      resolveResults = resolve;
      rejectResults = reject;
    });

    textarea.addEventListener("input", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof dom.window.HTMLTextAreaElement)) {
        rejectResults(new Error("Input event did not originate from the JSDOM textarea"));
        return;
      }

      const detectedMention = getDatabankMentionAtCaret(target);
      detectedMentions.push(detectedMention);
      coordinator.schedule({
        query: detectedMention?.query ?? null,
        contextKey: reloadedChat.id,
        request: (query: string, signal: AbortSignal) => databankApi.autocomplete({
          q: query,
          chatId: reloadedChat.id,
        }, signal),
        onSuccess: ({ data }: { data: AutocompleteResult[] }) => resolveResults(data),
        onError: (error: unknown) => rejectResults(error),
        onClear: () => rejectResults(new Error("AR007 mention was unexpectedly cleared")),
      });
    });

    try {
      textarea.value = "#ar007";
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        data: "#ar007",
        inputType: "insertText",
      }));

      const results = await resultsPromise;
      expect(detectedMentions).toEqual([{ query: "ar007", startIndex: 0 }]);
      expect(autocompleteRequestUrl?.searchParams.get("q")).toBe("ar007");
      expect(autocompleteRequestUrl?.searchParams.get("chatId")).toBe(reloadedChat.id);
      expect(autocompleteRequestUrl?.searchParams.has("characterId")).toBe(false);
      expect(autocompleteCacheControl).toBe("private, no-store");

      expect(results).toEqual([
        {
          slug: "ar007-attached",
          name: "AR007 Attached",
          databankId: ATTACHED_BANK_ID,
          databankName: "AR007 Attached Bank",
        },
        {
          slug: "ar007-global",
          name: "AR007 Global",
          databankId: GLOBAL_BANK_ID,
          databankName: "AR007 Global Bank",
        },
      ]);
      const slugs = results.map((result) => result.slug);
      expect(slugs).not.toContain("ar007-disabled");
      expect(slugs).not.toContain("ar007-foreign");
      expect(slugs).not.toContain("ar007-processing");
    } finally {
      coordinator.dispose();
    }
  });
});
