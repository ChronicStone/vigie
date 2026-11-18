import { memo, useRef, useState, type KeyboardEvent, type CSSProperties } from "react";
import { fadeIn } from "./motion.tsx";
import { prettySql, tokensOf, type Lang } from "@web/lib/highlight.ts";

/** Coloured text, inline. Rendered as React text so whatever telemetry carries can never become markup. */
export const Hl = memo(function Hl({ children, lang = "log" }: { children: string; lang?: Lang }) {
  return (
    <span>
      {tokensOf(children, lang).map((token, i) => (token.className ? <span key={i} className={`hl-${token.className}`}>{token.value}</span> : token.value))}
    </span>
  );
});

const CLAMP = 12;

/** A block of code. Long blocks fold, so one giant statement never takes over the page. */
export function Code({ text, lang = "sql", style, className, pretty, fold }: { text: string; lang?: Lang; style?: CSSProperties; className?: string; pretty?: boolean; fold?: boolean }) {
  const [open, setOpen] = useState(false);
  const block = useRef<HTMLPreElement>(null);
  const shown = pretty && lang === "sql" ? prettySql(text) : text;
  const long = Boolean(fold) && (shown.split("\n").length > CLAMP || shown.length > 900);
  return (
    <div className={`code ${long && !open ? "shut" : ""} ${className ?? ""}`} style={style}>
      <pre ref={block}><Hl lang={lang}>{shown}</Hl></pre>
      {long && <button className="tlink codem" onClick={() => { setOpen(!open); fadeIn(block.current, { opacity: 0.35 }, 240); }}>{open ? "Show less" : "Show all"}</button>}
    </div>
  );
}

/** A value as readable JSON. Text that is not JSON is shown as it is. */
export function Json({ value, style, fold }: { value: unknown; style?: CSSProperties; fold?: boolean }) {
  let text: string;
  if (typeof value === "string") {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      text = value;
    }
  } else text = JSON.stringify(value, null, 2) ?? "";
  return <Code text={text} lang="json" style={style} fold={fold} />;
}

/** A plain textarea over the same text in colour: caret, selection, undo and paste stay the browser's. */
export function CodeEditor({ value, onChange, lang = "sql", rows = 8, label, readOnly, onKeyDown }: { value: string; onChange?: (value: string) => void; lang?: Lang; rows?: number; label: string; readOnly?: boolean; onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void }) {
  const under = useRef<HTMLPreElement>(null);
  return (
    <div className="hled">
      <pre ref={under} aria-hidden="true"><Hl lang={lang}>{`${value}\n`}</Hl></pre>
      <textarea
        className="editor"
        aria-label={label}
        spellCheck={false}
        rows={rows}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          if (under.current) {
            under.current.scrollTop = event.currentTarget.scrollTop;
            under.current.scrollLeft = event.currentTarget.scrollLeft;
          }
        }}
      />
    </div>
  );
}
