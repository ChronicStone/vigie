import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { Trend } from "@web/components/charts.tsx";
import { Hl } from "@web/components/code.tsx";
import { DashBars, DashHeat, DashLines, HealthStrip, Legend, Panel, Rank, Stat, useNear, type DashKey, type DashMark, type Ranked } from "@web/components/dash.tsx";
import { Icon } from "@web/components/icons.tsx";
import { Clock } from "@web/components/lanes.tsx";
import { copy, DataLink, Load, Sql } from "@web/components/ui.tsx";
import { settingsServicesFn } from "@web/fns/admin.ts";
import { emailsFn, externalFn, overviewDatabaseFn, overviewFn, overviewPeopleFn, overviewRuntimeFn, overviewTasksFn, overviewTrafficFn } from "@web/fns/backend.ts";
import { shellFn } from "@web/fns/explore.ts";
import { alertsFn, issuesFn, uptimeFn } from "@web/fns/reliability.ts";
import { useFn, useScoped } from "@web/lib/api.ts";
import { ago, bytes, compact, fms, hm, pct, shortService } from "@web/lib/format.ts";
import { ENV_LABEL, rememberRange, useScope, useSetScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/")({ component: OverviewPage });

type Overview = Awaited<ReturnType<typeof overviewFn>>;
type Traffic = Awaited<ReturnType<typeof overviewTrafficFn>>;

/** An environment that has never sent anything gets the way to connect, not a message about the time range. */
function NoData({ env, code }: { env: string; code: string }) {
  const q = useFn(settingsServicesFn, undefined);
  const scope = useScope();
  const set = useSetScope();
  if (!q.data) return <div className="home-quiet"><b>Nothing from {env} in this window</b></div>;
  const reported = q.data.services.filter((service) => service.environment === code);
  if (reported.length) {
    const last = Math.max(...reported.map((service) => service.last));
    return (
      <div className="home-quiet">
        <b>Nothing from {env} in this window</b>
        <span>Its last event was {ago(last)}.</span>
        {scope.range !== "24h" && <div><button className="btn" onClick={() => { rememberRange("24h"); set({ range: "24h", from: undefined, to: undefined }); }}>Show the last 24 hours</button></div>}
      </div>
    );
  }
  const local = q.data.mode === "local";
  const snippet = [`OTEL_EXPORTER_OTLP_ENDPOINT=${q.data.endpoint}`, ...(local ? [] : ["OTEL_EXPORTER_OTLP_HEADERS=authorization=<ingest key>"]), `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=${code}`].join("\n");
  return (
    <div className="home-connect">
      <b>{env} has not sent anything yet</b>
      <span>Give your service these variables. Its first requests show up here within seconds.</span>
      <Sql text={snippet} lang="env" />
      <div className="home-connect-do">
        <button className="btn" onClick={() => copy(snippet)}><Icon name="copy" />Copy</button>
        {local ? <span className="t3">Local mode accepts data without a key.</span> : <Link className="btn" to="/settings/$section" params={{ section: "services" }}>Create an ingest key</Link>}
      </div>
    </div>
  );
}

/* ---- The dashboard. ---- */

const label = (service: string) => {
  const short = shortService(service);
  return short.length <= 3 ? short.toUpperCase() : short[0]!.toUpperCase() + short.slice(1);
};
const mb = (value: number) => `${Math.round(value)} MB`;
const count = (value: number) => (value === 0 ? "0" : compact(value));
const ms = (value: number) => (value === 0 ? "0" : fms(value));
const SERVICE_COLORS = ["var(--a)", "#86AEE8", "var(--warn)"];
const serviceKeys = (services: { service: string }[]): DashKey[] => services.slice(0, 3).map((s, i) => ({ key: s.service, label: label(s.service), color: SERVICE_COLORS[i]! }));

const TRAFFIC_KEYS: DashKey[] = [{ key: "ok", label: "Fine", color: "var(--a)" }, { key: "warn", label: "4xx", color: "var(--warn)" }, { key: "error", label: "5xx", color: "var(--err)" }];
const RUN_KEYS: DashKey[] = [{ key: "done", label: "Finished", color: "var(--a)" }, { key: "skipped", label: "Skipped", color: "var(--t4)" }, { key: "failed", label: "Failed", color: "var(--err)" }];
const QUERY_KEYS: DashKey[] = [{ key: "ok", label: "Fine", color: "var(--a)" }, { key: "error", label: "Failed", color: "var(--err)" }];
const EMAIL_KEYS: DashKey[] = [{ key: "ok", label: "Sent", color: "var(--a)" }, { key: "error", label: "Failed", color: "var(--err)" }];
const QUEUE_KEYS: DashKey[] = [{ key: "scheduled", label: "Scheduled", color: "#86AEE8" }, { key: "due", label: "Due", color: "var(--a)" }];
const POOL_KEYS: DashKey[] = [{ key: "used", label: "Used", color: "var(--a)" }, { key: "idle", label: "Idle", color: "#86AEE8" }];
const PEOPLE_KEYS: DashKey[] = [{ key: "people", label: "People", color: "var(--a)" }];

const RouteName = ({ method, route }: { method: string; route: string }) => <><em>{method}</em> {route}</>;
const routeRow = (r: { method: string; route: string }, value: ReactNode, size: number, tone?: string): Ranked => ({ id: `${r.method} ${r.route}`, name: <RouteName method={r.method} route={r.route} />, value, size, tone, to: "/requests/route", search: { method: r.method, route: r.route } });
const kindRow = (r: { kind: string }, value: ReactNode, size: number, tone?: string): Ranked => ({ id: r.kind, name: r.kind, value, size, tone, to: "/tasks/kind/$kind", params: { kind: r.kind } });
const statementRow = (r: { hash: string; statement: string }, value: ReactNode, size: number): Ranked => ({ id: r.hash, name: <Hl lang="sql">{r.statement}</Hl>, value, size, to: "/queries/$hash", params: { hash: r.hash } });

/** A titled row of panels. It asks for its data once it is about to be seen. */
function Row<F extends (options: any) => Promise<any>>({ title, fn, height, children }: { title: string; fn: F; height: number; children: (data: Awaited<ReturnType<F>>) => ReactNode }) {
  const [ref, near] = useNear<HTMLDivElement>();
  const q = useScoped(fn, {} as never, { enabled: near });
  return (
    <div className="dg" ref={ref}>
      <h2 className="dg-h">{title}</h2>
      <Load q={q as never} skeleton={<div className="skel dg-skel" aria-busy="true" style={{ height }} />}>{(data) => children(data as Awaited<ReturnType<F>>)}</Load>
    </div>
  );
}

function Needs({ d, lastEvent }: { d: Overview; lastEvent: number }) {
  const stale = lastEvent > 0 && Date.now() - lastEvent > 10 * 60_000;
  const fresh = lastEvent > 0 && <span className={stale ? "warn" : ""}>Last event {ago(lastEvent)}</span>;
  if (!d.allNeeds.length) {
    return (
      <Panel span={4} title="All clear" sub={fresh} className="dn">
        <p className="dn-clear">Nothing failing, nothing new, no alert firing in this window.</p>
      </Panel>
    );
  }
  return (
    <Panel span={4} title="Needs you" sub={<>{d.allNeeds.length} open{lastEvent > 0 && ". "}{fresh}</>} className="dn" >
      <div className="dn-scroll">
        <div className="dn-in">
          {d.allNeeds.map((need) => (
            <DataLink key={need.title + need.detail} className={`dn-r ${need.tone}`} to={need.to} search={need.search}>
              <i className="dn-m" />
              <b className="ell">{need.title}</b>
              <span className="ell">{need.fact ?? need.detail}</span>
            </DataLink>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function Hero({ from, to, marks, data, overview, lastEvent }: { from: number; to: number; marks: DashMark[]; data?: Traffic; overview: Overview; lastEvent: number }) {
  const s = data?.stats;
  const minutes = Math.max(1, (to - from) / 60_000);
  return (
    <div className="dash-grid">
      <Panel span={8} title="Traffic" sub="Requests by outcome" to="/requests" right={<Legend keys={TRAFFIC_KEYS} />}>
        {s ? (
          <>
            <div className="dss">
              <Stat value={count(s.requests)} label={`${(s.requests / minutes).toFixed(s.requests / minutes < 10 ? 1 : 0)} a minute`} />
              <Stat value={pct((s.error / Math.max(s.requests, 1)) * 100)} label={`${count(s.error)} server errors`} tone={s.error / Math.max(s.requests, 1) >= 0.01 ? "err" : undefined} />
              <Stat value={ms(s.p50)} label="p50" />
              <Stat value={ms(s.p95)} label="p95" />
              <Stat value={ms(s.p99)} label="p99" />
              <Stat value={count(data!.people)} label="people active" />
            </div>
            <DashBars rows={data!.series} keys={TRAFFIC_KEYS} from={from} to={to} marks={marks} height={250} label="Requests by outcome" />
          </>
        ) : <div className="skel dg-skel" style={{ height: 300 }} />}
      </Panel>
      <Needs d={overview} lastEvent={lastEvent} />
    </div>
  );
}

function Api({ from, to, marks, data }: { from: number; to: number; marks: DashMark[]; data?: Traffic }) {
  if (!data) return null;
  return (
    <div className="dg">
      <h2 className="dg-h">API</h2>
      <div className="dash-grid">
        <Panel span={6} title="Request duration" sub="Every request, by how long it took. Brighter means more.">
          <DashHeat cells={data.heat} step={data.heatStep} from={from} to={to} marks={marks} height={186} />
        </Panel>
        <Panel span={3} title="Slowest routes" sub="p95" to="/requests"><Rank empty="No requests." rows={data.slowest.map((r) => routeRow(r, ms(r.p95), r.p95))} /></Panel>
        <Panel span={3} title="Busiest routes" sub="Requests" to="/requests"><Rank empty="No requests." rows={data.busiest.map((r) => routeRow(r, count(r.count), r.count))} /></Panel>
      </div>
    </div>
  );
}

function Runtime({ from, to, marks }: { from: number; to: number; marks: DashMark[] }) {
  return (
    <Row title="Runtime" fn={overviewRuntimeFn} height={228}>
      {(d) => d.heap.series.length || d.loop.series.length ? (
        <div className="dash-grid">
          <Panel span={4} title="Heap memory" sub="Worst instance of each service" to="/runtime" right={d.heap.services.slice(0, 3).map((s) => <Stat key={s.service} small value={mb(s.now)} label={label(s.service)} />)}>
            <DashLines rows={d.heap.series} keys={serviceKeys(d.heap.services)} from={from} to={to} marks={marks} format={(v) => (v ? `${Math.round(v)}` : "0")} floor={100} label="Heap memory in MB" />
          </Panel>
          <Panel span={4} title="Event loop delay" sub="p99, worst instance" to="/runtime" right={d.loop.services.slice(0, 3).map((s) => <Stat key={s.service} small value={ms(s.now)} label={label(s.service)} tone={s.now >= 100 ? "warn" : undefined} />)}>
            <DashLines rows={d.loop.series} keys={serviceKeys(d.loop.services)} from={from} to={to} marks={marks} format={ms} threshold={Math.max(0, ...d.loop.services.map((s) => s.peak)) >= 50 ? 100 : undefined} label="Event loop delay" />
          </Panel>
          <Panel span={4} title="Database connections" sub={`${d.instances.length} ${d.instances.length === 1 ? "instance" : "instances"} running`} to="/runtime" right={<><Stat small value={Math.round(d.pool.used)} label="Used" /><Stat small value={Math.round(d.pool.idle)} label="Idle" /><Stat small value={Math.round(d.pool.waiting)} label="Waiting" tone={d.pool.waiting ? "err" : undefined} /></>}>
            <DashLines rows={d.pool.series} keys={d.pool.series.some((p) => p.waiting > 0) ? [...POOL_KEYS, { key: "waiting", label: "Waiting", color: "var(--err)" }] : POOL_KEYS} from={from} to={to} marks={marks} format={(v) => String(Math.round(v))} label="Database connections" />
          </Panel>
        </div>
      ) : <div className="dash-grid"><Panel span={12}><p className="dp-none">No runtime metrics in this window.</p></Panel></div>}
    </Row>
  );
}

function Tasks({ from, to, marks }: { from: number; to: number; marks: DashMark[] }) {
  return (
    <Row title="Tasks" fn={overviewTasksFn} height={364}>
      {(d) => (
        <div className="dash-grid">
          <Panel span={5} title="Runs" sub="Attempts by outcome" to="/tasks" right={<Legend keys={RUN_KEYS} />}>
            <div className="dss">
              <Stat value={count(d.stats.attempts)} label="attempts" />
              <Stat value={count(d.stats.failed)} label="failed" tone={d.stats.failed ? "err" : undefined} />
              <Stat value={ms(d.stats.p95)} label="p95" />
            </div>
            <DashBars rows={d.series} keys={RUN_KEYS} from={from} to={to} marks={marks} height={200} label="Task attempts by outcome" />
          </Panel>
          <Panel span={3} title="Queue now" to="/tasks/all">
            <div className="dss">
              <Stat value={count(d.now.due)} label="Due" tone={d.now.oldestDue >= 300 ? "warn" : undefined} />
              <Stat value={count(d.now.scheduled)} label="Scheduled" />
              <Stat value={count(d.now.running)} label="Running" />
            </div>
            <DashLines rows={d.waiting} keys={QUEUE_KEYS} from={from} to={to} marks={marks} height={170} format={(v) => String(Math.round(v))} label="Tasks waiting" />
            <p className="dp-foot">Longest wait {ms(d.oldestPeak)}</p>
          </Panel>
          <Panel span={4} title="Failing kinds" sub="Failed attempts" to="/tasks">
            <Rank empty="No task failed." rows={d.failing.map((r) => kindRow(r, `${count(r.failed)} of ${count(r.attempts)}`, r.failed / Math.max(r.attempts, 1), "err"))} />
            <div className="dp-t dp-t2"><span>Slowest kinds</span><small>p95</small></div>
            <Rank empty="No tasks ran." rows={d.slowest.slice(0, 3).map((r) => kindRow(r, ms(r.p95), r.p95))} />
          </Panel>
        </div>
      )}
    </Row>
  );
}

function Database({ from, to, marks }: { from: number; to: number; marks: DashMark[] }) {
  return (
    <Row title="Database" fn={overviewDatabaseFn} height={388}>
      {(d) => (
        <div className="dash-grid">
          <Panel span={d.postgres ? 5 : 8} title="Queries" sub="Volume by outcome" to="/queries" right={<Legend keys={QUERY_KEYS} />}>
            <div className="dss">
              <Stat value={count(d.stats.calls)} label="queries" />
              <Stat value={count(d.stats.errors)} label="failed" tone={d.stats.errors ? "err" : undefined} />
              <Stat value={ms(d.stats.avg)} label="average" />
              <Stat value={ms(d.stats.p95)} label="p95" />
            </div>
            <DashBars rows={d.series} keys={QUERY_KEYS} from={from} to={to} marks={marks} height={220} label="Queries by outcome" />
          </Panel>
          {d.postgres && (
            <Panel span={3} title="Postgres now" to="/database">
              <div className="dss dss-2">
                <Stat small value={bytes(d.postgres.size)} label="On disk" />
                <Stat small value={`${(Math.floor(d.postgres.hitRate * 100) / 100).toFixed(2)}%`} label="From cache" tone={d.postgres.hitRate < 95 ? "warn" : undefined} />
                <Stat small value={d.postgres.connections} label="Connections" />
                <Stat small value={d.postgres.deadlocks} label="Deadlocks" tone={d.postgres.deadlocks ? "warn" : undefined} />
              </div>
              <Rank empty="No tables." rows={d.postgres.tables.slice(0, 4).map((t) => ({ id: t.name, name: t.name, value: bytes(t.size), size: t.size, to: "/database", search: { source: "pg", table: t.name } }))} />
            </Panel>
          )}
          <Panel span={4} title="Slowest statements" sub="p95" to="/queries">
            <Rank empty="No queries." rows={d.slowest.slice(0, 4).map((r) => statementRow(r, ms(r.p95), r.p95))} />
            <div className="dp-t dp-t2"><span>Most total time</span></div>
            <Rank empty="No queries." rows={d.heaviest.slice(0, 3).map((r) => statementRow(r, ms(r.total), r.total))} />
          </Panel>
        </div>
      )}
    </Row>
  );
}

function ProcessPanel({ d }: { d: Overview }) {
  if (!d.processes.length) return <Panel span={5} title="Processes" to="/processes"><p className="dp-none">No process is defined.</p></Panel>;
  const rank = { Failing: 0, Stuck: 1, Slow: 2, Healthy: 3 } as const;
  const stateOf = (id: string) => d.processes.find((p) => p.id === id)?.state ?? "Healthy";
  const flows = [...d.flows].sort((a, b) => rank[stateOf(a.id)] - rank[stateOf(b.id)] || b.stats.started - a.stats.started);
  const lead = flows[0];
  if (!lead) return <Panel span={5} title="Processes" to="/processes"><p className="dp-none">No process ran in this window.</p></Panel>;
  const stops = lead.steps.flatMap((step) => step.parallel);
  const top = Math.max(1, ...stops.map((stop) => stop.reached));
  return (
    <Panel span={5} title={lead.title} sub={`${count(lead.stats.started)} started in this window`} to={`/processes/${lead.id}`} right={<><Stat small value={count(lead.stats.failed)} label="Failed" tone={lead.stats.failed ? "err" : undefined} /><Stat small value={count(lead.stats.stuck)} label="Stuck" tone={lead.stats.stuck ? "warn" : undefined} /></>}>
      <div className="df">
        {stops.map((stop) => (
          <Link key={stop.kind} className="df-s" to="/tasks/kind/$kind" params={{ kind: stop.kind }}>
            <span className="ell">{stop.label}</span>
            <span className="df-n">{count(stop.reached)}{stop.waiting > 0 && <em className="warn"> {count(stop.waiting)} waiting</em>}{stop.failed > 0 && <em className="err"> {count(stop.failed)} failed</em>}</span>
            <span className="df-b" aria-hidden="true">
              <i style={{ width: `${(Math.max(0, stop.reached - stop.waiting - stop.failed) / top) * 100}%`, background: "var(--a)" }} />
              <i style={{ width: `${(stop.waiting / top) * 100}%`, background: "var(--warn)" }} />
              <i style={{ width: `${(stop.failed / top) * 100}%`, background: "var(--err)" }} />
            </span>
          </Link>
        ))}
      </div>
      {flows.length > 1 && (
        <div className="df-more">
          {flows.slice(1).map((flow) => (
            <Link key={flow.id} to="/processes/$id" params={{ id: flow.id }}>
              <span className="ell">{flow.title}</span>
              <span className="df-n">{count(flow.stats.started)} started{flow.stats.stuck > 0 && <em className="warn"> {count(flow.stats.stuck)} stuck</em>}{flow.stats.failed > 0 && <em className="err"> {count(flow.stats.failed)} failed</em>}</span>
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Outside({ overview }: { overview: Overview }) {
  return (
    <Row title="Providers and processes" fn={externalFn} height={340}>
      {(d) => (
        <div className="dash-grid">
          <Panel span={7} title="Providers" sub="The more red in a cell, the bigger the share of calls that failed" to="/external">
            {d.rows.length ? (
              <div className="dv">
                <div className="dv-r dv-h"><span>Provider</span><span>Calls</span><span>Failed</span><span>p95</span><span /></div>
                {d.rows.map((row) => (
                  <Link key={row.host} className="dv-r" to="/external/$host" params={{ host: row.host }}>
                    <span className="ell">{row.name}</span>
                    <span>{count(row.calls)}</span>
                    <span className={row.failed ? "err" : "t4"}>{count(row.failed)}</span>
                    <span>{ms(row.p95)}</span>
                    <HealthStrip slots={row.timeline} />
                  </Link>
                ))}
              </div>
            ) : <p className="dp-none">No provider was called in this window.</p>}
          </Panel>
          <ProcessPanel d={overview} />
        </div>
      )}
    </Row>
  );
}

function Reliability() {
  const [ref, near] = useNear<HTMLDivElement>();
  const issues = useScoped(issuesFn, {}, { enabled: near });
  const alerts = useFn(alertsFn, undefined, { enabled: near });
  const uptime = useFn(uptimeFn, undefined, { enabled: near });
  const list = alerts.data ?? [];
  const firing = list.filter((alert) => alert.state === "firing" && !alert.paused).length;
  const open = (issues.data?.rows ?? []).filter((row) => row.status === "open" && row.inRange > 0).sort((a, b) => b.inRange - a.inRange).slice(0, 6);
  const monitors = uptime.data?.rows ?? [];
  return (
    <div className="dg" ref={ref}>
      <h2 className="dg-h">Reliability</h2>
      <div className="dash-grid">
        <Panel span={8} title="Open issues" sub="With events in this window" to="/issues" right={<><Stat small value={firing} label="Alerts firing" tone={firing ? "err" : undefined} /><Stat small value={list.filter((alert) => !alert.paused).length} label="Watching" /></>}>
          {open.length ? (
            <div className="di">
              {open.map((row) => (
                <Link key={row.fingerprint} className="di-r" to="/issues/$fp" params={{ fp: row.fingerprint }}>
                  <span className="di-n ell"><b className="ell">{row.name}</b><small className="ell">{row.message}</small></span>
                  <Trend values={row.trend} tone="err" />
                  <span className="di-v">{count(row.inRange)}</span>
                  <span className="t3 di-v">{ago(row.last_seen)}</span>
                </Link>
              ))}
            </div>
          ) : <p className="dp-none">No open issue had events in this window.</p>}
        </Panel>
        <Panel span={4} title="Uptime" sub="30 days" to="/uptime">
          <Rank empty="No monitors." rows={monitors.slice(0, 5).map((row) => ({ id: String(row.id), name: row.name, value: row.uptime30d == null ? "No checks" : pct(row.uptime30d), size: row.uptime30d ?? 0, tone: row.state === "down" ? "err" : undefined, to: "/uptime" }))} />
        </Panel>
      </div>
    </div>
  );
}

function PeopleAndEmail({ from, to, marks }: { from: number; to: number; marks: DashMark[] }) {
  const [ref, near] = useNear<HTMLDivElement>();
  const people = useScoped(overviewPeopleFn, {}, { enabled: near });
  const emails = useScoped(emailsFn, {}, { enabled: near });
  return (
    <div className="dg" ref={ref}>
      <h2 className="dg-h">People and delivery</h2>
      <div className="dash-grid">
        <Panel span={4} title="People active" to="/users" right={people.data && <><Stat small value={count(people.data.people)} label="People" /><Stat small value={count(people.data.accounts)} label="Accounts" /></>}>
          {people.data ? <DashLines rows={people.data.series} keys={PEOPLE_KEYS} from={from} to={to} marks={marks} area format={(v) => String(Math.round(v))} label="People active" /> : <div className="skel dg-skel" style={{ height: 150 }} />}
        </Panel>
        <Panel span={4} title="Emails" to="/emails" right={emails.data && <><Stat small value={count(emails.data.stats.sent)} label="Sent" /><Stat small value={count(emails.data.stats.failed)} label="Failed" tone={emails.data.stats.failed ? "err" : undefined} /><Stat small value={count(emails.data.delivery.bounced)} label="Bounced" tone={emails.data.delivery.bounced ? "warn" : undefined} /></>}>
          {emails.data ? <DashBars rows={emails.data.series} keys={EMAIL_KEYS} from={from} to={to} marks={marks} label="Emails sent" /> : <div className="skel dg-skel" style={{ height: 150 }} />}
        </Panel>
        <Panel span={4} title="Busiest accounts" to="/accounts">
          {people.data ? <Rank empty="No account was active." rows={people.data.busiest.slice(0, 5).map((row) => ({ id: row.id, name: row.name, value: count(row.events), size: row.events, to: "/accounts" }))} /> : null}
        </Panel>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="ovp dash" aria-busy="true" aria-label="Loading">
      <div className="dash-grid">
        <div className="skel dp s8" style={{ height: 420 }} />
        <div className="skel dp s4" style={{ height: 420 }} />
      </div>
    </div>
  );
}

function OverviewPage() {
  const q = useScoped(overviewFn, {});
  const traffic = useScoped(overviewTrafficFn, {});
  const scope = useScope();
  const shell = useFn(shellFn, { env: scope.env }, { refetchInterval: 30_000 });
  const marks = useMemo(() => (traffic.data?.deploys ?? []).map((deploy) => ({ t: deploy.t, label: `${label(deploy.service)} ${deploy.version.slice(0, 8)} deployed at ${hm(deploy.t)}` })), [traffic.data?.deploys]);
  const { from, to } = scope;
  return (
    <Load q={q} skeleton={<Loading />}>
      {(d) => {
        if (!d.summary.requests && !d.tasks.attempts) return <NoData env={ENV_LABEL[scope.env]} code={scope.env} />;
        return (
          <div className="ovp dash">
            <Clock>
              <Hero from={from} to={to} marks={marks} data={traffic.data} overview={d} lastEvent={shell.data?.ingest.lastEventAt ?? 0} />
              <Api from={from} to={to} marks={marks} data={traffic.data} />
              <Runtime from={from} to={to} marks={marks} />
              <Tasks from={from} to={to} marks={marks} />
              <Database from={from} to={to} marks={marks} />
              <Outside overview={d} />
              <Reliability />
              <PeopleAndEmail from={from} to={to} marks={marks} />
            </Clock>
          </div>
        );
      }}
    </Load>
  );
}
