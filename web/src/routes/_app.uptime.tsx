import { Dialog } from "@base-ui/react/dialog";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Part } from "@web/components/reliability.tsx";
import { Confirm, Empty, Load } from "@web/components/ui.tsx";
import { toast } from "@web/components/toast.tsx";
import { checkMonitorFn, createMonitorFn, deleteMonitorFn, pauseMonitorFn, statusPageFn, uptimeFn } from "@web/fns/reliability.ts";
import { errorText, useAct, useFn } from "@web/lib/api.ts";
import { dayMonth, fms, hm, span } from "@web/lib/format.ts";

export const Route = createFileRoute("/_app/uptime")({ component: UptimePage });

type Monitor = Awaited<ReturnType<typeof uptimeFn>>["rows"][number];

const barTone = (share: number | null) => (share === null ? "none" : share >= 99.9 ? "ok" : share >= 95 ? "warn" : "err");

const newMonitor = z.object({ name: z.string().trim().min(1, "Give it a name."), url: z.string().url("Enter a full URL, with https://."), expect: z.string().regex(/^(\d{3})?$/, "A status has three digits.") });

function AddMonitor({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="btn pri">Add monitor</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="dlgback" />
        <Dialog.Popup className="dlg">
          <Dialog.Title className="dlgt">Add a monitor</Dialog.Title>
          <MonitorForm onDone={() => { setOpen(false); onDone(); }} onCancel={() => setOpen(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MonitorForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const create = useAct(createMonitorFn);
  const form = useForm({
    defaultValues: { name: "", url: "", expect: "" },
    validators: { onSubmit: newMonitor },
    onSubmit: ({ value }) => {
      create.mutate({ name: value.name, url: value.url, expect: value.expect ? Number(value.expect) : null }, { onSuccess: () => { toast("Monitor added. First check within a minute."); form.reset(); onDone(); }, onError: (error) => toast(errorText(error)) });
    },
  });
  return (
    <form className="monadd" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      {([["name", "Name", "Public API"], ["url", "URL", "https://api.example.com/health"], ["expect", "Status, optional", "Under 400"]] as const).map(([name, label, placeholder]) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <label>
              <span>{label}</span>
              <input className="input" placeholder={placeholder} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} />
              {field.state.meta.errors[0] && <small className="err">{field.state.meta.errors[0].message}</small>}
            </label>
          )}
        </form.Field>
      ))}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn pri" disabled={create.isPending}>Add monitor</button>
      </div>
    </form>
  );
}

function stateOf(m: Monitor) {
  if (m.paused) return { text: "Paused", tone: "" };
  if (m.state === "down") return { text: m.since ? `Down for ${span(Date.now() - m.since)}` : "Down", tone: "err" };
  if (m.state === "up") return { text: m.since ? `Up for ${span(Date.now() - m.since)}` : "Up", tone: "" };
  return { text: "Waiting for the first check", tone: "" };
}

function MonitorRow({ m, onCheck, onPause, onDelete }: { m: Monitor; onCheck: () => void; onPause: () => void; onDelete: () => Promise<unknown> }) {
  const state = stateOf(m);
  const down = m.state === "down" && !m.paused;
  return (
    <div className={`uptime-mon ${down ? "down" : ""}`}>
      <div className="uptime-who">
        <div className="uptime-name"><b>{m.name}</b></div>
        <span className={`uptime-state ${state.tone}`}>{state.text}</span>
        {down && m.last_error && <span className="uptime-error">{m.last_error}</span>}
        <span className="uptime-url" title={m.url}>{m.url}</span>
        {m.managed_in !== "code" && (
          <div className="uptime-acts">
            <button onClick={onCheck}>Check now</button>
            <button onClick={onPause}>{m.paused ? "Resume" : "Pause"}</button>
            <Confirm trigger={<button>Delete</button>} title={`Delete ${m.name}?`} action="Delete" danger onConfirm={onDelete}>Its checks and outages are deleted with it.</Confirm>
          </div>
        )}
      </div>
      <div className="uptime-track">
        <div className="uptime-bars" role="img" aria-label={`Last 90 days of ${m.name}`}>
          {m.days.map((day) => <i key={day.at} className={barTone(day.share)} title={`${dayMonth(day.at)}: ${day.share === null ? "no checks" : `${day.share.toFixed(2)}% up`}`} />)}
        </div>
        <div className="uptime-cap"><span className="long">90 days ago</span><span className="short">30 days ago</span><span>Today</span></div>
      </div>
      <div className="uptime-fig"><b>{m.uptime30d === null ? "No checks" : `${m.uptime30d.toFixed(2)}%`}</b><small>30 days</small></div>
      <div className="uptime-fig"><b>{m.avgMs === null ? "None" : fms(m.avgMs)}</b><small>Answer, 24 h</small></div>
    </div>
  );
}

function UptimePage() {
  const q = useFn(uptimeFn, undefined, { refetchInterval: 30_000 });
  const pause = useAct(pauseMonitorFn);
  const remove = useAct(deleteMonitorFn);
  const check = useAct(checkMonitorFn);
  const status = useQuery({ queryKey: ["status-page"], queryFn: () => statusPageFn() });
  return (
    <Load q={q}>
      {(d) => {
        const running = d.rows.filter((m) => m.running);
        const paused = d.rows.filter((m) => m.paused);
        const down = running.filter((m) => m.state === "down");
        const off = d.rows.filter((m) => !m.running && !m.paused);
        const shown = [...running, ...paused];
        return (
          <>
            <div className="subbar uptime-bar">
              {down.length ? (
                <span className="uptime-answer err">{down.length === 1 ? `${down[0]!.name} is down` : `${down.length} monitors are down`}</span>
              ) : running.length ? (
                <span className="uptime-answer">{running.length === 1 ? "The monitor is up" : `All ${running.length} monitors are up`}<small>Checked every minute from this Vigie, so an outage of this host cannot show here.</small></span>
              ) : off.length ? (
                <span className="uptime-answer">This machine checks nothing<small>Monitors in code run on the server. Add one here to check it from this machine.</small></span>
              ) : paused.length ? (
                <span className="uptime-answer">Every monitor is paused</span>
              ) : (
                <span className="uptime-answer">Nothing is monitored yet</span>
              )}
              <span className="grow" />
              <AddMonitor onDone={() => void q.refetch()} />
            </div>
            <div className="ov uptime">
              {!d.rows.length && <Empty title="Nothing is monitored yet" hint="Add a URL here, or use defineMonitor in definitions/monitors. It is checked every minute." />}
              {shown.length > 0 && (
                <section className="rel-part">
                  {shown.map((m) => (
                    <MonitorRow
                      key={m.id}
                      m={m}
                      onCheck={() => check.mutate({ id: m.id }, { onSuccess: (r) => { toast(r.ok ? `Up, ${r.ms} ms` : r.error ?? "Failed"); void q.refetch(); }, onError: (error) => toast(errorText(error)) })}
                      onPause={() => pause.mutate({ id: m.id, paused: !m.paused }, { onSuccess: () => { toast(m.paused ? "Resumed" : "Paused"); void q.refetch(); } })}
                      onDelete={async () => { await remove.mutateAsync({ id: m.id }); void q.refetch(); }}
                    />
                  ))}
                </section>
              )}
              {off.length > 0 && (
                <Part title="On the server only" className="uptime-off">
                  {off.map((m) => <div className="uptime-offrow" key={m.id}><span>{m.name}</span><span className="uptime-url">{m.url}</span></div>)}
                </Part>
              )}
              {(d.outages.length > 0 || running.length > 0) && (
                <Part title="Outages">
                  {d.outages.map((o) => (
                    <div className="uptime-outage" key={o.id}>
                      <span>{dayMonth(o.started)}, {hm(o.started)}</span>
                      <span>{o.name}</span>
                      <span>{o.error}</span>
                      <span className="t2">{span((o.ended ?? Date.now()) - o.started)}</span>
                      <span className={o.ended ? "t3" : "err"}>{o.ended ? "Recovered" : "Still down"}</span>
                    </div>
                  ))}
                  {!d.outages.length && <p className="uptime-none">No outage recorded.</p>}
                </Part>
              )}
              <Part title="Status page" right={<Link className="lnk" to="/status-page">Edit</Link>}>
                <div className="uptime-public">
                  <span>{status.data?.isPublic ? "Public. Anyone with the link sees what you chose to show, never URLs or errors." : "Private. Only signed-in people can open it."} Pick its components, write incidents and updates on the status page screen.</span>
                </div>
              </Part>
            </div>
          </>
        );
      }}
    </Load>
  );
}
