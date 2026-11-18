import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Choice, TextField } from "@web/components/form.tsx";
import { TaskTabs } from "@web/components/task-tabs.tsx";
import { toast } from "@web/components/toast.tsx";
import { Chip, Confirm, Empty, Load } from "@web/components/ui.tsx";
import { bulkDryRunFn, bulkListFn, bulkRunFn, taskActionsInfoFn } from "@web/fns/tasks.ts";
import { errorText, useFn } from "@web/lib/api.ts";
import { ago, num } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({ action: z.enum(["requeue", "cancel", "ignore"]).optional().catch(undefined), ids: z.array(z.string()).optional().catch(undefined), sel: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/tasks/bulk")({ validateSearch: search, component: BulkPage });

const STATE = { "dry-run": ["Dry run", "t3"], running: ["Running", "lnk"], done: ["Done", "ok"] } as const;
const chipOf = (state: string) => STATE[state as keyof typeof STATE] ?? ([state, "t3"] as const);

function BulkPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const scope = useScope();
  const client = useQueryClient();
  const info = useFn(taskActionsInfoFn, undefined);
  // Without the app connected there is nothing to do here, so an old link lands on the list instead.
  useEffect(() => {
    if (info.data && !info.data.enabled) void navigate({ to: "/tasks/all", search: {}, replace: true });
  }, [info.data]);
  const q = useFn(bulkListFn, undefined, { refetchInterval: 3000 });
  const [creating, setCreating] = useState(Boolean(s.ids?.length));
  const dryRun = useMutation({ mutationFn: (data: { action: "requeue" | "cancel" | "ignore"; reason: string; name: string }) => bulkDryRunFn({ data: { ...scope.params, ...data, ids: s.ids } }), onSuccess: (result) => { void client.invalidateQueries(); setCreating(false); void navigate({ search: (prev) => ({ ...prev, sel: result.id, ids: undefined, action: undefined }), replace: true }); }, onError: (error) => toast(errorText(error)) });
  const run = useMutation({ mutationFn: (id: string) => bulkRunFn({ data: { id } }), onSuccess: () => void client.invalidateQueries() });
  const form = useForm({
    defaultValues: { action: s.action ?? ("requeue" as "requeue" | "cancel" | "ignore"), reason: "", name: "" },
    onSubmit: ({ value }) => dryRun.mutate(value),
  });
  if (!info.data?.enabled) return null;
  return (
    <>
      <TaskTabs right={<button className="btn pri" onClick={() => setCreating(true)}>New bulk action</button>} />
      <Load q={q}>
        {(rows) => {
          const selected = rows.find((b) => b.id === s.sel) ?? rows[0];
          const eligible = selected?.eligible.length ?? 0;
          const progressed = selected ? selected.done + selected.failed + selected.skipped : 0;
          return (
            <div className="ov tasks-bulk">
              <div className="tasks-bulk-list">
                {rows.map((b) => {
                  const [word, tone] = chipOf(b.state);
                  return (
                    <button key={b.id} className={`tasks-bulk-item ${!creating && selected?.id === b.id ? "is-on" : ""}`} onClick={() => { setCreating(false); void navigate({ search: (prev) => ({ ...prev, sel: b.id }), replace: true }); }}>
                      <span className="grow"><b>{b.name}</b><span>{b.action}, {num(b.eligible.length)} tasks, {b.actor}, {ago(b.created_at).toLowerCase()}</span></span>
                      <Chip tone={tone}>{word}</Chip>
                    </button>
                  );
                })}
                {!rows.length && <p className="tasks-bulk-empty">Pick tasks in <Link className="lnk" to="/tasks/all">All tasks</Link>, or start one here. Every action begins with a dry run.</p>}
              </div>
              <div className="tasks-bulk-main">
                {creating ? (
                  <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
                    <h3>{s.ids?.length ? `${num(s.ids.length)} tasks you picked` : "Every task in the current time range"}</h3>
                    <form.Field name="action">{(field) => <label className="field">Action<span><Choice label="Action" value={field.state.value} onChange={(value) => field.handleChange(value)} options={[["requeue", "Requeue"], ["cancel", "Cancel"], ["ignore", "Ignore"]]} /></span></label>}</form.Field>
                    <form.Field name="name">{(field) => <TextField field={field} label="Name" placeholder="Requeue after the provider outage" />}</form.Field>
                    <form.Field name="reason" validators={{ onChange: ({ value }) => (value.trim() ? undefined : "Say why, so the audit log explains this later.") }}>{(field) => <TextField field={field} label="Why" placeholder="The provider was rate limiting" />}</form.Field>
                    <div className="row"><button type="submit" className="btn pri" disabled={dryRun.isPending}>Start the dry run</button><button type="button" className="btn" onClick={() => setCreating(false)}>Close</button></div>
                  </form>
                ) : selected ? (
                  <>
                    <h3>{selected.name}</h3>
                    {selected.reason && <p className="tasks-bulk-why">{selected.reason}</p>}
                    <div className="processes-bar tasks-bulk-bar"><i className="is-done" style={{ width: `${eligible ? (progressed / eligible) * 100 : 0}%` }} /></div>
                    <dl className="tasks-bulk-facts">
                      <div><dt>Will change</dt><dd>{num(eligible)}</dd></div>
                      <div><dt>Left out, already settled</dt><dd>{num(selected.excluded)}</dd></div>
                      <div><dt>Done</dt><dd>{num(selected.done)}</dd></div>
                      {selected.failed > 0 && <div><dt>Failed</dt><dd className="err">{num(selected.failed)}</dd></div>}
                      {selected.skipped > 0 && <div><dt>Skipped</dt><dd>{num(selected.skipped)}</dd></div>}
                      <div><dt>Left</dt><dd>{num(Math.max(0, eligible - progressed))}</dd></div>
                    </dl>
                    {selected.state === "dry-run" && <Confirm trigger={<button className="btn pri">Run it on {num(eligible)} tasks</button>} title={`${selected.action} ${eligible} tasks?`} action={`${selected.action} ${eligible} tasks`} onConfirm={() => run.mutateAsync(selected.id)}>This goes through the app's task API as you. It cannot be undone from here.</Confirm>}
                  </>
                ) : (
                  <Empty title="Nothing here yet" hint="Start a dry run to see what an action would change." />
                )}
              </div>
            </div>
          );
        }}
      </Load>
    </>
  );
}
