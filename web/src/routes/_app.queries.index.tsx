import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";
import type { QueryPattern } from "@server/api/backend.ts";
import { NoMatch, share, timeSpent, useListKeys } from "@web/components/backend.tsx";
import { Hl } from "@web/components/code.tsx";
import { DataTable, type Col } from "@web/components/table.tsx";
import { Entry, Levels, Load, SearchBox, Segments } from "@web/components/ui.tsx";
import { queriesFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { compact, fms } from "@web/lib/format.ts";

const search = z.object({
  tab: z.enum(["patterns", "entry"]).optional().catch(undefined),
  find: z.string().optional().catch(undefined),
  show: z.enum(["repeated", "slow", "failing"]).optional().catch(undefined),
  sort: z.string().optional().catch(undefined),
});
export const Route = createFileRoute("/_app/queries/")({ validateSearch: search, component: QueriesPage });

const SLOW_MS = 100;
const REPEATS = 3;

type Suspect = { entry: string; times: number; n: number };

function QueriesPage() {
  const s = Route.useSearch();
  const { tab = "patterns", find = "", show } = s;
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useScoped(queriesFn, { tab });
  const set = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  useListKeys("qry-find", () => set({ find: undefined }));
  const d = q.data;
  /** Each pattern's worst repeat. Counting a statement run twice as a suspect would call everything N+1. */
  const suspects = useMemo(() => {
    const map = new Map<string, Suspect>();
    for (const row of d?.repeated ?? []) {
      if (!row.hash || row.times <= REPEATS) continue;
      const seen = map.get(row.hash);
      if (!seen || row.times * row.n > seen.times * seen.n) map.set(row.hash, row);
    }
    return map;
  }, [d]);
  const result = d?.result;
  const biggest = useMemo(() => (result?.tab === "patterns" ? Math.max(1, ...result.rows.map((r) => r.total)) : 1), [result]);
  const everything = d?.stats.total ?? 0;
  const columns = useMemo<Col<QueryPattern>[]>(() => [
    { id: "query", header: "Statement", className: "qry-cell", cell: (r) => {
      const sus = suspects.get(r.hash);
      return (
        <span className="qry-stmt">
          <span className="mono ell qry-sql"><Hl lang="sql">{r.statement.trim()}</Hl></span>
          {sus && <span className="qry-sus warn">Runs {sus.times}× per request in <span className="mono"><Entry text={sus.entry} /></span></span>}
          {!sus && r.errors > 0 && <span className="qry-sus err">{r.errors} failed</span>}
        </span>
      );
    } },
    { id: "calls", header: "Runs", num: true, width: 72, sort: (r) => r.calls, className: "mono t2", cell: (r) => compact(r.calls) },
    { id: "avg", header: "Average", num: true, width: 80, sort: (r) => r.avg, className: "mono t2", cell: (r) => fms(r.avg) },
    { id: "p95", header: "p95", num: true, width: 80, sort: (r) => r.p95, className: (r) => `mono ${r.p95 >= SLOW_MS ? "warn" : "t2"}`, cell: (r) => fms(r.p95) },
    { id: "total", header: "Time spent", num: true, width: 210, sort: (r) => r.total, className: "mono", cell: (r) => <span className="req-spent"><span className="req-bar"><i className={suspects.has(r.hash) ? "warn" : ""} style={{ scale: `${r.total / biggest} 1` }} /></span><span className="req-time">{timeSpent(r.total)}</span></span> },
  ], [biggest, suspects]);
  const [sortId, sortDir] = (s.sort ?? "total:desc").split(":");
  return (
    <Load q={q}>
      {(data) => {
        const lower = find.toLowerCase();
        const toolbar = (levels?: React.ReactNode) => (
          <div className="subbar qry-tools">
            <Segments env={false} value={tab} onChange={(value) => set({ tab: value === "patterns" ? undefined : value, show: undefined })} options={[["patterns", "Statements"], ["entry", "By entry point"]]} />
            <SearchBox id="qry-find" value={find} onChange={(value) => set({ find: value || undefined })} placeholder={tab === "entry" ? "Find an endpoint or task" : "Find a statement"} />
            {levels}
            <span className="grow" />
            <span className="req-figs">
              <span><b>{timeSpent(everything)}</b> in {compact(data.stats.calls)} queries</span>
              {data.stats.errors > 0 && <span className="err"><b>{compact(data.stats.errors)}</b> failed</span>}
            </span>
          </div>
        );
        if (data.result.tab === "entry") {
          const rows = data.result.rows.filter((row) => row.entry.toLowerCase().includes(lower));
          const scored = data.result.rows.map((row) => row.perCall * row.n);
          const top = Math.max(1, ...scored);
          return (
            <div className="ov">
              {toolbar()}
              {rows.length === 0 && data.result.rows.length > 0 && <NoMatch what="entry point" onClear={() => set({ find: undefined })} />}
              {rows.length > 0 && (
                <div className="qry-entries">
                  <div className="qry-eh"><span>Entry point</span><span>Queries each</span><span>Database time each</span><span>Runs</span><span>Time spent</span></div>
                  {rows.map((row) => {
                    const total = row.perCall * row.n;
                    const body = (
                      <>
                        <span className="mono ell qry-en"><Entry text={row.entry} /></span>
                        <span className={`mono ${row.queries >= 20 ? "warn" : "t2"}`}>{Math.round(row.queries)}</span>
                        <span className="mono t2">{fms(row.perCall)}</span>
                        <span className="mono t3">{compact(row.n)}</span>
                        <span className="req-spent mono"><span className="req-bar"><i style={{ scale: `${total / top} 1` }} /></span><span className="req-time">{timeSpent(total)}</span></span>
                      </>
                    );
                    const method = row.entry.match(/^(GET|POST|PATCH|PUT|DELETE)\s+(.*)$/);
                    const task = row.entry.match(/^task\s+(.*)$/);
                    if (method) return <Link key={row.entry} className="lst qry-er" to="/requests/route" search={{ method: method[1]!, route: method[2]! }}>{body}</Link>;
                    if (task) return <Link key={row.entry} className="lst qry-er" to="/tasks/kind/$kind" params={{ kind: task[1]! }}>{body}</Link>;
                    return <div key={row.entry} className="lst qry-er">{body}</div>;
                  })}
                </div>
              )}
              {!data.result.rows.length && <div className="cb t3 qry-none">No request or task ran a query in this window.</div>}
            </div>
          );
        }
        if (data.result.tab !== "patterns") return null;
        const all = data.result.rows;
        const counts = { repeated: all.filter((r) => suspects.has(r.hash)).length, slow: all.filter((r) => r.p95 >= SLOW_MS).length, failing: all.filter((r) => r.errors > 0).length };
        const rows = all.filter((r) => (show === "repeated" ? suspects.has(r.hash) : show === "slow" ? r.p95 >= SLOW_MS : show === "failing" ? r.errors > 0 : true) && r.statement.toLowerCase().includes(lower));
        // What to fix first: the costliest suspect, or else the costliest statement if it really dominates.
        const ranked = [...all].sort((a, b) => b.total - a.total);
        const top = ranked[0];
        const suspect = ranked.find((r) => suspects.has(r.hash));
        const pick = suspect && top && suspect.total >= top.total * 0.6 ? suspect : top;
        const first = pick && pick.total / Math.max(everything, 1) >= 0.05 ? pick : undefined;
        const firstSus = first && suspects.get(first.hash);
        return (
          <div className="qry-page">
            {first && !find && !show && (
              <Link className="qry-first" to="/queries/$hash" params={{ hash: first.hash }} search={{ find: undefined, show: undefined }}>
                <span className="qry-fl">
                  <span className="qry-fh">Fix first</span>
                  <span className="qry-ff"><b>{share(first.total, everything)}</b> of database time</span>
                  {firstSus && <span className="qry-ff"><b className="warn">{firstSus.times}×</b> per request</span>}
                  <span className="qry-ff"><b>{compact(first.calls)}</b> runs at <b>{fms(first.avg)}</b></span>
                </span>
                <span className="mono qry-fsql"><Hl lang="sql">{first.statement.trim()}</Hl></span>
                {firstSus && <span className="qry-fw mono"><Entry text={firstSus.entry} /></span>}
              </Link>
            )}
            {toolbar(
              <Levels value={show ?? "all"} onChange={(value) => set({ show: value === "all" ? undefined : value })} options={[
                ["all", `All ${all.length}`],
                ...(counts.repeated || show === "repeated" ? [["repeated", `N+1 suspects ${counts.repeated}`] as const] : []),
                ...(counts.slow || show === "slow" ? [["slow", `Slow ${counts.slow}`] as const] : []),
                ...(counts.failing || show === "failing" ? [["failing", `Failing ${counts.failing}`] as const] : []),
              ]} />,
            )}
            {rows.length === 0 && all.length > 0
              ? <NoMatch what="statement" onClear={() => set({ find: undefined, show: undefined })} />
              : <DataTable tableId="queries" rowHeight={50} rows={rows} columns={columns} rowKey={(r) => r.hash} initialSort={{ id: sortId ?? "total", desc: sortDir !== "asc" }} onSort={(sort) => set({ sort: sort && !(sort.id === "total" && sort.desc) ? `${sort.id}:${sort.desc ? "desc" : "asc"}` : undefined })} onRow={(r) => void navigate({ to: "/queries/$hash", params: { hash: r.hash }, search: { find: find || undefined, show } })} emptyTitle="No query ran in this window" emptyHint="Queries come from spans with db.query.text." />}
          </div>
        );
      }}
    </Load>
  );
}
