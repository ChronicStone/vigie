import { createFileRoute } from "@tanstack/react-router";
import { Empty, Load } from "@web/components/ui.tsx";
import { slosFn } from "@web/fns/reliability.ts";
import { useFn } from "@web/lib/api.ts";
import { useScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/slos")({ component: SlosPage });

type Slo = Awaited<ReturnType<typeof slosFn>>[number];

const runsOut = (slo: Slo) => (slo.left <= 0 ? "Already out" : slo.daysLeft !== null ? `Runs out in ${slo.daysLeft < 1 ? "under a day" : `${Math.round(slo.daysLeft)} d`}` : "Not burning");
const leftText = (slo: Slo) => (slo.left > 0 ? `${Math.round(slo.left)}% of the budget left` : `${Math.round(-slo.left)}% over budget`);

/** What is left of the allowance. When it is gone, the bar is gone too, and the words carry how far over it went. */
function Budget({ slo, thick }: { slo: Slo; thick?: boolean }) {
  const tone = slo.state === "burning" ? "err" : slo.state === "watch" ? "warn" : "";
  return <div className={`slos-track ${tone} ${thick ? "thick" : ""}`} role="img" aria-label={leftText(slo)}><i style={{ scale: `${Math.max(0, Math.min(100, slo.left)) / 100} 1` }} /></div>;
}

/** Failed share per day, against what the objective allows in a day. */
function Days({ slo }: { slo: Slo }) {
  const allowed = 100 - slo.objective;
  const failed = slo.daily.map((value) => Math.max(0, 100 - value));
  const top = Math.max(allowed * 1.6, ...failed);
  return (
    <div className="slos-days">
      <div className="slos-bars" role="img" aria-label={`Failed share per day, last ${failed.length} days`}>
        <em style={{ bottom: `${(allowed / top) * 100}%` }} />
        {failed.map((value, i) => <i key={i} className={value > allowed ? "over" : ""} style={{ scale: `1 ${value ? Math.max(0.04, value / top) : 0.02}` }} title={`${failed.length - i} d ago: ${value.toFixed(2)}% failed`} />)}
      </div>
      <div className="slos-cap"><span>{failed.length} days ago</span><span>Allowed {allowed.toFixed(allowed < 1 ? 2 : 1)}% a day</span><span>Today</span></div>
    </div>
  );
}

function Hot({ slo }: { slo: Slo }) {
  const tone = slo.state === "burning" ? "err" : "warn";
  const burning = slo.left <= 0 || slo.daysLeft !== null;
  return (
    <div className="slos-hot">
      <div className="slos-main">
        <div className="slos-top">
          <h3>{slo.name}</h3>
          <span className={`slos-out ${burning ? tone : "t2"}`}>{runsOut(slo)}</span>
        </div>
        <Budget slo={slo} thick />
        <div className="slos-under">
          <span className={slo.left <= 0 ? "err" : ""}>{leftText(slo)}</span>
          <span>{slo.burn > 0 ? <>Burning <b className={slo.burn >= 1 ? tone : ""}>{slo.burn.toFixed(1)}×</b> the rate it can afford</> : "Nothing failed in the last hour"}</span>
          <span>Aiming for {slo.objective}%, at {slo.attained.toFixed(2)}%</span>
        </div>
      </div>
      <Days slo={slo} />
    </div>
  );
}

function Calm({ slo }: { slo: Slo }) {
  return (
    <div className="slos-calm">
      <span className="slos-name">{slo.name}</span>
      <Budget slo={slo} />
      <span className="slos-left">{Math.round(slo.left)}% left</span>
      <span className="slos-goal">{slo.attained.toFixed(2)}% of {slo.objective}%</span>
      <span className="slos-then">{slo.burn > 0 ? runsOut(slo) : "Not burning"}</span>
    </div>
  );
}

function SlosPage() {
  const scope = useScope();
  const q = useFn(slosFn, { env: scope.env });
  return (
    <Load q={q}>
      {(rows) => {
        if (!rows.length) return <Empty title="No objective defined yet" hint="Add slos to definitions/catalog, with one query for good events and one for all events." />;
        const measured = rows.filter((slo) => slo.total > 0);
        const byRisk = (a: Slo, b: Slo) => a.left - b.left;
        const burning = measured.filter((slo) => slo.state === "burning").sort(byRisk);
        const watch = measured.filter((slo) => slo.state === "watch").sort(byRisk);
        const healthy = measured.filter((slo) => slo.state === "healthy").sort(byRisk);
        const idle = rows.filter((slo) => slo.total === 0);
        const next = [...measured].filter((slo) => slo.left > 0 && slo.daysLeft !== null).sort((a, b) => a.daysLeft! - b.daysLeft!)[0];
        const out = measured.filter((slo) => slo.left <= 0);
        return (
          <>
            <div className="subbar slos-bar">
              <span className={`slos-answer ${out.length ? "err" : burning.length ? "warn" : ""}`}>
                {out.length === 1 ? `${out[0]!.name} is over budget` : out.length ? `${out.length} objectives are over budget` : next ? `${next.name} runs out next, ${next.daysLeft! < 1 ? "in under a day" : `in ${Math.round(next.daysLeft!)} d`}` : measured.length ? "Nothing is burning" : "No objective has traffic yet"}
              </span>
              <span className="grow" />
              <span className="t3">Last 30 days</span>
            </div>
            <div className="ov slos">
              {burning.length > 0 && <section className="slos-group"><h2 className="err">Burning</h2>{burning.map((slo) => <Hot key={slo.id} slo={slo} />)}</section>}
              {watch.length > 0 && <section className="slos-group"><h2 className="warn">Worth a look</h2>{watch.map((slo) => <Hot key={slo.id} slo={slo} />)}</section>}
              {healthy.length > 0 && <section className="slos-group"><h2>Within budget</h2>{healthy.map((slo) => <Calm key={slo.id} slo={slo} />)}</section>}
              {idle.length > 0 && (
                <section className="slos-group slos-idle">
                  <h2>Nothing to measure</h2>
                  <p>No traffic in 30 days for {idle.map((slo) => slo.name).join(", ")}. An objective with no events neither holds nor fails.</p>
                </section>
              )}
            </div>
          </>
        );
      }}
    </Load>
  );
}
