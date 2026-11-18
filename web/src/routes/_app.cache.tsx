import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";
import { useListKeys } from "@web/components/backend.tsx";
import { Brush, Lines } from "@web/components/charts.tsx";
import { Levels, Empty, Load } from "@web/components/ui.tsx";
import { cacheFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { compact, fms } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({ keys: z.enum(["hot", "slow"]).optional().catch(undefined) });
export const Route = createFileRoute("/_app/cache")({ validateSearch: search, component: CachePage });

const RATE = [{ key: "rate", label: "Hit rate", color: "var(--a)" }];
const P95 = [{ key: "p95", label: "p95", color: "var(--a)" }];
const LOW_HIT = 80;

function CachePage() {
  const scope = useScope();
  const navigate = useNavigate({ from: Route.fullPath });
  const { keys: order = "hot" } = Route.useSearch();
  const q = useScoped(cacheFn, {});
  useListKeys();
  const rates = useMemo(() => (q.data?.hitSeries ?? []).flatMap((point) => (point.hit + point.miss ? [{ t: point.t, rate: (point.hit / (point.hit + point.miss)) * 100 }] : [])), [q.data]);
  const zoom = (from: number, to: number) => void navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, from, to, range: undefined })) as never });
  return (
    <Load q={q}>
      {(d) => {
        if (!d.stats.calls) return <Empty title="No Redis calls in this window" hint="Calls appear here once the app traces Redis. Rate limiting and live updates are the usual sources." />;
        // A moment with no call has no latency: drawing it as zero would look like a sudden fast spell.
        const busy = d.series.filter((point) => point.ok + point.error > 0);
        const failed = d.stats.errors > 0;
        const known = d.hitRate !== null;
        const keys = [...d.keys].sort((a, b) => (order === "slow" ? b.p95 - a.p95 : b.calls - a.calls));
        const barOf = (key: (typeof keys)[number]) => (order === "slow" ? key.p95 : key.calls);
        const most = Math.max(1, ...keys.map(barOf));
        const commandMost = Math.max(1, ...d.commands.map((c) => c.calls));
        return (
          <div className="ov">
            <section className="cch-head">
              <div className="cch-big">
                {known ? (
                  <>
                    <span className="cch-l">Hit rate</span>
                    <b className={d.hitRate! < LOW_HIT ? "warn" : ""}>{d.hitRate!.toFixed(1)}%</b>
                    <span className="cch-n">{compact(d.hits.hit)} hits, {compact(d.hits.miss)} misses</span>
                  </>
                ) : (
                  <>
                    <span className="cch-l">Hit rate</span>
                    <b className="t3">Not reported</b>
                    <span className="cch-n">Set <span className="mono">cache.hit</span> on Redis spans to see it</span>
                  </>
                )}
              </div>
              <div className="cch-chart">
                <Brush from={scope.from} to={scope.to} onZoom={zoom}>
                  {known && rates.length > 1
                    ? <Lines data={rates} keys={RATE} height={76} label="Hit rate over time" format={(v) => `${v.toFixed(0)}%`} area from={scope.from} to={scope.to} />
                    : <Lines data={busy} keys={P95} height={76} label="Response time, p95" format={fms} area from={scope.from} to={scope.to} />}
                </Brush>
                <span className="cch-cap">{known && rates.length > 1 ? "Hit rate over time" : "Response time, p95"}</span>
              </div>
              <div className="cch-side">
                <span><b>{compact(d.stats.calls)}</b> calls</span>
                <span><b className={d.stats.p95 >= 50 ? "warn" : ""}>{fms(d.stats.p95)}</b> p95</span>
                <span className={failed ? "err" : ""}><b>{failed ? compact(d.stats.errors) : "None"}</b> failed</span>
              </div>
            </section>
            <div className="cch-two">
              <section className="rt-list">
                <div className="cch-kh">
                  <h3>Keys</h3>
                  <Levels value={order} onChange={(value) => void navigate({ search: (prev) => ({ ...prev, keys: value === "hot" ? undefined : value }), replace: true })} options={[["hot", "Hottest"], ["slow", "Slowest"]]} />
                </div>
                {keys.map((key) => {
                  const seen = key.hit + key.miss;
                  return (
                    <div className="prov-oprow" key={key.key}>
                      <span className="mono grow ell">{key.key}</span>
                      {seen > 0 && <span className={`mono cch-hit ${(key.hit / seen) * 100 < LOW_HIT ? "warn" : "t3"}`}>{Math.round((key.hit / seen) * 100)}% hit</span>}
                      {key.errors > 0 && <span className="err mono prov-tf">{key.errors} failed</span>}
                      <span className="share prov-bar"><i style={{ scale: `${barOf(key) / most} 1` }} /></span>
                      <span className="mono t2 cch-calls">{compact(key.calls)}</span>
                      <span className={`mono rt-dur ${key.p95 >= 50 ? "warn" : "t2"}`} title="p95">{fms(key.p95)}</span>
                    </div>
                  );
                })}
                {!keys.length && <div className="cb t3">No key recorded. Key names come from the redis.command attribute.</div>}
              </section>
              <section className="rt-list">
                <h3>Commands</h3>
                {d.commands.map((c) => (
                  <div className="prov-oprow" key={c.command}>
                    <span className="mono grow ell">{c.command}</span>
                    {c.errors > 0 && <span className="err mono prov-tf">{c.errors} failed</span>}
                    <span className="share prov-bar cch-cmdbar"><i style={{ scale: `${c.calls / commandMost} 1` }} /></span>
                    <span className="mono t2 cch-calls">{compact(c.calls)}</span>
                  </div>
                ))}
              </section>
            </div>
          </div>
        );
      }}
    </Load>
  );
}
