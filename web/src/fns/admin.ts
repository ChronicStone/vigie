import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dashboard, dashboards, deleteDashboard, saveDashboard } from "@server/api/dashboards.ts";
import { cancelInvite, dropMember, inviteMember, addChannel, addToken, changeRole, dropToken, reloadExtensions, removeChannel, settingsAudit, settingsChannels, settingsExtensions, settingsMembers, settingsRedaction, settingsServices, settingsStorage, settingsTokens, testChannels, tryRedaction, pendingLink, decideLink } from "@server/api/settings.ts";
import type { Widget } from "@sdk";
import { admin, operator, owner, viewer } from "./auth.ts";

const widgets = z.custom<Widget[]>((value) => Array.isArray(value));
const idIn = z.object({ id: z.string() });

export const dashboardsFn = createServerFn().middleware([viewer]).handler(() => dashboards());
export const dashboardFn = createServerFn().middleware([viewer]).validator(idIn).handler(({ data }) => dashboard(data.id));
export const saveDashboardFn = createServerFn({ method: "POST" }).middleware([operator]).validator(z.object({ id: z.string().optional(), title: z.string(), widgets })).handler(({ data, context }) => saveDashboard(data, context.actor));
export const deleteDashboardFn = createServerFn({ method: "POST" }).middleware([operator]).validator(idIn).handler(({ data, context }) => deleteDashboard(data.id, context.actor));

export const settingsServicesFn = createServerFn().middleware([viewer]).handler(() => settingsServices());
export const settingsStorageFn = createServerFn().middleware([viewer]).handler(() => settingsStorage());
export const settingsChannelsFn = createServerFn().middleware([viewer]).handler(() => settingsChannels());
export const addChannelFn = createServerFn({ method: "POST" }).middleware([admin]).validator(z.object({ kind: z.enum(["slack", "discord", "webhook", "email"]), name: z.string(), target: z.string().url() })).handler(({ data, context }) => addChannel(data, context.actor));
export const removeChannelFn = createServerFn({ method: "POST" }).middleware([admin]).validator(idIn).handler(({ data, context }) => removeChannel(data.id, context.actor));
export const testChannelsFn = createServerFn({ method: "POST" }).middleware([operator]).handler(() => testChannels());
export const settingsMembersFn = createServerFn().middleware([admin]).handler(() => settingsMembers());
export const inviteMemberFn = createServerFn({ method: "POST" }).middleware([owner]).validator(z.object({ email: z.string(), role: z.enum(["viewer", "operator", "admin", "owner"]) })).handler(({ data, context }) => inviteMember(data, context.actor));
export const cancelInviteFn = createServerFn({ method: "POST" }).middleware([owner]).validator(idIn).handler(({ data, context }) => cancelInvite(data.id, context.actor));
export const dropMemberFn = createServerFn({ method: "POST" }).middleware([owner]).validator(idIn).handler(({ data, context }) => dropMember(data.id, context.actor));
export const changeRoleFn = createServerFn({ method: "POST" }).middleware([owner]).validator(z.object({ id: z.string(), role: z.enum(["viewer", "operator", "admin", "owner"]) })).handler(({ data, context }) => changeRole(data, context.actor));
export const settingsTokensFn = createServerFn().middleware([admin]).handler(() => settingsTokens());
export const addTokenFn = createServerFn({ method: "POST" }).middleware([admin]).validator(z.object({ kind: z.enum(["ingest", "api", "mcp", "deploy"]), name: z.string(), scope: z.enum(["read", "write"]), environment: z.string().optional() })).handler(({ data, context }) => addToken(data, context.actor));
export const dropTokenFn = createServerFn({ method: "POST" }).middleware([admin]).validator(idIn).handler(({ data, context }) => dropToken(data.id, context.actor));
export const settingsExtensionsFn = createServerFn().middleware([viewer]).handler(() => settingsExtensions());
export const reloadExtensionsFn = createServerFn({ method: "POST" }).middleware([admin]).handler(({ context }) => reloadExtensions(context.actor));
export const settingsRedactionFn = createServerFn().middleware([viewer]).handler(() => settingsRedaction());
export const tryRedactionFn = createServerFn({ method: "POST" }).middleware([viewer]).validator(z.object({ key: z.string(), value: z.string() })).handler(({ data }) => tryRedaction(data));
export const settingsAuditFn = createServerFn().middleware([admin]).handler(() => settingsAudit());
export const pendingLinkFn = createServerFn().middleware([admin]).validator(z.object({ code: z.string() })).handler(({ data }) => pendingLink(data.code));
export const decideLinkFn = createServerFn({ method: "POST" }).middleware([admin]).validator(z.object({ code: z.string(), allow: z.boolean(), environment: z.string().optional() })).handler(({ data, context }) => decideLink(data, context.actor));
