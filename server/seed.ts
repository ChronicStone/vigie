/** Realistic telemetry from a made-up shop, Acme, sent over real OTLP/HTTP, so a local Vigie shows a full product within seconds. */
const ROUTES = [
  ["GET", "/v1/session", "v1.session.show", 22, 9],
  ["GET", "/v1/dashboard/overview", "v1.dashboard.overview", 190, 5],
  ["GET", "/v1/customers", "v1.customers.index", 84, 6],
  ["GET", "/v1/customers/:id", "v1.customers.show", 48, 5],
  ["POST", "/v1/orders", "v1.orders.store", 230, 2],
  ["GET", "/v1/orders/:id/receipt", "v1.receipts.show", 115, 3],
  ["POST", "/v1/orders/:id/checkout", "v1.orders.checkout", 660, 1.4],
  ["GET", "/v1/accounts/:id", "v1.accounts.show", 64, 3],
  ["POST", "/v1/exports", "v1.exports.store", 128, 0.8],
  ["GET", "/v1/notifications", "v1.notifications.index", 31, 7],
  ["PATCH", "/v1/contracts/:id", "v1.contracts.update", 146, 0.7],
  ["GET", "/v1/tasks", "v1.tasks.index", 44, 2.6],
] as const;
const USERS = [
  ["usr_01j8c2", "OWNER", "acc_meridien"],
  ["usr_01j9f7", "ADMIN", "acc_horizon"],
  ["usr_01jb31", "MANAGER", "acc_lingua"],
  ["usr_01jd88", "CLIENT", "acc_atelier"],
  ["usr_01jd92", "MANAGER", "acc_meridien"],
] as const;
const TABLES = ["customer", "shipment", "payment", "account", "order", "notification", "session", "task", "user"];
const STATEMENTS = (table: string) => [
  `SELECT * FROM "${table}" WHERE "id" = $1 LIMIT 1`,
  `SELECT "id", "status", "created_at" FROM "${table}" WHERE "account_id" = $1 ORDER BY "created_at" DESC LIMIT $2`,
  `UPDATE "${table}" SET "updated_at" = $1 WHERE "id" = $2`,
];

const rand = (max = 1) => Math.random() * max;
const pick = <T>(list: readonly T[]) => list[Math.floor(rand(list.length))]!;
const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const ns = (ms: number) => `${BigInt(Math.round(ms * 1000)) * 1000n}`;
const attr = (map: Record<string, unknown>) =>
  Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: typeof value === "number" ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }) : typeof value === "boolean" ? { boolValue: value } : { stringValue: String(value) } }));

const resource = (service: string, instance: string, environment: string, version = "1ed5c2dc") => ({
  attributes: attr({ "service.name": service, "service.version": version, "service.instance.id": instance, "deployment.environment.name": environment }),
});

type Batch = { spans: Map<string, any[]>; logs: Map<string, any[]> };
const add = (map: Map<string, any[]>, key: string, value: any) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

function span(trace: string, parent: string, name: string, kind: number, start: number, duration: number, attributes: Record<string, unknown>, error?: string, events?: any[]) {
  const id = hex(8);
  return {
    traceId: trace,
    spanId: id,
    parentSpanId: parent,
    name,
    kind,
    startTimeUnixNano: ns(start),
    endTimeUnixNano: ns(start + duration),
    attributes: attr(attributes),
    status: error ? { code: 2, message: error } : { code: 1 },
    events: events ?? [],
  };
}

function request(batch: Batch, t: number, environment: string, instance: string) {
  let x = rand(ROUTES.reduce((sum, r) => sum + r[4], 0));
  let route: (typeof ROUTES)[number] = ROUTES[0];
  for (const r of ROUTES) {
    x -= r[4];
    if (x <= 0) {
      route = r;
      break;
    }
  }
  const [method, pattern, name, base] = route;
  const user = pick(USERS);
  const trace = hex(16);
  const key = `acme-api|${instance}|${environment}|${versionAt(t)}`;
  const refused = pattern.includes("register") && rand() < 0.04;
  const denied = !refused && rand() < 0.012;
  const invalid = !refused && !denied && rand() < 0.015;
  const status = refused ? 502 : denied ? 401 : invalid ? 422 : method === "POST" ? 201 : 200;
  const duration = refused ? 900 + rand(600) : Math.max(4, base * (0.4 + Math.pow(rand(), 2.6) * 3.4));
  const root = span(trace, "", `${method} ${pattern}`, 2, t, duration, { "http.request.method": method, "http.route": pattern, "http.response.status_code": status, "user.id": user[0], "workspace.accountId": user[2] }, status >= 500 ? `HTTP ${status}` : undefined);
  add(batch.spans, key, root);
  let cursor = t + 2;
  const repeat = pattern.includes("register") || rand() < 0.1;
  const queries = denied ? 1 : Math.round(2 + duration / 60 + rand(3));
  let dbMs = 0;
  let repeated = 0;
  add(batch.spans, key, span(trace, root.spanId, "pg.query:SELECT session", 3, cursor, 6, { "db.system": "postgresql", "db.query.text": 'SELECT * FROM "session" WHERE "token" = $1 LIMIT 1', "server.address": "postgres" }));
  cursor += 8;
  dbMs += 6;
  if (!denied) {
    for (let i = 0; i < queries && cursor < t + duration * 0.8; i++) {
      const table = pick(TABLES);
      const statement = STATEMENTS(table)[Math.floor(rand(3))]!;
      const d = 1 + rand(Math.max(4, duration / 14));
      add(batch.spans, key, span(trace, root.spanId, `pg.query:${statement.split(" ")[0]} ${table}`, 3, cursor, d, { "db.system": "postgresql", "db.query.text": statement, "server.address": "postgres" }));
      cursor += d + 0.4;
      dbMs += d;
    }
    if (repeat) {
      repeated = 6 + Math.floor(rand(10));
      for (let i = 0; i < repeated; i++) {
        const d = 3 + rand(9);
        add(batch.spans, key, span(trace, root.spanId, "pg.query:SELECT customer", 3, cursor, d, { "db.system": "postgresql", "db.query.text": 'SELECT * FROM "customer" WHERE "id" = $1', "server.address": "postgres" }));
        cursor += d;
        dbMs += d;
      }
    }
    if (rand() < 0.35) add(batch.spans, key, span(trace, root.spanId, "redis.get", 3, cursor, 1 + rand(2), { "db.system": "redis", "server.address": "redis", "db.operation.name": "GET" }));
  }
  const attributes: Record<string, unknown> = {
    operation: name.replace("v1.", ""),
    action: name.replace("v1.", "").replace(".", "_"),
    outcome: refused || invalid ? "failed" : denied ? "denied" : "succeeded",
    durationMs: Math.round(duration),
    status,
    method,
    path: pattern.replace(":id", `01j${hex(4)}`),
    "route.name": name,
    "route.pattern": pattern,
    requestId: `req_${hex(6)}`,
    "user.id": user[0],
    "user.adminRole": user[1],
    "workspace.accountId": user[2],
    "workspace.view": user[1] === "CLIENT" ? "client" : "admin",
    "db.queries": queries + repeated + 1,
    "db.durationMs": Math.round(dbMs),
    "db.repeatedQueries": repeated,
    "db.repeatedStatement": repeated ? 'SELECT * FROM "customer" WHERE "id" = $1' : undefined,
    "userAgent.browser.name": "Chrome",
    "userAgent.browser.version": "142",
    "userAgent.os.name": "macOS",
  };
  if (denied) attributes.reason = "HTTP_401";
  if (invalid) attributes.reason = "E_VALIDATION_ERROR";
  if (refused) {
    const start = t + duration * 0.25;
    const d = duration * 0.62;
    add(batch.spans, key, span(trace, root.spanId, "POST api.parcelo.example", 3, start, d, { "http.request.method": "POST", "url.full": "https://api.parcelo.example/v2/shipments", "server.address": "api.parcelo.example", "http.response.status_code": 412, "parcelo.operation": "createShipment" }, "412 ADDRESS_UNDELIVERABLE"));
    Object.assign(attributes, {
      reason: "PARCELO_ADDRESS_REFUSED",
      why: "Parcelo refused the shipment: the address cannot be delivered with EXPRESS48.",
      fix: "Fix the address on the order, or ship it with another service.",
      link: "https://docs.acme.example/parcelo#one-label-per-order",
      "error.name": "ParceloAddressRefused",
      "error.message": "412 ADDRESS_UNDELIVERABLE on EXPRESS48",
      "error.stack": "ParceloAddressRefused: 412 ADDRESS_UNDELIVERABLE on EXPRESS48\n    at ShipmentService.create (app/modules/parcelo/services/shipment.service.ts:152:13)\n    at OrdersController.checkout (app/modules/orders/controllers/shipments.controller.ts:88:5)",
      "parcelo.operation": "createShipment",
      "parcelo.topic": "shipments",
      "parcelo.outcome": "refused",
      "parcelo.remote.status": 412,
      "parcelo.remote.durationMs": Math.round(d),
      "parcelo.serviceCode": "EXPRESS48",
    });
  }
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  add(batch.logs, key, {
    timeUnixNano: ns(t + duration),
    severityText: level,
    severityNumber: level === "error" ? 17 : level === "warn" ? 13 : 9,
    body: { stringValue: `${method} ${pattern} ${status} in ${Math.round(duration)}ms` },
    attributes: attr(attributes),
    traceId: trace,
    spanId: root.spanId,
  });
}

type Attempt = { trace: string; kind: string; key: string; taskId: string; number: number; integration: string; fails?: { type: "retry" | "fail"; code: string; why: string; fix: string; errorName: string; message: string; status?: number }; duration: number; host?: string; method?: string; path?: string; status?: number; extra?: Record<string, unknown>; account?: string; user?: string; causedBy?: string; waitMs?: number };

const hostSpanName = (method: string, host: string) => `${method} ${host}`;

function taskAttempt(batch: Batch, t: number, environment: string, a: Attempt) {
  const worker = `worker-${1 + Math.floor(rand(2))}`;
  const key = `acme-worker|${worker}|${environment}|${versionAt(t)}`;
  const failed = Boolean(a.fails);
  const root = span(a.trace, "", `task ${a.kind}`, 5, t, a.duration, { "task.kind": a.kind, "task.id": a.taskId, "task.attempt": a.number, "task.key": a.key }, failed ? "attempt failed" : undefined);
  add(batch.spans, key, root);
  const queries = 2 + Math.floor(rand(7));
  let cursor = t + 2;
  let dbMs = 0;
  add(batch.logs, key, { timeUnixNano: ns(t + 1), severityText: "info", severityNumber: 9, body: { stringValue: `Starting ${a.kind}, attempt ${a.number}` }, attributes: attr({ logger: "tasks" }), traceId: a.trace, spanId: root.spanId });
  for (let i = 0; i < queries; i++) {
    const table = pick(["task", "payment", "shipment", "receipt"]);
    const statement = STATEMENTS(table)[Math.floor(rand(3))]!;
    const d = 1 + rand(Math.min(14, a.duration / (queries * 3) + 1));
    add(batch.spans, key, span(a.trace, root.spanId, `pg.query:${statement.split(" ")[0]} ${table}`, 3, cursor, d, { "db.system": "postgresql", "db.query.text": statement, "server.address": "postgres" }));
    cursor += d + 0.5;
    dbMs += d;
  }
  const remote = a.host ? Math.min(a.duration * 0.7, a.duration - (cursor - t)) : 0;
  if (a.host) {
    const status = a.fails?.status ?? a.status ?? (a.method === "POST" ? 201 : 200);
    add(batch.spans, key, span(a.trace, root.spanId, hostSpanName(a.method!, a.host), 3, cursor, Math.max(remote, 5), { "http.request.method": a.method, "url.full": `https://${a.host}${a.path}`, "server.address": a.host, "http.response.status_code": status }, status >= 400 ? `HTTP ${status} ${a.fails?.code ?? ""}`.trim() : undefined));
  }
  // Real tasks often decide there is nothing to do. A skip is not a failure, and the data must show that.
  const skip = !failed && (a.kind === "parcelo.ship" || a.kind === "tax.declare") && rand(1) < 0.07 ? "NOT_SHIPPABLE" : "";
  const attributes: Record<string, unknown> = {
    operation: `task.${a.kind}`,
    action: "task.attempt",
    outcome: failed ? "failed" : skip ? "skipped" : "succeeded",
    ...(skip ? { "taskOutcome.reason": skip } : {}),
    durationMs: Math.round(a.duration),
    "task.kind": a.kind,
    "task.key": a.key,
    "task.id": a.taskId,
    "task.run": 1,
    "task.attempt": a.number,
    "task.integration": a.integration,
    "task.waitMs": a.waitMs ?? Math.round(120 + rand(1400)),
    "task.causedBy": a.causedBy,
    "taskOutcome.type": skip ? "SKIP" : (a.fails?.type ?? "done").toUpperCase(),
    workerId: worker,
    "db.queries": queries,
    "db.durationMs": Math.round(dbMs),
    "db.repeatedQueries": 0,
    "user.id": a.user,
    "workspace.accountId": a.account,
    ...a.extra,
  };
  if (a.fails) {
    Object.assign(attributes, { reason: a.fails.code, "taskOutcome.code": a.fails.code, why: a.fails.why, fix: a.fails.fix, "error.name": a.fails.errorName, "error.message": a.fails.message, "error.stack": `${a.fails.errorName}: ${a.fails.message}\n    at ${a.kind.split(".")[0]}Client.request (app/modules/${a.kind.split(".")[0]}/services/${a.kind.split(".")[0]}.client.ts:92:13)\n    at ${a.kind.replace(/\W/g, "_")}.handle (app/modules/${a.kind.split(".")[0]}/handlers/${a.kind.split(".")[1] ?? "main"}.handler.ts:41:20)\n    at TaskRunner.run (node_modules/@acme/tasks/runner.js:88:5)` });
  }
  add(batch.logs, key, {
    timeUnixNano: ns(t + a.duration),
    severityText: failed ? "error" : "info",
    severityNumber: failed ? 17 : 9,
    body: { stringValue: `task ${a.kind} ${failed ? (a.fails!.type === "retry" ? "will retry" : "failed") : "ok"} in ${Math.round(a.duration)}ms` },
    attributes: attr(attributes),
    traceId: a.trace,
    spanId: root.spanId,
  });
}

const id26 = () => `01j${hex(5)}`;
const RATE_LIMIT = { type: "retry" as const, code: "PROVIDER_RATE_LIMITED", why: "Parcelo answered 429 after 3 calls in 10 s.", fix: "The retry is scheduled in 1 min. Lower parcelo.ship concurrency if this repeats.", errorName: "ProviderRateLimited", message: "429 from Parcelo", status: 429 };
const COUNTRY = { type: "fail" as const, code: "INVOXA_INVALID_COUNTRY", why: "Invoxa rejected country code FX for this client.", fix: "Map France to FR in the Invoxa client sync.", errorName: "InvoxaInvalidCountryError", message: "Invalid country code FX", status: 400 };
const TEMPLATES = ["order-receipt", "order-shipped", "invitation", "password-reset", "invoice-issued"];

/** One order travelling from payment to parcel, so processes have real instances, some stuck. */
function orderFlow(batch: Batch, t: number, environment: string) {
  const order = id26();
  const key = `order:${order}`;
  const user = pick(USERS);
  const shared = { key, account: user[2] };
  const ingestDur = 400 + rand(1500);
  const ingestFails = rand() < 0.004;
  taskAttempt(batch, t, environment, {
    ...shared,
    trace: hex(16),
    kind: "paynest.payment.ingest",
    taskId: `tsk_${hex(6)}`,
    number: 1,
    integration: "paynest",
    duration: ingestDur,
    host: "api.paynest.example",
    method: "GET",
    path: "/v1/payments",
    fails: ingestFails ? { type: "fail", code: "PAYNEST_AMOUNT_MISMATCH", why: "The amount paid does not match the order.", fix: "Check the payment on Paynest, then requeue this task.", errorName: "PaynestAmountMismatch", message: "Amount does not match the order", status: 200 } : undefined,
    extra: { "paynest.provider": "paynest", "paynest.remote.lastOperation": "getPayment", "paynest.remote.requestCount": 1 + Math.floor(rand(4)), "paynest.remote.durationMs": Math.round(ingestDur * 0.7), "paynest.remote.lastStatus": 200, "paymentIngest.result": ingestFails ? "failed" : "stored", "paymentIngest.resultId": `res_${hex(4)}` },
  });
  if (ingestFails) return;
  let at = t + ingestDur + 200;
  taskAttempt(batch, at, environment, { ...shared, trace: hex(16), kind: "receipts.render", taskId: `tsk_${hex(6)}`, number: 1, integration: "platform", duration: 300 + rand(1600) });
  at += 300;
  const template = rand() < 0.8 ? "order-receipt" : "order-shipped";
  const refused = rand() < 0.01;
  taskAttempt(batch, at, environment, {
    ...shared,
    trace: hex(16),
    kind: "receipts.email",
    taskId: `tsk_${hex(6)}`,
    number: 1,
    integration: "platform",
    duration: 120 + rand(300),
    host: "api.postwing.example",
    method: "POST",
    path: "/v2/email/outbound-emails",
    fails: refused ? { type: "fail", code: "POSTWING_THROTTLED", why: "Postwing refused the send: maximum sending rate exceeded.", fix: "Requeue this task. Raise the Postwing quota if it repeats.", errorName: "Throttling", message: "Maximum sending rate exceeded", status: 429 } : undefined,
    extra: { "emails.sent": refused ? 0 : 1, "emails.failed": refused ? 1 : 0, "emails.durationMs": Math.round(60 + rand(220)), "emails.template": template, "emails.error": refused ? "Throttling: Maximum sending rate exceeded" : undefined },
  });
  at += 300;
  const deliverId = `tsk_${hex(6)}`;
  const limited = rand() < 0.07;
  const proc = (number: number, atTime: number, fails?: typeof RATE_LIMIT) => {
    const d = 500 + rand(1800);
    taskAttempt(batch, atTime, environment, {
      ...shared,
      trace: hex(16),
      kind: "parcelo.ship",
      taskId: deliverId,
      number,
      integration: "parcelo",
      duration: d,
      host: "api.parcelo.example",
      method: "POST",
      path: "/v2/shipments",
      fails,
      extra: { "parcelo.operation": "createShipment", "parcelo.topic": "shipments", "parcelo.outcome": fails ? "rate_limited" : "delivered", "parcelo.remote.requestCount": 1 + Math.floor(rand(3)), "parcelo.remote.durationMs": Math.round(d * 0.7), "parcelo.remote.lastStatus": fails ? 429 : 201, "parcelo.serviceCode": pick(["EXPRESS48", "EXPRESS48", "RS6312"]) },
    });
  };
  proc(1, at, limited ? RATE_LIMIT : undefined);
  // Mostly it recovers a minute later. Recent ones are still waiting, which is what "stuck" looks like.
  if (limited && Date.now() - t > 3_600_000) proc(2, at + 60_000 + rand(4000));
  if (rand() < 0.2) taskAttempt(batch, at + 200, environment, { ...shared, trace: hex(16), kind: "tax.declare", taskId: `tsk_${hex(6)}`, number: 1, integration: "taxbox", duration: 300 + rand(900), host: "api.taxbox.example", method: "POST", path: "/v1/declarations" });
}

function billingFlow(batch: Batch, t: number, environment: string) {
  const user = pick(USERS);
  const key = `invoice:${id26()}`;
  const bad = rand() < 0.16;
  taskAttempt(batch, t, environment, { key, account: user[2], trace: hex(16), kind: "invoxa.customer.sync", taskId: `tsk_${hex(6)}`, number: 1, integration: "invoxa", duration: 400 + rand(1500), host: "api.invoxa.example", method: "POST", path: "/api/v1/clients", fails: bad ? COUNTRY : undefined, extra: { "invoxa.operation": "createClient", "invoxa.client": `cli_${hex(3)}` } });
  if (!bad) taskAttempt(batch, t + 1800, environment, { key, account: user[2], trace: hex(16), kind: "invoxa.invoices.sync", taskId: `tsk_${hex(6)}`, number: 1, integration: "invoxa", duration: 300 + rand(900), host: "api.invoxa.example", method: "POST", path: "/api/v1/invoices", extra: { "invoxa.operation": "pushInvoice", "emails.sent": rand() < 0.3 ? 1 : 0, "emails.template": "invoice-issued" } });
}

const CLOCKS: [string, number, string, string, string, string, number][] = [
  ["paynest.scan", 5, "paynest", "api.paynest.example", "GET", "/v1/scan", 1800],
  ["parcelo.tracking.read", 5, "parcelo", "api.parcelo.example", "GET", "/v2/shipments", 2600],
  ["emails.delivery-check", 15, "platform", "api.postwing.example", "POST", "/v2/insights", 1100],
  ["carts.sweep", 15, "platform", "", "", "", 280],
  ["webhooks.collect", 5, "platform", "", "", "", 140],
  ["billing.invoices.overdue", 1440, "platform", "", "", "", 900],
  ["accounts.company-register.refresh", 1440, "platform", "api.registry.example", "GET", "/v1/companies", 2400],
  ["tasks.reconcile", 1440, "platform", "", "", "", 420],
  ["tasks.maintenance", 1440, "platform", "", "", "", 880],
];

function clocks(batch: Batch, t: number, environment: string) {
  const minute = Math.floor(t / 60_000);
  for (const [kind, every, integration, host, method, path, base] of CLOCKS) {
    if (minute % every !== 0) continue;
    const extra: Record<string, unknown> = {};
    if (kind === "parcelo.tracking.read") Object.assign(extra, { "parcelo.operation": "readTracking", "parcelo.topic": "shipments", "parcelo.outcome": "ok", "parcelo.pages": 1 + Math.floor(rand(3)), "parcelo.parcelsTracked": Math.floor(rand(60)), "parcelo.parcelsDelivered": Math.floor(rand(50)), "parcelo.parcelsUnmatched": rand() < 0.2 ? Math.floor(rand(4)) : 0 });
    if (kind === "paynest.scan") Object.assign(extra, { "paynest.provider": "paynest", "paynest.remote.lastOperation": "scanPayments", "paynest.remote.requestCount": 1 + Math.floor(rand(6)), "paynest.remote.durationMs": Math.round(base * 0.7), "paynest.remote.lastStatus": 200 });
    if (kind === "emails.delivery-check") {
      const checked = 10 + Math.floor(rand(40));
      const bounced = rand() < 0.12 ? 1 : 0;
      Object.assign(extra, { "emailDeliveries.checked": checked, "emailDeliveries.delivered": checked - bounced, "emailDeliveries.bounced": bounced, "emailDeliveries.complained": rand() < 0.02 ? 1 : 0 });
    }
    taskAttempt(batch, t, environment, { key: `clock:${kind}`, trace: hex(16), kind, taskId: `tsk_${hex(6)}`, number: 1, integration, duration: base * (0.5 + rand(1.2)), host: host || undefined, method, path, extra });
  }
}

function extras(batch: Batch, t: number, environment: string) {
  const key = `acme-api|api-7f9c|${environment}|${versionAt(t)}`;
  const log = (level: string, body: string, attributes: Record<string, unknown>, trace = hex(16)) =>
    add(batch.logs, key, { timeUnixNano: ns(t), severityText: level, severityNumber: level === "error" ? 17 : level === "warn" ? 13 : 9, body: { stringValue: body }, attributes: attr(attributes), traceId: trace, spanId: hex(8) });
  if (rand() < 0.5) {
    const failed = rand() < 0.012;
    const feature = pick(["translation", "translation", "translation", "form builder", "support replies"]);
    const tokens = 400 + Math.floor(rand(6000));
    log(failed ? "error" : "info", `ai ${feature} ${failed ? "failed" : "ok"}`, { operation: `ai.${feature.replace(" ", "_")}`, "ai.feature": feature, "ai.model": "openai/gpt-6-luna", "ai.tokens": tokens, "ai.costUsd": Number((tokens * 0.000002).toFixed(5)), "ai.durationMs": Math.round(600 + rand(3000)), "ai.outcome": failed ? "failed" : "ok", "ai.error": failed ? pick(["Rate limited by the gateway", "Output did not match the schema"]) : undefined, "user.id": pick(USERS)[0] });
  }
  if (rand() < 0.35) {
    const [path, method] = pick([["/wp-login.php", "GET"], ["/.env", "GET"], ["/xmlrpc.php", "POST"], ["/v1/customer", "GET"]] as const);
    log("warn", `${method} ${path} 404`, { method, path, status: 404, outcome: "failed", durationMs: 2 + Math.floor(rand(4)), reason: "E_ROUTE_NOT_FOUND" });
  }
  if (rand() < 0.5) {
    const [apiKey, account] = pick([["key_8f21", "acc_horizon"], ["key_3a90", "acc_meridien"], ["key_77cd", "acc_lingua"]] as const);
    const denied = rand() < 0.03;
    const trace = hex(16);
    const duration = 20 + rand(180);
    const root = span(trace, "", "GET /api/public/v1/orders", 2, t, duration, { "http.request.method": "GET", "http.route": "/api/public/v1/orders", "http.response.status_code": denied ? 403 : 200 });
    add(batch.spans, key, root);
    log(denied ? "warn" : "info", `GET /api/public/v1/orders ${denied ? 403 : 200} in ${Math.round(duration)}ms`, { method: "GET", path: "/api/public/v1/orders", "route.pattern": "/api/public/v1/orders", "route.name": "public.results.index", status: denied ? 403 : 200, outcome: denied ? "denied" : "succeeded", durationMs: Math.round(duration), reason: denied ? pick(["Outside this account", "Missing permission", "Key expired"]) : undefined, "apiKey.id": apiKey, "workspace.accountId": account, "db.queries": 3, "db.durationMs": 11 }, trace);
  }
  if (rand() < 0.08) {
    const user = pick(USERS);
    const key2 = `acme-worker|worker-1|${environment}|${versionAt(t)}`;
    taskAttempt(batch, t, environment, { key: `company:${hex(3)}`, trace: hex(16), kind: "pipedeck.company.sync", taskId: `tsk_${hex(6)}`, number: 1, integration: "pipedeck", duration: 200 + rand(700), host: "api.pipedeck.example", method: "POST", path: "/crm/v3/objects/companies", account: user[2] });
    void key2;
  }
  if (rand() < 0.05) {
    const user = pick(USERS);
    taskAttempt(batch, t, environment, { key: `export:${id26()}`, trace: hex(16), kind: "exports.process", taskId: `tsk_${hex(6)}`, number: 1, integration: "platform", duration: 3000 + rand(9000), account: user[2], user: user[0] });
  }
  if (rand() < 0.1) taskAttempt(batch, t, environment, { key: `customer:${id26()}`, trace: hex(16), kind: "paynest.customer.create", taskId: `tsk_${hex(6)}`, number: 1, integration: "paynest", duration: 300 + rand(900), host: "api.paynest.example", method: "POST", path: "/v1/customers" });
}

const VERSIONS = [
  { at: 18, version: "5b8e5172" },
  { at: 9, version: "f60fa664" },
  { at: 5, version: "287f5d61" },
  { at: 0, version: "1ed5c2dc" },
];
let seedNow = Date.now();
function versionAt(t: number) {
  const hoursAgo = (seedNow - t) / 3_600_000;
  for (const v of VERSIONS) if (hoursAgo >= v.at) return v.version;
  return "1ed5c2dc";
}

function metricsPayload(t: number, environment: string) {
  const resources: any[] = [];
  for (const [service, instance] of [["acme-api", "api-7f9c"], ["acme-worker", "worker-1"], ["acme-worker", "worker-2"]] as const) {
    const wave = Math.sin(t / 900_000 + instance.length) * 0.5 + 0.5;
    const gauge = (name: string, unit: string, description: string, value: number, attributes: Record<string, unknown> = {}) => ({ name, unit, description, gauge: { dataPoints: [{ timeUnixNano: ns(t), asDouble: value, attributes: attr(attributes) }] } });
    const metrics = [
      gauge("process.cpu.utilization", "%", "CPU in use", 6 + wave * 16 + rand(3)),
      gauge("process.memory.usage", "MB", "Resident memory", 240 + wave * 60 + rand(8)),
      gauge("v8.heap.used", "MB", "Heap used", 130 + wave * 50 + rand(6)),
      gauge("nodejs.eventloop.delay.p99", "ms", "Event loop delay, 99th percentile", 6 + wave * 9 + rand(3)),
      gauge("db.client.connection.count", "connections", "Open Postgres connections", 3 + Math.round(wave * 5), { state: "used" }),
      gauge("db.client.connection.count", "connections", "Open Postgres connections", 10 + Math.round((1 - wave) * 6), { state: "idle" }),
      {
        name: "http.server.request.duration",
        unit: "s",
        description: "Duration of HTTP requests",
        histogram: { aggregationTemporality: 1, dataPoints: [{ timeUnixNano: ns(t), count: "20", sum: 4.2 + rand(), bucketCounts: ["2", "6", "8", "3", "1", "0"], explicitBounds: [0.01, 0.05, 0.1, 0.5, 1], attributes: attr({ "http.request.method": "GET" }) }] },
      },
    ];
    if (service === "acme-worker" && instance === "worker-1") {
      for (const [state, value] of [["due", 8 + rand(14)], ["scheduled", 170 + rand(30)], ["running", 2 + rand(5)], ["held", 2]] as const) metrics.push(gauge("vigie.tasks.backlog", "tasks", "Tasks by state", value, { "task.state": state }));
      metrics.push(gauge("vigie.tasks.oldest_due_age", "s", "Age of the oldest task waiting for a worker", 4 + rand(20)));
    }
    resources.push({ resource: resource(service, instance, environment), scopeMetrics: [{ scope: { name: "vigie-seed" }, metrics }] });
  }
  return { resourceMetrics: resources };
}

async function post(target: string, path: string, payload: unknown, key?: string) {
  const response = await fetch(`${target}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: key } : {}) }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
}

async function send(target: string, batch: Batch, key?: string) {
  const parts = (id: string) => {
    const [service, instance, environment, version] = id.split("|") as [string, string, string, string];
    return resource(service, instance, environment, version);
  };
  const scope = { name: "vigie-seed" };
  if (batch.spans.size) await post(target, "/v1/traces", { resourceSpans: [...batch.spans].map(([id, spans]) => ({ resource: parts(id), scopeSpans: [{ scope, spans }] })) }, key);
  if (batch.logs.size) await post(target, "/v1/logs", { resourceLogs: [...batch.logs].map(([id, logRecords]) => ({ resource: parts(id), scopeLogs: [{ scope, logRecords }] })) }, key);
}

export type SeedOptions = { target: string; hours: number; environment: string; rate: number; live: boolean; key?: string };

export async function seed(options: SeedOptions) {
  const { target, hours, environment, rate, key } = options;
  seedNow = Date.now();
  const start = seedNow - hours * 3_600_000;
  const stepMs = 60_000;
  let produced = 0;
  for (let t = start; t < seedNow; t += stepMs) {
    const batch: Batch = { spans: new Map(), logs: new Map() };
    const shape = 0.6 + 0.4 * Math.sin((t / 3_600_000 / 24) * Math.PI * 2 - 1);
    const count = Math.round(rate * shape * (0.7 + rand(0.6)));
    for (let i = 0; i < count; i++) request(batch, t + rand(stepMs), environment, "api-7f9c");
    for (let i = 0; i < Math.round(count * 0.28); i++) orderFlow(batch, t + rand(stepMs), environment);
    if (rand() < 0.3) billingFlow(batch, t + rand(stepMs), environment);
    clocks(batch, t, environment);
    extras(batch, t + rand(stepMs), environment);
    produced += count * 2;
    await send(target, batch, key);
    await post(target, "/v1/metrics", metricsPayload(t, environment), key);
  }
  console.log(`Sent about ${Math.round(produced)} wide events covering the last ${hours} h.`);
  if (!options.live) return;
  console.log("Sending live traffic. Press Ctrl+C to stop.");
  let lastMinute = 0;
  while (true) {
    const batch: Batch = { spans: new Map(), logs: new Map() };
    const now = Date.now();
    seedNow = now;
    const count = Math.round(rate / 40 + rand(rate / 20));
    for (let i = 0; i < count; i++) request(batch, now - rand(800), environment, "api-7f9c");
    if (rand() < rate / 200) orderFlow(batch, now - rand(800), environment);
    if (rand() < 0.01) billingFlow(batch, now, environment);
    if (Math.floor(now / 60_000) !== lastMinute) {
      lastMinute = Math.floor(now / 60_000);
      clocks(batch, now, environment);
    }
    if (rand() < 0.1) extras(batch, now, environment);
    // A restarting server must not end the traffic: this batch is dropped and the next one retries.
    await send(target, batch, key).catch(() => {});
    if (Math.floor(now / 1000) % 15 === 0) await post(target, "/v1/metrics", metricsPayload(now, environment), key).catch(() => {});
    await Bun.sleep(1000);
  }
}
