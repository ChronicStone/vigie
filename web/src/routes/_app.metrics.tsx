import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { SERIES } from "@web/components/charts.tsx";
import { Icon } from "@web/components/icons.tsx";
import { Empty, Pop, SearchBox, Segments, Skeleton } from "@web/components/ui.tsx";
import { YChart, type YRow } from "@web/components/ychart.tsx";
import { metricAttributesFn, metricListFn, metricSeriesFn } from "@web/fns/explore.ts";
import { useScoped } from "@web/lib/api.ts";
import { bytes, compact, fms } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({
  metric: z.string().optional().catch(undefined),
  agg: z.string().optional().catch(undefined),
  group: z.string().optional().catch(undefined),
  off: z.array(z.string()).optional().catch(undefined),
});
export const Route = createFileRoute("/_app/metrics")({ validateSearch: search, component: MetricsPage });

const AGGS = {
  Gauge: [["latest", "Latest"], ["avg", "Average"], ["min", "Lowest"], ["max", "Highest"]],
  Histogram: [["p95", "p95"], ["p50", "Median"], ["p99", "p99"], ["avg", "Average"]],
  Sum: [["sum", "Total"], ["avg", "Average"]],
} as const;

const AREA: Record<string, string> = { db: "Database", http: "HTTP", process: "Process", nodejs: "Node.js", v8: "Memory", vigie: "Tasks" };
const SPLIT: Record<string, string> = { "service.name": "Service", "service.instance.id": "Instance" };
const splitLabel = (key: string) => SPLIT[key] ?? key;

/** The names people use. What the instrumentation library wrote stays in the tooltip. */
const PLAIN: Record<string, string> = {
  "db.client.connection.count": "Database connections",
  "db.client.connection.pending_requests": "Waiting for a database connection",
  "db.client.operation.duration": "Database call duration",
  "vigie.tasks.backlog": "Tasks by state",
  "vigie.tasks.oldest_due_age": "Oldest task still waiting",
  "http.client.duration": "Outgoing HTTP call duration",
  "http.client.request.duration": "Outgoing HTTP call duration",
  "http.server.duration": "Request duration",
  "http.server.request.duration": "Request duration",
  "nodejs.eventloop.delay.max": "Event loop delay, highest",
  "nodejs.eventloop.delay.mean": "Event loop delay, average",
  "nodejs.eventloop.delay.min": "Event loop delay, lowest",
  "nodejs.eventloop.delay.p50": "Event loop delay, median",
  "nodejs.eventloop.delay.p90": "Event loop delay, p90",
  "nodejs.eventloop.delay.p99": "Event loop delay, p99",
  "nodejs.eventloop.delay.stddev": "Event loop delay, spread",
  "nodejs.eventloop.utilization": "Event loop busy",
  "process.cpu.utilization": "CPU in use",
  "process.cpu.time": "CPU time",
  "process.memory.usage": "Memory in use",
  "v8.heap.used": "Heap used",
  "v8js.memory.heap.used": "Heap used",
  "v8js.memory.heap.limit": "Heap limit",
};
const plainName = (m: { name: string; description: string }) => PLAIN[m.name] ?? (m.description && m.description.length <= 44 ? m.description.replace(/\.$/, "") : m.name);

type Metric = { name: string; unit: string; description: string; type: "Gauge" | "Sum" | "Histogram" };

function format(unit: string) {
  if (unit === "s") return (v: number) => fms(v * 1000);
  if (unit === "ms") return (v: number) => fms(v);
  if (unit === "By") return (v: number) => bytes(v);
  if (unit === "MB") return (v: number) => `${compact(v)} MB`;
  if (unit === "%") return (v: number) => `${v >= 10 ? Math.round(v) : Number(v.toFixed(1))}%`;
  if (unit === "1") return (v: number) => `${Number((v * 100).toFixed(1))}%`;
  return (v: number) => (Math.abs(v) >= 1000 ? compact(v) : String(Number(v.toFixed(v >= 10 ? 0 : 2))));
}

function MetricList({ metrics, current, onPick, id }: { metrics: Metric[]; current: string; onPick: (name: string) => void; id?: string }) {
  const [text, setText] = useState("");
  const groups = useMemo(() => {
    const needle = text.toLowerCase();
    const out = new Map<string, Metric[]>();
    for (const m of metrics.filter((x) => x.name.toLowerCase().includes(needle) || plainName(x).toLowerCase().includes(needle) || x.description.toLowerCase().includes(needle))) {
      const area = m.name.split(".")[0] ?? "";
      if (!out.has(area)) out.set(area, []);
      out.get(area)!.push(m);
    }
    return [...out];
  }, [metrics, text]);
  return (
    <>
      <SearchBox id={id} value={text} onChange={setText} placeholder="Find a metric" style={{ width: "100%", flex: "none" }} />
      <div className="metrics-scroll">
        {groups.map(([area, items]) => (
          <div key={area}>
            <div className="metrics-area">{AREA[area] ?? area}</div>
            {items.map((m) => (
              <button key={m.name} className={`metrics-item ${m.name === current ? "on" : ""}`} onClick={() => onPick(m.name)} title={m.description || m.name}>
                <span className="ell metrics-plain">{plainName(m)}</span>
                {plainName(m) !== m.name && <span className="ell metrics-name">{m.name}</span>}
              </button>
            ))}
          </div>
        ))}
        {!groups.length && <div className="metrics-none"><span>Nothing called “{text}”.</span> <button className="tlink" onClick={() => setText("")}>Clear</button></div>}
      </div>
    </>
  );
}

function MetricsPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const patch = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const scope = useScope();
  const list = useScoped(metricListFn, {});
  const metrics = list.data ?? [];
  const metric = metrics.find((m) => m.name === s.metric) ?? metrics.find((m) => m.name === "http.server.request.duration") ?? metrics[0];
  const aggs = metric ? AGGS[metric.type] : AGGS.Gauge;
  const agg = aggs.some(([key]) => key === s.agg) ? s.agg! : aggs[0][0];
  const attrs = useScoped(metricAttributesFn, { name: metric?.name ?? "" }, { enabled: Boolean(metric) });
  const options = useMemo(() => ["service.name", ...(attrs.data ?? []).map((a) => a.key).filter((k) => k !== "service.instance.id" && k !== "service.name"), "service.instance.id"], [attrs.data]);
  const groupBy = s.group ?? (attrs.data?.some((a) => a.key === "state") ? "state" : "service.name");
  const series = useScoped(metricSeriesFn, { name: metric?.name ?? "", type: metric?.type ?? "Gauge", agg, groupBy }, { enabled: Boolean(metric) });
  const off = useMemo(() => new Set(s.off ?? []), [s.off]);
  const { rows, ranked, keys } = useMemo(() => {
    const byTime = new Map<number, YRow>();
    const names = new Set<string>();
    for (const point of series.data ?? []) {
      const name = point.series || "value";
      names.add(name);
      const row = byTime.get(point.t) ?? ({ t: point.t } as YRow);
      row[name] = point.v;
      byTime.set(point.t, row);
    }
    const sorted = [...byTime.values()].sort((a, b) => a.t - b.t);
    const summed = [...names].map((name) => {
      const values = sorted.map((row) => row[name]).filter((v): v is number => typeof v === "number");
      const average = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
      return { name, values, average, now: values[values.length - 1] ?? 0, peak: values.length ? Math.max(...values) : 0, low: values.length ? Math.min(...values) : 0 };
    }).sort((a, b) => b.average - a.average);
    const colored = summed.map((entry, index) => ({ ...entry, color: SERIES[index % SERIES.length]! }));
    return { rows: sorted, ranked: colored, keys: colored.filter((entry) => !off.has(entry.name)).map((entry) => ({ key: entry.name, label: entry.name, color: entry.color })) };
  }, [series.data, off]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea")) {
        if (event.key === "Escape") target.blur();
        return;
      }
      if (event.metaKey || event.ctrlKey || !metric) return;
      if (event.key === "/") {
        event.preventDefault();
        document.getElementById("metricQ")?.focus();
      } else if (event.key === "j" || event.key === "k") {
        const next = metrics[metrics.findIndex((m) => m.name === metric.name) + (event.key === "j" ? 1 : -1)];
        if (next) patch({ metric: next.name, group: undefined, agg: undefined, off: undefined });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (list.isPending) return <Skeleton />;
  if (!metric) return <Empty title="No metrics yet" hint="Metrics appear here once a service sends them to /v1/metrics." />;
  const fmt = format(metric.unit);
  const pick = (name: string) => patch({ metric: name, group: undefined, agg: undefined, off: undefined });
  const toggle = (name: string) => {
    const next = new Set(off);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    patch({ off: next.size ? [...next] : undefined });
  };
  // Adding p95s or percentages up gives a number that means nothing, so a total only appears where a sum is true.
  const additive = metric.type !== "Histogram" && !["%", "s", "ms", "1"].includes(metric.unit);
  const single = ranked.length === 1 ? ranked[0] : undefined;
  const shown = ranked.filter((entry) => !off.has(entry.name));
  const totals = rows.map((row) => shown.reduce((sum, entry) => sum + (row[entry.name] ?? 0), 0));
  const figure = single ?? (additive && totals.length ? { now: totals[totals.length - 1]!, average: totals.reduce((a, b) => a + b, 0) / totals.length, peak: Math.max(...totals), low: Math.min(...totals) } : undefined);
  const whole = additive ? shown.reduce((sum, entry) => sum + entry.average, 0) : 0;
  return (
    <div className="metrics-page">
      <aside className="metrics-list" aria-label="Metrics">
        <MetricList metrics={metrics} current={metric.name} onPick={pick} id="metricQ" />
      </aside>
      <div className="metrics-main">
        <div className="metrics-head">
          <div className="metrics-title">
            <h2 title={metric.description || undefined}>{plainName(metric)}</h2>
            {plainName(metric) !== metric.name && <span className="metrics-name">{metric.name}</span>}
          </div>
          <span className="metrics-phonepick">
            <Pop width={300} trigger={<button className="fchip">Change metric<Icon name="chev" /></button>}>
              <div className="metrics-popbody"><MetricList metrics={metrics} current={metric.name} onPick={pick} /></div>
            </Pop>
          </span>
          <div className="metrics-controls">
            <Segments value={agg} env={false} onChange={(value) => patch({ agg: value === aggs[0][0] ? undefined : value })} options={aggs as unknown as [string, string][]} />
            <Pop width={240} align="end" trigger={<button className="fchip">Split by <span className="v">{splitLabel(groupBy)}</span><Icon name="chev" /></button>}>
              <h6>Split by</h6>
              <div className="scrollp">
                {options.map((option) => (
                  <button key={option} className="pitem" onClick={() => patch({ group: option, off: undefined })}>
                    <span className={`chk ${option === groupBy ? "on" : ""}`}><Icon name="check" /></span>
                    <span className={`ell ${SPLIT[option] ? "" : "m"}`}>{splitLabel(option)}</span>
                  </button>
                ))}
              </div>
            </Pop>
          </div>
        </div>
        {figure && rows.length > 0 && (
          <div className="metrics-figures">
            <span><b>{fmt(figure.now)}</b> now</span>
            <span><b>{fmt(figure.average)}</b> on average</span>
            <span><b>{fmt(figure.peak)}</b> at the highest</span>
          </div>
        )}
        <div className="metrics-chart">
          {rows.length > 0 ? (
            <YChart rows={rows} keys={keys} from={scope.from} to={scope.to} height={320} format={fmt} label={plainName(metric)} />
          ) : (
            <div className="metrics-empty">{series.isPending ? "" : "No data point in this time range. Widen the range at the top."}</div>
          )}
        </div>
        {ranked.length > 1 && (
          <div className="metrics-series">
            <div className="metrics-row metrics-rowhead">
              <span>{splitLabel(groupBy)}</span>
              <span className="metrics-rowspark" />
              <span className="r">Now</span>
              <span className="r">Average</span>
              <span className="r">Highest</span>
            </div>
            {ranked.map((entry) => (
              <button key={entry.name} className={`metrics-row ${off.has(entry.name) ? "off" : ""}`} aria-pressed={!off.has(entry.name)} title={off.has(entry.name) ? "Show on the chart" : "Hide from the chart"} onClick={() => toggle(entry.name)}>
                <span className="metrics-who"><i style={{ background: entry.color }} /><span className="ell m">{entry.name || "(none)"}</span></span>
                <span className="metrics-rowspark">{whole > 0 && !off.has(entry.name) ? <span className="share"><i style={{ scale: `${entry.average / whole} 1`, background: entry.color }} /></span> : null}</span>
                <span className="mono r">{fmt(entry.now)}</span>
                <span className="mono r t2">{fmt(entry.average)}</span>
                <span className="mono r t3">{fmt(entry.peak)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
