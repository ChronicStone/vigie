/**
 * Traces and metrics, from the standard OpenTelemetry Node SDK, sent to Vigie.
 * Import it first in main.ts, before anything else loads:
 *
 * ```ts
 * import '@vigiejs/nestjs/register'
 * ```
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { resolveConfig } from './config.js'

const config = resolveConfig()

/** A malformed VIGIE_URL turns tracing off with a warning; it never stops the app from starting. */
function validUrl(url: string | undefined) {
  if (!url) return null
  try {
    return new URL(url)
  } catch {
    console.warn(`[vigie] VIGIE_URL is not a valid URL (${url}): traces are off.`)
    return null
  }
}
const vigieUrl = validUrl(config.url)

if (vigieUrl && !process.env.VIGIE_TRACES_OFF) {
  const base = `${vigieUrl.href.replace(/\/$/, '')}/otlp`
  const headers = config.key ? { authorization: `Bearer ${config.key}` } : undefined
  const vigieOrigin = vigieUrl.origin
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': config.service,
      'deployment.environment.name': config.environment,
      ...(config.version ? { 'service.version': config.version } : {}),
    }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces`, headers }),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers }), exportIntervalMillis: 30_000 })],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noisy and rarely useful: every file read would be a span.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Without this, every batch the app sends to Vigie would be a span of its own.
        '@opentelemetry/instrumentation-undici': { ignoreRequestHook: (request: { origin: string }) => request.origin === vigieOrigin },
        '@opentelemetry/instrumentation-http': {
          ignoreOutgoingRequestHook: (request: { hostname?: string | null; host?: string | null }) => `${request.hostname ?? request.host ?? ''}` === vigieUrl.hostname,
          ignoreIncomingRequestHook: (request: { url?: string }) => (config.ignorePaths ?? []).includes((request.url ?? '').split('?')[0]),
        },
      }),
    ],
  })
  sdk.start()
  // Flush on the way out. A SIGTERM listener would cancel Node's default exit, so the signal is sent again once flushed.
  process.once('SIGTERM', () => {
    void sdk
      .shutdown()
      .catch(() => {})
      .finally(() => process.kill(process.pid, 'SIGTERM'))
  })
  process.once('beforeExit', () => void sdk.shutdown().catch(() => {}))
}
