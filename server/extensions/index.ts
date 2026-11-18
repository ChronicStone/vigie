import { readdirSync, realpathSync, statSync, watch } from "node:fs";
import { join, relative } from "node:path";
import { config } from "../config.ts";
import { setSecretPaths } from "../lib/redact.ts";
import { eventView, type ChannelDefinition, type EnricherDefinition, type HealthRuleDefinition, type IdentityDefinition, type RedactorDefinition, type ViewDefinition, type AlertDefinition, type MonitorDefinition, type StatusPageDefinition, type Catalog, type Dashboard, type ErrorRenderer, type LogRenderer, type Page, type Process, type Tool, type View } from "../../sdk/index.ts";

/**
 * Definitions can live anywhere, often in the app's own repo, where neither this repo's tsconfig
 * nor a `vigie` package resolves. Bun cannot redirect a bare import at run time, so every file under
 * the definitions folder is read with its SDK import pointed at this checkout's SDK.
 */
const SDK_PATH = join(import.meta.dir, "..", "..", "sdk", "index.ts");
const SDK_IMPORT = /(from\s*|import\s*\(\s*)(["'])(?:vigie\/sdk|@vigie\/sdk|vigie|@sdk)\2/g;
const definitionsReal = (() => {
  try {
    return realpathSync(config.definitionsDir);
  } catch {
    return config.definitionsDir;
  }
})();
const escaped = definitionsReal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
Bun.plugin({
  name: "vigie-sdk",
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escaped}/.*\\.(ts|tsx|js)(\\?.*)?$`) }, async ({ path }) => {
      const file = path.replace(/\?.*$/, "");
      const text = await Bun.file(file).text();
      return { contents: text.replace(SDK_IMPORT, `$1$2${SDK_PATH}$2`), loader: file.endsWith(".tsx") ? "tsx" : file.endsWith(".js") ? "js" : "ts" };
    });
  },
});

type Loaded = { file: string; kind: string; label: string; ok: boolean; error?: string };

export const registry = {
  renderers: [] as (LogRenderer & { file: string })[],
  errorRenderers: [] as ErrorRenderer[],
  pages: [] as (Page & { file: string })[],
  processes: [] as (Process & { file: string })[],
  alerts: [] as (AlertDefinition & { file: string })[],
  monitors: [] as (MonitorDefinition & { file: string })[],
  statusPages: [] as (StatusPageDefinition & { file: string })[],
  dashboards: [] as (Dashboard & { file: string })[],
  tools: [] as (Tool & { file: string })[],
  views: [] as (ViewDefinition & { file: string })[],
  channels: [] as (ChannelDefinition & { file: string })[],
  enrichers: [] as (EnricherDefinition & { file: string })[],
  redactors: [] as (RedactorDefinition & { file: string })[],
  healthRules: [] as (HealthRuleDefinition & { file: string })[],
  identities: [] as (IdentityDefinition & { file: string })[],
  catalog: { kind: "catalog", providers: {}, tasks: {}, retryLadder: [], slos: [], rules: [] } as Catalog,
  loaded: [] as Loaded[],
  version: 0,
  reloadMs: 0,
};

function walk(dir: string, out: string[] = []) {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.(ts|tsx|js)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
    }
  } catch {}
  return out;
}

const KIND_LABEL: Record<string, string> = { view: "Saved view", channel: "Channel", enricher: "Enricher", redactor: "Redactor", healthRule: "Health rule", identity: "Identity",  renderer: "Log renderer", errorRenderer: "Error renderer", page: "Page", process: "Process", alert: "Alert", monitor: "Monitor", statusPage: "Status page", dashboard: "Dashboard", tool: "MCP tool", catalog: "Catalogue" };

/** Loads every definition. One broken file never takes the others down: its error is shown on Settings, Extensions. */
export async function loadExtensions() {
  const started = performance.now();
  const next: typeof registry = { ...registry, renderers: [], errorRenderers: [], pages: [], processes: [], alerts: [], monitors: [], statusPages: [], dashboards: [], views: [], channels: [], enrichers: [], redactors: [], healthRules: [], identities: [], tools: [], loaded: [], catalog: { kind: "catalog", providers: {}, tasks: {}, retryLadder: [], slos: [], rules: [] } };
  const stamp = Date.now();
  for (const path of walk(config.definitionsDir).sort()) {
    const file = relative(config.definitionsDir, path);
    try {
      const module = await import(`${path}?v=${stamp}`);
      const items = Object.values(module).flat().filter((v: any) => v && typeof v === "object" && "kind" in v) as any[];
      if (!items.length) {
        // A file that exports something else is a helper the definitions share.
        if (Object.keys(module).length) {
          next.loaded.push({ file, ok: true, kind: "helper", label: "Helper" });
          continue;
        }
        throw new Error("This file exports nothing. Export a definition, for example `export const x = defineLogRenderer({…})`.");
      }
      const counts = new Map<string, number>();
      for (const item of items) {
        counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
        const tagged = { ...item, file };
        if (item.kind === "renderer") next.renderers.push(tagged);
        else if (item.kind === "errorRenderer") next.errorRenderers.push(tagged);
        else if (item.kind === "page") next.pages.push(tagged);
        else if (item.kind === "process") next.processes.push(tagged);
        else if (item.kind === "alert") next.alerts.push(tagged);
        else if (item.kind === "monitor") next.monitors.push(tagged);
        else if (item.kind === "statusPage") next.statusPages.push(tagged);
        else if (item.kind === "dashboard") next.dashboards.push(tagged);
        else if (item.kind === "tool") next.tools.push(tagged);
        else if (item.kind === "view") next.views.push(tagged);
        else if (item.kind === "channel") next.channels.push(tagged);
        else if (item.kind === "enricher") next.enrichers.push(tagged);
        else if (item.kind === "redactor") next.redactors.push(tagged);
        else if (item.kind === "healthRule") next.healthRules.push(tagged);
        else if (item.kind === "identity") next.identities.push(tagged);
        else if (item.kind === "catalog") {
          Object.assign(next.catalog.providers, item.providers);
          Object.assign(next.catalog.tasks, item.tasks);
          next.catalog.retryLadder = item.retryLadder ?? next.catalog.retryLadder;
          next.catalog.slos = [...(next.catalog.slos ?? []), ...(item.slos ?? [])];
          next.catalog.rules = [...(next.catalog.rules ?? []), ...(item.rules ?? [])];
          next.catalog.lateAfterSeconds = item.lateAfterSeconds ?? next.catalog.lateAfterSeconds;
        }
      }
      next.loaded.push({ file, ok: true, kind: items[0].kind, label: [...counts].map(([k, n]) => (n > 1 ? `${n} ${KIND_LABEL[k]?.toLowerCase().replace(/s$/, "se")}s` : KIND_LABEL[k])).join(", ") });
    } catch (error) {
      next.loaded.push({ file, ok: false, kind: "error", label: "Failed", error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
  }
  // One owner per namespace: the first file wins, the second is reported.
  const owners = new Map<string, string>();
  next.renderers = next.renderers.filter((r) => {
    const owner = owners.get(r.match);
    if (owner && !r.when) {
      const entry = next.loaded.find((l) => l.file === r.file);
      if (entry) Object.assign(entry, { ok: false, error: `${r.match} is already claimed by ${owner}` });
      return false;
    }
    owners.set(r.match, r.file);
    return true;
  });
  next.version = registry.version + 1;
  next.reloadMs = Math.round(performance.now() - started);
  Object.assign(registry, next);
  setSecretPaths(next.redactors.flatMap((r) => r.paths ?? []));
  return registry;
}

let timer: Timer | undefined;
export function watchExtensions() {
  if (config.mode !== "local") return;
  try {
    watch(config.definitionsDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await loadExtensions();
        console.log(`Definitions reloaded in ${registry.reloadMs} ms`);
      }, 120);
    });
  } catch {}
}

const prefixOf = (match: string) => match.replace(/\*$/, "");

/** Runs renderers on one event, and reports which fields they claimed, so nothing is ever hidden. */
export function renderEvent(attrs: Record<string, string>) {
  const e = eventView(attrs);
  const sections: { title: string; source: string; children: View[] }[] = [];
  const claimed = new Set<string>();
  for (const renderer of registry.renderers) {
    const prefix = prefixOf(renderer.match);
    const keys = e.keys(prefix);
    if (!keys.length) continue;
    try {
      if (renderer.when && !renderer.when(e)) continue;
      sections.push({ title: renderer.title, source: renderer.file, children: renderer.render(e).filter((v) => v !== null && v !== undefined && v !== false) });
      for (const key of keys) claimed.add(key);
    } catch (error) {
      sections.push({ title: renderer.title, source: renderer.file, children: [{ t: "callout", tone: "error", text: `This renderer threw: ${String(error)}` }] });
    }
  }
  const rest = Object.keys(attrs).filter((key) => !claimed.has(key) && !["why", "fix", "link", "vigie.fingerprint"].includes(key) && !key.startsWith("error."));
  return { sections, rest, error: explainError(attrs) };
}

export function explainError(attrs: Record<string, string>) {
  const name = attrs["error.name"] ?? attrs["error.type"] ?? "";
  const message = attrs["error.message"] ?? "";
  const code = attrs["taskOutcome.code"] ?? attrs.reason ?? attrs["error.code"] ?? "";
  let why = attrs.why ?? attrs["error.why"] ?? "";
  let fix = attrs.fix ?? attrs["error.fix"] ?? "";
  let href = attrs.link ?? attrs["error.link"] ?? "";
  if ((!why || !fix) && (name || code)) {
    const error = { name, message, code, attr: (key: string) => attrs[key] ?? "" };
    for (const renderer of registry.errorRenderers) {
      try {
        if (!renderer.match(error)) continue;
        why ||= renderer.why?.(error) ?? "";
        fix ||= renderer.fix?.(error) ?? "";
        href ||= renderer.link?.(error) ?? "";
        break;
      } catch {}
    }
  }
  if (!why && !fix && !message && !name) return null;
  return { name, code, message, stack: attrs["error.stack"] ?? attrs["exception.stacktrace"] ?? "", why, fix, link: href };
}

export function rowPhrases(attrs: Record<string, string>) {
  const e = eventView(attrs);
  const out: string[] = [];
  for (const renderer of registry.renderers) {
    if (!renderer.row || !e.keys(prefixOf(renderer.match)).length) continue;
    try {
      const phrase = renderer.row(e);
      if (phrase) out.push(phrase);
    } catch {}
  }
  return out;
}

export function eventAsText(attrs: Record<string, string>) {
  const e = eventView(attrs);
  const out: string[] = [];
  for (const renderer of registry.renderers) {
    if (!renderer.text || !e.keys(prefixOf(renderer.match)).length) continue;
    try {
      out.push(renderer.text(e));
    } catch {}
  }
  return out.join("\n");
}

/** Runs code enrichers and redactors on one row's attributes at ingest. A broken definition never loses data. */
export function applyIngestDefinitions(attributes: Record<string, string>, signal: "logs" | "spans") {
  for (const enricher of registry.enrichers) {
    if (enricher.signal && enricher.signal !== signal) continue;
    try {
      Object.assign(attributes, enricher.enrich(attributes) ?? {});
    } catch {}
  }
  for (const redactor of registry.redactors) {
    if (!redactor.keys) continue;
    for (const key of Object.keys(attributes)) {
      redactor.keys.lastIndex = 0;
      if (redactor.keys.test(key)) attributes[key] = redactor.mask ?? "[REDACTED]";
    }
  }
}
