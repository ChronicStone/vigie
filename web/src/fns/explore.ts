import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { logEvent, logFacet, logFields, logLevels, logRows, sameService, timeline } from "@server/api/logs.ts";
import { metricAttributes, metricList, metricSeries, runConsole, CONSOLE_TABLES } from "@server/api/metrics.ts";
import { traceCounts, traceDetail, traceList } from "@server/api/traces.ts";
import { addSavedView, globalSearch, savedViews, shell } from "@server/app.ts";
import { aiExplain, aiFilter, aiStatus } from "@server/ai.ts";
import { dbLinks, dbRows, dbSources, dbSql, dbStructure, dbTables } from "@server/api/database.ts";
import { admin, operator, scoped, scopeIn, viewer } from "./auth.ts";

const envIn = z.object({ env: z.enum(["PRD", "STG", "DEV"]) });
const logQuery = { q: z.string().optional(), level: z.string().optional(), kind: z.string().optional(), filters: z.array(z.object({ field: z.string(), op: z.enum(["is", "not", "contains", "not_contains", "starts", "gt", "gte", "lt", "lte", "exists"]), values: z.array(z.string()) })).optional() };

export const shellFn = createServerFn().middleware([viewer]).validator(envIn).handler(({ data, context }) => shell(data, context.actor));
export const searchFn = createServerFn().middleware([viewer]).validator(envIn.extend({ q: z.string() })).handler(({ data }) => globalSearch(data));
export const timelineFn = createServerFn().middleware([viewer]).validator(scopeIn).handler(({ data }) => timeline(data));

export const logRowsFn = createServerFn().middleware([viewer]).validator(scoped({ ...logQuery, before: z.number().optional(), limit: z.number().optional() })).handler(({ data }) => logRows(data));
export const logLevelsFn = createServerFn().middleware([viewer]).validator(scoped(logQuery)).handler(({ data }) => logLevels(data));
export const logFacetFn = createServerFn().middleware([viewer]).validator(scoped({ ...logQuery, field: z.string() })).handler(({ data }) => logFacet(data));
export const logFieldsFn = createServerFn().middleware([viewer]).validator(scopeIn).handler(({ data }) => logFields(data));
export const logEventFn = createServerFn().middleware([viewer]).validator(z.object({ id: z.string() })).handler(({ data }) => logEvent(data.id));
export const sameServiceFn = createServerFn().middleware([viewer]).validator(scoped({ service: z.string(), at: z.number() })).handler(({ data }) => sameService(data));
export const savedViewsFn = createServerFn().middleware([viewer]).validator(z.object({ scope: z.string() })).handler(({ data }) => savedViews(data.scope));
export const addSavedViewFn = createServerFn({ method: "POST" }).middleware([viewer]).validator(z.object({ name: z.string().min(1), scope: z.string(), filter: z.string() })).handler(({ data }) => addSavedView(data));

export const traceListFn = createServerFn().middleware([viewer]).validator(scoped({ q: z.string().optional(), filter: z.string().optional(), kind: z.string().optional(), sort: z.string().optional(), before: z.number().optional(), offset: z.number().optional(), limit: z.number().optional() })).handler(({ data }) => traceList(data));
export const traceCountsFn = createServerFn().middleware([viewer]).validator(scopeIn).handler(({ data }) => traceCounts(data));
export const traceFn = createServerFn().middleware([viewer]).validator(z.object({ id: z.string() })).handler(({ data }) => traceDetail(data.id));

export const metricListFn = createServerFn().middleware([viewer]).validator(scopeIn).handler(({ data }) => metricList(data));
export const metricAttributesFn = createServerFn().middleware([viewer]).validator(scoped({ name: z.string() })).handler(({ data }) => metricAttributes(data));
export const metricSeriesFn = createServerFn().middleware([viewer]).validator(scoped({ name: z.string(), type: z.string(), agg: z.string(), groupBy: z.string().optional(), filters: z.record(z.string(), z.string()).optional() })).handler(({ data }) => metricSeries(data));
export const consoleTablesFn = createServerFn().middleware([viewer]).handler(() => CONSOLE_TABLES);
export const runConsoleFn = createServerFn({ method: "POST" }).middleware([viewer]).validator(scoped({ sql: z.string() })).handler(({ data }) => runConsole(data));

const source = z.enum(["pg", "ch"]);
export const dbSourcesFn = createServerFn().middleware([viewer]).handler(() => dbSources());
export const dbTablesFn = createServerFn().middleware([viewer]).validator(z.object({ source })).handler(({ data }) => dbTables(data));
export const dbStructureFn = createServerFn().middleware([operator]).validator(z.object({ source, table: z.string() })).handler(({ data }) => dbStructure(data));
export const dbLinksFn = createServerFn().middleware([operator]).validator(z.object({ source, table: z.string() })).handler(({ data }) => dbLinks(data));
export const dbRowsFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ source, table: z.string(), filters: z.array(z.object({ column: z.string(), op: z.string(), value: z.string().optional() })).optional(), limit: z.number().optional(), offset: z.number().optional(), search: z.string().optional(), sort: z.string().optional(), desc: z.boolean().optional() })).handler(({ data }) => dbRows(data));
export const dbSqlFn = createServerFn({ method: "POST" }).middleware([admin]).validator(z.object({ source, sql: z.string() })).handler(({ data }) => dbSql(data));

export const aiStatusFn = createServerFn().middleware([viewer]).handler(() => aiStatus());
export const aiFilterFn = createServerFn({ method: "POST" }).middleware([viewer]).validator(z.object({ text: z.string(), fields: z.array(z.string()) })).handler(({ data }) => aiFilter(data));
export const aiExplainFn = createServerFn({ method: "POST" }).middleware([viewer]).validator(z.object({ eventId: z.string().optional(), traceId: z.string().optional() })).handler(({ data }) => aiExplain(data));
