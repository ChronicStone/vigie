import { defineTool } from "vigie/sdk";

export const blockedCustomers = defineTool({
  name: "parcelo_blocked",
  description: "Shipments to Parcelo that have not succeeded yet, with the reason.",
  scope: "read",
  run: ({ sql }) =>
    sql(`SELECT LogAttributes['task.key'] AS subject, argMax(LogAttributes['taskOutcome.reason'], Timestamp) AS code, argMax(LogAttributes['why'], Timestamp) AS why, max(Timestamp) AS last, countIf(Outcome = 'succeeded') AS ok FROM logs WHERE $__timeFilter(Timestamp) AND Environment = $__env AND TaskKind = 'parcelo.ship' GROUP BY subject HAVING ok = 0 ORDER BY last DESC LIMIT 50`),
});
