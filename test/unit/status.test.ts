import { beforeEach, expect, test } from "bun:test";

process.env.VIGIE_DATA_DIR ??= `/tmp/vigie-unit-${process.pid}`;
const { db } = await import("../../server/state/db.ts");
const { registry } = await import("../../server/extensions/index.ts");
const { declareIncident, postStatusUpdate, saveStatusConfig, statusEditor, statusModel } = await import("../../server/api/status.ts");
const { defineMonitor, defineStatusPage } = await import("../../sdk/index.ts");

const actor = { id: "u1", name: "Camille", role: "owner", through: "app" } as const;
const MIN = 60_000;

beforeEach(() => {
  for (const table of ["monitors", "monitor_checks", "monitor_outages", "status_incidents", "status_updates"]) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM settings WHERE key IN ('status_config', 'status_page')");
  registry.statusPages = [];
  const now = Date.now();
  for (const [id, name, state] of [["api", "API", "up"], ["web", "Website", "up"], ["db", "Database", "up"]]) {
    db.query("INSERT INTO monitors (id, name, url, managed_in, state) VALUES (?, ?, 'http://127.0.0.1/health', 'app', ?)").run(id!, name!, state!);
    db.query("INSERT INTO monitor_checks (monitor_id, at, ok, status, ms) VALUES (?, ?, 1, 200, 50)").run(id!, now - 5 * MIN);
  }
});

test("a down monitor shows on its own, before anyone writes a word", () => {
  db.exec("UPDATE monitors SET state = 'down' WHERE id = 'api'");
  db.query("INSERT INTO monitor_outages (monitor_id, started, error) VALUES ('api', ?, 'Answered 502')").run(Date.now() - 3 * MIN);
  const model = statusModel();
  expect(model.overall).toBe("major");
  expect(model.active).toHaveLength(1);
  expect(model.active[0]!.detected).toBe(true);
  expect(model.active[0]!.title).toBe("API stopped answering");
  // Visitors never see the error text.
  expect(JSON.stringify(model)).not.toContain("502");
});

test("a written incident makes the page say so, even while every check passes", () => {
  declareIncident({ title: "Slow logins", impact: "minor", monitors: ["web"], state: "investigating", message: "Signing in is slow." }, actor);
  const model = statusModel();
  expect(model.overall).toBe("degraded");
  expect(model.components.find((c) => c.name === "Website")!.state).toBe("degraded");
  expect(model.components.find((c) => c.name === "API")!.state).toBe("operational");
});

test("only what is listed shows, under its public name, and outages of the rest stay off", () => {
  db.exec("UPDATE monitors SET state = 'down' WHERE id = 'db'");
  db.query("INSERT INTO monitor_outages (monitor_id, started, error) VALUES ('db', ?, 'Could not connect')").run(Date.now() - 2 * MIN);
  saveStatusConfig({ title: "Acme", description: "", components: [{ key: "monitor:api", name: "Public API" }], show: { active: true, history: true, uptime: true, past: true }, days: 30 }, actor);
  const model = statusModel();
  expect(model.components.map((c) => c.name)).toEqual(["Public API"]);
  expect(model.overall).toBe("operational");
  expect(model.active).toHaveLength(0);
  expect(model.components[0]!.days).toHaveLength(30);
});

test("resolving moves an incident to the logbook, newest update first", () => {
  const { id } = declareIncident({ title: "Webhooks late", impact: "minor", monitors: ["api"], state: "investigating", message: "Looking." }, actor);
  postStatusUpdate({ incidentId: id, state: "resolved", message: "Fixed." }, actor);
  const model = statusModel();
  expect(model.active).toHaveLength(0);
  expect(model.past[0]!.updates.map((u) => u.state)).toEqual(["resolved", "investigating"]);
  expect(() => postStatusUpdate({ incidentId: id, state: "monitoring", message: "Again?" }, actor)).toThrow();
});

test("a page defined in code wins, and the app refuses to change it", () => {
  const api = defineMonitor({ id: "api", name: "API", url: "http://127.0.0.1/health" });
  registry.statusPages = [{ ...defineStatusPage({ title: "From code", public: true, components: [{ name: "Core", from: api }, { name: "Site", from: "monitor:web", group: "Web" }], days: 60 }), file: "status.ts" }];
  const model = statusModel();
  expect(model.title).toBe("From code");
  expect(model.isPublic).toBe(true);
  expect(model.components.map((c) => [c.key, c.name, c.group])).toEqual([["monitor:api", "Core", ""], ["monitor:web", "Site", "Web"]]);
  expect(model.daysShown).toBe(60);
  expect(statusEditor().code?.file).toBe("status.ts");
  expect(() => saveStatusConfig({ title: "x", description: "", components: null, show: { active: true, history: true, uptime: true, past: true }, days: 90 }, actor)).toThrow();
});
