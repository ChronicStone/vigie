import { useEffect, useMemo, useRef, useState } from "react";
import { fms } from "@web/lib/format.ts";
import { Entry, RoutePath } from "./ui.tsx";
import { Icon } from "./icons.tsx";

export type WfKind = "app" | "db" | "ext" | "cache" | "log" | "task" | "wait";
export type WfRow = { id: string; parent: string | null; kind: WfKind; label: string; start: number; duration?: number; error?: boolean; badge?: string; badgeTone?: "e" | "w" | "n"; detail?: string; level?: string };

const COLOR: Record<WfKind, string> = { app: "var(--app)", db: "var(--db)", ext: "var(--ext)", cache: "var(--cache)", log: "var(--t3)", task: "var(--task)", wait: "var(--t4)" };

/** Round steps people can read: 0, 300 ms, 600 ms, not 0, 301 ms, 602 ms. */
function roundTicks(total: number) {
  const rough = total / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((n) => n * power >= rough) ?? 10) * power;
  const out: { left: number; label: string }[] = [];
  const label = (at: number) => (at >= 1000 ? `${Number((at / 1000).toFixed(2))} s` : `${Number(at.toFixed(1))} ms`);
  for (let at = 0; at <= total; at += step) out.push({ left: (at / total) * 100, label: label(at) });
  return out;
}

/** The one waterfall: request, trace and task run all draw with it. */
export function Waterfall({ rows, total, selected, onSelect, header = "Span", marks, filter, keyboard }: { rows: WfRow[]; total: number; selected?: string | null; onSelect?: (id: string) => void; header?: string; marks?: { at: number; level: string }[]; filter?: (row: WfRow) => boolean; keyboard?: boolean }) {
  const [shut, setShut] = useState<Set<string>>(new Set());
  const host = useRef<HTMLDivElement>(null);
  const { order, hasKids } = useMemo(() => {
    const kids = new Map<string | null, WfRow[]>();
    const ids = new Set(rows.map((r) => r.id));
    for (const row of rows) {
      const parent = row.parent && ids.has(row.parent) ? row.parent : null;
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent)!.push(row);
    }
    const out: { row: WfRow; depth: number }[] = [];
    const walk = (row: WfRow, depth: number) => {
      const children = kids.get(row.id) ?? [];
      const visible = !filter || filter(row) || children.some((c) => filter(c));
      if (!visible) return;
      out.push({ row, depth });
      if (!shut.has(row.id)) for (const child of children.sort((a, b) => a.start - b.start)) walk(child, depth + 1);
    };
    for (const root of (kids.get(null) ?? []).sort((a, b) => a.start - b.start)) walk(root, 0);
    return { order: out, hasKids: new Set([...kids.keys()].filter(Boolean) as string[]) };
  }, [rows, shut, filter]);
  const toggle = (id: string) =>
    setShut((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const axis = useMemo(() => roundTicks(total), [total]);
  useEffect(() => {
    if (!selected || !keyboard) return;
    host.current?.querySelector(".wr.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected, keyboard]);
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input,textarea") || event.metaKey || event.ctrlKey) return;
      if (event.key !== "j" && event.key !== "k") return;
      const at = order.findIndex(({ row }) => row.id === selected);
      const next = order[Math.max(0, at + (event.key === "j" ? 1 : -1))];
      if (next) onSelect?.(next.row.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard, order, selected, onSelect]);
  return (
    <div className="wf" ref={host}>
      <div className="wfh">
        <span style={{ paddingLeft: 12, fontFamily: "var(--sans)", fontSize: 11 }}>{header}</span>
        <span className="ax">
          {axis.map((tick) => (
            <span key={tick.left} style={{ left: `${tick.left}%` }}>{tick.label}</span>
          ))}
        </span>
      </div>
      {marks && marks.length > 0 && (
        <div className="wr marks" style={{ cursor: "default" }}>
          <span className="wn t3" style={{ paddingLeft: 32, fontSize: 12 }}>{marks.length} log {marks.length === 1 ? "line" : "lines"}</span>
          <span className="wt">
            {marks.map((mark, i) => (
              <span key={i} className={`mk ${mark.level}`} style={{ left: `${(mark.at / total) * 100}%` }} />
            ))}
          </span>
        </div>
      )}
      {order.map(({ row, depth }) => {
        const left = (row.start / total) * 100;
        const width = row.duration !== undefined ? Math.max((row.duration / total) * 100, 0.35) : 0;
        const hue = row.error ? "var(--err)" : COLOR[row.kind];
        const isLog = row.kind === "log";
        const logColor = row.level === "error" ? "var(--err)" : row.level === "warn" ? "var(--warn)" : "var(--t3)";
        return (
          <button key={row.id} className={`wr ${selected === row.id ? "sel" : ""}`} onClick={() => onSelect?.(row.id)}>
            <span className={`wn ${isLog ? "log" : ""}`} style={{ paddingLeft: 10 + depth * 14 }}>
              <span
                className={`chev ${shut.has(row.id) ? "shut" : ""}`}
                onClick={(event) => {
                  if (!hasKids.has(row.id)) return;
                  event.stopPropagation();
                  toggle(row.id);
                }}
              >
                {hasKids.has(row.id) && <Icon name="chev" />}
              </span>
              {isLog ? <span className="ks" style={{ background: logColor, height: 7, width: 7, borderRadius: "50%" }} /> : <span className="ks" style={{ background: hue }} />}
              <span className="lbl" style={row.error || row.level === "error" ? { color: "var(--err)" } : row.level === "warn" ? { color: "var(--warn)" } : undefined}>
                {/^(GET|POST|PATCH|PUT|DELETE|task)\s/.test(row.label) ? <Entry text={row.label} /> : <RoutePath path={row.label} />}
              </span>
              {row.badge && <span className={`bdg ${row.badgeTone ?? "n"}`}>{row.badge}</span>}
              {row.detail && <span className="det">{row.detail}</span>}
            </span>
            <span className="wt">
              {axis.slice(1).map((tick) => (
                <span key={tick.left} className="grid" style={{ left: `${tick.left}%` }} />
              ))}
              {isLog || row.duration === undefined ? (
                <span className="pt" style={{ left: `${left}%`, ["--h" as string]: isLog ? logColor : hue }} />
              ) : (
                <>
                  <span className={`bar ${row.kind === "wait" ? "wait" : ""}`} style={{ left: `${left}%`, width: `${width}%`, ["--h" as string]: hue }} />
                  <span className={`barl ${row.error ? "e" : ""}`} style={{ left: `${left + width}%` }}>{fms(row.duration)}</span>
                </>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

type SpanLike = { id: string; parent: string; name: string; start: number; duration: number; status: string; statement: string; peer: string; httpStatus: number; taskKind: string; attrs: Record<string, string>; message?: string };

export const spanKind = (s: SpanLike): WfKind => (s.attrs["db.system"] === "redis" ? "cache" : s.statement ? "db" : s.peer ? "ext" : s.taskKind ? "task" : "app");

export function spanLabel(s: SpanLike) {
  if (s.statement) {
    const table = s.statement.match(/(?:FROM|INTO|UPDATE)\s+"?(\w+)"?/i)?.[1];
    return `${s.statement.trim().split(/\s+/)[0]!.toUpperCase()}${table ? ` ${table}` : ""}`;
  }
  return s.name.replace(/^pg\.query:/, "");
}

/** Turns spans and log lines into waterfall rows, collapsing a statement repeated in a row (N+1) into one badge. */
export function spansToRows(spans: SpanLike[], logs: { id: string; t: number; level: string; body: string; spanId: string }[], origin: number): WfRow[] {
  const rows: WfRow[] = [];
  const byParent = new Map<string, SpanLike[]>();
  for (const span of spans) {
    if (!byParent.has(span.parent)) byParent.set(span.parent, []);
    byParent.get(span.parent)!.push(span);
  }
  for (const [, siblings] of byParent) {
    siblings.sort((a, b) => a.start - b.start);
    let i = 0;
    while (i < siblings.length) {
      const span = siblings[i]!;
      let run = 1;
      while (span.statement && siblings[i + run]?.statement === span.statement) run++;
      const last = siblings[i + run - 1]!;
      const httpError = span.httpStatus >= 400;
      rows.push({
        id: span.id,
        parent: span.parent || null,
        kind: spanKind(span),
        label: spanLabel(span),
        start: span.start - origin,
        duration: run > 1 ? last.start + last.duration - span.start : span.duration,
        error: span.status === "Error" || httpError,
        badge: run > 1 ? `×${run}` : span.peer && span.httpStatus ? String(span.httpStatus) : undefined,
        badgeTone: run > 1 ? "w" : httpError ? "e" : "n",
        detail: run > 1 ? "N+1" : span.peer && span.attrs["url.full"] ? new URL(span.attrs["url.full"]).pathname : undefined,
      });
      i += run;
    }
  }
  for (const log of logs) {
    if (!log.body) continue;
    rows.push({ id: log.id, parent: log.spanId || null, kind: "log", label: log.body, start: log.t - origin, level: log.level });
  }
  return rows;
}
