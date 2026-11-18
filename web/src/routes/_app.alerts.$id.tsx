import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Json } from "@web/components/code.tsx";
import { LimitChart, Part } from "@web/components/reliability.tsx";
import { toast } from "@web/components/toast.tsx";
import { Chip, Confirm, Head, Load } from "@web/components/ui.tsx";
import { alertFn, deleteAlertFn, pauseAlertFn, testAlertFn } from "@web/fns/reliability.ts";
import { errorText, useAct, useScoped } from "@web/lib/api.ts";
import { ago, dayMonth, hm, span } from "@web/lib/format.ts";
import { alertValue } from "@web/lib/labels.ts";
import { useScope, useSetScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/alerts/$id")({ component: AlertPage });

const THIRTY_DAYS = 30 * 86_400_000;
const LIVE = new Set(["slo-burn", "rule-violation"]);
const peak = (value: number | null, unit?: string) => (value === null ? "" : `peak ${Math.round(value * 10) / 10}${unit ? ` ${unit}` : ""}`);

function AlertPage() {
  const { id } = Route.useParams();
  const q = useScoped(alertFn, { id });
  const scope = useScope();
  const setScope = useSetScope();
  const pause = useAct(pauseAlertFn);
  const test = useAct(testAlertFn);
  const remove = useAct(deleteAlertFn);
  const navigate = useNavigate();
  return (
    <Load q={q}>
      {(a) => {
        const firing = a.state === "firing" && !a.paused;
        const now = Date.now();
        const start = now - THIRTY_DAYS;
        // This page reads thirty days. Dragging across the chart narrows it, and the way back is one click.
        const from = scope.custom ? scope.from : start;
        const to = scope.custom ? scope.to : now;
        const recent = a.incidents.filter((incident) => incident.started >= start);
        const open = a.incidents.find((incident) => !incident.ended);
        const longest = recent.reduce((most, incident) => Math.max(most, (incident.ended ?? now) - incident.started), 0);
        const lastFired = a.incidents[0]?.started ?? a.last_fired;
        const limit = a.threshold ?? null;
        const unit = a.rule.unit ? ` ${a.rule.unit}` : "";
        const below = a.rule.below !== undefined;
        const currently = alertValue(a);
        return (
          <div className="ov alert">
            <Head back="/alerts" backTitle="Back to alerts" title={a.name} meta={a.error ? <Chip tone="warn">Cannot evaluate</Chip> : a.paused ? <Chip tone="t3">Paused</Chip> : undefined} right={<>
              {a.managed_in === "app" && <Confirm trigger={<button className="btn">Delete</button>} title={`Delete ${a.name}?`} action="Delete" danger onConfirm={async () => { await remove.mutateAsync({ id }); toast("Alert deleted"); void navigate({ to: "/alerts" }); }}>Its incident history is deleted with it.</Confirm>}
              <button className="btn" onClick={() => test.mutate({ id }, { onSuccess: (r) => toast(r.sent ? `Test sent to ${r.sent} channel(s)` : "No channel is set up yet"), onError: (error) => toast(errorText(error)) })}>Test notification</button>
              <button className="btn" onClick={() => pause.mutate({ id, paused: !a.paused }, { onSuccess: () => toast(a.paused ? "Resumed" : "Paused"), onError: (error) => toast(errorText(error)) })}>{a.paused ? "Resume" : "Pause"}</button>
            </>} />

            <div className="alert-lede">
              {a.error
                ? <p className="alert-state warn">{a.error}</p>
                : a.paused
                  ? <p className="alert-state t2">Nothing is being checked while it is paused.</p>
                  : firing
                    ? <p className="alert-state err">Firing for {span(now - (open?.started ?? a.since ?? now))}.{currently ? ` Now ${currently}` : ""}{limit !== null ? `, ${below ? "needs at least" : "limit"} ${limit}${unit}` : ""}{currently ? "." : ""}</p>
                    : <p className="alert-state">Not firing.{currently ? ` Now ${currently}.` : ""}</p>}
              <p className="alert-rule">Fires when: {a.rule.condition}.</p>
              <p className="alert-often">
                {recent.length
                  ? <>Fired <b>{recent.length === 1 ? "once" : `${recent.length}${a.incidents.length === 50 && recent.length === 50 ? "+" : ""} times`}</b> in 30 days. Last <b>{ago(lastFired)}</b>. Longest <b>{span(longest)}</b>.</>
                  : lastFired ? <>Has not fired in 30 days. Last <b>{dayMonth(lastFired)}</b>.</> : "Has never fired."}
              </p>
            </div>

            <Part title={scope.custom ? `${dayMonth(from)}, ${hm(from)} to ${dayMonth(to)}, ${hm(to)}` : "Last 30 days"} className="alert-chart" right={scope.custom ? <button className="tlink" onClick={() => setScope({ from: undefined, to: undefined })}>Back to 30 days</button> : undefined}>
              {LIVE.has(a.rule.when.source)
                ? <p className="alert-live">This alert reads a live value, so there is no history to draw.</p>
                : <LimitChart points={a.history} from={from} to={to} limit={limit} below={below} unit={a.rule.unit} incidents={a.incidents} label={`${a.name} over time`} height={190} zoom />}
            </Part>

            <div className="ovg alert-grid">
              <Part title="Incidents">
                {a.incidents.map((incident) => (
                  <Link key={incident.id} data-row className="alert-incident" to="/logs" search={{ from: incident.started - 300_000, to: (incident.ended ?? now) + 300_000, range: undefined }}>
                    <span>{dayMonth(incident.started)}, {hm(incident.started)}</span>
                    <span className="t2">{span((incident.ended ?? now) - incident.started)}</span>
                    <span className="t3">{below ? "" : peak(incident.peak, a.rule.unit)}</span>
                    <span className={incident.ended ? "t3" : "err"}>{incident.ended ? "Recovered" : "Still firing"}</span>
                  </Link>
                ))}
                {!a.incidents.length && <p className="alert-none">Nothing yet. If it fires, each time is listed here with the logs of that moment.</p>}
              </Part>
              <Part title="How it is checked">
                <dl className="alert-how">
                  <dt>Looks at</dt><dd>The last {a.rule.window}</dd>
                  {a.rule.for && <><dt>Holds for</dt><dd>{a.rule.for} before it fires</dd></>}
                  <dt>Tells</dt><dd>{a.rule.notify ?? "Every channel"}</dd>
                  {a.rule.quiet && <><dt>Quiet</dt><dd>Quiet from {a.rule.quiet.from} to {a.rule.quiet.to}, {a.rule.quiet.timezone}</dd></>}
                  {a.file && <><dt>Defined in</dt><dd className="mono">{a.file}</dd></>}
                </dl>
                <details className="alert-code">
                  <summary>Show the rule</summary>
                  <Json value={{ when: a.rule.when, above: a.rule.above, below: a.rule.below, sigma: a.rule.sigma, quiet: a.rule.quiet, window: a.rule.window, for: a.rule.for }} />
                </details>
              </Part>
            </div>
          </div>
        );
      }}
    </Load>
  );
}
