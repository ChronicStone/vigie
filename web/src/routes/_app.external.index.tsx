import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";
import { change, share, useListKeys } from "@web/components/backend.tsx";
import { DataTable } from "@web/components/table.tsx";
import { Levels, Load } from "@web/components/ui.tsx";
import { externalFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, axisLabel, compact, dayMonth, fms, hm } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({ show: z.enum(["failing", "slow"]).optional().catch(undefined) });
export const Route = createFileRoute("/_app/external/")({ validateSearch: search, component: ExternalPage });

const SLOW_MS = 1500;
/** The last few slots of the window count as "now". */
const RECENT_SLOTS = 3;

type Timeline = { t: number; ok: number; failed: number }[];

function health(row: { failed: number; calls: number; p95: number; timeline: Timeline }) {
  const recent = row.timeline.slice(-RECENT_SLOTS).some((slot) => slot.failed > 0);
  if (row.failed && recent) return { word: "Failing now", tone: "err", rank: 0 };
  if (row.failed) return { word: "Failed earlier", tone: "warn", rank: 1 };
  if (row.p95 >= SLOW_MS) return { word: "Slow", tone: "warn", rank: 2 };
  return { word: "Healthy", tone: "t3", rank: 3 };
}

/** One slot per moment of the window: calls in grey, failures in red, so "since when" reads without a chart. */
function Timeline({ slots, from, to }: { slots: Timeline; from: number; to: number }) {
  const most = Math.max(1, ...slots.map((slot) => slot.ok + slot.failed));
  return (
    <span className="ext-line" role="img" aria-label={`Calls from ${axisLabel(from, to - from)} to ${axisLabel(to, to - from)}`}>
      {slots.map((slot) => {
        const total = slot.ok + slot.failed;
        const height = total ? Math.max(0.16, total / most) : 0;
        // Red takes only the failed share of the bar, so 2 failures in 300 calls never paints the moment red.
        const red = total ? Math.max(slot.failed ? 14 : 0, (slot.failed / total) * 100) : 0;
        const style = total ? { scale: `1 ${height}`, ...(slot.failed ? { background: `linear-gradient(to top, var(--err) ${red}%, var(--t4) ${red}%)` } : {}) } : undefined;
        return <i key={slot.t} className={total ? "" : "none"} title={total ? `${axisLabel(slot.t, to - from)}: ${total} calls${slot.failed ? `, ${slot.failed} failed` : ""}` : undefined} style={style} />;
      })}
    </span>
  );
}

function ExternalPage() {
  const scope = useScope();
  const navigate = useNavigate({ from: Route.fullPath });
  const { show } = Route.useSearch();
  const q = useScoped(externalFn, {});
  useListKeys();
  const rows = useMemo(() => [...(q.data?.rows ?? [])].map((row) => ({ ...row, health: health(row) })).sort((a, b) => a.health.rank - b.health.rank || b.failed - a.failed || b.calls - a.calls), [q.data]);
  return (
    <Load q={q}>
      {(d) => {
        const failing = rows.filter((r) => r.failed > 0);
        const slow = rows.filter((r) => r.p95 >= SLOW_MS);
        const shown = show === "failing" ? failing : show === "slow" ? slow : rows;
        return (
          <div className="ext-page">
            <div className="subbar ext-tools">
              <Levels value={show ?? "all"} onChange={(value) => void navigate({ search: { show: value === "all" ? undefined : value }, replace: true })} options={[
                ["all", `All ${rows.length}`],
                ...(failing.length || show === "failing" ? [["failing", `Failed ${failing.length}`] as const] : []),
                ...(slow.length || show === "slow" ? [["slow", `Slow ${slow.length}`] as const] : []),
              ]} />
              <span className="grow" />
              <span className="req-figs">
                <span><b>{compact(d.stats.calls)}</b> calls</span>
                <span className={d.stats.failed ? "err" : ""}><b>{share(d.stats.failed, d.stats.calls)}</b> failed</span>
              </span>
            </div>
            <DataTable tableId="providers" inCard rowHeight={64} rows={shown} rowKey={(r) => r.host} onRow={(r) => void navigate({ to: "/external/$host", params: { host: r.host } })} emptyTitle="No outgoing call in this window" emptyHint="Calls come from spans with server.address." columns={[
              { id: "name", header: "Provider", width: 220, cell: (r) => (
                <span className="ext-who">
                  <b>{r.name}</b>
                  <span className={r.health.tone}>{r.health.word}{r.failed > 0 && r.lastFailed ? `, ${ago(r.lastFailed)}` : ""}</span>
                </span>
              ) },
              { id: "line", header: <span className="ext-axis"><span>{dayMonth(scope.from)} {hm(scope.from)}</span><span>{dayMonth(scope.to)} {hm(scope.to)}</span></span>, cell: (r) => <Timeline slots={r.timeline} from={scope.from} to={scope.to} /> },
              { id: "failed", header: "Failed", num: true, width: 110, sort: (r) => r.failed / Math.max(r.calls, 1), cell: (r) => (
                <span className="ext-fig">
                  <b className={r.failed ? "err" : "t4"}>{r.failed ? share(r.failed, r.calls) : "0%"}</b>
                  {r.failed > 0 && <small className="t3">{r.failed} of {compact(r.calls)}</small>}
                </span>
              ) },
              { id: "p95", header: "p95", num: true, width: 110, sort: (r) => r.p95, cell: (r) => {
                const moved = r.previous ? change(r.p95, r.previous.p95) : "";
                return (
                  <span className="ext-fig">
                    <b className={r.p95 >= SLOW_MS ? "warn" : ""}>{fms(r.p95)}</b>
                    {moved && <small className="t3">{moved}</small>}
                  </span>
                );
              } },
              { id: "calls", header: "Calls", num: true, width: 90, sort: (r) => r.calls, className: "mono t2", cell: (r) => compact(r.calls) },
            ]} />
          </div>
        );
      }}
    </Load>
  );
}
