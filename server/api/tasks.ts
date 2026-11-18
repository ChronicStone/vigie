import { redactValue } from "../lib/redact.ts";
import { query } from "../lib/clickhouse.ts";
import { appDb, loadPeople, personName, readOnly } from "../lib/appdb.ts";
import { mirrorFresh, pendingFromMirror } from "../mirror.ts";
import { appAccessToken } from "../auth.ts";
import { config } from "../config.ts";
import { registry } from "../extensions/index.ts";
import { audit, db } from "../state/db.ts";
import { readTraces } from "./traces.ts";
import { bucketOf, bucketTimes, dt, fillTime, HttpError, scopeOf, scopeParams, where, type Actor, type Scope, type ScopeInput } from "./http.ts";

const taskWhere = (scope: Scope) => `${where(scope)} AND Kind = 'task'`;
const LATE_SECONDS = () => registry.catalog.lateAfterSeconds ?? 300;

export type KindState = "failed" | "retrying" | "running" | "ok" | "held" | "idle";
export type RunState = "DONE" | "WAITING" | "FAILED" | "RUNNING" | "QUEUED" | "SCHEDULED" | "HELD" | "CANCELLED" | "SKIPPED";
export type StripItem = "ok" | "bad" | "skip" | "off";

export async function backlog(scope: Scope) {
  const params = scopeParams(scope);
  const [rows, oldest] = await Promise.all([
    // One row per kind and per worker, and every worker reports the same totals: add the kinds, then take one worker.
    query<{ state: string; v: number }>(`SELECT state, max(total) AS v FROM (SELECT Attributes['service.instance.id'] AS instance, Attributes['task.state'] AS state, sum(latest) AS total FROM (SELECT Attributes, argMax(Value, TimeUnix) AS latest FROM metrics_gauge WHERE MetricName = '${config.taskMetrics}.backlog' AND Environment = {env:String} AND TimeUnix >= now() - INTERVAL 5 MINUTE GROUP BY Attributes) GROUP BY instance, state) GROUP BY state`, { params }),
    query<{ v: number }>(`SELECT max(latest) AS v FROM (SELECT Attributes, argMax(Value, TimeUnix) AS latest FROM metrics_gauge WHERE MetricName = '${config.taskMetrics}.oldest_due_age' AND Environment = {env:String} AND TimeUnix >= now() - INTERVAL 5 MINUTE GROUP BY Attributes)`, { params }),
  ]);
  const value = (state: string) => Math.round(rows.find((r) => r.state === state)?.v ?? 0);
  return { due: value("due"), scheduled: value("scheduled"), running: value("running"), held: value("held"), oldestDue: oldest[0]?.v ?? 0 };
}

async function lastRuns(scope: Scope, count = 40) {
  const rows = await query<{ kind: string; runs: [string, string, number][] }>(`SELECT TaskKind AS kind, arraySlice(arrayReverse(arraySort(x -> x.1, groupArray(tuple(Timestamp, Outcome, DurationMs)))), 1, ${count}) AS runs FROM logs WHERE ${taskWhere(scope)} GROUP BY kind`, { params: scopeParams(scope) });
  return new Map(rows.map((r) => [r.kind, r.runs.map((x): StripItem => (x[1] === "failed" ? "bad" : x[1] === "skipped" ? "skip" : "ok")).reverse()]));
}

function stateOf(info: { failedShare: number; lastFailed: boolean; retrying: boolean; runningNow: boolean }): KindState {
  if (info.failedShare >= 10 || (info.lastFailed && info.failedShare >= 5)) return "failed";
  if (info.retrying) return "retrying";
  if (info.runningNow) return "running";
  return "ok";
}

const verdictTone = (bad: boolean, warn = false) => (bad ? "bad" : warn ? "warn" : "ok") as "bad" | "warn" | "ok";

export async function taskHealth(input: ScopeInput) {
  const scope = scopeOf(input, 60);
  const params = scopeParams(scope);
  const [lanes, kinds, series, waiting, strips, workers, totals, back] = await Promise.all([
    query<{ kind: string; t: number; done: number; skipped: number; failed: number }>(`SELECT TaskKind AS kind, ${bucketOf("Timestamp")} AS t, countIf(Outcome = 'succeeded') AS done, countIf(Outcome = 'skipped') AS skipped, countIf(Outcome = 'failed') AS failed FROM logs WHERE ${taskWhere(scope)} GROUP BY kind, t ORDER BY t`, { params }),
    query<{ kind: string; attempts: number; failed: number; skipped: number; runs: number; p95: number; wait: number; integration: string; last: number; lastOutcome: string; lastType: string; failCode: string; waitCode: string }>(`SELECT TaskKind AS kind, argMaxIf(if(LogAttributes['taskOutcome.code'] != '', LogAttributes['taskOutcome.code'], LogAttributes['taskOutcome.reason']), Timestamp, Outcome = 'failed') AS failCode, argMaxIf(if(LogAttributes['taskOutcome.code'] != '', LogAttributes['taskOutcome.code'], LogAttributes['taskOutcome.reason']), Timestamp, LogAttributes['taskOutcome.type'] IN ('RETRY', 'WAIT', 'LEASE_LOST')) AS waitCode, count() AS attempts, countIf(Outcome = 'failed') AS failed, countIf(Outcome = 'skipped') AS skipped, uniqExact(TaskId) AS runs, quantile(0.95)(DurationMs) AS p95, avg(toFloat64OrZero(LogAttributes['task.waitMs'])) AS wait, any(LogAttributes['task.integration']) AS integration, toUnixTimestamp(max(Timestamp)) * 1000 AS last, argMax(Outcome, Timestamp) AS lastOutcome, argMax(LogAttributes['taskOutcome.type'], Timestamp) AS lastType FROM logs WHERE ${taskWhere(scope)} GROUP BY kind`, { params }),
    query<{ t: number; ok: number; error: number }>(`SELECT ${bucketOf("Timestamp")} AS t, countIf(Outcome != 'failed') AS ok, countIf(Outcome = 'failed') AS error FROM logs WHERE ${taskWhere(scope)} GROUP BY t ${fillTime}`, { params }),
    query<{ t: number; due: number; scheduled: number }>(`SELECT t, maxIf(v, state = 'due') AS due, maxIf(v, state = 'scheduled') AS scheduled FROM (SELECT ${bucketOf("at")} AS t, instance, state, avg(reading) AS v FROM (SELECT TimeUnix AS at, Attributes['service.instance.id'] AS instance, Attributes['task.state'] AS state, sum(Value) AS reading FROM metrics_gauge WHERE MetricName = '${config.taskMetrics}.backlog' AND Environment = {env:String} AND TimeUnix >= toDateTime64({from:String}, 3) AND TimeUnix <= toDateTime64({to:String}, 3) GROUP BY at, instance, state) GROUP BY t, instance, state) GROUP BY t ORDER BY t`, { params }),
    lastRuns(scope),
    query<{ worker: string; last: number; lost: number }>(`SELECT LogAttributes['workerId'] AS worker, toUnixTimestamp(max(Timestamp)) * 1000 AS last, countIf(LogAttributes['taskOutcome.type'] = 'lease_lost') AS lost FROM logs WHERE ${taskWhere(scope)} AND worker != '' GROUP BY worker ORDER BY worker`, { params }),
    query<{ attempts: number; failed: number }>(`SELECT count() AS attempts, countIf(Outcome = 'failed') AS failed FROM logs WHERE ${taskWhere(scope)}`, { params }),
    backlog(scope),
  ]);
  const names = new Set<string>([...Object.keys(registry.catalog.tasks), ...kinds.map((k) => k.kind)]);
  const order: KindState[] = ["failed", "retrying", "running", "ok", "held", "idle"];
  const clock = bucketTimes(scope);
  const laneOf = (kind: string) => {
    const points = new Map(lanes.filter((row) => row.kind === kind).map((row) => [row.t, row]));
    return clock.map((t) => ({ t, done: points.get(t)?.done ?? 0, skipped: points.get(t)?.skipped ?? 0, failed: points.get(t)?.failed ?? 0 }));
  };
  const rows = [...names]
    .map((kind) => {
      const k = kinds.find((x) => x.kind === kind);
      const share = k ? (k.failed / Math.max(k.attempts, 1)) * 100 : 0;
      const state: KindState = k ? stateOf({ failedShare: share, lastFailed: k.lastOutcome === "failed", retrying: k.lastType === "RETRY", runningNow: Date.now() - k.last < 15000 }) : "idle";
      return { kind, integration: k?.integration || registry.catalog.tasks[kind]?.integration || "platform", runs: k?.runs ?? 0, attempts: k?.attempts ?? 0, failed: k?.failed ?? 0, skipped: k?.skipped ?? 0, lane: laneOf(kind), failedShare: share, p95: k?.p95 ?? 0, wait: (k?.wait ?? 0) / 1000, last: k?.last ?? 0, strip: strips.get(kind) ?? [], state, failCode: k?.failCode ?? "", waitCode: k?.waitCode ?? "" };
    })
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || b.runs - a.runs);
  const seen = workers.filter((w) => Date.now() - w.last < 5 * 60_000);
  const total = totals[0] ?? { attempts: 0, failed: 0 };
  const failedShare = (total.failed / Math.max(total.attempts, 1)) * 100;
  const worst = rows.filter((r) => r.failed > 0).sort((a, b) => b.failed - a.failed)[0];
  const facts = { oldestDue: back.oldestDue, due: back.due, scheduled: back.scheduled, failedShare, attempts: total.attempts, workers: seen.map((w) => w.worker), lost: workers.reduce((sum, w) => sum + w.lost, 0) };
  const worse = (card: "flow" | "execution" | "liveness", state: "ok" | "warn" | "bad") => {
    const rank = { ok: 0, warn: 1, bad: 2 };
    return registry.healthRules.filter((rule) => rule.card === card).reduce((current, rule) => {
      const next = rule.check(facts);
      return next && rank[next] > rank[current] ? next : current;
    }, state);
  };
  return {
    verdict: {
      flow: { state: worse("flow", verdictTone(back.oldestDue >= LATE_SECONDS())), oldestDue: back.oldestDue, due: back.due, scheduled: back.scheduled, lateAfter: LATE_SECONDS() },
      execution: { state: worse("execution", verdictTone(failedShare >= 5, failedShare >= 0.5)), failedShare, failed: total.failed, attempts: total.attempts, worst: worst?.kind ?? "" },
      liveness: { state: worse("liveness", verdictTone(!seen.length)), workers: seen.map((w) => w.worker), lost: workers.reduce((sum, w) => sum + w.lost, 0), lastSeen: Math.max(0, ...workers.map((w) => w.last)), known: workers.length },
    },
    backlog: back,
    series,
    waiting,
    rows,
  };
}

type RunDbRow = { id: string; kind: string; key: string; accountId: string; attempts: number; last: number; duration: number; worker: string; code: string; type: string; outcome: string; integration: string; traceId: string };
const RUN_ROWS = `SELECT TaskId AS id, any(TaskKind) AS kind, any(LogAttributes['task.key']) AS key, any(AccountId) AS accountId, max(toUInt32OrZero(LogAttributes['task.attempt'])) AS attempts, toUnixTimestamp64Milli(toDateTime64(max(Timestamp), 3)) AS last, argMax(DurationMs, Timestamp) AS duration, argMax(LogAttributes['workerId'], Timestamp) AS worker, argMax(if(LogAttributes['taskOutcome.code'] != '', LogAttributes['taskOutcome.code'], LogAttributes['taskOutcome.reason']), Timestamp) AS code, argMax(LogAttributes['taskOutcome.type'], Timestamp) AS type, argMax(Outcome, Timestamp) AS outcome, any(LogAttributes['task.integration']) AS integration, argMax(TraceId, Timestamp) AS traceId`;

/** Payloads are read straight from the app, so they skip the redaction that telemetry gets at ingest. */
const redactedJson = (value: unknown) => JSON.stringify(value ?? null, (key, item) => (typeof item === "string" ? redactValue(key, item) : item));

function taskState(row: { outcome: string; type: string }): RunState {
  if (row.outcome === "succeeded") return "DONE";
  // A skip is the task deciding there is nothing to do. It is not a failure and must never read as one.
  if (row.type === "SKIP") return "SKIPPED";
  if (row.type === "CANCELLED") return "CANCELLED";
  if (row.type === "RETRY" || row.type === "WAIT" || row.type === "AGAIN" || row.type === "LEASE_LOST" || row.type === "REQUEUED") return "WAITING";
  return row.outcome === "skipped" ? "SKIPPED" : "FAILED";
}

export type RunRow = { id: string; kind: string; key: string; accountId: string; attempts: number; last: number; duration: number; worker: string; code: string; integration: string; traceId: string; state: RunState };

async function pendingFromApp(kind: string | undefined, limit: number): Promise<RunRow[]> {
  if (!appDb()) return [];
  try {
    if (mirrorFresh()) {
      const now = Date.now();
      return (await pendingFromMirror(kind, limit)).map((r) => ({ id: r.id, kind: r.kind, key: r.key, attempts: r.attempts, last: r.runAt, duration: 0, worker: "", code: "", accountId: r.accountId, integration: registry.catalog.tasks[r.kind]?.integration ?? "", traceId: r.traceId, state: r.state === "RUNNING" ? "RUNNING" : r.runAt > now ? "SCHEDULED" : "QUEUED" }) as RunRow);
    }
    const rows = await readOnly<{ id: string; kind: string; key: string; state: string; attempts: number; runAt: string }>(`SELECT id, kind, key, state, attempts, "runAt" FROM task WHERE state IN ('QUEUED', 'RUNNING') ${kind ? "AND kind = $1" : ""} ORDER BY "runAt" LIMIT ${limit}`, kind ? [kind] : [], 5000);
    const now = Date.now();
    return rows.map((r) => {
      const at = new Date(r.runAt).getTime();
      return { id: String(r.id), kind: r.kind, key: r.key, attempts: r.attempts, last: at, duration: 0, worker: "", code: "", accountId: "", integration: registry.catalog.tasks[r.kind]?.integration ?? "", traceId: "", state: r.state === "RUNNING" ? "RUNNING" : at > now ? "SCHEDULED" : "QUEUED" };
    });
  } catch {
    return [];
  }
}

/** The span that recorded a task, from the event the app leaves on it. Looked for inside its trace when that is known. */
export async function producerOf(id: string, at: number) {
  const copied = mirrorFresh() ? await query<{ traceId: string }>("SELECT TraceId AS traceId FROM task_mirror FINAL WHERE Id = {id:String} LIMIT 1", { params: { id } }).catch(() => []) : [];
  const traceId = copied[0]?.traceId ?? "";
  const rows = await query<{ traceId: string; spanId: string; name: string; service: string }>(
    `SELECT TraceId AS traceId, SpanId AS spanId, SpanName AS name, ServiceName AS service FROM spans WHERE Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) ${traceId ? "AND TraceId = {traceId:String}" : ""} AND has(EventsName, 'task.recorded') AND arrayExists(a -> a['task.id'] = {id:String}, EventsAttributes) LIMIT 1`,
    { params: { id, traceId, from: dt(at - 7 * 86_400_000), to: dt(at + 60_000) }, timeout: 5 },
  ).catch(() => []);
  return rows[0] ?? null;
}

export type RunFilter = { q?: string; kind?: string; worker?: string; integration?: string; account?: string; view?: string; state?: string };

export async function listRuns(input: ScopeInput & RunFilter, limit = 300) {
  const scope = scopeOf(input);
  const params: Record<string, unknown> = { ...scopeParams(scope) };
  const clauses: string[] = [];
  if (input.q) {
    params.q = input.q;
    clauses.push("(TaskId = {q:String} OR positionCaseInsensitive(TaskKind, {q:String}) > 0 OR positionCaseInsensitive(LogAttributes['task.key'], {q:String}) > 0 OR AccountId = {q:String} OR positionCaseInsensitive(LogAttributes['taskOutcome.code'], {q:String}) > 0 OR positionCaseInsensitive(LogAttributes['taskOutcome.reason'], {q:String}) > 0)");
  }
  for (const [key, column] of [["kind", "TaskKind"], ["worker", "LogAttributes['workerId']"], ["integration", "LogAttributes['task.integration']"], ["account", "AccountId"]] as const) {
    if (input[key]) {
      params[key] = input[key];
      clauses.push(`${column} = {${key}:String}`);
    }
  }
  const extra = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
  const [rows, pending] = await Promise.all([query<RunDbRow>(`${RUN_ROWS} FROM logs WHERE ${taskWhere(scope)}${extra} GROUP BY TaskId ORDER BY last DESC LIMIT ${limit}`, { params: params as never }), pendingFromApp(input.kind, 50)]);
  let merged: RunRow[] = [...pending, ...rows.map(({ type, outcome, ...r }) => ({ ...r, state: taskState({ outcome, type }) }))];
  if (input.view === "open") merged = merged.filter((r) => r.state === "FAILED");
  if (input.view === "late") merged = merged.filter((r) => r.state === "WAITING" || (r.state === "QUEUED" && Date.now() - r.last > LATE_SECONDS() * 1000));
  if (input.view === "held") merged = merged.filter((r) => r.state === "HELD");
  if (input.state) merged = merged.filter((r) => r.state === input.state);
  return merged;
}

export async function taskList(input: ScopeInput & RunFilter) {
  const scope = scopeOf(input);
  const params = scopeParams(scope);
  const facet = (column: string) => query<{ value: string; n: number }>(`SELECT ${column} AS value, count() AS n FROM logs WHERE ${taskWhere(scope)} AND value != '' GROUP BY value ORDER BY n DESC LIMIT 60`, { params });
  const [rows, kind, worker, integration, account] = await Promise.all([listRuns(input), facet("TaskKind"), facet("LogAttributes['workerId']"), facet("LogAttributes['task.integration']"), facet("AccountId")]);
  return { rows, facets: { kind, worker, integration, account } };
}

/** Who turned this kind's switch on or off, read live from the app's history table. */
export async function switchHistory(input: { key: string }) {
  if (!appDb()) return [];
  try {
    if (mirrorFresh()) {
      const copied = await query<{ enabled: number; reason: string; userId: string; at: number }>("SELECT Enabled AS enabled, Reason AS reason, UserId AS userId, toUnixTimestamp64Milli(CreatedAt) AS at FROM switch_changes WHERE Key = {key:String} ORDER BY CreatedAt DESC LIMIT 20", { params: { key: input.key } });
      if (copied.length) {
        await loadPeople();
        return copied.map((row) => ({ enabled: Boolean(row.enabled), reason: row.reason, who: row.userId ? personName(row.userId) || row.userId : "", at: Number(row.at) }));
      }
    }
    const rows = await readOnly<{ enabled: boolean; previousEnabled: boolean | null; reason: string | null; userId: string | null; createdAt: string }>('SELECT enabled, "previousEnabled", reason, "userId", "createdAt" FROM feature_flag_change WHERE key = $1 ORDER BY "createdAt" DESC LIMIT 20', [input.key], 3000);
    await loadPeople();
    return rows.map((row) => ({ enabled: row.enabled, reason: row.reason ?? "", who: row.userId ? personName(row.userId) || row.userId : "", at: new Date(row.createdAt).getTime() }));
  } catch {
    return [];
  }
}

export async function taskKind(input: ScopeInput & { kind: string }) {
  const scope = scopeOf(input, 60);
  const params = { ...scopeParams(scope), kind: input.kind };
  const scoped = `${taskWhere(scope)} AND TaskKind = {kind:String}`;
  const [stats, series, duration, codes, ladder, strips, runs] = await Promise.all([
    query<{ runs: number; attempts: number; failed: number; skipped: number; p95: number; wait: number; lastOutcome: string; lastType: string; last: number; integration: string }>(`SELECT uniqExact(TaskId) AS runs, count() AS attempts, countIf(Outcome = 'failed') AS failed, countIf(Outcome = 'skipped') AS skipped, quantile(0.95)(DurationMs) AS p95, avg(toFloat64OrZero(LogAttributes['task.waitMs'])) AS wait, argMax(Outcome, Timestamp) AS lastOutcome, argMax(LogAttributes['taskOutcome.type'], Timestamp) AS lastType, toUnixTimestamp(max(Timestamp)) * 1000 AS last, any(LogAttributes['task.integration']) AS integration FROM logs WHERE ${scoped}`, { params }),
    query<{ t: number; ok: number; error: number; done: number; skipped: number }>(`SELECT ${bucketOf("Timestamp")} AS t, countIf(Outcome != 'failed') AS ok, countIf(Outcome = 'failed') AS error, countIf(Outcome = 'succeeded') AS done, countIf(Outcome = 'skipped') AS skipped FROM logs WHERE ${scoped} GROUP BY t ${fillTime}`, { params }),
    query<{ t: number; p50: number; p95: number }>(`SELECT ${bucketOf("Timestamp")} AS t, quantile(0.5)(DurationMs) AS p50, quantile(0.95)(DurationMs) AS p95 FROM logs WHERE ${scoped} GROUP BY t ORDER BY t`, { params }),
    query<{ type: string; code: string; n: number; why: string; taskId: string; last: number }>(`SELECT LogAttributes['taskOutcome.type'] AS type, if(LogAttributes['taskOutcome.code'] != '', LogAttributes['taskOutcome.code'], LogAttributes['taskOutcome.reason']) AS code, count() AS n, any(if(LogAttributes['why'] != '', LogAttributes['why'], LogAttributes['reason'])) AS why, argMax(TaskId, Timestamp) AS taskId, toUnixTimestamp(max(Timestamp)) * 1000 AS last FROM logs WHERE ${scoped} AND Outcome != 'succeeded' GROUP BY type, code ORDER BY n DESC LIMIT 30`, { params }),
    query<{ attempt: number; n: number }>(`SELECT toUInt32OrZero(LogAttributes['task.attempt']) AS attempt, count() AS n FROM logs WHERE ${scoped} AND Outcome = 'failed' GROUP BY attempt ORDER BY attempt`, { params }),
    lastRuns(scope),
    listRuns({ ...input, kind: input.kind }, 40),
  ]);
  const head = stats[0];
  const definition = registry.catalog.tasks[input.kind] ?? null;
  if (!head?.attempts && !definition) throw new HttpError(404, "No task of this kind ran in this time range.");
  const state: KindState = head?.attempts ? stateOf({ failedShare: (head.failed / head.attempts) * 100, lastFailed: head.lastOutcome === "failed", retrying: head.lastType === "RETRY", runningNow: false }) : "idle";
  return {
    switch: registry.catalog.tasks[input.kind]?.switch ?? "", kind: input.kind, definition, runs, stats: head ?? { runs: 0, attempts: 0, failed: 0, skipped: 0, p95: 0, wait: 0, lastOutcome: "", lastType: "", last: 0, integration: "" }, state, series, duration, codes, ladder: (registry.catalog.retryLadder ?? []).map((label, index) => ({ label, n: ladder.find((l) => l.attempt === index + 1)?.n ?? 0 })), strip: strips.get(input.kind) ?? [] };
}

export async function taskRun(id: string) {
  const newest = await query<{ eventId: string; traceId: string; end: number; duration: number; outcome: string; attrs: Record<string, string>; service: string; environment: string }>(`SELECT EventId AS eventId, TraceId AS traceId, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS end, DurationMs AS duration, Outcome AS outcome, LogAttributes AS attrs, ServiceName AS service, Environment AS environment FROM logs WHERE TaskId = {id:String} AND Kind = 'task' ORDER BY Timestamp DESC LIMIT 200`, { params: { id } });
  const attempts = newest.slice().reverse();
  const last = attempts[attempts.length - 1];
  if (!last) {
    // Queued and scheduled tasks have no attempt yet: only the app's table knows them.
    const row = appDb() ? (await readOnly<{ kind: string; key: string; state: RunState; accountId: string | null; payload: unknown; runAt: string }>(`SELECT id, kind, key, state, "accountId", payload, "runAt" FROM task WHERE id::text = $1 LIMIT 1`, [id], 3000).catch(() => []))[0] : undefined;
    if (!row) throw new HttpError(404, "No attempt of this task is left in telemetry.");
    return { id, kind: row.kind, key: row.key, state: row.state, runAt: new Date(row.runAt).getTime(), attempts: [], spans: [], logs: [], payload: redactedJson(row.payload), result: "null", accountId: row.accountId ?? "", createdBy: "", causedBy: "", producer: null, related: [], sameKind: [], definition: registry.catalog.tasks[row.kind] ?? null, actionsEnabled: Boolean(config.appApiUrl) };
  }
  // A task that repeats forever would ask for hundreds of traces: the latest runs and anything that went wrong tell the story.
  const worth = attempts.filter((a, index) => index >= attempts.length - 30 || a.outcome === "failed");
  const { spans, logs } = await readTraces([...new Set(worth.map((a) => a.traceId).filter(Boolean))]);
  const key = last.attrs["task.key"] ?? "";
  const kind = last.attrs["task.kind"] ?? "";
  type Other = { id: string; kind: string; last: number; outcome: string; type: string; attempts: number };
  const others = (cond: string, limit: number) => query<Other>(`SELECT TaskId AS id, any(TaskKind) AS kind, toUnixTimestamp(max(Timestamp)) * 1000 AS last, argMax(Outcome, Timestamp) AS outcome, argMax(LogAttributes['taskOutcome.type'], Timestamp) AS type, max(toUInt32OrZero(LogAttributes['task.attempt'])) AS attempts FROM logs WHERE Kind = 'task' AND ${cond} AND TaskId != {id:String} GROUP BY TaskId ORDER BY last DESC LIMIT ${limit}`, { params: { key, kind, id } });
  const [related, sameKind] = await Promise.all([others("LogAttributes['task.key'] = {key:String}", 20), others("TaskKind = {kind:String}", 8)]);
  let row: { state?: RunState; payload?: unknown; result?: unknown } | undefined;
  if (appDb()) {
    try {
      [row] = await readOnly<{ state: RunState; payload: unknown; result: unknown }>("SELECT state, payload, result FROM task WHERE id::text = $1 LIMIT 1", [id], 3000);
    } catch {}
  }
  const withState = (o: Other) => ({ ...o, state: taskState(o) });
  return {
    id,
    kind,
    key,
    state: row?.state ?? taskState({ outcome: last.outcome, type: last.attrs["taskOutcome.type"] ?? "" }),
    runAt: 0,
    attempts: attempts.map((a) => ({ eventId: a.eventId, traceId: a.traceId, end: a.end, start: a.end - a.duration, duration: a.duration, outcome: a.outcome, number: Number(a.attrs["task.attempt"] ?? 1), run: Number(a.attrs["task.run"] ?? 0), type: a.attrs["taskOutcome.type"] ?? "", code: a.attrs["taskOutcome.code"] ?? "", worker: a.attrs.workerId ?? "", reason: a.attrs["taskOutcome.reason"] ?? a.attrs.reason ?? "", message: a.attrs["error.message"] ?? "", fields: a.attrs, why: a.attrs.why ?? a.attrs["error.why"] ?? "", fix: a.attrs.fix ?? a.attrs["error.fix"] ?? "", waitMs: Number(a.attrs["task.waitMs"] ?? 0), service: a.service })),
    spans,
    logs,
    payload: redactedJson(row?.payload),
    result: redactedJson(row?.result),
    accountId: last.attrs["workspace.accountId"] ?? last.attrs["account.id"] ?? "",
    subject: { type: last.attrs["task.subject.type"] ?? "", id: last.attrs["task.subject.id"] ?? "" },
    createdBy: last.attrs["user.id"] ?? "",
    causedBy: last.attrs["task.causedBy"] ?? "",
    producer: await producerOf(id, attempts[0]?.end ?? Date.now()),
    related: related.map(withState),
    sameKind: sameKind.map(withState),
    definition: registry.catalog.tasks[kind] ?? null,
    actionsEnabled: actionsEnabled(),
    appTasksUrl: appTasksUrl(),
  };
}

export async function workers(input: ScopeInput) {
  const scope = scopeOf(input, 60);
  const params = scopeParams(scope);
  const [rows, series, recent, back] = await Promise.all([
    query<{ worker: string; first: number; last: number; attempts: number; lost: number; reclaims: number; busyMs: number; failed: number; skipped: number; lastKind: string; lastId: string }>(`SELECT LogAttributes['workerId'] AS worker, toUnixTimestamp(min(Timestamp)) * 1000 AS first, toUnixTimestamp(max(Timestamp)) * 1000 AS last, count() AS attempts, sum(DurationMs) AS busyMs, countIf(Outcome = 'failed') AS failed, countIf(Outcome = 'skipped') AS skipped, argMax(TaskKind, Timestamp) AS lastKind, argMax(TaskId, Timestamp) AS lastId, countIf(LogAttributes['taskOutcome.type'] = 'lease_lost') AS lost, countIf(LogAttributes['taskOutcome.reclaimed'] = 'true') AS reclaims FROM logs WHERE ${taskWhere(scope)} AND worker != '' GROUP BY worker ORDER BY worker`, { params }),
    query<{ worker: string; t: number; n: number }>(`SELECT LogAttributes['workerId'] AS worker, ${bucketOf("Timestamp")} AS t, count() AS n FROM logs WHERE ${taskWhere(scope)} AND worker != '' GROUP BY worker, t ORDER BY t`, { params }),
    query<{ worker: string; kind: string; id: string; t: number; duration: number; outcome: string; type: string }>(`SELECT LogAttributes['workerId'] AS worker, TaskKind AS kind, TaskId AS id, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, DurationMs AS duration, Outcome AS outcome, LogAttributes['taskOutcome.type'] AS type FROM logs WHERE ${taskWhere(scope)} AND worker != '' ORDER BY Timestamp DESC LIMIT 200`, { params }),
    backlog(scope),
  ]);
  return { times: bucketTimes(scope), rows, series, recent, slots: 4, backlog: back, windowMs: scope.to - scope.from };
}

function nextRun(info: { every?: string; at?: string }, now = Date.now()) {
  if (info.every) {
    const match = info.every.match(/^(\d+)(s|m|h)$/);
    if (!match) return null;
    const step = Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "s"];
    return Math.ceil(now / step) * step;
  }
  if (info.at) {
    const [h, m] = info.at.split(":").map(Number);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
    const minutes = Number(parts.find((x) => x.type === "hour")!.value) * 60 + Number(parts.find((x) => x.type === "minute")!.value);
    let diff = h! * 60 + m! - minutes;
    if (diff <= 0) diff += 1440;
    return now + diff * 60_000;
  }
  return null;
}

/** How long a clock can stay silent before it counts as late. */
function periodOf(info: { every?: string; at?: string }) {
  const match = info.every?.match(/^(\d+)(s|m|h)$/);
  if (match) return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "s"];
  return info.at ? 86_400_000 : 0;
}

export async function schedules(input: ScopeInput) {
  const wide = scopeOf({ ...input, from: Date.now() - 7 * 86_400_000, to: Date.now() });
  const rows = await query<{ kind: string; runs: [string, string][]; last: number }>(`SELECT TaskKind AS kind, arraySlice(arrayReverse(arraySort(x -> x.1, groupArray(tuple(Timestamp, Outcome)))), 1, 30) AS runs, toUnixTimestamp(max(Timestamp)) * 1000 AS last FROM logs WHERE ${taskWhere(wide)} GROUP BY kind`, { params: scopeParams(wide) });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  let flags = new Map<string, boolean>();
  if (appDb()) {
    try {
      flags = new Map((await readOnly<{ key: string; enabled: boolean }>("SELECT key, enabled FROM feature_flag", [], 3000)).map((f) => [f.key, f.enabled]));
    } catch {}
  }
  return Object.entries(registry.catalog.tasks)
    .filter(([, info]) => info.every || info.at)
    .map(([kind, info]) => {
      const row = byKind.get(kind);
      const outcomes = row?.runs.map((x) => x[1]) ?? [];
      let inRow = 0;
      for (const outcome of outcomes) {
        if (outcome === "skipped") continue;
        if (outcome === "succeeded") break;
        inRow++;
      }
      const switchOn: boolean | null = info.switch ? (flags.get(info.switch) ?? null) : true;
      return { kind, clock: info.clock ?? info.every ?? info.at ?? "", switch: info.switch ?? "", switchOn, next: switchOn === false ? null : nextRun(info), last: row?.last ?? 0, strip: outcomes.slice().reverse().map((o): StripItem => (o === "succeeded" ? "ok" : o === "skipped" ? "skip" : "bad")), inRow, every: info.every ?? "", at: info.at ?? "", periodMs: periodOf(info), lastOutcome: outcomes[0] ?? "" };
    });
}

/** Acting on a task needs the person's own app sign-in. With Vigie's own login, actions stay in the app and Vigie links there. */
export const actionsEnabled = () => Boolean(config.appApiUrl && config.auth.oidcIssuer);
export const appTasksUrl = () => config.appTasksUrl || (config.appUrl ? `${config.appUrl.replace(/\/$/, "")}/admin/tasks` : "");

/** Actions go through the app's own task API, as the signed-in person. Vigie never writes to the app's database. */
async function callAppApi(actor: Actor, path: string, body: unknown) {
  if (!config.appApiUrl) throw new HttpError(409, "Task actions need VIGIE_APP_API_URL. Nothing was changed.");
  const token = appAccessToken(actor.id);
  if (!token) throw new HttpError(403, `This needs your own ${config.appName} sign-in. Sign in to Vigie with ${config.auth.oidcName}, then try again. Nothing was changed.`);
  const response = await fetch(`${config.appApiUrl.replace(/\/$/, "")}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) {
    let reason = text.slice(0, 200);
    try {
      const body = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
      reason = body.message ?? body.errors?.[0]?.message ?? reason;
    } catch {
      // Not JSON: keep the text.
    }
    throw new HttpError(response.status === 401 || response.status === 403 ? 403 : response.status === 409 || response.status === 422 ? 409 : 502, `The app refused this: ${reason}`);
  }
  return text;
}

export type TaskAction = "requeue" | "cancel" | "run-now" | "ignore";

export async function taskAction(input: { id: string; action: TaskAction; reason?: string }, actor: Actor) {
  if (!input.reason?.trim()) throw new HttpError(400, "The app records a reason for every task action. Give one.");
  await callAppApi(actor, `/v1/tasks/${encodeURIComponent(input.id)}/actions/${input.action}`, { reason: input.reason ?? "" });
  audit(actor.name, actor.through, `${input.action} task`, input.id);
  return { ok: true };
}

type BulkDb = { id: string; name: string; action: TaskAction; actor: string; created_at: number; state: string; reason: string | null; filter: string; eligible: string; excluded: number; done: number; failed: number; skipped: number };

export function bulkList() {
  return db.query<BulkDb, []>("SELECT * FROM bulk_actions ORDER BY created_at DESC LIMIT 100").all().map((row) => ({ ...row, filter: row.filter, eligible: JSON.parse(row.eligible) as string[] }));
}

/** The dry run is stored. Nothing runs until the person confirms what it found. */
export async function bulkDryRun(input: ScopeInput & { action: TaskAction; reason: string; name?: string; ids?: string[]; filter?: RunFilter }, actor: Actor) {
  if (!input.reason.trim()) throw new HttpError(400, "Say why, so the audit log explains this later.");
  const { action, reason, name, ids, filter, ...scope } = input;
  const rows = (await listRuns({ ...scope, ...filter }, 1000)).filter((r) => !ids?.length || ids.includes(r.id));
  const eligible = rows.filter((r) => (action === "requeue" ? r.state === "FAILED" : ["FAILED", "WAITING", "QUEUED"].includes(r.state)));
  const id = crypto.randomUUID();
  db.query("INSERT INTO bulk_actions (id, name, action, actor, created_at, state, reason, filter, eligible, excluded) VALUES (?, ?, ?, ?, ?, 'dry-run', ?, ?, ?, ?)").run(id, name || `${action} ${eligible.length} tasks`, action, actor.name, Date.now(), reason, JSON.stringify(filter ?? { ids }), JSON.stringify(eligible.map((r) => r.id)), rows.length - eligible.length);
  return { id, eligible: eligible.length, excluded: rows.length - eligible.length, sample: eligible.slice(0, 5) };
}

export function bulkRun(input: { id: string }, actor: Actor) {
  const row = db.query<BulkDb, [string]>("SELECT * FROM bulk_actions WHERE id = ?").get(input.id);
  if (!row) throw new HttpError(404, "This bulk action does not exist.");
  if (row.state !== "dry-run") throw new HttpError(409, "This bulk action already ran.");
  if (!config.appApiUrl) throw new HttpError(409, "Bulk actions need VIGIE_APP_API_URL. Nothing was changed.");
  db.query("UPDATE bulk_actions SET state = 'running' WHERE id = ?").run(input.id);
  audit(actor.name, actor.through, `started bulk ${row.action}`, row.name);
  void (async () => {
    let done = 0;
    let failed = 0;
    for (const id of JSON.parse(row.eligible) as string[]) {
      try {
        await callAppApi(actor, `/v1/tasks/${encodeURIComponent(id)}/actions/${row.action}`, { reason: row.reason });
        done++;
      } catch {
        failed++;
      }
      db.query("UPDATE bulk_actions SET done = ?, failed = ? WHERE id = ?").run(done, failed, row.id);
      await Bun.sleep(100);
    }
    db.query("UPDATE bulk_actions SET state = 'done' WHERE id = ?").run(row.id);
    audit(actor.name, actor.through, `finished bulk ${row.action}: ${done} done, ${failed} failed`, row.name);
  })();
  return { ok: true };
}
