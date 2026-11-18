import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";

export const RANGES = { "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;
export type Range = keyof typeof RANGES;
const ENVS = ["PRD", "STG", "DEV"] as const;
export type Env = (typeof ENVS)[number];
/** Stored rows keep these codes. People read the names. */
export const ENV_LABEL: Record<Env, string> = { PRD: "Prod", STG: "Test", DEV: "Local" };

/** What this Vigie runs with: Prod and Test on a server, one Local on a machine. Known before the first screen. */
let known: Env[] = ["PRD", "STG"];
export const environments = () => known;
export function setEnvironments(list: string[]) {
  const next = list.filter((env): env is Env => (ENVS as readonly string[]).includes(env));
  if (next.length) known = next;
}

/** The global scope lives in the URL, so any link opens the same view. */
export const rootSearch = z.object({
  env: z.enum(ENVS).optional().catch(undefined),
  range: z.enum(["15m", "1h", "6h", "24h", "7d", "30d"]).optional().catch(undefined),
  from: z.number().optional().catch(undefined),
  to: z.number().optional().catch(undefined),
  svc: z.string().optional().catch(undefined),
  live: z.boolean().optional().catch(undefined),
});
export type RootSearch = z.infer<typeof rootSearch>;

const STORED = "vigie.range";
function storedRange(): Range | null {
  try {
    const value = localStorage.getItem(STORED);
    return value && value in RANGES ? (value as Range) : null;
  } catch {
    return null;
  }
}
export function rememberRange(range: Range) {
  try {
    localStorage.setItem(STORED, range);
  } catch {}
}

/** "now" moves in steps, so query keys stay stable between renders and cached answers are reused. */
function useNow(live: boolean) {
  const step = live ? 5000 : 15_000;
  const [now, setNow] = useState(() => Math.floor(Date.now() / step) * step);
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / step) * step), step);
    return () => clearInterval(timer);
  }, [step]);
  return now;
}

export function useScope() {
  const search = useSearch({ strict: false }) as RootSearch;
  const live = Boolean(search.live);
  const now = useNow(live);
  const range = search.range ?? storedRange() ?? "1h";
  const custom = Boolean(search.from && search.to);
  const to = custom ? search.to! : now;
  const from = custom ? search.from! : now - RANGES[range];
  const env = search.env && known.includes(search.env) ? search.env : known[0]!;
  const services = search.svc ?? "";
  const params = useMemo(() => ({ env, from, to, services: services || undefined }), [env, from, to, services]);
  return { env, range: custom ? ("custom" as const) : range, from, to, custom, live, services, params };
}

export function useSetScope() {
  const navigate = useNavigate();
  return useCallback(
    (patch: RootSearch) => {
      void navigate({ to: ".", replace: true, search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) } as never);
    },
    [navigate],
  );
}
