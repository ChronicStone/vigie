import { notifyChannels, pushInbox } from "../alerts.ts";
import { humanDuration } from "../notify.ts";
import { config } from "../config.ts";
import { registry } from "../extensions/index.ts";
import { audit, db } from "../state/db.ts";
import { HttpError, type Actor } from "./http.ts";

type MonitorRow = { id: string; name: string; url: string; expect: number | null; managed_in: string; paused: number; state: string; since: number | null; fails: number; last_checked: number | null; last_error: string | null };

const DAY = 86_400_000;
/** One failed check is often a blip. Two in a row, a minute apart, is an outage. */
const FAILS_TO_DOWN = 2;

/** Only checks a status and a time. Never follows a redirect, never keeps a body, and refuses the cloud metadata address. */
export function checkMonitorUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "That is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new HttpError(400, "A monitor checks an http or https URL.");
  if (parsed.hostname.startsWith("169.254.") || parsed.hostname === "metadata.google.internal") throw new HttpError(400, "This address is not allowed.");
  return parsed.toString();
}

export function syncCodeMonitors() {
  const ids = new Set(registry.monitors.map((m) => m.id));
  for (const m of registry.monitors) {
    db.query("INSERT INTO monitors (id, name, url, expect, managed_in) VALUES (?, ?, ?, ?, 'code') ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, expect = excluded.expect, managed_in = 'code'").run(m.id, m.name, checkMonitorUrl(m.url), m.expect ?? null);
  }
  for (const row of db.query<{ id: string }, []>("SELECT id FROM monitors WHERE managed_in = 'code'").all()) {
    if (!ids.has(row.id)) db.query("DELETE FROM monitors WHERE id = ?").run(row.id);
  }
}

export async function probe(monitor: Pick<MonitorRow, "url" | "expect">) {
  const started = performance.now();
  try {
    const response = await fetch(monitor.url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Vigie uptime" } });
    await response.body?.cancel();
    const ok = monitor.expect ? response.status === monitor.expect : response.status < 400;
    return { ok, status: response.status, ms: Math.round(performance.now() - started), error: ok ? null : `Answered ${response.status}` };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, status: null, ms: Math.round(performance.now() - started), error: timedOut ? "No answer in 10 s" : "Could not connect" };
  }
}

export async function runCheck(monitor: MonitorRow, now = Date.now()) {
  const result = await probe(monitor);
  db.query("INSERT OR REPLACE INTO monitor_checks (monitor_id, at, ok, status, ms) VALUES (?, ?, ?, ?, ?)").run(monitor.id, now, result.ok ? 1 : 0, result.status, result.ms);
  const fails = result.ok ? 0 : monitor.fails + 1;
  const state = result.ok ? "up" : fails >= FAILS_TO_DOWN ? "down" : monitor.state === "unknown" ? "unknown" : monitor.state;
  if (state === "down" && monitor.state !== "down") {
    db.query("INSERT INTO monitor_outages (monitor_id, started, error) VALUES (?, ?, ?)").run(monitor.id, now, result.error);
    pushInbox("uptime", `${monitor.name} is down`, result.error ?? "", "/uptime");
    await notifyChannels({ tone: "firing", title: `${monitor.name} is down`, summary: `${monitor.url} did not answer ${FAILS_TO_DOWN} times in a row: ${result.error}. Checked from this server, every minute.`, links: [{ label: "Open uptime", url: `${config.publicUrl}/uptime` }] });
  }
  if (state === "up" && monitor.state === "down") {
    const outage = db.query<{ started: number }, [string]>("SELECT started FROM monitor_outages WHERE monitor_id = ? AND ended IS NULL").get(monitor.id);
    db.query("UPDATE monitor_outages SET ended = ? WHERE monitor_id = ? AND ended IS NULL").run(now, monitor.id);
    pushInbox("uptime", `${monitor.name} is back up`, monitor.url, "/uptime");
    await notifyChannels({ tone: "resolved", title: `${monitor.name} is back up`, summary: `after ${humanDuration(now - (outage?.started ?? now))}.` });
  }
  db.query("UPDATE monitors SET state = ?, since = ?, fails = ?, last_checked = ?, last_error = ? WHERE id = ?").run(state, state !== monitor.state ? now : monitor.since, fails, now, result.error, monitor.id);
  return { ...result, state };
}

/** On a laptop, code monitors stay off: running Vigie locally must not probe production every minute. */
export async function runMonitors() {
  syncCodeMonitors();
  const filter = config.mode === "local" ? " AND managed_in = 'app'" : "";
  const rows = db.query<MonitorRow, []>(`SELECT * FROM monitors WHERE paused = 0${filter}`).all();
  await Promise.all(rows.map((row) => runCheck(row).catch((error) => console.error(`Uptime check of ${row.name} failed:`, error))));
  db.query("DELETE FROM monitor_checks WHERE at < ?").run(Date.now() - 90 * DAY);
}

export function uptime() {
  syncCodeMonitors();
  const now = Date.now();
  const today = Math.floor(now / DAY);
  const rows = db.query<MonitorRow, []>("SELECT * FROM monitors ORDER BY state = 'down' DESC, name").all().map((monitor) => {
    const byDay = new Map(db.query<{ day: number; n: number; good: number }, [string, number]>("SELECT at / 86400000 AS day, count() AS n, sum(ok) AS good FROM monitor_checks WHERE monitor_id = ? AND at >= ? GROUP BY day").all(monitor.id, now - 90 * DAY).map((r) => [Math.floor(r.day), r]));
    const days = Array.from({ length: 90 }, (_, index) => {
      const day = today - 89 + index;
      const row = byDay.get(day);
      return { at: day * DAY, share: row ? (row.good / row.n) * 100 : null };
    });
    const since = (from: number) => db.query<{ n: number; good: number | null; ms: number | null }, [string, number]>("SELECT count() AS n, sum(ok) AS good, avg(CASE WHEN ok = 1 THEN ms END) AS ms FROM monitor_checks WHERE monitor_id = ? AND at >= ?").get(monitor.id, from)!;
    const month = since(now - 30 * DAY);
    const day = since(now - DAY);
    return { ...monitor, running: !monitor.paused && (config.mode !== "local" || monitor.managed_in === "app"), days, uptime30d: month.n ? ((month.good ?? 0) / month.n) * 100 : null, avgMs: day.ms };
  });
  const outages = db.query<{ id: number; monitor_id: string; name: string; started: number; ended: number | null; error: string | null }, []>("SELECT o.id, o.monitor_id, m.name, o.started, o.ended, o.error FROM monitor_outages o JOIN monitors m ON m.id = o.monitor_id ORDER BY o.started DESC LIMIT 200").all();
  return { rows, outages, mode: config.mode };
}

export function createMonitor(input: { name: string; url: string; expect?: number | null }, actor: Actor) {
  if (!input.name.trim()) throw new HttpError(400, "A monitor needs a name.");
  const id = crypto.randomUUID();
  db.query("INSERT INTO monitors (id, name, url, expect, managed_in) VALUES (?, ?, ?, ?, 'app')").run(id, input.name.trim(), checkMonitorUrl(input.url), input.expect ?? null);
  audit(actor.name, actor.through, "Created monitor", input.name);
  return { id };
}

const appMonitor = (id: string) => {
  const monitor = db.query<MonitorRow, [string]>("SELECT * FROM monitors WHERE id = ?").get(id);
  if (!monitor) throw new HttpError(404, "This monitor does not exist.");
  return monitor;
};

export function pauseMonitor(input: { id: string; paused: boolean }, actor: Actor) {
  const monitor = appMonitor(input.id);
  db.query("UPDATE monitors SET paused = ? WHERE id = ?").run(input.paused ? 1 : 0, input.id);
  audit(actor.name, actor.through, input.paused ? "Paused monitor" : "Resumed monitor", monitor.name);
  return { ok: true };
}

export function deleteMonitor(id: string, actor: Actor) {
  const monitor = appMonitor(id);
  if (monitor.managed_in === "code") throw new HttpError(409, "This monitor is defined in code. Remove it from the file.");
  db.query("DELETE FROM monitors WHERE id = ?").run(id);
  db.query("DELETE FROM monitor_checks WHERE monitor_id = ?").run(id);
  db.query("DELETE FROM monitor_outages WHERE monitor_id = ?").run(id);
  audit(actor.name, actor.through, "Deleted monitor", monitor.name);
  return { ok: true };
}

export async function checkMonitorNow(id: string) {
  return runCheck(appMonitor(id));
}

const statusIsPublic = () => db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get("status_page")?.value === "public";

export function setStatusPage(input: { public: boolean }, actor: Actor) {
  if (registry.statusPages.at(-1)?.public !== undefined) throw new HttpError(409, `Whether the page is public is set in ${registry.statusPages.at(-1)!.file}.`);
  db.query("INSERT INTO settings (key, value) VALUES ('status_page', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(input.public ? "public" : "private");
  audit(actor.name, actor.through, input.public ? "Made the status page public" : "Made the status page private", "");
  return { ok: true };
}

