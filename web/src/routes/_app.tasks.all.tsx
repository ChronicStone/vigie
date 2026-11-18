import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { Icon } from "@web/components/icons.tsx";
import { DataTable, type Col } from "@web/components/table.tsx";
import { inWords, TaskTabs, useListKeys, usePhone } from "@web/components/task-tabs.tsx";
import { Levels, Load, Pop, SearchBox, TaskChip, Id, Subject } from "@web/components/ui.tsx";
import { taskActionsInfoFn, taskListFn } from "@web/fns/tasks.ts";
import { useFn, useScoped } from "@web/lib/api.ts";
import { ago, fms, num } from "@web/lib/format.ts";

const search = z.object({ q: z.string().optional().catch(undefined), view: z.enum(["open", "late", "held"]).optional().catch(undefined), state: z.string().optional().catch(undefined), kind: z.string().optional().catch(undefined), integration: z.string().optional().catch(undefined), account: z.string().optional().catch(undefined), worker: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/tasks/all")({ validateSearch: search, component: TaskListPage });

type Data = Awaited<ReturnType<typeof taskListFn>>;
type Row = Data["rows"][number];
const STATES: [string, string][] = [["FAILED", "Failed"], ["WAITING", "Waiting"], ["RUNNING", "Running"], ["QUEUED", "Due"], ["SCHEDULED", "Scheduled"], ["HELD", "Held"], ["SKIPPED", "Skipped"], ["CANCELLED", "Cancelled"], ["DONE", "Done"]];
const VIEW: Record<string, string> = { late: "Late", held: "Held", open: "Failed" };
const FACETS: [keyof Data["facets"], string][] = [["kind", "Kind"], ["integration", "Integration"], ["account", "Account"], ["worker", "Worker"]];

function TaskListPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const patch = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const [text, setText] = useState(s.q ?? "");
  // The search asks the server a moment after typing stops, and narrows what is already on screen at once.
  useEffect(() => {
    if (text === (s.q ?? "")) return;
    const timer = setTimeout(() => patch({ q: text || undefined }), 250);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => setText(s.q ?? ""), [s.q]);
  const q = useScoped(taskListFn, { q: s.q, view: s.view, kind: s.kind, integration: s.integration, account: s.account, worker: s.worker });
  const info = useFn(taskActionsInfoFn, undefined);
  const actions = Boolean(info.data?.enabled);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  useListKeys({ search: "tasks-all-find", rows: "[data-testid=tasks] tbody tr.click", onClear: () => { setText(""); patch({ q: undefined }); } });
  const phone = usePhone();
  const columns = useMemo<Col<Row>[]>(() => phone ? [
    { id: "state", header: "State", width: 84, cell: (t) => <TaskChip state={t.state} /> },
    { id: "kind", header: "Task", cell: (t) => <span className="tasks-all-two"><b className="mono">{t.kind}</b>{t.code ? <span className={t.state === "FAILED" ? "err" : ""}>{inWords(t.code)}</span> : t.key && t.key !== t.kind ? <span><Subject value={t.key} /></span> : null}</span> },
    { id: "last", header: "When", num: true, className: "t3", cell: (t) => ago(t.last) },
  ] : [
    ...(actions ? [{ id: "pick", header: "", width: 34, cell: (t: Row) => <button className="chkb" aria-label={`Select ${t.id}`} onClick={(event) => { event.stopPropagation(); toggle(t.id); }}><span className={`chk ${picked.has(t.id) ? "on" : ""}`}><Icon name="check" /></span></button> }] : []),
    { id: "state", header: "State", width: 104, cell: (t) => <TaskChip state={t.state} /> },
    { id: "kind", header: "Kind", className: "mono", cell: (t) => t.kind },
    { id: "key", header: "Subject", className: "t2 ell", style: { maxWidth: 260 }, cell: (t) => (t.key && t.key !== t.kind ? <Subject value={t.key} /> : "") },
    { id: "reason", header: "Reason", className: (t) => `ell ${t.state === "FAILED" ? "err" : "t3"}`, style: { maxWidth: 300 }, cell: (t) => (t.code ? <span title={t.code}>{inWords(t.code)}</span> : "") },
    { id: "account", header: "Account", cell: (t) => (t.accountId ? <Id value={t.accountId} /> : "") },
    { id: "attempts", header: "Attempts", num: true, sort: (t) => t.attempts, className: "mono t2", cell: (t) => (t.attempts > 1 ? t.attempts : "") },
    { id: "duration", header: "Took", num: true, sort: (t) => t.duration, className: "mono t2", cell: (t) => (t.duration ? fms(t.duration) : "") },
    { id: "last", header: "When", num: true, sort: (t) => t.last, className: "t3", cell: (t) => ago(t.last) },
  ], [picked, actions, phone]);
  const needle = text.trim().toLowerCase();
  const near = (q.data?.rows ?? []).filter((t) => !needle || t.id.toLowerCase().includes(needle) || t.kind.toLowerCase().includes(needle) || t.key.toLowerCase().includes(needle) || t.accountId.toLowerCase().includes(needle) || t.code.toLowerCase().includes(needle));
  const rows = s.state ? near.filter((t) => t.state === s.state) : near;
  const counts = (state: string) => near.filter((t) => t.state === state).length;
  const states = [["all", `All ${num(near.length)}`] as const, ...STATES.filter(([key]) => key === s.state || counts(key) > 0).map(([key, label]) => [key, `${label} ${num(counts(key))}`] as const)];
  const filtered = Boolean(text || s.state || s.view || s.kind || s.integration || s.account || s.worker);
  const levels = <Levels value={s.state ?? "all"} onChange={(state) => patch({ state: state === "all" ? undefined : state })} options={states} />;
  const clear = () => { setText(""); void navigate({ search: (prev) => ({ range: (prev as { range?: string }).range }) as never, replace: true }); };
  return (
    <>
      <TaskTabs right={phone ? undefined : levels} />
      <div className="subbar tasks-all-bar">
        <SearchBox id="tasks-all-find" value={text} onChange={setText} placeholder="Search id, kind, subject, reason" style={{ width: 300 }} />
        {FACETS.map(([key, label]) => {
          const options = q.data?.facets[key] ?? [];
          if (options.length < 2 && !s[key]) return null;
          return (
            <Pop key={key} width={300} trigger={<button className={`fchip ${s[key] ? "act" : ""}`}>{label}{s[key] && <span className="v mono"> {s[key]}</span>}<Icon name="chev" /></button>}>
              <h6>{label}</h6>
              <div className="scrollp">
                {options.map((option) => (
                  <button key={option.value} className="pitem" onClick={() => patch({ [key]: s[key] === option.value ? undefined : option.value })}>
                    <span className={`chk ${s[key] === option.value ? "on" : ""}`}><Icon name="check" /></span>
                    <span className="ell mono">{option.value}</span>
                    <span className="n">{num(option.n)}</span>
                  </button>
                ))}
              </div>
            </Pop>
          );
        })}
        {s.view && <button className="fchip act" onClick={() => patch({ view: undefined })}>{VIEW[s.view]}<Icon name="x" /></button>}
      </div>
      {phone && <div className="tasks-all-states">{levels}</div>}
      {actions && picked.size > 0 && (
        <div className="bulkbar">
          <b>{picked.size} selected</b>
          <span className="grow" />
          {(["requeue", "cancel", "ignore"] as const).map((action) => (
            <Link key={action} className="btn" style={{ textTransform: "capitalize" }} to="/tasks/bulk" search={{ action, ids: [...picked] }}>{action}</Link>
          ))}
        </div>
      )}
      <Load q={q}>
        {() => (
          <DataTable
            tableId="tasks"
            rowHeight={phone ? 46 : undefined}
            rows={rows}
            columns={columns}
            rowKey={(t) => t.id}
            rowClass={(t) => (t.state === "FAILED" ? "tint-failed" : "")}
            onRow={(t) => void navigate({ to: "/tasks/run/$id", params: { id: t.id } })}
            emptyTitle={filtered ? "No task matches" : "No task ran in this window"}
            emptyHint={filtered ? <button className="tlink" onClick={clear}>Clear the filters</button> : "Widen the time range in the top bar."}
          />
        )}
      </Load>
    </>
  );
}
