import { db } from "./db.ts";

export type TokenKind = "ingest" | "api" | "mcp" | "deploy";

const PREFIX: Record<TokenKind, string> = { ingest: "vk_", api: "va_", mcp: "vm_", deploy: "vd_" };

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** The secret is only ever returned here, once. Only its hash is stored. */
export function createToken(input: { kind: TokenKind; name: string; scope?: string; environment?: string; owner?: string }) {
  const secret = `${PREFIX[input.kind]}${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
  const id = crypto.randomUUID();
  db.query("INSERT INTO tokens (id, kind, name, hash, prefix, scope, environment, owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.kind, input.name, hash(secret), `${secret.slice(0, 7)}…${secret.slice(-2)}`, input.scope ?? "read", input.environment ?? null, input.owner ?? null, Date.now());
  return { id, secret };
}

const lookup = db.query<{ id: string; kind: TokenKind; scope: string; environment: string | null; owner: string | null; name: string }, [string]>("SELECT id, kind, scope, environment, owner, name FROM tokens WHERE hash = ? AND revoked_at IS NULL");
const touch = db.query("UPDATE tokens SET last_used = ? WHERE id = ?");
const lastTouched = new Map<string, number>();

export function verifyToken(secret: string, kinds: TokenKind[]) {
  const row = lookup.get(hash(secret));
  if (!row || !kinds.includes(row.kind)) return null;
  const now = Date.now();
  if (now - (lastTouched.get(row.id) ?? 0) > 60_000) {
    lastTouched.set(row.id, now);
    touch.run(now, row.id);
  }
  return row;
}

export function listTokens() {
  return db.query("SELECT id, kind, name, prefix, scope, environment, owner, created_at, last_used, revoked_at FROM tokens ORDER BY created_at DESC").all();
}

export function revokeToken(id: string) {
  db.query("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
}
