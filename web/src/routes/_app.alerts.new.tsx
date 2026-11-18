import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import type { AlertRule } from "@sdk";
import { Choice } from "@web/components/form.tsx";
import { LimitChart, type ChartIncident } from "@web/components/reliability.tsx";
import { toast } from "@web/components/toast.tsx";
import { Head } from "@web/components/ui.tsx";
import { requestsFn } from "@web/fns/backend.ts";
import { alertPreviewFn, channelNamesFn, createAlertFn, rulesFn, slosFn } from "@web/fns/reliability.ts";
import { taskHealthFn } from "@web/fns/tasks.ts";
import { errorText, useAct, useFn, useScoped } from "@web/lib/api.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({ method: z.string().optional().catch(undefined), route: z.string().optional().catch(undefined) });
export const Route = createFileRoute("/_app/alerts/new")({ validateSearch: search, component: AlertNewPage });

/** What people pick from, by what it watches. The stored family keeps its name, since alerts in code and through MCP use the same words. */
const GROUPS = [
  ["Requests", [["endpoint", "Route latency"], ["requests", "Server errors"]]],
  ["Tasks", [["tasks", "Task failures"], ["absence", "Task stopped running"]]],
  ["Logs", [["pattern", "Log pattern"], ["error", "Error count"]]],
  ["Signals", [["metric", "Custom metric"], ["anomaly", "Anomaly"], ["slo", "SLO burn"], ["rule", "Production rule"]]],
] as const;
type Family = (typeof GROUPS)[number][1][number][0];
const STORED: Record<Family, string> = { endpoint: "Endpoint", requests: "Requests", tasks: "Tasks", absence: "No activity", pattern: "Log pattern", error: "New error", metric: "Custom metric", slo: "SLO burn", rule: "Production rule", anomaly: "Anomaly" };
const WINDOWS = [["5m", "5 min"], ["10m", "10 min"], ["15m", "15 min"], ["30m", "30 min"], ["1h", "1 h"]] as const;
type Win = (typeof WINDOWS)[number][0];

type Values = { family: Family; target: string; threshold: string; window: Win; minRequests: string; name: string; sigma: string; quiet: boolean; quietFrom: string; quietTo: string; notify: string };

const ANOMALY_SOURCES = [["", "server errors"], ["tasks", "failed attempts"]] as const;
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const isTime = (text: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(text);

function ruleOf(v: Values): { rule: AlertRule; sentence: string; unit: string } {
  const made = baseRuleOf(v);
  const rule: AlertRule = { ...made.rule, ...(v.notify ? { notify: v.notify } : {}), ...(v.quiet && isTime(v.quietFrom) && isTime(v.quietTo) ? { quiet: { from: v.quietFrom, to: v.quietTo, timezone: TIMEZONE } } : {}) };
  return { ...made, rule };
}

function baseRuleOf(v: Values): { rule: AlertRule; sentence: string; unit: string } {
  const above = Number(v.threshold) || 0;
  const base = { window: v.window, above };
  const w = WINDOWS.find(([key]) => key === v.window)![1];
  switch (v.family) {
    case "endpoint": {
      const [method, route] = v.target.split(" ");
      return { unit: "ms", sentence: `p95 of ${v.target || "any route"} above ${above} ms for ${w}`, rule: { ...base, unit: "ms", when: { source: "route-p95", method: method || undefined, route: route || undefined, minRequests: Number(v.minRequests) || 0 }, condition: `p95 above ${above} ms over ${w}, at least ${v.minRequests} requests` } };
    }
    case "requests":
      return { unit: "%", sentence: `server errors above ${above}% over ${w}`, rule: { ...base, unit: "%", when: { source: "request-error-rate" }, condition: `Server errors above ${above}% over ${w}` } };
    case "tasks":
      return { unit: "%", sentence: `failed attempts${v.target ? ` of ${v.target}` : ""} above ${above}% over ${w}`, rule: { ...base, unit: "%", when: { source: "task-failure-rate", kind: v.target || undefined }, condition: `Failed attempts${v.target ? ` of ${v.target}` : ""} above ${above}% over ${w}` } };
    case "absence":
      return { unit: "", sentence: `no ${v.target || "task"} ran for ${w}`, rule: { window: v.window, below: 1, when: { source: "absence", taskKind: v.target }, condition: `No ${v.target} for ${w}` } };
    case "pattern": {
      const [key, value] = v.target.split("=");
      return { unit: "", sentence: `more than ${above} events with ${v.target || "this field"} in ${w}`, rule: { ...base, when: { source: "log-count", where: { [key ?? ""]: value ?? "" } }, condition: `More than ${above} events with ${v.target} in ${w}` } };
    }
    case "error":
      return { unit: "", sentence: `more than ${above} errors in ${w}`, rule: { ...base, when: { source: "new-error" }, condition: `More than ${above} grouped errors in ${w}` } };
    case "anomaly": {
      const sigma = Number(v.sigma) || 3;
      const label = ANOMALY_SOURCES.find(([key]) => key === v.target)?.[1] ?? (v.target ? `p95 of ${v.target}` : "server errors");
      const [method, route] = v.target.split(" ");
      const when: AlertRule["when"] = v.target === "tasks" ? { source: "task-failure-rate" } : route ? { source: "route-p95", method, route } : { source: "request-error-rate" };
      const unit = route ? "ms" : "%";
      return { unit, sentence: `${label} ${sigma} sigma above the last 7 days, over ${w}`, rule: { window: v.window, sigma, unit, when, condition: `${label[0]!.toUpperCase()}${label.slice(1)} ${sigma} sigma above the last 7 days, over ${w}` } };
    }
    case "slo":
      return { unit: "x", sentence: `${v.target || "an objective"} burning faster than ${above}x its budget`, rule: { window: v.window, above, unit: "x", when: { source: "slo-burn", slo: v.target }, condition: `${v.target} burning faster than ${above}x its budget` } };
    case "rule":
      return { unit: "", sentence: `${v.target || "a production rule"} is violated`, rule: { window: v.window, above: 0, when: { source: "rule-violation", rule: v.target }, condition: `${v.target} is violated` } };
    case "metric":
      return { unit: "", sentence: `${v.target || "a metric"} above ${above} for ${w}`, rule: { ...base, when: { source: "metric", name: v.target, agg: "max" }, condition: `${v.target} above ${above} for ${w}` } };
  }
}

const NEEDS_TARGET: Partial<Record<Family, string>> = { absence: "Pick a task", pattern: "Name a field and a value", metric: "Name a metric" };

/** The same walk the server does to count what would have fired, kept as spans so the chart can show them. */
function firedSpans(points: { t: number; v: number }[], limit: number | null | undefined, below: boolean): ChartIncident[] {
  if (limit === null || limit === undefined) return [];
  const spans: ChartIncident[] = [];
  let open: number | null = null;
  for (const point of points) {
    const value = Number(point.v);
    const over = below ? value < limit : value > limit;
    if (over && open === null) open = Number(point.t);
    if (!over && open !== null) {
      spans.push({ started: open, ended: Number(point.t) });
      open = null;
    }
  }
  if (open !== null) spans.push({ started: open, ended: Number(points[points.length - 1]!.t) });
  return spans;
}

function AlertNewPage() {
  const s = Route.useSearch();
  const navigate = useNavigate();
  const scope = useScope();
  const create = useAct(createAlertFn);
  const routes = useScoped(requestsFn, { tab: "matched" });
  const kinds = useScoped(taskHealthFn, {});
  const sloList = useFn(slosFn, { env: scope.env });
  const ruleList = useScoped(rulesFn, {});
  const channels = useFn(channelNamesFn, undefined);
  const form = useForm({
    defaultValues: { family: "endpoint", target: s.method && s.route ? `${s.method} ${s.route}` : "", threshold: "2000", window: "10m", minRequests: "20", name: "", sigma: "3", quiet: false, quietFrom: "22:00", quietTo: "07:00", notify: "" } as Values,
    onSubmit: ({ value }) => {
      const { rule, sentence } = ruleOf(value);
      create.mutate({ name: value.name.trim() || sentence[0]!.toUpperCase() + sentence.slice(1), family: STORED[value.family], rule }, { onSuccess: ({ id }) => { toast("Alert created"); void navigate({ to: "/alerts/$id", params: { id } }); }, onError: (error) => toast(errorText(error)) });
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const { rule, unit } = ruleOf(values);
  const live = values.family === "slo" || values.family === "rule";
  const missing = !values.target ? NEEDS_TARGET[values.family] : undefined;
  const previewReady = !live && !missing;
  const preview = useQuery({ queryKey: ["alert-preview", rule, scope.env], queryFn: () => alertPreviewFn({ data: { ...scope.params, rule } }), enabled: previewReady, placeholderData: (prev) => prev, staleTime: 30_000 });
  const routeOptions = routes.data?.tab === "matched" ? routes.data.rows.map((r) => [`${r.method} ${r.route}`, `${r.method} ${r.route}`] as const) : [];
  const kindOptions = (kinds.data?.rows ?? []).map((k) => [k.kind, k.kind] as const);
  const fired = preview.data?.fired ?? 0;
  const [now] = useState(() => Date.now());
  const history = (preview.data?.history ?? []) as { t: number; v: number }[];
  const limit = preview.data?.threshold ?? rule.above ?? rule.below ?? null;
  const verdict = live
    ? "This one is checked live, so there is no preview."
    : missing
      ? `${missing} to see what this would have done.`
      : !preview.data
        ? "Checking the last 7 days"
        : !preview.data.enoughHistory
          ? "Not enough history to preview this yet."
          : fired === 0
            ? "It would not have fired in the last 7 days."
            : fired === 1
              ? "It would have fired once in the last 7 days."
              : `It would have fired ${fired} times in the last 7 days.`;
  const number = (name: "threshold" | "minRequests" | "sigma", label: string, width: number) => (
    <form.Field name={name}>{(field) => <input className="wpick" style={{ width }} inputMode="decimal" aria-label={label} value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />}</form.Field>
  );
  const text = (label: string, placeholder: string) => (
    <form.Field name="target">{(field) => <input className="wpick alertnew-wide" aria-label={label} placeholder={placeholder} value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />}</form.Field>
  );
  const pick = (label: string, options: readonly (readonly [string, string])[]) => (
    <form.Field name="target">{(field) => <Choice label={label} value={field.state.value} onChange={field.handleChange} options={options} />}</form.Field>
  );
  return (
    <form className="ov alertnew" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      <Head back="/alerts" backTitle="Back to alerts" title="New alert" right={<><Link className="btn" to="/alerts">Cancel</Link><button type="submit" className="btn pri" disabled={create.isPending}>Create alert</button></>} />

      <section className="alertnew-fams" aria-label="What to watch">
        <form.Field name="family">
          {(field) => GROUPS.map(([group, items]) => (
            <div className="alertnew-famrow" key={group}>
              <span>{group}</span>
              <div>
                {items.map(([key, label]) => (
                  <button key={key} type="button" className={`alertnew-fam ${field.state.value === key ? "on" : ""}`} aria-pressed={field.state.value === key} onClick={() => { field.handleChange(key); form.setFieldValue("target", ""); form.setFieldValue("threshold", key === "endpoint" ? "2000" : key === "requests" || key === "tasks" ? "5" : "10"); }}>{label}</button>
                ))}
              </div>
            </div>
          ))}
        </form.Field>
      </section>

      <section className="alertnew-say">
        <p className="alertnew-sentence">
          Alert when{" "}
          {values.family === "endpoint" && <>p95 latency of {pick("Route", [["", "any route"], ...routeOptions])} stays above {number("threshold", "Threshold in milliseconds", 76)} ms</>}
          {values.family === "requests" && <>server errors stay above {number("threshold", "Threshold percent", 60)}%</>}
          {values.family === "tasks" && <>failed attempts of {pick("Task kind", [["", "any task"], ...kindOptions])} stay above {number("threshold", "Threshold percent", 60)}%</>}
          {values.family === "absence" && <>no {pick("Task kind", [["", "pick a task"], ...kindOptions])} runs</>}
          {values.family === "pattern" && <>more than {number("threshold", "Count", 60)} events carry {text("Field equals value", "reason=PROVIDER_RATE_LIMITED")}</>}
          {values.family === "error" && <>more than {number("threshold", "Count", 60)} errors happen</>}
          {values.family === "slo" && <>{pick("Objective", [["", "pick an objective"], ...(sloList.data ?? []).map((slo) => [slo.id, slo.name] as const)])} burns faster than {number("threshold", "Burn rate", 60)}x its budget</>}
          {values.family === "rule" && <>{pick("Rule", [["", "pick a rule"], ...(ruleList.data ?? []).map((r) => [r.id, r.name] as const)])} is violated</>}
          {values.family === "metric" && <>{text("Metric name", "v8.heap.used")} stays above {number("threshold", "Threshold", 76)}</>}
          {values.family === "anomaly" && <>{pick("What to watch", [...ANOMALY_SOURCES, ...routeOptions.map(([key, label]) => [key, `p95 of ${label}`] as const)])} goes {number("sigma", "Sigma", 48)} sigma above its last 7 days</>}
          {" "}for <form.Field name="window">{(field) => <Choice label="Window" value={field.state.value} onChange={field.handleChange} options={WINDOWS} />}</form.Field>
          {values.family === "endpoint" && <>, with at least {number("minRequests", "Minimum requests", 56)} requests</>}.
        </p>
        <div className="alertnew-opts">
          <span className="alertnew-opt">
            Tell
            <form.Field name="notify">{(field) => <Choice label="Channel" className="fchip" value={field.state.value} onChange={field.handleChange} options={[["", "Every channel"], ...(channels.data ?? []).map((name) => [name, name] as const)]} />}</form.Field>
          </span>
          <span className="alertnew-opt">
            <form.Field name="quiet">{(field) => <label className="alertnew-check"><input type="checkbox" checked={field.state.value} onChange={(event) => field.handleChange(event.target.checked)} />Quiet hours</label>}</form.Field>
            {values.quiet && (
              <>
                <form.Field name="quietFrom">{(field) => <input className="input alertnew-time" aria-label="Quiet from" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} />}</form.Field>
                to
                <form.Field name="quietTo">{(field) => <input className="input alertnew-time" aria-label="Quiet until" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} />}</form.Field>
              </>
            )}
          </span>
          <form.Field name="name">{(field) => <input className="input alertnew-name" placeholder="Name, optional" aria-label="Alert name" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />}</form.Field>
        </div>
        {values.quiet && <p className="alertnew-note">{TIMEZONE}. Still recorded. You are told when they end, if it is still firing.</p>}
      </section>

      <section className="alertnew-preview" aria-live="polite">
        <p className={`alertnew-verdict ${fired > 0 && previewReady ? "warn" : ""}`}>{verdict}</p>
        {previewReady && <LimitChart points={history} from={now - 7 * 86_400_000} to={now} limit={limit} below={rule.below !== undefined} unit={unit} incidents={firedSpans(history, limit, rule.below !== undefined)} label="What this alert would have done" height={170} />}
      </section>
    </form>
  );
}
