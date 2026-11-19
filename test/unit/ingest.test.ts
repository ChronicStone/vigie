import { expect, test } from "bun:test";
import { decodeProtobuf, encodeProtobuf } from "../../server/ingest/proto.ts";
import { normalizeEnvironment, normalizeLogs, normalizeMetrics, normalizeTraces } from "../../server/ingest/normalize.ts";

const resource = { attributes: [{ key: "service.name", value: { stringValue: "acme-api" } }, { key: "deployment.environment.name", value: { stringValue: "production" } }, { key: "service.version", value: { stringValue: "abc" } }] };

test("logs: attributes are flattened, the environment is normalized, a secret never gets stored", () => {
  const rows = normalizeLogs({ resourceLogs: [{ resource, scopeLogs: [{ logRecords: [{ timeUnixNano: "1793750000000000000", severityText: "ERROR", body: { stringValue: "failed for camille@example.com" }, attributes: [{ key: "password", value: { stringValue: "hunter2" } }, { key: "db.queries", value: { intValue: "3" } }, { key: "apiKey.id", value: { stringValue: "key_8f21" } }] }] }] }] });
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.Environment).toBe("DEV");
  expect(row.ServiceName).toBe("acme-api");
  expect(row.SeverityText).toBe("error");
  expect(row.LogAttributes.password).toBe("[REDACTED]");
  expect(row.LogAttributes["db.queries"]).toBe("3");
  expect(row.LogAttributes["apiKey.id"]).toBe("key_8f21");
  expect(row.Body).toContain("c***@example.com");
  expect(row.EventId).toBeTruthy();
});

test("traces: duration in nanoseconds and status names", () => {
  const rows = normalizeTraces({ resourceSpans: [{ resource, scopeSpans: [{ spans: [{ traceId: "aa", spanId: "bb", name: "GET /x", kind: 2, startTimeUnixNano: "1793750000000000000", endTimeUnixNano: "1793750000250000000", status: { code: 2, message: "boom" }, attributes: [] }] }] }] });
  expect(rows[0]!.Duration).toBe(250_000_000);
  expect(rows[0]!.StatusCode).toBe("Error");
  expect(rows[0]!.SpanName).toBe("GET /x");
});

test("metrics: every point records which instance it came from", () => {
  const out = normalizeMetrics({ resourceMetrics: [{ resource: { attributes: [...resource.attributes, { key: "service.instance.id", value: { stringValue: "api-1" } }] }, scopeMetrics: [{ metrics: [{ name: "m", gauge: { dataPoints: [{ timeUnixNano: "1793750000000000000", asDouble: 2, attributes: [{ key: "state", value: { stringValue: "due" } }] }] } }] }] }] });
  expect(out.gauge[0]!.Value).toBe(2);
  expect(out.gauge[0]!.Attributes["service.instance.id"]).toBe("api-1");
  expect(out.gauge[0]!.Attributes.state).toBe("due");
});

test("protobuf: a real OTLP message decodes to the same shape as JSON", () => {
  const payload = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] }, scopeLogs: [{ logRecords: [{ timeUnixNano: "1793750000000000000", severityText: "INFO", body: { stringValue: "hello" }, attributes: [{ key: "n", value: { intValue: "4" } }], traceId: Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex"), spanId: Buffer.from("0102030405060708", "hex") }] }] }] };
  const decoded = decodeProtobuf("logs", encodeProtobuf("logs", payload));
  const rows = normalizeLogs(decoded);
  expect(rows[0]!.Body).toBe("hello");
  expect(rows[0]!.ServiceName).toBe("svc");
  expect(rows[0]!.TraceId).toBe("0102030405060708090a0b0c0d0e0f10");
  expect(rows[0]!.LogAttributes.n).toBe("4");
});

test("environments: a server has Prod and Test, a machine has one Local, and unknown names never count as production", () => {
  const server = { environments: ["PRD", "STG"], fallback: "STG" };
  expect(normalizeEnvironment("production", server)).toBe("PRD");
  expect(normalizeEnvironment("staging", server)).toBe("STG");
  expect(normalizeEnvironment("test", server)).toBe("STG");
  expect(normalizeEnvironment("development", server)).toBe("STG");
  expect(normalizeEnvironment(undefined, server)).toBe("STG");
  const local = { environments: ["DEV"], fallback: "DEV" };
  expect(normalizeEnvironment("production", local)).toBe("DEV");
  expect(normalizeEnvironment("staging", local)).toBe("DEV");
});

test("task outcome types from the packages read like the app's own", async () => {
  const { canonicalOutcome } = await import("../../server/ingest/normalize.ts");
  for (const [sent, stored] of [["SKIPPED", "SKIP"], ["FAILED", "FAIL"], ["SUCCEEDED", "DONE"], ["RETRY", "RETRY"], ["skipped", "SKIP"]]) {
    const attrs: Record<string, string> = { "taskOutcome.type": sent };
    canonicalOutcome(attrs);
    expect(attrs["taskOutcome.type"]).toBe(stored);
  }
});
