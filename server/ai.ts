import { chat, maxIterations, toolDefinition, toServerSentEventsResponse } from "@tanstack/ai";
import { createOpenaiChatCompletions } from "@tanstack/ai-openai";
import { config } from "./config.ts";
import { HttpError, route } from "./api/http.ts";
import { toolsFor } from "./mcp.ts";
import { readEvent } from "./api/logs.ts";
import { readTrace } from "./api/traces.ts";
import { explainError, eventAsText } from "./extensions/index.ts";
import { CONSOLE_TABLES } from "./api/metrics.ts";

const enabled = () => Boolean(config.ai.apiKey);

function adapter() {
  if (!enabled()) throw new HttpError(409, "AI is off. Set VIGIE_AI_API_KEY to turn it on.");
  return createOpenaiChatCompletions(config.ai.model as any, config.ai.apiKey, config.ai.baseUrl ? { baseURL: config.ai.baseUrl } : {});
}

const SYSTEM = `You are Vigie, the assistant inside a self-hosted telemetry tool for an Adonis app called ${config.appName}.
Answer from the tools, never from memory. Cite trace ids, task ids and exact numbers.
Lead with the conclusion in one sentence, then the evidence. Be brief. Plain words. No filler.
When you mention an entity, link it as markdown: [trace](/traces/<id>), [task](/tasks/run/<id>), [issue](/issues/<fingerprint>).
Tables for run_query: ${Object.entries(CONSOLE_TABLES).map(([t, c]) => `${t}(${c.join(", ")})`).join("; ")}.`;

export const aiStatus = () => ({ enabled: enabled(), model: enabled() ? config.ai.model : null });

/** Ask Vigie: every read-only MCP tool is available to the model, under the person's own role. */
route("POST", "/api/ai/chat", "viewer", async ({ actor, request }) => {
  const input = (await request.json()) as { threadId?: string; messages: unknown; forwardedProps?: { context?: string } };
  const tools = toolsFor(actor)
    .filter((tool) => tool.scope === "read")
    .map((tool) =>
      toolDefinition({ name: tool.name, description: tool.description, inputSchema: tool.input as any }).server(async (args: any) => {
        try {
          return JSON.stringify(await tool.run(args ?? {}, actor)).slice(0, 24_000);
        } catch (error) {
          return `This tool failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }),
    );
  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => abortController.abort());
  const context = input.forwardedProps?.context ? `\nThe person is looking at: ${String(input.forwardedProps.context).slice(0, 4000)}` : "";
  const stream = chat({
    adapter: adapter(),
    threadId: input.threadId || crypto.randomUUID(),
    messages: input.messages,
    systemPrompts: [SYSTEM + context],
    tools,
    agentLoopStrategy: maxIterations(8),
    abortController,
  } as any);
  return toServerSentEventsResponse(stream as any, { abortController });
});

async function completeOnce(system: string, user: string) {
  const stream = chat({ adapter: adapter(), threadId: crypto.randomUUID(), messages: [{ role: "user", content: user }], systemPrompts: [system] } as any);
  let text = "";
  for await (const chunk of stream as any) {
    if (chunk.type === "TEXT_MESSAGE_CONTENT") text += chunk.delta ?? "";
    else if (chunk.type === "content" && chunk.delta) text += chunk.delta;
    else if (chunk.type === "RUN_ERROR" || chunk.type === "error") throw new HttpError(502, chunk.message ?? chunk.error?.message ?? "The model failed.");
  }
  return text.trim();
}

/** "failed payment calls from yesterday" → the search bar's own syntax. */
export async function aiFilter({ text, fields }: { text: string; fields: string[] }) {
  const q = await completeOnce(
    `Turn a request into a Vigie log search. Syntax: free text, plus field filters: status>=500, level=error, route.pattern^/v1, task.kind=emails.send, outcome=failed, durationMs>800. Field names you can use: ${fields.slice(0, 80).join(", ")}. Answer with the search only, nothing else.`,
    text,
  );
  return { q: q.replace(/^`+|`+$/g, "") };
}

/** One paragraph on one event or trace. */
export async function aiExplain(input: { eventId?: string; traceId?: string }) {
  let material = "";
  if (input.eventId) {
    const event = await readEvent(input.eventId);
    const error = explainError(event.attrs);
    material = JSON.stringify({ body: event.body, attrs: event.attrs, explained: error, renderers: eventAsText(event.attrs) });
  } else if (input.traceId) {
    const trace = await readTrace(input.traceId);
    material = JSON.stringify({ spans: trace.spans.slice(0, 120).map((s: any) => ({ name: s.name, ms: s.duration, status: s.status, parent: s.parent, id: s.id, statement: s.statement?.slice(0, 200), peer: s.peer, message: s.message })), logs: trace.logs.slice(0, 40) });
  } else throw new HttpError(400, "Say which event or trace.");
  return { text: await completeOnce("Explain what happened in this telemetry, in at most four short sentences, for the developer who owns the app. Say the cause first, then what to do. Use exact names and numbers. No preamble.", material.slice(0, 30_000)) };
}
