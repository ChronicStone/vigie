import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { TextField } from "@web/components/form.tsx";
import { DashThumb } from "@web/components/dash-thumb.tsx";
import { Icon } from "@web/components/icons.tsx";
import { toast } from "@web/components/toast.tsx";
import { Load, Pop, SearchBox } from "@web/components/ui.tsx";
import { dashboardsFn, saveDashboardFn } from "@web/fns/admin.ts";
import { errorText, useAct, useFn } from "@web/lib/api.ts";

const search = z.object({ q: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/dashboards/")({ validateSearch: search, component: DashboardsPage });

function DashboardsPage() {
  const q = useFn(dashboardsFn, undefined);
  const { q: text = "" } = Route.useSearch();
  const save = useAct(saveDashboardFn);
  const navigate = useNavigate();
  const setText = (value: string) => void navigate({ to: ".", search: ((prev: Record<string, unknown>) => ({ ...prev, q: value || undefined })) as never, replace: true });
  const form = useForm({
    defaultValues: { title: "" },
    onSubmit: ({ value }) => save.mutate({ title: value.title, widgets: [] }, { onSuccess: ({ id }) => void navigate({ to: "/dashboards/$id", params: { id } }), onError: (error) => toast(errorText(error)) }),
  });
  return (
    <Load q={q}>
      {(rows) => {
        const low = text.toLowerCase();
        const shown = rows.filter((d) => `${d.title} ${d.widgets.map((w) => w.title).join(" ")}`.toLowerCase().includes(low));
        return (
          <>
            <div className="subbar">
              <SearchBox value={text} onChange={setText} placeholder="Find a dashboard or a widget" />
              <span className="grow" />
              <Pop align="end" width={300} trigger={<button className="btn pri"><Icon name="plus" />New dashboard</button>}>
                <form style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }} onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
                  <form.Field name="title" validators={{ onChange: ({ value }) => (value.trim() ? undefined : "Give it a name") }}>{(field) => <TextField field={field} label="Name" placeholder="Launch week" autoFocus />}</form.Field>
                  <button className="btn pri" type="submit">Create</button>
                </form>
              </Pop>
            </div>
            <div className="home-dashes">
              {shown.map((d) => (
                <Link key={d.id} className="dcard home-dash home-keyrow" to="/dashboards/$id" params={{ id: d.id }}>
                  <DashThumb widgets={d.widgets} />
                  <span className="home-dash-foot">
                    <b>{d.title}</b>
                    {d.source === "app" && <span className="t3">Yours</span>}
                  </span>
                </Link>
              ))}
              {!shown.length && (
                <div className="home-quiet">
                  <b>No dashboard or widget matches "{text}"</b>
                  <div><button className="btn" onClick={() => setText("")}>Clear the search</button></div>
                </div>
              )}
            </div>
          </>
        );
      }}
    </Load>
  );
}
