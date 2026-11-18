import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { insert } from "../lib/clickhouse.ts";
import { noteIssues } from "../state/issues.ts";
import { decodeProtobuf, type Signal } from "./proto.ts";
import { applyIngestDefinitions, registry } from "../extensions/index.ts";
import { normalizeLogs, normalizeMetrics, normalizeTraces } from "./normalize.ts";

type Table = "spans" | "logs" | "metrics_gauge" | "metrics_sum" | "metrics_histogram";
type Queue = { lines: string[]; bytes: number };

const TABLES: Table[] = ["spans", "logs", "metrics_gauge", "metrics_sum", "metrics_histogram"];
const queues = Object.fromEntries(TABLES.map((t) => [t, { lines: [], bytes: 0 }])) as unknown as Record<Table, Queue>;
const spoolPath = (table: Table) => join(config.dataDir, `spool-${table}.ndjson`);

export const ingestStats = {
  accepted: { spans: 0, logs: 0, metrics: 0 },
  rejected: 0,
  spooled: 0,
  dropped: 0,
  lastEventAt: 0,
  lastFlushMs: 0,
  flushErrors: 0,
  lastError: "",
};

type Listener = (rows: any[]) => void;
const listeners = new Set<Listener>();

/** Live tail: subscribers get each accepted wide event as it arrives. */
export function subscribeLive(listener: Listener) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function queuedBytes() {
  return TABLES.reduce((sum, table) => sum + queues[table].bytes, 0);
}

function push(table: Table, rows: any[]) {
  const queue = queues[table];
  for (const row of rows) {
    const line = JSON.stringify(row);
    queue.lines.push(line);
    queue.bytes += line.length;
  }
  if (queue.lines.length >= config.ingest.maxBatchRows) void flush(table);
}

export class Backpressure extends Error {}

export async function decodeBody(request: Request, signal: Signal) {
  let bytes = new Uint8Array(await request.arrayBuffer());
  if (request.headers.get("content-encoding") === "gzip") bytes = Bun.gunzipSync(bytes);
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("protobuf")) return { payload: decodeProtobuf(signal, bytes), protobuf: true };
  return { payload: JSON.parse(new TextDecoder().decode(bytes)), protobuf: false };
}

/** A Redis command is not a SQL statement. It keeps its own field, so Queries and its rollups stay about the database. */
export function moveRedisStatement(attributes: Record<string, string>) {
  if (attributes["db.system"] !== "redis" && attributes["db.system.name"] !== "redis") return;
  const statement = attributes["db.statement"] ?? attributes["db.query.text"];
  if (statement) attributes["redis.command"] = statement;
  delete attributes["db.statement"];
  delete attributes["db.query.text"];
}

/** Accepts one OTLP payload. Throws Backpressure when the bounded queue is full, so exporters retry. */
export function accept(signal: Signal, payload: any, environment?: string) {
  if (queuedBytes() > config.ingest.maxQueueBytes) throw new Backpressure("queue full");
  ingestStats.lastEventAt = Date.now();
  if (signal === "traces") {
    const rows = normalizeTraces(payload, environment);
    for (const row of rows) moveRedisStatement(row.SpanAttributes);
    if (registry.enrichers.length || registry.redactors.some((r) => r.keys)) for (const row of rows) applyIngestDefinitions(row.SpanAttributes, "spans");
    ingestStats.accepted.spans += rows.length;
    noteIssues(rows, "span");
    push("spans", rows);
  } else if (signal === "logs") {
    const rows = normalizeLogs(payload, environment);
    if (registry.enrichers.length || registry.redactors.some((r) => r.keys)) for (const row of rows) applyIngestDefinitions(row.LogAttributes, "logs");
    ingestStats.accepted.logs += rows.length;
    noteIssues(rows, "log");
    push("logs", rows);
    if (listeners.size) for (const listener of listeners) listener(rows);
  } else {
    const { gauge, sum, histogram } = normalizeMetrics(payload, environment);
    ingestStats.accepted.metrics += gauge.length + sum.length + histogram.length;
    push("metrics_gauge", gauge);
    push("metrics_sum", sum);
    push("metrics_histogram", histogram);
  }
}

/** A busy ClickHouse (too many queries at once) frees up within a second: wait for it rather than spool. */
async function insertWhenFree(table: Table, body: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await insert(table, body);
    } catch (error) {
      if (attempt >= 4 || !/TOO_MANY_SIMULTANEOUS_QUERIES|Code: 202\b/.test(String(error))) throw error;
      await Bun.sleep(250 * 2 ** attempt);
    }
  }
}

async function flush(table: Table) {
  const queue = queues[table];
  if (!queue.lines.length) return;
  const lines = queue.lines;
  queue.lines = [];
  queue.bytes = 0;
  const body = lines.join("\n");
  const start = performance.now();
  try {
    await insertWhenFree(table, body);
    ingestStats.lastFlushMs = Math.round(performance.now() - start);
  } catch (error) {
    ingestStats.flushErrors++;
    ingestStats.lastError = String(error).slice(0, 300);
    spool(table, body, lines.length);
  }
}

/** ClickHouse down: keep rows on disk up to a limit, dropping metrics before wide events. */
function spool(table: Table, body: string, count: number) {
  const path = spoolPath(table);
  const size = existsSync(path) ? statSync(path).size : 0;
  const limit = config.ingest.maxSpoolBytes * (table.startsWith("metrics") ? 0.25 : 1);
  if (size + body.length > limit) {
    ingestStats.dropped += count;
    return;
  }
  appendFileSync(path, `${body}\n`);
  ingestStats.spooled += count;
}

async function replaySpool() {
  for (const table of TABLES) {
    const path = spoolPath(table);
    if (!existsSync(path)) continue;
    const working = `${path}.replay`;
    renameSync(path, working);
    try {
      const body = readFileSync(working, "utf8");
      await insertWhenFree(table, body);
      unlinkSync(working);
      // The banner reads rows still on disk, so it clears once they are stored.
      ingestStats.spooled = Math.max(0, ingestStats.spooled - body.split("\n").filter(Boolean).length);
    } catch {
      appendFileSync(path, readFileSync(working, "utf8"));
      unlinkSync(working);
      return;
    }
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let ticks = 0;

export function startPipeline() {
  timer = setInterval(() => {
    for (const table of TABLES) void flush(table);
    if (++ticks % 30 === 0) void replaySpool();
  }, config.ingest.flushMs);
}

export async function stopPipeline() {
  clearInterval(timer);
  await Promise.all(TABLES.map(flush));
}

export function flushAll() {
  return Promise.all(TABLES.map(flush));
}

export function pipelineHealth() {
  return { ...ingestStats, queuedBytes: queuedBytes() };
}
