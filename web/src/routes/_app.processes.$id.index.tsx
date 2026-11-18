import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import { Icon } from "@web/components/icons.tsx";
import { DataTable, type Col } from "@web/components/table.tsx";
import { inWords, useListKeys, usePhone } from "@web/components/task-tabs.tsx";
import { Back, Id, Levels, Load, SearchBox, Subject } from "@web/components/ui.tsx";
import { processFn } from "@web/fns/tasks.ts";
import { useScoped } from "@web/lib/api.ts";
import { ago, num, span } from "@web/lib/format.ts";

const search = z.object({ only: z.enum(["stuck", "failed", "running", "done"]).optional().catch(undefined), step: z.string().optional().catch(undefined), q: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/processes/$id/")({ validateSearch: search, component: ProcessPage });

type Detail = Awaited<ReturnType<typeof processFn>>;
type Step = Detail["steps"][number]["parallel"][number];
type Row = { key: string; accountId: string; state: "stuck" | "failed" | "running" | "done"; at: string; atKind: string; waited: number; why: string; code: string; lastAt: number; kinds: string[]; skippedAt: string };

const WORD: Record<Row["state"], string> = { stuck: "Stuck", failed: "Failed", running: "Still open", done: "Completed" };
const TONE: Record<Row["state"], string> = { stuck: "warn", failed: "err", running: "t2", done: "t3" };
const plural = (word: string) => (word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`);
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
const SUBSET: Record<string, string> = { stuck: "Stuck", failed: "Failed", running: "Still open", done: "Completed" };

/** One step, drawn with what happened to everything that reached it. A skip is grey: it finished, by deciding nothing was needed. */
function StepNode({ step, on, onPick, wide }: { step: Step; on: boolean; onPick: () => void; wide?: boolean }) {
  const reached = Math.max(step.reached, 1);
  const part = (n: number) => `${(n / reached) * 100}%`;
  const trouble = step.failed > 0 ? "err" : step.stuck > 0 ? "warn" : "";
  const open = step.reached - step.done - step.skipped - step.failed - step.waiting;
  const notes = [step.done ? `${num(step.done)} done` : "", step.skipped ? `${num(step.skipped)} skipped` : "", step.waiting ? `${num(step.waiting)} waiting` : "", step.failed ? `${num(step.failed)} failed` : "", open > 0 ? `${num(open)} running` : ""].filter(Boolean);
  return (
    <div className={`processes-node ${wide ? "is-wide" : ""} ${trouble ? `is-${trouble}` : ""} ${on ? "is-on" : ""} ${step.reached ? "" : "is-empty"}`} role="button" tabIndex={0} aria-pressed={on} onClick={onPick} onKeyDown={(event) => { if (event.key === "Enter") onPick(); }}>
      <span className="processes-node-t">
        <b>{step.label}</b>
        <Link to="/tasks/kind/$kind" params={{ kind: step.kind }} title={`Open ${step.kind}`} aria-label={`Open ${step.kind}`} onClick={(event) => event.stopPropagation()}><Icon name="chev" /></Link>
      </span>
      <span className="processes-node-n">{num(step.reached)}</span>
      <span className="processes-bar" aria-hidden="true">
        <i className="is-done" style={{ width: part(step.done) }} />
        <i className="is-skip" style={{ width: part(step.skipped) }} />
        <i className="is-stuck" style={{ width: part(step.waiting) }} />
        <i className="is-failed" style={{ width: part(step.failed) }} />
      </span>
      <span className="processes-node-m">{notes.length ? notes.join(", ") : "Nothing reached it"}{step.optional ? <em>, optional</em> : null}</span>
    </div>
  );
}

/** The bend between two columns. A thicker line means more of what started came through here. */
function Links({ from, to, started }: { from: number[]; to: number[]; started: number }) {
  const y = (i: number, n: number) => ((i + 0.5) / n) * 100;
  const pairs: { a: number; b: number; n: number }[] = [];
  if (from.length === 1) to.forEach((n, i) => pairs.push({ a: y(0, 1), b: y(i, to.length), n }));
  else from.forEach((n, i) => pairs.push({ a: y(i, from.length), b: y(0, to.length), n }));
  return (
    <svg className="processes-link" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {pairs.map(({ a, b, n }, i) => (
        <path key={i} d={`M0,${a} C55,${a} 45,${b} 100,${b}`} vectorEffect="non-scaling-stroke" className={n ? "" : "is-empty"} style={{ strokeWidth: n ? 1 + (n / Math.max(started, 1)) * 5 : 1 }} />
      ))}
    </svg>
  );
}

function Flow({ d, step, onStep, onlyDone, onDone }: { d: Detail; step?: string; onStep: (kind: string) => void; onlyDone: boolean; onDone: () => void }) {
  const open = d.stats.started - d.stats.completed - d.stats.stuck - d.stats.failed;
  const sizes = d.steps.map((group) => group.parallel.map((s) => s.reached));
  return (
    <div className="processes-flow" style={{ gridTemplateColumns: ["104px", ...d.steps.flatMap((group) => ["44px", group.parallel.length > 1 ? "minmax(300px, 1.7fr)" : "minmax(190px, 1fr)"]), "44px", "120px"].join(" ") }}>
      <div className="processes-cap">
        <b>{num(d.stats.started)}</b>
        <span>{plural(d.subject)} started</span>
      </div>
      {d.steps.map((group, index) => {
        const before = index ? sizes[index - 1]! : [d.stats.started];
        return (
          <div key={group.parallel[0]!.kind} style={{ display: "contents" }}>
            <Links from={before} to={sizes[index]!} started={d.stats.started} />
            {group.parallel.length > 1 ? (
              <div className="processes-fan">
                {group.parallel.map((s) => <StepNode key={s.kind} wide step={s} on={step === s.kind} onPick={() => onStep(s.kind)} />)}
              </div>
            ) : (
              <StepNode step={group.parallel[0]!} on={step === group.parallel[0]!.kind} onPick={() => onStep(group.parallel[0]!.kind)} />
            )}
          </div>
        );
      })}
      <Links from={sizes[sizes.length - 1]!} to={[d.stats.completed]} started={d.stats.started} />
      <button className={`processes-cap is-end ${onlyDone ? "is-on" : ""}`} aria-pressed={onlyDone} onClick={onDone}>
        <b>{num(d.stats.completed)}</b>
        <span>completed</span>
        {open > 0 && <em>{num(open)} still open</em>}
      </button>
    </div>
  );
}

function ProcessPage() {
  const { id } = Route.useParams();
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const patch = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const q = useScoped(processFn, { id });
  const [text, setText] = useState(s.q ?? "");
  const change = (value: string) => { setText(value); patch({ q: value || undefined }); };
  useListKeys({ search: "processes-find-instance", rows: "[data-testid=process-instances] tbody tr.click", onClear: () => change("") });
  const phone = usePhone();
  const columns = useMemo<Col<Row>[]>(() => phone ? [
    { id: "state", header: "State", width: 80, className: (r) => TONE[r.state], cell: (r) => WORD[r.state] },
    { id: "key", header: "Subject", cell: (r) => <span className="tasks-all-two"><b className="t2"><Subject value={r.key} /></b>{r.at ? <span>{r.at}</span> : null}</span> },
    { id: "last", header: "Seen", num: true, className: "t3", cell: (r) => (r.lastAt ? ago(r.lastAt) : "") },
  ] : [
    { id: "state", header: "State", width: 96, className: (r) => TONE[r.state], cell: (r) => WORD[r.state] },
    { id: "key", header: "Subject", className: "t2", cell: (r) => <Subject value={r.key} /> },
    { id: "account", header: "Account", cell: (r) => (r.accountId ? <Id value={r.accountId} /> : "") },
    { id: "where", header: "Where", className: "ell", style: { maxWidth: 420 }, cell: (r) => (r.at ? <><span>{r.at}</span>{r.why ? <span className="t3">, {r.why}</span> : r.code ? <span className="t3">, {inWords(r.code).toLowerCase()}</span> : null}</> : r.skippedAt ? <span className="t3">Nothing to do at {r.skippedAt}</span> : "") },
    { id: "for", header: "For", num: true, sort: (r) => r.waited, className: (r) => `mono ${r.state === "stuck" ? "warn" : "t3"}`, cell: (r) => (r.state === "stuck" || r.state === "failed" ? span(r.waited) : "") },
    { id: "last", header: "Last seen", num: true, sort: (r) => r.lastAt, className: "t3", cell: (r) => (r.lastAt ? ago(r.lastAt) : "") },
  ], [phone]);
  return (
    <Load q={q}>
      {(d) => {
        const flagged = new Map(d.attention.map((a) => [a.key, a]));
        const merged: Row[] = [
          ...d.attention.map((a): Row => ({ key: a.key, accountId: a.accountId, state: a.state as Row["state"], at: a.at, atKind: a.atKind, waited: a.waited, why: a.why, code: a.code, lastAt: d.recent.find((r) => r.key === a.key)?.lastAt ?? 0, kinds: d.recent.find((r) => r.key === a.key)?.kinds ?? (a.atKind ? [a.atKind] : []), skippedAt: "" })),
          ...d.recent.filter((r) => !flagged.has(r.key)).map((r): Row => ({ key: r.key, accountId: r.accountId, state: r.state as Row["state"], at: "", atKind: "", waited: 0, why: "", code: "", lastAt: r.lastAt, kinds: r.kinds, skippedAt: r.skippedAt })),
        ];
        const needle = text.trim().toLowerCase();
        const near = merged.filter((r) => (!s.step || r.atKind === s.step || r.kinds.includes(s.step)) && (!needle || r.key.toLowerCase().includes(needle) || r.accountId.toLowerCase().includes(needle)));
        const rows = s.only ? near.filter((r) => r.state === s.only) : near;
        const count = (state: string) => near.filter((r) => r.state === state).length;
        // The server sends every stuck and failed instance but only the latest others, so only exact counts are printed.
        const whole = d.recent.length >= d.stats.started;
        const exact = (key: string) => whole || key === "stuck" || key === "failed";
        const options = [["all", whole ? `All ${near.length}` : "Latest"] as const, ...Object.entries(SUBSET).filter(([key]) => key === s.only || count(key) > 0).map(([key, label]) => [key, exact(key) ? `${label} ${count(key)}` : label] as const)];
        const stepLabel = d.steps.flatMap((group) => group.parallel).find((step) => step.kind === s.step)?.label;
        return (
          <div className="ov processes-page">
            <div className="dh">
              <Back to={router.history.canGoBack() ? undefined : "/processes"} title="Back" />
              <h2>{d.title}</h2>
              {d.stats.failed > 0 && <span className="err">{num(d.stats.failed)} failed</span>}
              {d.stats.stuck > 0 && <span className="warn">{num(d.stats.stuck)} stuck</span>}
              <span className="dhm processes-sla">{d.stats.p50 >= 1000 ? `Typically ${span(d.stats.p50)}` : ""}{d.stats.p95 >= 1000 ? `, slowest 5% over ${span(d.stats.p95)}` : ""}{d.sla ? `${d.stats.p50 >= 1000 ? ", " : ""}promised within ${d.sla}` : ""}</span>
            </div>
            <div className="processes-flow-wrap">
              <Flow d={d} step={s.step} onStep={(kind) => patch({ step: s.step === kind ? undefined : kind })} onlyDone={s.only === "done"} onDone={() => patch({ only: s.only === "done" ? undefined : "done" })} />
            </div>
            <div className="subbar processes-bar-top">
              <Levels value={s.only ?? "all"} onChange={(value) => patch({ only: value === "all" ? undefined : (value as never) })} options={options} />
              {stepLabel && <button className="fchip act" onClick={() => patch({ step: undefined })}>At {stepLabel}<Icon name="x" /></button>}
              <span className="grow" />
              <SearchBox id="processes-find-instance" value={text} onChange={change} placeholder={`Find ${article(d.subject)} ${d.subject}`} style={{ width: 240 }} />
            </div>
            <DataTable
              inCard
              tableId="process-instances"
              rowHeight={phone ? 46 : undefined}
              rows={rows}
              rowKey={(r) => r.key}
              columns={columns}
              rowClass={(r) => (r.state === "failed" ? "tint-failed" : "")}
              onRow={(r) => void navigate({ to: "/processes/$id/instance", params: { id }, search: { key: r.key } })}
              emptyTitle={d.stats.started ? `No ${d.subject} matches` : `No ${d.subject} started in this window`}
              emptyHint={d.stats.started ? <button className="tlink" onClick={() => { setText(""); void navigate({ search: (prev) => ({ ...prev, only: undefined, step: undefined, q: undefined }), replace: true }); }}>Clear the filters</button> : "Widen the time range in the top bar."}
            />
          </div>
        );
      }}
    </Load>
  );
}
