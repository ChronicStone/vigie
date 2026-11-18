import { context, isSpanContextValid, trace, TraceFlags } from '@opentelemetry/api'
import { createLogger, type AuditableLogger } from 'evlog'
import { createLoggerStorage } from 'evlog/toolkit/storage'

const { storage, useLogger } = createLoggerStorage(
  'execution context. Register the Vigie middleware, or wrap the work in task() or runWithWideEvent().',
  '@vigie/adonis:execution',
)

/** The trace and span of the current OpenTelemetry span, so Vigie can join an event to its trace. */
export function getActiveTraceContext(): { traceId?: string; spanId?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext()
  return spanContext && isSpanContextValid(spanContext) ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {}
}

export function runWithTraceContext<Result>(event: Record<string, unknown>, execute: () => Result) {
  const spanContext = {
    traceId: typeof event.traceId === 'string' ? event.traceId : '',
    spanId: typeof event.spanId === 'string' ? event.spanId : '',
    traceFlags: TraceFlags.SAMPLED,
  }
  return isSpanContextValid(spanContext) ? context.with(trace.setSpanContext(context.active(), spanContext), execute) : execute()
}

/** One wide event around any piece of work outside a request: a script, a cron, a queue job. */
export async function runWithWideEvent<Result>(event: Record<string, unknown>, execute: (logger: AuditableLogger) => Result | Promise<Result>) {
  const logger = createLogger({ ...event, ...getActiveTraceContext() })
  const started = performance.now()
  return storage.run(logger, async () => {
    try {
      return await execute(logger)
    } catch (error) {
      logger.error(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      if (typeof logger.getContext().durationMs !== 'number') logger.set({ durationMs: Math.round(performance.now() - started) })
      logger.emit()
    }
  })
}

export { storage as executionStorage, useLogger }
export type { AuditableLogger }
