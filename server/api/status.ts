import { config } from "../config.ts";
import { registry } from "../extensions/index.ts";
import { statusKey } from "../../sdk/index.ts";
import { audit, db } from "../state/db.ts";
import { HttpError, type Actor } from "./http.ts";
import { uptime } from "./uptime.ts";

/**
 * The public status page. Monitors say what is down on their own; people add what happened, in
 * words, as incidents with updates (Investigating, Identified, Monitoring, Resolved). Visitors see
 * names, states and those words, never a URL, an error text or a timing.
 */
export type Impact = "minor" | "major" | "critical" | "maintenance";
export type UpdateState = "investigating" | "identified" | "monitoring" | "resolved" | "scheduled";
export type Overall = "operational" | "degraded" | "partial" | "major" | "maintenance";

const DAY = 86_400_000;
const RANK: Record<Overall, number> = { operational: 0, maintenance: 1, degraded: 2, partial: 3, major: 4 };
const FROM_IMPACT: Record<Impact, Overall> = { minor: "degraded", major: "partial", critical: "major", maintenance: "maintenance" };
const worst = (states: Overall[]) => states.reduce<Overall>((a, b) => (RANK[b] > RANK[a] ? b : a), "operational");

type IncidentRow = { id: number; title: string; impact: Impact; monitors: string; started: number; resolved: number | null; outage_id: number | null };
type UpdateRow = { id: number; incident_id: number; state: UpdateState; message: string; at: number; author: string | null };

const setting = (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value;
const saveSetting = (key: string, value: string) => db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

/** One line on the page. `key` is where its state comes from: a monitor, or an alert (error rate, failed tasks, a queue: anything an alert watches). */
export type StatusComponent = { key: string; name: string; group?: string };
export type StatusConfig = {
  title: string;
  description: string;
  /** null until someone picks: then every running monitor shows, under its own name. */
  components: StatusComponent[] | null;
  show: { active: boolean; history: boolean; uptime: boolean; past: boolean };
  days: 30 | 60 | 90;
};

const DEFAULTS: StatusConfig = { title: "", description: "", components: null, show: { active: true, history: true, uptime: true, past: true }, days: 90 };

/** A `defineStatusPage` in definitions wins over the app: the page is reviewed and deployed like code. */
export function codeStatusPage() {
  const found = registry.statusPages.at(-1);
  if (!found) return null;
  const config: StatusConfig = {
    title: found.title ?? "",
    description: found.description ?? "",
    components: found.components.map((c) => ({ key: statusKey(c.from), name: c.name, ...(c.group ? { group: c.group } : {}) })),
    show: { ...DEFAULTS.show, ...found.show },
    days: found.days ?? 90,
  };
  return { config, file: found.file, public: found.public, extra: registry.statusPages.length - 1 };
}

export function statusConfig(): StatusConfig {
  const code = codeStatusPage();
  if (code) return code.config;
  let saved: Partial<StatusConfig> = {};
  try {
    saved = JSON.parse(setting("status_config") ?? "{}");
  } catch {}
  return { ...DEFAULTS, ...saved, show: { ...DEFAULTS.show, ...saved.show } };
}

export const statusInfo = () => {
  const c = statusConfig();
  const code = codeStatusPage();
  return { title: c.title || (config.appName === "your app" ? "Status" : `${config.appName} status`), description: c.description, isPublic: code?.public ?? setting("status_page") === "public" };
};

/** Old incidents name monitors by id alone. */
const keyOf = (ref: string) => (ref.includes(":") ? ref : `monitor:${ref}`);

function incidents(sinceMs: number) {
  const rows = db.query<IncidentRow, [number]>("SELECT * FROM status_incidents WHERE resolved IS NULL OR started >= ? ORDER BY started DESC").all(sinceMs);
  const updates = db.query<UpdateRow, [number]>("SELECT * FROM status_updates WHERE incident_id IN (SELECT id FROM status_incidents WHERE resolved IS NULL OR started >= ?) ORDER BY at DESC").all(sinceMs);
  return rows.map((row) => ({ ...row, keys: (JSON.parse(row.monitors) as string[]).map(keyOf), updates: updates.filter((u) => u.incident_id === row.id) }));
}

type AlertRow = { id: string; name: string; state: string; paused: number };

/** Everything that could go on the page, for the editor: monitors and alerts, by key. */
export function statusSources() {
  const { rows } = uptime();
  const alerts = db.query<AlertRow, []>("SELECT id, name, state, paused FROM alerts ORDER BY name").all();
  return [
    ...rows.map((m) => ({ key: `monitor:${m.id}`, kind: "monitor" as const, name: m.name, detail: m.running ? (m.state === "down" ? "Down now" : "Checked every minute") : m.paused ? "Paused" : "Runs on the server only" })),
    ...alerts.map((a) => ({ key: `alert:${a.id}`, kind: "alert" as const, name: a.name, detail: a.paused ? "Paused" : a.state === "firing" ? "Firing now" : "Alert" })),
  ];
}

/** Everything the page shows, worked out once, for the page, the editor preview and MCP. */
export function statusModel(override?: StatusConfig) {
  const cfg = override ?? statusConfig();
  const { rows, outages } = uptime();
  const now = Date.now();
  const since = now - cfg.days * DAY;
  const firstDay = Math.floor(now / DAY) - cfg.days + 1;
  const monitorsById = new Map(rows.map((m) => [m.id, m]));
  const alerts = new Map(db.query<AlertRow, []>("SELECT id, name, state, paused FROM alerts").all().map((a) => [a.id, a]));
  const chosen: StatusComponent[] = cfg.components ?? rows.filter((m) => m.running || m.paused).map((m) => ({ key: `monitor:${m.id}`, name: m.name }));
  const components = chosen.filter((c) => {
    const [kind, id] = c.key.split(/:(.*)/s) as [string, string];
    return kind === "monitor" ? monitorsById.has(id) : kind === "alert" ? alerts.has(id) : false;
  });
  const nameOf = new Map(components.map((c) => [c.key, c.name]));
  const written = incidents(since).map((i) => ({ ...i, keys: i.keys.filter((k) => nameOf.has(k)) }));
  const explained = new Set(written.map((i) => i.outage_id).filter((id): id is number => id !== null));
  const activeWritten = written.filter((i) => i.resolved === null);

  const toIncident = (i: (typeof written)[number]) => ({
    id: `i${i.id}`,
    detected: false,
    title: i.title,
    impact: i.impact,
    state: i.updates[0]?.state ?? (i.resolved ? "resolved" : "investigating"),
    started: i.started,
    resolved: i.resolved,
    components: i.keys.map((k) => nameOf.get(k)!),
    updates: i.updates.map((u) => ({ state: u.state, message: u.message, at: u.at })),
  });
  /** What nobody has written about yet still shows: the page never claims all is well while a check fails. */
  const monitorOutages = outages
    .filter((o) => !explained.has(o.id) && o.started >= since && nameOf.has(`monitor:${o.monitor_id}`))
    .map((o) => ({ id: `o${o.id}`, key: `monitor:${o.monitor_id}`, started: o.started, ended: o.ended }));
  const alertSpells = db
    .query<{ id: number; alert_id: string; started: number; ended: number | null }, [number]>("SELECT id, alert_id, started, ended FROM incidents WHERE started >= ? OR ended IS NULL")
    .all(since)
    .filter((a) => nameOf.has(`alert:${a.alert_id}`))
    .map((a) => ({ id: `a${a.id}`, key: `alert:${a.alert_id}`, started: a.started, ended: a.ended }));
  const detected = [...monitorOutages, ...alertSpells]
    // A written incident covering the same component at the same time already tells the story.
    .filter((d) => !written.some((w) => w.keys.includes(d.key) && w.started <= (d.ended ?? now) && (w.resolved ?? now) >= d.started))
    .map((d) => ({
      id: d.id,
      detected: true,
      title: d.key.startsWith("alert:") ? `${nameOf.get(d.key)} degraded` : `${nameOf.get(d.key)} stopped answering`,
      impact: (d.key.startsWith("alert:") ? "minor" : "major") as Impact,
      state: (d.ended ? "resolved" : "investigating") as UpdateState,
      started: d.started,
      resolved: d.ended,
      components: [nameOf.get(d.key)!],
      updates: [] as { state: UpdateState; message: string; at: number }[],
    }));
  const all = [...written.map(toIncident), ...detected].sort((a, b) => b.started - a.started);

  const days = (c: StatusComponent) => {
    const [kind, id] = c.key.split(/:(.*)/s) as [string, string];
    const list = Array.from({ length: cfg.days }, (_, index) => {
      const at = (firstDay + index) * DAY;
      let share: number | null = null;
      if (kind === "monitor") share = monitorsById.get(id)!.days.find((d) => d.at === at)?.share ?? null;
      else {
        // An alert has no checks of its own: the share of the day it was not firing.
        const firing = alertSpells.filter((s) => s.key === c.key).reduce((sum, s) => sum + Math.max(0, Math.min(s.ended ?? now, at + DAY, now) - Math.max(s.started, at)), 0);
        share = at > now ? null : 100 - (firing / Math.min(DAY, now - at)) * 100;
      }
      const titles = all.filter((i) => i.components.includes(c.name) && i.started < at + DAY && (i.resolved ?? now) >= at).map((i) => i.title);
      return { at, share, incidents: titles };
    });
    return list;
  };
  const stateOf = (c: StatusComponent): Overall => {
    const [kind, id] = c.key.split(/:(.*)/s) as [string, string];
    const own: Overall = kind === "monitor" ? (monitorsById.get(id)!.paused ? "maintenance" : monitorsById.get(id)!.state === "down" ? "major" : "operational") : alerts.get(id)!.state === "firing" ? "degraded" : "operational";
    return worst([own, ...activeWritten.filter((i) => i.keys.includes(c.key)).map((i) => FROM_IMPACT[i.impact])]);
  };
  const shown = components.map((c) => {
    const history = days(c);
    const measured = history.filter((d) => d.share !== null);
    return { key: c.key, name: c.name, group: c.group ?? "", state: stateOf(c), uptime: measured.length ? measured.reduce((sum, d) => sum + d.share!, 0) / measured.length : null, days: history };
  });
  const active = all.filter((i) => i.resolved === null);
  return {
    ...statusInfo(),
    ...(override ? { title: override.title || statusInfo().title, description: override.description } : {}),
    show: cfg.show,
    daysShown: cfg.days,
    overall: worst([...shown.map((m) => m.state), ...active.map((i) => FROM_IMPACT[i.impact])]),
    components: shown,
    active,
    past: all.filter((i) => i.resolved !== null).slice(0, 30),
  };
}

export function statusPage(signedIn: boolean) {
  const model = statusModel();
  if (!model.isPublic && !signedIn) throw new HttpError(404, "This status page is private.");
  return model;
}

/** The editor: what is set, and everything that could be added. */
export const statusEditor = () => {
  const code = codeStatusPage();
  const config = statusConfig();
  // Until someone picks, the page shows every running monitor: the editor starts from exactly that.
  const components: StatusComponent[] = config.components ?? statusModel().components.map((c) => ({ key: c.key, name: c.name }));
  return { config: { ...config, components }, sources: statusSources(), isPublic: statusInfo().isPublic, code: code ? { file: code.file, decidesPublic: code.public !== undefined, ignored: code.extra } : null };
};

export function saveStatusConfig(input: StatusConfig, actor: Actor) {
  const code = codeStatusPage();
  if (code) throw new HttpError(409, `The status page is defined in ${code.file}. Change it there.`);
  const clean: StatusConfig = {
    title: input.title.trim().slice(0, 80),
    description: input.description.trim().slice(0, 280),
    components: input.components ? input.components.slice(0, 50).map((c) => ({ key: c.key, name: c.name.trim().slice(0, 60) || "Unnamed", ...(c.group?.trim() ? { group: c.group.trim().slice(0, 40) } : {}) })) : null,
    show: input.show,
    days: ([30, 60, 90] as const).includes(input.days) ? input.days : 90,
  };
  saveSetting("status_config", JSON.stringify(clean));
  audit(actor.name, actor.through, "Changed the status page", clean.title || "");
  return clean;
}

const IMPACTS = ["minor", "major", "critical", "maintenance"] as const;
const STATES = ["investigating", "identified", "monitoring", "resolved", "scheduled"] as const;

export function declareIncident(input: { title: string; impact: Impact; monitors: string[]; state: UpdateState; message: string; outageId?: number }, actor: Actor) {
  const title = input.title.trim();
  const message = input.message.trim();
  if (!title) throw new HttpError(400, "Say what is happening, in a few words.");
  if (!message) throw new HttpError(400, "Write a first update. Visitors read it.");
  if (!IMPACTS.includes(input.impact) || !STATES.includes(input.state)) throw new HttpError(400, "Unknown impact or state.");
  const now = Date.now();
  const started = input.outageId ? (db.query<{ started: number }, [number]>("SELECT started FROM monitor_outages WHERE id = ?").get(input.outageId)?.started ?? now) : now;
  const { id } = db.query<{ id: number }, [string, string, string, number, number | null, number | null]>("INSERT INTO status_incidents (title, impact, monitors, started, resolved, outage_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id").get(title, input.impact, JSON.stringify(input.monitors), started, input.state === "resolved" ? now : null, input.outageId ?? null)!;
  db.query("INSERT INTO status_updates (incident_id, state, message, at, author) VALUES (?, ?, ?, ?, ?)").run(id, input.state, message, now, actor.name);
  audit(actor.name, actor.through, "Declared an incident", title);
  return { id };
}

export function postStatusUpdate(input: { incidentId: number; state: UpdateState; message: string }, actor: Actor) {
  const incident = db.query<IncidentRow, [number]>("SELECT * FROM status_incidents WHERE id = ?").get(input.incidentId);
  if (!incident) throw new HttpError(404, "This incident does not exist.");
  if (incident.resolved) throw new HttpError(409, "This incident is resolved. Declare a new one if it came back.");
  if (!input.message.trim()) throw new HttpError(400, "Write what changed. Visitors read it.");
  if (!STATES.includes(input.state)) throw new HttpError(400, "Unknown state.");
  const now = Date.now();
  db.query("INSERT INTO status_updates (incident_id, state, message, at, author) VALUES (?, ?, ?, ?, ?)").run(incident.id, input.state, input.message.trim(), now, actor.name);
  if (input.state === "resolved") db.query("UPDATE status_incidents SET resolved = ? WHERE id = ?").run(now, incident.id);
  audit(actor.name, actor.through, input.state === "resolved" ? "Resolved an incident" : "Posted a status update", incident.title);
  return { ok: true };
}
