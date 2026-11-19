import { redactMap, redactValue } from "../lib/redact.ts";
import { config } from "../config.ts";

type KV = { key: string; value?: AnyValue };
type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KV[] };
  bytesValue?: string;
};

function plain(value: AnyValue | undefined): unknown {
  if (!value) return "";
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return String(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(plain);
  if (value.kvlistValue) return Object.fromEntries((value.kvlistValue.values ?? []).map((kv) => [kv.key, plain(kv.value)]));
  if (value.bytesValue !== undefined) return value.bytesValue;
  return "";
}

/** Flattens OTLP attributes to the string map ClickHouse stores. Nested lists become dotted keys. */
function flatten(attributes: KV[] | undefined, into: Record<string, string> = {}, prefix = "") {
  for (const kv of attributes ?? []) {
    const key = prefix + kv.key;
    if (kv.value?.kvlistValue) flatten(kv.value.kvlistValue.values, into, `${key}.`);
    else {
      const value = plain(kv.value);
      into[key] = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
    }
  }
  return into;
}

/** Nanoseconds since the epoch, as text, to the format ClickHouse reads for DateTime64(9). */
export function nanoToDate(nano: string | number | undefined): string {
  const text = String(nano ?? "0");
  if (text === "0" || text === "") {
    return new Date().toISOString().replace("T", " ").replace("Z", "000000");
  }
  const whole = text.length > 9 ? text.slice(0, -9) : "0";
  const fraction = text.length > 9 ? text.slice(-9) : text.padStart(9, "0");
  const date = new Date(Number(whole) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${date}.${fraction}`;
}

function resourceOf(resource: { attributes?: KV[] } | undefined) {
  const attrs = redactMap(flatten(resource?.attributes));
  return {
    attrs,
    service: attrs["service.name"] ?? "unknown",
    version: attrs["service.version"] ?? "",
    instance: attrs["service.instance.id"] ?? "",
    environment: normalizeEnvironment(attrs["deployment.environment.name"] ?? attrs["deployment.environment"]),
  };
}

const ENV_NAMES: [string, RegExp][] = [
  ["PRD", /^(prod|prd)/],
  ["STG", /^(stag|stg|test|uat|pre)/],
  ["DEV", /^(dev|local)/],
];

/** Whatever a service calls itself lands in an environment this Vigie has. Anything unknown is never counted as production. */
export function normalizeEnvironment(value: string | undefined, allowed = { environments: config.environments, fallback: config.ingest.defaultEnvironment }) {
  const raw = (value ?? "").toLowerCase();
  const named = ENV_NAMES.find(([, pattern]) => pattern.test(raw))?.[0];
  return named && allowed.environments.includes(named) ? named : allowed.fallback;
}

const KINDS = ["Unspecified", "Internal", "Server", "Client", "Producer", "Consumer"];
const STATUS = ["Unset", "Ok", "Error"];

function numeric(value: unknown, table: string[]) {
  if (typeof value === "number") return table[value] ?? table[0];
  if (typeof value === "string") {
    const match = table.find((entry) => value.toUpperCase().endsWith(entry.toUpperCase()));
    if (match) return match;
  }
  return table[0];
}

export function normalizeTraces(payload: any, forcedEnvironment?: string) {
  const rows: any[] = [];
  for (const rs of payload.resourceSpans ?? []) {
    const resource = resourceOf(rs.resource);
    for (const scope of rs.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const attributes = redactMap(flatten(span.attributes));
        const start = String(span.startTimeUnixNano ?? "0");
        const end = String(span.endTimeUnixNano ?? start);
        const events = span.events ?? [];
        rows.push({
          Timestamp: nanoToDate(start),
          TraceId: span.traceId ?? "",
          SpanId: span.spanId ?? "",
          ParentSpanId: span.parentSpanId ?? "",
          SpanName: redactValue("name", String(span.name ?? "")),
          SpanKind: numeric(span.kind, KINDS),
          ServiceName: resource.service,
          Environment: forcedEnvironment ?? resource.environment,
          ServiceVersion: resource.version,
          InstanceId: resource.instance,
          Duration: Number(BigInt(end) - BigInt(start)),
          StatusCode: numeric(span.status?.code, STATUS),
          StatusMessage: span.status?.message ?? "",
          SpanAttributes: attributes,
          ResourceAttributes: resource.attrs,
          EventsTimestamp: events.map((event: any) => nanoToDate(event.timeUnixNano)),
          EventsName: events.map((event: any) => event.name ?? ""),
          EventsAttributes: events.map((event: any) => redactMap(flatten(event.attributes))),
        });
      }
    }
  }
  return rows;
}

const LEVELS: [number, string][] = [
  [21, "fatal"],
  [17, "error"],
  [13, "warn"],
  [9, "info"],
  [5, "debug"],
  [0, "trace"],
];

function severity(record: any) {
  const number = Number(record.severityNumber ?? 0);
  const text = String(record.severityText ?? "").toLowerCase();
  if (text) return { text: text === "warning" ? "warn" : text, number };
  return { text: LEVELS.find(([min]) => number >= min)?.[1] ?? "info", number };
}

/** The packages and the docs say SUCCEEDED, FAILED, SKIPPED; the screens read DONE, FAIL, SKIP. One vocabulary, set at ingest. */
const OUTCOME_TYPES: Record<string, string> = { SUCCEEDED: "DONE", SUCCESS: "DONE", FAILED: "FAIL", SKIPPED: "SKIP" };
export function canonicalOutcome(attributes: Record<string, string>) {
  const type = attributes["taskOutcome.type"];
  if (type && OUTCOME_TYPES[type.toUpperCase()]) attributes["taskOutcome.type"] = OUTCOME_TYPES[type.toUpperCase()]!;
}

export function normalizeLogs(payload: any, forcedEnvironment?: string) {
  const rows: any[] = [];
  for (const rl of payload.resourceLogs ?? []) {
    const resource = resourceOf(rl.resource);
    for (const scope of rl.scopeLogs ?? []) {
      for (const record of scope.logRecords ?? []) {
        const attributes = redactMap(flatten(record.attributes));
        canonicalOutcome(attributes);
        const raw = plain(record.body);
        // evlog's compact records fall back to the service name as the line: its own `message` reads better.
        const body = (raw === "" || raw === resource.service) && attributes.message ? attributes.message : raw;
        const level = severity(record);
        const nano = String(record.timeUnixNano && record.timeUnixNano !== "0" ? record.timeUnixNano : (record.observedTimeUnixNano ?? "0"));
        rows.push({
          Timestamp: nanoToDate(nano),
          EventId: `${nano.slice(-12)}${Math.random().toString(36).slice(2, 8)}`,
          TraceId: record.traceId || attributes.traceId || attributes["span.trace_id"] || "",
          SpanId: record.spanId || attributes.spanId || attributes["span.span_id"] || "",
          SeverityText: level.text,
          SeverityNumber: level.number,
          ServiceName: resource.service,
          Environment: forcedEnvironment ?? resource.environment,
          ServiceVersion: resource.version,
          InstanceId: resource.instance,
          Body: redactValue("body", typeof body === "string" ? body : JSON.stringify(body)),
          LogAttributes: attributes,
          ResourceAttributes: resource.attrs,
        });
      }
    }
  }
  return rows;
}

function pointValue(point: any) {
  if (point.asDouble !== undefined) return Number(point.asDouble);
  if (point.asInt !== undefined) return Number(point.asInt);
  return 0;
}

export function normalizeMetrics(payload: any, forcedEnvironment?: string) {
  const out = { gauge: [] as any[], sum: [] as any[], histogram: [] as any[] };
  for (const rm of payload.resourceMetrics ?? []) {
    const resource = resourceOf(rm.resource);
    for (const scope of rm.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        const base = {
          MetricName: metric.name,
          MetricUnit: metric.unit ?? "",
          MetricDescription: metric.description ?? "",
          ServiceName: resource.service,
          Environment: forcedEnvironment ?? resource.environment,
        };
        for (const point of metric.gauge?.dataPoints ?? []) {
          out.gauge.push({ ...base, TimeUnix: nanoToDate(point.timeUnixNano), Attributes: { ...flatten(point.attributes), "service.instance.id": resource.instance }, Value: pointValue(point) });
        }
        for (const point of metric.sum?.dataPoints ?? []) {
          out.sum.push({
            ...base,
            TimeUnix: nanoToDate(point.timeUnixNano),
            Attributes: { ...flatten(point.attributes), "service.instance.id": resource.instance },
            Value: pointValue(point),
            IsMonotonic: Boolean(metric.sum.isMonotonic),
            AggregationTemporality: typeof metric.sum.aggregationTemporality === "number" ? metric.sum.aggregationTemporality : String(metric.sum.aggregationTemporality ?? "").includes("DELTA") ? 1 : 2,
          });
        }
        for (const point of metric.histogram?.dataPoints ?? []) {
          out.histogram.push({
            ...base,
            TimeUnix: nanoToDate(point.timeUnixNano),
            Attributes: { ...flatten(point.attributes), "service.instance.id": resource.instance },
            Count: Number(point.count ?? 0),
            Sum: Number(point.sum ?? 0),
            BucketCounts: (point.bucketCounts ?? []).map(Number),
            ExplicitBounds: point.explicitBounds ?? [],
            Min: point.min ?? null,
            Max: point.max ?? null,
          });
        }
      }
    }
  }
  return out;
}
