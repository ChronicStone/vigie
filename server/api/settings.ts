import { config } from "../config.ts";
import { createInvite, listMembers, pendingInvites, removeMember, revokeInvite, setMemberRole, type Role } from "../auth.ts";
import { loadExtensions, registry } from "../extensions/index.ts";
import { ingestStats, pipelineHealth } from "../ingest/pipeline.ts";
import { query } from "../lib/clickhouse.ts";
import { redactionCounts, redactValue, RULES } from "../lib/redact.ts";
import { audit, db } from "../state/db.ts";
import { createToken, listTokens, revokeToken, type TokenKind } from "../state/tokens.ts";
import { answerLink, linkRequest } from "../state/links.ts";
import { notifyChannels } from "../alerts.ts";
import { HttpError, type Actor } from "./http.ts";

export type TokenRow = { id: string; kind: TokenKind; name: string; prefix: string; scope: string; environment: string | null; owner: string | null; created_at: number; last_used: number | null; revoked_at: number | null };
const tokens = () => listTokens() as TokenRow[];

export async function settingsServices() {
  const services = await query<{ name: string; environment: string; last: number; events: number }>("SELECT ServiceName AS name, Environment AS environment, toUnixTimestamp(max(Timestamp)) * 1000 AS last, count() AS events FROM logs WHERE Timestamp >= now() - INTERVAL 1 DAY GROUP BY name, environment ORDER BY name, environment");
  const base = new URL(config.publicUrl);
  return { services, endpoint: config.mode === "local" ? `${base.protocol}//${base.hostname}:${config.ingestPort}` : `${config.publicUrl}/otlp`, ingest: pipelineHealth(), keys: tokens().filter((t) => t.kind === "ingest" && !t.revoked_at), mode: config.mode };
}

const SIGNALS = [
  { label: "Spans", tables: ["spans"], ttl: "30 days" },
  { label: "Wide events and logs", tables: ["logs"], ttl: "90 days" },
  { label: "Metrics", tables: ["metrics_gauge", "metrics_sum", "metrics_histogram"], ttl: "30 days" },
  { label: "Rollups", tables: ["req_1m", "task_1m", "query_1m", "edges_5m", "trace_index"], ttl: "400 days" },
];

export async function settingsStorage() {
  const [parts, memory] = await Promise.all([
    query<{ table: string; bytes: number; rows: number; first: string }>("SELECT table, sum(bytes_on_disk) AS bytes, sum(rows) AS rows, toString(min(min_date)) AS first FROM system.parts WHERE active AND database = currentDatabase() GROUP BY table"),
    query<{ value: number }>("SELECT value FROM system.asynchronous_metrics WHERE metric = 'MemoryResident'"),
  ]);
  const firstDay = parts.map((p) => p.first).filter((d) => d && d !== "1970-01-01").sort()[0];
  const days = firstDay ? Math.max(1, (Date.now() - Date.parse(firstDay)) / 86_400_000) : 1;
  const signals = SIGNALS.map((signal) => {
    const inTables = parts.filter((p) => signal.tables.includes(p.table));
    const rows = inTables.reduce((sum, p) => sum + Number(p.rows), 0);
    return { label: signal.label, ttl: signal.ttl, bytes: inTables.reduce((sum, p) => sum + Number(p.bytes), 0), rows, perDay: rows / days };
  });
  const total = signals.reduce((sum, s) => sum + s.bytes, 0);
  return { total, perDay: total / days, clickhouseRam: Number(memory[0]?.value ?? 0), vigieRam: process.memoryUsage.rss(), lag: ingestStats.lastEventAt ? Math.max(0, Date.now() - ingestStats.lastEventAt) : 0, lastFlushMs: ingestStats.lastFlushMs, signals };
}

/** Names only, for choosing one. Targets are secrets. */
export const channelNames = () => db.query<{ name: string }, []>("SELECT name FROM channels ORDER BY name").all().map((channel) => channel.name);

export const settingsChannels = () => db.query<{ id: string; kind: string; name: string; target: string; is_default: number; signed: number }, []>("SELECT id, kind, name, target, is_default, secret IS NOT NULL AS signed FROM channels").all();

export function addChannel(input: { kind: "slack" | "discord" | "webhook" | "email"; name: string; target: string }, actor: Actor) {
  if (input.kind === "email") {
    if (!config.smtpUrl) throw new HttpError(400, "E-mail needs VIGIE_SMTP_URL on the server.");
    if (!/^[^@\s]+@[^@\s]+$/.test(input.target)) throw new HttpError(400, "An e-mail address, please.");
  } else if (!/^https:\/\//.test(input.target) && config.mode === "server") throw new HttpError(400, "The target must use https.");
  const id = crypto.randomUUID();
  const secret = input.kind === "webhook" ? Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url") : null;
  db.query("INSERT INTO channels (id, kind, name, target, secret, is_default) VALUES (?, ?, ?, ?, ?, 0)").run(id, input.kind, input.name || input.kind, input.target, secret);
  audit(actor.name, actor.through, "Added a channel", input.name);
  return { id, secret };
}

export function removeChannel(id: string, actor: Actor) {
  db.query("DELETE FROM channels WHERE id = ?").run(id);
  audit(actor.name, actor.through, "Removed a channel", id);
  return { ok: true };
}

export const testChannels = () =>
  notifyChannels({
    tone: "firing",
    title: "Test: the payment provider is refusing calls",
    summary: "This is what an alert looks like here. Nothing is wrong: 10 task attempts failed in the last 15 min. Limit is 10.",
    fields: [{ label: "Since", at: Date.now() - 900_000 }, { label: "Environment", value: "Test" }, { label: "Also firing", value: "Exceptions" }],
    causes: [{ count: "8×", code: "PROVIDER_UNAVAILABLE", where: "payments.charge" }, { count: "2×", code: "PROVIDER_UNAVAILABLE", where: "payments.refund" }],
    advice: "Nothing yet. Tasks retry on their own.",
    trend: { values: [1, 1, 1, 2, 1, 1, 2, 3, 5, 7, 8, 7], label: "last 2 hours" },
    links: [{ label: "Open Vigie", url: config.publicUrl }],
  });

export const settingsMembers = () => ({ invites: pendingInvites(), mode: config.mode, members: listMembers() as { id: string; name: string; email: string; role: Role; lastSeen: string | number | null }[] });

export function inviteMember(input: { email: string; role: Role }, actor: Actor) {
  if (!/.+@.+/.test(input.email)) throw new HttpError(400, "An email address, please.");
  const token = createInvite(input.email, input.role, actor.name);
  audit(actor.name, actor.through, "Invited a member", `${input.email} as ${input.role}`);
  return { url: `${config.publicUrl}/login?invite=${token}` };
}

export function cancelInvite(id: string, actor: Actor) {
  revokeInvite(id);
  audit(actor.name, actor.through, "Cancelled an invitation", id);
  return { ok: true };
}

export function dropMember(id: string, actor: Actor) {
  try {
    removeMember(id);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  audit(actor.name, actor.through, "Removed a member", id);
  return { ok: true };
}

export function changeRole(input: { id: string; role: Role }, actor: Actor) {
  try {
    setMemberRole(input.id, input.role);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  audit(actor.name, actor.through, `Changed a member's role to ${input.role}`, input.id);
  return { ok: true };
}

export const settingsTokens = () => tokens();

export function addToken(input: { kind: TokenKind; name: string; scope: "read" | "write"; environment?: string }, actor: Actor) {
  if (!input.name.trim()) throw new HttpError(400, "A token needs a name.");
  const token = createToken({ kind: input.kind, name: input.name, scope: input.scope, environment: input.environment, owner: actor.name });
  audit(actor.name, actor.through, `Created a ${input.kind} token`, input.name);
  return token;
}

export function dropToken(id: string, actor: Actor) {
  revokeToken(id);
  audit(actor.name, actor.through, "Revoked a token", id);
  return { ok: true };
}

export const settingsExtensions = () => ({ dir: config.definitionsDir, loaded: registry.loaded, reloadMs: registry.reloadMs, hotReload: config.mode === "local" });

export async function reloadExtensions(actor: Actor) {
  await loadExtensions();
  audit(actor.name, actor.through, "Reloaded definitions");
  return settingsExtensions();
}

export const settingsRedaction = () => ({ rules: RULES.map((r) => ({ id: r.id, title: r.title, detail: r.detail, count: redactionCounts[r.id] ?? 0 })) });
export const tryRedaction = (input: { key: string; value: string }) => ({ value: redactValue(input.key, input.value) });

export const settingsAudit = () => db.query<{ id: number; at: number; actor: string; through: string; action: string; target: string | null; ip: string | null }, []>("SELECT * FROM audit ORDER BY at DESC LIMIT 500").all();

export const pendingLink = (code: string) => ({ request: linkRequest(code), environments: config.environments });

export function decideLink(input: { code: string; allow: boolean; environment?: string }, actor: Actor) {
  const result = answerLink(input, actor.name);
  if (!result) throw new HttpError(404, "This code has expired or was already used. Run the installer again.");
  audit(actor.name, actor.through, result.allowed ? "Linked an app" : "Refused to link an app", `${result.service}${input.environment ? ` (${input.environment})` : ""}`);
  return result;
}
