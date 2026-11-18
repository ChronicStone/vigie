import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { config } from "./config.ts";
import { actorOf, auth, usersExist, inviteFor } from "./auth.ts";
import { registry } from "./extensions/index.ts";
import { handleMcp } from "./mcp.ts";
import { handleIngest } from "./ingest/routes.ts";
import { pipelineHealth } from "./ingest/pipeline.ts";
import { pollLink, startLink } from "./state/links.ts";
import { ping, query } from "./lib/clickhouse.ts";
import { db } from "./state/db.ts";
import { dispatch, type Actor } from "./api/http.ts";
import { pageList } from "./api/dashboards.ts";
export { globalSearch } from "./search.ts";
import "./api/logs.ts";
import "./api/reliability.ts";
import "./ai.ts";
import { appDb, loadPeople, personName } from "./lib/appdb.ts";

const csp = (nonce: string) => `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;

const SECURITY = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": csp(""),
  ...(config.publicUrl.startsWith("https://") ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
};

function secure(response: Response) {
  for (const [key, value] of Object.entries(SECURITY)) response.headers.set(key, value);
  const nonce = response.headers.get("x-vigie-csp-nonce");
  if (nonce) {
    response.headers.set("content-security-policy", csp(nonce));
    response.headers.delete("x-vigie-csp-nonce");
  }
  return response;
}

let startHandler: { fetch: (request: Request) => Response | Promise<Response> } | null = null;
async function start() {
  if (!startHandler) startHandler = (await import(config.startEntry)).default;
  return startHandler!;
}

/** Start streams small inline scripts into its HTML. A per-response nonce allows exactly those and nothing injected later. */
function withNonce(response: Response) {
  if (!response.headers.get("content-type")?.includes("text/html")) return response;
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const rewritten = new HTMLRewriter().on("script", { element: (el) => void el.setAttribute("nonce", nonce) }).transform(response);
  rewritten.headers.set("x-vigie-csp-nonce", nonce);
  return rewritten;
}

async function serveStatic(pathname: string, request: Request) {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const path = join(config.webDir, safe);
  if (!path.startsWith(config.webDir)) return new Response("Not found", { status: 404 });
  const isAsset = safe.startsWith("/assets/");
  if (safe.startsWith("/_serverFn")) return (await start()).fetch(request);
  if (!existsSync(path) || statSync(path).isDirectory()) {
    if (isAsset) return new Response("Not found", { status: 404 });
    const shell = join(config.webDir, "_shell.html");
    if (!existsSync(shell)) return new Response("The web app is not built. Run: bun run build", { status: 503 });
    return withNonce(new Response(Bun.file(shell), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } }));
  }
  const cache = isAsset ? "public, max-age=31536000, immutable" : "no-cache";
  const accepts = request.headers.get("accept-encoding") ?? "";
  const file = Bun.file(path);
  if (accepts.includes("gzip") && /\.(js|css|html|svg|json)$/.test(path)) {
    const gz = Bun.file(`${path}.gz`);
    if (await gz.exists()) return new Response(gz, { headers: { "content-type": file.type, "content-encoding": "gzip", "cache-control": cache, vary: "accept-encoding" } });
  }
  return new Response(file, { headers: { "cache-control": cache } });
}

export async function shell(input: { env: string }, actor: Actor) {
  const { env } = input;
  const [services, environments, failing] = await Promise.all([
    query<{ name: string }>("SELECT DISTINCT ServiceName AS name FROM logs WHERE Timestamp >= now() - INTERVAL 7 DAY ORDER BY name"),
    query<{ name: string }>("SELECT DISTINCT Environment AS name FROM logs WHERE Timestamp >= now() - INTERVAL 7 DAY"),
    query<{ n: number }>("SELECT count() AS n FROM (SELECT TaskKind, sumIf(Attempts, Outcome = 'failed') / greatest(sum(Attempts), 1) AS r FROM task_1m WHERE Minute >= now() - INTERVAL 1 DAY AND Environment = {env:String} GROUP BY TaskKind HAVING r >= 0.05)", { params: { env } }),
  ]);
  await loadPeople();
  const count = (sql: string, ...args: string[]) => db.query<{ n: number }, string[]>(sql).get(...args)?.n ?? 0;
  const ingest = pipelineHealth();
  return {
    me: { id: actor.id, name: personName(actor.id) || actor.name, role: actor.role },
    mode: config.mode,
    services: services.map((s) => s.name),
    environments: environments.map((e) => e.name),
    badges: { issues: count("SELECT count(*) AS n FROM issues WHERE status = 'open' AND environment = ?", env), alerts: count("SELECT count(*) AS n FROM alerts WHERE state = 'firing' AND paused = 0"), inbox: count("SELECT count(*) AS n FROM inbox WHERE read_at IS NULL"), tasks: failing[0]?.n ?? 0 },
    pages: pageList(),
    ingest: { lastEventAt: ingest.lastEventAt, flushErrors: ingest.flushErrors, spooled: ingest.spooled, lastError: ingest.lastError },
    ai: Boolean(config.ai.apiKey),
    appDb: Boolean(appDb()),
  };
}

export const savedViews = (scope: string) => [
  ...registry.views.filter((view) => view.scope === scope).map((view) => ({ id: `code:${view.id}`, name: view.name, scope: view.scope, filter: view.filter })),
  ...db.query<{ id: string; name: string; scope: string; filter: string }, [string]>("SELECT * FROM saved_views WHERE scope = ? ORDER BY name").all(scope),
];
export function addSavedView(input: { name: string; scope: string; filter: string }) {
  const id = crypto.randomUUID();
  db.query("INSERT INTO saved_views (id, name, scope, filter) VALUES (?, ?, ?, ?)").run(id, input.name, input.scope, input.filter);
  return { id };
}

export async function handleApp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/health") {
    const clickhouse = await ping();
    return Response.json({ ok: clickhouse, clickhouse, ingest: pipelineHealth(), mode: config.mode }, { status: clickhouse ? 200 : 503 });
  }
  if (pathname === "/mcp") return secure(await handleMcp(request));
  // Behind one domain, exporters reach ingest at /otlp. No second port to expose.
  if (pathname.startsWith("/otlp/v1/")) {
    const target = new URL(request.url);
    target.pathname = pathname.slice("/otlp".length);
    return (await handleIngest(new Request(target, request))) ?? new Response("Not found", { status: 404 });
  }
  if (pathname.startsWith("/api/auth/")) return secure(await auth.handler(request));
  if (pathname === "/api/invite") {
    const invite = inviteFor(url.searchParams.get("token") ?? "");
    return secure(invite ? Response.json({ email: invite.email }) : Response.json({ message: "This invitation has expired or was already used." }, { status: 404 }));
  }
  // The installer in an app asks to be linked, then polls. Both run before sign-in by design: the code is only good once someone signed in allows it.
  if (pathname === "/api/link" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { service?: string };
    try {
      const link = startLink(String(body.service ?? "app"));
      return secure(Response.json({ ...link, url: `${config.publicUrl.replace(/\/$/, "")}/link?code=${link.code}` }));
    } catch (error) {
      return secure(Response.json({ error: (error as Error).message }, { status: 429 }));
    }
  }
  if (pathname.startsWith("/api/link/") && request.method === "GET") return secure(Response.json(pollLink(pathname.slice("/api/link/".length))));
  if (pathname === "/api/session") {
    const actor = await actorOf(request);
    return secure(Response.json({ actor, mode: config.mode, environments: config.environments, needsSetup: config.mode === "server" && !usersExist(), oidc: Boolean(config.auth.oidcIssuer), oidcName: config.auth.oidcName, appName: config.appName, allowSignup: config.auth.allowSignup }));
  }
  // Cookies travel on cross-site requests, so anything that changes state must come from our own origin.
  if (request.method !== "GET" && config.mode === "server") {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(config.publicUrl).origin) return secure(Response.json({ error: "Wrong origin." }, { status: 403 }));
  }
  if (pathname.startsWith("/api/")) {
    const actor = await actorOf(request);
    if (!actor) return secure(Response.json({ error: "Sign in first." }, { status: 401 }));
    return secure(await dispatch(request, url, actor));
  }
  return secure(await serveStatic(pathname, request));
}
