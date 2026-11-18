import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { compact, dayMonth, hm } from "@web/lib/format.ts";

/** j and k walk the rows of a list, Enter opens the focused one because rows are links, / goes to the page's search and Esc clears it. */
export function useRowKeys({ search, onClear }: { search?: string; onClear?: () => void } = {}) {
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = Boolean(target.closest("input,textarea,select,[contenteditable=true]"));
      if (event.key === "Escape" && typing && target.id === search) {
        onClearRef.current?.();
        target.blur();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/" && search) {
        event.preventDefault();
        document.getElementById(search)?.focus();
        return;
      }
      if (event.key !== "j" && event.key !== "k") return;
      const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")];
      if (!rows.length) return;
      event.preventDefault();
      const at = rows.indexOf(target.closest<HTMLElement>("[data-row]") as HTMLElement);
      const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (event.key === "j" ? 1 : -1)))];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search]);
}

const scrolled = new Map<string, number>();

/** Put first inside a scrolling list: Back lands where the list was. Back is a link here, so the router sees a new page and starts it at the top. */
export function KeepScroll({ id }: { id: string }) {
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const host = mark.current?.parentElement;
    if (!host) return;
    host.scrollTop = scrolled.get(id) ?? 0;
    const save = () => scrolled.set(id, host.scrollTop);
    host.addEventListener("scroll", save, { passive: true });
    return () => host.removeEventListener("scroll", save);
  }, [id]);
  return <span ref={mark} hidden />;
}

const tickLabel = (t: number, width: number) => (width > 3 * 86_400_000 ? dayMonth(t) : hm(t));
const moment = (t: number, width: number) => (width > 3 * 86_400_000 ? `${dayMonth(t)}, ${hm(t)}` : hm(t));

export type ChartIncident = { started: number; ended: number | null; peak?: number | null };

/**
 * One measure against its limit, on a real time axis, however few readings exist.
 * Readings further apart than the step break the line, a lone reading is a dot, and incidents are bands on the same clock.
 */
export function LimitChart({ points, from, to, limit, incidents = [], below, unit = "", height = 180, label, zoom }: {
  points: { t: number; v: number }[];
  from: number;
  to: number;
  limit?: number | null;
  incidents?: ChartIncident[];
  below?: boolean;
  unit?: string;
  height?: number;
  label: string;
  zoom?: boolean;
}) {
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const width = Math.max(1, to - from);
  const shown = points.map((p) => ({ t: Number(p.t), v: Number(p.v) || 0 })).filter((p) => p.t >= from && p.t <= to).sort((a, b) => a.t - b.t);
  const max = Math.max(limit ?? 0, ...shown.map((p) => p.v), 0);
  const top = max > 0 ? max * 1.18 : 1;
  const x = (t: number) => ((t - from) / width) * 100;
  const y = (v: number) => 100 - (v / top) * 100;
  // A step is what the readings normally are apart. A gap of more than three means nothing was there, not a slope.
  const gaps = shown.slice(1).map((p, i) => p.t - shown[i]!.t).sort((a, b) => a - b);
  const step = gaps[Math.floor(gaps.length / 2)] ?? width;
  const runs: { t: number; v: number }[][] = [];
  for (const point of shown) {
    const run = runs[runs.length - 1];
    if (run && point.t - run[run.length - 1]!.t <= step * 3) run.push(point);
    else runs.push([point]);
  }
  const line = (run: { t: number; v: number }[]) => run.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(3)} ${y(p.v).toFixed(3)}`).join(" ");
  const area = (run: { t: number; v: number }[]) => `${line(run)} L${x(run[run.length - 1]!.t).toFixed(3)} 100 L${x(run[0]!.t).toFixed(3)} 100 Z`;
  const over = (v: number) => limit !== null && limit !== undefined && (below ? v < limit : v > limit);
  const ratioAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    return rect ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
  };
  const nearest = cursor === null || !shown.length ? null : shown.reduce((best, p) => (Math.abs(p.t - cursor) < Math.abs(best.t - cursor) ? p : best), shown[0]!);
  const showNearest = nearest && Math.abs(nearest.t - (cursor ?? 0)) <= Math.max(step, width / 60) ? nearest : null;
  const format = (v: number) => `${v >= 100 ? compact(Math.round(v)) : Math.round(v * 100) / 100}${unit ? ` ${unit}` : ""}`;
  const incidentAt = cursor === null ? null : incidents.find((i) => cursor >= i.started && cursor <= (i.ended ?? to));
  const tipLeft = showNearest ? x(showNearest.t) : cursor !== null ? x(cursor) : 0;
  return (
    <div className="limit">
      <div
        ref={box}
        className={`limit-plot ${zoom ? "zoomable" : ""}`}
        style={{ height }}
        role="img"
        aria-label={label}
        onPointerMove={(event) => {
          const ratio = ratioAt(event.clientX);
          if (drag) setDrag({ ...drag, b: ratio });
          setCursor(from + ratio * width);
        }}
        onPointerLeave={() => setCursor(null)}
        onPointerDown={(event) => {
          if (!zoom) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const ratio = ratioAt(event.clientX);
          setDrag({ a: ratio, b: ratio });
        }}
        onPointerUp={() => {
          if (!drag) return;
          const low = Math.min(drag.a, drag.b);
          const high = Math.max(drag.a, drag.b);
          setDrag(null);
          if (high - low > 0.01) void navigate({ to: ".", search: ((prev: Record<string, unknown>) => ({ ...prev, from: Math.round(from + width * low), to: Math.round(from + width * high), range: undefined })) as never });
        }}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {incidents.map((incident) => {
            const left = Math.max(0, x(incident.started));
            const right = Math.min(100, x(incident.ended ?? to));
            if (right < 0 || left > 100) return null;
            return <rect key={incident.started} className={incident.ended ? "limit-band" : "limit-band open"} x={left} y={0} width={Math.max(right - left, 0.35)} height={100} />;
          })}
          {runs.filter((run) => run.length > 1).map((run) => <path key={`a${run[0]!.t}`} className="limit-area" d={area(run)} />)}
          {runs.filter((run) => run.length > 1).map((run) => <path key={`l${run[0]!.t}`} className="limit-line" d={line(run)} />)}
          {limit !== null && limit !== undefined && <line className="limit-rule" x1={0} x2={100} y1={y(limit)} y2={y(limit)} />}
        </svg>
        {runs.filter((run) => run.length === 1).map((run) => <i key={run[0]!.t} className={`limit-dot ${over(run[0]!.v) ? "over" : ""}`} style={{ left: `${x(run[0]!.t)}%`, top: `${y(run[0]!.v)}%` }} />)}
        {limit !== null && limit !== undefined && <span className="limit-tag" style={{ top: `${y(limit)}%` }}>{below ? "At least" : "Limit"} {format(limit)}</span>}
        {!shown.length && <span className="limit-none">No reading in this window</span>}
        {cursor !== null && !drag && (showNearest || incidentAt) && (
          <div className={`limit-tip ${tipLeft > 72 ? "flip" : ""}`} style={{ left: `${tipLeft}%` }}>
            {showNearest && <><b className={over(showNearest.v) ? "err" : ""}>{format(showNearest.v)}</b><span>{moment(showNearest.t, width)}</span></>}
            {incidentAt && <span className="err">Fired {moment(incidentAt.started, width)}{incidentAt.ended ? ` to ${moment(incidentAt.ended, width)}` : ", still firing"}</span>}
          </div>
        )}
        {cursor !== null && !drag && <i className="limit-cursor" style={{ left: `${showNearest ? x(showNearest.t) : x(cursor)}%` }} />}
        {drag && Math.abs(drag.b - drag.a) > 0 && <i className="limit-drag" style={{ left: `${Math.min(drag.a, drag.b) * 100}%`, width: `${Math.abs(drag.b - drag.a) * 100}%` }} />}
      </div>
      <div className="limit-axis" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => <span key={i}>{tickLabel(from + (width * i) / 4, width)}</span>)}
      </div>
    </div>
  );
}

/** A section of the page: a small heading, and what it holds. Nothing renders when there is nothing in it. */
export function Part({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rel-part ${className ?? ""}`}>
      <div className="rel-parth"><h3>{title}</h3>{right}</div>
      {children}
    </section>
  );
}
