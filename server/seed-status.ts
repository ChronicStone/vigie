import { db } from "./state/db.ts";

/**
 * Status history for a demo or a screenshot: four monitors with 90 days of checks, a few outages,
 * one written incident per kind, and one still open. Local mode only, and only once.
 */
const DAY = 86_400_000;
const STEP = 15 * 60_000;

type Outage = { monitor: string; daysAgo: number; at: number; minutes: number; error: string };

export function seedStatus(healthUrl: string) {
  if (db.query("SELECT 1 FROM monitors WHERE id = 'demo-api'").get()) return false;
  const now = Date.now();
  const monitors = [
    ["demo-website", "Website"],
    ["demo-api", "API"],
    ["demo-dashboard", "Dashboard"],
    ["demo-webhooks", "Webhooks"],
  ] as const;
  // They check this Vigie, so they stay up after the seed. Only history is invented.
  for (const [id, name] of monitors) db.query("INSERT INTO monitors (id, name, url, managed_in, state, since) VALUES (?, ?, ?, 'app', 'up', ?)").run(id, name, healthUrl, now - 2 * DAY);

  const outages: Outage[] = [
    { monitor: "demo-api", daysAgo: 2, at: 2 * 60 + 46, minutes: 14, error: "Answered 502" },
    { monitor: "demo-api", daysAgo: 9, at: 0 * 60 + 29, minutes: 9, error: "No answer in 10 s" },
    { monitor: "demo-website", daysAgo: 23, at: 2 * 60 + 41, minutes: 16, error: "Could not connect" },
    { monitor: "demo-dashboard", daysAgo: 23, at: 2 * 60 + 41, minutes: 16, error: "Could not connect" },
    { monitor: "demo-webhooks", daysAgo: 41, at: 14 * 60 + 5, minutes: 95, error: "Answered 503" },
    { monitor: "demo-api", daysAgo: 58, at: 9 * 60 + 12, minutes: 4, error: "Answered 500" },
  ];
  const windows = outages.map((o) => {
    const start = Math.floor((now - o.daysAgo * DAY) / DAY) * DAY + o.at * 60_000;
    return { ...o, start, end: start + o.minutes * 60_000 };
  });
  const insert = db.query("INSERT OR REPLACE INTO monitor_checks (monitor_id, at, ok, status, ms) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const [id] of monitors) {
      // Webhooks started being checked 70 days ago: the oldest bars stay empty.
      const first = id === "demo-webhooks" ? now - 70 * DAY : now - 90 * DAY;
      for (let at = Math.ceil(first / STEP) * STEP; at < now; at += STEP) {
        const down = windows.some((w) => w.monitor === id && at >= w.start - STEP && at <= w.end);
        insert.run(id, at, down ? 0 : 1, down ? 502 : 200, down ? 10_000 : 80 + Math.round(Math.random() * 120));
      }
    }
  })();
  const outageIds = windows.map((w) => db.query<{ id: number }, [string, number, number, string]>("INSERT INTO monitor_outages (monitor_id, started, ended, error) VALUES (?, ?, ?, ?) RETURNING id").get(w.monitor, w.start, w.end, w.error)!.id);

  const incident = (title: string, impact: string, monitorIds: string[], started: number, resolved: number | null, outageId: number | null, updates: [string, string, number][]) => {
    const { id } = db.query<{ id: number }, [string, string, string, number, number | null, number | null]>("INSERT INTO status_incidents (title, impact, monitors, started, resolved, outage_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id").get(title, impact, JSON.stringify(monitorIds), started, resolved, outageId)!;
    for (const [state, message, at] of updates) db.query("INSERT INTO status_updates (incident_id, state, message, at, author) VALUES (?, ?, ?, ?, 'Camille')").run(id, state, message, at);
  };
  const api = windows[0]!;
  incident("API returning errors", "critical", ["demo-api"], api.start, api.end, outageIds[0]!, [
    ["investigating", "Requests to the API fail with a 502. We are looking into it.", api.start + 3 * 60_000],
    ["identified", "A database failover left the API without connections. We are restarting it.", api.start + 8 * 60_000],
    ["resolved", "The API answers normally again. No data was lost.", api.end + 60_000],
  ]);
  const edge = windows[2]!;
  incident("Website and dashboard unreachable", "major", ["demo-website", "demo-dashboard"], edge.start, edge.end, outageIds[2]!, [
    ["investigating", "Our hosting provider has an incident on its load balancers.", edge.start + 4 * 60_000],
    ["resolved", "The provider fixed its load balancers. Everything is reachable again.", edge.end + 2 * 60_000],
  ]);
  const upgrade = Math.floor((now - 12 * DAY) / DAY) * DAY + 5 * 3_600_000;
  incident("Database upgrade", "maintenance", ["demo-api", "demo-dashboard"], upgrade, upgrade + 25 * 60_000, null, [
    ["scheduled", "We upgrade the database between 05:00 and 05:30 UTC. The dashboard may be slow.", upgrade - DAY],
    ["resolved", "The upgrade is done.", upgrade + 25 * 60_000],
  ]);
  incident("Webhooks arrive late", "minor", ["demo-webhooks"], now - 38 * 60_000, null, null, [
    ["investigating", "Some webhooks reach your endpoints up to 10 minutes late. Nothing is lost.", now - 36 * 60_000],
    ["identified", "One delivery worker is stuck on a slow endpoint. We are moving its queue to the others.", now - 12 * 60_000],
  ]);
  return true;
}
