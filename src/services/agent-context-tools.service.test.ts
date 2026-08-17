import { describe, expect, test } from "bun:test";
import {
  CONTEXT_PACK_GET_LIMIT_MAX,
  CONTEXT_PACK_LIST_LIMIT_MAX,
  CONTEXT_PACK_RECORD_MAX_BYTES,
  type ContextInvalidationReasonV1,
  type ContextPackCandidateInputV1,
  type ContextPackReaderV1,
  type ContextPackRevisionContentV1,
  type ContextToolInvocationOptionsV1,
  ContextPackInputRevisionTracker,
  ContextPackToolBudget,
  createContextToolCapability as createContextToolCapabilityImpl,
  freezeContextPackCandidateSnapshot,
  snapshotContextPackAccountCandidates,
  mergeContextPackCandidateSnapshots,
  recheckContextPackInputRevisionsAtCommit,
} from "./agent-context-tools.service";

interface ReaderState {
  aclRevision: number;
  attachmentRevision: string;
  allowed: boolean;
  content: ContextPackRevisionContentV1 | null;
  readCalls: number;
  onRead?: () => void;
  currentRevisionCalls: number;
}

function candidate(overrides: Partial<ContextPackCandidateInputV1> = {}): ContextPackCandidateInputV1 {
  return {
    ownerId: "user-a",
    packId: "pack-a",
    revisionId: "pack-a@1",
    revision: 1,
    digest: "digest-a",
    label: "Pack A",
    summary: "A bounded context pack",
    source: "preset",
    targetId: "preset-a",
    attachmentId: "attachment-a",
    attachmentRevision: "attachment-1",
    aclRevision: 1,
    byteCount: 32,
    tokenCount: 8,
    ...overrides,
  };
}

function content(overrides: Partial<ContextPackRevisionContentV1> = {}): ContextPackRevisionContentV1 {
  return {
    ownerId: "user-a",
    packId: "pack-a",
    revisionId: "pack-a@1",
    revision: 1,
    digest: "digest-a",
    records: [
      { id: "entry-a", title: "Title A", text: "literal {{macro}} /regex/", tags: ["one"] },
      { id: "entry-b", title: "Title B", text: "second literal", tags: ["two"] },
      { id: "entry-c", title: "Title C", text: "third literal", tags: ["three"] },
    ],
    ...overrides,
  };
}

function reader(state: ReaderState): ContextPackReaderV1 {
  return {
    currentAclRevision(ownerId) {
      expect(ownerId).toBe("user-a");
      state.currentRevisionCalls += 1;
      return Promise.resolve(state.aclRevision);
    },
    checkAccess({ ownerId, candidate }) {
      expect(ownerId).toBe("user-a");
      return Promise.resolve({
        allowed: state.allowed,
        aclRevision: state.aclRevision,
        attachmentRevision: state.attachmentRevision || candidate.attachmentRevision,
      });
    },
    currentRevisionIdentity({ ownerId }) {
      expect(ownerId).toBe("user-a");
      const current = state.content;
      if (!current) return Promise.resolve(null);
      return Promise.resolve({
        ownerId: current.ownerId,
        packId: current.packId,
        revisionId: current.revisionId,
        revision: current.revision,
        digest: current.digest,
      });
    },
    readRevision({ ownerId }) {
      expect(ownerId).toBe("user-a");
      state.readCalls += 1;
      state.onRead?.();
      return Promise.resolve(state.content);
    },
  };
}

function snapshot(candidateOverrides: Partial<ContextPackCandidateInputV1> = {}) {
  return freezeContextPackCandidateSnapshot({
    ownerId: "user-a",
    contextAclRevision: 1,
    candidates: [candidate(candidateOverrides)],
  });
}

function state(overrides: Partial<ReaderState> = {}): ReaderState {
  return {
    aclRevision: 1,
    attachmentRevision: "attachment-1",
    allowed: true,
    content: content(),
    readCalls: 0,
    currentRevisionCalls: 0,
    ...overrides,
  };
}

interface TestInvalidationSink {
  readonly reasons: ContextInvalidationReasonV1[];
  invalidateInput(reason: ContextInvalidationReasonV1): void;
  invalidateReadiness(reason: ContextInvalidationReasonV1): void;
}

function sink(): TestInvalidationSink {
  const reasons: ContextInvalidationReasonV1[] = [];
  return {
    reasons,
    invalidateInput(reason: ContextInvalidationReasonV1) {
      reasons.push(reason);
    },
    invalidateReadiness(reason: ContextInvalidationReasonV1) {
      reasons.push(reason);
    },
  };
}

type TestContextToolOptions = ContextToolInvocationOptionsV1;

function createContextToolCapability(
  frozen: ReturnType<typeof freezeContextPackCandidateSnapshot>,
  contextReader: ContextPackReaderV1,
  options: TestContextToolOptions,
) {
  return createContextToolCapabilityImpl(frozen, contextReader, options);
}


describe("agentic context candidate snapshot and reserved tools", () => {
  test("freezes only ASSEMBLE candidates and list exposes metadata, not content or ACL fields", async () => {
    const candidates = [candidate()];
    const frozen = freezeContextPackCandidateSnapshot({
      ownerId: "user-a",
      contextAclRevision: 1,
      candidates,
    });
    candidates.push(candidate({ packId: "pack-not-attached", revisionId: "pack-not-attached@1" }));
    const result = await createContextToolCapability(frozen, reader(state()), { invalidationSink: sink() }).list({});

    expect(result.status).toBe("success");
    const data = result.data as { candidates: readonly Record<string, unknown>[]; total: number };
    expect(data.total).toBe(1);
    expect(data.candidates).toHaveLength(1);
    expect(data.candidates[0]?.packId).toBe("pack-a");
    expect(data.candidates[0]).not.toHaveProperty("aclRevision");
    expect(data.candidates[0]).not.toHaveProperty("records");
    expect(Object.isFrozen(frozen.candidates)).toBe(true);
    expect(Object.isFrozen(frozen.candidates[0])).toBe(true);
  });
  test("WORK exposes only cognition-activated candidates and does not read inactive candidates", async () => {
    const frozen = freezeContextPackCandidateSnapshot({
      ownerId: "user-a",
      contextAclRevision: 1,
      candidates: [
        candidate(),
        candidate({
          packId: "future-pack",
          revisionId: "future-pack@1",
          label: "Future rule pack",
          targetId: "preset-a",
          attachmentId: "future-attachment",
        }),
      ],
    });
    const active = {
      contextPackRequirements: [
        {
          ruleId: null,
          source: "direct" as const,
          packId: "pack-a",
          revisionId: "pack-a@1",
          digest: "digest-a",
          required: true,
        },
      ],
      newlyActivatedContextPackRequirements: [],
    };
    const stateForActive = state();
    const capability = createContextToolCapability(frozen, reader(stateForActive), {
      activeCandidates: active,
      invalidationSink: sink(),
    });
    const listed = await capability.list({});
    expect(listed.status).toBe("success");
    expect((listed.data as { candidates: readonly { packId: string }[] }).candidates).toEqual([
      expect.objectContaining({ packId: "pack-a" }),
    ]);
    const inactive = await capability.get({
      pack_id: "future-pack",
      revision_id: "future-pack@1",
      revision: 1,
    });
    expect(inactive).toMatchObject({
      status: "error",
      errorCode: "context_pack_not_found",
    });
    expect(stateForActive.readCalls).toBe(0);
  });
  test("activates an optional attached candidate through attachment authority", async () => {
    const frozen = snapshot({ required: false });
    const stateForActive = state();
    const listed = await createContextToolCapability(frozen, reader(stateForActive), {
      activeCandidates: {
        contextPackRequirements: [{
          ruleId: null,
          source: "attachment",
          packId: "pack-a",
          revisionId: "pack-a@1",
          digest: "digest-a",
          required: false,
        }],
        newlyActivatedContextPackRequirements: [],
      },
      invalidationSink: sink(),
    }).list({});
    expect(listed).toMatchObject({ status: "success", toolName: "context_pack_list" });
    expect((listed.data as { candidates: readonly { packId: string }[] }).candidates).toEqual([
      expect.objectContaining({ packId: "pack-a" }),
    ]);
  });

  test("keeps an account candidate inactive when only a cognition rule activates it", async () => {
    const frozen = freezeContextPackCandidateSnapshot({
      ownerId: "user-a",
      contextAclRevision: 1,
      candidates: [candidate({
        source: "account",
        packId: "account-pack",
        revisionId: "account-pack@1",
        targetId: null,
        attachmentId: null,
        attachmentRevision: null,
      })],
    });
    const stateForInactive = state();
    const listed = await createContextToolCapability(frozen, reader(stateForInactive), {
      activeCandidates: {
        contextPackRequirements: [{
          ruleId: "rule-account",
          source: "rule",
          packId: "account-pack",
          revisionId: "account-pack@1",
          digest: "digest-a",
          required: true,
        }],
        newlyActivatedContextPackRequirements: [],
      },
      invalidationSink: sink(),
    }).list({});
    expect(listed).toMatchObject({ status: "success", toolName: "context_pack_list" });
    expect((listed.data as { candidates: readonly unknown[] }).candidates).toHaveLength(0);
    expect(stateForInactive.readCalls).toBe(0);
  });


  test("account snapshot rejects non-canonical revision identities before any database read", () => {
    const db = {
      query() {
        throw new Error("database must not be queried");
      },
    } as never;
    expect(() =>
      snapshotContextPackAccountCandidates(
        "user-a",
        [{
          packId: "pack-a",
          revisionId: "pack-a@01",
          revision: 1,
          digest: "digest-a",
        }],
        db,
      ),
    ).toThrow("revision identity mismatch");
  });
  test("empty cognition activation does not query ACL or expose frozen candidates", async () => {
    const frozen = snapshot();
    const stateForInactive = state();
    const result = await createContextToolCapability(frozen, reader(stateForInactive), {
      activeCandidates: { contextPackRequirements: [], newlyActivatedContextPackRequirements: [] },
      invalidationSink: sink(),
    }).list({});
    expect(result).toMatchObject({ status: "success", toolName: "context_pack_list" });
    expect((result.data as { candidates: readonly unknown[]; total: number }).candidates).toHaveLength(0);
    expect((result.data as { total: number }).total).toBe(0);
    expect(stateForInactive.currentRevisionCalls).toBe(0);
  });
  test("merges attachment and account snapshots only when owner and ACL revision match", () => {
    const attached = snapshot();
    const account = freezeContextPackCandidateSnapshot({
      ownerId: "user-a",
      contextAclRevision: 1,
      candidates: [
        candidate({
          source: "account",
          packId: "account-pack",
          revisionId: "account-pack@2",
          revision: 2,
          targetId: null,
          attachmentId: null,
          attachmentRevision: null,
        }),
      ],
    });
    const merged = mergeContextPackCandidateSnapshots([attached, account]);
    expect(merged.contextAclRevision).toBe(1);
    expect(merged.candidates.map((item) => item.packId)).toEqual(["pack-a", "account-pack"]);
    expect(merged.candidateInputRevisions).toHaveLength(2);
    expect(() =>
      mergeContextPackCandidateSnapshots([
        attached,
        { ...account, contextAclRevision: 2 },
      ]),
    ).toThrow("changed during merge");
  });



  test("preserves same revision across target attachments but rejects exact duplicates", () => {
    const acrossTargets = freezeContextPackCandidateSnapshot({
      ownerId: "user-a",
      contextAclRevision: 1,
      candidates: [
        candidate({ attachmentId: "attachment-a", targetId: "preset-a" }),
        candidate({ attachmentId: "attachment-b", targetId: "chat-a", source: "chat" }),
      ],
    });
    expect(acrossTargets.candidates).toHaveLength(2);
    expect(() =>
      freezeContextPackCandidateSnapshot({
        ownerId: "user-a",
        contextAclRevision: 1,
        candidates: [
          candidate({ attachmentId: "attachment-a" }),
          candidate({ attachmentId: "attachment-a" }),
        ],
      }),
    ).toThrow("duplicate context candidate");
  });
  test("accepts bounded pack descriptions separately from short labels", () => {
    const longDescription = "d".repeat(8 * 1024);
    const frozen = freezeContextPackCandidateSnapshot({
      ownerId: "user-a",
      contextAclRevision: 1,
      candidates: [candidate({ summary: longDescription })],
    });
    expect(frozen.candidates[0]?.summary).toBe(longDescription);
  });

  test("get requires exact pack revision and returns whole literal records by page", async () => {
    const frozen = snapshot();
    const tracker = new ContextPackInputRevisionTracker();
    const result = await createContextToolCapability(frozen, reader(state()), {
      revisionTracker: tracker,
      invalidationSink: sink(),
    }).get({
      pack_id: "pack-a",
      revision_id: "pack-a@1",
      revision: 1,
      limit: 2,
      offset: 1,
    });

    expect(result.status).toBe("success");
    const data = result.data as {
      records: readonly { id: string; text: string; title?: string; tags?: readonly string[] }[];
      total: number;
      offset: number;
      truncated: boolean;
    };
    expect(data.total).toBe(3);
    expect(data.offset).toBe(1);
    expect(data.truncated).toBe(false);
    expect(data.records[0]).toMatchObject({ id: "entry-b", title: "Title B", tags: ["two"] });

    const first = await createContextToolCapability(frozen, reader(state()), { invalidationSink: sink() }).get({
      pack_id: "pack-a",
      revision_id: "pack-a@1",
      revision: 1,
      limit: 1,
      offset: 0,
    });
    expect((first.data as { records: readonly { text: string }[] }).records[0]?.text).toBe(
      "literal {{macro}} /regex/",
    );

    const wrongRevision = await createContextToolCapability(frozen, reader(state()), { invalidationSink: sink() }).get({
      pack_id: "pack-a",
      revision_id: "pack-a@2",
      revision: 2,
    });
    expect(wrongRevision).toMatchObject({
      status: "error",
      toolName: "context_pack_get",
      errorCode: "context_pack_not_found",
    });
    expect(tracker.snapshot()).toHaveLength(1);
    expect(tracker.snapshot()[0]).toMatchObject({ packId: "pack-a", revisionId: "pack-a@1", digest: "digest-a" });
  });
  test("optional denied access returns one non-disclosing observation without bytes or activation", async () => {
    const frozen = snapshot();
    const denied = state({ allowed: false });
    const tracker = new ContextPackInputRevisionTracker();
    const result = await createContextToolCapability(frozen, reader(denied), {
      requirementFor: () => "optional",
      revisionTracker: tracker,
      invalidationSink: sink(),
    }).get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });

    expect(result).toMatchObject({ status: "error", toolName: "context_pack_get", errorCode: "context_pack_not_found" });
    expect(result.data).toBeUndefined();
    expect(denied.readCalls).toBe(0);
    expect(tracker.snapshot()).toHaveLength(0);
  });

  test("list/get bounds reject oversized pages and results without partial bytes", async () => {
    const frozen = snapshot();
    const bounded = createContextToolCapability(frozen, reader(state()), { invalidationSink: sink() });
    expect((await bounded.list({ limit: CONTEXT_PACK_LIST_LIMIT_MAX + 1 })).errorCode).toBe("invalid_arguments");
    expect((await bounded.get({
      pack_id: "pack-a",
      revision_id: "pack-a@1",
      revision: 1,
      limit: CONTEXT_PACK_GET_LIMIT_MAX + 1,
    })).errorCode).toBe("invalid_arguments");

    const overlong = state({
      content: content({ records: [{ id: "too-large", text: "x".repeat(CONTEXT_PACK_RECORD_MAX_BYTES + 1) }] }),
    });
    const tooLarge = await createContextToolCapability(frozen, reader(overlong), { invalidationSink: sink() }).get({
      pack_id: "pack-a",
      revision_id: "pack-a@1",
      revision: 1,
    });
    expect(tooLarge).toMatchObject({ status: "error", errorCode: "context_pack_limit_exceeded" });
    expect(tooLarge.data).toBeUndefined();

    const tinyBudget = new ContextPackToolBudget({ maxResultBytes: 16 });
    const budgetResult = await createContextToolCapability(frozen, reader(state()), {
      budget: tinyBudget,
      invalidationSink: sink(),
    }).get({
      pack_id: "pack-a",
      revision_id: "pack-a@1",
      revision: 1,
      limit: 1,
    });
    expect(budgetResult).toMatchObject({ status: "error", errorCode: "context_pack_limit_exceeded" });
    expect(budgetResult.data).toBeUndefined();
  });

  test("required access fails stably on stale ACL and invokes input/readiness invalidation", async () => {
    const frozen = snapshot();
    const changed = sink();
    const stale = state({ aclRevision: 2 });
    const capability = createContextToolCapability(frozen, reader(stale), {
      requirementFor: () => "required",
      invalidationSink: changed,
    });
    const result = await capability.get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });
    const repeated = await capability.get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });

    expect(result).toMatchObject({ status: "error", errorCode: "context_access_invalidated" });
    expect(repeated).toMatchObject({ status: "error", errorCode: "context_access_invalidated" });
    expect(result.data).toBeUndefined();
    expect(repeated.data).toBeUndefined();
    expect(stale.readCalls).toBe(0);
    expect(changed.reasons).toHaveLength(2);
    expect(changed.reasons[0]).toMatchObject({ kind: "acl_revision", ownerId: "user-a" });
  });

  test("optional stale/denied access is one non-disclosing observation and never activates a revision", async () => {
    const frozen = snapshot();
    const tracker = new ContextPackInputRevisionTracker();
    const changed = sink();
    const staleResult = await createContextToolCapability(frozen, reader(state({ aclRevision: 2 })), {
      revisionTracker: tracker,
      invalidationSink: changed,
    }).get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });
    expect(staleResult).toMatchObject({
      status: "error",
      toolName: "context_pack_get",
      errorCode: "context_pack_not_found",
    });
    expect(staleResult.data).toBeUndefined();
    expect(tracker.snapshot()).toHaveLength(0);
    expect(changed.reasons).toHaveLength(2);

    const denied = state({ allowed: false });
    const deniedResult = await createContextToolCapability(frozen, reader(denied), { invalidationSink: sink() }).get({
      pack_id: "pack-a",
      revision_id: "pack-a@1",
      revision: 1,
    });
    expect(deniedResult).toMatchObject({ status: "error", errorCode: "context_pack_not_found" });
    expect(deniedResult.data).toBeUndefined();
    expect(denied.readCalls).toBe(0);

    const stickyState = state({ allowed: false });
    const stickyCapability = createContextToolCapability(frozen, reader(stickyState), { invalidationSink: sink() });
    const firstDenied = await stickyCapability.get({
      pack_id: "pack-a",
      revision_id: "pack-a@1",
      revision: 1,
    });
    stickyState.allowed = true;
    const secondDenied = await stickyCapability.get({
      pack_id: "pack-a",
      revision_id: "pack-a@1",
      revision: 1,
    });
    expect(firstDenied.errorCode).toBe("context_pack_not_found");
    expect(secondDenied.errorCode).toBe("context_pack_not_found");
    expect(stickyState.readCalls).toBe(0);
  });

  test("host-required candidates cannot be downgraded by an optional active requirement", async () => {
    const frozen = snapshot({ required: true });
    const stale = state({ aclRevision: 2 });
    const changed = sink();
    const result = await createContextToolCapability(frozen, reader(stale), {
      activeCandidates: {
        contextPackRequirements: [{
          ruleId: null,
          source: "attachment",
          packId: "pack-a",
          revisionId: "pack-a@1",
          digest: "digest-a",
          required: false,
        }],
        newlyActivatedContextPackRequirements: [],
      },
      invalidationSink: changed,
    }).get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });
    expect(result).toMatchObject({
      status: "error",
      toolName: "context_pack_get",
      errorCode: "context_access_invalidated",
    });
    expect(result.data).toBeUndefined();
    expect(stale.readCalls).toBe(0);
    expect(changed.reasons[0]).toMatchObject({ kind: "acl_revision", ownerId: "user-a" });
    const denied = state({ allowed: false });
    const deniedResult = await createContextToolCapability(frozen, reader(denied), {
      activeCandidates: {
        contextPackRequirements: [{
          ruleId: null,
          source: "attachment",
          packId: "pack-a",
          revisionId: "pack-a@1",
          digest: "digest-a",
          required: false,
        }],
        newlyActivatedContextPackRequirements: [],
      },
      invalidationSink: sink(),
    }).get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });
    expect(deniedResult).toMatchObject({
      status: "error",
      toolName: "context_pack_get",
      errorCode: "context_access_invalidated",
    });
    expect(deniedResult.data).toBeUndefined();
    expect(denied.readCalls).toBe(0);
  });

  test("retains a caller requiredness callback when an active requirement is optional", async () => {
    const frozen = snapshot({ required: false });
    const stale = state({ aclRevision: 2 });
    const result = await createContextToolCapability(frozen, reader(stale), {
      activeCandidates: {
        contextPackRequirements: [{
          ruleId: null,
          source: "attachment",
          packId: "pack-a",
          revisionId: "pack-a@1",
          digest: "digest-a",
          required: false,
        }],
        newlyActivatedContextPackRequirements: [],
      },
      requirementFor: () => "required",
      invalidationSink: sink(),
    }).get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });
    expect(result).toMatchObject({ status: "error", errorCode: "context_access_invalidated" });
    expect(result.data).toBeUndefined();
    expect(stale.readCalls).toBe(0);
  });

  test("cross-user and frozen-set misses disclose neither metadata nor bytes", async () => {
    const frozen = snapshot();
    const unknownState = state();
    const result = await createContextToolCapability(frozen, reader(unknownState), { invalidationSink: sink() }).get({
      pack_id: "pack-from-another-user",
      revision_id: "pack-from-another-user@1",
      revision: 1,
    });
    expect(result).toMatchObject({ status: "error", errorCode: "context_pack_not_found" });
    expect(result.message).toBe("Context pack is unavailable.");
    expect(unknownState.readCalls).toBe(0);
    expect(() =>
      freezeContextPackCandidateSnapshot({
        ownerId: "user-a",
        contextAclRevision: 1,
        candidates: [candidate({ ownerId: "user-b" })],
      }),
    ).toThrow();
  });

  test("post-read ACL races discard bytes and invalidate the frozen revision", async () => {
    const frozen = snapshot();
    const changed = sink();
    const racing = state({
      onRead() {
        racing.aclRevision = 2;
      },
    });
    const result = await createContextToolCapability(frozen, reader(racing), {
      requirementFor: () => "required",
      invalidationSink: changed,
    }).get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });
    expect(result).toMatchObject({ status: "error", errorCode: "context_access_invalidated" });
    expect(result.data).toBeUndefined();
    expect(changed.reasons).toHaveLength(2);
  });

  test("changed immutable revision digest invalidates input/readiness without returning records", async () => {
    const frozen = snapshot();
    const changed = sink();
    const staleRevision = state({ content: content({ digest: "digest-after-freeze" }) });
    const result = await createContextToolCapability(frozen, reader(staleRevision), {
      requirementFor: () => "required",
      invalidationSink: changed,
    }).get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });
    expect(result).toMatchObject({ status: "error", errorCode: "context_access_invalidated" });
    expect(result.data).toBeUndefined();
    expect(changed.reasons).toHaveLength(2);
    expect(changed.reasons[0]).toMatchObject({ kind: "pack_revision", packId: "pack-a" });
  });

  test("COMMIT rechecks consumed revisions through the same sticky gate without output", async () => {
    const frozen = snapshot();
    const tracker = new ContextPackInputRevisionTracker();
    const changing = state();
    const changed = sink();
    const capability = createContextToolCapability(frozen, reader(changing), {
      revisionTracker: tracker,
      requirementFor: () => "required",
      invalidationSink: changed,
    });
    const fetched = await capability.get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });
    expect(fetched.status).toBe("success");
    changing.aclRevision = 2;
    const result = await recheckContextPackInputRevisionsAtCommit(
      frozen,
      reader(changing),
      tracker,
      changed,
      undefined,
      capability.operationGate,
    );
    expect(result).toMatchObject({ allowed: false, errorCode: "context_access_invalidated" });
    expect(changing.readCalls).toBe(1);
    expect(changed.reasons).toHaveLength(2);
  });

  test("account candidates keep nullable attachment identity through InputRevisionSet and COMMIT", async () => {
    const accountFrozen = freezeContextPackCandidateSnapshot({
      ownerId: "user-a",
      contextAclRevision: 1,
      candidates: [
        candidate({
          source: "account",
          targetId: null,
          attachmentId: null,
          attachmentRevision: null,
        }),
      ],
    });
    const tracker = new ContextPackInputRevisionTracker();
    const changed = sink();
    const accountState = state();
    const capability = createContextToolCapability(accountFrozen, reader(accountState), {
      requirementFor: () => "required",
      revisionTracker: tracker,
      invalidationSink: changed,
    });
    const fetched = await capability.get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });
    expect(fetched.status).toBe("success");
    expect(tracker.snapshot()[0]).toMatchObject({
      source: "account",
      targetId: null,
      attachmentId: null,
      attachmentRevision: null,
    });
    const result = await recheckContextPackInputRevisionsAtCommit(
      accountFrozen,
      reader(accountState),
      tracker,
      changed,
      undefined,
      capability.operationGate,
    );
    expect(result).toEqual({ allowed: true });
  });

  test("attachment revision changes invalidate input/readiness before output", async () => {
    const frozen = snapshot();
    const changed = sink();
    const moved = state({ attachmentRevision: "attachment-2" });
    const result = await createContextToolCapability(frozen, reader(moved), {
      requirementFor: () => "required",
      invalidationSink: changed,
    }).get({ pack_id: "pack-a", revision_id: "pack-a@1", revision: 1 });
    expect(result).toMatchObject({ status: "error", errorCode: "context_access_invalidated" });
    expect(moved.readCalls).toBe(0);
    expect(changed.reasons[0]).toMatchObject({ kind: "attachment_revision", packId: "pack-a" });
    expect(changed.reasons[0]?.revisionId).toBe("attachment-a");
  });
});
