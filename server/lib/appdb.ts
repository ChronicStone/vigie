import { SQL } from "bun";
import { config } from "../config.ts";
import { registry } from "../extensions/index.ts";

/** The observed app's Postgres, through a read-only role. Optional: without it Vigie works from telemetry alone. */
let client: SQL | null = null;
export function appDb() {
  if (!config.appDatabaseUrl) return null;
  client ??= new SQL({ url: config.appDatabaseUrl, max: 3, idleTimeout: 30 });
  return client;
}

/**
 * Every read runs in a read-only transaction with a statement timeout.
 * Prepared and parameterized, so one statement only: no stacked queries.
 */
export async function readOnly<T = Record<string, any>>(sql: string, params: unknown[] = [], timeoutMs = 15_000): Promise<T[]> {
  const db = appDb();
  if (!db) throw new Error("No app database is connected. Set VIGIE_APP_DATABASE_URL to a read-only role.");
  return db.begin("read only", async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${Math.round(timeoutMs)}`);
    return (await tx.unsafe(sql, params as any[])) as T[];
  }) as Promise<T[]>;
}

/** Keep this list the same as deploy/app-readonly.sql. */
export const SECRET_COLUMN = /(password|passwd|secret|token|hash|otp|credential|api_?key|private_?key|salt|secure_?code|webdoc)/i;
const NOT_SECRET = /(expires_?at|revoked_?at|access_?mode)$/i;
export const isSecretColumn = (table: string, column: string) => (SECRET_COLUMN.test(column) && !NOT_SECRET.test(column)) || table === "verification";

/**
 * Whether this role could read a credential. Raw SQL can rename any column, so masking cannot make it
 * safe: Postgres has to refuse. If it wouldn't, raw SQL stays off until the role is fixed.
 */
export async function secretsReadable() {
  const rows = await readOnly<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND has_column_privilege(current_user, format('%I.%I', table_schema, table_name), column_name, 'SELECT')`,
    [],
    5000,
  );
  return rows.filter((row) => isSecretColumn(row.table_name, row.column_name)).map((row) => `${row.table_name}.${row.column_name}`);
}

const people = new Map<string, { name: string; role: string; accountName: string }>();
const accounts = new Map<string, string>();
let peopleLoadedAt = 0;

/** Display names come from the app's own tables. Telemetry itself stays free of names. */
export async function loadPeople() {
  if (Date.now() - peopleLoadedAt < 60_000) return;
  const identity = registry.identities[0];
  if (identity) {
    peopleLoadedAt = Date.now();
    for (const person of await identity.people().catch(() => [])) {
      people.set(person.id, { name: person.name, role: person.role ?? "", accountName: person.accountName ?? "" });
      if (person.accountId) accounts.set(person.accountId, person.accountName ?? "");
    }
    return;
  }
  if (!appDb()) return;
  peopleLoadedAt = Date.now();
  try {
    const rows = await readOnly<any>(`SELECT u.id, u.name, u."adminRole" AS admin_role, u."accountId" AS account_id, a.name AS account_name FROM "user" u LEFT JOIN account a ON a.id = u."accountId"`, [], 5000);
    for (const row of rows) {
      people.set(String(row.id), { name: row.name, role: row.admin_role, accountName: row.account_name });
      if (row.account_id) accounts.set(String(row.account_id), row.account_name);
    }
  } catch {}
}
export const personName = (id: string) => people.get(id)?.name ?? "";
export const accountName = (id: string) => accounts.get(id) ?? "";
