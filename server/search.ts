import { query } from "./lib/clickhouse.ts";
import { db } from "./state/db.ts";

/** Palette search: pasted ids resolve to the entity, anything else matches routes, kinds and issues. */
export async function globalSearch(input: { q: string; env: string }) {
  const q = input.q.trim();
  const env = input.env;
  if (q.length < 2) return [];
  const out: { label: string; kind: string; to: string; search?: Record<string, string> }[] = [];
  if (/^[0-9a-f]{16,32}$/i.test(q)) {
    const [trace] = await query<{ id: string }>("SELECT TraceId AS id FROM trace_index WHERE TraceId = {q:String} LIMIT 1", { params: { q } });
    if (trace) out.push({ label: `Trace ${q}`, kind: "Trace", to: `/traces/${q}` });
  }
  const [routes, kinds, tasks] = await Promise.all([
    query<{ method: string; route: string }>("SELECT DISTINCT Method AS method, Route AS route FROM req_1m WHERE Minute >= now() - INTERVAL 7 DAY AND Environment = {env:String} AND positionCaseInsensitive(Route, {q:String}) > 0 LIMIT 8", { params: { q, env } }),
    query<{ kind: string }>("SELECT DISTINCT TaskKind AS kind FROM task_1m WHERE Minute >= now() - INTERVAL 7 DAY AND Environment = {env:String} AND positionCaseInsensitive(TaskKind, {q:String}) > 0 LIMIT 8", { params: { q, env } }),
    q.length >= 6 ? query<{ id: string; kind: string }>("SELECT TaskId AS id, any(TaskKind) AS kind FROM logs WHERE Kind = 'task' AND TaskId = {q:String} GROUP BY id LIMIT 1", { params: { q } }) : Promise.resolve([]),
  ]);
  for (const task of tasks) out.push({ label: `${task.kind}, run ${task.id}`, kind: "Task run", to: `/tasks/run/${task.id}` });
  for (const r of routes) out.push({ label: `${r.method} ${r.route}`, kind: "Route", to: "/requests/route", search: { method: r.method, route: r.route } });
  for (const k of kinds) out.push({ label: k.kind, kind: "Task kind", to: `/tasks/kind/${encodeURIComponent(k.kind)}` });
  for (const issue of db.query<{ fingerprint: string; name: string }, [string, string]>("SELECT fingerprint, name FROM issues WHERE name LIKE ? AND environment = ? LIMIT 6").all(`%${q}%`, env)) out.push({ label: issue.name, kind: "Issue", to: `/issues/${issue.fingerprint}` });
  return out;
}

