import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "bun";
import { encodeProtobuf } from "../../server/ingest/proto.ts";

/** Boots the real server, in server mode, against a real ClickHouse. Needs CLICKHOUSE_URL and a built web app. */
const CH = process.env.CLICKHOUSE_URL;
const ui = 24310;
const ingest = 24318;
const base = `http://127.0.0.1:${ui}`;
const dataDir = join(tmpdir(), `vigie-it-${process.pid}`);
const database = `vigie_it_${process.pid}`;
let server: ReturnType<typeof Bun.spawn>;
let fakeAi: ReturnType<typeof Bun.serve>;
let fakeIdp: ReturnType<typeof Bun.serve>;
const appCalls: { path: string; authorization: string | null; body: unknown }[] = [];
const aiCalls: any[] = [];

const run = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync(["bun", "cli/vigie.ts", ...args], { env: { ...process.env, ...serverEnv(), ...env } });

function serverEnv() {
  return { VIGIE_ALERT_GROUP_MS: "0", VIGIE_UPTIME: "off", VIGIE_MODE: "server", VIGIE_ENVS: "PRD,STG,DEV", VIGIE_DATA_DIR: dataDir, VIGIE_UI_PORT: String(ui), VIGIE_INGEST_PORT: String(ingest), VIGIE_HOST: "127.0.0.1", VIGIE_PUBLIC_URL: base, CLICKHOUSE_DATABASE: database, BETTER_AUTH_SECRET: "a-test-secret-a-test-secret-a-test", VIGIE_OIDC_ISSUER: `http://127.0.0.1:${fakeIdp.port}`, VIGIE_OIDC_CLIENT_ID: "vigie", VIGIE_OIDC_CLIENT_SECRET: "client-secret", VIGIE_APP_API_URL: `http://127.0.0.1:${fakeIdp.port}`, VIGIE_AI_API_KEY: "test", VIGIE_AI_BASE_URL: `http://127.0.0.1:${fakeAi.port}/v1` };
}

/** An identity provider and the app's task API, in the shapes the real ones answer with. */
function startFakeIdp() {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const issuer = `http://127.0.0.1:${server.port}`;
      const json = (body: unknown) => Response.json(body);
      if (url.pathname === "/.well-known/openid-configuration") return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
      if (url.pathname === "/authorize") return Response.redirect(`${url.searchParams.get("redirect_uri")}?code=the-code&state=${url.searchParams.get("state")}`, 302);
      if (url.pathname === "/token") return json({ access_token: "the-persons-token", token_type: "Bearer", expires_in: 3600, scope: "openid profile email" });
      if (url.pathname === "/userinfo") return json({ sub: "person-1", email: "person@example.test", name: "A Person", email_verified: true });
      if (url.pathname.startsWith("/v1/tasks/")) {
        appCalls.push({ path: url.pathname, authorization: request.headers.get("authorization"), body: await request.json() });
        return json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return server;
}

/** Speaks the OpenAI streaming protocol: first asks for a tool, then answers. */
function startFakeAi() {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      aiCalls.push(body);
      const usedTool = body.messages.some((m: any) => m.role === "tool") || !body.tools?.length;
      const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const parts = usedTool
        ? [chunk({ role: "assistant", content: body.tools?.length ? "Nothing is firing." : "status>=500" }), chunk({}, "stop")]
        : [chunk({ role: "assistant", tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "list_alerts", arguments: "{}" } }] }), chunk({}, "tool_calls")];
      return new Response(`${parts.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

const otlp = (body: string) => ({ resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }, { key: "deployment.environment.name", value: { stringValue: "DEV" } }] }, scopeLogs: [{ logRecords: [{ timeUnixNano: `${Date.now()}000000`, severityText: "INFO", body: { stringValue: body }, attributes: [{ key: "operation", value: { stringValue: "it" } }] }] }] }] });
const rpc = (token: string | null, method: string, params: unknown = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const chQuery = async (sql: string) => (await fetch(`${CH}/?database=${database}`, { method: "POST", headers: { "X-ClickHouse-User": process.env.CLICKHOUSE_USER ?? "default", "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD ?? "" }, body: sql })).text();

let ingestKey = "";

beforeAll(async () => {
  if (!CH) return;
  fakeAi = startFakeAi();
  fakeIdp = startFakeIdp();
  server = Bun.spawn(["bun", "server/index.ts"], { env: { ...process.env, ...serverEnv() }, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) break;
    await Bun.sleep(500);
  }
  ingestKey = run(["token", "--kind", "ingest", "--name", "it"]).stdout.toString().trim();
}, 60_000);

afterAll(async () => {
  if (!CH) return;
  server.kill();
  fakeAi.stop();
  fakeIdp.stop();
  await fetch(`${CH}/`, { method: "POST", headers: { "X-ClickHouse-User": process.env.CLICKHOUSE_USER ?? "default", "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD ?? "" }, body: `DROP DATABASE IF EXISTS ${database} SYNC` });
  rmSync(dataDir, { recursive: true, force: true });
});

test.skipIf(!CH)("ingest: no key is refused", async () => {
  const response = await fetch(`http://127.0.0.1:${ingest}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(otlp("nope")) });
  expect(response.status).toBe(401);
});

test.skipIf(!CH)("ingest: JSON, gzip and protobuf with a key, on the port and under /otlp, all stored", async () => {
  const headers = { authorization: ingestKey };
  const json = await fetch(`http://127.0.0.1:${ingest}/v1/logs`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(otlp("from-json")) });
  expect(json.status).toBe(200);
  const gz = await fetch(`http://127.0.0.1:${ingest}/v1/logs`, { method: "POST", headers: { ...headers, "content-type": "application/json", "content-encoding": "gzip" }, body: gzipSync(Buffer.from(JSON.stringify(otlp("from-gzip")))) as unknown as BodyInit });
  expect(gz.status).toBe(200);
  const pb = await fetch(`http://127.0.0.1:${ingest}/v1/logs`, { method: "POST", headers: { ...headers, "content-type": "application/x-protobuf" }, body: encodeProtobuf("logs", otlp("from-protobuf")) as unknown as BodyInit });
  expect(pb.status).toBe(200);
  expect(pb.headers.get("content-type")).toContain("protobuf");
  const viaApp = await fetch(`${base}/otlp/v1/logs`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(otlp("from-otlp-path")) });
  expect(viaApp.status).toBe(200);
  let stored = "";
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    stored = await chQuery("SELECT arrayStringConcat(arraySort(groupUniqArray(Body)), ',') FROM logs WHERE ServiceName = 'svc'");
    if (stored.includes("from-otlp-path") && stored.includes("from-protobuf")) break;
  }
  expect(stored.trim()).toBe("from-gzip,from-json,from-otlp-path,from-protobuf");
}, 20_000);

test.skipIf(!CH)("app: everything private needs a session", async () => {
  expect((await fetch(`${base}/api/live?env=PRD`)).status).toBe(401);
  const session = await (await fetch(`${base}/api/session`)).json();
  expect(session.actor).toBeNull();
  expect(session.needsSetup).toBe(true);
});

test.skipIf(!CH)("app: server functions refuse an anonymous caller", async () => {
  const html = await (await fetch(`${base}/`)).text();
  expect(html).toContain("<title>Vigie</title>");
  const asset = html.match(/assets\/[\w-]+\.js/)?.[0];
  expect(asset).toBeTruthy();
});

test.skipIf(!CH)("first owner: needs the code from the logs, then sign-up closes", async () => {
  const body = JSON.stringify({ name: "Owner", email: "owner@example.com", password: "a-long-password" });
  const headers = { "content-type": "application/json", origin: base };
  expect((await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers, body })).status).toBe(403);
  const code = await Bun.file(join(dataDir, "setup-code")).text();
  const made = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { ...headers, "x-vigie-setup-code": code.trim() }, body });
  expect(made.status).toBe(200);
  const cookie = made.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
  expect(session.actor.role).toBe("owner");
  const second = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { ...headers, "x-vigie-setup-code": code.trim() }, body: JSON.stringify({ name: "Other", email: "other@example.com", password: "a-long-password" }) });
  expect(second.status).toBe(403);
});

test.skipIf(!CH)("security headers: strict CSP with a nonce on every script, nothing inline without it", async () => {
  const response = await fetch(`${base}/logs`);
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-inline' 'nonce");
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  const html = await response.text();
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
  expect(response.headers.get("x-frame-options")).toBe("DENY");
});

test.skipIf(!CH)("wrong origin: a cross-site POST is refused before it reaches anything", async () => {
  const response = await fetch(`${base}/_serverFn/x`, { method: "POST", headers: { origin: "https://evil.example" } });
  expect(response.status).toBe(403);
});

test.skipIf(!CH)("MCP: no token, no access. A read token cannot write, a write token can", async () => {
  expect((await rpc(null, "tools/list")).status).toBe(401);
  const read = run(["token", "--kind", "mcp", "--name", "r", "--scope", "read"]).stdout.toString().trim();
  const write = run(["token", "--kind", "mcp", "--name", "w", "--scope", "write"]).stdout.toString().trim();
  const names = async (token: string) => ((await (await rpc(token, "tools/list")).json()).result.tools as { name: string }[]).map((t) => t.name);
  const readTools = await names(read);
  expect(readTools).toContain("get_context_pack");
  expect(readTools).toContain("parcelo_blocked");
  expect(readTools).toContain("page_parcelo");
  expect(readTools.length).toBeGreaterThan(60);
  for (const name of ["requeue_task", "run_task_now", "cancel_task", "ignore_task", "bulk_task_action", "update_issue", "create_alert", "declare_deployment"]) expect(readTools).not.toContain(name);
  expect(readTools).not.toContain("resolve_issue");
  expect(await names(write)).toContain("resolve_issue");
  const denied = await (await rpc(read, "tools/call", { name: "resolve_issue", arguments: { fingerprint: "x" } })).json();
  expect(denied.result.isError).toBe(true);
  const pack = await (await rpc(read, "tools/call", { name: "get_context_pack", arguments: { env: "DEV" } })).json();
  expect(JSON.parse(pack.result.content[0].text).requests).toBeDefined();
  const sql = await (await rpc(read, "tools/call", { name: "run_query", arguments: { sql: "DROP TABLE logs" } })).json();
  expect(sql.result.isError).toBe(true);
  const writeTools = await names(write);
  for (const name of ["requeue_task", "run_task_now", "cancel_task", "ignore_task"]) expect(writeTools).toContain(name);
  const requeue = await (await rpc(write, "tools/call", { name: "requeue_task", arguments: { id: "x", reason: "test" } })).json();
  expect(requeue.result.isError).toBe(true);
});

test.skipIf(!CH)("Ask Vigie: the model calls a read tool, then answers, as a stream", async () => {
  const token = run(["token", "--kind", "api", "--name", "ai", "--scope", "read"]).stdout.toString().trim();
  const response = await fetch(`${base}/api/ai/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ threadId: "t", messages: [{ role: "user", content: "What is firing?" }] }) });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("Nothing is firing.");
  expect(aiCalls.length).toBeGreaterThanOrEqual(2);
  expect(aiCalls[0].tools.map((t: any) => t.function.name)).toContain("list_alerts");
  expect(aiCalls[0].tools.map((t: any) => t.function.name)).not.toContain("resolve_issue");
}, 30_000);

test.skipIf(!CH)("AI search and explain read the model's streamed text", async () => {
  const script = `const m = await import("./server/ai.ts"); console.log(JSON.stringify(await m.aiFilter({ text: "failed things", fields: ["status"] }))); process.exit(0);`;
  // Async on purpose: the fake model lives in this process, so a blocking spawn would deadlock against it.
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, ...serverEnv() }, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(child.stdout).text();
  expect(JSON.parse(out.trim().split("\n").pop()!).q).toBe("status>=500");
}, 20_000);

test.skipIf(!CH)("vigie deploy declares a release with a deploy token, and refuses without one", async () => {
  const token = run(["token", "--kind", "deploy", "--name", "ci"]).stdout.toString().trim();
  const ok = await Bun.spawn(["bun", "cli/vigie.ts", "deploy", "--url", base, "--token", token, "--service", "svc", "--version", "v9", "--env", "DEV"], { env: { ...process.env, ...serverEnv() }, stdout: "ignore", stderr: "ignore" }).exited;
  expect(ok).toBe(0);
  const bad = await Bun.spawn(["bun", "cli/vigie.ts", "deploy", "--url", base, "--token", "nope", "--service", "svc", "--version", "v9"], { env: { ...process.env, ...serverEnv() }, stdout: "ignore", stderr: "ignore" }).exited;
  expect(bad).not.toBe(0);
});

test.skipIf(!CH)("MCP: every read tool answers, or refuses clearly, against an empty environment", async () => {
  const token = run(["token", "--kind", "mcp", "--name", "sweep", "--scope", "read"]).stdout.toString().trim();
  const tools = (await (await rpc(token, "tools/list")).json()).result.tools as { name: string; inputSchema: { required?: string[] } }[];
  const crashed: string[] = [];
  for (const tool of tools) {
    const args: Record<string, unknown> = { env: "DEV" };
    for (const key of tool.inputSchema.required ?? []) args[key] = key === "rule" ? { when: { source: "request-error-rate" }, above: 2, window: "10m" } : key === "sql" ? "SELECT 1 FROM logs LIMIT 1" : "missing";
    const body = await (await rpc(token, "tools/call", { name: tool.name, arguments: args })).json();
    const text: string = body.result?.content?.[0]?.text ?? JSON.stringify(body.error);
    if (body.error || (body.result?.isError && /syntax|DB::Exception|undefined|is not a function|TypeError/.test(text))) crashed.push(`${tool.name}: ${text.slice(0, 160)}`);
  }
  expect(crashed).toEqual([]);
}, 120_000);

test.skipIf(!CH)("uptime: two failures make an outage, the channel is told, and recovery closes it", async () => {
  const told: string[] = [];
  let healthy = true;
  const site = Bun.serve({ port: 0, fetch: () => new Response("x", { status: healthy ? 200 : 503 }) });
  const hook = Bun.serve({ port: 0, async fetch(request) { told.push(((await request.json()) as { text: string }).text); return new Response("ok"); } });
  const script = `
    const { db } = await import("./server/state/db.ts");
    const { createMonitor, runCheck, uptime } = await import("./server/api/uptime.ts");
    db.query("INSERT INTO channels (id, kind, name, target) VALUES ('it', 'slack', 'it', 'http://127.0.0.1:${hook.port}')").run();
    const { id } = createMonitor({ name: "Site", url: "http://127.0.0.1:${site.port}/" }, { id: "t", name: "t", role: "owner", through: "test" });
    const row = () => db.query("SELECT * FROM monitors WHERE id = ?").get(id);
    const step = async (at) => { await runCheck(row(), at); return row().state; };
    await Bun.write(Bun.stdout, JSON.stringify({ id }) + "\\n");
    for await (const line of console) {
      if (line === "end") break;
      const state = await step(Number(line));
      const data = uptime();
      console.log(JSON.stringify({ state, outages: data.outages.filter((o) => o.name === "Site"), up: data.rows.find((m) => m.id === id).uptime30d }));
    }
    db.query("DELETE FROM channels WHERE id = 'it'").run();
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, ...serverEnv() }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let buffer = "";
  const line = async () => {
    while (!buffer.includes("\n")) buffer += new TextDecoder().decode((await reader.read()).value);
    const index = buffer.indexOf("\n");
    const out = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    return JSON.parse(out);
  };
  const step = async (at: number) => { child.stdin.write(`${at}\n`); child.stdin.flush(); return line(); };
  await line();
  const now = Date.now();
  expect((await step(now)).state).toBe("up");
  healthy = false;
  expect((await step(now + 60_000)).state).toBe("up");
  expect(told.filter((t) => t.includes("Site")).length).toBe(0);
  const down = await step(now + 120_000);
  expect(down.state).toBe("down");
  expect(down.outages[0].ended).toBeNull();
  expect(told.filter((t) => t.includes("Site")).at(-1)).toContain("Site is down");
  healthy = true;
  const back = await step(now + 180_000);
  expect(back.state).toBe("up");
  expect(back.outages[0].ended).toBeTruthy();
  expect(back.up).toBe(50);
  expect(told.filter((t) => t.includes("Site")).at(-1)).toContain("Site is back up");
  child.stdin.write("end\n");
  child.stdin.flush();
  await child.exited;
  site.stop();
  hook.stop();
}, 30_000);

test.skipIf(!CH)("quiet hours: it records, stays silent, and tells when they end only if it is still firing", async () => {
  const told: string[] = [];
  const hook = Bun.serve({ port: 0, async fetch(request) { told.push(((await request.json()) as { text: string }).text); return new Response("ok"); } });
  const script = `
    const { db } = await import("./server/state/db.ts");
    const { evaluateAlerts } = await import("./server/alerts.ts");
    db.query("INSERT INTO channels (id, kind, name, target) VALUES ('q', 'slack', 'q', 'http://127.0.0.1:${hook.port}')").run();
    db.query("UPDATE alerts SET paused = 1").run();
    const hhmm = (d) => new Date(d).toISOString().slice(11, 16);
    const now = Date.now();
    const covers = { from: hhmm(now - 3600000), to: hhmm(now + 3600000), timezone: "UTC" };
    const misses = { from: hhmm(now + 3600000), to: hhmm(now + 7200000), timezone: "UTC" };
    const set = (value, quiet) => db.query("UPDATE alerts SET rule = ? WHERE id = 'q'").run(JSON.stringify({ when: { source: "sql", sql: "SELECT 0 AS t, " + value + " AS v" }, above: 1, window: "5m", quiet }));
    db.query("INSERT INTO alerts (id, name, family, rule, managed_in) VALUES ('q', 'Quiet probe', 'Custom', '{}', 'app')").run();
    const state = () => ({ ...db.query("SELECT state, quiet_pending FROM alerts WHERE id = 'q'").get(), incidents: db.query("SELECT count() AS n FROM incidents WHERE alert_id = 'q'").get().n });
    const out = [];
    set(5, covers); await evaluateAlerts(); out.push(state());
    set(5, misses); await evaluateAlerts(); out.push(state());
    set(0, misses); await evaluateAlerts(); out.push(state());
    set(5, covers); await evaluateAlerts(); out.push(state());
    set(0, covers); await evaluateAlerts(); out.push(state());
    db.query("DELETE FROM channels WHERE id = 'q'").run();
    db.query("DELETE FROM alerts WHERE id = 'q'").run();
    db.query("UPDATE alerts SET paused = 0").run();
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, ...serverEnv() }, stdout: "pipe", stderr: "inherit" });
  const steps = JSON.parse((await new Response(child.stdout).text()).trim().split("\n").pop()!);
  hook.stop();
  expect(steps[0]).toEqual({ state: "firing", quiet_pending: 1, incidents: 1 });
  expect(steps[1]).toEqual({ state: "firing", quiet_pending: 0, incidents: 1 });
  expect(steps[2]).toEqual({ state: "ok", quiet_pending: 0, incidents: 1 });
  expect(steps[3]).toEqual({ state: "firing", quiet_pending: 1, incidents: 2 });
  expect(steps[4]).toEqual({ state: "ok", quiet_pending: 0, incidents: 2 });
  // The server's own alert loop shares this channel, so only this alert's messages count.
  const mine = told.filter((t) => t.includes("Quiet probe"));
  expect(mine.length).toBe(2);
  expect(mine[0]).toContain("started during quiet hours");
  expect(mine[1]).toContain("recovered");
}, 30_000);

test.skipIf(!CH)("vigie parity: equal sides pass, a difference fails, and it never writes", async () => {
  const hd = `vigie_hd_${process.pid}`;
  const headers = { "X-ClickHouse-User": process.env.CLICKHOUSE_USER ?? "default", "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD ?? "" };
  const exec = (sql: string) => fetch(`${CH}/`, { method: "POST", headers, body: sql }).then(async (r) => { if (!r.ok) throw new Error(await r.text()); });
  await exec(`CREATE DATABASE IF NOT EXISTS ${hd}`);
  await exec(`CREATE TABLE ${hd}.otel_logs ENGINE = MergeTree ORDER BY Timestamp AS SELECT Timestamp, ServiceName, SeverityText, LogAttributes FROM ${database}.logs`);
  await exec(`CREATE TABLE ${hd}.otel_traces ENGINE = MergeTree ORDER BY Timestamp AS SELECT Timestamp, ServiceName FROM ${database}.spans`);
  await exec(`CREATE TABLE ${hd}.otel_metrics_gauge ENGINE = MergeTree ORDER BY TimeUnix AS SELECT TimeUnix, ServiceName FROM ${database}.metrics_gauge`);
  const parityRun = async () => {
    const child = Bun.spawn(["bun", "cli/vigie.ts", "parity", "--url", CH!, "--database", hd, "--user", process.env.CLICKHOUSE_USER ?? "default", "--hours", "24"], { env: { ...process.env, ...serverEnv(), HYPERDX_CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? "" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    return { code: await child.exited, out };
  };
  // Parity stops 5 minutes short of now, so the rows under test sit inside that window.
  await exec(`INSERT INTO ${hd}.otel_traces SELECT now() - INTERVAL 1 HOUR, 'extra-service' FROM numbers(50)`);
  const differs = await parityRun();
  expect(differs.code).toBe(1);
  expect(differs.out).toContain("extra-service");
  await exec(`ALTER TABLE ${hd}.otel_traces DELETE WHERE ServiceName = 'extra-service' SETTINGS mutations_sync = 2`);
  const same = await parityRun();
  expect(same.out).not.toContain("extra-service");
  expect(same.out).not.toContain("FAIL");
  await exec(`DROP DATABASE ${hd} SYNC`);
}, 60_000);

test.skipIf(!CH)("anomaly: a spike fires, a steady line does not, and too little history says so", async () => {
  const script = `
    const { db } = await import("./server/state/db.ts");
    const { evaluateAlerts } = await import("./server/alerts.ts");
    db.query("UPDATE alerts SET paused = 1").run();
    const rows = (n, spike) => "SELECT number AS t, if(number = " + (n - 1) + ", " + spike + ", 5 + number % 2) AS v FROM numbers(" + n + ")";
    const add = (id, sql) => db.query("INSERT INTO alerts (id, name, family, rule, managed_in) VALUES (?, ?, 'Custom', ?, 'app')").run(id, id, JSON.stringify({ when: { source: "sql", sql }, sigma: 3, window: "5m" }));
    add("spike", rows(50, 100));
    add("steady", rows(50, 6));
    add("young", rows(10, 100));
    await evaluateAlerts();
    const read = (id) => db.query("SELECT state, error FROM alerts WHERE id = ?").get(id);
    console.log(JSON.stringify({ spike: read("spike"), steady: read("steady"), young: read("young") }));
    for (const id of ["spike", "steady", "young"]) { db.query("DELETE FROM incidents WHERE alert_id = ?").run(id); db.query("DELETE FROM alerts WHERE id = ?").run(id); }
    db.query("UPDATE alerts SET paused = 0").run();
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, ...serverEnv() }, stdout: "pipe", stderr: "inherit" });
  const out = JSON.parse((await new Response(child.stdout).text()).trim().split("\n").pop()!);
  expect(out.spike.state).toBe("firing");
  expect(out.steady.state).toBe("ok");
  expect(out.young.state).toBe("ok");
  expect(out.young.error).toContain("Not enough history");
}, 30_000);

test.skipIf(!CH)("sign-in with the app: a person gets a session, and task actions go to the app's route with their own token", async () => {
  const jar = new Map<string, string>();
  const keep = (response: Response) => { for (const c of response.headers.getSetCookie()) { const [pair] = c.split(";"); const at = pair!.indexOf("="); jar.set(pair!.slice(0, at), pair!.slice(at + 1)); } return response; };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const start = keep(await fetch(`${base}/api/auth/sign-in/social`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ provider: "app", callbackURL: "/" }) }));
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  expect(url).toContain("/authorize");
  const authorize = await fetch(url, { redirect: "manual" });
  const callback = keep(await fetch(authorize.headers.get("location")!, { redirect: "manual", headers: { cookie: cookie() } }));
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/");
  const session = (await (await fetch(`${base}/api/session`, { headers: { cookie: cookie() } })).json()) as { name?: string; user?: { name?: string; email?: string } };
  expect(JSON.stringify(session)).toContain("A Person");

  const script = `
    const { authDb } = await import("./server/auth.ts");
    const { taskAction } = await import("./server/api/tasks.ts");
    const person = authDb.query("SELECT id, name FROM user WHERE email = 'person@example.test'").get();
    const actor = { id: person.id, name: person.name, role: "owner", through: "app" };
    const results = {};
    results.person = await taskAction({ id: "01a1a462-ef1d-7374-a3a8-20a6dabc524a", action: "run-now", reason: "Stuck" }, actor).then(() => "ok", (e) => String(e.message));
    results.machine = await taskAction({ id: "01a1a462-ef1d-7374-a3a8-20a6dabc524a", action: "cancel", reason: "x" }, { id: "token-1", name: "CI", role: "owner", through: "api" }).then(() => "ok", (e) => String(e.message));
    console.log(JSON.stringify(results));
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, ...serverEnv() }, stdout: "pipe", stderr: "inherit" });
  const results = JSON.parse((await new Response(child.stdout).text()).trim().split("\n").pop()!);
  expect(results.person).toBe("ok");
  expect(results.machine).toContain("own Acme sign-in");
  expect(appCalls).toEqual([{ path: "/v1/tasks/01a1a462-ef1d-7374-a3a8-20a6dabc524a/actions/run-now", authorization: "Bearer the-persons-token", body: { reason: "Stuck" } }]);
}, 30_000);

test.skipIf(!CH)("alert channels: a named channel gets it alone, a missing name falls back to all, and live families evaluate", async () => {
  const told: Record<string, string[]> = { a: [], b: [] };
  const hook = Bun.serve({ port: 0, async fetch(request) { const which = new URL(request.url).pathname.slice(1); told[which]?.push(((await request.json()) as { text: string }).text); return new Response("ok"); } });
  const script = `
    const { db } = await import("./server/state/db.ts");
    const { notifyChannels, evaluateRule } = await import("./server/alerts.ts");
    db.query("INSERT INTO channels (id, kind, name, target) VALUES ('ca', 'slack', 'a', 'http://127.0.0.1:${hook.port}/a'), ('cb', 'slack', 'b', 'http://127.0.0.1:${hook.port}/b')").run();
    await notifyChannels({ tone: "info", title: "t", summary: "only-a" }, "a");
    await notifyChannels({ tone: "info", title: "t", summary: "missing-name" }, "gone");
    const slo = await evaluateRule({ when: { source: "slo-burn", slo: "no-such-objective" }, above: 1, window: "5m" }, "DEV");
    const rule = await evaluateRule({ when: { source: "rule-violation", rule: "no-such-rule" }, above: 0, window: "5m" }, "DEV");
    db.query("DELETE FROM channels WHERE id IN ('ca', 'cb')").run();
    console.log(JSON.stringify({ slo, rule }));
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, ...serverEnv() }, stdout: "pipe", stderr: "inherit" });
  const out = JSON.parse((await new Response(child.stdout).text()).trim().split("\n").pop()!);
  hook.stop();
  expect(told.a!.some((t) => t.includes("only-a"))).toBe(true);
  expect(told.b!.some((t) => t.includes("only-a"))).toBe(false);
  expect(told.a!.some((t) => t.includes("missing-name"))).toBe(true);
  expect(told.b!.some((t) => t.includes("missing-name"))).toBe(true);
  expect(out).toEqual({ slo: 0, rule: 0 });
}, 30_000);

test.skipIf(!CH)("alerts that fire together are one post, and recover as one post", async () => {
  const told: string[] = [];
  const hook = Bun.serve({ port: 0, async fetch(request) { told.push(JSON.stringify(await request.json())); return new Response("ok"); } });
  const script = `
    const { db } = await import("./server/state/db.ts");
    const { evaluateAlerts } = await import("./server/alerts.ts");
    db.query("DELETE FROM alerts").run();
    db.query("INSERT INTO channels (id, kind, name, target) VALUES ('g', 'slack', 'g', 'http://127.0.0.1:${hook.port}')").run();
    const rule = (v) => JSON.stringify({ when: { source: "sql", sql: "SELECT toUnixTimestamp(now()) * 1000 AS t, " + v + " AS v" }, above: 1, window: "5m" });
    db.query("INSERT INTO alerts (id, name, family, rule, managed_in) VALUES ('g1', 'Group one', 'Custom', ?, 'app'), ('g2', 'Group two', 'Custom', ?, 'app')").run(rule(5), rule(5));
    await evaluateAlerts();
    db.query("UPDATE alerts SET rule = ?").run(rule(0));
    await evaluateAlerts();
    db.query("DELETE FROM channels WHERE id = 'g'").run();
    db.query("DELETE FROM alerts WHERE id IN ('g1', 'g2')").run();
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, ...serverEnv() }, stdout: "ignore", stderr: "inherit" });
  await child.exited;
  hook.stop();
  const mine = told.filter((t) => t.includes("Group one") || t.includes("Group two"));
  expect(mine.length).toBe(2);
  expect(mine[0]).toContain("Also firing");
  expect(mine[0]).toContain("#E5484D");
  expect(mine[1]).toContain("Also back to normal");
  expect(mine[1]).toContain("#2EB67D");
}, 30_000);
