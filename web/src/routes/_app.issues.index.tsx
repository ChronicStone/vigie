import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Trend } from "@web/components/charts.tsx";
import { Choice } from "@web/components/form.tsx";
import { KeepScroll, useRowKeys } from "@web/components/reliability.tsx";
import { Empty, Levels, Load, SearchBox } from "@web/components/ui.tsx";
import { issuesFn } from "@web/fns/reliability.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, compact, num, shortService } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({
  f: z.enum(["open", "new", "regressed", "resolved", "archived", "muted"]).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  sort: z.enum(["worst", "events", "people", "latest"]).optional().catch(undefined),
});
export const Route = createFileRoute("/_app/issues/")({ validateSearch: search, component: IssuesPage });

type Row = Awaited<ReturnType<typeof issuesFn>>["rows"][number];
type Sort = NonNullable<z.infer<typeof search>["sort"]>;

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const SORTS: Record<Sort, (a: Row, b: Row) => number> = {
  worst: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.inRange - a.inRange || b.last_seen - a.last_seen,
  events: (a, b) => b.inRange - a.inRange || b.events - a.events,
  people: (a, b) => b.people - a.people || b.inRange - a.inRange,
  latest: (a, b) => b.last_seen - a.last_seen,
};
const SORT_LABELS = [["worst", "Worst first"], ["events", "Most events"], ["people", "Most people"], ["latest", "Latest"]] as const;
const DAY = 86_400_000;
/** The list's filters travel with the row, so Back on the issue returns to the list as it was. */
const KEEP_LIST = ((prev: Record<string, unknown>) => prev) as never;

function IssueRow({ issue, services }: { issue: Row; services: number }) {
  return (
    <Link data-row className="issues-row" to="/issues/$fp" params={{ fp: issue.fingerprint }} search={KEEP_LIST}>
      <span className="issues-what">
        <span className="issues-name">
          <span className="mono ell">{issue.name}</span>
          {issue.priority === "high" && issue.status === "open" && <em>High</em>}
        </span>
        <span className="issues-msg">{issue.message}{services > 1 ? <span className="t4"> in {shortService(issue.service)}</span> : null}</span>
      </span>
      <span className="issues-trend"><Trend values={issue.trend} tone="err" /></span>
      <span className={`issues-num ${issue.inRange ? "" : "quiet"}`}>
        <b>{compact(issue.inRange)}<i className="issues-unit"> events</i></b>
        <small>{num(issue.events)} ever</small>
      </span>
      <span className={`issues-num ${issue.people ? "" : "quiet"}`}><b>{compact(issue.people)}<i className="issues-unit"> {issue.people === 1 ? "person" : "people"}</i></b></span>
      <span className="issues-last">{ago(issue.last_seen)}</span>
    </Link>
  );
}

function Group({ title, tone, rows, services }: { title: string; tone?: string; rows: Row[]; services: number }) {
  if (!rows.length) return null;
  return (
    <section className="issues-group">
      <h3 className={tone ?? ""}>{title}<span>{rows.length}</span></h3>
      {rows.map((issue) => <IssueRow key={issue.fingerprint} issue={issue} services={services} />)}
    </section>
  );
}

function IssuesPage() {
  const { f = "open", q: text = "", sort = "worst" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const scope = useScope();
  const q = useScoped(issuesFn, { filter: f, q: text || undefined });
  const set = (patch: z.infer<typeof search>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  useRowKeys({ search: "issQ", onClear: () => set({ q: undefined }) });
  const window = scope.custom ? "In this window" : `Last ${scope.range}`;
  return (
    <Load q={q}>
      {(d) => {
        const rows = [...d.rows].sort(SORTS[sort]);
        const services = new Set(rows.map((i) => i.service)).size;
        const isOpenList = f === "open" && sort === "worst";
        const isNew = (i: Row) => !i.regressed && i.first_seen >= Date.now() - DAY;
        const options = ([["open", "Open", d.counts.open], ["new", "New", d.counts.new], ["regressed", "Came back", d.counts.regressed], ["resolved", "Resolved", d.counts.resolved]] as const)
          .filter(([key, , count]) => key === f || key === "open" || count > 0)
          .map(([key, label, count]) => [key, <>{label} <b>{count}</b></>] as const);
        const hidden = ([["archived", "Archived", d.counts.archived], ["muted", "Muted", d.counts.muted]] as const).filter(([key, , count]) => key === f || count > 0);
        return (
          <>
            <div className="subbar issues-bar">
              <Levels value={(f === "archived" || f === "muted") ? ("" as never) : f} onChange={(value) => set({ f: value === "open" ? undefined : value })} options={options as never} />
              {hidden.length > 0 && <Choice label="Issues set aside" className={`fchip ${f === "archived" || f === "muted" ? "act" : ""}`} value={f === "archived" || f === "muted" ? f : ""} onChange={(value) => set({ f: (value || undefined) as never })} options={[["", "Set aside"], ...hidden.map(([key, label, count]) => [key, `${label} ${count}`] as const)]} />}
              <span className="grow" />
              <Choice label="Order" className="fchip" value={sort} onChange={(value) => set({ sort: value === "worst" ? undefined : value })} options={SORT_LABELS} />
              <SearchBox id="issQ" value={text} onChange={(value) => set({ q: value || undefined })} placeholder="Search issues" />
            </div>
            <div className="ov issues" data-testid="issues">
              <KeepScroll id={`issues:${f}:${text}:${sort}`} />
              {rows.length > 0 && (
                <div className="issues-head" aria-hidden="true">
                  <span>Issue</span>
                  <span>{window}</span>
                  <span className="r">Events</span>
                  <span className="r">People</span>
                  <span className="r">Last seen</span>
                </div>
              )}
              {isOpenList ? (
                <>
                  <Group title="Came back" tone="err" rows={rows.filter((i) => i.regressed)} services={services} />
                  <Group title="New today" tone="warn" rows={rows.filter(isNew)} services={services} />
                  <Group title="Still open" rows={rows.filter((i) => !i.regressed && !isNew(i))} services={services} />
                </>
              ) : (
                rows.map((issue) => <IssueRow key={issue.fingerprint} issue={issue} services={services} />)
              )}
              {!rows.length && (text
                ? <Empty title="No issue matches"><button className="btn" style={{ marginTop: 12 }} onClick={() => set({ q: undefined })}>Clear the search</button></Empty>
                : <Empty title={f === "open" ? "Nothing is broken" : "None here"} hint={f === "open" ? "Errors are grouped by cause as they arrive." : undefined}>{f !== "open" && <button className="btn" style={{ marginTop: 12 }} onClick={() => set({ f: undefined })}>Show open issues</button>}</Empty>)}
            </div>
          </>
        );
      }}
    </Load>
  );
}
