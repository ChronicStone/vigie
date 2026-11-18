/**
 * The Vigie SDK. Everything you can extend lives here, as plain modules under `definitions/`.
 * Files hot reload locally and deploy with your app.
 */
export type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };
export type Tone = "neutral" | "ok" | "warn" | "error" | "brand" | "muted";
export type LinkKind = "task" | "trace" | "person" | "account" | "process" | "route" | "page" | "url" | "issue";

export type View =
  | null
  | undefined
  | false
  | string
  | number
  | { t: "text"; text: string; tone?: Tone; mono?: boolean }
  | { t: "inline"; children: View[] }
  | { t: "stack"; children: View[] }
  | { t: "section"; title: string; source?: string; children: View[] }
  | { t: "nums"; items: { label: string; value: View; tone?: Tone }[] }
  | { t: "kv"; rows: { key?: string; label: string; value: View; tone?: Tone; filter?: boolean }[] }
  | { t: "table"; columns: string[]; rows: View[][] }
  | { t: "badge"; text: string; tone: Tone }
  | { t: "duration"; ms: number }
  | { t: "bytes"; value: number }
  | { t: "status"; code: number }
  | { t: "code"; text: string }
  | { t: "sql"; text: string; note?: string }
  | { t: "json"; value: Json }
  | { t: "callout"; tone: Tone; title?: string; text: string }
  | { t: "meter"; value: number; max: number; label?: string; tone?: Tone }
  | { t: "link"; kind: LinkKind; id: string; text?: string };

const clean = (children: View[]) => children.filter((c) => c !== null && c !== undefined && c !== false);

export const ui = {
  text: (text: string, options: { tone?: Tone; mono?: boolean } = {}): View => ({ t: "text", text, ...options }),
  inline: (...children: View[]): View => ({ t: "inline", children: clean(children) }),
  stack: (...children: View[]): View => ({ t: "stack", children: clean(children) }),
  section: (title: string, ...children: View[]): View => ({ t: "section", title, children: clean(children) }),
  numbers: (items: Record<string, View | { value: View; tone: Tone }>): View => ({
    t: "nums",
    items: Object.entries(items).map(([label, item]) => {
      if (item && typeof item === "object" && !("t" in item)) return { label, value: item.value, tone: item.tone };
      return { label, value: item as View };
    }),
  }),
  kv: (rows: Record<string, View>): View => ({ t: "kv", rows: Object.entries(rows).filter(([, v]) => v !== undefined && v !== "" && v !== null).map(([label, value]) => ({ label, value })) }),
  fields: (e: EventView, prefix: string, options: { hide?: RegExp; tones?: Record<string, Tone> } = {}): View => ({
    t: "kv",
    rows: e
      .keys(prefix)
      .filter((key) => !options.hide?.test(key))
      .map((key) => ({ key, label: key.slice(prefix.length).replace(/^\./, "") || key, value: e.str(key), tone: options.tones?.[e.str(key)], filter: true })),
  }),
  table: (columns: string[], rows: View[][]): View => ({ t: "table", columns, rows }),
  badge: (text: string, tone: Tone = "neutral"): View => ({ t: "badge", text, tone }),
  duration: (ms: number): View => ({ t: "duration", ms }),
  bytes: (value: number): View => ({ t: "bytes", value }),
  httpStatus: (code: number): View => ({ t: "status", code }),
  code: (text: string): View => ({ t: "code", text }),
  sql: (text: string, note?: string): View => ({ t: "sql", text, note }),
  json: (value: Json): View => ({ t: "json", value }),
  callout: (tone: Tone, text: string, title?: string): View => ({ t: "callout", tone, text, title }),
  meter: (value: number, max: number, label?: string, tone?: Tone): View => ({ t: "meter", value, max, label, tone }),
};

export const link = {
  task: (id: string, text?: string): View => ({ t: "link", kind: "task", id, text }),
  trace: (id: string, text?: string): View => ({ t: "link", kind: "trace", id, text }),
  person: (id: string, text?: string): View => ({ t: "link", kind: "person", id, text }),
  account: (id: string, text?: string): View => ({ t: "link", kind: "account", id, text }),
  process: (id: string, text?: string): View => ({ t: "link", kind: "process", id, text }),
  route: (id: string, text?: string): View => ({ t: "link", kind: "route", id, text }),
  page: (id: string, text?: string): View => ({ t: "link", kind: "page", id, text }),
  url: (id: string, text?: string): View => ({ t: "link", kind: "url", id, text }),
};

/** Read access to one wide event, using the flattened attribute names the app really emits. */
export type EventView = {
  str(key: string): string;
  num(key: string): number;
  bool(key: string): boolean;
  has(key: string): boolean;
  keys(prefix?: string): string[];
  attrs: Record<string, string>;
};

export function eventView(attrs: Record<string, string>): EventView {
  return {
    attrs,
    str: (key) => attrs[key] ?? "",
    num: (key) => Number(attrs[key] ?? 0) || 0,
    bool: (key) => attrs[key] === "true",
    has: (key) => attrs[key] !== undefined && attrs[key] !== "",
    keys: (prefix = "") => Object.keys(attrs).filter((key) => key.startsWith(prefix)),
  };
}

export type LogRenderer = {
  kind: "renderer";
  id: string;
  /** A field namespace such as `stripe.*`. Those fields are claimed: they leave the generic "other fields" list. */
  match: string;
  title: string;
  when?: (e: EventView) => boolean;
  render: (e: EventView) => View[];
  /** One short phrase for log rows. */
  row?: (e: EventView) => string | null | undefined;
  /** Plain text for MCP, Slack and agent prompts. */
  text?: (e: EventView) => string;
};
export const defineLogRenderer = (d: Omit<LogRenderer, "kind">): LogRenderer => ({ kind: "renderer", ...d });

export type ErrorInput = { name: string; message: string; code: string; attr: (key: string) => string };
export type ErrorRenderer = {
  /** The plain sentence an alert leads with when this error is behind it. */
  headline?: (error: ErrorInput) => string;
  /** The sentence when it stops. */
  recovered?: (error: ErrorInput) => string;
  kind: "errorRenderer";
  id: string;
  match: (error: { name: string; message: string; code: string; attr: (key: string) => string }) => boolean;
  why?: (error: { name: string; message: string; code: string; attr: (key: string) => string }) => string;
  fix?: (error: { name: string; message: string; code: string; attr: (key: string) => string }) => string;
  link?: (error: { name: string; message: string; code: string; attr: (key: string) => string }) => string;
};
/** Why, fix and link for errors the app does not explain itself yet. */
export const defineErrorRenderer = (d: Omit<ErrorRenderer, "kind">): ErrorRenderer => ({ kind: "errorRenderer", ...d });

export type Block =
  | { b: "row"; children: Block[]; columns?: string }
  | { b: "stat"; title: string; sql: string; unit?: string; tone?: Tone; format?: "number" | "ms" | "percent"; note?: string }
  | { b: "series"; title: string; sql: string; span?: number; height?: number; kind?: "bars" | "lines"; note?: string }
  | { b: "table"; title: string; sql: string; span?: number; link?: string }
  | { b: "events"; title: string; where: Record<string, string | number | { gt: number }>; limit?: number }
  | { b: "funnel"; title: string; steps: { label: string; sql: string; note?: string; bad?: boolean }[]; source?: string }
  | { b: "state"; sql: string; text: (row: Record<string, any>) => View };

export const row = (...children: Block[]): Block => ({ b: "row", children });
export const stat = (d: Omit<Extract<Block, { b: "stat" }>, "b">): Block => ({ b: "stat", ...d });
export const series = (d: Omit<Extract<Block, { b: "series" }>, "b">): Block => ({ b: "series", ...d });
export const table = (d: Omit<Extract<Block, { b: "table" }>, "b">): Block => ({ b: "table", ...d });
export const eventList = (d: Omit<Extract<Block, { b: "events" }>, "b">): Block => ({ b: "events", ...d });
export const funnel = (d: Omit<Extract<Block, { b: "funnel" }>, "b">): Block => ({ b: "funnel", ...d });
export const stateLine = (d: Omit<Extract<Block, { b: "state" }>, "b">): Block => ({ b: "state", ...d });

export type Page = { kind: "page"; id: string; title: string; nav?: { group: string; order?: number }; access?: "viewer" | "operator" | "admin" | "owner"; layout: Block[]; process?: string };
export const definePage = (d: Omit<Page, "kind">): Page => ({ kind: "page", ...d });

export type Step = { kind: string; label: string; expectWithin?: string; optional?: boolean; provider?: string; parallel?: Step[] };
export const step = {
  task: (kind: string, options: Omit<Step, "kind" | "parallel"> ): Step => ({ kind, ...options }),
  parallel: (steps: Step[]): Step => ({ kind: "", label: "", parallel: steps }),
};
export type Process = {
  kind: "process";
  id: string;
  title: string;
  /** What one instance follows, in the words people use. */
  subject: string;
  /** Instances are grouped by the task's subject, or by task.key when it has none. Only keys with this prefix belong here. */
  keyPrefix?: string;
  /**
   * When some kinds name the same object by another id, such as the provider's. Read from the app's
   * table: `aliasColumn` holds the other id and `subjectColumn` the one the other kinds use.
   */
  aliases?: { subjectType: string; table: string; aliasColumn: string; subjectColumn: string }[];
  description?: string;
  steps: Step[];
  sla?: string;
  /** Standing processes run on a clock and have no instances, only runs. */
  standing?: boolean;
};
export const defineProcess = (d: Omit<Process, "kind">): Process => ({ kind: "process", ...d });

export type AlertWhen =
  | { source: "task-failure-rate"; kind?: string }
  | { source: "oldest-due" }
  | { source: "request-error-rate" }
  | { source: "route-p95"; method?: string; route?: string; minRequests?: number }
  | { source: "log-count"; where: Record<string, string> }
  | { source: "absence"; taskKind: string }
  | { source: "metric"; name: string; agg?: "avg" | "max" | "latest"; attributes?: Record<string, string> }
  | { source: "new-error" }
  | { source: "slo-burn"; slo: string }
  | { source: "rule-violation"; rule: string }
  | { source: "sql"; sql: string };
export type QuietHours = { from: string; to: string; timezone?: string };
/**
 * `sigma` fires on a value that far above its own last 7 days, instead of a fixed `above`.
 * `quiet` keeps it recording during those hours but holds the notification until they end.
 */
export type AlertRule = { when: AlertWhen; above?: number; below?: number; sigma?: number; quiet?: QuietHours; window: string; for?: string; notify?: string; unit?: string; condition?: string };
export type AlertDefinition = { kind: "alert"; id: string; name: string; family: string } & AlertRule;
export const defineAlert = (d: Omit<AlertDefinition, "kind">): AlertDefinition => ({ kind: "alert", ...d });

/** Checked every minute from Vigie. `expect` is an exact status; without it, anything under 400 counts as up. */
export type MonitorDefinition = { kind: "monitor"; id: string; name: string; url: string; expect?: number };
export const defineMonitor = (d: Omit<MonitorDefinition, "kind">): MonitorDefinition => ({ kind: "monitor", ...d });

/** Where a status page line takes its state: a monitor or an alert from definitions, or one made in the app by id. */
export type StatusSource = MonitorDefinition | AlertDefinition | `monitor:${string}` | `alert:${string}`;
export type StatusPageSection = "active" | "history" | "uptime" | "past";
/**
 * The public status page. Only what is listed shows, in this order, under the names visitors read:
 * outages of anything else stay off the page. Incidents and their updates are written in the app or over MCP.
 */
export type StatusPageDefinition = {
  kind: "statusPage";
  title?: string;
  description?: string;
  /** Anyone with the link can open it. Leave it out to decide in the app. */
  public?: boolean;
  components: { name: string; from: StatusSource; group?: string }[];
  show?: Partial<Record<StatusPageSection, boolean>>;
  days?: 30 | 60 | 90;
};
export const defineStatusPage = (d: Omit<StatusPageDefinition, "kind">): StatusPageDefinition => ({ kind: "statusPage", ...d });
/** The `monitor:<id>` or `alert:<id>` key a source stands for. */
export const statusKey = (from: StatusSource) => (typeof from === "string" ? from : `${from.kind}:${from.id}`);

export type Widget = { type: "stat" | "series" | "bars" | "lines" | "table" | "list" | "events" | "pie" | "sparkline"; title: string; span?: number; height?: number; sql: string; unit?: string; tone?: Tone; format?: "number" | "ms" | "percent"; legend?: string[] };
export type Dashboard = { kind: "dashboard"; id: string; title: string; widgets: Widget[] };
export const defineDashboard = (d: Omit<Dashboard, "kind">): Dashboard => ({ kind: "dashboard", ...d });

export type ToolContext = { sql: (query: string) => Promise<Record<string, any>[]>; env: string };
export type Tool = { kind: "tool"; name: string; description: string; scope: "read" | "write"; input?: Record<string, unknown>; run: (ctx: ToolContext, input: any) => unknown | Promise<unknown> };
export const defineTool = (d: Omit<Tool, "kind">): Tool => ({ kind: "tool", ...d });

export type TaskKindInfo = { integration?: string; switch?: string; every?: string; at?: string; serial?: string; concurrency?: number; handler?: string; clock?: string };
export type Catalog = { kind: "catalog"; providers: Record<string, string>; tasks: Record<string, TaskKindInfo>; retryLadder?: string[]; slos?: SloDefinition[]; rules?: RuleDefinition[]; lateAfterSeconds?: number };
export const defineCatalog = (d: Omit<Catalog, "kind">): Catalog => ({ kind: "catalog", ...d });

export type SloDefinition = { id: string; name: string; objective: number; good: string; total: string };
export type RuleDefinition = { id: string; name: string; entry: { route?: string; method?: string; taskKind?: string; any?: boolean }; statement?: string; host?: string; aiCalls?: boolean; atMost?: number; exactly?: number };

/** A saved view in code. It shows up beside the views people save in the app. */
export type ViewDefinition = { kind: "view"; id: string; name: string; scope: string; filter: string };
export const defineView = (d: Omit<ViewDefinition, "kind">): ViewDefinition => ({ kind: "view", ...d });

/** A notification channel in code, such as a differently worded Slack post. */
export type ChannelDefinition = { kind: "channel"; name: string; send: (message: { title: string; text: string; notice: unknown }) => Promise<void> | void };
export const defineChannel = (d: Omit<ChannelDefinition, "kind">): ChannelDefinition => ({ kind: "channel", ...d });

/** Adds or derives attributes at ingest, before storage. Return the attributes to add. */
export type EnricherDefinition = { kind: "enricher"; name: string; signal?: "logs" | "spans"; enrich: (attributes: Readonly<Record<string, string>>) => Record<string, string> | undefined };
export const defineEnricher = (d: Omit<EnricherDefinition, "kind">): EnricherDefinition => ({ kind: "enricher", ...d });

/** A second layer of redaction at ingest. Any attribute whose key matches is replaced. */
/** Masks more at ingest. `keys` masks whole fields by name; `paths` masks the segment after each path, as in `/webhooks/:secret`. */
export type RedactorDefinition = { kind: "redactor"; name: string; keys?: RegExp; paths?: string[]; mask?: string };
export const defineRedactor = (d: Omit<RedactorDefinition, "kind">): RedactorDefinition => ({ kind: "redactor", ...d });

export type HealthFacts = { oldestDue: number; due: number; scheduled: number; failedShare: number; attempts: number; workers: string[]; lost: number };
/** A rule feeding the task engine verdict cards. It can only make a card worse, never hide a problem. */
export type HealthRuleDefinition = { kind: "healthRule"; name: string; card: "flow" | "execution" | "liveness"; check: (facts: HealthFacts) => "bad" | "warn" | undefined };
export const defineHealthRule = (d: Omit<HealthRuleDefinition, "kind">): HealthRuleDefinition => ({ kind: "healthRule", ...d });

/** Resolves ids to people and accounts, in place of the app database. */
export type IdentityDefinition = { kind: "identity"; name: string; people: () => Promise<{ id: string; name: string; role?: string; accountId?: string; accountName?: string }[]> };
export const defineIdentity = (d: Omit<IdentityDefinition, "kind">): IdentityDefinition => ({ kind: "identity", ...d });

export const defineSlo = (d: SloDefinition): Catalog => ({ kind: "catalog", providers: {}, tasks: {}, slos: [d] });
export const defineRule = (d: RuleDefinition): Catalog => ({ kind: "catalog", providers: {}, tasks: {}, rules: [d] });
