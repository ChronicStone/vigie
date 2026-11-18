import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { Widget } from "@sdk";
import { Icon } from "@web/components/icons.tsx";
import { toast } from "@web/components/toast.tsx";
import { Confirm, copy, Head, Load } from "@web/components/ui.tsx";
import { WidgetBody } from "@web/components/widget.tsx";
import { dashboardFn, deleteDashboardFn, saveDashboardFn } from "@web/fns/admin.ts";
import { errorText, useAct, useFn } from "@web/lib/api.ts";

export const Route = createFileRoute("/_app/dashboards/$id/")({ component: DashboardPage });

const STARTER: Widget = { type: "bars", title: "New widget", span: 6, height: 150, sql: "SELECT $__bucket(Timestamp) AS t, countIf(SeverityText != 'error') AS ok, countIf(SeverityText = 'error') AS error FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env GROUP BY t ORDER BY t" };

/** A chart is read at a glance: it never needs more height than this, whatever its definition asks for. */
const boardHeight = (widget: Widget) => (widget.type === "bars" || widget.type === "series" || widget.type === "lines" ? Math.min(widget.height ?? 130, 132) : widget.height);

function DashboardPage() {
  const { id } = Route.useParams();
  const q = useFn(dashboardFn, { id });
  const save = useAct(saveDashboardFn);
  const remove = useAct(deleteDashboardFn);
  const navigate = useNavigate();
  return (
    <Load q={q}>
      {(d) => {
        const add = () => save.mutate({ id, title: d.title, widgets: [...d.widgets, STARTER] }, { onSuccess: () => void navigate({ to: "/dashboards/$id/widget/$index", params: { id, index: String(d.widgets.length) } }), onError: (error) => toast(errorText(error)) });
        const editable = d.source === "app";
        const actions = (widget: Widget, index: number) => (
          <span className="wacts home-wacts">
            <Link to="/console" search={{ sql: widget.sql }} aria-label={`Open ${widget.title} in the query console`}>Query</Link>
            {editable && <button onClick={() => save.mutate({ id, title: d.title, widgets: [...d.widgets.slice(0, index + 1), { ...widget, title: `${widget.title} copy` }, ...d.widgets.slice(index + 1)] })}>Duplicate</button>}
            {editable && <button onClick={() => save.mutate({ id, title: d.title, widgets: d.widgets.filter((_, i) => i !== index) })}>Remove</button>}
            <Link to="/dashboards/$id/widget/$index" params={{ id, index: String(index) }} aria-label={`Open ${widget.title}`}>{editable ? "Edit" : "Open"}</Link>
          </span>
        );
        // Stats side by side read as one line of numbers, so runs of them share a strip instead of each taking a tile.
        const blocks: { stats?: { widget: Widget; index: number }[]; widget?: Widget; index?: number }[] = [];
        d.widgets.forEach((widget, index) => {
          const last = blocks[blocks.length - 1];
          if (widget.type === "stat") {
            if (last?.stats) last.stats.push({ widget, index });
            else blocks.push({ stats: [{ widget, index }] });
          } else blocks.push({ widget, index });
        });
        return (
          <div className="home-board">
            <Head back="/dashboards" backTitle="Back to dashboards" title={d.title} meta={d.source === "code" ? <span className="dhm" title={`definitions/${d.file}`}>Defined in code</span> : undefined} right={<>
              {editable && <Confirm trigger={<button className="btn">Delete</button>} title="Delete this dashboard?" action="Delete" danger onConfirm={async () => { await remove.mutateAsync({ id }); void navigate({ to: "/dashboards" }); }}>Its widgets go with it.</Confirm>}
              <button className="btn" onClick={() => copy(location.href, "Link copied")}>Share</button>
              {editable && <button className="btn pri" onClick={add}><Icon name="plus" />Add a widget</button>}
            </>} />
            {!d.widgets.length && (
              <div className="home-quiet">
                <b>This dashboard is empty</b>
                <span>A widget is one query drawn as a chart, a number or a table.</span>
                <div><button className="btn pri" onClick={add}><Icon name="plus" />Add the first widget</button></div>
              </div>
            )}
            <div className="home-grid">
              {blocks.map((block, i) =>
                block.stats ? (
                  <div className="home-stats" key={i}>
                    {block.stats.map(({ widget, index }) => (
                      <div className="home-cell-stat" key={index}>
                        <WidgetBody widget={widget} header={actions(widget, index)} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="home-cell" key={i} style={{ gridColumn: `span ${block.widget!.span ?? 6}` }}>
                    <WidgetBody widget={{ ...block.widget!, height: boardHeight(block.widget!) }} header={actions(block.widget!, block.index!)} />
                  </div>
                ),
              )}
            </div>
          </div>
        );
      }}
    </Load>
  );
}
