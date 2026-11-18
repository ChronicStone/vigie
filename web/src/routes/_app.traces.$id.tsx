import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { z } from "zod";
import type { View } from "@sdk";
import type { SpanRow, TraceLog } from "@server/api/traces.ts";
import { Block } from "@web/components/blocks.tsx";
import { Hl } from "@web/components/code.tsx";
import { Icon } from "@web/components/icons.tsx";
import { originOf, SpanInspector, totalOf, TraceWaterfall } from "@web/components/trace-view.tsx";
import { Back, copy, Entry, Id, Kv, Load, Method, RoutePath, Tabs, WhyFix } from "@web/components/ui.tsx";
import { spanKind } from "@web/components/waterfall.tsx";
import { hostPressureFn, routeFn } from "@web/fns/backend.ts";
import { aiExplainFn, aiStatusFn, logEventFn, traceFn } from "@web/fns/explore.ts";
import { errorText, useFn, useScoped } from "@web/lib/api.ts";
import { dayMonth, fms, hms, shortService, statusClass } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const TABS = ["logs", "queries", "slowest", "source", "event"] as const;
const search = z.object({ tab: z.enum(TABS).optional().catch(undefined), span: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/traces/$id")({ validateSearch: search, component: TracePage });

type Tab = (typeof TABS)[number];
type Event = Awaited<ReturnType<typeof logEventFn>>;

const SHARE = [["app", "Your code", "var(--app)"], ["db", "Database", "var(--db)"], ["ext", "HTTP calls", "var(--ext)"], ["cache", "Cache", "var(--cache)"]] as const;

/** Time a span spent in itself, once its children are taken out. This is what makes the slow line stand out. */
function ownTimes(spans: SpanRow[]) {
  const children = new Map<string, number>();
  for (const span of spans) children.set(span.parent, (children.get(span.parent) ?? 0) + span.duration);
  return spans.map((span) => ({ span, own: Math.max(0, span.duration - (children.get(span.id) ?? 0)) }));
}

/** The same statement run again and again is the likeliest cause of a slow execution, so it is grouped, not listed. */
function statementsOf(spans: SpanRow[]) {
  const groups = new Map<string, { statement: string; first: string; n: number; ms: number }>();
  for (const span of spans) {
    if (!span.statement) continue;
    const entry = groups.get(span.statement) ?? { statement: span.statement, first: span.id, n: 0, ms: 0 };
    entry.n++;
    entry.ms += span.duration;
    groups.set(span.statement, entry);
  }
  return [...groups.values()].sort((a, b) => Number(b.n > 3) - Number(a.n > 3) || b.ms - a.ms);
}

/** Back goes where you came from, with its filters. A shared link has nowhere to return to, so it lands on the list. */
function BackFrom() {
  const router = useRouter();
  return router.history.canGoBack() ? <Back title="Back" /> : <Back to="/traces" title="Back to traces" />;
}

function Identity({ event, root }: { event?: Event; root?: SpanRow }) {
  if (event?.kind === "request") {
    return (
      <Link className="trace-entry" to="/requests/route" search={((prev: Record<string, unknown>) => ({ env: prev.env, range: prev.range, from: prev.from, to: prev.to, method: event.method, route: event.route })) as never} title="Open this route">
        <Method m={event.method} />
        <span className="trace-path"><RoutePath path={event.route || event.attrs.path || ""} /></span>
      </Link>
    );
  }
  if (event?.kind === "task") {
    return (
      <span className="trace-entry">
        <span className="mth m-task">task</span>
        <span className="trace-path">{event.taskKind}</span>
      </span>
    );
  }
  return <span className="trace-entry"><span className="trace-path"><Entry text={root?.name ?? "Trace"} /></span></span>;
}

/** The first thing on the page: did it work, how long did it take, and against what is that slow. */
function verdictOf(event: Event | undefined, failing: SpanRow[], root: SpanRow | undefined) {
  const status = event?.status || root?.httpStatus || 0;
  const hardFail = event?.kind === "task" ? event.outcome === "failed" || event.level === "error" : status >= 500 || event?.level === "error" || (!event && root?.status === "Error");
  if (hardFail) return { word: event?.kind === "task" ? "Failed" : status ? `Failed with ${status}` : "Failed", tone: "err" };
  if (status >= 400) return { word: event?.outcome === "denied" ? `Denied with ${status}` : `Refused with ${status}`, tone: statusClass(status) };
  if (failing.length) return { word: `${status ? `Answered ${status}` : "Finished"}, ${failing.length} ${failing.length === 1 ? "call" : "calls"} failed`, tone: "warn" };
  return { word: status ? `Answered ${status}` : "Finished", tone: "" };
}

function TimeShare({ spans }: { spans: SpanRow[] }) {
  const parts = useMemo(() => {
    const sums: Record<string, number> = { app: 0, db: 0, ext: 0, cache: 0 };
    for (const { span, own } of ownTimes(spans)) {
      const kind = spanKind(span);
      sums[kind === "task" ? "app" : kind] = (sums[kind === "task" ? "app" : kind] ?? 0) + own;
    }
    return SHARE.map(([key, label, color]) => ({ key, label, color, ms: sums[key] ?? 0 })).filter((part) => part.ms > 0);
  }, [spans]);
  const whole = parts.reduce((sum, part) => sum + part.ms, 0) || 1;
  if (!parts.length) return null;
  return (
    <div className="trace-share" aria-label="Where the time went">
      <div className="xbar">
        {parts.map((part) => <i key={part.key} title={`${part.label}, ${fms(part.ms)}`} style={{ flexGrow: part.ms, flexBasis: 0, background: part.color }} />)}
      </div>
      <div className="xleg">
        {parts.map((part) => <span key={part.key}><i style={{ background: part.color }} />{part.label} <b>{fms(part.ms)}</b></span>)}
      </div>
    </div>
  );
}

function Frames({ stack }: { stack: string }) {
  const frames = stack.split("\n").slice(1).map((line) => line.trim().replace(/^at /, ""));
  const mine = frames.filter((f) => !f.includes("node_modules") && !f.startsWith("node:"));
  const rest = frames.length - mine.length;
  return (
    <div className="trace-frames">
      <div className="frame"><span className="err">{stack.split("\n")[0]}</span></div>
      {mine.map((frame) => {
        const match = frame.match(/^(.*?) \((.*)\)$/);
        return <div className="frame" key={frame}><span className="hl-function">{match?.[1] ?? frame}</span>{match && <span><Hl lang="place">{match[2]!}</Hl></span>}</div>;
      })}
      {rest > 0 && <div className="frame t4">{rest} {rest === 1 ? "frame" : "frames"} in dependencies and Node internals</div>}
    </div>
  );
}

function TraceLogs({ logs, origin, many }: { logs: TraceLog[]; origin: number; many: boolean }) {
  return (
    <>
      {logs.map((log) => (
        <Link key={log.id} className={`trace-log ${many ? "many" : ""}`} to="/logs" search={((prev: Record<string, unknown>) => ({ env: prev.env, range: prev.range, from: prev.from, to: prev.to, event: log.id, kind: "both" })) as never} title="Open this event in Logs">
          <span className="trace-at">+{fms(Math.max(0, log.t - origin))}</span>
          <span className={`lvd ${log.level}`} />
          {many && <span className="t3 ell">{shortService(log.service)}</span>}
          <span className={`ell ${log.level === "error" ? "err" : ""}`}><Hl>{log.body}</Hl></span>
        </Link>
      ))}
    </>
  );
}

function TraceQueries({ statements, onSelect }: { statements: ReturnType<typeof statementsOf>; onSelect: (id: string) => void }) {
  const max = Math.max(1, ...statements.map((s) => s.ms));
  return (
    <>
      {statements.map((s) => (
        <button className="trace-query" key={s.statement} onClick={() => onSelect(s.first)} title="Show in the waterfall">
          <span className="trace-sql ell"><Hl lang="sql">{s.statement}</Hl></span>
          <span className={`mono ${s.n > 3 ? "warn" : "t3"}`}>×{s.n}</span>
          <span className="share"><i style={{ scale: `${s.ms / max} 1`, background: s.n > 3 ? "var(--warn)" : "var(--db)" }} /></span>
          <span className="mono t2">{fms(s.ms)}</span>
        </button>
      ))}
    </>
  );
}

function TraceSlowest({ spans, onSelect }: { spans: SpanRow[]; onSelect: (id: string) => void }) {
  const rows = useMemo(() => ownTimes(spans).sort((a, b) => b.own - a.own).slice(0, 100), [spans]);
  const max = Math.max(1, ...rows.map((row) => row.own));
  return (
    <>
      {rows.map(({ span, own }) => (
        <button className="trace-query" key={span.id} onClick={() => onSelect(span.id)} title="Show in the waterfall">
          <span className="ell"><Entry text={span.name.replace(/^pg\.query:/, "")} /></span>
          <span />
          <span className="share"><i style={{ scale: `${own / max} 1`, background: "var(--t3)" }} /></span>
          <span className="mono t2">{fms(own)}</span>
        </button>
      ))}
    </>
  );
}

function WideEvent({ event }: { event: Event }) {
  return (
    <>
      {event.view.sections.map((section) => (
        <div className="rd" key={section.title}>
          <div className="rdh"><span>{section.title}</span><span className="src">{section.source}</span></div>
          {(section.children as View[]).map((child, i) => <Block key={i} view={child} />)}
        </div>
      ))}
      <div className="rd" style={{ borderBottom: 0 }}>
        <div className="rdh"><span>All other fields</span><span className="src">{event.view.rest.length}</span></div>
        <div className="kvg">{event.view.rest.map((key) => <Kv key={key} k={key}>{event.attrs[key] ?? ""}</Kv>)}</div>
      </div>
    </>
  );
}

function TracePage() {
  const { id } = Route.useParams();
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const scope = useScope();
  const q = useFn(traceFn, { id });
  const spans = q.data?.spans;
  const logs = q.data?.logs;
  const wide = logs?.find((l) => l.kind === "request" || l.kind === "task");
  const event = useFn(logEventFn, { id: wide?.id ?? "" }, { enabled: Boolean(wide) });
  const e = event.data;
  const route = useScoped(routeFn, { method: e?.method ?? "", route: e?.route ?? "" }, { enabled: Boolean(e?.route) });
  const firstSpan = spans?.[0];
  const pressure = useFn(hostPressureFn, { env: scope.env, at: firstSpan?.start ?? 0, service: firstSpan?.service ?? "" }, { enabled: Boolean(firstSpan) });
  const ai = useFn(aiStatusFn, undefined, { staleTime: Infinity }).data?.enabled;
  const explain = useMutation({ mutationFn: (data: { traceId: string }) => aiExplainFn({ data }) });
  const patch = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea")) return;
      if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        document.getElementById("traceFind")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Load q={q}>
      {({ spans, logs, truncated }) => {
        const origin = originOf(spans, logs);
        const total = totalOf(spans, logs, origin);
        const root = spans.find((span) => !span.parent) ?? spans[0];
        const failing = spans.filter((span) => span.status === "Error" || span.httpStatus >= 400);
        const error = e?.view.error;
        const explained = logs.find((log) => log.why);
        const why = error?.why ?? explained?.why;
        const fix = error?.fix ?? explained?.fix;
        const duration = e?.duration || total;
        const verdict = verdictOf(e, failing, root);
        const own = ownTimes(spans);
        const slowest = own.reduce<(typeof own)[number] | undefined>((best, row) => (!best || row.own > best.own ? row : best), undefined);
        const current = spans.find((span) => span.id === s.span) ?? failing[failing.length - 1] ?? slowest?.span;
        const statements = statementsOf(spans);
        const queryCount = statements.reduce((sum, st) => sum + st.n, 0);
        const repeated = statements.filter((st) => st.n > 3).sort((a, b) => b.n - a.n)[0];
        const stats = route.data?.stats;
        const usual = stats && stats.count > 1 && stats.p95 > 0 ? stats : undefined;
        const slow = usual ? duration > usual.p95 : duration >= 800;
        const services = new Set(spans.map((span) => span.service));
        const options: [Tab, string][] = [];
        if (logs.length) options.push(["logs", `Logs ${logs.length}`]);
        if (statements.length) options.push(["queries", `Queries ${queryCount}`]);
        if (spans.length > 3) options.push(["slowest", "Slowest"]);
        if (error?.stack) options.push(["source", "Error source"]);
        if (e) options.push(["event", "Wide event"]);
        const preferred: Tab = error?.stack ? "source" : logs.length ? "logs" : "queries";
        const tab = options.some(([key]) => key === s.tab) ? s.tab! : options.some(([key]) => key === preferred) ? preferred : options[0]?.[0];
        const select = (spanId: string) => patch({ span: spanId });
        const userId = e?.attrs["user.id"];
        return (
          <div className="trace-page">
            <div className="dh">
              <BackFrom />
              <h2><Identity event={e} root={root} /></h2>
              <span className="dhr">
                <Id value={id} keep={12} className="trace-id" />
                {e?.kind === "task" && e.taskId && <Link className="btn" to="/tasks/run/$id" params={{ id: e.taskId }}>Open run</Link>}
                {ai && <button className="btn" disabled={explain.isPending} onClick={() => explain.mutate({ traceId: id })}><Icon name="spark" />{explain.isPending ? "Reading…" : "Explain"}</button>}
                <button className="btn" onClick={() => copy(`Investigate trace ${id}.\n${e?.body ?? root?.name ?? ""}\nwhy: ${why ?? ""}\nfix: ${fix ?? ""}\nSpans:\n${spans.slice(0, 80).map((span) => `${Math.round(span.start - origin)}ms ${span.name} ${Math.round(span.duration)}ms ${span.status}`).join("\n")}${e ? `\nFields:\n${JSON.stringify(e.attrs, null, 2)}` : ""}`, "Agent prompt copied")}><Icon name="copy" />Agent prompt</button>
              </span>
            </div>
            <div className="trace-verdict">
              <div className="trace-answer">
                <div className="trace-line">
                  <b className={`trace-word ${verdict.tone}`}>{verdict.word}</b>
                  <b className={`trace-time ${slow && !verdict.tone ? "warn" : ""}`}>{fms(duration)}</b>
                  {usual && <span className="trace-usual">{duration > usual.p95 * 1.5 ? `${(duration / usual.avg).toFixed(1)}× the usual ${fms(usual.avg)}` : `usually ${fms(usual.avg)}, p95 ${fms(usual.p95)}`}</span>}
                </div>
                <div className="trace-facts">
                  {root && <span>{dayMonth(root.start)}, {hms(root.start)}</span>}
                  <span>{[...services].map(shortService).join(", ")}{root?.version ? ` ${root.version.slice(0, 8)}` : ""}</span>
                  {e?.attrs["workspace.accountId"] && <span>{e.attrs["workspace.accountId"]}</span>}
                  {userId && <Link className="lnk" to="/users/$id" params={{ id: userId }}>{userId}</Link>}
                </div>
                {(why || fix) && <WhyFix why={why} fix={fix} link={error?.link} style={{ margin: "10px 0 0" }} />}
                {repeated && (
                  <button className="trace-repeat" onClick={() => { patch({ tab: "queries", span: repeated.first }); }}>
                    <b>The same query ran {repeated.n} times.</b> <span className="t3">Load these rows once with an IN clause.</span>
                  </button>
                )}
                {slow && pressure.data && pressure.data.length > 0 && (
                  <p className="trace-pressure"><b>Under host pressure.</b> {pressure.data.map((p) => `${p.label} was ${(p.near / p.base).toFixed(1)} times its level of the hour before`).join(", ")}. This may be why it was slow, not the code.</p>
                )}
              </div>
              <TimeShare spans={spans} />
            </div>
            {explain.data && <div className="dnote">{explain.data.text}</div>}
            {explain.error && <div className="dnote err">{errorText(explain.error)}</div>}
            <div className="trace-body">
              <div className="trace-main">
                {spans.length > 0 && (
                  <div className="trace-wf">
                    <TraceWaterfall spans={spans} logs={logs} selected={current?.id ?? null} onSelect={select} marks truncated={truncated} findId="traceFind" keyboard />
                  </div>
                )}
                {options.length > 0 && (
                  <div className="trace-evidence">
                    <Tabs value={tab!} onChange={(value) => patch({ tab: value })} options={options} />
                    <div className="trace-pane">
                      {tab === "logs" && <TraceLogs logs={logs} origin={origin} many={services.size > 1} />}
                      {tab === "queries" && <TraceQueries statements={statements} onSelect={select} />}
                      {tab === "slowest" && <TraceSlowest spans={spans} onSelect={select} />}
                      {tab === "source" && error?.stack && <Frames stack={error.stack} />}
                      {tab === "event" && e && <WideEvent event={e} />}
                    </div>
                  </div>
                )}
              </div>
              {current && (
                <aside className="trace-side" aria-label="Selected span">
                  <SpanInspector span={current} spans={spans} total={total} />
                </aside>
              )}
            </div>
          </div>
        );
      }}
    </Load>
  );
}
