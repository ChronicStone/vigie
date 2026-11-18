#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
// `vigie --seed` means `vigie up --seed`.
const [command = "up", ...rest] = args[0]?.startsWith("-") ? ["up", ...args] : args;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const ok = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`\x1b[31m✗\x1b[0m ${s}`);

function flags(options: Record<string, { type: "string" | "boolean" }>) {
  return parseArgs({ args: rest, options, allowPositionals: true }).values as Record<string, any>;
}

const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
const dataDir = () => resolve(process.env.VIGIE_DATA_DIR ?? join(homedir(), ".vigie"));

async function waitFor(url: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return true;
    } catch {}
    await Bun.sleep(500);
  }
  return false;
}

/** Local mode uses the same engine as production: an installed clickhouse, else Docker, else a downloaded binary. */
async function ensureClickHouse(): Promise<{ url: string; stop?: () => void; how: string }> {
  if (process.env.CLICKHOUSE_URL) return { url: process.env.CLICKHOUSE_URL, how: "CLICKHOUSE_URL" };
  const port = Number(process.env.VIGIE_CH_PORT ?? 18123);
  const url = `http://127.0.0.1:${port}`;
  if (await waitFor(`${url}/ping`, 0.5)) return { url, how: "already running" };
  const dir = join(dataDir(), "clickhouse");
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.xml");
  writeFileSync(
    configPath,
    // A laptop has room, and the desktop build of ClickHouse resides far above the server's. The server's cap stays in the file.
    readFileSync(join(root, "deploy/clickhouse/vigie.xml"), "utf8").replace(/<max_server_memory_usage>\d+/, "<max_server_memory_usage>3000000000").replace("</clickhouse>", `  <http_port>${port}</http_port>\n  <listen_host>127.0.0.1</listen_host>\n  <path>${dir}/data/</path>\n  <tmp_path>${dir}/tmp/</tmp_path>\n  <user_files_path>${dir}/files/</user_files_path>\n  <format_schema_path>${dir}/schemas/</format_schema_path>\n  <logger><level>warning</level><console>0</console><log>${dir}/clickhouse.log</log><errorlog>${dir}/clickhouse.err.log</errorlog></logger>\n  <users><default><password></password><networks><ip>127.0.0.1</ip><ip>::1</ip></networks><profile>default</profile><quota>default</quota><access_management>1</access_management></default></users>\n  <profiles><default/></profiles>\n  <quotas><default/></quotas>\n</clickhouse>`),
  );
  let binary = has("clickhouse") ? "clickhouse" : "";
  if (!binary && has("docker") && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0) {
    const name = "vigie-local-ch";
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    const run = spawnSync("docker", ["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:8123`, "-v", `${name}:/var/lib/clickhouse`, "-v", `${join(root, "deploy/clickhouse/vigie.xml")}:/etc/clickhouse-server/config.d/vigie.xml:ro`, "-e", "CLICKHOUSE_SKIP_USER_SETUP=1", "--memory", "1g", "clickhouse/clickhouse-server:25.8"], { stdio: "inherit" });
    if (run.status === 0 && (await waitFor(`${url}/ping`, 60))) return { url, how: "Docker", stop: () => void spawnSync("docker", ["stop", name], { stdio: "ignore" }) };
  }
  if (!binary) {
    const target = join(dataDir(), "bin", "clickhouse");
    if (!existsSync(target)) {
      mkdirSync(join(dataDir(), "bin"), { recursive: true });
      const os = platform() === "darwin" ? "macos" : "amd64";
      const flavor = platform() === "darwin" ? (arch() === "arm64" ? "macos-aarch64" : "macos") : arch() === "arm64" ? "aarch64" : os;
      console.log(`Downloading ClickHouse (${flavor}) to ${target}…`);
      const response = await fetch(`https://builds.clickhouse.com/master/${flavor}/clickhouse`);
      if (!response.ok) throw new Error(`Could not download ClickHouse: ${response.status}. Install it or start Docker.`);
      await Bun.write(target, response);
      chmodSync(target, 0o755);
    }
    binary = target;
  }
  const child = spawn(binary, ["server", "--config-file", configPath], { stdio: "ignore", detached: false });
  if (!(await waitFor(`${url}/ping`, 40))) throw new Error(`ClickHouse did not start. See ${dir}/clickhouse.err.log`);
  return { url, how: binary === "clickhouse" ? "installed binary" : "downloaded binary", stop: () => child.kill() };
}

/** A checkout builds the app once; an installed package ships it built. */
function ensureBuilt() {
  if (existsSync(join(root, "dist/client")) && existsSync(join(root, "dist/server/server.js"))) return;
  if (!existsSync(join(root, "web/src"))) throw new Error("This copy of Vigie has no built app. Reinstall it.");
  console.log("Building the app once…");
  const built = spawnSync("bun", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (built.status !== 0) throw new Error("The build failed.");
}

/** The app's own definitions: --definitions, else ./definitions or ./vigie here, else an empty folder. */
function findDefinitions(given?: string) {
  if (given) return resolve(given);
  for (const name of ["definitions", "vigie"]) {
    const dir = resolve(process.cwd(), name);
    if (existsSync(dir)) return dir;
  }
  const empty = join(dataDir(), "definitions");
  mkdirSync(empty, { recursive: true });
  return empty;
}

/** The first free port from here. 4318 is every OpenTelemetry tool's default, so it is often taken. */
function freePort(start: number) {
  for (let port = start; port < start + 50; port++) {
    try {
      Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() }).stop(true);
      return port;
    } catch {
      // Taken: try the next one.
    }
  }
  throw new Error(`No free port near ${start}.`);
}

const commands: Record<string, () => Promise<void>> = {
  /** Everything on this machine from an installed package: ClickHouse, ingest and the built app. */
  async up() {
    const values = flags({ seed: { type: "boolean" }, port: { type: "string" }, definitions: { type: "string" } });
    ensureBuilt();
    const clickhouse = await ensureClickHouse();
    ok(`ClickHouse ready (${clickhouse.how})`);
    const uiPort = values.port ?? process.env.VIGIE_UI_PORT ?? String(freePort(5310));
    const wantedIngest = Number(process.env.VIGIE_INGEST_PORT ?? 4318);
    const ingestPort = freePort(wantedIngest);
    if (ingestPort !== wantedIngest) console.log(`Port ${wantedIngest} is taken, so data goes to ${ingestPort}.`);
    const definitions = findDefinitions(values.definitions);
    const env = { ...process.env, CLICKHOUSE_URL: clickhouse.url, VIGIE_MODE: process.env.VIGIE_MODE ?? "local", VIGIE_UI_PORT: uiPort, VIGIE_INGEST_PORT: String(ingestPort), VIGIE_PUBLIC_URL: process.env.VIGIE_PUBLIC_URL ?? `http://localhost:${uiPort}`, VIGIE_DEFINITIONS: definitions };
    const child = spawn("bun", [join(root, "server/index.ts")], { cwd: root, stdio: "inherit", env });
    let stopping = false;
    const stop = () => {
      stopping = true;
      child.kill();
      clickhouse.stop?.();
      process.exit(0);
    };
    child.on("exit", (code) => {
      if (!stopping) {
        clickhouse.stop?.();
        process.exit(code ?? 0);
      }
    });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const ready = await waitFor(`http://127.0.0.1:${ingestPort}/health`, 60);
    if (!ready) return bad("Vigie did not start. The lines above say why.");
    if (values.seed) {
      const { seed } = await import("../server/seed.ts");
      await seed({ target: `http://127.0.0.1:${ingestPort}`, hours: 24, environment: "DEV", rate: 14, live: false });
    }
    console.log(`\n${bold("Vigie is ready")} on http://localhost:${uiPort}`);
    console.log(`  Definitions  ${definitions}`);
    console.log(`  Adonis       ${bold("node ace add @vigie/adonis")}`);
    console.log(`  NestJS       ${bold("npx @vigie/nestjs init")}`);
    console.log(`  Anything     OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${ingestPort}\n`);
    await new Promise(() => {});
  },
  async dev() {
    const values = flags({ seed: { type: "boolean" }, port: { type: "string" } });
    const clickhouse = await ensureClickHouse();
    ok(`ClickHouse ready (${clickhouse.how})`);
    process.env.CLICKHOUSE_URL = clickhouse.url;
    process.env.VIGIE_MODE ??= "local";
    const webPort = values.port ?? process.env.VIGIE_WEB_PORT ?? String(freePort(5310));
    const wantedIngest = Number(process.env.VIGIE_INGEST_PORT ?? 4318);
    const ingestPort = freePort(wantedIngest);
    if (ingestPort !== wantedIngest) console.log(`Port ${wantedIngest} is taken, so data goes to ${ingestPort}.`);
    process.env.VIGIE_INGEST_PORT = String(ingestPort);
    process.env.VIGIE_PUBLIC_URL ??= `http://localhost:${webPort}`;
    let child: ChildProcess;
    let stopping = false;
    const boot = () => {
      child = spawn("bun", ["--bun", "x", "vite", "dev", "--port", webPort, "--clearScreen", "false"], { cwd: root, stdio: "inherit", env: { ...process.env, VIGIE_DEV: "1" } });
      // Exit code 75 means a server file changed: start again with the new code.
      child.on("exit", (code) => {
        if (!stopping && code === 75) boot();
        else if (!stopping) process.exit(code ?? 0);
      });
    };
    boot();
    const ready = await waitFor(`http://127.0.0.1:${ingestPort}/health`, 60);
    if (values.seed && ready) {
      const { seed } = await import("../server/seed.ts");
      await seed({ target: `http://127.0.0.1:${ingestPort}`, hours: 24, environment: "PRD", rate: 14, live: false });
    }
    if (ready) {
      ok(`Vigie is on http://localhost:${webPort}`);
      ok(`Send telemetry to http://localhost:${ingestPort}`);
    }
    const stop = () => {
      stopping = true;
      child.kill();
      clickhouse.stop?.();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {});
  },
  async start() {
    await import("../server/index.ts");
  },
  async seed() {
    const values = flags({ target: { type: "string" }, hours: { type: "string" }, env: { type: "string" }, rate: { type: "string" }, live: { type: "boolean" }, key: { type: "string" }, seed: { type: "boolean" }, port: { type: "string" } });
    const { seed } = await import("../server/seed.ts");
    await seed({ target: values.target ?? `http://127.0.0.1:${process.env.VIGIE_INGEST_PORT ?? 4318}`, hours: Number(values.hours ?? 24), environment: values.env ?? "PRD", rate: Number(values.rate ?? 14), live: Boolean(values.live), key: values.key });
  },
  /** First run on a server: secrets, first ingest key, first admin. Safe to run again. */
  async setup() {
    const values = flags({ email: { type: "string" }, password: { type: "string" }, name: { type: "string" } });
    const { auth, migrateAuth, setupCode, usersExist } = await import("../server/auth.ts");
    await migrateAuth();
    const { createToken, listTokens } = await import("../server/state/tokens.ts");
    if (!listTokens().some((t: any) => t.kind === "ingest" && !t.revoked_at)) {
      const key = createToken({ kind: "ingest", name: "First service", owner: "setup" });
      console.log(`\n${bold("Ingest key")} (shown once):\n  ${key.secret}\n`);
    } else ok("An ingest key already exists");
    if (usersExist()) ok("An owner already exists");
    else if (values.email && values.password) {
      await auth.api.signUpEmail({ body: { email: values.email, password: values.password, name: values.name ?? values.email.split("@")[0]! }, headers: new Headers({ "x-vigie-setup-code": setupCode() }) });
      ok(`Owner created: ${values.email}`);
    } else console.log(`Open the app to create the first owner, or run: ${bold("vigie setup --email you@example.com --password …")}`);
    process.exit(0);
  },
  async check() {
    process.env.VIGIE_DATA_DIR ??= join(dataDir(), "check");
    const { config } = await import("../server/config.ts");
    const { ping } = await import("../server/lib/clickhouse.ts");
    const { loadExtensions } = await import("../server/extensions/index.ts");
    const registry = await loadExtensions();
    let failed = 0;
    for (const item of registry.loaded) {
      if (item.ok) ok(`${item.file} ${dim(item.label)}`);
      else {
        bad(`${item.file}: ${item.error}`);
        failed++;
      }
    }
    if (await ping()) ok(`ClickHouse answers at ${config.clickhouse.url}`);
    else {
      bad(`ClickHouse does not answer at ${config.clickhouse.url}`);
      failed++;
    }
    if (config.mode === "server" && !config.auth.secret) {
      bad("BETTER_AUTH_SECRET is not set");
      failed++;
    }
    console.log(failed ? `\n${failed} problem(s).` : "\nEverything is fine.");
    process.exit(failed ? 1 : 0);
  },
  /** A consistent copy of the state: issues, alerts, dashboards, tokens, members. Telemetry itself ages out on its own. */
  async backup() {
    const { config } = await import("../server/config.ts");
    const { Database } = await import("bun:sqlite");
    const dir = join(config.dataDir, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(dir, { recursive: true });
    for (const name of ["vigie.db", "auth.db"]) {
      const file = join(config.dataDir, name);
      if (!existsSync(file)) continue;
      const source = new Database(file, { readonly: true });
      source.exec(`VACUUM INTO '${join(dir, name)}'`);
      source.close();
      ok(join(dir, name));
    }
    process.exit(0);
  },
  /** Compares with HyperDX during dual-write. The password comes from HYPERDX_CLICKHOUSE_PASSWORD, never a flag. */
  async parity() {
    const values = flags({ hours: { type: "string" }, url: { type: "string" }, user: { type: "string" }, database: { type: "string" }, dashboards: { type: "string" } });
    const hyperdxUrl = values.url ?? process.env.HYPERDX_CLICKHOUSE_URL;
    if (!hyperdxUrl) throw new Error("Give the HyperDX ClickHouse with --url or HYPERDX_CLICKHOUSE_URL.");
    const { parity, PARITY_CHECKS, tileChecks } = await import("../server/parity.ts");
    // The app keeps its HyperDX dashboards as code: pass that file to compare every tile too.
    const spec = values.dashboards ? await import(resolve(values.dashboards)) : null;
    const checks = [...PARITY_CHECKS, ...(spec ? spec.DASHBOARDS.flatMap(tileChecks) : [])];
    const { config } = await import("../server/config.ts");
    const result = await parity(
      { url: hyperdxUrl, user: values.user ?? process.env.HYPERDX_CLICKHOUSE_USER ?? "default", password: process.env.HYPERDX_CLICKHOUSE_PASSWORD ?? "", database: values.database ?? "default" },
      { url: config.clickhouse.url, user: config.clickhouse.user, password: config.clickhouse.password, database: config.clickhouse.database },
      Number(values.hours ?? 24),
      checks,
    );
    for (const row of result.rows) console.log(`${row.ok ? "ok  " : "DIFF"}  ${row.name.padEnd(26)} ${row.key.padEnd(38).slice(0, 38)} ${String(row.hyperdx).padStart(9)} ${String(row.vigie).padStart(9)}  ${row.diff.toFixed(2)}%`);
    for (const failure of result.failed) console.log(`FAIL  ${failure.name}: ${failure.error}`);
    console.log(result.ok ? `\nWithin limits: ${result.rows.length} rows.` : `\nNot within limits: ${result.rows.filter((r) => !r.ok).length} of ${result.rows.length} rows, ${result.failed.length} checks could not run.`);
    process.exit(result.ok ? 0 : 1);
  },
  /** Declares a release from CI: vigie deploy --url https://vigie.you.com --token vd_… --service api --version $SHA */
  async deploy() {
    const values = flags({ url: { type: "string" }, token: { type: "string" }, service: { type: "string" }, version: { type: "string" }, env: { type: "string" } });
    const response = await fetch(`${values.url ?? process.env.VIGIE_URL}/api/deployments`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${values.token ?? process.env.VIGIE_DEPLOY_TOKEN}` }, body: JSON.stringify({ service: values.service, version: values.version, environment: values.env ?? "PRD" }) });
    if (!response.ok) throw new Error(`Vigie answered ${response.status}: ${await response.text()}`);
    ok(`Declared ${values.service} ${values.version}`);
    process.exit(0);
  },
  async token() {
    const values = flags({ kind: { type: "string" }, name: { type: "string" }, scope: { type: "string" }, env: { type: "string" } });
    const { createToken } = await import("../server/state/tokens.ts");
    const token = createToken({ kind: (values.kind ?? "api") as any, name: values.name ?? "CLI", scope: values.scope, environment: values.env, owner: "cli" });
    console.log(token.secret);
    process.exit(0);
  },
  async help() {
    console.log(`${bold("vigie")}: self-hosted telemetry for Node apps

  ${bold("vigie")} [--seed]        Everything on this machine: ClickHouse, ingest and the app (:5310)
  ${bold("vigie dev")} [--seed]    The same, with hot reload of Vigie itself, for working on Vigie
  ${bold("vigie start")}           Run the server (production)
  ${bold("vigie setup")}           First run on a server: first ingest key and owner
  ${bold("vigie backup")}          Copy the state databases (issues, alerts, tokens, members)
  ${bold("vigie check")}           Check definitions and the connection to ClickHouse
  ${bold("vigie seed")}            Send realistic telemetry [--hours 24 --env PRD --rate 14 --live]
  ${bold("vigie parity")}          Compare with HyperDX during dual-write [--url --user --database --hours --dashboards]
  ${bold("vigie deploy")}          Declare a release from CI [--url --token --service --version --env]
  ${bold("vigie token")}           Create a token [--kind ingest|api|mcp|deploy --scope read|write --name …]
`);
  },
};

const run = commands[command] ?? commands.help!;
await run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
