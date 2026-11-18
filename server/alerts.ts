import { query } from "./lib/clickhouse.ts";
import { config } from "./config.ts";
import { explainError, registry } from "./extensions/index.ts";
import { discordMessage, emailMessage, humanDuration, humanWindow, noticeText, slackMessage, type Notice } from "./notify.ts";
import { db } from "./state/db.ts";
import { dt, type Scope } from "./api/http.ts";
import type { AlertRule, AlertWhen, QuietHours } from "../sdk/index.ts";

const seconds = (text: string) => {
  const m = text?.match(/^(\d+)(s|m|h|d)$/);
  return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s"] : 600;
};

/** Every rule compiles to one query that yields a value per time bucket. The evaluator reads the last one, the chart reads them all. */
function compile(when: AlertWhen, windowSeconds: number) {
  const t = "toUnixTimestamp(toStartOfInterval(TS, toIntervalSecond({step:UInt32}))) * 1000";
  const time = (column: string) => `${column} >= toDateTime64({from:String}, 3) AND ${column} <= toDateTime64({to:String}, 3) AND Environment = {env:String}`;
  const params: Record<string, any> = {};
  switch (when.source) {
    case "task-failure-rate":
      if (when.kind) params.kind = when.kind;
      return { params, sql: `SELECT ${t.replace("TS", "Minute")} AS t, sumIf(Attempts, Outcome = 'failed') / greatest(sum(Attempts), 1) * 100 AS v FROM task_1m WHERE ${time("Minute")} ${when.kind ? "AND TaskKind = {kind:String}" : ""} GROUP BY t ORDER BY t` };
    case "oldest-due":
      return { params, sql: `SELECT ${t.replace("TS", "TimeUnix")} AS t, max(Value) AS v FROM metrics_gauge WHERE MetricName = '${config.taskMetrics}.oldest_due_age' AND ${time("TimeUnix")} GROUP BY t ORDER BY t` };
    case "request-error-rate":
      return { params, sql: `SELECT ${t.replace("TS", "Minute")} AS t, sumIf(Requests, StatusClass >= 500) / greatest(sum(Requests), 1) * 100 AS v FROM req_1m WHERE ${time("Minute")} GROUP BY t ORDER BY t` };
    case "route-p95": {
      const extra = [when.method ? "Method = {method:String}" : "", when.route ? "Route = {route:String}" : ""].filter(Boolean).map((c) => ` AND ${c}`).join("");
      Object.assign(params, { method: when.method, route: when.route, min: when.minRequests ?? 0 });
      return { params, sql: `SELECT ${t.replace("TS", "Minute")} AS t, if(sum(Requests) >= {min:UInt32}, quantilesTDigestMerge(0.5, 0.95, 0.99)(Quantiles)[2], 0) AS v FROM req_1m WHERE ${time("Minute")}${extra} GROUP BY t ORDER BY t` };
    }
    case "log-count": {
      const parts = Object.entries(when.where).map(([key, value], index) => {
        params[`k${index}`] = key;
        params[`v${index}`] = value;
        return `LogAttributes[{k${index}:String}] = {v${index}:String}`;
      });
      return { params, sql: `SELECT ${t.replace("TS", "Timestamp")} AS t, count() AS v FROM logs WHERE ${time("Timestamp")} AND ${parts.join(" AND ") || "1"} GROUP BY t ORDER BY t` };
    }
    case "absence":
      params.kind = when.taskKind;
      return { params, sql: `SELECT ${t.replace("TS", "Minute")} AS t, sum(Attempts) AS v FROM task_1m WHERE ${time("Minute")} AND TaskKind = {kind:String} GROUP BY t ORDER BY t` };
    case "metric": {
      params.name = when.name;
      const parts = Object.entries(when.attributes ?? {}).map(([key, value], index) => {
        params[`k${index}`] = key;
        params[`v${index}`] = value;
        return ` AND Attributes[{k${index}:String}] = {v${index}:String}`;
      });
      const agg = when.agg === "max" ? "max(Value)" : when.agg === "latest" ? "argMax(Value, TimeUnix)" : "avg(Value)";
      return { params, sql: `SELECT ${t.replace("TS", "TimeUnix")} AS t, ${agg} AS v FROM metrics_gauge WHERE MetricName = {name:String} AND ${time("TimeUnix")}${parts.join("")} GROUP BY t ORDER BY t` };
    }
    case "new-error":
      return { params, sql: `SELECT ${t.replace("TS", "Timestamp")} AS t, count() AS v FROM logs WHERE ${time("Timestamp")} AND Fingerprint != '' GROUP BY t ORDER BY t` };
    case "sql":
      return { params, sql: when.sql };
    default:
      throw new Error(`${when.source} has no history query.`);
  }
}

/** These read what the SLO and rule pages already compute. They are live values, so they have no history to draw. */
async function liveValue(when: AlertWhen, env: string) {
  const { rules, slos } = await import("./api/reliability.ts");
  if (when.source === "slo-burn") return (await slos({ env: env as "PRD" })).find((slo) => slo.id === when.slo)?.burn ?? 0;
  if (when.source === "rule-violation") {
    const now = Date.now();
    return (await rules({ env: env as "PRD", from: now - 3_600_000, to: now })).find((rule) => rule.id === when.rule)?.violated ?? 0;
  }
  return null;
}

export async function evaluateRule(rule: AlertRule, env: string) {
  const live = await liveValue(rule.when, env);
  if (live !== null) return live;
  const window = seconds(rule.window);
  const now = Date.now();
  const { sql, params } = compile(rule.when, window);
  const rows = await query<any>(sql, { params: { ...params, from: dt(now - window * 1000), to: dt(now), env, step: window }, timeout: 8 });
  if (rule.when.source === "absence" || rule.when.source === "log-count" || rule.when.source === "new-error") return rows.reduce((sum, r) => sum + Number(r.v), 0);
  return rows.length ? Number(rows[rows.length - 1].v) : 0;
}

/** Quiet hours may wrap past midnight, so 22:00 to 07:00 covers both ends of the night. */
export function inQuietHours(quiet: QuietHours | undefined, now = Date.now()) {
  if (!quiet) return false;
  const minutes = (text: string) => {
    const [h, m] = text.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: quiet.timezone }).formatToParts(now);
  const current = Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
  const from = minutes(quiet.from);
  const to = minutes(quiet.to);
  return from <= to ? current >= from && current < to : current >= from || current < to;
}

/** A line far enough above normal that ordinary noise does not cross it. A perfectly flat history must not fire on the first small bump. */
export function sigmaLine(values: number[], sigma: number) {
  if (values.length < 24) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
  return { mean, deviation, line: mean + sigma * Math.max(deviation, Math.abs(mean) * 0.05, 0.01) };
}

const baselines = new Map<string, { at: number; value: ReturnType<typeof sigmaLine> }>();

/** The last 7 days of the same value, read at most every 10 minutes per alert. */
export async function anomalyBaseline(rule: AlertRule, env: string, now = Date.now()) {
  const key = `${env}:${JSON.stringify(rule.when)}:${rule.window}:${rule.sigma}`;
  const cached = baselines.get(key);
  if (cached && now - cached.at < 600_000) return cached.value;
  const step = seconds(rule.window);
  const { sql, params } = compile(rule.when, step);
  const rows = await query<any>(sql, { params: { ...params, from: dt(now - 7 * 86_400_000), to: dt(now - step * 1000), env, step }, timeout: 10 });
  const value = sigmaLine(rows.map((r) => Number(r.v)), rule.sigma ?? 3);
  baselines.set(key, { at: now, value });
  return value;
}

export async function alertHistory(rule: AlertRule, scope: Scope) {
  if (rule.when.source === "slo-burn" || rule.when.source === "rule-violation") return [];
  const span = scope.to - scope.from;
  const step = Math.max(60, Math.floor(span / 1000 / 120));
  const { sql, params } = compile(rule.when, step);
  return query<any>(sql, { params: { ...params, from: dt(scope.from), to: dt(scope.to), env: scope.env, step }, timeout: 10 });
}

/** Signs a webhook the way the Standard Webhooks spec says, so any of its verifier libraries accept it. */
export function webhookHeaders(secret: string, body: string, id = `msg_${crypto.randomUUID()}`, at = Math.floor(Date.now() / 1000)) {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
  const signature = new Bun.CryptoHasher("sha256", key).update(`${id}.${at}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": `v1,${signature}` };
}

async function sendEmail(to: string, notice: Notice) {
  if (!config.smtpUrl) throw new Error("E-mail needs VIGIE_SMTP_URL.");
  const { createTransport } = await import("nodemailer");
  await createTransport(config.smtpUrl).sendMail({ from: config.mailFrom, to, ...emailMessage(notice) });
}

/** An alert can name one channel. A name that no longer exists falls back to every channel: an alert must never go silent. */
export async function notifyChannels(notice: Notice, only?: string) {
  const all = db.query<any, []>("SELECT * FROM channels").all();
  const named = only ? all.filter((channel) => channel.name === only) : [];
  const codeNamed = only ? registry.channels.filter((channel) => channel.name === only) : [];
  const useAll = !named.length && !codeNamed.length;
  const channels = useAll ? all : named;
  if (config.slackWebhook && !channels.length && useAll) channels.push({ kind: "slack", target: config.slackWebhook, name: "Slack" });
  const results: { name: string; ok: boolean; error?: string }[] = [];
  for (const channel of channels) {
    try {
      if (channel.kind === "email") {
        await sendEmail(channel.target, notice);
        results.push({ name: channel.name, ok: true });
        continue;
      }
      const body = channel.kind === "slack" ? JSON.stringify(slackMessage(notice)) : channel.kind === "discord" ? JSON.stringify(discordMessage(notice)) : JSON.stringify({ ...notice, text: noticeText(notice), at: new Date().toISOString() });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (channel.secret) Object.assign(headers, webhookHeaders(channel.secret, body));
      const response = await fetch(channel.target, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
      results.push({ name: channel.name, ok: response.ok, error: response.ok ? undefined : `Answered ${response.status}` });
    } catch (error) {
      results.push({ name: channel.name, ok: false, error: String(error) });
    }
  }
  for (const channel of useAll ? registry.channels : codeNamed) {
    try {
      await channel.send({ title: notice.title, text: noticeText(notice), notice });
      results.push({ name: channel.name, ok: true });
    } catch (error) {
      results.push({ name: channel.name, ok: false, error: String(error) });
    }
  }
  return { sent: results.filter((r) => r.ok).length, results };
}

const ENV_NAME: Record<string, string> = { PRD: "Production", STG: "Test", DEV: "Local" };

/** The message says what the number means, not which query crossed which line. */
function summaryOf(rule: AlertRule, value: number) {
  const window = humanWindow(rule.window);
  const limit = rule.sigma ? "far above its usual level" : rule.below !== undefined ? `It should stay above ${fmt(rule, rule.below)}` : `Limit is ${fmt(rule, rule.above ?? 0)}`;
  const close = rule.sigma ? `That is ${limit}.` : `${limit}.`;
  switch (rule.when.source) {
    case "task-failure-rate":
      return `${fmt(rule, value)} of task attempts failed in the last ${window}. ${close}`;
    case "request-error-rate":
      return `${fmt(rule, value)} of requests answered with a server error in the last ${window}. ${close}`;
    case "route-p95":
      return `The slowest 5% of requests took ${fmt(rule, value)} or more in the last ${window}. ${close}`;
    case "oldest-due":
      return `The oldest task due to run has waited ${humanDuration(value * 1000)}. ${close}`;
    case "absence":
      return `${rule.when.taskKind} has not run in the last ${window}.`;
    case "new-error":
      return `${Math.round(value)} new kinds of error appeared in the last ${window}.`;
    default:
      return `Now ${fmt(rule, value)} over the last ${window}. ${close}`;
  }
}

type Cause = { count: string; code: string; where: string; traceId: string; taskId: string; fingerprint: string; attrs: Record<string, string> };

/** What is behind an alert: the errors or routes that make up the number. Nothing here may fail the alert itself. */
async function causesOf(rule: AlertRule, env: string): Promise<Cause[]> {
  const params = { from: dt(Date.now() - seconds(rule.window) * 1000), env };
  const scope = "Timestamp >= toDateTime64({from:String}, 3) AND Environment = {env:String}";
  const where = "if(TaskKind != '', TaskKind, concat(Method, ' ', Route))";
  try {
    if (rule.when.source === "route-p95") {
      const rows = await query<any>(`SELECT ${where} AS at, round(quantile(0.95)(DurationMs)) AS ms, any(TraceId) AS traceId FROM logs WHERE ${scope} AND Kind = 'request' GROUP BY at ORDER BY ms DESC LIMIT 3`, { params, timeout: 5 });
      return rows.map((row) => ({ count: `${row.ms} ms`, code: "p95", where: row.at, traceId: row.traceId, taskId: "", fingerprint: "", attrs: {} }));
    }
    if (!["task-failure-rate", "request-error-rate", "new-error", "log-count"].includes(rule.when.source)) return [];
    const kind = rule.when.source === "task-failure-rate" ? "AND Kind = 'task'" : rule.when.source === "request-error-rate" ? "AND Kind = 'request' AND Status >= 500" : "";
    const code = "if(LogAttributes['taskOutcome.code'] != '', LogAttributes['taskOutcome.code'], if(LogAttributes['error.name'] != '', LogAttributes['error.name'], if(Status >= 500, toString(Status), 'Error')))";
    const rows = await query<any>(`SELECT ${code} AS code, ${where} AS at, count() AS n, any(TraceId) AS traceId, any(TaskId) AS taskId, any(Fingerprint) AS fingerprint, any(LogAttributes) AS attrs FROM logs WHERE ${scope} ${kind} AND (Outcome = 'failed' OR SeverityText IN ('error', 'fatal')) GROUP BY code, at ORDER BY n DESC LIMIT 3`, { params, timeout: 5 });
    return rows.map((row) => ({ count: `${row.n}×`, code: row.code, where: row.at, traceId: row.traceId, taskId: row.taskId, fingerprint: row.fingerprint, attrs: row.attrs ?? {} }));
  } catch {
    return [];
  }
}

function headlineOf(attrs: Record<string, string>, fallback: string) {
  const code = attrs["taskOutcome.code"] ?? attrs.reason ?? attrs["error.code"] ?? "";
  const error = { name: attrs["error.name"] ?? attrs["error.type"] ?? "", message: attrs["error.message"] ?? "", code, attr: (key: string) => attrs[key] ?? "" };
  for (const renderer of registry.errorRenderers) {
    try {
      if (renderer.match(error) && renderer.headline) return { title: renderer.headline(error), recovered: renderer.recovered?.(error) ?? "" };
    } catch {}
  }
  return { title: fallback, recovered: "" };
}

type Held = { alert: any; rule: AlertRule; value: number; since: number; note?: string; at: number };
const heldFiring = new Map<string, Held>();
const heldRecovered = new Map<string, Held & { started: number; title: string; recoveredTitle: string }>();

async function firingNotice(group: Held[], env: string): Promise<{ notice: Notice; titles: Map<string, { title: string; recovered: string }> }> {
  const withCauses = await Promise.all(group.map(async (held) => ({ held, causes: await causesOf(held.rule, env) })));
  const lead = withCauses.find((entry) => entry.causes.length) ?? withCauses[0]!;
  const others = withCauses.filter((entry) => entry !== lead).map((entry) => entry.held.alert.name);
  const top = lead.causes[0];
  const { title, recovered } = headlineOf(top?.attrs ?? {}, `${lead.held.alert.name} is firing`);
  const explained = top ? explainError(top.attrs) : null;
  const url = `${config.publicUrl}/alerts/${lead.held.alert.id}`;
  const history = await alertHistory(lead.held.rule, { from: Date.now() - 2 * 3_600_000, to: Date.now(), env, bucket: 600 } as Scope).catch(() => []);
  const titles = new Map(group.map((held) => [held.alert.id as string, held === lead.held ? { title, recovered } : { title: `${held.alert.name} is firing`, recovered: "" }]));
  return {
    titles,
    notice: {
      tone: "firing",
      title,
      summary: [lead.held.alert.name !== title && !title.includes(lead.held.alert.name) ? `${lead.held.alert.name}: ` : "", summaryOf(lead.held.rule, lead.held.value), lead.held.note ?? ""].join("").trim(),
      fields: [
        { label: "Since", at: lead.held.since },
        { label: "Environment", value: ENV_NAME[env] ?? env },
        ...(others.length ? [{ label: "Also firing", value: others.join(", ") }] : []),
      ],
      causes: lead.causes.map(({ count, code, where }) => ({ count, code, where })),
      advice: explained?.fix || undefined,
      trend: history.length ? { values: history.map((p: any) => Number(p.v)), label: "last 2 hours" } : undefined,
      links: [
        { label: "Open alert", url },
        ...(top?.taskId ? [{ label: "Latest failure", url: `${config.publicUrl}/tasks/run/${top.taskId}` }] : top?.traceId ? [{ label: "Latest failure", url: `${config.publicUrl}/traces/${top.traceId}` }] : []),
        ...(top?.fingerprint ? [{ label: "Issue", url: `${config.publicUrl}/issues/${top.fingerprint}` }] : []),
      ],
    },
  };
}

function recoveredNotice(group: (Held & { started: number; title: string; recoveredTitle: string })[]): Notice {
  const lead = group[0]!;
  const others = group.slice(1).map((held) => held.alert.name);
  const title = lead.recoveredTitle || `${lead.alert.name} recovered`;
  const limit = lead.rule.sigma ? "" : lead.rule.below !== undefined ? `, should stay above ${fmt(lead.rule, lead.rule.below)}` : `, limit ${fmt(lead.rule, lead.rule.above ?? 0)}`;
  return { tone: "resolved", title, summary: `after ${humanDuration(Date.now() - lead.started)}. Now ${fmt(lead.rule, lead.value)}${limit}.${others.length ? ` Also back to normal: ${others.join(", ")}.` : ""}` };
}

/** Alerts that cross their line together are one incident, so they go out as one post. Held briefly so the rest can join. */
async function flushNotices(env: string, now: number) {
  const ready = <T extends Held>(held: Map<string, T>) => {
    const entries = [...held.values()];
    if (!entries.length || now - Math.min(...entries.map((h) => h.at)) < config.alertGroupMs) return [];
    held.clear();
    const byTarget = new Map<string, T[]>();
    for (const entry of entries) byTarget.set(entry.rule.notify ?? "", [...(byTarget.get(entry.rule.notify ?? "") ?? []), entry]);
    return [...byTarget.entries()];
  };
  for (const [target, group] of ready(heldFiring)) {
    const { notice, titles } = await firingNotice(group, env);
    await notifyChannels(notice, target || undefined);
    for (const [id, title] of titles) db.query("UPDATE incidents SET headline = ?, recovered = ?, notified = 1 WHERE alert_id = ? AND ended IS NULL").run(title.title, title.recovered, id);
  }
  for (const [target, group] of ready(heldRecovered)) await notifyChannels(recoveredNotice(group), target || undefined);
}

export function syncCodeAlerts() {
  const ids = new Set(registry.alerts.map((a) => a.id));
  for (const alert of registry.alerts) {
    const { id, name, family, when, above, below, sigma, quiet, window, notify, unit, condition, for: forWindow } = alert;
    const rule = JSON.stringify({ when, above, below, sigma, quiet, window, notify, unit, condition, for: forWindow });
    db.query("INSERT INTO alerts (id, name, family, rule, managed_in) VALUES (?, ?, ?, ?, 'code') ON CONFLICT(id) DO UPDATE SET name = excluded.name, family = excluded.family, rule = excluded.rule, managed_in = 'code'").run(id, name, family, rule);
  }
  for (const row of db.query<any, []>("SELECT id FROM alerts WHERE managed_in = 'code'").all()) {
    if (!ids.has(row.id)) db.query("DELETE FROM alerts WHERE id = ?").run(row.id);
  }
}

export function pushInbox(category: string, title: string, detail: string, href: string, dedupe?: string) {
  db.query("INSERT OR IGNORE INTO inbox (at, category, title, detail, href, dedupe) VALUES (?, ?, ?, ?, ?, ?)").run(Date.now(), category, title, detail, href, dedupe ?? null);
}

const fmt = (rule: AlertRule, value: number) => `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}${rule.unit ? ` ${rule.unit}` : ""}`;

/** Evaluates every alert. One failed query marks that alert as failing to evaluate: it never hides as healthy. */
export async function evaluateAlerts() {
  syncCodeAlerts();
  const env = process.env.VIGIE_ALERT_ENV ?? config.mainEnvironment;
  const now = Date.now();
  for (const alert of db.query<any, []>("SELECT * FROM alerts WHERE paused = 0").all()) {
    const rule: AlertRule = JSON.parse(alert.rule);
    try {
      const value = await evaluateRule(rule, env);
      const baseline = rule.sigma ? await anomalyBaseline(rule, env, now) : null;
      if (rule.sigma && !baseline) {
        db.query("UPDATE alerts SET value = ?, last_checked = ?, error = ? WHERE id = ?").run(value, now, "Not enough history yet. This alert compares against the last 7 days and needs at least 24 windows.", alert.id);
        continue;
      }
      const breached = rule.sigma ? value > baseline!.line : rule.below !== undefined ? value < rule.below : value > (rule.above ?? Infinity);
      const quiet = inQuietHours(rule.quiet, now);
      const pendingSince = breached ? (alert.since ?? now) : null;
      const holdFor = seconds(rule.for ?? "0s") * 1000;
      const firing = breached && now - (pendingSince ?? now) >= holdFor;
      if (firing && alert.state !== "firing") {
        db.query("INSERT INTO incidents (alert_id, started, peak) VALUES (?, ?, ?)").run(alert.id, now, value);
        db.query("UPDATE alerts SET last_fired = ? WHERE id = ?").run(now, alert.id);
        pushInbox("alert", `${alert.name} is firing`, rule.condition ?? `Now ${fmt(rule, value)}.`, `/alerts/${alert.id}`);
        if (quiet) db.query("UPDATE alerts SET quiet_pending = 1 WHERE id = ?").run(alert.id);
        else heldFiring.set(alert.id, { alert, rule, value, since: pendingSince ?? now, at: now });
      } else if (firing) {
        db.query("UPDATE incidents SET peak = max(coalesce(peak, 0), ?) WHERE alert_id = ? AND ended IS NULL").run(value, alert.id);
        // A restart while a post was held must not lose the alert: still firing and nobody told, so hold it again.
        const told = db.query<{ notified: number }, [string]>("SELECT notified FROM incidents WHERE alert_id = ? AND ended IS NULL").get(alert.id);
        if (told && !told.notified && !alert.quiet_pending && !quiet && !heldFiring.has(alert.id)) heldFiring.set(alert.id, { alert, rule, value, since: pendingSince ?? now, at: now });
        // Quiet hours are over and it is still firing: this is the notification they held back.
        if (alert.quiet_pending && !quiet) {
          db.query("UPDATE alerts SET quiet_pending = 0 WHERE id = ?").run(alert.id);
          heldFiring.set(alert.id, { alert, rule, value, since: pendingSince ?? now, at: now, note: " It started during quiet hours." });
        }
      } else if (!breached && alert.state === "firing") {
        const open = db.query<{ started: number; headline: string | null; recovered: string | null }, [string]>("SELECT started, headline, recovered FROM incidents WHERE alert_id = ? AND ended IS NULL").get(alert.id);
        db.query("UPDATE incidents SET ended = ? WHERE alert_id = ? AND ended IS NULL").run(now, alert.id);
        pushInbox("alert", `${alert.name} recovered`, `Back to ${fmt(rule, value)}.`, `/alerts/${alert.id}`);
        // Nobody was told it fired, so there is nothing to take back. It stays in the incidents and the inbox.
        // Fired and recovered inside the holding window: nobody was told, and now nobody needs to be.
        const neverSent = heldFiring.delete(alert.id);
        if (!alert.quiet_pending && !quiet && !neverSent) heldRecovered.set(alert.id, { alert, rule, value, since: pendingSince ?? now, at: now, started: open?.started ?? now, title: open?.headline ?? "", recoveredTitle: open?.recovered ?? "" });
        db.query("UPDATE alerts SET quiet_pending = 0 WHERE id = ?").run(alert.id);
      }
      db.query("UPDATE alerts SET state = ?, value = ?, since = ?, last_checked = ?, error = NULL WHERE id = ?").run(firing ? "firing" : "ok", value, pendingSince, now, alert.id);
    } catch (error) {
      db.query("UPDATE alerts SET error = ?, last_checked = ? WHERE id = ?").run(String(error).slice(0, 300), now, alert.id);
    }
  }
  await flushNotices(env, now);
}

/** An issue someone marked fixed is firing again. Worth one post, and only from the environment that matters. */
export async function notifyCameBack(issue: { fp: string; name: string; message: string; version: string; resolvedAt: number | null; environment: string }) {
  if (issue.environment !== (process.env.VIGIE_ALERT_ENV ?? config.mainEnvironment)) return;
  pushInbox("issue", `${issue.name} came back`, issue.message, `/issues/${issue.fp}`, `back:${issue.fp}:${issue.version}`);
  await notifyChannels({ tone: "warning", title: `This came back: ${issue.name}`, summary: `Back in version ${issue.version || "unknown"}. ${issue.message}`.slice(0, 500), fields: issue.resolvedAt ? [{ label: "Resolved", at: issue.resolvedAt }] : [], links: [{ label: "Open issue", url: `${config.publicUrl}/issues/${issue.fp}` }] }).catch(() => undefined);
}
