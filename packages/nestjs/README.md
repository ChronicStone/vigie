# @vigie/nestjs

Sends a NestJS app's requests, errors, traces and background jobs to [Vigie](https://github.com/ChronicStone/vigie), self-hosted telemetry you run yourself.

```sh
npx @vigie/nestjs init
```

That is the whole setup. It installs the package, finds the Vigie running on your machine (or asks where yours runs), adds two lines to your app, writes `VIGIE_URL` and `VIGIE_KEY` to `.env`, and sends a test event. With a Vigie on a server, it opens a page where someone signed in allows the app: nobody copies a key.

In CI, or anywhere without a browser:

```sh
npx @vigie/nestjs init --url=https://vigie.acme.dev --key=vk_…
```

## The two lines

```ts
// src/main.ts: first line, so traces start before Nest loads
import '@vigie/nestjs/register'
```

```ts
// src/app.module.ts
@Module({ imports: [VigieModule.forRoot()] })
export class AppModule {}
```

`forRoot()` takes no options. It reads `VIGIE_URL`, `VIGIE_KEY` and `NODE_ENV`, and the name and version from `package.json`. It loads `.env` itself when nothing else has.

## What you get

Every request becomes one wide event: method, the route as written in the controller (`/orders/:id/checkout`), the handler (`OrdersController.checkout`), status, outcome, duration, the signed-in user's id, and its trace. A 404 is recorded too. Add what matters to you from anywhere in the request:

```ts
import { useLogger } from '@vigie/nestjs'

@Post(':id/checkout')
async checkout(@Param('id') id: string) {
  const order = await this.orders.checkout(id)
  useLogger().set({ order: { id: order.id, total: order.total } })
  return order
}
```

Background work goes through `@VigieTask`. On a BullMQ or Bull processor, the job's id, attempt, queue and wait time come from the job itself. Throwing marks the attempt failed; `skipTask()` and `retryTask()` say why it did not run:

```ts
import { skipTask, useLogger, VigieTask } from '@vigie/nestjs'

@Processor('emails')
export class EmailsProcessor extends WorkerHost {
  @VigieTask('emails.send', { integration: 'postwing' })
  async process(job: Job<{ to: string; unsubscribed: boolean }>) {
    if (job.data.unsubscribed) return skipTask('UNSUBSCRIBED')
    useLogger().set({ email: { template: 'welcome' } })
    await this.postwing.send(job.data.to)
  }
}
```

Anything else, a script or a cron, can be one task with `task({ kind: 'reports.nightly' }, async ({ log }) => …)`.

Traces come from the standard OpenTelemetry Node SDK with its auto-instrumentations: HTTP, Express, Fastify, Postgres, MySQL, Redis, gRPC and more.

## Options

All optional, in `VigieModule.forRoot({ … })`:

| Option | Default | What it does |
|---|---|---|
| `url` | `VIGIE_URL` | Where Vigie runs. Empty sends nothing, as in tests. |
| `key` | `VIGIE_KEY` | The ingest key. A Vigie on your machine needs none. |
| `service` | `OTEL_SERVICE_NAME`, then `package.json` name | How the app appears in Vigie. |
| `environment` | `APP_ENV`, then `NODE_ENV` | `production`, `staging` or `development`. |
| `version` | `APP_VERSION`, then `package.json` version | Shown on each event, for "since which release". |
| `ignorePaths` | `['/health']` | Requests to skip. |
| `secretPaths` | `[]` | Path segments followed by a secret, such as `webhooks` for `/webhooks/:token`. Masked before anything leaves the app. |
| `pretty` | on outside production | Print each event in the terminal too. |

Set `VIGIE_TRACES_OFF=1` to keep the wide events and turn tracing off.

## Requirements

NestJS 11 or 12 on Express or Fastify. Node 22.12 or later.

## License

MIT
