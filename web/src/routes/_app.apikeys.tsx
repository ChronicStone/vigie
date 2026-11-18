import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Load, looksLikeId, Sql } from "@web/components/ui.tsx";
import { apiKeysFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, compact } from "@web/lib/format.ts";

export const Route = createFileRoute("/_app/apikeys")({ component: ApiKeysPage });

const logsOf = (filters: { field: string; op: string; values: string[] }[]) => ((prev: Record<string, unknown>) => ({ ...prev, filters })) as never;

/** Keys with refused calls rise: a key being refused is either broken or being abused, and both need someone. */
function ApiKeysPage() {
  const q = useScoped(apiKeysFn, {});
  const navigate = useNavigate();
  return (
    <Load q={q}>
      {(d) => {
        if (!d.keys.length) {
          return (
            <div className="home-connect">
              <b>No API key was used in this window</b>
              <span>A key appears here the first time a request carries <span className="mono">apiKey.id</span> on its wide event. Send the key's id, never its secret.</span>
              <Sql text={`{ "apiKey": { "id": "key_3a90" }, "workspace": { "accountId": "…" } }`} lang="json" />
            </div>
          );
        }
        const rows = [...d.keys].sort((a, b) => b.denied - a.denied || b.errors - a.errors || b.calls - a.calls);
        const most = Math.max(1, ...rows.map((k) => k.calls));
        const reasonMost = Math.max(1, ...d.denied.map((x) => x.n));
        return (
          <div className="home-keys">
            <div className="home-person-sum">
              <span className="home-sumfig"><b>{compact(d.stats.calls)}</b> calls</span>
              {d.stats.denied > 0 ? <Link className="home-sumfig" to="/logs" search={logsOf([{ field: "outcome", op: "is", values: ["denied"] }, { field: "apiKey.id", op: "exists", values: [] }])}><b className="warn">{compact(d.stats.denied)}</b> refused</Link> : <span className="home-sumfig"><b>0</b> refused</span>}
              <span className="home-sumfig"><b className={d.stats.errors >= 5 ? "err" : ""}>{d.stats.errors.toFixed(1)}%</b> errors</span>
            </div>
            <div className="home-ledger home-keytable">
              <div className="home-lh" aria-hidden="true"><span>Key</span><span>Account</span><span className="r">Calls</span><span className="r">Refused</span><span className="r">Errors</span><span className="r">Last used</span></div>
              {rows.map((k) => {
                const open = () => void navigate({ to: "/logs", search: logsOf([{ field: "apiKey.id", op: "is", values: [k.key] }]) });
                return (
                  <div key={k.key} className="home-row home-keyrow" tabIndex={0} role="link" onClick={open} onKeyDown={(event) => { if (event.key === "Enter") open(); }}>
                    <span className="home-who"><b className="mono ell">{k.key}</b></span>
                    <span className="home-cell-acc ell">
                      {k.accountId && <Link className="lnk-quiet" to="/users" search={((prev: Record<string, unknown>) => ({ ...prev, account: k.accountId })) as never} onClick={(event) => event.stopPropagation()}>{looksLikeId(k.account) ? <span className="mono">{k.account.slice(0, 8)}…</span> : k.account}</Link>}
                    </span>
                    <span className="home-use">
                      <span className="share"><i style={{ scale: `${k.calls / most} 1` }} /></span>
                      <b>{compact(k.calls)}<small className="home-ph">calls</small></b>
                    </span>
                    <span className={`r num ${k.denied ? "warn" : "t4"}`}>{compact(k.denied)}<small className="home-ph">refused</small></span>
                    <span className={`r num ${k.errors ? "err" : "t4"}`}>{compact(k.errors)}<small className="home-ph">errors</small></span>
                    <span className="r t3">{ago(k.lastUsed)}</span>
                  </div>
                );
              })}
            </div>
            {d.denied.length > 0 && (
              <section className="home-reasons">
                <div className="home-eh"><span className="home-h">Why calls were refused</span></div>
                {d.denied.map((x) => (
                  <Link key={x.reason} className="home-reason home-keyrow" to="/logs" search={logsOf([{ field: "outcome", op: "is", values: ["denied"] }, { field: "reason", op: "is", values: [x.reason] }])}>
                    <span className="ell">{x.reason}</span>
                    <span className="home-wbar"><i style={{ background: "var(--warn)", scale: `${x.n / reasonMost} 1` }} /></span>
                    <b>{compact(x.n)}</b>
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
