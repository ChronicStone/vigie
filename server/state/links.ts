import { createToken } from "./tokens.ts";

/**
 * Linking an app from its terminal, like `gh auth login`: the installer asks for a code, someone
 * signed in to Vigie allows it, and the installer picks up an ingest key once. Nothing is stored:
 * a request lives 10 minutes in memory, and a restart only means running the installer again.
 */
type Link = { code: string; secret: string; service: string; created: number; status: "pending" | "approved" | "denied"; key?: string; environment?: string };

const TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;
const links = new Map<string, Link>();

const prune = () => {
  for (const [secret, link] of links) if (Date.now() - link.created > TTL_MS) links.delete(secret);
};

/** No 0/O or 1/I, so the code reads aloud and survives a screenshot. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
};

export function startLink(service: string) {
  prune();
  if ([...links.values()].filter((l) => l.status === "pending").length >= MAX_PENDING) throw new Error("Too many apps are waiting to be linked. Try again in a few minutes.");
  const clean = service.trim().slice(0, 80).replace(/[^\w.\-]/g, "-") || "app";
  const link: Link = { code: makeCode(), secret: Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url"), service: clean, created: Date.now(), status: "pending" };
  links.set(link.secret, link);
  return { code: link.code, secret: link.secret, expiresIn: TTL_MS / 1000 };
}

/** The installer polls with its secret. An approved key is handed out once, then forgotten. */
export function pollLink(secret: string) {
  prune();
  const link = links.get(secret);
  if (!link) return { status: "expired" as const };
  if (link.status !== "approved") return { status: link.status };
  links.delete(secret);
  return { status: "approved" as const, key: link.key, environment: link.environment };
}

const byCode = (code: string) => {
  prune();
  const wanted = code.trim().toUpperCase();
  return [...links.values()].find((l) => l.code === wanted && l.status === "pending");
};

export function linkRequest(code: string) {
  const link = byCode(code);
  return link ? { service: link.service, code: link.code, created: link.created } : null;
}

export function answerLink(input: { code: string; allow: boolean; environment?: string }, owner: string) {
  const link = byCode(input.code);
  if (!link) return null;
  if (!input.allow) {
    link.status = "denied";
    return { service: link.service, allowed: false };
  }
  const token = createToken({ kind: "ingest", name: link.service, environment: input.environment, owner });
  link.status = "approved";
  link.key = token.secret;
  link.environment = input.environment;
  return { service: link.service, allowed: true };
}
