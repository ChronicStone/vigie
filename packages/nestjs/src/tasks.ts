import { createLogger, type AuditableLogger } from 'evlog'
import { executionStorage, getActiveTraceContext, runWithWideEvent, useLogger } from './execution.js'

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
  /** The provider it talks to, such as `paynest`, for the External calls page. */
  integration?: string
}

export type TaskOutcome = 'succeeded' | 'failed' | 'skipped' | 'retry'

type Tools = { log: AuditableLogger; skip: (code: string, why?: string) => void; retry: (code: string, why?: string) => void }

const errorCode = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? error.name : 'Error'
}

const marks = new WeakMap<AuditableLogger, (outcome: TaskOutcome, code: string, why?: string) => void>()

/**
 * Wraps one attempt of a background task in a wide event that the Tasks page reads.
 * Throwing marks it failed. Call `skip(reason)` or `retry(reason)` to say so instead.
 */
export function task<Result>(info: TaskInfo, run: (tools: Tools) => Result | Promise<Result>) {
  const event: Record<string, unknown> = {
    operation: info.kind,
    task: { kind: info.kind, id: info.id, attempt: info.attempt, queue: info.queue, waitMs: info.waitMs, integration: info.integration },
  }
  return runWithWideEvent(event, async (log) => {
    let outcome: TaskOutcome = 'succeeded'
    const mark = (next: TaskOutcome, code: string, why?: string) => {
      outcome = next
      log.set({ taskOutcome: { type: next.toUpperCase(), code, ...(why ? { reason: why } : {}) } })
    }
    marks.set(log, mark)
    try {
      const result = await run({ log, skip: (code, why) => mark('skipped', code, why), retry: (code, why) => mark('retry', code, why) })
      log.set({ outcome })
      return result
    } catch (error) {
      log.set({ outcome: 'failed', reason: errorCode(error), taskOutcome: { type: 'FAILED', code: errorCode(error) } })
      throw error
    }
  })
}

/**
 * One attempt around a method that may or may not be async. A sync method stays sync: it returns its
 * own value, and the event is sent before it returns. A promise is awaited for the outcome only.
 */
function attempt<Result>(info: TaskInfo, run: () => Result): Result {
  const log = createLogger({ operation: info.kind, task: { ...info }, ...getActiveTraceContext() })
  const started = performance.now()
  let outcome: TaskOutcome = 'succeeded'
  marks.set(log, (next, code, why) => {
    outcome = next
    log.set({ taskOutcome: { type: next.toUpperCase(), code, ...(why ? { reason: why } : {}) } })
  })
  const end = (error?: unknown) => {
    if (error !== undefined) {
      log.error(error instanceof Error ? error : new Error(String(error)))
      log.set({ outcome: 'failed', reason: errorCode(error), taskOutcome: { type: 'FAILED', code: errorCode(error) } })
    } else log.set({ outcome })
    log.set({ durationMs: Math.round(performance.now() - started) })
    log.emit()
  }
  return executionStorage.run(log, () => {
    let result: Result
    try {
      result = run()
    } catch (error) {
      end(error)
      throw error
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (value) => (end(), value),
        (error: unknown) => {
          end(error)
          throw error
        },
      ) as Result
    }
    end()
    return result
  })
}

/** Inside a `@VigieTask` method: say it did not run, and why. */
export function skipTask(code: string, why?: string) {
  marks.get(useLogger())?.('skipped', code, why)
}

/** Inside a `@VigieTask` method: say it will run again, and why. */
export function retryTask(code: string, why?: string) {
  marks.get(useLogger())?.('retry', code, why)
}

type JobLike = { id?: unknown; attemptsMade?: unknown; queueName?: unknown; queue?: { name?: unknown }; timestamp?: unknown; processedOn?: unknown }

/** What a BullMQ or Bull job already says about itself, so the decorator needs nothing else. */
function fromJob(job: unknown): Partial<TaskInfo> {
  if (!job || typeof job !== 'object') return {}
  const j = job as JobLike
  const looksLikeJob = 'attemptsMade' in j || 'queueName' in j
  if (!looksLikeJob) return {}
  const started = typeof j.processedOn === 'number' ? j.processedOn : Date.now()
  return {
    id: j.id === undefined ? undefined : String(j.id),
    attempt: typeof j.attemptsMade === 'number' ? j.attemptsMade + 1 : undefined,
    queue: typeof j.queueName === 'string' ? j.queueName : typeof j.queue?.name === 'string' ? j.queue.name : undefined,
    waitMs: typeof j.timestamp === 'number' ? Math.max(0, started - j.timestamp) : undefined,
  }
}

/**
 * Records every call of the method as one task attempt. On a BullMQ or Bull processor the job's
 * id, attempt, queue and wait come from the job itself.
 *
 * ```ts
 * @VigieTask('emails.send')
 * async process(job: Job) { … }
 * ```
 */
export function VigieTask(kind: string, info: Omit<TaskInfo, 'kind'> = {}): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      return attempt({ kind, ...info, ...fromJob(args[0]) }, () => original.apply(this, args))
    }
    Object.defineProperty(descriptor.value, 'name', { value: original.name })
    // Nest reads handler metadata (@Process, @Cron, @OnEvent…) from the function itself: carry it over.
    for (const key of Reflect.ownKeys(original)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue
      try {
        Object.defineProperty(descriptor.value, key, Object.getOwnPropertyDescriptor(original, key)!)
      } catch {}
    }
    const meta = (Reflect as unknown as { getMetadataKeys?: (t: object) => unknown[]; getMetadata?: (k: unknown, t: object) => unknown; defineMetadata?: (k: unknown, v: unknown, t: object) => void })
    for (const key of meta.getMetadataKeys?.(original) ?? []) meta.defineMetadata?.(key, meta.getMetadata?.(key, original), descriptor.value)
    return descriptor
  }
}
