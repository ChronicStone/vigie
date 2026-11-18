import { createFileRoute, Link } from "@tanstack/react-router";
import { useRowKeys } from "@web/components/reliability.tsx";
import { Empty, Id, Load } from "@web/components/ui.tsx";
import { releasesFn } from "@web/fns/reliability.ts";
import { useFn } from "@web/lib/api.ts";
import { ago, compact, fms, pct } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/releases")({ component: ReleasesPage });

type Release = Awaited<ReturnType<typeof releasesFn>>["rows"][number];

const HOUR = 3_600_000;
const VERDICT = { clean: ["No change", "t3"], changed: ["Slightly worse", "warn"], regression: ["Worse", "err"], unknown: ["Too little traffic", "t3"] } as const;

/** Before and after on one scale: the grey mark is the hour before, the coloured one the hour after. */
function Shift({ before, after, top, text, tone, label }: { before: number; after: number; top: number; text: (v: number) => string; tone: string; label: string }) {
  const low = (Math.min(before, after) / top) * 100;
  const high = (Math.max(before, after) / top) * 100;
  const worse = after > before;
  return (
    <span className="releases-shift" aria-label={`${label}: ${text(before)} before, ${text(after)} after`}>
      <span className="releases-nums"><span className="t3">{text(before)}</span><span className="t4">→</span><span className={worse ? tone : "t2"}>{text(after)}</span></span>
      <span className="releases-scale" aria-hidden="true">
        <i className={`span ${worse ? tone : ""}`} style={{ left: `${low}%`, width: `${high - low}%` }} />
        <i className="from" style={{ left: `${(before / top) * 100}%` }} />
        <i className={`to ${worse ? tone : ""}`} style={{ left: `${(after / top) * 100}%` }} />
      </span>
    </span>
  );
}

function ReleaseRow({ release, tops }: { release: Release; tops: { errors: number; p95: number } }) {
  const [label, tone] = VERDICT[release.verdict];
  const before = release.before.requests;
  return (
    <div className={`releases-row ${release.verdict}`}>
      <Link data-row className="releases-link" to="/" search={{ from: release.first - HOUR, to: release.first + HOUR, range: undefined }} aria-label={`Open the two hours around ${release.version}`} />
      <span className="releases-node" aria-hidden="true" />
      <span className="releases-id"><Id value={release.version} keep={7} /><small>{ago(release.first)}</small></span>
      <span className={`releases-verdict ${tone}`}>
        {label}
        {release.regressedIssues > 0 && <Link className="releases-back" to="/issues" search={{ f: "regressed" }}>{release.regressedIssues} {release.regressedIssues === 1 ? "issue" : "issues"} came back</Link>}
      </span>
      {release.verdict === "unknown"
        ? <span className="releases-thin">{before ? `Only ${compact(before)} ${before === 1 ? "request" : "requests"}` : "No request"} in the hour before, so there is nothing to compare with. In the hour after: {pct(release.after.errors)} errors, p95 {fms(release.after.p95)}.</span>
        : <>
            <Shift label="Errors" before={release.before.errors} after={release.after.errors} top={tops.errors} text={pct} tone={tone} />
            <Shift label="p95" before={release.before.p95} after={release.after.p95} top={tops.p95} text={fms} tone={tone} />
          </>}
    </div>
  );
}

function ReleasesPage() {
  const scope = useScope();
  const q = useFn(releasesFn, { env: scope.env });
  useRowKeys();
  return (
    <Load q={q}>
      {(d) => {
        const worse = d.rows.filter((r) => r.verdict === "regression");
        const latest = d.rows[0];
        // One scale per measure across every release, so a small change looks small. Errors start from 1%, or 0.1% would fill the bar.
        const compared = d.rows.filter((r) => r.verdict !== "unknown");
        const tops = {
          errors: Math.max(1, ...compared.flatMap((r) => [r.before.errors, r.after.errors])),
          p95: Math.max(1, ...compared.flatMap((r) => [r.before.p95, r.after.p95])),
        };
        return (
          <>
            <div className="subbar releases-bar">
              <span className="releases-running">
                <b>Running now</b>
                {d.running.map((r) => <span key={r.service}>{r.service} <Id value={r.version} keep={7} /> <span className="t3">{r.instances} {r.instances === 1 ? "instance" : "instances"}</span></span>)}
                {!d.running.length && <span className="t3">Nothing reported in the last 15 min</span>}
              </span>
            </div>
            <div className="ov releases">
              {!d.rows.length && <Empty title="No release seen yet" hint="Releases come from service.version on your events, or from POST /api/deployments in CI." />}
              {latest && (
                <div className="releases-lede">
                  <p className={latest.verdict === "regression" ? "err" : latest.verdict === "changed" ? "warn" : ""}>
                    {latest.verdict === "regression" ? "The latest release made things worse" : latest.verdict === "changed" ? "The latest release looks slightly worse" : latest.verdict === "clean" ? "The latest release changed nothing" : "Too little traffic to judge the latest release"}
                  </p>
                  <span>{worse.length ? `${worse.length} of the last ${compared.length} compared made things worse. ` : compared.length > 1 ? `No clear regression in the last ${compared.length} compared. ` : ""}Each compares the hour after it with the hour before.</span>
                </div>
              )}
              {d.rows.length > 0 && (
                <>
                  {compared.length > 0 && <div className="releases-head" aria-hidden="true"><span /><span>Release</span><span>Verdict</span><span>Errors</span><span>p95</span></div>}
                  <div className="releases-line">{d.rows.map((release) => <ReleaseRow key={release.version} release={release} tops={tops} />)}</div>
                </>
              )}
            </div>
          </>
        );
      }}
    </Load>
  );
}
