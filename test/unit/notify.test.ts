import { expect, test } from "bun:test";
import { moveRedisStatement } from "../../server/ingest/pipeline.ts";
import { frameLocation } from "../../server/lib/source.ts";
import { discordMessage, emailMessage, escapeSlack, humanDuration, humanWindow, slackMessage, slackTime, sparkline } from "../../server/notify.ts";

const firing = {
  tone: "firing" as const,
  title: "Parcelo is refusing calls",
  summary: "10 task attempts failed in the last 15 min. Limit is 10.",
  fields: [{ label: "Since", at: Date.now() }, { label: "Environment", value: "Production" }],
  causes: [{ count: "8×", code: "PARCELO_UNAVAILABLE", where: "parcelo.ship" }],
  advice: "Tasks retry on their own.",
  trend: { values: [1, 1, 2, 4, 8], label: "last 2 hours" },
  links: [{ label: "Open alert", url: "https://vigie.test/alerts/a" }, { label: "Issue", url: "https://vigie.test/issues/i" }],
};

test("a firing post has a headline, facts, causes, advice, buttons and a trend, in a red bar", () => {
  const message = slackMessage(firing);
  const { color, blocks } = message.attachments[0]!;
  expect(color).toBe("#E5484D");
  expect(blocks.map((b: any) => b.type)).toEqual(["header", "section", "section", "section", "section", "actions", "context"]);
  expect(JSON.stringify(blocks)).toContain("PARCELO_UNAVAILABLE");
  expect((blocks[5] as any).elements[0].style).toBe("primary");
  expect((blocks[5] as any).elements[1].style).toBeUndefined();
  expect(message.text).toContain("Parcelo is refusing calls");
});

test("a recovery is one line in a green bar", () => {
  const { attachments } = slackMessage({ tone: "resolved", title: "Parcelo is answering again", summary: "after 15 min." });
  expect(attachments[0]!.color).toBe("#2EB67D");
  expect(attachments[0]!.blocks).toHaveLength(1);
});

test("no message carries raw csv, trace ids or a UTC range", () => {
  const body = JSON.stringify(slackMessage(firing));
  expect(body).not.toContain("Time Range");
  expect(body).not.toMatch(/[0-9a-f]{32}/);
});

test("text from the app cannot inject Slack markup", () => {
  expect(escapeSlack("<!channel> a&b")).toBe("&lt;!channel&gt; a&amp;b");
  const body = JSON.stringify(slackMessage({ tone: "info", title: "t", summary: "<!channel> look" }));
  expect(body).not.toContain("<!channel>");
});

test("the limits Slack enforces are respected", () => {
  const long = slackMessage({ ...firing, title: "x".repeat(300), links: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, url: "https://a.test" })) });
  const blocks = long.attachments[0]!.blocks as any[];
  expect(blocks[0].text.text.length).toBeLessThanOrEqual(150);
  expect(blocks.find((b) => b.type === "actions").elements.length).toBeLessThanOrEqual(5);
});

test("sparkline, durations and times read well", () => {
  expect(sparkline([0, 0, 0, 0])).toBe("▁▁▁▁");
  expect(sparkline([1, 2, 4, 8])).toEndWith("█");
  expect(sparkline([1, 2])).toBe("");
  expect(humanWindow("15m")).toBe("15 min");
  expect(humanDuration(95 * 60_000)).toBe("1 h 35 min");
  expect(slackTime(1_793_572_200_000)).toContain("<!date^1793572200^");
});

test("Discord and e-mail say the same thing, safely", () => {
  const { embeds, allowed_mentions } = discordMessage({ ...firing, summary: "@everyone look" });
  expect(allowed_mentions.parse).toEqual([]);
  expect(embeds[0]!.color).toBe(0xe5484d);
  expect(embeds[0]!.fields[0]!.value).toMatch(/^<t:\d+:t>$/);
  expect(embeds[0]!.description).toContain("[Open alert](https://vigie.test/alerts/a)");
  const mail = emailMessage({ ...firing, summary: "<script>alert(1)</script>" });
  expect(mail.html).not.toContain("<script>");
  expect(mail.html).toContain("&lt;script&gt;");
  expect(mail.subject).toContain("Parcelo is refusing calls");
  expect(mail.text).toContain("Environment: Production");
  expect(mail.text).toContain("UTC");
});

test("a frame gives a repo path and line, and refuses to climb out", () => {
  expect(frameLocation("Error: x\n    at run (/app/apps/api/app/modules/paynest/result.handler.ts:41:20)\n    at node:internal/x:1:1")).toEqual({ path: "apps/api/app/modules/paynest/result.handler.ts", line: 41 });
  expect(frameLocation("Error: x\n    at file:///srv/app/modules/a.ts:7:3")).toEqual({ path: "app/modules/a.ts", line: 7 });
  expect(frameLocation("Error: x\n    at run (/app/node_modules/pg/index.js:1:1)")).toBeNull();
  expect(frameLocation("Error: x\n    at run (/app/../../etc/passwd:1:1)")).toBeNull();
});

test("a Redis command leaves the SQL statement fields", () => {
  const attributes: Record<string, string> = { "db.system": "redis", "db.statement": "get limiter:1" };
  moveRedisStatement(attributes);
  expect(attributes["redis.command"]).toBe("get limiter:1");
  expect(attributes["db.statement"]).toBeUndefined();
  const sql: Record<string, string> = { "db.system": "postgresql", "db.statement": "select 1" };
  moveRedisStatement(sql);
  expect(sql["db.statement"]).toBe("select 1");
});
