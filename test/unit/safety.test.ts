import { expect, test } from "bun:test";
import { redactValue } from "../../server/lib/redact.ts";
import { checkConsoleSql } from "../../server/api/metrics.ts";
import { parseSearch, filterSql } from "../../server/api/logs.ts";

test("redaction: secrets by name, ids stay readable", () => {
  expect(redactValue("authorization", "Bearer abc")).toBe("[REDACTED]");
  expect(redactValue("session_token", "abc123")).toBe("[REDACTED]");
  expect(redactValue("api_key", "abc123")).toBe("[REDACTED]");
  expect(redactValue("apiKey.id", "key_8f21")).toBe("key_8f21");
  expect(redactValue("token.id", "tok_1")).toBe("tok_1");
});

test("redaction: secrets inside values", () => {
  expect(redactValue("message", "mail camille@example.com now")).toBe("mail c***@example.com now");
  expect(redactValue("path", "/reset-password/abcdef123")).toBe("/reset-password/[REDACTED]");
  expect(redactValue("route", "/reset-password/:token")).toBe("/reset-password/:token");
  expect(redactValue("note", "card 4242 4242 4242 4242")).toBe("card [CARD]");
});

test("console: only one SELECT, only known tables", () => {
  expect(checkConsoleSql("SELECT 1 FROM logs")).toBe("SELECT 1 FROM logs");
  expect(checkConsoleSql("WITH x AS (SELECT 1 FROM spans) SELECT * FROM x;")).toContain("WITH x");
  for (const sql of ["DROP TABLE logs", "SELECT 1; DROP TABLE logs", "SELECT * FROM system.users", "SELECT * FROM users", "SELECT * FROM url('http://x', CSV)", "SELECT * FROM logs JOIN tokens ON 1", "INSERT INTO logs VALUES (1)"]) {
    expect(() => checkConsoleSql(sql), sql).toThrow();
  }
});

test("search bar: fields become filters, the rest is text", () => {
  const parsed = parseSearch('status>=500 path^/v1 user.id:abc "two words" boom');
  expect(parsed.filters).toEqual([
    { field: "status", op: "gte", values: ["500"] },
    { field: "path", op: "starts", values: ["/v1"] },
    { field: "user.id", op: "is", values: ["abc"] },
  ]);
  expect(parsed.text).toBe("two words boom");
});

test("filters: values travel as parameters, a bad field name is refused", () => {
  const params: Record<string, unknown> = {};
  const [sql] = filterSql([{ field: "reason", op: "is", values: ["x'; DROP TABLE logs; --"] }], params);
  expect(sql).not.toContain("DROP");
  expect(params.f0).toEqual(["x'; DROP TABLE logs; --"]);
  expect(() => filterSql([{ field: "a'] OR 1=1 --", op: "is", values: ["x"] }], {})).toThrow();
});
