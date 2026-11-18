import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { TraceRow } from "@server/api/traces.ts";
import { Failure, Levels, Method, Pop, RoutePath, SearchBox, Segments } from "@web/components/ui.tsx";
import { Icon } from "@web/components/icons.tsx";
import { traceCountsFn, traceListFn } from "@web/fns/explore.ts";
import { useScoped } from "@web/lib/api.ts";
import { fms, hms, shortService, statusClass } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({
  q: z.string().optional().catch(undefined),
  f: z.enum(["all", "error", "ok"]).optional().catch(undefined),
  kind: z.enum(["request", "task"]).optional().catch(undefined),
  sort: z.enum(["time", "duration"]).optional().catch(undefined),
  sel: z.string().optional().catch(undefined),
});
export const Route = createFileRoute("/_app/traces/")({ validateSearch: search, component: TracesPage });

const KINDS = [["request", "Requests"], ["task", "Tasks"]] as const;
const SCROLL_KEY = "vigie.traces.scroll";

/** Durations span five orders of magnitude, so a shared log scale keeps both 8 ms and 40 s readable on one axis. */
function useScale(rows: TraceRow[]) {
  return useMemo(() => {
    const top = Math.max(1000, ...rows.map((row) => row.duration));
    const decades = Math.ceil(Math.log10(top));
    const at = (ms: number) => Math.min(1, Math.max(0.012, Math.log10(Math.max(1, ms)) / decades));
    const ticks = Array.from({ length: decades }, (_, i) => 10 ** (i + 1));
    return { at, ticks, decades };
  }, [rows]);
}

function StatusCell({ row }: { row: TraceRow }) {
  if (row.status >= 400) return <span className={statusClass(row.status)}>{row.status}</span>;
  if (row.errors > 0) return <span className="err">{row.errors} {row.errors === 1 ? "error" : "errors"}</span>;
  return <span className="t3">{row.status || "Ok"}</span>;
}

function EntryCell({ row }: { row: TraceRow }) {
  const others = row.services.length > 1 ? row.services.map(shortService).join(", ") : "";
  return (
    <span className="traces-entry">
      {row.method ? <Method m={row.method} /> : row.taskKind ? <span className="mth m-task">task</span> : null}
      <span className="ell">{row.method ? <RoutePath path={row.route || row.root} /> : row.taskKind || row.root}</span>
      {others && <span className="traces-svc">{others}</span>}
    </span>
  );
}

function readScroll() {
  try {
    return JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? "null") as { key: string; top: number } | null;
  } catch {
    return null;
  }
}

function TracesPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const scope = useScope();
  const patch = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const filter = s.f ?? "all";
  const sort = s.sort ?? "time";
  const [text, setText] = useState(s.q ?? "");
  useEffect(() => setText(s.q ?? ""), [s.q]);
  useEffect(() => {
    if (text === (s.q ?? "")) return;
    const timer = setTimeout(() => patch({ q: text || undefined, sel: undefined }), 260);
    return () => clearTimeout(timer);
  });
  const input = useMemo(() => ({ ...scope.params, q: s.q, filter, kind: s.kind, sort }), [scope.params, s.q, filter, s.kind, sort]);
  const q = useInfiniteQuery({
    queryKey: ["traces", input],
    initialPageParam: undefined as { before?: number; offset?: number } | undefined,
    queryFn: ({ pageParam, signal }) => traceListFn({ data: { ...input, ...pageParam, limit: 200 }, signal }),
    getNextPageParam: (last, pages) => (last.rows.length < 200 ? undefined : sort === "duration" ? { offset: pages.length * 200 } : last.next ? { before: last.next } : undefined),
    placeholderData: keepPreviousData,
  });
  const counts = useScoped(traceCountsFn, {});
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (q.data?.pages.flatMap((page) => page.rows) ?? []).filter((row) => !seen.has(row.id) && seen.add(row.id));
  }, [q.data]);
  const scale = useScale(rows);
  const scrollKey = JSON.stringify([s.q, filter, s.kind, sort]);
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => (typeof matchMedia === "function" && matchMedia("(max-width: 860px)").matches ? 54 : 38),
    overscan: 16,
    initialOffset: () => {
      const saved = readScroll();
      return saved?.key === scrollKey ? saved.top : 0;
    },
  });
  const items = virtual.getVirtualItems();
  const lastIndex = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (lastIndex >= rows.length - 30 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [lastIndex, rows.length, q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);
  const open = (row: TraceRow) => {
    try {
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ key: scrollKey, top: scroller.current?.scrollTop ?? 0 }));
    } catch {}
    void navigate({ search: (prev) => ({ ...prev, sel: row.id }), replace: true }).then(() => navigate({ to: "/traces/$id", params: { id: row.id }, search: (prev) => ({ env: prev.env, range: prev.range, from: prev.from, to: prev.to, svc: prev.svc }) as never }));
  };
  const selectedIndex = rows.findIndex((row) => row.id === s.sel);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea")) {
        if (event.key === "Escape") {
          setText("");
          patch({ q: undefined });
          target.blur();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey) return;
      if (event.key === "/") {
        event.preventDefault();
        document.getElementById("trQ")?.focus();
      } else if (event.key === "Escape") {
        if (s.q) patch({ q: undefined });
        else if (s.sel) patch({ sel: undefined });
      } else if (event.key === "Enter") {
        const row = rows[selectedIndex];
        if (row) open(row);
      } else if (event.key === "j" || event.key === "k") {
        const index = selectedIndex + (event.key === "j" ? 1 : -1);
        const next = rows[Math.max(0, index)];
        if (next) {
          patch({ sel: next.id });
          virtual.scrollToIndex(Math.max(0, index), { align: "auto" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const filtered = Boolean(s.q || s.kind || filter !== "all");
  const levels: [string, React.ReactNode][] = [];
  const c = counts.data;
  // The figures count the whole window, so beside a search they would say the wrong thing.
  const showCounts = !s.q && !s.kind;
  for (const [key, label] of [["all", "All"], ["error", "Failed"], ["ok", "Ok"]] as const) {
    const n = c?.[key];
    if (key !== "all" && n === 0 && filter !== key) continue;
    levels.push([key, showCounts && n !== undefined ? <>{label} <b>{n.toLocaleString("en-US")}</b></> : label]);
  }
  return (
    <>
      <div className="traces-bar">
        <SearchBox id="trQ" value={text} onChange={setText} placeholder="A route, a task, a trace id, or duration>500ms" style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }} />
        <Levels value={filter} onChange={(f) => patch({ f: f === "all" ? undefined : (f as "error" | "ok"), sel: undefined })} options={levels as [string, React.ReactNode][]} />
        <Pop
          width={180}
          trigger={<button className={`fchip ${s.kind ? "act" : ""}`}>Type{s.kind && <span className="v">{KINDS.find(([key]) => key === s.kind)?.[1]}</span>}<Icon name="chev" /></button>}
        >
          {KINDS.map(([key, label]) => (
            <button key={key} className="pitem" onClick={() => patch({ kind: s.kind === key ? undefined : key, sel: undefined })}>
              <span className={`chk ${s.kind === key ? "on" : ""}`}><Icon name="check" /></span>
              <span>{label}</span>
            </button>
          ))}
        </Pop>
        <span className="traces-sort">
          <Segments value={sort} env={false} onChange={(v) => patch({ sort: v === "time" ? undefined : v, sel: undefined })} options={[["time", "Newest"], ["duration", "Slowest"]]} />
        </span>
      </div>
      <div className="traces-head traces-grid">
        <span>Entry point</span>
        <span>Status</span>
        <span className="traces-axis" aria-hidden="true">
          {scale.ticks.map((tick) => <span key={tick} style={{ left: `${(Math.log10(tick) / scale.decades) * 100}%` }}>{tick >= 1000 ? `${tick / 1000} s` : `${tick} ms`}</span>)}
        </span>
        <span className="r">Duration</span>
        <span className="r traces-dim">Spans</span>
        <span className="r traces-dim">Started</span>
      </div>
      <div className="traces-list" ref={scroller}>
        {q.error && <Failure error={q.error} retry={() => void q.refetch()} />}
        {!rows.length && !q.isPending && !q.error && (
          <div className="ph" style={{ padding: "60px 20px" }}>
            <div>
              <h3>{filtered ? "No execution matches" : "No execution in this window"}</h3>
              <p>{filtered ? "These filters found nothing in this time range." : "Widen the time range at the top."}</p>
              {filtered && <button className="btn" style={{ marginTop: 12 }} onClick={() => { setText(""); patch({ q: undefined, f: undefined, kind: undefined, sel: undefined }); }}>Clear filters</button>}
            </div>
          </div>
        )}
        {q.isPending && !rows.length && Array.from({ length: 14 }, (_, i) => <div key={i} className="skel" style={{ height: 26, margin: "6px 20px", opacity: 1 - i * 0.06 }} />)}
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {items.map((item) => {
            const row = rows[item.index]!;
            const failed = row.errors > 0 || row.status >= 500;
            const slow = !failed && Boolean(row.method) && row.duration >= 800;
            return (
              <Link
                key={row.id}
                className={`traces-row traces-grid ${s.sel === row.id ? "sel" : ""}`}
                style={{ transform: `translateY(${item.start}px)` }}
                to="/traces/$id"
                params={{ id: row.id }}
                search={((prev: Record<string, unknown>) => ({ env: prev.env, range: prev.range, from: prev.from, to: prev.to, svc: prev.svc })) as never}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                  event.preventDefault();
                  open(row);
                }}
              >
                <EntryCell row={row} />
                <span className="traces-status"><StatusCell row={row} /></span>
                <span className="traces-track">
                  {scale.ticks.map((tick) => <i key={tick} className="traces-tick" style={{ left: `${(Math.log10(tick) / scale.decades) * 100}%` }} />)}
                  <span className={`traces-bar-fill ${failed ? "err" : slow ? "warn" : ""}`} style={{ scale: `${scale.at(row.duration)} 1` }} />
                </span>
                <span className={`mono r traces-dur ${failed ? "err" : slow ? "warn" : ""}`}>{fms(row.duration)}</span>
                <span className="mono r t3 traces-dim">{row.spans}</span>
                <span className="mono r t3 traces-dim">{hms(row.t)}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
