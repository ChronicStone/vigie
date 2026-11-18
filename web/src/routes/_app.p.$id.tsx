import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { Block as BlockDef, View } from "@sdk";
import { Block } from "@web/components/blocks.tsx";
import { Bars, Lines, SERIES, XAxis } from "@web/components/charts.tsx";
import { Card, copy, Entry, Load, Stat } from "@web/components/ui.tsx";
import { runConsoleFn } from "@web/fns/explore.ts";
import { customPageFn, eventsBlockFn } from "@web/fns/tasks.ts";
import { useScoped } from "@web/lib/api.ts";
import { hm, num } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/p/$id")({ component: CustomPage });

function useSql(sql: string) {
  const scope = useScope();
  return useQuery({ queryKey: ["block", sql, scope.params], queryFn: () => runConsoleFn({ data: { ...scope.params, sql } }), staleTime: 15_000, placeholderData: (prev) => prev });
}

/** A few readings placed where they happened on the window, so one bucket never fills the whole chart. */
function spread(rows: ({ t: number } & Record<string, number>)[], keys: string[], from: number, to: number) {
  if (rows.length >= 24) return rows;
  const slots = 48;
  const step = (to - from) / slots;
  return Array.from({ length: slots }, (_, i) => {
    const t = from + i * step;
    return rows.find((row) => Number(row.t) >= t && Number(row.t) < t + step) ?? ({ t, ...Object.fromEntries(keys.map((key) => [key, 0])) } as { t: number } & Record<string, number>);
  });
}

/** A series named for trouble keeps trouble's colour, whatever position it has in the query. */
const colorOf = (key: string, index: number) => (/^(error|errors|failed|failures)$/i.test(key) ? "var(--err)" : /^(warn|warning|retry|retries)$/i.test(key) ? "var(--warn)" : /^(skip|skipped)$/i.test(key) ? "var(--t4)" : SERIES[index]!);

function SeriesBlock({ block }: { block: Extract<BlockDef, { b: "series" }> }) {
  const scope = useScope();
  const q = useSql(block.sql);
  const rows = (q.data?.rows ?? []) as ({ t: number } & Record<string, number>)[];
  const keys = (q.data?.columns ?? []).map((c) => c.name).filter((name) => name !== "t");
  if (q.data && !rows.some((row) => keys.some((key) => Number(row[key]) > 0))) return null;
  return (
    <Card title={block.title} right={block.note ? <span className="a">{block.note}</span> : undefined}>
      <div className="cb">
        {block.kind === "lines" ? <Lines data={rows} keys={keys.map((key, i) => ({ key, label: key, color: SERIES[i]! }))} height={block.height ?? 130} label={block.title} /> : <Bars data={spread(rows, keys, scope.from, scope.to)} series={keys.map((key, i) => ({ key, label: key, color: colorOf(key, i) }))} height={block.height ?? 130} label={block.title} />}
        <XAxis from={scope.from} to={scope.to} />
      </div>
    </Card>
  );
}

function TableBlock({ block }: { block: Extract<BlockDef, { b: "table" }> }) {
  const q = useSql(block.sql);
  // A column empty on every row says nothing.
  const columns = (q.data?.columns ?? []).filter((c) => (q.data?.rows ?? []).some((row) => row[c.name] !== "" && row[c.name] !== null && row[c.name] !== undefined));
  if (q.data && !q.data.rows.length) return null;
  return (
    <Card title={block.title}>
      <div className="tbl" style={{ overflow: "visible" }}>
        <table>
          <thead><tr>{columns.map((c) => <th key={c.name} className={/Int|Float/.test(c.type) ? "num" : ""}>{c.name}</th>)}</tr></thead>
          <tbody>{(q.data?.rows ?? []).map((row, i) => <tr key={i}>{columns.map((c) => <td key={c.name} className={/Int|Float/.test(c.type) ? "mono num" : ""} style={{ whiteSpace: "normal" }}>{String(row[c.name] ?? "")}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </Card>
  );
}

function StatBlock({ block }: { block: Extract<BlockDef, { b: "stat" }> }) {
  const q = useSql(block.sql);
  const value = Number(Object.values(q.data?.rows[0] ?? {})[0] ?? 0);
  return <Card><Stat label={block.title} value={num(value)} unit={block.unit} note={block.note} tone={block.tone === "error" ? "err" : block.tone === "warn" ? "warn" : undefined} /></Card>;
}

function EventsBlock({ block }: { block: Extract<BlockDef, { b: "events" }> }) {
  const q = useScoped(eventsBlockFn, { match: block.where, limit: block.limit ?? 12 });
  if (q.data && !q.data.length) return null;
  return (
    <Card title={block.title} right={<Link to="/logs">Open in logs</Link>}>
      {(q.data ?? []).map((event) => (
        <Link key={event.id} className="lst" to="/logs" search={{ event: event.id }}>
          <span className="mono t3" style={{ width: 42, flex: "none" }}>{hm(event.t)}</span>
          <span className="mono ell" style={{ width: 230, flex: "none" }}><Entry text={event.kind === "task" ? `task ${event.taskKind}` : `${event.method} ${event.route}`} /></span>
          <span className={`ell grow ${event.level === "error" ? "err" : "t3"}`}>{event.why || event.body}</span>
        </Link>
      ))}
    </Card>
  );
}

function PageBlock({ block }: { block: BlockDef }) {
  switch (block.b) {
    case "row":
      return <div className="ovg" style={{ gridTemplateColumns: `repeat(${block.children.length},minmax(0,1fr))` }}>{block.children.map((child, i) => <PageBlock key={i} block={child} />)}</div>;
    case "stat":
      return <StatBlock block={block} />;
    case "series":
      return <SeriesBlock block={block} />;
    case "table":
      return <TableBlock block={block} />;
    case "events":
      return <EventsBlock block={block} />;
    default:
      return null;
  }
}

function CustomPage() {
  const { id } = Route.useParams();
  const q = useScoped(customPageFn, { id });
  return (
    <Load q={q}>
      {(d) => {
        const state = JSON.parse(d.state) as View;
        const layout = JSON.parse(d.layout) as BlockDef[];
        return (
          <div className="ov">
            <div className="custompage-state">
              <p><Block view={state} /></p>
              {d.process && <Link className="btn" to="/processes/$id" params={{ id: d.process }}>Open process</Link>}
            </div>
            {d.funnels.map((funnel) => (
              <Card key={funnel.title} title={funnel.title}>
                <div className="custompage-funnel">
                  {funnel.steps.map((step) => (
                    <div className={`custompage-step ${step.bad && step.value ? "is-bad" : ""}`} key={step.label}>
                      <span>{step.label}</span>
                      <b>{num(step.value)}</b>
                      <em>{step.note}</em>
                    </div>
                  ))}
                </div>
              </Card>
            ))}
            {layout.map((block, i) => <div key={i}><PageBlock block={block} /></div>)}
            <div className="custompage-file">Defined in <button onClick={() => copy(d.file, "Path copied")}>{d.file}</button></div>
          </div>
        );
      }}
    </Load>
  );
}
