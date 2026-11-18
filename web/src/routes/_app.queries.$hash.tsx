import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { timeSpent, useListKeys } from "@web/components/backend.tsx";
import { Code } from "@web/components/code.tsx";
import { Lanes } from "@web/components/lanes.tsx";
import { Entry, Head, Load } from "@web/components/ui.tsx";
import { queryFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { compact, fms, hms } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({ find: z.string().optional().catch(undefined), show: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/queries/$hash")({ validateSearch: search, component: QueryPage });

const COST = [{ key: "avg", label: "Average", color: "var(--a)" }];
const RUNS = [{ key: "calls", label: "Runs", color: "var(--t3)" }];

/** The table a statement is about: the first one outside any brackets, so a subquery's table never names the page. */
function mainTable(statement: string) {
  let depth = 0;
  let outer = "";
  for (const char of statement) {
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) outer += char;
  }
  return outer.match(/\b(?:from|into|update)\s+"?(\w+)"?/i)?.[1];
}

function QueryPage() {
  const { hash } = Route.useParams();
  const scope = useScope();
  const q = useScoped(queryFn, { hash });
  useListKeys();
  return (
    <Load q={q}>
      {(d) => {
        const repeatMost = d.repeats.reduce((most, r) => (r.n > most ? r.n : most), 1);
        const usual = d.repeats.reduce((best, r) => (r.traces > best.traces ? r : best), { n: 1, traces: 0 });
        const maxRepeat = Math.max(1, ...d.repeats.map((r) => r.traces));
        const table = mainTable(d.stats.statement);
        const traced = d.callers.reduce((sum, c) => sum + c.calls, 0);
        const biggest = Math.max(1, ...d.callers.map((c) => c.total));
        const verb = (d.stats.operation || d.stats.statement.trim().split(/\s+/)[0] || "Query").toLowerCase();
        const repeated = repeatMost > 3;
        return (
          <div className="ov">
            <Head back="/queries" backTitle="Back to queries" title={table ? `${verb[0]!.toUpperCase()}${verb.slice(1)} on ${table}` : d.stats.statement.trim().slice(0, 60)} />
            <Code className="flat q1-sql" text={d.recent[0]?.statement ?? d.stats.statement} lang="sql" pretty fold />
            <div className="q1-cost">
              <div className="q1-fig"><span>Time spent</span><b>{timeSpent(d.stats.total)}</b></div>
              <div className="q1-fig"><span>Runs</span><b>{compact(d.stats.calls)}</b></div>
              <div className="q1-fig"><span>Average</span><b>{fms(d.stats.avg)}</b></div>
              <div className="q1-fig"><span>p95</span><b className={d.stats.p95 >= 100 ? "warn" : ""}>{fms(d.stats.p95)}</b></div>
              {d.stats.errors > 0 && <div className="q1-fig"><span>Failed</span><b className="err">{compact(d.stats.errors)}</b></div>}
              {repeatMost > 1 && (
                <div className="q1-fig"><span>Per request</span><b className={repeated ? "warn" : ""}>{usual.n === repeatMost ? `${usual.n}×` : `${usual.n}× to ${repeatMost}×`}</b></div>
              )}
            </div>
            <div className={d.repeats.length > 1 ? "rt-two" : "rt-one"}>
              <section className="rt-list">
                <h3 className="q1-who">Who runs it{traced > 0 && traced < d.stats.calls && <span className="t3">{compact(traced)} of {compact(d.stats.calls)} runs have a trace</span>}</h3>
                {d.callers.map((caller) => {
                  const method = caller.entry.match(/^(GET|POST|PATCH|PUT|DELETE)\s+(.*)$/);
                  const task = caller.entry.match(/^task\s+(.*)$/);
                  const body = (
                    <>
                      <span className="mono ell grow"><Entry text={caller.entry} /></span>
                      {caller.most > 3 && <span className="warn q1-rep">up to {caller.most}×</span>}
                      <span className="mono t3 q1-runs">{compact(caller.calls)} runs</span>
                      <span className="req-spent mono q1-spent"><span className="req-bar"><i className={caller.most > 3 ? "warn" : ""} style={{ scale: `${caller.total / biggest} 1` }} /></span><span className="req-time">{timeSpent(caller.total)}</span></span>
                    </>
                  );
                  if (method) return <Link key={caller.entry} className="lst" to="/requests/route" search={{ method: method[1]!, route: method[2]! }}>{body}</Link>;
                  if (task) return <Link key={caller.entry} className="lst" to="/tasks/kind/$kind" params={{ kind: task[1]! }}>{body}</Link>;
                  return <div key={caller.entry} className="lst">{body}</div>;
                })}
                {!d.callers.length && <div className="cb t3">No trace of this statement in this window. Runs are sampled, the totals above are not.</div>}
              </section>
              {d.repeats.length > 1 && (
                <section className="rt-sec">
                  <h3>Repeats in one request</h3>
                  <div className="q1-reps" role="img" aria-label={d.repeats.map((r) => `${r.n} times in ${r.traces} requests`).join(", ")}>
                    {d.repeats.map((r) => (
                      <div key={r.n} className="q1-repc" title={`${r.traces} requests ran it ${r.n} times`}>
                        <span className="rt-n">{compact(r.traces)}</span>
                        <span className="rt-track"><i className={r.n > 3 ? "slow" : ""} style={{ scale: `1 ${r.traces / maxRepeat}` }} /></span>
                        <span className="rt-x">{r.n}×</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
            <section className="rt-list rt-one">
              <h3>Slowest runs</h3>
              {d.slowest.map((run, i) => (
                <Link key={run.traceId + i} className="lst" to="/traces/$id" params={{ id: run.traceId }}>
                  <span className="lt rt-time">{hms(run.t)}</span>
                  <span className="mono grow ell">{run.entry ? <Entry text={run.entry} /> : <span className="t3">No entry point recorded</span>}</span>
                  {run.status === "Error" && <span className="err">Failed</span>}
                  <span className={`mono rt-dur ${run.duration >= 100 ? "warn" : "t2"}`}>{fms(run.duration)}</span>
                </Link>
              ))}
            </section>
            <Lanes from={scope.from} to={scope.to} height={46} lanes={[
              { id: "avg", label: "Average", kind: "line", keys: COST, data: d.series.filter((point) => point.calls > 0), format: fms },
              { id: "runs", label: "Runs", keys: RUNS, data: d.series },
            ]} />
          </div>
        );
      }}
    </Load>
  );
}
