import { Hono } from "hono";
import * as contextPacks from "../services/agent-context-packs.service";
import {
  ContextPackAclRevisionConflictError,
  ContextPackRevisionConflictError,
  ContextPackValidationError,
  parsePortableContextPackSnapshotV1,
  type ContextPackTargetScope,
} from "../types/agent-context-packs";

const app = new Hono();

function errorResponse(c: any, error: unknown): Response {
  if (error instanceof ContextPackAclRevisionConflictError) {
    return c.json({
      error: error.message,
      code: error.code,
      expectedContextAclRevision: error.expectedContextAclRevision,
      actualContextAclRevision: error.actualContextAclRevision,
    }, 409);
  }
  if (error instanceof ContextPackRevisionConflictError) {
    return c.json({ error: error.message, code: error.code, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision }, 409);
  }
  if (error instanceof ContextPackValidationError) {
    return c.json({ error: error.message, code: error.code, path: error.path }, 400);
  }
  console.error("[context-packs] request failed", error);
  return c.json({ error: "Context pack request failed", code: "CONTEXT_PACK_INTERNAL" }, 500);
}

function parseScope(value: string | undefined): ContextPackTargetScope | null {
  if (value === "preset" || value === "chat" || value === "world_book") return value;
  return null;
}

function parseNonNegativeInt(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

app.get("/", (c) => {
  const userId = c.get("userId");
  try {
    return c.json({
      data: contextPacks.listContextPacks(userId, {
        includeDisabled: c.req.query("include_disabled") === "true",
        includeReviewRequired: c.req.query("include_review") === "true",
        limit: parsePositiveInt(c.req.query("limit")),
        offset: parsePositiveInt(c.req.query("offset")),
      }),
      contextAclRevision: contextPacks.getContextAccountRevision(userId),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  try {
    const body = await c.req.json();
    return c.json(contextPacks.createContextPack(userId, body), 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// A foreign/portable import is intentionally static and cannot receive a
// target attachment in the same request.
app.post("/import", async (c) => {
  const userId = c.get("userId");
  try {
    const snapshot = parsePortableContextPackSnapshotV1(await c.req.json());
    return c.json(contextPacks.importForeignContextPack(userId, snapshot), 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/selectable", (c) => {
  const userId = c.get("userId");
  try {
    return c.json({
      data: contextPacks.listSelectableContextPackRevisions(
        userId,
        parsePositiveInt(c.req.query("limit")),
      ),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/:packId/revisions", (c) => {
  const userId = c.get("userId");
  const packId = c.req.param("packId");
  try {
    const pack = contextPacks.getContextPack(userId, packId, { includeInactive: true });
    if (!pack) return c.json({ error: "Not found" }, 404);
    return c.json({ data: contextPacks.listContextPackRevisions(userId, packId, { includeInactive: c.req.query("include_inactive") === "true" }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/:packId/revisions", async (c) => {
  const userId = c.get("userId");
  const packId = c.req.param("packId");
  try {
    const revision = contextPacks.createContextPackRevision(userId, packId, await c.req.json());
    if (!revision) return c.json({ error: "Not found" }, 404);
    return c.json(revision, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/:packId/revisions/:revision", (c) => {
  const userId = c.get("userId");
  const revision = parsePositiveInt(c.req.param("revision"));
  if (!revision) return c.json({ error: "Not found" }, 404);
  try {
    const result = contextPacks.getContextPackRevision(userId, c.req.param("packId"), revision, { includeInactive: c.req.query("include_inactive") === "true" });
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/:packId/acl", (c) => {
  const userId = c.get("userId");
  try {
    const acl = contextPacks.getContextPackAcl(userId, c.req.param("packId"));
    if (!acl) return c.json({ error: "Not found" }, 404);
    return c.json({ data: acl });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.put("/:packId/acl", async (c) => {
  const userId = c.get("userId");
  try {
    const body = await c.req.json();
    const entries = body?.entries;
    const expectedContextAclRevision = parseNonNegativeInt(body?.expectedContextAclRevision);
    if (expectedContextAclRevision === undefined) return c.json({ error: "expectedContextAclRevision is required" }, 400);
    const acl = contextPacks.setContextPackAcl(userId, c.req.param("packId"), entries, expectedContextAclRevision);
    if (!acl) return c.json({ error: "Not found" }, 404);
    return c.json({ data: acl, contextAclRevision: contextPacks.getContextAccountRevision(userId) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/:packId/review", async (c) => {
  const userId = c.get("userId");
  try {
    const result = contextPacks.reviewContextPack(userId, c.req.param("packId"), await c.req.json());
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json({ pack: result, contextAclRevision: contextPacks.getContextAccountRevision(userId) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/:packId/attachments", (c) => {
  const userId = c.get("userId");
  const packId = c.req.param("packId");
  const scope = parseScope(c.req.query("scope"));
  const targetId = c.req.query("target_id");
  try {
    const pack = contextPacks.getContextPack(userId, packId, { includeInactive: true });
    if (!pack) return c.json({ error: "Not found" }, 404);
    let attachments = [...contextPacks.listContextPackAttachmentsForPack(userId, packId, {
      includeInactive: c.req.query("include_inactive") === "true",
    })];
    if (scope) attachments = attachments.filter((attachment) => attachment.scope === scope);
    if (targetId) attachments = attachments.filter((attachment) => attachment.targetId === targetId);
    return c.json({ data: attachments });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/:packId/attachments", async (c) => {
  const userId = c.get("userId");
  try {
    const attachment = contextPacks.attachContextPack(userId, c.req.param("packId"), await c.req.json());
    if (!attachment) return c.json({ error: "Not found" }, 404);
    return c.json({ attachment, contextAclRevision: contextPacks.getContextAccountRevision(userId) }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.delete("/:packId/attachments/:attachmentId", (c) => {
  const userId = c.get("userId");
  const scope = parseScope(c.req.query("scope"));
  const expectedContextAclRevision = parseNonNegativeInt(c.req.query("expected_revision"));
  if (!scope) return c.json({ error: "scope is required" }, 400);
  if (expectedContextAclRevision === undefined) return c.json({ error: "expected_revision is required" }, 400);
  try {
    if (!contextPacks.deleteContextPackAttachment(userId, scope, c.req.param("attachmentId"), expectedContextAclRevision)) return c.json({ error: "Not found" }, 404);
    return c.json({ success: true, contextAclRevision: contextPacks.getContextAccountRevision(userId) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/:packId/export", (c) => {
  const userId = c.get("userId");
  try {
    const revision = parsePositiveInt(c.req.query("revision"));
    const snapshot = contextPacks.exportContextPack(userId, c.req.param("packId"), revision);
    if (!snapshot) return c.json({ error: "Not found" }, 404);
    return c.json(snapshot);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/:packId/duplicate", async (c) => {
  const userId = c.get("userId");
  try {
    const result = contextPacks.duplicateContextPack(userId, c.req.param("packId"), await c.req.json());
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.delete("/:packId", (c) => {
  const userId = c.get("userId");
  const expectedRevision = parseNonNegativeInt(c.req.query("expected_revision"));
  if (expectedRevision === undefined) return c.json({ error: "expected_revision is required" }, 400);
  try {
    if (!contextPacks.deleteContextPack(userId, c.req.param("packId"), expectedRevision)) return c.json({ error: "Not found" }, 404);
    return c.json({ success: true, contextAclRevision: contextPacks.getContextAccountRevision(userId) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/:packId", (c) => {
  const userId = c.get("userId");
  try {
    const pack = contextPacks.getContextPack(userId, c.req.param("packId"), { includeInactive: c.req.query("include_inactive") === "true" });
    if (!pack) return c.json({ error: "Not found" }, 404);
    return c.json({ pack, revisions: contextPacks.listContextPackRevisions(userId, pack.id, { includeInactive: c.req.query("include_inactive") === "true" }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.put("/:packId", async (c) => {
  const userId = c.get("userId");
  try {
    const pack = contextPacks.updateContextPack(userId, c.req.param("packId"), await c.req.json());
    if (!pack) return c.json({ error: "Not found" }, 404);
    return c.json({ pack, contextAclRevision: contextPacks.getContextAccountRevision(userId) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export { app as agentContextPacksRoutes };
