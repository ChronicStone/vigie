/** What a notification says, with no idea where it goes. Each channel turns it into its own format. */
export type Notice = {
  tone: "firing" | "warning" | "resolved" | "info";
  title: string;
  summary: string;
  /** A field is text, or a moment each channel shows in its own way. */
  fields?: { label: string; value?: string; at?: number }[];
  causes?: { count: string; code: string; where: string }[];
  advice?: string;
  trend?: { values: number[]; label: string };
  links?: { label: string; url: string }[];
};

const LOOK = {
  firing: { color: "#E5484D", mark: "🔴" },
  warning: { color: "#F2C744", mark: "🟡" },
  resolved: { color: "#2EB67D", mark: "✅" },
  info: { color: "#8A8A8F", mark: "🔵" },
} as const;

/** Slack reads these three characters as markup, so anything from the app must escape them. */
export const escapeSlack = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A time Slack shows in each reader's own timezone. The fallback is only for clients that cannot. */
export const slackTime = (ms: number) => {
  const sameDay = Date.now() - ms < 12 * 3_600_000;
  return `<!date^${Math.floor(ms / 1000)}^${sameDay ? "{time}" : "{date_short} {time}"}|${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC>`;
};

export function sparkline(values: number[], width = 12) {
  if (values.length < 3) return "";
  const size = Math.ceil(values.length / width);
  const buckets: number[] = [];
  for (let i = 0; i < values.length; i += size) buckets.push(Math.max(...values.slice(i, i + size)));
  const max = Math.max(...buckets);
  if (max <= 0) return "▁".repeat(buckets.length);
  const bars = "▁▂▃▄▅▆▇█";
  return buckets.map((v) => bars[Math.min(7, Math.floor((v / max) * 7.999))]).join("");
}

/** Slack refuses the whole message if one text is over 3000 characters. */
const mrkdwn = (text: string) => ({ type: "mrkdwn", text: text.slice(0, 2900) });

/** One Block Kit message. A resolved notice stays one line: good news should not take up the channel. */
export function slackMessage(notice: Notice) {
  const look = LOOK[notice.tone];
  const text = escapeSlack(`${look.mark} ${notice.title}: ${notice.summary}`);
  if (notice.tone === "resolved") {
    return { text, attachments: [{ color: look.color, blocks: [{ type: "section", text: mrkdwn(`✅ *${escapeSlack(notice.title)}* ${escapeSlack(notice.summary)}`) }] }] };
  }
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: `${look.mark} ${notice.title}`.slice(0, 150), emoji: true } },
    { type: "section", text: mrkdwn(escapeSlack(notice.summary)) },
  ];
  if (notice.fields?.length) blocks.push({ type: "section", fields: notice.fields.slice(0, 10).map((field) => mrkdwn(`*${escapeSlack(field.label)}*\n${field.at ? slackTime(field.at) : escapeSlack(field.value ?? "")}`)) });
  if (notice.causes?.length) blocks.push({ type: "section", text: mrkdwn(notice.causes.map((cause) => `*${escapeSlack(cause.count)}*  \`${escapeSlack(cause.code)}\` on *${escapeSlack(cause.where)}*`).join("\n")) });
  if (notice.advice) blocks.push({ type: "section", text: mrkdwn(`*What to do:* ${escapeSlack(notice.advice)}`) });
  if (notice.links?.length) {
    blocks.push({
      type: "actions",
      elements: notice.links.slice(0, 5).map((link, index) => ({ type: "button", text: { type: "plain_text", text: link.label.slice(0, 75) }, url: link.url, ...(index === 0 ? { style: "primary" } : {}) })),
    });
  }
  const line = notice.trend ? sparkline(notice.trend.values) : "";
  if (line) blocks.push({ type: "context", elements: [mrkdwn(`${line}  ${escapeSlack(notice.trend!.label)}`)] });
  return { text, attachments: [{ color: look.color, blocks }] };
}

const COLOR_NUMBER = { firing: 0xe5484d, warning: 0xf2c744, resolved: 0x2eb67d, info: 0x8a8a8f } as const;
const asText = (field: NonNullable<Notice["fields"]>[number]) => (field.at ? new Date(field.at).toISOString().slice(0, 16).replace("T", " ") + " UTC" : (field.value ?? ""));

/** Discord reads markdown and would act on mentions, so they are switched off for the whole message. */
export function discordMessage(notice: Notice) {
  const look = LOOK[notice.tone];
  const description = [notice.summary, ...(notice.causes ?? []).map((cause) => `**${cause.count}** \`${cause.code}\` on **${cause.where}**`), notice.advice ? `**What to do:** ${notice.advice}` : "", ...(notice.links?.length ? [notice.links.map((link) => `[${link.label}](${link.url})`).join(" · ")] : [])].filter(Boolean).join("\n\n");
  return {
    allowed_mentions: { parse: [] as string[] },
    embeds: [{
      title: `${look.mark} ${notice.title}`.slice(0, 256),
      description: description.slice(0, 4000),
      color: COLOR_NUMBER[notice.tone],
      fields: (notice.fields ?? []).slice(0, 10).map((field) => ({ name: field.label, value: field.at ? `<t:${Math.floor(field.at / 1000)}:t>` : (field.value || "-"), inline: true })),
    }],
  };
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A plain, light e-mail that reads the same in every client. */
export function emailMessage(notice: Notice) {
  const look = LOOK[notice.tone];
  const text = [notice.title, "", notice.summary, ...(notice.fields ?? []).map((field) => `${field.label}: ${asText(field)}`), ...(notice.causes ?? []).map((cause) => `${cause.count} ${cause.code} on ${cause.where}`), notice.advice ? `What to do: ${notice.advice}` : "", ...(notice.links ?? []).map((link) => `${link.label}: ${link.url}`)].filter((line, index) => line || index === 1).join("\n");
  const row = (content: string) => `<tr><td style="padding:0 0 12px;font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#2a2a2e">${content}</td></tr>`;
  const html = `<table role="presentation" width="100%" style="max-width:560px;border-left:4px solid ${look.color};padding-left:16px"><tbody>${[
    `<strong style="font-size:17px;color:#111">${escapeHtml(notice.title)}</strong>`,
    escapeHtml(notice.summary),
    ...(notice.fields?.length ? [notice.fields.map((field) => `<strong>${escapeHtml(field.label)}:</strong> ${escapeHtml(asText(field))}`).join("<br>")] : []),
    ...(notice.causes?.length ? [notice.causes.map((cause) => `<strong>${escapeHtml(cause.count)}</strong> <code>${escapeHtml(cause.code)}</code> on <strong>${escapeHtml(cause.where)}</strong>`).join("<br>")] : []),
    ...(notice.advice ? [`<strong>What to do:</strong> ${escapeHtml(notice.advice)}`] : []),
    ...(notice.links?.length ? [notice.links.map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`).join(" &nbsp;·&nbsp; ")] : []),
  ].map(row).join("")}</tbody></table>`;
  return { subject: `${look.mark} ${notice.title}`.slice(0, 180), text, html };
}

/** Plain text, for logs, the inbox and code channels. */
export const noticeText = (notice: Notice) => [notice.summary, ...(notice.fields ?? []).map((field) => `${field.label}: ${asText(field)}`), ...(notice.causes ?? []).map((cause) => `${cause.count} ${cause.code} on ${cause.where}`), notice.advice ? `What to do: ${notice.advice}` : ""].filter(Boolean).join("\n");

export const humanWindow = (window: string) => {
  const match = window?.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return window;
  return `${match[1]} ${{ s: "s", m: "min", h: "h", d: match[1] === "1" ? "day" : "days" }[match[2] as "s"]}`;
};

export const humanDuration = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
};
