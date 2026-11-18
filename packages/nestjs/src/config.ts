import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type VigieConfig = {
  /** Where Vigie runs. Telemetry goes to `<url>/otlp`. Empty turns Vigie off, as in tests. Defaults to `VIGIE_URL`. */
  url?: string
  /** The ingest key. A Vigie running on your machine accepts data without one. Defaults to `VIGIE_KEY`. */
  key?: string
  /** How this app appears in Vigie. Defaults to `OTEL_SERVICE_NAME`, then the `name` in package.json. */
  service: string
  /** `production`, `staging` or `development`. Defaults to `NODE_ENV`. Vigie shows them as PRD, STG and DEV. */
  environment: string
  /** Defaults to `APP_VERSION`, then the `version` in package.json. */
  version?: string
  /** Paths whose next segment is a secret, such as `webhooks` for `/webhooks/:token`. Masked before anything leaves the app. */
  secretPaths?: string[]
  /** Requests to skip entirely. Defaults to `/health`. */
  ignorePaths?: string[]
  /** Also print each wide event in the terminal. Defaults to true outside production. */
  pretty?: boolean
}

export type VigieOptions = Partial<VigieConfig>

/** Loads `.env` when nothing set VIGIE_URL yet, so the app needs no config module for Vigie. */
export function loadEnv() {
  if (process.env.VIGIE_URL !== undefined) return
  const file = join(process.cwd(), '.env')
  if (!existsSync(file)) return
  try {
    process.loadEnvFile(file)
  } catch {}
}

function packageJson(): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** Every option has a default from the environment or package.json, so `VigieModule.forRoot()` needs none. */
export function resolveConfig(options: VigieOptions = {}): VigieConfig {
  loadEnv()
  const pkg = packageJson()
  const env = process.env
  return {
    url: options.url ?? env.VIGIE_URL ?? '',
    key: options.key ?? env.VIGIE_KEY ?? '',
    service: options.service ?? env.OTEL_SERVICE_NAME ?? env.APP_NAME ?? pkg.name?.replace(/^@[^/]+\//, '') ?? 'app',
    environment: options.environment ?? env.APP_ENV ?? env.NODE_ENV ?? 'development',
    version: options.version ?? env.APP_VERSION ?? pkg.version,
    secretPaths: options.secretPaths ?? [],
    ignorePaths: options.ignorePaths ?? ['/health'],
    pretty: options.pretty,
  }
}
