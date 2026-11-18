import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";
import type { RouteRow } from "@server/api/backend.ts";
import { change, NoMatch, share, timeSpent, useListKeys } from "@web/components/backend.tsx";
import { Icon } from "@web/components/icons.tsx";
import { DataTable, type Col } from "@web/components/table.tsx";
import { Hover, Levels, Load, Method2, RoutePath, SearchBox, Skeleton } from "@web/components/ui.tsx";
import { requestsFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { compact, fms, num } from "@web/lib/format.ts";

const search = z.object({
  tab: z.enum(["matched", "unmatched", "denied"]).optional().catch(undefined),
  find: z.string().optional().catch(undefined),
  show: z.enum(["failing", "slow", "repeated"]).optional().catch(undefined),
  sort: z.string().optional().catch(undefined),
});
export const Route = createFileRoute("/_app/requests/")({ validateSearch: search, component: RequestsPage });

const SLOW_MS = 1000;
const REPEATS = 3;
const isFailing = (r: RouteRow) => r.errors > 0;
const isSlow = (r: RouteRow) => r.p95 >= SLOW_MS;
const isRepeated = (r: RouteRow) => r.repeat > REPEATS;
const getsSlower = (r: RouteRow) => r.prevAvg > 0 && r.count >= 20 && r.avg >= r.prevAvg * 1.3;

/** Each route's problem in words, worst first. Every clause is one of the row's own numbers. */
function problems(r: RouteRow) {
  const out: { text: string; tone: "err" | "warn" }[] = [];
  if (isFailing(r)) out.push({ text: `${r.errors < 10 ? r.errors.toFixed(1) : Math.round(r.errors)}% failed`, tone: "err" });
  if (isSlow(r)) out.push({ text: "Slow", tone: "warn" });
  if (isRepeated(r)) out.push({ text: `Same query ${r.repeat}×`, tone: "warn" });
  if (getsSlower(r)) out.push({ text: `${change(r.avg, r.prevAvg)} slower`, tone: "warn" });
  if (r.warns >= 10) out.push({ text: `${Math.round(r.warns)}% refused`, tone: "warn" });
  return out;
}

function RequestsPage() {
  const s = Route.useSearch();
  const { tab = "matched", find = "", show } = s;
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useScoped(requestsFn, { tab });
  const set = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  useListKeys(tab === "matched" ? "req-find" : undefined, () => set({ find: undefined }));
  const data = q.data?.tab === "matched" ? q.data : null;
  const biggest = useMemo(() => Math.max(1, ...(data?.rows.map((r) => r.total) ?? [1])), [data]);
  const everything = useMemo(() => data?.rows.reduce((sum, r) => sum + r.total, 0) ?? 0, [data]);
  const columns = useMemo<Col<RouteRow>[]>(() => [
    { id: "route", header: "Route", className: "mono", cell: (r) => <Link to="/requests/route" search={{ method: r.method, route: r.route, find: find || undefined, show }} onClick={(e) => e.stopPropagation()} className="req-route"><Method2 m={r.method} /><span className="req-path"><RoutePath path={r.route} /></span><span className="req-hurts-in">{problems(r).map((p) => <span key={p.text} className={p.tone}>{p.text}</span>)}</span></Link> },
    { id: "hurts", header: "What hurts", width: 250, cell: (r) => {
      const found = problems(r);
      if (!found.length) return "";
      return <span className="req-hurts">{found.map((p) => <span key={p.text} className={p.tone}>{p.text}</span>)}</span>;
    } },
    { id: "count", header: "Requests", num: true, width: 90, sort: (r) => r.count, className: "mono t2", cell: (r) => compact(r.count) },
    { id: "p95", header: "p95", num: true, width: 90, sort: (r) => r.p95, className: (r) => `mono ${isSlow(r) ? "warn" : "t2"}`, cell: (r) => fms(r.p95) },
    { id: "total", header: "Time spent", num: true, width: 230, sort: (r) => r.total, className: "mono", cell: (r) => <span className="req-spent"><span className="req-bar"><i className={isFailing(r) ? "err" : isSlow(r) ? "warn" : ""} style={{ scale: `${r.total / biggest} 1` }} /></span><span className="req-time">{timeSpent(r.total)}</span></span> },
  ], [biggest, find, show]);
  const open = (r: { method: string; route: string }) => void navigate({ to: "/requests/route", search: { method: r.method, route: r.route, find: find || undefined, show } });
  const [sortId, sortDir] = (s.sort ?? "total:desc").split(":");
  return (
    <Load q={q} skeleton={<Skeleton />}>
      {(d) => {
        if (d.tab === "unmatched") {
          return (
            <>
              <Sub title="Paths no route matched" />
              <DataTable rows={d.rows} rowKey={(r) => r.method + r.path} emptyTitle="Every path matched a route" onRow={(r) => void navigate({ to: "/logs", search: { q: `path=${r.path}` } as never })} columns={[
                { id: "path", header: "Path", className: "mono", cell: (r) => <><Method2 m={r.method} />{r.path}</> },
                { id: "like", header: "", width: 90, className: "t3", cell: (r) => (/\.(php|env)|wp-/.test(r.path) ? "Scanner" : "") },
                { id: "count", header: "Requests", num: true, width: 110, className: "mono", sort: (r) => r.count, cell: (r) => num(r.count) },
              ]} initialSort={{ id: "count", desc: true }} />
            </>
          );
        }
        if (d.tab === "denied") {
          return (
            <>
              <Sub title="Requests we refused" />
              <DataTable rows={d.rows} rowKey={(r) => r.method + r.route + r.reason} emptyTitle="Nothing was denied" onRow={(r) => r.route && open(r)} columns={[
                { id: "route", header: "Route", className: "mono", cell: (r) => <><Method2 m={r.method} /><RoutePath path={r.route} /></> },
                { id: "reason", header: "Reason", className: "warn", cell: (r) => r.reason },
                { id: "count", header: "Requests", num: true, width: 110, className: "mono", sort: (r) => r.count, cell: (r) => num(r.count) },
              ]} initialSort={{ id: "count", desc: true }} />
            </>
          );
        }
        const lower = find.toLowerCase();
        const counts = { failing: d.rows.filter(isFailing).length, slow: d.rows.filter(isSlow).length, repeated: d.rows.filter(isRepeated).length };
        const test = show === "failing" ? isFailing : show === "slow" ? isSlow : show === "repeated" ? isRepeated : () => true;
        const rows = d.rows.filter((r) => test(r) && `${r.method} ${r.route}`.toLowerCase().includes(lower));
        const ranked = [...d.rows].sort((a, b) => b.total - a.total);
        const shown = ranked.filter((r) => r.total / Math.max(everything, 1) >= 0.025).slice(0, 9);
        const rest = ranked.slice(shown.length);
        const restTotal = rest.reduce((sum, r) => sum + r.total, 0);
        return (
          <>
            {everything > 0 && (
              <section className="req-map" aria-label="Where server time goes">
                <div className="req-maph">
                  <h3>Where server time goes</h3>
                  <span className="req-figs">
                    <span><b>{timeSpent(everything)}</b> in {compact(d.summary.requests)} requests</span>
                    <span className={d.summary.serverErrors ? "err" : ""}><b>{share(d.summary.serverErrors, d.summary.requests)}</b> server errors</span>
                    <span><b>{fms(d.summary.p95)}</b> p95</span>
                  </span>
                </div>
                <div className="req-strip">
                  {shown.map((r) => {
                    const tone = isFailing(r) ? "err" : isSlow(r) ? "warn" : "";
                    const name = r.route.split("/").filter((part) => part && part !== "v1" && part !== "api").slice(-2).join("/") || r.route;
                    return (
                      <Hover key={`${r.method} ${r.route}`} text={`${r.method} ${r.route}, ${share(r.total, everything)} of server time`} className={`req-seg ${tone}`} style={{ flexGrow: r.total, flexBasis: 0 }}>
                        <Link to="/requests/route" search={{ method: r.method, route: r.route }}>
                          <span className="req-segn">{name}</span>
                          <span className="req-segv">{share(r.total, everything)}</span>
                        </Link>
                      </Hover>
                    );
                  })}
                  {restTotal > 0 && (
                    <span className="req-seg req-other" style={{ flexGrow: restTotal, flexBasis: 0 }}>
                      <span className="req-segn">{rest.length} others</span>
                      <span className="req-segv">{share(restTotal, everything)}</span>
                    </span>
                  )}
                </div>
              </section>
            )}
            <div className="subbar req-bar-row">
              <SearchBox id="req-find" value={find} onChange={(value) => set({ find: value || undefined })} placeholder="Find a route" />
              <Levels value={show ?? "all"} onChange={(value) => set({ show: value === "all" ? undefined : value })} options={[
                ["all", `All ${d.rows.length}`],
                ...(counts.failing || show === "failing" ? [["failing", `Failing ${counts.failing}`] as const] : []),
                ...(counts.slow || show === "slow" ? [["slow", `Slow ${counts.slow}`] as const] : []),
                ...(counts.repeated || show === "repeated" ? [["repeated", `Repeated queries ${counts.repeated}`] as const] : []),
              ]} />
              <span className="grow" />
              {d.counts.unmatched > 0 && <Link className="req-quiet" to="/requests" search={{ tab: "unmatched" }}>{compact(d.counts.unmatched)} unmatched</Link>}
              {d.counts.denied > 0 && <Link className="req-quiet" to="/requests" search={{ tab: "denied" }}>{compact(d.counts.denied)} denied</Link>}
            </div>
            {rows.length === 0 && d.rows.length > 0
              ? <NoMatch what="route" onClear={() => set({ find: undefined, show: undefined })} />
              : <DataTable tableId="routes" rows={rows} columns={columns} rowKey={(r) => `${r.method} ${r.route}`} initialSort={{ id: sortId ?? "total", desc: sortDir !== "asc" }} onSort={(sort) => set({ sort: sort && !(sort.id === "total" && sort.desc) ? `${sort.id}:${sort.desc ? "desc" : "asc"}` : undefined })} onRow={open} emptyTitle="No request in this window" emptyHint="Routes appear once the app sends request events." />}
          </>
        );
      }}
    </Load>
  );
}

function Sub({ title }: { title: string }) {
  return (
    <div className="dh">
      <Link className="ib" to="/requests" search={{}} title="Back to routes" aria-label="Back to routes"><Icon name="back" /></Link>
      <h2>{title}</h2>
    </div>
  );
}
