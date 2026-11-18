import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Widget } from "@sdk";
import { runConsoleFn } from "@web/fns/explore.ts";
import { errorText } from "@web/lib/api.ts";
import { compact, fms } from "@web/lib/format.ts";
import { useScope, useSetScope } from "@web/lib/scope.ts";
import { Bars, Brush, Legend, Lines, Pie, SERIES, Spark, XAxis } from "./charts.tsx";
import { Hl } from "./code.tsx";

const SQL_START = /^\s*(select|insert|update|delete|with)\b/i;

export const showValue = (value: number, widget: Pick<Widget, "format">) => (widget.format === "ms" ? fms(value) : widget.format === "percent" ? `${value.toFixed(1)}%` : compact(value));

const headerLabel = (column: string) => column.charAt(0).toUpperCase() + column.slice(1).replace(/_/g, " ");

/** The same query, cached the same way, for the widget, the dashboard list and the editor. */
export function useWidgetData(sql: string, enabled = true) {
  const scope = useScope();
  return useQuery({ queryKey: ["widget", sql, scope.params], queryFn: () => runConsoleFn({ data: { ...scope.params, sql } }), enabled, placeholderData: (prev) => prev, staleTime: 15_000, refetchInterval: scope.live ? 5000 : false });
}

const BAR_COLOR: Record<string, [string, string]> = {
  ok: ["Ok", "color-mix(in srgb, var(--a) 72%, var(--s1))"],
  warn: ["4xx", "var(--warn)"],
  error: ["Failed", "var(--err)"],
};

function Head({ title, legend, header }: { title: string; legend?: [string, string][]; header?: React.ReactNode }) {
  return (
    <div className="ch home-wh">
      <span className="home-wt ell" title={title}>{title}</span>
      {legend && legend.length > 1 && <Legend items={legend} />}
      {header}
    </div>
  );
}

const Nothing = ({ height }: { height?: number }) => <div className="home-wnone" style={{ height }}>Nothing in this window.</div>;

/** Draws one widget from its SQL. Same on dashboards, on the widget editor, and for agents. */
export function WidgetBody({ widget, header }: { widget: Widget; header?: React.ReactNode }) {
  const scope = useScope();
  const set = useSetScope();
  const q = useWidgetData(widget.sql);
  const rows = useMemo(() => (q.data?.rows ?? []) as ({ t: number } & Record<string, number>)[], [q.data]);
  const columns = useMemo(() => q.data?.columns.map((c) => c.name) ?? [], [q.data]);
  const numeric = useMemo(() => new Set(columns.filter((c) => rows.length > 0 && rows.every((row) => (row[c] as unknown) !== "" && row[c] !== null && Number.isFinite(Number(row[c]))))), [columns, rows]);
  const seriesKeys = useMemo(() => columns.filter((name) => name !== "t").map((key, i) => ({ key, label: key, color: SERIES[i % SERIES.length]! })), [columns]);
  const barKeys = useMemo(() => seriesKeys.map((key) => (BAR_COLOR[key.key] ? { key: key.key, label: BAR_COLOR[key.key]![0], color: BAR_COLOR[key.key]![1] } : key)), [seriesKeys]);
  const height = widget.height ?? 130;
  const zoom = (from: number, to: number) => set({ from, to, range: undefined });
  if (q.error) return <><Head title={widget.title} header={header} /><div className="cb"><div className="stmt err">{errorText(q.error)}</div></div></>;
  switch (widget.type) {
    case "stat": {
      const value = Number(Object.values(rows[0] ?? {})[0] ?? 0);
      return (
        <div className="home-stat">
          <span className="home-stat-l ell" title={widget.title}>{widget.title}</span>
          <span className={`home-stat-v ${widget.tone === "error" && value ? "err" : widget.tone === "warn" && value ? "warn" : ""}`}>
            {q.data ? <span className="numin" key={String(value)}>{showValue(value, widget)}</span> : <span className="t4">–</span>}
            {widget.unit && <small>{widget.unit}</small>}
          </span>
          {header}
        </div>
      );
    }
    case "bars":
    case "series":
      return (
        <>
          <Head title={widget.title} legend={barKeys.map((k) => [k.label, k.color])} header={header} />
          <div className="cb home-wb">
            {q.data && !rows.length ? <Nothing height={height} /> : <Brush from={scope.from} to={scope.to} onZoom={zoom}><Bars data={rows} height={height} label={widget.title} series={barKeys} /></Brush>}
            <XAxis from={scope.from} to={scope.to} />
          </div>
        </>
      );
    case "lines":
      return (
        <>
          <Head title={widget.title} legend={seriesKeys.map((k) => [k.label, k.color])} header={header} />
          <div className="cb home-wb">
            {q.data && !rows.length ? <Nothing height={height} /> : <Brush from={scope.from} to={scope.to} onZoom={zoom}><Lines data={rows} keys={seriesKeys} height={height} label={widget.title} format={widget.format === "ms" ? fms : undefined} /></Brush>}
            <XAxis from={scope.from} to={scope.to} />
          </div>
        </>
      );
    case "pie": {
      const items = (rows as unknown as { label: string; value: number }[]).map((item, i) => ({ label: String(item.label), value: Number(item.value), color: SERIES[i % SERIES.length]! }));
      return (
        <>
          <Head title={widget.title} header={header} />
          <div className="cb home-wb">{q.data && !items.length ? <Nothing /> : <Pie items={items} height={height} format={(value) => showValue(value, widget)} />}</div>
        </>
      );
    }
    case "sparkline": {
      const key = columns.find((name) => name !== "t") ?? "value";
      const values = rows.map((row) => Number(row[key] ?? 0));
      return (
        <>
          <Head title={widget.title} header={header} />
          <div className="cb home-wb">
            <div className="home-stat-v">{showValue(values[values.length - 1] ?? 0, widget)}</div>
            <Spark values={values} height={Math.max(28, height - 70)} />
          </div>
        </>
      );
    }
    case "list": {
      const items = rows as unknown as { label: string; value: number }[];
      const max = Math.max(1, ...items.map((r) => Number(r.value)));
      const bad = widget.tone === "error" || /^failed/i.test(widget.title);
      return (
        <>
          <Head title={widget.title} header={header} />
          <div className="home-wlist">
            {items.map((item) => (
              <div className="home-wli" key={item.label} title={item.label}>
                <span className="mono ell">{item.label}</span>
                <span className="home-wbar" aria-hidden="true"><i className={bad ? "bad" : ""} style={{ scale: `${Math.max(Number(item.value) / max, 0.01)} 1` }} /></span>
                <span className="mono">{showValue(Number(item.value), widget)}</span>
              </div>
            ))}
            {q.data && !items.length && <Nothing />}
          </div>
        </>
      );
    }
    default:
      return (
        <>
          <Head title={widget.title} header={header} />
          <div className="tbl home-wtbl" style={{ overflow: "auto", maxHeight: height + 40 }}>
            {q.data && !q.data.rows.length ? <Nothing /> : (
              <table>
                <thead><tr>{columns.map((c) => <th key={c} style={numeric.has(c) ? { textAlign: "right" } : undefined}>{headerLabel(c)}</th>)}</tr></thead>
                <tbody>{rows.map((row, i) => <tr key={i}>{columns.map((c) => <td key={c} className="mono ell" style={numeric.has(c) ? { textAlign: "right", maxWidth: 380 } : { maxWidth: 380 }}>{numeric.has(c) ? Number(row[c]).toLocaleString("en-US", { maximumFractionDigits: 2 }) : <Hl lang={SQL_START.test(String(row[c] ?? "")) ? "sql" : "log"}>{String(row[c] ?? "")}</Hl>}</td>)}</tr>)}</tbody>
              </table>
            )}
          </div>
        </>
      );
  }
}
