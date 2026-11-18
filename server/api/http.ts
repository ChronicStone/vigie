import type { Role } from "../auth.ts";

export type Actor = { id: string; name: string; role: Role; through: "app" | "mcp" | "api" };

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
export const hasRole = (actor: Actor, role: Role) => RANK[actor.role] >= RANK[role];

/** Its message starts with the status, so the status survives the trip through a server function. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`${status}|${message}`);
  }
  get text() {
    return this.message.slice(4);
  }
}

/** The few raw HTTP routes: streams, and what machines call with a token. Everything the app reads goes through typed server functions. */
type Ctx = { request: Request; url: URL; actor: Actor };
type Route = { method: string; path: string; role: Role; handler: (ctx: Ctx) => unknown | Promise<unknown> };
const routes: Route[] = [];
export const route = (method: "GET" | "POST", path: string, role: Role, handler: Route["handler"]) => void routes.push({ method, path, role, handler });

export async function dispatch(request: Request, url: URL, actor: Actor): Promise<Response> {
  const found = routes.find((r) => r.method === request.method && r.path === url.pathname);
  if (!found) return Response.json({ error: "No such route" }, { status: 404 });
  if (!hasRole(actor, found.role)) return Response.json({ error: `This needs the ${found.role} role.` }, { status: 403 });
  try {
    const result = await found.handler({ request, url, actor });
    return result instanceof Response ? result : Response.json(result ?? { ok: true });
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.text }, { status: error.status });
    console.error(`${request.method} ${url.pathname}:`, error);
    return Response.json({ error: "Something failed on the server." }, { status: 500 });
  }
}

/** The time and environment every screen shares. */
export type ScopeInput = { env: string; from: number; to: number; services?: string };
export type Scope = { from: number; to: number; env: string; services: string[]; bucket: number };

const BUCKETS = [10, 30, 60, 300, 600, 1800, 3600, 10800, 21600, 86400];

export function scopeOf(input: ScopeInput, points = 72): Scope {
  const seconds = Math.max(1, (input.to - input.from) / 1000 / points);
  const bucket = BUCKETS.find((b) => b >= seconds) ?? 86400;
  return { from: input.from, to: input.to, env: input.env, services: (input.services ?? "").split(",").filter(Boolean), bucket };
}

export const dt = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace("T", " ");

export function scopeParams(scope: Scope) {
  return { from: dt(scope.from), to: dt(scope.to), env: scope.env, services: scope.services.length ? scope.services : undefined, bucket: scope.bucket };
}

/** The WHERE clause shared by every read of logs or spans. */
export function where(scope: Scope, time = "Timestamp") {
  const parts = [`${time} >= toDateTime64({from:String}, 3)`, `${time} <= toDateTime64({to:String}, 3)`, "Environment = {env:String}"];
  if (scope.services.length) parts.push("ServiceName IN {services:Array(String)}");
  return parts.join(" AND ");
}

export const bucketOf = (column: string) => `toUnixTimestamp(toStartOfInterval(${column}, toIntervalSecond({bucket:UInt32}))) * 1000`;
/** Every bucket of a window, so a row's trend has one slot per moment instead of one per moment it was busy. */
export function bucketTimes(scope: Scope) {
  const step = scope.bucket * 1000;
  const times: number[] = [];
  for (let t = Math.floor(scope.from / step) * step; t <= scope.to; t += step) times.push(t);
  return times;
}

/** Empty time buckets become zeros, so a quiet minute reads as quiet instead of disappearing. */
export const fillTime = `ORDER BY t WITH FILL FROM toUnixTimestamp(toStartOfInterval(toDateTime64({from:String}, 3), toIntervalSecond({bucket:UInt32}))) * 1000 TO toUnixTimestamp(toDateTime64({to:String}, 3)) * 1000 STEP {bucket:UInt32} * 1000`;
