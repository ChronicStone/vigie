import { stripAppPrefix } from "./app-name.ts";
const pad = (n: number) => String(n).padStart(2, "0");
export const hms = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const hm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayMonth = (t: number) => {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
export const axisLabel = (t: number, span: number) => (span > 2 * 86_400_000 ? dayMonth(t) : hm(t));
export const fms = (m: number | null | undefined) => {
  const v = Number(m ?? 0);
  if (v >= 60_000) return `${(v / 60_000).toFixed(v >= 600_000 ? 0 : 1)} min`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 1 : 2)} s`;
  if (v > 0 && v < 1) return `${v.toFixed(1)} ms`;
  return `${Math.round(v)} ms`;
};
export const num = (n: number | null | undefined) => Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 1 });
export const compact = (n: number | null | undefined) => {
  const v = Number(n ?? 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
};
export const pct = (n: number | null | undefined, digits = 2) => `${Number(n ?? 0).toFixed(digits)}%`;
export const bytes = (n: number | null | undefined) => {
  let v = Number(n ?? 0);
  for (const unit of ["B", "kB", "MB", "GB", "TB"]) {
    if (v < 1024) return `${v >= 100 || unit === "B" ? Math.round(v) : v.toFixed(1)} ${unit}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} PB`;
};
export const ago = (t: number | null | undefined) => {
  if (!t) return "Never";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86_400) return "Yesterday";
  return dayMonth(t);
};
export const inFuture = (t: number | null | undefined) => {
  if (!t) return "";
  const s = (t - Date.now()) / 1000;
  if (s <= 5) return "now";
  if (s < 60) return `in ${Math.round(s)} s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  return `in ${h} h ${Math.round((s - h * 3600) / 60)} min`;
};
export const span = (ms: number) => {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s - h * 3600) / 60);
  if (h >= 48) return `${Math.round(h / 24)} d`;
  return m ? `${h} h ${m} min` : `${h} h`;
};
export const statusClass = (s: number) => (s >= 500 ? "err" : s >= 400 ? "warn" : "st-ok");
export const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]!.toUpperCase())
    .join("");
export const shortService = (s: string) => stripAppPrefix(s);
