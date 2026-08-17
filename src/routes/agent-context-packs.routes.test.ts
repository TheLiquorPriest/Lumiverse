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
});
