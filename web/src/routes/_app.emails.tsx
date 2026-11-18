import { createFileRoute, Link } from "@tanstack/react-router";
import { share, useListKeys } from "@web/components/backend.tsx";
import { Icon } from "@web/components/icons.tsx";
import { Lanes } from "@web/components/lanes.tsx";
import { Empty, Load } from "@web/components/ui.tsx";
import { emailsFn } from "@web/fns/backend.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, compact, fms, hms } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

export const Route = createFileRoute("/_app/emails")({ component: EmailsPage });

const SENT = [{ key: "ok", label: "Sent", color: "var(--t3)" }, { key: "error", label: "Refused", color: "var(--err)" }];

function EmailsPage() {
  const scope = useScope();
  const q = useScoped(emailsFn, {});
  useListKeys();
  return (
    <Load q={q}>
      {(d) => {
        const { checked, delivered, bounced, complained, last } = d.delivery;
        if (!d.stats.sent && !d.stats.failed && !checked) return <Empty title="No email in this window" hint="Emails appear here from wide events with emails.sent and emails.failed. Delivery comes from the emails.delivery-check task." />;
        const waiting = Math.max(0, checked - delivered - bounced - complained);
        const most = Math.max(1, ...d.templates.map((t) => t.sent + t.failed));
        const parts = [
          { label: "Delivered", n: delivered, color: "var(--ok)" },
          { label: "Not confirmed yet", n: waiting, color: "var(--line3)" },
          { label: "Bounced", n: bounced, color: "var(--err)" },
          { label: "Complained", n: complained, color: "var(--err)" },
        ];
        const refusedOften = new Map<string, number>();
        for (const r of d.refused) refusedOften.set(r.error, (refusedOften.get(r.error) ?? 0) + 1);
        return (
          <div className="ov">
            <section className="mail-flow">
              <div className="mail-stages">
                <div className="mail-stage">
                  <span className="mail-l">Sent</span>
                  <b>{compact(d.stats.sent)}</b>
                  <span className="mail-n">{d.stats.failed ? <span className="err">{compact(d.stats.failed)} refused by SES</span> : "None refused"}</span>
                </div>
                <Icon name="chev" />
                <div className="mail-stage">
                  <span className="mail-l">Checked</span>
                  <b>{compact(checked)}</b>
                  <span className="mail-n">{last ? `Last check ${ago(last)}` : "No check ran"}</span>
                </div>
                <Icon name="chev" />
                <div className="mail-stage">
                  <span className="mail-l">Delivered</span>
                  <b className={delivered ? "ok" : ""}>{compact(delivered)}</b>
                  <span className="mail-n">{checked ? `${share(delivered, checked)} of checked` : "Nothing checked yet"}</span>
                </div>
                <span className="grow" />
                <div className={`mail-stage mail-bad ${bounced ? "on" : ""}`}>
                  <span className="mail-l">Bounced</span>
                  <b>{compact(bounced)}</b>
                  {bounced > 0 && <span className="mail-n">{share(bounced, checked)} of checked</span>}
                </div>
                <div className={`mail-stage mail-bad ${complained ? "on" : ""}`}>
                  <span className="mail-l">Complained</span>
                  <b>{compact(complained)}</b>
                  {complained > 0 && <span className="mail-n">{share(complained, checked)} of checked</span>}
                </div>
              </div>
              {checked > 0 && (
                <div className="xbar mail-bar" role="img" aria-label={parts.map((part) => `${part.label} ${part.n}`).join(", ")}>
                  {parts.filter((part) => part.n > 0).map((part) => <i key={part.label} title={`${part.label}: ${part.n}`} style={{ flexGrow: part.n, background: part.color }} />)}
                </div>
              )}
              {waiting > 0 && <div className="mail-wait">{compact(waiting)} checked and not confirmed yet</div>}
            </section>
            <Lanes from={scope.from} to={scope.to} height={46} lanes={[
              { id: "sent", label: "Sent", sub: d.stats.p95 ? `${fms(d.stats.p95)} to send, p95` : undefined, data: d.series, keys: SENT },
            ]} />
            <div className={d.refused.length ? "rt-two" : "rt-one"}>
              <section className="rt-list">
                <h3>By template</h3>
                {d.templates.map((t) => (
                  <div className="mail-tpl" key={t.template}>
                    <span className="mono grow ell">{t.template || "No template recorded"}</span>
                    {t.failed > 0 && <span className="err mono mail-ref">{t.failed} refused</span>}
                    <span className="share prov-bar"><i style={{ scale: `${(t.sent + t.failed) / most} 1` }} /></span>
                    <span className="mono t2 prov-n">{compact(t.sent)}</span>
                  </div>
                ))}
              </section>
              {d.refused.length > 0 && (
                <section className="rt-list">
                  <h3 className="err">Refused</h3>
                  {d.refused.map((r) => (
                    <Link key={r.id} className="lst mail-refused" to="/logs" search={{ event: r.id }}>
                      <span className="lt rt-time">{hms(r.t)}</span>
                      <span className="grow mail-rw">
                        <span className="mono ell">{r.template}</span>
                        <span className="err ell mail-why">{r.error}</span>
                      </span>
                    </Link>
                  ))}
                </section>
              )}
            </div>
          </div>
        );
      }}
    </Load>
  );
}
