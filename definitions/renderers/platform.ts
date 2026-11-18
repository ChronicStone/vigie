import { defineErrorRenderer, defineLogRenderer, link, ui } from "vigie/sdk";

export const database = defineLogRenderer({
  id: "database",
  match: "db.*",
  title: "Database",
  render: (e) => {
    const queries = e.num("db.queries");
    const time = e.num("db.durationMs");
    const total = e.num("durationMs") || 1;
    const repeated = e.num("db.repeatedQueries");
    return [
      ui.numbers({
        queries,
        [`${Math.round((time / total) * 100)}% of the time`]: ui.duration(time),
        repeated: { value: repeated, tone: repeated ? "warn" : "neutral" },
      }),
      ui.meter(time, total, undefined, "brand"),
      repeated > 0 && e.has("db.repeatedStatement") && ui.sql(e.str("db.repeatedStatement"), `Same query ${repeated} times, likely N+1.`),
    ];
  },
  row: (e) => (e.num("db.repeatedQueries") > 3 ? `same query ${e.num("db.repeatedQueries")} times` : null),
  text: (e) => `${e.num("db.queries")} queries, ${e.num("db.durationMs")} ms, ${e.num("db.repeatedQueries")} repeated`,
});

export const who = defineLogRenderer({
  id: "who",
  match: "user.*",
  title: "Who",
  when: (e) => e.has("user.id"),
  render: (e) => [
    ui.kv({
      person: link.person(e.str("user.id")),
      role: e.str("user.adminRole"),
      account: e.has("workspace.accountId") ? link.account(e.str("workspace.accountId")) : undefined,
      view: e.str("workspace.view"),
    }),
  ],
  text: (e) => `user ${e.str("user.id")} (${e.str("user.adminRole")})`,
});

export const task = defineLogRenderer({
  id: "task",
  match: "task.*",
  title: "Task",
  when: (e) => e.has("task.kind"),
  render: (e) => [
    ui.kv({
      run: link.task(e.str("task.id"), e.str("task.id")),
      kind: ui.code(e.str("task.kind")),
      key: ui.code(e.str("task.key")),
      attempt: e.str("task.attempt"),
      outcome: e.str("taskOutcome.type"),
      worker: e.str("workerId"),
    }),
  ],
  text: (e) => `task ${e.str("task.kind")} ${e.str("task.id")} attempt ${e.str("task.attempt")}: ${e.str("taskOutcome.type")}`,
});

export const errors = defineErrorRenderer({
  id: "known-errors",
  match: (error) => error.code.startsWith("INVOXA_") || error.code === "E_VALIDATION_ERROR",
  why: (error) => (error.code === "E_VALIDATION_ERROR" ? "The request did not pass validation." : `Invoxa refused the call: ${error.message}.`),
  fix: (error) => (error.code === "E_VALIDATION_ERROR" ? "Read the invalid fields in the response body." : "Fix the client in Invoxa, then requeue the task from its run page."),
});

const PROVIDER_NAMES: Record<string, string> = { PARCELO: "Parcelo", PAYNEST: "Paynest", INVOXA: "Invoxa", PIPEDECK: "Pipedeck", TAXBOX: "Taxbox" };
const providerOf = (code: string) => Object.keys(PROVIDER_NAMES).find((key) => code.startsWith(`${key}_`));

/** A provider that stops answering is what most task alerts come down to, so say that first. */
export const providerDown = defineErrorRenderer({
  id: "provider-unavailable",
  match: (error) => error.code.endsWith("_UNAVAILABLE") && Boolean(providerOf(error.code)),
  headline: (error) => `${PROVIDER_NAMES[providerOf(error.code)!]} is refusing calls`,
  recovered: (error) => `${PROVIDER_NAMES[providerOf(error.code)!]} is answering again`,
  why: (error) => `${PROVIDER_NAMES[providerOf(error.code)!]} did not accept the call: ${error.message}`,
  fix: () => "Nothing yet. Tasks retry on their own. If it lasts, check the provider's status and lower this kind's concurrency.",
});
