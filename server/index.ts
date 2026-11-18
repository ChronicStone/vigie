import { config } from "./config.ts";
import { handleIngest } from "./ingest/routes.ts";
import { startPipeline, stopPipeline } from "./ingest/pipeline.ts";
import { ping } from "./lib/clickhouse.ts";
import { migrate } from "./schema.ts";
import { handleApp } from "./app.ts";
import { startBackground } from "./background.ts";
import { migrateAuth, setupCode, usersExist } from "./auth.ts";
import { loadExtensions, registry, watchExtensions } from "./extensions/index.ts";

async function waitForClickHouse() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await ping()) return;
    if (attempt === 0) console.log(`Waiting for ClickHouse at ${config.clickhouse.url}…`);
    await Bun.sleep(1000);
  }
  throw new Error(`ClickHouse did not answer at ${config.clickhouse.url}`);
}

// A browser cancelling a query it no longer needs is normal: it must not read as a server error.
const logError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (args.some((a) => a instanceof Error && a.name === "AbortError")) return;
  logError(...args);
};

await waitForClickHouse();
await migrate();
await migrateAuth();
await loadExtensions();
watchExtensions();
const broken = registry.loaded.filter((l) => !l.ok);
for (const item of broken) console.warn(`Definition failed: ${item.file}: ${item.error}`);
startPipeline();
startBackground();

Bun.serve({
  hostname: config.host,
  port: config.ingestPort,
  idleTimeout: 60,
  maxRequestBodySize: 32 * 1024 * 1024,
  async fetch(request) {
    return (await handleIngest(request)) ?? (new URL(request.url).pathname === "/health" ? new Response("ok") : new Response("Not found", { status: 404 }));
  },
});

Bun.serve({
  hostname: config.host,
  port: config.uiPort,
  idleTimeout: 120,
  maxRequestBodySize: 8 * 1024 * 1024,
  fetch: handleApp,
});

if (config.mode === "server" && !usersExist()) console.log(`First run. Create the owner at ${config.publicUrl} with this setup code: ${setupCode()}`);
console.log(`Vigie is running.\n  App:    ${config.publicUrl}\n  OTLP:   http://${config.host}:${config.ingestPort}/v1/{traces,logs,metrics}\n  MCP:    ${config.publicUrl}/mcp\n  Mode:   ${config.mode}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await stopPipeline();
    process.exit(0);
  });
}
