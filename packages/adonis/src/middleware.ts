import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import type { AuditableLogger } from 'evlog'
import { defineFrameworkIntegration } from 'evlog/toolkit'
import { executionStorage, getActiveTraceContext } from './execution.js'

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /** This request's wide event. Add what matters with `ctx.log.set({ order: { id } })`. */
    log: AuditableLogger
  }
}

const integration = defineFrameworkIntegration<HttpContext>({
  name: 'adonis',
  extractRequest: (ctx) => ({ method: ctx.request.method(), path: ctx.request.url(false), headers: ctx.request.headers(), requestId: ctx.request.id() }),
  attachLogger: (ctx, logger) => {
    ctx.log = logger
  },
  storage: executionStorage,
})

const statusOf = (error: unknown, fallback: number) => (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : fallback)
const reasonOf = (error: unknown, status: number) => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) return error.code
  return `HTTP_${status}`
}

/** The id of whoever is signed in, when @adonisjs/auth knows it. Nothing else about them leaves the app. */
function userId(ctx: HttpContext) {
  const user = (ctx as { auth?: { user?: { id?: unknown } } }).auth?.user
  return user && (typeof user.id === 'string' || typeof user.id === 'number') ? String(user.id) : undefined
}

/** One wide event per request: route, status, outcome, duration, user, and whatever the app adds with ctx.log. */
export default class VigieMiddleware {
  static ignorePaths: string[] = []

  async handle(ctx: HttpContext, next: NextFn) {
    if (VigieMiddleware.ignorePaths.some((path) => ctx.request.url() === path)) return next()
    const { finish, logger, runWith, skipped } = integration.start(ctx)
    if (skipped) return next()
    const started = performance.now()
    logger.set(getActiveTraceContext())
    const close = (error?: unknown) => {
      const status = error ? statusOf(error, 500) : ctx.response.getStatus()
      const event = logger.getContext()
      logger.set({
        status,
        durationMs: Math.round(performance.now() - started),
        ...(ctx.route ? { route: { name: ctx.route.name, pattern: ctx.route.pattern }, operation: ctx.route.name ?? `${ctx.request.method()} ${ctx.route.pattern}` } : {}),
        ...(typeof event.outcome === 'string' ? {} : { outcome: status === 401 || status === 403 ? 'denied' : status >= 400 ? 'failed' : 'succeeded' }),
        ...(status >= 400 && typeof event.reason !== 'string' ? { reason: reasonOf(error, status) } : {}),
        ...(userId(ctx) && !event.user ? { user: { id: userId(ctx) } } : {}),
      })
    }
    try {
      await runWith(next)
      close()
      await finish({ status: ctx.response.getStatus() })
    } catch (error) {
      close(error)
      await finish({ error: error instanceof Error ? error : new Error(String(error)) })
      throw error
    }
  }
}
