#!/usr/bin/env node
/**
 * `npx @vigiejs/nestjs init`: everything a Nest app needs to send its telemetry to Vigie.
 * In CI: `npx @vigiejs/nestjs init --url=https://vigie.acme.dev --key=vk_…`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

type Found = { url: string; mode: 'local' | 'server' }

const color = (code: number) => (text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text)
const green = color(32)
const yellow = color(33)
const cyan = color(36)
const bold = color(1)
const ok = (text: string) => console.log(`${green('✓')} ${text}`)
const warn = (text: string) => console.log(`${yellow('!')} ${text}`)

const trim = (url: string) => url.replace(/\/$/, '')
const cwd = process.cwd()
const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split('=')
      return [key, value.length ? value.join('=') : 'true']
    }),
) as { url?: string; key?: string; 'no-install'?: string }

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
async function findLocal() {
  const found = await Promise.all(Array.from({ length: 6 }, (_, i) => ask(`http://localhost:${5310 + i}`)))
  return found.find(Boolean) ?? null
}

async function prompt(question: string, fallback = '') {
  if (!process.stdin.isTTY) return fallback
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question}${fallback ? ` (${fallback})` : ''} `)
  rl.close()
  return answer.trim() || fallback
}

/** Only in a terminal someone is looking at: never in CI or over SSH. */
function openBrowser(url: string) {
  if (!process.stdout.isTTY || process.env.CI || process.env.SSH_CONNECTION) return
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch {}
}

/** A server Vigie hands out a key once someone signed in there allows this app, like `gh auth login`. */
async function link(vigie: Found, service: string): Promise<string | null> {
  const start = await fetch(`${vigie.url}/api/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service }) }).catch(() => null)
  if (!start?.ok) return null
  const { code, url, secret, expiresIn } = (await start.json()) as { code: string; url: string; secret: string; expiresIn: number }
  console.log(`Allow ${cyan(service)} in Vigie. Code ${bold(code)}\n  ${url}`)
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

async function sendTestEvent(vigie: Found, key: string, service: string) {
  return fetch(`${vigie.url}/otlp/v1/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'deployment.environment', value: { stringValue: 'development' } }] },
          scopeLogs: [{ logRecords: [{ timeUnixNano: `${Date.now()}000000`, severityText: 'info', body: { stringValue: `${service} is connected to Vigie` }, attributes: [{ key: 'vigie.setup', value: { stringValue: 'true' } }] }] }],
        },
      ],
    }),
    signal: AbortSignal.timeout(5000),
  }).catch((error: Error) => ({ ok: false, status: 0, statusText: error.message }) as const)
}

function packageManager() {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return { name: 'pnpm', add: ['add'] }
  if (existsSync(join(cwd, 'yarn.lock'))) return { name: 'yarn', add: ['add'] }
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return { name: 'bun', add: ['add'] }
  return { name: 'npm', add: ['install'] }
}

/** Puts `import '@vigiejs/nestjs/register'` first in main.ts, so tracing starts before Nest loads. */
export function addRegister(source: string) {
  if (source.includes('@vigiejs/nestjs/register')) return source
  const semi = /from ['"][^'"]+['"];/.test(source) ? ';' : ''
  return `import '@vigiejs/nestjs/register'${semi}\n${source}`
}

/** The text range of the object passed to `@Module(…)`, braces included, skipping strings and comments. */
function moduleObject(source: string): { open: number; close: number } | null {
  const at = /@Module\(\s*\{/.exec(source)
  if (!at) return null
  const open = at.index + at[0].length - 1
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') i = source.indexOf('\n', i) === -1 ? source.length : source.indexOf('\n', i)
    else if (c === '/' && source[i + 1] === '*') i = source.indexOf('*/', i + 2) + 1
    else if (c === "'" || c === '"' || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++
    } else if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') {
      depth--
      if (depth === 0) return { open, close: i }
    }
  }
  return null
}

/** Where `imports:` sits at the top level of the module object, ignoring comments and nested objects. */
function topLevelImports(source: string, range: { open: number; close: number }) {
  let depth = 0
  for (let i = range.open; i < range.close; i++) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') i = source.indexOf('\n', i)
    else if (c === '/' && source[i + 1] === '*') i = source.indexOf('*/', i + 2) + 1
    else if (c === "'" || c === '"' || c === '`') {
      for (i++; i < range.close && source[i] !== c; i++) if (source[i] === '\\') i++
    } else if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (depth === 1 && /\bimports\s*:/y.test(source.slice(i, i + 40)) && !/[\w$]/.test(source[i - 1] ?? '')) {
      const colon = source.indexOf(':', i)
      let value = colon + 1
      while (/\s/.test(source[value] ?? '')) value++
      return { value }
    }
  }
  return null
}

/** Adds `VigieModule.forRoot()` to the root module's imports, creating the array when there is none. Throws rather than guess. */
export function addModule(source: string) {
  if (/\bVigieModule\b/.test(source)) return source
  const range = moduleObject(source)
  if (!range) throw new Error('No @Module({ … }) found in the root module.')
  const found = topLevelImports(source, range)
  if (found && source[found.value] !== '[') throw new Error('Its imports is not an array literal.')

  const quote = /from "/.test(source) ? '"' : "'"
  const semi = /from ['"][^'"]+['"];/.test(source) ? ';' : ''
  const importLine = `import { VigieModule } from ${quote}@vigiejs/nestjs${quote}${semi}\n`
  let next: string
  if (found) {
    const at = found.value + 1
    const empty = /^\s*\]/.test(source.slice(at))
    next = source.slice(0, at) + (empty ? 'VigieModule.forRoot()' : 'VigieModule.forRoot(), ') + source.slice(at)
  } else {
    next = `${source.slice(0, range.open + 1)}\n  imports: [VigieModule.forRoot()],${source.slice(range.open + 1)}`
  }
  const lastImport = [...next.matchAll(/^import[^;]*?from\s+['"][^'"]+['"];?[ \t]*$/gm)].at(-1)
  const at = lastImport ? lastImport.index! + lastImport[0].length + 1 : 0
  return next.slice(0, at) + importLine + next.slice(at)
}

/** Sets or replaces one KEY=value line in .env. */
export function setEnv(source: string, key: string, value: string) {
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  if (pattern.test(source)) return source.replace(pattern, line)
  return `${source}${source && !source.endsWith('\n') ? '\n' : ''}${line}\n`
}

function edit(path: string, change: (source: string) => string) {
  const before = readFileSync(path, 'utf8')
  const after = change(before)
  if (after !== before) writeFileSync(path, after)
  return after !== before
}

async function main() {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) throw new Error('Run this in your Nest app, next to its package.json.')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; dependencies?: Record<string, string> }
  if (!pkg.dependencies?.['@nestjs/core']) throw new Error('This is not a Nest app: @nestjs/core is not in its dependencies.')
  const service = process.env.OTEL_SERVICE_NAME ?? pkg.name?.replace(/^@[^/]+\//, '') ?? 'app'

  if (!pkg.dependencies['@vigiejs/nestjs'] && flags['no-install'] !== 'true') {
    const pm = packageManager()
    const spec = process.env.VIGIE_NESTJS_SPEC ?? '@vigiejs/nestjs'
    console.log(`Installing @vigiejs/nestjs with ${pm.name}…`)
    const result = spawnSync(pm.name, [...pm.add, spec], { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.status !== 0) throw new Error(`${pm.name} could not install @vigiejs/nestjs.`)
  }

  let vigie: Found | null = null
  if (flags.url) vigie = (await ask(flags.url)) ?? { url: trim(flags.url), mode: 'server' }
  else {
    vigie = await findLocal()
    if (vigie) ok(`Found Vigie at ${vigie.url}`)
  }
  if (!vigie) {
    const url = await prompt('Where does Vigie run?', 'http://localhost:5310')
    vigie = (await ask(url)) ?? { url: trim(url), mode: 'server' }
  }

  let key = flags.key ?? ''
  if (!key && vigie.mode === 'server') key = (await link(vigie, service)) ?? (await prompt('Paste an ingest key from Vigie, Settings, Tokens:'))

  const main = ['src/main.ts', 'src/main.js'].map((file) => join(cwd, file)).find(existsSync)
  const root = ['src/app.module.ts', 'src/app.module.js'].map((file) => join(cwd, file)).find(existsSync)
  if (main && edit(main, addRegister)) ok('Traces start first in src/main.ts')
  else if (!main) warn("No src/main.ts: add import '@vigiejs/nestjs/register' at the top of your entry file.")
  if (!root) warn('No src/app.module.ts: add VigieModule.forRoot() to your root module imports.')
  else {
    try {
      if (edit(root, addModule)) ok('VigieModule.forRoot() added to src/app.module.ts')
    } catch (error) {
      warn(`src/app.module.ts was left as it is. ${(error as Error).message} Add VigieModule.forRoot() to its imports by hand.`)
    }
  }

  const envPath = join(cwd, '.env')
  const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  writeFileSync(envPath, setEnv(setEnv(env, 'VIGIE_URL', vigie.url), 'VIGIE_KEY', key))
  ok('VIGIE_URL and VIGIE_KEY written to .env')
  const example = join(cwd, '.env.example')
  if (existsSync(example)) edit(example, (source) => setEnv(setEnv(source, 'VIGIE_URL', ''), 'VIGIE_KEY', ''))

  const sent = await sendTestEvent(vigie, key, service)
  if (sent.ok) {
    ok(`Vigie received a test event from ${service}`)
    console.log(`  Start the app: each request now shows up at ${vigie.url}/logs`)
  } else {
    const why = sent.status === 401 ? 'Vigie refused the ingest key.' : sent.status ? `Vigie answered ${sent.status}.` : `Vigie did not answer at ${vigie.url}.`
    warn(`${why} The app is set up; fix VIGIE_URL or VIGIE_KEY in .env, then run this again.`)
    process.exitCode = 1
  }
}

const invoked = process.argv[1] && /init\.(js|ts)$|vigie-nestjs$/.test(process.argv[1])
if (invoked) {
  if (process.argv[2] && process.argv[2] !== 'init' && !process.argv[2].startsWith('--')) {
    console.log('Usage: npx @vigiejs/nestjs init [--url=https://vigie.acme.dev] [--key=vk_…] [--no-install]')
    process.exit(1)
  }
  main().catch((error: Error) => {
    console.error(`${yellow('✗')} ${error.message}`)
    process.exit(1)
  })
}
