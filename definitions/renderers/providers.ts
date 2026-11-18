import { defineLogRenderer, ui } from "vigie/sdk";

export const parcelo = defineLogRenderer({
  id: "parcelo",
  match: "parcelo.*",
  title: "Parcelo",
  render: (e) => [
    e.has("parcelo.parcelsTracked") &&
      ui.numbers({
        observed: e.num("parcelo.parcelsTracked"),
        created: e.num("parcelo.parcelsDelivered"),
        unmatched: { value: e.num("parcelo.parcelsUnmatched"), tone: e.num("parcelo.parcelsUnmatched") ? "warn" : "neutral" },
      }),
    ui.fields(e, "parcelo.", { hide: /parcels/, tones: { refused: "error", rate_limited: "warn" } }),
  ],
  row: (e) => (e.has("parcelo.parcelsTracked") ? `${e.num("parcelo.parcelsTracked")} parcels tracked` : null),
  text: (e) => `Parcelo ${e.str("parcelo.operation")}: ${e.str("parcelo.outcome")}`,
});

export const paynest = defineLogRenderer({
  id: "paynest",
  match: "paynest.*",
  title: "Paynest",
  render: (e) => [ui.fields(e, "paynest.")],
  text: (e) => `Paynest ${e.str("paynest.remote.lastOperation")}: ${e.num("paynest.remote.requestCount")} calls`,
});

export const paymentIngest = defineLogRenderer({
  id: "payment-ingest",
  match: "paymentIngest.*",
  title: "Payment ingest",
  render: (e) => [ui.fields(e, "paymentIngest.", { tones: { failed: "error" } })],
  row: (e) => (e.has("paymentIngest.result") ? `payment ${e.str("paymentIngest.result")}` : null),
});

export const deliveries = defineLogRenderer({
  id: "email-deliveries",
  match: "emailDeliveries.*",
  title: "Email deliveries",
  render: (e) => [
    ui.numbers({
      checked: e.num("emailDeliveries.checked"),
      delivered: e.num("emailDeliveries.delivered"),
      bounced: { value: e.num("emailDeliveries.bounced"), tone: e.num("emailDeliveries.bounced") ? "warn" : "neutral" },
    }),
  ],
  row: (e) => `${e.num("emailDeliveries.checked")} deliveries checked`,
});

export const emails = defineLogRenderer({
  id: "emails",
  match: "emails.*",
  title: "Email",
  render: (e) => [ui.fields(e, "emails.", { tones: { "1": "neutral" } })],
});

export const ai = defineLogRenderer({
  id: "ai",
  match: "ai.*",
  title: "AI call",
  render: (e) => [
    ui.numbers({ tokens: e.num("ai.tokens"), cost: `$${e.num("ai.costUsd").toFixed(4)}`, time: ui.duration(e.num("ai.durationMs")) }),
    ui.fields(e, "ai.", { hide: /tokens|costUsd|durationMs/, tones: { failed: "error" } }),
  ],
});
