import { useEffect, useRef } from "react";
import { fms, span } from "@web/lib/format.ts";

/** Time added up over many runs: an hour reads as an hour, not as 60.0 min. */
export const timeSpent = (ms: number) => (ms >= 3_600_000 ? span(ms) : fms(ms));

/** A percentage that stays honest at both ends: 0.3% stays 0.3%, 99.96% never rounds up to 100%. */
export const share = (part: number, whole: number) => {
  if (!whole) return "0%";
  const value = (part / whole) * 100;
  if (value >= 99.95 && part < whole) return "99.9%";
  return value >= 10 || Number.isInteger(value) ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
};

/** "+12%" against the window before. Nothing when there was nothing before, or when it barely moved. */
export const change = (now: number, before: number) => {
  if (!before || !now) return "";
  const value = Math.round(((now - before) / before) * 100);
  if (Math.abs(value) < 3) return "";
  return `${value > 0 ? "+" : ""}${value}%`;
};

/** The list keys every page shares: / focuses the search, Esc clears it, j and k walk the rows, Enter opens. */
export function useListKeys(searchId?: string, onClear?: () => void) {
  const clear = useRef(onClear);
  clear.current = onClear;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = Boolean(target.closest("input,textarea,select,[contenteditable=true]"));
      if (event.key === "Escape" && typing && searchId && target.id === searchId) {
        clear.current?.();
        target.blur();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/" && searchId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        document.getElementById(searchId)?.focus();
        return;
      }
      if (event.key !== "j" && event.key !== "k") return;
      const rows = [...document.querySelectorAll<HTMLElement>(".main tr.click, .main a.lst, .main [data-row]")];
      if (!rows.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const at = rows.indexOf(target.closest<HTMLElement>("tr.click, a.lst, [data-row]") as HTMLElement);
      const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (event.key === "j" ? 1 : -1)))];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [searchId]);
}

/** Text search and a filter that found nothing: the same offer everywhere. */
export function NoMatch({ what, onClear }: { what: string; onClear: () => void }) {
  return (
    <div className="ph" style={{ padding: "48px 20px" }}>
      <div>
        <h3>No {what} matches</h3>
        <button className="btn" style={{ marginTop: 12 }} onClick={onClear}>Clear the filter</button>
      </div>
    </div>
  );
}
