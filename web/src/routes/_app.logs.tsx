import { keepPreviousData, useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { LogListRow, LogOp } from "@server/api/logs.ts";
import type { View } from "@sdk";
import { Block } from "@web/components/blocks.tsx";
import { Icon } from "@web/components/icons.tsx";
import { Spine } from "@web/components/shell.tsx";
import { Glide, Presence } from "@web/components/motion.tsx";
import { copy, Kv, Load, Method, Pop, RoutePath, WhyFix } from "@web/components/ui.tsx";
import { toast } from "@web/components/toast.tsx";
import { addSavedViewFn, aiExplainFn, aiFilterFn, aiStatusFn, logEventFn, logFacetFn, logFieldsFn, logLevelsFn, logRowsFn, sameServiceFn, savedViewsFn } from "@web/fns/explore.ts";
import { errorText, useAct, useFn, useScoped } from "@web/lib/api.ts";
import { dayMonth, fms, hms, shortService, statusClass } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";
import { Code, Hl, Json } from "@web/components/code.tsx";

const filterIn = z.object({ field: z.string(), op: z.enum(["is", "not", "contains", "not_contains", "starts", "gt", "gte", "lt", "lte", "exists"]), values: z.array(z.string()) });
const search = z.object({
  q: z.string().optional().catch(undefined),
  level: z.enum(["all", "error", "warn", "info"]).optional().catch(undefined),
  kind: z.enum(["wide", "plain", "both"]).optional().catch(undefined),
  filters: z.array(filterIn).optional().catch(undefined),
  event: z.string().optional().catch(undefined),
  tab: z.enum(["event", "json", "same"]).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/logs")({ validateSearch: search, component: LogsPage });

type Filter = z.infer<typeof filterIn>;
const FIELDS: [string, string][] = [["service", "service"], ["outcome", "outcome"], ["status", "status"], ["route.pattern", "route"], ["method", "method"], ["user.id", "user"], ["workspace.accountId", "account"], ["task.kind", "task.kind"], ["reason", "reason"], ["operation", "operation"]];
const CODE_VIEWS: { name: string; patch: { q?: string; level?: string; filters?: Filter[]; kind?: string } }[] = [
  { name: "Server errors", patch: { q: "status>=500" } },
  { name: "Failed tasks", patch: { filters: [{ field: "outcome", op: "is", values: ["failed"] }, { field: "kind", op: "is", values: ["task"] }] } },
  { name: "Refused emails", patch: { q: "emails.failed>0" } },
  { name: "Slow requests", patch: { q: "durationMs>800" } },
  { name: "Denied requests", patch: { filters: [{ field: "outcome", op: "is", values: ["denied"] }] } },
  { name: "Repeated queries", patch: { q: "db.repeatedQueries>3" } },
];
const COLUMNS = [["user", "User"], ["account", "Account"], ["biz", "Business fields"]] as const;
type Column = (typeof COLUMNS)[number][0];

function useColumns() {
  const [cols, setCols] = useState<Set<Column>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("vigie.logcols") ?? '["biz"]') as Column[]);
    } catch {
      return new Set<Column>(["biz"]);
    }
  });
  const toggle = (column: Column) =>
    setCols((prev) => {
      const next = new Set(prev);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      try {
        localStorage.setItem("vigie.logcols", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  return [cols, toggle] as const;
}

/** A batch ClickHouse half accepted is replayed from disk, so the same event can come back twice. It is one event. */
function once<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.id) && seen.add(row.id));
}

function Message({ row, cols }: { row: LogListRow; cols: Set<Column> }) {
  return (
    <div className="lmsg">
      {row.kind === "request" ? (
        <span className="hd">
          <Method m={row.method} />
          <span className="pth"><RoutePath path={row.route || row.body.split(" ")[1] || ""} /></span> <span className={statusClass(row.status)}>{row.status}</span>
        </span>
      ) : row.kind === "task" ? (
        <span className="hd">
          <span className="mth m-task">task</span>
          <span className="pth">{row.taskKind}</span>
          {row.level === "error" && <span className="err"> failed</span>}
        </span>
      ) : (
        <span className="hd"><span className="pth"><Hl>{row.body}</Hl></span></span>
      )}
      {row.why ? (
        <span className="kv why">{row.why}</span>
      ) : (
        <>
          {cols.has("user") && row.userId && <span className="kv">{row.userId}</span>}
          {cols.has("account") && row.accountId && <span className="kv" style={{ color: "var(--t4)" }}>{row.accountId}</span>}
          {cols.has("biz") && row.phrases.map((phrase) => <span key={phrase} className={`kv ${phrase.startsWith("same query") ? "rep" : ""}`}>{phrase}</span>)}
        </>
      )}
    </div>
  );
}

function Row({ row, cols, selected, fresh, onOpen }: { row: LogListRow; cols: Set<Column>; selected: boolean; fresh: boolean; onOpen: () => void }) {
  return (
    <button className={`lrow ${selected ? "sel" : ""} ${row.level === "error" ? "iserr" : ""} ${fresh ? "fresh" : ""}`} onClick={onOpen} aria-pressed={selected}>
      <span className="lt">{hms(row.t)}</span>
      <span className={`lvd ${row.level}`} />
      <span className={`ls s-${shortService(row.service)}`}>{shortService(row.service)}</span>
      <Message row={row} cols={cols} />
      <span className={`ld ${row.kind === "request" && row.duration >= 800 ? "slow" : ""}`}>{row.duration ? fms(row.duration) : ""}</span>
    </button>
  );
}

function FieldValues({ field, label, query, filters, onToggle, onNegate }: { field: string; label: string; query: { q?: string; level?: string; kind?: string; filters?: Filter[] }; filters: Filter[]; onToggle: (value: string) => void; onNegate: (neg: boolean) => void }) {
  const facet = useScoped(logFacetFn, { ...query, field });
  const current = filters.find((f) => f.field === field);
  const max = Math.max(1, ...(facet.data ?? []).map((v) => v.c));
  return (
    <>
      <h6 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="m">{label}</span>
        <span className="seg" style={{ height: 23, padding: 1 }}>
          <Glide on={current?.op === "not"} />
          <button style={{ height: 19, padding: "0 7px" }} className={current?.op !== "not" ? "on" : ""} onClick={() => onNegate(false)}>is</button>
          <button style={{ height: 19, padding: "0 7px" }} className={current?.op === "not" ? "on" : ""} onClick={() => onNegate(true)}>is not</button>
        </span>
      </h6>
      <div className="scrollp">
        {(facet.data ?? []).map(({ value, c }) => {
          const on = current?.values.includes(value);
          return (
            <button key={value} className="pitem" onClick={() => onToggle(value)}>
              <span className="fill" style={{ width: `${(c / max) * 100}%` }} />
              <span className={`chk ${on ? "on" : ""} ${on && current?.op === "not" ? "neg" : ""}`}><Icon name={on && current?.op === "not" ? "x" : "check"} /></span>
              <span className="ell">{value}</span>
              <span className="n">{c}</span>
            </button>
          );
        })}
        {facet.data && !facet.data.length && <div className="pfoot">No value in this range.</div>}
      </div>
    </>
  );
}

function FilterPop({ query, filters, setFilters }: { query: { q?: string; level?: string; kind?: string; filters?: Filter[] }; filters: Filter[]; setFilters: (next: Filter[]) => void }) {
  const [field, setField] = useState<[string, string] | null>(null);
  const fields = useScoped(logFieldsFn, {}, { enabled: field === null, staleTime: 60_000 });
  const extra = (fields.data ?? []).filter((f) => !FIELDS.some(([key]) => key === f.field)).slice(0, 60);
  const toggle = (name: string, value: string) => {
    const current = filters.find((f) => f.field === name);
    if (!current) return setFilters([...filters, { field: name, op: "is", values: [value] }]);
    const values = current.values.includes(value) ? current.values.filter((v) => v !== value) : [...current.values, value];
    setFilters(values.length ? filters.map((f) => (f === current ? { ...f, values } : f)) : filters.filter((f) => f !== current));
  };
  return (
    <Pop width={320} onOpenChange={(open) => !open && setField(null)} trigger={<button className="addf">+ Filter</button>}>
      {field ? (
        <FieldValues field={field[0]} label={field[1]} query={query} filters={filters} onToggle={(value) => toggle(field[0], value)} onNegate={(neg) => setFilters(filters.map((f) => (f.field === field[0] ? { ...f, op: (neg ? "not" : "is") as LogOp } : f)))} />
      ) : (
        <>
          <h6>Filter by a field</h6>
          <div className="scrollp">
            {FIELDS.map(([key, label]) => (
              <button key={key} className="pitem" onClick={() => setField([key, label])}><span className="m">{label}</span></button>
            ))}
            {extra.map((f) => (
              <button key={f.field} className="pitem" onClick={() => setField([f.field, f.field])}><span className="m ell">{f.field}</span><span className="n">{f.c}</span></button>
            ))}
          </div>
          <div className="pfoot">Any field works in the search bar, such as <span className="m" style={{ color: "var(--t2)" }}>user.plan=pro</span>.</div>
        </>
      )}
    </Pop>
  );
}

/** The fields worth reading first, in plain words. They are lifted out of "all fields" so nothing reads twice. */
const FACTS: { key: string; label: string }[] = [
  { key: "user.id", label: "Person" },
  { key: "workspace.accountId", label: "Account" },
  { key: "task.attempt", label: "Attempt" },
  { key: "subject", label: "Subject" },
  { key: "provider", label: "Provider" },
  { key: "reason", label: "Reason" },
  { key: "db.queries", label: "Database queries" },
  { key: "db.repeatedQueries", label: "Repeated queries" },
  { key: "path", label: "Path" },
];

function saidWhat(e: { kind: string; body: string; outcome: string; status: number; duration: number; taskKind: string }) {
  const took = e.duration ? ` in ${fms(e.duration)}` : "";
  if (e.kind === "request") {
    if (e.status >= 500) return `The server failed this request with ${e.status}${took}.`;
    if (e.outcome === "denied") return `This request was denied with ${e.status}${took}.`;
    if (e.status >= 400) return `This request was refused with ${e.status}${took}.`;
    return `Answered ${e.status}${took}.`;
  }
  if (e.kind === "task") {
    if (e.outcome === "failed") return `This attempt failed${took ? ` after ${fms(e.duration)}` : ""}.`;
    return e.outcome ? `Finished as ${e.outcome}${took}.` : `Ran${took}.`;
  }
  return "";
}

function agentPrompt(event: { body: string; service: string; t: number; attrs: Record<string, string>; traceId: string; summary: string }) {
  return [`Investigate this event from ${event.service} at ${new Date(event.t).toISOString()}.`, `Message: ${event.body}`, event.summary, `Trace: ${event.traceId}`, "Fields:", JSON.stringify(event.attrs, null, 2)].filter(Boolean).join("\n");
}

function EventPanel({ id, tab, setTab, onClose, onStep, onFilter, leaving }: { leaving?: boolean;  id: string; tab: string; setTab: (tab: "event" | "json" | "same") => void; onClose: () => void; onStep: (dir: number) => void; onFilter: (field: string, value: string) => void }) {
  const q = useFn(logEventFn, { id });
  const navigate = useNavigate();
  const event = q.data;
  const ai = useFn(aiStatusFn, undefined, { staleTime: Infinity }).data?.enabled;
  const explain = useMutation({ mutationFn: (data: { eventId: string }) => aiExplainFn({ data }) });
  const same = useScoped(sameServiceFn, { service: event?.service ?? "", at: event?.t ?? 0 }, { enabled: tab === "same" && Boolean(event) });
  useEffect(() => {
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Enter" || key.metaKey || key.ctrlKey) return;
      // The row you just clicked keeps focus, and Enter there still means the event it opened.
      const target = key.target as HTMLElement;
      if (target.closest("input,textarea,.pop") || (target.closest("button,a") && !target.closest(".lrow"))) return;
      key.preventDefault();
      if (event?.kind === "task" && event.taskId) void navigate({ to: "/tasks/run/$id", params: { id: event.taskId } });
      else if (event?.traceId) void navigate({ to: "/traces/$id", params: { id: event.traceId } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [event, navigate]);
  return (
    <aside className="panel" aria-label="Event" data-leaving={leaving || undefined}>
      <Load q={q}>
        {(e) => (
          <>
            <div className="phead logs-phead">
              <span className={e.level === "error" ? "err" : e.level === "warn" ? "warn" : "t2"}>{e.level === "error" ? "Error" : e.level === "warn" ? "Warning" : "Info"}</span>
              <span className="t3">{dayMonth(e.t)}, {hms(e.t)}</span>
              <span className="grow" />
              <button className="ib" title="Previous, k" aria-label="Previous event" onClick={() => onStep(-1)}><Icon name="up" /></button>
              <button className="ib" title="Next, j" aria-label="Next event" onClick={() => onStep(1)}><Icon name="down" /></button>
              <button className="ib" title="Close, Esc" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
            </div>
            <div className="pbody">
              <div className="hero logs-story">
                <h3>
                  {e.kind === "request" ? <><Method m={e.method} /> <RoutePath path={e.route || e.attrs.path || ""} /></> : e.kind === "task" ? <><span className="mth m-task">task</span> {e.taskKind}</> : <Hl>{e.body}</Hl>}
                </h3>
                {saidWhat(e) && <p className={`logs-said ${e.level === "error" ? "err" : e.level === "warn" ? "warn" : ""}`}>{saidWhat(e)}</p>}
                {e.view.error && !e.view.error.why && !e.view.error.fix && e.view.error.message && <p className="logs-said err">{e.view.error.message}</p>}
                {e.view.error && <WhyFix why={e.view.error.why} fix={e.view.error.fix} link={e.view.error.link} />}
              </div>
              <div className="ptabs">
                <Glide on={tab} line swap />
                {([["event", "Event"], ["json", "JSON"], ["same", "Just before"]] as const).map(([key, label]) => (
                  <button key={key} className={`ptab ${tab === key ? "on" : ""}`} onClick={() => setTab(key)}>{label}</button>
                ))}
              </div>
              {tab === "event" && (
                <>
                  {(() => {
                    // A section already tells what it claimed, so facts only lift what would otherwise be buried in the list of fields.
                    const facts = FACTS.filter((fact) => e.attrs[fact.key] && e.view.rest.includes(fact.key));
                    return (
                      <div className="rd">
                        <div className="kvg logs-facts">
                          <Kv label="Service" onFilter={() => onFilter("service", e.service)}>{`${shortService(e.service)}${e.version ? ` ${e.version.slice(0, 8)}` : ""}`}</Kv>
                          {facts.map((fact) => (
                            <Kv key={fact.key} label={fact.label} onFilter={() => onFilter(fact.key, e.attrs[fact.key] ?? "")}>
                              {fact.key === "user.id" ? <Link className="lnk" to="/users/$id" params={{ id: e.attrs[fact.key]! }}>{e.attrs[fact.key]}</Link> : (e.attrs[fact.key] ?? "")}
                            </Kv>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                  {e.view.sections.map((section) => (
                    <div className="rd" key={section.title}>
                      <div className="rdh"><span>{section.title}</span></div>
                      {(section.children as View[]).map((child, i) => <Block key={i} view={child} onFilter={onFilter} />)}
                    </div>
                  ))}
                  {e.view.error?.stack && (
                    <div className="rd">
                      <div className="rdh"><span>Stack</span></div>
                      <Code text={e.view.error.stack} lang="stack" fold />
                    </div>
                  )}
                  {(() => {
                    const rest = e.view.rest.filter((key) => !FACTS.some((fact) => fact.key === key));
                    if (!rest.length) return null;
                    return (
                      <div className="rd" style={{ borderBottom: 0 }}>
                        <div className="rdh"><span>All fields</span><span>{rest.length}</span></div>
                        <div className="kvg">
                          {rest.map((key) => (
                            <Kv key={key} k={key} tone={key === "outcome" ? (e.attrs[key] === "succeeded" ? "ok" : e.attrs[key] === "denied" ? "warn" : "err") : key === "status" ? statusClass(e.status) : undefined} onFilter={() => onFilter(key, e.attrs[key] ?? "")}>{key === "outcome" || key === "status" ? (e.attrs[key] ?? "") : <Hl>{e.attrs[key] ?? ""}</Hl>}</Kv>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
              {tab === "json" && <div className="logs-json"><Json value={{ timestamp: new Date(e.t).toISOString(), level: e.level, service: e.service, message: e.body, ...e.attrs }} /></div>}
              {tab === "same" && once(same.data ?? []).map((row) => (
                <Link key={row.id} className="same" style={{ width: "100%", textAlign: "left" }} to="/logs" search={{ event: row.id }}>
                  <span className="lt">{hms(row.t)}</span>
                  <span className={`lvd ${row.level}`} style={{ alignSelf: "center" }} />
                  <span className="ell m"><Hl>{row.body}</Hl></span>
                </Link>
              ))}
            </div>
            <div className="pacts">
              {e.kind === "task" && e.taskId ? (
                <Link className="btn pri" to="/tasks/run/$id" params={{ id: e.taskId }}>Open run <span className="kbd logs-enter">↵</span></Link>
              ) : e.traceId ? (
                <Link className="btn pri" to="/traces/$id" params={{ id: e.traceId }}>Open trace <span className="kbd logs-enter">↵</span></Link>
              ) : null}
              <button className="btn" onClick={() => copy(agentPrompt(e), "Agent prompt copied")}><Icon name="copy" />Agent prompt</button>
              {ai && <button className="btn" disabled={explain.isPending} onClick={() => explain.mutate({ eventId: e.id })}><Icon name="spark" />{explain.isPending ? "Reading…" : "Explain"}</button>}
            </div>
            {explain.data && <div className="stmt" style={{ margin: "0 12px 12px", background: "var(--well)", color: "var(--t2)" }}>{explain.data.text}</div>}
            {explain.error && <div className="stmt err" style={{ margin: "0 12px 12px" }}>{errorText(explain.error)}</div>}
          </>
        )}
      </Load>
    </aside>
  );
}

function SaveView({ onSave }: { onSave: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  return (
    <Pop open={open} onOpenChange={setOpen} width={240} trigger={<button className="fi logs-save">Save this search</button>}>
      <form className="logs-saveform" onSubmit={(event) => { event.preventDefault(); if (!name.trim()) return; onSave(name.trim()); setName(""); setOpen(false); }}>
        <input className="input" autoFocus aria-label="View name" placeholder="Name this view" value={name} onChange={(event) => setName(event.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim()}>Save</button>
      </form>
    </Pop>
  );
}

function LogsPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const scope = useScope();
  const patch = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const level = s.level ?? "all";
  const kind = s.kind ?? "wide";
  const filters = useMemo(() => s.filters ?? [], [s.filters]);
  const query = useMemo(() => ({ q: s.q, level, kind, filters }), [s.q, level, kind, filters]);
  const [text, setText] = useState(s.q ?? "");
  useEffect(() => setText(s.q ?? ""), [s.q]);
  const [cols, toggleCol] = useColumns();
  const levels = useScoped(logLevelsFn, { q: s.q, kind, filters });
  const views = useFn(savedViewsFn, { scope: "logs" });
  const aiOn = useFn(aiStatusFn, undefined, { staleTime: Infinity }).data?.enabled;
  const fieldNames = useScoped(logFieldsFn, {}, { staleTime: 60_000, enabled: Boolean(aiOn) });
  const toSearch = useMutation({ mutationFn: (value: string) => aiFilterFn({ data: { text: value, fields: (fieldNames.data ?? []).map((f) => f.field) } }) });
  const save = useAct(addSavedViewFn);

  const input = useMemo(() => ({ ...scope.params, ...query }), [scope.params, query]);
  const rows = useInfiniteQuery({
    queryKey: ["logs", input],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) => logRowsFn({ data: { ...input, before: pageParam, limit: 200 }, signal }),
    getNextPageParam: (last) => last.next ?? undefined,
    placeholderData: keepPreviousData,
  });

  const [live, setLive] = useState<LogListRow[]>([]);
  // New rows wait here while you read: a list that moves under the cursor is unreadable. They come in at the top, or on request.
  const [held, setHeld] = useState<LogListRow[]>([]);
  // A row stays marked as new for as long as its highlight lasts, whatever re-renders in between.
  const freshIds = useRef(new Map<string, number>());
  const scroller = useRef<HTMLDivElement>(null);
  const reading = useRef(false);
  reading.current = Boolean(s.event);
  useEffect(() => {
    setLive([]);
    setHeld([]);
  }, [input.env, input.q, input.level, input.kind, input.filters]);
  useEffect(() => {
    if (!scope.live) return;
    const source = new EventSource(`/api/live?env=${scope.env}`);
    source.onmessage = (message) => {
      const batch = JSON.parse(message.data as string) as LogListRow[];
      const shown = batch.filter((row) => (level === "all" || row.level === level) && (kind === "both" || (kind === "wide" ? row.kind !== "log" : row.kind === "log")));
      if (!shown.length) return;
      const at = Date.now();
      for (const [id, seen] of freshIds.current) if (at - seen > 1500) freshIds.current.delete(id);
      for (const row of shown) freshIds.current.set(row.id, at);
      const away = reading.current || (scroller.current?.scrollTop ?? 0) > 12;
      (away ? setHeld : setLive)((prev) => [...shown.reverse(), ...prev].slice(0, 500));
    };
    return () => {
      source.close();
      setHeld([]);
    };
  }, [scope.live, scope.env, level, kind]);
  const releaseHeld = () => {
    setLive((prev) => [...held, ...prev].slice(0, 500));
    setHeld([]);
    if (scroller.current) scroller.current.scrollTop = 0;
  };

  const liveBlocked = scope.live && Boolean(filters.length || s.q);
  const list = useMemo(() => {
    const stored = once(rows.data?.pages.flatMap((page) => page.rows) ?? []);
    if (!scope.live || liveBlocked) return stored;
    const seen = new Set(live.map((row) => row.id));
    return [...live, ...stored.filter((row) => !seen.has(row.id))];
  }, [rows.data, live, scope.live, liveBlocked]);

  const virtual = useVirtualizer({ count: list.length, getScrollElement: () => scroller.current, estimateSize: () => 36, overscan: 20 });
  const items = virtual.getVirtualItems();
  const lastIndex = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (lastIndex >= list.length - 30 && rows.hasNextPage && !rows.isFetchingNextPage) void rows.fetchNextPage();
  }, [lastIndex, list.length, rows.hasNextPage, rows.isFetchingNextPage, rows.fetchNextPage]);

  const selectedIndex = list.findIndex((row) => row.id === s.event);
  const step = (dir: number) => {
    const index = selectedIndex < 0 ? 0 : selectedIndex + dir;
    const next = list[Math.max(0, index)];
    if (next && next.id !== s.event) {
      patch({ event: next.id });
      virtual.scrollToIndex(Math.max(0, index), { align: "auto" });
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea")) {
        if (event.key === "Escape") {
          setText("");
          if (s.q) patch({ q: undefined });
          target.blur();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || document.querySelector(".pop")) return;
      if (event.key === "/") {
        event.preventDefault();
        document.getElementById("q")?.focus();
      } else if (event.key === "j") step(1);
      else if (event.key === "k") step(-1);
      else if (event.key === "Escape") {
        if (s.event) patch({ event: undefined, tab: undefined });
        else if (s.q) patch({ q: undefined });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const setFilters = (next: Filter[]) => patch({ filters: next.length ? next : undefined });
  const addFilter = (field: string, value: string) => setFilters([...filters.filter((f) => f.field !== field), { field, op: "is", values: [value] }]);
  const counts = levels.data ?? { all: 0, error: 0, warn: 0, info: 0, debug: 0 };
  const searching = Boolean(s.q || s.level || filters.length || s.kind);
  const clearAll = () => {
    setText("");
    patch({ q: undefined, level: undefined, kind: undefined, filters: undefined });
  };
  const viewKey = (view: { q?: string; level?: string; filters?: Filter[]; kind?: string }) => JSON.stringify([view.q ?? "", view.level ?? "", view.filters ?? [], view.kind ?? ""]);
  const currentView = viewKey({ q: s.q, level: s.level, filters: s.filters, kind: s.kind });
  const openView = (view: { q?: string; level?: string; filters?: Filter[]; kind?: string }) => {
    if (viewKey(view) === currentView) return clearAll();
    setText(view.q ?? "");
    patch({ q: view.q, level: view.level as typeof s.level, filters: view.filters, kind: view.kind as typeof s.kind });
  };
  const facetRow = (key: string, label: React.ReactNode, count: number | undefined, on: boolean, onClick: () => void) => (
    <button key={key} className={`fi ${on ? "on" : ""}`} aria-pressed={on} onClick={onClick}>
      <span className="ell">{label}</span>
      {count !== undefined && <em>{count.toLocaleString("en-US")}</em>}
    </button>
  );
  const savedList = (views.data ?? []).map((view) => ({ id: view.id, name: view.name, patch: JSON.parse(view.filter) as { q?: string; level?: string; filters?: Filter[]; kind?: string } }));
  const known = currentView === viewKey({}) || CODE_VIEWS.some((view) => viewKey(view.patch) === currentView) || savedList.some((view) => viewKey(view.patch) === currentView);
  return (
    <div className="lg3">
      <aside className="fac" aria-label="Filters">
        <div className="fg">
          {([["all", "Everything"], ["error", "Errors"], ["warn", "Warnings"], ["info", "Info"]] as const).filter(([key]) => key === "all" || level === key || counts[key] > 0).map(([key, label]) => facetRow(key, <span className={key === "error" ? "err" : key === "warn" ? "warn" : undefined}>{label}</span>, counts[key], level === key, () => patch({ level: key === "all" ? undefined : key })))}
        </div>
        <div className="fg">
          <div className="fh">Show</div>
          {([["wide", "Requests and tasks"], ["plain", "Log lines"], ["both", "Both"]] as const).map(([key, label]) => facetRow(key, label, undefined, kind === key, () => patch({ kind: key === "wide" ? undefined : key })))}
        </div>
        <div className="fg">
          <div className="fh">Views</div>
          {CODE_VIEWS.map((view) => facetRow(view.name, view.name, undefined, viewKey(view.patch) === currentView, () => openView(view.patch)))}
          {savedList.map((view) => facetRow(view.id, view.name, undefined, viewKey(view.patch) === currentView, () => openView(view.patch)))}
          {Boolean(s.q || filters.length) && !known && (
            <SaveView onSave={(name) => save.mutate({ name, scope: "logs", filter: JSON.stringify({ q: s.q, level: s.level, filters: s.filters, kind: s.kind }) }, { onSuccess: () => toast(`Saved as ${name}`), onError: (error) => toast(errorText(error)) })} />
          )}
        </div>
      </aside>
      <div className="lcol">
      <div className="lbar" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <div className="qwrap" style={{ flex: 1, minWidth: 0 }}>
          <form className="qbar" onSubmit={(event) => { event.preventDefault(); patch({ q: text || undefined }); }}>
            <Icon name="search" style={{ width: 14, height: 14, color: "var(--t3)", flex: "none" }} />
            {filters.map((filter) => (
              <span className="tok" key={filter.field}>
                <span className="k" style={{ paddingRight: 4 }}>{FIELDS.find(([key]) => key === filter.field)?.[1] ?? filter.field}</span>
                <button type="button" className="o" title="Switch between is and is not" onClick={() => setFilters(filters.map((f) => (f === filter ? { ...f, op: f.op === "not" ? "is" : "not" } : f)))}>{filter.op === "not" ? "is not" : "is"}</button>
                <span className="v" style={{ paddingLeft: 5, paddingRight: 2 }}>{filter.values.length > 2 ? `${filter.values.length} values` : filter.values.join(", ")}</span>
                <button type="button" className="x" aria-label="Remove filter" onClick={() => setFilters(filters.filter((f) => f !== filter))}>×</button>
              </span>
            ))}
            <input id="q" value={text} autoComplete="off" aria-label="Search events" placeholder={filters.length ? "Search messages and fields" : "Search, or type a field: status>=500, user.id:usr_01j"} onChange={(event) => setText(event.target.value)} onBlur={() => text !== (s.q ?? "") && patch({ q: text || undefined })} />
            {aiOn && text.trim().includes(" ") && !/[=<>^~:]/.test(text) && (
              <button type="button" className="addf" disabled={toSearch.isPending} onClick={() => toSearch.mutate(text, { onSuccess: ({ q }) => { setText(q); patch({ q }); }, onError: (error) => toast(errorText(error)) })}><Icon name="spark" size={12} /> {toSearch.isPending ? "Reading…" : "Turn into a search"}</button>
            )}
            <FilterPop query={query} filters={filters} setFilters={setFilters} />
            <span className="kbd">/</span>
          </form>
        </div>
        <span className="logs-rowfields">
          <Pop align="end" width={220} trigger={<button className="btn">Row fields</button>}>
            <h6>Show in rows</h6>
            {COLUMNS.map(([key, label]) => (
              <button key={key} className="pitem" onClick={() => toggleCol(key)}>
                <span className={`chk ${cols.has(key) ? "on" : ""}`}><Icon name="check" /></span>
                <span>{label}</span>
              </button>
            ))}
          </Pop>
        </span>
      </div>
      <Spine />
      {liveBlocked && (
        <div className="logs-livenote">
          <span>New events are not added while a search or filter is on.</span>
          <button className="tlink" onClick={clearAll}>Clear to follow them</button>
        </div>
      )}
      <div className="lbody">
        <div className="ltable">
          <div className="logs" style={{ display: "contents" }}>
            <div className="lhead"><span>Time</span><span /><span>Service</span><span>Event</span><span className="r">Duration</span></div>
            <div className={`lvscroll logs-scroll ${level === "error" ? "logs-allerr" : ""}`} ref={scroller} onScroll={(event) => { if (held.length && event.currentTarget.scrollTop <= 12 && !s.event) releaseHeld(); }}>
              {held.length > 0 && <button className="logs-new" onClick={releaseHeld}><Icon name="up" size={12} />{held.length} new {held.length === 1 ? "event" : "events"}</button>}
              {rows.isPending && !list.length && Array.from({ length: 14 }, (_, i) => <div key={i} className="skel" style={{ height: 24, marginBottom: 7, opacity: 1 - i * 0.06 }} />)}
              {rows.error && <div className="ph" style={{ padding: "60px 20px" }}><div><h3>This did not load</h3><p>{errorText(rows.error)}</p><button className="btn" style={{ marginTop: 10 }} onClick={() => void rows.refetch()}>Try again</button></div></div>}
              {!rows.isPending && !rows.error && !list.length && (
                <div className="ph" style={{ padding: "60px 20px" }}>
                  <div>
                    <h3>{searching ? "No event matches" : "No event in this window"}</h3>
                    <p>{searching ? "This search found nothing in this time range." : "Widen the time range at the top."}</p>
                    {searching && <button className="btn" style={{ marginTop: 12 }} onClick={clearAll}>Clear search and filters</button>}
                  </div>
                </div>
              )}
              <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
                {items.map((item) => {
                  const row = list[item.index]!;
                  return (
                    <div key={row.id} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}>
                      <Row row={row} cols={cols} selected={row.id === s.event} fresh={Date.now() - (freshIds.current.get(row.id) ?? 0) < 1500} onOpen={() => patch({ event: row.id })} />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        <Presence value={s.event}>{(id, leaving) => <EventPanel id={id} leaving={leaving} tab={s.tab ?? "event"} setTab={(tab) => patch({ tab: tab === "event" ? undefined : tab })} onClose={() => patch({ event: undefined, tab: undefined })} onStep={step} onFilter={addFilter} />}</Presence>
      </div>
      </div>
    </div>
  );
}
