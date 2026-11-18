import { config } from "../config.ts";
import { verifyToken } from "../state/tokens.ts";
import { accept, Backpressure, decodeBody, ingestStats } from "./pipeline.ts";
import type { Signal } from "./proto.ts";

const PATHS: Record<string, Signal> = { "/v1/traces": "traces", "/v1/logs": "logs", "/v1/metrics": "metrics" };

function keyFrom(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim();
}

/** OTLP/HTTP, JSON and protobuf, gzip accepted. The same paths and auth header HyperDX used, so cutover only changes the endpoint and the key. */
export async function handleIngest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const signal = PATHS[url.pathname];
  if (!signal) return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let environment: string | undefined;
  if (config.ingest.requireKey) {
    const token = verifyToken(keyFrom(request), ["ingest"]);
    if (!token) {
      ingestStats.rejected++;
      return Response.json({ code: 16, message: "Invalid ingest key" }, { status: 401 });
    }
    environment = token.environment ?? undefined;
  }

  try {
    const { payload, protobuf } = await decodeBody(request, signal);
    accept(signal, payload, environment);
    if (protobuf) return new Response(new Uint8Array(0), { headers: { "content-type": "application/x-protobuf" } });
    return Response.json({ partialSuccess: {} });
  } catch (error) {
    if (error instanceof Backpressure) {
      return Response.json({ code: 8, message: "Queue full" }, { status: 429, headers: { "retry-after": "5" } });
    }
    ingestStats.rejected++;
    return Response.json({ code: 3, message: `Could not read this payload: ${String(error).slice(0, 200)}` }, { status: 400 });
  }
}
