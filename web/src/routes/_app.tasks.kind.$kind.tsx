import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Lanes } from "@web/components/lanes.tsx";
import { inWords, KIND_STATE, useListKeys, usePhone } from "@web/components/task-tabs.tsx";
import { DataTable } from "@web/components/table.tsx";
import { Back, Card, Chip, Load, Subject, TaskChip } from "@web/components/ui.tsx";
import { switchHistoryFn, taskKindFn } from "@web/fns/tasks.ts";
import { useFn, useScoped } from "@web/lib/api.ts";
import { ago, dayMonth, fms, hm, num } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/tasks/kind/$kind")({ component: KindPage });

const DUR = [{ key: "p50", label: "p50", color: "var(--t3)" }, { key: "p95", label: "p95", color: "var(--a)" }];
const OUTCOMES = [{ key: "done", label: "Finished", color: "var(--a)" }, { key: "skipped", label: "Skipped", color: "var(--t4)" }, { key: "error", label: "Failed", color: "var(--err)" }];

const TYPE_WORD: Record<string, [string, string]> = { SKIP: ["Skipped", "t3"], WAIT: ["Waited", "t3"], AGAIN: ["Ran again", "t3"], RETRY: ["Retried", "warn"], FAIL: ["Failed", "err"], LEASE_LOST: ["Lost its worker", "warn"], CANCELLED: ["Cancelled", "t3"], REQUEUED: ["Requeued", "t3"] };
/** What needs a person comes first, what the task simply decided comes last. */
const WEIGHT: Record<string, number> = { FAIL: 0, RETRY: 1, LEASE_LOST: 2, WAIT: 3, SKIP: 4, AGAIN: 5, REQUEUED: 6, CANCELLED: 7 };

function KindPage() {
  const { kind } = Route.useParams();
  const navigate = useNavigate();
  const router = useRouter();
  const scope = useScope();
  const q = useScoped(taskKindFn, { kind });
  const history = useFn(switchHistoryFn, { key: q.data?.switch ?? "" }, { enabled: Boolean(q.data?.switch) });
  useListKeys({ rows: ".tasks-kind [data-testid=kind-runs] tbody tr.click, .tasks-kind-reason" });
  const phone = usePhone();
  return (
    <Load q={q}>
      {(d) => {
        const maxLadder = Math.max(1, ...d.ladder.map((l) => l.n));
        const ladder = d.ladder.some((step) => step.n > 0);
        const codes = [...d.codes].sort((a, b) => (WEIGHT[a.type] ?? 0) - (WEIGHT[b.type] ?? 0) || b.n - a.n);
        const needs = codes.some((code) => (WEIGHT[code.type] ?? 0) < 3);
        const def = d.definition;
        const defs: [string, string][] = ([
          ["Clock", def?.clock ?? "None, queued by events"],
          ["Integration", def?.integration ?? d.stats.integration],
          ["Switch", def?.switch ?? ""],
          ["One at a time per", def?.serial ?? ""],
          ["Concurrency", def?.concurrency ? `${def.concurrency} per worker` : ""],
          ["Handler", def?.handler ?? ""],
        ] as [string, string][]).filter(([, value]) => value);
        return (
          <div className="ov tasks-kind">
            <div className="dh">
              <Back to={router.history.canGoBack() ? undefined : "/tasks"} title="Back" />
              <h2 className="mono">{d.kind}</h2>
              {d.state !== "ok" && <Chip tone={KIND_STATE[d.state][1]}>{KIND_STATE[d.state][0]}</Chip>}
              <span className="dhr"><Link className="btn" to="/tasks/all" search={{ kind }}>All {num(d.stats.runs)} runs</Link></span>
            </div>
            {codes.length > 0 && (
              <div className={`tasks-kind-why ${ladder ? "has-ladder" : ""}`}>
                <div>
                  <h3>{needs ? "Why it does not finish" : "When it stops early"}</h3>
                  {codes.map((code) => {
                    const [word, tone] = TYPE_WORD[code.type] ?? ["Failed", "err"];
                    return (
                      <div key={code.type + code.code} className="tasks-kind-reason" role="link" tabIndex={0} onClick={() => void navigate({ to: "/tasks/run/$id", params: { id: code.taskId } })} onKeyDown={(event) => { if (event.key === "Enter") void navigate({ to: "/tasks/run/$id", params: { id: code.taskId } }); }}>
                        <span className={`tasks-kind-word ${tone}`}>{word}</span>
                        <span className="tasks-kind-text">
                          <b title={code.code}>{code.code ? inWords(code.code) : "No reason recorded"}</b>
                          {code.why && <span>{code.why}</span>}
                        </span>
                        <span className="tasks-kind-last">{ago(code.last)}</span>
                        <Link className="tasks-kind-n" to="/tasks/all" search={{ kind, q: code.code || undefined }} onClick={(event) => event.stopPropagation()}>{num(code.n)}</Link>
                      </div>
                    );
                  })}
                </div>
                {ladder && (
                  <div>
                    <h3>Failures at each retry</h3>
                    <div className="tasks-kind-ladder">
                      {d.ladder.filter((step) => step.n > 0).map((step) => (
                        <div key={step.label}>
                          <span>{step.label}</span>
                          <i><u style={{ scale: `${step.n / maxLadder} 1` }} /></i>
                          <b>{num(step.n)}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <Lanes from={scope.from} to={scope.to} height={64} lanes={[
              { id: "runs", label: "Runs", sub: d.stats.attempts !== d.stats.runs ? `${num(d.stats.attempts)} attempts` : undefined, data: d.series, keys: OUTCOMES, figures: [{ value: num(d.stats.runs), label: "Ran" }, ...(d.stats.failed ? [{ value: num(d.stats.failed), label: "Failed", tone: "err" }] : []), ...(d.stats.skipped ? [{ value: num(d.stats.skipped), label: "Skipped", tone: "t3" }] : [])] },
              { id: "duration", label: "Duration", sub: d.stats.wait > 0 ? `${fms(d.stats.wait)} in the queue` : undefined, kind: "line", data: d.duration, keys: DUR, format: fms, figures: [{ value: fms(d.stats.p95), label: "p95", color: "var(--a)" }] },
            ]} />
            <div className="tasks-kind-runs">
              <h3>Latest runs</h3>
              <DataTable inCard tableId="kind-runs" rows={d.runs} rowKey={(run) => run.id} onRow={(run) => void navigate({ to: "/tasks/run/$id", params: { id: run.id } })} emptyTitle="No run in this window" emptyHint="Widen the time range in the top bar." columns={[
                { id: "state", header: "State", width: 104, cell: (run) => <TaskChip state={run.state} /> },
                { id: "subject", header: "Subject", className: "t2", cell: (run) => (run.key && run.key !== run.kind ? <Subject value={run.key} /> : "") },
                ...(phone ? [] : [{ id: "reason", header: "Reason", className: (run: { state: string }) => `ell ${run.state === "FAILED" ? "err" : "t3"}`, style: { maxWidth: 260 }, cell: (run: { code: string }) => (run.code ? <span title={run.code}>{inWords(run.code)}</span> : "") },
                { id: "attempts", header: "Attempts", num: true, className: "mono t3", cell: (run: { attempts: number }) => (run.attempts > 1 ? run.attempts : "") }]),
                { id: "duration", header: "Took", num: true, className: "mono t2", cell: (run) => (run.duration ? fms(run.duration) : "") },
                { id: "last", header: "When", num: true, className: "t3", cell: (run) => ago(run.last) },
              ]} />
            </div>
            {history.data && history.data.length > 0 && (
              <Card title={`Switch ${d.switch}`}>
                {history.data.map((change) => (
                  <div className="lst" key={change.at}>
                    <span className={change.enabled ? "ok" : "warn"} style={{ width: 70, flex: "none" }}>{change.enabled ? "Turned on" : "Turned off"}</span>
                    <span className="ell grow t2">{change.reason}</span>
                    <span className="t3">{change.who}</span>
                    <span className="mono t3">{dayMonth(change.at)} {hm(change.at)}</span>
                  </div>
                ))}
              </Card>
            )}
            <dl className="tasks-kind-def">
              {defs.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}
            </dl>
          </div>
        );
      }}
    </Load>
  );
}
