import {
  Global,
  Injectable,
  Module,
  type CallHandler,
  type DynamicModule,
  type ExecutionContext,
  type MiddlewareConsumer,
  type NestInterceptor,
  type NestModule,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import type { AuditableLogger } from 'evlog'
import { defineFrameworkIntegration } from 'evlog/toolkit'
import { catchError, Observable, throwError } from 'rxjs'
import { resolveConfig, type VigieConfig, type VigieOptions } from './config.js'
import { executionStorage, getActiveTraceContext } from './execution.js'
import { flushVigie, initVigie } from './logger.js'

/** Where the request's wide event lives. Not `req.log`: on Fastify that is Fastify's own logger. */
const WIDE = Symbol.for('vigie.wideEvent')

/** The path alone. A malformed URL such as `//[` must not break the request. */
function pathOf(url: string) {
  try {
    return new URL(url, 'http://localhost').pathname
  } catch {
    return url.split(/[?#]/)[0] || '/'
  }
}

type RawRequest = {
  method?: string
  url?: string
  originalUrl?: string
  headers: Record<string, string | string[] | undefined>
  [WIDE]?: AuditableLogger
  route?: { path?: string }
  routeOptions?: { url?: string }
  user?: { id?: unknown; sub?: unknown }
  raw?: RawRequest
}
type RawResponse = { statusCode: number; writableFinished?: boolean; once: (event: 'finish' | 'close', listener: () => void) => unknown }

const integration = defineFrameworkIntegration<RawRequest>({
  name: 'nestjs',
  extractRequest: (req) => ({
    method: req.method || 'GET',
    path: pathOf(req.originalUrl || req.url || '/'),
    headers: req.headers as Record<string, string>,
    requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined,
  }),
  attachLogger: (req, logger) => {
    req[WIDE] = logger
  },
  storage: executionStorage,
})

const statusOf = (error: unknown) => {
  if (error && typeof error === 'object') {
    if ('getStatus' in error && typeof error.getStatus === 'function') return Number(error.getStatus())
    if ('status' in error && typeof error.status === 'number') return error.status
  }
  return 500
}
const reasonOf = (error: unknown, status: number) => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) return error.code
  if (error instanceof Error && error.name !== 'Error' && !/Exception$/.test(error.name)) return error.name
  return `HTTP_${status}`
}
const userIdOf = (req: RawRequest) => {
  const id = req.user?.id ?? req.user?.sub
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
}

let config: VigieConfig | undefined

/** One wide event per request, opened before routing so a 404 is recorded too. */
function middleware(req: RawRequest, res: RawResponse, next: (error?: unknown) => void) {
  const path = pathOf(req.originalUrl || req.url || '/')
  if (config?.ignorePaths?.includes(path)) return next()
  const { logger, finish, runWith, skipped } = integration.start(req)
  if (skipped) return next()
  const started = performance.now()
  logger.set(getActiveTraceContext())
  let done = false
  const close = (aborted: boolean) => {
    if (done) return
    done = true
    // The client went away before the response was sent: 499, as nginx records it.
    const status = aborted ? 499 : res.statusCode
    const event = logger.getContext()
    logger.set({
      status,
      durationMs: Math.round(performance.now() - started),
      ...(typeof event.outcome === 'string' ? {} : { outcome: aborted ? 'aborted' : status === 401 || status === 403 ? 'denied' : status >= 400 ? 'failed' : 'succeeded' }),
      ...(status >= 400 && typeof event.reason !== 'string' ? { reason: aborted ? 'CLIENT_ABORTED' : `HTTP_${status}` } : {}),
    })
    void finish({ status })
  }
  res.once('finish', () => close(false))
  res.once('close', () => close(true))
  runWith(() => next())
}

/** Inside the request: the route as written in the controller, the handler, the user, and any error. */
@Injectable()
class VigieInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle()
    const req = context.switchToHttp().getRequest<RawRequest>()
    const logger = req[WIDE] ?? req.raw?.[WIDE]
    if (!logger) return next.handle()
    const pattern = req.route?.path ?? req.routeOptions?.url
    const handler = `${context.getClass().name}.${context.getHandler().name}`
    logger.set({
      ...(pattern ? { route: { pattern, name: handler } } : {}),
      operation: handler,
      ...(userIdOf(req) ? { user: { id: userIdOf(req) } } : {}),
    })
    // Run the handler inside the event's context, so useLogger() works on Express and Fastify alike.
    const handled = new Observable<unknown>((subscriber) => executionStorage.run(logger, () => next.handle().subscribe(subscriber)))
    return handled.pipe(
      catchError((error: unknown) => {
        const status = statusOf(error)
        if (status >= 500) logger.error(error instanceof Error ? error : new Error(String(error)))
        logger.set({ reason: reasonOf(error, status), ...(status >= 500 ? {} : { error: { message: error instanceof Error ? error.message : String(error) } }) })
        return throwError(() => error)
      }),
    )
  }
}

/**
 * Sends every request, error and `@VigieTask` to Vigie. Every option defaults from the environment:
 * `VIGIE_URL`, `VIGIE_KEY`, `NODE_ENV`, and the name and version in package.json.
 *
 * ```ts
 * @Module({ imports: [VigieModule.forRoot()] })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({})
export class VigieModule implements NestModule, OnApplicationShutdown {
  static forRoot(options: VigieOptions = {}): DynamicModule {
    config = resolveConfig(options)
    initVigie(config)
    return { module: VigieModule, providers: [{ provide: APP_INTERCEPTOR, useClass: VigieInterceptor }] }
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(middleware).forRoutes('{*path}')
  }

  async onApplicationShutdown() {
    await flushVigie()
  }
}
