import { appName } from "@web/lib/app-name.ts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Strip } from "@web/components/charts.tsx";
import { useListKeys } from "@web/components/task-tabs.tsx";
import { Empty, Load, SearchBox } from "@web/components/ui.tsx";
import { schedulesFn } from "@web/fns/tasks.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, inFuture } from "@web/lib/format.ts";
import { useState } from "react";

const search = z.object({ q: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/schedules")({ validateSearch: search, component: SchedulesPage });

type Clock = Awaited<ReturnType<typeof schedulesFn>>[number];
type Fate = "failing" | "silent" | "held" | "unknown" | "fine";

/** Late means twice its period plus the app's own late line: one slow run is not a stopped clock. */
function fateOf(clock: Clock, now: number): Fate {
  if (clock.switchOn === false) return "held";
  const silent = clock.periodMs > 0 && now - clock.last > clock.periodMs * 2 + 300_000;
  if (silent) return clock.switchOn === null ? "unknown" : "silent";
  return clock.inRow > 0 ? "failing" : "fine";
}

const GROUP: Record<Fate, string> = { failing: "Failing", silent: "Silent", unknown: "Silent", fine: "On time", held: "Held" };

function Row({ clock, fate, now }: { clock: Clock; fate: Fate; now: number }) {
  const late = fate === "silent" || fate === "unknown";
  return (
    <Link className={`schedules-row is-${fate}`} to="/tasks/kind/$kind" params={{ kind: clock.kind }}>
      <span className="schedules-name"><b className="mono">{clock.kind}</b><span>{clock.clock}</span></span>
      <span className="schedules-strip">{clock.strip.length ? <Strip items={clock.strip} count={30} /> : <span className={late ? "warn" : "t4"}>No run in 7 days</span>}</span>
      <span className={`schedules-last ${late ? "warn" : ""}`}>{clock.last ? ago(clock.last) : ""}</span>
      <span className="schedules-next">{fate === "held" ? "Will not fire" : clock.next ? inFuture(clock.next) : ""}</span>
      {fate === "held" && <p className="schedules-note">Switch <code>{clock.switch}</code> is off. It stays silent until someone turns it on in {appName}.</p>}
      {fate === "failing" && <p className="schedules-note err">The last {clock.inRow === 1 ? "run" : `${clock.inRow} runs`} failed.</p>}
    </Link>
  );
}

function SchedulesPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useScoped(schedulesFn, {});
  const [text, setText] = useState(s.q ?? "");
  const change = (value: string) => { setText(value); void navigate({ search: (prev) => ({ ...prev, q: value || undefined }), replace: true }); };
  useListKeys({ search: "schedules-find", rows: ".schedules-row", onClear: () => change("") });
  return (
    <Load q={q}>
      {(rows) => {
        if (!rows.length) return <Empty title="No clock defined" hint="Add every or at to a task in definitions/catalog." />;
        const now = Date.now();
        const withFate = rows.map((clock) => ({ clock, fate: fateOf(clock, now) }));
        const needle = text.trim().toLowerCase();
        const shown = withFate.filter(({ clock }) => clock.kind.includes(needle));
        const groups = (["failing", "silent", "fine", "held"] as Fate[]).map((group) => ({ group, list: shown.filter(({ fate }) => fate === group || (group === "silent" && fate === "unknown")).sort((a, b) => a.clock.kind.localeCompare(b.clock.kind)) })).filter(({ list }) => list.length);
        const unread = shown.filter(({ fate }) => fate === "unknown").map(({ clock }) => clock.switch);
        return (
          <div className="ov schedules">
            <div className="schedules-bar">
              <span className="t3 schedules-window">Last 7 days</span>
              <SearchBox id="schedules-find" value={text} onChange={change} placeholder="Find a clock" style={{ width: 220 }} />
            </div>
            <div className="schedules-head" aria-hidden="true">
              <span>Clock</span>
              <span>Last 30 runs</span>
              <span>Last ran</span>
              <span>Next</span>
            </div>
            {groups.map(({ group, list }) => (
              <section key={group}>
                <h3 className={`schedules-group is-${group}`}>
                  {GROUP[group]} <b>{list.length}</b>
                  {group === "silent" && unread.length > 0 && <span>{unread.length === 1 ? "Its switch" : `${unread.length} switches`} cannot be read here, so {unread.length === 1 ? "it" : "some of these"} may simply be off.</span>}
                </h3>
                {list.map(({ clock, fate }) => <Row key={clock.kind} clock={clock} fate={fate} now={now} />)}
              </section>
            ))}
            {!shown.length && <div className="schedules-none">No clock matches. <button className="tlink" onClick={() => { setText(""); void navigate({ search: (prev) => ({ ...prev, q: undefined }), replace: true }); }}>Clear the filters</button></div>}
          </div>
        );
      }}
    </Load>
  );
}
