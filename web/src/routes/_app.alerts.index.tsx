import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Icon } from "@web/components/icons.tsx";
import { KeepScroll, useRowKeys } from "@web/components/reliability.tsx";
import { Empty, Levels, Load, SearchBox } from "@web/components/ui.tsx";
import { alertsFn } from "@web/fns/reliability.ts";
import { useFn } from "@web/lib/api.ts";
import { ago, span } from "@web/lib/format.ts";
import { alertValue } from "@web/lib/labels.ts";

const search = z.object({
  f: z.enum(["all", "code", "app"]).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  paused: z.boolean().optional().catch(undefined),
});
export const Route = createFileRoute("/_app/alerts/")({ validateSearch: search, component: AlertsPage });

type Row = Awaited<ReturnType<typeof alertsFn>>[number];

/** The list's filters travel with the row, so Back on the alert returns to the list as it was. */
const KEEP_LIST = ((prev: Record<string, unknown>) => prev) as never;

const limitOf = (a: Row) => {
  const limit = a.rule.above ?? a.rule.below;
  return limit === undefined ? "" : `${a.rule.below !== undefined ? "needs at least" : "limit"} ${limit}${a.rule.unit ? ` ${a.rule.unit}` : ""}`;
};
const history = (a: Row) => {
  if (!a.last_fired) return "Never fired";
  if (!a.fired30d) return `Last fired ${ago(a.last_fired)}`;
  return `Fired ${a.fired30d === 1 ? "once" : `${a.fired30d} times`} in 30 days, last ${ago(a.last_fired)}`;
};

function FiringRow({ alert }: { alert: Row }) {
  return (
    <Link data-row className="alerts-firing" to="/alerts/$id" params={{ id: alert.id }} search={KEEP_LIST}>
      <span className="alerts-what">
        <span className="alerts-loud">{alert.name}</span>
        <span className="alerts-rule">{alert.rule.condition}</span>
      </span>
      <span className="alerts-now">
        <b>{alertValue(alert) || "Firing"}</b>
        <small>{limitOf(alert)}</small>
      </span>
      <span className="alerts-for">
        <b>{alert.since ? `For ${span(Date.now() - alert.since)}` : "Firing"}</b>
        <small>{alert.fired30d > 1 ? `${alert.fired30d} times in 30 days` : "First time in 30 days"}</small>
      </span>
    </Link>
  );
}

function QuietRow({ alert, note, tone }: { alert: Row; note?: string; tone?: string }) {
  const now = alertValue(alert);
  return (
    <Link data-row className="alerts-row" to="/alerts/$id" params={{ id: alert.id }} search={KEEP_LIST}>
      <span className="alerts-name">{alert.name}</span>
      <span className="alerts-sentence">{alert.rule.condition}{now && !alert.paused ? <span className="t3">. Now {now}.</span> : null}</span>
      <span className={`alerts-last ${tone ?? ""}`}>{note ?? history(alert)}</span>
    </Link>
  );
}

function AlertsPage() {
  const { f = "all", q: text = "", paused: showPaused } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useFn(alertsFn, undefined);
  const set = (patch: z.infer<typeof search>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  useRowKeys({ search: "alQ", onClear: () => set({ q: undefined }) });
  return (
    <Load q={q}>
      {(rows) => {
        const code = rows.filter((a) => a.managed_in === "code").length;
        const app = rows.length - code;
        const needle = text.toLowerCase();
        const shown = rows.filter((a) => (f === "all" || a.managed_in === f) && (!needle || `${a.name} ${a.rule.condition ?? ""}`.toLowerCase().includes(needle)));
        const paused = shown.filter((a) => a.paused);
        const live = shown.filter((a) => !a.paused);
        const firing = live.filter((a) => a.state === "firing" && !a.error).sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
        const broken = live.filter((a) => a.error);
        const watching = live.filter((a) => a.state !== "firing" && !a.error);
        // Where an alert is managed only says something when both kinds exist.
        const options = code && app ? ([["all", <>All <b>{rows.length}</b></>], ["code", <>In code <b>{code}</b></>], ["app", <>In the app <b>{app}</b></>]] as const) : [];
        return (
          <>
            <div className="subbar alerts-bar">
              {/* What is firing is the first row below, so it is not said twice. */}
              {firing.length === 0 && <span className="alerts-answer">{live.length ? "Nothing is firing" : "Nothing is watching right now"}</span>}
              <Levels value={f} onChange={(value) => set({ f: value === "all" ? undefined : value })} options={options as never} />
              <span className="grow" />
              <SearchBox id="alQ" value={text} onChange={(value) => set({ q: value || undefined })} placeholder="Search alerts" />
              <Link className="btn pri" to="/alerts/new" search={{ method: undefined, route: undefined }}><Icon name="plus" />New alert</Link>
            </div>
            <div className="ov alerts" data-testid="alerts">
              <KeepScroll id={`alerts:${f}:${text}:${Boolean(showPaused)}`} />
              {!rows.length && <Empty title="Nothing is watching yet" hint="An alert tells you when a route slows down, tasks start failing, or something stops running."><Link className="btn" style={{ marginTop: 12 }} to="/alerts/new" search={{ method: undefined, route: undefined }}>Write the first one</Link></Empty>}
              {rows.length > 0 && !shown.length && <Empty title="No alert matches"><button className="btn" style={{ marginTop: 12 }} onClick={() => set({ q: undefined, f: undefined })}>Clear the search</button></Empty>}
              {firing.length > 0 && <section className="alerts-hot" aria-label="Firing">{firing.map((alert) => <FiringRow key={alert.id} alert={alert} />)}</section>}
              {broken.length > 0 && (
                <section className="alerts-group">
                  <h3 className="warn">Cannot evaluate</h3>
                  {broken.map((alert) => <QuietRow key={alert.id} alert={alert} note={alert.error ?? ""} tone="warn" />)}
                </section>
              )}
              {watching.length > 0 && (
                <section className="alerts-group">
                  <h3>Watching</h3>
                  {watching.map((alert) => <QuietRow key={alert.id} alert={alert} />)}
                </section>
              )}
              {paused.length > 0 && (
                <section className="alerts-group alerts-paused">
                  <button className="alerts-fold" aria-expanded={Boolean(showPaused)} onClick={() => set({ paused: showPaused ? undefined : true })}>
                    <Icon name="chev" />Paused<span>{paused.length}</span>
                  </button>
                  {showPaused && paused.map((alert) => <QuietRow key={alert.id} alert={alert} note="Paused" />)}
                </section>
              )}
            </div>
          </>
        );
      }}
    </Load>
  );
}
