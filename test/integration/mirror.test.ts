import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CH = process.env.CLICKHOUSE_URL;
const PG = process.env.VIGIE_TEST_APP_DB;

/** Against a real Postgres and ClickHouse: the copy must carry the row and must never carry payload or result. */
test.skipIf(!CH || !PG)("the task mirror copies rows, takes updates and never copies payload or result", async () => {
  const database = `vigie_mirror_${process.pid}`;
  const script = `
    const { SQL } = await import("bun");
    const pg = new SQL(process.env.VIGIE_APP_DATABASE_URL);
    await pg\`DROP TABLE IF EXISTS task\`;
    await pg\`DROP TYPE IF EXISTS task_state\`;
    await pg\`CREATE TYPE task_state AS ENUM ('QUEUED', 'RUNNING', 'DONE')\`;
    await pg\`CREATE TABLE task (id uuid PRIMARY KEY, kind text, key text, state task_state, standing boolean, "accountId" uuid, "testCenterId" uuid, "subjectType" text, "subjectId" text, "serialKey" text, "runAt" timestamptz, attempts int, runs int, "consecutiveFailures" int, "leaseUntil" timestamptz, "workerId" text, "waitReason" text, code text, payload jsonb, result jsonb, "causedBy" text, "createdBy" text, "traceId" text, "lastRunAt" timestamptz, "lastOkAt" timestamptz, "createdAt" timestamptz, "updatedAt" timestamptz, "settledAt" timestamptz)\`;
    const id = "01a00000-0000-7000-8000-000000000001";
    await pg\`INSERT INTO task (id, kind, key, state, "runAt", attempts, runs, payload, result, "causedBy", "createdAt", "updatedAt") VALUES (\${id}, 'demo.kind', 'k1', 'QUEUED', now(), 0, 1, '{"secret":"PAYLOAD-SECRET"}', '{"secret":"RESULT-SECRET"}', 'user:someone', now(), now() - interval '1 minute')\`;
    const { migrate } = await import("./server/schema.ts");
    await migrate();
    const { mirrorOnce, pendingFromMirror } = await import("./server/mirror.ts");
    const { query } = await import("./server/lib/clickhouse.ts");
    const first = await mirrorOnce();
    await pg\`UPDATE task SET state = 'DONE', "updatedAt" = now() WHERE id = \${id}\`;
    const second = await mirrorOnce();
    const rows = await query("SELECT * FROM task_mirror FINAL WHERE Id = '" + id + "'");
    const pending = await pendingFromMirror(undefined, 10);
    await pg\`DROP TABLE task\`;
    await pg\`DROP TYPE task_state\`;
    console.log(JSON.stringify({ first, second, state: rows[0]?.State, cause: rows[0]?.CausedBy, count: rows.length, pending: pending.length, raw: JSON.stringify(rows) }));
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, CLICKHOUSE_DATABASE: database, VIGIE_APP_DATABASE_URL: PG!, VIGIE_MODE: "server", VIGIE_DATA_DIR: mkdtempSync(join(tmpdir(), "vigie-mirror-")) }, stdout: "pipe", stderr: "inherit" });
  const out = JSON.parse((await new Response(child.stdout).text()).trim().split("\n").pop()!);
  expect(out.first.tasks).toBe(1);
  expect(out.second.tasks).toBeGreaterThanOrEqual(1);
  expect(out.count).toBe(1);
  expect(out.state).toBe("DONE");
  expect(out.cause).toBe("user:someone");
  expect(out.pending).toBe(0);
  expect(out.raw).not.toContain("SECRET");
  await fetch(`${CH}/`, { method: "POST", headers: { "X-ClickHouse-User": process.env.CLICKHOUSE_USER ?? "default", "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD ?? "" }, body: `DROP DATABASE IF EXISTS ${database}` });
}, 30_000);

/** Production has 3,988 tasks stamped by one transaction. A batch holds 2,000, so a cursor of the time alone never moves on. */
test.skipIf(!CH || !PG)("the mirror moves past more rows than a batch holds with one timestamp, and goes quiet when caught up", async () => {
  const database = `vigie_mirror_same_${process.pid}`;
  const script = `
    const { SQL } = await import("bun");
    const pg = new SQL(process.env.VIGIE_APP_DATABASE_URL);
    await pg\`DROP TABLE IF EXISTS task\`;
    await pg\`DROP TABLE IF EXISTS feature_flag_change\`;
    await pg\`CREATE TABLE task (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text, key text, state text, standing boolean, "accountId" uuid, "testCenterId" uuid, "subjectType" text, "subjectId" text, "serialKey" text, "runAt" timestamptz, attempts int, runs int, "consecutiveFailures" int, "leaseUntil" timestamptz, "workerId" text, "waitReason" text, code text, "causedBy" text, "createdBy" text, "traceId" text, "lastRunAt" timestamptz, "lastOkAt" timestamptz, "createdAt" timestamptz, "updatedAt" timestamptz, "settledAt" timestamptz)\`;
    await pg\`INSERT INTO task (kind, key, state, "runAt", "createdAt", "updatedAt") SELECT 'bulk', 'k' || n, 'DONE', now(), now(), '2026-11-04 10:00:00.123456+00'::timestamptz FROM generate_series(1, 4500) n\`;
    await pg\`INSERT INTO task (kind, key, state, "runAt", "createdAt", "updatedAt") VALUES ('after', 'last', 'QUEUED', now(), now(), '2026-11-04 10:00:01+00')\`;
    await pg\`CREATE TABLE feature_flag_change (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text, enabled boolean, "previousEnabled" boolean, reason text, "userId" text, "createdAt" timestamptz)\`;
    await pg\`INSERT INTO feature_flag_change (key, enabled, "createdAt") VALUES ('s', true, '2026-11-04 10:00:00.123456+00')\`;
    const { migrate } = await import("./server/schema.ts");
    await migrate();
    const { mirrorOnce, mirrorFresh } = await import("./server/mirror.ts");
    const { query } = await import("./server/lib/clickhouse.ts");
    const passes = [];
    for (let i = 0; i < 6; i++) passes.push(await mirrorOnce());
    const [{ tasks }] = await query("SELECT count() AS tasks FROM task_mirror FINAL");
    const [{ after }] = await query("SELECT count() AS after FROM task_mirror FINAL WHERE Kind = 'after'");
    const [{ parts }] = await query("SELECT count() AS parts FROM switch_changes");
    const fresh = mirrorFresh();
    await pg\`DROP TABLE task\`;
    await pg\`DROP TABLE feature_flag_change\`;
    console.log(JSON.stringify({ passes, tasks: Number(tasks), after: Number(after), parts: Number(parts), fresh }));
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, CLICKHOUSE_DATABASE: database, VIGIE_APP_DATABASE_URL: PG!, VIGIE_MODE: "server", VIGIE_DATA_DIR: mkdtempSync(join(tmpdir(), "vigie-mirror-same-")) }, stdout: "pipe", stderr: "inherit" });
  const out = JSON.parse((await new Response(child.stdout).text()).trim().split("\n").pop()!);
  expect(out.tasks).toBe(4501);
  expect(out.after).toBe(1);
  expect(out.passes.at(-1).tasks).toBe(0);
  expect(out.parts).toBe(1);
  expect(out.passes.at(-1).switches).toBe(0);
  expect(out.fresh).toBe(true);
  await fetch(`${CH}/`, { method: "POST", headers: { "X-ClickHouse-User": process.env.CLICKHOUSE_USER ?? "default", "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD ?? "" }, body: `DROP DATABASE IF EXISTS ${database}` });
}, 60_000);

/** The real tasks of one order have different keys and may name it by the provider's id. They must still be one instance. */
test.skipIf(!CH || !PG)("a process instance follows its subject, across keys and through an alias", async () => {
  const database = `vigie_process_${process.pid}`;
  const script = `
    const { SQL } = await import("bun");
    const pg = new SQL(process.env.VIGIE_APP_DATABASE_URL);
    await pg\`DROP TABLE IF EXISTS order\`;
    await pg\`CREATE TABLE order (id text PRIMARY KEY, "providerOrderId" text)\`;
    await pg\`INSERT INTO order VALUES ('a-1', 'vt-99')\`;
    const { migrate } = await import("./server/schema.ts");
    await migrate();
    const { insert } = await import("./server/lib/clickhouse.ts");
    const now = Date.now();
    const log = (kind, key, subjectType, subjectId, at) => JSON.stringify({ Timestamp: new Date(at).toISOString(), ServiceName: "worker", Environment: "PRD", SeverityText: "info", Body: "task", LogAttributes: { kind: "task", "task.kind": kind, "task.id": kind + key, "task.key": key, "task.subject.type": subjectType, "task.subject.id": subjectId, outcome: "succeeded", operation: "tasks.run", "taskOutcome.type": "DONE" } });
    await insert("logs", [log("demo.ingest", "ingest:vt-99", "paynest-order", "vt-99", now - 3000), log("demo.render", "render:a-1", "order", "a-1", now - 2000), log("demo.email", "email:a-1", "order", "a-1", now - 1000)].join("\\n"));
    const { registry } = await import("./server/extensions/index.ts");
    registry.processes.length = 0;
    registry.processes.push({ kind: "process", id: "p", title: "P", subject: "order", file: "t", aliases: [{ subjectType: "paynest-order", table: "order", aliasColumn: "providerOrderId", subjectColumn: "id" }], steps: [{ kind: "demo.ingest", label: "Ingest" }, { kind: "demo.render", label: "Render" }, { kind: "demo.email", label: "Email" }] });
    const { processDetail, processInstance } = await import("./server/api/processes.ts");
    const scope = { env: "PRD", from: now - 60000, to: now + 60000 };
    await Bun.sleep(1500);
    const detail = await processDetail({ ...scope, id: "p" });
    const page = await processInstance({ ...scope, id: "p", key: "a-1" });
    await pg\`DROP TABLE order\`;
    console.log(JSON.stringify({ started: detail.started ?? detail.stats?.started, instances: (detail.instances ?? detail.rows ?? []).map((i) => i.key), steps: page.destinations.map((d) => d.state), events: page.events.length }));
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, CLICKHOUSE_DATABASE: database, VIGIE_APP_DATABASE_URL: PG!, VIGIE_MODE: "server", VIGIE_DATA_DIR: mkdtempSync(join(tmpdir(), "vigie-process-")) }, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(child.stdout).text();
  const out = JSON.parse(text.trim().split("\n").pop()!);
  expect(out.steps).toEqual(["done", "done", "done"]);
  expect(out.events).toBe(3);
  await fetch(`${CH}/`, { method: "POST", headers: { "X-ClickHouse-User": process.env.CLICKHOUSE_USER ?? "default", "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD ?? "" }, body: `DROP DATABASE IF EXISTS ${database}` });
}, 30_000);

test.skipIf(!CH)("a Linear issue is filed once, and a refusal says so", async () => {
  const database = `vigie_linear_${process.pid}`;
  const calls: { auth: string | null; body: any }[] = [];
  let refuse = false;
  const linear = Bun.serve({
    port: 0,
    async fetch(request) {
      calls.push({ auth: request.headers.get("authorization"), body: await request.json() });
      if (refuse) return Response.json({ errors: [{ message: "no" }] }, { status: 400 });
      return Response.json({ data: { issueCreate: { success: true, issue: { url: "https://linear.test/EXA-1" } } } });
    },
  });
  const script = `
    const { db } = await import("./server/state/db.ts");
    const { createLinearIssue, issueDetail } = await import("./server/api/reliability.ts");
    const { migrate } = await import("./server/schema.ts");
    await migrate();
    const actor = { name: "t", through: "ui" };
    const insert = (fp) => db.query("INSERT INTO issues (fingerprint, name, message, service, environment, first_seen, last_seen, why, fix) VALUES (?, 'Boom', 'It broke', 'api', 'PRD', 1, 1, 'because', 'do this')").run(fp);
    insert("ok-1");
    const first = await createLinearIssue({ fp: "ok-1" }, actor);
    const second = await createLinearIssue({ fp: "ok-1" }, actor);
    const stored = db.query("SELECT linear_url AS url FROM issues WHERE fingerprint = 'ok-1'").get();
    const now = Date.now();
    const detail = await issueDetail({ env: "PRD", from: now - 60000, to: now, fp: "ok-1" });
    console.log(JSON.stringify({ first, second, stored, ready: detail.linearReady }));
    await fetch(process.env.REFUSE_URL);
    insert("no-1");
    let message = "";
    try { await createLinearIssue({ fp: "no-1" }, actor); } catch (error) { message = error.message; }
    const after = db.query("SELECT linear_url AS url FROM issues WHERE fingerprint = 'no-1'").get();
    console.log(JSON.stringify({ first, second, stored, ready: detail.linearReady, message, after }));
    process.exit(0);
  `;
  const switcher = Bun.serve({ port: 0, fetch() { refuse = true; return new Response("ok"); } });
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, CLICKHOUSE_DATABASE: database, REFUSE_URL: `http://127.0.0.1:${switcher.port}`, VIGIE_LINEAR_API_KEY: "lin_test_key", VIGIE_LINEAR_TEAM_ID: "team-1", VIGIE_LINEAR_URL: `http://127.0.0.1:${linear.port}`, VIGIE_MODE: "server", VIGIE_DATA_DIR: mkdtempSync(join(tmpdir(), "vigie-linear-")) }, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(child.stdout).text();
  linear.stop();
  switcher.stop();
  const out = JSON.parse(text.trim().split("\n").pop()!);
  expect(out.first.url).toBe("https://linear.test/EXA-1");
  expect(out.second.url).toBe("https://linear.test/EXA-1");
  expect(out.stored.url).toBe("https://linear.test/EXA-1");
  expect(out.ready).toBe(true);
  expect(out.message).toContain("Linear refused");
  expect(out.message).not.toContain("lin_test_key");
  expect(out.after.url).toBeNull();
  // Filed once: the second call for ok-1 never reached Linear. One more call is the refused one.
  expect(calls.length).toBe(2);
  expect(calls[0]!.auth).toBe("lin_test_key");
  expect(calls[0]!.body.variables.input.teamId).toBe("team-1");
  expect(calls[0]!.body.variables.input.title).toBe("Boom");
  expect(calls[0]!.body.variables.input.description).toContain("do this");
  await fetch(`${CH}/`, { method: "POST", headers: { "X-ClickHouse-User": process.env.CLICKHOUSE_USER ?? "default", "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD ?? "" }, body: `DROP DATABASE IF EXISTS ${database}` });
}, 30_000);

test.skipIf(!CH)("the query language: every named table answers, limits hold, and writes are refused", async () => {
  const database = `vigie_vql_${process.pid}`;
  const script = `
    const { migrate } = await import("./server/schema.ts");
    await migrate();
    const { insert } = await import("./server/lib/clickhouse.ts");
    const now = new Date().toISOString();
    await insert("logs", JSON.stringify({ Timestamp: now, EventId: "e1", TraceId: "t1", ServiceName: "worker", Environment: "PRD", SeverityText: "info", Body: "task", LogAttributes: { "task.kind": "demo.kind", "task.id": "i1", "task.key": "k1", "task.attempt": "2", "taskOutcome.code": "DEMO_DOWN", outcome: "failed", operation: "tasks.run" } }));
    await insert("spans", JSON.stringify({ Timestamp: now, TraceId: "t1", SpanId: "s1", ParentSpanId: "", SpanName: "pipedeck create", SpanKind: "Client", ServiceName: "worker", Environment: "PRD", Duration: 840000000, StatusCode: "Error", StatusMessage: "", SpanAttributes: { "peer.service": "pipedeck", "server.address": "pipedeck", "provider.operation": "create", "http.response.status_code": "429" } }));
    const { CONSOLE_TABLES, runConsole } = await import("./server/api/metrics.ts");
    const input = { env: "PRD", from: Date.now() - 3600000, to: Date.now() + 3600000 };
    const answered = {};
    for (const table of Object.keys(CONSOLE_TABLES)) {
      try { await runConsole({ ...input, sql: "SELECT " + CONSOLE_TABLES[table].filter((c) => c !== "Quantiles").join(", ") + " FROM " + table + " LIMIT 1" }); answered[table] = true; }
      catch (error) { answered[table] = String(error.message).slice(0, 160); }
    }
    const attempt = (await runConsole({ ...input, sql: "SELECT TaskKind, Attempt, Code, Outcome FROM task_attempts WHERE TaskId = 'i1'" })).rows[0];
    const call = (await runConsole({ ...input, sql: "SELECT Provider, Operation, Status, DurationMs, Failed FROM provider_calls" })).rows[0];
    const refused = [];
    for (const sql of ["DROP TABLE logs", "INSERT INTO logs SELECT * FROM logs", "SELECT * FROM system.tables", "SELECT * FROM url('http://x.test', CSV)"]) {
      try { await runConsole({ ...input, sql }); } catch { refused.push(sql); }
    }
    console.log(JSON.stringify({ answered, attempt, call, refused: refused.length }));
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, CLICKHOUSE_DATABASE: database, VIGIE_MODE: "server", VIGIE_DATA_DIR: mkdtempSync(join(tmpdir(), "vigie-vql-")) }, stdout: "pipe", stderr: "inherit" });
  const out = JSON.parse((await new Response(child.stdout).text()).trim().split("\n").pop()!);
  for (const [table, result] of Object.entries(out.answered)) expect(`${table}: ${result}`).toBe(`${table}: true`);
  expect(out.attempt).toEqual({ TaskKind: "demo.kind", Attempt: 2, Code: "DEMO_DOWN", Outcome: "failed" });
  expect(out.call).toEqual({ Provider: "pipedeck", Operation: "create", Status: 429, DurationMs: 840, Failed: 1 });
  expect(out.refused).toBe(4);
  await fetch(`${CH}/`, { method: "POST", headers: { "X-ClickHouse-User": process.env.CLICKHOUSE_USER ?? "default", "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD ?? "" }, body: `DROP DATABASE IF EXISTS ${database}` });
}, 30_000);

test("Discord, e-mail and source context work against real protocols", async () => {
  const discord: any[] = [];
  const github: { path: string; auth: string | null; accept: string | null }[] = [];
  const hook = Bun.serve({ port: 0, async fetch(request) { discord.push(await request.json()); return new Response(null, { status: 204 }); } });
  const gh = Bun.serve({ port: 0, fetch(request) { const url = new URL(request.url); github.push({ path: url.pathname + url.search, auth: request.headers.get("authorization"), accept: request.headers.get("accept") }); return url.pathname.includes("missing") ? new Response("no", { status: 404 }) : new Response(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")); } });
  const subject = `Parcelo is refusing calls ${process.pid}-${Date.now()}`;
  const script = `
    const { db } = await import("./server/state/db.ts");
    db.query("DELETE FROM channels").run();
    db.query("INSERT INTO channels (id, kind, name, target) VALUES ('d', 'discord', 'd', 'http://127.0.0.1:${hook.port}'), ('e', 'email', 'e', 'ops@acme.test')").run();
    const { notifyChannels } = await import("./server/alerts.ts");
    const sent = await notifyChannels({ tone: "firing", title: "${subject}", summary: "10 failed.", fields: [{ label: "Since", at: 1793572200000 }], links: [{ label: "Open alert", url: "https://vigie.test/a" }] });
    const { sourceAround } = await import("./server/lib/source.ts");
    const stack = "Error: x\\n    at run (/app/app/modules/a.ts:12:3)";
    const found = await sourceAround(stack, "61da86a9");
    const again = await sourceAround(stack, "61da86a9");
    const notCommit = await sourceAround(stack, "0.0.1");
    const missing = await sourceAround("Error: x\\n    at run (/app/app/modules/missing.ts:3:1)", "61da86a9");
    console.log(JSON.stringify({ sent, found, again: Boolean(again), notCommit, missing }));
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, VIGIE_MODE: "local", VIGIE_DATA_DIR: mkdtempSync(join(tmpdir(), "vigie-chan-")), VIGIE_SMTP_URL: process.env.VIGIE_TEST_SMTP ?? "smtp://127.0.0.1:1", VIGIE_MAIL_FROM: "Vigie <vigie@acme.test>", VIGIE_SOURCE_REPO: "acme/shop", VIGIE_GITHUB_TOKEN: "gh_test", VIGIE_SOURCE_PREFIX: "apps/api/", VIGIE_GITHUB_API: `http://127.0.0.1:${gh.port}` }, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(child.stdout).text();
  hook.stop();
  gh.stop();
  const out = JSON.parse(text.trim().split("\n").pop()!);
  expect(out.sent.results[0]).toEqual({ name: "d", ok: true });
  // A real SMTP server when one is given. Without one, the failure must be reported, not swallowed.
  expect(out.sent.results[1].ok).toBe(Boolean(process.env.VIGIE_TEST_SMTP));
  expect(discord[0].embeds[0].title).toContain(subject);
  expect(discord[0].allowed_mentions.parse).toEqual([]);
  if (process.env.VIGIE_TEST_SMTP_API) {
    const found = (await (await fetch(`${process.env.VIGIE_TEST_SMTP_API}/api/v1/search?query=${encodeURIComponent(subject)}`)).json()) as { messages: { ID: string; To: { Address: string }[]; Subject: string }[] };
    expect(found.messages.length).toBe(1);
    expect(found.messages[0]!.To[0]!.Address).toBe("ops@acme.test");
    const message = (await (await fetch(`${process.env.VIGIE_TEST_SMTP_API}/api/v1/message/${found.messages[0]!.ID}`)).json()) as { HTML: string; Text: string };
    expect(message.HTML).toContain("Open alert");
    expect(message.Text).toContain("UTC");
  }
  expect(out.found.path).toBe("apps/api/app/modules/a.ts");
  expect(out.found.lines.find((l: any) => l.n === 12).text).toBe("line 12");
  expect(out.found.lines.length).toBe(11);
  expect(out.found.url).toContain("/blob/61da86a9/");
  expect(out.notCommit).toBeNull();
  expect(out.missing).toBeNull();
  // Read once and cached. The token goes only to GitHub.
  expect(github.filter((g) => g.path.includes("a.ts")).length).toBe(1);
  expect(github[0]!.auth).toBe("Bearer gh_test");
  expect(github[0]!.path).toContain("ref=61da86a9");
  expect(github[0]!.accept).toContain("raw");
}, 30_000);
