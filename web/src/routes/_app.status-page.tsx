import { Dialog } from "@base-ui/react/dialog";
import { createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useEffect, useState } from "react";
import { Choice } from "@web/components/form.tsx";
import { Part } from "@web/components/reliability.tsx";
import { IMPACT, StatusView, UPDATE, type StatusModel } from "@web/components/status-view.tsx";
import { toast } from "@web/components/toast.tsx";
import { Load } from "@web/components/ui.tsx";
import { declareIncidentFn, postStatusUpdateFn, saveStatusConfigFn, setStatusPageFn, statusEditorFn, statusPreviewFn } from "@web/fns/reliability.ts";
import { errorText, useAct, useFn } from "@web/lib/api.ts";
import { ago } from "@web/lib/format.ts";

export const Route = createFileRoute("/_app/status-page")({ component: StatusPageEditor });

type Editor = Awaited<ReturnType<typeof statusEditorFn>>;
type Draft = Editor["config"];
type Source = Editor["sources"][number];
type Impact = keyof typeof IMPACT;
type UpdateState = keyof typeof UPDATE;

const SECTIONS = [
  ["active", "Happening now", "Open incidents and their updates"],
  ["history", "History bars", "One bar per day, per component"],
  ["uptime", "Uptime", "The share of time each component was up"],
  ["past", "Past incidents", "Resolved incidents, with what was written"],
] as const;

/** The page as code: the same thing a `defineStatusPage` in definitions/ would hold. */
function asCode(draft: Draft, isPublic: boolean) {
  const q = (s: string) => JSON.stringify(s);
  const lines = [
    'import { defineStatusPage } from "@vigiejs/sdk";',
    "",
    "export const status = defineStatusPage({",
    ...(draft.title ? [`  title: ${q(draft.title)},`] : []),
    ...(draft.description ? [`  description: ${q(draft.description)},`] : []),
    `  public: ${isPublic},`,
    "  components: [",
    ...(draft.components ?? []).map((c) => `    { name: ${q(c.name)}, from: ${q(c.key)}${c.group ? `, group: ${q(c.group)}` : ""} },`),
    "  ],",
    `  show: { active: ${draft.show.active}, history: ${draft.show.history}, uptime: ${draft.show.uptime}, past: ${draft.show.past} },`,
    `  days: ${draft.days},`,
    "});",
    "",
  ];
  return lines.join("\n");
}

function StatusPageEditor() {
  const q = useFn(statusEditorFn, undefined, { refetchInterval: false });
  return <Load q={q}>{(editor) => <EditorBody editor={editor} refetch={() => void q.refetch()} />}</Load>;
}

function EditorBody({ editor, refetch }: { editor: Editor; refetch: () => void }) {
  const [draft, setDraft] = useState<Draft>(editor.config);
  useEffect(() => setDraft(editor.config), [editor.config]);
  const deferred = useDeferredValue(draft);
  const preview = useFn(statusPreviewFn, deferred, { refetchInterval: 30_000 });
  const save = useAct(saveStatusConfigFn);
  const setPublic = useAct(setStatusPageFn);
  const locked = Boolean(editor.code);
  const dirty = JSON.stringify(draft) !== JSON.stringify(editor.config);
  const components = draft.components ?? [];
  const used = new Set(components.map((c) => c.key));
  const free = editor.sources.filter((s) => !used.has(s.key));
  const sourceOf = (key: string) => editor.sources.find((s) => s.key === key);
  const patch = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));
  const setComponent = (index: number, next: Partial<Draft["components"] extends (infer C)[] | null ? C : never>) => patch({ components: components.map((c, i) => (i === index ? { ...c, ...next } : c)) });
  const move = (index: number, by: number) => {
    const list = [...components];
    const [item] = list.splice(index, 1);
    list.splice(index + by, 0, item!);
    patch({ components: list });
  };
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(asCode(draft, editor.isPublic));
      toast("Copied. Save it as definitions/status.ts: from then on, the page is set in code.");
    } catch {
      toast("Your browser refused the clipboard.");
    }
  };

  return (
    <div className="ov stp">
      <div className="stp-edit">
        <div className="stp-bar">
          <span className={`stp-public ${editor.isPublic ? "on" : ""}`}>{editor.isPublic ? "Public: anyone with the link" : "Private: signed-in people only"}</span>
          <span className="grow" />
          <a className="btn" href="/status" target="_blank" rel="noreferrer">Open</a>
          {!editor.code?.decidesPublic && (
            <button className="btn" onClick={() => setPublic.mutate({ public: !editor.isPublic }, { onSuccess: () => { toast(editor.isPublic ? "The page is private" : "The page is public"); refetch(); }, onError: (error) => toast(errorText(error)) })}>{editor.isPublic ? "Make private" : "Make public"}</button>
          )}
        </div>

        {editor.code && (
          <p className="stmt stp-code">
            Set in <code>{editor.code.file}</code>. Change it there and deploy: this page shows it.
            {editor.code.ignored > 0 && ` ${editor.code.ignored} other defineStatusPage ${editor.code.ignored === 1 ? "is" : "are"} ignored: only the last one counts.`}
          </p>
        )}

        <Incidents model={preview.data} sources={editor.sources} components={components} onChange={() => void preview.refetch()} />

        <Part title="Page">
          <div className="stp-fields">
            <label className="field">Title<input className="input" disabled={locked} value={draft.title} placeholder={preview.data?.title ?? "Status"} onChange={(event) => patch({ title: event.target.value })} maxLength={80} /></label>
            <label className="field">Description<textarea className="input stp-area" disabled={locked} value={draft.description} placeholder="What this page covers, and what keeps working during an outage." onChange={(event) => patch({ description: event.target.value })} maxLength={280} rows={2} /></label>
          </div>
        </Part>

        <Part title="Components" right={<span className="t3 stp-count">{components.length} shown</span>}>
          <div className="stp-comps">
            {components.length === 0 && <p className="t3 stp-empty">Nothing is shown. Add a monitor or an alert below.</p>}
            {components.map((c, index) => {
              const source = sourceOf(c.key);
              return (
                <div className="stp-comp" key={c.key}>
                  <div className="stp-order">
                    <button className="ib" aria-label={`Move ${c.name} up`} disabled={locked || index === 0} onClick={() => move(index, -1)}>↑</button>
                    <button className="ib" aria-label={`Move ${c.name} down`} disabled={locked || index === components.length - 1} onClick={() => move(index, 1)}>↓</button>
                  </div>
                  <div className="stp-cfields">
                    <input className="input" aria-label="Name visitors read" disabled={locked} value={c.name} onChange={(event) => setComponent(index, { name: event.target.value })} />
                    <input className="input" aria-label="Group" placeholder="No group" disabled={locked} value={c.group ?? ""} onChange={(event) => setComponent(index, { group: event.target.value || undefined })} />
                    <small className={source ? "t3" : "err"}>{source ? `${source.kind === "monitor" ? "Monitor" : "Alert"}: ${source.name}. ${source.detail}` : "Its monitor or alert no longer exists: it stays off the page."}</small>
                  </div>
                  <button className="btn stp-remove" disabled={locked} onClick={() => patch({ components: components.filter((_, i) => i !== index) })}>Remove</button>
                </div>
              );
            })}
            {!locked && free.length > 0 && (
              <label className="field stp-add">
                Add
                <select className="input" value="" onChange={(event) => {
                  const source = free.find((s) => s.key === event.target.value);
                  if (source) patch({ components: [...components, { key: source.key, name: source.name }] });
                }}>
                  <option value="">A monitor or an alert…</option>
                  <optgroup label="Monitors">{free.filter((s) => s.kind === "monitor").map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</optgroup>
                  <optgroup label="Alerts: error rates, failed tasks, queues">{free.filter((s) => s.kind === "alert").map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</optgroup>
                </select>
              </label>
            )}
          </div>
        </Part>

        <Part title="Sections">
          <div className="stp-sections">
            {SECTIONS.map(([key, label, hint]) => (
              <label className="stp-check" key={key}>
                <input type="checkbox" disabled={locked} checked={draft.show[key]} onChange={(event) => patch({ show: { ...draft.show, [key]: event.target.checked } })} />
                <span><b>{label}</b><small>{hint}</small></span>
              </label>
            ))}
            <label className="field stp-days">History<Choice label="Days of history" value={String(draft.days) as "30" | "60" | "90"} onChange={(value) => !locked && patch({ days: Number(value) as 30 | 60 | 90 })} options={[["30", "30 days"], ["60", "60 days"], ["90", "90 days"]]} /></label>
          </div>
        </Part>

        <div className="stp-save">
          <button className="btn" onClick={copyCode}>Copy as code</button>
          <span className="grow" />
          {dirty && !locked && <button className="btn" onClick={() => setDraft(editor.config)}>Discard</button>}
          {!locked && <button className="btn pri" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft, { onSuccess: () => { toast("Saved. Visitors see it now."); refetch(); }, onError: (error) => toast(errorText(error)) })}>{dirty ? "Save" : "Saved"}</button>}
        </div>
      </div>

      <div className="stp-preview" aria-label="Preview">
        <div className="stp-ptitle"><span>Preview</span>{dirty && <span className="warn">Not saved</span>}</div>
        {preview.data ? <StatusView model={preview.data} updatedAt={preview.dataUpdatedAt} preview /> : <div className="stp-ploading" />}
      </div>
    </div>
  );
}

/** What people read during an outage: declare one, then post updates until it is resolved. */
function Incidents({ model, sources, components, onChange }: { model?: StatusModel; sources: Source[]; components: { key: string; name: string }[]; onChange: () => void }) {
  const written = (model?.active ?? []).filter((i) => !i.detected);
  const detected = (model?.active ?? []).filter((i) => i.detected);
  return (
    <Part title="Incidents" right={<Declare components={components} sources={sources} onDone={onChange} />}>
      <div className="stp-incidents">
        {!written.length && !detected.length && <p className="t3 stp-empty">Nothing is open. Visitors see the components above and their history.</p>}
        {detected.map((i) => (
          <div className="stp-inc" key={i.id}>
            <div className="stp-inch"><b>{i.title}</b><span className="err">Detected {ago(i.started)}</span></div>
            <p className="t3">Vigie shows this on its own. Declare an incident to tell visitors what is going on.</p>
          </div>
        ))}
        {written.map((i) => <Update key={i.id} incident={i} onDone={onChange} />)}
      </div>
    </Part>
  );
}

function Update({ incident, onDone }: { incident: StatusModel["active"][number]; onDone: () => void }) {
  const post = useAct(postStatusUpdateFn);
  const [state, setState] = useState<UpdateState>(incident.state === "investigating" ? "identified" : incident.state === "identified" ? "monitoring" : "resolved");
  const [message, setMessage] = useState("");
  const [impact, impactTone] = IMPACT[incident.impact as Impact] ?? IMPACT.major;
  const [now, nowTone] = UPDATE[incident.state as UpdateState] ?? UPDATE.investigating;
  return (
    <div className="stp-inc">
      <div className="stp-inch"><b>{incident.title}</b><span className={`sp-chip ${impactTone}`}>{impact}</span><span className="grow" /><span className={nowTone}>{now}, {ago(incident.updates[0]?.at ?? incident.started)}</span></div>
      <form className="stp-post" onSubmit={(event) => {
        event.preventDefault();
        post.mutate({ incidentId: Number(incident.id.slice(1)), state, message }, { onSuccess: () => { toast(state === "resolved" ? "Resolved. It moves to past incidents." : "Posted. Visitors see it now."); setMessage(""); onDone(); }, onError: (error) => toast(errorText(error)) });
      }}>
        <Choice label="New state" value={state} onChange={setState} options={(["investigating", "identified", "monitoring", "resolved"] as const).map((s) => [s, UPDATE[s][0]] as const)} />
        <textarea className="input stp-area" rows={2} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={state === "resolved" ? "What fixed it, and whether anything was lost." : "What you know now, in plain words."} aria-label="Update" />
        <button className="btn pri" disabled={!message.trim() || post.isPending} type="submit">{state === "resolved" ? "Resolve" : "Post update"}</button>
      </form>
    </div>
  );
}

function Declare({ components, sources, onDone }: { components: { key: string; name: string }[]; sources: Source[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const declare = useAct(declareIncidentFn);
  const [title, setTitle] = useState("");
  const [impact, setImpact] = useState<Impact>("major");
  const [state, setState] = useState<UpdateState>("investigating");
  const [message, setMessage] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const choices = components.length ? components : sources.map((s) => ({ key: s.key, name: s.name }));
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="btn pri">Declare an incident</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="dlgback" />
        <Dialog.Popup className="dlg stp-dlg">
          <Dialog.Title className="dlgt">Declare an incident</Dialog.Title>
          <form className="stp-fields" onSubmit={(event) => {
            event.preventDefault();
            declare.mutate({ title, impact, monitors: picked, state, message }, { onSuccess: () => { toast("Declared. Visitors see it now."); setOpen(false); setTitle(""); setMessage(""); setPicked([]); onDone(); }, onError: (error) => toast(errorText(error)) });
          }}>
            <label className="field">What visitors read<input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Payments are failing" autoFocus maxLength={120} /></label>
            <label className="field">Impact<Choice label="Impact" value={impact} onChange={setImpact} options={(["minor", "major", "critical", "maintenance"] as const).map((i) => [i, IMPACT[i][0]] as const)} /></label>
            <fieldset className="stp-pick">
              <legend>Affects</legend>
              {choices.map((c) => (
                <label className="stp-check" key={c.key}>
                  <input type="checkbox" checked={picked.includes(c.key)} onChange={(event) => setPicked(event.target.checked ? [...picked, c.key] : picked.filter((k) => k !== c.key))} />
                  <span><b>{c.name}</b></span>
                </label>
              ))}
            </fieldset>
            <label className="field">State<Choice label="State" value={state} onChange={setState} options={(["investigating", "identified", "monitoring", "scheduled"] as const).map((s) => [s, UPDATE[s][0]] as const)} /></label>
            <label className="field">First update<textarea className="input stp-area" rows={3} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="What visitors notice, and what you are doing about it." /></label>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="btn pri" disabled={!title.trim() || !message.trim() || declare.isPending}>Declare</button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
