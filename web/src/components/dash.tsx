import { areaY, defineChart, lineY, rect, ruleX, ruleY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { Link, useNavigate } from "@tanstack/react-router";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { axisLabel, compact } from "@web/lib/format.ts";
import { useClockStore } from "./lanes.tsx";

/** The pieces of a dashboard: panels, figures, rankings and time charts that keep one clock between them. */

export type DashRow = { t: number } & Record<string, any>;
export type DashKey = { key: string; label: string; color: string };
export type DashMark = { t: number; label: string };

const TWEEN = { duration: 260, easing: "ease-out" } as const;
const GRID = { stroke: "var(--line)", strokeOpacity: 1 };
const TOP = 6;
const BOTTOM = 20;
const RIGHT = 16;

/** Steps people can read off an axis: 0, 250, 500, never 0, 333, 667. */
function niceTicks(high: number, wanted = 4) {
  const top = high > 0 ? high : 1;
  const rough = top / wanted;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((n) => n * power >= rough) ?? 10) * power;
  const max = Math.ceil(top / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { max, ticks };
}

const HOUR = 3_600_000;
const STEPS = [60_000, 300_000, 900_000, 1_800_000, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR, 168 * HOUR];
/** Clock labels on round times, in local time: 10:00, 12:00, never 09:37. */
function clockTicks(from: number, to: number, most: number) {
  const step = STEPS.find((s) => (to - from) / s <= most) ?? STEPS[STEPS.length - 1]!;
  const offset = new Date(from).getTimezoneOffset() * 60_000;
  const first = Math.ceil((from - offset) / step) * step + offset;
  const ticks: number[] = [];
  for (let t = first; t <= to; t += step) ticks.push(t);
  return ticks;
}

const gutter = (labels: string[]) => Math.ceil(Math.max(...labels.map((label) => label.length)) * 6) + 10;

/** The filled height of a chart's slot, so a chart takes whatever room its row gives it and a panel is never half empty. */
function useBoxHeight(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => setHeight(Math.max(fallback, element.clientHeight));
    place();
    const watcher = new ResizeObserver(place);
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [fallback]);
  return [ref, height] as const;
}

const nearest = (rows: DashRow[], t: number) => {
  let best: DashRow | undefined;
  let gap = Infinity;
  for (const row of rows) {
    const distance = Math.abs(row.t - t);
    if (distance < gap) {
      gap = distance;
      best = row;
    }
  }
  return best;
};

/** The line every chart shows for the moment under the pointer, and the reading on the chart it is over. Only this re-renders as the pointer moves. */
function Cursor({ self, left, width, from, to, rows, keys, format, top }: { self: object; left: number; width: number; from: number; to: number; rows: DashRow[]; keys: DashKey[]; format: (value: number) => string; top: number }) {
  const store = useClockStore();
  const at = useSyncExternalStore(store.subscribe, store.get);
  const last = useRef(at);
  if (at) last.current = at;
  const spot = last.current;
  if (!spot || spot.t < from || spot.t > to) return null;
  const plot = width - left - RIGHT;
  const x = left + ((spot.t - from) / (to - from)) * plot;
  const point = nearest(rows, spot.t);
  const live = Boolean(at);
  return (
    <>
      <i className={`dc-cur ${live ? "on" : ""}`} style={{ left: x, top, bottom: BOTTOM }} />
      {spot.owner === self && point && (
        <div className={`dc-tip ${live ? "on" : ""} ${x > width / 2 ? "flip" : ""}`} style={{ left: x, top: top + 4 }}>
          <b>{axisLabel(point.t, Math.min(to - from, 86_400_000))}</b>
          {keys.filter((key) => point[key.key] !== undefined).map((key) => (
            <span key={key.key}><i style={{ background: key.color }} /><em>{key.label}</em><strong>{format(Number(point[key.key]))}</strong></span>
          ))}
        </div>
      )}
    </>
  );
}

/** Hover to read any moment on every chart at once. Drag across one to zoom the whole page to that window. */
function TimeChart({ rows, keys, from, to, height, left, format, label, children }: { rows: DashRow[]; keys: DashKey[]; from: number; to: number; height: number; left: number; format: (value: number) => string; label: string; children: (height: number) => ReactNode }) {
  const [box, filled] = useBoxHeight(height);
  const store = useClockStore();
  const self = useRef({}).current;
  const navigate = useNavigate();
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const place = () => setWidth(element.clientWidth);
    place();
    const watcher = new ResizeObserver(place);
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [box]);
  const plot = Math.max(1, width - left - RIGHT);
  const ratioAt = (clientX: number) => (clientX - box.current!.getBoundingClientRect().left - left) / plot;
  return (
    <div
      className="dc"
      ref={box}
      style={{ minHeight: height }}
      role="img"
      aria-label={label}
      onPointerMove={(event) => {
        const ratio = ratioAt(event.clientX);
        if (drag) setDrag({ ...drag, end: Math.max(0, Math.min(1, ratio)) });
        store.set(ratio < 0 || ratio > 1 ? null : { t: from + ratio * (to - from), owner: self });
      }}
      onPointerLeave={() => {
        if (store.get()?.owner === self) store.set(null);
      }}
      onPointerDown={(event) => {
        const ratio = ratioAt(event.clientX);
        if (ratio < 0 || ratio > 1) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ start: ratio, end: ratio });
      }}
      onPointerUp={() => {
        if (!drag) return;
        const low = Math.min(drag.start, drag.end);
        const high = Math.max(drag.start, drag.end);
        setDrag(null);
        if (high - low > 0.01) void navigate({ to: ".", search: ((prev: Record<string, unknown>) => ({ ...prev, from: Math.round(from + (to - from) * low), to: Math.round(from + (to - from) * high), range: undefined })) as never });
      }}
    >
      <div className="dc-in">{width > 0 && children(filled)}</div>
      {width > 0 && <Cursor self={self} left={left} width={width} from={from} to={to} rows={rows} keys={keys} format={format} top={TOP} />}
      {drag && Math.abs(drag.end - drag.start) > 0 && <i className="dc-sel" style={{ left: left + Math.min(drag.start, drag.end) * plot, width: Math.abs(drag.end - drag.start) * plot, top: TOP, bottom: BOTTOM }} />}
    </div>
  );
}

const xAxis = (from: number, to: number, width: number) => ({
  scale: scaleLinear().domain([from, to]),
  axis: { line: false, ticks: { values: clockTicks(from, to, width < 340 ? 3 : width < 620 ? 5 : 8), size: 0, format: (t: number) => axisLabel(t, to - from) } },
});
const yAxis = (max: number, ticks: number[], format: (value: number) => string) => ({
  scale: scaleLinear().domain([0, max]),
  grid: GRID,
  axis: { line: false, ticks: { values: ticks, size: 0, format } },
});
const deployRules = (marks: DashMark[] | undefined, from: number, to: number) => {
  const inside = (marks ?? []).filter((mark) => mark.t > from && mark.t < to);
  return inside.length ? [ruleX(inside, { x: "t", stroke: "var(--a)", strokeOpacity: 0.32, strokeDasharray: "2 3", id: "deploys" } as any)] : [];
};

/** Stacked bars placed on real time, so they line up with every line chart on the page. */
export const DashBars = memo(function DashBars({ rows, keys, from, to, height = 150, format = compact, marks, label = "Volume" }: { rows: DashRow[]; keys: DashKey[]; from: number; to: number; height?: number; format?: (value: number) => string; marks?: DashMark[]; label?: string }) {
  const { max, ticks } = useMemo(() => niceTicks(Math.max(0, ...rows.map((row) => keys.reduce((sum, key) => sum + (Number(row[key.key]) || 0), 0)))), [rows, keys]);
  const left = gutter(ticks.map(format));
  const pieces = useMemo(() => {
    const step = rows.length > 1 ? rows[1]!.t - rows[0]!.t : (to - from) / 60;
    return rows.flatMap((row) => {
      let base = 0;
      return keys.flatMap((key) => {
        const value = Number(row[key.key]) || 0;
        if (value <= 0) return [];
        const piece = { x1: row.t, x2: row.t + step, y1: base, y2: base + value, series: key.label };
        base += value;
        return [piece];
      });
    });
  }, [rows, keys, from, to]);
  const color = useMemo(() => ({ domain: keys.map((key) => key.label), range: keys.map((key) => key.color) }), [keys]);
  return (
    <TimeChart rows={rows} keys={keys} from={from} to={to} height={height} left={left} format={format} label={label}>
      {(filled) => (
        <Chart
          definition={defineChart(({ width }: { width: number }) => ({
            svgAnimation: TWEEN,
            marks: [rect(pieces, { x1: "x1", x2: "x2", y1: "y1", y2: "y2", color: "series", inset: 0.6, id: "bars" } as any), ...deployRules(marks, from, to)],
            scales: { x: xAxis(from, to, width), y: yAxis(max, ticks, format) },
            color,
            margin: { top: TOP, right: RIGHT, bottom: BOTTOM, left },
            focus: false,
          })) as any}
          height={filled}
          ariaLabel={label}
          className="dc-chart"
        />
      )}
    </TimeChart>
  );
});

export const DashLines = memo(function DashLines({ rows, keys, from, to, height = 150, format = compact, floor = 0, threshold, area, marks, label = "Trend" }: { rows: DashRow[]; keys: DashKey[]; from: number; to: number; height?: number; format?: (value: number) => string; floor?: number; threshold?: number; area?: boolean; marks?: DashMark[]; label?: string }) {
  const { max, ticks } = useMemo(() => niceTicks(Math.max(floor, threshold ?? 0, ...rows.flatMap((row) => keys.map((key) => Number(row[key.key]) || 0)))), [rows, keys, floor, threshold]);
  const left = gutter(ticks.map(format));
  const points = useMemo(() => rows.flatMap((row) => keys.flatMap((key) => (row[key.key] === undefined || row[key.key] === null ? [] : [{ t: row.t, value: Number(row[key.key]), series: key.label }]))), [rows, keys]);
  const color = useMemo(() => ({ domain: keys.map((key) => key.label), range: keys.map((key) => key.color) }), [keys]);
  return (
    <TimeChart rows={rows} keys={keys} from={from} to={to} height={height} left={left} format={format} label={label}>
      {(filled) => (
        <Chart
          definition={defineChart(({ width }: { width: number }) => ({
            svgAnimation: TWEEN,
            marks: [
              ...(area ? [areaY(points, { x: "t", y: "value", fill: keys[0]!.color, fillOpacity: 0.08, id: "area" } as any)] : []),
              lineY(points, { x: "t", y: "value", color: "series", strokeWidth: 1.6, id: "lines" } as any),
              ...(threshold ? [ruleY([threshold], { stroke: "var(--err)", strokeOpacity: 0.55, strokeDasharray: "3 3", id: "limit" } as any)] : []),
              ...deployRules(marks, from, to),
            ],
            scales: { x: xAxis(from, to, width), y: yAxis(max, ticks, format) },
            color,
            margin: { top: TOP, right: RIGHT, bottom: BOTTOM, left },
            focus: false,
          })) as any}
          height={filled}
          ariaLabel={label}
          className="dc-chart"
        />
      )}
    </TimeChart>
  );
});

const HEAT_LEVELS = [0.14, 0.28, 0.44, 0.62, 0.8, 1];
const HEAT_ROWS = 22;
const HEAT_LABELS: [number, string][] = [[0, "1 ms"], [5, "10 ms"], [10, "100 ms"], [15, "1 s"], [20, "10 s"]];

/** Every request by how long it took: a band that lifts or splits shows what a percentile hides. */
export const DashHeat = memo(function DashHeat({ cells, step, from, to, height = 190, marks }: { cells: { t: number; y: number; n: number }[]; step: number; from: number; to: number; height?: number; marks?: DashMark[] }) {
  const layers = useMemo(() => {
    const top = Math.max(1, ...cells.map((cell) => cell.n));
    const groups = HEAT_LEVELS.map(() => [] as { x1: number; x2: number; y1: number; y2: number }[]);
    for (const cell of cells) {
      const level = Math.min(HEAT_LEVELS.length - 1, Math.floor((Math.log1p(cell.n) / Math.log1p(top)) * HEAT_LEVELS.length));
      groups[level]!.push({ x1: cell.t, x2: cell.t + step, y1: cell.y, y2: cell.y + 1 });
    }
    return groups;
  }, [cells, step]);
  const rows = useMemo(() => {
    const byTime = new Map<number, DashRow>();
    for (const cell of cells) {
      const row = byTime.get(cell.t) ?? { t: cell.t, n: 0 };
      row.n += cell.n;
      byTime.set(cell.t, row);
    }
    return [...byTime.values()];
  }, [cells]);
  const left = gutter(HEAT_LABELS.map(([, text]) => text));
  const names = new Map(HEAT_LABELS);
  return (
    <TimeChart rows={rows} keys={[{ key: "n", label: "Requests", color: "var(--a)" }]} from={from} to={to} height={height} left={left} format={compact} label="Requests by duration">
      {(filled) => (
        <Chart
          definition={defineChart(({ width }: { width: number }) => ({
            marks: [
              ...layers.map((cellsAtLevel, i) => rect(cellsAtLevel, { x1: "x1", x2: "x2", y1: "y1", y2: "y2", fill: "var(--a)", fillOpacity: HEAT_LEVELS[i], inset: 0.5, id: `level-${i}` } as any)),
              ...deployRules(marks, from, to),
            ],
            scales: {
              x: xAxis(from, to, width),
              y: { scale: scaleLinear().domain([0, HEAT_ROWS]), grid: GRID, axis: { line: false, ticks: { values: HEAT_LABELS.map(([y]) => y), size: 0, format: (y: number) => names.get(y) ?? "" } } },
            },
            margin: { top: TOP, right: RIGHT, bottom: BOTTOM, left },
            focus: false,
          })) as any}
          height={filled}
          ariaLabel="Requests by duration"
          className="dc-chart"
        />
      )}
    </TimeChart>
  );
});

/** One cell per moment. The red part is the share that failed, so one failure in a thousand calls doesn't read as an outage. */
export const HealthStrip = memo(function HealthStrip({ slots }: { slots: { t: number; ok: number; failed: number }[] }) {
  const top = Math.max(1, ...slots.map((slot) => slot.ok + slot.failed));
  return (
    <div className="dhs" aria-hidden="true">
      {slots.map((slot) => {
        const total = slot.ok + slot.failed;
        return (
          <i key={slot.t} className={total ? "" : "off"} style={total ? { opacity: slot.failed ? 1 : 0.3 + 0.6 * (Math.log1p(total) / Math.log1p(top)) } : undefined}>
            {slot.failed > 0 && <b style={{ height: `${Math.max(22, Math.min(100, (slot.failed / total) * 400))}%` }} />}
          </i>
        );
      })}
    </div>
  );
});

export function Panel({ span, title, sub, to, search, right, children, className = "" }: { span: number; title?: ReactNode; sub?: ReactNode; to?: string; search?: Record<string, unknown>; right?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={`dp s${span} ${className}`}>
      {(title || right) && (
        <header className="dp-h">
          <div className="dp-t">
            {to ? <Link to={to as never} search={search as never}>{title}</Link> : <span>{title}</span>}
            {sub && <small>{sub}</small>}
          </div>
          {right && <div className="dp-r">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ value, label, tone, small }: { value: ReactNode; label: string; tone?: string; small?: boolean }) {
  return (
    <div className={`ds ${small ? "ds-m" : ""} ${tone ?? ""}`}>
      <b><span className="numin" key={String(value)}>{value}</span></b>
      <span>{label}</span>
    </div>
  );
}

export function Legend({ keys }: { keys: { label: string; color: string }[] }) {
  return <div className="dl">{keys.map((key) => <span key={key.label}><i style={{ background: key.color }} />{key.label}</span>)}</div>;
}

export type Ranked = { id: string; name: ReactNode; value: ReactNode; size: number; tone?: string; to: string; search?: Record<string, unknown>; params?: Record<string, string> };

/** What leads on one measure, with a bar so the gap between rows reads at once. */
export function Rank({ rows, empty }: { rows: Ranked[]; empty: string }) {
  const top = Math.max(1e-9, ...rows.map((row) => row.size));
  if (!rows.length) return <p className="dr-none">{empty}</p>;
  return (
    <div className="dr">
      {rows.map((row) => (
        <Link key={row.id} className="dr-k" to={row.to as never} params={row.params as never} search={row.search as never}>
          <span className="dr-n ell">{row.name}</span>
          <span className={`dr-v ${row.tone ?? ""}`}>{row.value}</span>
          <i className={`dr-b ${row.tone ?? ""}`} style={{ transform: `scaleX(${Math.max(0.01, row.size / top)})` }} />
        </Link>
      ))}
    </div>
  );
}

/** True once an element is about to be seen. A row asks for its data only then, so opening the page costs its first screen. */
export function useNear<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: "700px 0px" });
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [near]);
  return [ref, near] as const;
}
