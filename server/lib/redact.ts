/** Redaction runs at ingest, before anything is stored. Nothing downstream ever sees the raw value. */
/** Path segments whose next segment is a secret, such as the token in a reset link. Apps add theirs with `defineRedactor({ paths })`. */
const DEFAULT_SECRET_PATHS = ["reset-password", "password/reset", "verify-email", "magic-link", "invitations"];
const pathsDetail = (paths: string[]) => paths.map((p) => `/${p}/*`).join(", ");

export const RULES = [
  { id: "secret-keys", title: "Secret field names", detail: "password, token, authorization, cookie, secret, api key" },
  { id: "secret-paths", title: "Paths with a secret", detail: pathsDetail(DEFAULT_SECRET_PATHS) },
  { id: "emails", title: "Emails in values", detail: "Masked to c***@domain" },
  { id: "cards", title: "Card numbers", detail: "Masked" },
];

export const redactionCounts: Record<string, number> = Object.fromEntries(RULES.map((r) => [r.id, 0]));

const SECRET_KEY = /(^|[._-])(password|passwd|pwd|token|authorization|cookie|set-cookie|secret|api[_-]?key|private[_-]?key|session[_-]?token)($|[._-])/i;
const pathPattern = (paths: string[]) => new RegExp(`(\\/(?:${paths.map((p) => p.replace(/^\/|\/$/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\/)(?!:)[^/?#\\s"]+`, "g");
let SECRET_PATH = pathPattern(DEFAULT_SECRET_PATHS);

/** Called when definitions load: the default paths plus every `defineRedactor({ paths })`. */
export function setSecretPaths(extra: string[]) {
  const paths = [...new Set([...DEFAULT_SECRET_PATHS, ...extra.map((p) => p.replace(/^\/|\/\*?$/g, ""))])];
  SECRET_PATH = pathPattern(paths);
  RULES[1]!.detail = pathsDetail(paths);
}
const EMAIL = /([a-zA-Z0-9])[a-zA-Z0-9._%+-]*@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
const CARD = /\b(?:\d[ -]?){13,16}\b/g;
const SAFE_EMAIL_KEYS = /^(service\.|telemetry\.|process\.|host\.)/;

/** `apiKey.id` or `token.id` name the thing, they are not the secret. */
const SAFE_ID = /(\.id|Id)$/;

export function redactValue(key: string, value: string): string {
  if (SECRET_KEY.test(key) && !SAFE_ID.test(key)) {
    redactionCounts["secret-keys"]!++;
    return "[REDACTED]";
  }
  if (value.length < 6 || SAFE_EMAIL_KEYS.test(key)) return value;
  let out = value;
  if (out.includes("/")) {
    out = out.replace(SECRET_PATH, (_, prefix) => {
      redactionCounts["secret-paths"]!++;
      return `${prefix}[REDACTED]`;
    });
  }
  if (out.includes("@")) {
    out = out.replace(EMAIL, (_, first, domain) => {
      redactionCounts.emails!++;
      return `${first}***@${domain}`;
    });
  }
  if (/\d{4}/.test(out) && !key.endsWith("id") && !key.endsWith("Id")) {
    out = out.replace(CARD, (match) => {
      if (match.replace(/\D/g, "").length < 13) return match;
      redactionCounts.cards!++;
      return "[CARD]";
    });
  }
  return out;
}

export function redactMap(map: Record<string, string>) {
  for (const key in map) map[key] = redactValue(key, map[key]!);
  return map;
}
