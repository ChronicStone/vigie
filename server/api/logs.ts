import { config } from "../config.ts";
import { query } from "../lib/clickhouse.ts";
import { subscribeLive } from "../ingest/pipeline.ts";
import { eventAsText, renderEvent, rowPhrases } from "../extensions/index.ts";
import { bucketOf, dt, fillTime, HttpError, route, scopeOf, scopeParams, where, type Scope, type ScopeInput } from "./http.ts";

/** Fields with their own column read far faster than the attribute map. */
const HOT: Record<string, string> = {
  level: "SeverityText", service: "ServiceName", "service.name": "ServiceName", version: "ServiceVersion", kind: "Kind", operation: "Operation", outcome: "Outcome", status: "Status", method: "Method",
  "route.pattern": "Route", route: "Route", durationMs: "DurationMs", duration: "DurationMs", "db.queries": "DbQueries", "task.kind": "TaskKind", "task.id": "TaskId", "user.id": "UserId", "workspace.accountId": "AccountId", traceId: "TraceId", "trace.id": "TraceId", message: "Body",
};
const NUMERIC = new Set(["Status", "DurationMs", "DbQueries"]);

export type LogOp = "is" | "not" | "contains" | "not_contains" | "starts" | "gt" | "gte" | "lt" | "lte" | "exists";
export type Filter = { field: string; op: LogOp; values: string[] };
/** The app logs a failed task attempt at info level. Whoever filters on errors still wants to see it. */
const LEVEL = "if(Outcome = 'failed' AND Kind = 'task', 'error', SeverityText)";

export type LogQuery = ScopeInput & { q?: string; filters?: Filter[]; level?: string; kind?: string };

export function filterSql(filters: Filter[], params: Record<string, any>) {
  return filters.map((filter, index) => {
    if (!/^[\w.\-]+$/.test(filter.field)) throw new HttpError(400, `Bad field name ${filter.field}`);
    const hot = HOT[filter.field];
    const name = `f${index}`;
    params[`${name}k`] = filter.field;
    const column = hot ?? `LogAttributes[{${name}k:String}]`;
    const numeric = hot ? NUMERIC.has(hot) : false;
    const text = numeric ? `toString(${column})` : column;
    switch (filter.op) {
      case "is":
      case "not":
        params[name] = filter.values;
        return `${text} ${filter.op === "is" ? "IN" : "NOT IN"} {${name}:Array(String)}`;
      case "contains":
      case "not_contains":
        params[name] = filter.values[0] ?? "";
        return `${filter.op === "contains" ? "" : "NOT "}positionCaseInsensitive(${text}, {${name}:String}) > 0`;
      case "starts":
        params[name] = filter.values[0] ?? "";
        return `startsWith(${text}, {${name}:String})`;
      case "exists":
        return hot ? `${text} != ''` : `mapContains(LogAttributes, {${name}k:String})`;
      default: {
        const symbol = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.op];
        params[name] = Number(filter.values[0] ?? 0);
        return `${numeric ? column : `toFloat64OrZero(${column})`} ${symbol} {${name}:Float64}`;
      }
    }
  });
}

/** Reads the search bar: text, `status>=500`, `path^/v1`, `service.name!=worker`, `user.id:abc`. */
export function parseSearch(text: string) {
  const filters: Filter[] = [];
  const free: string[] = [];
  const OPS: Record<string, LogOp> = { ">=": "gte", "<=": "lte", ">": "gt", "<": "lt", "!=": "not", "=": "is", ":": "is", "^": "starts", "~": "contains", "!~": "not_contains" };
  for (const token of text.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const match = token.match(/^([\w.\-]+)(>=|<=|!=|!~|=|:|>|<|\^|~)(.+)$/);
    if (!match) {
      free.push(token.replaceAll('"', ""));
      continue;
    }
    filters.push({ field: match[1]!, op: OPS[match[2]!]!, values: [match[3]!.replaceAll('"', "")] });
  }
  return { filters, text: free.join(" ") };
}

export function logFilter(input: LogQuery, scope: Scope, skipField?: string) {
  const params: Record<string, any> = { ...scopeParams(scope) };
  const parts = [where(scope)];
  const parsed = parseSearch(input.q ?? "");
  parts.push(...filterSql([...(input.filters ?? []), ...parsed.filters].filter((f) => f.field !== skipField), params));
  if (input.level && input.level !== "all" && skipField !== "level") {
    params.level = input.level === "error" ? ["error", "fatal"] : [input.level];
    parts.push(`${LEVEL} IN {level:Array(String)}`);
  }
  if (input.kind === "wide") parts.push("Kind != 'log'");
  if (input.kind === "plain") parts.push("Kind = 'log'");
  if (parsed.text) {
    params.text = parsed.text;
    parts.push("(positionCaseInsensitive(Body, {text:String}) > 0 OR arrayExists(v -> positionCaseInsensitive(v, {text:String}) > 0, mapValues(LogAttributes)))");
  }
  return { sql: parts.join(" AND "), params };
}

export type LogRow = { id: string; t: number; level: string; service: string; kind: string; body: string; method: string; route: string; status: number; duration: number; taskKind: string; outcome: string; traceId: string; why: string; userId: string; accountId: string; attrs: Record<string, string> };
const ROW = `EventId AS id, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, ${LEVEL} AS level, ServiceName AS service, Kind AS kind, Body AS body, Method AS method, Route AS route, Status AS status, DurationMs AS duration, TaskKind AS taskKind, Outcome AS outcome, TraceId AS traceId, LogAttributes['why'] AS why, UserId AS userId, AccountId AS accountId, LogAttributes AS attrs`;
const shape = ({ attrs, ...row }: LogRow) => ({ ...row, phrases: rowPhrases(attrs) });
export type LogListRow = ReturnType<typeof shape>;

export async function logRows(input: LogQuery & { before?: number; limit?: number }) {
  const scope = scopeOf(input);
  const { sql, params } = logFilter(input, scope);
  const limit = Math.min(input.limit ?? 200, 1000);
  const cursor = input.before ? " AND Timestamp < toDateTime64({before:String}, 3)" : "";
  if (input.before) params.before = dt(input.before);
  const rows = await query<LogRow>(`SELECT ${ROW} FROM logs WHERE ${sql}${cursor} ORDER BY Timestamp DESC LIMIT ${limit}`, { params });
  return { rows: rows.map(shape), next: rows.length === limit ? rows[rows.length - 1]!.t : null };
}

export async function logLevels(input: LogQuery) {
  const scope = scopeOf(input);
  const { sql, params } = logFilter(input, scope, "level");
  const rows = await query<{ level: string; c: number }>(`SELECT ${LEVEL} AS level, count() AS c FROM logs WHERE ${sql} GROUP BY level`, { params });
  const out = { all: 0, error: 0, warn: 0, info: 0, debug: 0 };
  for (const row of rows) {
    out.all += row.c;
    const key = (row.level === "fatal" ? "error" : row.level) as keyof typeof out;
    if (key in out) out[key] += row.c;
  }
  return out;
}

export type LevelPoint = { t: number; info: number; warn: number; error: number };
const LEVEL_POINTS = `${bucketOf("Timestamp")} AS t, countIf(${LEVEL} NOT IN ('error', 'fatal', 'warn')) AS info, countIf(${LEVEL} = 'warn') AS warn, countIf(${LEVEL} IN ('error', 'fatal')) AS error`;

/** The time spine: all volume in the scope, unfiltered. */
export async function timeline(input: ScopeInput) {
  const scope = scopeOf(input);
  return query<LevelPoint>(`SELECT ${LEVEL_POINTS} FROM logs WHERE ${where(scope)} GROUP BY t ${fillTime}`, { params: scopeParams(scope) });
}

export async function logFacet(input: LogQuery & { field: string }) {
  const scope = scopeOf(input);
  if (!/^[\w.\-]+$/.test(input.field)) throw new HttpError(400, "Bad field name");
  const { sql, params } = logFilter(input, scope, input.field);
  const hot = HOT[input.field];
  params.fk = input.field;
  const column = hot ? (NUMERIC.has(hot) ? `toString(${hot})` : hot) : "LogAttributes[{fk:String}]";
  return query<{ value: string; c: number }>(`SELECT ${column} AS value, count() AS c FROM logs WHERE ${sql} AND value != '' AND value != '0' GROUP BY value ORDER BY c DESC LIMIT 50`, { params });
}

export async function logFields(input: ScopeInput) {
  const scope = scopeOf(input);
  return query<{ field: string; c: number }>(`SELECT key AS field, count() AS c FROM (SELECT arrayJoin(mapKeys(LogAttributes)) AS key FROM logs WHERE ${where(scope)} ORDER BY Timestamp DESC LIMIT 100000) GROUP BY key ORDER BY c DESC LIMIT 200`, { params: scopeParams(scope) });
}

export type EventRecord = { id: string; t: number; level: string; service: string; version: string; instance: string; environment: string; kind: string; body: string; method: string; route: string; status: number; duration: number; taskKind: string; taskId: string; outcome: string; traceId: string; spanId: string; fingerprint: string; attrs: Record<string, string> };

export async function readEvent(id: string) {
  const [row] = await query<EventRecord>(
    `SELECT EventId AS id, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, SeverityText AS level, ServiceName AS service, ServiceVersion AS version, InstanceId AS instance, Environment AS environment, Kind AS kind, Body AS body, Method AS method, Route AS route, Status AS status, DurationMs AS duration, TaskKind AS taskKind, TaskId AS taskId, Outcome AS outcome, TraceId AS traceId, SpanId AS spanId, Fingerprint AS fingerprint, LogAttributes AS attrs FROM logs WHERE EventId = {id:String} LIMIT 1`,
    { params: { id } },
  );
  if (!row) throw new HttpError(404, "This event no longer exists.");
  return row;
}

export async function logEvent(id: string) {
  const event = await readEvent(id);
  return { ...event, view: renderEvent(event.attrs), summary: eventAsText(event.attrs) };
}

export async function sameService(input: ScopeInput & { service: string; at: number }) {
  const rows = await query<LogRow>(`SELECT ${ROW} FROM logs WHERE ServiceName = {service:String} AND Timestamp <= toDateTime64({at:String}, 3) AND Environment = {env:String} ORDER BY Timestamp DESC LIMIT 30`, { params: { service: input.service, at: dt(input.at), env: input.env } });
  return rows.map(shape);
}

/** Live tail over SSE. A slow client just misses rows: the stream never buffers without limit. */
route("GET", "/api/live", "viewer", ({ url, request }) => {
  const env = url.searchParams.get("env") ?? config.mainEnvironment;
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (rows: any[]) => {
        const items = rows
          .filter((r) => r.Environment === env)
          .map((r): LogListRow => {
            const a = r.LogAttributes as Record<string, string>;
            return {
              id: r.EventId,
              t: Date.parse(`${String(r.Timestamp).slice(0, 23).replace(" ", "T")}Z`),
              level: r.SeverityText,
              service: r.ServiceName,
              kind: a.method ? "request" : a["task.kind"] ? "task" : a.operation ? "operation" : "log",
              body: r.Body,
              method: a.method ?? "",
              route: a["route.pattern"] ?? "",
              status: Number(a.status ?? 0),
              duration: Number(a.durationMs ?? 0),
              taskKind: a["task.kind"] ?? "",
              outcome: a.outcome ?? "",
              traceId: r.TraceId,
              why: a.why ?? "",
              userId: a["user.id"] ?? "",
              accountId: a["workspace.accountId"] ?? "",
              phrases: rowPhrases(a),
            };
          });
        if (items.length && (controller.desiredSize ?? 1) > 0) controller.enqueue(encoder.encode(`data: ${JSON.stringify(items)}\n\n`));
      };
      const unsubscribe = subscribeLive(send);
      const beat = setInterval(() => controller.enqueue(encoder.encode(": beat\n\n")), 20_000);
      stop = () => {
        unsubscribe();
        clearInterval(beat);
      };
      request.signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
});
