import { defineDashboard } from "vigie/sdk";

const requests = "FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env AND Kind = 'request'";
const tasks = "FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env AND Kind = 'task'";
const ext = "FROM spans WHERE $__timeFilter(Timestamp) AND Environment = $__env AND PeerHost != '' AND DbStatement = ''";

export const jobs = defineDashboard({
  id: "jobs",
  title: "Jobs and queues",
  widgets: [
    { type: "stat", title: "Attempts", span: 3, sql: `SELECT count() AS v ${tasks}` },
    { type: "stat", title: "Due now", span: 3, sql: `SELECT argMax(Value, TimeUnix) AS v FROM metrics_gauge WHERE $__timeFilter(TimeUnix) AND Environment = $__env AND MetricName = 'vigie.tasks.backlog' AND Attributes['state'] = 'due'` },
    { type: "stat", title: "Oldest overdue", span: 3, unit: "s", sql: `SELECT argMax(Value, TimeUnix) AS v FROM metrics_gauge WHERE $__timeFilter(TimeUnix) AND Environment = $__env AND MetricName = 'vigie.tasks.oldest_due_age'` },
    { type: "stat", title: "Failed attempts", span: 3, tone: "error", sql: `SELECT countIf(Outcome != 'succeeded') AS v ${tasks}` },
    { type: "bars", title: "Attempts by outcome", span: 7, height: 170, sql: `SELECT $__bucket(Timestamp) AS t, countIf(Outcome = 'succeeded') AS ok, countIf(Outcome != 'succeeded') AS error ${tasks} GROUP BY t ORDER BY t` },
    { type: "list", title: "Failed attempts by kind", span: 5, height: 170, sql: `SELECT TaskKind AS label, countIf(Outcome != 'succeeded') AS value ${tasks} GROUP BY label HAVING value > 0 ORDER BY value DESC LIMIT 6` },
    { type: "lines", title: "Backlog", span: 6, height: 150, sql: `SELECT $__bucket(TimeUnix) AS t, avgIf(Value, Attributes['state'] = 'due') AS due, avgIf(Value, Attributes['state'] = 'running') AS running FROM metrics_gauge WHERE $__timeFilter(TimeUnix) AND Environment = $__env AND MetricName = 'vigie.tasks.backlog' GROUP BY t ORDER BY t` },
    { type: "table", title: "Recent failures", span: 6, height: 150, sql: `SELECT TaskKind AS kind, LogAttributes['taskOutcome.reason'] AS code, count() AS n ${tasks} AND Outcome != 'succeeded' GROUP BY kind, code ORDER BY n DESC LIMIT 6` },
  ],
});

export const overview = defineDashboard({
  id: "overview",
  title: "Acme overview",
  widgets: [
    { type: "stat", title: "Requests", span: 3, sql: `SELECT count() AS v ${requests}` },
    { type: "stat", title: "Server errors", span: 3, tone: "error", sql: `SELECT countIf(Status >= 500) AS v ${requests}` },
    { type: "stat", title: "p95", span: 3, format: "ms", sql: `SELECT quantile(0.95)(DurationMs) AS v ${requests}` },
    { type: "stat", title: "Active people", span: 3, sql: `SELECT uniqExact(UserId) AS v ${requests}` },
    { type: "bars", title: "Traffic", span: 12, height: 190, sql: `SELECT $__bucket(Timestamp) AS t, countIf(Status < 500) AS ok, countIf(Status >= 500) AS error ${requests} GROUP BY t ORDER BY t` },
    { type: "list", title: "Slowest routes", span: 6, height: 160, format: "ms", sql: `SELECT concat(Method, ' ', Route) AS label, quantile(0.95)(DurationMs) AS value ${requests} AND Route != '' GROUP BY label ORDER BY value DESC LIMIT 6` },
    { type: "list", title: "Busiest accounts", span: 6, height: 160, sql: `SELECT AccountId AS label, count() AS value ${requests} AND AccountId != '' GROUP BY label ORDER BY value DESC LIMIT 6` },
  ],
});

export const latency = defineDashboard({
  id: "requests",
  title: "Requests and latency",
  widgets: [
    { type: "lines", title: "Latency", span: 12, height: 190, format: "ms", sql: `SELECT $__bucket(Timestamp) AS t, avg(DurationMs) AS average, quantile(0.95)(DurationMs) AS p95 ${requests} GROUP BY t ORDER BY t` },
    { type: "table", title: "Routes", span: 12, height: 300, sql: `SELECT Method AS method, Route AS route, count() AS requests, round(quantile(0.95)(DurationMs)) AS p95 ${requests} AND Route != '' GROUP BY method, route ORDER BY requests DESC LIMIT 20` },
  ],
});

export const database = defineDashboard({
  id: "database",
  title: "Database",
  widgets: [
    { type: "stat", title: "Queries", span: 4, sql: `SELECT sum(Calls) AS v FROM query_1m WHERE $__timeFilter(Minute) AND Environment = $__env` },
    { type: "stat", title: "Query errors", span: 4, tone: "error", sql: `SELECT sum(Errors) AS v FROM query_1m WHERE $__timeFilter(Minute) AND Environment = $__env` },
    { type: "stat", title: "Total time", span: 4, format: "ms", sql: `SELECT sum(Duration) AS v FROM query_1m WHERE $__timeFilter(Minute) AND Environment = $__env` },
    { type: "bars", title: "Queries over time", span: 12, height: 170, sql: `SELECT $__bucket(Minute) AS t, sum(Calls) AS ok, sum(Errors) AS error FROM query_1m WHERE $__timeFilter(Minute) AND Environment = $__env GROUP BY t ORDER BY t` },
    { type: "table", title: "Most time spent", span: 12, height: 280, sql: `SELECT any(Statement) AS statement, sum(Calls) AS calls, round(sum(Duration)) AS total_ms FROM query_1m WHERE $__timeFilter(Minute) AND Environment = $__env GROUP BY Hash ORDER BY total_ms DESC LIMIT 12` },
  ],
});

export const providers = defineDashboard({
  id: "providers",
  title: "Providers",
  widgets: [
    { type: "bars", title: "Calls", span: 12, height: 170, sql: `SELECT $__bucket(Timestamp) AS t, countIf(HttpStatus < 400) AS ok, countIf(HttpStatus >= 400) AS error ${ext} GROUP BY t ORDER BY t` },
    { type: "table", title: "Hosts", span: 12, height: 260, sql: `SELECT PeerHost AS host, count() AS calls, countIf(HttpStatus >= 400) AS errors, round(quantile(0.95)(Duration) / 1e6) AS p95_ms ${ext} GROUP BY host ORDER BY calls DESC` },
  ],
});

export const runtime = defineDashboard({
  id: "runtime",
  title: "Runtime",
  widgets: [
    { type: "lines", title: "Memory, MB", span: 6, height: 170, sql: `SELECT $__bucket(TimeUnix) AS t, avg(Value) AS memory FROM metrics_gauge WHERE $__timeFilter(TimeUnix) AND Environment = $__env AND MetricName = 'process.memory.usage' GROUP BY t ORDER BY t` },
    { type: "lines", title: "Event loop p99, ms", span: 6, height: 170, sql: `SELECT $__bucket(TimeUnix) AS t, avg(Value) AS delay FROM metrics_gauge WHERE $__timeFilter(TimeUnix) AND Environment = $__env AND MetricName = 'nodejs.eventloop.delay.p99' GROUP BY t ORDER BY t` },
    { type: "lines", title: "CPU, %", span: 6, height: 170, sql: `SELECT $__bucket(TimeUnix) AS t, avg(Value) AS cpu FROM metrics_gauge WHERE $__timeFilter(TimeUnix) AND Environment = $__env AND MetricName = 'process.cpu.utilization' GROUP BY t ORDER BY t` },
    { type: "lines", title: "Database connections", span: 6, height: 170, sql: `SELECT $__bucket(TimeUnix) AS t, avgIf(Value, Attributes['state'] = 'used') AS used, avgIf(Value, Attributes['state'] = 'idle') AS idle FROM metrics_gauge WHERE $__timeFilter(TimeUnix) AND Environment = $__env AND MetricName = 'db.client.connection.count' GROUP BY t ORDER BY t` },
  ],
});

export const exceptions = defineDashboard({
  id: "exceptions",
  title: "Exceptions",
  widgets: [
    { type: "bars", title: "Errors over time", span: 12, height: 170, sql: `SELECT $__bucket(Timestamp) AS t, 0 AS ok, count() AS error FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env AND SeverityText IN ('error', 'fatal') GROUP BY t ORDER BY t` },
    { type: "table", title: "By cause", span: 12, height: 280, sql: `SELECT LogAttributes['error.name'] AS name, count() AS events, uniqExact(UserId) AS people, any(LogAttributes['why']) AS why FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env AND SeverityText IN ('error', 'fatal') GROUP BY name ORDER BY events DESC LIMIT 12` },
  ],
});

export const publicApi = defineDashboard({
  id: "public-api",
  title: "Public API",
  widgets: [
    { type: "stat", title: "Calls", span: 4, sql: `SELECT count() AS v ${requests} AND LogAttributes['apiKey.id'] != ''` },
    { type: "stat", title: "Denied", span: 4, tone: "warn", sql: `SELECT countIf(Outcome = 'denied') AS v ${requests} AND LogAttributes['apiKey.id'] != ''` },
    { type: "stat", title: "Keys in use", span: 4, sql: `SELECT uniqExact(LogAttributes['apiKey.id']) AS v ${requests}` },
    { type: "table", title: "Keys", span: 12, height: 240, sql: `SELECT LogAttributes['apiKey.id'] AS key, count() AS calls, countIf(Status >= 400) AS errors ${requests} AND key != '' GROUP BY key ORDER BY calls DESC` },
  ],
});

export const emails = defineDashboard({
  id: "emails",
  title: "Emails",
  widgets: [
    { type: "stat", title: "Sent", span: 4, sql: `SELECT sum(toFloat64OrZero(LogAttributes['emails.sent'])) AS v FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env` },
    { type: "stat", title: "Refused", span: 4, tone: "error", sql: `SELECT sum(toFloat64OrZero(LogAttributes['emails.failed'])) AS v FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env` },
    { type: "stat", title: "Bounced", span: 4, tone: "warn", sql: `SELECT sum(toFloat64OrZero(LogAttributes['emailDeliveries.bounced'])) AS v FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env` },
    { type: "bars", title: "Volume", span: 12, height: 170, sql: `SELECT $__bucket(Timestamp) AS t, sum(toFloat64OrZero(LogAttributes['emails.sent'])) AS ok, sum(toFloat64OrZero(LogAttributes['emails.failed'])) AS error FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env AND LogAttributes['emails.template'] != '' GROUP BY t ORDER BY t` },
    { type: "table", title: "By template", span: 12, height: 200, sql: `SELECT LogAttributes['emails.template'] AS template, sum(toFloat64OrZero(LogAttributes['emails.sent'])) AS sent, sum(toFloat64OrZero(LogAttributes['emails.failed'])) AS failed FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env AND template != '' GROUP BY template ORDER BY sent DESC` },
  ],
});
