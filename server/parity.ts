/**
 * Compares this Vigie with the HyperDX ClickHouse it is replacing, while both receive the same traffic.
 * Reads only. Exit code 1 when anything is past its limit, so it can gate the cutover.
 */
export type Side = { url: string; user: string; password: string; database: string };
export type ParityCheck = { name: string; limit: number; hyperdx: string; vigie: string };
export type ParityRow = { name: string; key: string; hyperdx: number; vigie: number; diff: number; ok: boolean };

const COUNT_LIMIT = 1;
const TILE_LIMIT = 2;

/** Both sides store OTel's flattened attributes, so one expression reads both. Only the table names differ. */
const same = (name: string, limit: number, key: string, table: "logs" | "traces" | "gauge", where = "1"): ParityCheck => {
  const time = table === "gauge" ? "TimeUnix" : "Timestamp";
  // HyperDX also reports on its own ClickHouse and collector. Those were never going to reach Vigie.
  const sql = (from: string) => `SELECT ${key} AS key, count() AS v FROM ${from} WHERE ${time} >= {from:DateTime64(3)} AND ${time} < {to:DateTime64(3)} AND ServiceName NOT IN ('clickhouse', 'otelcol-hyperdx') AND ${where} GROUP BY key`;
  return { name, limit, hyperdx: sql({ logs: "otel_logs", traces: "otel_traces", gauge: "otel_metrics_gauge" }[table]), vigie: sql({ logs: "logs", traces: "spans", gauge: "metrics_gauge" }[table]) };
};

const attr = (key: string) => `LogAttributes['${key}']`;
const REQUEST = `ServiceName = 'acme-api' AND ${attr("method")} != ''`;
const TASK = `ServiceName = 'acme-worker' AND ${attr("task.id")} != ''`;
const ROUTE = `concat(${attr("method")}, ' ', if(${attr("route.pattern")} != '', ${attr("route.pattern")}, '(no route)'))`;

/**
 * The plan's exit checks: counts per service within 1 percent, tiles within 2.
 * Filters are the ones the HyperDX dashboards use, from tools/observability/hyperdx/fields.ts in the app repo.
 */
export const PARITY_CHECKS: ParityCheck[] = [
  same("Events per service", COUNT_LIMIT, "ServiceName", "logs"),
  same("Spans per service", COUNT_LIMIT, "ServiceName", "traces"),
  same("Gauge points per service", COUNT_LIMIT, "ServiceName", "gauge"),
  same("Requests by route", TILE_LIMIT, ROUTE, "logs", REQUEST),
  same("Server errors by route", TILE_LIMIT, ROUTE, "logs", `${REQUEST} AND toUInt16OrZero(${attr("status")}) >= 500`),
  same("Task attempts by kind", TILE_LIMIT, attr("task.kind"), "logs", TASK),
  same("Failed attempts by kind", TILE_LIMIT, attr("task.kind"), "logs", `${TASK} AND ${attr("outcome")} = 'failed'`),
  same("Error events by service", TILE_LIMIT, "ServiceName", "logs", "lower(SeverityText) IN ('error', 'fatal')"),
];

async function run(side: Side, sql: string, from: number, to: number) {
  const url = new URL(side.url);
  url.searchParams.set("output_format_json_quote_64bit_integers", "0");
  url.searchParams.set("database", side.database);
  url.searchParams.set("default_format", "JSONEachRow");
  url.searchParams.set("readonly", "1");
  url.searchParams.set("param_from", (from / 1000).toFixed(3));
  url.searchParams.set("param_to", (to / 1000).toFixed(3));
  const response = await fetch(url, { method: "POST", body: sql, headers: { "X-ClickHouse-User": side.user, "X-ClickHouse-Key": side.password }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error((await response.text()).slice(0, 300));
  const text = await response.text();
  return flattenRows(text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : []);
}

export function compare(name: string, limit: number, hyperdx: Map<string, number>, vigie: Map<string, number>): ParityRow[] {
  return [...new Set([...hyperdx.keys(), ...vigie.keys()])].sort().map((key) => {
    const a = hyperdx.get(key) ?? 0;
    const b = vigie.get(key) ?? 0;
    const diff = a === b ? 0 : (Math.abs(a - b) / Math.max(a, b, 1)) * 100;
    return { name, key, hyperdx: a, vigie: b, diff, ok: diff <= limit };
  });
}

export async function parity(hyperdx: Side, vigie: Side, hours: number, checks = PARITY_CHECKS) {
  // Stops 5 minutes short of now, so a batch still in flight on one side is not read as a difference.
  const to = Date.now() - 300_000;
  const from = to - hours * 3_600_000;
  const rows: ParityRow[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const check of checks) {
    try {
      const [a, b] = await Promise.all([run(hyperdx, check.hyperdx, from, to), run(vigie, check.vigie, from, to)]);
      rows.push(...compare(check.name, check.limit, a, b));
    } catch (error) {
      failed.push({ name: check.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { rows, failed, ok: !failed.length && rows.length > 0 && rows.every((row) => row.ok) };
}

/* ---------- Every HyperDX tile, read from the dashboards the app keeps as code ---------- */

type Series = { aggFn: string; alias: string; valueExpression?: string; where?: string; level?: string; metricType?: "gauge" | "sum" | "histogram"; metricName?: string };
type TileConfig = { displayType?: string; configType?: string; sourceId?: "logs" | "traces" | "metrics"; select?: Series[] | string; where?: string; groupBy?: string; sqlTemplate?: string };
export type DashboardSpec = { name: string; rows: { key: string; name: string; config: TileConfig }[][] };

const TABLES = {
  logs: { hyperdx: "otel_logs", vigie: "logs", time: "Timestamp" },
  traces: { hyperdx: "otel_traces", vigie: "spans", time: "Timestamp" },
  gauge: { hyperdx: "otel_metrics_gauge", vigie: "metrics_gauge", time: "TimeUnix" },
  sum: { hyperdx: "otel_metrics_sum", vigie: "metrics_sum", time: "TimeUnix" },
  histogram: { hyperdx: "otel_metrics_histogram", vigie: "metrics_histogram", time: "TimeUnix" },
} as const;

const RANGE = (column: string) => `${column} >= {from:DateTime64(3)} AND ${column} < {to:DateTime64(3)}`;

function aggregate(item: Series, time: string) {
  const value = item.valueExpression || "1";
  switch (item.aggFn) {
    case "count": return "count()";
    case "count_distinct": return `uniqExact(${value})`;
    case "quantile": return `quantile(${item.level ?? "0.95"})(${value})`;
    case "last_value": return `argMax(${value}, ${time})`;
    case "increase": return `max(${value}) - min(${value})`;
    default: return `${item.aggFn}(${value})`;
  }
}

/** A saved tile becomes one query per series. The same expressions run on both sides; only table names differ. */
export function tileChecks(dashboard: DashboardSpec): ParityCheck[] {
  const checks: ParityCheck[] = [];
  for (const { key, name, config } of dashboard.rows.flat()) {
    const label = `${dashboard.name.replace(/^.*·\s*/, "")} / ${name}`;
    if (config.displayType === "markdown") continue;
    if (config.configType === "sql" && config.sqlTemplate) {
      const source = config.sourceId === "metrics" ? "gauge" : (config.sourceId ?? "logs");
      const write = (table: string) => config.sqlTemplate!.replaceAll("$__sourceTable", table).replace(/\$__timeFilter_ms\((\w+)\)/g, (_, column) => RANGE(column));
      // Some tiles name HyperDX's tables directly instead of using the source.
      const vigieNames = (sql: string) => sql.replace(/(?:default\.)?otel_metrics_(gauge|sum|histogram)/g, "metrics_$1").replace(/(?:default\.)?otel_logs/g, "logs").replace(/(?:default\.)?otel_traces/g, "spans");
      checks.push({ name: label, limit: TILE_LIMIT, hyperdx: write(TABLES[source].hyperdx), vigie: vigieNames(write(TABLES[source].vigie)) });
      continue;
    }
    if (config.displayType === "search") {
      const source = TABLES[config.sourceId === "traces" ? "traces" : "logs"];
      const write = (table: string) => `SELECT count() AS v FROM ${table} WHERE ${RANGE(source.time)} AND (${config.where || "1"})`;
      checks.push({ name: `${label} (rows)`, limit: TILE_LIMIT, hyperdx: write(source.hyperdx), vigie: write(source.vigie) });
      continue;
    }
    for (const item of (Array.isArray(config.select) ? config.select : [])) {
      const source = !config.sourceId || config.sourceId === "metrics" ? TABLES[config.sourceId ? (item.metricType ?? "gauge") : "logs"] : TABLES[config.sourceId];
      const metric = item.metricName ? ` AND MetricName = '${item.metricName}'` : "";
      const expression = item.metricName && !item.valueExpression ? { ...item, valueExpression: item.metricType === "histogram" ? "Count" : "Value" } : item;
      const filters = [config.where, item.where].filter(Boolean).map((f) => ` AND (${f})`).join("");
      const write = (table: string) => `SELECT ${config.groupBy ? `${config.groupBy}, ` : ""}${aggregate(expression, source.time)} AS v FROM ${table} WHERE ${RANGE(source.time)}${metric}${filters}${config.groupBy ? " GROUP BY 1" : ""}`;
      checks.push({ name: `${label} · ${item.alias}`, limit: TILE_LIMIT, hyperdx: write(source.hyperdx), vigie: write(source.vigie) });
    }
  }
  return checks;
}

/** Text columns name the row, number columns are what gets compared. */
export function flattenRows(rows: Record<string, unknown>[]) {
  const out = new Map<string, number>();
  for (const row of rows) {
    const entries = Object.entries(row);
    const isNumber = (v: unknown) => typeof v === "number" || (typeof v === "string" && v !== "" && Number.isFinite(Number(v)));
    const name = entries.filter(([, v]) => !isNumber(v)).map(([, v]) => String(v)).join(" · ");
    for (const [column, value] of entries) if (isNumber(value)) out.set([name, column === "v" ? "" : column].filter(Boolean).join(" · ") || "value", Number(value));
  }
  return out;
}
