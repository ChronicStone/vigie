import { definePage, eventList, funnel, row, series, stateLine, table, ui } from "@vigiejs/sdk";

const ingest = `FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env AND TaskKind = 'paynest.payment.ingest'`;

export default definePage({
  id: "paynest",
  title: "Paynest",
  nav: { group: "Processes", order: 20 },
  layout: [
    stateLine({
      sql: `SELECT countIf(Outcome != 'succeeded') AS failed ${ingest}`,
      text: (r) => (r.failed ? ui.inline(ui.text(`${r.failed} payments failed to store`, { tone: "warn" }), ui.text(" and need a look.", { tone: "muted" })) : ui.text("Ingest is healthy.")),
    }),
    funnel({
      title: "Paynest payments, from start to finish",
      source: "defineProcess",
      steps: [
        { label: "Read", sql: `SELECT uniqExact(LogAttributes['task.key']) AS n ${ingest}`, note: "payments seen on Paynest" },
        { label: "Stored", sql: `SELECT uniqExactIf(LogAttributes['task.key'], Outcome = 'succeeded') AS n ${ingest}` },
        { label: "Failed", sql: `SELECT uniqExactIf(LogAttributes['task.key'], Outcome != 'succeeded') AS n ${ingest}`, bad: true, note: "need a look" },
      ],
    }),
    row(
      table({ title: "Why payments fail", span: 6, sql: `SELECT LogAttributes['taskOutcome.reason'] AS code, count() AS attempts, any(LogAttributes['why']) AS why ${ingest} AND Outcome != 'succeeded' GROUP BY code ORDER BY attempts DESC LIMIT 10` }),
      series({ title: "Calls to Paynest", span: 6, kind: "bars", sql: `SELECT $__bucket(Timestamp) AS t, countIf(HttpStatus < 400) AS ok, countIf(HttpStatus >= 400) AS error FROM spans WHERE $__timeFilter(Timestamp) AND Environment = $__env AND PeerHost = 'api.paynest.example' GROUP BY t ORDER BY t` }),
    ),
    eventList({ title: "Failed payments", where: { "task.kind": "paynest.payment.ingest", outcome: "failed" }, limit: 12 }),
  ],
});
