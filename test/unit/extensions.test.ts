import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.VIGIE_DATA_DIR = join(tmpdir(), `vigie-unit-${process.pid}`);
const { loadExtensions, registry, renderEvent, explainError, rowPhrases } = await import("../../server/extensions/index.ts");

beforeAll(async () => {
  await loadExtensions();
});

test("the shipped definitions all load", () => {
  expect(registry.loaded.filter((l) => !l.ok)).toEqual([]);
  expect(registry.processes.length).toBeGreaterThan(3);
  expect(registry.alerts.length).toBeGreaterThan(3);
  expect(registry.dashboards.length).toBeGreaterThan(3);
  expect(registry.pages.map((p) => p.id).sort()).toEqual(["invoxa", "parcelo", "paynest"]);
});

test("a renderer claims its namespace, nothing is hidden", () => {
  const view = renderEvent({ "parcelo.operation": "createShipment", "parcelo.outcome": "refused", status: "502", "db.queries": "3", "db.durationMs": "10", durationMs: "100" });
  expect(view.sections.map((s) => s.title)).toEqual(expect.arrayContaining(["Parcelo", "Database"]));
  expect(view.rest).toContain("status");
  expect(view.rest).not.toContain("parcelo.outcome");
});

test("a row phrase comes from the renderer", () => {
  expect(rowPhrases({ "db.repeatedQueries": "14", "db.queries": "20" })).toContain("same query 14 times");
});

test("why and fix: the app's own text wins, the catalogue fills the gap", () => {
  expect(explainError({ why: "mine", fix: "do it", "error.name": "X" })?.why).toBe("mine");
  const known = explainError({ "error.name": "InvoxaInvalidCountryError", "error.message": "Invalid country code FX", "taskOutcome.code": "INVOXA_INVALID_COUNTRY" });
  expect(known?.why).toContain("Invoxa refused");
  expect(known?.fix).toContain("requeue");
  expect(explainError({ status: "200" })).toBeNull();
});
