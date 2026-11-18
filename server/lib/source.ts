import { config } from "../config.ts";

const cache = new Map<string, string | null>();
const MAX_FILES = 200;
const CONTEXT = 5;

export const sourceEnabled = () => Boolean(config.source.repo && config.source.token);

/** The repo path and line from one stack frame, whatever folder the app ran from. */
export function frameLocation(stack: string) {
  for (const line of stack.split("\n")) {
    if (!line.includes(" at ") || line.includes("node_modules") || line.includes("node:")) continue;
    const match = line.match(/(?:\(|at\s)(?:file:\/\/)?([^()\s]+?):(\d+):\d+\)?\s*$/);
    if (!match) continue;
    const path = match[1]!.replace(/^\/+/, "");
    if (path.split("/").includes("..")) return null;
    return { path: path.replace(/^(?:.*?\/)?(?=app\/|apps\/|packages\/|start\/|config\/)/, ""), line: Number(match[2]) };
  }
  return null;
}

/** Only a full commit names one exact file. A tag or "0.0.1" could show the wrong lines, so those show nothing. */
export async function sourceAround(stack: string | null | undefined, version: string | null | undefined) {
  if (!sourceEnabled() || !stack || !version || !/^[0-9a-f]{7,40}$/.test(version)) return null;
  const at = frameLocation(stack);
  if (!at) return null;
  const path = at.path.startsWith("apps/") || at.path.startsWith("packages/") ? at.path : `${config.source.prefix}${at.path}`;
  const key = `${version}:${path}`;
  if (!cache.has(key)) {
    if (cache.size >= MAX_FILES) cache.delete(cache.keys().next().value!);
    const response = await fetch(`${config.source.api}/repos/${config.source.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${version}`, { headers: { accept: "application/vnd.github.raw+json", authorization: `Bearer ${config.source.token}`, "user-agent": "vigie" }, signal: AbortSignal.timeout(5000) }).catch(() => null);
    cache.set(key, response?.ok ? await response.text() : null);
  }
  const file = cache.get(key);
  if (!file) return null;
  const lines = file.split("\n");
  const from = Math.max(1, at.line - CONTEXT);
  return { path, line: at.line, version, url: `https://github.com/${config.source.repo}/blob/${version}/${path}#L${at.line}`, lines: lines.slice(from - 1, at.line + CONTEXT).map((text, index) => ({ n: from + index, text })) };
}
