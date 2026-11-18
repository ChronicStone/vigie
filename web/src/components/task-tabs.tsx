import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { taskActionsInfoFn } from "@web/fns/tasks.ts";
import { useFn } from "@web/lib/api.ts";
import { Glide } from "./motion.tsx";

export function TaskTabs({ right }: { right?: ReactNode }) {
  const path = useLocation({ select: (l) => l.pathname });
  // Bulk actions need the app connected. Without it the tab leads nowhere, so it stays off.
  const info = useFn(taskActionsInfoFn, undefined);
  return (
    <div className="ptabs" style={{ padding: "0 20px", flex: "none", borderBottom: "1px solid var(--line)" }}>
      <Glide on={path} line />
      <Link className={`ptab ${path === "/tasks" ? "on" : ""}`} to="/tasks" search={scopeOnly}>Health</Link>
      <Link className={`ptab ${path === "/tasks/all" ? "on" : ""}`} to="/tasks/all" search={scopeOnly}>All tasks</Link>
      {info.data?.enabled && <Link className={`ptab ${path === "/tasks/bulk" ? "on" : ""}`} to="/tasks/bulk" search={scopeOnly}>Bulk actions</Link>}
      {right && <div className="tasks-tabs-right">{right}</div>}
    </div>
  );
}

/** Moving between tabs keeps the time window and drops the other tab's filters. */
const scopeOnly = (prev: Record<string, unknown>) => Object.fromEntries(Object.entries(prev).filter(([key]) => ["range", "from", "to", "env", "service"].includes(key))) as never;

export const KIND_STATE = { failed: ["Failing", "err"], retrying: ["Retrying", "warn"], running: ["Running", "lnk"], ok: ["Healthy", "ok"], held: ["Held", "t3"], idle: ["No runs", "t3"] } as const;

/** Phone tables carry fewer columns rather than scrolling sideways. */
export function usePhone() {
  return useSyncExternalStore(
    (notify) => {
      const query = matchMedia("(max-width: 760px)");
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => matchMedia("(max-width: 760px)").matches,
    () => false,
  );
}

/** Reason codes read as words, and the code stays one hover away for searching. */
export const inWords = (code: string) => {
  const text = code.toLowerCase().replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * The list keys every task page shares: `/` focuses the search, Esc clears it, j and k walk the rows,
 * Enter opens the focused row through the row's own handler.
 */
export function useListKeys({ search, rows, onClear }: { search?: string; rows: string; onClear?: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      const typing = Boolean(target.closest("input, textarea, [contenteditable]"));
      if (event.key === "Escape" && typing && search && target.id === search) {
        onClear?.();
        target.blur();
        return;
      }
      if (typing || document.querySelector(".dlg, .pop")) return;
      if (event.key === "/" && search) {
        event.preventDefault();
        document.getElementById(search)?.focus();
        return;
      }
      if (event.key !== "j" && event.key !== "k") return;
      const list = [...document.querySelectorAll<HTMLElement>(rows)];
      if (!list.length) return;
      event.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = list[at < 0 ? 0 : Math.max(0, Math.min(list.length - 1, at + (event.key === "j" ? 1 : -1)))]!;
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search, rows, onClear]);
}
