import { areaY, barY, defineChart, lineY, ruleY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { barRows } from "@web/lib/chart-rows.ts";
import { axisLabel, compact } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

/** Bars and lines settle into new values instead of jumping. Respects reduced motion on its own. */
const TWEEN = { duration: 260, easing: "ease-out" } as const;

export const SERIES = ["var(--a)", "#86AEE8", "#79C9A0", "var(--warn)", "#C9A2E8", "#6BB5AA", "#E98D80"];
const CHART = "var(--a)";
const WARN = "var(--warn)";
const ERR = "var(--err)";

type Point = Record<string, any> & { t: number };

const timeLabel = (t: number, seconds = false) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });

/** Flat bars with the errors on top. Used for every "volume over time" in the app. */
export const Bars = memo(function Bars({ data, height = 120, label = "Volume", series, unit, compactMode }: { data: Point[]; height?: number; label?: string; series?: { key: string; color: string; label: string }[]; unit?: string; compactMode?: boolean }) {
  const keys = series ?? [
    { key: "ok", color: CHART, label: "Ok" },
    { key: "warn", color: WARN, label: "4xx" },
    { key: "error", color: ERR, label: "Errors" },
  ];
  const definition = useMemo(() => {
    // Each bar is keyed by its label, so buckets under a minute need seconds or two bars would collide.
    const rows = barRows(data, keys, timeLabel);
    const domain = [...new Set(rows.map((r) => r.x))];
    const present = keys.filter((k) => rows.some((r) => r.series === k.label));
    return defineChart({
      svgAnimation: TWEEN,
      marks: [barY(rows, { x: "x", y: "value", color: "series" })],
      scales: { x: { scale: () => scaleBand<string>().padding(data.length > 120 ? 0.08 : 0.14), domain, axis: false }, y: { scale: scaleLinear, axis: false } },
      color: { domain: present.map((k) => k.label), range: present.map((k) => k.color) },
      margin: 0,
      // These charts hide their axes, so the tooltip gets no labels by itself and would say "x" and "y".
      ...(compactMode ? {} : {
        tooltip: {
          use: tooltip,
          items: [
            { id: "value", label: label, text: (point: { yValue: number }) => compact(point.yValue) },
            { id: "time", label: "Time", text: (point: { xValue: string }) => String(point.xValue) },
          ],
        },
      }),
    });
  }, [data, compactMode]);
  if (!data.length) return <div style={{ height }} />;
  return <Chart definition={definition} height={height} ariaLabel={label} className="vchart" />;
});

/** Lines for latency and gauges. Filled only when one series is shown. */
export const Lines = memo(function Lines({ data, keys, height = 120, label = "Trend", format, threshold, area, quiet, from, to }: { data: Point[]; keys: { key: string; label: string; color?: string }[]; height?: number; label?: string; format?: (v: number) => string; threshold?: number; area?: boolean; quiet?: boolean; from?: number; to?: number }) {
  // A line starts where its data starts. Stretching it to the whole window would put points under the wrong labels.
  const scope = useScope();
  const first = data[0]?.t ?? scope.from;
  const end = data[data.length - 1]?.t ?? scope.to;
  const windowFrom = from ?? Math.min(scope.from, Number(first));
  const windowTo = to ?? Math.max(scope.to, Number(end));
  const definition = useMemo(() => {
    const rows = data.flatMap((point) => keys.map((k) => ({ t: Number(point.t), series: k.label, value: Number(point[k.key]) || 0 })));
    const colors = keys.map((k, i) => k.color ?? SERIES[i % SERIES.length]!);
    const show = format ?? ((v: number) => compact(v));
    return defineChart({
      svgAnimation: TWEEN,
      marks: [
        ...(area && keys.length === 1 ? [areaY(rows, { x: "t", y: "value", fill: colors[0], fillOpacity: 0.05, id: "fill" } as any)] : []),
        lineY(rows, { x: "t", y: "value", color: "series", strokeWidth: 1.6 } as any),
        ...(threshold !== undefined ? [ruleY([threshold], { stroke: ERR, strokeDasharray: "3 3", id: "threshold" } as any)] : []),
      ],
      scales: {
        x: { scale: scaleLinear().domain([windowFrom, windowTo]), axis: false, label: "Time", format: (v: number) => timeLabel(v) } as any,
        y: { scale: scaleLinear, axis: false, grid: { stroke: "rgba(255,255,255,.05)" }, label: "Value", format: show, zero: true, ...(threshold !== undefined ? { domain: [0, Math.max(threshold * 1.1, ...rows.map((r) => r.value))] } : {}) } as any,
      },
      color: { domain: keys.map((k) => k.label), range: colors },
      margin: { top: 4, bottom: 2, left: 0, right: 0 },
      // These charts hide their axes, so the tooltip gets no labels by itself and would show a raw timestamp.
      ...(quiet ? {} : { tooltip: {
        use: tooltip,
        items: [
          { id: "value", label: keys.length === 1 ? keys[0]!.label : "Value", text: (point: { yValue: number }) => show(point.yValue) },
          { id: "time", label: "Time", text: (point: { xValue: number }) => timeLabel(point.xValue) },
        ],
      } }),
    } as any);
  }, [data, keys, format, threshold, area, quiet, windowFrom, windowTo]);
  if (!data.length) return <div style={{ height }} />;
  return <Chart definition={definition as any} height={height} ariaLabel={label} className="vchart" />;
});

/** A small trend inside a row or a number. No axes, no focus: it must never compete with the row. */
export const Spark = memo(function Spark({ values, color = "var(--a)", height = 22, width }: { values: number[]; color?: string; height?: number; width?: number }) {
  const definition = useMemo(() => {
    const rows = values.map((value, i) => ({ i, value }));
    return defineChart({
      svgAnimation: TWEEN,
      marks: [areaY(rows, { x: "i", y: "value", fill: color, fillOpacity: 0.12, id: "fill" } as any), lineY(rows, { x: "i", y: "value", stroke: color, strokeWidth: 1.5, id: "line" } as any)],
      scales: { x: { scale: scaleLinear, axis: false } as any, y: { scale: scaleLinear, axis: false } as any },
      margin: 0,
    } as any);
  }, [values, color]);
  if (values.length < 2) return <div style={{ height, width }} />;
  return <Chart definition={definition as any} height={height} width={width} ariaLabel="Trend" className="vspark" />;
});

/** Attempts in order, one tick each: tall and red for a failure. */
/** Shares of one whole. Rows arrive largest first from the widget's SQL. */
export function Pie({ items, height = 150, format }: { items: { label: string; value: number; color: string }[]; height?: number; format: (value: number) => string }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) return <div className="t3">Nothing in this window.</div>;
  const r = 15.9155;
  let offset = 25;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, minHeight: height }}>
      <svg viewBox="0 0 42 42" style={{ height, width: height, flex: "none" }} role="img" aria-label={items.map((item) => `${item.label} ${format(item.value)}`).join(", ")}>
        {items.map((item) => {
          const share = (item.value / total) * 100;
          const circle = <circle key={item.label} cx="21" cy="21" r={r} fill="none" stroke={item.color} strokeWidth="5" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={offset} />;
          offset -= share;
          return circle;
        })}
      </svg>
      <div style={{ display: "grid", gap: 6, minWidth: 0, flex: 1 }}>
        {items.map((item) => (
          <div key={item.label} className="row" style={{ fontSize: 12.5 }}>
            <i style={{ width: 8, height: 8, borderRadius: 2, background: item.color, flex: "none" }} />
            <span className="ell grow t2">{item.label}</span>
            <span className="mono">{format(item.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Strip({ items, count = 40 }: { items: ("ok" | "bad" | "skip" | "off")[]; count?: number }) {
  const padded = [...new Array(Math.max(0, count - items.length)).fill("off"), ...items.slice(-count)] as ("ok" | "bad" | "skip" | "off")[];
  return (
    <div className="strip" aria-hidden="true">
      {padded.map((item, i) => (
        <i key={i} className={`st-${item}`} />
      ))}
    </div>
  );
}

/** A trend inside a table row: one slot per moment of the window, drawn by CSS so a thousand rows cost nothing. */
export function Trend({ values, tone }: { values: number[]; tone?: "err" | "warn" }) {
  const max = Math.max(1, ...values);
  return (
    <div className={`tb ${tone ?? ""}`} aria-hidden="true">
      {values.map((value, i) => (
        <i key={i} style={{ scale: `1 ${value ? Math.max(0.12, value / max) : 0.03}` }} />
      ))}
    </div>
  );
}

/** The time scale for a column of lanes. */
export function TimeAxis({ from, to, ticks = 5 }: { from: number; to: number; ticks?: number }) {
  return (
    <div className="xax">
      {Array.from({ length: ticks }, (_, i) => (
        <span key={i} style={{ left: `${(i / (ticks - 1)) * 100}%`, transform: `translateX(${i === 0 ? 0 : i === ticks - 1 ? -100 : -50}%)` }}>{axisLabel(from + ((to - from) * i) / (ticks - 1), to - from)}</span>
      ))}
    </div>
  );
}

export function XAxis({ from, to, ticks = 5 }: { from: number; to: number; ticks?: number }) {
  return (
    <div className="xaxis">
      {Array.from({ length: ticks }, (_, i) => (
        <span key={i}>{axisLabel(from + ((to - from) * i) / (ticks - 1), to - from)}</span>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: [string, string][] }) {
  return (
    <span className="legend">
      {items.map(([label, color]) => (
        <span key={label}>
          <i style={{ background: color }} />
          {label}
        </span>
      ))}
    </span>
  );
}

/** Drag across any time chart to zoom every screen to that window. */
export function Brush({ from, to, onZoom, children, style, className }: { from: number; to: number; onZoom: (from: number, to: number) => void; children: React.ReactNode; style?: React.CSSProperties; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const start = useRef(0);
  const at = useCallback((event: React.PointerEvent) => {
    const rect = host.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }, []);
  return (
    <div
      ref={host}
      className={`hist ${className ?? ""}`}
      style={style}
      data-testid="brush"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = at(event);
        setSel([start.current, start.current]);
      }}
      onPointerMove={(event) => {
        if (sel) setSel([Math.min(start.current, at(event)), Math.max(start.current, at(event))]);
      }}
      onPointerUp={() => {
        if (sel && sel[1] - sel[0] > 0.01) onZoom(Math.round(from + (to - from) * sel[0]), Math.round(from + (to - from) * sel[1]));
        setSel(null);
      }}
    >
      {children}
      {sel && <div className="bsel" style={{ left: `${sel[0] * 100}%`, width: `${(sel[1] - sel[0]) * 100}%` }} />}
    </div>
  );
}


export const AVG_P95 = [{ key: "avg", label: "Average", color: "var(--t3)" }, { key: "p95", label: "p95", color: "var(--a)" }];
