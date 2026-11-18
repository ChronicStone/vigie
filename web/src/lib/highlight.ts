import { createHighlighter, defineLanguage, type HighlightToken, type HighlightTokenClass, type TokenRange } from "@tanstack/highlight/core";
import { env } from "@tanstack/highlight/languages/env";
import { json } from "@tanstack/highlight/languages/json";
import { ts } from "@tanstack/highlight/languages/ts";

/** One pass, first alternative wins, no overlaps: the classify step decides what a match is. */
function scan(code: string, pattern: RegExp, classify: (match: string, end: number) => HighlightTokenClass | null): TokenRange[] {
  const out: TokenRange[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    if (!match[0]) {
      pattern.lastIndex++;
      continue;
    }
    const end = match.index + match[0].length;
    const className = classify(match[0], end);
    if (className) out.push({ className, start: match.index, end });
  }
  return out;
}

const SQL_KEYWORDS = new Set(
  "add all alter analyze and any array as asc attach begin between by case cast check column commit constraint create cross database default delete desc distinct drop else end except exists explain filter final first following foreign format from full global group having ilike in index inner insert intersect interval into is join key last lateral left like limit materialized natural not nulls offset on only or order outer over partition prewhere primary range recursive references returning right rollback row rows sample select set settings table then to truncate union unique unnest update using values view when where window with within"
    .split(" "),
);
const SQL = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'\\])*'|"(?:""|[^"])*"|`[^`]*`|\$[\w.]+|\{\w+:\w+\}|\b\d+(?:\.\d+)?\b|[A-Za-z_]\w*|::|[=<>!|+*/%-]+|\?/g;

/** Postgres and ClickHouse. The stock grammar reads "id" as a string, which colours a whole ORM query the same. */
export const sqlLanguage = defineLanguage({
  name: "sql",
  tokenize: (code) =>
    scan(code, SQL, (match, end) => {
      const first = match[0]!;
      if (first === "-" && match[1] === "-") return "comment";
      if (first === "/" && match[1] === "*") return "comment";
      if (first === "'") return "string";
      if (first === '"' || first === "`") return "property";
      if (first === "$" || first === "{" || first === "?") return "variable";
      if (first >= "0" && first <= "9") return "number";
      if (/^[A-Za-z_]/.test(match)) {
        const word = match.toLowerCase();
        if (word === "true" || word === "false" || word === "null") return "literal";
        if (SQL_KEYWORDS.has(word)) return "keyword";
        if (code[end] === "(") return "function";
        return null;
      }
      return "operator";
    }),
});

const LOG = /https?:\/\/[^\s"']+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{24,}\b|"(?:[^"\\]|\\.)*"|(?<![\w])'(?:[^'\\]|\\.)*'|\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|\b(?:ERROR|FATAL|FAILED|failed|error)\b|\b(?:WARN|WARNING|warn|warning)\b|\b(?:true|false|null)\b|[\w.-]+(?==)|(?<![\w.:/])\/[\w\-./:{}%~@]*|\b[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)+\b|(?<![\w.-])\d+(?:\.\d+)?(?:\s?(?:ms|s|min|KB|MB|GB|%))?(?![\w.-])/g;

/** A log line: what was called, where, how long and how it ended stand out; ids step back. */
export const logLanguage = defineLanguage({
  name: "log",
  tokenize: (code) =>
    scan(code, LOG, (match, end) => {
      const first = match[0]!;
      if (match.startsWith("http")) return "link";
      if (first === '"' || first === "'") return "string";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(match) || /^[0-9a-f]{24,}$/.test(match)) return "meta";
      if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(match)) return "keyword";
      if (/^(ERROR|FATAL|FAILED|failed|error)$/.test(match)) return "deleted";
      if (/^(WARN|WARNING|warn|warning)$/.test(match)) return "tag";
      if (/^(true|false|null)$/.test(match)) return "literal";
      if (code[end] === "=") return "property";
      if (first === "/") return "attr";
      if (first >= "0" && first <= "9") return "number";
      return "function";
    }),
});

/** A stack trace: the error, then your frames bright and dependency frames dim. */
export const stackLanguage = defineLanguage({
  name: "stack",
  tokenize: (code) => {
    const out: TokenRange[] = [];
    let offset = 0;
    for (const line of code.split("\n")) {
      const frame = line.match(/^(\s*)at\s+(?:(.+?)\s+\()?(.+?)(\)?)$/);
      if (frame) {
        const dim = /node_modules|^node:|\(node:/.test(line.trim().slice(3));
        if (dim) out.push({ className: "comment", start: offset, end: offset + line.length });
        else {
          const start = offset + frame[1]!.length;
          out.push({ className: "comment", start, end: start + 2 });
          let at = line.indexOf(frame[3]!, frame[1]!.length + 3);
          if (frame[2]) {
            const fn = line.indexOf(frame[2], frame[1]!.length + 3);
            out.push({ className: "function", start: offset + fn, end: offset + fn + frame[2].length });
            at = line.indexOf(frame[3]!, fn + frame[2].length);
          }
          const place = frame[3]!.match(/^(.*?)(:\d+(?::\d+)?)?$/)!;
          out.push({ className: "string", start: offset + at, end: offset + at + place[1]!.length });
          if (place[2]) out.push({ className: "number", start: offset + at + place[1]!.length, end: offset + at + frame[3]!.length });
        }
      } else {
        const error = line.match(/^\s*(?:\w+:\s*)?\w*(?:Error|Exception)\b/);
        if (error) out.push({ className: "deleted", start: offset + error.index!, end: offset + error[0].length });
      }
      offset += line.length + 1;
    }
    return out;
  },
});

/** A source position on its own: the file, then the line and column. */
export const placeLanguage = defineLanguage({
  name: "place",
  tokenize: (code) => {
    const position = code.match(/:\d+(?::\d+)?$/);
    const end = position ? position.index! : code.length;
    return [{ className: "string" as const, start: 0, end }, ...(position ? [{ className: "number" as const, start: end, end: code.length }] : [])];
  },
});

const highlighter = createHighlighter({ languages: [sqlLanguage, logLanguage, stackLanguage, placeLanguage, json, env, ts] });

export type Lang = "sql" | "log" | "stack" | "place" | "json" | "env" | "ts" | "plain";

/** Past this a line is data, not something to read: it stays plain so a huge payload never blocks a frame. */
const MAX = 200_000;
const CACHE = 4_000;
const cache = new Map<string, HighlightToken[]>();

/** Tokens, cached, since a virtual list asks again for the same line every time it scrolls back into view. */
export function tokensOf(text: string, lang: Lang): HighlightToken[] {
  if (lang === "plain" || text.length > MAX) return [{ value: text }];
  const key = `${lang}\u0000${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tokens = highlighter.tokenize(text, { lang }).tokens;
  if (cache.size >= CACHE) cache.delete(cache.keys().next().value!);
  cache.set(key, tokens);
  return tokens;
}

const CLAUSE = /^(from|where|having|limit|offset|returning|values|set|union|except|intersect|prewhere|settings)$/i;
const TWO_WORD = /^(group|order|left|right|inner|full|cross)$/i;

/** ORM SQL arrives as one long line. Break it at the top level clauses, leaving strings and nested queries alone. */
export function prettySql(text: string): string {
  if (text.includes("\n")) return text;
  let depth = 0;
  let out = "";
  const word = /'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_]\w*|[()]|[^'"A-Za-z_()]+/g;
  for (const part of text.match(word) ?? [text]) {
    if (part === "(") depth++;
    else if (part === ")") depth--;
    else if (depth === 0 && out && !out.endsWith("\n") && (CLAUSE.test(part) || TWO_WORD.test(part) || /^join$/i.test(part) && !/(left|right|inner|full|cross|outer)\s+$/i.test(out))) out = `${out.trimEnd()}\n`;
    out += part;
  }
  return out;
}
