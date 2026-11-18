import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "../config.ts";

/** Mutable state: issues, alert state, dashboards, saved views, tokens. Telemetry itself stays in ClickHouse. */
export const db = new Database(process.env.VIGIE_STATE_DB ?? join(config.dataDir, "vigie.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA cache_size = -8000; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS issues (
  fingerprint TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  service TEXT NOT NULL,
  environment TEXT NOT NULL,
  entry TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee TEXT,
  regressed INTEGER NOT NULL DEFAULT 0,
  regressed_in TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  archived_until INTEGER,
  why TEXT,
  fix TEXT,
  link TEXT,
  stack TEXT
);
CREATE INDEX IF NOT EXISTS issues_status ON issues(status, last_seen);
CREATE TABLE IF NOT EXISTS issue_activity (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  rule TEXT NOT NULL,
  managed_in TEXT NOT NULL DEFAULT 'app',
  paused INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'ok',
  value REAL,
  since INTEGER,
  last_fired INTEGER,
  last_checked INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  alert_id TEXT NOT NULL,
  started INTEGER NOT NULL,
  ended INTEGER,
  peak REAL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  secret TEXT,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  filter TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',
  environment TEXT,
  owner TEXT,
  created_at INTEGER NOT NULL,
  last_used INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  through TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  environment TEXT NOT NULL,
  version TEXT NOT NULL,
  at INTEGER NOT NULL,
  declared_by TEXT,
  UNIQUE(service, environment, version)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export function audit(actor: string, through: "app" | "mcp" | "api" | "system", action: string, target?: string, ip?: string) {
  db.query("INSERT INTO audit (at, actor, through, action, target, ip) VALUES (?, ?, ?, ?, ?, ?)").run(Date.now(), actor, through, action, target ?? null, ip ?? null);
}

db.exec(`
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  href TEXT,
  read_at INTEGER,
  dedupe TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS bulk_actions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  filter TEXT NOT NULL,
  eligible TEXT NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS production_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_by TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mute_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  service TEXT,
  environment TEXT,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  expect INTEGER,
  managed_in TEXT NOT NULL DEFAULT 'app',
  paused INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'unknown',
  since INTEGER,
  fails INTEGER NOT NULL DEFAULT 0,
  last_checked INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS monitor_checks (
  monitor_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  ms INTEGER,
  PRIMARY KEY (monitor_id, at)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS status_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  impact TEXT NOT NULL DEFAULT 'major',
  monitors TEXT NOT NULL DEFAULT '[]',
  started INTEGER NOT NULL,
  resolved INTEGER,
  outage_id INTEGER
);
CREATE TABLE IF NOT EXISTS status_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  message TEXT NOT NULL,
  at INTEGER NOT NULL,
  author TEXT
);
CREATE INDEX IF NOT EXISTS status_updates_incident ON status_updates (incident_id, at);
CREATE TABLE IF NOT EXISTS monitor_outages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL,
  started INTEGER NOT NULL,
  ended INTEGER,
  error TEXT
);
`);
try {
  db.exec("ALTER TABLE alerts ADD COLUMN quiet_pending INTEGER NOT NULL DEFAULT 0");
} catch {
  // The column is already there.
}

for (const column of ["headline TEXT", "recovered TEXT", "notified INTEGER NOT NULL DEFAULT 0"]) {
  try {
    db.exec(`ALTER TABLE incidents ADD COLUMN ${column}`);
  } catch {}
}
for (const column of ["resolved_at INTEGER", "linear_url TEXT", "muted_by TEXT"]) {
  try {
    db.exec(`ALTER TABLE issues ADD COLUMN ${column}`);
  } catch {}
}
