import { defineStatusPage } from "@vigiejs/sdk";
import { api, app, shop } from "./monitors/acme.ts";

/** What customers see at /status. Provider alerts stay off: an outage at Parcelo is not ours to announce. */
export const status = defineStatusPage({
  title: "Acme status",
  description: "The Acme shop, its API and the app. Orders already paid are kept during an outage.",
  components: [
    { name: "App", from: app },
    { name: "API", from: api },
    { name: "Shop", from: shop },
  ],
  days: 90,
});
