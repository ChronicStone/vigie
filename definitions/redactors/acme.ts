import { defineRedactor } from "@vigiejs/sdk";

/** Webhook and receipt links carry their secret in the path. */
export const acmePaths = defineRedactor({ name: "Acme secret links", paths: ["parcelo/webhooks", "receipts"] });
