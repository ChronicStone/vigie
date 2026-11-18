import { defineProcess, step } from "vigie/sdk";

export const fulfilment = defineProcess({
  id: "order-fulfilment",
  title: "Order fulfilment",
  subject: "order",
  keyPrefix: "order:",
  description: "From a Paynest payment to a parcel on its way.",
  sla: "4h",
  steps: [
    step.task("paynest.payment.ingest", { label: "Payment confirmed by Paynest", expectWithin: "30m" }),
    step.parallel([
      step.task("receipts.render", { label: "Receipt rendered", expectWithin: "10m", optional: true }),
      step.task("receipts.email", { label: "Customer emailed", expectWithin: "1h", optional: true }),
      step.task("parcelo.ship", { label: "Shipment created at Parcelo", expectWithin: "15m", provider: "parcelo" }),
      step.task("tax.declare", { label: "Declared to Taxbox", expectWithin: "24h", optional: true }),
    ]),
  ],
});

export const customers = defineProcess({
  id: "customer-registration",
  title: "Customer registration",
  subject: "customer",
  keyPrefix: "customer:",
  steps: [step.task("paynest.customer.create", { label: "Customer created on Paynest", expectWithin: "1h" })],
});

export const billing = defineProcess({
  id: "billing-sync",
  title: "Billing sync",
  subject: "invoice",
  keyPrefix: "invoice:",
  steps: [
    step.task("invoxa.customer.sync", { label: "Client matched in Invoxa", expectWithin: "1h" }),
    step.task("invoxa.invoices.sync", { label: "Invoice sent to Invoxa", expectWithin: "1h" }),
  ],
});

export const exportsProcess = defineProcess({
  id: "exports",
  title: "Exports",
  subject: "export",
  keyPrefix: "export:",
  steps: [step.task("exports.process", { label: "Export rendered", expectWithin: "30m" })],
});

export const crm = defineProcess({
  id: "crm-sync",
  title: "CRM sync",
  subject: "company",
  keyPrefix: "company:",
  steps: [step.task("pipedeck.company.sync", { label: "Company sent to Pipedeck", expectWithin: "1h" })],
});
