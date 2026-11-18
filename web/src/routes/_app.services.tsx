import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useListKeys } from "@web/components/backend.tsx";
import { Empty, Load } from "@web/components/ui.tsx";
import { servicesFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, compact, fms, shortService } from "@web/lib/format.ts";

export const Route = createFileRoute("/_app/services")({ component: ServicesPage });

const QUIET_MS = 10 * 60_000;
const short = (version: string) => (version ? version.slice(0, 7) : "No version");

function ServicesPage() {
  const q = useScoped(servicesFn, {});
  const navigate = useNavigate();
  useListKeys();
  return (
    <Load q={q}>
      {(rows) => {
        if (!rows.length) return <Empty title="No service has sent anything yet" hint="A service appears here with its first event over OTLP." />;
        const reporting = rows.filter((s) => Date.now() - s.lastSeen <= QUIET_MS).length;
        const versions = [...new Set(rows.flatMap((s) => s.instanceRows.map((i) => i.version)).filter(Boolean))];
        return (
          <div className="ov">
            <section className="svc-sum">
              <span className={`svc-big ${reporting === rows.length ? "ok" : "warn"}`}>{reporting} of {rows.length} reporting</span>
              {versions.length === 1 && <span className="t3">All on <span className="mono t1">{short(versions[0]!)}</span></span>}
              {versions.length > 1 && <span className="warn">{versions.length} versions running</span>}
            </section>
            {rows.map((s) => {
              const seenNow = Date.now() - s.lastSeen <= QUIET_MS;
              const open = () => void navigate({ to: "/logs", search: { svc: s.name } as never });
              const instance = s.instanceRows[0]?.id;
              return (
                <section className="svc-one" key={s.name}>
                  <div className="svc-row" data-row tabIndex={0} role="link" onClick={open} onKeyDown={(event) => event.key === "Enter" && open()}>
                    <span className="svc-who">
                      <b>{shortService(s.name)}</b>
                      <span className={seenNow ? "ok" : "warn"}>{seenNow ? "Reporting" : `Quiet, seen ${ago(s.lastSeen)}`}</span>
                    </span>
                    <span className="svc-fig"><span>Events</span><b>{compact(s.perMinute)}/min</b></span>
                    <span className="svc-fig"><span>Failed</span><b className={s.errors ? "err" : "t3"}>{s.errors ? compact(s.errors) : "None"}</b></span>
                    <span className="svc-fig"><span>p95</span><b>{fms(s.p95)}</b></span>
                    <span className="grow" />
                    <Link className="tlink svc-link" to="/logs" search={{ svc: s.name } as never} onClick={(event) => event.stopPropagation()}>Logs</Link>
                    {instance && <Link className="tlink svc-link" to="/runtime" search={{ instance }} onClick={(event) => event.stopPropagation()}>Runtime</Link>}
                  </div>
                  {s.instanceRows.map((i) => (
                    <Link key={i.id} className="lst svc-inst" to="/runtime" search={{ instance: i.id }}>
                      <span className="mono t2 svc-id">{i.id.slice(0, 12)}</span>
                      <span className={`mono svc-ver ${versions.length > 1 && i.version !== versions[0] ? "warn" : "t3"}`}>{short(i.version)}</span>
                      <span className="grow" />
                      <span className="mono t3">{compact(i.events)} events</span>
                      <span className="t3 svc-seen">{ago(i.lastSeen)}</span>
                    </Link>
                  ))}
                </section>
              );
            })}
          </div>
        );
      }}
    </Load>
  );
}
