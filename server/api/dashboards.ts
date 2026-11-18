import { query } from "../lib/clickhouse.ts";
import { registry } from "../extensions/index.ts";
import { audit, db } from "../state/db.ts";
import type { Block, Widget } from "../../sdk/index.ts";
import { eventView } from "../../sdk/index.ts";
import { runConsole } from "./metrics.ts";
import { HttpError, scopeOf, scopeParams, where, type Actor, type ScopeInput } from "./http.ts";

export type DashboardRecord = { id: string; title: string; source: "code" | "app"; file: string; widgets: Widget[] };

function allDashboards(): DashboardRecord[] {
  const code = registry.dashboards.map((d): DashboardRecord => ({ id: d.id, title: d.title, source: "code", file: d.file, widgets: d.widgets }));
  const app = db.query<{ id: string; name: string; definition: string }, []>("SELECT id, name, definition FROM dashboards ORDER BY name").all().map((d): DashboardRecord => ({ id: d.id, title: d.name, source: "app", file: "", widgets: (JSON.parse(d.definition) as { widgets?: Widget[] }).widgets ?? [] }));
  return [...code, ...app];
}

export const dashboards = () => allDashboards();

export function dashboard(id: string) {
  const found = allDashboards().find((d) => d.id === id);
  if (!found) throw new HttpError(404, "This dashboard does not exist.");
  return found;
}

export function saveDashboard(input: { id?: string; title: string; widgets: Widget[] }, actor: Actor) {
  if (!input.title.trim()) throw new HttpError(400, "A dashboard needs a name.");
  const id = input.id ?? crypto.randomUUID();
  if (registry.dashboards.some((d) => d.id === id)) throw new HttpError(409, "This dashboard lives in code. Edit its file.");
  db.query("INSERT OR REPLACE INTO dashboards (id, name, definition, updated_at) VALUES (?, ?, ?, ?)").run(id, input.title, JSON.stringify({ widgets: input.widgets }), Date.now());
  audit(actor.name, actor.through, "Saved dashboard", input.title);
  return { id };
}

export function deleteDashboard(id: string, actor: Actor) {
  db.query("DELETE FROM dashboards WHERE id = ?").run(id);
  audit(actor.name, actor.through, "Deleted dashboard", id);
  return { ok: true };
}

export const pageList = () => registry.pages.map((p) => ({ id: p.id, title: p.title, group: p.nav?.group ?? "Processes", order: p.nav?.order ?? 50, file: p.file }));

export async function customPage(input: ScopeInput & { id: string }) {
  const page = registry.pages.find((p) => p.id === input.id);
  if (!page) throw new HttpError(404, "This page is not defined.");
  const { id: _, ...scope } = input;
  const single = async (sql: string) => (await runConsole({ ...scope, sql })).rows[0] ?? {};
  const stateBlock = page.layout.find((b): b is Extract<Block, { b: "state" }> => b.b === "state");
  const state = stateBlock ? stateBlock.text(await single(stateBlock.sql)) : null;
  const funnels = await Promise.all(
    page.layout
      .filter((b): b is Extract<Block, { b: "funnel" }> => b.b === "funnel")
      .map(async (block) => ({
        title: block.title,
        source: block.source ?? "",
        steps: await Promise.all(block.steps.map(async (step) => ({ label: step.label, note: step.note ?? "", bad: step.bad ?? false, value: Number(Object.values(await single(step.sql))[0] ?? 0) }))),
      })),
  );
  const plain = (block: Block): Exclude<Block, { b: "state" }> | null => (block.b === "state" ? null : block.b === "row" ? { b: "row", children: block.children.map(plain).filter((c): c is Exclude<Block, { b: "state" }> => c !== null) } : block);
  return { id: page.id, title: page.title, file: page.file, process: page.process ?? null, state: JSON.stringify(state), funnels, layout: JSON.stringify(page.layout.filter((b) => b.b !== "state" && b.b !== "funnel").map(plain)) };
}

export async function eventsBlock(input: ScopeInput & { match: Record<string, string | number | { gt: number }>; limit?: number }) {
  const scope = scopeOf(input);
  const params: Record<string, string | number | string[] | undefined> = { ...scopeParams(scope) };
  const parts = [where(scope)];
  Object.entries(input.match).forEach(([key, value], index) => {
    params[`k${index}`] = key;
    if (typeof value === "object") {
      params[`v${index}`] = value.gt;
      parts.push(`toFloat64OrZero(LogAttributes[{k${index}:String}]) > {v${index}:Float64}`);
    } else {
      params[`v${index}`] = String(value);
      parts.push(`LogAttributes[{k${index}:String}] = {v${index}:String}`);
    }
  });
  return query<{ id: string; traceId: string; taskId: string; t: number; level: string; kind: string; method: string; route: string; taskKind: string; status: number; duration: number; body: string; why: string }>(`SELECT EventId AS id, TraceId AS traceId, TaskId AS taskId, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, SeverityText AS level, Kind AS kind, Method AS method, Route AS route, TaskKind AS taskKind, Status AS status, DurationMs AS duration, Body AS body, LogAttributes['why'] AS why FROM logs WHERE ${parts.join(" AND ")} ORDER BY Timestamp DESC LIMIT ${Math.min(input.limit ?? 20, 200)}`, { params });
}

export { eventView };
