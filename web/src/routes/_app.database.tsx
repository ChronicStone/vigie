import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { DbColumn } from "@server/api/database.ts";
import { Icon } from "@web/components/icons.tsx";
import { Glide } from "@web/components/motion.tsx";
import { DataTable, type Col } from "@web/components/table.tsx";
import { toast } from "@web/components/toast.tsx";
import { Card, copy, Empty, Kv, Load, Pop, SearchBox, Segments } from "@web/components/ui.tsx";
import { dbLinksFn, dbRowsFn, dbSourcesFn, dbSqlFn, dbStructureFn, dbTablesFn } from "@web/fns/explore.ts";
import { errorText, useFn } from "@web/lib/api.ts";
import { bytes, compact } from "@web/lib/format.ts";
import { Code, CodeEditor, Hl } from "@web/components/code.tsx";

const filterIn = z.object({ column: z.string(), op: z.string(), value: z.string().optional() });
const search = z.object({
  source: z.enum(["pg", "ch"]).optional().catch(undefined),
  table: z.string().optional().catch(undefined),
  mode: z.enum(["data", "structure", "sql"]).optional().catch(undefined),
  filters: z.array(filterIn).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  row: z.number().optional().catch(undefined),
  sort: z.string().optional().catch(undefined),
  desc: z.boolean().optional().catch(undefined),
  via: z.string().optional().catch(undefined),
});
export const Route = createFileRoute("/_app/database")({ validateSearch: search, component: DatabasePage });

type Filter = z.infer<typeof filterIn>;
type Row = Record<string, unknown>;
type DbLink = { table: string; column: string; to: string };
const PAGE = 200;

const OPS: Record<string, [string, string][]> = {
  text: [["eq", "is"], ["neq", "is not"], ["contains", "contains"], ["not_contains", "does not contain"], ["starts", "starts with"], ["ends", "ends with"], ["in", "is one of"], ["not_in", "is none of"], ["empty", "is empty"], ["not_empty", "is not empty"], ["null", "is null"], ["not_null", "is not null"]],
  uuid: [["eq", "is"], ["neq", "is not"], ["in", "is one of"], ["null", "is null"], ["not_null", "is not null"]],
  enum: [["eq", "is"], ["neq", "is not"], ["in", "is one of"], ["not_in", "is none of"], ["null", "is null"], ["not_null", "is not null"]],
  number: [["eq", "="], ["neq", "≠"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"], ["between", "between"], ["null", "is null"], ["not_null", "is not null"]],
  time: [["gt", "after"], ["lt", "before"], ["between", "between"], ["null", "is null"], ["not_null", "is not null"]],
  bool: [["true", "is true"], ["false", "is false"], ["null", "is null"]],
  json: [["json_contains", "contains JSON"], ["json_has", "has key"], ["null", "is null"], ["not_null", "is not null"]],
};
const CH_OPS: [string, string][] = [["eq", "is"], ["neq", "is not"], ["contains", "contains"], ["gt", ">"], ["lt", "<"]];
const NO_VALUE = new Set(["null", "not_null", "true", "false", "empty", "not_empty"]);
const STATE_TONE: Record<string, string> = { DONE: "ok", FAILED: "err", RUNNING: "lnk", QUEUED: "t2", CANCELLED: "t3", SKIPPED: "t3" };

function cellText(value: unknown) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function AddFilter({ columns, source, onAdd, seed }: { columns: DbColumn[]; source: "pg" | "ch"; onAdd: (filter: Filter) => void; seed?: string }) {
  const [column, setColumn] = useState<DbColumn | null>(seed ? columns.find((c) => c.name === seed) ?? null : null);
  const [op, setOp] = useState("");
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const ops = column ? (source === "ch" ? CH_OPS : OPS[column.kind] ?? OPS.text!) : [];
  const chosen = op || ops[0]?.[0] || "";
  const reset = () => { setColumn(null); setOp(""); setValue(""); };
  return (
    <Pop open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }} width={290} trigger={<button className="addf">+ Filter</button>}>
      {!column ? (
        <>
          <h6>Filter by a column</h6>
          <div className="scrollp">
            {columns.map((c) => <button key={c.name} className="pitem" onClick={() => setColumn(c)}><span className="m ell">{c.name}</span><span className="n">{c.type}</span></button>)}
          </div>
        </>
      ) : (
        <form style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }} onSubmit={(event) => { event.preventDefault(); onAdd({ column: column.name, op: chosen, value: NO_VALUE.has(chosen) ? undefined : value }); setOpen(false); reset(); }}>
          <div className="m" style={{ fontSize: 12 }}>{column.name} <span className="t3">{column.type}</span></div>
          <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
            {ops.map(([key, label]) => <button key={key} type="button" className={`tgl ${chosen === key ? "on" : ""}`} onClick={() => setOp(key)}>{label}</button>)}
          </div>
          {!NO_VALUE.has(chosen) && (column.enum ? (
            <div className="scrollp" style={{ maxHeight: 160 }}>
              {column.enum.map((option) => <button type="button" key={option} className={`pitem`} onClick={() => setValue(option)}><span className={`chk ${value === option ? "on" : ""}`}><Icon name="check" /></span><span>{option}</span></button>)}
            </div>
          ) : (
            <input className="input" autoFocus aria-label="Value" placeholder={chosen === "between" ? "from, to" : chosen === "in" || chosen === "not_in" ? "a, b, c" : "Value"} value={value} onChange={(e) => setValue(e.target.value)} />
          ))}
          <button className="btn pri" type="submit">Apply</button>
        </form>
      )}
    </Pop>
  );
}

const opLabel = (op: string) => Object.values(OPS).flat().find(([key]) => key === op)?.[1] ?? op;

/** How many rows elsewhere point at this one. A number with a page behind it is a link to that page. */
function LinkedRow({ source, link, value, onOpen }: { source: "pg" | "ch"; link: DbLink; value: unknown; onOpen: () => void }) {
  const filter = { column: link.column, op: "eq", value: String(value) };
  const q = useQuery({ queryKey: ["db-link-count", source, link.table, filter], queryFn: () => dbRowsFn({ data: { source, table: link.table, filters: [filter], limit: 1 } }), staleTime: 30_000 });
  const n = q.data?.count;
  return (
    <button className="database-linked" onClick={onOpen} disabled={n === 0}>
      <span className="ell mono">{link.table}<span className="t3">.{link.column}</span></span>
      <span className={`mono ${n ? "lnk" : "t4"}`}>{n === undefined || n === null ? "" : n.toLocaleString("en-US")}</span>
    </button>
  );
}

function Data({ source, table, columns, links }: { source: "pg" | "ch"; table: string; columns: DbColumn[]; links: DbLink[] }) {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const patch = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const filters = useMemo(() => s.filters ?? [], [s.filters]);
  const [text, setText] = useState(s.q ?? "");
  const q = useInfiniteQuery({
    queryKey: ["db-rows", source, table, filters, s.q, s.sort, s.desc],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => dbRowsFn({ data: { source, table, filters, search: s.q, sort: s.sort, desc: s.desc, limit: PAGE, offset: pageParam } }),
    getNextPageParam: (last, pages) => (last.rows.length < PAGE ? undefined : pages.length * PAGE),
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => (q.data?.pages.flatMap((page) => page.rows) ?? []) as Row[], [q.data]);
  const first = q.data?.pages[0];
  const selected = s.row !== undefined ? rows[s.row] : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 34, overscan: 16 });
  const items = virtual.getVirtualItems();
  const lastIndex = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (lastIndex >= rows.length - 30 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [lastIndex, rows.length, q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);
  // Following a link is a step you can go back from, so it is a real navigation, unlike a filter tweak.
  const open = (next: { table: string; filters?: Filter[] }) => void navigate({ search: (prev) => ({ ...prev, table: next.table, filters: next.filters, row: undefined, q: undefined, sort: undefined, desc: undefined, mode: undefined, via: table }) });
  const follow = (column: DbColumn, value: unknown) => column.references && open({ table: column.references.table, filters: [{ column: column.references.column, op: "eq", value: String(value) }] });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea")) {
        if (event.key === "Escape") {
          setText("");
          if (s.q) patch({ q: undefined });
          target.blur();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || document.querySelector(".pop")) return;
      if (event.key === "/") {
        event.preventDefault();
        document.getElementById("dbQ")?.focus();
      } else if (event.key === "Escape") {
        if (s.row !== undefined) patch({ row: undefined });
        else if (s.q) patch({ q: undefined });
      } else if (event.key === "j" || event.key === "k") {
        const next = Math.max(0, (s.row ?? -1) + (event.key === "j" ? 1 : -1));
        if (next < rows.length) {
          patch({ row: next });
          virtual.scrollToIndex(next, { align: "auto" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const toCsv = () => {
    const names = columns.map((c) => c.name);
    const csv = [names.join(","), ...rows.map((row) => names.map((n) => JSON.stringify(row[n] ?? "")).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${table}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} rows as CSV`);
  };
  const sortOn = (name: string) => {
    if (source !== "pg") return;
    if (s.sort !== name) patch({ sort: name, desc: true, row: undefined });
    else if (s.desc !== false) patch({ desc: false, row: undefined });
    else patch({ sort: undefined, desc: undefined, row: undefined });
  };
  const filtered = Boolean(filters.length || s.q);
  return (
    <>
      <div className="database-filters">
        {source === "pg" && (
          <form onSubmit={(event) => { event.preventDefault(); patch({ q: text || undefined, row: undefined }); }} style={{ display: "contents" }}>
            <SearchBox id="dbQ" value={text} onChange={setText} placeholder="Search this table" style={{ width: 220 }} />
          </form>
        )}
        {filters.map((filter, index) => (
          <span className="tok" key={`${filter.column}${index}`}>
            <span className="k mono" style={{ paddingRight: 4 }}>{filter.column}</span>
            <span className="o">{opLabel(filter.op)}</span>
            {filter.value !== undefined && <span className="v" style={{ paddingLeft: 5, paddingRight: 2 }}>{filter.value}</span>}
            <button className="x" aria-label="Remove filter" onClick={() => patch({ filters: filters.filter((_, i) => i !== index), row: undefined })}>×</button>
          </span>
        ))}
        <AddFilter columns={columns} source={source} onAdd={(filter) => patch({ filters: [...filters, filter], row: undefined })} />
        <span className="grow" />
        <span className="database-count">
          {first?.count != null ? `${first.count.toLocaleString("en-US")} ${first.count === 1 ? "row" : "rows"}` : `${rows.length} rows`}
        </span>
        <button className="btn" onClick={toCsv} disabled={!rows.length}>Export</button>
      </div>
      {q.error && <p className="console-error" role="alert">{errorText(q.error)}</p>}
      <div className="dbmain">
        <div className="dbgrid database-grid" ref={scroller}>
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.name} title={c.type} aria-sort={s.sort === c.name ? (s.desc === false ? "ascending" : "descending") : undefined}>
                    {source === "pg" ? <button className="database-th" onClick={() => sortOn(c.name)}>{c.name}{s.sort === c.name && <Icon name={s.desc === false ? "up" : "down"} size={11} />}</button> : c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items[0] && items[0].start > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: items[0].start, padding: 0, border: 0 }} /></tr>}
              {items.map((item) => {
                const row = rows[item.index]!;
                return (
                  <tr key={item.index} className={s.row === item.index ? "sel" : ""} onClick={() => patch({ row: item.index })} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && patch({ row: item.index })}>
                    {columns.map((column) => {
                      const raw = cellText(row[column.name]);
                      // Sub-second digits push everything else off screen. The whole value is in the row panel.
                      const text = raw !== null && column.kind === "time" ? raw.replace(/(\d{2}:\d{2}:\d{2})\.\d+.*$/, "$1") : raw;
                      if (text === null) return <td key={column.name}><span className="t4 mono">null</span></td>;
                      if (column.kind === "enum" || column.name === "state") return <td key={column.name}><button className={`epill ${STATE_TONE[text] ?? ""}`} title="Filter on this value" onClick={(event) => { event.stopPropagation(); patch({ filters: [...filters, { column: column.name, op: "eq", value: text }], row: undefined }); }}>{text}</button></td>;
                      if (column.references) return <td key={column.name}><button className="mono lnk fk" title={`Open in ${column.references.table}`} onClick={(event) => { event.stopPropagation(); follow(column, row[column.name]); }}>{text}</button></td>;
                      if (column.kind === "number") return <td key={column.name}><span className="mono" style={{ display: "block", textAlign: "right" }}>{text}</span></td>;
                      if (column.kind === "json") return <td key={column.name}><span className="mono ell" style={{ display: "block", maxWidth: 260 }}><Hl lang="json">{text}</Hl></span></td>;
                      return <td key={column.name}><span className={`mono ell ${column.primary ? "t2" : ""}`} style={{ display: "block", maxWidth: 300 }}>{text}</span></td>;
                    })}
                  </tr>
                );
              })}
              {items.length > 0 && virtual.getTotalSize() - items[items.length - 1]!.end > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: virtual.getTotalSize() - items[items.length - 1]!.end, padding: 0, border: 0 }} /></tr>}
            </tbody>
          </table>
          {!rows.length && !q.isPending && !q.error && (
            <div className="ph" style={{ padding: "60px 20px" }}>
              <div>
                <h3>{filtered ? "No row matches" : "This table is empty"}</h3>
                {filtered && <><p>These filters found nothing here.</p><button className="btn" style={{ marginTop: 12 }} onClick={() => { setText(""); patch({ filters: undefined, q: undefined, row: undefined }); }}>Clear filters</button></>}
              </div>
            </div>
          )}
        </div>
        {selected && (
          <aside className="panel dbpanel database-panel" aria-label="Row">
            <div className="phead">
              <span className="ell mono">{cellText(selected[columns.find((c) => c.primary)?.name ?? columns[0]!.name])}</span>
              <span className="grow" />
              <button className="ib" title="Copy this row" aria-label="Copy this row" onClick={() => copy(JSON.stringify(selected, null, 2), "Row copied")}><Icon name="copy" /></button>
              <button className="ib" title="Close, Esc" aria-label="Close row" onClick={() => patch({ row: undefined })}><Icon name="x" /></button>
            </div>
            <div className="pbody">
              {links.length > 0 && (
                <div className="rd">
                  <div className="rdh"><span>Rows that point here</span></div>
                  {links.map((link) => <LinkedRow key={`${link.table}.${link.column}`} source={source} link={link} value={selected[link.to]} onOpen={() => open({ table: link.table, filters: [{ column: link.column, op: "eq", value: String(selected[link.to]) }] })} />)}
                </div>
              )}
              <div className="rd">
                <div className="kvg">
                  {columns.filter((c) => c.kind !== "json").map((c) => {
                    const text = cellText(selected[c.name]);
                    return <Kv key={c.name} k={c.name} tone={text === null ? "t4" : c.name === "state" ? STATE_TONE[text] : undefined}>{c.references && text ? <button className="lnk mono" onClick={() => follow(c, selected[c.name])}>{text}</button> : text ?? "null"}</Kv>;
                  })}
                </div>
              </div>
              {columns.filter((c) => c.kind === "json" && selected[c.name] !== null).map((c) => (
                <div className="rd" key={c.name} style={{ borderBottom: 0 }}>
                  <div className="rdh"><span>{c.name}</span><button onClick={() => copy(cellText(selected[c.name]) ?? "", "JSON copied")}>Copy</button></div>
                  <Code text={JSON.stringify(typeof selected[c.name] === "string" ? JSON.parse(selected[c.name] as string) : selected[c.name], null, 2)} lang="json" fold />
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
    </>
  );
}

function Structure({ columns, indexes, links, onOpen }: { columns: DbColumn[]; indexes: { name: string; columns: string; note: string }[]; links: DbLink[]; onOpen: (table: string) => void }) {
  return (
    <div className="ov">
      <div className="ovg" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
        <Card title="Columns" right={<span className="a">{columns.length}</span>}>
          <DataTable inCard rows={columns} rowKey={(c) => c.name} columns={[
            { id: "name", header: "Name", className: "mono", cell: (c) => <>{c.name}{c.primary && <span className="t4"> key</span>}</> },
            { id: "type", header: "Type", className: "mono t3", cell: (c) => c.type },
            { id: "refs", header: "Points to", className: "mono", cell: (c) => (c.references ? <button className="lnk mono" onClick={() => onOpen(c.references!.table)}>{c.references.table}.{c.references.column}</button> : "") },
          ]} />
        </Card>
        <Card title="Indexes" right={<span className="a">{indexes.length}</span>}>
          {indexes.map((index) => (
            <div className="lst" key={index.name} style={{ height: "auto", paddingTop: 8, paddingBottom: 8, alignItems: "flex-start" }}>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="mono ell" style={{ display: "block" }}>{index.name}</span>
                <span className="t3 mono" style={{ fontSize: 11.5 }}>{index.columns}</span>
              </span>
              <span className="t3" style={{ fontSize: 12, textAlign: "right" }}>{index.note}</span>
            </div>
          ))}
          {!indexes.length && <div className="cb t3">No index reported.</div>}
          {links.length > 0 && (
            <>
              <div className="ch"><span>Pointed at by</span><span className="a">{links.length}</span></div>
              {links.map((link) => (
                <button className="lst" key={`${link.table}.${link.column}`} onClick={() => onOpen(link.table)}>
                  <span className="mono grow ell">{link.table}<span className="t3">.{link.column}</span></span>
                  <span className="t3 mono">{link.to}</span>
                </button>
              ))}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function SqlMode({ source, table }: { source: "pg" | "ch"; table: string }) {
  const [sql, setSql] = useState(source === "pg" ? `SELECT *\nFROM "${table}"\nLIMIT 100` : `SELECT *\nFROM ${table}\nLIMIT 100`);
  const run = useMutation({ mutationFn: (text: string) => dbSqlFn({ data: { source, sql: text } }) });
  const columns = useMemo<Col<Row>[]>(() => (run.data?.columns ?? []).map((name) => ({ id: name, header: name, className: "mono", sort: (row) => cellText(row[name]) ?? "", cell: (row) => cellText(row[name]) ?? <span className="t4">null</span> })), [run.data]);
  return (
    <div className="database-sql">
      <div className="console-editor">
        <CodeEditor label="SQL" rows={6} value={sql} onChange={setSql} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); run.mutate(sql); } }} />
        <div className="console-run">
          <button className="btn pri" onClick={() => run.mutate(sql)} disabled={run.isPending}>Run <span className="kbd console-kbd">⌘↵</span></button>
          <span className="console-stat">{run.data ? `${run.data.rows.length} rows in ${run.data.elapsed} ms` : "Read only, stops after 30 s"}</span>
        </div>
      </div>
      <div className="console-results conres">
        {run.error && <p className="console-error" role="alert">{errorText(run.error)}</p>}
        {run.data && !run.error && <DataTable rows={run.data.rows} columns={columns} rowKey={(row) => JSON.stringify(row).slice(0, 180)} emptyTitle="No rows" />}
      </div>
    </div>
  );
}

function TableList({ tables, table, onPick, id, zeroIsReal }: { tables: { name: string; rows: number }[]; table?: string; onPick: (name: string) => void; id?: string; zeroIsReal: boolean }) {
  const [text, setText] = useState("");
  const shown = tables.filter((t) => t.name.toLowerCase().includes(text.toLowerCase()));
  return (
    <>
      <SearchBox id={id} value={text} onChange={setText} placeholder="Find a table" style={{ width: "100%", flex: "none" }} />
      <div className="dblist">
        {shown.map((t) => (
          <button key={t.name} className={`mitem database-item ${t.name === table ? "on" : ""}`} onClick={() => onPick(t.name)}>
            <span className="mono ell">{t.name}</span>
            {Number(t.rows) > 0 || zeroIsReal ? <span className="t3 mono">{compact(Number(t.rows))}</span> : null}
          </button>
        ))}
        {!shown.length && <div className="console-none">No table called “{text}”.</div>}
      </div>
    </>
  );
}

function DatabasePage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const patch = (next: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const sources = useFn(dbSourcesFn, undefined, { staleTime: Infinity });
  // A source that is not connected is not an option. It is simply not offered.
  const usable = (sources.data ?? []).filter((option) => option.available);
  const source = usable.some((option) => option.id === s.source) ? s.source! : usable[0]?.id ?? "ch";
  const tables = useFn(dbTablesFn, { source }, { staleTime: 60_000, enabled: sources.data !== undefined });
  const mode = s.mode ?? "data";
  const list = tables.data ?? [];
  const table = s.table && list.some((t) => t.name === s.table) ? s.table : list[0]?.name;
  const meta = list.find((t) => t.name === table);
  const structure = useFn(dbStructureFn, { source, table: table ?? "" }, { enabled: Boolean(table), staleTime: 60_000 });
  const inbound = useFn(dbLinksFn, { source, table: table ?? "" }, { enabled: Boolean(table), staleTime: 60_000 });
  const links = inbound.data ?? [];
  const outbound = [...new Set((structure.data?.columns ?? []).flatMap((c) => (c.references ? [c.references.table] : [])))];
  const pickTable = (name: string) => patch({ table: name, filters: undefined, row: undefined, q: undefined, sort: undefined, desc: undefined, via: undefined });
  const openTable = (name: string, filters?: Filter[]) => void navigate({ search: (prev) => ({ ...prev, table: name, filters, row: undefined, q: undefined, sort: undefined, desc: undefined, mode: undefined, via: table }) });
  return (
    <div className="dbwrap database-page">
      <aside className="dbside database-rail" aria-label="Tables">
        {usable.length > 1 && (
          <div className="seg env" style={{ width: "100%" }}>
            <Glide on={source} />
            {usable.map((option) => (
              <button key={option.id} style={{ flex: 1 }} className={source === option.id ? "on" : ""} onClick={() => patch({ source: option.id, table: undefined, filters: undefined, row: undefined, q: undefined, sort: undefined, desc: undefined, via: undefined })}>{option.label}</button>
            ))}
          </div>
        )}
        <TableList tables={list} table={table} onPick={pickTable} zeroIsReal={source === "pg"} />
      </aside>
      <div className="dbcontent">
        {!table ? (
          tables.error ? <Empty title="This did not load" hint={errorText(tables.error)} /> : tables.isPending ? null : <Empty title="No table here" />
        ) : (
          <>
            <div className="database-head">
              {s.via && <button className="ib" title={`Back to ${s.via}`} aria-label={`Back to ${s.via}`} onClick={() => router.history.back()}><Icon name="back" /></button>}
              <h2 className="mono">{table}</h2>
              {meta && Number(meta.bytes) > 0 && <span className="t3">{bytes(Number(meta.bytes))}</span>}
              <span className="database-phone">
                <Pop width={280} trigger={<button className="fchip">Change table<Icon name="chev" /></button>}>
                  <div className="metrics-popbody"><TableList tables={list} table={table} onPick={pickTable} zeroIsReal={source === "pg"} /></div>
                </Pop>
              </span>
              <span className="grow" />
              <Segments value={mode} env={false} onChange={(value) => patch({ mode: value === "data" ? undefined : value })} options={[["data", "Rows"], ["structure", "Structure"], ["sql", "SQL"]]} />
            </div>
            {(outbound.length > 0 || links.length > 0) && (
              <div className="database-links">
                {outbound.length > 0 && <span><em>Points to</em>{outbound.map((name) => <button key={name} className="lnk mono" onClick={() => openTable(name)}>{name}</button>)}</span>}
                {links.length > 0 && <span><em>Pointed at by</em>{[...new Set(links.map((link) => link.table))].map((name) => <button key={name} className="lnk mono" onClick={() => openTable(name)}>{name}</button>)}</span>}
              </div>
            )}
            <Load q={structure}>
              {(d) => (mode === "data" ? <Data key={`${source}${table}`} source={source} table={table} columns={d.columns} links={links} /> : mode === "structure" ? <Structure columns={d.columns} indexes={d.indexes} links={links} onOpen={openTable} /> : <SqlMode key={`${source}${table}`} source={source} table={table} />)}
            </Load>
          </>
        )}
      </div>
    </div>
  );
}
