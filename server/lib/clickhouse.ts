import { config } from "../config.ts";

const { url, user, password, database } = config.clickhouse;

type Params = Record<string, string | number | boolean | string[] | number[] | undefined>;

export class ClickHouseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly sql: string,
  ) {
    super(message);
    this.name = "ClickHouseError";
  }
}

function endpoint(settings: Record<string, string | number>, params?: Params, withDatabase = true) {
  const search = new URLSearchParams();
  if (withDatabase) search.set("database", database);
  search.set("session_timezone", "UTC");
  for (const [key, value] of Object.entries(settings)) search.set(key, String(value));
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    search.set(`param_${key}`, Array.isArray(value) ? `[${value.map((v) => `'${String(v).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`).join(",")}]` : String(value));
  }
  return `${url}/?${search}`;
}

const headers = { "X-ClickHouse-User": user, "X-ClickHouse-Key": password };

/** ClickHouse is tuned for a small box and refuses bursts. Reads wait their turn here instead of failing a page. */
const MAX_CONCURRENT = 8;
let running = 0;
const waiting: (() => void)[] = [];
async function turn<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await run();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function send(sql: string, target: string, body: string) {
  const response = await fetch(target, { method: "POST", headers, body });
  if (!response.ok) {
    const text = await response.text();
    const exception = text.match(/"exception":\s*"([^"]*)"/)?.[1] ?? text;
    throw new ClickHouseError(exception.replace(/\s*\(version [^)]*\)\s*$/, "").slice(0, 800), response.status, sql.slice(0, 400));
  }
  return response;
}

/** Runs a statement that returns nothing. */
export async function exec(sql: string, options: { withDatabase?: boolean; settings?: Record<string, string | number> } = {}) {
  await send(sql, endpoint(options.settings ?? {}, undefined, options.withDatabase ?? true), sql);
}

export type QueryOptions = {
  params?: Params;
  /** Hard time limit in seconds. */
  timeout?: number;
  maxRows?: number;
  /** Runs with readonly=2, for anything a person or an agent typed. */
  readonly?: boolean;
};

export async function query<T = Record<string, any>>(sql: string, options: QueryOptions = {}): Promise<T[]> {
  const settings: Record<string, string | number> = {
    default_format: "JSON",
    output_format_json_quote_64bit_integers: 0,
    max_execution_time: options.timeout ?? 15,
  };
  if (options.readonly) {
    settings.readonly = 2;
    settings.max_result_rows = options.maxRows ?? 10_000;
    settings.result_overflow_mode = "break";
    settings.max_rows_to_read = 50_000_000;
    settings.max_memory_usage = 300_000_000;
  }
  return turn(async () => {
    const response = await send(sql, endpoint(settings, options.params), sql);
    const parsed = (await response.json()) as { data: T[] };
    return parsed.data;
  });
}

export async function queryWithStats<T = Record<string, any>>(sql: string, options: QueryOptions = {}) {
  const settings: Record<string, string | number> = {
    default_format: "JSON",
    output_format_json_quote_64bit_integers: 0,
    max_execution_time: options.timeout ?? 15,
    readonly: 2,
    max_result_rows: options.maxRows ?? 10_000,
    max_rows_to_read: 50_000_000,
    max_memory_usage: 300_000_000,
    result_overflow_mode: "break",
  };
  return turn(async () => {
    const response = await send(sql, endpoint(settings, options.params), sql);
    return (await response.json()) as {
      data: T[];
      meta: { name: string; type: string }[];
      statistics: { elapsed: number; rows_read: number; bytes_read: number };
    };
  });
}

/** Inserts rows as JSONEachRow. Asynchronous inserts keep parts small when batches are tiny. */
export async function insert(table: string, lines: string) {
  const sql = `INSERT INTO ${table} FORMAT JSONEachRow`;
  const target = endpoint({ async_insert: 1, wait_for_async_insert: 1, query: sql, date_time_input_format: "best_effort", input_format_skip_unknown_fields: 1 });
  await send(sql, target, lines);
}

export async function ping() {
  try {
    const response = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
