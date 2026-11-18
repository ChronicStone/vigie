import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { actionsEnabled, appTasksUrl, bulkDryRun, bulkList, bulkRun, schedules, taskAction, taskHealth, taskKind, taskList, taskRun, workers , switchHistory } from "@server/api/tasks.ts";
import { processDetail, processInstance, processList } from "@server/api/processes.ts";
import { customPage, eventsBlock } from "@server/api/dashboards.ts";
import { owner, scoped, scopeIn, viewer } from "./auth.ts";

const runFilter = { q: z.string().optional(), kind: z.string().optional(), worker: z.string().optional(), integration: z.string().optional(), account: z.string().optional(), view: z.string().optional(), state: z.string().optional() };
const action = z.enum(["requeue", "cancel", "run-now", "ignore"]);

export const taskHealthFn = createServerFn().middleware([viewer]).validator(scopeIn).handler(({ data }) => taskHealth(data));
export const taskListFn = createServerFn().middleware([viewer]).validator(scoped(runFilter)).handler(({ data }) => taskList(data));
export const taskKindFn = createServerFn().middleware([viewer]).validator(scoped({ kind: z.string() })).handler(({ data }) => taskKind(data));
export const taskRunFn = createServerFn().middleware([viewer]).validator(z.object({ id: z.string() })).handler(({ data }) => taskRun(data.id));
export const workersFn = createServerFn().middleware([viewer]).validator(scopeIn).handler(({ data }) => workers(data));
export const schedulesFn = createServerFn().middleware([viewer]).validator(scopeIn).handler(({ data }) => schedules(data));
export const taskActionFn = createServerFn({ method: "POST" }).middleware([owner]).validator(z.object({ id: z.string(), action, reason: z.string().optional() })).handler(({ data, context }) => taskAction(data, context.actor));
export const bulkListFn = createServerFn().middleware([viewer]).handler(() => bulkList());
export const bulkDryRunFn = createServerFn({ method: "POST" }).middleware([owner]).validator(scoped({ action, reason: z.string(), name: z.string().optional(), ids: z.array(z.string()).optional(), filter: z.object(runFilter).optional() })).handler(({ data, context }) => bulkDryRun(data, context.actor));
export const bulkRunFn = createServerFn({ method: "POST" }).middleware([owner]).validator(z.object({ id: z.string() })).handler(({ data, context }) => bulkRun(data, context.actor));

export const processListFn = createServerFn().middleware([viewer]).validator(scopeIn).handler(({ data }) => processList(data));
export const processFn = createServerFn().middleware([viewer]).validator(scoped({ id: z.string() })).handler(({ data }) => processDetail(data));
export const instanceFn = createServerFn().middleware([viewer]).validator(scoped({ id: z.string(), key: z.string() })).handler(({ data }) => processInstance(data));
export const customPageFn = createServerFn().middleware([viewer]).validator(scoped({ id: z.string() })).handler(({ data }) => customPage(data));
export const eventsBlockFn = createServerFn().middleware([viewer]).validator(scoped({ match: z.record(z.string(), z.union([z.string(), z.number(), z.object({ gt: z.number() })])), limit: z.number().optional() })).handler(({ data }) => eventsBlock(data));
export const switchHistoryFn = createServerFn().middleware([viewer]).validator(z.object({ key: z.string() })).handler(({ data }) => switchHistory(data));
export const taskActionsInfoFn = createServerFn().middleware([viewer]).handler(() => ({ enabled: actionsEnabled(), appTasksUrl: appTasksUrl() }));
