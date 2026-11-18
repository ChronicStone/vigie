// Drives the running app like a person. usage: node test/e2e/behaviour.mjs <base-url>
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:4310";
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on("console", async (m) => {
  if (m.type() !== "error" || /Failed to load resource/.test(m.text())) return;
  // React logs "%o %s" with the real error in its arguments, so read those.
  const args = await Promise.all(m.args().map((arg) => arg.evaluate((value) => (value instanceof Error ? value.stack : String(value))).catch(() => "")));
  problems.push(`console: ${args.join(" ").replace(/\s+/g, " ").slice(0, 500)}`);
});

let passed = 0;
const failures = [];
async function check(name, run) {
  problems.length = 0;
  try {
    await run();
    if (problems.length) throw new Error(problems.join(" | "));
    passed++;
    console.log(`ok    ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split("\n").slice(0, 3).join(" ")}`);
    await page.screenshot({ path: `/tmp/vigie-fail-${failures.length}.png` }).catch(() => {});
  }
}
const open = async (path) => {
  await page.goto(base + path, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
};
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`); };
const ok = (value, what) => { if (!value) throw new Error(what); };
const param = (name) => new URL(page.url()).searchParams.get(name);

await check("palette opens with the keyboard, finds a route and goes there", async () => {
  await open("/?range=24h");
  await page.keyboard.press("Meta+k");
  await page.locator("#cmdq").fill("register");
  await page.locator(".cmdi", { hasText: "/v1/orders/:id/checkout" }).first().waitFor({ timeout: 5000 });
  await page.locator(".cmdi", { hasText: "/v1/orders/:id/checkout" }).first().click();
  await page.waitForURL(/requests\/route/);
  ok(page.url().includes("range=24h"), "the time range must survive navigation");
  await page.locator(".dh h2", { hasText: "register" }).waitFor();
});

await check("g then l jumps to logs", async () => {
  await open("/");
  await page.keyboard.press("g");
  await page.keyboard.press("l");
  await page.waitForURL(/\/logs/);
});

await check("logs: opening an event shows why and fix, Esc closes, j moves", async () => {
  await open("/logs?range=24h&level=error");
  await page.locator(".lrow").first().waitFor();
  await page.locator(".lrow").first().click();
  await page.locator(".panel .hero").waitFor();
  ok(param("event"), "the event must be in the URL");
  await page.locator(".panel .why").waitFor();
  const first = param("event");
  await page.keyboard.press("j");
  await page.waitForFunction((id) => new URL(location.href).searchParams.get("event") !== id, first);
  await page.keyboard.press("Escape");
  await page.locator(".panel").waitFor({ state: "detached" });
});

await check("code is highlighted: SQL in the list, as you type in the console", async () => {
  await open("/queries?range=24h");
  await page.locator("tbody .hl-keyword").first().waitFor();
  ok((await page.locator("tbody .hl-keyword").first().innerText()).trim().length > 0, "a keyword must be coloured");
  await open("/console");
  const editor = page.getByRole("textbox", { name: "Query" });
  await editor.fill("SELECT 1 AS one, '<img src=x onerror=window.pwned=1>' AS s");
  await page.locator(".hled pre .hl-keyword", { hasText: "SELECT" }).waitFor();
  ok((await page.locator(".hled pre .hl-string").first().innerText()).includes("<img"), "markup in a string must stay text");
  ok(!(await page.evaluate(() => window.pwned)), "telemetry text must never run");
  ok((await page.locator(".hled pre img").count()) === 0, "telemetry text must never become markup");
});

await check("motion: the clock cursor fades, and a tab or a sort fades its content", async () => {
  await open("/emails?range=24h");
  const lane = page.locator(".lane").first();
  await lane.waitFor();
  const box = await lane.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator(".lntip.on").waitFor();
  ok((await page.locator(".lntip").evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration))) > 0, "the tooltip must fade");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(30);
  ok((await page.locator(".lntip").count()) === 1, "leaving must fade out, not unmount");
  const fading = () => page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getKeyframes?.().some((k) => k.opacity !== undefined)).length);
  await open("/queries?range=24h");
  await page.locator(".seg button", { hasText: "By entry point" }).click();
  ok((await fading()) > 0, "switching tab must animate the content");
  await page.locator(".seg button", { hasText: "Statements" }).click();
  await page.locator("tbody tr").first().waitFor();
  await page.waitForTimeout(350);
  await page.locator("thead th button", { hasText: "Runs" }).click();
  ok((await fading()) > 0, "sorting must animate the rows");
});

await check("logs: event tabs all render", async () => {
  await open("/logs?range=24h&level=error");
  await page.locator(".lrow").first().click();
  await page.locator(".panel .hero").waitFor();
  await page.locator(".ptab", { hasText: "JSON" }).click();
  await page.locator(".panel .code .hl-property").first().waitFor();
  await page.locator(".ptab", { hasText: "Just before" }).click();
  await page.locator(".same").first().waitFor();
});

await check("logs: search syntax filters on the server", async () => {
  await open("/logs?range=24h");
  await page.locator("#q").fill("status>=500");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => new URL(location.href).searchParams.get("q") === "status>=500");
  await page.waitForTimeout(800);
  const statuses = await page.locator(".lrow .hd .err").allTextContents();
  ok(statuses.length > 0, "there must be 5xx rows");
  ok(statuses.every((s) => Number(s) >= 500), `all rows must be 5xx, got ${statuses.slice(0, 5)}`);
});

await check("logs: + Filter builds a token, survives reload, and can be removed", async () => {
  await open("/logs?range=24h");
  await page.locator(".addf").click();
  await page.locator(".pitem", { hasText: "service" }).first().click();
  await page.locator(".pitem", { hasText: "acme-worker" }).click();
  await page.keyboard.press("Escape");
  await page.locator(".tok", { hasText: "acme-worker" }).waitFor();
  await page.waitForTimeout(600);
  const services = await page.locator(".lrow .ls").allTextContents();
  ok(services.length && services.every((s) => s === "worker"), "only worker rows");
  await page.reload();
  await page.locator(".tok", { hasText: "acme-worker" }).waitFor();
  await page.locator(".tok .x").click();
  await page.locator(".tok").waitFor({ state: "detached" });
});

await check("logs: scrolling loads more rows, and only a window is in the DOM", async () => {
  await open("/logs?range=24h");
  await page.locator(".lrow").first().waitFor();
  await page.locator(".lvscroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(1200);
  const tall = await page.locator(".lvscroll").evaluate((el) => el.scrollHeight);
  ok(tall > 200 * 30, `more than one page loaded, list is ${tall}px tall`);
  ok((await page.locator(".lrow").count()) < 120, "virtualized");
});

await check("logs: live toggle streams new rows", async () => {
  await open("/logs?range=15m");
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".lrow.fresh"), null, { timeout: 15000 });
  await page.getByRole("button", { name: "Live", exact: true }).click();
});

await check("spine: dragging zooms every screen, and Clear undoes it", async () => {
  await open("/logs?range=24h");
  const box = await page.locator(".spine .hist").boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + 10, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("from"));
  await page.locator(".bclear").click();
  await page.waitForFunction(() => !new URL(location.href).searchParams.get("from"));
});

await check("environment switch changes the data and stays in the URL", async () => {
  await open("/requests?range=24h");
  const before = await page.locator("[data-testid=routes] tbody tr").first().textContent();
  await page.locator('[aria-label="Environment"] button', { hasText: "Test" }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("env") === "STG");
  await page.waitForTimeout(800);
  ok((await page.locator("[data-testid=routes] tbody tr").first().textContent()) !== before, "rows must change");
});

await check("tables: clicking a header sorts", async () => {
  await open("/requests?range=24h");
  await page.locator("[data-testid=routes] th button", { hasText: "p95" }).click();
  await page.waitForTimeout(150);
  const read = async () => (await page.locator("[data-testid=routes] tbody tr td:nth-child(4)").allTextContents()).map((t) => (t.endsWith(" s") ? parseFloat(t) * 1000 : parseFloat(t)));
  const values = await read();
  ok(values.length > 3 && values.every((v, i) => i === 0 || values[i - 1] >= v), `descending, got ${values}`);
  await page.locator("[data-testid=routes] th button", { hasText: "p95" }).click();
  await page.waitForTimeout(150);
  const asc = await read();
  ok(asc.every((v, i) => i === 0 || asc[i - 1] <= v), `ascending, got ${asc}`);
});

await check("trace page: a request opens here, a span selects, tabs work, the old address redirects", async () => {
  await open("/logs?range=24h&q=status%3E%3D500");
  await page.locator(".lrow").first().click();
  await page.locator(".pacts .btn.pri").click();
  await page.waitForURL(/traces\/[0-9a-f]+/);
  const id = new URL(page.url()).pathname.split("/").pop();
  await page.locator(".wr").nth(2).click();
  await page.locator(".ins h4").waitFor();
  ok(param("span"), "the span must be in the URL");
  await page.locator(".ptab", { hasText: "Queries" }).click();
  await page.locator(".trace-query").first().waitFor();
  await page.locator(".ptab", { hasText: "Error source" }).click();
  await page.locator(".frame").first().waitFor();
  await page.locator(".ptab", { hasText: "Wide event" }).click();
  await page.locator(".trace-pane .rd").first().waitFor();
  await open(`/requests/${id}?range=24h`);
  await page.waitForURL(new RegExp(`/traces/${id}`));
});

await check("traces: a row opens its trace, back returns to the list", async () => {
  await open("/traces?range=1h&f=error");
  await page.locator(".traces-row").first().click();
  await page.waitForURL(/traces\/[0-9a-f]+/);
  await page.locator(".wr").first().waitFor();
  await page.goBack();
  await page.waitForURL(/\/traces\?/);
  eq(param("f"), "error", "the filter survives going back");
});

await check("short ranges draw: 15 minutes has buckets under a minute", async () => {
  await open("/logs?range=15m");
  await page.locator(".spine .vchart").waitFor();
  eq(await page.locator("h3", { hasText: "This screen failed" }).count(), 0, "failed screens");
});

await check("task not run yet: a queued row from the app database opens", async () => {
  await open("/tasks/all?range=1h&state=QUEUED");
  await page.locator("[data-testid=tasks] tbody tr").first().locator("td").nth(2).click();
  await page.locator(".tasks-run-verdict", { hasText: /not run yet|A worker has it/ }).waitFor();
  await page.locator(".code .hl-property").first().waitFor();
});

await check("metrics: choosing a metric and an aggregate redraws", async () => {
  await open("/metrics?range=6h");
  await page.locator(".metrics-item", { hasText: "backlog" }).click();
  await page.locator(".metrics-title", { hasText: "vigie.tasks.backlog" }).waitFor();
  await page.locator(".metrics-row .m", { hasText: "due" }).waitFor();
  await page.locator(".metrics-controls .seg button", { hasText: "Highest" }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("agg") === "max");
});

await check("console: runs a query, refuses a write and an unknown table", async () => {
  await open("/console?range=24h");
  await page.locator(".conres table tbody tr").first().waitFor();
  await page.locator(".editor").fill("DROP TABLE logs");
  await page.locator("button", { hasText: "Run query" }).click();
  await page.locator(".conres .console-error", { hasText: "Only SELECT" }).waitFor();
  await page.locator(".editor").fill("SELECT * FROM system.users");
  await page.locator("button", { hasText: "Run query" }).click();
  await page.locator(".conres .console-error", { hasText: "Unknown table" }).waitFor();
});

await check("task run: the verdict, what happened, and its whole log", async () => {
  await open("/tasks/all?range=24h&kind=parcelo.ship&view=late");
  await page.goto(`${base}/tasks/all?range=24h&kind=parcelo.ship&state=DONE`);
  await page.locator("[data-testid=tasks] tbody tr").first().waitFor();
  await page.locator("[data-testid=tasks] tbody tr").first().locator("td").nth(2).click();
  await page.waitForURL(/tasks\/run\//);
  // The log is the page, every field of a line one click away.
  await page.locator(".tasks-run-verdict p").first().waitFor();
  await page.locator(".tasks-run-row").first().waitFor();
  await page.locator(".tasks-run-step").first().click();
  await page.waitForFunction(() => new URL(location.href).searchParams.has("at"));
});

await check("tasks: picking rows and starting a dry run stores it", async () => {
  await open("/tasks/all?range=24h&view=open");
  await page.locator("[data-testid=tasks] tbody tr").first().waitFor();
  // Vigie has its own login, so unless a deployment wires task actions, selection and the bulk page are not there at all.
  if (!(await page.locator(".chkb").count())) {
    eq(await page.locator(".ptab", { hasText: "Bulk" }).count(), 0, "bulk tab");
    await page.goto(`${base}/tasks/bulk`);
    await page.waitForURL(/tasks\/all/);
    return;
  }
  await page.locator(".chkb").first().click();
  await page.locator(".bulkbar a", { hasText: "requeue" }).click();
  await page.waitForURL(/tasks\/bulk/);
  await page.locator("input[name=reason]").fill("End to end test");
  await page.locator("button", { hasText: "Start the dry run" }).click();
  await page.locator(".tasks-bulk-facts", { hasText: "Will change" }).waitFor();
});

await check("issues: resolve, then reopen, both recorded", async () => {
  await open("/issues?range=24h");
  await page.locator("[data-testid=issues] a[data-row]").first().waitFor();
  await page.locator("[data-testid=issues] a[data-row]").first().click();
  await page.waitForURL(/issues\/.+/);
  await page.locator("button", { hasText: "Resolve" }).click();
  await page.locator(".schip", { hasText: "Resolved" }).waitFor();
  await page.locator("button", { hasText: "Reopen" }).click();
  await page.locator(".schip", { hasText: "Open" }).waitFor();
  await page.locator(".card", { hasText: "Activity" }).locator(".lst", { hasText: "Resolved" }).first().waitFor();
  const comment = `Looking at it ${Date.now()}`;
  await page.locator("input[aria-label='Add a comment']").fill(comment);
  await page.keyboard.press("Enter");
  await page.locator(".card", { hasText: "Activity" }).locator(".lst", { hasText: comment }).waitFor();
});

await check("alerts: creating one from a sentence, previewed, then opening it", async () => {
  await open("/alerts/new?range=24h");
  await page.locator(".alertnew-fam", { hasText: "Server errors" }).click();
  await page.locator("input[aria-label='Threshold percent']").fill("3");
  await page.locator("input[aria-label='Alert name']").fill("E2E server errors");
  await page.locator(".alertnew-verdict", { hasText: "last 7 days" }).waitFor();
  await page.locator("button", { hasText: "Create alert" }).click();
  await page.waitForURL(/alerts\/[0-9a-f-]{20,}/);
  await page.locator("h2", { hasText: "E2E server errors" }).waitFor();
  await page.locator("button", { hasText: "Pause" }).click();
  await page.locator(".schip", { hasText: "Paused" }).waitFor();
});

await check("settings: a token shows its secret once, and revoking removes it", async () => {
  await open("/settings/tokens");
  await page.locator("button", { hasText: "New token" }).click();
  await page.locator("input[name=name]").fill("E2E token");
  await page.locator("button", { hasText: "Create token" }).click();
  await page.locator(".stmt", { hasText: "shown once" }).waitFor();
  ok(/vm_/.test(await page.locator(".stmt button").textContent()), "an MCP token");
  await page.keyboard.press("Escape");
  const row = page.locator(".lst", { hasText: "E2E token" });
  await row.waitFor();
  await row.locator("button", { hasText: "Revoke" }).click();
  await page.locator(".dlg button", { hasText: "Revoke" }).click();
  await row.waitFor({ state: "detached" });
});

await check("overview: panels draw real charts, one cursor across all of them, a drag zooms", async () => {
  await open("/?range=24h");
  await page.locator(".dc-chart svg").first().waitFor();
  const first = page.locator(".dc").first();
  const box = await first.boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + 40);
  await page.locator(".dc-tip.on").first().waitFor();
  const { lines, charts, tips } = await page.evaluate(() => ({ lines: document.querySelectorAll(".dc-cur.on").length, charts: document.querySelectorAll(".dc").length, tips: document.querySelectorAll(".dc-tip.on").length }));
  if (lines !== charts || tips !== 1) throw new Error(`${lines} cursors on ${charts} charts, ${tips} readings`);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForURL(/from=\d+/);
});

await check("settings: redaction try-it masks an email", async () => {
  await open("/settings/redaction");
  await page.locator(".code", { hasText: "c***@example.com" }).waitFor();
});

await check("database: pill filters, foreign key follows, row opens, writes are refused", async () => {
  await open("/database?source=pg&table=task");
  await page.locator(".dbgrid tbody tr").first().waitFor();
  await page.locator(".dbgrid .epill").first().click();
  const state = (await page.locator(".tok .v").first().textContent()).trim();
  await page.waitForTimeout(500);
  const states = await page.locator(".dbgrid .epill").allTextContents();
  ok(states.length && states.every((s) => s === state), `only ${state}, got ${states.slice(0, 4)}`);
  await page.locator(".dbgrid .fk").first().click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("table") === "account");
  await page.locator(".tok", { hasText: "id" }).waitFor();
  await page.locator(".dbgrid tbody tr").first().click();
  await page.locator(".dbpanel .kvr").first().waitFor();
  await page.locator(".database-head .seg button", { hasText: "Structure" }).click();
  await page.locator(".card", { hasText: "Columns" }).waitFor();
  await page.locator(".database-head .seg button", { hasText: "SQL" }).click();
  await page.locator(".editor").fill("DELETE FROM account");
  await page.locator("button.btn.pri", { hasText: "Run" }).first().click();
  await page.locator(".console-error", { hasText: /read-only|Raw SQL is off/ }).waitFor();
});

await check("processes: instance page explains where it is stuck", async () => {
  await open("/processes/order-fulfilment?range=24h");
  await page.locator(".processes-node").first().waitFor();
  await page.locator("[data-testid=process-instances] tbody tr.click").first().click();
  await page.waitForURL(/instance/);
  await page.locator(".processes-answer p").waitFor();
  await page.locator(".processes-stop").first().waitFor();
});

await check("uptime: a monitor is added, checked, and deleted", async () => {
  await open("/uptime");
  await page.getByRole("button", { name: "Add monitor" }).click();
  await page.getByPlaceholder("Public API").fill("Probe e2e");
  await page.getByPlaceholder("https://api.example.com/health").fill(`${base}/health`);
  await page.locator(".dlg").getByRole("button", { name: "Add monitor" }).click();
  const row = page.locator(".uptime-mon", { hasText: "Probe e2e" });
  await row.waitFor();
  await row.getByRole("button", { name: "Check now" }).click();
  await row.locator(".uptime-state", { hasText: /^Up/ }).waitFor({ timeout: 8000 });
  await row.getByRole("button", { name: "Delete" }).click();
  await page.locator(".dlg").getByRole("button", { name: "Delete" }).click();
  await row.waitFor({ state: "detached" });
});

await check("uptime: a bad URL is refused in the form", async () => {
  await open("/uptime");
  await page.getByRole("button", { name: "Add monitor" }).click();
  await page.getByPlaceholder("Public API").fill("Bad");
  await page.getByPlaceholder("https://api.example.com/health").fill("nope");
  await page.locator(".dlg").getByRole("button", { name: "Add monitor" }).click();
  await page.getByText("Enter a full URL").waitFor();
  await page.locator(".dlg").getByRole("button", { name: "Cancel" }).click();
});

await check("alerts: an anomaly alert with quiet hours is created and says so", async () => {
  await open("/alerts/new");
  await page.getByRole("button", { name: "Anomaly", exact: true }).click();
  await page.getByText("sigma above its last 7 days").waitFor();
  await page.getByText("Quiet hours").click();
  await page.getByLabel("Quiet from").waitFor();
  await page.getByRole("button", { name: "Create alert" }).click();
  await page.waitForURL((url) => /\/alerts\/[0-9a-f-]{36}/.test(url.pathname));
  await page.getByText("Quiet from 22:00 to 07:00").waitFor();
  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.locator(".dlg").getByRole("button", { name: "Delete" }).click();
});

await check("status page: signed-in people see it, and it never shows URLs", async () => {
  await open("/status");
  // Monitors are optional, and a machine runs none from code: the page must still answer, in words.
  await page.locator(".status-mon, h1", { hasText: /./ }).first().waitFor();
  const text = await page.locator(".statusp").textContent();
  ok(!/http|127\.0\.0\.1|Could not connect/.test(text), "no URL or error text on the status page");
});

await check("alerts: every family of the design opens, and live ones say there is no preview", async () => {
  await open("/alerts/new");
  for (const name of ["Custom metric", "SLO burn", "Production rule"]) await page.getByRole("button", { name, exact: true }).click();
  await page.getByText("checked live").waitFor();
});

await check("every nav link answers without an error", async () => {
  const paths = ["/", "/dashboards", "/inbox", "/logs", "/traces", "/metrics", "/console", "/database", "/requests", "/queries", "/external", "/emails", "/runtime", "/services", "/map", "/ai", "/tasks", "/tasks/all", "/tasks/bulk", "/workers", "/schedules", "/processes", "/p/parcelo", "/p/paynest", "/p/invoxa", "/issues", "/alerts", "/slos", "/rules", "/releases", "/users", "/accounts", "/apikeys", "/settings/services", "/settings/storage", "/settings/channels", "/settings/members", "/settings/tokens", "/settings/extensions", "/settings/redaction", "/settings/audit"];
  for (const path of paths) {
    await open(path);
    const failed = await page.locator("h3", { hasText: "This did not load" }).count();
    if (failed) throw new Error(`${path}: ${await page.locator(".ph p").first().textContent()}`);
  }
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
