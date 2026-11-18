import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const env = process.env;

function number(name: string, fallback: number) {
  const value = Number(env[name]);
  return Number.isFinite(value) && env[name] !== undefined && env[name] !== "" ? value : fallback;
}

export type Mode = "local" | "server";

const mode: Mode = env.VIGIE_MODE === "server" ? "server" : "local";
/** Prod and Test on a server, one Local on a machine. A deployment can list its own. */
const environments = (env.VIGIE_ENVS ?? (mode === "local" ? "DEV" : "PRD,STG")).split(",").map((name) => name.trim()).filter(Boolean);
const dataDir = resolve(env.VIGIE_DATA_DIR ?? (mode === "local" ? join(homedir(), ".vigie") : "/data"));
mkdirSync(dataDir, { recursive: true });

export const config = {
  mode,
  environments,
  /** The one screens, alerts and tools use when nobody names one. */
  mainEnvironment: environments[0]!,
  dataDir,
  host: env.VIGIE_HOST ?? (mode === "local" ? "127.0.0.1" : "0.0.0.0"),
  uiPort: number("VIGIE_UI_PORT", 4310),
  ingestPort: number("VIGIE_INGEST_PORT", 4318),
  publicUrl: env.VIGIE_PUBLIC_URL ?? `http://localhost:${number("VIGIE_UI_PORT", 4310)}`,
  webDir: resolve(env.VIGIE_WEB_DIR ?? join(import.meta.dir, "..", "dist", "client")),
  startEntry: resolve(env.VIGIE_START_ENTRY ?? join(import.meta.dir, "..", "dist", "server", "server.js")),
  definitionsDir: resolve(env.VIGIE_DEFINITIONS ?? join(import.meta.dir, "..", "definitions")),
  clickhouse: {
    url: env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
    user: env.CLICKHOUSE_USER ?? "default",
    password: env.CLICKHOUSE_PASSWORD ?? "",
    database: env.CLICKHOUSE_DATABASE ?? "vigie",
  },
  /** Read-only connection string to the observed app's Postgres. Optional: enables task rows and the database explorer. */
  appDatabaseUrl: env.VIGIE_APP_DATABASE_URL ?? "",
  /** The observed app's API, used for task actions as the signed-in person. */
  appApiUrl: env.VIGIE_APP_API_URL ?? "",
  /** Where people open the app, for links from Vigie to its control center. */
  appUrl: env.VIGIE_APP_URL ?? "",
  /** The observed app's name, as people say it: buttons read "Requeue in <name>". */
  appName: env.VIGIE_APP_NAME ?? "your app",
  /** The prefix of the two task gauges the app sends: `<prefix>.backlog` and `<prefix>.oldest_due_age`. */
  taskMetrics: env.VIGIE_TASK_METRICS ?? "vigie.tasks",
  /** Where the app lists its tasks, for "Requeue in <name>". Defaults to <VIGIE_APP_URL>/admin/tasks. */
  appTasksUrl: env.VIGIE_APP_TASKS_URL ?? "",
  ingest: {
    /** Ingest keys come from the state database. In local mode a request without a key is accepted. */
    requireKey: mode === "server",
    maxBatchRows: number("VIGIE_BATCH_ROWS", 10_000),
    flushMs: number("VIGIE_FLUSH_MS", 1_000),
    maxQueueBytes: number("VIGIE_MAX_QUEUE_BYTES", 64 * 1024 * 1024),
    maxSpoolBytes: number("VIGIE_MAX_SPOOL_BYTES", 256 * 1024 * 1024),
    defaultEnvironment: env.VIGIE_DEFAULT_ENV ?? environments.at(-1)!,
  },
  auth: {
    secret: env.BETTER_AUTH_SECRET ?? "",
    oidcIssuer: env.VIGIE_OIDC_ISSUER ?? "",
    oidcClientId: env.VIGIE_OIDC_CLIENT_ID ?? "",
    oidcClientSecret: env.VIGIE_OIDC_CLIENT_SECRET ?? "",
    /** The sign-in button reads "Continue with <name>". Often the app itself signs people in. */
    oidcName: env.VIGIE_OIDC_NAME ?? (env.VIGIE_APP_NAME || "single sign-on"),
    allowSignup: env.VIGIE_ALLOW_SIGNUP === "true",
  },
  ai: {
    apiKey: env.VIGIE_AI_API_KEY ?? env.OPENAI_API_KEY ?? "",
    baseUrl: env.VIGIE_AI_BASE_URL ?? "",
    model: env.VIGIE_AI_MODEL ?? "gpt-4.1-mini",
  },
  slackWebhook: env.VIGIE_SLACK_WEBHOOK ?? "",
  smtpUrl: env.VIGIE_SMTP_URL ?? "",
  mailFrom: env.VIGIE_MAIL_FROM ?? "Vigie <vigie@localhost>",
  source: { repo: env.VIGIE_SOURCE_REPO ?? "", token: env.VIGIE_GITHUB_TOKEN ?? "", prefix: env.VIGIE_SOURCE_PREFIX ?? "", api: env.VIGIE_GITHUB_API ?? "https://api.github.com" },
  alertGroupMs: number("VIGIE_ALERT_GROUP_MS", 30_000),
  linear: { apiKey: env.VIGIE_LINEAR_API_KEY ?? "", teamId: env.VIGIE_LINEAR_TEAM_ID ?? "", url: env.VIGIE_LINEAR_URL ?? "https://api.linear.app/graphql" },
};
