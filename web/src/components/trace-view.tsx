import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { SpanRow, TraceLog } from "@server/api/traces.ts";
import { fms } from "@web/lib/format.ts";
import { Entry, Kv, Sql, WhyFix, copy } from "./ui.tsx";
import { Icon } from "./icons.tsx";
import { spanKind, spanLabel, spansToRows, Waterfall, type WfRow } from "./waterfall.tsx";

export const KIND_LABEL = { app: "Application span", db: "Database query", ext: "Outgoing HTTP call", cache: "Cache call", task: "Task", log: "Log line", wait: "Waiting" } as const;

export function originOf(spans: SpanRow[], logs: { t: number }[]) {
  return Math.min(...spans.map((s) => s.start), ...logs.map((l) => l.t));
}
export function totalOf(spans: SpanRow[], logs: { t: number }[], origin: number) {
  return Math.max(1, ...spans.map((s) => s.start + s.duration - origin), ...logs.map((l) => l.t - origin));
}

export function SpanInspector({ span, spans, total, why, fix }: { span: SpanRow; spans: SpanRow[]; total: number; why?: string; fix?: string }) {
  const kind = spanKind(span);
  const own = Math.max(0, span.duration - spans.filter((s) => s.parent === span.id).reduce((sum, s) => sum + s.duration, 0));
  const repeats = span.statement ? spans.filter((s) => s.statement === span.statement && s.parent === span.parent).length : 1;
  const failed = span.status === "Error" || span.httpStatus >= 400;
  const origin = Math.min(...spans.map((s) => s.start));
  const request = span.attrs["url.full"] ? `${span.attrs["http.request.method"] ?? ""} ${span.attrs["url.full"]}${span.httpStatus ? `\n\n${span.httpStatus} ${(span.message ?? "").replace(new RegExp(`^(HTTP )?${span.httpStatus}\\s*`), "")}` : ""}` : "";
  return (
    <>
      <div className="ins">
        <div className="rdh" style={{ marginBottom: 5 }}>
          <span>{KIND_LABEL[kind]}</span>
          <span className="src">{((span.duration / total) * 100).toFixed(1)}% of the time</span>
        </div>
        <h4 className={failed ? "err" : ""}><Entry text={spanLabel(span)} /></h4>
      </div>
      <div className="rd">
        <div className="nums">
          <div className="num"><b>{fms(span.duration)}</b><span>duration</span></div>
          <div className="num"><b>{fms(own)}</b><span>own time</span></div>
          <div className="num"><b>+{Math.round(span.start - origin)} ms</b><span>started at</span></div>
        </div>
      </div>
      {(span.statement || request) && (
        <div className="rd">
          <div className="rdh">
            <span>{span.statement ? "Statement" : "Request and response"}</span>
            <button onClick={() => copy(span.statement || request)}>Copy</button>
          </div>
          <Sql text={span.statement || request} lang={span.statement ? "sql" : "log"} pretty fold />
        </div>
      )}
      {repeats > 3 && (
        <div className="rd">
          <div className="stmt">
            <b>This query ran {repeats} times in one request.</b>
            <br />
            Load these rows once with an IN clause.
          </div>
          {span.hash !== "0" && <Link className="lnk" style={{ display: "block", marginTop: 8, fontSize: 12.5 }} to="/queries/$hash" params={{ hash: span.hash }}>Open this query</Link>}
        </div>
      )}
      {failed && (why || fix) && <div className="rd"><WhyFix why={why} fix={fix} style={{ margin: 0 }} /></div>}
      <div className="rd" style={{ borderBottom: 0 }}>
        <div className="rdh"><span>Attributes</span></div>
        <div className="kvg" style={{ marginTop: 10 }}>
          <Kv k="service.name">{span.service}</Kv>
          <Kv k="service.version">{span.version}</Kv>
          {Object.entries(span.attrs).filter(([key]) => key !== "db.query.text").map(([key, value]) => (
            <Kv key={key} k={key} tone={key === "http.response.status_code" && Number(value) >= 400 ? "err" : undefined}>{value}</Kv>
          ))}
        </div>
      </div>
    </>
  );
}

/** Find a span, errors only. The colours are named once, by the time bar above the waterfall. */
export function TraceWaterfall({ spans, logs, selected, onSelect, marks, truncated, findId, keyboard }: { spans: SpanRow[]; logs: TraceLog[]; selected: string | null; onSelect: (id: string) => void; marks?: boolean; truncated?: boolean; findId?: string; keyboard?: boolean }) {
  const [text, setText] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const origin = originOf(spans, logs);
  const total = totalOf(spans, logs, origin);
  const rows = useMemo(() => spansToRows(spans, [], origin), [spans, origin]);
  const errors = rows.filter((r) => r.error).length;
  const q = text.toLowerCase();
  const filter = useMemo(() => (errorsOnly || q ? (row: WfRow) => (!errorsOnly || Boolean(row.error)) && (!q || row.label.toLowerCase().includes(q)) : undefined), [errorsOnly, q]);
  return (
    <>
      <div className="wftool">
        <div className="finp">
          <Icon name="search" />
          <input id={findId} placeholder="Find a span" aria-label="Find a span" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setText(""); e.currentTarget.blur(); } }} />
        </div>
        {errors > 0 && <button className={`tgl ${errorsOnly ? "on" : ""}`} aria-pressed={errorsOnly} onClick={() => setErrorsOnly((v) => !v)}>Errors only <b>{errors}</b></button>}
        <span className="grow" />
        <span className="t3" style={{ fontSize: 12.5 }}>{spans.length} {spans.length === 1 ? "span" : "spans"}{truncated ? ", more not shown" : ""}</span>
      </div>
      <Waterfall rows={rows} total={total} selected={selected} onSelect={onSelect} filter={filter} keyboard={keyboard} marks={marks ? logs.map((log) => ({ at: Math.max(0, log.t - origin), level: log.level })) : undefined} />
    </>
  );
}
