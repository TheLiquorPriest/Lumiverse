import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { createContextPack } from "../services/agent-context-packs.service";
import { agentContextPacksRoutes } from "./agent-context-packs.routes";

const OWNER = "context-route-owner";
const OTHER = "context-route-other";
const PRESET_ID = "context-route-preset";
const app = new Hono();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  await next();
});
app.route("/context-packs", agentContextPacksRoutes);

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await runMigrations(getDb());
  getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(OWNER, OWNER, `${OWNER}@example.test`);
  getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(OTHER, OTHER, `${OTHER}@example.test`);
  getDb().query("INSERT INTO presets (id, name, provider, user_id) VALUES (?, ?, ?, ?)").run(PRESET_ID, "Route preset", "test", OWNER);
});

describe("authenticated context pack routes", () => {
  test("deletes an owned pack only with expected revision and returns actual ACL epoch", async () => {
    const created = createContextPack(OWNER, {
      name: "Route pack",
      content: [{ id: "entry", title: "Entry", body: "literal", tags: [] }],
    });
    const missingExpected = await app.request(`http://localhost/context-packs/${created.pack.id}`, {
      method: "DELETE",
      headers: { "x-test-user": OWNER },
    });
    expect(missingExpected.status).toBe(400);

    const stale = await app.request(`http://localhost/context-packs/${created.pack.id}?expected_revision=0`, {
      method: "DELETE",
      headers: { "x-test-user": OWNER },
    });
    expect(stale.status).toBe(409);

    const deleted = await app.request(`http://localhost/context-packs/${created.pack.id}?expected_revision=${created.pack.latestRevision}`, {
      method: "DELETE",
      headers: { "x-test-user": OWNER },
    });
    expect(deleted.status).toBe(200);
    const body = await deleted.json() as { success: boolean; contextAclRevision: number };
    expect(body.success).toBe(true);
    expect(body.contextAclRevision).toBeGreaterThan(created.pack.contextAclRevision);

    const ownerRead = await app.request(`http://localhost/context-packs/${created.pack.id}`, {
      headers: { "x-test-user": OWNER },
    });
    expect(ownerRead.status).toBe(404);
    const otherRead = await app.request(`http://localhost/context-packs/${created.pack.id}`, {
      headers: { "x-test-user": OTHER },
    });
    expect(otherRead.status).toBe(404);
  });

  test("lists exact shared revisions with use access but excludes read-only shares", async () => {
    const shared = createContextPack(OWNER, {
      name: "Shared route pack",
      content: [{ id: "entry", title: "Entry", body: "shared", tags: [] }],
    });
    getDb().query("UPDATE agent_context_packs SET visibility = 'account' WHERE user_id = ? AND id = ?")
      .run(OWNER, shared.pack.id);
    getDb().query(`INSERT INTO agent_context_pack_acls
      (user_id, pack_id, principal_user_id, permission)
      VALUES (?, ?, ?, 'read')`)
      .run(OWNER, shared.pack.id, OTHER);

    const readOnly = await app.request("http://localhost/context-packs/selectable", {
      headers: { "x-test-user": OTHER },
    });
    expect(readOnly.status).toBe(200);
    expect((await readOnly.json() as { data: unknown[] }).data).toEqual([]);

    getDb().query("UPDATE agent_context_pack_acls SET permission = 'use' WHERE user_id = ? AND pack_id = ? AND principal_user_id = ?")
      .run(OWNER, shared.pack.id, OTHER);
    const usable = await app.request("http://localhost/context-packs/selectable", {
      headers: { "x-test-user": OTHER },
    });
    expect(usable.status).toBe(200);
    expect((await usable.json() as { data: Array<Record<string, unknown>> }).data).toEqual([
      expect.objectContaining({
        ownerId: OWNER,
        source: "shared",
        packId: shared.pack.id,
        revision: 1,
      }),
    ]);
  });
});
