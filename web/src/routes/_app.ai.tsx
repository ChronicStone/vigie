import { createFileRoute, Link } from "@tanstack/react-router";
import { change, share, useListKeys } from "@web/components/backend.tsx";
import { Lanes } from "@web/components/lanes.tsx";
import { Empty, Load } from "@web/components/ui.tsx";
import { aiUsageFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, compact, fms } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/ai")({ component: AiPage });

const money = (value: number) => (value >= 100 ? `$${Math.round(value)}` : value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`);
const COST = [{ key: "cost", label: "Cost", color: "var(--a)" }];
const CALLS = [{ key: "ok", label: "Calls", color: "var(--t4)" }, { key: "error", label: "Failed", color: "var(--err)" }];

function AiPage() {
  const scope = useScope();
  const q = useScoped(aiUsageFn, {});
  useListKeys();
  return (
    <Load q={q}>
      {(d) => {
        if (!d.stats.calls) return <Empty title="No AI call in this window" hint="AI calls appear here from wide events with ai.feature, ai.model, ai.tokens and ai.costUsd." />;
        const byFeature = new Map<string, { feature: string; cost: number; calls: number; failed: number; tokens: number; p95: number; models: string[] }>();
        for (const f of d.features) {
          const entry = byFeature.get(f.feature) ?? { feature: f.feature, cost: 0, calls: 0, failed: 0, tokens: 0, p95: 0, models: [] };
          entry.cost += f.cost;
          entry.calls += f.calls;
          entry.failed += f.failed;
          entry.tokens += f.tokens;
          entry.p95 = Math.max(entry.p95, f.p95);
          if (f.model) entry.models.push(f.model);
          byFeature.set(f.feature, entry);
        }
        const features = [...byFeature.values()].sort((a, b) => b.cost - a.cost);
        const most = Math.max(0.0001, ...features.map((f) => f.cost));
        const moved = change(d.stats.cost, d.previous.cost);
        const failRate = (d.stats.failed / d.stats.calls) * 100;
        // The same error ten times is one problem. The list arrives newest first, so each row opens its latest occurrence.
        const grouped = new Map<string, (typeof d.failures)[number] & { n: number }>();
        for (const f of d.failures) {
          const key = `${f.feature} ${f.error}`;
          const seen = grouped.get(key);
          if (seen) seen.n += 1;
          else grouped.set(key, { ...f, n: 1 });
        }
        const failures = [...grouped.values()].sort((a, b) => b.n - a.n);
        return (
          <div className="ov">
            <section className="ai-head">
              <div className="ai-big">
                <span className="cch-l">Spent</span>
                <b>{money(d.stats.cost)}</b>
                {moved && <span className="cch-n">{moved} on the window before</span>}
              </div>
              <span className="ai-figs">
                <span><span className="t3">Calls</span><b>{compact(d.stats.calls)}</b></span>
                <span><span className="t3">Per call</span><b>{money(d.stats.cost / d.stats.calls)}</b></span>
                <span><span className="t3">Failed</span><b className={d.stats.failed ? (failRate >= 5 ? "err" : "warn") : "t3"}>{d.stats.failed ? share(d.stats.failed, d.stats.calls) : "None"}</b></span>
                <span><span className="t3">p95</span><b>{fms(d.stats.p95)}</b></span>
                <span><span className="t3">Tokens</span><b>{compact(d.stats.tokens)}</b></span>
              </span>
            </section>
            <section className="rt-list ai-features">
              <div className="ai-fh"><span>Feature</span><span>Cost</span><span>Share</span><span>Per call</span><span>Calls</span><span>Failed</span><span>p95</span></div>
              {features.map((f) => (
                <div className="ai-row" key={f.feature}>
                  <span className="ai-name">
                    <b>{f.feature}</b>
                    <span className="mono t3 ell">{f.models.join(", ")}</span>
                  </span>
                  <span className="ai-cost"><span className="req-bar ai-bar"><i style={{ scale: `${f.cost / most} 1` }} /></span><b className="mono">{money(f.cost)}</b></span>
                  <span className="mono t2 ai-c">{share(f.cost, d.stats.cost)}</span>
                  <span className="mono t2 ai-c">{money(f.cost / Math.max(f.calls, 1))}</span>
                  <span className="mono t2 ai-c">{compact(f.calls)}</span>
                  <span className={`mono ai-c ${f.failed ? ((f.failed / f.calls) * 100 >= 5 ? "err" : "warn") : "t4"}`}>{f.failed ? share(f.failed, f.calls) : "None"}</span>
                  <span className="mono t2 ai-c">{fms(f.p95)}</span>
                </div>
              ))}
            </section>
            <Lanes from={scope.from} to={scope.to} height={46} lanes={[
              { id: "cost", label: "Cost", keys: COST, data: d.costSeries, format: money },
              { id: "calls", label: "Calls", keys: CALLS, data: d.series },
            ]} />
            {failures.length > 0 && (
              <section className="rt-list">
                <h3 className="err">Why calls failed</h3>
                {failures.map((f) => (
                  <Link key={f.id} className="lst" to="/logs" search={{ event: f.id }}>
                    <span className="ai-ff">{f.feature}</span>
                    <span className="err grow ell">{f.error || "No error recorded"}</span>
                    <span className="mono t2">{f.n}×</span>
                    <span className="t3 ai-ago">{ago(f.t)}</span>
                  </Link>
                ))}
              </section>
            )}
          </div>
        );
      }}
    </Load>
  );
}
