import { definePage, eventList, funnel, row, series, stateLine, table, ui } from "vigie/sdk";

const sync = `FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env AND TaskKind LIKE 'invoxa.%'`;

export default definePage({
  id: "invoxa",
  title: "Invoxa",
  nav: { group: "Processes", order: 30 },
  process: "billing-sync",
  layout: [
    stateLine({
      sql: `SELECT countIf(Outcome != 'succeeded') AS failed, count() AS total ${sync}`,
      text: (r) => (r.failed / Math.max(r.total, 1) > 0.05 ? ui.inline(ui.text("Invoxa sync is failing", { tone: "error" }), ui.text(` on ${r.failed} of ${r.total} attempts.`, { tone: "muted" })) : ui.text("Invoxa sync is healthy.")),
    }),
    funnel({
      title: "Invoxa sync, from start to finish",
      source: "defineProcess",
      steps: [
        { label: "Clients sent", sql: `SELECT uniqExactIf(TaskId, TaskKind = 'invoxa.customer.sync') AS n ${sync}` },
        { label: "Clients refused", sql: `SELECT uniqExactIf(TaskId, TaskKind = 'invoxa.customer.sync' AND Outcome != 'succeeded') AS n ${sync}`, bad: true },
        { label: "Invoices sent", sql: `SELECT uniqExactIf(TaskId, TaskKind = 'invoxa.invoices.sync' AND Outcome = 'succeeded') AS n ${sync}` },
      ],
    }),
    row(
      table({ title: "Why it fails", span: 6, sql: `SELECT LogAttributes['taskOutcome.reason'] AS code, count() AS attempts, any(LogAttributes['why']) AS why ${sync} AND Outcome != 'succeeded' GROUP BY code ORDER BY attempts DESC LIMIT 10` }),
      series({ title: "Attempts over time", span: 6, kind: "bars", sql: `SELECT $__bucket(Timestamp) AS t, countIf(Outcome = 'succeeded') AS ok, countIf(Outcome != 'succeeded') AS error ${sync} GROUP BY t ORDER BY t` }),
    ),
    eventList({ title: "Failed attempts", where: { "task.integration": "invoxa", outcome: "failed" }, limit: 12 }),
  ],
});
