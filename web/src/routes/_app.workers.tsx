import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { Lanes } from "@web/components/lanes.tsx";
import { DataTable } from "@web/components/table.tsx";
import { inWords, useListKeys, usePhone } from "@web/components/task-tabs.tsx";
import { Empty, Load } from "@web/components/ui.tsx";
import { workersFn } from "@web/fns/tasks.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, compact, fms, hms, num, span } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/workers")({ component: WorkersPage });

const ATTEMPTS = [{ key: "n", label: "Attempts", color: "var(--a)" }];
const ACTIVE = 5 * 60_000;

const OUTCOME = (r: { outcome: string; type: string }) => {
  if (r.outcome === "succeeded") return ["Finished", "t2"];
  if (r.type === "WAIT") return ["Waiting", "t3"];
  if (r.type === "SKIP" || r.type === "SKIPPED" || r.outcome === "skipped") return ["Skipped", "t3"];
  if (r.type === "RETRY") return ["Will retry", "warn"];
  if (r.type === "LEASE_LOST") return ["Lost its worker", "warn"];
  return [inWords(r.type || "failed"), "err"];
};

function WorkersPage() {
  const scope = useScope();
  const navigate = useNavigate();
  const q = useScoped(workersFn, {});
  useListKeys({ rows: ".workers .lnr-click, [data-testid=worker-attempts] tbody tr.click" });
  const phone = usePhone();
  const byWorker = useMemo(() => {
    const out = new Map<string, { t: number; n: number }[]>();
    for (const name of new Set((q.data?.series ?? []).map((p) => p.worker))) {
      const points = new Map((q.data?.series ?? []).filter((p) => p.worker === name).map((p) => [p.t, p.n]));
      out.set(name, (q.data?.times ?? []).map((t) => ({ t, n: points.get(t) ?? 0 })));
    }
    return out;
  }, [q.data]);
  return (
    <Load q={q}>
      {(d) => {
        if (!d.rows.length) return <Empty title="No worker in this window" hint="Widen the time range in the top bar. A worker appears here once it has run a task." />;
        const now = Date.now();
        const rows = [...d.rows].sort((a, b) => b.last - a.last);
        const active = rows.filter((w) => now - w.last < ACTIVE);
        const newest = rows[0]!;
        const lost = rows.reduce((sum, w) => sum + w.lost, 0);
        const reclaimed = rows.reduce((sum, w) => sum + w.reclaims, 0);
        const { due, running } = d.backlog;
        const seen = new Map<string, (typeof d.recent)[number] & { times: number }>();
        for (const attempt of d.recent) {
          const known = seen.get(attempt.id);
          if (known) known.times++;
          else seen.set(attempt.id, { ...attempt, times: 1 });
        }
        const latest = [...seen.values()].slice(0, 16);
        return (
          <div className="ov workers">
            <div className="workers-answer">
              {active.length > 0 ? (
                <p>{active.length} {active.length === 1 ? "worker is" : "workers are"} active{running ? `, ${num(running)} ${running === 1 ? "task" : "tasks"} running` : ""}{due ? `, ${num(due)} due` : ", nothing waiting"}.</p>
              ) : due > 0 ? (
                <p className="err">{num(due)} {due === 1 ? "task is" : "tasks are"} due and no worker has run anything for {span(now - newest.last)}.</p>
              ) : (
                <p>Nothing is due, and no worker has run a task for {span(now - newest.last)}.</p>
              )}
              {(lost > 0 || reclaimed > 0) && <p className="workers-lost">{lost > 0 && `${num(lost)} ${lost === 1 ? "lease" : "leases"} lost`}{lost > 0 && reclaimed > 0 && ", "}{reclaimed > 0 && `${num(reclaimed)} reclaimed`}</p>}
            </div>
            <Lanes wholeRow from={scope.from} to={scope.to} height={44} columns={["Attempts", "Worked"]} lanes={rows.map((w) => {
              const on = now - w.last < ACTIVE;
              return {
                id: w.worker,
                to: "/tasks/all",
                search: { worker: w.worker },
                label: <span className="mono">{w.worker}</span>,
                sub: on ? <span className="workers-on">Active, up {span(now - w.first)}</span> : <>Last task {ago(w.last).toLowerCase()}</>,
                data: byWorker.get(w.worker) ?? [],
                keys: ATTEMPTS,
                figures: [{ value: compact(w.attempts) }, { value: fms(w.busyMs), tone: "t2" }],
              };
            })} />
            {latest.length > 0 && (
              <div className="workers-recent">
                <h3>Latest attempts</h3>
                <DataTable inCard tableId="worker-attempts" rows={latest} rowKey={(r) => r.id} onRow={(r) => void navigate({ to: "/tasks/run/$id", params: { id: r.id } })} columns={[
                  { id: "t", header: "When", width: 92, className: "mono t3", cell: (r) => hms(r.t) },
                  { id: "kind", header: "Task", className: "mono", cell: (r) => <>{r.kind}{r.times > 1 && <span className="t3"> ×{r.times}</span>}</> },
                  ...(phone ? [] : [{ id: "outcome", header: "Ended", className: (r: { outcome: string; type: string }) => OUTCOME(r)[1]!, cell: (r: { outcome: string; type: string }) => OUTCOME(r)[0] }, { id: "worker", header: "Worker", className: "mono t3", cell: (r: { worker: string }) => <Link className="workers-link" to="/tasks/all" search={{ worker: r.worker }} onClick={(event) => event.stopPropagation()}>{r.worker}</Link> }]),
                  { id: "took", header: "Took", num: true, className: "mono t2", cell: (r) => fms(r.duration) },
                ]} />
              </div>
            )}
          </div>
        );
      }}
    </Load>
  );
}
