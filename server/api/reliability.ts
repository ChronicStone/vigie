import { query } from "../lib/clickhouse.ts";
import { accountName, loadPeople } from "../lib/appdb.ts";
import { alertHistory, evaluateRule, notifyChannels, syncCodeAlerts, anomalyBaseline, sigmaLine } from "../alerts.ts";
import { registry } from "../extensions/index.ts";
import { audit, db } from "../state/db.ts";
import type { AlertRule, RuleDefinition } from "../../sdk/index.ts";
import { config } from "../config.ts";
import { muteRuleFor } from "../state/issues.ts";
import { sourceAround } from "../lib/source.ts";
import { bucketOf, dt, fillTime, HttpError, route, scopeOf, scopeParams, type Actor, type ScopeInput } from "./http.ts";

export type IssueDb = { resolved_at: number | null; linear_url: string | null; muted_by: string | null; fingerprint: string; name: string; message: string; service: string; environment: string; entry: string; status: "open" | "resolved" | "archived"; priority: "high" | "medium" | "low"; assignee: string | null; regressed: number; regressed_in: string | null; first_seen: number; last_seen: number; events: number; archived_until: number | null; why: string | null; fix: string | null; link: string | null; stack: string | null };

export async function issues(input: ScopeInput & { filter?: string; q?: string }) {
  const scope = scopeOf(input, 40);
  const everything = db.query<IssueDb, [string]>("SELECT * FROM issues WHERE environment = ? ORDER BY last_seen DESC LIMIT 500").all(scope.env);
  const muted = everything.filter((i) => i.muted_by);
  const all = everything.filter((i) => !i.muted_by);
  const open = all.filter((i) => i.status === "open");
  const isNew = (i: IssueDb) => i.first_seen >= scope.to - 86_400_000 && !i.regressed;
  const counts = { muted: muted.length, open: open.length, new: open.filter(isNew).length, regressed: open.filter((i) => i.regressed).length, high: open.filter((i) => i.priority === "high").length, resolved: all.filter((i) => i.status === "resolved").length, archived: all.filter((i) => i.status === "archived").length, unassigned: open.filter((i) => !i.assignee).length };
  const FILTERS: Record<string, IssueDb[]> = { muted, open, new: open.filter(isNew), regressed: open.filter((i) => i.regressed), high: open.filter((i) => i.priority === "high"), unassigned: open.filter((i) => !i.assignee), resolved: all.filter((i) => i.status === "resolved"), archived: all.filter((i) => i.status === "archived") };
  let rows = FILTERS[input.filter ?? "open"] ?? open;
  if (input.q) rows = rows.filter((i) => `${i.name} ${i.message} ${i.entry}`.toLowerCase().includes(input.q!.toLowerCase()));
  rows = rows.slice(0, 200);
  const fps = rows.map((i) => i.fingerprint);
  const [trend, reach] = fps.length ? await Promise.all([
    query<{ fp: string; t: number; n: number }>(`SELECT Fingerprint AS fp, ${bucketOf("Timestamp")} AS t, count() AS n FROM logs WHERE Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Fingerprint IN {fps:Array(String)} GROUP BY fp, t ORDER BY t`, { params: { ...scopeParams(scope), fps } }),
    query<{ fp: string; people: number }>(`SELECT Fingerprint AS fp, uniqExactIf(UserId, UserId != '') AS people FROM logs WHERE Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Fingerprint IN {fps:Array(String)} GROUP BY fp`, { params: { ...scopeParams(scope), fps } }),
  ]) : [[], []];
  const peopleOf = new Map(reach.map((row) => [row.fp, Number(row.people)]));
  const span = scope.bucket * 1000;
  const start = Math.floor(scope.from / span) * span;
  const size = Math.ceil((scope.to - start) / span);
  const map = new Map<string, { strip: number[]; events: number }>();
  for (const point of trend) {
    if (!map.has(point.fp)) map.set(point.fp, { strip: new Array(size).fill(0), events: 0 });
    const entry = map.get(point.fp)!;
    const index = Math.floor((point.t - start) / span);
    if (index >= 0 && index < size) entry.strip[index] = point.n;
    entry.events += point.n;
  }
  return { counts, rows: rows.map((i) => ({ ...i, trend: map.get(i.fingerprint)?.strip ?? new Array<number>(size).fill(0), inRange: map.get(i.fingerprint)?.events ?? 0, people: peopleOf.get(i.fingerprint) ?? 0 })) };
}

export async function issueDetail(input: ScopeInput & { fp: string }) {
  const scope = scopeOf(input, 60);
  const issue = db.query<IssueDb, [string]>("SELECT * FROM issues WHERE fingerprint = ?").get(input.fp);
  if (!issue) throw new HttpError(404, "This issue does not exist.");
  const params = { ...scopeParams(scope), fp: input.fp };
  await loadPeople();
  const [series, accounts, latest, reach] = await Promise.all([
    query<{ t: number; ok: number; error: number }>(`SELECT ${bucketOf("Timestamp")} AS t, 0 AS ok, count() AS error FROM logs WHERE Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Fingerprint = {fp:String} GROUP BY t ${fillTime}`, { params }),
    query<{ id: string; n: number }>(`SELECT AccountId AS id, count() AS n FROM logs WHERE Timestamp >= toDateTime64({from:String}, 3) AND Fingerprint = {fp:String} AND id != '' GROUP BY id ORDER BY n DESC LIMIT 12`, { params }),
    query<{ id: string; traceId: string; taskId: string; kind: string; t: number; stack: string }>(`SELECT EventId AS id, TraceId AS traceId, TaskId AS taskId, Kind AS kind, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, LogAttributes['error.stack'] AS stack FROM logs WHERE Fingerprint = {fp:String} ORDER BY Timestamp DESC LIMIT 1`, { params }),
    query<{ people: number; n: number }>(`SELECT uniqExactIf(UserId, UserId != '') AS people, count() AS n FROM logs WHERE Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Fingerprint = {fp:String}`, { params }),
  ]);
  const activity = db.query<{ id: number; at: number; actor: string; action: string; note: string | null }, [string]>("SELECT id, at, actor, action, note FROM issue_activity WHERE fingerprint = ? ORDER BY at DESC LIMIT 50").all(input.fp);
  const versions = await query<{ version: string }>("SELECT argMax(ServiceVersion, Timestamp) AS version FROM logs WHERE Fingerprint = {fp:String} AND Timestamp >= now() - INTERVAL 30 DAY", { params: { fp: input.fp } }).catch(() => []);
  const source = await sourceAround(issue.stack || latest[0]?.stack, versions[0]?.version).catch(() => null);
  const verification = issue.resolved_at ? await fixCheck(issue, input.fp) : null;
  const muteRule = issue.muted_by ? db.query<{ id: string; pattern: string; reason: string }, [string]>("SELECT id, pattern, reason FROM mute_rules WHERE id = ?").get(issue.muted_by) : null;
  return { ...issue, series, people: Number(reach[0]?.people ?? 0), inRange: Number(reach[0]?.n ?? 0), accounts: accounts.map((a) => ({ ...a, name: accountName(a.id) || a.id })), latest: latest[0] ?? null, activity, source, verification, muteRule, linearReady: Boolean(config.linear.apiKey && config.linear.teamId) };
}

/** Did it stay away? Only a version shipped after the fix can say so: quiet with no release proves nothing. */
export async function fixCheck(issue: { service: string; environment: string; resolved_at?: number | null }, fp: string) {
  const since = issue.resolved_at ?? 0;
  const params = { since: dt(since), fp, service: issue.service, env: issue.environment };
  const [events, versions] = await Promise.all([
    query<{ n: number; version: string }>("SELECT count() AS n, argMin(ServiceVersion, Timestamp) AS version FROM logs WHERE Timestamp >= toDateTime64({since:String}, 3) AND Fingerprint = {fp:String}", { params }),
    query<{ version: string; first: number; last: number }>("SELECT ServiceVersion AS version, toUnixTimestamp(min(Timestamp)) * 1000 AS first, toUnixTimestamp(max(Timestamp)) * 1000 AS last FROM logs WHERE ServiceName = {service:String} AND Environment = {env:String} AND Timestamp >= toDateTime64({since:String}, 3) GROUP BY version ORDER BY first", { params }),
  ]);
  const before = await query<{ version: string }>("SELECT argMax(ServiceVersion, Timestamp) AS version FROM logs WHERE ServiceName = {service:String} AND Environment = {env:String} AND Timestamp < toDateTime64({since:String}, 3) AND Timestamp >= toDateTime64({since:String}, 3) - INTERVAL 7 DAY", { params });
  const shipped = versions.filter((v) => v.version && v.version !== before[0]?.version);
  const after = Number(events[0]?.n ?? 0);
  const state: "came-back" | "fixed" | "waiting" = after > 0 ? "came-back" : shipped.length ? "fixed" : "waiting";
  return { state, since, events: after, cameBackIn: after > 0 ? (events[0]?.version ?? "") : "", shipped: shipped.map((v) => v.version) };
}

export function muteLike(input: { fp: string; reason: string; pattern?: string; everywhere?: boolean }, actor: Actor) {
  const issue = db.query<IssueDb, [string]>("SELECT * FROM issues WHERE fingerprint = ?").get(input.fp);
  if (!issue) throw new HttpError(404, "This issue does not exist.");
  if (!input.reason.trim()) throw new HttpError(400, "Say why this is muted.");
  const id = crypto.randomUUID();
  const pattern = input.pattern?.trim() || issue.name;
  db.query("INSERT INTO mute_rules (id, pattern, service, environment, reason, created_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, pattern, input.everywhere ? null : issue.service, input.everywhere ? null : issue.environment, input.reason, actor.name, Date.now());
  const rules = [{ id, pattern, service: input.everywhere ? null : issue.service, environment: input.everywhere ? null : issue.environment }];
  for (const row of db.query<IssueDb, []>("SELECT * FROM issues WHERE muted_by IS NULL").all()) {
    if (muteRuleFor(row.name, row.message, row.service, row.environment, rules)) db.query("UPDATE issues SET muted_by = ? WHERE fingerprint = ?").run(id, row.fingerprint);
  }
  audit(actor.name, actor.through, "Muted issues", `${pattern}: ${input.reason}`);
  return { id };
}

export function unmute(input: { id: string }, actor: Actor) {
  db.query("UPDATE issues SET muted_by = NULL WHERE muted_by = ?").run(input.id);
  db.query("DELETE FROM mute_rules WHERE id = ?").run(input.id);
  audit(actor.name, actor.through, "Removed a mute rule", input.id);
  return { ok: true };
}

/** Files the issue in Linear once. The key stays on the server and is never returned. */
export async function createLinearIssue(input: { fp: string }, actor: Actor) {
  const issue = db.query<IssueDb, [string]>("SELECT * FROM issues WHERE fingerprint = ?").get(input.fp);
  if (!issue) throw new HttpError(404, "This issue does not exist.");
  if (issue.linear_url) return { url: issue.linear_url };
  if (!config.linear.apiKey || !config.linear.teamId) throw new HttpError(400, "Linear is not set up. Set VIGIE_LINEAR_API_KEY and VIGIE_LINEAR_TEAM_ID.");
  const description = [issue.message, issue.why ? `Why: ${issue.why}` : "", issue.fix ? `Fix: ${issue.fix}` : "", `${config.publicUrl}/issues/${issue.fingerprint}`].filter(Boolean).join("\n\n");
  const response = await fetch(config.linear.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: config.linear.apiKey },
    body: JSON.stringify({ query: "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { url } } }", variables: { input: { teamId: config.linear.teamId, title: issue.name, description } } }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as { data?: { issueCreate?: { issue?: { url?: string } } } };
  const url = body.data?.issueCreate?.issue?.url;
  if (!url) throw new HttpError(502, `Linear refused the issue (${response.status}).`);
  db.query("UPDATE issues SET linear_url = ? WHERE fingerprint = ?").run(url, input.fp);
  db.query("INSERT INTO issue_activity (fingerprint, at, actor, action, note) VALUES (?, ?, ?, ?, ?)").run(input.fp, Date.now(), actor.name, "Created a Linear issue", url);
  audit(actor.name, actor.through, "Created a Linear issue", issue.name);
  return { url };
}

export function updateAlert(input: { id: string; name?: string; family?: string; rule?: AlertRule }, actor: Actor) {
  const alert = db.query<{ managed_in: string; name: string; family: string; rule: string }, [string]>("SELECT managed_in, name, family, rule FROM alerts WHERE id = ?").get(input.id);
  if (!alert) throw new HttpError(404, "This alert does not exist.");
  if (alert.managed_in === "code") throw new HttpError(400, "This alert lives in code. Edit its file.");
  db.query("UPDATE alerts SET name = ?, family = ?, rule = ? WHERE id = ?").run(input.name ?? alert.name, input.family ?? alert.family, input.rule ? JSON.stringify(input.rule) : alert.rule, input.id);
  audit(actor.name, actor.through, "Updated alert", input.name ?? alert.name);
  return { ok: true };
}

export function createProductionRule(input: Omit<RuleDefinition, "id">, actor: Actor) {
  if (!input.name?.trim()) throw new HttpError(400, "A rule needs a name.");
  if (input.atMost === undefined && input.exactly === undefined) throw new HttpError(400, "Give a bound: atMost or exactly.");
  const id = crypto.randomUUID();
  db.query("INSERT INTO production_rules (id, name, definition, created_by, at) VALUES (?, ?, ?, ?, ?)").run(id, input.name, JSON.stringify(input), actor.name, Date.now());
  audit(actor.name, actor.through, "Created a production rule", input.name);
  return { id };
}

const appRules = () => db.query<{ id: string; definition: string }, []>("SELECT id, definition FROM production_rules").all().map((row) => ({ ...(JSON.parse(row.definition) as RuleDefinition), id: row.id }));

export function updateIssue(input: { fp: string; status?: "open" | "resolved" | "archived"; days?: number; priority?: "high" | "medium" | "low"; assignee?: string | null; comment?: string }, actor: Actor) {
  const issue = db.query<IssueDb, [string]>("SELECT * FROM issues WHERE fingerprint = ?").get(input.fp);
  if (!issue) throw new HttpError(404, "This issue does not exist.");
  const note = (action: string, text?: string) => {
    db.query("INSERT INTO issue_activity (fingerprint, at, actor, action, note) VALUES (?, ?, ?, ?, ?)").run(input.fp, Date.now(), actor.name, action, text ?? null);
    audit(actor.name, actor.through, `${action} issue ${issue.name}`, input.fp);
  };
  if (input.status === "resolved") {
    db.query("UPDATE issues SET status = 'resolved', regressed = 0, resolved_at = ? WHERE fingerprint = ?").run(Date.now(), input.fp);
    note("Resolved");
  } else if (input.status === "archived") {
    db.query("UPDATE issues SET status = 'archived', archived_until = ? WHERE fingerprint = ?").run(Date.now() + (input.days ?? 1) * 86_400_000, input.fp);
    note(`Archived for ${input.days ?? 1} day`);
  } else if (input.status === "open") {
    db.query("UPDATE issues SET status = 'open', archived_until = NULL WHERE fingerprint = ?").run(input.fp);
    note("Reopened");
  }
  if (input.priority) {
    db.query("UPDATE issues SET priority = ? WHERE fingerprint = ?").run(input.priority, input.fp);
    note(`Priority set to ${input.priority}`);
  }
  if (input.assignee !== undefined) {
    db.query("UPDATE issues SET assignee = ? WHERE fingerprint = ?").run(input.assignee || null, input.fp);
    note(input.assignee ? `Assigned to ${input.assignee}` : "Unassigned");
  }
  if (input.comment) note("Commented", input.comment.slice(0, 2000));
  return { ok: true };
}

type AlertDb = { id: string; name: string; family: string; rule: string; managed_in: "code" | "app"; paused: number; state: "ok" | "firing"; value: number | null; since: number | null; last_fired: number | null; last_checked: number | null; error: string | null };

export function alerts() {
  syncCodeAlerts();
  const firedIn30d = new Map(db.query<{ id: string; n: number }, [number]>("SELECT alert_id AS id, count(*) AS n FROM incidents WHERE started >= ? GROUP BY alert_id").all(Date.now() - 30 * 86_400_000).map((row) => [row.id, row.n]));
  return db.query<AlertDb, []>("SELECT * FROM alerts ORDER BY CASE state WHEN 'firing' THEN 0 ELSE 1 END, name").all().map((a) => ({ ...a, rule: JSON.parse(a.rule) as AlertRule, fired30d: firedIn30d.get(a.id) ?? 0 }));
}

export async function alertDetail(input: ScopeInput & { id: string }) {
  syncCodeAlerts();
  const alert = db.query<AlertDb, [string]>("SELECT * FROM alerts WHERE id = ?").get(input.id);
  if (!alert) throw new HttpError(404, "This alert does not exist.");
  const rule = JSON.parse(alert.rule) as AlertRule;
  const scope = { ...scopeOf(input), from: Date.now() - 30 * 86_400_000, to: Date.now() };
  const baseline = rule.sigma ? await anomalyBaseline(rule, scope.env).catch(() => null) : null;
  return { ...alert, rule, threshold: baseline?.line ?? rule.above ?? rule.below ?? null, history: await alertHistory(rule, scope).catch(() => []), incidents: db.query<{ id: number; alert_id: string; started: number; ended: number | null; peak: number | null; note: string | null }, [string]>("SELECT * FROM incidents WHERE alert_id = ? ORDER BY started DESC LIMIT 50").all(input.id), file: registry.alerts.find((a) => a.id === input.id)?.file ?? "" };
}

export async function alertPreview(input: ScopeInput & { rule: AlertRule }) {
  const scope = { ...scopeOf(input), from: Date.now() - 7 * 86_400_000, to: Date.now() };
  const history = await alertHistory(input.rule, scope);
  const baseline = input.rule.sigma ? sigmaLine(history.map((p: { v: number }) => Number(p.v)), input.rule.sigma) : null;
  const limit = input.rule.sigma ? (baseline?.line ?? Infinity) : (input.rule.above ?? Infinity);
  let fired = 0;
  let above = false;
  for (const point of history) {
    const over = input.rule.below !== undefined ? point.v < input.rule.below : point.v > limit;
    if (over && !above) fired++;
    above = over;
  }
  return { history, fired, enoughHistory: !input.rule.sigma || baseline !== null, threshold: input.rule.sigma ? (baseline?.line ?? null) : (input.rule.above ?? input.rule.below ?? null), value: await evaluateRule(input.rule, scope.env).catch(() => null) };
}

export function createAlert(input: { name: string; family: string; rule: AlertRule }, actor: Actor) {
  if (!input.name.trim()) throw new HttpError(400, "An alert needs a name.");
  const id = crypto.randomUUID();
  db.query("INSERT INTO alerts (id, name, family, rule, managed_in) VALUES (?, ?, ?, ?, 'app')").run(id, input.name, input.family, JSON.stringify(input.rule));
  audit(actor.name, actor.through, "Created alert", input.name);
  return { id };
}

export function pauseAlert(input: { id: string; paused: boolean }, actor: Actor) {
  db.query("UPDATE alerts SET paused = ? WHERE id = ?").run(input.paused ? 1 : 0, input.id);
  audit(actor.name, actor.through, input.paused ? "Paused alert" : "Resumed alert", input.id);
  return { ok: true };
}

export async function testAlert(id: string) {
  const alert = db.query<AlertDb, [string]>("SELECT * FROM alerts WHERE id = ?").get(id);
  if (!alert) throw new HttpError(404, "This alert does not exist.");
  return notifyChannels({ tone: "info", title: `Test: ${alert.name}`, summary: "This is a test. Nothing is wrong.", links: [{ label: "Open alert", url: `${config.publicUrl}/alerts/${alert.id}` }] });
}

export function deleteAlert(id: string, actor: Actor) {
  const alert = db.query<AlertDb, [string]>("SELECT * FROM alerts WHERE id = ?").get(id);
  if (alert?.managed_in === "code") throw new HttpError(409, `This alert is defined in code. Edit ${registry.alerts.find((a) => a.id === id)?.file ?? "its file"}.`);
  db.query("DELETE FROM incidents WHERE alert_id = ?").run(id);
  db.query("DELETE FROM alerts WHERE id = ?").run(id);
  audit(actor.name, actor.through, "Deleted alert", alert?.name);
  return { ok: true };
}

const SLO_WINDOW = 30 * 86_400_000;

async function sloValue(good: string, total: string, from: number, to: number, env: string) {
  const expand = (sql: string) => sql.replaceAll("$__from", "{from:String}").replaceAll("$__to", "{to:String}").replaceAll("$__env", "{env:String}");
  const iso = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");
  const params = { from: iso(from), to: iso(to), env };
  const [[g], [t]] = await Promise.all([query<{ v: number }>(expand(good), { params }), query<{ v: number }>(expand(total), { params })]);
  return { good: Number(g?.v ?? 0), total: Number(t?.v ?? 0) };
}

const sloCache = new Map<string, { at: number; value: ReturnType<typeof computeSlos> }>();

/** Objectives cover 30 days and move slowly: one minute of cache spares about 120 queries per open. */
export function slos(input: { env: string }) {
  const cached = sloCache.get(input.env);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const value = computeSlos(input);
  sloCache.set(input.env, { at: Date.now(), value });
  value.catch(() => sloCache.delete(input.env));
  return value;
}

function computeSlos(input: { env: string }) {
  const now = Date.now();
  return Promise.all(
    (registry.catalog.slos ?? []).map(async (slo) => {
      const [month, hour, ...days] = await Promise.all([
        sloValue(slo.good, slo.total, now - SLO_WINDOW, now, input.env),
        sloValue(slo.good, slo.total, now - 3_600_000, now, input.env),
        ...Array.from({ length: 14 }, (_, day) => {
          const from = now - (14 - day) * 86_400_000;
          return sloValue(slo.good, slo.total, from, from + 86_400_000, input.env);
        }),
      ]);
      const budget = 100 - slo.objective;
      const failedShare = month.total ? (1 - month.good / month.total) * 100 : 0;
      const hourShare = hour.total ? (1 - hour.good / hour.total) * 100 : 0;
      const left = budget > 0 ? 100 - (failedShare / budget) * 100 : 0;
      const burn = budget > 0 ? hourShare / budget : 0;
      const state: "burning" | "watch" | "healthy" = left <= 0 || burn >= 2 ? "burning" : left < 50 || burn >= 1 ? "watch" : "healthy";
      const daysLeft = burn > 0 && left > 0 ? (left / 100) * 30 / burn : null;
      return { id: slo.id, name: slo.name, objective: slo.objective, left, burn, daysLeft, attained: month.total ? (month.good / month.total) * 100 : 100, total: month.total, daily: days.map((d) => (d.total ? (d.good / d.total) * 100 : 100)), state };
    }),
  );
}

export async function rules(input: ScopeInput) {
  const scope = scopeOf(input);
  const params = scopeParams(scope);
  return Promise.all(
    [...(registry.catalog.rules ?? []), ...appRules()].map(async (rule) => {
      const local: Record<string, string | number | string[] | undefined> = { ...params };
      const entry: string[] = ["Timestamp >= toDateTime64({from:String}, 3)", "Timestamp <= toDateTime64({to:String}, 3)", "Environment = {env:String}"];
      if (rule.entry.taskKind) {
        local.kind = rule.entry.taskKind;
        entry.push("Kind = 'task'", "TaskKind = {kind:String}");
      } else {
        entry.push("Kind = 'request'");
        if (rule.entry.route) {
          local.route = rule.entry.route;
          entry.push("Route = {route:String}");
        }
        if (rule.entry.method) {
          local.method = rule.entry.method;
          entry.push("Method = {method:String}");
        }
      }
      const spanFilter = rule.statement ? "positionCaseInsensitive(DbStatement, {statement:String}) > 0" : rule.host ? "PeerHost = {host:String}" : rule.aiCalls ? "SpanAttributes['ai.model'] != ''" : "DbStatement != ''";
      if (rule.statement) local.statement = rule.statement;
      if (rule.host) local.host = rule.host;
      const limit = rule.exactly !== undefined ? `n != ${Number(rule.exactly)}` : `n > ${Number(rule.atMost ?? 0)}`;
      const [[checked], [violated]] = await Promise.all([
        query<{ n: number }>(`SELECT count() AS n FROM logs WHERE ${entry.join(" AND ")}`, { params: local }),
        query<{ v: number; last: number; traceId: string }>(`SELECT count() AS v, max(last) AS last, any(TraceId) AS traceId FROM (SELECT TraceId, count() AS n, toUnixTimestamp(max(Timestamp)) * 1000 AS last FROM spans WHERE Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND ${spanFilter} AND TraceId IN (SELECT TraceId FROM logs WHERE ${entry.join(" AND ")}) GROUP BY TraceId HAVING ${limit})`, { params: local }),
      ]);
      const state: "unchecked" | "violated" | "holding" = !checked?.n ? "unchecked" : violated?.v ? "violated" : "holding";
      return { id: rule.id, name: rule.name, entry: rule.entry, checked: checked?.n ?? 0, violated: violated?.v ?? 0, last: violated?.last ?? 0, traceId: violated?.traceId ?? "", state };
    }),
  );
}

export async function releases(input: { env: string }) {
  const { env } = input;
  const params = { env };
  const [versions, running] = await Promise.all([
    query<{ version: string; first: number; last: number }>(`SELECT ServiceVersion AS version, toUnixTimestamp(min(Timestamp)) * 1000 AS first, toUnixTimestamp(max(Timestamp)) * 1000 AS last FROM logs WHERE Environment = {env:String} AND version != '' GROUP BY version ORDER BY first DESC LIMIT 20`, { params }),
    query<{ service: string; version: string; instances: number }>(`SELECT ServiceName AS service, argMax(ServiceVersion, Timestamp) AS version, uniqExact(InstanceId) AS instances FROM logs WHERE Environment = {env:String} AND Timestamp >= now() - INTERVAL 15 MINUTE GROUP BY service ORDER BY service`, { params }),
  ]);
  const declared = new Map(db.query<{ version: string; declared_by: string }, [string]>("SELECT version, declared_by FROM deployments WHERE environment = ?").all(env).map((d) => [d.version, d.declared_by]));
  const measure = async (from: number, to: number) => {
    const [row] = await query<{ n: number; e: number; p95: number }>(`SELECT sum(Requests) AS n, sumIf(Requests, StatusClass >= 500) AS e, quantilesTDigestMerge(0.5, 0.95, 0.99)(Quantiles)[2] AS p95 FROM req_1m WHERE Minute >= toDateTime({from:UInt32}) AND Minute < toDateTime({to:UInt32}) AND Environment = {env:String}`, { params: { env, from: Math.floor(from / 1000), to: Math.floor(to / 1000) } });
    return { errors: row?.n ? (row.e / row.n) * 100 : 0, p95: row?.p95 ?? 0, requests: row?.n ?? 0 };
  };
  const rows = await Promise.all(
    versions.map(async (v) => {
      const hour = 3_600_000;
      const [before, after] = await Promise.all([measure(v.first - hour, v.first), measure(v.first, v.first + hour)]);
      const regression = before.requests >= 20 && (after.errors > before.errors * 1.5 + 0.5 || after.p95 > before.p95 * 1.4);
      const changed = before.requests > 0 && (after.errors > before.errors * 1.1 || after.p95 > before.p95 * 1.15);
      const regressedIssues = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM issues WHERE regressed_in = ?").get(v.version)?.n ?? 0;
      const verdict: "unknown" | "regression" | "changed" | "clean" = before.requests < 20 ? "unknown" : regression ? "regression" : changed || regressedIssues ? "changed" : "clean";
      return { ...v, before, after, verdict, declaredBy: declared.get(v.version) ?? "Detected", regressedIssues };
    }),
  );
  return { running, rows };
}

/** CI declares a release with a deploy token. */
route("POST", "/api/deployments", "viewer", async ({ request, actor }) => {
  const input = (await request.json()) as { service?: string; version?: string; environment?: string };
  if (!input.version || !input.service) throw new HttpError(400, "A deployment needs a service and a version.");
  db.query("INSERT OR REPLACE INTO deployments (service, environment, version, at, declared_by) VALUES (?, ?, ?, ?, ?)").run(input.service, input.environment ?? "PRD", input.version, Date.now(), actor.name);
  audit(actor.name, actor.through, "Declared a deployment", `${input.service} ${input.version}`);
  return { ok: true };
});

export function inbox(input: { category?: string; unread?: boolean }) {
  const clauses = ["1 = 1"];
  const args: string[] = [];
  if (input.category && input.category !== "all") {
    clauses.push("category = ?");
    args.push(input.category);
  }
  if (input.unread) clauses.push("read_at IS NULL");
  return {
    rows: db.query<{ id: number; at: number; category: string; title: string; detail: string | null; href: string | null; read_at: number | null }, string[]>(`SELECT id, at, category, title, detail, href, read_at FROM inbox WHERE ${clauses.join(" AND ")} ORDER BY at DESC LIMIT 2000`).all(...args),
    unread: db.query<{ n: number }, []>("SELECT count(*) AS n FROM inbox WHERE read_at IS NULL").get()?.n ?? 0,
    firing: db.query<{ id: string }, []>("SELECT id FROM alerts WHERE state = 'firing' AND paused = 0").all().map((row) => `/alerts/${row.id}`),
    down: db.query<{ name: string }, []>("SELECT name FROM monitors WHERE state = 'down' AND paused = 0").all().map((row) => row.name),
  };
}

export function markRead(input: { id?: number; ids?: number[] }) {
  if (input.ids) {
    for (const id of input.ids) db.query("UPDATE inbox SET read_at = ? WHERE id = ?").run(Date.now(), id);
    return { ok: true };
  }
  if (input.id) db.query("UPDATE inbox SET read_at = ? WHERE id = ?").run(Date.now(), input.id);
  else db.query("UPDATE inbox SET read_at = ? WHERE read_at IS NULL").run(Date.now());
  return { ok: true };
}
