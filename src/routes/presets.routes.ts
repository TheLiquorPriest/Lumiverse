import { createHash } from "node:crypto";
import { Hono } from "hono";
import * as svc from "../services/presets.service";
import * as stashSvc from "../services/prompt-stash.service";
import { PresetRevisionConflictError } from "../types/preset";
import { AgentConfigValidationError } from "../types/agents";
import { parsePagination } from "../services/pagination";
import { REVALIDATE_PRIVATE, ifNoneMatchSatisfies } from "../utils/http-cache";
import { getAgentRuntimeHostLimits } from "../services/agent-runtime-limits";
import { duplicatePresetWithAgentConfig, encodePortableAgentConfig, getAgentRuntimeSharedDraft, getPortablePresetRuntimeEnvelope, getPresetAgentConfig, importPortablePreset, importPortablePresetRuntime, parsePortablePresetRuntimeImportRequest, saveAgentRuntimeSharedDraft } from "../services/agent-config-portability.service";

const app = new Hono();

function userEtagScope(userId: string): string {
  return createHash("sha256").update(userId).digest("base64url");
}

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listPresets(userId, pagination));
});

app.get("/registry", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const provider = c.req.query("provider") || undefined;
  const engine = c.req.query("engine") || undefined;

  // Hashing the filtered `(id, cache_revision)` sequence catches every update
  // and delete/create replacement without reading preset JSON blobs.
  const sig = svc.getPresetRegistrySignature(userId, provider, engine);
  const etag = `W/"presets-reg-${sig}-${pagination.limit}-${pagination.offset}"`;
  if (ifNoneMatchSatisfies(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": REVALIDATE_PRIVATE, Vary: "Cookie, Accept-Encoding" } });
  }
  c.header("ETag", etag);
  c.header("Cache-Control", REVALIDATE_PRIVATE);
  c.header("Vary", "Cookie, Accept-Encoding");
  return c.json(svc.listPresetRegistry(userId, pagination, provider, engine));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.provider) return c.json({ error: "name and provider are required" }, 400);
  try {
    return c.json(svc.createPreset(userId, body), 201);
  } catch (err) {
    if (err instanceof AgentConfigValidationError) {
      return c.json({ error: err.message, code: err.code, path: err.path }, 400);
    }
    throw err;
  }
});

app.get("/stash", (c) => {
  return c.json(stashSvc.listPromptStash(c.get("userId")));
});

app.post("/stash", async (c) => {
  const body = await c.req.json();
  try {
    if (!body?.block || typeof body.block !== "object") return c.json({ error: "block is required" }, 400);
    const userId = c.get("userId");
    const sourcePreset = typeof body.sourcePresetId === "string"
      ? svc.getPreset(userId, body.sourcePresetId)
      : null;
    return c.json(
      stashSvc.addPromptBlockToStash(
        userId,
        body.block,
        sourcePreset ? { id: sourcePreset.id, name: sourcePreset.name } : undefined,
      ),
      201,
    );
  } catch (err: any) {
    return c.json({ error: err?.message || "Unable to add prompt block to stash" }, 400);
  }
});

app.delete("/stash/:stashId", (c) => {
  const deleted = stashSvc.removePromptBlockFromStash(c.get("userId"), c.req.param("stashId"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.get("/agent-runtime-limits", (c) => {
  return c.json(getAgentRuntimeHostLimits());
});

app.get("/:id/agent-config", (c) => {
  const editor = getAgentRuntimeSharedDraft(c.get("userId"), c.req.param("id"));
  if (!editor) return c.json({ error: "Not found" }, 404);
  return c.json(editor);
});

app.put("/:id/agent-config", async (c) => {
  try {
    const body = await c.req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("AGENT_RUNTIME_DRAFT_INVALID");
    const allowedKeys = new Set(["config", "slotBindings", "contextPackSelections", "contextRules", "taskTemplates", "reviewAcknowledgements", "promptOrder", "expectedPresetRevision", "expectedConfigRevision"]);
    for (const key of Object.keys(body)) if (!allowedKeys.has(key)) throw new Error("AGENT_RUNTIME_DRAFT_UNKNOWN_FIELD");
    for (const key of allowedKeys) if (!Object.hasOwn(body, key)) throw new Error("AGENT_RUNTIME_DRAFT_MISSING_FIELD");
    const result = saveAgentRuntimeSharedDraft(c.get("userId"), c.req.param("id"), {
      config: body.config, slotBindings: body.slotBindings, contextPackSelections: body.contextPackSelections, contextRules: body.contextRules, taskTemplates: body.taskTemplates, reviewAcknowledgements: body.reviewAcknowledgements, promptOrder: body.promptOrder, expectedPresetRevision: body.expectedPresetRevision, expectedConfigRevision: body.expectedConfigRevision,
    });
    return c.json(result);
  } catch (error: any) {
    const message = error?.message || "Invalid agent runtime draft";
    const code = message === "PRESET_REVISION_CONFLICT" || message === "AGENT_CONFIG_REVISION_CONFLICT" ? message : message === "PRESET_REVISION_REQUIRED" || message === "AGENT_CONFIG_REVISION_REQUIRED" ? message : "AGENT_CONFIG_INVALID";
    return c.json({ error: message, code }, code.endsWith("CONFLICT") ? 409 : code === "PRESET_REVISION_REQUIRED" || code === "AGENT_CONFIG_REVISION_REQUIRED" ? 428 : 400);
  }
});

app.get("/:id/agent-runtime/portable", (c) => {
  try {
    const envelope = getPortablePresetRuntimeEnvelope(c.get("userId"), c.req.param("id"));
    if (!envelope) return c.json({ error: "Not found" }, 404);
    return c.json(envelope);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Portable Agent Runtime requires repair";
    return c.json({ error: message, code: "AGENT_RUNTIME_PORTABLE_INVALID" }, 400);
  }
});
app.post("/import-portable", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = parsePortablePresetRuntimeImportRequest(body);
    const result = importPortablePresetRuntime(c.get("userId"), parsed);
    return c.json(result, 201);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid portable preset runtime";
    const code = message.startsWith("AGENT_RUNTIME_PORTABLE_REGEX_INVALID")
      ? "AGENT_RUNTIME_PORTABLE_REGEX_INVALID"
      : message === "PRESET_REVISION_CONFLICT"
        ? "PRESET_REVISION_CONFLICT"
        : message === "PRESET_REVISION_REQUIRED"
          ? "PRESET_REVISION_REQUIRED"
          : "AGENT_RUNTIME_PORTABLE_INVALID";
    const status = code === "PRESET_REVISION_CONFLICT"
      ? 409
      : code === "PRESET_REVISION_REQUIRED"
        ? 428
        : 400;
    return c.json({ error: message, code }, status);
  }
});

app.get("/:id/agent-config/portable", (c) => {
  const projection = getPresetAgentConfig(c.get("userId"), c.req.param("id"));
  if (!projection) return c.json({ error: "Not found" }, 404);
  return c.json(JSON.parse(encodePortableAgentConfig(projection.config)));
});

app.post("/agent-config/portable/import", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(importPortablePreset(c.get("userId"), body), 201);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid portable preset";
    const code = typeof message === "string" && message.startsWith("AGENT_RUNTIME_PORTABLE_REGEX_INVALID")
      ? "AGENT_RUNTIME_PORTABLE_REGEX_INVALID"
      : "PORTABLE_PRESET_INVALID";
    return c.json({ error: message, code }, 400);
  }
});

app.post("/:id/duplicate", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json(duplicatePresetWithAgentConfig(c.get("userId"), c.req.param("id"), typeof body?.name === "string" ? body.name : undefined), 201);
  } catch (error: any) {
    return c.json({ error: error?.message || "Preset not found" }, error?.message === "Preset not found" ? 404 : 400);
  }
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  // A dedicated monotonic revision drives this ETag, so same-second updates
  // invalidate cache entries without altering the user's visible update time.
  const cacheRevision = svc.getPresetCacheRevision(userId, id);
  if (cacheRevision == null) return c.json({ error: "Not found" }, 404);

  const etag = `W/"preset-${id}-${cacheRevision}-${userEtagScope(userId)}"`;
  if (ifNoneMatchSatisfies(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": REVALIDATE_PRIVATE, Vary: "Cookie, Accept-Encoding" } });
  }

  const preset = svc.getPreset(userId, id);
  if (!preset) return c.json({ error: "Not found" }, 404); // deleted between lookups
  c.header("ETag", etag);
  c.header("Cache-Control", REVALIDATE_PRIVATE);
  c.header("Vary", "Cookie, Accept-Encoding");
  return c.json(preset);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (
    typeof body.expected_cache_revision !== "number"
    || !Number.isSafeInteger(body.expected_cache_revision)
    || body.expected_cache_revision < 0
  ) {
    return c.json({
      error: "expected_cache_revision is required",
      code: "PRESET_REVISION_REQUIRED",
    }, 428);
  }
  try {
    const preset = svc.updatePreset(userId, c.req.param("id"), body);
    if (!preset) return c.json({ error: "Not found" }, 404);
    return c.json(preset);
  } catch (err) {
    if (err instanceof PresetRevisionConflictError) {
      return c.json({
        error: err.message,
        code: err.code,
        expected_cache_revision: err.expectedCacheRevision,
        actual_cache_revision: err.actualCacheRevision,
      }, 409);
    }
    if (err instanceof AgentConfigValidationError) {
      return c.json({ error: err.message, code: err.code, path: err.path }, 400);
    }
    throw err;
  }
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  if (!svc.deletePreset(userId, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as presetsRoutes };
