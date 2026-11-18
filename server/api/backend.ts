import { query } from "../lib/clickhouse.ts";
import { accountName, loadPeople, personName } from "../lib/appdb.ts";
import { registry } from "../extensions/index.ts";
import { db } from "../state/db.ts";
import { processDetail, processSummaries } from "./processes.ts";
import { bucketOf, bucketTimes, dt, fillTime, HttpError, scopeOf, scopeParams, where, type Scope, type ScopeInput } from "./http.ts";

export const minuteWhere = (scope: Scope) => {
  const parts = ["Minute >= toStartOfMinute(toDateTime64({from:String}, 3))", "Minute <= toDateTime64({to:String}, 3)", "Environment = {env:String}"];
  if (scope.services.length) parts.push("ServiceName IN {services:Array(String)}");
  return parts.join(" AND ");
};
const P95 = "quantilesTDigestMerge(0.5, 0.95, 0.99)(Quantiles)[2]";
const P95Q = "quantilesTDigestMerge(0.5, 0.95)(Quantiles)[2]";

export type RequestPoint = { t: number; ok: number; warn: number; error: number; avg: number; p95: number };
export type VolumePoint = { t: number; ok: number; error: number };
export type RequestSummary = { requests: number; serverErrors: number; denied: number; avg: number; p95: number };

export async function requestSummary(scope: Scope): Promise<RequestSummary> {
  const [row] = await query<RequestSummary>(`SELECT sum(Requests) AS requests, sumIf(Requests, StatusClass = 500) AS serverErrors, sumIf(Requests, Outcome = 'denied') AS denied, sum(Duration) / greatest(sum(Requests), 1) AS avg, ${P95} AS p95 FROM req_1m WHERE ${minuteWhere(scope)}`, { params: scopeParams(scope) });
  return row ?? { requests: 0, serverErrors: 0, denied: 0, avg: 0, p95: 0 };
}

function requestSeries(scope: Scope, extra = "", params: Record<string, string> = {}) {
  return query<RequestPoint>(
    `SELECT ${bucketOf("Minute")} AS t, sumIf(Requests, StatusClass < 400) AS ok, sumIf(Requests, StatusClass = 400) AS warn, sumIf(Requests, StatusClass >= 500) AS error, sum(Duration) / greatest(sum(Requests), 1) AS avg, ${P95} AS p95 FROM req_1m WHERE ${minuteWhere(scope)} ${extra} GROUP BY t ${fillTime}`,
    { params: { ...scopeParams(scope), ...params } },
  );
}

const taskMinutes = "Minute >= toStartOfMinute(toDateTime64({from:String}, 3)) AND Minute <= toDateTime64({to:String}, 3) AND Environment = {env:String}";

export type Need = { tone: "err" | "warn"; title: string; detail: string; to: string; search?: Record<string, string>; fact?: string; when?: number; whenLabel?: string; series?: number[] };

export async function overview(input: ScopeInput) {
  const scope = scopeOf(input);
  const params = scopeParams(scope);
  const [summary, series, tasks, slow, taskSeries, kinds, repeated, active, processes] = await Promise.all([
    requestSummary(scope),
    requestSeries(scope),
    query<{ attempts: number; failed: number }>(`SELECT sum(Attempts) AS attempts, sumIf(Attempts, Outcome = 'failed') AS failed FROM task_1m WHERE ${taskMinutes}`, { params }),
    query<{ method: string; route: string; p95: number }>(`SELECT Method AS method, Route AS route, ${P95} AS p95 FROM req_1m WHERE ${minuteWhere(scope)} AND Route != '' GROUP BY method, route ORDER BY p95 DESC LIMIT 5`, { params }),
    query<{ t: number; attempts: number; failed: number }>(`SELECT ${bucketOf("Minute")} AS t, sum(Attempts) AS attempts, sumIf(Attempts, Outcome = 'failed') AS failed FROM task_1m WHERE ${taskMinutes} GROUP BY t ${fillTime}`, { params }),
    query<{ kind: string; attempts: number; failed: number; last: number }>(`SELECT TaskKind AS kind, sum(Attempts) AS attempts, sumIf(Attempts, Outcome = 'failed') AS failed, toUnixTimestamp(maxIf(Minute, Outcome = 'failed')) * 1000 AS last FROM task_1m WHERE ${taskMinutes} GROUP BY kind HAVING failed > 0 ORDER BY failed / attempts DESC LIMIT 3`, { params }),
    query<{ route: string; method: string; statement: string; times: number; n: number }>(`SELECT Route AS route, Method AS method, any(LogAttributes['db.repeatedStatement']) AS statement, round(avg(toFloat64OrZero(LogAttributes['db.repeatedQueries']))) AS times, count() AS n FROM logs WHERE ${where(scope)} AND Kind = 'request' AND toFloat64OrZero(LogAttributes['db.repeatedQueries']) > 3 GROUP BY route, method ORDER BY times * n DESC LIMIT 1`, { params }),
    query<{ n: number }>(`SELECT uniqExact(UserId) AS n FROM logs WHERE ${where(scope)} AND UserId != ''`, { params }),
    processSummaries(scope).catch(() => []),
  ]);
  const issues = db.query<{ fingerprint: string; name: string; message: string; regressed: number; first_seen: number }, [string]>("SELECT fingerprint, name, message, regressed, first_seen FROM issues WHERE status = 'open' AND environment = ? ORDER BY regressed DESC, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen DESC LIMIT 4").all(scope.env);
  const firing = db.query<{ id: string; name: string; value: number | null; rule: string; since: number | null }, []>("SELECT id, name, value, rule, since FROM alerts WHERE state = 'firing' AND paused = 0").all();
  const needs: Need[] = [];
  for (const alert of firing) needs.push({ tone: "err", title: `${alert.name} is firing`, detail: (JSON.parse(alert.rule) as { condition?: string }).condition ?? `Now ${Math.round((alert.value ?? 0) * 10) / 10}.`, when: alert.since ?? undefined, whenLabel: "Since", to: `/alerts/${alert.id}` });
  const failingKinds = kinds.filter((kind) => (kind.failed / Math.max(kind.attempts, 1)) * 100 >= 2);
  const kindPoints = failingKinds.length ? await query<{ kind: string; t: number; n: number }>(`SELECT TaskKind AS kind, ${bucketOf("Minute")} AS t, sumIf(Attempts, Outcome = 'failed') AS n FROM task_1m WHERE ${taskMinutes} AND TaskKind IN {kinds:Array(String)} GROUP BY kind, t ORDER BY t`, { params: { ...params, kinds: failingKinds.map((kind) => kind.kind) } }) : [];
  for (const kind of failingKinds) {
    const share = (kind.failed / Math.max(kind.attempts, 1)) * 100;
    needs.push({ tone: "err", title: `${kind.kind} is failing`, detail: `${share.toFixed(0)}% of attempts failed`, fact: `${kind.failed} of ${kind.attempts} attempts`, when: kind.last || undefined, series: fillBuckets(scope, kindPoints.filter((point) => point.kind === kind.kind)), to: `/tasks/kind/${encodeURIComponent(kind.kind)}` });
  }
  const raised = issues.filter((issue) => issue.regressed || issue.first_seen > scope.from);
  const issueParams = { ...params, fps: raised.map((issue) => issue.fingerprint) };
  const [issuePoints, issueTotals] = raised.length
    ? await Promise.all([
        query<{ fp: string; t: number; n: number }>(`SELECT Fingerprint AS fp, ${bucketOf("Timestamp")} AS t, count() AS n FROM logs WHERE ${where(scope)} AND Fingerprint IN {fps:Array(String)} GROUP BY fp, t ORDER BY t`, { params: issueParams }),
        query<{ fp: string; n: number; people: number; last: number }>(`SELECT Fingerprint AS fp, count() AS n, uniqExactIf(UserId, UserId != '') AS people, toUnixTimestamp(max(Timestamp)) * 1000 AS last FROM logs WHERE ${where(scope)} AND Fingerprint IN {fps:Array(String)} GROUP BY fp`, { params: issueParams }),
      ])
    : [[], []];
  for (const issue of raised) {
    const total = issueTotals.find((row) => row.fp === issue.fingerprint);
    needs.push({ tone: issue.regressed ? "warn" : "err", title: `${issue.name}${issue.regressed ? " came back" : " is new"}`, detail: issue.message, fact: total ? `${total.n} ${total.n === 1 ? "event" : "events"}${total.people ? `, ${total.people} ${total.people === 1 ? "person" : "people"}` : ""}` : undefined, when: total?.last, series: fillBuckets(scope, issuePoints.filter((point) => point.fp === issue.fingerprint)), to: `/issues/${issue.fingerprint}` });
  }
  const routeSeries = async (method: string, route: string, condition = "1") =>
    fillBuckets(scope, await query<{ t: number; n: number }>(`SELECT ${bucketOf("Timestamp")} AS t, count() AS n FROM logs WHERE ${where(scope)} AND Method = {m:String} AND Route = {r:String} AND ${condition} GROUP BY t ORDER BY t`, { params: { ...params, m: method, r: route } }));
  const failing = await query<{ method: string; route: string; failed: number; total: number; last: number; status: number }>(`SELECT Method AS method, Route AS route, countIf(Status >= 500) AS failed, count() AS total, toUnixTimestamp(maxIf(Timestamp, Status >= 500)) * 1000 AS last, anyIf(Status, Status >= 500) AS status FROM logs WHERE ${where(scope)} AND Kind = 'request' AND Route != '' GROUP BY method, route HAVING failed > 0 ORDER BY failed DESC LIMIT 3`, { params });
  for (const route of failing) needs.push({ tone: "err", title: "Server errors on this route", detail: `${route.method} ${route.route}`, fact: `${route.failed} of ${route.total} requests answered ${route.status}`, when: route.last, series: await routeSeries(route.method, route.route, "Status >= 500"), to: "/requests/route", search: { method: route.method, route: route.route } });
  const top = repeated[0];
  if (top) needs.push({ tone: "warn", title: `Same query ${top.times} times per request`, detail: `${top.method} ${top.route}`, fact: `Likely N+1, in ${top.n} requests`, series: await routeSeries(top.method, top.route), to: "/requests/route", search: { method: top.method, route: top.route } });
  const taskTotals = tasks[0] ?? { attempts: 0, failed: 0 };
  const busiest = [...processes].filter((p) => p.started > 0).sort((a, b) => b.started - a.started)[0];
  const details = await Promise.all(processes.filter((p) => p.started > 0).map((p) => processDetail({ ...input, id: p.id }).catch(() => null)));
  const flow = details.find((detail) => detail?.id === busiest?.id) ?? null;
  const flows = details.flatMap((detail) => (detail ? [{ id: detail.id, title: detail.title, stats: detail.stats, steps: detail.steps }] : []));
  return { summary, tasks: taskTotals, active: active[0]?.n ?? 0, series, taskSeries, slow, needs: needs.slice(0, 5), allNeeds: needs, processes, flow, flows };
}

/** The same scope, for the window of the same length right before it. */
export const previousMinutes = (scope: Scope) => {
  const parts = ["Minute >= toStartOfMinute(toDateTime64({prevFrom:String}, 3))", "Minute < toDateTime64({from:String}, 3)", "Environment = {env:String}"];
  if (scope.services.length) parts.push("ServiceName IN {services:Array(String)}");
  return parts.join(" AND ");
};
const prevFrom = (scope: Scope) => dt(scope.from - (scope.to - scope.from));

/**
 * The app reports a repeated statement cut at 160 characters, so its hash never matches a stored pattern.
 * The pattern it belongs to is the busiest one starting with that text.
 */
async function patternHashes(scope: Scope, statements: string[]) {
  if (!statements.length) return new Map<string, string>();
  const rows = await query<{ hash: string; statement: string }>(`SELECT toString(Hash) AS hash, any(Statement) AS statement FROM query_1m WHERE ${minuteWhere(scope)} GROUP BY Hash ORDER BY sum(Calls) DESC LIMIT 5000`, { params: scopeParams(scope) });
  return new Map(statements.map((statement) => [statement, rows.find((row) => row.statement.startsWith(statement))?.hash ?? ""]));
}

export type RouteRow = { method: string; route: string; count: number; avg: number; p95: number; errors: number; warns: number; spark: number[]; total: number; prevCount: number; prevAvg: number; repeat: number };
export type RequestsResult =
  | { tab: "matched"; summary: RequestSummary; counts: RouteCounts; rows: RouteRow[] }
  | { tab: "unmatched"; summary: RequestSummary; counts: RouteCounts; rows: { method: string; path: string; count: number }[] }
  | { tab: "denied"; summary: RequestSummary; counts: RouteCounts; rows: { method: string; route: string; reason: string; count: number }[] };
type RouteCounts = { unmatched: number; denied: number };

export async function requests(input: ScopeInput & { tab?: string }): Promise<RequestsResult> {
  const scope = scopeOf(input, 26);
  const params = scopeParams(scope);
  const [summary, countRows] = await Promise.all([requestSummary(scope), query<RouteCounts>(`SELECT countIf(Route = '') AS unmatched, countIf(Outcome = 'denied') AS denied FROM logs WHERE ${where(scope)} AND Method != '' `, { params })]);
  const counts = countRows[0] ?? { unmatched: 0, denied: 0 };
  if (input.tab === "unmatched") return { tab: "unmatched", summary, counts, rows: await query(`SELECT Method AS method, LogAttributes['path'] AS path, count() AS count FROM logs WHERE ${where(scope)} AND Method != '' AND Route = '' GROUP BY method, path ORDER BY count DESC LIMIT 500`, { params }) };
  if (input.tab === "denied") return { tab: "denied", summary, counts, rows: await query(`SELECT Method AS method, Route AS route, LogAttributes['reason'] AS reason, count() AS count FROM logs WHERE ${where(scope)} AND Method != '' AND Outcome = 'denied' GROUP BY method, route, reason ORDER BY count DESC LIMIT 500`, { params }) };
  const [rows, sparks, previous, repeats] = await Promise.all([
    query<Omit<RouteRow, "spark" | "prevCount" | "prevAvg" | "repeat">>(`SELECT Method AS method, Route AS route, sum(Requests) AS count, sum(Duration) AS total, sum(Duration) / greatest(sum(Requests), 1) AS avg, ${P95} AS p95, sumIf(Requests, StatusClass >= 500) / greatest(sum(Requests), 1) * 100 AS errors, sumIf(Requests, StatusClass = 400) / greatest(sum(Requests), 1) * 100 AS warns FROM req_1m WHERE ${minuteWhere(scope)} AND Route != '' GROUP BY method, route ORDER BY count DESC LIMIT 1000`, { params }),
    query<{ method: string; route: string; t: number; n: number }>(`SELECT Method AS method, Route AS route, ${bucketOf("Minute")} AS t, sum(Requests) AS n FROM req_1m WHERE ${minuteWhere(scope)} AND Route != '' GROUP BY method, route, t ORDER BY t`, { params }),
    query<{ method: string; route: string; count: number; avg: number }>(`SELECT Method AS method, Route AS route, sum(Requests) AS count, sum(Duration) / greatest(sum(Requests), 1) AS avg FROM req_1m WHERE ${previousMinutes(scope)} AND Route != '' GROUP BY method, route`, { params: { ...params, prevFrom: prevFrom(scope) } }),
    query<{ method: string; route: string; times: number }>(`SELECT Method AS method, Route AS route, round(avg(toFloat64OrZero(LogAttributes['db.repeatedQueries']))) AS times FROM logs WHERE ${where(scope)} AND Kind = 'request' AND LogAttributes['db.repeatedStatement'] != '' GROUP BY method, route`, { params }),
  ]);
  const before = new Map(previous.map((row) => [`${row.method} ${row.route}`, row]));
  const repeated = new Map(repeats.map((row) => [`${row.method} ${row.route}`, row.times]));
  const times = bucketTimes(scope);
  const index = new Map(times.map((t, i) => [t, i]));
  const spark = new Map<string, number[]>();
  for (const point of sparks) {
    const key = `${point.method} ${point.route}`;
    if (!spark.has(key)) spark.set(key, new Array(times.length).fill(0));
    const slot = index.get(point.t);
    if (slot !== undefined) spark.get(key)![slot] = point.n;
  }
  return { tab: "matched", summary, counts, rows: rows.map((r) => {
    const key = `${r.method} ${r.route}`;
    return { ...r, spark: spark.get(key) ?? [], prevCount: before.get(key)?.count ?? 0, prevAvg: before.get(key)?.avg ?? 0, repeat: repeated.get(key) ?? 0 };
  }) };
}

export async function routeDetail(input: ScopeInput & { method: string; route: string; sort?: string }) {
  const scope = scopeOf(input, 60);
  const { method, route } = input;
  const params = { ...scopeParams(scope), method, route };
  const extra = "AND Method = {method:String} AND Route = {route:String}";
  const LOG_ROUTE = `${where(scope)} AND Kind = 'request' AND Method = {method:String} AND Route = {route:String}`;
  const REQUEST_ROW = "EventId AS id, TraceId AS traceId, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, Status AS status, DurationMs AS duration, Outcome AS outcome, UserId AS userId, AccountId AS accountId";
  type RequestRow = { id: string; traceId: string; t: number; status: number; duration: number; outcome: string; userId: string; accountId: string };
  const WHY = "if(LogAttributes['error.message'] != '', LogAttributes['error.message'], LogAttributes['reason'])";
  const [slowest, failing, histogram, reasons, parts] = await Promise.all([
    query<RequestRow>(`SELECT ${REQUEST_ROW} FROM logs WHERE ${LOG_ROUTE} ORDER BY DurationMs DESC LIMIT 8`, { params }),
    query<RequestRow>(`SELECT ${REQUEST_ROW} FROM logs WHERE ${LOG_ROUTE} AND (Status >= 500 OR Outcome = 'failed') ORDER BY Timestamp DESC LIMIT 8`, { params }),
    query<{ bucket: number; n: number; failed: number }>(`SELECT multiIf(DurationMs < 25, 0, DurationMs < 50, 1, DurationMs < 100, 2, DurationMs < 250, 3, DurationMs < 500, 4, DurationMs < 1000, 5, DurationMs < 2500, 6, DurationMs < 5000, 7, 8) AS bucket, count() AS n, countIf(Status >= 500) AS failed FROM logs WHERE ${LOG_ROUTE} GROUP BY bucket ORDER BY bucket`, { params }),
    query<{ status: number; why: string; n: number; last: number }>(`SELECT Status AS status, anyIf(${WHY}, ${WHY} != '') AS why, count() AS n, toUnixTimestamp(max(Timestamp)) * 1000 AS last FROM logs WHERE ${LOG_ROUTE} AND Status >= 400 GROUP BY status ORDER BY status >= 500 DESC, n DESC LIMIT 8`, { params }),
    query<{ avg: number; db: number; queries: number }>(`SELECT avg(DurationMs) AS avg, avg(toFloat64OrZero(LogAttributes['db.durationMs'])) AS db, avg(DbQueries) AS queries FROM logs WHERE ${LOG_ROUTE}`, { params }),
  ]);
  const [series, stats, recent, repeated, calls, previous] = await Promise.all([
    requestSeries(scope, extra, { method, route }),
    query<{ count: number; errors: number; warns: number; avg: number; p95: number }>(`SELECT sum(Requests) AS count, sumIf(Requests, StatusClass >= 500) AS errors, sumIf(Requests, StatusClass = 400) AS warns, sum(Duration) / greatest(sum(Requests), 1) AS avg, ${P95} AS p95 FROM req_1m WHERE ${minuteWhere(scope)} ${extra}`, { params }),
    query<{ id: string; traceId: string; t: number; status: number; duration: number; outcome: string; userId: string; accountId: string }>(`SELECT EventId AS id, TraceId AS traceId, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, Status AS status, DurationMs AS duration, Outcome AS outcome, UserId AS userId, AccountId AS accountId FROM logs WHERE ${where(scope)} AND Kind = 'request' AND Method = {method:String} AND Route = {route:String} ORDER BY ${input.sort === "slow" ? "DurationMs DESC" : "Timestamp DESC"} LIMIT 40`, { params }),
    query<{ statement: string; times: number; dbMs: number; n: number; hash: string }>(`SELECT LogAttributes['db.repeatedStatement'] AS statement, round(avg(toFloat64OrZero(LogAttributes['db.repeatedQueries']))) AS times, round(avg(toFloat64OrZero(LogAttributes['db.durationMs']))) AS dbMs, count() AS n, toString(cityHash64(normalizeQuery(statement))) AS hash FROM logs WHERE ${where(scope)} AND Kind = 'request' AND Method = {method:String} AND Route = {route:String} AND statement != '' GROUP BY statement ORDER BY n DESC LIMIT 2`, { params }),
    query<{ host: string; method: string; path: string; calls: number; avg: number; total: number; errors: number }>(`SELECT PeerHost AS host, ${EXT_METHOD} AS method, ${EXT_OP} AS path, count() AS calls, avg(Duration) / 1e6 AS avg, sum(Duration) / 1e6 AS total, countIf(${EXT_FAILED}) AS errors FROM spans WHERE Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND PeerHost != '' AND DbStatement = '' AND SpanAttributes['db.system'] = '' AND TraceId IN (SELECT TraceId FROM logs WHERE ${where(scope)} AND Kind = 'request' AND Method = {method:String} AND Route = {route:String}) GROUP BY host, method, path ORDER BY total DESC LIMIT 8`, { params }),
    query<{ avg: number; count: number; errors: number; p95: number }>(`SELECT sum(Duration) / greatest(sum(Requests), 1) AS avg, sum(Requests) AS count, sumIf(Requests, StatusClass >= 500) AS errors, ${P95} AS p95 FROM req_1m WHERE Minute >= toStartOfMinute(toDateTime64({prevFrom:String}, 3)) AND Minute < toDateTime64({from:String}, 3) AND Environment = {env:String} ${extra}`, { params: { ...params, prevFrom: dt(scope.from - (scope.to - scope.from)) } }),
  ]);
  await loadPeople();
  const person = <T extends { userId: string }>(r: T) => ({ ...r, person: personName(r.userId) || r.userId });
  const hashes = await patternHashes(scope, repeated.map((r) => r.statement));
  return {
    stats: stats[0] ?? { count: 0, errors: 0, warns: 0, avg: 0, p95: 0 },
    previousAvg: previous[0]?.avg ?? 0,
    previous: previous[0] ?? { avg: 0, count: 0, errors: 0, p95: 0 },
    series,
    recent: recent.map(person),
    slowest: slowest.map(person),
    failing: failing.map(person),
    histogram,
    reasons,
    parts: parts[0] ?? { avg: 0, db: 0, queries: 0 },
    repeated: repeated.map((r) => ({ ...r, hash: hashes.get(r.statement) ?? "" })),
    calls: calls.map((c) => ({ ...c, provider: registry.catalog.providers[c.host] ?? c.host })),
  };
}

export type QueryPattern = { hash: string; statement: string; operation: string; calls: number; errors: number; total: number; avg: number; p95: number };
export type QueriesResult =
  | { tab: "patterns"; rows: QueryPattern[] }
  | { tab: "entry"; rows: { entry: string; kind: string; perCall: number; queries: number; n: number }[] }
  | { tab: "nplus"; rows: { entry: string; statement: string; times: number; n: number; hash: string }[] };

export async function queries(input: ScopeInput & { tab?: string }) {
  const scope = scopeOf(input, 60);
  const params = scopeParams(scope);
  const entry = "if(Kind = 'task', concat('task ', TaskKind), concat(Method, ' ', Route))";
  const [stats, series, slow, suspects, repeatedRows] = await Promise.all([
    query<{ calls: number; errors: number; avg: number; p95: number; total: number }>(`SELECT sum(Calls) AS calls, sum(Errors) AS errors, sum(Duration) / greatest(sum(Calls), 1) AS avg, ${P95Q} AS p95, sum(Duration) AS total FROM query_1m WHERE ${minuteWhere(scope)}`, { params }),
    query<VolumePoint & { avg: number; p95: number }>(`SELECT ${bucketOf("Minute")} AS t, sum(Calls) - sum(Errors) AS ok, sum(Errors) AS error, sum(Duration) / greatest(sum(Calls), 1) AS avg, ${P95Q} AS p95 FROM query_1m WHERE ${minuteWhere(scope)} GROUP BY t ${fillTime}`, { params }),
    query<{ n: number }>(`SELECT count() AS n FROM spans WHERE Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND DbStatement != '' AND Duration >= 100000000`, { params }),
    query<{ n: number }>(`SELECT uniqExact(concat(Route, LogAttributes['db.repeatedStatement'])) AS n FROM logs WHERE ${where(scope)} AND LogAttributes['db.repeatedStatement'] != ''`, { params }),
    query<{ entry: string; statement: string; times: number; n: number }>(`SELECT ${entry} AS entry, LogAttributes['db.repeatedStatement'] AS statement, round(avg(toFloat64OrZero(LogAttributes['db.repeatedQueries']))) AS times, count() AS n FROM logs WHERE ${where(scope)} AND statement != '' GROUP BY entry, statement ORDER BY times * n DESC LIMIT 100`, { params }),
  ]);
  const hashes = await patternHashes(scope, [...new Set(repeatedRows.map((row) => row.statement))]);
  const repeated = repeatedRows.map((row) => ({ ...row, hash: hashes.get(row.statement) ?? "" }));
  let result: QueriesResult;
  if (input.tab === "entry") result = { tab: "entry", rows: await query(`SELECT ${entry} AS entry, Kind AS kind, avg(toFloat64OrZero(LogAttributes['db.durationMs'])) AS perCall, avg(DbQueries) AS queries, count() AS n FROM logs WHERE ${where(scope)} AND Kind IN ('request', 'task') AND DbQueries > 0 GROUP BY entry, kind ORDER BY perCall * n DESC LIMIT 200`, { params }) };
  else if (input.tab === "nplus") result = { tab: "nplus", rows: repeated };
  else result = { tab: "patterns", rows: await query(`SELECT toString(Hash) AS hash, any(Statement) AS statement, any(Operation) AS operation, sum(Calls) AS calls, sum(Errors) AS errors, sum(Duration) AS total, sum(Duration) / greatest(sum(Calls), 1) AS avg, ${P95Q} AS p95 FROM query_1m WHERE ${minuteWhere(scope)} GROUP BY Hash ORDER BY total DESC LIMIT 500`, { params }) };
  return { stats: stats[0] ?? { calls: 0, errors: 0, avg: 0, p95: 0, total: 0 }, slow: slow[0]?.n ?? 0, suspects: suspects[0]?.n ?? 0, series, result, repeated };
}

export async function queryDetail(input: ScopeInput & { hash: string }) {
  const scope = scopeOf(input, 60);
  const params = { ...scopeParams(scope), hash: input.hash };
  const span = "Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND DbStatement != '' AND DbStatementHash = toUInt64OrZero({hash:String})";
  const logScope = `Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND Kind IN ('request', 'task')`;
  const [callers, slowest] = await Promise.all([
    query<{ entry: string; calls: number; total: number; traces: number; most: number }>(`SELECT l.entry AS entry, sum(s.n) AS calls, sum(s.total) AS total, count() AS traces, max(s.n) AS most FROM (SELECT TraceId, count() AS n, sum(Duration) / 1e6 AS total FROM spans WHERE ${span} GROUP BY TraceId) AS s INNER JOIN (SELECT TraceId, any(if(Kind = 'task', concat('task ', TaskKind), concat(Method, ' ', Route))) AS entry FROM logs WHERE ${logScope} GROUP BY TraceId) AS l ON s.TraceId = l.TraceId GROUP BY entry ORDER BY total DESC LIMIT 30`, { params }),
    query<{ traceId: string; t: number; duration: number; status: string }>(`SELECT TraceId AS traceId, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, Duration / 1e6 AS duration, StatusCode AS status FROM spans WHERE ${span} ORDER BY Duration DESC LIMIT 8`, { params }),
  ]);
  const [stats, series, recent, repeats] = await Promise.all([
    query<Omit<QueryPattern, "hash">>(`SELECT any(Statement) AS statement, any(Operation) AS operation, sum(Calls) AS calls, sum(Errors) AS errors, sum(Duration) AS total, sum(Duration) / greatest(sum(Calls), 1) AS avg, ${P95Q} AS p95 FROM query_1m WHERE ${minuteWhere(scope)} AND Hash = toUInt64OrZero({hash:String})`, { params }),
    query<{ t: number; calls: number; avg: number }>(`SELECT ${bucketOf("Minute")} AS t, sum(Calls) AS calls, sum(Duration) / greatest(sum(Calls), 1) AS avg FROM query_1m WHERE ${minuteWhere(scope)} AND Hash = toUInt64OrZero({hash:String}) GROUP BY t ${fillTime}`, { params }),
    query<{ traceId: string; t: number; duration: number; statement: string; service: string; status: string }>(`SELECT TraceId AS traceId, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, Duration / 1e6 AS duration, DbStatement AS statement, ServiceName AS service, StatusCode AS status FROM spans WHERE ${span} ORDER BY Timestamp DESC LIMIT 40`, { params }),
    query<{ n: number; traces: number }>(`SELECT n, count() AS traces FROM (SELECT TraceId, count() AS n FROM spans WHERE ${span} GROUP BY TraceId) GROUP BY n ORDER BY n LIMIT 30`, { params }),
  ]);
  const head = stats[0];
  if (!head?.calls) throw new HttpError(404, "This query did not run in this time range.");
  const entries = await entryOf([...new Set([...recent, ...slowest].map((r) => r.traceId))]);
  return { stats: head, series, recent: recent.map((r) => ({ ...r, entry: entries.get(r.traceId)?.entry ?? r.service })), repeats, callers, slowest: slowest.map((r) => ({ ...r, entry: entries.get(r.traceId)?.entry ?? "" })) };
}

async function entryOf(traces: string[]) {
  if (!traces.length) return new Map<string, { entry: string; taskId: string }>();
  const rows = await query<{ traceId: string; entry: string; taskId: string }>(`SELECT TraceId AS traceId, if(Kind = 'task', concat('task ', TaskKind), concat(Method, ' ', Route)) AS entry, TaskId AS taskId FROM logs WHERE TraceId IN {traces:Array(String)} AND Kind IN ('request', 'task') LIMIT 100`, { params: { traces } });
  return new Map(rows.map((r) => [r.traceId, r]));
}

/** A provider call failed when it answered 4xx or 5xx, or when the span says so: a call that never got an answer has no status. */
const EXT_FAILED = "(HttpStatus >= 400 OR StatusCode = 'Error')";
const EXT_METHOD = "if(SpanAttributes['http.request.method'] != '', SpanAttributes['http.request.method'], SpanAttributes['http.method'])";
const foldPath = (path: string) => `replaceRegexpAll(replaceRegexpAll(splitByChar('?', ${path})[1], '[0-9a-fA-F][0-9a-fA-F-]{15,}', ':id'), '/[0-9]{2,}', '/:id')`;
/**
 * What a call did, in the best words the span carries. Our own providers name the operation.
 * AWS SDK spans carry older http.* keys: S3 becomes GetObject and so on, SES keeps its path with ids folded.
 */
const EXT_OP = `multiIf(SpanAttributes['provider.operation'] != '', SpanAttributes['provider.operation'], extractURLParameter(SpanAttributes['http.target'], 'x-id') != '', extractURLParameter(SpanAttributes['http.target'], 'x-id'), PeerHost LIKE '%.s3.%', transform(${EXT_METHOD}, ['GET', 'HEAD', 'PUT', 'DELETE', 'POST'], ['GetObject', 'HeadObject', 'PutObject', 'DeleteObject', 'PostObject'], SpanName), SpanAttributes['url.full'] != '', ${foldPath("path(SpanAttributes['url.full'])")}, SpanAttributes['http.target'] != '', ${foldPath("SpanAttributes['http.target']")}, SpanName)`;

const extWhere = "Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND PeerHost != '' AND DbStatement = '' AND SpanAttributes['db.system'] = ''";
type ExtStats = { calls: number; errors: number; failed: number; avg: number; p95: number };
const EXT_STATS = `count() AS calls, countIf(HttpStatus >= 400) AS errors, countIf(${EXT_FAILED}) AS failed, avg(Duration) / 1e6 AS avg, quantile(0.95)(Duration) / 1e6 AS p95`;

export type ProviderHealth = { t: number; ok: number; failed: number };

export async function external(input: ScopeInput) {
  const scope = scopeOf(input, 60);
  const params = scopeParams(scope);
  const [board, previous] = await Promise.all([
    query<{ host: string; t: number; ok: number; failed: number }>(`SELECT PeerHost AS host, ${bucketOf("Timestamp")} AS t, countIf(NOT ${EXT_FAILED}) AS ok, countIf(${EXT_FAILED}) AS failed FROM spans WHERE ${extWhere} GROUP BY host, t ORDER BY t`, { params }),
    query<{ host: string; calls: number; failed: number; p95: number }>(`SELECT PeerHost AS host, count() AS calls, countIf(${EXT_FAILED}) AS failed, quantile(0.95)(Duration) / 1e6 AS p95 FROM spans WHERE Timestamp >= toDateTime64({prevFrom:String}, 3) AND Timestamp < toDateTime64({from:String}, 3) AND Environment = {env:String} AND PeerHost != '' AND DbStatement = '' AND SpanAttributes['db.system'] = '' GROUP BY host`, { params: { ...params, prevFrom: prevFrom(scope) } }),
  ]);
  const slots = bucketTimes(scope);
  const before = new Map(previous.map((row) => [row.host, row]));
  const [stats, series, rows] = await Promise.all([
    query<ExtStats>(`SELECT ${EXT_STATS} FROM spans WHERE ${extWhere}`, { params }),
    query<VolumePoint & { avg: number; p95: number }>(`SELECT ${bucketOf("Timestamp")} AS t, countIf(HttpStatus < 400) AS ok, countIf(HttpStatus >= 400) AS error, avg(Duration) / 1e6 AS avg, quantile(0.95)(Duration) / 1e6 AS p95 FROM spans WHERE ${extWhere} GROUP BY t ${fillTime}`, { params }),
    query<{ host: string; calls: number; e4: number; e5: number; failed: number; lastFailed: number; avg: number; p95: number }>(`SELECT PeerHost AS host, count() AS calls, countIf(HttpStatus >= 400 AND HttpStatus < 500) AS e4, countIf(HttpStatus >= 500) AS e5, countIf(${EXT_FAILED}) AS failed, toUnixTimestamp(maxIf(Timestamp, ${EXT_FAILED})) * 1000 AS lastFailed, avg(Duration) / 1e6 AS avg, quantile(0.95)(Duration) / 1e6 AS p95 FROM spans WHERE ${extWhere} GROUP BY host ORDER BY calls DESC LIMIT 200`, { params }),
  ]);
  return {
    stats: stats[0] ?? { calls: 0, errors: 0, failed: 0, avg: 0, p95: 0 },
    series,
    rows: rows.map((r) => {
      const points = new Map(board.filter((point) => point.host === r.host).map((point) => [point.t, point]));
      return { ...r, name: registry.catalog.providers[r.host] ?? r.host, timeline: slots.map((t): ProviderHealth => ({ t, ok: points.get(t)?.ok ?? 0, failed: points.get(t)?.failed ?? 0 })), previous: before.get(r.host) ?? null };
    }),
  };
}

export async function provider(input: ScopeInput & { host: string }) {
  const scope = scopeOf(input, 60);
  const params = { ...scopeParams(scope), host: input.host };
  const scoped = `${extWhere} AND PeerHost = {host:String}`;
  const CALL = `TraceId AS traceId, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, ${EXT_METHOD} AS method, ${EXT_OP} AS path, HttpStatus AS status, Duration / 1e6 AS duration, ${EXT_FAILED} AS failed`;
  type Call = { traceId: string; t: number; method: string; path: string; status: number; duration: number; failed: number };
  const logScope = `Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND Kind IN ('request', 'task')`;
  const [stats, series, ops, codes, calls, failures, failedCalls, triggers] = await Promise.all([
    query<ExtStats>(`SELECT ${EXT_STATS} FROM spans WHERE ${scoped}`, { params }),
    query<VolumePoint>(`SELECT ${bucketOf("Timestamp")} AS t, countIf(NOT ${EXT_FAILED}) AS ok, countIf(${EXT_FAILED}) AS error FROM spans WHERE ${scoped} GROUP BY t ${fillTime}`, { params }),
    query<{ method: string; path: string; calls: number; avg: number; p95: number; errors: number }>(`SELECT ${EXT_METHOD} AS method, ${EXT_OP} AS path, count() AS calls, avg(Duration) / 1e6 AS avg, quantile(0.95)(Duration) / 1e6 AS p95, countIf(${EXT_FAILED}) AS errors FROM spans WHERE ${scoped} GROUP BY method, path ORDER BY errors DESC, calls DESC LIMIT 30`, { params }),
    query<{ status: number; message: string; n: number }>(`SELECT HttpStatus AS status, any(StatusMessage) AS message, count() AS n FROM spans WHERE ${scoped} AND HttpStatus >= 400 GROUP BY status ORDER BY n DESC LIMIT 12`, { params }),
    query<Call>(`SELECT ${CALL} FROM spans WHERE ${scoped} ORDER BY Timestamp DESC LIMIT 40`, { params }),
    query<{ method: string; path: string; status: number; message: string; n: number; last: number }>(`SELECT ${EXT_METHOD} AS method, ${EXT_OP} AS path, HttpStatus AS status, anyIf(StatusMessage, StatusMessage != '') AS message, count() AS n, toUnixTimestamp(max(Timestamp)) * 1000 AS last FROM spans WHERE ${scoped} AND ${EXT_FAILED} GROUP BY method, path, status ORDER BY n DESC LIMIT 12`, { params }),
    query<Call>(`SELECT ${CALL} FROM spans WHERE ${scoped} AND ${EXT_FAILED} ORDER BY Timestamp DESC LIMIT 15`, { params }),
    query<{ entry: string; calls: number; failed: number; total: number; runs: number }>(`SELECT l.entry AS entry, sum(s.n) AS calls, sum(s.failed) AS failed, sum(s.total) AS total, count() AS runs FROM (SELECT TraceId, count() AS n, countIf(${EXT_FAILED}) AS failed, sum(Duration) / 1e6 AS total FROM spans WHERE ${scoped} GROUP BY TraceId) AS s INNER JOIN (SELECT TraceId, any(if(Kind = 'task', concat('task ', TaskKind), concat(Method, ' ', Route))) AS entry FROM logs WHERE ${logScope} GROUP BY TraceId) AS l ON s.TraceId = l.TraceId GROUP BY entry ORDER BY failed DESC, calls DESC LIMIT 12`, { params }),
  ]);
  const entries = await entryOf([...new Set([...calls, ...failedCalls].map((c) => c.traceId))]);
  const withEntry = (c: Call) => ({ ...c, entry: entries.get(c.traceId)?.entry ?? "", taskId: entries.get(c.traceId)?.taskId ?? "" });
  return { host: input.host, name: registry.catalog.providers[input.host] ?? input.host, stats: stats[0] ?? { calls: 0, errors: 0, failed: 0, avg: 0, p95: 0 }, series, ops, codes, failures, triggers, calls: calls.map(withEntry), failedCalls: failedCalls.map(withEntry) };
}

const num = (key: string) => `toFloat64OrZero(LogAttributes['${key}'])`;

export async function emails(input: ScopeInput) {
  const scope = scopeOf(input, 60);
  const params = scopeParams(scope);
  const scoped = `${where(scope)} AND ${num("emails.sent")} + ${num("emails.failed")} > 0`;
  const [stats, series, templates, refused, delivery] = await Promise.all([
    query<{ sent: number; failed: number; p95: number }>(`SELECT sum(${num("emails.sent")}) AS sent, sum(${num("emails.failed")}) AS failed, quantile(0.95)(${num("emails.durationMs")}) AS p95 FROM logs WHERE ${scoped}`, { params }),
    query<VolumePoint>(`SELECT ${bucketOf("Timestamp")} AS t, sum(${num("emails.sent")}) AS ok, sum(${num("emails.failed")}) AS error FROM logs WHERE ${scoped} GROUP BY t ${fillTime}`, { params }),
    query<{ template: string; sent: number; failed: number }>(`SELECT LogAttributes['emails.template'] AS template, sum(${num("emails.sent")}) AS sent, sum(${num("emails.failed")}) AS failed FROM logs WHERE ${scoped} GROUP BY template ORDER BY sent DESC LIMIT 50`, { params }),
    query<{ id: string; traceId: string; t: number; template: string; error: string }>(`SELECT EventId AS id, TraceId AS traceId, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, LogAttributes['emails.template'] AS template, LogAttributes['emails.error'] AS error FROM logs WHERE ${scoped} AND ${num("emails.failed")} > 0 ORDER BY Timestamp DESC LIMIT 1 BY EventId LIMIT 30`, { params }),
    query<{ checked: number; delivered: number; bounced: number; complained: number; last: number; runs: number }>(`SELECT sum(${num("emailDeliveries.checked")}) AS checked, sum(${num("emailDeliveries.delivered")}) AS delivered, sum(${num("emailDeliveries.bounced")}) AS bounced, sum(${num("emailDeliveries.complained")}) AS complained, toUnixTimestamp(max(Timestamp)) * 1000 AS last, count() AS runs FROM logs WHERE ${where(scope)} AND LogAttributes['emailDeliveries.checked'] != ''`, { params }),
  ]);
  return { stats: stats[0] ?? { sent: 0, failed: 0, p95: 0 }, series, templates, refused, delivery: delivery[0] ?? { checked: 0, delivered: 0, bounced: 0, complained: 0, last: 0, runs: 0 } };
}

const RUNTIME_GAUGES = ["process.cpu.utilization", "process.memory.usage", "v8.heap.used", "v8js.memory.heap.used", "v8js.memory.heap.limit", "nodejs.eventloop.delay.p99", "nodejs.eventloop.utilization", "db.client.connection.count"];
/** OTel semantic conventions report bytes and seconds. Older instrumentation already reports MB and ms. */
const runtimeValue = (name: string, value: number) => (name.startsWith("v8js.memory") ? value / 1_048_576 : name === "nodejs.eventloop.delay.p99" && value < 5 ? value * 1000 : name === "nodejs.eventloop.utilization" ? value * 100 : value);

const fillBuckets = (scope: Scope, points: { t: number; n: number }[]) => {
  const at = new Map(points.map((point) => [point.t, point.n]));
  return bucketTimes(scope).map((t) => at.get(t) ?? 0);
};

export async function runtime(input: ScopeInput & { instance?: string }) {
  const scope = scopeOf(input, 60);
  const params = scopeParams(scope);
  const instances = await query<{ instance: string; service: string; seen: number }>(`SELECT Attributes['service.instance.id'] AS instance, any(ServiceName) AS service, toUnixTimestamp(max(TimeUnix)) * 1000 AS seen FROM metrics_gauge WHERE TimeUnix >= toDateTime64({from:String}, 3) AND Environment = {env:String} AND instance != '' AND MetricName IN {names:Array(String)} GROUP BY instance ORDER BY seen DESC, service, instance`, { params: { ...params, names: RUNTIME_GAUGES } as never });
  const instance = input.instance || instances[0]?.instance || "";
  // Several spaces or states report at once: add them per instant, then average per bucket. Bytes and seconds become MB and ms here.
  const [gauges, sums, version] = await Promise.all([
    query<{ name: string; state: string; t: number; v: number }>(`SELECT name, state, t, avg(v) AS v FROM (SELECT MetricName AS name, Attributes['state'] AS state, TimeUnix AS at, ${bucketOf("TimeUnix")} AS t, sum(Value) AS v FROM metrics_gauge WHERE TimeUnix >= toDateTime64({from:String}, 3) AND TimeUnix <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND MetricName IN {names:Array(String)} AND Attributes['service.instance.id'] = {inst:String} GROUP BY name, state, at, t) GROUP BY name, state, t ORDER BY t`, { params: { ...params, names: RUNTIME_GAUGES, inst: instance } as never }),
    query<{ name: string; state: string; t: number; v: number }>(`SELECT name, state, t, avg(v) AS v FROM (SELECT MetricName AS name, if(Attributes['state'] != '', Attributes['state'], Attributes['db.client.connection.state']) AS state, TimeUnix AS at, ${bucketOf("TimeUnix")} AS t, sum(Value) AS v FROM metrics_sum WHERE TimeUnix >= toDateTime64({from:String}, 3) AND TimeUnix <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND MetricName IN {names:Array(String)} AND Attributes['service.instance.id'] = {inst:String} GROUP BY name, state, at, t) GROUP BY name, state, t ORDER BY t`, { params: { ...params, names: ["db.client.connection.count"], inst: instance } as never }),
    query<{ version: string; first: number }>(`SELECT any(ServiceVersion) AS version, toUnixTimestamp(min(Timestamp)) * 1000 AS first FROM logs WHERE InstanceId = {inst:String} AND Environment = {env:String} AND Timestamp >= toDateTime64({from:String}, 3)`, { params: { ...params, inst: instance } }),
  ]);
  const series = [...gauges, ...sums].map((point) => ({ ...point, v: runtimeValue(point.name, point.v) }));
  return { instances, instance, series, notices: runtimeNotices(series), version: version[0]?.version ?? "", first: version[0]?.first ?? 0 };
}

/** Plain warnings from the runtime series: memory that only climbs, and an event loop falling behind. */
export function runtimeNotices(series: { name: string; t: number; v: number }[]) {
  const notices: { tone: "warn" | "bad"; title: string; text: string }[] = [];
  const of = (name: string) => series.filter((p) => p.name === name).sort((a, b) => a.t - b.t);
  const heap = of("v8.heap.used");
  if (heap.length >= 8) {
    const third = Math.floor(heap.length / 3);
    const avg = (points: typeof heap) => points.reduce((sum, p) => sum + p.v, 0) / Math.max(points.length, 1);
    const [start, middle, end] = [avg(heap.slice(0, third)), avg(heap.slice(third, 2 * third)), avg(heap.slice(2 * third))];
    if (start > 0 && middle > start * 1.1 && end > middle * 1.1) notices.push({ tone: "warn", title: "Heap keeps growing", text: `From ${Math.round(start)} to ${Math.round(end)} MB in this window, with no drop back.` });
  }
  const loop = of("nodejs.eventloop.delay.p99");
  if (loop.length) {
    const behind = loop.filter((p) => p.v > 100).length;
    if (behind / loop.length > 0.2) notices.push({ tone: "bad", title: "The event loop is falling behind", text: `Over 100 ms in ${Math.round((behind / loop.length) * 100)}% of this window. Requests wait while it catches up.` });
  }
  return notices;
}

/** What was running at one moment on the chart. */
export async function whatRanHere(input: { env: string; at: number; instance?: string }) {
  const params = { from: dt(input.at - 60_000), to: dt(input.at + 60_000), env: input.env, inst: input.instance ?? "" };
  const rows = await query<{ id: string; traceId: string; taskId: string; kind: string; name: string; duration: number; outcome: string; t: number }>(
    `SELECT EventId AS id, TraceId AS traceId, TaskId AS taskId, Kind AS kind, if(Kind = 'task', TaskKind, concat(Method, ' ', Route)) AS name, DurationMs AS duration, Outcome AS outcome, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t FROM logs WHERE Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND Kind IN ('request', 'task') ${input.instance ? "AND InstanceId = {inst:String}" : ""} ORDER BY DurationMs DESC LIMIT 30`,
    { params },
  );
  return { from: input.at - 60_000, to: input.at + 60_000, rows };
}

/** Whether the host was struggling when a request ran. Compares the minutes around it with the hour before. */
export async function hostPressure(input: { env: string; at: number; service: string }) {
  const params = { near0: dt(input.at - 60_000), near1: dt(input.at + 60_000), base0: dt(input.at - 3_600_000), env: input.env, service: input.service };
  const rows = await query<{ name: string; near: number; base: number }>(
    `SELECT MetricName AS name, avgIf(Value, TimeUnix >= toDateTime64({near0:String}, 3)) AS near, avgIf(Value, TimeUnix < toDateTime64({near0:String}, 3)) AS base FROM metrics_gauge WHERE TimeUnix >= toDateTime64({base0:String}, 3) AND TimeUnix <= toDateTime64({near1:String}, 3) AND Environment = {env:String} AND ServiceName = {service:String} AND MetricName IN ('process.cpu.utilization', 'v8.heap.used', 'nodejs.eventloop.delay.p99') GROUP BY name`,
    { params },
  );
  const LABEL: Record<string, string> = { "process.cpu.utilization": "CPU", "v8.heap.used": "Heap", "v8js.memory.heap.used": "Heap", "nodejs.eventloop.delay.p99": "Event loop delay" };
  return rows.filter((row) => row.base > 0 && Number.isFinite(row.near) && row.near > row.base * 1.5).map((row) => ({ label: LABEL[row.name] ?? row.name, near: row.near, base: row.base }));
}

const REDIS = "(SpanAttributes['db.system'] = 'redis' OR SpanAttributes['db.system.name'] = 'redis')";
const KEY_PATTERN = "replaceRegexpAll(replaceRegexpAll(arrayElement(splitByChar(' ', SpanAttributes['redis.command']), 2), '[0-9a-f]{8}-[0-9a-f-]{27,}', '*'), '[0-9]{2,}', '*')";

/** Redis as the app uses it. A hit rate needs the app to say what hit, so it is only shown when spans carry cache.hit. */
export async function cachePage(input: ScopeInput) {
  const scope = scopeOf(input, 60);
  const params = scopeParams(scope);
  const scoped = `Timestamp >= toDateTime64({from:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND Environment = {env:String} AND ${REDIS}`;
  const hitSeries = await query<{ t: number; hit: number; miss: number }>(`SELECT ${bucketOf("Timestamp")} AS t, countIf(SpanAttributes['cache.hit'] = 'true') AS hit, countIf(SpanAttributes['cache.hit'] = 'false') AS miss FROM spans WHERE ${scoped} GROUP BY t ${fillTime}`, { params });
  const [stats, series, commands, keys, hits] = await Promise.all([
    query<{ calls: number; errors: number; avg: number; p95: number }>(`SELECT count() AS calls, countIf(StatusCode = 'Error') AS errors, avg(Duration) / 1e6 AS avg, quantile(0.95)(Duration) / 1e6 AS p95 FROM spans WHERE ${scoped}`, { params }),
    query<VolumePoint & { avg: number; p95: number }>(`SELECT ${bucketOf("Timestamp")} AS t, countIf(StatusCode != 'Error') AS ok, countIf(StatusCode = 'Error') AS error, avg(Duration) / 1e6 AS avg, quantile(0.95)(Duration) / 1e6 AS p95 FROM spans WHERE ${scoped} GROUP BY t ${fillTime}`, { params }),
    query<{ command: string; calls: number; errors: number; avg: number; p95: number }>(`SELECT upper(arrayElement(splitByChar(' ', multiIf(SpanAttributes['redis.command'] != '', SpanAttributes['redis.command'], SpanAttributes['db.operation.name'] != '', SpanAttributes['db.operation.name'], replaceRegexpOne(SpanName, '^redis[. ]', ''))), 1)) AS command, count() AS calls, countIf(StatusCode = 'Error') AS errors, avg(Duration) / 1e6 AS avg, quantile(0.95)(Duration) / 1e6 AS p95 FROM spans WHERE ${scoped} GROUP BY command ORDER BY calls DESC LIMIT 30`, { params }),
    query<{ key: string; calls: number; avg: number; p95: number; errors: number; total: number; hit: number; miss: number }>(`SELECT ${KEY_PATTERN} AS key, count() AS calls, avg(Duration) / 1e6 AS avg, quantile(0.95)(Duration) / 1e6 AS p95, countIf(StatusCode = 'Error') AS errors, sum(Duration) / 1e6 AS total, countIf(SpanAttributes['cache.hit'] = 'true') AS hit, countIf(SpanAttributes['cache.hit'] = 'false') AS miss FROM spans WHERE ${scoped} AND key != '' AND upper(arrayElement(splitByChar(' ', SpanAttributes['redis.command']), 1)) NOT IN ('EVALSHA', 'EVAL', 'CLIENT', 'INFO', 'MULTI', 'EXEC', 'SCRIPT', 'PING') GROUP BY key ORDER BY calls DESC LIMIT 30`, { params }),
    query<{ hit: number; miss: number }>(`SELECT countIf(SpanAttributes['cache.hit'] = 'true') AS hit, countIf(SpanAttributes['cache.hit'] = 'false') AS miss FROM spans WHERE ${scoped}`, { params }),
  ]);
  const known = (hits[0]?.hit ?? 0) + (hits[0]?.miss ?? 0);
  return { stats: stats[0] ?? { calls: 0, errors: 0, avg: 0, p95: 0 }, series, commands, keys, hitSeries, hits: hits[0] ?? { hit: 0, miss: 0 }, hitRate: known ? ((hits[0]!.hit / known) * 100) : null };
}

/** Commands the app ran, from the wide event each one writes. */
export async function commandsPage(input: ScopeInput) {
  const scope = scopeOf(input, 60);
  const params = scopeParams(scope);
  const scoped = `${where(scope)} AND Operation = 'command.run'`;
  const [rows, recent] = await Promise.all([
    query<{ name: string; runs: number; failed: number; avg: number; last: number }>(`SELECT LogAttributes['command.name'] AS name, count() AS runs, countIf(Outcome = 'failed') AS failed, avg(toFloat64OrZero(LogAttributes['command.durationMs'])) AS avg, toUnixTimestamp(max(Timestamp)) * 1000 AS last FROM logs WHERE ${scoped} GROUP BY name ORDER BY last DESC LIMIT 100`, { params }),
    query<{ id: string; t: number; name: string; args: string; exitCode: string; duration: number; outcome: string; service: string; error: string; traceId: string }>(`SELECT EventId AS id, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, LogAttributes['command.name'] AS name, LogAttributes['command.args'] AS args, LogAttributes['command.exitCode'] AS exitCode, toFloat64OrZero(LogAttributes['command.durationMs']) AS duration, Outcome AS outcome, ServiceName AS service, LogAttributes['error.message'] AS error, TraceId AS traceId FROM logs WHERE ${scoped} ORDER BY Timestamp DESC LIMIT 100`, { params }),
  ]);
  return { rows, recent };
}

export async function services(input: ScopeInput) {
  const scope = scopeOf(input, 26);
  const params = scopeParams(scope);
  const instanceRows = await query<{ name: string; id: string; version: string; events: number; lastSeen: number }>(`SELECT ServiceName AS name, InstanceId AS id, anyLast(ServiceVersion) AS version, count() AS events, toUnixTimestamp(max(Timestamp)) * 1000 AS lastSeen FROM logs WHERE ${where(scope)} AND InstanceId != '' GROUP BY name, id ORDER BY lastSeen DESC`, { params });
  const [rows, sparks] = await Promise.all([
    query<{ name: string; version: string; events: number; errors: number; p95: number; instances: number; lastSeen: number }>(`SELECT ServiceName AS name, anyLast(ServiceVersion) AS version, count() AS events, countIf(SeverityText IN ('error', 'fatal') OR (Outcome = 'failed' AND Kind = 'task')) AS errors, quantile(0.95)(DurationMs) AS p95, uniqExact(InstanceId) AS instances, toUnixTimestamp(max(Timestamp)) * 1000 AS lastSeen FROM logs WHERE ${where(scope)} GROUP BY name ORDER BY name`, { params }),
    query<{ name: string; t: number; n: number }>(`SELECT ServiceName AS name, ${bucketOf("Timestamp")} AS t, count() AS n FROM logs WHERE ${where(scope)} GROUP BY name, t ORDER BY t`, { params }),
  ]);
  const minutes = Math.max(1, (scope.to - scope.from) / 60000);
  return rows.map((r) => ({ ...r, perMinute: r.events / minutes, spark: fillBuckets(scope, sparks.filter((s) => s.name === r.name)), instanceRows: instanceRows.filter((i) => i.name === r.name) }));
}

export async function serviceMap(input: ScopeInput) {
  const scope = scopeOf(input);
  const params = scopeParams(scope);
  const [edges, nodes] = await Promise.all([
    query<{ caller: string; callee: string; kind: string; calls: number; errors: number }>(`SELECT Caller AS caller, Callee AS callee, CalleeKind AS kind, sum(Calls) AS calls, sum(Errors) AS errors FROM edges_5m WHERE Bucket >= toStartOfFiveMinutes(toDateTime64({from:String}, 3)) AND Bucket <= toDateTime64({to:String}, 3) AND Environment = {env:String} GROUP BY caller, callee, kind ORDER BY calls DESC LIMIT 200`, { params }),
    query<{ name: string; events: number; errors: number }>(`SELECT ServiceName AS name, count() AS events, countIf(SeverityText IN ('error', 'fatal') OR (Outcome = 'failed' AND Kind = 'task')) AS errors FROM logs WHERE ${where(scope)} GROUP BY name`, { params }),
  ]);
  return { services: nodes, edges: edges.map((e) => ({ ...e, name: registry.catalog.providers[e.callee] ?? e.callee })) };
}

export async function aiUsage(input: ScopeInput) {
  const scope = scopeOf(input, 60);
  const params = scopeParams(scope);
  const scoped = `${where(scope)} AND LogAttributes['ai.feature'] != ''`;
  const [previousCost, costSeries] = await Promise.all([
    query<{ cost: number; calls: number }>(`SELECT sum(${num("ai.costUsd")}) AS cost, count() AS calls FROM logs WHERE Timestamp >= toDateTime64({prevFrom:String}, 3) AND Timestamp < toDateTime64({from:String}, 3) AND Environment = {env:String} AND LogAttributes['ai.feature'] != ''`, { params: { ...params, prevFrom: prevFrom(scope) } }),
    query<{ t: number; cost: number }>(`SELECT ${bucketOf("Timestamp")} AS t, sum(${num("ai.costUsd")}) AS cost FROM logs WHERE ${scoped} GROUP BY t ${fillTime}`, { params }),
  ]);
  const [stats, features, failures, series] = await Promise.all([
    query<{ calls: number; tokens: number; cost: number; p95: number; failed: number }>(`SELECT count() AS calls, sum(${num("ai.tokens")}) AS tokens, sum(${num("ai.costUsd")}) AS cost, quantile(0.95)(${num("ai.durationMs")}) AS p95, countIf(LogAttributes['ai.outcome'] = 'failed') AS failed FROM logs WHERE ${scoped}`, { params }),
    query<{ feature: string; model: string; calls: number; cost: number; tokens: number; failed: number; p95: number }>(`SELECT LogAttributes['ai.feature'] AS feature, LogAttributes['ai.model'] AS model, count() AS calls, sum(${num("ai.costUsd")}) AS cost, sum(${num("ai.tokens")}) AS tokens, countIf(LogAttributes['ai.outcome'] = 'failed') AS failed, quantile(0.95)(${num("ai.durationMs")}) AS p95 FROM logs WHERE ${scoped} GROUP BY feature, model ORDER BY cost DESC LIMIT 40`, { params }),
    query<{ id: string; traceId: string; t: number; feature: string; error: string }>(`SELECT EventId AS id, TraceId AS traceId, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, LogAttributes['ai.feature'] AS feature, LogAttributes['ai.error'] AS error FROM logs WHERE ${scoped} AND LogAttributes['ai.outcome'] = 'failed' ORDER BY Timestamp DESC LIMIT 1 BY EventId LIMIT 20`, { params }),
    query<VolumePoint>(`SELECT ${bucketOf("Timestamp")} AS t, countIf(LogAttributes['ai.outcome'] != 'failed') AS ok, countIf(LogAttributes['ai.outcome'] = 'failed') AS error FROM logs WHERE ${scoped} GROUP BY t ${fillTime}`, { params }),
  ]);
  return { stats: stats[0] ?? { calls: 0, tokens: 0, cost: 0, p95: 0, failed: 0 }, features, failures, series, costSeries, previous: previousCost[0] ?? { cost: 0, calls: 0 } };
}

export async function users(input: ScopeInput) {
  const scope = scopeOf(input, 60);
  const params = scopeParams(scope);
  await loadPeople();
  const [rows, active] = await Promise.all([
    query<{ id: string; role: string; accountId: string; requests: number; errors: number; lastSeen: number }>(`SELECT UserId AS id, anyIf(LogAttributes['user.adminRole'], LogAttributes['user.adminRole'] != '') AS role, anyIf(AccountId, AccountId != '') AS accountId, count() AS requests, countIf(Status >= 500 OR SeverityText = 'error') AS errors, toUnixTimestamp(max(Timestamp)) * 1000 AS lastSeen FROM logs WHERE ${where(scope)} AND UserId != '' GROUP BY id ORDER BY requests DESC LIMIT 1000`, { params }),
    query<{ t: number; n: number }>(`SELECT ${bucketOf("Timestamp")} AS t, uniqExact(UserId) AS n FROM logs WHERE ${where(scope)} AND UserId != '' GROUP BY t ${fillTime}`, { params }),
  ]);
  return { rows: rows.map((r) => ({ ...r, name: personName(r.id) || r.id, account: accountName(r.accountId) || r.accountId })), active };
}

export async function user(input: ScopeInput & { id: string }) {
  const scope = scopeOf(input, 60);
  const params = { ...scopeParams(scope), id: input.id };
  await loadPeople();
  const [stats, events, tasks, slow] = await Promise.all([
    query<{ requests: number; errors: number; p95: number; role: string; accountId: string; tasks: number }>(`SELECT count() AS requests, countIf(Status >= 500 OR SeverityText = 'error') AS errors, quantile(0.95)(DurationMs) AS p95, anyIf(LogAttributes['user.adminRole'], LogAttributes['user.adminRole'] != '') AS role, anyIf(AccountId, AccountId != '') AS accountId, countIf(Kind = 'task') AS tasks FROM logs WHERE ${where(scope)} AND UserId = {id:String}`, { params }),
    query<{ id: string; traceId: string; t: number; method: string; route: string; status: number; duration: number; operation: string }>(`SELECT EventId AS id, TraceId AS traceId, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, Method AS method, Route AS route, Status AS status, DurationMs AS duration, Operation AS operation FROM logs WHERE ${where(scope)} AND UserId = {id:String} AND Kind = 'request' ORDER BY Timestamp DESC LIMIT 400`, { params }),
    query<{ id: string; kind: string; outcome: string; t: number }>(`SELECT TaskId AS id, TaskKind AS kind, argMax(Outcome, Timestamp) AS outcome, toUnixTimestamp(max(Timestamp)) * 1000 AS t FROM logs WHERE ${where(scope)} AND UserId = {id:String} AND Kind = 'task' GROUP BY id, kind ORDER BY t DESC LIMIT 10`, { params }),
    query<{ method: string; route: string; max: number }>(`SELECT Method AS method, Route AS route, max(DurationMs) AS max FROM logs WHERE ${where(scope)} AND UserId = {id:String} AND Kind = 'request' GROUP BY method, route ORDER BY max DESC LIMIT 5`, { params }),
  ]);
  const head = stats[0];
  if (!head?.requests) throw new HttpError(404, "This person has no activity in this time range.");
  return { id: input.id, name: personName(input.id) || input.id, account: accountName(head.accountId) || head.accountId, stats: head, events, tasks, slow };
}

export async function accounts(input: ScopeInput) {
  const scope = scopeOf(input);
  await loadPeople();
  const rows = await query<{ id: string; people: number; requests: number; failed: number; errors: number; p95: number; tasksFailed: number; lastSeen: number }>(`SELECT AccountId AS id, uniqExact(UserId) AS people, countIf(Kind = 'request') AS requests, countIf(Status >= 500) AS failed, countIf(Status >= 500) / greatest(countIf(Kind = 'request'), 1) * 100 AS errors, quantileIf(0.95)(DurationMs, Kind = 'request') AS p95, countIf(Kind = 'task' AND Outcome = 'failed') AS tasksFailed, toUnixTimestamp(max(Timestamp)) * 1000 AS lastSeen FROM logs WHERE ${where(scope)} AND AccountId != '' GROUP BY id ORDER BY requests DESC LIMIT 1000`, { params: scopeParams(scope) });
  return rows.map((r) => ({ ...r, name: accountName(r.id) || r.id }));
}

export async function apiKeys(input: ScopeInput) {
  const scope = scopeOf(input);
  const params = scopeParams(scope);
  await loadPeople();
  const scoped = `${where(scope)} AND LogAttributes['apiKey.id'] != ''`;
  const [stats, keys, denied] = await Promise.all([
    query<{ calls: number; errors: number; denied: number; active: number }>(`SELECT count() AS calls, countIf(Status >= 400) / greatest(count(), 1) * 100 AS errors, countIf(Outcome = 'denied') AS denied, uniqExact(LogAttributes['apiKey.id']) AS active FROM logs WHERE ${scoped}`, { params }),
    query<{ key: string; accountId: string; calls: number; errors: number; denied: number; lastUsed: number }>(`SELECT LogAttributes['apiKey.id'] AS key, any(AccountId) AS accountId, count() AS calls, countIf(Status >= 400) AS errors, countIf(Outcome = 'denied') AS denied, toUnixTimestamp(max(Timestamp)) * 1000 AS lastUsed FROM logs WHERE ${scoped} GROUP BY key ORDER BY calls DESC LIMIT 200`, { params }),
    query<{ reason: string; n: number }>(`SELECT LogAttributes['reason'] AS reason, count() AS n FROM logs WHERE ${scoped} AND Outcome = 'denied' GROUP BY reason ORDER BY n DESC LIMIT 20`, { params }),
  ]);
  return { stats: stats[0] ?? { calls: 0, errors: 0, denied: 0, active: 0 }, keys: keys.map((k) => ({ ...k, account: accountName(k.accountId) || k.accountId })), denied };
}
