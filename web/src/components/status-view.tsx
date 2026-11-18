import type { statusModel } from "@server/api/status.ts";
import { ago, dayMonth, hm, span } from "@web/lib/format.ts";

export type StatusModel = ReturnType<typeof statusModel>;
type Incident = StatusModel["active"][number];
type Overall = StatusModel["overall"];

export const OVERALL: Record<Overall, { label: string; tone: string }> = {
  operational: { label: "Operational", tone: "ok" },
  degraded: { label: "Degraded", tone: "warn" },
  partial: { label: "Partial outage", tone: "warn" },
  major: { label: "Major outage", tone: "err" },
  maintenance: { label: "Maintenance", tone: "info" },
};
export const IMPACT = { minor: ["Minor", "warn"], major: ["Major", "err"], critical: ["Critical", "err"], maintenance: ["Maintenance", "info"] } as const;
export const UPDATE = { investigating: ["Investigating", "err"], identified: ["Identified", "warn"], monitoring: ["Monitoring", "info"], resolved: ["Resolved", "ok"], scheduled: ["Scheduled", "info"] } as const;

const cellTone = (share: number | null, incidents: number) => (share === null ? "none" : share < 98 ? "err" : share < 99.9 || incidents ? "warn" : "ok");

/** A lighthouse in pixels. Its lamp and beam carry the state of the whole page. */
const TOWER = ["....a....", "...rrr...", "..rrrrr..", "...lll...", "..ggggg..", "...www...", "...rrr...", "...www...", "..rrrrr..", "..wwwww..", "..rrrrr..", ".wwwwwww.", "bbbbbbbbb"];
function Lighthouse() {
  return (
    <div className="sp-light" aria-hidden="true">
      <span className="sp-beam" />
      <svg className="sp-mark" viewBox="0 0 9 13" shapeRendering="crispEdges">
        {TOWER.flatMap((row, y) => [...row].map((c, x) => (c === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" className={`px-${c}`} />)))}
      </svg>
    </div>
  );
}

/** The page answers in a sentence: what is wrong, by name, and that the rest works. */
function answer(model: StatusModel) {
  if (!model.components.length) return { head: "Nothing is watched here yet.", rest: "" };
  const hit = model.components.filter((c) => c.state !== "operational");
  const open = model.active;
  if (!hit.length && !open.length) return { head: "Everything is working.", rest: `${model.components.length === 1 ? model.components[0]!.name : `All ${model.components.length} services`}, checked every minute.` };
  const head = open.length ? `${open[0]!.title}.` : `${hit.map((c) => c.name).join(", ")} ${hit.length === 1 ? "is" : "are"} ${OVERALL[hit[0]!.state].label.toLowerCase()}.`;
  const fine = model.components.length - hit.length;
  const rest = open.length > 1 ? `${open.length - 1} more open below.` : fine === 0 ? "" : hit.length ? "Everything else works." : "";
  return { head, rest };
}

function period(i: Incident) {
  if (i.resolved === null) return `since ${hm(i.started)}, ${ago(i.started)}`;
  const sameDay = dayMonth(i.started) === dayMonth(i.resolved);
  return `${hm(i.started)} to ${sameDay ? hm(i.resolved) : `${dayMonth(i.resolved)} ${hm(i.resolved)}`}, ${span(i.resolved - i.started)}`;
}

/** Updates read like log lines: time, state, words. Newest first. */
function LogLines({ i }: { i: Incident }) {
  if (!i.updates.length)
    return <p className="sp-quiet">{i.resolved ? "Seen by Vigie's checks, and back on its own. Nobody wrote about it." : "Seen by Vigie's checks. Words follow when someone looks into it."}</p>;
  return (
    <ol className="sp-lines">
      {i.updates.map((u, index) => {
        const [label, tone] = UPDATE[u.state as keyof typeof UPDATE] ?? UPDATE.investigating;
        return (
          <li key={index}>
            <time dateTime={new Date(u.at).toISOString()}>{dayMonth(u.at) === dayMonth(i.started) ? hm(u.at) : `${dayMonth(u.at)} ${hm(u.at)}`}</time>
            <b className={tone}>{label}</b>
            <p>{u.message}</p>
          </li>
        );
      })}
    </ol>
  );
}

function Entry({ i, open }: { i: Incident; open?: boolean }) {
  const [impact, impactTone] = IMPACT[i.impact as keyof typeof IMPACT] ?? IMPACT.major;
  const head = (
    <>
      <span className="sp-date">{dayMonth(i.started)}</span>
      <span className="sp-what">
        <b>{i.title}</b>
        <small><span className={impactTone}>{impact}</span>{i.components.length > 0 && <> on {i.components.join(", ")}</>}, {period(i)}</small>
      </span>
    </>
  );
  if (open)
    return (
      <article className={`sp-entry sp-open ${impactTone}`}>
        <div className="sp-ehead">{head}</div>
        <LogLines i={i} />
      </article>
    );
  return (
    <details className="sp-entry">
      <summary className="sp-ehead">{head}</summary>
      <LogLines i={i} />
    </details>
  );
}

/** Month labels over the grid, where each month starts. */
function months(days: { at: number }[]) {
  return days.map((d, index) => {
    const date = new Date(d.at);
    return index === 0 || date.getUTCDate() === 1 ? date.toLocaleString("en", { month: "short", timeZone: "UTC" }) : "";
  });
}

export function StatusView({ model, updatedAt, preview }: { model: StatusModel; updatedAt: number; preview?: boolean }) {
  const overall = OVERALL[model.overall];
  const { head, rest } = answer(model);
  const groups = [...new Set(model.components.map((c) => c.group))];
  const ticks = model.components[0] ? months(model.components[0].days) : [];
  return (
    <div className={`sp ${overall.tone} ${preview ? "sp-preview" : ""}`} style={{ ["--days" as string]: model.daysShown }}>
      <main className="sp-col">
        <header className="sp-top">
          <Lighthouse />
          <div className="sp-who">
            <p className="sp-name">{model.title}</p>
            {model.description && <p className="sp-desc">{model.description}</p>}
          </div>
        </header>

        <section className="sp-answer" aria-live="polite">
          <h1>{head}</h1>
          {rest && <p>{rest}</p>}
        </section>

        {model.show.active && model.active.length > 0 && (
          <section className="sp-now" aria-label="Open incidents">
            {model.active.map((i) => <Entry key={i.id} i={i} open />)}
          </section>
        )}

        {model.components.length > 0 && (
          <section aria-labelledby="sp-watch">
            <div className="sp-h2"><h2 id="sp-watch">Watch</h2>{model.show.history && <span>Each square is a day</span>}</div>
            <div className="sp-grid" role="table" aria-label={`The last ${model.daysShown} days, one row per service`}>
              {model.show.history && (
                <div className="sp-row sp-ticks" role="row" aria-hidden="true">
                  <span />
                  <span className="sp-cells">{ticks.map((t, index) => <i key={index}>{t}</i>)}</span>
                  <span />
                </div>
              )}
              {groups.map((group) => (
                <div role="rowgroup" key={group || "_"} className="sp-rows">
                  {group && <div className="sp-gname" role="row"><span role="rowheader">{group}</span></div>}
                  {model.components.filter((c) => c.group === group).map((c) => (
                    <div className="sp-row" role="row" key={c.key}>
                      <span className="sp-cname" role="rowheader"><i className={`sp-dot ${OVERALL[c.state].tone}`} /><b>{c.name}</b><small className={OVERALL[c.state].tone}>{OVERALL[c.state].label}</small></span>
                      {model.show.history ? (
                        <span className="sp-cells" role="cell">
                          {c.days.map((d) => <i key={d.at} className={cellTone(d.share, d.incidents.length)} title={`${dayMonth(d.at)}: ${d.share === null ? "not watched yet" : `${d.share.toFixed(2)}% up`}${d.incidents.length ? `. ${d.incidents.join(", ")}` : ""}`} />)}
                        </span>
                      ) : <span role="cell" />}
                      <span className="sp-up" role="cell">{model.show.uptime && c.uptime !== null ? `${c.uptime.toFixed(2)}%` : ""}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        )}

        {model.show.past && (
          <section aria-labelledby="sp-log">
            <div className="sp-h2"><h2 id="sp-log">Logbook</h2><span>{model.daysShown} days</span></div>
            {model.past.length === 0 ? <p className="sp-quiet">Nothing to report in {model.daysShown} days.</p> : <div className="sp-book">{model.past.map((i) => <Entry key={i.id} i={i} />)}</div>}
          </section>
        )}

        <footer className="sp-foot">
          <span>Updated {hm(updatedAt)}, checked every minute</span>
          <span>Kept by Vigie</span>
        </footer>
      </main>
    </div>
  );
}
