// Measures what the eye catches: controls side by side of different heights, and contents off-centre inside them.
// usage: node test/e2e/align.mjs <base-url> [range]   Exits 1 when anything is off.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:4310";
const R = `range=${process.argv[3] ?? "24h"}`;
const lists = ["/", "/logs", "/traces", "/metrics", "/console", "/database", "/requests", "/queries", "/external", "/emails", "/cache", "/commands", "/runtime", "/services", "/map", "/ai", "/tasks", "/tasks/all", "/workers", "/schedules", "/processes", "/issues", "/alerts", "/alerts/new", "/slos", "/uptime", "/rules", "/releases", "/users", "/accounts", "/apikeys", "/dashboards", "/inbox", "/settings/services", "/settings/retention", "/settings/channels", "/settings/access", "/settings/tokens"];
const details = [["/requests", "tbody tr"], ["/queries", "tbody tr"], ["/external", "tbody tr"], ["/tasks", "tbody tr"], ["/tasks/all", "tbody tr"], ["/alerts", "a[data-row]"],["/processes", "tbody tr"], ["/users", ".home-who"], ["/dashboards", ".dcard"], ["/issues", "a[data-row]"],["/logs", ".lrow"]];

const audit = () => {
  const CONTROL = "button, a.btn, a.ib, a.lnk.btn, input:not([type=checkbox]):not([type=radio]), select, textarea, .sb, .finp, .qbar, .seg, .lvls, .fchip, .input";
  const OUTER = "button, a.btn, a.ib, .sb, .finp, .qbar, .seg, .lvls, .fchip, .input, input.input";
  const visible = (el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const name = (el) => `${el.tagName.toLowerCase()}${el.classList.length ? "." + [...el.classList].filter((c) => !/^(on|act|grow|go|pick)$/.test(c)).join(".") : ""}`;
  const out = [];
  // 1. Controls side by side in one row share a height and a centre line.
  const rows = new Set();
  for (const el of document.querySelectorAll(OUTER)) {
    if (el.closest(".seg, .lvls, .qbar, .sb, .finp, .ptabs, .nlist, .tbl, .cmdb, svg") && !el.matches(".seg, .lvls, .qbar, .sb, .finp")) continue;
    if (el.parentElement) rows.add(el.parentElement);
  }
  for (const row of rows) {
    const items = [...row.children].filter((c) => c.matches(OUTER) && visible(c));
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1].getBoundingClientRect();
      const b = items[i].getBoundingClientRect();
      if (a.bottom <= b.top || b.bottom <= a.top) continue;
      if (Math.abs(a.height - b.height) > 0.5) out.push(`height ${Math.round(a.height)} vs ${Math.round(b.height)}: ${name(items[i - 1])} next to ${name(items[i])}`);
      else if (Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) > 0.5) out.push(`centre off: ${name(items[i - 1])} next to ${name(items[i])}`);
    }
  }
  // 2. What is inside a control sits on its centre line.
  for (const el of document.querySelectorAll("button, a.btn, a.ib, .sb, .finp, .qbar, .fchip, .kbd")) {
    if (!visible(el) || el.closest(".tbl tbody")) continue;
    const box = el.getBoundingClientRect();
    if (box.height > 44) continue;
    const centre = box.top + box.height / 2;
    // Stacked lines count as one block: the block is what sits on the centre line.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let low = Infinity, high = -Infinity, sample = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || node.parentElement.closest(".kbd") !== (el.matches(".kbd") ? el : null)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (!r.height) continue;
      low = Math.min(low, r.top); high = Math.max(high, r.bottom); sample ||= node.textContent.trim().slice(0, 18);
    }
    if (sample && Math.abs((low + high) / 2 - centre) > 1.25) out.push(`text off-centre by ${((low + high) / 2 - centre).toFixed(1)}: "${sample}" in ${name(el)}`);
    for (const child of el.querySelectorAll(":scope > svg, :scope > .kbd, :scope > button, :scope > input")) {
      if (!visible(child)) continue;
      const r = child.getBoundingClientRect();
      if (Math.abs(r.top + r.height / 2 - centre) > 1.25) out.push(`${child.tagName.toLowerCase()}${child.className && typeof child.className === "string" ? "." + child.className : ""} off-centre by ${(r.top + r.height / 2 - centre).toFixed(1)} in ${name(el)}`);
    }
  }
  // 3. Things that clip what they hold.
  for (const el of document.querySelectorAll(CONTROL)) {
    if (!visible(el) || el.matches("textarea, input, .seg, .lvls") || el.closest(".lvls")) continue;
    if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && getComputedStyle(el).overflowY !== "visible") out.push(`clips its content: ${name(el)}`);
  }
  // 4. In a row, the icon and the text share a centre line, and so do the texts beside each other.
  const textBox = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let low = Infinity, high = -Infinity;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.height) { low = Math.min(low, r.top); high = Math.max(high, r.bottom); }
    }
    return low === Infinity ? null : (low + high) / 2;
  };
  for (const row of document.querySelectorAll(".ni, .lst, .dh, .ch, .subbar, .top, .ol, .kvr, .lnn, .phead, .rdh, .ph3, .kbar, .budget .nm, .row")) {
    if (!visible(row) || getComputedStyle(row).display.indexOf("flex") < 0 || getComputedStyle(row).alignItems !== "center") continue;
    const kids = [...row.children].filter(visible);
    const centres = kids.map((kid) => ({ kid, y: kid.matches("svg, i") ? kid.getBoundingClientRect().top + kid.getBoundingClientRect().height / 2 : textBox(kid) })).filter((k) => k.y !== null);
    for (let i = 1; i < centres.length; i++) {
      if (Math.abs(centres[i].y - centres[i - 1].y) > 1.75) out.push(`row off by ${(centres[i].y - centres[i - 1].y).toFixed(1)}: ${name(centres[i - 1].kid)} beside ${name(centres[i].kid)} in ${name(row)}`);
    }
  }
  // 5. Sections start on one left edge inside the panel.
  const main = document.querySelector(".main")?.getBoundingClientRect();
  if (main) {
    for (const el of document.querySelectorAll(".ov > .card > .ch, .ov > .subbar, .ov > .dh, .ov > .mband, .ov > .card > .cb, .ov > .card > .lst, .ov > .tbl td:first-child, .ov > .tbl th:first-child, .ov > .lns .lnr, .ov > .card .tbl td:first-child")) {
      if (!visible(el)) continue;
      const pad = parseFloat(getComputedStyle(el).paddingLeft) + el.getBoundingClientRect().left - main.left - 1;
      if (Math.abs(pad - 20) > 1) out.push(`left edge ${Math.round(pad)} not 20: ${name(el)}`);
    }
  }
  // 6. A number column's header ends where its numbers end.
  for (const table of document.querySelectorAll(".tbl table")) {
    if (!visible(table)) continue;
    const row = table.querySelector("tbody tr:not([aria-hidden])");
    if (!row) continue;
    const heads = table.querySelectorAll("thead th");
    [...row.children].forEach((td, i) => {
      const th = heads[i];
      if (!th || !th.classList.contains("num") || !td.textContent.trim()) return;
      const place = (el) => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect().right; };
      const label = th.querySelector("button") ?? th;
      const inner = [...label.childNodes].find((n) => n.nodeType === 3) ?? label;
      const range = document.createRange(); range.selectNodeContents(inner);
      const headRight = range.getBoundingClientRect().right;
      if (Math.abs(headRight - place(td)) > 1.5) out.push(`column "${th.textContent.trim()}" header ends ${(headRight - place(td)).toFixed(1)} from its numbers`);
    });
  }
  // 7. Anything you can click settles softly. A hard requirement, not a nicety.
  for (const el of document.querySelectorAll("a, button, summary, tr.click td, .lst, input:not([type=checkbox]):not([type=radio]), textarea")) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const moves = s.transitionDuration.split(",").some((d) => parseFloat(d) > 0) && s.transitionProperty !== "none";
    if (!moves) out.push(`no transition: ${name(el)}`);
    if (s.transitionProperty.split(",").some((p) => p.trim() === "all")) out.push(`transition all: ${name(el)}`);
  }
  return [...new Set(out)];
};

// ALIGN_ONLY=/logs,/traces limits the run to those pages and their detail views.
const only = process.env.ALIGN_ONLY?.split(",");
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const found = new Map();
const note = (where, items) => { for (const item of items) found.set(item, [...(found.get(item) ?? []), where]); };
for (const path of lists) {
  if (only && !only.includes(path)) continue;
  await page.goto(`${base}${path}?${R}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(350);
  note(path, await page.evaluate(audit));
}
for (const [path, selector] of details) {
  if (only && !only.includes(path)) continue;
  await page.goto(`${base}${path}?${R}`, { waitUntil: "domcontentloaded" });
  const row = page.locator(selector).first();
  if (!(await row.waitFor({ timeout: 5000 }).then(() => true).catch(() => false))) continue;
  await row.click({ timeout: 3000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(450);
  note(`${path} detail`, await page.evaluate(audit));
}
await browser.close();
const sorted = [...found.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [item, where] of sorted) console.log(`${String(where.length).padStart(3)}  ${item}   ${where.slice(0, 3).join(" ")}`);
console.log(sorted.length ? `${sorted.length} alignment problems` : "aligned");
process.exit(sorted.length ? 1 : 0);
