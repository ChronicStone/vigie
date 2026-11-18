import { createFileRoute, Link } from "@tanstack/react-router";
import { share, useListKeys } from "@web/components/backend.tsx";
import { Lanes } from "@web/components/lanes.tsx";
import { Entry, Head, Load } from "@web/components/ui.tsx";
import { providerFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, compact, fms, hms, statusClass } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/external/$host")({ component: ProviderPage });

/** The method only earns its place in front of a path. An operation name already says what it does. */
function Op({ method, path, host }: { method: string; path: string; host: string }) {
  const clean = path.replace(new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`), "");
  if (!clean.startsWith("/")) return <span className="mono">{clean || "Unnamed call"}</span>;
  return <span className="mono">{method && <span className={`m-${method.toLowerCase()}`}>{method} </span>}{clean}</span>;
}

/** The span recorded no HTTP status. All we know is what it says, so it says that, not 0 and not a guess at why. */
const statusText = (status: number) => (status ? String(status) : "No status");

function ProviderPage() {
  const { host } = Route.useParams();
  const q = useScoped(providerFn, { host });
  const scope = useScope();
  useListKeys();
  return (
    <Load q={q}>
      {(d) => {
        const rate = d.stats.calls ? (d.stats.failed / d.stats.calls) * 100 : 0;
        const verdict = !d.stats.calls ? { word: "No calls", tone: "t3" } : rate >= 5 ? { word: "Failing", tone: "err" } : d.stats.failed ? { word: "Some failures", tone: "warn" } : d.stats.p95 >= 1500 ? { word: "Slow", tone: "warn" } : { word: "Healthy", tone: "ok" };
        const failMost = Math.max(1, ...d.failures.map((f) => f.n));
        const triggerMost = Math.max(1, ...d.triggers.map((t) => t.calls));
        const opMost = Math.max(1, ...d.ops.map((o) => o.calls));
        const failed = d.failedCalls.length > 0;
        return (
          <div className="ov">
            <Head back="/external" backTitle="Back to external calls" title={d.name} meta={d.name !== d.host ? <span className="dhm mono">{d.host}</span> : undefined} />
            <div className="rt-verdict">
              <b className={`rt-word ${verdict.tone}`}>{verdict.word}</b>
              <div className="rt-figs">
                <div className="rt-fig"><span className="rt-figl">Calls</span><b>{compact(d.stats.calls)}</b></div>
                <div className="rt-fig"><span className="rt-figl">Failed</span><b className={d.stats.failed ? "err" : ""}>{d.stats.failed ? share(d.stats.failed, d.stats.calls) : "None"}</b>{d.stats.failed > 0 && <span className="rt-delta">{d.stats.failed} calls</span>}</div>
                <div className="rt-fig"><span className="rt-figl">Average</span><b>{fms(d.stats.avg)}</b></div>
                <div className="rt-fig"><span className="rt-figl">p95</span><b className={d.stats.p95 >= 1500 ? "warn" : ""}>{fms(d.stats.p95)}</b></div>
              </div>
            </div>
            {d.failures.length > 0 && (
              <section className="rt-list prov-sec">
                <h3>What is failing</h3>
                {d.failures.map((f) => (
                  <div className="prov-fail" key={`${f.method} ${f.path} ${f.status}`}>
                    <span className="prov-op ell"><Op method={f.method} path={f.path} host={d.host} /></span>
                    <span className={`mono prov-status ${f.status ? statusClass(f.status) : "err"}`}>{statusText(f.status)}</span>
                    <span className="grow ell t3 prov-msg">{f.message}</span>
                    <span className="share bad prov-bar"><i style={{ scale: `${f.n / failMost} 1` }} /></span>
                    <span className="mono prov-n">{compact(f.n)}</span>
                    <span className="t3 prov-ago">{ago(f.last)}</span>
                  </div>
                ))}
              </section>
            )}
            <div className="rt-two">
              <section className="rt-list">
                <h3>What triggered these calls</h3>
                {d.triggers.map((t) => {
                  const method = t.entry.match(/^(GET|POST|PATCH|PUT|DELETE)\s+(.*)$/);
                  const task = t.entry.match(/^task\s+(.*)$/);
                  const body = (
                    <>
                      <span className="mono ell grow"><Entry text={t.entry} /></span>
                      {t.failed > 0 && <span className="err mono prov-tf">{compact(t.failed)} failed</span>}
                      <span className="share prov-bar"><i style={{ scale: `${t.calls / triggerMost} 1` }} /></span>
                      <span className="mono t2 prov-n">{compact(t.calls)}</span>
                    </>
                  );
                  if (method) return <Link key={t.entry} className="lst" to="/requests/route" search={{ method: method[1]!, route: method[2]! }}>{body}</Link>;
                  if (task) return <Link key={t.entry} className="lst" to="/tasks/kind/$kind" params={{ kind: task[1]! }}>{body}</Link>;
                  return <div key={t.entry} className="lst">{body}</div>;
                })}
                {!d.triggers.length && <div className="cb t3">No request or task linked to these calls in this window.</div>}
              </section>
              <section className="rt-list">
                <h3>Operations</h3>
                {d.ops.map((op) => (
                  <div className="prov-oprow" key={op.method + op.path}>
                    <span className="grow ell"><Op method={op.method} path={op.path} host={d.host} /></span>
                    {op.errors > 0 && <span className="err mono prov-tf">{op.errors} failed</span>}
                    <span className="share prov-bar"><i style={{ scale: `${op.calls / opMost} 1` }} /></span>
                    <span className="mono t2 prov-n">{compact(op.calls)}</span>
                    <span className={`mono rt-dur ${op.p95 >= 1500 ? "warn" : "t2"}`} title="p95">{fms(op.p95)}</span>
                  </div>
                ))}
              </section>
            </div>
            <section className="rt-list rt-one">
              <h3 className={failed ? "err" : ""}>{failed ? "Failed calls, and what made them" : "Latest calls, and what made them"}</h3>
              {(failed ? d.failedCalls : d.calls).map((call, i) => (
                <Link key={call.traceId + i} className="lst" {...(call.taskId ? { to: "/tasks/run/$id", params: { id: call.taskId } } : { to: "/traces/$id", params: { id: call.traceId } })}>
                  <span className="lt rt-time">{hms(call.t)}</span>
                  <span className="prov-call ell"><Op method={call.method} path={call.path} host={d.host} /></span>
                  <span className={`mono prov-status ${call.status ? statusClass(call.status) : call.failed ? "err" : "t3"}`}>{statusText(call.status)}</span>
                  <span className="grow ell t2 mono prov-entry">{call.entry ? <Entry text={call.entry} /> : ""}</span>
                  <span className={`mono rt-dur ${call.duration >= 800 ? "warn" : "t2"}`}>{fms(call.duration)}</span>
                </Link>
              ))}
            </section>
            <Lanes from={scope.from} to={scope.to} height={46} lanes={[{ id: "calls", label: "Calls", data: d.series }]} />
          </div>
        );
      }}
    </Load>
  );
}
