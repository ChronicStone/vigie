import { definePage, eventList, funnel, row, series, stateLine, table, ui } from "vigie/sdk";

const deliver = `FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env AND TaskKind = 'parcelo.ship'`;

export default definePage({
  id: "parcelo",
  title: "Parcelo",
  nav: { group: "Processes", order: 10 },
  process: "order-fulfilment",
  layout: [
    stateLine({
      sql: `SELECT countIf(Outcome != 'succeeded') AS failed, count() AS total ${deliver}`,
      text: (r) => (r.failed ? ui.inline(ui.text(`${r.failed} delivery attempts failed`, { tone: "warn" }), ui.text(" of ", { tone: "muted" }), ui.text(String(r.total), { tone: "muted" }), ui.text(". Most recover on the next retry.", { tone: "muted" })) : ui.text("Deliveries are healthy.")),
    }),
    funnel({
      title: "Parcels, from Parcelo to delivered",
      source: "defineProcess",
      steps: [
        { label: "Observed", sql: `SELECT sum(toUInt32OrZero(LogAttributes['parcelo.parcelsTracked'])) AS n FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env`, note: "from the registration read" },
        { label: "Unmatched", sql: `SELECT sum(toUInt32OrZero(LogAttributes['parcelo.parcelsUnmatched'])) AS n FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env`, note: "need a look", bad: true },
        { label: "Sent", sql: `SELECT uniqExact(TaskId) AS n ${deliver}`, note: "unique deliveries" },
        { label: "Delivered", sql: `SELECT uniqExactIf(TaskId, Outcome = 'succeeded') AS n ${deliver}`, note: "at least one success" },
        { label: "Certified", sql: `SELECT sum(toUInt32OrZero(LogAttributes['parcelo.parcelsDelivered'])) AS n FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env`, note: "labels created" },
      ],
    }),
    row(
      table({ title: "Why deliveries fail", span: 6, sql: `SELECT LogAttributes['taskOutcome.reason'] AS code, count() AS attempts, any(LogAttributes['why']) AS why ${deliver} AND Outcome != 'succeeded' GROUP BY code ORDER BY attempts DESC LIMIT 10` }),
      series({ title: "Deliveries over time", span: 6, kind: "bars", sql: `SELECT $__bucket(Timestamp) AS t, countIf(Outcome = 'succeeded') AS ok, countIf(Outcome != 'succeeded') AS error ${deliver} GROUP BY t ORDER BY t` }),
    ),
    eventList({ title: "Refused and rate limited", where: { "taskOutcome.type": "retry", "task.integration": "parcelo" }, limit: 12 }),
  ],
});
