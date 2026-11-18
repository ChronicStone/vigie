import protobuf from "protobufjs";

/** The OTLP wire format, only the fields Vigie reads. Field numbers come from opentelemetry-proto. */
const anyValue = {
  oneofs: { value: { oneof: ["stringValue", "boolValue", "intValue", "doubleValue", "arrayValue", "kvlistValue", "bytesValue"] } },
  fields: {
    stringValue: { type: "string", id: 1 },
    boolValue: { type: "bool", id: 2 },
    intValue: { type: "int64", id: 3 },
    doubleValue: { type: "double", id: 4 },
    arrayValue: { type: "ArrayValue", id: 5 },
    kvlistValue: { type: "KeyValueList", id: 6 },
    bytesValue: { type: "bytes", id: 7 },
  },
};

const root = protobuf.Root.fromJSON({
  nested: {
    AnyValue: anyValue,
    ArrayValue: { fields: { values: { rule: "repeated", type: "AnyValue", id: 1 } } },
    KeyValueList: { fields: { values: { rule: "repeated", type: "KeyValue", id: 1 } } },
    KeyValue: { fields: { key: { type: "string", id: 1 }, value: { type: "AnyValue", id: 2 } } },
    Resource: { fields: { attributes: { rule: "repeated", type: "KeyValue", id: 1 } } },
    Scope: { fields: { name: { type: "string", id: 1 }, version: { type: "string", id: 2 } } },
    Event: { fields: { timeUnixNano: { type: "fixed64", id: 1 }, name: { type: "string", id: 2 }, attributes: { rule: "repeated", type: "KeyValue", id: 3 } } },
    Status: { fields: { message: { type: "string", id: 2 }, code: { type: "int32", id: 3 } } },
    Span: {
      fields: {
        traceId: { type: "bytes", id: 1 },
        spanId: { type: "bytes", id: 2 },
        parentSpanId: { type: "bytes", id: 4 },
        name: { type: "string", id: 5 },
        kind: { type: "int32", id: 6 },
        startTimeUnixNano: { type: "fixed64", id: 7 },
        endTimeUnixNano: { type: "fixed64", id: 8 },
        attributes: { rule: "repeated", type: "KeyValue", id: 9 },
        events: { rule: "repeated", type: "Event", id: 11 },
        status: { type: "Status", id: 15 },
      },
    },
    ScopeSpans: { fields: { scope: { type: "Scope", id: 1 }, spans: { rule: "repeated", type: "Span", id: 2 } } },
    ResourceSpans: { fields: { resource: { type: "Resource", id: 1 }, scopeSpans: { rule: "repeated", type: "ScopeSpans", id: 2 } } },
    TracesRequest: { fields: { resourceSpans: { rule: "repeated", type: "ResourceSpans", id: 1 } } },
    LogRecord: {
      fields: {
        timeUnixNano: { type: "fixed64", id: 1 },
        severityNumber: { type: "int32", id: 2 },
        severityText: { type: "string", id: 3 },
        body: { type: "AnyValue", id: 5 },
        attributes: { rule: "repeated", type: "KeyValue", id: 6 },
        traceId: { type: "bytes", id: 9 },
        spanId: { type: "bytes", id: 10 },
        observedTimeUnixNano: { type: "fixed64", id: 11 },
      },
    },
    ScopeLogs: { fields: { scope: { type: "Scope", id: 1 }, logRecords: { rule: "repeated", type: "LogRecord", id: 2 } } },
    ResourceLogs: { fields: { resource: { type: "Resource", id: 1 }, scopeLogs: { rule: "repeated", type: "ScopeLogs", id: 2 } } },
    LogsRequest: { fields: { resourceLogs: { rule: "repeated", type: "ResourceLogs", id: 1 } } },
    NumberDataPoint: {
      fields: {
        attributes: { rule: "repeated", type: "KeyValue", id: 7 },
        startTimeUnixNano: { type: "fixed64", id: 2 },
        timeUnixNano: { type: "fixed64", id: 3 },
        asDouble: { type: "double", id: 4 },
        asInt: { type: "sfixed64", id: 6 },
      },
    },
    HistogramDataPoint: {
      fields: {
        attributes: { rule: "repeated", type: "KeyValue", id: 9 },
        startTimeUnixNano: { type: "fixed64", id: 2 },
        timeUnixNano: { type: "fixed64", id: 3 },
        count: { type: "fixed64", id: 4 },
        sum: { type: "double", id: 5 },
        bucketCounts: { rule: "repeated", type: "fixed64", id: 6 },
        explicitBounds: { rule: "repeated", type: "double", id: 7 },
        min: { type: "double", id: 11 },
        max: { type: "double", id: 12 },
      },
    },
    Gauge: { fields: { dataPoints: { rule: "repeated", type: "NumberDataPoint", id: 1 } } },
    Sum: { fields: { dataPoints: { rule: "repeated", type: "NumberDataPoint", id: 1 }, aggregationTemporality: { type: "int32", id: 2 }, isMonotonic: { type: "bool", id: 3 } } },
    Histogram: { fields: { dataPoints: { rule: "repeated", type: "HistogramDataPoint", id: 1 }, aggregationTemporality: { type: "int32", id: 2 } } },
    Metric: { fields: { name: { type: "string", id: 1 }, description: { type: "string", id: 2 }, unit: { type: "string", id: 3 }, gauge: { type: "Gauge", id: 5 }, sum: { type: "Sum", id: 7 }, histogram: { type: "Histogram", id: 9 } } },
    ScopeMetrics: { fields: { scope: { type: "Scope", id: 1 }, metrics: { rule: "repeated", type: "Metric", id: 2 } } },
    ResourceMetrics: { fields: { resource: { type: "Resource", id: 1 }, scopeMetrics: { rule: "repeated", type: "ScopeMetrics", id: 2 } } },
    MetricsRequest: { fields: { resourceMetrics: { rule: "repeated", type: "ResourceMetrics", id: 1 } } },
  },
});

const types = {
  traces: root.lookupType("TracesRequest"),
  logs: root.lookupType("LogsRequest"),
  metrics: root.lookupType("MetricsRequest"),
};

export type Signal = keyof typeof types;

function hexify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hexify);
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = hexify(entry);
    return out;
  }
  return value;
}

/** Decodes protobuf into the same shape OTLP/JSON has, with ids as hex and 64-bit values as strings. */
export function decodeProtobuf(signal: Signal, bytes: Uint8Array): any {
  const type = types[signal];
  const message = type.decode(bytes);
  return hexify(type.toObject(message, { longs: String, bytes: Uint8Array, defaults: false, arrays: true }));
}

export function encodeProtobuf(signal: Signal, payload: object): Uint8Array {
  const type = types[signal];
  return type.encode(type.fromObject(payload)).finish();
}
