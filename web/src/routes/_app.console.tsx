import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { SERIES } from "@web/components/charts.tsx";
import { CodeEditor, Hl } from "@web/components/code.tsx";
import { Icon } from "@web/components/icons.tsx";
import { DataTable, type Col } from "@web/components/table.tsx";
import { toast } from "@web/components/toast.tsx";
import { copy, Pop, SearchBox, Segments, SplitBar, Tabs } from "@web/components/ui.tsx";
import { YChart, type YRow } from "@web/components/ychart.tsx";
import { addSavedViewFn, consoleTablesFn, runConsoleFn, savedViewsFn } from "@web/fns/explore.ts";
import { errorText, useAct, useFn } from "@web/lib/api.ts";
import { num } from "@web/lib/format.ts";
import { useScope } from "@web/lib/scope.ts";

const search = z.object({
  sql: z.string().optional().catch(undefined),
  t: z.string().optional().catch(undefined),
  view: z.enum(["table", "chart"]).optional().catch(undefined),
  y: z.string().optional().catch(undefined),
  side: z.enum(["tables", "queries"]).optional().catch(undefined),
});
export const Route = createFileRoute("/_app/console")({ validateSearch: search, component: ConsolePage });

const DEFAULT = `SELECT TaskKind AS kind, count() AS runs,
       quantile(0.95)(DurationMs) AS p95,
       countIf(Outcome = 'failed') AS failed
FROM logs
WHERE $__timeFilter(Timestamp) AND Environment = $__env AND Kind = 'task'
GROUP BY kind
ORDER BY failed DESC
LIMIT 100`;

const EXAMPLES: [string, string][] = [
  ["Failures by task", DEFAULT],
  ["Slowest routes", `SELECT Route AS route, count() AS requests,
       quantile(0.95)(DurationMs) AS p95
FROM logs
WHERE $__timeFilter(Timestamp) AND Environment = $__env AND Kind = 'request'
GROUP BY route
ORDER BY p95 DESC
LIMIT 50`],
  ["Errors over time", `SELECT $__bucket(Timestamp) AS t, ServiceName AS service, count() AS errors
FROM logs
WHERE $__timeFilter(Timestamp) AND Environment = $__env AND SeverityText = 'error'
GROUP BY t, service
ORDER BY t`],
  ["Busiest people", `SELECT UserId AS person, count() AS requests,
       countIf(Status >= 500) AS failed
FROM logs
WHERE $__timeFilter(Timestamp) AND Environment = $__env AND Kind = 'request' AND UserId != ''
GROUP BY person
ORDER BY requests DESC
LIMIT 50`],
];

const SHORTCUTS: [string, string][] = [
  ["$__timeFilter(Timestamp)", "The time range at the top"],
  ["$__env", "The environment at the top"],
  ["$__bucket(Timestamp)", "Groups rows into chart buckets"],
];

const RECENT_KEY = "vigie.console.recent";
function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function remember(sql: string) {
  const next = [sql, ...readRecent().filter((item) => item !== sql)].slice(0, 12);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

type Row = Record<string, unknown>;
type Column = { name: string; type: string };

const isNumeric = (column: Column) => /Int|Float|Decimal/.test(column.type);
function asTime(value: unknown) {
  if (typeof value === "number") return value > 1e11 ? value : NaN;
  if (typeof value === "string") {
    if (/^\d{12,}$/.test(value)) return Number(value);
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(`${value.replace(" ", "T")}${value.endsWith("Z") ? "" : "Z"}`) : NaN;
  }
  return NaN;
}

/** Works out what a result can be drawn as: over time when a column holds times, ranked when it has a name and a number. Otherwise not at all. */
function chartOf(columns: Column[], rows: Row[]) {
  if (!rows.length) return null;
  const sample = rows[0]!;
  const time = columns.find((c) => /Date/.test(c.type) || ((/^(t|time|bucket|minute|hour|day)$/i).test(c.name) && Number.isFinite(asTime(sample[c.name]))));
  const numbers = columns.filter((c) => isNumeric(c) && c !== time);
  const texts = columns.filter((c) => !isNumeric(c) && c !== time);
  if (!numbers.length) return null;
  if (time && rows.length > 1) return { kind: "time" as const, time: time.name, numbers: numbers.map((c) => c.name), split: texts[0]?.name };
  if (texts.length) return { kind: "ranked" as const, label: texts[0]!.name, numbers: numbers.map((c) => c.name) };
  return null;
}

function Schema({ tables, open, onOpen, onInsert, inputId }: { tables: Record<string, string[]>; open: string; onOpen: (table: string) => void; onInsert: (text: string) => void; inputId?: string }) {
  const [text, setText] = useState("");
  const needle = text.toLowerCase();
  const entries = Object.entries(tables).map(([table, cols]) => ({ table, cols: needle && !table.toLowerCase().includes(needle) ? cols.filter((c) => c.toLowerCase().includes(needle)) : cols, hit: table.toLowerCase().includes(needle) })).filter((entry) => entry.hit || entry.cols.length);
  return (
    <>
      <SearchBox id={inputId} value={text} onChange={setText} placeholder="Find a table or column" style={{ width: "100%", flex: "none" }} />
      <div className="console-schema">
        {entries.map(({ table, cols }) => {
          const expanded = table === open || Boolean(needle);
          return (
            <div key={table}>
              <div className={`console-table ${expanded ? "on" : ""}`}>
                <button className="console-tname" aria-expanded={expanded} onClick={() => onOpen(expanded && !needle ? "" : table)}>
                  <span className={`console-chev ${expanded ? "open" : ""}`}><Icon name="chev" /></span>
                  <span className="ell">{table}</span>
                </button>
                <button className="console-add" title={`Insert ${table}`} aria-label={`Insert ${table}`} onClick={() => onInsert(table)}>+</button>
              </div>
              {expanded && (
                <div className="console-cols">
                  {cols.map((column) => <button key={column} className="console-col" title={`Insert ${column}`} onClick={() => onInsert(column)}>{column}</button>)}
                </div>
              )}
            </div>
          );
        })}
        {!entries.length && <div className="console-none">Nothing called “{text}”.</div>}
        {!needle && (
          <>
            <div className="console-area">Shortcuts</div>
            {SHORTCUTS.map(([code, meaning]) => (
              <button key={code} className="console-short" title={`Insert ${code}`} onClick={() => onInsert(code)}>
                <span className="ell console-code">{code}</span>
                <span className="ell t3">{meaning}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </>
  );
}

function Queries({ recent, saved, onPick }: { recent: string[]; saved: { id: string; name: string; filter: string }[]; onPick: (sql: string) => void }) {
  const line = (key: string, label: string | null, sql: string) => (
    <button key={key} className="console-query" onClick={() => onPick(sql)} title={sql}>
      {label && <span className="ell console-qname">{label}</span>}
      <span className="ell console-code"><Hl lang="sql">{sql.replace(/\s+/g, " ")}</Hl></span>
    </button>
  );
  return (
    <div className="console-schema">
      {saved.length > 0 && <div className="console-area">Saved</div>}
      {saved.map((view) => line(view.id, view.name, view.filter))}
      {recent.length > 0 && <div className="console-area">Recent</div>}
      {recent.map((sql) => line(sql, null, sql))}
      <div className="console-area">Starting points</div>
      {EXAMPLES.map(([name, sql]) => line(name, name, sql))}
    </div>
  );
}

function ConsolePage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const scope = useScope();
  const patch = useCallback((next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true }), [navigate]);
  const tables = useFn(consoleTablesFn, undefined, { staleTime: Infinity });
  const saved = useFn(savedViewsFn, { scope: "console" });
  const save = useAct(addSavedViewFn);
  const [sql, setSql] = useState(s.sql ?? DEFAULT);
  const [recent, setRecent] = useState<string[]>([]);
  const [saveName, setSaveName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  useEffect(() => setRecent(readRecent()), []);
  const run = useMutation({ mutationFn: (text: string) => runConsoleFn({ data: { ...scope.params, sql: text } }), onSuccess: (_, text) => setRecent(remember(text)) });
  const page = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run.mutate(sql);
  }, [run, sql]);
  const execute = (text = sql) => {
    patch({ sql: text === DEFAULT ? undefined : text });
    run.mutate(text);
  };
  const insert = (text: string) => {
    const area = page.current?.querySelector<HTMLTextAreaElement>("textarea.editor");
    const start = area?.selectionStart ?? sql.length;
    const end = area?.selectionEnd ?? sql.length;
    const before = sql.slice(0, start);
    const after = sql.slice(end);
    const lead = before && !/[\s(,.]$/.test(before) ? " " : "";
    const trail = after && !/^[\s),.]/.test(after) ? " " : "";
    const next = `${before}${lead}${text}${trail}${after}`;
    setSql(next);
    const caret = before.length + lead.length + text.length + trail.length;
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(caret, caret);
    });
  };
  const pick = (text: string) => {
    setSql(text);
    execute(text);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea")) {
        if (event.key === "Escape") target.blur();
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        patch({ side: undefined });
        requestAnimationFrame(() => document.getElementById("consoleFind")?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [patch]);
  const result = run.data;
  const columns = useMemo<Col<Row>[]>(() => (result?.columns ?? []).map((column) => {
    const numeric = isNumeric(column);
    return { id: column.name, header: column.name, num: numeric, sort: numeric ? (row) => Number(row[column.name] ?? 0) : (row) => String(row[column.name] ?? ""), className: (row) => `mono ${column.name === "failed" && Number(row[column.name]) > 0 ? "err" : ""}`, cell: (row) => { const value = row[column.name]; return typeof value === "object" ? JSON.stringify(value) : numeric ? num(Number(value)) : String(value ?? ""); } };
  }), [result?.columns]);
  const keyed = useMemo(() => (result?.rows ?? []).map((row, index) => ({ ...row, __index: index })), [result?.rows]);
  const chart = useMemo(() => (result ? chartOf(result.columns, result.rows) : null), [result]);
  const view = chart ? (s.view ?? "table") : "table";
  const y = chart?.numbers.includes(s.y ?? "") ? s.y! : chart?.numbers[0] ?? "";
  const timeChart = useMemo(() => {
    if (chart?.kind !== "time" || !result) return null;
    const byTime = new Map<number, YRow>();
    const names = new Set<string>();
    for (const row of result.rows) {
      const t = asTime(row[chart.time]);
      if (!Number.isFinite(t)) continue;
      const target = byTime.get(t) ?? ({ t } as YRow);
      if (chart.split) {
        const name = String(row[chart.split] ?? "");
        names.add(name);
        target[name] = Number(row[y] ?? 0);
      } else {
        for (const key of chart.numbers.slice(0, 6)) {
          names.add(key);
          target[key] = Number(row[key] ?? 0);
        }
      }
      byTime.set(t, target);
    }
    const rows = [...byTime.values()].sort((a, b) => a.t - b.t);
    return { rows, keys: [...names].slice(0, 8).map((key) => ({ key, label: key })) };
  }, [chart, result, y]);
  const rankedMax = Math.max(1, ...(result?.rows ?? []).map((row) => Number(row[y] ?? 0)));
  const toCsv = () => {
    if (!result) return;
    const names = result.columns.map((c) => c.name);
    const csv = [names.join(","), ...result.rows.map((row) => names.map((n) => JSON.stringify(row[n] ?? "")).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "vigie-query.csv";
    link.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${result.rows.length} rows`);
  };
  const open = s.t ?? "logs";
  const side = s.side ?? "tables";
  const lines = sql.split("\n").length;
  const rail = (id?: string) => (
    <>
      <Tabs value={side} onChange={(value) => patch({ side: value === "tables" ? undefined : value })} style={{ padding: 0 }} options={[["tables", "Tables"], ["queries", "Queries"]]} />
      {side === "tables"
        ? <Schema tables={tables.data ?? {}} open={open} onOpen={(table) => patch({ t: table })} onInsert={insert} inputId={id} />
        : <Queries recent={recent} saved={saved.data ?? []} onPick={pick} />}
    </>
  );
  return (
    <div className="console-page" ref={page}>
      <aside className="console-rail" aria-label="Tables and queries">{rail("consoleFind")}</aside>
      <div className="console-main">
        <div className="console-editor">
          <CodeEditor
            label="Query"
            value={sql}
            rows={Math.min(16, Math.max(6, lines + 1))}
            onChange={setSql}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                execute();
              }
            }}
          />
          <div className="console-run">
            <button className="btn pri" onClick={() => execute()} disabled={run.isPending}>Run query <span className="kbd console-kbd">⌘↵</span></button>
            <Pop open={saveOpen} onOpenChange={setSaveOpen} width={240} trigger={<button className="btn">Save</button>}>
              <form className="logs-saveform" onSubmit={(event) => {
                event.preventDefault();
                const name = saveName.trim();
                if (!name) return;
                save.mutate({ name, scope: "console", filter: sql }, { onSuccess: () => { toast(`Saved as ${name}`); patch({ side: "queries" }); }, onError: (error) => toast(errorText(error)) });
                setSaveName("");
                setSaveOpen(false);
              }}>
                <input className="input" autoFocus aria-label="Query name" placeholder="Name this query" value={saveName} onChange={(event) => setSaveName(event.target.value)} />
                <button className="btn" type="submit" disabled={!saveName.trim()}>Save</button>
              </form>
            </Pop>
            <span className="console-phone">
              <Pop width={300} trigger={<button className="btn">Tables</button>}>
                <div className="console-pop">{rail()}</div>
              </Pop>
            </span>
            <span className="console-stat">
              {run.isPending ? "Running…" : result && !run.error ? `${num(result.rows.length)} ${result.rows.length === 1 ? "row" : "rows"} in ${result.elapsed} ms, ${num(result.rowsRead)} scanned` : "Read only, stops after 10 s"}
            </span>
          </div>
        </div>
        <div className="console-results conres" style={{ "--console-cols": result?.columns.length ?? 1 } as React.CSSProperties}>
          {run.error && <p className="console-error" role="alert">{errorText(run.error)}</p>}
          {result && !run.error && (
            <>
              <div className="console-bar">
                {chart && <Segments value={view} env={false} onChange={(value) => patch({ view: value === "table" ? undefined : value })} options={[["table", "Table"], ["chart", "Chart"]]} />}
                {view === "chart" && chart && chart.numbers.length > 1 && (chart.kind === "ranked" || chart.split) && (
                  <Pop width={200} trigger={<button className="fchip">Show <span className="v">{y}</span><Icon name="chev" /></button>}>
                    {chart.numbers.map((name) => <button key={name} className="pitem" onClick={() => patch({ y: name })}><span className={`chk ${name === y ? "on" : ""}`}><Icon name="check" /></span><span className="m ell">{name}</span></button>)}
                  </Pop>
                )}
                <span className="grow" />
                <button className="btn" onClick={() => copy(JSON.stringify({ tool: "run_query", arguments: { sql } }), "Copied as an MCP call")}>Copy as MCP call</button>
                <button className="btn" onClick={toCsv} disabled={!result.rows.length}>Export CSV</button>
              </div>
              {view === "table" && <DataTable rows={keyed} columns={columns} rowKey={(row) => String((row as Row).__index)} emptyTitle="No rows" emptyHint="This query is valid but matched nothing in this time range." />}
              {view === "chart" && chart?.kind === "time" && timeChart && timeChart.rows.length > 0 && (
                <div className="console-chart"><YChart rows={timeChart.rows} keys={timeChart.keys} from={timeChart.rows[0]!.t} to={timeChart.rows[timeChart.rows.length - 1]!.t} height={340} label="Query result over time" />{timeChart.keys.length > 1 && <div className="xleg">{timeChart.keys.map((key, i) => <span key={key.key}><i style={{ background: SERIES[i % SERIES.length] }} />{key.label}</span>)}</div>}</div>
              )}
              {view === "chart" && chart?.kind === "ranked" && (
                <div className="console-chart console-ranked">
                  {result.rows.slice(0, 60).map((row, i) => <SplitBar key={i} height={30} labelWidth={210} label={<span className="mono" style={{ fontSize: 12 }}>{String(row[chart.label])}</span>} value={Number(row[y] ?? 0)} max={rankedMax} color="var(--a)" right={num(Number(row[y] ?? 0))} />)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
