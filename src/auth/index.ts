import { betterAuth } from "better-auth";
import { username, admin, bearer, genericOAuth } from "better-auth/plugins";
import { getDb } from "../db/connection";
import { env } from "../env";
import { provisionUserDirectories } from "./provision";
import { seedDefaultPreset } from "./default-preset";
import { getAllowedOrigins } from "../services/trusted-hosts.service";
import { listEnabledSsoAuthConfigs } from "../services/sso-providers.service";

// ─── Signup gate ────────────────────────────────────────────────────────
// All signups are blocked unless a valid nonce is presented.
// Nonces are single-use, short-lived (10s), cryptographically random, and
// tracked as a small set so concurrent admin-created signups don't race on a
// single slot (the previous single-slot design made one valid nonce unusable
// when two creations were in flight, and burned it on the first failure).

const CREATION_NONCE_TTL_MS = 10_000;
const MAX_OUTSTANDING_NONCES = 16;
const outstandingNonces = new Map<string, number>(); // nonce → expiry

export const CREATION_NONCE_HEADER = "x-lumiverse-creation-nonce";

export function allowCreation(): string {
  // Bound memory: drop expired entries first, then evict oldest if still full.
  const now = Date.now();
  for (const [nonce, expiry] of outstandingNonces) {
    if (now > expiry) outstandingNonces.delete(nonce);
  }
  if (outstandingNonces.size >= MAX_OUTSTANDING_NONCES) {
    const oldest = [...outstandingNonces.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) outstandingNonces.delete(oldest[0]);
  }
  const nonce = crypto.randomUUID();
  outstandingNonces.set(nonce, now + CREATION_NONCE_TTL_MS);
  return nonce;
}

function consumeNonce(expectedNonce: string | null): boolean {
  if (!expectedNonce) return false;
  const expiry = outstandingNonces.get(expectedNonce);
  if (expiry === undefined) return false;
  outstandingNonces.delete(expectedNonce); // single use
  return Date.now() <= expiry;
}

// ─── BetterAuth instance ────────────────────────────────────────────────

let ssoConfigs: ReturnType<typeof listEnabledSsoAuthConfigs> = [];
try {
  ssoConfigs = listEnabledSsoAuthConfigs();
  if (ssoConfigs.length > 0) {
    console.log(`[Auth] Registered ${ssoConfigs.length} owner-configured SSO provider${ssoConfigs.length === 1 ? "" : "s"}.`);
    for (const provider of ssoConfigs) {
      console.log(`[Auth] SSO ${provider.providerId} redirect URI: ${provider.redirectURI}`);
    }
  }
} catch (err) {
  // This can happen in tests that import auth before migrations have run.
  // In production the table exists, so surface it as a warning rather than crash.
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[Auth] Could not load SSO providers at startup: ${message}`);
}

export const auth = betterAuth({
  database: getDb(),
  baseURL: process.env.AUTH_BASE_URL || `http://localhost:${env.port}`,
  basePath: "/api/auth",
  secret: env.authSecret,
  // Dynamic form so that hosts added via the Operator panel (Host-header
  // allowlist) are also accepted by BetterAuth's origin check. A static array
  // would freeze the env-only baseline at module init, which is why newly
  // added trusted hosts appeared to "revert" on every server restart — the
  // DB-backed hosts were loaded into the middleware's cache but never fed
  // back into BetterAuth.
  trustedOrigins: (request?: Request) => {
    if (env.trustAnyOrigin) {
      const origin = request?.headers.get("origin");
      return origin ? [origin] : [];
    }
    return [...getAllowedOrigins()];
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  plugins: [
    username({
      usernameNormalization: (u) => u.toLowerCase(),
    }),
    admin({
      defaultRole: "user",
      adminRoles: ["admin", "owner"],
      roles: {
        user: {} as any,
        admin: {} as any,
        owner: {} as any,
      },
    }),
    ...(ssoConfigs.length > 0
      ? [genericOAuth({
          config: ssoConfigs.map((provider) => ({
            providerId: provider.providerId,
            clientId: provider.clientId,
            clientSecret: provider.clientSecret,
            discoveryUrl: provider.discoveryUrl,
            redirectURI: provider.redirectURI,
            scopes: provider.scopes,
            pkce: provider.pkce,
            disableImplicitSignUp: true,
            disableSignUp: true,
          })),
        })]
      : []),
    bearer(),
  ],
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ssoConfigs.map((provider) => provider.providerId),
      allowDifferentEmails: true,
      disableImplicitLinking: true,
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (_user, ctx) => {
          const expectedNonce = ctx?.headers?.get(CREATION_NONCE_HEADER) ?? null;
          if (!consumeNonce(expectedNonce)) {
            return false;
          }
        },
        after: async (user) => {
          // BetterAuth swallows hook exceptions, so surface directory or
          // preset-seed failures independently instead of dropping the user
          // into a half-provisioned state with no signal in the logs.
          try {
            provisionUserDirectories(user.id);
          } catch (err) {
            console.error(
              `[Auth] Failed to provision directories for user ${user.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
          try {
            seedDefaultPreset(user.id, { setActive: true });
          } catch (err) {
            console.error(
              `[Auth] Failed to seed default preset for user ${user.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        },
      },
    },
  },
});

export type Auth = typeof auth;
