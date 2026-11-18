import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { actorOf, type Role } from "@server/auth.ts";
import { hasRole, HttpError } from "@server/api/http.ts";

/** Server functions are API endpoints: every one states the role it needs, and this is the only way to get an actor. */
const needs = (role: Role) =>
  createMiddleware({ type: "function" }).server(async ({ next }) => {
    const actor = await actorOf(getRequest());
    if (!actor) throw new HttpError(401, "Sign in first.");
    if (!hasRole(actor, role)) throw new HttpError(403, `This needs the ${role} role.`);
    return next({ context: { actor } });
  });

export const viewer = needs("viewer");
export const operator = needs("operator");
export const admin = needs("admin");
export const owner = needs("owner");

export const scopeIn = z.object({ env: z.enum(["PRD", "STG", "DEV"]), from: z.number(), to: z.number(), services: z.string().optional() });
export const scoped = <T extends z.ZodRawShape>(shape: T) => scopeIn.extend(shape);
