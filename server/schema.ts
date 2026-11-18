import { config } from "./config.ts";
import { exec } from "./lib/clickhouse.ts";

const DB = config.clickhouse.database;

/** Same column names as the OpenTelemetry ClickHouse exporter, so HyperDX queries port and history can be copied. */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS spans (
    Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),
    TraceId String CODEC(ZSTD(1)),
    SpanId String CODEC(ZSTD(1)),
    ParentSpanId String CODEC(ZSTD(1)),
    SpanName LowCardinality(String),
    SpanKind LowCardinality(String),
    ServiceName LowCardinality(String),
    Environment LowCardinality(String),
    ServiceVersion LowCardinality(String),
    InstanceId LowCardinality(String),
    Duration UInt64 CODEC(ZSTD(1)),
    StatusCode LowCardinality(String),
    StatusMessage String CODEC(ZSTD(1)),
    SpanAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    EventsTimestamp Array(DateTime64(9)) CODEC(ZSTD(1)),
    EventsName Array(LowCardinality(String)) CODEC(ZSTD(1)),
    EventsAttributes Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    HttpRoute LowCardinality(String) MATERIALIZED SpanAttributes['http.route'],
    HttpStatus UInt16 MATERIALIZED toUInt16OrZero(if(SpanAttributes['http.response.status_code'] != '', SpanAttributes['http.response.status_code'], SpanAttributes['http.status_code'])),
    DbStatement String MATERIALIZED if(SpanAttributes['db.query.text'] != '', SpanAttributes['db.query.text'], SpanAttributes['db.statement']) CODEC(ZSTD(1)),
    DbStatementHash UInt64 MATERIALIZED cityHash64(normalizeQuery(DbStatement)),
    PeerHost LowCardinality(String) MATERIALIZED if(SpanAttributes['server.address'] != '', SpanAttributes['server.address'], SpanAttributes['net.peer.name']),
    TaskKind LowCardinality(String) MATERIALIZED SpanAttributes['task.kind'],
    TaskId String MATERIALIZED SpanAttributes['task.id'],
    UserId String MATERIALIZED SpanAttributes['user.id'],
    AccountId String MATERIALIZED SpanAttributes['workspace.accountId'],
    INDEX idx_trace TraceId TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_task TaskId TYPE bloom_filter(0.01) GRANULARITY 1
  ) ENGINE = MergeTree
  PARTITION BY toDate(Timestamp)
  ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))
  TTL toDateTime(Timestamp) + INTERVAL 30 DAY
  SETTINGS ttl_only_drop_parts = 1`,

  `CREATE TABLE IF NOT EXISTS logs (
    Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),
    EventId String CODEC(ZSTD(1)),
    TraceId String CODEC(ZSTD(1)),
    SpanId String CODEC(ZSTD(1)),
    SeverityText LowCardinality(String),
    SeverityNumber UInt8,
    ServiceName LowCardinality(String),
    Environment LowCardinality(String),
    ServiceVersion LowCardinality(String),
    InstanceId LowCardinality(String),
    Body String CODEC(ZSTD(1)),
    LogAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    Kind LowCardinality(String) MATERIALIZED multiIf(LogAttributes['method'] != '', 'request', LogAttributes['task.kind'] != '', 'task', LogAttributes['operation'] != '', 'operation', 'log'),
    Operation LowCardinality(String) MATERIALIZED LogAttributes['operation'],
    Outcome LowCardinality(String) MATERIALIZED LogAttributes['outcome'],
    Status UInt16 MATERIALIZED toUInt16OrZero(LogAttributes['status']),
    Method LowCardinality(String) MATERIALIZED LogAttributes['method'],
    Route LowCardinality(String) MATERIALIZED LogAttributes['route.pattern'],
    DurationMs Float32 MATERIALIZED toFloat32OrZero(if(LogAttributes['durationMs'] != '', LogAttributes['durationMs'], LogAttributes['duration'])),
    DbQueries UInt32 MATERIALIZED toUInt32OrZero(LogAttributes['db.queries']),
    TaskKind LowCardinality(String) MATERIALIZED LogAttributes['task.kind'],
    TaskId String MATERIALIZED LogAttributes['task.id'],
    UserId String MATERIALIZED LogAttributes['user.id'],
    AccountId String MATERIALIZED LogAttributes['workspace.accountId'],
    Fingerprint String MATERIALIZED LogAttributes['vigie.fingerprint'],
    INDEX idx_trace TraceId TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_event EventId TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1,
    INDEX idx_fp Fingerprint TYPE bloom_filter(0.01) GRANULARITY 1
  ) ENGINE = MergeTree
  PARTITION BY toDate(Timestamp)
  ORDER BY (ServiceName, Kind, toDateTime(Timestamp))
  TTL toDateTime(Timestamp) + INTERVAL 90 DAY
  SETTINGS ttl_only_drop_parts = 1`,

  `CREATE TABLE IF NOT EXISTS metrics_gauge (
    TimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
    MetricName LowCardinality(String),
    MetricUnit LowCardinality(String),
    MetricDescription LowCardinality(String),
    ServiceName LowCardinality(String),
    Environment LowCardinality(String),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    Value Float64 CODEC(ZSTD(1))
  ) ENGINE = MergeTree PARTITION BY toDate(TimeUnix) ORDER BY (MetricName, ServiceName, toDateTime(TimeUnix))
  TTL toDateTime(TimeUnix) + INTERVAL 30 DAY SETTINGS ttl_only_drop_parts = 1`,

  `CREATE TABLE IF NOT EXISTS metrics_sum (
    TimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
    MetricName LowCardinality(String),
    MetricUnit LowCardinality(String),
    MetricDescription LowCardinality(String),
    ServiceName LowCardinality(String),
    Environment LowCardinality(String),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    Value Float64 CODEC(ZSTD(1)),
    IsMonotonic Bool,
    AggregationTemporality UInt8
  ) ENGINE = MergeTree PARTITION BY toDate(TimeUnix) ORDER BY (MetricName, ServiceName, toDateTime(TimeUnix))
  TTL toDateTime(TimeUnix) + INTERVAL 30 DAY SETTINGS ttl_only_drop_parts = 1`,

  `CREATE TABLE IF NOT EXISTS metrics_histogram (
    TimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
    MetricName LowCardinality(String),
    MetricUnit LowCardinality(String),
    MetricDescription LowCardinality(String),
    ServiceName LowCardinality(String),
    Environment LowCardinality(String),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    Count UInt64 CODEC(ZSTD(1)),
    Sum Float64 CODEC(ZSTD(1)),
    BucketCounts Array(UInt64) CODEC(ZSTD(1)),
    ExplicitBounds Array(Float64) CODEC(ZSTD(1)),
    Min Nullable(Float64),
    Max Nullable(Float64)
  ) ENGINE = MergeTree PARTITION BY toDate(TimeUnix) ORDER BY (MetricName, ServiceName, toDateTime(TimeUnix))
  TTL toDateTime(TimeUnix) + INTERVAL 30 DAY SETTINGS ttl_only_drop_parts = 1`,

  // One row per trace, so the Traces explorer never scans spans.
  `CREATE TABLE IF NOT EXISTS trace_index (
    TraceId String,
    Environment LowCardinality(String),
    Day Date,
    Start SimpleAggregateFunction(min, DateTime64(9)),
    End SimpleAggregateFunction(max, DateTime64(9)),
    Spans SimpleAggregateFunction(sum, UInt64),
    Errors SimpleAggregateFunction(sum, UInt64),
    Services SimpleAggregateFunction(groupUniqArrayArray, Array(String)),
    Root AggregateFunction(argMinIf, String, DateTime64(9), UInt8),
    RootKind AggregateFunction(argMinIf, String, DateTime64(9), UInt8),
    RootStatus AggregateFunction(maxIf, UInt16, UInt8),
    RootRoute AggregateFunction(argMinIf, String, DateTime64(9), UInt8),
    RootMethod AggregateFunction(argMinIf, String, DateTime64(9), UInt8),
    RootTask AggregateFunction(argMinIf, String, DateTime64(9), UInt8)
  ) ENGINE = AggregatingMergeTree PARTITION BY Day ORDER BY (Environment, TraceId)
  TTL Day + INTERVAL 30 DAY SETTINGS ttl_only_drop_parts = 1`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS trace_index_mv TO trace_index AS
    SELECT TraceId, Environment, toDate(Timestamp) AS Day,
      min(Timestamp) AS Start,
      max(addNanoseconds(Timestamp, Duration)) AS End,
      count() AS Spans,
      countIf(StatusCode = 'Error') AS Errors,
      groupUniqArray(toString(ServiceName)) AS Services,
      argMinIfState(toString(SpanName), Timestamp, toUInt8(ParentSpanId = '')) AS Root,
      argMinIfState(toString(SpanKind), Timestamp, toUInt8(ParentSpanId = '')) AS RootKind,
      maxIfState(HttpStatus, toUInt8(ParentSpanId = '')) AS RootStatus,
      argMinIfState(toString(HttpRoute), Timestamp, toUInt8(ParentSpanId = '')) AS RootRoute,
      argMinIfState(SpanAttributes['http.request.method'], Timestamp, toUInt8(ParentSpanId = '')) AS RootMethod,
      argMinIfState(toString(TaskKind), Timestamp, toUInt8(ParentSpanId = '')) AS RootTask
    FROM spans GROUP BY TraceId, Environment, Day`,

  `CREATE TABLE IF NOT EXISTS req_1m (
    Minute DateTime,
    Environment LowCardinality(String),
    ServiceName LowCardinality(String),
    Method LowCardinality(String),
    Route LowCardinality(String),
    StatusClass UInt16,
    Outcome LowCardinality(String),
    Requests SimpleAggregateFunction(sum, UInt64),
    Duration SimpleAggregateFunction(sum, Float64),
    Quantiles AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), Float32),
    LastSeen SimpleAggregateFunction(max, DateTime)
  ) ENGINE = AggregatingMergeTree PARTITION BY toDate(Minute)
  ORDER BY (Environment, ServiceName, Route, Method, StatusClass, Outcome, Minute)
  TTL Minute + INTERVAL 400 DAY SETTINGS ttl_only_drop_parts = 1`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS req_1m_mv TO req_1m AS
    SELECT toStartOfMinute(Timestamp) AS Minute, Environment, ServiceName, Method, Route,
      toUInt16(intDiv(Status, 100) * 100) AS StatusClass, Outcome,
      count() AS Requests, sum(toFloat64(DurationMs)) AS Duration,
      quantilesTDigestState(0.5, 0.95, 0.99)(DurationMs) AS Quantiles,
      max(toDateTime(Timestamp)) AS LastSeen
    FROM logs WHERE Kind = 'request'
    GROUP BY Minute, Environment, ServiceName, Method, Route, StatusClass, Outcome`,

  // The names people and agents query, so a query reads like the product and survives a column rename underneath.
  `CREATE OR REPLACE VIEW events AS SELECT Timestamp, EventId, TraceId, ServiceName, Environment, ServiceVersion, Kind, Body, Operation, Outcome, Status, Method, Route, DurationMs, TaskKind, TaskId, UserId, AccountId, Fingerprint, LogAttributes AS Fields FROM logs`,
  `CREATE OR REPLACE VIEW requests AS SELECT Timestamp, TraceId, ServiceName, Environment, Method, Route, Status, DurationMs, Outcome, DbQueries, UserId, AccountId FROM logs WHERE Kind = 'request'`,
  `CREATE OR REPLACE VIEW task_attempts AS SELECT Timestamp, TaskId, TaskKind, LogAttributes['task.key'] AS Key, toUInt32OrZero(LogAttributes['task.attempt']) AS Attempt, toUInt32OrZero(LogAttributes['task.run']) AS Run, Outcome, LogAttributes['taskOutcome.type'] AS Type, LogAttributes['taskOutcome.code'] AS Code, LogAttributes['workerId'] AS Worker, DurationMs, LogAttributes['task.subject.type'] AS SubjectType, LogAttributes['task.subject.id'] AS SubjectId, LogAttributes['task.causedBy'] AS CausedBy, TraceId, Environment, AccountId FROM logs WHERE Kind = 'task'`,
  `CREATE OR REPLACE VIEW queries AS SELECT Timestamp, TraceId, ServiceName, Environment, DbStatement AS Statement, toString(DbStatementHash) AS Hash, Duration / 1000000 AS DurationMs, StatusCode, TaskKind, TaskId, UserId, AccountId FROM spans WHERE DbStatement != ''`,
  `CREATE OR REPLACE VIEW provider_calls AS SELECT Timestamp, TraceId, ServiceName, Environment, if(SpanAttributes['peer.service'] != '', SpanAttributes['peer.service'], toString(PeerHost)) AS Provider, SpanAttributes['provider.operation'] AS Operation, toString(PeerHost) AS Host, HttpStatus AS Status, Duration / 1000000 AS DurationMs, HttpStatus = 0 OR HttpStatus >= 400 AS Failed, TaskKind, TaskId FROM spans WHERE PeerHost != '' AND DbStatement = ''`,

  `CREATE TABLE IF NOT EXISTS task_mirror (
    Id String,
    Kind LowCardinality(String),
    Key String,
    State LowCardinality(String),
    Standing UInt8,
    AccountId String,
    TestCenterId String,
    SubjectType LowCardinality(String),
    SubjectId String,
    SerialKey String,
    RunAt DateTime64(3),
    Attempts UInt32,
    Runs UInt32,
    ConsecutiveFailures UInt32,
    LeaseUntil Nullable(DateTime64(3)),
    WorkerId String,
    WaitReason String,
    Code LowCardinality(String),
    CausedBy String,
    CreatedBy String,
    TraceId String,
    LastRunAt Nullable(DateTime64(3)),
    LastOkAt Nullable(DateTime64(3)),
    CreatedAt DateTime64(3),
    UpdatedAt DateTime64(3),
    SettledAt Nullable(DateTime64(3))
  ) ENGINE = ReplacingMergeTree(UpdatedAt) ORDER BY Id
  TTL toDateTime(CreatedAt) + INTERVAL 400 DAY`,

  `CREATE TABLE IF NOT EXISTS switch_changes (
    Id String,
    Key LowCardinality(String),
    Enabled UInt8,
    PreviousEnabled UInt8,
    Reason String,
    UserId String,
    CreatedAt DateTime64(3)
  ) ENGINE = ReplacingMergeTree ORDER BY (Key, CreatedAt, Id)
  TTL toDateTime(CreatedAt) + INTERVAL 400 DAY`,

  `CREATE TABLE IF NOT EXISTS task_1m (
    Minute DateTime,
    Environment LowCardinality(String),
    TaskKind LowCardinality(String),
    Outcome LowCardinality(String),
    Attempts SimpleAggregateFunction(sum, UInt64),
    Duration SimpleAggregateFunction(sum, Float64),
    Quantiles AggregateFunction(quantilesTDigest(0.5, 0.95), Float32)
  ) ENGINE = AggregatingMergeTree PARTITION BY toDate(Minute)
  ORDER BY (Environment, TaskKind, Outcome, Minute)
  TTL Minute + INTERVAL 400 DAY SETTINGS ttl_only_drop_parts = 1`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS task_1m_mv TO task_1m AS
    SELECT toStartOfMinute(Timestamp) AS Minute, Environment, TaskKind, Outcome,
      count() AS Attempts, sum(toFloat64(DurationMs)) AS Duration,
      quantilesTDigestState(0.5, 0.95)(DurationMs) AS Quantiles
    FROM logs WHERE Kind = 'task'
    GROUP BY Minute, Environment, TaskKind, Outcome`,

  `CREATE TABLE IF NOT EXISTS query_1m (
    Minute DateTime,
    Environment LowCardinality(String),
    ServiceName LowCardinality(String),
    Hash UInt64,
    Statement SimpleAggregateFunction(any, String),
    Operation SimpleAggregateFunction(any, String),
    Calls SimpleAggregateFunction(sum, UInt64),
    Errors SimpleAggregateFunction(sum, UInt64),
    Duration SimpleAggregateFunction(sum, Float64),
    Quantiles AggregateFunction(quantilesTDigest(0.5, 0.95), Float64),
    LastSeen SimpleAggregateFunction(max, DateTime)
  ) ENGINE = AggregatingMergeTree PARTITION BY toDate(Minute)
  ORDER BY (Environment, ServiceName, Hash, Minute)
  TTL Minute + INTERVAL 400 DAY SETTINGS ttl_only_drop_parts = 1`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS query_1m_mv TO query_1m AS
    SELECT toStartOfMinute(Timestamp) AS Minute, Environment, ServiceName, DbStatementHash AS Hash,
      any(normalizeQuery(DbStatement)) AS Statement,
      any(splitByChar(' ', upper(trimLeft(DbStatement)))[1]) AS Operation,
      count() AS Calls, countIf(StatusCode = 'Error') AS Errors,
      sum(spans.Duration / 1e6) AS Duration,
      quantilesTDigestState(0.5, 0.95)(toFloat64(spans.Duration / 1e6)) AS Quantiles,
      max(toDateTime(Timestamp)) AS LastSeen
    FROM spans WHERE DbStatement != ''
    GROUP BY Minute, Environment, ServiceName, Hash`,

  `CREATE TABLE IF NOT EXISTS edges_5m (
    Bucket DateTime,
    Environment LowCardinality(String),
    Caller LowCardinality(String),
    Callee LowCardinality(String),
    CalleeKind LowCardinality(String),
    Calls SimpleAggregateFunction(sum, UInt64),
    Errors SimpleAggregateFunction(sum, UInt64)
  ) ENGINE = AggregatingMergeTree PARTITION BY toDate(Bucket)
  ORDER BY (Environment, Caller, Callee, CalleeKind, Bucket)
  TTL Bucket + INTERVAL 90 DAY SETTINGS ttl_only_drop_parts = 1`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS edges_5m_mv TO edges_5m AS
    SELECT toStartOfFiveMinutes(Timestamp) AS Bucket, Environment, ServiceName AS Caller,
      multiIf(DbStatement != '', if(SpanAttributes['db.system'] != '', SpanAttributes['db.system'], 'database'), PeerHost != '', toString(PeerHost), '') AS Callee,
      multiIf(DbStatement != '', 'database', SpanAttributes['db.system'] = 'redis', 'cache', 'external') AS CalleeKind,
      count() AS Calls, countIf(StatusCode = 'Error') AS Errors
    FROM spans WHERE Callee != ''
    GROUP BY Bucket, Environment, Caller, Callee, CalleeKind`,
];

export async function migrate() {
  await exec(`CREATE DATABASE IF NOT EXISTS ${DB}`, { withDatabase: false });
  for (const statement of STATEMENTS) await exec(statement);
}
