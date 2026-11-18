import { config } from "../config.ts";
import { accountName, appDb, loadPeople, personName, readOnly } from "../lib/appdb.ts";
import { query } from "../lib/clickhouse.ts";
import { backlog } from "./tasks.ts";
import { minuteWhere, previousMinutes, queries } from "./backend.ts";
import { bucketOf, fillTime, scopeOf, scopeParams, where, type Scope, type ScopeInput } from "./http.ts";

/**
 * The Overview dashboard, one function per section. The page asks for a section only when it scrolls near,
 * so opening it costs the first screen and ClickHouse never answers ten sections it did not need to.
 */
const QUANTILES = "quantilesTDigestMerge(0.5, 0.95, 0.99)(Quantiles)";
const TASK_QUANTILES = "quantilesTDigestMerge(0.5, 0.95)(Quantiles)";

/** Every lane on a page shares one clock, so every section must slice time the same way. */
const POINTS = 72;
const scopeFor = (input: ScopeInput) => scopeOf(input, POINTS);

type ServicePoint = { t: number; service: string; v: number };
export type ServiceRow = { t: number } & Record<string, number>;

/**
 * A service can run several instances, and one of them leaking is what matters, so each moment shows its worst
 * instance. A reading can come in parts (a heap reports one row per space), which add up first.
 */
const worstInstance = (scope: Scope, metric: string, unit: number) => {
  const params = { ...scopeParams(scope), metric };
  return query<ServicePoint>(
    `SELECT t, service, max(v) / ${unit} AS v FROM (
       SELECT ${bucketOf("at")} AS t, service, instance, avg(reading) AS v FROM (
         SELECT TimeUnix AS at, ServiceName AS service, Attributes['service.instance.id'] AS instance, sum(Value) AS reading
         FROM metrics_gauge WHERE MetricName = {metric:String} AND ${where(scope, "TimeUnix")} GROUP BY at, service, instance
       ) GROUP BY t, service, instance
     ) GROUP BY t, service ORDER BY t`,
    { params },
  );
};

/** One row per moment with one key per service, the shape a chart takes. */
function perService(points: ServicePoint[]) {
  const rows = new Map<number, ServiceRow>();
  for (const point of points) {
    const row = rows.get(point.t) ?? ({ t: point.t } as ServiceRow);
    row[point.service] = Math.round(point.v * 100) / 100;
    rows.set(point.t, row);
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}

function readings(points: ServicePoint[]) {
  const byService = new Map<string, { now: number; peak: number; at: number }>();
  for (const point of points) {
    const found = byService.get(point.service) ?? { now: 0, peak: 0, at: 0 };
    if (point.t >= found.at) Object.assign(found, { now: point.v, at: point.t });
    found.peak = Math.max(found.peak, point.v);
    byService.set(point.service, found);
  }
  return [...byService].map(([service, value]) => ({ service, now: value.now, peak: value.peak })).sort((a, b) => a.service.localeCompare(b.service));
}

const MB = 1_048_576;
/** This app's own age and depth of tasks waiting. All its workers report the same totals, so the highest reading is the total. */
const backlogSeries = (scope: Scope) =>
  query<{ t: number; due: number; scheduled: number; running: number }>(
    `SELECT t, maxIf(v, state = 'due') AS due, maxIf(v, state = 'scheduled') AS scheduled, maxIf(v, state = 'running') AS running FROM (
       SELECT ${bucketOf("at")} AS t, instance, state, avg(reading) AS v FROM (
         SELECT TimeUnix AS at, Attributes['service.instance.id'] AS instance, Attributes['task.state'] AS state, sum(Value) AS reading
         FROM metrics_gauge WHERE MetricName = '${config.taskMetrics}.backlog' AND ${where(scope, "TimeUnix")} GROUP BY at, instance, state
       ) GROUP BY t, instance, state
     ) GROUP BY t ORDER BY t`,
    { params: scopeParams(scope) },
  );
const oldestWaitSeries = (scope: Scope) =>
  query<{ t: number; wait: number }>(`SELECT ${bucketOf("TimeUnix")} AS t, max(Value) * 1000 AS wait FROM metrics_gauge WHERE MetricName = '${config.taskMetrics}.oldest_due_age' AND ${where(scope, "TimeUnix")} GROUP BY t ORDER BY t`, { params: scopeParams(scope) });

const share = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);

export async function overviewTraffic(input: ScopeInput) {
  const scope = scopeFor(input);
  const params = scopeParams(scope);
  const heatScope = scopeOf(input, 48);
  const before = new Date(scope.from - (scope.to - scope.from)).toISOString().slice(0, 23).replace("T", " ");
  const [series, stats, routes, heat, people, deploys] = await Promise.all([
    query<{ t: number; ok: number; warn: number; error: number; p50: number; p95: number; p99: number }>(`SELECT ${bucketOf("Minute")} AS t, sumIf(Requests, StatusClass < 400) AS ok, sumIf(Requests, StatusClass = 400) AS warn, sumIf(Requests, StatusClass >= 500) AS error, ${QUANTILES}[1] AS p50, ${QUANTILES}[2] AS p95, ${QUANTILES}[3] AS p99 FROM req_1m WHERE ${minuteWhere(scope)} GROUP BY t ${fillTime}`, { params }),
    query<{ requests: number; ok: number; warn: number; error: number; denied: number; p50: number; p95: number; p99: number }>(`SELECT sum(Requests) AS requests, sumIf(Requests, StatusClass < 400) AS ok, sumIf(Requests, StatusClass = 400) AS warn, sumIf(Requests, StatusClass >= 500) AS error, sumIf(Requests, Outcome = 'denied') AS denied, ${QUANTILES}[1] AS p50, ${QUANTILES}[2] AS p95, ${QUANTILES}[3] AS p99 FROM req_1m WHERE ${minuteWhere(scope)}`, { params }),
    query<{ method: string; route: string; count: number; failed: number; p95: number }>(`SELECT Method AS method, Route AS route, sum(Requests) AS count, sumIf(Requests, StatusClass >= 500) AS failed, ${QUANTILES}[2] AS p95 FROM req_1m WHERE ${minuteWhere(scope)} AND Route != '' GROUP BY method, route ORDER BY count DESC LIMIT 200`, { params }),
    // Five rows per power of ten: 1 ms at the bottom, past 10 s at the top.
    query<{ t: number; y: number; n: number }>(`SELECT ${bucketOf("Timestamp")} AS t, least(greatest(floor(log10(greatest(DurationMs, 1)) * 5), 0), 21) AS y, count() AS n FROM logs WHERE ${where(heatScope)} AND Kind = 'request' GROUP BY t, y ORDER BY t, y`, { params: scopeParams(heatScope) }),
    query<{ n: number }>(`SELECT uniqExact(UserId) AS n FROM logs WHERE ${where(scope)} AND UserId != ''`, { params }),
    // A version counts as deployed here only if nothing ran it during the same length of time before this window.
    query<{ version: string; service: string; t: number }>(`SELECT ServiceVersion AS version, ServiceName AS service, toUnixTimestamp(min(Timestamp)) * 1000 AS t FROM logs WHERE Environment = {env:String} AND Timestamp >= toDateTime64({before:String}, 3) AND Timestamp <= toDateTime64({to:String}, 3) AND ServiceVersion != '' GROUP BY version, service HAVING t >= toUnixTimestamp(toDateTime64({from:String}, 3)) * 1000 ORDER BY t DESC LIMIT 12`, { params: { ...params, before } }),
  ]);
  const top = (sort: (typeof routes)[number] extends infer R ? (a: R, b: R) => number : never) => [...routes].sort(sort).slice(0, 5);
  return {
    series: series.map((p) => ({ ...p, rate: share(p.error, p.ok + p.warn + p.error) })),
    stats: stats[0] ?? { requests: 0, ok: 0, warn: 0, error: 0, denied: 0, p50: 0, p95: 0, p99: 0 },
    heat,
    heatStep: heatScope.bucket * 1000,
    people: people[0]?.n ?? 0,
    deploys,
    busiest: routes.slice(0, 5),
    slowest: top((a, b) => b.p95 - a.p95),
    failing: routes.filter((r) => r.failed > 0).sort((a, b) => b.failed - a.failed).slice(0, 5),
  };
}

export async function overviewTasks(input: ScopeInput) {
  const scope = scopeFor(input);
  const params = scopeParams(scope);
  const taskScope = minuteWhere({ ...scope, services: [] });
  const [series, kinds, stats, waiting, oldest, now] = await Promise.all([
    query<{ t: number; done: number; skipped: number; failed: number; p50: number; p95: number }>(`SELECT ${bucketOf("Minute")} AS t, sumIf(Attempts, Outcome = 'succeeded') AS done, sumIf(Attempts, Outcome = 'skipped') AS skipped, sumIf(Attempts, Outcome = 'failed') AS failed, ${TASK_QUANTILES}[1] AS p50, ${TASK_QUANTILES}[2] AS p95 FROM task_1m WHERE ${taskScope} GROUP BY t ${fillTime}`, { params }),
    query<{ kind: string; attempts: number; failed: number; p95: number }>(`SELECT TaskKind AS kind, sum(Attempts) AS attempts, sumIf(Attempts, Outcome = 'failed') AS failed, ${TASK_QUANTILES}[2] AS p95 FROM task_1m WHERE ${taskScope} GROUP BY kind ORDER BY attempts DESC LIMIT 200`, { params }),
    query<{ attempts: number; done: number; skipped: number; failed: number; p50: number; p95: number }>(`SELECT sum(Attempts) AS attempts, sumIf(Attempts, Outcome = 'succeeded') AS done, sumIf(Attempts, Outcome = 'skipped') AS skipped, sumIf(Attempts, Outcome = 'failed') AS failed, ${TASK_QUANTILES}[1] AS p50, ${TASK_QUANTILES}[2] AS p95 FROM task_1m WHERE ${taskScope}`, { params }),
    backlogSeries(scope),
    oldestWaitSeries(scope),
    backlog(scope),
  ]);
  return {
    series,
    waiting,
    oldest,
    stats: stats[0] ?? { attempts: 0, done: 0, skipped: 0, failed: 0, p50: 0, p95: 0 },
    now,
    oldestPeak: Math.max(0, ...oldest.map((p) => p.wait)),
    busiest: kinds.slice(0, 5),
    slowest: [...kinds].sort((a, b) => b.p95 - a.p95).slice(0, 5),
    failing: kinds.filter((k) => k.failed > 0).sort((a, b) => b.failed - a.failed).slice(0, 5),
  };
}

export async function overviewRuntime(input: ScopeInput) {
  const scope = scopeFor(input);
  const params = scopeParams(scope);
  const [heap, loop, pool, instances] = await Promise.all([
    worstInstance(scope, "v8js.memory.heap.used", MB),
    worstInstance(scope, "nodejs.eventloop.delay.p99", 0.001),
    // Connections held by every instance add up: they all draw from the one database.
    query<{ t: number; used: number; idle: number; waiting: number }>(
      `SELECT t, sumIf(v, state = 'used') AS used, sumIf(v, state = 'idle') AS idle, sumIf(v, state = 'pending') AS waiting FROM (
         SELECT ${bucketOf("TimeUnix")} AS t, Attributes['service.instance.id'] AS instance, if(MetricName = 'db.client.connection.pending_requests', 'pending', Attributes['db.client.connection.state']) AS state, avg(Value) AS v
         FROM metrics_sum WHERE MetricName IN ('db.client.connection.count', 'db.client.connection.pending_requests') AND ${where(scope, "TimeUnix")} GROUP BY t, instance, state
       ) GROUP BY t ORDER BY t`,
      { params },
    ),
    query<{ instance: string; service: string; seen: number; heap: number; loop: number }>(
      `SELECT instance, any(service) AS service, max(at) AS seen, argMaxIf(reading, at, name = 'v8js.memory.heap.used') / ${MB} AS heap, argMaxIf(reading, at, name = 'nodejs.eventloop.delay.p99') * 1000 AS loop FROM (
         SELECT TimeUnix AS raw, toUnixTimestamp(TimeUnix) * 1000 AS at, MetricName AS name, ServiceName AS service, Attributes['service.instance.id'] AS instance, sum(Value) AS reading
         FROM metrics_gauge WHERE MetricName IN ('v8js.memory.heap.used', 'nodejs.eventloop.delay.p99') AND ${where(scope, "TimeUnix")} GROUP BY raw, at, name, service, instance
       ) WHERE instance != '' GROUP BY instance ORDER BY service, seen DESC LIMIT 12`,
      { params },
    ),
  ]);
  const last = pool[pool.length - 1];
  const newest = Math.max(0, ...instances.map((row) => row.seen));
  const running = instances.filter((row) => newest - row.seen < 5 * 60_000);
  return {
    heap: { services: readings(heap), series: perService(heap) },
    loop: { services: readings(loop), series: perService(loop) },
    pool: { series: pool, used: last?.used ?? 0, idle: last?.idle ?? 0, waiting: last?.waiting ?? 0, peak: Math.max(0, ...pool.map((p) => p.used + p.idle)) },
    instances: running,
    replaced: instances.length - running.length,
  };
}

export type PostgresNow = { size: number; connections: number; hitRate: number; deadlocks: number; tables: { name: string; size: number; rows: number }[] };

/** The database itself, asked directly. Only the environment Vigie's read-only role belongs to can answer. */
async function postgresNow(env: string): Promise<PostgresNow | null> {
  if (!appDb() || env !== config.mainEnvironment) return null;
  try {
    const [[database], tables] = await Promise.all([
      readOnly<{ size: string; connections: number; hit: number | null; deadlocks: string }>(`SELECT pg_database_size(current_database()) AS size, numbackends AS connections, blks_hit::float8 / nullif(blks_hit + blks_read, 0) AS hit, deadlocks FROM pg_stat_database WHERE datname = current_database()`, [], 3000),
      readOnly<{ name: string; size: string; rows: number }>(`SELECT relname AS name, pg_total_relation_size(c.oid) AS size, reltuples::bigint AS rows FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 5`, [], 3000),
    ]);
    if (!database) return null;
    return { size: Number(database.size), connections: Number(database.connections), hitRate: (database.hit ?? 0) * 100, deadlocks: Number(database.deadlocks), tables: tables.map((t) => ({ name: t.name, size: Number(t.size), rows: Math.max(0, Number(t.rows)) })) };
  } catch {
    return null;
  }
}

export async function overviewDatabase(input: ScopeInput) {
  const scope = scopeFor(input);
  const params = scopeParams(scope);
  const [{ stats, series, repeated }, patterns, postgres] = await Promise.all([
    queries({ ...input }),
    query<{ hash: string; statement: string; calls: number; total: number; p95: number }>(`SELECT toString(Hash) AS hash, any(Statement) AS statement, sum(Calls) AS calls, sum(Duration) AS total, quantilesTDigestMerge(0.5, 0.95)(Quantiles)[2] AS p95 FROM query_1m WHERE ${minuteWhere(scope)} GROUP BY Hash ORDER BY total DESC LIMIT 200`, { params }),
    postgresNow(input.env),
  ]);
  return { stats, series, heaviest: patterns.slice(0, 5), slowest: [...patterns].sort((a, b) => b.p95 - a.p95).slice(0, 5), repeated: repeated.slice(0, 5), postgres };
}

export async function overviewPeople(input: ScopeInput) {
  const scope = scopeFor(input);
  const params = scopeParams(scope);
  await loadPeople();
  const [series, totals, accounts, active] = await Promise.all([
    query<{ t: number; people: number }>(`SELECT ${bucketOf("Timestamp")} AS t, uniqExactIf(UserId, UserId != '') AS people FROM logs WHERE ${where(scope)} GROUP BY t ${fillTime}`, { params }),
    query<{ people: number; accounts: number }>(`SELECT uniqExactIf(UserId, UserId != '') AS people, uniqExactIf(AccountId, AccountId != '') AS accounts FROM logs WHERE ${where(scope)}`, { params }),
    query<{ id: string; events: number; errors: number }>(`SELECT AccountId AS id, count() AS events, countIf(Status >= 500 OR SeverityText = 'error') AS errors FROM logs WHERE ${where(scope)} AND AccountId != '' GROUP BY id ORDER BY events DESC LIMIT 100`, { params }),
    query<{ id: string; events: number }>(`SELECT UserId AS id, count() AS events FROM logs WHERE ${where(scope)} AND UserId != '' GROUP BY id ORDER BY events DESC LIMIT 5`, { params }),
  ]);
  const named = accounts.map((row) => ({ ...row, name: accountName(row.id) || row.id }));
  return { series, people: totals[0]?.people ?? 0, accounts: totals[0]?.accounts ?? 0, busiest: named.slice(0, 5), troubled: named.filter((row) => row.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 5), active: active.map((row) => ({ ...row, name: personName(row.id) || row.id })) };
}
