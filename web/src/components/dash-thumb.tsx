import type { Widget as Full } from "@sdk";
import { showValue, useWidgetData } from "./widget.tsx";

/**
 * A drawing of a real dashboard: each widget at its real place, under its real title.
 * Numbers are live, since a stat is cheap and the board's page reuses the answer. Chart shapes are drawn, not data.
 */
type Widget = { title?: string; span?: number; height?: number; type: string; sql?: string; format?: Full["format"]; tone?: Full["tone"]; unit?: string };

const seedOf = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
const wave = (seed: number, count: number) => {
  let value = seed;
  return Array.from({ length: count }, () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return 0.18 + (value % 1000) / 1220;
  });
};
const BAD = /error|fail|exception|refus|denied/i;

function ThumbStat({ widget }: { widget: Widget }) {
  const q = useWidgetData(widget.sql ?? "", Boolean(widget.sql));
  const value = Number(Object.values((q.data?.rows ?? [])[0] ?? {})[0] ?? 0);
  const tone = widget.tone === "error" && value ? "err" : widget.tone === "warn" && value ? "warn" : "";
  return <b className={`home-thumb-v ${tone}`}>{q.data ? <>{showValue(value, widget)}{widget.unit && <small>{widget.unit}</small>}</> : <i className="home-thumb-bar" />}</b>;
}

function Shape({ widget }: { widget: Widget }) {
  const seed = seedOf(widget.title ?? widget.type);
  const stroke = BAD.test(widget.title ?? "") ? "var(--err)" : "var(--a)";
  if (widget.type === "table" || widget.type === "list") {
    return (
      <svg className="home-thumb-g" viewBox="0 0 100 40" preserveAspectRatio="none">
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <rect x={0} y={2 + i * 10} width={widget.type === "list" ? 100 * (0.92 - i * 0.2) : 42 + ((seed >> i) & 15)} height={3.5} rx={1} fill={widget.type === "list" ? stroke : "var(--t4)"} opacity={widget.type === "list" ? 0.55 : 0.8} />
            {widget.type === "table" && <rect x={86} y={2 + i * 10} width={14} height={3.5} rx={1} fill="var(--t4)" opacity={0.8} />}
          </g>
        ))}
      </svg>
    );
  }
  if (widget.type === "pie") {
    const share = 0.35 + (seed % 40) / 100;
    const c = 2 * Math.PI * 15;
    return (
      <svg className="home-thumb-g" viewBox="0 0 100 40">
        <circle cx={50} cy={20} r={15} fill="none" stroke="var(--s3)" strokeWidth={5} />
        <circle cx={50} cy={20} r={15} fill="none" stroke={stroke} strokeWidth={5} strokeDasharray={`${c * share} ${c}`} transform="rotate(-90 50 20)" />
      </svg>
    );
  }
  if (widget.type === "bars" || widget.type === "series" || widget.type === "bar") {
    const values = wave(seed, 28);
    return (
      <svg className="home-thumb-g" viewBox="0 0 100 40" preserveAspectRatio="none">
        {values.map((value, i) => <rect key={i} x={i * (100 / 28)} y={40 - value * 40} width={100 / 28 - 0.8} height={value * 40} fill={stroke} opacity={0.62} />)}
      </svg>
    );
  }
  const points = wave(seed, 14).map((value, i, all) => `${(i / (all.length - 1)) * 100},${40 - value * 36}`);
  return (
    <svg className="home-thumb-g" viewBox="0 0 100 40" preserveAspectRatio="none">
      <polygon points={`0,40 ${points.join(" ")} 100,40`} fill={stroke} opacity={0.1} />
      <polyline points={points.join(" ")} fill="none" stroke={stroke} strokeWidth={1.3} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function DashThumb({ widgets }: { widgets: Widget[] }) {
  if (!widgets.length) return <div className="home-thumb home-thumb-empty">No widget yet</div>;
  return (
    <div className="home-thumb" aria-hidden="true">
      {widgets.slice(0, 8).map((widget, i) => (
        <div key={i} className={`home-thumb-c ${widget.type === "stat" ? "stat" : ""}`} style={{ gridColumn: `span ${Math.min(12, widget.span ?? 6)}` }}>
          <span className="home-thumb-t ell">{widget.title}</span>
          {widget.type === "stat" ? <ThumbStat widget={widget} /> : <Shape widget={widget} />}
        </div>
      ))}
    </div>
  );
}
