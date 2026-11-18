import { Dialog } from "@base-ui/react/dialog";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { dashboardsFn } from "@web/fns/admin.ts";
import { searchFn, shellFn, timelineFn } from "@web/fns/explore.ts";
import { errorStatus, errorText, useFn, useScoped } from "@web/lib/api.ts";
import { ago, axisLabel } from "@web/lib/format.ts";
import { ENV_LABEL, environments, rememberRange, RANGES, useScope, useSetScope, type Range } from "@web/lib/scope.ts";
import { Bars, Brush } from "./charts.tsx";
import { Icon, Mark } from "./icons.tsx";
import { fadeIn, Glide } from "./motion.tsx";
import { Avatar, DataLink, Entry, Pop } from "./ui.tsx";
const AskPanel = lazy(() => import("./ask.tsx"));

type NavItem = { to: string; label: string; icon: string; hint?: string; badge?: "inbox" | "tasks" | "alerts" };
/** The places an operator goes when something is wrong are always one click. The rest folds away, and the palette reaches all of it. */
const NAV: { group: string | null; fold?: boolean; items: NavItem[] }[] = [
  { group: null, items: [{ to: "/", label: "Overview", icon: "overview" }, { to: "/inbox", label: "Inbox", icon: "alerts", badge: "inbox" }, { to: "/dashboards", label: "Dashboards", icon: "dash" }] },
  { group: "Investigate", items: [{ to: "/logs", label: "Logs", icon: "logs" }, { to: "/traces", label: "Traces", icon: "traces", hint: "each execution" }, { to: "/requests", label: "Requests", icon: "requests", hint: "by route" }, { to: "/queries", label: "Queries", icon: "queries" }, { to: "/external", label: "External calls", icon: "external" }, { to: "/issues", label: "Issues", icon: "issues" }] },
  { group: "Background", items: [{ to: "/tasks", label: "Tasks", icon: "tasks", badge: "tasks" }, { to: "/processes", label: "Processes", icon: "processes" }, { to: "/workers", label: "Workers", icon: "workers" }, { to: "/schedules", label: "Schedules", icon: "schedules" }] },
  { group: "Reliability", fold: true, items: [{ to: "/alerts", label: "Alerts", icon: "alerts", badge: "alerts" }, { to: "/slos", label: "SLOs", icon: "target" }, { to: "/uptime", label: "Uptime", icon: "uptime" }, { to: "/status-page", label: "Status page", icon: "uptime" }, { to: "/rules", label: "Rules", icon: "check" }, { to: "/releases", label: "Releases", icon: "releases" }] },
  { group: "Customers", fold: true, items: [{ to: "/users", label: "People", icon: "user" }, { to: "/accounts", label: "Accounts", icon: "biz" }, { to: "/apikeys", label: "API keys", icon: "code" }] },
  { group: "System", fold: true, items: [{ to: "/emails", label: "Emails", icon: "emails" }, { to: "/cache", label: "Cache", icon: "queries" }, { to: "/commands", label: "Commands", icon: "logs" }, { to: "/ai", label: "AI usage", icon: "spark" }, { to: "/runtime", label: "Runtime", icon: "uptime" }, { to: "/services", label: "Services", icon: "dash" }, { to: "/map", label: "Service map", icon: "processes" }, { to: "/metrics", label: "Metrics", icon: "metrics" }, { to: "/database", label: "Database", icon: "queries" }, { to: "/console", label: "Query console", icon: "code" }] },
];
/** Extension pages name a group from their own definition: older names still land somewhere sensible. */
const GROUP_OF: Record<string, string> = { Explore: "Investigate", Backend: "System", Tasks: "Background", Processes: "Background", People: "Customers" };

const TITLES: [RegExp, string][] = [
  [/^\/link/, "Link an app"], [/^\/status-page/, "Status page"],
  [/^\/$/, "Overview"], [/^\/logs/, "Logs"], [/^\/traces/, "Traces"], [/^\/metrics/, "Metrics"], [/^\/console/, "Query console"], [/^\/database/, "Database"],
  [/^\/requests/, "Requests"], [/^\/queries/, "Queries"], [/^\/external/, "External calls"], [/^\/emails/, "Emails"], [/^\/cache/, "Cache"], [/^\/commands/, "Commands"], [/^\/runtime/, "Runtime"], [/^\/services/, "Services"], [/^\/map/, "Service map"], [/^\/ai/, "AI usage"],
  [/^\/tasks/, "Tasks"], [/^\/workers/, "Workers"], [/^\/schedules/, "Schedules"], [/^\/processes/, "Processes"], [/^\/issues/, "Issues"], [/^\/alerts/, "Alerts"], [/^\/slos/, "SLOs"], [/^\/uptime/, "Uptime"], [/^\/rules/, "Rules"], [/^\/releases/, "Releases"],
  [/^\/users/, "People"], [/^\/accounts/, "Accounts"], [/^\/apikeys/, "API keys"], [/^\/dashboards/, "Dashboards"], [/^\/inbox/, "Inbox"], [/^\/settings/, "Settings"],
];

/** The time spine is the picture of time on event lists. Pages with their own charts would only show it twice. */
const SPINE = /^\/traces$/;

type ShellData = Awaited<ReturnType<typeof shellFn>>;

function SideNav({ shell, open, onNavigate }: { shell: ShellData | undefined; open: boolean; onNavigate: () => void }) {
  const path = useLocation({ select: (l) => l.pathname });
  const active = path === "/" ? "/" : `/${path.split("/")[1]}`;
  const [opened, setOpened] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("vigie.nav") ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (group: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      try {
        localStorage.setItem("vigie.nav", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  const groups = useMemo(() => {
    const known = new Set(NAV.map((entry) => entry.group));
    const home = (group: string) => (known.has(group) ? group : (GROUP_OF[group] ?? "System"));
    return NAV.map((entry) => ({ ...entry, items: [...entry.items, ...(shell?.pages ?? []).filter((p) => home(p.group) === entry.group).sort((a, b) => a.order - b.order).map((p): NavItem => ({ to: `/p/${p.id}`, label: p.title, icon: "biz" }))] }));
  }, [shell?.pages]);
  const inSettings = path.startsWith("/settings");
  return (
    <nav className={`nav ${open ? "open" : ""}`} aria-label="Main">
      <div className="brand">
        <Mark />
        Vigie
      </div>
      <button className="home-nav-search" data-testid="palette" aria-label="Search everything" onClick={() => { onNavigate(); window.dispatchEvent(new Event("vigie:palette")); }}>
        <Icon name="search" />
        <span>Search</span>
        <span className="kbd">⌘K</span>
      </button>
      <div className="nscroll">
       <div className="nlist">
        <Glide on={`${path}|${[...opened].join()}`} select=".ni.on" />
        {groups.map(({ group, fold, items }) => {
          const isActive = (item: NavItem) => (item.to.startsWith("/p/") ? path === item.to : active === item.to);
          const show = !fold || (group ? opened.has(group) : true) || items.some(isActive);
          const bad = items.reduce((sum, item) => sum + (item.badge ? (shell?.badges[item.badge] ?? 0) : 0), 0);
          return (
            <div key={group ?? "top"} style={{ display: "contents" }}>
              {group && !fold && <div className="nsec home-nav-sec">{group}</div>}
              {group && fold && (
                <button className="nsec nsb" onClick={() => toggle(group)} aria-expanded={show}>
                  <span>{group}</span>
                  {!show && bad > 0 ? <span className="cnt" style={{ marginLeft: "auto", marginRight: 6, font: "500 11px var(--mono)", color: "var(--err)" }}>{bad}</span> : <span style={{ marginLeft: "auto" }} />}
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="m4 6 4 4 4-4" />
                  </svg>
                </button>
              )}
              <div className={`ngrp ${show ? "" : "shut"}`} inert={!show}>
                <div>
                  {items.map((item) => {
                    const count = item.badge ? (shell?.badges[item.badge] ?? 0) : 0;
                    return (
                      <DataLink key={item.to} to={item.to} className={`ni ${isActive(item) ? "on" : ""}`} aria-current={isActive(item) ? "page" : undefined} onClick={onNavigate}>
                        <Icon name={item.icon} />
                        <span>{item.label}</span>
                        {item.hint && <span className="home-ni-hint">{item.hint}</span>}
                        {count > 0 && <span className={`cnt ${item.badge === "inbox" ? "home-cnt-quiet" : ""}`}>{count}</span>}
                      </DataLink>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
       </div>
      </div>
      <div className="nfoot">
        <Avatar name={shell?.me.name ?? "You"} />
        <div className="grow ell" style={{ fontWeight: 500, fontSize: 12.5 }}>
          {shell?.me.name ?? " "}
        </div>
        <Link className={`ib ${inSettings ? "home-gear-on" : ""}`} to="/settings/$section" params={{ section: "services" }} title="Settings" aria-label="Settings" aria-current={inSettings ? "page" : undefined} onClick={onNavigate}>
          <Icon name="gear" />
        </Link>
      </div>
    </nav>
  );
}

const RANGE_NAMES: Record<Range, string> = { "15m": "Last 15 minutes", "1h": "Last hour", "6h": "Last 6 hours", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days" };

/** Time and services are one question, what am I looking at, so they are one control. */
function ScopePicker({ services }: { services: string[] }) {
  const scope = useScope();
  const set = useSetScope();
  const [open, setOpen] = useState(false);
  const chosen = scope.services ? scope.services.split(",") : [];
  const span = scope.to - scope.from;
  const when = scope.custom ? `${axisLabel(scope.from, span)} – ${axisLabel(scope.to, span)}` : scope.range;
  const filter = chosen.length === 1 ? chosen[0] : chosen.length ? `${chosen.length} services` : "";
  return (
    <Pop
      width={250}
      align="end"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button className="btn home-scope" aria-label="Time range and services">
          <span className="home-scope-when">{when}</span>
          {filter && <span className="home-scope-svc ell">{filter}</span>}
          <Icon name="chev" />
        </button>
      }
    >
      <h6>Time range</h6>
      {(Object.keys(RANGES) as Range[]).map((range) => (
        <button
          key={range}
          className="pitem"
          aria-pressed={scope.range === range}
          onClick={() => {
            rememberRange(range);
            set({ range, from: undefined, to: undefined });
            setOpen(false);
          }}
        >
          <span className={`home-radio ${scope.range === range ? "on" : ""}`} />
          <span>{RANGE_NAMES[range]}</span>
          <span className="n">{range}</span>
        </button>
      ))}
      {scope.custom && (
        <button className="pitem" onClick={() => { set({ from: undefined, to: undefined }); setOpen(false); }}>
          <span className="home-radio on" />
          <span className="ell">{when}</span>
          <span className="n">Clear</span>
        </button>
      )}
      {services.length > 1 && (
        <>
          <h6 className="home-pop-h">Services</h6>
          <div className="scrollp">
            {services.map((service) => {
              const on = chosen.includes(service);
              return (
                <button key={service} className="pitem" onClick={() => set({ svc: (on ? chosen.filter((s) => s !== service) : [...chosen, service]).join(",") || undefined })}>
                  <span className={`chk ${on ? "on" : ""}`}>
                    <Icon name="check" />
                  </span>
                  <span className="ell">{service}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </Pop>
  );
}

function Controls({ shell, onAsk }: { shell: ShellData | undefined; onAsk: () => void }) {
  const scope = useScope();
  const set = useSetScope();
  return (
    <div className="home-ctrls">
      <button className="ib home-top-search" aria-label="Search everything" onClick={() => window.dispatchEvent(new Event("vigie:palette"))}>
        <Icon name="search" />
      </button>
      {shell?.ai && (
        <button className="btn home-ask" aria-label="Ask Vigie" onClick={onAsk}>
          <Icon name="spark" />
          <span>Ask</span>
        </button>
      )}
      {environments().length > 1 && (
        <div className="seg env" role="group" aria-label="Environment">
          <Glide on={scope.env} />
          {environments().map((env) => (
            <button key={env} className={scope.env === env ? "on" : ""} aria-pressed={scope.env === env} onClick={() => set({ env })}>
              {ENV_LABEL[env]}
            </button>
          ))}
        </div>
      )}
      <ScopePicker services={shell?.services ?? []} />
      <button className={`btn home-live ${scope.live ? "on" : ""}`} aria-pressed={scope.live} aria-label="Live" onClick={() => set({ live: scope.live ? undefined : true })}>
        <span className="livedot" />
        <Icon name="uptime" className="home-live-i" />
        <span>Live</span>
      </button>
    </div>
  );
}

const SPINE_SERIES = [
  { key: "info", color: "var(--a)", label: "Info" },
  { key: "warn", color: "var(--warn)", label: "Warn" },
  { key: "error", color: "var(--err)", label: "Error" },
];

export function Spine() {
  const scope = useScope();
  const set = useSetScope();
  const q = useScoped(timelineFn, {});
  return (
    <div className="spine">
      <Brush from={scope.from} to={scope.to} onZoom={(from, to) => set({ from, to, range: undefined })}>
        <Bars data={q.data ?? []} height={33} label="Events over time" compactMode series={SPINE_SERIES} />
        {scope.custom && (
          <button className="bclear" onPointerDown={(event) => event.stopPropagation()} onClick={() => set({ from: undefined, to: undefined })}>
            Clear {axisLabel(scope.from, scope.to - scope.from)}–{axisLabel(scope.to, scope.to - scope.from)}
          </button>
        )}
      </Brush>
      <div className="axis">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i}>{axisLabel(scope.from + ((scope.to - scope.from) * i) / 6, scope.to - scope.from)}</span>
        ))}
      </div>
    </div>
  );
}

const GOTO: Record<string, string> = { o: "/", l: "/logs", t: "/tasks", r: "/requests", q: "/queries", i: "/issues", a: "/alerts", d: "/dashboards", p: "/processes", s: "/settings/services", m: "/metrics", e: "/external", b: "/database", c: "/console", x: "/traces" };

type Hit = { label: string; to: string; kind: string; icon?: string; search?: Record<string, string> };
const PAGES: Hit[] = [
  ...NAV.flatMap(({ items }) => items.map((item): Hit => ({ label: item.label, to: item.to, kind: "Go to", icon: item.icon }))),
  { label: "All tasks", to: "/tasks/all", kind: "Go to", icon: "tasks" },
  { label: "Bulk actions", to: "/tasks/bulk", kind: "Go to", icon: "tasks" },
  { label: "New alert", to: "/alerts/new", kind: "Create", icon: "plus" },
  ...[["services", "Services and keys"], ["storage", "Retention and storage"], ["channels", "Notification channels"], ["members", "Members and access"], ["tokens", "Tokens"], ["extensions", "Extensions"], ["redaction", "Redaction"], ["audit", "Audit log"]].map(([id, label]): Hit => ({ label: label!, to: `/settings/${id}`, kind: "Settings", icon: "gear" })),
];
const KIND_ICON: Record<string, string> = { Trace: "traces", "Task run": "tasks", Route: "requests", "Task kind": "tasks", Issue: "issues", Dashboard: "dash", "Your page": "biz", Search: "logs" };
/** The order groups read in, whatever arrives first: an exact id is what you came for, then where you asked to go. */
const GROUP_ORDER = ["Trace", "Task run", "Recent", "Go to", "Route", "Task kind", "Issue", "Dashboard", "Your page", "Settings", "Create", "Search"];
const GROUP_NAME: Record<string, string> = { Trace: "Traces", "Task run": "Task runs", Route: "Routes", "Task kind": "Task kinds", Issue: "Issues", Dashboard: "Dashboards", "Your page": "Your pages", Search: "Search" };

const RECENT_KEY = "vigie.recent";
const readRecent = (): Hit[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Hit[];
  } catch {
    return [];
  }
};
const keepRecent = (hit: Hit) => {
  try {
    const next = [{ ...hit, kind: hit.kind === "Recent" ? "Go to" : hit.kind }, ...readRecent().filter((h) => h.to !== hit.to || h.label !== hit.label)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
};

/** A pasted id, bare or inside a link. */
const pastedId = (text: string) => {
  const inLink = text.match(/(?:traces|requests|run)\/([0-9a-z-]{8,})/i);
  const value = (inLink?.[1] ?? text).trim();
  return /^[0-9a-f]{16,32}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) ? value : "";
};

/** Letters in order count as a match: "exc" finds External calls. Whole words and starts rank first. */
function matchOf(label: string, q: string): { score: number; at: Set<number> } | null {
  if (!q) return { score: 1, at: new Set() };
  const low = label.toLowerCase();
  const start = low.indexOf(q);
  if (start >= 0) {
    const wordStart = start === 0 || /[\s./_-]/.test(low[start - 1]!);
    return { score: (start === 0 ? 300 : wordStart ? 200 : 100) - label.length / 100, at: new Set(Array.from({ length: q.length }, (_, i) => start + i)) };
  }
  const at = new Set<number>();
  let from = 0;
  for (const char of q) {
    const found = low.indexOf(char, from);
    if (found < 0) return null;
    at.add(found);
    from = found + 1;
  }
  return { score: 10 - label.length / 100, at };
}

function Marked({ text, at }: { text: string; at?: Set<number> }) {
  if (!at?.size) return <>{text}</>;
  return <>{[...text].map((char, i) => (at.has(i) ? <mark key={i}>{char}</mark> : char))}</>;
}

function Palette({ shell }: { shell: ShellData | undefined }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const scope = useScope();
  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("vigie:palette", show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("vigie:palette", show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  // Local results answer on the keystroke. The server is asked a moment later, and old answers stay until new ones land.
  useEffect(() => {
    const id = pastedId(text);
    const timer = setTimeout(() => setAsked(id || text.trim()), id ? 0 : 120);
    return () => clearTimeout(timer);
  }, [text]);
  const found = useQuery({ queryKey: ["search", asked, scope.env], queryFn: () => searchFn({ data: { q: asked, env: scope.env } }), enabled: open && asked.length >= 2, staleTime: 5000, placeholderData: (previous) => previous });
  const boards = useQuery({ queryKey: ["palette-dashboards"], queryFn: () => dashboardsFn(), enabled: open, staleTime: 60_000 });
  const q = text.toLowerCase().trim();
  const id = pastedId(text);
  const hits = useMemo(() => {
    const local: Hit[] = [
      ...PAGES,
      ...(shell?.pages ?? []).map((p): Hit => ({ label: p.title, to: `/p/${p.id}`, kind: "Your page" })),
      ...(boards.data ?? []).map((d): Hit => ({ label: d.title, to: `/dashboards/${d.id}`, kind: "Dashboard" })),
    ];
    const scored = (id ? [] : local).flatMap((hit) => {
      const match = matchOf(hit.label, q);
      return match ? [{ hit, match }] : [];
    });
    if (q) scored.sort((a, b) => b.match.score - a.match.score);
    const remote = asked.length >= 2 && q ? (found.data ?? []).map((hit) => ({ hit: hit as Hit, match: matchOf(hit.label, q) ?? { score: 0, at: new Set<number>() } })) : [];
    const recent = !q ? readRecent().map((hit) => ({ hit: { ...hit, kind: "Recent" }, match: { score: 0, at: new Set<number>() } })) : [];
    const shown = !q ? scored.filter(({ hit }) => hit.kind === "Go to") : scored;
    const all = [...recent, ...remote, ...shown];
    if (q.length >= 2 && !id) all.push({ hit: { label: `Search logs for "${text.trim()}"`, to: "/logs", kind: "Search", search: { q: text.trim() } }, match: { score: 0, at: new Set() } });
    if (id) all.push({ hit: { label: `Search logs for ${id}`, to: "/logs", kind: "Search", search: { q: id } }, match: { score: 0, at: new Set() } });
    return all.sort((a, b) => GROUP_ORDER.indexOf(a.hit.kind) - GROUP_ORDER.indexOf(b.hit.kind));
  }, [q, id, text, asked, found.data, boards.data, shell?.pages]);
  const idMissing = Boolean(id) && asked === id && !found.isFetching && !hits.some(({ hit }) => hit.kind === "Trace" || hit.kind === "Task run");
  useEffect(() => {
    list.current?.querySelector(".cmdi.on")?.scrollIntoView({ block: "nearest" });
  }, [index, hits]);
  const close = () => {
    setOpen(false);
    setText("");
    setAsked("");
    setIndex(0);
  };
  const go = (hit: Hit) => {
    keepRecent(hit);
    close();
    void navigate({ to: hit.to, search: (prev: Record<string, unknown>) => ({ ...prev, ...hit.search }) } as never);
  };
  let lastGroup = "";
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dlgback" />
        <Dialog.Popup className="cmdb home-cmd" style={{ position: "fixed", left: "50%", top: "12vh", transform: "translateX(-50%)", zIndex: 71, width: "min(640px, calc(100% - 32px))", outline: "none" }} aria-label="Search everything">
          <div className="home-cmd-in">
            <Icon name="search" />
            <input
              id="cmdq"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={text}
              placeholder="Jump to a page, route, task kind, or paste a trace id"
              onChange={(e) => {
                setText(e.target.value);
                setIndex(0);
              }}
              onKeyDown={(event) => {
                const down = event.key === "ArrowDown" || (event.ctrlKey && event.key === "j");
                const up = event.key === "ArrowUp" || (event.ctrlKey && event.key === "k");
                if (down) {
                  event.preventDefault();
                  setIndex((i) => (hits.length ? (i + 1) % hits.length : 0));
                } else if (up) {
                  event.preventDefault();
                  setIndex((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0));
                } else if (event.key === "Enter" && hits[index]) go(hits[index]!.hit);
              }}
            />
            {found.isFetching && <span className="home-cmd-busy" aria-label="Searching" />}
          </div>
          <div className="cmdl" ref={list}>
            {idMissing && <div className="home-cmd-none">No trace or task run has this id.</div>}
            {hits.map(({ hit, match }, i) => {
              const head = hit.kind !== lastGroup;
              lastGroup = hit.kind;
              const route = hit.kind === "Route" ? hit.label.match(/^(\S+)\s+(.*)$/) : null;
              return (
                <div key={`${hit.kind}${hit.to}${hit.label}${JSON.stringify(hit.search ?? {})}`} style={{ display: "contents" }}>
                  {head && <div className="home-cmd-group">{GROUP_NAME[hit.kind] ?? hit.kind}</div>}
                  <button className={`cmdi ${i === index ? "on" : ""}`} onClick={() => go(hit)} onMouseMove={() => { if (i !== index) setIndex(i); }}>
                    <Icon name={hit.icon ?? KIND_ICON[hit.kind] ?? "chev"} />
                    <span className={`ell ${route || hit.kind === "Task kind" || hit.kind === "Trace" || hit.kind === "Task run" ? "mono" : ""}`}>
                      {route ? <Entry text={hit.label} /> : <Marked text={hit.label} at={match.at} />}
                    </span>
                    {i === index && <small>↵</small>}
                  </button>
                </div>
              );
            })}
            {!hits.length && !idMissing && <div className="home-cmd-none">Nothing matches "{text.trim()}".</div>}
          </div>
          <div className="home-cmd-foot">
            <span><span className="kbd">↑</span><span className="kbd">↓</span> move</span>
            <span><span className="kbd">↵</span> open</span>
            <span><span className="kbd">esc</span> close</span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Shortcuts() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const pending = useRef(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      // Esc in a page's search clears it. React only hears a value set through the native setter.
      if (event.key === "Escape" && target.matches(".main .sb input")) {
        const input = target as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.blur();
        return;
      }
      if (target.closest("input,textarea,[contenteditable]") || event.metaKey || event.ctrlKey) return;
      if (event.key === "?") setOpen((v) => !v);
      if (event.key === "/") {
        const search = document.querySelector<HTMLInputElement>(".main .sb input");
        if (search) {
          event.preventDefault();
          search.focus();
        }
        return;
      }
      if ((event.key === "j" || event.key === "k") && !pending.current) {
        const rows = [...document.querySelectorAll<HTMLElement>(".main .home-keyrow")];
        if (rows.length) {
          event.preventDefault();
          const at = rows.indexOf(target.closest<HTMLElement>(".home-keyrow") as HTMLElement);
          const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (event.key === "j" ? 1 : -1)))];
          next?.focus();
          next?.scrollIntoView({ block: "nearest" });
          return;
        }
      }
      if (pending.current) {
        pending.current = false;
        const to = GOTO[event.key];
        if (to) void navigate({ to, search: (prev: Record<string, unknown>) => prev } as never);
        return;
      }
      if (event.key === "g") {
        pending.current = true;
        setTimeout(() => (pending.current = false), 900);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dlgback" />
        <Dialog.Popup className="dlg">
          <Dialog.Title className="dlgt">Keyboard</Dialog.Title>
          <div className="kvg" style={{ marginTop: 8 }}>
            {[["⌘K", "Search everything"], ["/", "Focus the page's search"], ["j k", "Next and previous row"], ["↵", "Open the row"], ["Esc", "Close a panel, clear a search"], ["g o", "Overview"], ["g l", "Logs"], ["g x", "Traces"], ["g r", "Requests"], ["g q", "Queries"], ["g i", "Issues"], ["g t", "Tasks"], ["g a", "Alerts"]].map(([key, label]) => (
              <div className="kvr" key={key}>
                <span className="k">
                  <span className="kbd">{key}</span>
                </span>
                <span className="val">{label}</span>
              </div>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Shell() {
  const path = useLocation({ select: (l) => l.pathname });
  const [navOpen, setNavOpen] = useState(false);
  const [ask, setAsk] = useState(false);
  const scope = useScope();
  const shell = useFn(shellFn, { env: scope.env }, { refetchInterval: 30_000 });
  useEffect(() => {
    const open = () => setAsk(true);
    window.addEventListener("vigie:ask", open);
    return () => window.removeEventListener("vigie:ask", open);
  }, []);
  useEffect(() => {
    if (shell.error && errorStatus(shell.error) === 401) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }, [shell.error]);
  const page = useRef<HTMLDivElement>(null);
  const shown = useRef(path);
  useEffect(() => {
    if (shown.current !== path) fadeIn(page.current);
    shown.current = path;
  }, [path]);
  const data = shell.data;
  const title = TITLES.find(([pattern]) => pattern.test(path))?.[1] ?? data?.pages.find((p) => path === `/p/${p.id}`)?.title ?? "Vigie";
  const lastEventAt = data?.ingest.lastEventAt ?? 0;
  return (
    <div id="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <SideNav shell={data} open={navOpen} onNavigate={() => setNavOpen(false)} />
      <div className={`home-scrim ${navOpen ? "on" : ""}`} aria-hidden="true" onClick={() => setNavOpen(false)} />
      <main className="main" id="main">
        <header className="top home-top">
          <button className="ib navtoggle" aria-label="Menu" onClick={() => setNavOpen((v) => !v)}>
            <Icon name="menu" />
          </button>
          <span className="ttl">{title}</span>
          <span className="grow" />
          <Controls shell={data} onAsk={() => setAsk((v) => !v)} />
        </header>
        {shell.error && errorStatus(shell.error) !== 401 && <div className="banner bad">Vigie cannot reach its data right now. {errorText(shell.error)}</div>}
        {data && data.ingest.flushErrors > 0 && data.ingest.spooled > 0 && <div className="banner" title={data.ingest.lastError}>{/MEMORY_LIMIT|memory limit/i.test(data.ingest.lastError ?? "") ? "ClickHouse is out of memory" : "ClickHouse refused writes"}. {data.ingest.spooled} rows are safe on disk and will replay.</div>}
        {lastEventAt > 0 && Date.now() - lastEventAt > 10 * 60_000 && <div className="banner">No telemetry arrived since {ago(lastEventAt)}. Check that your services still export to Vigie.</div>}
        {SPINE.test(path) && <Spine />}
        <div className="page" ref={page}>
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </div>
      </main>
      <Palette shell={data} />
      <Shortcuts />
      {ask && (
        <Suspense fallback={null}>
          <AskPanel onClose={() => setAsk(false)} />
        </Suspense>
      )}
    </div>
  );
}
