import { query } from "../lib/clickhouse.ts";
import { dt, HttpError, scopeOf, scopeParams, type Scope, type ScopeInput } from "./http.ts";

const dayWhere = "Day >= toDate(toDateTime64({from:String}, 3)) AND Day <= toDate(toDateTime64({to:String}, 3)) AND Environment = {env:String}";

export type TraceRow = { id: string; t: number; duration: number; spans: number; errors: number; services: string[]; root: string; status: number; route: string; method: string; taskKind: string };

export async function traceList(input: ScopeInput & { q?: string; filter?: string; kind?: string; sort?: string; before?: number; offset?: number; limit?: number }) {
  const scope = scopeOf(input);
  const params: Record<string, any> = { ...scopeParams(scope) };
  const having = ["S >= toDateTime64({from:String}, 3)", "S <= toDateTime64({to:String}, 3)"];
  if (input.filter === "error") having.push("ErrorCount > 0");
  if (input.filter === "ok") having.push("ErrorCount = 0");
  if (input.kind === "request") having.push("MethodName != ''");
  if (input.kind === "task") having.push("Task != ''");
  let free = (input.q ?? "").trim();
  const minMs = free.match(/duration>(\d+)(ms|s)?/);
  if (minMs) {
    params.minNs = Number(minMs[1]) * (minMs[2] === "s" ? 1e9 : 1e6);
    having.push("DurationNs >= {minNs:UInt64}");
    free = free.replace(minMs[0], "").trim();
  }
  if (free) {
    params.text = free;
    having.push("(positionCaseInsensitive(RootName, {text:String}) > 0 OR TraceId = {text:String} OR positionCaseInsensitive(RouteName, {text:String}) > 0)");
  }
  if (scope.services.length) having.push("hasAny(Svc, {services:Array(String)})");
  if (input.before) {
    params.before = dt(input.before);
    having.push("S < toDateTime64({before:String}, 3)");
  }
  const order = input.sort === "duration" ? "DurationNs DESC" : "S DESC";
  const limit = Math.min(input.limit ?? 200, 500);
  const rows = await query<TraceRow>(
    `SELECT TraceId AS id, toUnixTimestamp64Milli(toDateTime64(S, 3)) AS t, DurationNs / 1e6 AS duration, SpanCount AS spans, ErrorCount AS errors, Svc AS services, RootName AS root, StatusCode AS status, RouteName AS route, MethodName AS method, Task AS taskKind FROM (
       SELECT TraceId, min(Start) AS S, max(End) AS E, sum(Spans) AS SpanCount, sum(Errors) AS ErrorCount, groupUniqArrayArray(Services) AS Svc,
         argMinIfMerge(Root) AS RootName, maxIfMerge(RootStatus) AS StatusCode, argMinIfMerge(RootRoute) AS RouteName, argMinIfMerge(RootMethod) AS MethodName, argMinIfMerge(RootTask) AS Task,
         dateDiff('nanosecond', S, E) AS DurationNs
       FROM trace_index WHERE ${dayWhere} GROUP BY TraceId
     ) WHERE ${having.join(" AND ")} ORDER BY ${order} LIMIT ${limit}${input.offset ? ` OFFSET ${Math.max(0, Math.floor(input.offset))}` : ""}`,
    { params },
  );
  return { rows, next: rows.length === limit && input.sort !== "duration" ? rows[rows.length - 1]!.t : null };
}

export async function traceCounts(input: ScopeInput) {
  const scope = scopeOf(input);
  const [row] = await query<{ all: number; error: number; ok: number }>(
    `SELECT count() AS all, countIf(Errors > 0) AS error, countIf(Errors = 0) AS ok FROM (SELECT TraceId, sum(Errors) AS Errors, min(Start) AS S FROM trace_index WHERE ${dayWhere} GROUP BY TraceId HAVING S >= toDateTime64({from:String}, 3) AND S <= toDateTime64({to:String}, 3))`,
    { params: scopeParams(scope) },
  );
  return row ?? { all: 0, error: 0, ok: 0 };
}

export type SpanRow = { id: string; parent: string; traceId: string; name: string; kind: string; service: string; version: string; start: number; duration: number; status: string; message: string; attrs: Record<string, string>; statement: string; hash: string; peer: string; httpStatus: number; taskKind: string };
export type TraceLog = { id: string; t: number; level: string; service: string; spanId: string; body: string; kind: string; outcome: string; duration: number; why: string; fix: string; attrs: Record<string, string> };

const SPAN = `TraceId AS traceId, SpanId AS id, ParentSpanId AS parent, SpanName AS name, SpanKind AS kind, ServiceName AS service, ServiceVersion AS version, toUnixTimestamp64Micro(toDateTime64(Timestamp, 6)) / 1000 AS start, Duration / 1e6 AS duration, StatusCode AS status, StatusMessage AS message, SpanAttributes AS attrs, DbStatement AS statement, toString(DbStatementHash) AS hash, PeerHost AS peer, HttpStatus AS httpStatus, TaskKind AS taskKind`;
const LOG = `EventId AS id, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, SeverityText AS level, ServiceName AS service, SpanId AS spanId, Body AS body, Kind AS kind, Outcome AS outcome, DurationMs AS duration, LogAttributes['why'] AS why, LogAttributes['fix'] AS fix, LogAttributes AS attrs`;

export async function readTrace(id: string) {
  const [spans, logs] = await Promise.all([
    query<SpanRow>(`SELECT ${SPAN} FROM spans WHERE TraceId = {id:String} ORDER BY Timestamp LIMIT 5001`, { params: { id } }),
    query<TraceLog>(`SELECT ${LOG} FROM logs WHERE TraceId = {id:String} ORDER BY Timestamp LIMIT 500`, { params: { id } }),
  ]);
  return { spans, logs, truncated: spans.length > 5000 };
}

export async function traceDetail(id: string) {
  const trace = await readTrace(id);
  if (!trace.spans.length && !trace.logs.length) throw new HttpError(404, "This trace has no spans or logs left.");
  return trace;
}

export async function readTraces(ids: string[]) {
  if (!ids.length) return { spans: [] as SpanRow[], logs: [] as (TraceLog & { traceId: string })[] };
  const [spans, logs] = await Promise.all([
    query<SpanRow>(`SELECT ${SPAN} FROM spans WHERE TraceId IN {ids:Array(String)} ORDER BY Timestamp LIMIT 5000`, { params: { ids } }),
    query<TraceLog & { traceId: string }>(`SELECT TraceId AS traceId, ${LOG} FROM logs WHERE TraceId IN {ids:Array(String)} AND Kind = 'log' ORDER BY Timestamp LIMIT 300`, { params: { ids } }),
  ]);
  return { spans, logs };
}
