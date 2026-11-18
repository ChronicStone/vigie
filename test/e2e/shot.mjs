// One screenshot of a running page, and any console error it raised.
// usage: node test/e2e/shot.mjs <out.png> <path> [--port 5310] [--w 1440] [--h 900] [--click "<selector>"] [--hover "<selector>"] [--full]
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string", default: "5310" }, w: { type: "string", default: "1440" }, h: { type: "string", default: "900" }, click: { type: "string", multiple: true, default: [] }, hover: { type: "string" }, full: { type: "boolean", default: false } },
});
const [out, path] = positionals;
if (!out || !path) {
  console.error("usage: node test/e2e/shot.mjs <out.png> <path> [--port 5310] [--w 1440] [--h 900] [--click selector] [--hover selector] [--full]");
  process.exit(64);
}
mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: Number(values.w), height: Number(values.h) } });
const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error).slice(0, 300)}`));
page.on("console", (message) => {
  if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(`console: ${message.text().slice(0, 300)}`);
});
const settle = async () => {
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(500);
};
await page.goto(`http://localhost:${values.port}${path}`, { waitUntil: "domcontentloaded" });
await settle();
for (const selector of values.click) {
  await page.locator(selector).first().click({ timeout: 5000 }).catch((error) => errors.push(`click ${selector}: ${String(error).slice(0, 160)}`));
  await settle();
}
if (values.hover) {
  await page.locator(values.hover).first().hover({ timeout: 5000 }).catch((error) => errors.push(`hover: ${String(error).slice(0, 160)}`));
  await page.waitForTimeout(350);
}
await page.screenshot({ path: out, fullPage: values.full });
await browser.close();
console.log(out);
console.log(errors.length ? errors.join("\n") : "no console errors");
process.exit(errors.length ? 1 : 0);
