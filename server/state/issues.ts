import { db } from "./db.ts";

const LOG_NUMERIC = /\b[0-9a-f]{8,}\b|\b\d+\b|"[^"]*"|'[^']*'/gi;

function stem(text: string) {
  return text.replace(LOG_NUMERIC, "?").slice(0, 200);
}

function firstFrame(stack: string | undefined) {
  if (!stack) return "";
  const line = stack.split("\n").find((l) => l.includes(" at ") && !l.includes("node_modules"));
  return line ? line.trim().replace(/:\d+:\d+\)?$/, "") : "";
}

function fingerprintOf(name: string, message: string, stack: string | undefined) {
  return Bun.hash(`${name}|${firstFrame(stack) || stem(message)}`).toString(36);
}

const upsert = db.query(`
  INSERT INTO issues (fingerprint, name, message, service, environment, entry, first_seen, last_seen, events, why, fix, link, stack, priority)
  VALUES ($fp, $name, $message, $service, $environment, $entry, $now, $now, 1, $why, $fix, $link, $stack, $priority)
  ON CONFLICT(fingerprint) DO UPDATE SET
    last_seen = $now,
    events = events + 1,
    message = $message,
    why = COALESCE($why, why),
    fix = COALESCE($fix, fix),
    link = COALESCE($link, link),
    stack = COALESCE($stack, stack),
    regressed = CASE WHEN status = 'resolved' THEN 1 ELSE regressed END,
    regressed_in = CASE WHEN status = 'resolved' THEN $version ELSE regressed_in END,
    status = CASE WHEN status = 'resolved' THEN 'open'
                  WHEN status = 'archived' AND archived_until IS NOT NULL AND archived_until < $now THEN 'open'
                  ELSE status END
`);

/** Groups errors at ingest. A resolved issue that fires again reopens as a regression. */
export function noteIssues(rows: any[], kind: "log" | "span") {
  for (const row of rows) {
    if (kind === "log") {
      const a = row.LogAttributes;
      const failed = row.SeverityText === "error" || row.SeverityText === "fatal";
      // The app logs a failed task attempt at info level with a code and no exception. It is still a failure.
      const taskFailed = a.outcome === "failed" && Boolean(a["taskOutcome.code"]);
      const name = a["error.name"] ?? a["error.type"] ?? a["exception.type"] ?? a["taskOutcome.code"] ?? a.reason ?? (a["ai.feature"] ? `AI ${a["ai.feature"]} failed` : undefined);
      // A 404 or a refused form is the app answering correctly, not a problem to triage.
      const clientError = /^4\d\d$/.test(a.status ?? "");
      if (!failed && !taskFailed && (clientError || !a["error.message"])) continue;
      const message = a["error.message"] ?? a["exception.message"] ?? a.why ?? a["taskOutcome.reason"] ?? a.reason ?? row.Body;
      const stack = a["error.stack"] ?? a["exception.stacktrace"];
      // One code on one kind is one problem, whatever the row it happened on.
      const fp = taskFailed && !a["error.name"] ? fingerprintOf(`${a["task.kind"]}:${name}`, name ?? "", undefined) : fingerprintOf(name ?? "Error", String(message), stack);
      a["vigie.fingerprint"] = fp;
      save(fp, name ?? "Error", String(message), row, a, stack, a["route.pattern"] ? `${a.method} ${a["route.pattern"]}` : a["task.kind"] ? `task ${a["task.kind"]}` : (a.operation ?? ""));
    } else {
      const index = (row.EventsName as string[]).indexOf("exception");
      if (index < 0) continue;
      const e = row.EventsAttributes[index];
      const name = e["exception.type"] ?? "Error";
      const message = e["exception.message"] ?? row.StatusMessage ?? "";
      const stack = e["exception.stacktrace"];
      const fp = fingerprintOf(name, message, stack);
      row.SpanAttributes["vigie.fingerprint"] = fp;
      save(fp, name, message, row, row.SpanAttributes, stack, row.SpanName);
    }
  }
}

type MuteRule = { id: string; pattern: string; service: string | null; environment: string | null };
const muteRules = db.query<MuteRule, []>("SELECT id, pattern, service, environment FROM mute_rules");

/** The first rule that covers this error. A rule matches the name or message, within its service and environment. */
export function muteRuleFor(name: string, message: string, service: string, environment: string, rules: MuteRule[] = muteRules.all()) {
  const text = `${name} ${message}`.toLowerCase();
  return rules.find((rule) => text.includes(rule.pattern.toLowerCase()) && (!rule.service || rule.service === service) && (!rule.environment || rule.environment === environment));
}

const setMuted = db.query("UPDATE issues SET muted_by = ? WHERE fingerprint = ?");

const statusOf = db.query<{ status: string; resolved_at: number | null }, [string]>("SELECT status, resolved_at FROM issues WHERE fingerprint = ?");

function save(fp: string, name: string, message: string, row: any, a: Record<string, string>, stack: string | undefined, entry: string) {
  const before = statusOf.get(fp);
  upsert.run({
    $fp: fp,
    $name: name,
    $message: message.slice(0, 1000),
    $service: row.ServiceName,
    $environment: row.Environment,
    $entry: entry,
    $now: Date.now(),
    $why: a.why ?? a["error.why"] ?? null,
    $fix: a.fix ?? a["error.fix"] ?? null,
    $link: a.link ?? a["error.link"] ?? null,
    $stack: stack?.slice(0, 8000) ?? null,
    $version: row.ServiceVersion,
    $priority: a["taskOutcome.type"] === "RETRY" || a["ai.feature"] ? "medium" : row.Environment === "PRD" ? "high" : "medium",
  });
  const rule = muteRuleFor(name, message, row.ServiceName, row.Environment);
  if (rule) setMuted.run(rule.id, fp);
  else if (before?.status === "resolved") void import("../alerts.ts").then(({ notifyCameBack }) => notifyCameBack({ fp, name, message, version: row.ServiceVersion, resolvedAt: before.resolved_at, environment: row.Environment }));
}
