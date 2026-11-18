// The whole sign-in story on a server-mode Vigie with no users yet.
// usage: node test/e2e/auth.mjs <screenshots-dir> <VIGIE_DATA_DIR> [base-url]
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [dir, data, base = "http://localhost:14410"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome" });
const results = [];
const check = async (name, run) => {
  try {
    await run();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${String(error).split("\n")[0].slice(0, 170)}`);
  }
};
const base32 = (text) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of text.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
};
const totp = (secret) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac("sha1", base32(secret)).update(counter).digest();
  return String((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 1000000).padStart(6, "0");
};
const size = { viewport: { width: 1440, height: 900 } };
const session = async (page) => (await (await page.request.get(`${base}/api/session`)).json()).actor;
const away = (url) => !url.pathname.startsWith("/login");

const ownerContext = await browser.newContext(size);
const owner = await ownerContext.newPage();
const errors = [];
owner.on("pageerror", (error) => errors.push(String(error).slice(0, 150)));
const code = readFileSync(`${data}/setup-code`, "utf8").trim();
const email = "owner@acme.test";
const password = "correct-horse-battery";
let link = "";

await check("anonymous is sent to login", async () => {
  await owner.goto(`${base}/`);
  await owner.waitForURL(/login/, { timeout: 8000 });
});
await check("a wrong setup code is refused", async () => {
  await owner.getByLabel("Setup code").fill("nope");
  await owner.getByLabel("Your name").fill("Owner");
  await owner.getByLabel("Email").fill(email);
  await owner.getByLabel("Password").fill(password);
  await owner.getByRole("button", { name: "Create and continue" }).click();
  await owner.getByRole("alert").waitFor({ timeout: 4000 });
});
await check("the owner is created with the setup code", async () => {
  await owner.getByLabel("Setup code").fill(code);
  await owner.getByRole("button", { name: "Create and continue" }).click();
  await owner.waitForURL(away, { timeout: 8000 });
});
await check("the owner creates an invitation", async () => {
  await owner.goto(`${base}/settings/members`);
  await owner.getByRole("button", { name: "Create link" }).waitFor({ timeout: 6000 });
  await owner.getByLabel("Email").fill("marie@acme.test");
  await owner.getByRole("button", { name: "Create link" }).click();
  await owner.getByText("Send this link yourself").waitFor({ timeout: 4000 });
  link = await owner.locator(".stmt b").first().innerText();
  await owner.screenshot({ path: `${dir}/members.png` });
});

const memberContext = await browser.newContext(size);
const member = await memberContext.newPage();
await check("sign-up without an invitation is closed", async () => {
  const response = await member.request.post(`${base}/api/auth/sign-up/email`, { headers: { origin: base }, data: { name: "x", email: "x@x.test", password: "long-enough-password" } });
  if (response.status() < 400) throw new Error(`answered ${response.status()}`);
});
await check("an invitation for another address is refused", async () => {
  const invite = new URL(link).searchParams.get("invite");
  const response = await member.request.post(`${base}/api/auth/sign-up/email`, { headers: { origin: base, "x-vigie-invite": invite }, data: { name: "x", email: "other@x.test", password: "long-enough-password" } });
  if (response.status() < 400) throw new Error(`answered ${response.status()}`);
});
await check("the invited person joins with the role they were given", async () => {
  // Sign-up allows 3 tries per 10 seconds, and the checks above used them.
  await member.waitForTimeout(11000);
  await member.goto(link);
  await member.getByText("You were invited as marie@acme.test").waitFor({ timeout: 6000 });
  await member.screenshot({ path: `${dir}/join.png` });
  await member.getByLabel("Your name").fill("Marie");
  await member.getByLabel("Password").fill("marie-long-password");
  await member.getByRole("button", { name: "Create my account" }).click();
  await member.waitForURL(away, { timeout: 8000 });
  const actor = await session(member);
  if (actor?.role !== "operator") throw new Error(`role ${actor?.role}`);
});
await check("a used invitation stops working", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  await page.getByText(/expired or was already used/).waitFor({ timeout: 5000 });
  await context.close();
});
await check("an operator cannot reach member settings", async () => {
  await member.goto(`${base}/settings/members`);
  await member.waitForTimeout(1500);
  if (await member.getByRole("button", { name: "Create link" }).count()) throw new Error("the invitation form is visible");
});
await check("the last owner cannot be removed", async () => {
  await owner.goto(`${base}/settings/members`);
  const row = owner.locator(".lst", { hasText: email });
  await row.getByRole("button", { name: "Remove" }).click();
  await owner.locator(".dlg button.danger").click();
  await owner.getByText("Vigie needs at least one owner").first().waitFor({ timeout: 3000 });
  await owner.locator(".dlg").getByRole("button", { name: "Cancel" }).click();
  await owner.waitForTimeout(300);
});
await check("two-factor turns on and is then required to sign in", async () => {
  await owner.getByLabel("Current password").fill(password);
  await owner.getByRole("button", { name: "Turn on two-factor sign-in" }).click();
  await owner.locator('[aria-label="Two-factor QR code"] svg').waitFor({ timeout: 5000 });
  await owner.screenshot({ path: `${dir}/twofactor.png` });
  const uri = await owner.evaluate(async (pw) => (await (await fetch("/api/auth/two-factor/get-totp-uri", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) })).json()).totpURI, password);
  const secret = new URL(uri).searchParams.get("secret");
  await owner.getByLabel("Code from your app").fill(totp(secret));
  await owner.getByRole("button", { name: "Confirm" }).click();
  await owner.getByText("Keep these backup codes").waitFor({ timeout: 5000 });
  const context = await browser.newContext(size);
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("6-digit code").waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${dir}/code.png` });
  if (await session(page)) throw new Error("signed in before the code");
  await page.getByLabel("6-digit code").fill("000000");
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("alert").waitFor({ timeout: 4000 });
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.waitForURL(away, { timeout: 6000 });
  await context.close();
});
await check("removing a member signs them out at once", async () => {
  await owner.goto(`${base}/settings/members`);
  await owner.locator(".lst", { hasText: "marie@acme.test" }).getByRole("button", { name: "Remove" }).click();
  await owner.locator(".dlg button.danger").click();
  await owner.waitForTimeout(1200);
  if (await session(member)) throw new Error("still signed in");
});
await check("bulk actions point to Acme", async () => {
  await owner.goto(`${base}/tasks/bulk`);
  await owner.getByText("Bulk actions run in Acme").waitFor({ timeout: 6000 });
  await owner.screenshot({ path: `${dir}/bulk.png` });
});
console.log(results.join("\n"));
console.log("page errors", JSON.stringify(errors));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
