# @vigiejs/adonis

Sends an Adonis app's requests, errors and background tasks to [Vigie](../../README.md), self-hosted telemetry for Adonis apps.

```sh
node ace add @vigiejs/adonis
```

That is the whole setup. It finds the Vigie running on your machine (or asks where yours runs), sets up traces with the official `@adonisjs/otel`, registers one middleware, writes `VIGIE_URL` and `VIGIE_KEY`, and sends a test event. With a Vigie on a server, it opens a page where someone signed in allows the app: nobody copies a key.

In CI, or anywhere without a browser:

```sh
node ace configure @vigiejs/adonis --url=https://vigie.acme.com --key=vk_…
```

## What you get

Every request becomes one wide event: method, route, status, outcome, duration, the signed-in user's id, and the trace it belongs to. Add what matters to you:

```ts
router.post('/orders', async ({ request, log }) => {
  const order = await Order.create(request.all())
  log.set({ order: { id: order.id, total: order.total } })
  return order
})
```

Background work goes through `task()`. Throwing marks the attempt failed; `skip()` and `retry()` say why it did not run:

```ts
import { task } from '@vigiejs/adonis'

await task({ kind: 'invoices.sync', id: job.id, attempt: job.attempts, integration: 'stripe' }, async ({ log, skip }) => {
  if (!account.stripeId) return skip('NO_STRIPE_ACCOUNT')
  const synced = await stripe.sync(account)
  log.set({ invoices: { synced } })
})
```

Anything else, a script or a cron, can be one wide event with `runWithWideEvent({ operation: 'reports.nightly' }, async (log) => …)`.

## Config

`config/vigie.ts`, written by the installer:

| Option | What it does |
|---|---|
| `url` | Where Vigie runs. Empty sends nothing, as in tests. |
| `key` | The ingest key. A Vigie on your machine needs none. |
| `service`, `environment`, `version` | How the app appears in Vigie. Read from `APP_NAME`, `APP_ENV`, `APP_VERSION`. |
| `ignorePaths` | Requests to skip, such as `/health`. |
| `secretPaths` | Path segments followed by a secret, such as `webhooks` for `/webhooks/:token`. Masked before anything leaves the app. |
| `pretty` | Print each event in the terminal too. On outside production. |

## Requirements

Adonis 6 or 7, Node 22 or later.

## License

MIT
