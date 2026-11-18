import { initLogger, type DrainContext, type WideEvent } from 'evlog'
import { createOTLPDrain } from 'evlog/otlp'
import { createDrainPipeline, type PipelineDrainFn } from 'evlog/pipeline'
import { formatEventSummary } from 'evlog/toolkit'
import type { VigieConfig } from './config.js'

let pipeline: PipelineDrainFn<DrainContext> | undefined

/** The line a person reads in the log list: the app's own message, else "GET /users 200 in 12ms". */
function summary(event: WideEvent) {
  if (typeof event.message === 'string' && event.message.trim()) return event.message
  const task = event.task as { kind?: unknown } | undefined
  if (task && typeof task.kind === 'string') {
    const code = (event.taskOutcome as { code?: unknown } | undefined)?.code
    return `${task.kind} ${String(event.outcome ?? '')}${typeof code === 'string' ? ` (${code})` : ''}`.trim()
  }
  return formatEventSummary(event) || (typeof event.operation === 'string' ? event.operation : String(event.service ?? ''))
}

const escape = (path: string) => path.replace(/^\/|\/\*?$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function initVigie(config: VigieConfig) {
  const production = config.environment === 'production'
  const drain = config.url
    ? (pipeline = createDrainPipeline<DrainContext>()(
        createOTLPDrain({
          endpoint: `${config.url.replace(/\/$/, '')}/otlp`,
          recordShape: 'compact',
          serviceName: config.service,
          ...(config.key ? { headers: { authorization: `Bearer ${config.key}` } } : {}),
          ...(config.version ? { resourceAttributes: { 'service.version': config.version } } : {}),
        }),
      ))
    : undefined
  const secretPaths = config.secretPaths?.length ? [new RegExp(`(?<=\\/(?:${config.secretPaths.map(escape).join('|')})\\/)(?!:)[^/?#\\s]+`, 'g')] : []
  initLogger({
    env: { service: config.service, environment: config.environment, ...(config.version ? { version: config.version } : {}) },
    minLevel: production ? 'info' : 'debug',
    pretty: config.pretty ?? !production,
    // Vigie masks secrets again at ingest. Masking here too means they never leave the app.
    redact: { paths: [], patterns: secretPaths } as never,
    ...(drain ? { drain: (ctx: DrainContext) => drain({ ...ctx, event: { ...ctx.event, message: summary(ctx.event) } }) } : {}),
  })
}

/** Sends what is still buffered. Called when the app shuts down. */
export async function flushVigie() {
  await pipeline?.flush()
}
