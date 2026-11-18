import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Lanes, type Lane } from "@web/components/lanes.tsx";
import { inWords, KIND_STATE, TaskTabs, useListKeys } from "@web/components/task-tabs.tsx";
import { Levels, Load, SearchBox } from "@web/components/ui.tsx";
import { taskHealthFn } from "@web/fns/tasks.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, fms, num, span } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({ f: z.enum(["all", "failed", "retrying", "running", "held"]).optional().catch(undefined), q: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/tasks/")({ validateSearch: search, component: TasksPage });

const OUTCOMES = [{ key: "done", color: "var(--a)", label: "Finished" }, { key: "skipped", color: "var(--t4)", label: "Skipped" }, { key: "failed", color: "var(--err)", label: "Failed" }];
const WAITING = [{ key: "due", label: "Due", color: "var(--t2)" }];
const FILTERS: [string, string][] = [["failed", "Failing"], ["retrying", "Retrying"], ["running", "Running"], ["held", "Held"]];

type Health = Awaited<ReturnType<typeof taskHealthFn>>;
type Row = Health["rows"][number];

/** What a kind's row says under its name: the trouble when there is one, otherwise how recently it ran. */
function subOf(kind: Row) {
  if (kind.state === "failed" || (kind.failed > 0 && kind.failCode)) return <span className="err">{kind.failed} of {num(kind.attempts)} failed{kind.failCode ? `, ${inWords(kind.failCode).toLowerCase()}` : ""}</span>;
  if (kind.state === "retrying") return <span className="warn">Retrying{kind.waitCode ? `, ${inWords(kind.waitCode).toLowerCase()}` : ""}</span>;
  return <>{kind.skipped > 0 ? `${num(kind.skipped)} skipped, ` : ""}{kind.failed > 0 ? `${kind.failed} failed, ` : ""}{ago(kind.last).toLowerCase()}</>;
}

function Flow({ d }: { d: Health }) {
  const { flow } = d.verdict;
  if (flow.due === 0) return <p>Nothing is waiting{flow.scheduled ? <span className="t3">, <Link className="lnk" to="/tasks/all" search={{ state: "SCHEDULED" }}>{num(flow.scheduled)} scheduled</Link></span> : null}</p>;
  const late = flow.oldestDue >= flow.lateAfter;
  return <p className={late ? "err" : ""}><Link className="lnk" to="/tasks/all" search={{ state: "QUEUED" }}>{num(flow.due)} due</Link>, the oldest for {span(flow.oldestDue * 1000)}{late ? `, past the ${span(flow.lateAfter * 1000)} line` : ""}</p>;
}

function Execution({ d }: { d: Health }) {
  const { execution } = d.verdict;
  const skipped = d.rows.reduce((sum, row) => sum + row.skipped, 0);
  if (!execution.attempts) return <p className="t2">No task ran in this window</p>;
  if (!execution.failed) return <p>All {num(execution.attempts)} attempts went through{skipped ? <span className="t3">, {num(skipped)} of them skipped</span> : null}</p>;
  return <p className={execution.state === "bad" ? "err" : execution.state === "warn" ? "warn" : ""}><Link className="lnk" to="/tasks/all" search={{ state: "FAILED" }}>{num(execution.failed)} of {num(execution.attempts)} failed</Link>{execution.worst ? <span className="t2">, mostly <Link className="lnk mono" to="/tasks/kind/$kind" params={{ kind: execution.worst }}>{execution.worst}</Link></span> : null}</p>;
}

function Workers({ d }: { d: Health }) {
  const { liveness, flow } = d.verdict;
  const lost = liveness.lost ? <span className="warn">, {liveness.lost} {liveness.lost === 1 ? "lease" : "leases"} lost</span> : null;
  if (liveness.workers.length) return <p><Link className="lnk" to="/workers">{liveness.workers.length} active</Link>{lost}</p>;
  if (!liveness.lastSeen) return <p className={flow.due ? "err" : "t2"}>No worker has run a task in this window</p>;
  // Silence with work due is an outage. Silence with nothing due is worth a glance, nothing more.
  return <p className={flow.due ? "err" : "warn"}><Link className="lnk" to="/workers">None active</Link><span className="t2">, the last task ran {ago(liveness.lastSeen).toLowerCase()}</span>{lost}</p>;
}

function TasksPage() {
  const { f = "all", q: text = "" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const scope = useScope();
  const q = useScoped(taskHealthFn, {});
  const [shown, setShown] = useState(text);
  const setText = (value: string) => {
    setShown(value);
    void navigate({ search: (prev) => ({ ...prev, q: value || undefined }), replace: true });
  };
  useListKeys({ search: "tasks-health-find", rows: ".tasks-health .lnr-click", onClear: () => setText("") });
  const counts = (key: string) => q.data?.rows.filter((row) => row.state === key).length ?? 0;
  const options = [["all", "All"] as const, ...FILTERS.filter(([key]) => key === f || counts(key) > 0).map(([key, label]) => [key, <>{label} <b className="tasks-health-n">{counts(key)}</b></>] as const)];
  return (
    <>
      <TaskTabs right={(
        <>
          {(q.data?.backlog.running ?? 0) > 0 && <span className="t3">{num(q.data!.backlog.running)} running now</span>}
          <Levels value={f} onChange={(value) => void navigate({ search: (prev) => ({ ...prev, f: value === "all" ? undefined : (value as never) }), replace: true })} options={options as never} />
          <SearchBox id="tasks-health-find" value={shown} onChange={setText} placeholder="Find a task kind" style={{ width: 240 }} />
        </>
      )} />
      <Load q={q}>
        {(d) => {
          const needle = shown.trim().toLowerCase();
          // Anything with a failure rises above what ran clean, whatever its share.
          const rank = (row: Row) => (row.state === "failed" ? 0 : row.state === "retrying" ? 1 : row.failed > 0 ? 2 : 3);
          const ran = d.rows.filter((row) => row.runs > 0 && (f === "all" || row.state === f) && row.kind.includes(needle)).sort((a, b) => rank(a) - rank(b) || (rank(a) < 3 ? b.failed - a.failed : b.runs - a.runs));
          const quiet = d.rows.filter((row) => row.runs === 0 && row.kind.includes(needle));
          const anyFailed = ran.some((row) => row.failed > 0);
          const lanes: Lane[] = ran.map((row) => {
            const state = KIND_STATE[row.state];
            return {
              id: row.kind,
              label: <span className={`mono ${row.state === "failed" ? "err" : row.state === "retrying" ? "warn" : ""}`}>{row.kind}</span>,
              sub: <span title={state[0]}>{subOf(row)}</span>,
              to: `/tasks/kind/${encodeURIComponent(row.kind)}`,
              data: row.lane,
              keys: OUTCOMES,
              figures: [{ value: num(row.runs) }, ...(anyFailed ? [{ value: row.failed ? num(row.failed) : "", tone: "err" }] : []), { value: row.p95 ? fms(row.p95) : "", tone: "t2" }],
            };
          });
          if (d.waiting.some((point) => point.due > 0) && f === "all" && !needle) lanes.unshift({ id: "queue", label: "Waiting for a worker", kind: "line", data: d.waiting, keys: WAITING, format: num, figures: [{ value: num(d.backlog.due), label: "Due now", tone: d.verdict.flow.state === "bad" ? "err" : "" }] });
          return (
            <div className="ov tasks-health">
              <div className="tasks-health-pulse">
                <div><span>Queue</span><Flow d={d} /></div>
                <div><span>Attempts</span><Execution d={d} /></div>
                <div><span>Workers</span><Workers d={d} /></div>
              </div>
              {lanes.length > 0 && <Lanes wholeRow from={scope.from} to={scope.to} height={26} columns={anyFailed ? ["Runs", "Failed", "p95"] : ["Runs", "p95"]} lanes={lanes} />}
              {!lanes.length && (
                <div className="tasks-health-none">
                  {needle || f !== "all" ? <>No task kind matches. <button className="tlink" onClick={() => { setText(""); void navigate({ search: (prev) => ({ ...prev, f: undefined, q: undefined }), replace: true }); }}>Clear the filters</button></> : "No task ran in this window. Widen the time range."}
                </div>
              )}
              {quiet.length > 0 && f === "all" && (
                <div className="tasks-health-quiet">
                  <span>No runs in this window</span>
                  <div>{quiet.map((row) => <Link key={row.kind} className="mono" to="/tasks/kind/$kind" params={{ kind: row.kind }}>{row.kind}</Link>)}</div>
                </div>
              )}
            </div>
          );
        }}
      </Load>
    </>
  );
}
