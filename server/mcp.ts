import { actorOf } from "./auth.ts";
import { eventAsText, explainError, registry } from "./extensions/index.ts";
import { query } from "./lib/clickhouse.ts";
import { audit, db } from "./state/db.ts";
import { CONSOLE_TABLES, runConsole } from "./api/metrics.ts";
import { logFilter } from "./api/logs.ts";
import { readEvent } from "./api/logs.ts";
import { readTrace } from "./api/traces.ts";
import { listRuns } from "./api/tasks.ts";
import { processSummaries } from "./api/processes.ts";
import { declareIncident, postStatusUpdate, statusModel } from "./api/status.ts";
import { config } from "./config.ts";
import { dt, scopeOf, type Actor, type ScopeInput } from "./api/http.ts";
import { accounts, aiUsage, emails, external, hostPressure, provider, queries, queryDetail, requests, requestSummary, routeDetail, runtime, serviceMap, services, user, users, whatRanHere } from "./api/backend.ts";
import { logFacet, logFields, logRows } from "./api/logs.ts";
import { metricAttributes, metricList, metricSeries } from "./api/metrics.ts";
import { traceList } from "./api/traces.ts";
import { actionsEnabled, bulkDryRun, schedules, switchHistory, taskAction, taskHealth, taskKind, taskRun, workers } from "./api/tasks.ts";
import { processDetail, processInstance } from "./api/processes.ts";
import { alertDetail, alertPreview, createAlert, createLinearIssue, createProductionRule, deleteAlert, issueDetail, muteLike, pauseAlert, releases, rules, slos, unmute, updateAlert, updateIssue } from "./api/reliability.ts";
import { dbRows, dbSql, dbStructure, dbTables } from "./api/database.ts";
import { dashboard, dashboards, deleteDashboard, saveDashboard } from "./api/dashboards.ts";
import { createMonitor, deleteMonitor, uptime } from "./api/uptime.ts";
import { globalSearch } from "./search.ts";

type Args = Record<string, any>;
type ToolDef = { name: string; description: string; scope: "read" | "write"; input: Record<string, unknown>; run: (args: Args, actor: Actor) => unknown | Promise<unknown> };

const scopeArgs = {
  env: { type: "string", enum: config.environments, description: `Environment. PRD is Prod, STG is Test, DEV is Local. Default ${config.mainEnvironment}.` },
  minutes: { type: "number", description: "How far back to look. Default 60." },
};

function inputFrom(args: Args): ScopeInput {
  const to = Date.now();
  return { env: args.env ?? config.mainEnvironment, from: to - (args.minutes ?? 60) * 60_000, to };
}
const scopeFrom = (args: Args) => scopeOf(inputFrom(args));

export const BUILTIN_TOOLS: ToolDef[] = [
  {
    name: "get_context_pack",
    description: "A short brief of the running system: traffic, errors, open issues, firing alerts, failing tasks, process states. Call this first.",
    scope: "read",
    input: { type: "object", properties: scopeArgs },
    run: async (args) => {
      const scope = scopeFrom(args);
      const [summary, processes, tasks] = await Promise.all([
        requestSummary(scope),
        processSummaries(scope),
        query(`SELECT TaskKind AS kind, sum(Attempts) AS attempts, sumIf(Attempts, Outcome = 'failed') AS failed FROM task_1m WHERE Minute >= now() - INTERVAL {m:UInt32} MINUTE AND Environment = {env:String} GROUP BY kind HAVING failed > 0 ORDER BY failed DESC LIMIT 10`, { params: { m: args.minutes ?? 60, env: scope.env } }),
      ]);
      return {
        requests: summary,
        issues: db.query("SELECT fingerprint, name, message, priority, regressed, events FROM issues WHERE status = 'open' AND environment = ? ORDER BY last_seen DESC LIMIT 10").all(scope.env),
        firingAlerts: db.query("SELECT id, name, value FROM alerts WHERE state = 'firing'").all(),
        failingTasks: tasks,
        processes: processes.map((p) => ({ id: p.id, title: p.title, state: p.state, stuck: p.stuck, failed: p.failed })),
      };
    },
  },
  {
    name: "search_logs",
    description: "Search wide events and logs. The query takes free text and fields: status>=500, route.pattern^/v1, user.plan=pro.",
    scope: "read",
    input: { type: "object", properties: { q: { type: "string" }, level: { type: "string" }, limit: { type: "number" }, ...scopeArgs } },
    run: async (args) => {
      const scope = scopeFrom(args);
      const { sql, params } = logFilter({ ...inputFrom(args), q: args.q, level: args.level }, scope);
      return query(`SELECT EventId AS id, Timestamp AS at, SeverityText AS level, ServiceName AS service, Body AS message, Kind AS kind, TraceId AS traceId, LogAttributes['why'] AS why FROM logs WHERE ${sql} ORDER BY Timestamp DESC LIMIT ${Math.min(args.limit ?? 30, 200)}`, { params });
    },
  },
  {
    name: "get_event",
    description: "One wide event with every field, plus what custom renderers say about it.",
    scope: "read",
    input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: async (args) => {
      const event = await readEvent(args.id);
      return { ...event, explained: explainError(event.attrs), summary: eventAsText(event.attrs) };
    },
  },
  {
    name: "get_trace",
    description: "Every span and log of a trace. Long traces are summarised by span kind.",
    scope: "read",
    input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: async (args) => {
      const trace = await readTrace(args.id);
      return {
        spans: trace.spans.slice(0, 200).map((s: any) => ({ id: s.id, parent: s.parent, name: s.name, ms: s.duration, status: s.status, statement: s.statement || undefined, peer: s.peer || undefined, httpStatus: s.httpStatus || undefined })),
        logs: trace.logs,
        truncated: trace.spans.length > 200,
      };
    },
  },
  {
    name: "list_tasks",
    description: "Task runs, newest first. Filter by kind, view (open, late, held), worker or free text.",
    scope: "read",
    input: { type: "object", properties: { kind: { type: "string" }, view: { type: "string" }, q: { type: "string" }, ...scopeArgs } },
    run: async (args) => {
      return (await listRuns({ ...inputFrom(args), kind: args.kind, view: args.view, q: args.q }, 100)).slice(0, 100);
    },
  },
  {
    name: "list_issues",
    description: "Errors grouped by cause.",
    scope: "read",
    input: { type: "object", properties: { status: { type: "string", enum: ["open", "resolved", "archived"] }, env: { type: "string" } } },
    run: (args) => db.query("SELECT fingerprint, name, message, service, status, priority, regressed, regressed_in, events, last_seen, why, fix FROM issues WHERE status = ? AND environment = ? ORDER BY last_seen DESC LIMIT 100").all(args.status ?? "open", args.env ?? config.mainEnvironment),
  },
  {
    name: "list_alerts",
    description: "Every alert with its state and current value.",
    scope: "read",
    input: { type: "object", properties: {} },
    run: () => db.query("SELECT id, name, family, state, value, paused, managed_in, last_fired, error FROM alerts ORDER BY name").all(),
  },
  {
    name: "list_processes",
    description: "Business processes defined in code, with their state.",
    scope: "read",
    input: { type: "object", properties: scopeArgs },
    run: (args) => processSummaries(scopeFrom(args)),
  },
  {
    name: "run_query",
    description: `Read-only SELECT over telemetry. Tables: ${Object.keys(CONSOLE_TABLES).join(", ")}. Macros: $__timeFilter(column), $__env.`,
    scope: "read",
    input: { type: "object", required: ["sql"], properties: { sql: { type: "string" }, ...scopeArgs } },
    run: (args) => runConsole({ ...inputFrom(args), sql: args.sql }),
  },
  {
    name: "resolve_issue",
    description: "Mark an issue resolved. It reopens as a regression if it fires again.",
    scope: "write",
    input: { type: "object", required: ["fingerprint"], properties: { fingerprint: { type: "string" }, note: { type: "string" } } },
    run: (args, actor) => {
      db.query("UPDATE issues SET status = 'resolved', regressed = 0 WHERE fingerprint = ?").run(args.fingerprint);
      db.query("INSERT INTO issue_activity (fingerprint, at, actor, action, note) VALUES (?, ?, ?, 'Resolved', ?)").run(args.fingerprint, Date.now(), actor.name, args.note ?? null);
      audit(actor.name, "mcp", "Resolved an issue", args.fingerprint);
      return { ok: true };
    },
  },
  {
    name: "pause_alert",
    description: "Pause or resume an alert.",
    scope: "write",
    input: { type: "object", required: ["id", "paused"], properties: { id: { type: "string" }, paused: { type: "boolean" } } },
    run: (args, actor) => {
      db.query("UPDATE alerts SET paused = ? WHERE id = ?").run(args.paused ? 1 : 0, args.id);
      audit(actor.name, "mcp", args.paused ? "Paused alert" : "Resumed alert", args.id);
      return { ok: true };
    },
  },
];

const prop = {
  env: scopeArgs.env,
  minutes: scopeArgs.minutes,
  id: { type: "string" },
  limit: { type: "number", description: "Most rows to return. Default 50." },
  reason: { type: "string", description: "Why. Recorded in the audit log." },
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const scoped = (extra: Record<string, unknown> = {}, required: string[] = []) => obj({ env: prop.env, minutes: prop.minutes, ...extra }, required);
const top = <T>(rows: T[], args: Args, fallback = 50) => rows.slice(0, Math.min(args.limit ?? fallback, 500));
const read = (name: string, description: string, input: Record<string, unknown>, run: ToolDef["run"]): ToolDef => ({ name, description, scope: "read", input, run });
const write = (name: string, description: string, input: Record<string, unknown>, run: ToolDef["run"]): ToolDef => ({ name, description, scope: "write", input, run });

/** Lean answers: summaries and top rows, never chart series. Payloads never leave through MCP. */
const FULL_TOOLS: ToolDef[] = [
  read("whoami", "The caller, role and what it can see.", obj({}), (_, actor) => ({ id: actor.id, name: actor.name, role: actor.role, through: actor.through })),
  read("list_services", "Services with version, throughput, errors and last seen.", scoped(), async (args) => (await services(inputFrom(args))).map(({ spark, ...row }) => row)),
  read("list_environments", "Environments that sent data in the last 7 days.", obj({}), () => query("SELECT DISTINCT Environment AS name FROM logs WHERE Timestamp >= now() - INTERVAL 7 DAY")),
  read("search", "Find a route, task kind, issue, trace id or task id.", obj({ q: { type: "string" }, env: prop.env }, ["q"]), (args) => globalSearch({ q: args.q, env: args.env ?? config.mainEnvironment })),
  read("list_logs", "Events by level, service or any field. Same query as search_logs, with fields included.", scoped({ q: { type: "string" }, level: { type: "string" }, kind: { type: "string", enum: ["wide", "plain", "both"] }, limit: prop.limit }), async (args) => (await logRows({ ...inputFrom(args), q: args.q, level: args.level, kind: args.kind, limit: Math.min(args.limit ?? 50, 200) })).rows),
  read("get_log_attributes", "Attribute keys with counts, or the values of one key, to filter on.", scoped({ key: { type: "string" } }), (args) => (args.key ? logFacet({ ...inputFrom(args), field: args.key }) : logFields(inputFrom(args)))),
  read("list_traces", "Traces, newest or slowest. Accepts duration>500ms, a route or a trace id.", scoped({ q: { type: "string" }, errors: { type: "boolean" }, slowest: { type: "boolean" }, limit: prop.limit }), async (args) => (await traceList({ ...inputFrom(args), q: args.q, filter: args.errors ? "error" : undefined, sort: args.slowest ? "duration" : undefined, limit: Math.min(args.limit ?? 50, 200) })).rows),
  read("get_trace_logs", "The log lines of a trace, on the trace's clock.", obj({ id: prop.id }, ["id"]), async (args) => (await readTrace(args.id)).logs),
  read("explain_execution", "A trace as a short brief: what ran, what failed, why, the slowest spans.", obj({ id: prop.id }, ["id"]), async (args) => {
    const { spans, logs } = await readTrace(args.id);
    const failed = spans.filter((s) => s.status === "Error" || s.httpStatus >= 400);
    const explained = logs.find((l) => l.why);
    const slowest = [...spans].sort((a, b) => b.duration - a.duration).slice(0, 8);
    return { root: spans.find((s) => !s.parent)?.name, spans: spans.length, why: explained?.why, fix: explained?.fix, failed: failed.map((s) => ({ name: s.name, ms: Math.round(s.duration), status: s.httpStatus || s.status, message: s.message })), slowest: slowest.map((s) => ({ name: s.name, ms: Math.round(s.duration) })), queries: spans.filter((s) => s.statement).length };
  }),
  read("list_metrics", "Metric names with type, unit and last seen.", scoped(), (args) => metricList(inputFrom(args))),
  read("get_metric_attributes", "The attributes of one metric, to group or filter by.", scoped({ name: { type: "string" } }, ["name"]), (args) => metricAttributes({ ...inputFrom(args), name: args.name })),
  read("get_metric", "A metric summarised: latest, average, minimum, maximum per series.", scoped({ name: { type: "string" }, type: { type: "string", enum: ["Gauge", "Sum", "Histogram"] }, groupBy: { type: "string" } }, ["name"]), async (args) => {
    const points = await metricSeries({ ...inputFrom(args), name: args.name, type: args.type ?? "Gauge", agg: args.type === "Histogram" ? "p95" : "avg", groupBy: args.groupBy ?? "service.name" });
    const bySeries = new Map<string, number[]>();
    for (const point of points) bySeries.set(point.series, [...(bySeries.get(point.series) ?? []), point.v]);
    return [...bySeries].map(([series, values]) => ({ series, latest: values[values.length - 1], avg: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values) }));
  }),
  read("list_instances", "Instances reporting runtime metrics, with version and uptime.", scoped(), async (args) => (await runtime(inputFrom(args))).instances),
  read("list_endpoints", "Routes with volume, average, p95 and error rate.", scoped({ limit: prop.limit }), async (args) => {
    const result = await requests(inputFrom(args));
    return result.tab === "matched" ? top(result.rows.map(({ spark, ...row }) => row), args) : [];
  }),
  read("get_endpoint_stats", "One route: stats, N+1 suspects, provider calls and recent requests.", scoped({ method: { type: "string" }, route: { type: "string" } }, ["method", "route"]), async (args) => {
    const { series, ...rest } = await routeDetail({ ...inputFrom(args), method: args.method, route: args.route });
    return { ...rest, recent: rest.recent.slice(0, 10) };
  }),
  read("list_slow_operations", "The slowest routes by p95, with volume beside them.", scoped({ limit: prop.limit }), async (args) => {
    const result = await requests(inputFrom(args));
    return result.tab === "matched" ? top(result.rows.map(({ spark, ...row }) => row).sort((a, b) => b.p95 - a.p95), args, 15) : [];
  }),
  read("get_request", "One request by trace id: its event, why, queries and failing spans.", obj({ id: prop.id }, ["id"]), async (args) => {
    const { spans, logs } = await readTrace(args.id);
    const wide = logs.find((l) => l.kind === "request");
    const event = wide ? await readEvent(wide.id) : null;
    return { event: event?.attrs, explained: event ? explainError(event.attrs) : null, queries: spans.filter((s) => s.statement).length, failed: spans.filter((s) => s.status === "Error" || s.httpStatus >= 400).map((s) => ({ name: s.name, status: s.httpStatus, message: s.message })) };
  }),
  read("list_db_queries", "Query patterns by total time.", scoped({ limit: prop.limit }), async (args) => {
    const { result } = await queries(inputFrom(args));
    return result.tab === "patterns" ? top(result.rows, args) : [];
  }),
  read("get_db_query_detail", "One query pattern: stats, callers and how often it repeats in a request.", scoped({ hash: { type: "string" } }, ["hash"]), async (args) => {
    const { series, ...rest } = await queryDetail({ ...inputFrom(args), hash: args.hash });
    return { ...rest, recent: rest.recent.slice(0, 10) };
  }),
  read("list_external_calls", "Hosts called, with volume, errors and latency.", scoped(), async (args) => (await external(inputFrom(args))).rows),
  read("get_external_call_detail", "One host: operations, status codes and recent calls.", scoped({ host: { type: "string" } }, ["host"]), async (args) => {
    const { series, ...rest } = await provider({ ...inputFrom(args), host: args.host });
    return { ...rest, calls: rest.calls.slice(0, 10) };
  }),
  read("list_providers", "Named providers from the catalogue, with volume and errors.", scoped(), async (args) => (await external(inputFrom(args))).rows.filter((r) => r.name !== r.host)),
  read("get_provider", "One provider by host.", scoped({ host: { type: "string" } }, ["host"]), async (args) => {
    const { series, ...rest } = await provider({ ...inputFrom(args), host: args.host });
    return { ...rest, calls: rest.calls.slice(0, 10) };
  }),
  read("list_emails", "Sends, refusals and delivery outcomes by template.", scoped(), async (args) => {
    const { series, ...rest } = await emails(inputFrom(args));
    return rest;
  }),
  read("list_ai_usage", "Calls, tokens, cost and failures by feature and model.", scoped(), async (args) => {
    const { series, ...rest } = await aiUsage(inputFrom(args));
    return rest;
  }),
  read("get_task_health", "The three verdicts, Flow, Execution and Liveness, with the kinds behind them.", scoped(), async (args) => {
    const { verdict, backlog } = await taskHealth(inputFrom(args));
    return { verdict, backlog };
  }),
  read("list_task_kinds", "Per kind: state, runs, failed share, p95, queue wait.", scoped(), async (args) => (await taskHealth(inputFrom(args))).rows.map(({ strip, ...row }) => row)),
  read("get_task_kind", "One kind: definition, failure codes and retry ladder.", scoped({ kind: { type: "string" } }, ["kind"]), async (args) => {
    const { series, duration, strip, ...rest } = await taskKind({ ...inputFrom(args), kind: args.kind });
    return rest;
  }),
  read("get_task", "One task and its attempts. Payload and result never leave through MCP.", obj({ id: prop.id }, ["id"]), async (args) => {
    const { spans, logs, payload, result, ...rest } = await taskRun(args.id);
    return rest;
  }),
  read("get_task_timeline", "A run as phases: attempts, gaps, and the slowest calls of each attempt.", obj({ id: prop.id }, ["id"]), async (args) => {
    const run = await taskRun(args.id);
    return run.attempts.map((a) => ({ attempt: a.number, outcome: a.outcome, code: a.code, why: a.why, worker: a.worker, ms: a.duration, slowest: run.spans.filter((s) => s.traceId === a.traceId && s.parent).sort((x, y) => y.duration - x.duration).slice(0, 5).map((s) => ({ name: s.name, ms: Math.round(s.duration) })) }));
  }),
  read("list_task_failures", "Open failures grouped by kind and code.", scoped(), async (args) => {
    const scope = scopeFrom(args);
    return query(`SELECT TaskKind AS kind, LogAttributes['taskOutcome.code'] AS code, count() AS attempts, any(if(LogAttributes['why'] != '', LogAttributes['why'], LogAttributes['reason'])) AS why, argMax(TaskId, Timestamp) AS sampleTask FROM logs WHERE Environment = {env:String} AND Kind = 'task' AND Outcome = 'failed' AND Timestamp >= toDateTime64({from:String}, 3) GROUP BY kind, code ORDER BY attempts DESC LIMIT 50`, { params: { env: scope.env, from: dt(scope.from) } });
  }),
  read("list_held_tasks", "Tasks held behind a switch that is off. Needs the app database.", scoped(), (args) => listRuns({ ...inputFrom(args), view: "held" }, 100)),
  read("list_workers", "Workers with attempts, last seen and lease losses.", scoped(), async (args) => (await workers(inputFrom(args))).rows),
  read("list_schedules", "Clocks with next run, last run and failures in a row.", scoped(), async (args) => (await schedules(inputFrom(args))).map(({ strip, ...row }) => row)),
  ...(["requeue", "run-now", "cancel", "ignore"] as const).map((action) => write(`${action.replace("-now", "_now").replace("run_now", "run")}_task`.replace("run_task", "run_task_now"), `${action} a task through the app's API, as the caller. Needs a signed-in person: a machine token is refused.`, obj({ id: prop.id, reason: prop.reason }, ["id", "reason"]), (args, actor) => taskAction({ id: args.id, action, reason: args.reason }, actor))),
  write("bulk_task_action", "Requeue, cancel or ignore many tasks. Stores a dry run: nothing changes here.", scoped({ action: { type: "string", enum: ["requeue", "cancel", "ignore"] }, reason: prop.reason, ids: { type: "array", items: { type: "string" } }, kind: { type: "string" } }, ["action", "reason"]), (args, actor) => bulkDryRun({ ...inputFrom(args), action: args.action, reason: args.reason, ids: args.ids, filter: args.kind ? { kind: args.kind } : undefined }, actor)),
  read("get_process", "One process: steps, completed, failed, stuck, p50 and p95.", scoped({ id: prop.id }, ["id"]), async (args) => {
    const { recent, ...rest } = await processDetail({ ...inputFrom(args), id: args.id });
    return { ...rest, attention: rest.attention.slice(0, 20) };
  }),
  read("list_process_instances", "Recent instances of a process.", scoped({ id: prop.id }, ["id"]), async (args) => (await processDetail({ ...inputFrom(args), id: args.id })).recent),
  read("list_stuck_instances", "Instances past a step's expected time, or failed.", scoped({ id: prop.id }, ["id"]), async (args) => (await processDetail({ ...inputFrom(args), id: args.id })).attention),
  read("get_process_instance", "One subject's journey, with why and fix.", scoped({ id: prop.id, key: { type: "string" } }, ["id", "key"]), (args) => processInstance({ ...inputFrom(args), id: args.id, key: args.key })),
  read("get_issue", "One issue: what, where, accounts and the latest occurrence.", scoped({ fingerprint: { type: "string" } }, ["fingerprint"]), async (args) => {
    const { series, activity, ...rest } = await issueDetail({ ...inputFrom(args), fp: args.fingerprint });
    return rest;
  }),
  read("get_issue_activity", "Who did what on an issue.", obj({ fingerprint: { type: "string" } }, ["fingerprint"]), (args) => db.query("SELECT at, actor, action, note FROM issue_activity WHERE fingerprint = ? ORDER BY at DESC LIMIT 50").all(args.fingerprint)),
  read("list_occurrences", "Recent events of an issue.", scoped({ fingerprint: { type: "string" }, limit: prop.limit }, ["fingerprint"]), (args) => query(`SELECT EventId AS id, TraceId AS traceId, TaskId AS taskId, Timestamp AS at, AccountId AS accountId FROM logs WHERE Fingerprint = {fp:String} ORDER BY Timestamp DESC LIMIT ${Math.min(args.limit ?? 20, 100)}`, { params: { fp: args.fingerprint } })),
  write("update_issue", "Resolve, archive, reopen, set priority or assignee. Recorded under the caller's name.", obj({ fingerprint: { type: "string" }, status: { type: "string", enum: ["open", "resolved", "archived"] }, days: { type: "number" }, priority: { type: "string", enum: ["high", "medium", "low"] }, assignee: { type: "string" } }, ["fingerprint"]), (args, actor) => updateIssue({ fp: args.fingerprint, status: args.status, days: args.days, priority: args.priority, assignee: args.assignee }, actor)),
  write("add_issue_comment", "Comment on an issue.", obj({ fingerprint: { type: "string" }, comment: { type: "string" } }, ["fingerprint", "comment"]), (args, actor) => updateIssue({ fp: args.fingerprint, comment: args.comment }, actor)),
  read("get_alert", "One alert with its rule and incidents.", scoped({ id: prop.id }, ["id"]), async (args) => {
    const { history, ...rest } = await alertDetail({ ...inputFrom(args), id: args.id });
    return rest;
  }),
  read("list_alert_events", "Incidents across all alerts.", obj({ limit: prop.limit }), (args) => db.query(`SELECT i.started, i.ended, i.peak, a.name FROM incidents i JOIN alerts a ON a.id = i.alert_id ORDER BY i.started DESC LIMIT ${Math.min(args.limit ?? 30, 200)}`).all()),
  read("preview_alert", "How often a condition would have fired in the last 7 days.", obj({ env: prop.env, rule: { type: "object", description: "{ when, above or below, window }" } }, ["rule"]), async (args) => {
    const { history, ...rest } = await alertPreview({ ...inputFrom(args), rule: args.rule });
    return { ...rest, peak: history.reduce((max, p) => Math.max(max, p.v), 0) };
  }),
  read("get_status_page", "The public status page as visitors see it: overall state, components, open incidents with their updates, and the logbook.", obj({}), () => {
    const { components, ...model } = statusModel();
    return { ...model, components: components.map(({ days, ...c }) => ({ ...c, badDays: days.filter((d) => d.share !== null && d.share < 99.9).map((d) => ({ day: new Date(d.at).toISOString().slice(0, 10), up: Math.round(d.share! * 100) / 100 })) })) };
  }),
  write("declare_incident", "Open an incident on the public status page, with its first update. Visitors read the title and message as written: plain words, no internals. Components are keys from get_status_page.", obj({ title: { type: "string" }, impact: { type: "string", enum: ["minor", "major", "critical", "maintenance"] }, components: { type: "array", items: { type: "string" } }, state: { type: "string", enum: ["investigating", "identified", "monitoring", "scheduled"] }, message: { type: "string" } }, ["title", "impact", "message"]), (args, actor) => declareIncident({ title: args.title, impact: args.impact, monitors: args.components ?? [], state: args.state ?? "investigating", message: args.message }, actor)),
  write("post_status_update", "Add an update to an open incident on the status page. State resolved closes it. The id is the number in get_status_page's incident id (i12 is 12).", obj({ incident: { type: "number" }, state: { type: "string", enum: ["investigating", "identified", "monitoring", "resolved"] }, message: { type: "string" } }, ["incident", "state", "message"]), (args, actor) => postStatusUpdate({ incidentId: args.incident, state: args.state, message: args.message }, actor)),
  write("create_alert", "Create an alert in the app. It starts paused.", obj({ name: { type: "string" }, family: { type: "string" }, rule: { type: "object" } }, ["name", "rule"]), (args, actor) => {
    const made = createAlert({ name: args.name, family: args.family ?? "Custom", rule: args.rule }, actor);
    pauseAlert({ id: made.id, paused: true }, actor);
    return made;
  }),
  write("update_alert", "Change an alert made in the app. Alerts in code answer with an error: edit their file.", obj({ id: prop.id, name: { type: "string" }, family: { type: "string" }, rule: { type: "object" } }, ["id"]), (args, actor) => updateAlert(args as never, actor)),
  write("create_production_rule", "Pin an invariant, such as at most 20 queries per GET /accounts. Checked from the next traces on.", obj({ name: { type: "string" }, entry: { type: "object", description: "{ route, method } or { taskKind } or { any: true }" }, statement: { type: "string" }, host: { type: "string" }, atMost: { type: "number" }, exactly: { type: "number" } }, ["name", "entry"]), (args, actor) => createProductionRule(args as never, actor)),
  write("mute_issues", "Stop issues like this one from showing up, with a reason. Their events are still stored.", obj({ fp: { type: "string" }, reason: prop.reason, pattern: { type: "string" }, everywhere: { type: "boolean" } }, ["fp", "reason"]), (args, actor) => muteLike(args as never, actor)),
  write("unmute_issues", "Remove a mute rule.", obj({ id: prop.id }, ["id"]), (args, actor) => unmute(args as never, actor)),
  write("create_linear_issue", "File this issue in Linear once. Needs Linear set up on the server.", obj({ fp: { type: "string" } }, ["fp"]), (args, actor) => createLinearIssue(args as never, actor)),
  write("delete_alert", "Delete an alert made in the app. Alerts in code stay.", obj({ id: prop.id }, ["id"]), (args, actor) => deleteAlert(args.id, actor)),
  read("export_alert_as_code", "The defineAlert snippet for an alert, to paste into the repo.", obj({ id: prop.id }, ["id"]), (args) => {
    const alert = db.query<{ id: string; name: string; family: string; rule: string }, [string]>("SELECT id, name, family, rule FROM alerts WHERE id = ?").get(args.id);
    if (!alert) return { error: "No such alert." };
    return { code: `export const alert = defineAlert(${JSON.stringify({ id: alert.id, name: alert.name, family: alert.family, ...JSON.parse(alert.rule) }, null, 2)});` };
  }),
  read("list_slos", "Objectives with budget left and burn.", obj({ env: prop.env }), async (args) => (await slos({ env: args.env ?? config.mainEnvironment })).map(({ daily, ...row }) => row)),
  read("list_rules", "Production rules: holding, violated or unchecked, with a sample trace.", scoped(), (args) => rules(inputFrom(args))),
  read("get_deployment", "One version: when it appeared, and its verdict against the hour before.", obj({ env: prop.env, service: { type: "string" }, version: { type: "string" } }, ["version"]), async (args) => {
    const all = await releases({ env: args.env ?? config.mainEnvironment });
    return all.rows.find((r: any) => r.version === args.version && (!args.service || r.service === args.service)) ?? { error: "No such version in this environment." };
  }),
  read("get_service_map", "Services, queues, databases and hosts, with call volume and error rate.", scoped(), (args) => serviceMap(inputFrom(args))),
  read("what_ran_here", "What ran around one moment: the slowest requests and tasks.", obj({ env: prop.env, at: { type: "number", description: "Unix milliseconds." }, instance: { type: "string" } }, ["at"]), (args) => whatRanHere({ env: args.env ?? config.mainEnvironment, at: args.at, instance: args.instance })),
  read("get_host_pressure", "Whether CPU, heap or the event loop were unusually high around one moment.", obj({ env: prop.env, at: { type: "number" }, service: { type: "string" } }, ["at", "service"]), (args) => hostPressure({ env: args.env ?? config.mainEnvironment, at: args.at, service: args.service })),
  read("get_switch_history", "Who turned a feature switch on or off, and why.", obj({ key: { type: "string" } }, ["key"]), (args) => switchHistory({ key: args.key })),
  read("list_tables", "Tables of the database explorer.", obj({ source: { type: "string", enum: ["app", "state"], description: "Default app." } }), (args) => dbTables({ source: args.source ?? "app" })),
  read("get_table_structure", "Columns and indexes of one table. Secret columns are never listed.", obj({ source: { type: "string" }, table: { type: "string" } }, ["table"]), (args) => dbStructure({ source: args.source ?? "app", table: args.table })),
  read("read_table", "Rows of one table, in a read-only transaction.", obj({ source: { type: "string" }, table: { type: "string" }, search: { type: "string" }, limit: prop.limit }, ["table"]), (args) => dbRows({ source: args.source ?? "app", table: args.table, search: args.search, limit: Math.min(args.limit ?? 50, 200) })),
  read("run_readonly_sql", "Run SQL in a read-only transaction. Refused if the role can read credentials.", obj({ source: { type: "string" }, sql: { type: "string" } }, ["sql"]), (args) => dbSql({ source: args.source ?? "app", sql: args.sql })),
  read("list_deployments", "Versions seen, with their verdict against the hour before.", obj({ env: prop.env }), (args) => releases({ env: args.env ?? config.mainEnvironment })),
  write("declare_deployment", "Declare a release.", obj({ service: { type: "string" }, version: { type: "string" }, env: prop.env }, ["service", "version"]), (args, actor) => {
    db.query("INSERT OR REPLACE INTO deployments (service, environment, version, at, declared_by) VALUES (?, ?, ?, ?, ?)").run(args.service, args.env ?? config.mainEnvironment, args.version, Date.now(), actor.name);
    audit(actor.name, "mcp", "Declared a deployment", `${args.service} ${args.version}`);
    return { ok: true };
  }),
  read("list_notification_channels", "Channels. Their URLs stay private.", obj({}), () => db.query("SELECT id, kind, name FROM channels").all()),
  read("list_users", "People ranked by requests, with errors and last seen.", scoped({ limit: prop.limit }), async (args) => top((await users(inputFrom(args))).rows, args)),
  read("get_user_activity", "One person's recent requests and tasks.", scoped({ id: prop.id }, ["id"]), async (args) => {
    const detail = await user({ ...inputFrom(args), id: args.id });
    return { ...detail, events: detail.events.slice(0, 30) };
  }),
  read("list_accounts", "Accounts with people, requests, errors and failed tasks.", scoped({ limit: prop.limit }), async (args) => top(await accounts(inputFrom(args)), args)),
  read("list_dashboards", "Dashboards, in code and in the app.", obj({}), () => dashboards().map((d) => ({ id: d.id, title: d.title, source: d.source, widgets: d.widgets.length }))),
  read("get_dashboard", "A dashboard's widgets with their current values.", scoped({ id: prop.id }, ["id"]), async (args) => {
    const found = dashboard(args.id);
    return { title: found.title, widgets: await Promise.all(found.widgets.map(async (w) => ({ title: w.title, type: w.type, rows: (await runConsole({ ...inputFrom(args), sql: w.sql })).rows.slice(0, 12) }))) };
  }),
  write("create_dashboard", "Create a dashboard in the app.", obj({ title: { type: "string" }, widgets: { type: "array" } }, ["title"]), (args, actor) => saveDashboard({ title: args.title, widgets: args.widgets ?? [] }, actor)),
  write("update_dashboard", "Rename a dashboard made in the app or replace its widgets. Dashboards in code answer with their file.", obj({ id: prop.id, title: { type: "string" }, widgets: { type: "array" } }, ["id"]), (args, actor) => {
    const found = dashboard(args.id);
    return saveDashboard({ id: args.id, title: args.title ?? found.title, widgets: args.widgets ?? found.widgets }, actor);
  }),
  write("add_widget", "Add a widget to a dashboard made in the app.", obj({ id: prop.id, widget: { type: "object", description: "{ type, title, sql, span, height }" } }, ["id", "widget"]), (args, actor) => {
    const found = dashboard(args.id);
    return saveDashboard({ id: args.id, title: found.title, widgets: [...found.widgets, args.widget] }, actor);
  }),
  write("update_widget", "Change one widget of a dashboard made in the app.", obj({ id: prop.id, index: { type: "number" }, widget: { type: "object" } }, ["id", "index", "widget"]), (args, actor) => {
    const found = dashboard(args.id);
    if (!found.widgets[args.index]) return { error: "No widget at that index." };
    return saveDashboard({ id: args.id, title: found.title, widgets: found.widgets.map((w, i) => (i === args.index ? { ...w, ...args.widget } : w)) }, actor);
  }),
  write("remove_widget", "Remove one widget from a dashboard made in the app.", obj({ id: prop.id, index: { type: "number" } }, ["id", "index"]), (args, actor) => {
    const found = dashboard(args.id);
    return saveDashboard({ id: args.id, title: found.title, widgets: found.widgets.filter((_, i) => i !== args.index) }, actor);
  }),
  write("delete_dashboard", "Delete a dashboard made in the app.", obj({ id: prop.id }, ["id"]), (args, actor) => deleteDashboard(args.id, actor)),
  read("list_monitors", "Uptime monitors: state, uptime over 30 days and average time.", obj({}), () => uptime().rows.map(({ days, ...row }) => row)),
  read("list_outages", "Recent outages of the uptime monitors.", obj({}), () => uptime().outages),
  write("create_monitor", "Add a URL to check every minute.", obj({ name: { type: "string" }, url: { type: "string" }, expect: { type: "number" } }, ["name", "url"]), (args, actor) => createMonitor({ name: args.name, url: args.url, expect: args.expect }, actor)),
  write("delete_monitor", "Delete a monitor made in the app. Monitors in code stay.", obj({ id: prop.id }, ["id"]), (args, actor) => deleteMonitor(args.id, actor)),
  read("list_extensions", "Loaded definitions and their load errors.", obj({}), () => registry.loaded),
  read("get_extension_errors", "Definitions that failed to load, with the reason.", obj({}), () => registry.loaded.filter((e) => !e.ok)),
  read("setup_service", "How to point a service at this Vigie. Keys are created in Settings, never returned here.", obj({ service: { type: "string" } }, ["service"]), (args) => ({
    env: { OTEL_SERVICE_NAME: args.service, OTEL_EXPORTER_OTLP_ENDPOINT: config.mode === "local" ? `http://localhost:${config.ingestPort}` : `${config.publicUrl}/otlp`, OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf", OTEL_EXPORTER_OTLP_HEADERS: "authorization=<an ingest key from Settings, Services>" },
  })),
  read("get_slo", "One objective with budget left and burn.", obj({ env: prop.env, id: prop.id }, ["id"]), async (args) => (await slos({ env: args.env ?? config.mainEnvironment })).find((slo) => slo.id === args.id) ?? { error: "No such objective." }),
  read("list_rule_violations", "Only the production rules that are broken, with a sample trace.", scoped(), async (args) => (await rules(inputFrom(args))).filter((rule) => rule.state === "violated")),
  read("get_release_verdict", "A version's verdict against the hour before it.", obj({ env: prop.env, version: { type: "string" } }, ["version"]), async (args) => {
    const { rows } = await releases({ env: args.env ?? config.mainEnvironment });
    return rows.find((r) => r.version === args.version) ?? { error: "This version was not seen." };
  }),
  read("get_account", "One account: people, requests, errors and failed tasks.", scoped({ id: prop.id }, ["id"]), async (args) => (await accounts(inputFrom(args))).find((a) => a.id === args.id) ?? { error: "No such account in this window." }),
  write("resume_alert", "Resume a paused alert.", obj({ id: prop.id }, ["id"]), (args, actor) => pauseAlert({ id: args.id, paused: false }, actor)),
];

function allTools(): ToolDef[] {
  const custom: ToolDef[] = registry.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    scope: tool.scope,
    input: tool.input ?? { type: "object", properties: {} },
    run: (args) => tool.run({ env: args.env ?? config.mainEnvironment, sql: async (sql) => (await runConsole({ ...inputFrom(args), sql })).rows as Record<string, any>[] }, args),
  }));
  const pages: ToolDef[] = registry.pages.map((page) => ({
    name: `page_${page.id.replace(/\W/g, "_")}`,
    description: `Read the "${page.title}" page: its numbers and tables as data.`,
    scope: "read",
    input: { type: "object", properties: scopeArgs },
    run: async (args) => {
      const blocks: any[] = [];
      const visit = async (block: any) => {
        if (block.b === "row") for (const child of block.children) await visit(child);
        else if (block.sql) blocks.push({ title: block.title, rows: (await runConsole({ ...inputFrom(args), sql: block.sql })).rows });
      };
      for (const block of page.layout) await visit(block);
      return { title: page.title, blocks };
    },
  }));
  return [...BUILTIN_TOOLS, ...FULL_TOOLS, ...custom, ...pages];
}

export function toolsFor(actor: Actor) {
  const canWrite = actor.role !== "viewer";
  // Task actions stay in the app with Vigie's own login, so agents are not offered tools that can only refuse.
  const taskTools = new Set(["requeue_task", "run_task_now", "cancel_task", "ignore_task", "bulk_task_action"]);
  return allTools().filter((t) => (t.scope === "read" || canWrite) && (actionsEnabled() || !taskTools.has(t.name)));
}

const reply = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const failure = (id: unknown, code: number, message: string, status = 200) => Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });

/** MCP over streamable HTTP, JSON responses. Read and write tools are separated by the token's scope. */
export async function handleMcp(request: Request) {
  if (request.method === "GET" || request.method === "DELETE") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const actor = await actorOf(request);
  if (!actor) return Response.json({ error: "A token is required." }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  let message: any;
  try {
    message = await request.json();
  } catch {
    return failure(null, -32700, "Parse error", 400);
  }
  const { id, method, params } = message;
  if (id === undefined) return new Response(null, { status: 202 });
  switch (method) {
    case "initialize":
      return reply(id, { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "vigie", version: "0.1.0" }, instructions: "Call get_context_pack first. Everything is read-only unless your token has write scope." });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: toolsFor(actor).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input, annotations: { readOnlyHint: t.scope === "read" } })) });
    case "tools/call": {
      const tool = toolsFor(actor).find((t) => t.name === params?.name);
      if (!tool) return reply(id, { isError: true, content: [{ type: "text", text: `Unknown tool ${params?.name}, or your token cannot use it.` }] });
      try {
        const result = await tool.run(params?.arguments ?? {}, { ...actor, through: "mcp" });
        return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (error) {
        return reply(id, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
      }
    }
    default:
      return failure(id, -32601, `Unknown method ${method}`);
  }
}
