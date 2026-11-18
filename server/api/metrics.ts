import { query, queryWithStats } from "../lib/clickhouse.ts";
import type { Json } from "../../sdk/index.ts";
import { dt, HttpError, scopeOf, scopeParams, type ScopeInput } from "./http.ts";

const UNION = `(SELECT MetricName, MetricUnit, MetricDescription, ServiceName, Environment, TimeUnix, 'Gauge' AS Type FROM metrics_gauge
  UNION ALL SELECT MetricName, MetricUnit, MetricDescription, ServiceName, Environment, TimeUnix, 'Sum' AS Type FROM metrics_sum
  UNION ALL SELECT MetricName, MetricUnit, MetricDescription, ServiceName, Environment, TimeUnix, 'Histogram' AS Type FROM metrics_histogram)`;

export async function metricList(input: ScopeInput) {
  const scope = scopeOf(input);
  return query<{ name: string; unit: string; description: string; type: "Gauge" | "Sum" | "Histogram"; lastSeen: number; points: number }>(
    `SELECT MetricName AS name, any(MetricUnit) AS unit, any(MetricDescription) AS description, any(Type) AS type, toUnixTimestamp(max(TimeUnix)) * 1000 AS lastSeen, count() AS points FROM ${UNION} WHERE TimeUnix >= toDateTime64({from:String}, 3) AND Environment = {env:String} GROUP BY name ORDER BY name`,
    { params: scopeParams(scope) },
  );
}

export async function metricAttributes(input: ScopeInput & { name: string }) {
  const scope = scopeOf(input);
  return query<{ key: string; values: number }>(
    `SELECT key, uniqExact(val) AS values FROM (SELECT arrayJoin(Attributes) AS kv, kv.1 AS key, kv.2 AS val FROM (SELECT Attributes, TimeUnix, Environment, MetricName FROM metrics_gauge UNION ALL SELECT Attributes, TimeUnix, Environment, MetricName FROM metrics_sum UNION ALL SELECT Attributes, TimeUnix, Environment, MetricName FROM metrics_histogram) WHERE MetricName = {name:String} AND Environment = {env:String} AND TimeUnix >= toDateTime64({from:String}, 3)) GROUP BY key ORDER BY key`,
    { params: { ...scopeParams(scope), name: input.name } },
  );
}

const AGG: Record<string, string> = { latest: "argMax(Value, TimeUnix)", avg: "avg(Value)", min: "min(Value)", max: "max(Value)", sum: "sum(Value)", rate: "sum(Value)" };
export type SeriesPoint = { t: number; series: string; v: number };

export async function metricSeries(input: ScopeInput & { name: string; type: string; agg: string; groupBy?: string; filters?: Record<string, string> }) {
  const scope = scopeOf(input);
  const { name, type, agg, groupBy } = input;
  const params: Record<string, any> = { ...scopeParams(scope), name, group: groupBy ?? "" };
  const group = groupBy === "service.name" ? "toString(ServiceName)" : groupBy ? "Attributes[{group:String}]" : "''";
  let cond = "MetricName = {name:String} AND Environment = {env:String} AND TimeUnix >= toDateTime64({from:String}, 3) AND TimeUnix <= toDateTime64({to:String}, 3)";
  Object.entries(input.filters ?? {}).forEach(([key, value], index) => {
    if (!/^[\w.\-]+$/.test(key)) throw new HttpError(400, "Bad attribute name");
    params[`fk${index}`] = key;
    params[`fv${index}`] = value;
    cond += ` AND Attributes[{fk${index}:String}] = {fv${index}:String}`;
  });
  const t = "toUnixTimestamp(toStartOfInterval(TimeUnix, toIntervalSecond({bucket:UInt32}))) * 1000";
  if (type === "Histogram") {
    if (agg === "avg" || agg === "count") return query<SeriesPoint>(`SELECT ${t} AS t, ${group} AS series, ${agg === "avg" ? "sum(Sum) / greatest(sum(Count), 1)" : "sum(Count)"} AS v FROM metrics_histogram WHERE ${cond} GROUP BY t, series ORDER BY t`, { params });
    params.q = Number(agg.replace("p", "")) / 100;
    return query<SeriesPoint>(
      `SELECT t, series, if(total = 0, 0, arrayElement(bounds, greatest(1, least(length(bounds), arrayFirstIndex(c -> c >= total * {q:Float64}, arrayCumSum(buckets)))))) AS v FROM (SELECT ${t} AS t, ${group} AS series, any(ExplicitBounds) AS bounds, sumForEach(BucketCounts) AS buckets, sum(Count) AS total FROM metrics_histogram WHERE ${cond} GROUP BY t, series) ORDER BY t`,
      { params },
    );
  }
  return query<SeriesPoint>(`SELECT ${t} AS t, ${group} AS series, ${AGG[agg] ?? AGG.avg} AS v FROM ${type === "Sum" ? "metrics_sum" : "metrics_gauge"} WHERE ${cond} GROUP BY t, series ORDER BY t`, { params });
}

/** What the console and agents may read. Anything else is refused by name, with the valid list. */
export const CONSOLE_TABLES: Record<string, string[]> = {
  events: ["Timestamp", "EventId", "TraceId", "ServiceName", "Environment", "ServiceVersion", "Kind", "Body", "Operation", "Outcome", "Status", "Method", "Route", "DurationMs", "TaskKind", "TaskId", "UserId", "AccountId", "Fingerprint", "Fields"],
  requests: ["Timestamp", "TraceId", "ServiceName", "Environment", "Method", "Route", "Status", "DurationMs", "Outcome", "DbQueries", "UserId", "AccountId"],
  task_attempts: ["Timestamp", "TaskId", "TaskKind", "Key", "Attempt", "Run", "Outcome", "Type", "Code", "Worker", "DurationMs", "SubjectType", "SubjectId", "CausedBy", "TraceId", "Environment", "AccountId"],
  queries: ["Timestamp", "TraceId", "ServiceName", "Environment", "Statement", "Hash", "DurationMs", "StatusCode", "TaskKind", "TaskId", "UserId", "AccountId"],
  provider_calls: ["Timestamp", "TraceId", "ServiceName", "Environment", "Provider", "Operation", "Host", "Status", "DurationMs", "Failed", "TaskKind", "TaskId"],
  task_mirror: ["Id", "Kind", "Key", "State", "AccountId", "SubjectType", "SubjectId", "RunAt", "Attempts", "Runs", "Code", "WaitReason", "CausedBy", "TraceId", "CreatedAt", "UpdatedAt", "SettledAt"],
  switch_changes: ["Key", "Enabled", "PreviousEnabled", "Reason", "UserId", "CreatedAt"],
  spans: ["Timestamp", "TraceId", "SpanId", "ParentSpanId", "SpanName", "SpanKind", "ServiceName", "Environment", "Duration", "StatusCode", "HttpRoute", "HttpStatus", "DbStatement", "PeerHost", "TaskKind", "UserId", "AccountId", "SpanAttributes"],
  logs: ["Timestamp", "TraceId", "SeverityText", "ServiceName", "Environment", "Kind", "Body", "Operation", "Outcome", "Status", "Method", "Route", "DurationMs", "DbQueries", "TaskKind", "TaskId", "UserId", "AccountId", "LogAttributes"],
  metrics_gauge: ["TimeUnix", "MetricName", "MetricUnit", "ServiceName", "Environment", "Attributes", "Value"],
  metrics_sum: ["TimeUnix", "MetricName", "ServiceName", "Environment", "Attributes", "Value"],
  metrics_histogram: ["TimeUnix", "MetricName", "ServiceName", "Environment", "Attributes", "Count", "Sum", "BucketCounts", "ExplicitBounds"],
  req_1m: ["Minute", "Environment", "ServiceName", "Method", "Route", "StatusClass", "Outcome", "Requests", "Duration", "Quantiles"],
  task_1m: ["Minute", "Environment", "TaskKind", "Outcome", "Attempts", "Duration", "Quantiles"],
  query_1m: ["Minute", "Environment", "ServiceName", "Hash", "Statement", "Operation", "Calls", "Errors", "Duration"],
  trace_index: ["TraceId", "Environment", "Day", "Start", "End", "Spans", "Errors", "Services"],
  edges_5m: ["Bucket", "Environment", "Caller", "Callee", "CalleeKind", "Calls", "Errors"],
};

export function checkConsoleSql(sql: string) {
  const clean = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(clean)) throw new HttpError(400, "Only SELECT queries run here.");
  if (clean.includes(";")) throw new HttpError(400, "Run one statement at a time.");
  const withNames = [...clean.matchAll(/\b(?:with|,)\s+(\w+)\s+as\s*\(/gi)].map((m) => m[1]!.toLowerCase());
  for (const match of clean.matchAll(/\b(?:from|join)\s+([`"\w.]+)/gi)) {
    const table = match[1]!.replace(/[`"]/g, "");
    if (withNames.includes(table.toLowerCase())) continue;
    if (!CONSOLE_TABLES[table]) throw new HttpError(400, `Unknown table ${table}. You can read: ${Object.keys(CONSOLE_TABLES).join(", ")}.`);
  }
  if (/\b(url|file|s3|remote|remoteSecure|mysql|postgresql|input|hdfs|azureBlobStorage|cluster|executable)\s*\(/i.test(clean)) throw new HttpError(400, "Table functions are not allowed here.");
  if (/system\./i.test(clean)) throw new HttpError(400, "System tables are not available here.");
  return clean;
}

export type ConsoleResult = { rows: Record<string, Json>[]; columns: { name: string; type: string }[]; elapsed: number; rowsRead: number };

export async function runConsole(input: ScopeInput & { sql: string }): Promise<ConsoleResult> {
  const scope = scopeOf(input, 60);
  const expanded = input.sql
    .replace(/\$__timeFilter\(([\w.]+)\)/g, (_, column) => `${column} >= toDateTime64({from:String}, 3) AND ${column} <= toDateTime64({to:String}, 3)`)
    .replace(/\$__bucket\(([\w.]+)\)/g, (_, column) => `toUnixTimestamp(toStartOfInterval(${column}, toIntervalSecond(${scope.bucket}))) * 1000`)
    .replace(/\$__env\b/g, "{env:String}");
  const sql = checkConsoleSql(expanded);
  const result = await queryWithStats<Record<string, Json>>(sql, { params: { from: dt(scope.from), to: dt(scope.to), env: scope.env }, timeout: 10, maxRows: 10_000 });
  return { rows: result.data, columns: result.meta, elapsed: Math.round(result.statistics.elapsed * 1000), rowsRead: result.statistics.rows_read };
}
