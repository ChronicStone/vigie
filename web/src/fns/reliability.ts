import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createLinearIssue, muteLike, unmute, alertDetail, alertPreview, alerts, createAlert, deleteAlert, inbox, issueDetail, issues, markRead, pauseAlert, releases, rules, slos, testAlert, updateIssue } from "@server/api/reliability.ts";
import { getRequest } from "@tanstack/react-start/server";
import { channelNames } from "@server/api/settings.ts";
import { actorOf } from "@server/auth.ts";
import { checkMonitorNow, createMonitor, deleteMonitor, pauseMonitor, setStatusPage, uptime } from "@server/api/uptime.ts";
import { declareIncident, postStatusUpdate, saveStatusConfig, statusEditor, statusModel, statusPage } from "@server/api/status.ts";
import type { AlertRule } from "@sdk";
import { admin, operator, scoped, scopeIn, viewer } from "./auth.ts";

const envIn = z.object({ env: z.enum(["PRD", "STG", "DEV"]) });
const ruleIn = z.custom<AlertRule>((value) => typeof value === "object" && value !== null && "when" in value && "window" in value, "An alert needs a condition and a window.");

export const issuesFn = createServerFn().middleware([viewer]).validator(scoped({ filter: z.string().optional(), q: z.string().optional() })).handler(({ data }) => issues(data));
export const issueFn = createServerFn().middleware([viewer]).validator(scoped({ fp: z.string() })).handler(({ data }) => issueDetail(data));
export const updateIssueFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ fp: z.string(), status: z.enum(["open", "resolved", "archived"]).optional(), days: z.number().optional(), priority: z.enum(["high", "medium", "low"]).optional(), assignee: z.string().nullable().optional(), comment: z.string().optional() })).handler(({ data, context }) => updateIssue(data, context.actor));
export const muteIssuesFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ fp: z.string(), reason: z.string(), everywhere: z.boolean().optional() })).handler(({ data, context }) => muteLike(data, context.actor));
export const unmuteFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ id: z.string() })).handler(({ data, context }) => unmute(data, context.actor));
export const linearIssueFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ fp: z.string() })).handler(({ data, context }) => createLinearIssue(data, context.actor));
export const alertsFn = createServerFn().middleware([viewer]).handler(() => alerts());
export const alertFn = createServerFn().middleware([viewer]).validator(scoped({ id: z.string() })).handler(({ data }) => alertDetail(data));
export const alertPreviewFn = createServerFn({ method: "POST" }).middleware([viewer]).validator(scoped({ rule: ruleIn })).handler(({ data }) => alertPreview(data));
export const createAlertFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ name: z.string(), family: z.string(), rule: ruleIn })).handler(({ data, context }) => createAlert(data, context.actor));
export const pauseAlertFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ id: z.string(), paused: z.boolean() })).handler(({ data, context }) => pauseAlert(data, context.actor));
export const testAlertFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ id: z.string() })).handler(({ data }) => testAlert(data.id));
export const deleteAlertFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ id: z.string() })).handler(({ data, context }) => deleteAlert(data.id, context.actor));
export const slosFn = createServerFn().middleware([viewer]).validator(envIn).handler(({ data }) => slos(data));
export const rulesFn = createServerFn().middleware([viewer]).validator(scopeIn).handler(({ data }) => rules(data));
export const releasesFn = createServerFn().middleware([viewer]).validator(envIn).handler(({ data }) => releases(data));
export const inboxFn = createServerFn().middleware([viewer]).validator(z.object({ category: z.string().optional(), unread: z.boolean().optional() })).handler(({ data }) => inbox(data));
export const markReadFn = createServerFn({ method: "POST" }).middleware([viewer]).validator(z.object({ id: z.number().optional(), ids: z.array(z.number()).max(2000).optional() })).handler(({ data }) => markRead(data));

export const uptimeFn = createServerFn().middleware([viewer]).handler(() => uptime());
export const createMonitorFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ name: z.string(), url: z.string(), expect: z.number().nullish() })).handler(({ data, context }) => createMonitor(data, context.actor));
export const pauseMonitorFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ id: z.string(), paused: z.boolean() })).handler(({ data, context }) => pauseMonitor(data, context.actor));
export const deleteMonitorFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ id: z.string() })).handler(({ data, context }) => deleteMonitor(data.id, context.actor));
export const checkMonitorFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ id: z.string() })).handler(({ data }) => checkMonitorNow(data.id));
/** The one function without a role: statusPage answers visitors only when the page was made public. */
export const statusPageFn = createServerFn().handler(async () => statusPage(Boolean(await actorOf(getRequest()))));
export const setStatusPageFn = createServerFn({ method: "POST" }).middleware([admin]).validator(z.object({ public: z.boolean() })).handler(({ data, context }) => setStatusPage(data, context.actor));
export const channelNamesFn = createServerFn().middleware([viewer]).handler(() => channelNames());

const impactIn = z.enum(["minor", "major", "critical", "maintenance"]);
const stateIn = z.enum(["investigating", "identified", "monitoring", "resolved", "scheduled"]);
export const declareIncidentFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ title: z.string(), impact: impactIn, monitors: z.array(z.string()), state: stateIn, message: z.string(), outageId: z.number().optional() })).handler(({ data, context }) => declareIncident(data, context.actor));
export const postStatusUpdateFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ incidentId: z.number(), state: stateIn, message: z.string() })).handler(({ data, context }) => postStatusUpdate(data, context.actor));
const configIn = z.object({
  title: z.string(),
  description: z.string(),
  components: z.array(z.object({ key: z.string(), name: z.string(), group: z.string().optional() })).nullable(),
  show: z.object({ active: z.boolean(), history: z.boolean(), uptime: z.boolean(), past: z.boolean() }),
  days: z.union([z.literal(30), z.literal(60), z.literal(90)]),
});
export const statusEditorFn = createServerFn().middleware([admin]).handler(() => statusEditor());
/** The editor previews a draft before it is saved. */
export const statusPreviewFn = createServerFn({ method: "POST" }).middleware([admin]).validator(configIn).handler(({ data }) => statusModel(data));
export const saveStatusConfigFn = createServerFn({ method: "POST" }).middleware([admin]).validator(configIn).handler(({ data, context }) => saveStatusConfig(data, context.actor));
