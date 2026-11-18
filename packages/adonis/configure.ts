import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type Configure from '@adonisjs/core/commands/configure'
import { stubsRoot } from './stubs/main.js'

type Found = { url: string; mode: 'local' | 'server' }

const trim = (url: string) => url.replace(/\/$/, '')

async function ask(url: string): Promise<Found | null> {
  try {
    const response = await fetch(`${trim(url)}/health`, { signal: AbortSignal.timeout(1500) })
    const body = (await response.json()) as { mode?: string }
    return { url: trim(url), mode: body.mode === 'server' ? 'server' : 'local' }
  } catch {
    return null
  }
}

/** `vigie` on this machine takes the first free port from 5310. */
async function findLocal(): Promise<Found | null> {
  const found = await Promise.all(Array.from({ length: 6 }, (_, i) => ask(`http://localhost:${5310 + i}`)))
  return found.find(Boolean) ?? null
}

/** Only in a terminal someone is looking at: never in CI or a pipe. */
function openBrowser(url: string) {
  if (!process.stdout.isTTY || process.env.CI || process.env.SSH_CONNECTION) return
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch {}
}

/** A server Vigie hands out a key once someone signed in there allows this app, like `gh auth login`. */
async function link(command: Configure, vigie: Found, service: string): Promise<string | null> {
  const start = await fetch(`${vigie.url}/api/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service }),
  }).catch(() => null)
  if (!start?.ok) return null
  const { code, url, secret, expiresIn } = (await start.json()) as { code: string; url: string; secret: string; expiresIn: number }
  command.logger.info(`Allow ${command.colors.cyan(service)} in Vigie. Code ${command.colors.bold(code)}`)
  command.logger.log(`  ${url}`)
  openBrowser(url)
  const until = Date.now() + expiresIn * 1000
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const poll = await fetch(`${vigie.url}/api/link/${secret}`).catch(() => null)
    if (!poll?.ok) continue
    const result = (await poll.json()) as { status: string; key?: string }
    if (result.status === 'approved' && result.key) return result.key
    if (result.status === 'denied') throw new Error('Someone refused this app in Vigie. Nothing was changed there.')
  }
  throw new Error('Nobody allowed the app in time. Run the command again.')
}

/** One test event, so setup only says "connected" once Vigie has accepted data from this app. */
async function sendTestEvent(vigie: Found, key: string, service: string) {
  const now = `${Date.now()}000000`
  const response = await fetch(`${vigie.url}/otlp/v1/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'deployment.environment', value: { stringValue: 'development' } }] },
          scopeLogs: [{ logRecords: [{ timeUnixNano: now, severityText: 'info', body: { stringValue: `${service} is connected to Vigie` }, attributes: [{ key: 'vigie.setup', value: { stringValue: 'true' } }] }] }],
        },
      ],
    }),
    signal: AbortSignal.timeout(5000),
  }).catch((error: Error) => ({ ok: false, status: 0, statusText: error.message }) as const)
  return response
}

/**
 * `node ace add @vigie/adonis`, or `node ace configure @vigie/adonis --url=https://vigie.acme.com --key=vg_…` in CI.
 */
export async function configure(command: Configure) {
  const flags = command.parsedFlags as { url?: string; key?: string }
  const installer = await command.createCodemods()
  const service = command.app.appName || 'app'

  /** Traces and metrics come from the official package. It is set up first, pointed at Vigie. */
  const hadOtel = existsSync(command.app.configPath('otel.ts'))
  if (!hadOtel) {
    const installed = await installer.installPackages([{ name: '@adonisjs/otel', isDevDependency: false }])
    if (installed) {
      const { exitCode } = await command.kernel.exec('configure', ['@adonisjs/otel'])
      if (exitCode === 0) {
        // Replace the config it just wrote with one that sends to Vigie.
        const overwrite = await command.createCodemods()
        overwrite.overwriteExisting = true
        await overwrite.makeUsingStub(stubsRoot, 'config/otel.stub', {})
      }
      else command.logger.warning('Traces are not set up: @adonisjs/otel failed to configure. Wide events still go to Vigie.')
    }
  }

  let vigie: Found | null = null
  if (flags.url) vigie = (await ask(flags.url)) ?? { url: trim(flags.url), mode: 'server' }
  else vigie = await findLocal()
  if (vigie && !flags.url) command.logger.success(`Found Vigie at ${vigie.url}`)
  if (!vigie) {
    const url = await command.prompt.ask('Where does Vigie run?', { default: 'http://localhost:5310' })
    vigie = (await ask(url)) ?? { url: trim(url), mode: 'server' }
  }

  let key = flags.key ?? ''
  if (!key && vigie.mode === 'server') {
    key = (await link(command, vigie, service)) ?? (await command.prompt.secure('Paste an ingest key from Vigie, Settings, Tokens'))
  }

  // Created only now: codemods read the files once, and the step above just changed them.
  const codemods = await command.createCodemods()
  await codemods.makeUsingStub(stubsRoot, 'config/vigie.stub', {})
  await codemods.updateRcFile((rc) => rc.addProvider('@vigie/adonis/vigie_provider'))
  // The server stack runs for every request, so a 404 is recorded too.
  await codemods.registerMiddleware('server', [{ path: '@vigie/adonis/vigie_middleware', position: 'after' }])
  await codemods.defineEnvVariables({ VIGIE_URL: vigie.url, VIGIE_KEY: key }, { omitFromExample: ['VIGIE_KEY'] })
  await codemods.defineEnvValidations({
    leadingComment: 'Where this app sends its telemetry. Leave VIGIE_URL empty to send nothing, as in tests.',
    variables: {
      VIGIE_URL: "Env.schema.string.optional({ format: 'url', tld: false })",
      VIGIE_KEY: 'Env.schema.string.optional()',
    },
  })

  if (hadOtel) {
    command.logger.info('config/otel.ts already existed, so it was left alone. To send traces to Vigie, add this destination:')
    command.logger.log("  destinations: { vigie: destinations.otlp({ endpoint: env.get('VIGIE_URL') + '/otlp', headers: { authorization: 'Bearer ' + env.get('VIGIE_KEY') } }) }")
  }

  const sent = await sendTestEvent(vigie, key, service)
  if (sent.ok) {
    command.logger.success(`Vigie received a test event from ${service}`)
    command.logger.log(`  Start the app: each request now shows up at ${vigie.url}/logs`)
  } else {
    const why = sent.status === 401 ? 'Vigie refused the ingest key.' : sent.status ? `Vigie answered ${sent.status}.` : `Vigie did not answer at ${vigie.url}.`
    command.logger.warning(`${why} The app is set up; fix VIGIE_URL or VIGIE_KEY in .env, then run node ace configure @vigie/adonis again.`)
  }
}
