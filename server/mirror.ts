import { insert, query } from "./lib/clickhouse.ts";
import { appDb, readOnly } from "./lib/appdb.ts";
import { db } from "./state/db.ts";

/**
 * Copies the app's task and switch tables into ClickHouse every few seconds. Lists and history read the
 * copy, so dashboards never load production Postgres, tasks join with spans and events, and history
 * outlives the app's purge. Payload, result, claim token and notify user are never copied.
 */
const BATCH = 2000;
const TASK_COLUMNS = `id::text AS id, kind, key, state::text AS state, standing, "accountId"::text AS "accountId", "testCenterId"::text AS "testCenterId", "subjectType", "subjectId", "serialKey", "runAt", attempts, runs, "consecutiveFailures", "leaseUntil", "workerId", "waitReason", code, "causedBy", "createdBy", "traceId", "lastRunAt", "lastOkAt", "createdAt", "updatedAt", "settledAt", "updatedAt"::text AS "cursorAt"`;

const cursorOf = (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? "1970-01-01T00:00:00.000Z";
const setCursor = (key: string, value: string) => db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

async function mirrorTasks() {
  // One transaction can stamp thousands of rows alike, more than a batch holds, so the id is part of the cursor.
  const [at, id = ""] = cursorOf("mirror.tasks").split("|");
  const rows = await readOnly<any>(`SELECT ${TASK_COLUMNS} FROM task WHERE ("updatedAt", id::text) > ($1::timestamptz, $2) ORDER BY "updatedAt", id::text LIMIT ${BATCH}`, [at, id], 5000);
  // Reading it is what makes the copy fresh: a quiet app has nothing new to copy.
  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('mirror.tasks.at', ?)").run(String(Date.now()));
  if (!rows.length) return 0;
  const lines = rows.map((row) =>
    JSON.stringify({
      Id: row.id,
      Kind: row.kind,
      Key: row.key,
      State: row.state,
      Standing: row.standing ? 1 : 0,
      AccountId: row.accountId ?? "",
      TestCenterId: row.testCenterId ?? "",
      SubjectType: row.subjectType ?? "",
      SubjectId: row.subjectId ?? "",
      SerialKey: row.serialKey ?? "",
      RunAt: iso(row.runAt),
      Attempts: row.attempts ?? 0,
      Runs: row.runs ?? 0,
      ConsecutiveFailures: row.consecutiveFailures ?? 0,
      LeaseUntil: iso(row.leaseUntil),
      WorkerId: row.workerId ?? "",
      WaitReason: row.waitReason ?? "",
      Code: row.code ?? "",
      CausedBy: row.causedBy ?? "",
      CreatedBy: row.createdBy ?? "",
      TraceId: row.traceId ?? "",
      LastRunAt: iso(row.lastRunAt),
      LastOkAt: iso(row.lastOkAt),
      CreatedAt: iso(row.createdAt),
      UpdatedAt: iso(row.updatedAt),
      SettledAt: iso(row.settledAt),
    }),
  );
  await insert("task_mirror", lines.join("\n"));
  const last = rows[rows.length - 1];
  setCursor("mirror.tasks", `${last.cursorAt}|${last.id}`);
  return rows.length;
}

async function mirrorSwitches() {
  const cursor = cursorOf("mirror.switches");
  const rows = await readOnly<any>(`SELECT id::text AS id, key, enabled, "previousEnabled", reason, "userId", "createdAt", "createdAt"::text AS "cursorAt" FROM feature_flag_change WHERE "createdAt" > $1::timestamptz ORDER BY "createdAt" LIMIT ${BATCH}`, [cursor], 5000);
  if (!rows.length) return 0;
  await insert("switch_changes", rows.map((row) => JSON.stringify({ Id: row.id, Key: row.key, Enabled: row.enabled ? 1 : 0, PreviousEnabled: row.previousEnabled ? 1 : 0, Reason: row.reason ?? "", UserId: row.userId ?? "", CreatedAt: iso(row.createdAt) })).join("\n"));
  // A JavaScript date stops at milliseconds, which would read the last row again on every pass.
  setCursor("mirror.switches", rows[rows.length - 1].cursorAt);
  return rows.length;
}

/** One failing table must not stop the other. An app without a switch history is fine. */
export async function mirrorOnce() {
  if (!appDb()) return { tasks: 0, switches: 0 };
  const [tasks, switches] = await Promise.allSettled([mirrorTasks(), mirrorSwitches()]);
  return { tasks: tasks.status === "fulfilled" ? tasks.value : 0, switches: switches.status === "fulfilled" ? switches.value : 0, error: tasks.status === "rejected" ? String(tasks.reason) : undefined };
}

/** The copy is usable once it has run recently. Otherwise callers fall back to reading the app. */
export const mirrorFresh = () => {
  const at = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get("mirror.tasks.at")?.value;
  return Boolean(at && Date.now() - Number(at) < 10 * 60_000);
};

export async function pendingFromMirror(kind: string | undefined, limit: number) {
  return query<{ id: string; kind: string; key: string; state: string; attempts: number; runAt: number; accountId: string; traceId: string }>(
    `SELECT Id AS id, Kind AS kind, Key AS key, State AS state, Attempts AS attempts, toUnixTimestamp64Milli(RunAt) AS runAt, AccountId AS accountId, TraceId AS traceId FROM task_mirror FINAL WHERE State IN ('QUEUED', 'RUNNING') ${kind ? "AND Kind = {kind:String}" : ""} ORDER BY RunAt LIMIT ${Number(limit)}`,
    { params: kind ? { kind } : {} },
  );
}
