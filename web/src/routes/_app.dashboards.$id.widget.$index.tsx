import { useForm, useStore } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Widget } from "@sdk";
import { CodeEditor } from "@web/components/code.tsx";
import { TextField } from "@web/components/form.tsx";
import { toast } from "@web/components/toast.tsx";
import { copy, Head, Load, Segments } from "@web/components/ui.tsx";
import { WidgetBody } from "@web/components/widget.tsx";
import { dashboardFn, saveDashboardFn } from "@web/fns/admin.ts";
import { errorText, useAct, useFn } from "@web/lib/api.ts";

export const Route = createFileRoute("/_app/dashboards/$id/widget/$index")({ component: WidgetPage });

/** Each type says what shape its query has to return, since that is what makes it draw. */
const TYPES = [
  ["bars", "Bars", "t, then one column per stack", <path key="b" d="M2 13V9M6 13V4M10 13V7M14 13V2" />],
  ["lines", "Lines", "t, then one column per line", <path key="l" d="M1.5 11 5.5 6l3.5 3 5.5-6" />],
  ["stat", "Number", "One row, one number", <path key="s" d="M4 5.5 6 4v8M9.5 5a2.2 2.2 0 1 1 3.6 1.7L9.5 12h4" />],
  ["list", "Ranked list", "label, value", <path key="r" d="M2 4h12M2 8h8M2 12h5" />],
  ["pie", "Pie", "label, value", <g key="p"><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5V8l4 3.7" /></g>],
  ["sparkline", "Sparkline", "t, then one value", <path key="p2" d="M1.5 9h3l2-5 3 8 2-3h3" />],
  ["table", "Table", "Any columns", <g key="t"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 7h12M7 7v6" /></g>],
] as const;

const WIDTHS = [["3", "¼"], ["4", "⅓"], ["6", "½"], ["8", "⅔"], ["12", "Full"]] as const;

function Editor({ id, index, title, widgets, source, file }: { id: string; index: number; title: string; widgets: Widget[]; source: string; file: string }) {
  const widget = widgets[index]!;
  const save = useAct(saveDashboardFn);
  const navigate = useNavigate();
  const readOnly = source === "code";
  const form = useForm({
    defaultValues: { title: widget.title, type: widget.type, sql: widget.sql, span: String(widget.span ?? 6) },
    onSubmit: ({ value }) => {
      const next = widgets.map((w, i) => (i === index ? { ...w, title: value.title, type: value.type, sql: value.sql, span: Number(value.span) || 6 } : w));
      save.mutate({ id, title, widgets: next }, { onSuccess: () => void navigate({ to: "/dashboards/$id", params: { id } }), onError: (error) => toast(errorText(error)) });
    },
  });
  const values = useStore(form.store, (state) => state.values);
  // The preview runs what you typed once you pause, not on every keystroke.
  const [ran, setRan] = useState(values.sql);
  useEffect(() => {
    const timer = setTimeout(() => setRan(values.sql), 450);
    return () => clearTimeout(timer);
  }, [values.sql]);
  const type = TYPES.find(([key]) => key === values.type);
  const width = WIDTHS.some(([key]) => key === values.span) ? values.span : "6";
  return (
    <form className="home-editor" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      <Head back={`/dashboards/${id}`} backTitle="Back to dashboard" title={values.title || "Untitled widget"} meta={<span className="dhm">{title}</span>} right={<>
        <Link className="btn" to="/console" search={{ sql: values.sql }}>Open in console</Link>
        {readOnly ? <Link className="btn" to="/dashboards/$id" params={{ id }}>Close</Link> : <><Link className="btn" to="/dashboards/$id" params={{ id }}>Cancel</Link><button className="btn pri" type="submit">Apply</button></>}
      </>} />
      {readOnly && (
        <div className="home-code-note">
          <span>Read only. This widget is defined in code, in <b className="mono">definitions/{file}</b>. Edit that file: it reloads here at once and deploys with your app.</span>
        </div>
      )}
      <div className="home-editor-grid">
        <div className="home-editor-left">
          <div className="home-eh">
            <span className="home-h">Query</span>
            <button type="button" className="lnk-quiet home-eh-do" onClick={() => copy(values.sql, "Query copied")}>Copy</button>
          </div>
          <form.Field name="sql">{(field) => <CodeEditor label="Query" readOnly={readOnly} rows={12} value={field.state.value} onChange={field.handleChange} />}</form.Field>
          {type && <div className="home-e-shape"><span className="t3">{type[1]} expects</span> <span className="mono">{type[2]}</span></div>}
        </div>
        <div className="home-editor-right">
          <div className="home-editor-preview wd">
            <WidgetBody widget={{ ...widget, title: values.title, type: values.type, sql: ran, height: 200 }} />
          </div>
          <div className="home-eh"><span className="home-h">Shown as</span></div>
          <form.Field name="type">
            {(field) => (
              <div className="wtypes home-types" role="radiogroup" aria-label="Widget type">
                {TYPES.map(([key, label, , glyph]) => (
                  <button type="button" role="radio" aria-checked={field.state.value === key} key={key} disabled={readOnly} className={field.state.value === key ? "on" : ""} onClick={() => field.handleChange(key)}>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyph}</svg>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </form.Field>
          {!readOnly && (
            <div className="home-e-fields">
              <form.Field name="title">{(field) => <TextField field={field} label="Title" />}</form.Field>
              <form.Field name="span">
                {(field) => (
                  <div className="field">
                    Width
                    <Segments value={width} options={WIDTHS} onChange={field.handleChange} env={false} />
                  </div>
                )}
              </form.Field>
            </div>
          )}
        </div>
      </div>
    </form>
  );
}

function WidgetPage() {
  const { id, index } = Route.useParams();
  const q = useFn(dashboardFn, { id });
  return <Load q={q}>{(d) => (d.widgets[Number(index)] ? <Editor key={index} id={id} index={Number(index)} title={d.title} widgets={d.widgets} source={d.source} file={d.file} /> : <div className="home-quiet"><b>This dashboard has no such widget</b><div><Link className="btn" to="/dashboards/$id" params={{ id }}>Back to {d.title}</Link></div></div>)}</Load>;
}
