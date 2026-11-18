import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { NoMatch, useListKeys } from "@web/components/backend.tsx";
import { Hl } from "@web/components/code.tsx";
import { Empty, Levels, Load, SearchBox } from "@web/components/ui.tsx";
import { commandsFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { dayMonth, fms, hm, shortService } from "@web/lib/format.ts";

const search = z.object({ find: z.string().optional().catch(undefined), show: z.enum(["failed"]).optional().catch(undefined) });
export const Route = createFileRoute("/_app/commands")({ validateSearch: search, component: CommandsPage });

function CommandsPage() {
  const { find = "", show } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useScoped(commandsFn, {});
  const set = (next: { find?: string; show?: "failed" }) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  useListKeys("cmdrun-find", () => set({ find: undefined }));
  return (
    <Load q={q}>
      {(d) => {
        if (!d.recent.length) return <Empty title="No command ran in this window" hint="Commands the app runs by hand or on deploy show here. Scheduled work is under Tasks." />;
        const failed = d.recent.filter((r) => r.outcome === "failed" || (r.exitCode && r.exitCode !== "0"));
        const lower = find.toLowerCase();
        const isBad = (r: (typeof d.recent)[number]) => r.outcome === "failed" || Boolean(r.exitCode && r.exitCode !== "0");
        const rows = d.recent.filter((r) => (show ? isBad(r) : true) && `${r.name} ${r.args}`.toLowerCase().includes(lower));
        const days: { day: string; rows: typeof rows }[] = [];
        for (const row of rows) {
          const day = dayMonth(row.t);
          if (days[days.length - 1]?.day !== day) days.push({ day, rows: [] });
          days[days.length - 1]!.rows.push(row);
        }
        return (
          <div className="cmdrun-page">
            <div className="subbar cmdrun-tools">
              <SearchBox id="cmdrun-find" value={find} onChange={(value) => set({ find: value || undefined })} placeholder="Find a command" />
              <Levels value={show ?? "all"} onChange={(value) => set({ show: value === "all" ? undefined : value })} options={[["all", `All ${d.recent.length}`], ...(failed.length || show ? [["failed", `Failed ${failed.length}`] as const] : [])]} />
            </div>
            {!rows.length && <NoMatch what="command" onClear={() => set({ find: undefined, show: undefined })} />}
            <div className="cmdrun-list">
              {days.map((group) => (
                <section key={group.day} className="cmdrun-day">
                  <h3>{group.day}</h3>
                  {group.rows.map((r) => {
                    const bad = isBad(r);
                    const body = (
                      <>
                        <span className={`cmdrun-mark ${bad ? "bad" : ""}`} aria-label={bad ? "Failed" : "Worked"} />
                        <span className="lt cmdrun-t">{hm(r.t)}</span>
                        <span className="cmdrun-main">
                          <span className="cmdrun-cmd">
                            <span className={`mono cmdrun-name ${bad ? "err" : ""}`}>{r.name}</span>
                            {r.args && <span className="mono ell cmdrun-args"><Hl>{r.args}</Hl></span>}
                          </span>
                          {bad && r.error && <span className="err ell cmdrun-err">{r.error}</span>}
                        </span>
                        {bad && r.exitCode && r.exitCode !== "0" && <span className="mono err cmdrun-exit">exit {r.exitCode}</span>}
                        <span className="t3 cmdrun-svc">{shortService(r.service)}</span>
                        <span className="mono t2 cmdrun-dur">{fms(r.duration)}</span>
                      </>
                    );
                    return r.traceId
                      ? <Link key={r.id} className="lst cmdrun-row" to="/traces/$id" params={{ id: r.traceId }}>{body}</Link>
                      : <Link key={r.id} className="lst cmdrun-row" to="/logs" search={{ event: r.id }}>{body}</Link>;
                  })}
                </section>
              ))}
            </div>
          </div>
        );
      }}
    </Load>
  );
}
