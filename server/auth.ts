import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { twoFactor } from "better-auth/plugins/two-factor";
import { getMigrations } from "better-auth/db/migration";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { verifyToken } from "./state/tokens.ts";
import type { Actor } from "./api/http.ts";

export type Role = "viewer" | "operator" | "admin" | "owner";

function persistedSecret() {
  if (config.auth.secret) return config.auth.secret;
  const path = join(config.dataDir, "auth-secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

/** Whoever opens a fresh server first must not become its owner: the first sign-up needs this code, printed in the server's logs. */
export function setupCode() {
  const path = join(config.dataDir, "setup-code");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const code = Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString("base64url");
  writeFileSync(path, code, { mode: 0o600 });
  return code;
}

export const authDb = new Database(join(config.dataDir, "auth.db"), { create: true });
authDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

authDb.exec("CREATE TABLE IF NOT EXISTS invite (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT NOT NULL, at INTEGER NOT NULL, expires INTEGER NOT NULL, used_at INTEGER)");

const hashOf = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const INVITE_DAYS = 7;

/** Only the hash is stored, so the link works once for whoever received it and a stolen database opens nothing. */
export function createInvite(email: string, role: Role, by: string) {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const clean = email.trim().toLowerCase();
  authDb.query("DELETE FROM invite WHERE email = ? AND used_at IS NULL").run(clean);
  authDb.query("INSERT INTO invite (id, token_hash, email, role, invited_by, at, expires) VALUES (?, ?, ?, ?, ?, ?, ?)").run(crypto.randomUUID(), hashOf(token), clean, role, by, Date.now(), Date.now() + INVITE_DAYS * 86_400_000);
  return token;
}

export function inviteFor(token: string) {
  return authDb.query<{ id: string; email: string; role: Role }, [string, number]>("SELECT id, email, role FROM invite WHERE token_hash = ? AND used_at IS NULL AND expires > ?").get(hashOf(token), Date.now());
}

export const pendingInvites = () => authDb.query<{ id: string; email: string; role: Role; expires: number }, [number]>("SELECT id, email, role, expires FROM invite WHERE used_at IS NULL AND expires > ? ORDER BY at DESC").all(Date.now());
export const revokeInvite = (id: string) => authDb.query("DELETE FROM invite WHERE id = ?").run(id);

const oidc = config.auth.oidcIssuer
  ? [
      genericOAuth({
        config: [
          {
            providerId: "app",
            discoveryUrl: `${config.auth.oidcIssuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
            clientId: config.auth.oidcClientId,
            clientSecret: config.auth.oidcClientSecret,
            scopes: ["openid", "profile", "email"],
          },
        ],
      }),
    ]
  : [];

export const auth = betterAuth({
  appName: "Vigie",
  // On a first boot Better Auth reports the tables migrateAuth() is about to create. Nobody can act on that line.
  logger: { log: (level, message) => void (message.includes("Database schema mismatch") || message.includes("Rate limiting could not determine a client IP") ? undefined : console[level === "debug" ? "log" : level](`[auth] ${message}`)) },
  baseURL: config.publicUrl,
  secret: persistedSecret(),
  database: authDb,
  emailAndPassword: { enabled: true, disableSignUp: false, minPasswordLength: 10 },
  user: { additionalFields: { role: { type: "string", required: false, defaultValue: "viewer", input: false } } },
  // No cookie cache: removing someone or changing their role must apply on their next request, not a minute later.
  session: { cookieCache: { enabled: false }, expiresIn: 60 * 60 * 24 * 14 },
  advanced: { cookiePrefix: "vigie", useSecureCookies: config.publicUrl.startsWith("https://"), defaultCookieAttributes: { sameSite: "lax", httpOnly: true } },
  // One bucket per path on purpose: behind a proxy every client looks the same, and a forwarded address could be forged.
  rateLimit: { enabled: true, window: 60, max: 30, storage: "memory" },
  trustedOrigins: [config.publicUrl],
  plugins: [...oidc, twoFactor({ issuer: "Vigie" })],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;
      if (usersExist()) {
        const invite = inviteFor(ctx.headers?.get("x-vigie-invite") ?? "");
        if (invite && String(ctx.body?.email ?? "").trim().toLowerCase() !== invite.email) throw new APIError("FORBIDDEN", { message: "This invitation is for another email address." });
        if (!invite && !config.auth.allowSignup) throw new APIError("FORBIDDEN", { message: "Sign-up is closed. Ask an owner to invite you." });
        return;
      }
      if (ctx.headers?.get("x-vigie-setup-code") !== setupCode()) throw new APIError("FORBIDDEN", { message: "The setup code is wrong. It is printed in the server's logs." });
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const row = authDb.query<{ n: number }, []>('SELECT count(*) AS n FROM "user"').get();
          if (!row || row.n === 0) return { data: { ...user, role: "owner" } };
          const invite = authDb.query<{ id: string; role: Role }, [string, number]>("SELECT id, role FROM invite WHERE email = ? AND used_at IS NULL AND expires > ?").get(String(user.email).toLowerCase(), Date.now());
          if (invite) authDb.query("UPDATE invite SET used_at = ? WHERE id = ?").run(Date.now(), invite.id);
          return { data: { ...user, role: invite?.role ?? "viewer" } };
        },
      },
    },
  },
});

export async function migrateAuth() {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

export function usersExist() {
  try {
    return (authDb.query<{ n: number }, []>('SELECT count(*) AS n FROM "user"').get()?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

const LOCAL_ACTOR: Actor = { id: "local", name: process.env.USER ?? "You", role: "owner", through: "app" };

/** Who is calling. Tokens are for machines, sessions for people. Local mode needs neither: it only listens on this machine. */
export async function actorOf(request: Request): Promise<Actor | null> {
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) {
    const token = verifyToken(header.slice(7).trim(), ["api", "mcp", "deploy"]);
    if (!token) return null;
    return { id: token.id, name: token.name, role: token.scope === "write" ? "operator" : "viewer", through: token.kind === "mcp" ? "mcp" : "api" };
  }
  if (config.mode === "local") return LOCAL_ACTOR;
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  const user = session.user as typeof session.user & { role?: Role };
  return { id: user.id, name: user.name || user.email, role: user.role ?? "viewer", through: "app" };
}

export function listMembers() {
  try {
    return authDb
      .query<any, []>(`SELECT u.id, u.name, u.email, u.role, (SELECT max(s.updatedAt) FROM "session" s WHERE s.userId = u.id) AS lastSeen FROM "user" u ORDER BY u.createdAt`)
      .all();
  } catch {
    return [];
  }
}

const isLastOwner = (id: string) => {
  const owners = authDb.query<{ id: string }, []>(`SELECT id FROM "user" WHERE role = 'owner'`).all();
  return owners.length === 1 && owners[0]!.id === id;
};

export function setMemberRole(id: string, role: Role) {
  if (role !== "owner" && isLastOwner(id)) throw new Error("Vigie needs at least one owner.");
  authDb.query('UPDATE "user" SET role = ? WHERE id = ?').run(role, id);
}

export function removeMember(id: string) {
  if (isLastOwner(id)) throw new Error("Vigie needs at least one owner.");
  authDb.query('DELETE FROM "session" WHERE userId = ?').run(id);
  authDb.query('DELETE FROM "account" WHERE userId = ?').run(id);
  authDb.query('DELETE FROM "user" WHERE id = ?').run(id);
}

/** The person's own token from signing in with the app. Task actions run as them, or not at all. */
export function appAccessToken(userId: string) {
  try {
    return authDb.query<{ accessToken: string | null }, [string]>(`SELECT accessToken FROM "account" WHERE userId = ? AND providerId = 'app' LIMIT 1`).get(userId)?.accessToken ?? null;
  } catch {
    return null;
  }
}
