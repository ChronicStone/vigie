import { resolve } from "node:path";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { redact } from "@tanstack/redact/vite";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;

/**
 * `@server/*` is the Bun runtime: ingest queue, SQLite, extension registry.
 * Server functions import it as a real module instead of a bundled copy,
 * so one process holds one instance of every piece of state, in dev and in production.
 */
function runtimeIsExternal(): Plugin {
  let dev = false;
  const PREFIX = "\0vigie-runtime:";
  return {
    name: "vigie-runtime-external",
    enforce: "pre",
    configResolved(config) {
      dev = config.command === "serve";
    },
    resolveId(source) {
      if (!source.startsWith("@server/")) return null;
      const file = resolve(root, "server", source.slice("@server/".length));
      // Browser code never reaches these: the Start compiler removes server function bodies. Only the dev dependency scan looks.
      if (this.environment.name === "client") return dev ? `${PREFIX}client` : null;
      return dev ? `${PREFIX}${file}` : { id: file, external: true };
    },
    async load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const file = id.slice(PREFIX.length);
      if (file === "client") return "export {};";
      // Vite's module runner would make its own copy of a project file. Hand it the module Bun already loaded.
      const module = (await import(file)) as Record<string, unknown>;
      const store = ((globalThis as Record<string, unknown>).__vigieRuntime ??= {}) as Record<string, unknown>;
      store[file] = module;
      return [`const m = globalThis.__vigieRuntime[${JSON.stringify(file)}];`, ...Object.keys(module).map((name) => (name === "default" ? "export default m.default;" : `export const ${name} = m.${name};`))].join("\n");
    },
  };
}

/**
 * `vigie dev`: the runtime boots inside the Vite process, so server functions and the ingest queue share one instance
 * and the app gets hot reload. A change under server/ restarts the process: its state lives in native modules.
 */
function runtimeInDev(): Plugin {
  return {
    name: "vigie-runtime-dev",
    apply: "serve",
    async configureServer(server) {
      await import(resolve(root, "server/index.ts"));
      const { handleApp } = await import(resolve(root, "server/app.ts"));
      const { watch } = await import("node:fs");
      watch(resolve(root, "server"), { recursive: true }, () => process.exit(75));
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!;
        if (!path.startsWith("/api/") && path !== "/mcp" && path !== "/health") return next();
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
        const response = await handleApp(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
        res.statusCode = response.status;
        response.headers.forEach((value: string, key: string) => {
          if (key !== "content-security-policy") res.setHeader(key, value);
        });
        if (!response.body) return void res.end();
        const reader = response.body.getReader();
        res.on("close", () => void reader.cancel());
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      });
    },
  };
}

export default defineConfig({
  publicDir: resolve(root, "web/public"),
  plugins: [runtimeIsExternal(), runtimeInDev(), tanstackStart({ srcDirectory: "web/src", spa: { enabled: true, prerender: { outputPath: "/_shell", crawlLinks: false, retryCount: 0 } } }), react(), ...(process.env.VIGIE_REDACT ? [redact()] : [])],
  resolve: { alias: { "@web": resolve(root, "web/src"), "@sdk": resolve(root, "sdk/index.ts") } },
  server: { port: Number(process.env.VIGIE_WEB_PORT ?? 5310) },
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
});
