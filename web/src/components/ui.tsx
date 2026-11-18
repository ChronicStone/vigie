import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { Tooltip } from "@base-ui/react/tooltip";
import { Link, useRouter } from "@tanstack/react-router";
import { errorStatus, errorText } from "@web/lib/api.ts";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { fms, initials, statusClass } from "@web/lib/format.ts";
import { Icon } from "./icons.tsx";
import { fadeIn, Glide } from "./motion.tsx";
import { toast } from "./toast.tsx";
import { Code } from "./code.tsx";
import type { Lang } from "@web/lib/highlight.ts";

export function Method({ m }: { m: string }) {
  return <span className={`mth m-${m.toLowerCase()}`}>{m}</span>;
}
export function Method2({ m }: { m: string }) {
  return <span className={`mth2 m-${m.toLowerCase()}`}>{m}</span>;
}
/** `:id` in a route reads as a parameter. */
export function RoutePath({ path }: { path: string }) {
  const parts = path.split(/(:[a-zA-Z_]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith(":") ? (
          <span className="prm" key={i}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
/** "POST /v1/x" or "task foo.bar", with functional colour. */
export function Entry({ text }: { text: string }) {
  const match = text.match(/^(GET|POST|PATCH|PUT|DELETE|task)\s+(.*)$/);
  if (!match) return <span>{text}</span>;
  return (
    <>
      <span className={`m-${match[1]!.toLowerCase()}`}>{match[1]}</span> <RoutePath path={match[2]!} />
    </>
  );
}

export function Status({ code }: { code: number }) {
  if (!code) return null;
  return <span className={statusClass(code)}>{code}</span>;
}

const CHIP: Record<string, [string, string]> = {
  DONE: ["Done", "ok"],
  FAILED: ["Failed", "err"],
  RUNNING: ["Running", "lnk"],
  QUEUED: ["Due", "t2"],
  SCHEDULED: ["Scheduled", "t3"],
  HELD: ["Held", "warn"],
  WAITING: ["Waiting", "warn"],
  CANCELLED: ["Cancelled", "t3"],
  SKIPPED: ["Skipped", "t3"],
};
export function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className={`schip ${tone}`}>
      <i />
      {children}
    </span>
  );
}
export function TaskChip({ state }: { state: string }) {
  const [label, tone] = CHIP[state] ?? [state, "t3"];
  return <Chip tone={tone}>{label}</Chip>;
}

/** A long id: short on screen, whole on hover, copied on click. */
export function Id({ value, keep = 8, className }: { value: string; keep?: number; className?: string }) {
  if (!value) return null;
  return (
    <button
      type="button"
      className={`idt ${className ?? ""}`}
      title={`${value}, click to copy`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        copy(value, "Id copied");
      }}
    >
      {value.length > keep + 1 ? `${value.slice(0, keep)}…` : value}
    </button>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const HEX = /^[0-9a-f]{16,}$/i;
export const looksLikeId = (text: string) => UUID.test(text) || HEX.test(text);

/** A task's subject: "assessment 01a1a61f…", "webhook 39172…", or a plain key. */
export function Subject({ value }: { value: string }) {
  const clean = value.replace(":", " ");
  const parts = clean.split(" ");
  const last = parts[parts.length - 1] ?? "";
  if (looksLikeId(last)) return <>{parts.slice(0, -1).join(" ")}{parts.length > 1 ? " " : ""}<Id value={last} /></>;
  return <>{clean}</>;
}

export function Avatar({ name, size }: { name: string; size?: number }) {
  return (
    <span className="ava" style={size ? { width: size, height: size, fontSize: size * 0.43 } : undefined}>
      {initials(name)}
    </span>
  );
}

export function Stat({ label, value, unit, note, tone }: { label: string; value: ReactNode; unit?: string; note?: string; tone?: string }) {
  return (
    <div className="met">
      <div className="l">
        <span>{label}</span>
        {note && <span className="t4">{note}</span>}
      </div>
      <div className={`v ${tone ?? ""}`}>
        <span className="numin" key={String(value)}>
          {value}
        </span>
        {unit && <small>{unit}</small>}
      </div>
    </div>
  );
}
export function StatBand({ children, columns }: { children: ReactNode; columns: number }) {
  return (
    <div className="mband" style={{ gridTemplateColumns: `repeat(${columns},minmax(0,1fr))` }}>
      {children}
    </div>
  );
}

export function Card({ title, right, children, style, className }: { title?: ReactNode; right?: ReactNode; children?: ReactNode; style?: React.CSSProperties; className?: string }) {
  return (
    <div className={`card ${className ?? ""}`} style={style}>
      {(title || right) && (
        <div className="ch">
          <span>{title}</span>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

/** The header of a detail page: where you came from, what this is, what you can do. Never a big floating title. */
export function Head({ back, backTitle, title, mono, meta, right }: { back?: string; backTitle?: string; title: ReactNode; mono?: boolean; meta?: ReactNode; right?: ReactNode }) {
  return (
    <div className="dh">
      {back && <Back to={back} title={backTitle ?? "Back"} />}
      <h2 className={mono ? "mono" : ""}>{title}</h2>
      {meta}
      {right && <span className="dhr">{right}</span>}
    </div>
  );
}

/** A link whose target arrives as data from the server: extension nav, "needs you" rows, inbox items. Links written in code use the typed Link. */
export function DataLink({ to, search, children, ...rest }: { to: string; search?: Record<string, string>; children: ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <Link to={to as never} search={((prev: Record<string, unknown>) => ({ ...prev, ...search })) as never} {...rest}>
      {children}
    </Link>
  );
}

export function Back({ to, title }: { to?: string; title: string }) {
  const router = useRouter();
  if (!to) {
    return (
      <button className="ib" title={title} aria-label={title} onClick={() => router.history.back()}>
        <Icon name="back" />
      </button>
    );
  }
  return (
    <DataLink className="ib" to={to} title={title} aria-label={title}>
      <Icon name="back" />
    </DataLink>
  );
}

export function Segments<T extends string>({ value, options, onChange, env }: { value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (value: T) => void; env?: boolean }) {
  return (
    <div className={`seg ${env === false ? "" : "env"}`} role="group">
      <Glide on={value} swap />
      {options.map(([key, label]) => (
        <button key={key} className={value === key ? "on" : ""} aria-pressed={value === key} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Levels<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (value: T) => void }) {
  // One choice is not a choice.
  if (options.length < 2) return null;
  return (
    <div className="lvls" role="group">
      <Glide on={value} swap />
      {options.map(([key, label]) => (
        <button key={key} className={value === key ? "on" : ""} aria-pressed={value === key} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange, style }: { value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (value: T) => void; style?: React.CSSProperties }) {
  return (
    <div className="ptabs" style={{ padding: "0 20px", flex: "none", ...style }} role="tablist">
      <Glide on={value} line swap />
      {options.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={value === key} className={`ptab ${value === key ? "on" : ""}`} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder, style, id, autoFocus }: { value: string; onChange: (value: string) => void; placeholder: string; style?: React.CSSProperties; id?: string; autoFocus?: boolean }) {
  return (
    <div className="sb" style={style}>
      <Icon name="search" />
      <input id={id} autoFocus={autoFocus} value={value} placeholder={placeholder} aria-label={placeholder} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Long text reveals on hover. */
export function Hover({ text, children, className, style }: { text: string; children?: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={<span className={`ell ${className ?? ""}`} style={style} />}>{children ?? text}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="tip">{text}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Pop({ trigger, children, align = "start", width = 300, open, onOpenChange }: { trigger: React.ReactElement<any>; children: ReactNode; align?: "start" | "end" | "center"; width?: number; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align={align} style={{ zIndex: 60 }}>
          <Popover.Popup className="pop" style={{ position: "static", width }}>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function Empty({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ph" style={{ padding: "60px 20px" }}>
      <div>
        <h3>{title}</h3>
        {hint && <p>{hint}</p>}
        {children}
      </div>
    </div>
  );
}

export function Failure({ error, retry }: { error: Error; retry?: () => void }) {
  const status = errorStatus(error);
  return (
    <div className="ph" style={{ padding: "60px 20px" }} role="alert">
      <div>
        <h3>{status === 403 ? "You need a higher role" : status === 404 ? "Nothing here" : "This did not load"}</h3>
        <p>{errorText(error)}</p>
        {retry && status !== 403 && status !== 404 && (
          <button className="btn" style={{ marginTop: 12 }} onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

/** Loading looks like the page about to appear, never a spinner on an empty screen. */
export function Skeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="ov" aria-busy="true" aria-label="Loading">
      <div className="skel" style={{ height: 150, margin: "12px 20px" }} />
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel" key={i} style={{ height: 30, margin: "0 20px 6px", opacity: 1 - i * 0.09 }} />
      ))}
    </div>
  );
}

/** Wraps a query: first load shows the skeleton, a failure shows what failed, stale data stays while refreshing. */
export function Load<T>({ q, children, skeleton }: { q: { data?: T; error: Error | null; isPending: boolean; refetch: () => unknown }; children: (data: T) => ReactNode; skeleton?: ReactNode }) {
  const mark = useRef<HTMLSpanElement>(null);
  const waited = useRef(q.data === undefined);
  useLayoutEffect(() => {
    if (q.data === undefined || !waited.current) return;
    waited.current = false;
    for (let next = mark.current?.nextElementSibling; next; next = next.nextElementSibling) fadeIn(next, { opacity: 0, translate: "0 3px" });
  }, [q.data]);
  if (q.data !== undefined) {
    return (
      <>
        <span ref={mark} hidden />
        {children(q.data)}
      </>
    );
  }
  if (q.error) return <Failure error={q.error} retry={() => q.refetch()} />;
  return <>{skeleton ?? <Skeleton />}</>;
}

export function copy(text: string, note = "Copied") {
  void navigator.clipboard?.writeText(text);
  toast(note);
}

export function CopyButton({ text, label = "Copy", note }: { text: string; label?: string; note?: string }) {
  return (
    <button className="btn" onClick={() => copy(text, note)}>
      <Icon name="copy" />
      {label}
    </button>
  );
}

export function Sql({ text, style, lang = "sql", pretty, fold }: { text: string; style?: React.CSSProperties; lang?: Lang; pretty?: boolean; fold?: boolean }) {
  return <Code text={text} lang={lang} style={style} pretty={pretty} fold={fold} />;
}

export function Kv({ k, label, children, tone, onFilter }: { k?: string; label?: string; children: ReactNode; tone?: string; onFilter?: () => void }) {
  return (
    <div className="kvr">
      <span className="k" title={k ?? label}>
        {label ?? k}
      </span>
      <span className={`val ${tone ?? ""}`}>
        {typeof children === "string" || typeof children === "number" ? <span title={String(children)}>{children}</span> : children}
        {onFilter && (
          <button className="fbtn" onClick={onFilter}>
            + filter
          </button>
        )}
      </span>
    </div>
  );
}

export function WhyFix({ why, fix, link, style }: { why?: string; fix?: string; link?: string; style?: React.CSSProperties }) {
  if (!why && !fix) return null;
  return (
    <dl className="why" style={style}>
      {why && (
        <>
          <dt>why</dt>
          <dd className="err">{why}</dd>
        </>
      )}
      {fix && (
        <>
          <dt>fix</dt>
          <dd className="ok">{fix}</dd>
        </>
      )}
      {link && (
        <>
          <dt>link</dt>
          <dd>
            <a className="lnk" href={link} target="_blank" rel="noreferrer">
              {link}
            </a>
          </dd>
        </>
      )}
    </dl>
  );
}

export function SplitBar({ label, value, max, color, right, labelWidth = 96, height = 29 }: { label: ReactNode; value: number; max: number; color: string; right: ReactNode; labelWidth?: number; height?: number }) {
  return (
    <div className="split" style={{ height }}>
      <span className="t2 ell" style={{ width: labelWidth, flex: "none" }}>
        {label}
      </span>
      <span className="dbm" style={{ margin: 0, flex: 1 }}>
        <i style={{ width: `${Math.max(max ? (value / max) * 100 : 0, value ? 0.8 : 0)}%`, background: `${color}` }} />
      </span>
      <span className="mono t3" style={{ flex: "none", minWidth: 28, textAlign: "right" }}>
        {right}
      </span>
    </div>
  );
}

export function Confirm({ trigger, title, children, action, onConfirm, danger }: { trigger: React.ReactElement<any>; title: string; children: ReactNode; action: string; onConfirm: () => void | Promise<unknown>; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={trigger} />
      <Dialog.Portal>
        <Dialog.Backdrop className="dlgback" />
        <Dialog.Popup className="dlg">
          <Dialog.Title className="dlgt">{title}</Dialog.Title>
          <div className="dlgb">{children}</div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            <Dialog.Close className="btn">Cancel</Dialog.Close>
            <button
              className={`btn ${danger ? "danger" : "pri"}`}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } catch (error) {
                  toast(errorText(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {action}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Duration({ ms, http }: { ms: number; http?: boolean }) {
  return <span className={`mono ${http && ms >= 800 ? "warn" : "t2"}`}>{fms(ms)}</span>;
}
