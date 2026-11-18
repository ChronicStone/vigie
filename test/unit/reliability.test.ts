import { expect, test } from "bun:test";
import { compare, flattenRows, tileChecks } from "../../server/parity.ts";

process.env.VIGIE_DATA_DIR ??= `/tmp/vigie-unit-${process.pid}`;
const { inQuietHours, sigmaLine } = await import("../../server/alerts.ts");
const { checkMonitorUrl } = await import("../../server/api/uptime.ts");
const { isSecretColumn, SECRET_COLUMN } = await import("../../server/lib/appdb.ts");

const at = (time: string) => new Date(`2026-11-04T${time}:00Z`).getTime();

test("quiet hours wrap past midnight, and end when they say", () => {
  const night = { from: "22:00", to: "07:00", timezone: "UTC" };
  expect(inQuietHours(night, at("23:30"))).toBe(true);
  expect(inQuietHours(night, at("06:59"))).toBe(true);
  expect(inQuietHours(night, at("07:00"))).toBe(false);
  expect(inQuietHours(night, at("12:00"))).toBe(false);
  expect(inQuietHours(undefined, at("23:30"))).toBe(false);
});

test("quiet hours read the clock in their own timezone", () => {
  const paris = { from: "09:00", to: "10:00", timezone: "Europe/Paris" };
  expect(inQuietHours(paris, at("08:30"))).toBe(true);
  expect(inQuietHours(paris, at("09:30"))).toBe(false);
});

test("sigma: needs history, sits above the noise, and a flat line does not fire on a small bump", () => {
  expect(sigmaLine([1, 2, 3], 3)).toBeNull();
  const noisy = Array.from({ length: 48 }, (_, i) => (i % 2 ? 8 : 12));
  expect(sigmaLine(noisy, 3)!.line).toBeCloseTo(16, 5);
  const flat = sigmaLine(Array.from({ length: 48 }, () => 100), 3)!;
  expect(flat.line).toBeGreaterThan(110);
  expect(sigmaLine(Array.from({ length: 48 }, () => 0), 3)!.line).toBeGreaterThan(0);
});

test("monitors take http and https only, and never the cloud metadata address", () => {
  expect(checkMonitorUrl("https://api.example.com/health")).toBe("https://api.example.com/health");
  for (const bad of ["file:///etc/passwd", "ftp://x.com", "not a url", "http://169.254.169.254/latest", "http://metadata.google.internal/"]) expect(() => checkMonitorUrl(bad)).toThrow();
});

test("parity: a service on one side only is a full difference, and limits apply per row", () => {
  const rows = compare("x", 1, new Map([["api", 1000], ["worker", 100], ["gone", 5]]), new Map([["api", 995], ["worker", 90]]));
  expect(rows.find((r) => r.key === "api")!.ok).toBe(true);
  expect(rows.find((r) => r.key === "worker")!.ok).toBe(false);
  expect(rows.find((r) => r.key === "gone")!.diff).toBe(100);
});

test("parity tiles: builder and SQL tiles become the same query on each side's tables", () => {
  const [builder, withSql, search, note] = tileChecksFixture();
  expect(builder!.hyperdx).toContain("FROM otel_logs");
  expect(builder!.vigie).toContain("FROM logs");
  expect(builder!.vigie.replace("FROM logs", "FROM otel_logs")).toBe(builder!.hyperdx);
  expect(builder!.hyperdx).toContain("quantile(0.95)(x)");
  expect(withSql!.hyperdx).not.toContain("$__");
  expect(withSql!.vigie).toContain("Timestamp >= {from:DateTime64(3)}");
  expect(search!.vigie).toContain("count() AS v");
  expect(note).toBeUndefined();
});

function tileChecksFixture() {
  return tileChecks({ name: "Acme · Overview", rows: [[
    { key: "a", name: "A", config: { sourceId: "logs", select: [{ aggFn: "quantile", level: "0.95", alias: "p95", valueExpression: "x" }], groupBy: "y" } },
    { key: "b", name: "B", config: { configType: "sql", sourceId: "logs", sqlTemplate: "SELECT count() AS n FROM $__sourceTable WHERE $__timeFilter_ms(Timestamp)" } },
    { key: "c", name: "C", config: { displayType: "search", sourceId: "logs", where: "a = 1", select: "x" } },
    { key: "d", name: "D", config: { displayType: "markdown" } },
  ]] });
}

test("parity rows: text names the row, numbers are compared", () => {
  const flat = flattenRows([{ route: "GET /a", n: "3", p95: 1.5 }, { v: 9 }]);
  expect(flat.get("GET /a · n")).toBe(3);
  expect(flat.get("GET /a · p95")).toBe(1.5);
  expect(flat.get("value")).toBe(9);
});

test("credentials are recognised on the real Acme column names, and their dates are not", () => {
  for (const [table, column] of [["auth_account", "password"], ["auth_account", "accessToken"], ["auth_account", "refreshToken"], ["auth_account", "idToken"], ["session", "token"], ["account_api_key", "secretHash"], ["webhook_endpoint", "secret"], ["webhook_endpoint", "previousSecret"], ["user_invitation", "tokenHash"], ["information_demand_recipient", "token_hash"], ["task", "claimToken"], ["verification", "value"], ["verification", "identifier"], ["order", "secureCode"], ["order_import_row", "secureCode"], ["account_invoice", "webdoc_url"], ["account_invoice_credit", "webdoc_url"]]) expect(isSecretColumn(table!, column!)).toBe(true);
  for (const [table, column] of [["auth_account", "accessTokenExpiresAt"], ["information_demand_recipient", "token_expires_at"], ["information_demand_recipient", "token_revoked_at"], ["information_demand_recipient", "token_access_mode"], ["webhook_endpoint", "previousSecretExpiresAt"], ["user", "email"], ["settings", "value"]]) expect(isSecretColumn(table!, column!)).toBe(false);
});

test("webhooks are signed like the Standard Webhooks test vector", async () => {
  const { webhookHeaders } = await import("../../server/alerts.ts");
  const headers = webhookHeaders("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", '{"test": 2432232314}', "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330);
  expect(headers["webhook-signature"]).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("the role and Vigie hide the same credentials", async () => {
  const role = await Bun.file(new URL("../../deploy/app-readonly.sql", import.meta.url)).text();
  expect(role).toContain(`column_name ~* '${SECRET_COLUMN.source}'`);
});
