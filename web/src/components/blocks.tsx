import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import type { Tone, View } from "@sdk";
import { bytes, fms, statusClass } from "@web/lib/format.ts";
import { Kv } from "./ui.tsx";
import { Code, Hl, Json } from "@web/components/code.tsx";

const TONE: Record<Tone, string> = { neutral: "", ok: "ok", warn: "warn", error: "err", brand: "lnk", muted: "t3" };

function ViewLink({ view }: { view: Extract<View, { t: "link" }> }) {
  const text = view.text ?? view.id;
  switch (view.kind) {
    case "task":
      return <Link className="lnk mono" to="/tasks/run/$id" params={{ id: view.id }}>{text}</Link>;
    case "trace":
      return <Link className="lnk mono" to="/traces/$id" params={{ id: view.id }}>{text}</Link>;
    case "person":
      return <Link className="lnk" to="/users/$id" params={{ id: view.id }}>{text}</Link>;
    case "process":
      return <Link className="lnk" to="/processes/$id" params={{ id: view.id }}>{text}</Link>;
    case "page":
      return <Link className="lnk" to="/p/$id" params={{ id: view.id }}>{text}</Link>;
    case "account":
      return <Link className="lnk" to="/accounts">{text}</Link>;
    case "url":
      return <a className="lnk" href={view.id} target="_blank" rel="noreferrer">{text}</a>;
    default:
      return <span>{text}</span>;
  }
}

/** Draws what a renderer returned. Data only: extensions never run in the browser. */
export function Block({ view, onFilter }: { view: View; onFilter?: (field: string, value: string) => void }): ReactNode {
  if (view === null || view === undefined || view === false) return null;
  if (typeof view === "string" || typeof view === "number") return <span>{view}</span>;
  switch (view.t) {
    case "text":
      return <span className={`${view.tone ? TONE[view.tone] : ""} ${view.mono ? "mono" : ""}`}>{view.text}</span>;
    case "inline":
      return <>{view.children.map((child, i) => <Fragment key={i}><Block view={child} /></Fragment>)}</>;
    case "stack":
      return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{view.children.map((child, i) => <Block key={i} view={child} onFilter={onFilter} />)}</div>;
    case "section":
      return (
        <div className="rd">
          <div className="rdh"><span>{view.title}</span>{view.source && <span className="src">{view.source}</span>}</div>
          {view.children.map((child, i) => <Block key={i} view={child} onFilter={onFilter} />)}
        </div>
      );
    case "nums":
      return (
        <div className="nums">
          {view.items.map((item) => (
            <div className="num" key={item.label}>
              <b className={item.tone ? TONE[item.tone] : ""}><Block view={item.value} /></b>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      );
    case "kv":
      return (
        <div className="kvg">
          {view.rows.map((row) => (
            <Kv key={row.key ?? row.label} k={row.key} label={row.label} tone={row.tone ? TONE[row.tone] : undefined} onFilter={row.filter && row.key && onFilter ? () => onFilter(row.key!, String(row.value)) : undefined}>
              <Block view={row.value} />
            </Kv>
          ))}
        </div>
      );
    case "table":
      return (
        <div className="tbl" style={{ overflow: "visible" }}>
          <table>
            <thead><tr>{view.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>{view.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}><Block view={cell} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    case "badge":
      return <span className={`schip ${TONE[view.tone]}`}><i />{view.text}</span>;
    case "duration":
      return <span className="mono">{fms(view.ms)}</span>;
    case "bytes":
      return <span className="mono">{bytes(view.value)}</span>;
    case "status":
      return <span className={`mono ${statusClass(view.code)}`}>{view.code}</span>;
    case "code":
      return <span className="mono"><Hl>{view.text}</Hl></span>;
    case "sql":
      return (
        <div>
          {view.note && <div className="warn" style={{ marginBottom: 6 }}>{view.note}</div>}
          <Code text={view.text} lang="sql" pretty fold />
        </div>
      );
    case "json":
      return <Json value={view.value} fold />;
    case "callout":
      return <div className={`stmt ${TONE[view.tone]}`}>{view.title && <b>{view.title}<br /></b>}{view.text}</div>;
    case "meter":
      return <div className="dbm"><i style={{ width: `${Math.min(100, (view.value / Math.max(view.max, 1)) * 100)}%` }} /></div>;
    case "link":
      return <ViewLink view={view} />;
  }
}

