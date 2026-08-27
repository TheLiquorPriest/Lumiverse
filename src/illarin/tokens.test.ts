import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { initIdentity } from "../crypto/init";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as svc from "../services/illarin-instance.service";
import { IllarinRateLimitError, type IllarinFetch, type IllarinRequestOptions } from "./api";
import { getValidAccessToken, handleTerminalUnauthorized, refreshAccessToken } from "./tokens";
import type { TokenPair } from "./types";

const USER_A = "user-a";
const USER_B = "user-b";
const BASE_URL = "https://illarin.xyz";

interface LinkEventMessage {
  payload: { linked: boolean; reason?: string };
  userId?: string;
}

/** Await the real signal: the next ILLARIN_LINK_STATE_CHANGED dispatch. */
function nextLinkEvent(): Promise<LinkEventMessage> {
  const { promise, resolve } = Promise.withResolvers<LinkEventMessage>();
  const off = eventBus.on(EventType.ILLARIN_LINK_STATE_CHANGED, (message) => {
    off();
    resolve({ payload: message.payload, userId: message.userId });
  });
  return promise;
}

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

function futureExpiry(ms = 15 * 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function pair(access: string, refresh: string, expiresAt = futureExpiry()): TokenPair {
  return {
    accessToken: access,
    accessTokenExpiresAt: expiresAt,
    refreshToken: refresh,
    instance: { id: `inst-${refresh}`, scopes: ["asset:receive"] },
  };
}

async function seedLinked(userId: string, p: TokenPair): Promise<void> {
  await svc.saveInstance({
    userId,
    illarinUrl: BASE_URL,
    pair: p,
    instanceName: `${userId}-box`,
    applicationName: "Lumiverse",
    declarationJson: JSON.stringify({ applicationVersion: "0.0.0-test" }),
  });
}

describe("illarin token lifecycle", () => {
  beforeAll(async () => {
    await initIdentity();
  });

  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  /** Test-seam cast on a named const: minimal counting stand-in for safeFetch. */
  function countingFetch(handler: () => Response | Promise<Response>): {
    fetch: IllarinFetch;
    calls: () => number;
    bodies: string[];
  } {
    let calls = 0;
    const bodies: string[] = [];
    const fetch = ((url: string, init?: { body?: string }) => {
      calls++;
      bodies.push(init?.body ?? "");
      return handler();
    }) as unknown as IllarinFetch;
    return { fetch, calls: () => calls, bodies };
  }

  const opts = (fetch: IllarinFetch): IllarinRequestOptions => ({ fetchImpl: fetch });

  test("returns the stored access token without touching the network while fresh", async () => {
    await seedLinked(USER_A, pair("ia1.fresh", "ir1.1"));
    const { fetch, calls } = countingFetch(() => Response.json({}));

    const token = await getValidAccessToken(USER_A, opts(fetch));

    expect(token).toBe("ia1.fresh");
    expect(calls()).toBe(0);
  });

  test("returns null when the user has never linked", async () => {
    await expect(getValidAccessToken(USER_A)).resolves.toBeNull();
  });

  test("refreshes inside the skew window and persists the replacement durably", async () => {
    // 30s left < 90s skew window.
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const { fetch, calls, bodies } = countingFetch(() => Response.json(pair("ia1.new", "ir1.new")));

    const token = await getValidAccessToken(USER_A, opts(fetch));

    expect(token).toBe("ia1.new");
    expect(bodies[0]).toBe(JSON.stringify({ refreshToken: "ir1.old" }));
    expect(calls()).toBe(1);

    const stored = await svc.getIllarinInstance(USER_A);
    expect(stored?.refreshToken).toBe("ir1.new");
    expect(stored?.accessToken).toBe("ia1.new");
    expect(stored?.lastRefreshAt).not.toBeNull();
  });

  test("forces one serialized refresh after an access-endpoint 401 even when the token is fresh", async () => {
    await seedLinked(USER_A, pair("ia1.rejected", "ir1.old"));
    const { fetch, calls } = countingFetch(() => Response.json(pair("ia1.retry", "ir1.next")));

    const tokens = await Promise.all([
      refreshAccessToken(USER_A, opts(fetch)),
      refreshAccessToken(USER_A, opts(fetch)),
    ]);

    expect(tokens).toEqual(["ia1.retry", "ia1.retry"]);
    expect(calls()).toBe(1);
    expect((await svc.getIllarinInstance(USER_A))?.refreshToken).toBe("ir1.next");
  });

  test("coalesces concurrent refreshes into a single HTTP call", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const { fetch, calls } = countingFetch(() => Response.json(pair("ia1.new", "ir1.new")));

    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => getValidAccessToken(USER_A, opts(fetch))),
    );

    expect(tokens).toEqual(["ia1.new", "ia1.new", "ia1.new", "ia1.new", "ia1.new"]);
    expect(calls()).toBe(1);
  });

  test("terminal 401 removes credentials and emits the link-state event", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const { fetch } = countingFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    const emitted = nextLinkEvent();

    await expect(getValidAccessToken(USER_A, opts(fetch))).resolves.toBeNull();

    await expect(svc.getIllarinInstance(USER_A)).resolves.toBeNull();
    await expect(emitted).resolves.toEqual({
      userId: USER_A,
      payload: { linked: false, reason: "unauthorized" },
    });
  });

  test("unknown refresh outcome stops the installation and never retries the old token", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    // Test-seam cast on a named const: always-failing transport.
    const flaky: IllarinFetch = (() => {
      throw new TypeError("connection reset");
    }) as unknown as IllarinFetch;

    const emitted = nextLinkEvent();
    // First attempt: outcome unknown → teardown.
    await expect(getValidAccessToken(USER_A, opts(flaky))).resolves.toBeNull();
    await expect(emitted).resolves.toEqual({
      userId: USER_A,
      payload: { linked: false, reason: "refresh_outcome_unknown" },
    });
    await expect(svc.getIllarinInstance(USER_A)).resolves.toBeNull();

    // Second attempt: no blind retry of the possibly-spent token.
    await expect(getValidAccessToken(USER_A)).resolves.toBeNull();
  });

  test("rate limits propagate without destroying credentials", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const { fetch, calls } = countingFetch(
      () => Response.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "7" } }),
    );

    try {
      await getValidAccessToken(USER_A, opts(fetch));
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(IllarinRateLimitError);
      expect((err as IllarinRateLimitError).retryAfterSeconds).toBe(7);
    }

    // No teardown happened: credentials survive for a Retry-After retry.
    const stored = await svc.getIllarinInstance(USER_A);
    expect(stored?.refreshToken).toBe("ir1.old");
    expect(calls()).toBe(1);
  });

  test("teardown is isolated per installation", async () => {
    await seedLinked(USER_A, pair("ia1.a-old", "ir1.a", futureExpiry(30_000)));
    await seedLinked(USER_B, pair("ia1.b-fresh", "ir1.b"));
    const { fetch } = countingFetch(() => {
      throw new TypeError("connection reset");
    });
    const emittedForA = nextLinkEvent();

    await expect(getValidAccessToken(USER_A, opts(fetch))).resolves.toBeNull();

    const event = await emittedForA;
    expect(event.userId).toBe(USER_A);

    await expect(svc.getIllarinInstance(USER_B)).resolves.toMatchObject({ accessToken: "ia1.b-fresh" });
    await expect(getValidAccessToken(USER_B)).resolves.toBe("ia1.b-fresh");
  });

  test("handleTerminalUnauthorized deletes the row and reports the reason", async () => {
    await seedLinked(USER_A, pair("ia1.x", "ir1.x"));
    const emitted = nextLinkEvent();

    await handleTerminalUnauthorized(USER_A, "unlinked");

    await expect(svc.getIllarinInstance(USER_A)).resolves.toBeNull();
    await expect(emitted).resolves.toEqual({
      userId: USER_A,
      payload: { linked: false, reason: "unlinked" },
    });
  });
});
