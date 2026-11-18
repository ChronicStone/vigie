import { appName } from "@web/lib/app-name.ts";
import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";
import { z } from "zod";
import { Code, Hl, Json } from "@web/components/code.tsx";
import { Icon } from "@web/components/icons.tsx";
import { inWords, useListKeys } from "@web/components/task-tabs.tsx";
import { toast } from "@web/components/toast.tsx";
import { Back, copy, Id, Kv, Levels, Load, SearchBox, Subject, TaskChip, Tabs } from "@web/components/ui.tsx";
import { spansToRows, type WfKind, type WfRow } from "@web/components/waterfall.tsx";
import { taskActionFn, taskRunFn } from "@web/fns/tasks.ts";
import { errorText, useFn } from "@web/lib/api.ts";
import { ago, dayMonth, fms, hms, inFuture, span as spanText } from "@web/lib/format.ts";

const search = z.object({
  tab: z.enum(["log", "data"]).optional().catch(undefined),
  at: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  only: z.enum(["errors"]).optional().catch(undefined),
  sql: z.boolean().optional().catch(undefined),
});
export const Route = createFileRoute("/_app/tasks/run/$id")({ validateSearch: search, component: RunPage });

type TaskVerb = "requeue" | "cancel" | "run-now";
type Run = Awaited<ReturnType<typeof taskRunFn>>;
type Attempt = Run["attempts"][number];
type Tone = "ok" | "err" | "warn" | "skip";

/** The app records a reason for every task action, so asking is not optional. It goes through the app as you. */
function TaskActionDialog({ label, title, action, danger, primary, onConfirm }: { label: string; title: string; action: string; danger?: boolean; primary?: boolean; onConfirm: (reason: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={`btn ${primary ? "pri" : ""}`}>{primary && <Icon name="replay" />}{label}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="dlgback" />
        <Dialog.Popup className="dlg">
          <Dialog.Title className="dlgt">{title}</Dialog.Title>
          <form onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await onConfirm(reason.trim());
              setOpen(false);
              setReason("");
            } catch (error) {
              toast(errorText(error));
            } finally {
              setBusy(false);
            }
          }}>
            <label className="dlgb" style={{ display: "grid", gap: 6 }}>
              It runs through the app under your name, with this reason.
              <input className="input" aria-label="Reason" placeholder="Why" autoFocus value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <Dialog.Close className="btn">Close</Dialog.Close>
              <button type="submit" className={`btn ${danger ? "danger" : "pri"}`} disabled={busy || !reason.trim()}>{action}</button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const clock = (t: number) => `${hms(t)}.${String(Math.floor(t % 1000)).padStart(3, "0")}`;
const reasonOf = (attempt: Attempt) => attempt.code || attempt.reason;

function toneOf(attempt: Attempt): Tone {
  if (attempt.outcome === "succeeded") return "ok";
  if (attempt.type === "SKIP" || attempt.type === "CANCELLED" || attempt.type === "REQUEUED") return "skip";
  if (attempt.type === "WAIT" || attempt.type === "AGAIN") return "skip";
  if (attempt.type === "RETRY" || attempt.type === "LEASE_LOST") return "warn";
  return attempt.outcome === "skipped" ? "skip" : "err";
}

const WORD: Record<string, string> = { DONE: "Finished", AGAIN: "Finished, runs again", RETRY: "Failed, will retry", WAIT: "Waiting", SKIP: "Skipped", FAIL: "Failed", LEASE_LOST: "Lost its worker", REQUEUED: "Requeued", CANCELLED: "Cancelled" };
const wordOf = (attempt: Attempt) => (attempt.outcome === "succeeded" ? "Finished" : WORD[attempt.type] ?? (attempt.outcome === "skipped" ? "Skipped" : "Failed"));

/** Attempts number retries of one run; a task that runs again counts runs. Say whichever is actually moving. */
function nameOf(attempt: Attempt, attempts: Attempt[]) {
  const runs = new Set(attempts.map((a) => a.run)).size > 1;
  const retried = attempts.some((a) => a.number > 1);
  if (runs && retried) return `Run ${attempt.run}, attempt ${attempt.number}`;
  if (runs) return `Run ${attempt.run}`;
  return `Attempt ${attempt.number}`;
}

/** The answer, in one line. A skip reads as a decision, a wait as a wait, and only a failure reads as a failure. */
function verdictOf(run: Run, repeats: number) {
  const last = run.attempts[run.attempts.length - 1]!;
  const reason = reasonOf(last);
  const words = reason ? inWords(reason) : "";
  const retried = last.number > 1 ? ` on attempt ${last.number}` : "";
  if (run.state === "RUNNING") return { tone: "", text: "A worker has it now." };
  if (run.state === "QUEUED") return { tone: "", text: "Waiting for a free worker." };
  if (run.state === "SCHEDULED") return { tone: "", text: "Scheduled to run again." };
  if (run.state === "DONE" && repeats > 2) return { tone: "", text: `Ran ${run.attempts.length >= 200 ? "more than 200" : repeats} times. The latest finished in ${fms(last.duration)}.` };
  if (run.state === "DONE") {
    const before = run.attempts.slice(0, -1);
    const held = before.find((a) => a.type === "WAIT");
    return { tone: "", text: `Finished${retried} in ${fms(last.duration)}${held && reasonOf(held) ? `, after waiting: ${inWords(reasonOf(held)).toLowerCase()}` : ""}.` };
  }
  if (run.state === "SKIPPED") return { tone: "", text: `Skipped${words ? `: ${words.toLowerCase()}` : ""}. It decided there was nothing to do, and nothing failed.` };
  if (run.state === "CANCELLED") return { tone: "", text: `Cancelled${words ? `: ${words.toLowerCase()}` : ""}.` };
  if (run.state === "WAITING" && last.type === "WAIT") return { tone: "", text: `Waiting${words ? `: ${words.toLowerCase()}` : ""}. It runs again once that clears.` };
  if (run.state === "WAITING" && last.type === "AGAIN") return { tone: "", text: "Finished this pass, and will run again." };
  if (run.state === "WAITING") return { tone: "warn", text: `${nameOf(last, run.attempts)} failed${words ? ` with ${words.toLowerCase()}` : ""}, and it will try again.` };
  return { tone: "err", text: `Failed${retried}${words ? `: ${words.toLowerCase()}` : ""}. It will not try again on its own.` };
}

type Step = { id: string; attempts: Attempt[]; tone: Tone; word: string; reason: string };

/** Runs that ended the same way, one after another, are one step. Failures always stand alone. */
function stepsOf(attempts: Attempt[]): Step[] {
  const groups: Step[] = [];
  for (const attempt of attempts) {
    const tone = toneOf(attempt);
    const word = wordOf(attempt);
    const reason = reasonOf(attempt);
    const previous = groups[groups.length - 1];
    if (previous && tone !== "err" && previous.tone === tone && previous.word === word && previous.reason === reason) previous.attempts.push(attempt);
    else groups.push({ id: attempt.eventId, attempts: [attempt], tone, word, reason });
  }
  // Two in a row are clearer written out. Folding starts at three.
  return groups.flatMap((group) => (group.attempts.length < 3 ? group.attempts.map((attempt) => ({ ...group, id: attempt.eventId, attempts: [attempt] })) : [group]));
}

const PLUMBING = /^(task\.|taskOutcome\.|workerId$|operation$|action$|outcome$|duration|message$|target\.type$|why$|fix$|db\.(durationMs|repeatedQueries)$|error\.(why|fix|message)$)/;

/** The facts an event carries beyond its plumbing, on the line itself, the way a log reads. */
function trailOf(fields: Record<string, string>) {
  return Object.entries(fields).filter(([key, value]) => !PLUMBING.test(key) && value !== "").slice(0, 6).map(([key, value]) => `${key}=${value.length > 40 ? `${value.slice(0, 40)}…` : value}`).join(" ");
}

type Line = { id: string; t: number; kind: WfKind | "event"; level: string; text: string; trail?: string; depth: number; duration?: number; start: number; badge?: string; badgeTone?: string; error: boolean; fields?: Record<string, string>; statement?: string; spanId?: string; traceId: string };

/** Everything an attempt left behind, in the order it happened: its calls, its log lines, and the event that closed it. */
function linesOf(attempt: Attempt, run: Run): Line[] {
  const spans = run.spans.filter((span) => span.traceId === attempt.traceId);
  const root = spans.find((span) => !span.parent) ?? spans.find((span) => span.name === `task ${run.kind}`);
  const byId = new Map(spans.map((span) => [span.id, span]));
  const rows: WfRow[] = spansToRows(spans as never, [], 0).filter((row) => row.id !== root?.id);
  const depthOf = (id: string | null, guard = 0): number => {
    if (!id || id === root?.id || guard > 6) return 0;
    const parent = byId.get(id)?.parent ?? null;
    return 1 + depthOf(parent, guard + 1);
  };
  const out: Line[] = rows.map((row) => {
    const span = byId.get(row.id);
    const where = span?.peer && !row.label.includes(span.peer) ? span.peer : "";
    return { id: row.id, t: row.start, start: row.start, kind: row.kind, level: row.error ? "error" : "info", text: [row.label, where, row.detail].filter(Boolean).join(" "), depth: Math.min(depthOf(row.parent), 3), duration: row.duration, badge: row.badge, badgeTone: row.badgeTone, error: Boolean(row.error), fields: span?.attrs, statement: span?.statement || undefined, spanId: span?.id, traceId: attempt.traceId };
  });
  for (const log of run.logs) {
    if (log.traceId !== attempt.traceId || !log.body || /^task /.test(log.body)) continue;
    out.push({ id: log.id, t: log.t, start: log.t, kind: "log", level: log.level, text: log.body, depth: 0, error: log.level === "error" || log.level === "fatal", fields: log.attrs, traceId: attempt.traceId });
  }
  const tone = toneOf(attempt);
  out.push({ id: attempt.eventId, t: attempt.end, start: attempt.end, kind: "event", level: tone === "err" ? "error" : tone === "warn" ? "warn" : tone === "skip" ? "skip" : "info", text: attempt.fields.message || attempt.fields.operation || attempt.fields.action || run.kind, trail: trailOf(attempt.fields), depth: 0, error: tone === "err", fields: attempt.fields, traceId: attempt.traceId });
  return out.sort((a, b) => a.t - b.t);
}

const GROUPS: [string, RegExp][] = [
  ["Outcome", /^(outcome$|taskOutcome|error|why$|fix$|reason$|message$|status$)/],
  ["Task", /^(task\.|workerId$|operation$|action$|duration)/],
  ["Target", /^target\./],
  ["Database", /^db\./],
];

/** Every field the line recorded, nothing hidden, in the order someone reads them. */
function Fields({ fields }: { fields: Record<string, string> }) {
  const keys = Object.keys(fields).sort();
  const groups = GROUPS.map(([label, pattern]): [string, string[]] => [label, keys.filter((key) => pattern.test(key))]);
  const known = new Set(groups.flatMap(([, list]) => list));
  groups.push(["Everything else", keys.filter((key) => !known.has(key))]);
  return (
    <div className="tasks-run-fields">
      {groups.filter(([, list]) => list.length).map(([label, list]) => (
        <div key={label}>
          <h6>{label}</h6>
          <div className="kvg">{list.map((key) => <Kv k={key} key={key}><Hl>{String(fields[key])}</Hl></Kv>)}</div>
        </div>
      ))}
    </div>
  );
}

const TAG: Record<string, string> = { db: "sql", ext: "call", app: "span", cache: "cache", task: "task", wait: "wait" };
const tagOf = (line: Line) => (line.kind === "log" || line.kind === "event" ? (line.level === "skip" ? "skip" : line.level) : TAG[line.kind] ?? "span");

const LogLine = memo(function LogLine({ line, from, total, startOpen }: { line: Line; from: number; total: number; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const hasBody = Boolean(line.statement || (line.fields && Object.keys(line.fields).length));
  const left = Math.max(0, Math.min(100, ((line.start - from) / total) * 100));
  const width = line.duration ? Math.max(0.6, Math.min(100 - left, (line.duration / total) * 100)) : 0;
  return (
    <div className={`tasks-run-line ${line.error ? "is-err" : ""} ${open ? "is-open" : ""}`}>
      <button className="tasks-run-row" aria-expanded={open} disabled={!hasBody} onClick={() => setOpen(!open)}>
        <Icon name="chev" />
        <span className="tasks-run-time">{hms(line.t)}<i>.{String(Math.floor(line.t % 1000)).padStart(3, "0")}</i></span>
        <span className={`tasks-run-tag tasks-run-tag-${tagOf(line)}`}>{tagOf(line)}</span>
        <span className="tasks-run-text" style={{ paddingLeft: line.depth * 14 }}><Hl>{line.text}</Hl>{line.badge && <b className={`tasks-run-badge ${line.badgeTone === "e" ? "err" : line.badgeTone === "w" ? "warn" : "t2"}`}>{line.badge}</b>}{line.trail && <span className="tasks-run-trail">{line.trail}</span>}</span>
        <span className="tasks-run-took">{line.duration !== undefined ? fms(line.duration) : ""}</span>
        {width > 0 ? <span className="tasks-run-bar"><i className={`tasks-run-bar-${line.kind} ${line.error ? "is-err" : ""}`} style={{ left: `${left}%`, width: `${width}%` }} /></span> : <span />}
      </button>
      {open && hasBody && (
        <div className="tasks-run-detail">
          {line.statement && <Code text={line.statement} lang="sql" pretty fold />}
          {line.fields && <Fields fields={line.fields} />}
          <div className="tasks-run-detail-acts">
            <button className="tlink" onClick={() => copy(JSON.stringify(line.fields ?? {}, null, 2), "Line copied as JSON")}>Copy as JSON</button>
            {line.spanId && <Link className="tlink" to="/traces/$id" params={{ id: line.traceId }} search={{ span: line.spanId }}>Open in the trace</Link>}
          </div>
        </div>
      )}
    </div>
  );
});

function matches(line: Line, needle: string) {
  if (line.text.toLowerCase().includes(needle)) return true;
  if (line.statement?.toLowerCase().includes(needle)) return true;
  return line.fields ? JSON.stringify(line.fields).toLowerCase().includes(needle) : false;
}

function AttemptLog({ attempt, run, needle, errorsOnly, sql, alone }: { attempt: Attempt; run: Run; needle: string; errorsOnly: boolean; sql: boolean; alone: boolean }) {
  const all = useMemo(() => linesOf(attempt, run), [attempt, run]);
  const lines = all.filter((line) => (sql || line.kind !== "db" || line.error) && (!errorsOnly || line.error || line.level === "warn") && (!needle || matches(line, needle)));
  if (!lines.length && (needle || errorsOnly)) return null;
  const tone = toneOf(attempt);
  const from = Math.min(attempt.start, ...all.map((line) => line.start));
  const total = Math.max(1, attempt.end - from);
  return (
    <section className="tasks-run-attempt">
      <header className={`tasks-run-attempt-h tasks-run-tone-${tone}`}>
        <b>{nameOf(attempt, run.attempts)}</b>
        <span>{wordOf(attempt)}{reasonOf(attempt) ? `: ${inWords(reasonOf(attempt)).toLowerCase()}` : ""}</span>
        <span className="grow" />
        {attempt.worker && <span className="mono t3 tasks-run-worker">{attempt.worker}</span>}
        <span className="mono t2">{fms(attempt.duration)}</span>
        {attempt.traceId && <Link className="tlink" to="/traces/$id" params={{ id: attempt.traceId }}>Trace</Link>}
      </header>
      {lines.map((line) => <LogLine key={line.id} line={line} from={from} total={total} startOpen={line.kind === "event" && (tone === "err" || tone === "warn" || alone)} />)}
    </section>
  );
}

/** A plain copy of the whole log, the same order the page shows. */
function plainLog(run: Run) {
  return run.attempts.flatMap((attempt) => [`--- ${nameOf(attempt, run.attempts)}: ${wordOf(attempt)} ${reasonOf(attempt)} (${fms(attempt.duration)}, ${attempt.worker})`, ...linesOf(attempt, run).map((line) => `${clock(line.t)} ${tagOf(line).padEnd(6)} ${line.text}`)]).join("\n");
}

function CausedBy({ cause }: { cause: string }) {
  const separator = cause.indexOf(":");
  const type = cause.slice(0, separator);
  const id = cause.slice(separator + 1);
  if (type === "task") return <Link className="lnk" to="/tasks/run/$id" params={{ id }}>task {id.slice(0, 13)}</Link>;
  if (type === "user") return <Link className="lnk" to="/users/$id" params={{ id }}>{id}</Link>;
  if (type === "request") return <Link className="lnk" to="/traces/$id" params={{ id }}>request {id.slice(0, 13)}</Link>;
  return <>{type === "clock" ? "The schedule" : cause}</>;
}

/** Back returns to where you came from, filters and scroll included. Only a shared link falls back to the list. */
function HeadBack() {
  const router = useRouter();
  return <Back to={router.history.canGoBack() ? undefined : "/tasks/all"} title="Back" />;
}

function NotRunYet({ run }: { run: Run }) {
  return (
    <div className="ov tasks-run">
      <div className="dh"><HeadBack /><h2 className="mono"><Link to="/tasks/kind/$kind" params={{ kind: run.kind }}>{run.kind}</Link></h2><TaskChip state={run.state} /></div>
      <div className="tasks-run-verdict">
        <p>{run.state === "RUNNING" ? "A worker has it now. Nothing is logged until the attempt ends." : `It has not run yet. Due ${inFuture(run.runAt) || ago(run.runAt).toLowerCase()}.`}</p>
        <div className="tasks-run-meta"><span><Subject value={run.key} /></span>{run.accountId && <span>{run.accountId}</span>}</div>
      </div>
      {run.payload !== "null" && <div className="tasks-run-data"><div><h6>Payload</h6><Json value={run.payload} fold /></div></div>}
    </div>
  );
}

function RunPage() {
  const { id } = Route.useParams();
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const patch = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const q = useFn(taskRunFn, { id });
  const client = useQueryClient();
  const act = useMutation({ mutationFn: ({ action, reason }: { action: TaskVerb; reason: string }) => taskActionFn({ data: { id, action, reason } }), onSuccess: (_, { action }) => { toast(action === "requeue" ? "Requeued with the same payload" : action === "cancel" ? "Cancelled" : "Scheduled to run now"); void client.invalidateQueries(); } });
  const [text, setText] = useState(s.q ?? "");
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const setSearch = (value: string) => { setText(value); patch({ q: value || undefined }); };
  useListKeys({ search: "tasks-run-find", rows: ".tasks-run-step, .tasks-run-row:not(:disabled)", onClear: () => setSearch("") });
  return (
    <Load q={q}>
      {(run) => {
        if (!run.attempts.length) return <NotRunYet run={run} />;
        const last = run.attempts[run.attempts.length - 1]!;
        const first = run.attempts[0]!;
        const steps = stepsOf(run.attempts);
        const repeats = new Set(run.attempts.map((a) => a.run)).size;
        const verdict = verdictOf(run, repeats);
        const selected = steps.find((step) => step.id === s.at);
        const shownSteps = selected ? [selected] : steps;
        const needle = (text || "").trim().toLowerCase();
        const allLines = run.attempts.flatMap((attempt) => linesOf(attempt, run));
        const errorCount = allLines.filter((line) => line.error || line.level === "warn").length;
        const sqlCount = allLines.filter((line) => line.kind === "db").length;
        const logCount = allLines.filter((line) => line.kind !== "db").length;
        const hasData = run.payload !== "null" || run.result !== "null";
        const tab = hasData ? s.tab ?? "log" : "log";
        const subject = run.subject ?? { type: "", id: "" };
        const others = run.related.filter((other) => other.id !== run.id);
        const failing = last.why || last.fix || last.message;
        const failure = run.state === "FAILED" || (run.state === "WAITING" && last.type === "RETRY") || last.type === "LEASE_LOST";
        const workers = [...new Set(run.attempts.map((a) => a.worker).filter(Boolean))];
        return (
          <div className="ov tasks-run">
            <div className="dh">
              <HeadBack />
              <h2 className="mono"><Link className="tasks-run-kind" to="/tasks/kind/$kind" params={{ kind: run.kind }}>{run.kind}</Link></h2>
              <TaskChip state={run.state} />
              <span className="dhr">
                <button className="btn tasks-run-prompt" onClick={() => copy(`Investigate task ${id} (${run.kind}). State ${run.state}. ${last.why} ${last.fix}\n\n${plainLog(run)}`, "Agent prompt copied")}><Icon name="copy" />Agent prompt</button>
                {last.traceId && <Link className="btn" to="/traces/$id" params={{ id: last.traceId }}>Open trace</Link>}
                {run.actionsEnabled ? (
                  <>
                    {["WAITING", "QUEUED", "SCHEDULED"].includes(run.state) && <TaskActionDialog label="Cancel" title="Cancel this task?" action="Cancel task" danger onConfirm={(reason) => act.mutateAsync({ action: "cancel", reason })} />}
                    {["WAITING", "SCHEDULED"].includes(run.state) && <TaskActionDialog label="Run now" title="Run this task now?" action="Run now" onConfirm={(reason) => act.mutateAsync({ action: "run-now", reason })} />}
                    {run.state === "FAILED" && <TaskActionDialog label="Requeue" primary title="Requeue this task?" action="Requeue" onConfirm={(reason) => act.mutateAsync({ action: "requeue", reason })} />}
                  </>
                ) : (
                  run.state === "FAILED" && run.appTasksUrl && <a className="btn pri" href={run.appTasksUrl} target="_blank" rel="noreferrer"><Icon name="replay" />Requeue in {appName}</a>
                )}
              </span>
            </div>
            <div className="tasks-run-verdict">
              <p className={verdict.tone}>{verdict.text}</p>
              {failing && failure && (
                <dl className="tasks-run-why">
                  {(last.why || last.message) && <><dt>Why</dt><dd>{last.why || last.message}</dd></>}
                  {last.fix && <><dt>Fix</dt><dd>{last.fix}</dd></>}
                </dl>
              )}
              {failing && !failure && (last.why || last.message) && <p className="tasks-run-note">{last.why || last.message}</p>}
              <div className="tasks-run-meta">
                <span>{dayMonth(first.start)}, {hms(first.start)}</span>
                {repeats > 1 ? <span>last ran {ago(last.end).toLowerCase()}</span> : <span>took {fms(last.end - first.start)}</span>}
                {first.waitMs > 0 && <span>waited {fms(first.waitMs)} for a worker</span>}
                {workers.length === 1 && <span className="mono">{workers[0]}</span>}
                {workers.length > 1 && <span>{workers.length} workers</span>}
              </div>
            </div>
            <div className="tasks-run-body">
              <aside className="tasks-run-rail">
                <div className="tasks-run-what">
                <h5>What happened</h5>
                <ol className="tasks-run-steps">
                  {(run.producer || run.causedBy) && (
                    <li className="tasks-run-origin">
                      <i />
                      <span className="t3">Started by</span>
                      <span>{run.producer ? <Link className="lnk mono" to="/traces/$id" params={{ id: run.producer.traceId }}>{run.producer.name.replace(/^task /, "")}</Link> : <CausedBy cause={run.causedBy} />}</span>
                    </li>
                  )}
                  {steps.map((step, index) => {
                    const head = step.attempts[0]!;
                    const tail = step.attempts[step.attempts.length - 1]!;
                    const previous = steps[index - 1]?.attempts.at(-1);
                    const gap = previous ? head.start - previous.end : 0;
                    const durations = step.attempts.map((a) => a.duration);
                    const many = step.attempts.length > 1;
                    return (
                      <li key={step.id} className={`tasks-run-tone-${step.tone}`}>
                        {gap > 1000 && <span className="tasks-run-gap">{spanText(gap)} later</span>}
                        <button className={`tasks-run-step ${s.at === step.id ? "is-on" : ""}`} aria-pressed={s.at === step.id} onClick={() => patch({ at: s.at === step.id ? undefined : step.id, tab: undefined })}>
                          <i />
                          <span className="tasks-run-step-t">
                            <b>{many ? `${step.attempts.length} runs` : nameOf(head, run.attempts)}</b>
                            <span>{step.word}{step.reason ? `: ${inWords(step.reason).toLowerCase()}` : ""}</span>
                          </span>
                          <span className="tasks-run-step-m">
                            <span className="mono">{many ? `${fms(Math.min(...durations))} to ${fms(Math.max(...durations))}` : fms(head.duration)}</span>
                            <span className="mono t3">{many ? `${hms(head.end).slice(0, 5)} to ${hms(tail.end).slice(0, 5)}` : hms(head.end)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
                </div>
                <div className="tasks-run-about">
                {(subject.id || run.key || run.accountId || run.createdBy) && <h5>About</h5>}
                <div className="kvg tasks-run-facts">
                  {subject.id ? <Kv label={subject.type ? inWords(subject.type) : "Subject"}><Id value={subject.id} keep={13} /></Kv> : run.key && run.key !== run.kind && <Kv label="Key"><span className="ell"><Subject value={run.key} /></span></Kv>}
                  {run.accountId && <Kv label="Account"><Id value={run.accountId} keep={13} /></Kv>}
                  {run.createdBy && <Kv label="Person"><Link className="lnk" to="/users/$id" params={{ id: run.createdBy }}><Id value={run.createdBy} keep={13} /></Link></Kv>}
                  <Kv label="Task"><Id value={run.id} keep={13} /></Kv>
                </div>
                {others.length > 0 && (
                  <>
                    <h5>Same {subject.type || "subject"}</h5>
                    <div className="tasks-run-others">
                      {others.slice(0, 8).map((other) => (
                        <Link key={other.id} to="/tasks/run/$id" params={{ id: other.id }}>
                          <span className="mono ell">{other.kind}</span>
                          <TaskChip state={other.state} />
                        </Link>
                      ))}
                    </div>
                  </>
                )}
                {!hasData && <p className="tasks-run-hint">Payload and result come from the app's task table. Set VIGIE_APP_DATABASE_URL to read them here.</p>}
                </div>
              </aside>
              <div className="tasks-run-main">
                {hasData && <Tabs value={tab} onChange={(value) => patch({ tab: value === "log" ? undefined : value })} style={{ borderBottom: "1px solid var(--line)" }} options={[["log", "Log"], ["data", "Payload and result"]]} />}
                {tab === "data" ? (
                  <div className="tasks-run-data">
                    <div>
                      <h6>Payload <button className="tlink" onClick={() => copy(run.payload, "Payload copied")}>Copy</button></h6>
                      {run.payload === "null" ? <p className="t3">No payload stored.</p> : <Json value={run.payload} fold />}
                    </div>
                    <div>
                      <h6>Result <button className="tlink" onClick={() => copy(run.result, "Result copied")}>Copy</button></h6>
                      {run.result === "null" ? <p className="t3">No result stored.</p> : <Json value={run.result} fold />}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="tasks-run-bar-top">
                      <SearchBox id="tasks-run-find" value={text} onChange={setSearch} placeholder="Search this log" style={{ flex: "1 1 200px", maxWidth: 320 }} />
                      {errorCount > 0 && <Levels value={s.only ?? "all"} onChange={(value) => patch({ only: value === "all" ? undefined : "errors" })} options={[["all", `All ${logCount}`], ["errors", `Errors ${errorCount}`]]} />}
                      {sqlCount > 0 && <button className={`fchip ${s.sql ? "act" : ""}`} aria-pressed={Boolean(s.sql)} onClick={() => patch({ sql: s.sql ? undefined : true })}>SQL {sqlCount}</button>}
                      <span className="grow" />
                      {selected && <button className="fchip act" onClick={() => patch({ at: undefined })}>Showing one step<Icon name="x" /></button>}
                      <button className="btn tasks-run-copy" onClick={() => copy(plainLog(run), "Whole log copied")}><Icon name="copy" />Copy log</button>
                    </div>
                    <div className="tasks-run-log">
                      {shownSteps.map((step) => {
                        const many = step.attempts.length > 1;
                        const open = !many || unfolded.has(step.id) || Boolean(selected) || Boolean(needle);
                        const tail = step.attempts[step.attempts.length - 1]!;
                        const list = open ? step.attempts : [tail];
                        return (
                          <div key={step.id}>
                            {many && !open && (
                              <button className="tasks-run-fold" onClick={() => setUnfolded((prev) => new Set(prev).add(step.id))}>
                                <Icon name="chev" />
                                {step.attempts.length - 1} earlier identical {step.attempts.length - 1 === 1 ? "run" : "runs"}: show them
                              </button>
                            )}
                            {list.map((attempt) => <AttemptLog key={attempt.eventId} attempt={attempt} run={run} needle={needle} errorsOnly={s.only === "errors"} sql={Boolean(s.sql)} alone={run.attempts.length === 1} />)}
                          </div>
                        );
                      })}
                      {needle && !allLines.some((line) => matches(line, needle)) && <div className="tasks-run-none">Nothing in this log says that. <button className="tlink" onClick={() => setSearch("")}>Clear the search</button></div>}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      }}
    </Load>
  );
}
