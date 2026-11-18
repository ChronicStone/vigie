import { query, queryWithStats } from "../lib/clickhouse.ts";
import { config } from "../config.ts";
import { appDb, readOnly, isSecretColumn, secretsReadable } from "../lib/appdb.ts";
import { CONSOLE_TABLES, checkConsoleSql } from "./metrics.ts";
import type { Json } from "../../sdk/index.ts";
import { HttpError } from "./http.ts";

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const quote = (name: string) => {
  if (!IDENT.test(name)) throw new HttpError(400, `Bad name: ${name}`);
  return `"${name}"`;
};

const OPS: Record<string, (column: string, index: number, cast: string) => string> = {
  eq: (c, i, t) => `${c} = $${i}::${t}`,
  neq: (c, i, t) => `${c} IS DISTINCT FROM $${i}::${t}`,
  contains: (c, i) => `${c}::text ILIKE '%' || $${i} || '%'`,
  not_contains: (c, i) => `${c}::text NOT ILIKE '%' || $${i} || '%'`,
  starts: (c, i) => `${c}::text ILIKE $${i} || '%'`,
  ends: (c, i) => `${c}::text ILIKE '%' || $${i}`,
  gt: (c, i, t) => `${c} > $${i}::${t}`,
  gte: (c, i, t) => `${c} >= $${i}::${t}`,
  lt: (c, i, t) => `${c} < $${i}::${t}`,
  lte: (c, i, t) => `${c} <= $${i}::${t}`,
  json_contains: (c, i) => `${c}::jsonb @> $${i}::jsonb`,
  json_has: (c, i) => `${c}::jsonb ? $${i}`,
};
const NO_VALUE: Record<string, (c: string) => string> = {
  null: (c) => `${c} IS NULL`,
  not_null: (c) => `${c} IS NOT NULL`,
  true: (c) => `${c} IS TRUE`,
  false: (c) => `${c} IS FALSE`,
  empty: (c) => `(${c} IS NULL OR ${c}::text = '')`,
  not_empty: (c) => `(${c} IS NOT NULL AND ${c}::text <> '')`,
};

async function pgStructure(table: string): Promise<{ columns: DbColumn[]; indexes: { name: string; columns: string; note: string }[] }> {
  const columns = await readOnly<{ name: string; type: string; nullable: boolean; typtype: string; default: string | null; enum: string[] | null }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, t.typtype AS typtype, pg_get_expr(d.adbin, d.adrelid) AS default,
       (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS enum
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relname = $1 AND n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [table],
    5000,
  );
  if (!columns.length) throw new HttpError(404, `No table called ${table}.`);
  // Credentials are never listed, selected, searched or filtered on, whatever the role is allowed to read.
  const visible = columns.filter((c) => !isSecretColumn(table, c.name));
  const fks = await readOnly<{ col: string; ref: string; ref_col: string }>(
    `SELECT a.attname AS col, cf.relname AS ref, af.attname AS ref_col FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class cf ON cf.oid = k.confrelid
     JOIN LATERAL unnest(k.conkey, k.confkey) AS u(a, f) ON true JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.a JOIN pg_attribute af ON af.attrelid = k.confrelid AND af.attnum = u.f
     WHERE k.contype = 'f' AND c.relname = $1`,
    [table],
    5000,
  );
  const indexes = await readOnly<{ name: string; def: string }>(`SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`, [table], 5000);
  const pk = await readOnly<{ name: string }>(`SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = (SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace) AND i.indisprimary`, [table], 5000);
  const fk = new Map(fks.map((f) => [f.col, { table: f.ref, column: f.ref_col }]));
  return {
    columns: visible.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, default: c.default, enum: c.enum ?? null, references: fk.get(c.name) ?? null, kind: kindOf(c.type, c.typtype), primary: pk.some((p) => p.name === c.name) })),
    indexes: indexes.map((i) => ({ name: i.name, columns: i.def.match(/\(([^)]*)\)/)?.[1] ?? "", note: [/UNIQUE/.test(i.def) ? "unique" : "", / WHERE /.test(i.def) ? `partial, ${i.def.split(" WHERE ")[1]}` : ""].filter(Boolean).join(", ") })),
  };
}

function kindOf(type: string, typtype?: string) {
  if (typtype === "e") return "enum";
  if (/json/.test(type)) return "json";
  if (/bool/.test(type)) return "bool";
  if (/int|numeric|real|double|decimal/.test(type)) return "number";
  if (/time|date/.test(type)) return "time";
  if (/uuid/.test(type)) return "uuid";
  return "text";
}

const castOf = (type: string) => (/^[\w\s".,()[\]]+$/.test(type) ? type : "text");

export type DbSource = "pg" | "ch";
export type DbColumn = { name: string; type: string; nullable: boolean; default?: string | null; enum: string[] | null; references: { table: string; column: string } | null; kind: string; primary: boolean };
export type DbFilter = { column: string; op: string; value?: string };

export const dbSources = () => [
  { id: "pg" as DbSource, label: config.appName === "your app" ? "App" : config.appName, available: Boolean(appDb()) },
  { id: "ch" as DbSource, label: "Telemetry", available: true },
];

export async function dbTables(input: { source: DbSource }): Promise<{ name: string; rows: number; bytes: number }[]> {
  if (input.source === "ch") {
    const rows = await query<{ name: string; rows: number; bytes: number }>("SELECT table AS name, sum(rows) AS rows, sum(bytes_on_disk) AS bytes FROM system.parts WHERE active AND database = currentDatabase() GROUP BY table");
    return Object.keys(CONSOLE_TABLES).map((name) => ({ name, rows: rows.find((r) => r.name === name)?.rows ?? 0, bytes: rows.find((r) => r.name === name)?.bytes ?? 0 }));
  }
  // reltuples is an estimate: counting a large table on every open would be the slowest query of the session.
  return readOnly<{ name: string; rows: number; bytes: number }>(
    `SELECT c.relname AS name, GREATEST(c.reltuples, s.n_live_tup, 0)::bigint AS rows, pg_total_relation_size(c.oid) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') ORDER BY c.relname`,
    [],
    3000,
  );
}

export async function dbStructure(input: { source: DbSource; table: string }): Promise<{ columns: DbColumn[]; indexes: { name: string; columns: string; note: string }[] }> {
  const { table } = input;
  if (input.source === "ch") {
    if (!CONSOLE_TABLES[table]) throw new HttpError(404, `No table called ${table}.`);
    const columns = await query<{ name: string; type: string; primary: number }>("SELECT name, type, is_in_sorting_key AS primary FROM system.columns WHERE database = currentDatabase() AND table = {table:String} AND name IN {cols:Array(String)}", { params: { table, cols: CONSOLE_TABLES[table]! } });
    return { columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: false, references: null, enum: null, kind: /Int|Float/.test(c.type) ? "number" : /Date/.test(c.type) ? "time" : /Map|Array|Aggregate/.test(c.type) ? "json" : "text", primary: Boolean(c.primary) })), indexes: [] };
  }
  return pgStructure(table);
}

/** What points at this table: every foreign key elsewhere that references it. */
export async function dbLinks(input: { source: DbSource; table: string }): Promise<{ table: string; column: string; to: string }[]> {
  if (input.source === "ch") return [];
  return readOnly<{ table: string; column: string; to: string }>(
    `SELECT c.relname AS "table", a.attname AS "column", af.attname AS "to" FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class cf ON cf.oid = k.confrelid
     JOIN LATERAL unnest(k.conkey, k.confkey) AS u(a, f) ON true JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.a JOIN pg_attribute af ON af.attrelid = k.confrelid AND af.attnum = u.f
     WHERE k.contype = 'f' AND cf.relname = $1 ORDER BY 1, 2`,
    [input.table],
    5000,
  );
}

export async function dbRows(input: { source: DbSource; table: string; filters?: DbFilter[]; limit?: number; offset?: number; search?: string; sort?: string; desc?: boolean }): Promise<{ rows: Record<string, Json>[]; sql: string; count: number | null; elapsed: number }> {
  const table = input.table;
  const limit = Math.min(Number(input.limit) || 100, 500);
  const offset = Math.max(Number(input.offset) || 0, 0);
  if (input.source === "ch") {
    if (!CONSOLE_TABLES[table]) throw new HttpError(400, `Unknown table ${table}.`);
    const columns = CONSOLE_TABLES[table]!.filter((c) => !["Quantiles"].includes(c));
    const time = columns.find((c) => /^(Timestamp|TimeUnix|Minute|Bucket|Day)$/.test(c));
    const parts: string[] = [];
    const params: Record<string, any> = {};
    (input.filters ?? []).forEach((f, index) => {
      if (!columns.includes(f.column)) throw new HttpError(400, `Unknown column ${f.column}.`);
      params[`f${index}`] = String(f.value ?? "");
      if (f.op === "eq") parts.push(`toString(${f.column}) = {f${index}:String}`);
      else if (f.op === "neq") parts.push(`toString(${f.column}) != {f${index}:String}`);
      else if (f.op === "contains") parts.push(`positionCaseInsensitive(toString(${f.column}), {f${index}:String}) > 0`);
      else if (f.op === "gt") parts.push(`toFloat64OrZero(toString(${f.column})) > toFloat64OrZero({f${index}:String})`);
      else if (f.op === "lt") parts.push(`toFloat64OrZero(toString(${f.column})) < toFloat64OrZero({f${index}:String})`);
      else throw new HttpError(400, `Operator ${f.op} is not available on telemetry tables.`);
    });
    const sql = `SELECT ${columns.join(", ")} FROM ${table}${parts.length ? ` WHERE ${parts.join(" AND ")}` : ""}${time ? ` ORDER BY ${time} DESC` : ""} LIMIT ${limit} OFFSET ${offset}`;
    const result = await queryWithStats<Record<string, Json>>(sql, { params, timeout: 15, maxRows: limit });
    return { rows: result.data, sql, count: null, elapsed: Math.round(result.statistics.elapsed * 1000) };
  }
  const { columns } = await pgStructure(table);
  const byName = new Map(columns.map((c) => [c.name, c]));
  const params: unknown[] = [];
  const parts: string[] = [];
  for (const filter of input.filters ?? []) {
    const column = byName.get(filter.column);
    if (!column) throw new HttpError(400, `Unknown column ${filter.column}.`);
    const name = quote(column.name);
    if (NO_VALUE[filter.op]) {
      parts.push(NO_VALUE[filter.op]!(name));
      continue;
    }
    if (filter.op === "in" || filter.op === "not_in") {
      params.push(String(filter.value ?? "").split(",").map((v) => v.trim()));
      parts.push(`${name}::text ${filter.op === "in" ? "= ANY" : "<> ALL"}($${params.length}::text[])`);
      continue;
    }
    if (filter.op === "between") {
      const [a, b] = String(filter.value ?? "").split(",").map((v) => v.trim());
      params.push(a, b);
      parts.push(`${name} BETWEEN $${params.length - 1}::${castOf(column.type)} AND $${params.length}::${castOf(column.type)}`);
      continue;
    }
    const op = OPS[filter.op];
    if (!op) throw new HttpError(400, `Unknown operator ${filter.op}.`);
    // Values travel as text and Postgres casts them to the column's type, so a bad value is a clear error, never an injection.
    params.push(String(filter.value ?? ""));
    parts.push(op(name, params.length, castOf(column.type)));
  }
  if (input.search) {
    params.push(String(input.search));
    parts.push(`(${columns.filter((c) => c.kind !== "json").map((c) => `${quote(c.name)}::text ILIKE '%' || $${params.length} || '%'`).join(" OR ")})`);
  }
  const order = input.sort && byName.has(input.sort) ? input.sort : columns.find((c) => c.kind === "time")?.name ?? columns.find((c) => c.primary)?.name;
  const list = columns.map((c) => quote(c.name)).join(", ");
  const sql = `SELECT ${list} FROM ${quote(table)}${parts.length ? ` WHERE ${parts.join(" AND ")}` : ""}${order ? ` ORDER BY ${quote(order)} ${input.desc === false ? "ASC" : "DESC"}` : ""} LIMIT ${limit} OFFSET ${offset}`;
  const started = performance.now();
  const rows = await readOnly<Record<string, Json>>(sql, params, 15_000);
  let count: number | null = null;
  try {
    const [row] = await readOnly<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${quote(table)}${parts.length ? ` WHERE ${parts.join(" AND ")}` : ""}`, params, 3000);
    count = Number(row.n);
  } catch {}
  return { rows, sql, count, elapsed: Math.round(performance.now() - started) };
}

export async function dbSql(input: { source: DbSource; sql: string }): Promise<{ rows: Record<string, Json>[]; columns: string[]; elapsed: number }> {
  const sql = input.sql.trim().replace(/;\s*$/, "");
  if (!sql) throw new HttpError(400, "Write a query first.");
  const started = performance.now();
  if (input.source === "ch") {
    const clean = checkConsoleSql(sql);
    const result = await queryWithStats<Record<string, Json>>(clean, { timeout: 30, maxRows: 5000 });
    return { rows: result.data, columns: result.meta.map((m) => m.name), elapsed: Math.round(result.statistics.elapsed * 1000) };
  }
  const readable = await secretsReadable();
  if (readable.length) throw new HttpError(403, `Raw SQL is off: this role can read ${readable.slice(0, 3).join(", ")}${readable.length > 3 ? ` and ${readable.length - 3} more credentials` : ""}. Run deploy/app-readonly.sql.`);
  const rows = await readOnly<Record<string, Json>>(sql, [], 30_000);
  return { rows: rows.slice(0, 5000), columns: rows[0] ? Object.keys(rows[0]) : [], elapsed: Math.round(performance.now() - started) };
}
