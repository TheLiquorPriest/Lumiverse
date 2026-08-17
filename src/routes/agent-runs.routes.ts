import { Hono } from "hono";
import type { Context } from "hono";
import {
  AgentRunStopUnavailableError,
  getAgentRun,
  getAgentRunChanges,
  getWorkspaceIndex,
  getWorkspacePreview,
  requestAgentRunStop,
} from "../services/agent-run-projection.service";
import type { AgentWorkspaceSectionIdV2 } from "../types/agent-run-projection";

const app = new Hono();
const WORKSPACE_SECTIONS = new Set<AgentWorkspaceSectionIdV2>([
  "objective", "tasks", "records", "submissions", "artifacts",
]);

function notFound(c: Context): Response {
  return c.json({ error: "Not found" }, 404);
}

function authenticatedUserId(c: Context): string | null {
  const userId = c.get("userId");
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

function cursorFor(c: Context): string | undefined {
  return c.req.query("cursor") || c.req.header("x-agent-run-cursor") || undefined;
}

type OptionalIdResult = { readonly present: boolean; readonly value?: string; readonly invalid: boolean };

function optionalQueryId(c: Context, keys: readonly string[]): OptionalIdResult {
  const values = keys
    .map((key) => c.req.query(key))
    .filter((value): value is string => value !== undefined);
  if (values.length === 0) return { present: false, invalid: false };
  if (values.some((value) => value.length === 0)) return { present: true, invalid: true };
  const first = values[0]!;
  return {
    present: true,
    ...(values.every((value) => value === first) ? { value: first } : {}),
    invalid: !values.every((value) => value === first),
  };
}

function optionalBodyId(body: Record<string, unknown>, keys: readonly string[]): OptionalIdResult {
  const values: unknown[] = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) values.push(body[key]);
  }
  if (values.length === 0) return { present: false, invalid: false };
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    return { present: true, invalid: true };
  }
  const strings = values as string[];
  const first = strings[0]!;
  return {
    present: true,
    ...(strings.every((value) => value === first) ? { value: first } : {}),
    invalid: !strings.every((value) => value === first),
  };
}

function chatChanges(c: Context, chatId: string | undefined): Response {
  const userId = authenticatedUserId(c);
  if (!userId || !chatId) return notFound(c);
  const changes = getAgentRunChanges(userId, chatId, cursorFor(c));
  return changes ? c.json(changes) : notFound(c);
}

// Cursor delta/full-resync endpoints. The aliases keep the public surface
// stable while the frontend migrates from active polling to chat cursors.
app.get("/changes/:chatId", (c) => chatChanges(c, c.req.param("chatId")));
app.get("/:chatId/changes", (c) => chatChanges(c, c.req.param("chatId")));
app.get("/active/:chatId", (c) => chatChanges(c, c.req.param("chatId")));
app.get("/:chatId/active", (c) => chatChanges(c, c.req.param("chatId")));
app.get("/active", (c) => {
  const chatId = optionalQueryId(c, ["chatId", "chat_id"]);
  if (chatId.invalid || !chatId.value) return c.json({ error: "Invalid chat id" }, 400);
  return chatChanges(c, chatId.value);
});

function exactRun(c: Context, turnId: string): Response {
  const userId = authenticatedUserId(c);
  if (!userId || !turnId) return notFound(c);
  const chatId = optionalQueryId(c, ["chatId", "chat_id"]);
  if (chatId.invalid) return c.json({ error: "Invalid chat id" }, 400);
  const run = getAgentRun(userId, turnId, chatId.value);
  return run ? c.json(run) : notFound(c);
}

app.get("/status/:turnId", (c) => exactRun(c, c.req.param("turnId")));
app.get("/:turnId/status", (c) => exactRun(c, c.req.param("turnId")));
app.get("/:turnId", (c) => exactRun(c, c.req.param("turnId")));

app.get("/:turnId/workspace", (c) => {
  const userId = authenticatedUserId(c);
  const turnId = c.req.param("turnId");
  if (!userId || !turnId) return notFound(c);
  const index = getWorkspaceIndex(userId, turnId);
  return index ? c.json(index) : notFound(c);
});

app.get("/:turnId/workspace/:section", (c) => {
  const userId = authenticatedUserId(c);
  const turnId = c.req.param("turnId");
  const rawSection = c.req.param("section");
  if (!userId || !turnId || !WORKSPACE_SECTIONS.has(rawSection as AgentWorkspaceSectionIdV2)) return notFound(c);
  const pageRaw = c.req.query("page");
  const page = pageRaw === undefined ? 0 : Number(pageRaw);
  const expectedRevisionRaw = c.req.query("revision");
  const expectedRevision = expectedRevisionRaw === undefined ? undefined : Number(expectedRevisionRaw);
  if (!Number.isSafeInteger(page) || page < 0 || (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) {
    return c.json({ error: "Invalid workspace page" }, 400);
  }
  const preview = getWorkspacePreview(
    userId,
    turnId,
    rawSection as AgentWorkspaceSectionIdV2,
    page,
    expectedRevision,
  );
  return preview ? c.json(preview) : notFound(c);
});

app.post("/:turnId/stop", async (c) => {
  const userId = authenticatedUserId(c);
  const turnId = c.req.param("turnId");
  if (!userId || !turnId) return notFound(c);
  let body: Record<string, unknown> = {};
  try {
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json({ error: "Invalid stop request" }, 400);
      }
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return c.json({ error: "Invalid stop request" }, 400);
  }
  const chatIdResult = optionalBodyId(body, ["chat_id", "chatId"]);
  const generationIdResult = optionalBodyId(body, ["generation_id", "generationId"]);
  const rootIdResult = optionalBodyId(body, ["root_id", "rootId"]);
  if (chatIdResult.invalid || generationIdResult.invalid || rootIdResult.invalid) {
    return c.json({ error: "Invalid stop request" }, 400);
  }
  const chatId = chatIdResult.value;
  const generationId = generationIdResult.value;
  const rootId = rootIdResult.value;
  const run = getAgentRun(userId, turnId, chatId);
  if (!run || (generationId !== undefined && generationId !== run.generationId) || (rootId !== undefined && rootId !== turnId)) {
    return notFound(c);
  }
  try {
    const result = requestAgentRunStop(userId, run.chatId, turnId);
    return result ? c.json(result) : notFound(c);
  } catch (error) {
    if (error instanceof AgentRunStopUnavailableError) {
      return c.json({ error: error.code }, 409);
    }
    throw error;
  }
});
export const agentRunsRoutes = app;
