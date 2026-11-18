import { describe, expect, test } from "bun:test";
import { prettySql, tokensOf } from "../../web/src/lib/highlight.ts";

const kinds = (text: string, lang: Parameters<typeof tokensOf>[1]) => tokensOf(text, lang).filter((token) => token.className).map((token) => [token.className, token.value]);

describe("highlight", () => {
  test("Postgres quoted names are names, not strings", () => {
    const tokens = kinds(`select "id", count(*) from "task" where "state" = 'done' and x = $1 limit 10`, "sql");
    expect(tokens).toContainEqual(["keyword", "select"]);
    expect(tokens).toContainEqual(["property", '"id"']);
    expect(tokens).toContainEqual(["function", "count"]);
    expect(tokens).toContainEqual(["string", "'done'"]);
    expect(tokens).toContainEqual(["variable", "$1"]);
    expect(tokens).toContainEqual(["number", "10"]);
  });
  test("ClickHouse parameters and functions", () => {
    const tokens = kinds("SELECT quantile(0.95)(DurationMs) FROM logs WHERE Environment = {env:String}", "sql");
    expect(tokens).toContainEqual(["function", "quantile"]);
    expect(tokens).toContainEqual(["variable", "{env:String}"]);
  });
  test("text is never lost, so telemetry renders exactly as sent", () => {
    for (const [text, lang] of [[`select '<img src=x onerror=alert(1)>' from "a"`, "sql"], ["GET /v1/a/:id 200 in 12 ms user=<b>x</b>", "log"], ['{"a":"<script>"}', "json"], ["TypeError: x\n    at fn (/app/a.ts:1:2)\n    at node:internal/x:1:1", "stack"]] as const) {
      expect(tokensOf(text, lang).map((token) => token.value).join("")).toBe(text);
    }
  });
  test("log lines mark the call, the path, the number and the id", () => {
    const tokens = kinds("POST /v1/accounts/:id 503 in 12 ms worker=a 01a10bbd-307a-747c-8145-f251c43d12c0 webhooks.collect failed", "log");
    expect(tokens).toContainEqual(["keyword", "POST"]);
    expect(tokens).toContainEqual(["attr", "/v1/accounts/:id"]);
    expect(tokens).toContainEqual(["number", "503"]);
    expect(tokens).toContainEqual(["number", "12 ms"]);
    expect(tokens).toContainEqual(["property", "worker"]);
    expect(tokens).toContainEqual(["meta", "01a10bbd-307a-747c-8145-f251c43d12c0"]);
    expect(tokens).toContainEqual(["function", "webhooks.collect"]);
    expect(tokens).toContainEqual(["deleted", "failed"]);
  });
  test("stack frames: yours bright, dependencies dim", () => {
    const tokens = kinds("TypeError: boom\n    at render (/app/x.ts:10:2)\n    at run (/app/node_modules/y/z.js:1:1)", "stack");
    expect(tokens).toContainEqual(["deleted", "TypeError"]);
    expect(tokens).toContainEqual(["function", "render"]);
    expect(tokens).toContainEqual(["string", "/app/x.ts"]);
    expect(tokens).toContainEqual(["number", ":10:2"]);
    expect(tokens.at(-1)![0]).toBe("comment");
  });
  test("pretty SQL breaks top level clauses only", () => {
    const out = prettySql(`select "a" from "t" left join "u" on "a" = (select 1 from "v") where "a" = 'from x' group by "a" limit 1`);
    expect(out.split("\n")).toEqual([`select "a"`, `from "t"`, `left join "u" on "a" = (select 1 from "v")`, `where "a" = 'from x'`, `group by "a"`, `limit 1`]);
  });
});
