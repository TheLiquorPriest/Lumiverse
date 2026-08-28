import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { strFromU8, unzipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { initIdentity } from "../crypto/init";
import { env } from "../env";
import * as imageGenConnSvc from "../services/image-gen-connections.service";
import { imageGenConnectionSecretKey } from "../services/image-gen-connections.service";
import * as settingsSvc from "../services/settings.service";
import { getSecret, listSecretKeys } from "../services/secrets.service";
import {
  startImport,
  submitTicket,
} from "../services/user-data/import.service";
import { prepareCacheSize } from "../services/user-data/secret-ticket.service";
import { inspectLegacyImageGenerationPrivateData } from "../services/user-data/private-data";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { userDataRoutes } from "./user-data.routes";

const SOURCE_USER = "legacy-image-source";
const IMPORT_USER = "legacy-image-import";
const NANO_SECRET = "legacy-nanogpt-ticket-secret";
const NOVEL_SECRET = "legacy-novelai-ticket-secret";

const app = new Hono();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  await next();
});
app.route("/api/v1/user-data", userDataRoutes);
app.onError((error, c) => c.json({ error: error.message }, 500));

function seedUser(userId: string): void {
  getDb()
    .query(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) ' +
        "VALUES (?, ?, ?, 1, 0, 0)",
    )
    .run(userId, userId, `${userId}@example.test`);
}

function seedLegacySettings(userId: string, activeConnectionId?: string): void {
  settingsSvc.putSetting(userId, "imageGeneration", {
    enabled: true,
    provider: "novelai",
    activeImageGenConnectionId: activeConnectionId ?? null,
    nanogpt: {
      apiKey: NANO_SECRET,
      model: "hidream",
      size: "1024x1024",
      numInferenceSteps: 24,
    },
    novelai: {
      apiKey: NOVEL_SECRET,
      model: "nai-diffusion-4-5-full",
      sampler: "k_euler_ancestral",
      steps: 31,
    },
    legacyCredentialWrappers: [
      { wrapper: { nanogpt: [{ apiKey: NANO_SECRET, marker: "deep-nano" }] } },
      JSON.stringify({ wrapper: { novelai: { apiKey: NOVEL_SECRET, marker: "encoded-novel" } } }),
    ],
  });
}


function archiveRows(
  archive: Record<string, Uint8Array>,
  path: string,
): Array<Record<string, any>> {
  const bytes = archive[path];
  if (!bytes) throw new Error(`archive is missing ${path}`);
  return strFromU8(bytes)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}


describe("legacy image credentials at user-data ticket preparation", () => {
  let workDir = "";
  let previousDataDir = "";

  beforeAll(async () => {
    previousDataDir = env.dataDir;
    workDir = mkdtempSync(join(tmpdir(), "lumiverse-legacy-image-ticket-"));
    env.dataDir = workDir;
    await initIdentity();
  });

  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    seedUser(SOURCE_USER);
  });

  afterEach(() => closeDatabase());

  afterAll(() => {
    closeDatabase();
    env.dataDir = previousDataDir;
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("migrates both keys despite an unrelated connection and ticket-round-trips them", async () => {
    const unrelated = await imageGenConnSvc.createConnection(SOURCE_USER, {
      name: "Existing ComfyUI",
      provider: "comfyui",
      api_url: "http://127.0.0.1:8188",
      is_default: true,
      default_parameters: { steps: 20 },
    });
    seedLegacySettings(SOURCE_USER, unrelated.id);

    const prepareResponse = await app.request(
      "http://localhost/api/v1/user-data/export/prepare",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": SOURCE_USER,
        },
        body: JSON.stringify({ includeSecrets: true, includeVectors: false }),
      },
    );
    expect(prepareResponse.status).toBe(200);
    const prepared = await prepareResponse.json() as {
      archiveId: string;
      archiveUrl: string;
      ticket: unknown;
      secretsCount: number;
    };
    expect(prepared.ticket).toBeTruthy();
    expect(prepared.secretsCount).toBe(2);

    const sourceConnections = imageGenConnSvc.listConnections(SOURCE_USER, { limit: 20, offset: 0 });
    expect(sourceConnections.total).toBe(3);
    expect(imageGenConnSvc.getConnection(SOURCE_USER, unrelated.id)).toMatchObject({
      name: "Existing ComfyUI",
      provider: "comfyui",
      has_api_key: false,
      is_default: true,
      default_parameters: { steps: 20 },
    });
    const nano = sourceConnections.data.find((connection) => connection.provider === "nanogpt");
    const novel = sourceConnections.data.find((connection) => connection.provider === "novelai");
    expect(nano).toMatchObject({ name: "Nano-GPT (migrated)", has_api_key: true, is_default: false });
    expect(novel).toMatchObject({ name: "NovelAI (migrated)", has_api_key: true, is_default: false });
    expect(nano?.default_parameters.numInferenceSteps).toBe(24);
    expect(novel?.default_parameters.steps).toBe(31);

    const nanoKey = imageGenConnectionSecretKey(nano!.id);
    const novelKey = imageGenConnectionSecretKey(novel!.id);
    const expectedSecretKeys = [nanoKey, novelKey].sort();
    expect(listSecretKeys(SOURCE_USER)).toEqual(expectedSecretKeys);
    await expect(getSecret(SOURCE_USER, nanoKey)).resolves.toBe(NANO_SECRET);
    await expect(getSecret(SOURCE_USER, novelKey)).resolves.toBe(NOVEL_SECRET);

    const storedSettings = settingsSvc.getSetting(SOURCE_USER, "imageGeneration")!.value;
    expect(storedSettings.nanogpt).toEqual({
      model: "hidream",
      size: "1024x1024",
      numInferenceSteps: 24,
    });
    expect(storedSettings.novelai).toEqual({
      model: "nai-diffusion-4-5-full",
      sampler: "k_euler_ancestral",
      steps: 31,
    });
    expect(storedSettings.activeImageGenConnectionId).toBe(unrelated.id);
    expect(storedSettings.legacyCredentialWrappers[0]).toEqual({
      wrapper: { nanogpt: [{ marker: "deep-nano" }] },
    });
    expect(JSON.parse(storedSettings.legacyCredentialWrappers[1])).toEqual({
      wrapper: { novelai: { marker: "encoded-novel" } },
    });
    expect(inspectLegacyImageGenerationPrivateData(storedSettings)).toMatchObject({
      credentials: [],
      changed: false,
    });
    const atRest = getDb()
      .query("SELECT key, encrypted_value, iv, tag FROM secrets WHERE user_id = ? ORDER BY key")
      .all(SOURCE_USER);
    expect(JSON.stringify(atRest)).not.toContain(NANO_SECRET);
    expect(JSON.stringify(atRest)).not.toContain(NOVEL_SECRET);

    const archiveResponse = await app.request(`http://localhost${prepared.archiveUrl}`, {
      headers: { "x-test-user": SOURCE_USER },
    });
    expect(archiveResponse.status).toBe(200);
    const archiveBytes = new Uint8Array(await archiveResponse.arrayBuffer());
    const archive = unzipSync(archiveBytes);
    const secretIndex = JSON.parse(strFromU8(archive["secrets/index.json"]!)) as { keys: string[] };
    expect(secretIndex.keys.sort()).toEqual(expectedSecretKeys);
    expect(archiveRows(archive, "database/image_gen_connections.ndjson")).toHaveLength(3);
    const archiveText = Object.values(archive).map((entry) => strFromU8(entry)).join("\n");
    expect(archiveText).not.toContain(NANO_SECRET);
    expect(archiveText).not.toContain(NOVEL_SECRET);

    const archivePath = join(workDir, `${prepared.archiveId}.lvbak`);
    writeFileSync(archivePath, archiveBytes);

    // A fresh database models the receiving install and avoids global ID
    // collisions with the source connection rows retained by a same-DB test.
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    seedUser(IMPORT_USER);
    const jobId = crypto.randomUUID();
    let stopAwaitingTicket = () => {};
    const awaitingTicket = new Promise<void>((resolve) => {
      stopAwaitingTicket = eventBus.on(EventType.USER_IMPORT_PROGRESS, (event) => {
        if (
          event.userId === IMPORT_USER
          && event.payload?.jobId === jobId
          && event.payload?.phase === "awaiting_ticket"
        ) {
          stopAwaitingTicket();
          resolve();
        }
      });
    });
    const importJob = await startImport({ userId: IMPORT_USER, archivePath, jobId });
    await awaitingTicket;
    expect(importJob.status).toBe("awaiting_ticket");
    await expect(submitTicket(jobId, prepared.ticket)).resolves.toEqual({ accepted: true });
    expect(importJob.completion).toBeDefined();
    await importJob.completion;
    expect(importJob.status).toBe("complete");

    const importedConnections = imageGenConnSvc.listConnections(IMPORT_USER, { limit: 20, offset: 0 });
    expect(importedConnections.total).toBe(3);
    const importedNano = importedConnections.data.find((connection) => connection.provider === "nanogpt");
    const importedNovel = importedConnections.data.find((connection) => connection.provider === "novelai");
    expect(importedNano).toMatchObject({ id: nano!.id, has_api_key: false, review_required: true });
    expect(importedNovel).toMatchObject({ id: novel!.id, has_api_key: false, review_required: true });
    expect(listSecretKeys(IMPORT_USER)).toEqual(expectedSecretKeys);
    await expect(getSecret(IMPORT_USER, nanoKey)).resolves.toBe(NANO_SECRET);
    await expect(getSecret(IMPORT_USER, novelKey)).resolves.toBe(NOVEL_SECRET);
    const importedSettings = settingsSvc.getSetting(IMPORT_USER, "imageGeneration")!.value;
    expect(importedSettings.nanogpt.apiKey).toBeUndefined();
    expect(importedSettings.novelai.apiKey).toBeUndefined();
    expect(inspectLegacyImageGenerationPrivateData(importedSettings)).toMatchObject({
      credentials: [],
      changed: false,
    });
  });

  test("ticketless export never leaks legacy plaintext keys", async () => {
    seedLegacySettings(SOURCE_USER);

    const response = await app.request(
      "http://localhost/api/v1/user-data/export?includeVectors=0",
      { headers: { "x-test-user": SOURCE_USER } },
    );
    expect(response.status).toBe(200);
    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const settingsRows = archiveRows(archive, "database/settings.ndjson");
    const imageSettingsRow = settingsRows.find((row) => row.key === "imageGeneration");
    expect(imageSettingsRow).toBeDefined();
    const exportedSettings = JSON.parse(imageSettingsRow!.value);
    expect(exportedSettings.nanogpt.apiKey).toBeUndefined();
    expect(exportedSettings.novelai.apiKey).toBeUndefined();
    expect(Object.keys(archive).some((path) => path.startsWith("secrets/"))).toBe(false);
    const archiveText = Object.values(archive).map((entry) => strFromU8(entry)).join("\n");
    expect(archiveText).not.toContain(NANO_SECRET);
    expect(archiveText).not.toContain(NOVEL_SECRET);
  });

  test("direct empty placeholders are cleaned without creating secrets", async () => {
    settingsSvc.putSetting(SOURCE_USER, "imageGeneration", {
      provider: "nanogpt",
      nanogpt: { apiKey: "", model: "hidream" },
      novelai: { apiKey: null, model: "nai-diffusion-4-5-full" },
    });

    const response = await app.request(
      "http://localhost/api/v1/user-data/export/prepare",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": SOURCE_USER,
        },
        body: JSON.stringify({ includeSecrets: true, includeVectors: false }),
      },
    );
    expect(response.status).toBe(200);
    const prepared = await response.json() as { archiveUrl: string; secretsCount: number };
    expect(prepared.secretsCount).toBe(0);
    expect(imageGenConnSvc.listConnections(SOURCE_USER, { limit: 20, offset: 0 }).total).toBe(0);
    expect(listSecretKeys(SOURCE_USER)).toEqual([]);

    const stored = settingsSvc.getSetting(SOURCE_USER, "imageGeneration")!.value;
    expect(stored.nanogpt).toEqual({ model: "hidream" });
    expect(stored.novelai).toEqual({ model: "nai-diffusion-4-5-full" });
    expect(inspectLegacyImageGenerationPrivateData(stored)).toMatchObject({
      credentials: [],
      changed: false,
    });
    const archiveResponse = await app.request(
      "http://localhost" + prepared.archiveUrl,
      { headers: { "x-test-user": SOURCE_USER } },
    );
    expect(archiveResponse.status).toBe(200);
    expect(prepareCacheSize()).toBe(0);
  });

  test("recursive empty placeholders are cleaned without creating secrets", async () => {
    settingsSvc.putSetting(SOURCE_USER, "imageGeneration", {
      provider: "novelai",
      wrappers: [
        { nanogpt: [{ apiKey: null, marker: "deep-empty" }] },
        JSON.stringify({ novelai: { apiKey: "", marker: "encoded-empty" } }),
      ],
    });

    const response = await app.request(
      "http://localhost/api/v1/user-data/export/prepare",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": SOURCE_USER,
        },
        body: JSON.stringify({ includeSecrets: true, includeVectors: false }),
      },
    );
    expect(response.status).toBe(200);
    const prepared = await response.json() as { archiveUrl: string; secretsCount: number };
    expect(prepared.secretsCount).toBe(0);
    expect(imageGenConnSvc.listConnections(SOURCE_USER, { limit: 20, offset: 0 }).total).toBe(0);
    expect(listSecretKeys(SOURCE_USER)).toEqual([]);

    const stored = settingsSvc.getSetting(SOURCE_USER, "imageGeneration")!.value;
    expect(stored.wrappers[0]).toEqual({ nanogpt: [{ marker: "deep-empty" }] });
    expect(JSON.parse(stored.wrappers[1])).toEqual({
      novelai: { marker: "encoded-empty" },
    });
    expect(inspectLegacyImageGenerationPrivateData(stored)).toMatchObject({
      credentials: [],
      changed: false,
    });
    const archiveResponse = await app.request(
      "http://localhost" + prepared.archiveUrl,
      { headers: { "x-test-user": SOURCE_USER } },
    );
    expect(archiveResponse.status).toBe(200);
    expect(prepareCacheSize()).toBe(0);
  });

  test("ambiguous recursive credentials abort before any migration or ticket", async () => {
    settingsSvc.putSetting(SOURCE_USER, "imageGeneration", {
      provider: "nanogpt",
      nanogpt: { apiKey: NANO_SECRET, model: "hidream" },
      backups: [{ nanogpt: { apiKey: NOVEL_SECRET, model: "hidream" } }],
    });
    const settingsBefore = settingsSvc.getSetting(SOURCE_USER, "imageGeneration")!.value;

    const response = await app.request(
      "http://localhost/api/v1/user-data/export/prepare",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": SOURCE_USER,
        },
        body: JSON.stringify({ includeSecrets: true, includeVectors: false }),
      },
    );
    expect(response.status).toBe(500);
    expect(prepareCacheSize()).toBe(0);
    expect(imageGenConnSvc.listConnections(SOURCE_USER, { limit: 20, offset: 0 }).total).toBe(0);
    expect(listSecretKeys(SOURCE_USER)).toEqual([]);
    expect(settingsSvc.getSetting(SOURCE_USER, "imageGeneration")!.value).toEqual(settingsBefore);
  });

  test("unmappable recursive credentials abort before any migration or ticket", async () => {
    settingsSvc.putSetting(SOURCE_USER, "imageGeneration", {
      provider: "novelai",
      wrappers: [{ novelai: { apiKey: { token: NOVEL_SECRET } } }],
    });
    const settingsBefore = settingsSvc.getSetting(SOURCE_USER, "imageGeneration")!.value;

    const response = await app.request(
      "http://localhost/api/v1/user-data/export/prepare",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": SOURCE_USER,
        },
        body: JSON.stringify({ includeSecrets: true, includeVectors: false }),
      },
    );
    expect(response.status).toBe(500);
    expect(prepareCacheSize()).toBe(0);
    expect(imageGenConnSvc.listConnections(SOURCE_USER, { limit: 20, offset: 0 }).total).toBe(0);
    expect(listSecretKeys(SOURCE_USER)).toEqual([]);
    expect(settingsSvc.getSetting(SOURCE_USER, "imageGeneration")!.value).toEqual(settingsBefore);
  });

  test("preservation failure aborts before issuing or retaining a ticket", async () => {
    seedLegacySettings(SOURCE_USER);
    getDb().run(`
      CREATE TRIGGER reject_legacy_image_secret
      BEFORE INSERT ON secrets
      WHEN NEW.key LIKE 'image_gen_connection_%'
      BEGIN
        SELECT RAISE(ABORT, 'forced secret preservation failure');
      END
    `);

    const response = await app.request(
      "http://localhost/api/v1/user-data/export/prepare",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": SOURCE_USER,
        },
        body: JSON.stringify({ includeSecrets: true, includeVectors: false }),
      },
    );
    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ticket).toBeUndefined();
    expect(prepareCacheSize()).toBe(0);
    expect(imageGenConnSvc.listConnections(SOURCE_USER, { limit: 20, offset: 0 }).total).toBe(0);
    expect(listSecretKeys(SOURCE_USER)).toEqual([]);
    const settings = settingsSvc.getSetting(SOURCE_USER, "imageGeneration")!.value;
    expect(settings.nanogpt.apiKey).toBe(NANO_SECRET);
    expect(settings.novelai.apiKey).toBe(NOVEL_SECRET);
  });

  test("profile insertion failure rolls back defaults, secrets, and plaintext cleanup", async () => {
    const previousDefault = await imageGenConnSvc.createConnection(SOURCE_USER, {
      name: "Quarantined previous default",
      provider: "comfyui",
      is_default: true,
    });
    getDb().query(
      "UPDATE image_gen_connections SET metadata = ? WHERE id = ? AND user_id = ?",
    ).run(
      JSON.stringify({ __lumiverse_import_review_required: true }),
      previousDefault.id,
      SOURCE_USER,
    );
    expect(imageGenConnSvc.getDefaultConnection(SOURCE_USER)).toBeNull();

    settingsSvc.putSetting(SOURCE_USER, "imageGeneration", {
      provider: "novelai",
      activeImageGenConnectionId: null,
      novelai: {
        apiKey: NOVEL_SECRET,
        model: "nai-diffusion-4-5-full",
        steps: 31,
      },
    });
    const settingsBefore = settingsSvc.getSetting(SOURCE_USER, "imageGeneration")!.value;
    getDb().run(
      "CREATE TRIGGER reject_legacy_image_profile "
        + "BEFORE INSERT ON image_gen_connections "
        + "WHEN NEW.provider = 'novelai' "
        + "BEGIN "
        + "SELECT RAISE(ABORT, 'forced profile insertion failure'); "
        + "END",
    );

    const response = await app.request(
      "http://localhost/api/v1/user-data/export/prepare",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": SOURCE_USER,
        },
        body: JSON.stringify({ includeSecrets: true, includeVectors: false }),
      },
    );
    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ticket).toBeUndefined();
    expect(prepareCacheSize()).toBe(0);

    const connections = imageGenConnSvc.listConnections(SOURCE_USER, { limit: 20, offset: 0 });
    expect(connections.total).toBe(1);
    expect(imageGenConnSvc.getConnection(SOURCE_USER, previousDefault.id)).toMatchObject({
      id: previousDefault.id,
      is_default: true,
      review_required: true,
    });
    expect(listSecretKeys(SOURCE_USER)).toEqual([]);
    expect(settingsSvc.getSetting(SOURCE_USER, "imageGeneration")!.value).toEqual(settingsBefore);
  });
});
