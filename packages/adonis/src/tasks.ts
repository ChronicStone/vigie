import type { AuditableLogger } from 'evlog'
import { runWithWideEvent } from './execution.js'

export type TaskInfo = {
  /** What the task does, dotted: `emails.send`, `invoices.sync`. One row per kind on the Tasks page. */
  kind: string
  /** This run's id, stable across retries, so Vigie can show every attempt of one run. */
  id?: string
  /** 1 for the first try. */
  attempt?: number
  /** The queue it came from. */
  queue?: string
  /** How long it waited in the queue before starting, in milliseconds. */
  waitMs?: number
  /** The provider it talks to, such as `stripe`, for the External calls page. */
  integration?: string
}

export type TaskOutcome = 'succeeded' | 'failed' | 'skipped' | 'retry'

const errorCode = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? error.name : 'Error'
}

/**
 * Wraps one attempt of a background task in a wide event that the Tasks page reads.
 * Throwing marks it failed. Call `skip(reason)` or `retry(reason)` to say so instead.
 *
 * ```ts
 * await task({ kind: 'emails.send', id: job.id, attempt: job.attempts }, async ({ log, skip }) => {
 *   if (user.unsubscribed) return skip('UNSUBSCRIBED')
 *   log.set({ email: { template: 'welcome' } })
 *   await mailer.send(...)
 * })
 * ```
 */
export function task<Result>(
  info: TaskInfo,
  run: (tools: { log: AuditableLogger; skip: (code: string, why?: string) => void; retry: (code: string, why?: string) => void }) => Result | Promise<Result>,
) {
  const event: Record<string, unknown> = {
    operation: info.kind,
    task: { kind: info.kind, id: info.id, attempt: info.attempt, queue: info.queue, waitMs: info.waitMs, integration: info.integration },
  }
  return runWithWideEvent(event, async (log) => {
    let outcome: TaskOutcome = 'succeeded'
    const mark = (next: TaskOutcome) => (code: string, why?: string) => {
      outcome = next
      log.set({ taskOutcome: { type: next.toUpperCase(), code, ...(why ? { reason: why } : {}) } })
    }
    try {
      const result = await run({ log, skip: mark('skipped'), retry: mark('retry') })
      log.set({ outcome })
      return result
    } catch (error) {
      log.set({ outcome: 'failed', reason: errorCode(error), taskOutcome: { type: 'FAILED', code: errorCode(error) } })
      throw error
    }
  })
}
