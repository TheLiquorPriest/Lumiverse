import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  attachContextPack,
  createContextPack,
  createContextPackRevision,
  disableContextPack,
  exportContextPack,
  getContextAccountRevision,
  getContextPack,
  getContextPackRevision,
  importForeignContextPack,
  listContextPackCandidateMetadata,
  listSelectableContextPackRevisions,
  readContextPackRevisionForUser,
  reviewContextPack,
  updateContextPack,
  type ContextPackCandidateMetadataResult,
} from "./agent-context-packs.service";
import { buildHostPrefetchedAgentContextSnapshot } from "./agent-context-tools.service";

const USER_ID = "context-metadata-user";
const PRESET_ID = "context-metadata-preset";

async function applySchema(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "107_agent_context_packs.sql")).text());
  db.run("PRAGMA foreign_keys = ON");
}

function seedCandidates(count = 128): void {
  const db = getDb();
  db.query(
    `INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`,
  ).run(USER_ID, "Context Metadata", "context-metadata@example.test");
  db.query(
    `INSERT INTO presets (id, name, provider, user_id) VALUES (?, ?, ?, ?)`,
  ).run(PRESET_ID, "Context metadata preset", "test", USER_ID);
  for (let index = 0; index < count; index += 1) {
    const packId = `context-pack-${String(index).padStart(3, "0")}`;
    const attachmentId = `context-attachment-${String(index).padStart(3, "0")}`;
    const digest = String(index.toString(16)).padStart(64, "0");
    const contentJson = index === 0 ? "not-json-at-all" : "[]";
    db.query(
      `INSERT INTO agent_context_packs
       (user_id, id, name, description, visibility, state, latest_revision, provenance_json)
       VALUES (?, ?, ?, ?, 'private', 'active', 1, '{}')`,
    ).run(USER_ID, packId, `Pack ${index}`, `Description ${index}`);
    db.query(
      `INSERT INTO agent_context_pack_revisions
       (user_id, pack_id, revision, content_json, content_digest, token_count, byte_count, state, provenance_json, created_by)
       VALUES (?, ?, 1, ?, ?, ?, ?, 'active', '{}', ?)`,
    ).run(USER_ID, packId, contentJson, digest, index + 1, contentJson.length, USER_ID);
    db.query(
      `INSERT INTO agent_preset_context_pack_attachments
       (user_id, attachment_id, preset_id, pack_id, revision, position, required, state, provenance_json)
       VALUES (?, ?, ?, ?, 1, ?, ?, 'active', '{}')`,
    ).run(USER_ID, attachmentId, PRESET_ID, packId, index, index === 0 ? 1 : 0);
  }
}
function seedDirectCandidate(): string {
  const db = getDb();
  const packId = "context-direct-pack";
  const digest = "f".repeat(64);
  db.query(
    `INSERT INTO agent_context_packs
     (user_id, id, name, description, visibility, state, latest_revision, provenance_json)
     VALUES (?, ?, ?, ?, 'private', 'active', 1, '{}')`,
  ).run(USER_ID, packId, "Direct pack", "Direct selection");
  db.query(
    `INSERT INTO agent_context_pack_revisions
     (user_id, pack_id, revision, content_json, content_digest, token_count, byte_count, state, provenance_json, created_by)
     VALUES (?, ?, 1, ?, ?, 1, 2, 'active', '{}', ?)`,
  ).run(USER_ID, packId, "[]", digest, USER_ID);
  return digest;
}


describe("context-pack metadata candidate bounds", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applySchema();
    seedCandidates();
  });

  test("lists at most 128 metadata rows without parsing content JSON", () => {
    const snapshot = listContextPackCandidateMetadata(USER_ID, [{ scope: "preset", targetId: PRESET_ID }]);
    const results = snapshot.items;
    expect(snapshot.contextAclRevision).toBeGreaterThanOrEqual(0);
    expect(results).toHaveLength(128);
    expect(results.every((entry) => entry.kind === "candidate")).toBe(true);
    expect((results[0] as Extract<ContextPackCandidateMetadataResult, { kind: "candidate" }>).attachmentId).toBe(
      "context-attachment-000",
    );
    expect(results[127]).not.toHaveProperty("content");
    expect(results[127]).not.toHaveProperty("provenance");
    expect(() => listContextPackCandidateMetadata(USER_ID, [{ scope: "preset", targetId: PRESET_ID }], 129)).toThrow(
      "maxCandidates",
    );
  });
  test("returns a private required omission marker while hiding optional omissions", () => {
    getDb().query(
      "UPDATE agent_preset_context_pack_attachments SET state = 'disabled' WHERE user_id = ? AND attachment_id = ?",
    ).run(USER_ID, "context-attachment-000");
    getDb().query(
      "UPDATE agent_preset_context_pack_attachments SET state = 'review_required' WHERE user_id = ? AND attachment_id = ?",
    ).run(USER_ID, "context-attachment-001");
    const snapshot = listContextPackCandidateMetadata(USER_ID, [{ scope: "preset", targetId: PRESET_ID }]);
    const results = snapshot.items;
    expect(results[0]).toEqual({
      kind: "omission",
      ownerId: USER_ID,
      attachmentId: "context-attachment-000",
      source: "preset",
      targetId: PRESET_ID,
      required: true,
      reason: "disabled",
    });
    expect(results).toHaveLength(127);
    expect(results.some((entry) => entry.kind === "omission")).toBe(true);
    expect(results.some((entry) => entry.kind === "candidate" && entry.attachmentId === "context-attachment-001")).toBe(false);
  });
  test("builds one frozen mixed snapshot without duplicating attached selections", () => {
    const db = getDb();
    db.query(
      `INSERT INTO presets (id, name, provider, user_id) VALUES (?, ?, ?, ?)`,
    ).run("context-mixed-preset", "Context mixed preset", "test", USER_ID);
    db.query(
      `INSERT INTO agent_preset_context_pack_attachments
       (user_id, attachment_id, preset_id, pack_id, revision, position, required, state, provenance_json)
       VALUES (?, ?, ?, ?, 1, 0, 1, 'active', '{}')`,
    ).run(USER_ID, "context-mixed-attachment", "context-mixed-preset", "context-pack-000");
    const directDigest = seedDirectCandidate();
    const attachedDigest = "0".repeat(64);
    const snapshot = buildHostPrefetchedAgentContextSnapshot({
      ownerId: USER_ID,
      targetScopes: [{ scope: "preset", targetId: "context-mixed-preset" }],
      selections: [
        {
          packId: "context-pack-000",
          revisionId: "context-pack-000@1",
          revision: 1,
          digest: attachedDigest,
          required: true,
        },
        {
          packId: "context-direct-pack",
          revisionId: "context-direct-pack@1",
          revision: 1,
          digest: directDigest,
          required: false,
        },
      ],
    });
    expect(snapshot.ownerId).toBe(USER_ID);
    expect(snapshot.contextAclRevision).toBeGreaterThanOrEqual(0);
    expect(snapshot.candidates.filter((candidate) => candidate.packId === "context-pack-000")).toHaveLength(1);
    expect(snapshot.candidates.filter((candidate) => candidate.packId === "context-direct-pack")).toHaveLength(1);
    expect(snapshot.candidates.map((candidate) => candidate.packId)).toEqual([
      "context-pack-000",
      "context-direct-pack",
    ]);
    expect(snapshot.candidateInputRevisions).toHaveLength(snapshot.candidates.length);
  });

  test("rejects an attached selection whose digest changed before account lookup", () => {
    expect(() =>
      buildHostPrefetchedAgentContextSnapshot({
        ownerId: USER_ID,
        targetScopes: [{ scope: "preset", targetId: PRESET_ID }],
        selections: [
          {
            packId: "context-pack-000",
            revisionId: "context-pack-000@1",
            revision: 1,
            digest: "f".repeat(64),
          },
        ],
      }),
    ).toThrow("revision identity mismatch");
  });
  test("omits an unavailable optional policy selection without aborting preflight", () => {
    const actualDigest = seedDirectCandidate();
    const snapshot = buildHostPrefetchedAgentContextSnapshot({
      ownerId: USER_ID,
      targetScopes: [],
      selections: [
        {
          packId: "context-direct-pack",
          revisionId: "context-direct-pack@1",
          revision: 1,
          digest: actualDigest.replace(/^f/, "e"),
          required: false,
        },
      ],
    });
    expect(snapshot.candidates).toHaveLength(0);
    expect(snapshot.candidateInputRevisions).toHaveLength(0);
  });
  test("rejects an unavailable required account selection", () => {
    expect(() =>
      buildHostPrefetchedAgentContextSnapshot({
        ownerId: USER_ID,
        targetScopes: [],
        selections: [
          {
            packId: "missing-account-pack",
            revisionId: "missing-account-pack@1",
            revision: 1,
            digest: "a".repeat(64),
            required: true,
          },
        ],
      }),
    ).toThrow("required account context pack is unavailable");
  });

  test("import review appends an active immutable revision that can attach and read", () => {
    const source = createContextPack(USER_ID, {
      name: "Portable source",
      content: [{ id: "entry", title: "Entry", body: "portable bytes", tags: ["source"] }],
    });
    const portable = exportContextPack(USER_ID, source.pack.id);
    if (!portable) throw new Error("portable source snapshot was not produced");
    const imported = importForeignContextPack(USER_ID, portable);
    expect(imported.pack.state).toBe("review_required");
    expect(imported.pack.latestRevision).toBe(1);
    expect(() => updateContextPack(USER_ID, imported.pack.id, {
      state: "active",
      expectedRevision: 1,
    })).toThrow("activated through review");
    expect(imported.revision.state).toBe("review_required");

    const aclBeforeReview = getContextAccountRevision(USER_ID);
    const reviewed = reviewContextPack(USER_ID, imported.pack.id, {
      acknowledge: true,
      state: "active",
      expectedRevision: 1,
    });
    // The revision insert and pack availability transition each trigger one
    // account ACL epoch bump; the service must not manually bump it again.
    expect(getContextAccountRevision(USER_ID)).toBe(aclBeforeReview + 2);
    expect(reviewed).toMatchObject({ state: "active", latestRevision: 2 });

    const oldRevision = getContextPackRevision(USER_ID, imported.pack.id, 1, { includeInactive: true });
    const activeRevision = getContextPackRevision(USER_ID, imported.pack.id, 2, { includeInactive: true });
    expect(oldRevision).toMatchObject({
      revision: 1,
      state: "review_required",
      content: imported.revision.content,
      contentDigest: imported.revision.contentDigest,
      tokenCount: imported.revision.tokenCount,
      byteCount: imported.revision.byteCount,
      provenance: imported.revision.provenance,
    });
    expect(activeRevision).toMatchObject({
      revision: 2,
      state: "active",
      content: oldRevision?.content,
      contentDigest: oldRevision?.contentDigest,
      tokenCount: oldRevision?.tokenCount,
      byteCount: oldRevision?.byteCount,
      provenance: oldRevision?.provenance,
    });
    expect(getContextPackRevision(USER_ID, imported.pack.id, 1)).toBeNull();
    expect(() => getDb().query(
      "UPDATE agent_context_pack_revisions SET state = 'active' WHERE user_id = ? AND pack_id = ? AND revision = ?",
    ).run(USER_ID, imported.pack.id, 1)).toThrow("immutable");

    const attachment = attachContextPack(USER_ID, imported.pack.id, {
      scope: "preset",
      targetId: PRESET_ID,
      revision: 2,
      required: true,
    });
    expect(attachment).toMatchObject({ packId: imported.pack.id, revision: 2, state: "active" });
    expect(readContextPackRevisionForUser(USER_ID, imported.pack.id, 2)).toMatchObject({
      packId: imported.pack.id,
      revision: 2,
      contentDigest: imported.revision.contentDigest,
    });
  });

  test("stale review CAS rolls back an inserted revision and trigger mutation", () => {
    const source = createContextPack(USER_ID, {
      name: "Portable source",
      content: [{ id: "entry", title: "Entry", body: "portable bytes", tags: [] }],
    });
    const portable = exportContextPack(USER_ID, source.pack.id);
    if (!portable) throw new Error("portable source snapshot was not produced");
    const imported = importForeignContextPack(USER_ID, portable);
    const db = getDb();
    const aclBeforeReview = getContextAccountRevision(USER_ID);
    const triggerName = "context_review_force_cas_miss";
    db.run(`
      CREATE TRIGGER ${triggerName}
      AFTER INSERT ON agent_context_pack_revisions
      WHEN NEW.user_id = '${USER_ID}'
       AND NEW.pack_id = '${imported.pack.id}'
       AND NEW.revision = 2
      BEGIN
        UPDATE agent_context_packs
        SET latest_revision = 3
        WHERE user_id = NEW.user_id AND id = NEW.pack_id;
      END
    `);
    try {
      expect(() => reviewContextPack(USER_ID, imported.pack.id, {
        acknowledge: true,
        state: "active",
        expectedRevision: 1,
      })).toThrow("current revision is 3");
    } finally {
      db.run(`DROP TRIGGER ${triggerName}`);
    }
    expect(getDb().query("SELECT latest_revision, state FROM agent_context_packs WHERE user_id = ? AND id = ?").get(USER_ID, imported.pack.id)).toEqual({
      latest_revision: 1,
      state: "review_required",
    });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_context_pack_revisions WHERE user_id = ? AND pack_id = ?").get(USER_ID, imported.pack.id)).toEqual({
      count: 1,
    });
    expect(getContextAccountRevision(USER_ID)).toBe(aclBeforeReview);
  });

  test("native active and disabled packs retain their existing review transitions", () => {
    const created = createContextPack(USER_ID, {
      name: "Native pack",
      content: [{ id: "entry", title: "Entry", body: "native bytes", tags: [] }],
    });
    const disabled = reviewContextPack(USER_ID, created.pack.id, {
      acknowledge: true,
      state: "disabled",
      expectedRevision: 1,
    });
    expect(disabled).toMatchObject({ state: "disabled", latestRevision: 1 });
    const reactivated = reviewContextPack(USER_ID, created.pack.id, {
      acknowledge: true,
      state: "active",
      expectedRevision: 1,
    });
    expect(reactivated).toMatchObject({ state: "active", latestRevision: 1 });
    expect(getContextPackRevision(USER_ID, created.pack.id, 1, { includeInactive: true })).toMatchObject({ state: "active" });
  });
  test("disableContextPack enforces latest-revision CAS", () => {
    const created = createContextPack(USER_ID, {
      name: "Disable CAS pack",
      content: [{ id: "entry", title: "Entry", body: "disable bytes", tags: [] }],
    });
    const revised = createContextPackRevision(USER_ID, created.pack.id, {
      content: [{ id: "entry", title: "Revised", body: "revised bytes", tags: [] }],
      expectedRevision: 1,
    });
    expect(revised).toMatchObject({ revision: 2, state: "active" });
    expect(() => disableContextPack(USER_ID, created.pack.id, 1)).toThrow("current revision is 2");
    expect(getContextPack(USER_ID, created.pack.id)).toMatchObject({ state: "active", latestRevision: 2 });
    expect(disableContextPack(USER_ID, created.pack.id, 2)).toBe(true);
    expect(getContextPack(USER_ID, created.pack.id)).toBeNull();
    expect(getContextPack(USER_ID, created.pack.id, { includeInactive: true })).toMatchObject({
      state: "disabled",
      latestRevision: 2,
    });
  });


  test("rejects target attachment overflow instead of hiding a later required scope", () => {
    const db = getDb();
    db.query(
      `INSERT INTO presets (id, name, provider, user_id) VALUES (?, ?, ?, ?)`,
    ).run("context-overflow-preset", "Context overflow preset", "test", USER_ID);
    db.query(
      `INSERT INTO agent_preset_context_pack_attachments
       (user_id, attachment_id, preset_id, pack_id, revision, position, required, state, provenance_json)
       VALUES (?, ?, ?, ?, 1, 0, 1, 'active', '{}')`,
    ).run(USER_ID, "context-overflow-attachment", "context-overflow-preset", "context-pack-001");
    expect(() =>
      buildHostPrefetchedAgentContextSnapshot({
        ownerId: USER_ID,
        targetScopes: [
          { scope: "preset", targetId: PRESET_ID },
          { scope: "preset", targetId: "context-overflow-preset" },
        ],
        selections: [],
      }),
    ).toThrow("context candidate limit exceeded");
  });
});
describe("context-pack ownership and attachment authority", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applySchema();
    seedCandidates(2);
  });

  test("resolves shared revision rows through the owner after ACL access", () => {
    const db = getDb();
    const sharedPackId = createContextPack(USER_ID, {
      name: "Shared revision",
      content: [{ id: "shared", title: "Shared", body: "Readable by ACL", tags: [] }],
    }).pack.id;
    const sharedUserId = "context-shared-reader";
    db.query(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`)
      .run(sharedUserId, "Shared reader", "shared-reader@example.test");
    db.query("UPDATE agent_context_packs SET visibility = 'account' WHERE user_id = ? AND id = ?")
      .run(USER_ID, sharedPackId);
    db.query(`INSERT INTO agent_context_pack_acls
      (user_id, pack_id, principal_user_id, permission)
      VALUES (?, ?, ?, 'read')`)
      .run(USER_ID, sharedPackId, sharedUserId);

    const revision = getContextPackRevision(sharedUserId, sharedPackId, 1, { requireAccess: "read" });
    expect(revision).toMatchObject({ userId: USER_ID, packId: sharedPackId, revision: 1 });
    expect(readContextPackRevisionForUser(sharedUserId, sharedPackId, 1)).toMatchObject({
      userId: USER_ID,
      packId: sharedPackId,
    });
    expect(getContextPack(sharedUserId, sharedPackId, { includeInactive: true })).toBeNull();
  });

  test("rejects shared attachment and invalid or disabled revisions with domain validation", () => {
    const db = getDb();
    const sharedUserId = "context-shared-attacher";
    db.query(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`)
      .run(sharedUserId, "Shared attacher", "shared-attacher@example.test");
    db.query("UPDATE agent_context_packs SET visibility = 'account' WHERE user_id = ? AND id = ?")
      .run(USER_ID, "context-pack-001");
    db.query(`INSERT INTO agent_context_pack_acls
      (user_id, pack_id, principal_user_id, permission)
      VALUES (?, ?, ?, 'use')`)
      .run(USER_ID, "context-pack-001", sharedUserId);
    db.query(`INSERT INTO presets (id, name, provider, user_id) VALUES (?, ?, ?, ?)`)
      .run("shared-reader-preset", "Shared reader preset", "test", sharedUserId);

    expect(() => attachContextPack(sharedUserId, "context-pack-001", {
      scope: "preset",
      targetId: "shared-reader-preset",
      revision: 1,
    })).toThrow("shared context packs must be duplicated");
    expect(() => attachContextPack(USER_ID, "context-pack-001", {
      scope: "preset",
      targetId: PRESET_ID,
      revision: 99,
    })).toThrow("requested revision does not exist");
    db.query("UPDATE agent_context_packs SET state = 'disabled' WHERE user_id = ? AND id = ?")
      .run(USER_ID, "context-pack-001");
    expect(() => attachContextPack(USER_ID, "context-pack-001", {
      scope: "preset",
      targetId: PRESET_ID,
      revision: 1,
    })).toThrow("context pack is not active");
  });

  test("serializes revision CAS and reports a stale writer as revision conflict", () => {
    const created = createContextPack(USER_ID, {
      name: "Revision race",
      content: [{ id: "entry", title: "Entry", body: "Initial", tags: [] }],
    });
    const next = createContextPackRevision(USER_ID, created.pack.id, {
      expectedRevision: 1,
      content: [{ id: "entry", title: "Entry", body: "First", tags: [] }],
    });
    expect(next?.revision).toBe(2);
    expect(() => createContextPackRevision(USER_ID, created.pack.id, {
      expectedRevision: 1,
      content: [{ id: "entry", title: "Entry", body: "Stale", tags: [] }],
    })).toThrow("current revision is 2");
    expect(getContextPack(USER_ID, created.pack.id)).toMatchObject({ latestRevision: 2 });
  });

  test("selects and assembles an exact shared revision only while use access remains active", () => {
    const db = getDb();
    const sharedUserId = "context-shared-selector";
    db.query(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`)
      .run(sharedUserId, "Shared selector", "shared-selector@example.test");
    const created = createContextPack(USER_ID, {
      name: "Shared selection",
      content: [{ id: "shared", title: "Shared", body: "Exact shared content", tags: [] }],
    });
    db.query("UPDATE agent_context_packs SET visibility = 'account' WHERE user_id = ? AND id = ?")
      .run(USER_ID, created.pack.id);
    db.query(`INSERT INTO agent_context_pack_acls
      (user_id, pack_id, principal_user_id, permission)
      VALUES (?, ?, ?, 'use')`)
      .run(USER_ID, created.pack.id, sharedUserId);

    const selectable = listSelectableContextPackRevisions(sharedUserId);
    const selected = selectable.find((revision) => revision.packId === created.pack.id);
    expect(selected).toMatchObject({
      ownerId: USER_ID,
      source: "shared",
      packId: created.pack.id,
      revision: 1,
    });
    expect(selected?.digest).toHaveLength(64);

    const snapshot = buildHostPrefetchedAgentContextSnapshot({
      ownerId: sharedUserId,
      targetScopes: [],
      selections: [{
        packId: created.pack.id,
        revisionId: `${created.pack.id}@1`,
        revision: 1,
        digest: selected!.digest,
        required: true,
      }],
    });
    expect(snapshot.ownerId).toBe(sharedUserId);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]).toMatchObject({
      ownerId: USER_ID,
      source: "account",
      packId: created.pack.id,
      revision: 1,
      required: true,
    });

    db.query("DELETE FROM agent_context_pack_acls WHERE user_id = ? AND pack_id = ? AND principal_user_id = ?")
      .run(USER_ID, created.pack.id, sharedUserId);
    expect(() => buildHostPrefetchedAgentContextSnapshot({
      ownerId: sharedUserId,
      targetScopes: [],
      selections: [{
        packId: created.pack.id,
        revisionId: `${created.pack.id}@1`,
        revision: 1,
        digest: selected!.digest,
        required: true,
      }],
    })).toThrow("required account context pack is unavailable");
  });
});
