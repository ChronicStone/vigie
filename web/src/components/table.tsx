import { createSortedRowModel, rowSortingFeature, sortFn_basic, tableFeatures, useTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fadeIn } from "./motion.tsx";

const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() });

export type Col<T> = { id: string; header: ReactNode; cell: (row: T) => ReactNode; num?: boolean; width?: number | string; sort?: (row: T) => number | string; className?: string | ((row: T) => string); style?: React.CSSProperties };
type Sort = { id: string; desc: boolean }[];

/**
 * Every table in the app: TanStack Table for the model, TanStack Virtual for the rows.
 * 10,000 rows scroll like 50, and the header stays put.
 */
const isBlank = (value: ReactNode) => value === "" || value === null || value === undefined || value === false;

export function DataTable<T extends object>({ rows, columns: allColumns, onRow, rowKey, rowHeight = 34, inCard, emptyTitle = "Nothing here", emptyHint, initialSort, rowClass, tableId, selected, onSort }: {
  /** Told when the person changes the sort, so a page can keep it in the URL and pass it back as initialSort. */
  onSort?: (sort: { id: string; desc: boolean } | null) => void;
  rows: T[];
  columns: Col<T>[];
  onRow?: (row: T) => void;
  rowKey: (row: T) => string;
  rowHeight?: number;
  inCard?: boolean;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  initialSort?: { id: string; desc: boolean };
  rowClass?: (row: T) => string;
  tableId?: string;
  selected?: string | null;
}) {
  // A column that is empty on every row says nothing: it stays off until a row has a value.
  const columns = useMemo(() => {
    if (!rows.length) return allColumns;
    const sample = rows.slice(0, 300);
    return allColumns.filter((column) => column.header === "" || sample.some((row) => !isBlank(column.cell(row))));
  }, [rows, allColumns]);
  const [sorting, setSorting] = useState<Sort>(initialSort ? [initialSort] : []);
  const scroller = useRef<HTMLDivElement>(null);
  const tbody = useRef<HTMLTableSectionElement>(null);
  const sortedBy = useRef(sorting);
  useEffect(() => {
    if (sortedBy.current === sorting) return;
    sortedBy.current = sorting;
    onSort?.(sorting[0] ?? null);
    fadeIn(tbody.current, { opacity: 0, translate: "0 3px" }, 200);
  }, [sorting]);
  // Headers and cells are drawn below from `columns`. The model only needs ids and sort values.
  const defs = useMemo(() => columns.map((column) => ({ id: column.id, enableSorting: Boolean(column.sort), accessorFn: column.sort ?? (() => 0), sortFn: sortFn_basic })) as unknown as ColumnDef<typeof features, T, unknown>[], [columns]);
  const table = useTable({ features, columns: defs, data: rows, state: { sorting }, onSortingChange: setSorting as never, getRowId: (row: T) => rowKey(row) } as never) as unknown as { getRowModel: () => { rows: { id: string; original: T }[] } };
  const model = table.getRowModel().rows;
  const virtual = useVirtualizer({ count: inCard ? 0 : model.length, getScrollElement: () => scroller.current, estimateSize: () => rowHeight, overscan: 14 });
  const items = inCard ? null : virtual.getVirtualItems();
  const top = items?.[0]?.start ?? 0;
  const bottom = items?.length ? virtual.getTotalSize() - items[items.length - 1]!.end : 0;
  const body = items ? items.map((item) => ({ row: model[item.index]!, key: item.key })) : model.map((row) => ({ row, key: row.id }));
  const tableEl = (
    <table data-testid={tableId}>
      <thead>
        <tr>
          {columns.map((column) => {
            const sorted = sorting[0]?.id === column.id ? (sorting[0].desc ? "down" : "up") : "";
            return (
              <th key={column.id} className={`${column.num ? "num" : ""} ${sorted ? "on" : ""}`} style={column.width ? { width: column.width } : undefined} aria-sort={sorted ? (sorting[0]!.desc ? "descending" : "ascending") : undefined}>
                {column.sort ? (
                  <button onClick={() => setSorting((prev) => (prev[0]?.id === column.id ? (prev[0].desc ? [{ id: column.id, desc: false }] : []) : [{ id: column.id, desc: true }]))}>
                    {column.header}
                    <svg className={`sorti ${sorted}`} viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                ) : (
                  column.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody ref={tbody}>
        {top > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: top, padding: 0, border: 0 }} /></tr>}
        {body.map(({ row, key }) => (
          <tr key={key} className={`${onRow ? "click" : ""} ${rowClass?.(row.original) ?? ""} ${selected && selected === row.id ? "sel" : ""}`} onClick={onRow ? () => onRow(row.original) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (event) => event.key === "Enter" && onRow(row.original) : undefined} style={{ height: rowHeight }}>
            {columns.map((column) => (
              <td key={column.id} className={`${column.num ? "num" : ""} ${typeof column.className === "function" ? column.className(row.original) : (column.className ?? "")}`} style={column.style}>
                {column.cell(row.original)}
              </td>
            ))}
          </tr>
        ))}
        {bottom > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: bottom, padding: 0, border: 0 }} /></tr>}
      </tbody>
    </table>
  );
  const empty = !rows.length && (
    <div className="ph" style={{ padding: "48px 20px" }}>
      <div>
        <h3>{emptyTitle}</h3>
        {emptyHint && <p>{emptyHint}</p>}
      </div>
    </div>
  );
  // With no row, column headers label nothing.
  if (!rows.length) return <div className="tbl" style={{ overflow: "visible" }}>{empty}</div>;
  if (inCard) return <div className="tbl" style={{ overflow: "visible" }}>{tableEl}{empty}</div>;
  return (
    <div className="tblwrap">
      <div className="tbl" ref={scroller}>
        {tableEl}
        {empty}
      </div>
    </div>
  );
}
