import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Icon } from "@web/components/icons.tsx";
import { Avatar, Id, Levels, Load, looksLikeId, SearchBox } from "@web/components/ui.tsx";
import { usersFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, compact } from "@web/lib/format.ts";

const search = z.object({ q: z.string().optional().catch(undefined), only: z.enum(["errors"]).optional().catch(undefined), account: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/users/")({ validateSearch: search, component: UsersPage });

const title = (text: string) => (text ? text.charAt(0) + text.slice(1).toLowerCase() : "");

function UsersPage() {
  const q = useScoped(usersFn, {});
  const s = Route.useSearch();
  const navigate = useNavigate();
  const patch = (next: Partial<z.infer<typeof search>>, replace = false) => void navigate({ to: ".", search: ((prev: Record<string, unknown>) => ({ ...prev, ...next })) as never, replace });
  return (
    <Load q={q}>
      {(d) => {
        const inAccount = s.account ? d.rows.filter((u) => u.accountId === s.account) : d.rows;
        const low = (s.q ?? "").toLowerCase();
        const found = inAccount.filter((u) => `${u.name} ${u.id} ${u.account} ${u.role}`.toLowerCase().includes(low));
        const failing = found.filter((u) => u.errors > 0).length;
        const rows = [...found].filter((u) => s.only !== "errors" || u.errors > 0).sort((a, b) => b.errors - a.errors || b.requests - a.requests);
        const most = Math.max(1, ...found.map((u) => u.requests));
        const accountName = s.account ? (inAccount[0]?.account ?? s.account) : "";
        return (
          <>
            <div className="subbar home-bar">
              <SearchBox id="home-people-q" value={s.q ?? ""} onChange={(value) => patch({ q: value || undefined }, true)} placeholder="Search by name, account or id" />
              <Levels value={s.only ?? "all"} onChange={(value) => patch({ only: value === "errors" ? "errors" : undefined })} options={failing ? [["all", `Everyone ${found.length}`], ["errors", <span className="err" key="e">Hit errors {failing}</span>]] : []} />
              {s.account && (
                <button className="fchip home-chip" onClick={() => patch({ account: undefined })} title="Show every account">
                  <span className="t3">Account</span> {looksLikeId(accountName) ? `${accountName.slice(0, 8)}…` : accountName}
                  <Icon name="x" size={11} />
                </button>
              )}
            </div>
            {rows.length ? (
              <div className="home-ledger home-people">
                <div className="home-lh" aria-hidden="true"><span>Person</span><span>Account</span><span className="r">Requests</span><span className="r">Errors</span><span className="r">Last seen</span></div>
                {rows.map((u) => {
                  const open = () => void navigate({ to: "/users/$id", params: { id: u.id }, search: ((prev: Record<string, unknown>) => ({ ...prev, show: undefined })) as never });
                  return (
                    <div key={u.id} className="home-row home-keyrow" tabIndex={0} role="link" onClick={open} onKeyDown={(event) => { if (event.key === "Enter") open(); }}>
                      <span className="home-who">
                        {looksLikeId(u.name) ? <><span className="home-noava"><Icon name="user" size={12} /></span><Id value={u.name} /></> : <><Avatar name={u.name} size={22} /><b className="ell">{u.name}</b></>}
                        {u.role && <small className="t3">{title(u.role)}</small>}
                      </span>
                      <span className="home-cell-acc ell">
                        {u.accountId ? (
                          <button className="lnk-quiet ell" title={`Only ${u.account}`} onClick={(event) => { event.stopPropagation(); patch({ account: u.accountId }); }}>
                            {looksLikeId(u.account) ? <span className="mono">{u.account.slice(0, 8)}…</span> : u.account}
                          </button>
                        ) : null}
                      </span>
                      <span className="home-use">
                        <span className="share"><i style={{ scale: `${u.requests / most} 1` }} /></span>
                        <b>{compact(u.requests)}<small className="home-ph">requests</small></b>
                      </span>
                      <span className="r num">
                        {u.errors ? (
                          <Link className="err home-fig-link" to="/logs" search={((prev: Record<string, unknown>) => ({ ...prev, level: "error", filters: [{ field: "user.id", op: "is", values: [u.id] }] })) as never} onClick={(event) => event.stopPropagation()}>{compact(u.errors)}</Link>
                        ) : <span className="t4">0</span>}
                        <small className="home-ph">errors</small>
                      </span>
                      <span className="r t3">{ago(u.lastSeen)}</span>
                    </div>
                  );
                })}
              </div>
            ) : d.rows.length ? (
              <div className="home-quiet">
                <b>Nobody matches this</b>
                <div><button className="btn" onClick={() => patch({ q: undefined, only: undefined, account: undefined })}>Clear the filters</button></div>
              </div>
            ) : (
              <div className="home-quiet">
                <b>Nobody was active in this window</b>
                <span>A person appears here once a wide event carries <span className="mono">user.id</span>. Names come from your app's people view.</span>
              </div>
            )}
          </>
        );
      }}
    </Load>
  );
}
