import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { change, share, useListKeys } from "@web/components/backend.tsx";
import { Hl } from "@web/components/code.tsx";
import { Lanes } from "@web/components/lanes.tsx";
import { Head, Id, Load, looksLikeId, Method2, RoutePath } from "@web/components/ui.tsx";
import { routeFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { compact, fms, hms, statusClass } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({ method: z.string().catch(""), route: z.string().catch(""), find: z.string().optional().catch(undefined), show: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/requests/route")({ validateSearch: search, component: RoutePage });

const BUCKETS = ["25 ms", "50 ms", "100 ms", "250 ms", "500 ms", "1 s", "2.5 s", "5 s", "5 s+"];
/** Where a time falls on the bars. */
const bucketOf = (ms: number) => (ms < 25 ? 0 : ms < 50 ? 1 : ms < 100 ? 2 : ms < 250 ? 3 : ms < 500 ? 4 : ms < 1000 ? 5 : ms < 2500 ? 6 : ms < 5000 ? 7 : 8);

type Row = { id: string; traceId: string; t: number; status: number; duration: number; outcome: string; person: string };

function RequestRow({ r }: { r: Row }) {
  return (
    <Link className="lst" to="/traces/$id" params={{ id: r.traceId }}>
      <span className="lt rt-time">{hms(r.t)}</span>
      <span className={`mono rt-status ${statusClass(r.status)}`}>{r.status}</span>
      <span className="grow ell t2">{looksLikeId(r.person) ? <Id value={r.person} /> : r.person}</span>
      <span className={`mono rt-dur ${r.duration >= 800 ? "warn" : "t2"}`}>{fms(r.duration)}</span>
    </Link>
  );
}

function RoutePage() {
  const { method, route } = Route.useSearch();
  const scope = useScope();
  const q = useScoped(routeFn, { method, route });
  useListKeys();
  return (
    <Load q={q}>
      {(d) => {
        const { stats, previous } = d;
        const failRate = stats.count ? (stats.errors / stats.count) * 100 : 0;
        const prevRate = previous.count ? (previous.errors / previous.count) * 100 : 0;
        const verdict = !stats.count ? { word: "No traffic", tone: "t3" } : failRate >= 1 ? { word: "Failing", tone: "err" } : stats.p95 >= 1000 ? { word: "Slow", tone: "warn" } : stats.errors ? { word: "Some failures", tone: "warn" } : { word: "Healthy", tone: "ok" };
        const slower = change(stats.avg, d.previousAvg);
        const hasBefore = previous.count > 0;
        const figures = [
          { label: "Requests", value: compact(stats.count), delta: change(stats.count, previous.count), bad: false },
          { label: "Failed", value: stats.errors ? share(stats.errors, stats.count) : "None", tone: stats.errors ? "err" : "", delta: hasBefore && Math.abs(failRate - prevRate) >= 0.1 ? `was ${prevRate.toFixed(1)}%` : "", bad: failRate > prevRate },
          { label: "Average", value: fms(stats.avg), delta: slower, bad: stats.avg > d.previousAvg },
          { label: "p95", value: fms(stats.p95), tone: stats.p95 >= 1000 ? "warn" : "", delta: change(stats.p95, previous.p95), bad: stats.p95 > previous.p95 },
        ];
        const most = Math.max(1, ...d.histogram.map((b) => b.n));
        const bars = BUCKETS.map((label, i) => ({ label, ...(d.histogram.find((b) => b.bucket === i) ?? { n: 0, failed: 0 }) }));
        const p95At = bucketOf(stats.p95);
        const avg = d.parts.avg || stats.avg;
        const providerMs = stats.count ? d.calls.reduce((sum, c) => sum + c.total, 0) / stats.count : 0;
        const dbMs = d.parts.db;
        const ownMs = Math.max(0, avg - dbMs - providerMs);
        const parts = [
          { label: "Database", ms: dbMs, color: "var(--db)" },
          { label: "Providers", ms: providerMs, color: "var(--ext)" },
          { label: "Own code", ms: ownMs, color: "var(--line3)" },
        ].filter((part) => part.ms >= 0.5);
        const partsTotal = parts.reduce((sum, part) => sum + part.ms, 0);
        const suspects = d.repeated.filter((r) => r.times > 1);
        return (
          <div className="ov">
            <Head back="/requests" backTitle="Back to requests" title={<><Method2 m={method} /><RoutePath path={route} /></>} mono right={<Link className="btn" to="/alerts/new" search={{ method, route }}>Create alert</Link>} />
            <div className="rt-verdict">
              <b className={`rt-word ${verdict.tone}`}>{verdict.word}</b>
              <div className="rt-figs">
                {figures.map((f) => (
                  <div key={f.label} className="rt-fig">
                    <span className="rt-figl">{f.label}</span>
                    <b className={f.tone ?? ""}>{f.value}</b>
                    {f.delta && <span className={`rt-delta ${f.bad ? "warn" : ""}`}>{f.delta}</span>}
                  </div>
                ))}
              </div>
              <span className="rt-against">{hasBefore ? "Against the window before" : "Nothing in the window before to compare with"}</span>
            </div>
            <div className="rt-two">
              <section className="rt-sec">
                <h3>How long requests take</h3>
                <div className="rt-hist" role="img" aria-label={bars.map((b) => `Under ${b.label}: ${b.n}`).join(", ")}>
                  {bars.map((b, i) => (
                    <div key={b.label} className={`rt-col ${i === p95At ? "p95" : ""}`}>
                      <span className="rt-n">{b.n ? compact(b.n) : ""}</span>
                      <span className="rt-track">
                        <i style={{ scale: `1 ${Math.max(b.n ? 0.02 : 0, (b.n - b.failed) / most)}` }} className={i >= 6 ? "slow" : ""} />
                        {b.failed > 0 && <i className="bad" style={{ scale: `1 ${Math.max(0.02, b.failed / most)}`, translate: `0 calc(-1 * ${((b.n - b.failed) / most) * 100}%)` }} />}
                      </span>
                      <span className="rt-x">{b.label.replace(" ms", "")}{b.label.endsWith(" ms") && <span className="rt-ms"> ms</span>}</span>
                    </div>
                  ))}
                </div>
              </section>
              <section className="rt-sec rt-why">
                <h3>What the time goes to</h3>
                {partsTotal > 0 && (
                  <>
                    <div className="xbar rt-parts">{parts.map((part) => <i key={part.label} style={{ flexGrow: part.ms, background: part.color }} />)}</div>
                    <div className="xleg">{parts.map((part) => <span key={part.label}><i style={{ background: part.color }} /><b>{fms(part.ms)}</b>{part.label}</span>)}</div>
                  </>
                )}
                {suspects.map((rep) => (
                  <Link key={rep.statement} className="lst rt-cause" to={rep.hash ? "/queries/$hash" : "/queries"} params={rep.hash ? { hash: rep.hash } : undefined as never}>
                    <span className="grow rt-cw">
                      <span className={rep.times > 3 ? "warn" : "t2"}>Same query {rep.times}× per request</span>
                      <span className="mono ell t3 rt-sql"><Hl lang="sql">{rep.statement}</Hl></span>
                    </span>
                    <span className="mono t3">{compact(rep.n)} requests</span>
                  </Link>
                ))}
                {d.calls.slice(0, 5).map((call) => (
                  <Link key={call.host + call.path} className="lst rt-cause" to="/external/$host" params={{ host: call.host }}>
                    <span className="grow ell"><span className="t2">{call.provider}</span> <span className="mono t3">{call.path.replace(`${call.host} `, "")}</span></span>
                    {call.errors > 0 && <span className="err mono">{call.errors} failed</span>}
                    <span className="mono t3">{compact(call.calls)}×</span>
                    <span className="mono t2 rt-dur">{fms(call.avg)}</span>
                  </Link>
                ))}
              </section>
            </div>
            {d.reasons.length > 0 && (
              <section className="rt-sec rt-reasons">
                <h3>Why it answered an error</h3>
                {d.reasons.map((reason) => (
                  <div className="rt-reason" key={reason.status}>
                    <span className={`mono rt-status ${statusClass(reason.status)}`}>{reason.status}</span>
                    <span className="grow ell t2">{reason.why || "No reason recorded"}</span>
                    <span className="mono t3">{compact(reason.n)}×</span>
                  </div>
                ))}
              </section>
            )}
            <div className={d.failing.length ? "rt-two" : "rt-one"}>
              {d.failing.length > 0 && (
                <section className="rt-list">
                  <h3 className="err">Failed</h3>
                  {d.failing.map((r) => <RequestRow key={r.id} r={r} />)}
                </section>
              )}
              <section className="rt-list">
                <h3>Slowest</h3>
                {d.slowest.map((r) => <RequestRow key={r.id} r={r} />)}
              </section>
            </div>
            <Lanes from={scope.from} to={scope.to} height={52} lanes={[
              { id: "volume", label: "Requests", data: d.series },
              { id: "time", label: "Response time", kind: "line", data: d.series.filter((point) => point.ok + point.warn + point.error > 0), format: fms },
            ]} />
          </div>
        );
      }}
    </Load>
  );
}
