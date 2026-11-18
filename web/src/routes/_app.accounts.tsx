import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Levels, Load, looksLikeId, SearchBox } from "@web/components/ui.tsx";
import { accountsFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, compact, fms } from "@web/lib/format.ts";

const search = z.object({ q: z.string().optional().catch(undefined), only: z.enum(["failing"]).optional().catch(undefined) });
export const Route = createFileRoute("/_app/accounts")({ validateSearch: search, component: AccountsPage });

const hurt = (a: { failed: number; tasksFailed: number }) => a.failed + a.tasksFailed;

/** A row opens the people of that account, worst first: that is who to call. */
function AccountsPage() {
  const q = useScoped(accountsFn, {});
  const s = Route.useSearch();
  const navigate = useNavigate();
  const patch = (next: Partial<z.infer<typeof search>>, replace = false) => void navigate({ to: ".", search: ((prev: Record<string, unknown>) => ({ ...prev, ...next })) as never, replace });
  return (
    <Load q={q}>
      {(all) => {
        const low = (s.q ?? "").toLowerCase();
        const found = all.filter((a) => `${a.name} ${a.id}`.toLowerCase().includes(low));
        const failing = found.filter((a) => hurt(a) > 0).length;
        const rows = found.filter((a) => s.only !== "failing" || hurt(a) > 0).sort((a, b) => hurt(b) - hurt(a) || b.requests - a.requests);
        const most = Math.max(1, ...found.map((a) => a.requests));
        return (
          <>
            <div className="subbar home-bar">
              <SearchBox id="home-accounts-q" value={s.q ?? ""} onChange={(value) => patch({ q: value || undefined }, true)} placeholder="Search by name or id" />
              <Levels value={s.only ?? "all"} onChange={(value) => patch({ only: value === "failing" ? "failing" : undefined })} options={failing ? [["all", `All ${found.length}`], ["failing", <span className="err" key="f">Affected {failing}</span>]] : []} />
            </div>
            {rows.length ? (
              <div className="home-ledger home-accounts">
                <div className="home-lh" aria-hidden="true"><span>Account</span><span className="r">Requests</span><span className="r">Failed requests</span><span className="r">Failed tasks</span><span className="r">p95</span><span className="r">Last seen</span></div>
                {rows.map((a) => {
                  const open = () => void navigate({ to: "/users", search: ((prev: Record<string, unknown>) => ({ ...prev, q: undefined, only: undefined, account: a.id })) as never });
                  const named = !looksLikeId(a.name);
                  return (
                    <div key={a.id} className="home-row home-keyrow" tabIndex={0} role="link" onClick={open} onKeyDown={(event) => { if (event.key === "Enter") open(); }}>
                      <span className="home-who">
                        <b className={`ell ${named ? "" : "mono"}`} title={a.id}>{named ? a.name : `${a.name.slice(0, 12)}…`}</b>
                        <small className="t3">{a.people} {a.people === 1 ? "person" : "people"}</small>
                      </span>
                      <span className="home-use">
                        <span className="share"><i style={{ scale: `${a.requests / most} 1` }} /></span>
                        <b>{compact(a.requests)}<small className="home-ph">requests</small></b>
                      </span>
                      <span className="r num">
                        {a.failed ? <Link className="err home-fig-link" to="/logs" search={((prev: Record<string, unknown>) => ({ ...prev, filters: [{ field: "workspace.accountId", op: "is", values: [a.id] }, { field: "status", op: "gte", values: ["500"] }] })) as never} onClick={(event) => event.stopPropagation()}>{compact(a.failed)}</Link> : <span className="t4">0</span>}
                        <small className="home-ph">failed</small>
                      </span>
                      <span className="r num">
                        {a.tasksFailed ? <Link className="err home-fig-link" to="/tasks/all" search={((prev: Record<string, unknown>) => ({ ...prev, state: "FAILED", account: a.id })) as never} onClick={(event) => event.stopPropagation()}>{compact(a.tasksFailed)}</Link> : <span className="t4">0</span>}
                        <small className="home-ph">tasks failed</small>
                      </span>
                      <span className={`r num ${a.p95 >= 1000 ? "warn" : "t2"}`}>{fms(a.p95)}<small className="home-ph">p95</small></span>
                      <span className="r t3">{ago(a.lastSeen)}</span>
                    </div>
                  );
                })}
              </div>
            ) : all.length ? (
              <div className="home-quiet">
                <b>No account matches this</b>
                <div><button className="btn" onClick={() => patch({ q: undefined, only: undefined })}>Clear the filters</button></div>
              </div>
            ) : (
              <div className="home-quiet">
                <b>No account was active in this window</b>
                <span>An account appears here once a wide event carries <span className="mono">workspace.accountId</span>. Names come from your app's people view.</span>
              </div>
            )}
          </>
        );
      }}
    </Load>
  );
}
