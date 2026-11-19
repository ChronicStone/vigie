import { defineAlert } from "@vigiejs/sdk";

export const taskFailureRate = defineAlert({ id: "task-failure-rate", name: "Task failure rate", family: "Tasks", when: { source: "task-failure-rate" }, above: 5, window: "15m", unit: "%", condition: "Failed attempts above 5% over 15 min" });
export const oldestDue = defineAlert({ id: "oldest-due", name: "Tasks waiting too long", family: "Tasks", when: { source: "oldest-due" }, above: 300, window: "5m", for: "5m", unit: "s", condition: "Oldest due task above 5 min for 5 min" });
export const apiErrors = defineAlert({ id: "api-5xx", name: "API 5xx rate", family: "Requests", when: { source: "request-error-rate" }, above: 2, window: "10m", unit: "%", condition: "Server errors above 2% over 10 min" });
export const apiP95 = defineAlert({ id: "api-p95", name: "API p95", family: "Endpoint", when: { source: "route-p95", minRequests: 20 }, above: 2000, window: "10m", unit: "ms", condition: "p95 above 2 s over 10 min, at least 20 requests" });
export const refusedEmails = defineAlert({ id: "refused-emails", name: "Refused emails", family: "Log pattern", when: { source: "log-count", where: { "emails.failed": "1" } }, above: 5, window: "1h", condition: "More than 5 refused sends in 1 h" });
export const noPayments = defineAlert({ id: "no-payments", name: "No payments ingested", family: "No activity", when: { source: "absence", taskKind: "paynest.payment.ingest" }, below: 1, window: "30m", condition: "No paynest.payment.ingest for 30 min" });
export const heap = defineAlert({ id: "heap", name: "Heap above 80%", family: "Runtime", when: { source: "metric", name: "v8.heap.used", agg: "max" }, above: 410, window: "10m", unit: "MB", condition: "Heap used above 410 MB for 10 min" });
