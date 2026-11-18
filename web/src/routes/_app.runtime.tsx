import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useListKeys } from "@web/components/backend.tsx";
import { Lanes } from "@web/components/lanes.tsx";
import { Card, Empty, Load, Segments } from "@web/components/ui.tsx";
import { runtimeFn, whatRanHereFn } from "@web/fns/backend.ts";
import { useScope } from "@web/lib/scope.ts";
import { useFn, useScoped } from "@web/lib/api.ts";
import { ago, fms, hm, hms, shortService, span } from "@web/lib/format.ts";

const search = z.object({ instance: z.string().optional().catch(undefined), at: z.coerce.number().optional().catch(undefined) });
export const Route = createFileRoute("/_app/runtime")({ validateSearch: search, component: RuntimePage });

/** Each measure lists the names apps may report it under. `floor` is how much movement counts at all: 2 points of CPU is nothing. */
const CARDS = [
  { names: ["process.cpu.utilization"], state: "", label: "CPU", unit: "%", digits: 0, floor: 15 },
  { names: ["process.memory.usage"], state: "", label: "Memory", unit: "MB", digits: 0, floor: 60 },
  { names: ["v8js.memory.heap.used", "v8.heap.used"], state: "", label: "Heap used", unit: "MB", digits: 0, floor: 40 },
  { names: ["nodejs.eventloop.delay.p99"], state: "", label: "Event loop delay", unit: "ms", digits: 1, floor: 25 },
  { names: ["nodejs.eventloop.utilization"], state: "", label: "Event loop busy", unit: "%", digits: 0, floor: 20 },
  { names: ["db.client.connection.count"], state: "used", label: "Connections in use", unit: "", digits: 0, floor: 5 },
  { names: ["db.client.connection.count"], state: "idle", label: "Connections idle", unit: "", digits: 0, floor: 8 },
];
const LINE = [{ key: "v", label: "Value", color: "var(--a)" }];
const GONE_MS = 10 * 60_000;

function RuntimePage() {
  const { instance, at } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useScoped(runtimeFn, { instance });
  const scope = useScope();
  const ran = useFn(whatRanHereFn, { env: scope.env, at: at ?? 0, instance: instance ?? q.data?.instance }, { enabled: at !== undefined });
  const setAt = (value: number | undefined) => void navigate({ search: (prev) => ({ ...prev, at: value }), replace: true });
  useListKeys();
  return (
    <Load q={q}>
      {(d) => {
        if (!d.instances.length) return <Empty title="No runtime metrics yet" hint="Instances report process.memory.usage, v8.heap.used and the event loop over OTLP." />;
        const current = d.instances.find((i) => i.instance === d.instance);
        const measures = CARDS.flatMap((card) => {
          const points = d.series.filter((p) => card.names.includes(p.name) && (!card.state || p.state === card.state));
          if (!points.some((p) => p.v > 0)) return [];
          const sorted = points.map((p) => p.v).sort((a, b) => a - b);
          const usual = sorted[Math.floor(sorted.length / 2)] ?? 0;
          const low = sorted[0] ?? 0;
          const peak = sorted[sorted.length - 1] ?? 0;
          const latest = points[points.length - 1]?.v ?? 0;
          const show = (value: number) => `${value.toFixed(card.digits)}${card.unit && card.unit !== "%" ? " " : ""}${card.unit}`;
          const steady = peak - low < card.floor && peak - usual < Math.max(card.floor, usual * 0.25);
          return [{ card, points, latest, peak, show, steady }];
        });
        const moving = measures.filter((m) => !m.steady);
        const steady = measures.filter((m) => m.steady);
        const lanes = moving.length ? moving : measures.slice(0, 2);
        const stillRow = steady.filter((m) => !lanes.includes(m));
        const bad = d.notices.find((n) => n.tone === "bad");
        const word = bad ? { text: bad.title, tone: "err" } : d.notices[0] ? { text: d.notices[0].title, tone: "warn" } : moving.length ? { text: `${moving.length} of ${measures.length} measures moved`, tone: "t1" } : { text: "All steady", tone: "ok" };
        const quiet = current ? Date.now() - current.seen > GONE_MS : false;
        return (
          <div className="ov">
            <div className="subbar rtm-pick">
              <Segments env={false} value={d.instance} onChange={(value) => void navigate({ search: (prev) => ({ ...prev, instance: value, at: undefined }), replace: true })} options={d.instances.map((i) => [i.instance, <span key={i.instance} className={Date.now() - i.seen > GONE_MS ? "rtm-gone" : ""}>{shortService(i.service)} <span className="mono">{i.instance.slice(0, 4)}</span></span>] as const)} />
              <span className="grow" />
              <span className="req-figs rtm-meta">
                {quiet && current && <span className="warn">Last seen {ago(current.seen)}</span>}
                {d.version && <span>Version <b className="mono">{d.version.slice(0, 7)}</b></span>}
                {d.first > 0 && <span>Up <b>{span(Date.now() - d.first)}</b></span>}
              </span>
            </div>
            <section className="rtm-state">
              <b className={`rtm-word ${word.tone}`}>{word.text}</b>
              {stillRow.length > 0 && (
                <span className="rtm-still">
                  {stillRow.map((m) => <span key={m.card.label}><span className="t3">{m.card.label}</span> <b>{m.show(m.latest)}</b></span>)}
                </span>
              )}
              <span className="rtm-hint">Click a moment to see what ran</span>
            </section>
            {d.notices.map((notice) => <div className="dnote" key={notice.title}><b className={notice.tone === "bad" ? "err" : "warn"}>{notice.title}.</b> {notice.text}</div>)}
            <Lanes from={scope.from} to={scope.to} height={moving.length ? 60 : 34} onPick={setAt} lanes={lanes.map((m) => ({ id: m.card.label, label: m.card.label, kind: "line" as const, keys: LINE, data: m.points, format: m.show, figures: [{ value: m.show(m.latest), label: "Now" }, { value: m.show(m.peak), label: "Peak" }] }))} />
            {at !== undefined && (
              <Card title={`What ran around ${hm(at)}`} right={<button onClick={() => setAt(undefined)}>Close</button>}>
                {ran.data && !ran.data.rows.length && <div className="cb t3">Nothing ran within a minute of this moment.</div>}
                {ran.data?.rows.map((row) => (
                  <Link key={row.id} className="lst" to={row.kind === "task" && row.taskId ? "/tasks/run/$id" : "/traces/$id"} params={{ id: row.kind === "task" && row.taskId ? row.taskId : row.traceId }}>
                    <span className="lt rt-time">{hms(row.t)}</span>
                    <span className={`ell grow mono ${row.outcome === "failed" ? "err" : ""}`}>{row.name}</span>
                    <span className="mono t2 rt-dur">{fms(row.duration)}</span>
                  </Link>
                ))}
              </Card>
            )}
          </div>
        );
      }}
    </Load>
  );
}
