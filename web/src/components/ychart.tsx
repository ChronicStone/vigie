import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { axisLabel, compact } from "@web/lib/format.ts";
import { useSetScope } from "@web/lib/scope.ts";
import { Brush, SERIES } from "./charts.tsx";

export type YRow = Record<string, number> & { t: number };
export type YKey = { key: string; label: string; color?: string };

const GUTTER = 58;
const BOTTOM = 24;
const TOP = 8;

/** Steps people can read off the axis: 0, 5, 10, never 0, 3.7, 7.4. */
function niceScale(lowest: number, highest: number, wanted = 4) {
  // A flat line still gets a scale around it, so the number can be read.
  const flat = lowest === highest ? Math.abs(highest) * 0.2 || 1 : 0;
  const low = lowest === 0 ? 0 : lowest - flat;
  const high = highest + flat;
  const span = high - low;
  const rough = span / wanted;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((n) => n * power >= rough) ?? 10) * power;
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step || step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { min, max, ticks };
}

/**
 * Lines on a real y scale. Used where the number itself is the point: Metrics and the console.
 * The scale starts at zero unless the values sit so far from it that their movement would read as flat.
 */
export const YChart = memo(function YChart({ rows, keys, from, to, height = 300, format = compact, label = "Chart" }: { rows: YRow[]; keys: YKey[]; from: number; to: number; height?: number; format?: (value: number) => string; label?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const setScope = useSetScope();
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const place = () => setWidth(el.clientWidth);
    place();
    const watcher = new ResizeObserver(place);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);
  const plot = Math.max(10, width - GUTTER);
  const inner = height - TOP - BOTTOM;
  const scale = useMemo(() => {
    const values = rows.flatMap((row) => keys.map((k) => row[k.key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v)));
    const high = values.length ? Math.max(...values) : 1;
    const low = values.length ? Math.min(...values) : 0;
    const tight = low > 0 && low > high * 0.6;
    return niceScale(tight ? low : Math.min(0, low), high);
  }, [rows, keys]);
  const x = (t: number) => ((t - from) / Math.max(1, to - from)) * plot;
  const y = (v: number) => TOP + inner - ((v - scale.min) / Math.max(1e-9, scale.max - scale.min)) * inner;
  const gap = useMemo(() => {
    if (rows.length < 3) return Infinity;
    const steps = rows.slice(1).map((row, i) => row.t - rows[i]!.t).sort((a, b) => a - b);
    return steps[Math.floor(steps.length / 2)]! * 3.5;
  }, [rows]);
  const paths = useMemo(() => keys.map((k, index) => {
    let d = "";
    let last: number | null = null;
    for (const row of rows) {
      const v = row[k.key];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        last = null;
        continue;
      }
      d += `${last === null || row.t - last > gap ? "M" : "L"}${x(row.t).toFixed(1)} ${y(v).toFixed(1)}`;
      last = row.t;
    }
    return { key: k.key, color: k.color ?? SERIES[index % SERIES.length]!, d };
  }), [rows, keys, plot, scale, gap, from, to]);
  const xTicks = useMemo(() => {
    const count = width < 520 ? 3 : 6;
    return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
  }, [from, to, width]);
  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const t = from + ((event.clientX - rect.left) / rect.width) * (to - from);
    let best = 0;
    for (let i = 0; i < rows.length; i++) if (Math.abs(rows[i]!.t - t) < Math.abs(rows[best]!.t - t)) best = i;
    setHover(best);
  };
  const point = hover !== null ? rows[hover] : undefined;
  const px = point ? x(point.t) : 0;
  return (
    <div className="ychart" ref={host} style={{ height }} role="img" aria-label={label}>
      {width > 0 && (
        <>
          <div className="ychart-y" aria-hidden="true">
            {scale.ticks.map((tick) => <span key={tick} style={{ top: y(tick) }}>{format(tick)}</span>)}
          </div>
          <div className="ychart-plot" style={{ left: GUTTER, height: height - BOTTOM }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            <Brush from={from} to={to} onZoom={(start, end) => setScope({ from: start, to: end, range: undefined })} className="ychart-brush">
              <svg width={plot} height={height - BOTTOM} aria-hidden="true">
                {scale.ticks.map((tick) => <line key={tick} className="ychart-grid" x1={0} x2={plot} y1={y(tick)} y2={y(tick)} />)}
                {keys.length === 1 && paths[0]?.d && rows.length > 1 && <path className="ychart-area" d={`${paths[0].d}L${x(rows[rows.length - 1]!.t).toFixed(1)} ${y(Math.max(scale.min, 0))}L${x(rows[0]!.t).toFixed(1)} ${y(Math.max(scale.min, 0))}Z`} fill={paths[0].color} />}
                {paths.map((path) => <path key={path.key} className="ychart-line" d={path.d} stroke={path.color} />)}
                {point && <line className="ychart-cursor" x1={px} x2={px} y1={TOP} y2={TOP + inner} />}
                {point && paths.map((path, i) => {
                  const v = point[keys[i]!.key];
                  return typeof v === "number" ? <circle key={path.key} className="ychart-dot" cx={px} cy={y(v)} r={3} fill={path.color} /> : null;
                })}
              </svg>
            </Brush>
            {point && (
              <div className={`ychart-tip ${px > plot / 2 ? "flip" : ""}`} style={{ left: px, top: TOP }}>
                <b>{new Date(point.t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</b>
                {keys
                  .map((k, i) => ({ k, v: point[k.key], color: paths[i]!.color }))
                  .filter((row) => typeof row.v === "number")
                  .sort((a, b) => b.v! - a.v!)
                  .slice(0, 8)
                  .map((row) => (
                    <span key={row.k.key}><i style={{ background: row.color }} /><em>{row.k.label}</em><strong>{format(row.v!)}</strong></span>
                  ))}
              </div>
            )}
          </div>
          <div className="ychart-x" style={{ left: GUTTER }} aria-hidden="true">
            {xTicks.map((t, i) => <span key={i} style={{ left: `${(i / (xTicks.length - 1)) * 100}%`, translate: i === 0 ? "0 0" : i === xTicks.length - 1 ? "-100% 0" : "-50% 0" }}>{axisLabel(t, to - from)}</span>)}
          </div>
        </>
      )}
    </div>
  );
});
