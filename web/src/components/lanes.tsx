import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { axisLabel, compact } from "@web/lib/format.ts";
import { Bars, Lines, TimeAxis } from "./charts.tsx";
import { Icon } from "./icons.tsx";
import { DataLink } from "./ui.tsx";

type Row = { t: number } & Record<string, any>;
export type LaneKey = { key: string; label: string; color: string };
export type Figure = { value: ReactNode; label?: string; tone?: string; color?: string };
export type Lane = {
  id: string;
  label: ReactNode;
  sub?: ReactNode;
  icon?: string;
  to?: string;
  search?: Record<string, string>;
  kind?: "bars" | "line";
  data: Row[];
  keys?: LaneKey[];
  format?: (value: number) => string;
  figures?: Figure[];
  threshold?: number;
};

export const VOLUME: LaneKey[] = [
  { key: "ok", label: "Ok", color: "var(--a)" },
  { key: "warn", label: "4xx", color: "var(--warn)" },
  { key: "error", label: "Failed", color: "var(--err)" },
];
export const AVG_P95_KEYS: LaneKey[] = [
  { key: "avg", label: "Average", color: "var(--t3)" },
  { key: "p95", label: "p95", color: "var(--a)" },
];

const nearest = (rows: Row[], t: number) => {
  let best: Row | undefined;
  let gap = Infinity;
  for (const row of rows) {
    const distance = Math.abs(row.t - t);
    if (distance < gap) {
      gap = distance;
      best = row;
    }
  }
  return best;
};

/** A line needs two points. One reading on its own becomes one bar, placed where it happened on the axis. */
function placed(rows: Row[], from: number, to: number): Row[] {
  const slots = 60;
  const step = (to - from) / slots;
  return Array.from({ length: slots }, (_, i) => {
    const t = from + i * step;
    return rows.find((row) => row.t >= t && row.t < t + step) ?? { t, ...Object.fromEntries(Object.keys(rows[0] ?? {}).filter((key) => key !== "t").map((key) => [key, 0])) };
  });
}

type Moment = { t: number; owner: object } | null;
function clockStore() {
  let moment: Moment = null;
  const listeners = new Set<() => void>();
  return {
    get: () => moment,
    set(next: Moment) {
      moment = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
const SharedClock = createContext<ReturnType<typeof clockStore> | null>(null);

/** Every group of lanes inside shows the same moment, however far apart on the page they are. */
export const useClockStore = () => {
  const shared = useContext(SharedClock);
  const [own] = useState(clockStore);
  return shared ?? own;
};
export function Clock({ children }: { children: ReactNode }) {
  const [store] = useState(clockStore);
  return <SharedClock.Provider value={store}>{children}</SharedClock.Provider>;
}

/** The line and the reading. Only this re-renders as the pointer moves: redrawing the charts on every move is what would make a long page lag. */
function Cursor({ store, self, root, lanes, from, to, dragging }: { store: ReturnType<typeof clockStore>; self: object; root: RefObject<HTMLDivElement | null>; lanes: Lane[]; from: number; to: number; dragging: boolean }) {
  const at = useSyncExternalStore(store.subscribe, store.get);
  // The last position stays mounted, so leaving fades out where it was instead of vanishing.
  const last = useRef(at);
  if (at) last.current = at;
  const spot = last.current;
  const box = root.current?.querySelector<HTMLElement>(".lane")?.getBoundingClientRect();
  const outer = root.current?.getBoundingClientRect();
  if (!spot || !box || !outer) return null;
  const span = to - from;
  const x = box.left - outer.left + ((spot.t - from) / span) * box.width;
  const live = Boolean(at && !dragging);
  const mine = spot.owner === self;
  return (
    <>
      <i className={`lncur ${live ? "on" : ""}`} style={{ left: x }} />
      {mine && (
        <div className={`lntip ${live ? "on" : ""} ${x > outer.width - 330 ? "flip" : ""}`} style={{ left: x }}>
          <b>{axisLabel(spot.t, Math.min(span, 86_400_000))}</b>
          {lanes.map((lane) => {
            const point = nearest(lane.data, spot.t);
            const keys = lane.keys ?? VOLUME;
            const shown = keys.filter((key) => point && point[key.key] !== undefined && (lane.kind === "line" || Number(point[key.key]) > 0));
            const format = lane.format ?? compact;
            return (
              <span key={lane.id}>
                <em>{lane.label}</em>
                <span className="lntv">{shown.length ? shown.map((key) => <span key={key.key}>{shown.length > 1 && <small>{key.label} </small>}{format(Number(point![key.key]))}</span>) : "0"}</span>
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * The page's one clock: every measure on the same time axis with one cursor, each on its own scale,
 * so what happened together lines up. Drag across it to zoom, click a moment to ask what ran.
 */
export function Lanes({ lanes, from, to, height = 56, columns, onPick, wholeRow }: { lanes: Lane[]; from: number; to: number; height?: number; columns?: string[]; onPick?: (t: number) => void; wholeRow?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const clock = useClockStore();
  const self = useRef({}).current;
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const pressed = useRef<string | null>(null);
  const open = (lane: Lane) => {
    if (lane.to) void navigate({ to: lane.to, search: ((prev: Record<string, unknown>) => ({ ...prev, ...lane.search })) as never });
  };
  const span = to - from;
  const measure = (clientX: number) => {
    const lane = root.current?.querySelector<HTMLElement>(".lane");
    if (!lane || !root.current) return null;
    const box = lane.getBoundingClientRect();
    const ratio = (clientX - box.left) / box.width;
    return { ratio, left: box.left - root.current.getBoundingClientRect().left, width: box.width };
  };
  const present = lanes.filter(Boolean);
  return (
    <div
      className="lns"
      ref={root}
      onPointerLeave={() => {
        if (clock.get()?.owner === self) clock.set(null);
      }}
      onPointerMove={(event) => {
        const box = measure(event.clientX);
        if (!box) return;
        if (drag) setDrag({ ...drag, end: Math.max(0, Math.min(1, box.ratio)) });
        clock.set(box.ratio < 0 || box.ratio > 1 ? null : { t: from + box.ratio * span, owner: self });
      }}
      onPointerUp={() => {
        if (!drag) return;
        const low = Math.min(drag.start, drag.end);
        const high = Math.max(drag.start, drag.end);
        setDrag(null);
        if (high - low > 0.01) void navigate({ to: ".", search: ((prev: Record<string, unknown>) => ({ ...prev, from: Math.round(from + span * low), to: Math.round(from + span * high), range: undefined })) as never });
        else if (wholeRow && pressed.current) {
          const lane = present.find((item) => item.id === pressed.current);
          if (lane) open(lane);
        } else if (onPick) onPick(Math.round(from + span * low));
      }}
    >
      <div className="lnr lnh">
        <span />
        <TimeAxis from={from} to={to} />
        <div className="lnf">{columns?.map((column, i) => <span key={column} className="lnc" style={{ gridColumn: 3 - columns.length + i + 1 }}>{column}</span>)}</div>
      </div>
      {present.map((lane) => {
        const name = (
          <>
            {lane.icon && <Icon name={lane.icon} />}
            <span className="lnt">
              <span className="nm">{lane.label}</span>
              {lane.sub && <span className="sm">{lane.sub}</span>}
            </span>
          </>
        );
        return (
          <div
            className={`lnr ${wholeRow && lane.to ? "lnr-click" : ""}`}
            key={lane.id}
            tabIndex={wholeRow && lane.to ? 0 : undefined}
            onClick={wholeRow && lane.to ? (event) => { if (!(event.target as HTMLElement).closest(".lane, a, button")) open(lane); } : undefined}
            onKeyDown={wholeRow && lane.to ? (event) => { if (event.key === "Enter") open(lane); } : undefined}
          >
            {lane.to ? <DataLink className="lnn" to={lane.to} search={lane.search}>{name}</DataLink> : <div className="lnn">{name}</div>}
            <div
              className={`lane ${onPick ? "pick" : ""}`}
              onPointerDown={(event) => {
                const box = measure(event.clientX);
                if (!box) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                pressed.current = lane.id;
                setDrag({ start: box.ratio, end: box.ratio });
              }}
            >
              {lane.kind === "line" && lane.data.length > 1
                ? <Lines data={lane.data} keys={lane.keys ?? AVG_P95_KEYS} height={height} label={String(lane.label)} format={lane.format} threshold={lane.threshold} area={(lane.keys ?? AVG_P95_KEYS).length === 1} quiet from={from} to={to} />
                : <Bars data={lane.kind === "line" ? placed(lane.data, from, to) : lane.data} series={lane.kind === "line" ? (lane.keys ?? AVG_P95_KEYS).slice(-1) : lane.keys} height={height} label={String(lane.label)} compactMode />}
            </div>
            <div className="lnf">
              {lane.figures?.map((figure, i, all) => (
                <span key={i} className="lnv" style={{ gridColumn: 3 - all.length + i + 1 }}>
                  <b className={figure.tone ?? ""}><span className="numin" key={String(figure.value)}>{figure.value}</span></b>
                  {(figure.label ?? columns?.[i]) && <small className={figure.label ? "" : "lnphone"}>{figure.color && <i style={{ background: figure.color }} />}{figure.label ?? columns?.[i]}</small>}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {drag && Math.abs(drag.end - drag.start) > 0 && (() => {
        const box = root.current?.querySelector<HTMLElement>(".lane");
        if (!box || !root.current) return null;
        const left = box.getBoundingClientRect().left - root.current.getBoundingClientRect().left;
        const width = box.getBoundingClientRect().width;
        return <i className="lnsel" style={{ left: left + Math.min(drag.start, drag.end) * width, width: Math.abs(drag.end - drag.start) * width }} />;
      })()}
      <Cursor store={clock} self={self} root={root} lanes={present} from={from} to={to} dragging={Boolean(drag)} />
    </div>
  );
}
