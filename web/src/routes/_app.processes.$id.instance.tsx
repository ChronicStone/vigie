import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { Icon } from "@web/components/icons.tsx";
import { inWords } from "@web/components/task-tabs.tsx";
import { Back, copy, Id, Load, Subject } from "@web/components/ui.tsx";
import { instanceFn } from "@web/fns/tasks.ts";
import { useScoped } from "@web/lib/api.ts";
import { dayMonth, fms, hms, span } from "@web/lib/format.ts";

const search = z.object({ key: z.string().catch("") });
export const Route = createFileRoute("/_app/processes/$id/instance")({ validateSearch: search, component: InstancePage });

type Instance = Awaited<ReturnType<typeof instanceFn>>;
type Dest = Instance["destinations"][number];

const WORD: Record<string, string> = { done: "Done", failed: "Failed", retrying: "Waiting", running: "Running", pending: "Not reached yet", skipped: "Not needed", decided: "Nothing to do" };

function verdictOf(d: Instance) {
  const subject = d.process.subject;
  if (d.state === "failed") return { tone: "err", text: `This ${subject} failed at ${d.at}.` };
  if (d.state === "stuck") return { tone: "warn", text: `This ${subject} has been stuck at ${d.at} for ${span(d.waited)}.` };
  if (d.state === "done") {
    const stopped = d.destinations.find((dest) => dest.state === "decided");
    return { tone: "", text: stopped ? `This ${subject} finished early: ${stopped.label} decided there was nothing to do.` : `This ${subject} reached every destination in ${span(d.lastAt - d.firstAt)}.` };
  }
  const current = d.destinations.find((dest) => dest.state === "running" || dest.state === "retrying") ?? d.destinations.find((dest) => dest.state === "pending");
  return { tone: "", text: current ? `This ${subject} is on its way, next at ${current.label}.` : `This ${subject} is on its way.` };
}

function Stop({ dest, here, events, open }: { dest: Dest; here: boolean; events: Instance["events"]; open: boolean }) {
  const tone = dest.state === "failed" ? "err" : here ? "warn" : dest.state === "done" ? "ok" : dest.state === "pending" || dest.state === "skipped" ? "off" : "plain";
  const body = (
    <>
      <i className={`processes-stop-dot is-${tone}`}>{dest.state === "done" ? <Icon name="check" /> : null}</i>
      <span className="processes-stop-t">
        <b>{dest.label}{here && <em className={dest.state === "failed" ? "err" : "warn"}>It is here</em>}</b>
        <span>{dest.state === "skipped" && open ? "Not reached yet" : WORD[dest.state]}{dest.code ? `: ${inWords(dest.code).toLowerCase()}` : ""}{dest.attempts > 1 ? `, ${dest.attempts} attempts` : ""}{dest.state === "pending" && dest.expectWithin ? `, expected within ${dest.expectWithin}` : ""}</span>
      </span>
      {dest.first > 0 && <span className="processes-stop-m"><span className="mono">{hms(dest.first)}</span><span className="mono t3">{fms(dest.duration)}</span></span>}
    </>
  );
  return (
    <li className={`processes-stop ${here ? "is-here" : ""} is-${tone}`}>
      {dest.taskId ? <Link className="processes-stop-row" to="/tasks/run/$id" params={{ id: dest.taskId }}>{body}</Link> : <div className="processes-stop-row">{body}</div>}
      {events.length > 1 && (
        <ol className="processes-tries">
          {events.map((event, i) => (
            <li key={i}><Link to="/tasks/run/$id" params={{ id: event.taskId }}>
              <span className="mono t3">{hms(event.t)}</span>
              <span className={event.outcome === "failed" && event.type !== "RETRY" ? "err" : "t2"}>{event.type ? inWords(event.type) : inWords(event.outcome)}{event.code ? `: ${inWords(event.code).toLowerCase()}` : ""}</span>
              <span className="mono t3">{fms(event.duration)}</span>
            </Link></li>
          ))}
        </ol>
      )}
    </li>
  );
}

function InstancePage() {
  const { id } = Route.useParams();
  const { key } = Route.useSearch();
  const router = useRouter();
  const q = useScoped(instanceFn, { id, key });
  return (
    <Load q={q}>
      {(d) => {
        const verdict = verdictOf(d);
        const byKind = new Map(d.destinations.map((dest) => [dest.kind, dest]));
        const failing = d.atKind ? byKind.get(d.atKind) : undefined;
        const groups = d.process.steps.map((kinds) => kinds.map((kind) => byKind.get(kind)!).filter(Boolean));
        return (
          <div className="ov processes-instance">
            <div className="dh">
              <Back to={router.history.canGoBack() ? undefined : `/processes/${id}`} title="Back" />
              <h2><Subject value={key} /></h2>
              <span className="dhm">{d.process.title}</span>
              <span className="dhr">
                <button className="btn processes-prompt" onClick={() => copy(`${verdict.text}\nProcess: ${d.process.title}\nKey: ${key}\nwhy: ${d.why}\nfix: ${d.fix}\n${d.events.map((e) => `${new Date(e.t).toISOString()} ${e.label} attempt ${e.attempt} ${e.outcome} ${e.code}`).join("\n")}`, "Agent prompt copied")}><Icon name="copy" />Agent prompt</button>
                {failing?.taskId && <Link className="btn pri" to="/tasks/run/$id" params={{ id: failing.taskId }}>Open the run</Link>}
              </span>
            </div>
            <div className="processes-answer">
              <p className={verdict.tone}>{verdict.text}</p>
              {d.state !== "done" && (d.why || d.fix) && (
                <dl>
                  {d.why && <><dt>Why</dt><dd>{d.why}</dd></>}
                  {d.fix && <><dt>Do</dt><dd>{d.fix}</dd></>}
                </dl>
              )}
              <div className="processes-answer-m">
                <span>Started {dayMonth(d.firstAt)}, {hms(d.firstAt)}</span>
                <span>Last seen {hms(d.lastAt)}</span>
                {d.accountId && <span>Account <Id value={d.accountId} keep={13} /></span>}
              </div>
            </div>
            <ol className="processes-journey">
              {groups.map((group, i) => (
                <li key={i} className={group.length > 1 ? "processes-together" : ""}>
                  {group.length > 1 && <h4>At the same time</h4>}
                  <ol>
                    {group.map((dest) => <Stop key={dest.kind} dest={dest} here={dest.kind === d.atKind} events={d.events.filter((event) => event.kind === dest.kind)} open={d.state !== "done"} />)}
                  </ol>
                </li>
              ))}
            </ol>
          </div>
        );
      }}
    </Load>
  );
}
