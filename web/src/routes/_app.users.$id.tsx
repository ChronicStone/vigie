import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";
import { Avatar, Chip, Head, Levels, Load, looksLikeId, Method, RoutePath } from "@web/components/ui.tsx";
import { userFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { compact, dayMonth, fms, hm, hms, num, span, statusClass } from "@web/lib/format.ts";

const search = z.object({ show: z.enum(["all", "failed"]).optional().catch(undefined), q: z.string().optional().catch(undefined), only: z.enum(["errors"]).optional().catch(undefined), account: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/users/$id")({ validateSearch: search, component: UserPage });

type Data = Awaited<ReturnType<typeof userFn>>;
type Item =
  | { type: "reads"; t: number; bad: false; count: number }
  | { type: "request"; t: number; bad: boolean; event: Data["events"][number]; times: number }
  | { type: "task"; t: number; bad: boolean; task: Data["tasks"][number] };

/** A quiet stretch this long ends one sitting and starts the next. */
const SESSION_GAP = 30 * 60_000;

/** One history, newest first: requests and tasks together, a repeat folded into one line, a failure never folded. */
function historyOf(d: Data, show: "actions" | "all" | "failed") {
  const items: Item[] = [
    ...d.events.map((event): Item => ({ type: "request", t: event.t, bad: event.status >= 500, event, times: 1 })),
    ...d.tasks.map((task): Item => ({ type: "task", t: task.t, bad: task.outcome !== "succeeded", task })),
  ].sort((a, b) => b.t - a.t);
  const sessions: { items: Item[]; last: number; first: number; requests: number; failed: number }[] = [];
  for (const item of items) {
    let session = sessions[sessions.length - 1];
    if (!session || session.first - item.t > SESSION_GAP) {
      session = { items: [], last: item.t, first: item.t, requests: 0, failed: 0 };
      sessions.push(session);
    }
    session.first = item.t;
    if (item.type === "request") session.requests++;
    if (item.bad) session.failed++;
    if (show === "failed" && !item.bad) continue;
    const previous = session.items[session.items.length - 1];
    if (show === "actions" && item.type === "request" && !item.bad && item.event.method === "GET") {
      if (previous?.type === "reads") previous.count++;
      else session.items.push({ type: "reads", t: item.t, bad: false, count: 1 });
      continue;
    }
    if (item.type === "request" && !item.bad && previous?.type === "request" && !previous.bad && previous.event.method === item.event.method && previous.event.route === item.event.route) previous.times++;
    else session.items.push(item);
  }
  return sessions.filter((session) => session.items.length);
}

function UserPage() {
  const { id } = Route.useParams();
  const q = useScoped(userFn, { id });
  const s = Route.useSearch();
  const navigate = useNavigate();
  const onlyFailed = s.show === "failed";
  const show = s.show ?? "actions";
  const sessions = useMemo(() => (q.data ? historyOf(q.data, show) : []), [q.data, show]);
  return (
    <Load q={q}>
      {(d) => {
        const failedRequests = d.events.filter((e) => e.status >= 500).length;
        const failedTasks = d.tasks.filter((t) => t.outcome !== "succeeded").length;
        const failed = failedRequests + failedTasks;
        const role = d.stats.role ? d.stats.role.charAt(0) + d.stats.role.slice(1).toLowerCase() : "";
        const account = looksLikeId(d.account) ? `${d.account.slice(0, 8)}…` : d.account;
        const named = !looksLikeId(d.name);
        return (
          <div className="home-person">
            <Head back="/users" backTitle="Back to people" title={<span className="row">{named && <Avatar name={d.name} size={20} />}<span className={named ? "" : "mono"}>{named ? d.name : `${d.name.slice(0, 12)}…`}</span></span>} meta={
              <span className="dhm">
                {role}{role && account ? " at " : ""}
                {d.stats.accountId && <Link className="lnk-quiet" to="/users" search={((prev: Record<string, unknown>) => ({ ...prev, account: d.stats.accountId, show: undefined })) as never}>{account}</Link>}
              </span>
            } />
            <div className="home-person-sum">
              <span className="home-sumfig"><b>{num(d.stats.requests)}</b> requests</span>
              <span className="home-sumfig"><b className={d.stats.errors ? "err" : ""}>{num(d.stats.errors)}</b> errors</span>
              <span className="home-sumfig"><b>{fms(d.stats.p95)}</b> p95</span>
              <span className="home-sumfig"><b>{num(d.stats.tasks)}</b> task runs</span>
              <span className="grow" />
              <Levels value={show} onChange={(value) => void navigate({ to: ".", search: ((prev: Record<string, unknown>) => ({ ...prev, show: value === "actions" ? undefined : value })) as never })} options={[["actions", "Actions"], ["all", "With reads"], ...(failed ? [["failed", <span className="err" key="f">Failed {failed}</span>] as const] : [])]} />
            </div>
            <div className="home-history">
              {sessions.map((session) => (
                <section key={session.last} className="home-session">
                  <header className="home-session-h">
                    <b>{dayMonth(session.last)}, {hm(session.first)}{session.last - session.first >= 60_000 ? ` to ${hm(session.last)}` : ""}</b>
                    {session.last - session.first >= 60_000 && <span className="t3">{span(session.last - session.first)}</span>}
                    <span className="t3">{compact(session.requests)} {session.requests === 1 ? "request" : "requests"}</span>
                    {session.failed > 0 && <span className="err">{session.failed} failed</span>}
                  </header>
                  {session.items.map((item) =>
                    item.type === "reads" ? (
                      <div key={`r${item.t}`} className="home-ev home-ev-reads">
                        <span className="home-ev-t" />
                        <i className="home-ev-dot quiet" aria-hidden="true" />
                        <span>{item.count} {item.count === 1 ? "read" : "reads"}</span>
                      </div>
                    ) : item.type === "request" ? (
                      <Link key={item.event.id} className={`home-ev home-keyrow ${item.bad ? "bad" : ""} ${item.event.method === "GET" ? "read" : "write"}`} to="/traces/$id" params={{ id: item.event.traceId }}>
                        <span className="home-ev-t">{hms(item.t)}</span>
                        <i className="home-ev-dot" aria-hidden="true" />
                        <span className="home-ev-what mono ell"><Method m={item.event.method} /> <RoutePath path={item.event.route} />{item.times > 1 && <small> × {item.times}</small>}</span>
                        <span className={`mono home-ev-st ${statusClass(item.event.status)}`}>{item.event.status}</span>
                        <span className={`mono home-ev-d ${item.event.duration >= 800 ? "warn" : "t3"}`}>{fms(item.event.duration)}</span>
                      </Link>
                    ) : (
                      <Link key={`t${item.task.id}`} className={`home-ev home-keyrow write ${item.bad ? "bad" : ""}`} to="/tasks/run/$id" params={{ id: item.task.id }}>
                        <span className="home-ev-t">{hms(item.t)}</span>
                        <i className="home-ev-dot task" aria-hidden="true" />
                        <span className="home-ev-what mono ell"><span className="m-task">task</span> {item.task.kind}</span>
                        <span className="home-ev-st"><Chip tone={item.bad ? "err" : "ok"}>{item.bad ? "Failed" : "Done"}</Chip></span>
                        <span className="home-ev-d" />
                      </Link>
                    ),
                  )}
                </section>
              ))}
              {!sessions.length && (
                <div className="home-quiet">
                  <b>{onlyFailed ? "Nothing failed for this person in this window" : "No request or task for this person in this window"}</b>
                  {onlyFailed && <div><button className="btn" onClick={() => void navigate({ to: ".", search: ((prev: Record<string, unknown>) => ({ ...prev, show: undefined })) as never })}>Show everything</button></div>}
                </div>
              )}
              {d.events.length >= 400 && <div className="home-history-end t3">The latest 400 requests. Narrow the time range to go further back.</div>}
            </div>
          </div>
        );
      }}
    </Load>
  );
}
