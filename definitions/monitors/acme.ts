import { defineMonitor } from "@vigiejs/sdk";

/** Our own public routes only. Provider endpoints are left out: they count our calls, and a probe every minute would spend that budget. */
export const api = defineMonitor({ id: "api", name: "API", url: "https://api.acme.example/ready", expect: 200 });
export const app = defineMonitor({ id: "app", name: "App", url: "https://app.acme.example" });
export const shop = defineMonitor({ id: "shop", name: "Shop", url: "https://shop.acme.example" });
