import { appDb, readOnly } from "../lib/appdb.ts";
import { query } from "../lib/clickhouse.ts";
import { registry } from "../extensions/index.ts";
import { HttpError, scopeOf, scopeParams, where, type Scope, type ScopeInput } from "./http.ts";
import type { Process, Step } from "../../sdk/index.ts";

const PENDING_TYPES = new Set(["RETRY", "WAIT", "AGAIN"]);

const flat = (steps: Step[]): Step[] => steps.flatMap((s) => (s.parallel ? s.parallel : [s]));
const ms = (text?: string) => {
  const m = text?.match(/^(\d+)(s|m|h|d)$/);
  return m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s"] : Infinity;
};

type StepState = { kind: string; attempts: number; done: boolean; skipped: boolean; failed: boolean; waiting: boolean; first: number; last: number; taskId: string; code: string; why: string; fix: string; worker: string; duration: number };

function classify(process: Process, states: Map<string, StepState>, now: number) {
  const steps = flat(process.steps);
  const required = steps.filter((s) => !s.optional);
  const seen = steps.filter((s) => states.has(s.kind));
  const firstAt = Math.min(...seen.map((s) => states.get(s.kind)!.first));
  const lastAt = Math.max(...seen.map((s) => states.get(s.kind)!.last));
  const failed = seen.filter((s) => states.get(s.kind)!.failed);
  const waiting = seen.filter((s) => states.get(s.kind)!.waiting);
  // A step that decided there is nothing to do ends the chain on purpose, so the steps after it never come.
  const skipped = seen.some((s) => states.get(s.kind)!.skipped);
  const done = required.every((s) => states.get(s.kind)?.done) || (skipped && !waiting.length);
  let stuck: { step: Step; waited: number } | null = null;
  for (const s of waiting) {
    const state = states.get(s.kind)!;
    const waited = now - state.first;
    if (waited > ms(s.expectWithin)) stuck = { step: s, waited };
  }
  // Without the app database, ids that mean the same object stay apart, so a "missing" step proves nothing.
  const canJoin = !process.aliases?.length || Boolean(appDb());
  if (!stuck && !done && !failed.length && canJoin) {
    const missing = required.find((s) => !states.has(s.kind));
    if (missing && now - lastAt > ms(missing.expectWithin)) stuck = { step: missing, waited: now - lastAt };
  }
  const state: "failed" | "stuck" | "done" | "running" = failed.length ? "failed" : stuck ? "stuck" : done ? "done" : "running";
  return { state, firstAt, lastAt, stuck, failed, waiting, duration: done ? lastAt - firstAt : 0 };
}

/** One instance follows one business object. A task with no subject is its own key, as the plan's joins say. */
const INSTANCE_KEY = "if(LogAttributes['task.subject.id'] != '', LogAttributes['task.subject.id'], LogAttributes['task.key'])";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const aliasCache = new Map<string, { at: number; subject: string }>();

/** Looks up the subject each alias stands for. Without the app database, or on an unknown id, the alias stays its own instance. */
export async function resolveAliases(aliases: NonNullable<Process["aliases"]>, wanted: { subjectType: string; id: string }[]) {
  const found = new Map<string, string>();
  for (const alias of aliases) {
    if (![alias.table, alias.aliasColumn, alias.subjectColumn].every((name) => IDENTIFIER.test(name))) continue;
    const ids = [...new Set(wanted.filter((w) => w.subjectType === alias.subjectType).map((w) => w.id))];
    const missing: string[] = [];
    for (const id of ids) {
      const cached = aliasCache.get(`${alias.table}:${id}`);
      if (cached && Date.now() - cached.at < 300_000) found.set(id, cached.subject);
      else missing.push(id);
    }
    if (!missing.length || !appDb()) continue;
    try {
      const rows = await readOnly<{ alias: string; subject: string }>(`SELECT "${alias.aliasColumn}"::text AS alias, "${alias.subjectColumn}"::text AS subject FROM "${alias.table}" WHERE "${alias.aliasColumn}"::text IN (SELECT jsonb_array_elements_text($1::text::jsonb))`, [JSON.stringify(missing)], 5000);
      for (const row of rows) {
        found.set(row.alias, row.subject);
        aliasCache.set(`${alias.table}:${row.alias}`, { at: Date.now(), subject: row.subject });
      }
    } catch {}
  }
  return found;
}

/** The ids that mean this instance, so its page finds every step. */
async function idsOfInstance(process: Process, key: string) {
  const ids = [key];
  if (!appDb()) return ids;
  for (const alias of process.aliases ?? []) {
    if (![alias.table, alias.aliasColumn, alias.subjectColumn].every((name) => IDENTIFIER.test(name))) continue;
    try {
      const rows = await readOnly<{ alias: string | null }>(`SELECT "${alias.aliasColumn}"::text AS alias FROM "${alias.table}" WHERE "${alias.subjectColumn}"::text = $1`, [key], 3000);
      for (const row of rows) if (row.alias) ids.push(row.alias);
    } catch {}
  }
  return ids;
}

async function instancesOf(process: Process, scope: Scope, limit = 5000, key?: string) {
  const kinds = flat(process.steps).map((s) => s.kind);
  const params: Record<string, any> = { ...scopeParams(scope), kinds };
  let extra = "";
  if (process.keyPrefix) {
    params.prefix = process.keyPrefix;
    extra += " AND startsWith(LogAttributes['task.key'], {prefix:String})";
  }
  if (key) {
    params.ids = await idsOfInstance(process, key);
    extra += ` AND ${INSTANCE_KEY} IN {ids:Array(String)}`;
  }
  const rows = await query<{ key: string; subjectType: string; kind: string; attempts: number; done: number; type: string; outcome: string; first: number; last: number; taskId: string; code: string; why: string; fix: string; worker: string; duration: number; accountId: string }>(
    `SELECT ${INSTANCE_KEY} AS key, any(LogAttributes['task.subject.type']) AS subjectType, TaskKind AS kind, count() AS attempts, countIf(Outcome = 'succeeded') > 0 AS done, argMax(LogAttributes['taskOutcome.type'], Timestamp) AS type, argMax(Outcome, Timestamp) AS outcome,
      toUnixTimestamp64Milli(toDateTime64(min(Timestamp), 3)) AS first, toUnixTimestamp64Milli(toDateTime64(max(Timestamp), 3)) AS last, argMax(TaskId, Timestamp) AS taskId, argMax(if(LogAttributes['taskOutcome.code'] != '', LogAttributes['taskOutcome.code'], LogAttributes['taskOutcome.reason']), Timestamp) AS code, argMax(LogAttributes['why'], Timestamp) AS why, argMax(LogAttributes['fix'], Timestamp) AS fix, argMax(LogAttributes['workerId'], Timestamp) AS worker, argMax(DurationMs, Timestamp) AS duration, any(AccountId) AS accountId
     FROM logs WHERE ${where(scope)} AND Kind = 'task' AND TaskKind IN {kinds:Array(String)} AND key != ''${extra} GROUP BY key, kind ORDER BY last DESC LIMIT ${limit * kinds.length}`,
    { params },
  );
  const translated = process.aliases?.length ? await resolveAliases(process.aliases, rows.map((row) => ({ subjectType: row.subjectType, id: row.key }))) : new Map<string, string>();
  for (const row of rows) row.key = translated.get(row.key) ?? row.key;
  const grouped = new Map<string, { states: Map<string, StepState>; accountId: string }>();
  for (const row of rows) {
    if (!grouped.has(row.key)) grouped.set(row.key, { states: new Map(), accountId: row.accountId });
    grouped.get(row.key)!.states.set(row.kind, {
      kind: row.kind,
      attempts: row.attempts,
      done: Boolean(row.done),
      skipped: !row.done && row.type === "SKIP",
      failed: !row.done && row.outcome === "failed" && !PENDING_TYPES.has(row.type),
      waiting: !row.done && PENDING_TYPES.has(row.type),
      first: row.first,
      last: row.last,
      taskId: row.taskId,
      code: row.code,
      why: row.why,
      fix: row.fix,
      worker: row.worker,
      duration: row.duration,
    });
  }
  const now = Date.now();
  return [...grouped].map(([key, value]) => ({ key, accountId: value.accountId, states: value.states, ...classify(process, value.states, now) }));
}

export async function processSummaries(scope: Scope) {
  return Promise.all(
    registry.processes.map(async (process) => {
      const instances = process.standing ? [] : await instancesOf(process, scope);
      const started = instances.length;
      const done = instances.filter((i) => i.state === "done");
      const failed = instances.filter((i) => i.state === "failed").length;
      const stuck = instances.filter((i) => i.state === "stuck").length;
      const durations = done.map((i) => i.duration).sort((a, b) => a - b);
      const state: "Failing" | "Stuck" | "Slow" | "Healthy" = failed > 0 && failed / Math.max(started, 1) > 0.05 ? "Failing" : stuck > 0 ? "Stuck" : failed > 0 ? "Slow" : "Healthy";
      const buckets = 26;
      const spark = new Array(buckets).fill(0);
      for (const instance of instances) {
        const i = Math.min(buckets - 1, Math.floor(((instance.firstAt - scope.from) / (scope.to - scope.from)) * buckets));
        if (i >= 0) spark[i]++;
      }
      const held = (step: Step) => instances.filter((i) => i.state === "failed" && i.failed.some((s) => s.kind === step.kind)).length + instances.filter((i) => i.state === "stuck" && i.stuck?.step.kind === step.kind).length;
      const steps = process.steps.map((entry) => (entry.parallel ?? [entry]).map((step) => ({ kind: step.kind, label: step.label, reached: instances.filter((i) => i.states.has(step.kind)).length, held: held(step) })));
      const pile = steps.flat().sort((a, b) => b.held - a.held)[0];
      return { id: process.id, title: process.title, subject: process.subject, description: process.description ?? "", state, started, completed: done.length, failed, stuck, running: instances.filter((i) => i.state === "running").length, typical: durations[Math.floor(durations.length / 2)] ?? 0, spark, file: process.file, standing: Boolean(process.standing), steps, pile: pile?.held ? pile : null };
    }),
  );
}

export const processList = (input: ScopeInput) => processSummaries(scopeOf(input));

function byId(id: string) {
  const process = registry.processes.find((p) => p.id === id);
  if (!process) throw new HttpError(404, `No process called ${id} is defined.`);
  return process;
}

export async function processDetail(input: ScopeInput & { id: string }) {
  const scope = scopeOf(input);
  const process = byId(input.id);
  const instances = await instancesOf(process, scope);
  const done = instances.filter((i) => i.state === "done");
  const durations = done.map((i) => i.duration).sort((a, b) => a - b);
  const q = (x: number) => durations[Math.floor(durations.length * x)] ?? 0;
  const count = (kind: string, test: (s: StepState) => boolean) => instances.filter((i) => i.states.has(kind) && test(i.states.get(kind)!)).length;
  const stepView = (step: Step) => ({
    kind: step.kind,
    label: step.label,
    optional: Boolean(step.optional),
    provider: step.provider ?? "",
    reached: count(step.kind, () => true),
    done: count(step.kind, (s) => s.done),
    waiting: count(step.kind, (s) => s.waiting),
    failed: count(step.kind, (s) => s.failed),
    skipped: count(step.kind, (s) => s.skipped),
    stuck: instances.filter((i) => i.stuck?.step.kind === step.kind).length,
  });
  const now = Date.now();
  return {
    id: process.id,
    title: process.title,
    subject: process.subject,
    file: process.file,
    sla: process.sla ?? "",
    description: process.description ?? "",
    stats: { started: instances.length, completed: done.length, failed: instances.filter((i) => i.state === "failed").length, stuck: instances.filter((i) => i.state === "stuck").length, running: instances.filter((i) => i.state === "running").length, p50: q(0.5), p95: q(0.95) },
    steps: process.steps.map((s) => (s.parallel ? { parallel: s.parallel.map(stepView) } : { parallel: [stepView(s)] })),
    attention: instances
      .filter((i) => i.state === "stuck" || i.state === "failed")
      .slice(0, 200)
      .map((i) => ({ key: i.key, accountId: i.accountId, state: i.state, at: i.stuck?.step.label ?? i.failed[0]?.label ?? "", atKind: i.stuck?.step.kind ?? i.failed[0]?.kind ?? "", waited: i.stuck?.waited ?? now - i.lastAt, why: i.failed[0] ? i.states.get(i.failed[0].kind)?.why ?? "" : "", code: i.failed[0] ? i.states.get(i.failed[0].kind)?.code ?? "" : "" })),
    recent: instances.slice(0, 50).map((i) => ({ key: i.key, accountId: i.accountId, state: i.state, firstAt: i.firstAt, lastAt: i.lastAt, kinds: [...i.states.keys()], duration: i.duration, skippedAt: flat(process.steps).find((s) => i.states.get(s.kind)?.skipped)?.label ?? "" })),
  };
}

export async function processInstance(input: ScopeInput & { id: string; key: string }) {
  const process = byId(input.id);
  const key = input.key;
  const scope = { ...scopeOf(input), from: Date.now() - 30 * 86_400_000, to: Date.now() };
  const [instance] = await instancesOf(process, scope, 1, key);
  if (!instance) throw new HttpError(404, "This instance has no telemetry left.");
  const events = await query<{ taskId: string; kind: string; t: number; outcome: string; duration: number; attempt: string; code: string; type: string; why: string; worker: string; traceId: string }>(
    `SELECT TaskId AS taskId, TaskKind AS kind, toUnixTimestamp64Milli(toDateTime64(Timestamp, 3)) AS t, Outcome AS outcome, DurationMs AS duration, LogAttributes['task.attempt'] AS attempt, if(LogAttributes['taskOutcome.code'] != '', LogAttributes['taskOutcome.code'], LogAttributes['taskOutcome.reason']) AS code, LogAttributes['taskOutcome.type'] AS type, LogAttributes['why'] AS why, LogAttributes['workerId'] AS worker, TraceId AS traceId FROM logs WHERE Kind = 'task' AND ${INSTANCE_KEY} IN {ids:Array(String)} AND Environment = {env:String} ORDER BY Timestamp LIMIT 200`,
    { params: { ids: await idsOfInstance(process, key), env: scope.env } },
  );
  const steps = flat(process.steps);
  const label = (kind: string) => steps.find((s) => s.kind === kind)?.label ?? kind;
  const blocked = instance.failed[0] ? instance.states.get(instance.failed[0].kind) : [...instance.states.values()].find((s) => s.waiting);
  return {
    process: { id: process.id, title: process.title, subject: process.subject, steps: process.steps.map((entry) => (entry.parallel ?? [entry]).map((step) => step.kind)), },
    atKind: instance.stuck?.step.kind ?? instance.failed[0]?.kind ?? "",
    firstAt: instance.firstAt,
    lastAt: instance.lastAt,
    key,
    accountId: instance.accountId,
    state: instance.state,
    waited: instance.stuck?.waited ?? 0,
    at: instance.stuck?.step.label ?? (instance.failed[0]?.label ?? ""),
    why: blocked?.why ?? "",
    fix: blocked?.fix ?? "",
    events: events.map((e) => ({ ...e, label: label(e.kind) })),
    destinations: steps.map((s) => {
      const state = instance.states.get(s.kind);
      return { label: s.label, kind: s.kind, optional: Boolean(s.optional), taskId: state?.taskId ?? "", state: !state ? (s.optional ? "skipped" : "pending") : state.done ? "done" : state.failed ? "failed" : state.waiting ? "retrying" : state.skipped ? "decided" : "running", attempts: state?.attempts ?? 0, first: state?.first ?? 0, last: state?.last ?? 0, duration: state?.duration ?? 0, code: state?.code ?? "", why: state?.why ?? "", worker: state?.worker ?? "", expectWithin: s.expectWithin ?? "" };
    }),
  };
}
