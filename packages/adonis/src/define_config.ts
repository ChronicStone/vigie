export type VigieConfig = {
  /** Where Vigie runs. Telemetry goes to `<url>/otlp`. Leave it empty to turn Vigie off, as in tests. */
  url?: string
  /** The ingest key. A Vigie running on your machine accepts data without one. */
  key?: string
  /** How this app appears in Vigie, such as `acme-api`. */
  service: string
  /** `production`, `staging` or `development`. Vigie shows them as PRD, STG and DEV. */
  environment: string
  version?: string
  /** Paths whose next segment is a secret, such as `webhooks` for `/webhooks/:token`. Masked before anything leaves the app. */
  secretPaths?: string[]
  /** Requests to skip entirely, such as health checks. */
  ignorePaths?: string[]
  /** Also print each wide event in the terminal. Defaults to true outside production. */
  pretty?: boolean
}

export function defineConfig(config: VigieConfig): VigieConfig {
  return config
}
