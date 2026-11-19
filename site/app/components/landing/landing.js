// The landing's motion and demos, ported as is from the hand-written page.
// mountLanding(root) starts everything inside root and returns a function that stops it all.
export function mountLanding(root) {
const ac = new AbortController(), timers = new Set(), observers = [];
let dead = false;
// Window listeners, timers, frames and observers are tracked so leaving the page stops them.
const addEventListener = (type, fn, opts) => window.addEventListener(type, fn, { ...(typeof opts === "object" ? opts : {}), signal: ac.signal });
const setInterval = (fn, ms) => { const id = window.setInterval(fn, ms); timers.add(id); return id; };
const requestAnimationFrame = (fn) => (dead ? 0 : window.requestAnimationFrame(fn));
const IntersectionObserver = class extends window.IntersectionObserver { constructor(...a) { super(...a); observers.push(this); } };

const $ = (s, r = root) => r.querySelector(s);
const $$ = (s, r = root) => [...r.querySelectorAll(s)];
/* Canvas gets plain rgb(): not every browser's canvas reads oklch() yet. */
function toRGB(v) {
  const m = /^oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(v);
  if (!m) return v;
  const L = +m[1] / (m[1].includes(".") && +m[1] <= 1 && !v.includes("%") ? 1 : 100), Cc = +m[2], h = +m[3] * Math.PI / 180, al = m[4] == null ? 1 : +m[4];
  const A = Cc * Math.cos(h), B = Cc * Math.sin(h);
  const l = (L + .3963377774 * A + .2158037573 * B) ** 3, mm = (L - .1055613458 * A - .0638541728 * B) ** 3, ss = (L - .0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * mm + .2309699292 * ss, -1.2684380046 * l + 2.6097574011 * mm - .3413193965 * ss, -.0041960863 * l - .7034186147 * mm + 1.707614701 * ss];
  const [r, g, bb] = lin.map((c) => { c = Math.max(0, Math.min(1, c)); return Math.round(255 * (c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055)); });
  return `rgba(${r},${g},${bb},${al})`;
}
const css = (n) => toRGB(getComputedStyle(root).getPropertyValue(n).trim());
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const stateName = (location.hash.slice(1).split("&")[0] || "");
const deep = stateName.length > 0;
if (deep) root.classList.add("instant");

/* ---------------- Pixels: one grid, one dither, used by every picture on the page ---------------- */
/* Channel colours for the offscreen scene: each kind of light keeps its own channel. */
const CH = (r, g, b) => `rgb(${r},${g},${b})`;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + .5) / 16);
const bay = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];
const onScreen = (el, cb) => new IntersectionObserver(([e]) => cb(e.isIntersecting), { rootMargin: "120px" }).observe(el);

/* The lighthouse, as pixel art: r roof, g gallery, l glass, L the lamp, w white band, c coral band, d window, b rock. */
const TOWER = [
  "......r......", ".....rrr.....", "....rrrrr....", "...rrrrrrr...",
  "...g.lll.g...", "...g.lLl.g...", "...g.lll.g...", "..ggggggggg..", "..g.g.g.g.g..",
  "...wwwwwww...", "...wwwwwww...", "...ccccccc...", "...ccccccc...", "...wwwdwww...", "...wwwwwww...",
  "..ccccccccc..", "..ccccccccc..", "..wwwwdwwww..", "..wwwwwwwww..", "..ccccccccc..",
  ".ccccccccccc.", ".wwwwwdwwwww.", ".wwwwwdwwwww.",
].map((r) => "...." + r + "....").concat([
  "....bbbbbbbbbbbbbb...", "..bbbbbbbbbbbbbbbbbb.", "bbbbbbbbbbbbbbbbbbbbb",
]);
const TW = 21, LAMP = [10, 5];
function drawTower(ctx, C, sx, sy, t, pal, flash = 0) {
  const pulse = Math.min(1, .7 + .2 * Math.sin(t * 2.4) + flash);
  for (let y = 0; y < TOWER.length; y++) for (let x = 0; x < TW; x++) {
    const ch = TOWER[y][x]; if (!ch || ch === ".") continue;
    let col = pal[ch], a = 1;
    if (ch === "l") a = .4 + .25 * pulse + .35 * flash; if (ch === "L") a = pulse;
    if (ch === "b") a = (x + y) % 3 ? .9 : .6;
    ctx.globalAlpha = a; ctx.fillStyle = col;
    ctx.fillRect((sx + x) * C + .5, (sy + y) * C + .5, C - 1, C - 1);
    if (x > 10 && ch !== "l" && ch !== "L" && ch !== "b") { ctx.globalAlpha = .26; ctx.fillStyle = pal.shade; ctx.fillRect((sx + x) * C + .5, (sy + y) * C + .5, C - 1, C - 1); }
  }
  ctx.globalAlpha = 1;
}

/* ---------------- The watch: a dithered sea of telemetry, a lighthouse, and what its light finds ---------------- */
function Watch(canvas, o = {}) {
  const ctx = canvas.getContext("2d");
  const off = document.createElement("canvas"), oc = off.getContext("2d", { willReadFrequently: true });
  const N = o.lines || 30;
  const finds = o.finds || [];
  const pal = { r: css("--sun"), c: css("--sun"), w: css("--ink"), g: css("--ink-3"), d: css("--night-3"), l: css("--lamp"), L: css("--lamp"), b: css("--rock"), shade: css("--night") };
  const tone = { sea: css("--sea"), lamp: css("--lamp"), fault: css("--fault") };
  const seeds = Array.from({ length: N }, (_, i) => ({ a: Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1), b: Math.abs(Math.cos(i * 78.233) * 12543.123 % 1) }));
  let K = 9, C = 6, W = 0, H = 0, dpr = 1, cols = 0, rows = 0, horizon = 0, lx = 0, ly = 0, tsx = 0, tsy = 0;
  let theta = 2.2, pointer = null, raf = 0, running = false, stars = [], beamA = 1, flash = 0;
  const gch = (v) => CH(0, Math.round(v * beamA), 0);
  const spread = .08;

  function size() {
    dpr = Math.min(devicePixelRatio || 1, 2); W = canvas.clientWidth; H = canvas.clientHeight;
    C = W < 700 ? 5 : 6; K = o.k ?? (W < 700 ? 6 : 9);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(W / C); rows = Math.ceil(H / C); off.width = cols; off.height = rows;
    horizon = Math.round(H * (o.horizon ?? (W < 700 ? .8 : .64)) / C) * C;
    const tx = Math.round(W * (o.tower ?? (W < 700 ? .8 : .82)) / K);
    tsx = tx - 10; tsy = Math.round((horizon + K * 2) / K) - TOWER.length;
    lx = (tsx + LAMP[0] + .5) * K; ly = (tsy + LAMP[1] + .5) * K;
    stars = Array.from({ length: Math.round(W / 34) }, (_, i) => {
      const r1 = Math.abs(Math.sin(i * 91.7) * 1e4 % 1), r2 = Math.abs(Math.sin(i * 47.3) * 1e4 % 1);
      return { x: Math.floor(r1 * cols), y: Math.floor(r2 * (horizon / C - 8)) + 2, ph: r1 * 6, big: r2 > .8 };
    });
  }
  const lineY = (i) => horizon + (H - horizon + 40) * Math.pow((i + 1) / N, 1.6);
  const amp = (i) => 2 + 46 * Math.pow((i + 1) / N, 1.5);
  function height(i, x, t) {
    const s = seeds[i];
    let n = .5 + .22 * Math.sin(x * .011 + i * 1.7 + t * .55) + .16 * Math.sin(x * .023 - t * .8 + i * .6) + .12 * Math.sin(x * .0047 + t * .21 + s.a * 6);
    for (let k = 0; k < 2; k++) {
      const px = ((s.a + k * .47) * (W + 300) + t * (16 + 20 * s.b + k * 8)) % (W + 300) - 150;
      const d = (x - px) / (10 + 8 * k); n += (1 + s.b) * Math.exp(-d * d);
    }
    let h = amp(i) * n;
    for (const f of finds) if (f.line === i) { const d = (x - f.fx * W) / (7 + 5 * (i / N)); h += amp(i) * 3.2 * Math.exp(-d * d); }
    return h;
  }
  function path(c, i, t) {
    const y0 = lineY(i); c.beginPath(); c.moveTo(-10, y0 - height(i, -10, t));
    for (let x = -4; x <= W + 10; x += 6) c.lineTo(x, y0 - height(i, x, t));
  }
  function wedge(c, s) {
    const L = (W + H) * 2; c.beginPath(); c.moveTo(lx, ly);
    c.lineTo(lx + Math.cos(theta - s) * L, ly + Math.sin(theta - s) * L);
    c.lineTo(lx + Math.cos(theta + s) * L, ly + Math.sin(theta + s) * L); c.closePath();
  }
  /* Draw the scene small, one sample per cell, with each kind of light in its own channel: sea red, lamp green, fault blue. */
  function scene(t) {
    oc.setTransform(1 / C, 0, 0, 1 / C, 0, 0);
    oc.globalCompositeOperation = "source-over"; oc.fillStyle = CH(0, 0, 0); oc.fillRect(0, 0, W, H);
    for (let i = 0; i < N; i++) {
      const tt = (i + 1) / N; path(oc, i, t);
      oc.lineTo(W + 10, H + 10); oc.lineTo(-10, H + 10); oc.closePath(); oc.fillStyle = CH(0, 0, 0); oc.fill();
      path(oc, i, t); oc.lineWidth = C * (.55 + .45 * tt); oc.strokeStyle = `rgba(255,0,0,${.34 + .66 * tt})`; oc.stroke();
    }
    oc.globalCompositeOperation = "lighter";
    const g = oc.createLinearGradient(lx, ly, lx + Math.cos(theta) * H, ly + Math.sin(theta) * H);
    g.addColorStop(0, gch(90)); g.addColorStop(1, gch(8));
    wedge(oc, spread * 1.15); oc.fillStyle = g; oc.fill();
    const rg = oc.createLinearGradient(0, horizon, 0, H);
    rg.addColorStop(0, CH(0, 46, 0)); rg.addColorStop(1, CH(0, 0, 0));
    oc.fillStyle = rg; oc.fillRect(lx - K * 3, horizon + K * 2, K * 6, H);
    oc.save(); wedge(oc, spread); oc.clip(); oc.globalCompositeOperation = "source-over";
    for (let i = 0; i < N; i++) {
      const tt = (i + 1) / N; path(oc, i, t);
      oc.lineTo(W + 10, H + 10); oc.lineTo(-10, H + 10); oc.closePath(); oc.fillStyle = gch(40); oc.fill();
      path(oc, i, t); oc.lineWidth = C * (.5 + .5 * tt); oc.strokeStyle = gch(255); oc.stroke();
    }
    if (pointer && pointer.y > horizon) {
      oc.globalCompositeOperation = "lighter";
      const sg = oc.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 110);
      sg.addColorStop(0, CH(0, 110, 0)); sg.addColorStop(1, CH(0, 0, 0));
      oc.fillStyle = sg; oc.fillRect(pointer.x - 110, pointer.y - 110, 220, 220);
    }
    oc.restore();
    oc.globalCompositeOperation = "source-over";
    for (const f of finds) {
      const i = f.line, y0 = lineY(i), fx = f.fx * W; oc.beginPath();
      for (let x = fx - 24; x <= fx + 24; x += 3) x === fx - 24 ? oc.moveTo(x, y0 - height(i, x, t)) : oc.lineTo(x, y0 - height(i, x, t));
      oc.lineWidth = C * .9; oc.strokeStyle = f.lit ? CH(0, 0, 255) : CH(0, 0, 150); oc.stroke();
    }
  }
  const SZ = [0, .3, .46, .62, .8];
  const AL = { sea: [0, .38, .55, .75, .95], lamp: [0, .5, .72, .9, 1], fault: [0, .65, .85, 1, 1] };
  function pixels() {
    const d = oc.getImageData(0, 0, cols, rows).data;
    const B = { sea: [], lamp: [], fault: [] }; for (const k in B) for (let l = 0; l < 5; l++) B[k].push(new Path2D());
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const k = (y * cols + x) * 4, r = d[k], g = d[k + 1], b = d[k + 2];
      if (r + g + b < 8) continue;
      let cat, v;
      if (b > 30) { cat = "fault"; v = b; } else if (g > 14 && g >= r * .6) { cat = "lamp"; v = g; } else { cat = "sea"; v = r; }
      let l = (v / 255 * 4.2 + bay(x, y) - .5) | 0; if (l < 1) continue; if (l > 4) l = 4;
      const s = SZ[l] * C, p = (C - s) / 2; B[cat][l].rect(x * C + p, y * C + p, s, s);
    }
    for (const k in B) { ctx.fillStyle = tone[k]; for (let l = 1; l < 5; l++) { ctx.globalAlpha = AL[k][l]; ctx.fill(B[k][l]); } }
    ctx.globalAlpha = 1;
  }
  function frame(t) {
    ctx.clearRect(0, 0, W, H);
    // soft atmosphere under the pixels: the beam's haze and the lamp's halo
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    const hg = ctx.createLinearGradient(lx, ly, lx + Math.cos(theta) * H * .9, ly + Math.sin(theta) * H * .9);
    hg.addColorStop(0, `rgba(214,240,140,${(.16 * beamA).toFixed(3)})`); hg.addColorStop(1, "rgba(214,240,140,0)");
    wedge(ctx, spread * 1.6); ctx.fillStyle = hg; ctx.fill();
    const HR = 120 + 140 * flash, halo = ctx.createRadialGradient(lx, ly, 0, lx, ly, HR); halo.addColorStop(0, `rgba(214,240,140,${(.3 + .55 * flash).toFixed(3)})`); halo.addColorStop(1, "rgba(214,240,140,0)");
    ctx.fillStyle = halo; ctx.fillRect(lx - HR, ly - HR, HR * 2, HR * 2); ctx.restore();
    scene(t); pixels();
    // stars: pixel crosses that twinkle, brighter near the pointer
    for (const s of stars) {
      let a = .12 + .3 * (Math.sin(t * 1.3 + s.ph * 3) + 1) / 2;
      if (pointer) { const dd = Math.hypot(s.x * C - pointer.x, s.y * C - pointer.y); if (dd < 160) a += .5 * (1 - dd / 160); }
      ctx.globalAlpha = a; ctx.fillStyle = tone.sea; const q = C * .6, p = (C - q) / 2;
      ctx.fillRect(s.x * C + p, s.y * C + p, q, q);
      if (s.big) { for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) ctx.fillRect((s.x + dx) * C + C * .35, (s.y + dy) * C + C * .35, C * .3, C * .3); }
    }
    ctx.globalAlpha = 1;
    drawTower(ctx, K, tsx, tsy, t, pal, flash);
    // what the light finds
    for (const f of finds) {
      const fx = f.fx * W, fy = lineY(f.line) - height(f.line, fx, t);
      let dlt = Math.atan2(fy - ly, fx - lx) - theta; dlt = Math.atan2(Math.sin(dlt), Math.cos(dlt));
      const near = pointer && Math.hypot(fx - pointer.x, fy - pointer.y) < 90;
      f.lit = (beamA > .55 && Math.abs(dlt) < spread * .95) || near; f.x = fx; f.y = fy;
      if (f.found) {
        const col = f.tone === "warn" ? css("--warn") : f.tone === "ok" ? tone.lamp : tone.fault;
        const k = C, bx = Math.round(fx / k), by = Math.round(fy / k) - 4;
        ctx.globalAlpha = f.lit ? 1 : .7; ctx.fillStyle = col;
        for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1], [0, 0]]) ctx.fillRect((bx + dx) * k + .5, (by + dy) * k + .5, k - 1, k - 1);
        ctx.globalAlpha = 1;
      }
    }
    o.onFrame && o.onFrame(finds, t);
  }
  function aimAt(x, y) { return Math.atan2(y - ly, x - lx); }
  function tick(ms) {
    const t = ms / 1000;
    let want, k;
    if (pointer) { want = aimAt(pointer.x, Math.max(pointer.y, ly + 30)); k = .28; beamA += (1 - beamA) * .15; flash *= .9; }
    else {
      // a real lighthouse: the lens turns a full circle, the beam crosses the sea, dims behind the tower, and flashes as it faces you
      const ph = t * .55 + 2.2, front = Math.sin(ph), e = Math.max(0, Math.min(1, (front + .62) / .5));
      want = aimAt(W * (.5 - .64 * Math.cos(ph)), H * .9); k = .2;
      beamA += (e * e * (3 - 2 * e) - beamA) * .2; flash = Math.pow(Math.max(0, front), 14);
      if (beamA < .04) theta = want;
    }
    let d = want - theta; d = Math.atan2(Math.sin(d), Math.cos(d)); theta += d * k;
    frame(t); if (running) raf = requestAnimationFrame(tick);
  }
  size(); addEventListener("resize", () => { size(); if (!running) frame(o.stillTime ?? 4); });
  return {
    start() { if (running) return; if (reduce || o.still) { const t = o.stillTime ?? 4, f = finds[o.aim ?? 0]; theta = f ? aimAt(f.fx * W, lineY(f.line) - height(f.line, f.fx * W, t)) : aimAt(W * .4, H * .85); frame(t); return; } running = true; raf = requestAnimationFrame(tick); },
    stop() { running = false; cancelAnimationFrame(raf); },
    point(x, y) { pointer = { x, y }; }, release() { pointer = null; },
  };
}

/* ---------------- Ambient dithered glows, and the night dissolving into day ---------------- */
function Dither(canvas, cfg) {
  const ctx = canvas.getContext("2d"); const C = cfg.cell || 6;
  let W = 0, H = 0, cols = 0, rows = 0, running = false, raf = 0, last = 0;
  const colors = (cfg.blobs || []).map((b) => css(b.c)); const dcol = cfg.color ? css(cfg.color) : null;
  function size() { const dpr = Math.min(devicePixelRatio || 1, 2); W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); cols = Math.ceil(W / C); rows = Math.ceil(H / C); }
  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    if (cfg.mode === "dissolve") {
      const P = [null, new Path2D(), new Path2D(), new Path2D(), new Path2D()], S = [0, .38, .6, .84, 1.08];
      for (let y = 0; y < rows; y++) { const v0 = (y + .5) / rows; for (let x = 0; x < cols; x++) {
        const v = v0 + .05 * Math.sin(t * .7 + x * .35 + y * .2) * Math.sin(Math.PI * v0);
        let l = (v * 4.6 + bay(x, y) - .5) | 0; if (y >= rows - 2) l = 4; if (l < 1) continue; if (l > 4) l = 4;
        const s = S[l] * C, p = (C - s) / 2; P[l].rect(x * C + p, y * C + p, s, s);
      } }
      ctx.fillStyle = dcol; for (let l = 1; l < 5; l++) ctx.fill(P[l]);
    } else {
      const bl = cfg.blobs.map((b, i) => ({ x: (b.x + (b.dx ?? .03) * Math.sin(t * .17 + i * 2.1)) * W, y: (b.y + (b.dy ?? .03) * Math.cos(t * .13 + i)) * H, r: b.r * W, ry: (b.ry ?? b.r) * W, a: b.a }));
      const P = bl.map(() => [null, new Path2D(), new Path2D(), new Path2D(), new Path2D()]), S = [0, .26, .4, .56, .72];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const px = (x + .5) * C, py = (y + .5) * C; let best = 0, bi = -1;
        for (let i = 0; i < bl.length; i++) { const b = bl[i], dx = (px - b.x) / b.r, dy = (py - b.y) / b.ry, v = b.a * Math.exp(-(dx * dx + dy * dy) * 2.4); if (v > best) { best = v; bi = i; } }
        if (best < .02) continue;
        let l = (best * 4 + bay(x, y) - .5) | 0; if (l < 1) continue; if (l > 4) l = 4;
        const s = S[l] * C, p = (C - s) / 2; P[bi][l].rect(x * C + p, y * C + p, s, s);
      }
      P.forEach((ps, i) => { ctx.fillStyle = colors[i]; for (let l = 1; l < 5; l++) { ctx.globalAlpha = [0, .28, .42, .58, .75][l] * (cfg.alpha ?? 1); ctx.fill(ps[l]); } });
      ctx.globalAlpha = 1;
    }
    cfg.after && cfg.after(ctx, W, H, C, t);
  }
  function loop(ms) { if (!running) return; if (ms - last > 66) { last = ms; draw(ms / 1000); } raf = requestAnimationFrame(loop); }
  size(); addEventListener("resize", () => { size(); draw(performance.now() / 1000); });
  draw(cfg.stillTime ?? 2);
  if (!reduce && !deep) onScreen(canvas, (v) => { if (v && !running) { running = true; raf = requestAnimationFrame(loop); } else if (!v) { running = false; cancelAnimationFrame(raf); } });
  return { draw };
}

/* ---------------- LED panel: attributes flow through the ingest gate and come out redacted ---------------- */
function Ticker(canvas, items) {
  const ctx = canvas.getContext("2d"); const P = 3, ROWS = 11, GAP = 3;
  let W = 0, H = 0, cols = 0, running = false, raf = 0;
  const col = { key: css("--ink-3"), raw: css("--fault"), mask: css("--lamp"), off: css("--led-off"), gate: css("--lamp") };
  function bitmap(text) {
    const c = document.createElement("canvas"), x = c.getContext("2d", { willReadFrequently: true });
    x.font = "500 10px 'Geist Mono', ui-monospace, monospace"; const w = Math.ceil(x.measureText(text).width) + 1;
    c.width = w; c.height = ROWS; x.font = "500 10px 'Geist Mono', ui-monospace, monospace"; x.textBaseline = "middle"; x.fillStyle = CH(255, 255, 255); x.fillText(text, 0, ROWS / 2 + .5);
    const d = x.getImageData(0, 0, w, ROWS).data, m = new Uint8Array(w * ROWS);
    for (let i = 0; i < w * ROWS; i++) m[i] = d[i * 4 + 3] > 96 ? 1 : 0;
    return { w, m };
  }
  let lines = [];
  function build() {
    lines = items.map((it, i) => {
      const keyB = bitmap(it.k), raw = bitmap(it.k + it.raw), mask = bitmap(it.k + it.mask);
      return { keyW: keyB.w, raw, mask, speed: 13 + (i * 7) % 11, ph: i * 37 };
    });
  }
  function size() { const dpr = Math.min(devicePixelRatio || 1, 2); W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); cols = Math.floor(W / P); }
  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    const gate = Math.round(cols * .5), lineH = ROWS + GAP;
    const Pth = { key: new Path2D(), raw: new Path2D(), mask: new Path2D(), off: new Path2D() };
    lines.forEach((ln, li) => {
      const span = Math.max(ln.raw.w, ln.mask.w) + 26, shift = Math.floor(t * ln.speed + ln.ph);
      for (let x = 0; x < cols; x++) {
        const after = x > gate, bm = after ? ln.mask : ln.raw;
        const sx = ((x - shift) % span + span) % span;
        for (let y = 0; y < ROWS; y++) {
          const on = sx < bm.w && bm.m[y * bm.w + sx];
          const glitch = Math.abs(x - gate) < 2 && Math.random() < .05;
          const k = on ? (sx < ln.keyW ? "key" : after ? "mask" : "raw") : glitch ? "mask" : "off";
          const py = (li * lineH + y + 1) * P;
          if (py + P > H) continue;
          Pth[k].rect(x * P + .5, py + .5, P - 1.5, P - 1.5);
        }
      }
    });
    ctx.fillStyle = col.off; ctx.fill(Pth.off);
    ctx.fillStyle = col.key; ctx.fill(Pth.key);
    ctx.fillStyle = col.raw; ctx.fill(Pth.raw);
    ctx.fillStyle = col.mask; ctx.fill(Pth.mask);
    ctx.fillStyle = col.gate; ctx.globalAlpha = .9; ctx.fillRect(gate * P + P + 1, 0, 2, H); ctx.globalAlpha = .18; ctx.fillRect(gate * P - P * 3, 0, P * 8, H); ctx.globalAlpha = 1;
  }
  function loop(ms) { if (!running) return; draw(ms / 1000); raf = requestAnimationFrame(loop); }
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => {
    build(); size(); draw(3.2); addEventListener("resize", () => { size(); draw(performance.now() / 1000); });
    if (!reduce && !deep) onScreen(canvas, (v) => { if (v && !running) { running = true; raf = requestAnimationFrame(loop); } else if (!v) { running = false; cancelAnimationFrame(raf); } });
  });
}

/* ---------------- The hero: six things wrong, somewhere in the sea ---------------- */
const hero = $("#hero");
const FINDS = [
  { line: 17, fx: .43, tone: "err", a: "POST /parcels", b: "502", c: "1.42 s", t: "Parcelo is refusing calls" },
  { line: 9, fx: .21, tone: "warn", a: "GET /sessions/:id", b: "14 queries", t: "Same query 14 times, likely N+1" },
  { line: 12, fx: .64, tone: "warn", a: "parcelo.ship", b: "6 waiting", t: "Past 15 min at Shipment created at Parcelo" },
  { line: 22, fx: .11, tone: "err", a: "invoxa.invoices.sync", b: "failed", t: "Invoxa refused the call" },
  { line: 5, fx: .52, tone: "warn", a: "v8.heap.used", b: "412 MB", t: "Heap above 80% on app-2" },
  { line: 24, fx: .69, tone: "ok", a: "password", b: "[REDACTED]", t: "A secret stopped at ingest" },
];
const coWrap = $("#callouts"), pips = $$("#found .pips i");
FINDS.forEach((f) => {
  const el = document.createElement("div"); el.className = "callout" + (f.tone === "err" ? "" : " " + f.tone);
  el.innerHTML = `<div class="r1"><span>${f.a}</span><b>${f.b}</b>${f.c ? `<span>${f.c}</span>` : ""}</div><div class="r2">${f.t}</div>`;
  coWrap.append(el); f.el = el; f.hold = 0;
});
let foundN = 0;
function markFound(f) {
  if (f.found) return; f.found = true; foundN++;
  pips[foundN - 1]?.classList.add("on");
  $("#foundTxt").innerHTML = foundN === FINDS.length ? `<b>All ${FINDS.length} spotted.</b> That is the whole job.` : `<b>${foundN} of ${FINDS.length}</b> spotted`;
}
const sea = Watch($("#sea"), {
  lines: 30, finds: FINDS, still: deep, stillTime: 4, aim: 0,
  onFrame(finds) {
    const now = performance.now(), hw = hero.clientWidth, placed = [];
    // A phone or a short laptop screen shows at most three at once.
    const most = hw < 700 || hero.clientHeight < 780 ? 3 : 6;
    // The headline, the lede and the buttons stay readable: callouts keep below them.
    const hr = hero.getBoundingClientRect(), cr = $(".hero .copyb").getBoundingClientRect();
    const copy = { left: cr.left - hr.left - 12, right: cr.left - hr.left + Math.min(cr.width, 760) + 12, bottom: cr.bottom - hr.top + 14 };
    const overCopy = (x, w, top) => x + w / 2 > copy.left && x - w / 2 < copy.right && top < copy.bottom;
    // Callouts still fading out count as taken space until they are gone.
    const fading = [...hero.querySelectorAll(".callout:not(.on)")].filter((e) => parseFloat(getComputedStyle(e).opacity) > 0.05).map((e) => {
      const b = e.getBoundingClientRect(); return { x: b.left - hr.left + b.width / 2, w: b.width, top: b.top - hr.top, h: b.height };
    });
    const hits = (x, w, top, h) => [...placed, ...fading].find((r) => Math.abs(r.x - x) < (r.w + w) / 2 + 10 && top < r.top + r.h + 10 && r.top < top + h + 10);
    for (const f of [...finds].sort((x, y) => y.y - x.y)) {
      if (f.lit) { f.hold = now + 2400; markFound(f); }
      // Decide first, then switch once: toggling to measure would restart the fade every frame.
      let show = false;
      if (now < f.hold) {
        const cw = f.el.offsetWidth, ch = f.el.offsetHeight;
        const cx = Math.max(cw / 2 + 12, Math.min(hw - cw / 2 - 12, f.x));
        let top = f.y - ch - 18;
        if (overCopy(cx, cw, top)) top = copy.bottom;
        // Stack upward while there is room, else below the one it hits.
        for (let n = 0; n < 6; n++) {
          const hit = hits(cx, cw, top, ch); if (!hit) break;
          const up = hit.top - ch - 10;
          top = up > 8 && !overCopy(cx, cw, up) ? up : hit.top + hit.h + 10;
        }
        // No free spot left: this one waits rather than cover another (a phone fits fewer at once).
        show = placed.length < most && !hits(cx, cw, top, ch) && top + ch <= hero.clientHeight - 48;
        if (show) {
          placed.push({ x: cx, w: cw, top, h: ch });
          // .callout is drawn above its anchor (translate -100%): style.top is its bottom edge.
          f.el.style.left = cx + "px"; f.el.style.top = top + ch + "px"; f.el.style.setProperty("--stem", (f.x - cx + cw / 2) + "px");
        }
      }
      if (f.el.classList.contains("on") !== show) f.el.classList.toggle("on", show);
    }
  },
});
if (deep) { markFound(FINDS[1]); markFound(FINDS[4]); }
onScreen(hero, (v) => (v ? sea.start() : sea.stop()));
hero.addEventListener("pointermove", (e) => { const r = hero.getBoundingClientRect(); sea.point(e.clientX - r.left, e.clientY - r.top); });
hero.addEventListener("pointerleave", () => sea.release());

/* ---------------- Copy buttons ---------------- */
$$(".copy").forEach((b) => b.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); } catch {}
  b.classList.add("done"); setTimeout(() => b.classList.remove("done"), 1600);
}));

/* ---------------- The product tour ---------------- */
const fit = $("#fit");
const LOGS = [
  { lv: "warn", s: "worker", m: "parcelo.ship attempt 1 failed, retry in 30 s", ev: "parcelo" },
  { lv: "info", s: "api", m: "POST /parcels 201 in 112 ms" },
  { lv: "error", s: "worker", m: "PARCELO_UNAVAILABLE Parcelo did not accept the call: 502", ev: "parcelo" },
  { lv: "info", s: "cron", m: "paynest.payment.ingest <i>14 results</i>" },
  { lv: "info", s: "worker", m: "receipts.email sent to c***@acme.fr" },
  { lv: "warn", s: "api", m: "GET /sessions/4812 <i>same query 14 times</i>" },
  { lv: "info", s: "worker", m: "Parcelo <i>42 parcels</i>", ev: "parcelo" },
  { lv: "debug", s: "api", m: "cache hit session:4812" },
  { lv: "info", s: "worker", m: "invoxa.invoices.sync <i>3 invoices sent</i>" },
  { lv: "warn", s: "worker", m: "parcelo.ship waiting 16 min, past 15 min", ev: "parcelo" },
];
let clock = Date.UTC(2026, 10, 16, 14, 1, 40, 120);
const fmt = (t) => new Date(t).toISOString().slice(11, 21);
let li = 0;
const logList = $("#logList");
function logRow(fresh) {
  const r = LOGS[li++ % LOGS.length]; clock += 600 + Math.round(Math.random() * 2400);
  const el = document.createElement("div"); el.className = "lr" + (fresh ? " fresh" : ""); el.dataset.i = (li - 1) % LOGS.length;
  el.innerHTML = `<span class="t">${fmt(clock)}</span><span class="lv ${r.lv}">${r.lv}</span><span class="s">${r.s}</span><span class="msg">${r.m}</span>`;
  el.addEventListener("click", () => selectLog(el));
  return el;
}
for (let i = 0; i < 17; i++) logList.prepend(logRow(false));
function evPanel(r, time) {
  if (r.ev === "parcelo") return `<div><h5>Parcelo</h5><div class="sub">parcelo.ship at ${time}</div></div>
    <div class="nums"><div><b>42</b><span>observed</span></div><div><b>41</b><span>created</span></div><div class="warn"><b>1</b><span>unmatched</span></div></div>
    <div><div class="sec2">Fields</div><dl class="kv"><dt>operation</dt><dd>deliver</dd><dt>outcome</dt><dd><span class="chip err">refused</span></dd><dt>session</dt><dd>RS6731-B2</dd><dt>attempt</dt><dd>1 of 5</dd><dt>token</dt><dd style="color:var(--warn)">[REDACTED]</dd></dl></div>
    <div><div class="sec2">Same trace</div><dl class="kv"><dt>request</dt><dd>POST /parcels</dd><dt>duration</dt><dd>1.84 s</dd></dl></div>`;
  return `<div><h5>${r.s}</h5><div class="sub">${r.m.replace(/<[^>]+>/g, "")}</div></div>
    <dl class="kv"><dt>level</dt><dd>${r.lv}</dd><dt>service</dt><dd>${r.s}</dd><dt>time</dt><dd>${time}</dd><dt>host</dt><dd>app-2</dd></dl>`;
}
function selectLog(el) {
  $$(".lr.sel", logList).forEach((x) => x.classList.remove("sel")); el.classList.add("sel");
  $("#evPanel").innerHTML = evPanel(LOGS[+el.dataset.i], el.firstElementChild.textContent);
}
selectLog($$(".lr", logList).find((x) => LOGS[+x.dataset.i].lv === "error"));
let streamT = 0;
function stream() { const el = logRow(true); logList.prepend(el); const rows = $$(".lr", logList); if (rows.length > 18 && !rows.at(-1).classList.contains("sel")) rows.at(-1).remove(); else if (rows.length > 18) rows.at(-2).remove(); }

// traces
const SPANS = [
  { n: "POST /parcels", c: "--svc-app", s: 0, e: 1840 },
  { n: "auth.session", c: "--svc-cache", s: 6, e: 14 },
  { n: "select customers", c: "--svc-db", s: 18, e: 58 },
  { n: "insert registration", c: "--svc-db", s: 62, e: 104 },
  { n: "parcelo.ship", c: "--svc-ext", s: 112, e: 1532, err: 1 },
  { n: "queue parcelo.ship", c: "--svc-task", s: 1540, e: 1558 },
  { n: "update registration", c: "--svc-db", s: 1562, e: 1598 },
];
const total = 1840;
$("#ticks").innerHTML = [0, 500, 1000, 1500].map((t) => `<span style="left:${t / total * 100}%">${t < 1000 ? t + " ms" : t / 1000 + " s"}</span>`).join("");
$("#wf").innerHTML = SPANS.map((s, i) => `<div class="wr${s.err ? " e" : ""}" style="--i:${i}"><div class="n" style="padding-left:${i ? 14 : 0}px"><i style="background:var(${s.c})"></i><span class="m">${s.n}</span></div><div class="trk"><div class="bar" style="left:${s.s / total * 100}%;width:${Math.max(.6, (s.e - s.s) / total * 100)}%;background:var(${s.c})"></div></div><span class="d">${s.e - s.s >= 1000 ? ((s.e - s.s) / 1000).toFixed(2) + " s" : s.e - s.s + " ms"}</span></div>`).join("");
// issues sparkline
$("#spark").innerHTML = [0,0,1,0,0,0,2,1,0,3,5,4,6,8,7,9,6,8,10,7,9,8,6,7,9,8,5,6,7,8].map((v, i) => `<i style="--i:${i};height:${8 + v * 9}%"></i>`).join("");

const story = $("#story"), steps = $$("#tourTabs .step"), TOUR = steps.map((s) => s.dataset.t);
const pinned = () => innerWidth > 900;
let cur = null;
function scaleApp() {
  const kw = fit.parentElement.clientWidth / 1152;
  const k = pinned() ? Math.min(1, kw, (innerHeight - 250) / 640) : Math.max(.56, Math.min(1, kw));
  fit.style.setProperty("--k", k.toFixed(4));
}
addEventListener("resize", scaleApp); scaleApp();
function showTour(name) {
  if (name === cur) return; cur = name;
  steps.forEach((s) => s.setAttribute("aria-selected", s.dataset.t === name));
  $$("#app .pane").forEach((p) => { const on = p.dataset.p === name; p.classList.toggle("on", on); p.classList.remove("play"); if (on) { void p.offsetWidth; p.classList.add("play"); } });
  $$("#app .ni[data-n]").forEach((n) => n.classList.toggle("on", n.dataset.n === name));
  clearInterval(streamT); if (name === "logs" && !reduce && !deep) streamT = setInterval(stream, 1500);
  if (!pinned()) steps.forEach((s) => $(".bar", s).style.setProperty("--p", s.dataset.t === name ? 1 : 0));
}
const storyTop = () => story.getBoundingClientRect().top + scrollY;
steps.forEach((s, i) => s.addEventListener("click", () => {
  if (pinned()) scrollTo({ top: storyTop() + (i + .5) / 5 * (story.offsetHeight - innerHeight), behavior: reduce ? "auto" : "smooth" });
  else showTour(s.dataset.t);
}));
showTour("logs");


/* ---------------- Definitions ---------------- */
const defTabs = $$("#defTabs .tab");
function showDef(name) {
  defTabs.forEach((t) => t.setAttribute("aria-selected", t.dataset.d === name));
  $$(".dpane").forEach((p) => p.classList.toggle("on", p.dataset.dp === name));
}
defTabs.forEach((t) => t.addEventListener("click", () => showDef(t.dataset.d)));
const TONE = { error: ["chip err", "error"], warn: ["chip warn", "warn"], neutral: ["chip", "info"] };
const WITHIN = { "15m": "6 waiting past 15 min", "1h": "2 waiting past 1 h", "5m": "14 waiting past 5 min" };
const bind = {
  title(v) { $("#rTitle").textContent = v || "Untitled"; $("#rTitle2").textContent = v || "Untitled"; },
  tone(v) { $("#rTone").className = TONE[v][0]; $("#rLv").className = "lv " + (v === "neutral" ? "info" : v); $("#rLv").textContent = TONE[v][1]; },
  fix(v) { $("#eFix").textContent = v; },
  within(v) { $("#pNote").textContent = WITHIN[v]; },
  above(v) { $("#aCond").textContent = v; drawAlert(+v); },
};
$$(".tv").forEach((b) => b.addEventListener("click", () => {
  const opts = b.dataset.opts.split(","); const cur = b.textContent.replace(/"/g, "");
  const next = opts[(opts.indexOf(cur) + 1) % opts.length];
  b.textContent = b.classList.contains("nu") ? next : `"${next}"`;
  b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump");
  bind[b.dataset.bind](next);
}));
$$(".ed").forEach((e) => {
  e.addEventListener("input", () => bind[e.dataset.bind](e.textContent.trim()));
  e.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); e.blur(); } });
});
$$("#errSw button").forEach((b) => b.addEventListener("click", () => {
  $$("#errSw button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  const rec = b.dataset.s === "rec";
  $("#eHead").textContent = rec ? "Parcelo is answering again" : "Parcelo is refusing calls";
  $("#eBody").style.display = rec ? "none" : "";
}));

// the alert chart
const RATE = [.4,.6,.5,.8,.7,.9,1.2,1.1,.9,1.4,1.8,2.6,3.1,2.4,1.6,1.2,.9,.8,1.1,1.5,1.3,.9,.7,.6];
function drawAlert(th) {
  const svg = $("#aChart"), w = 520, h = 210, pl = 30, pr = 8, pt = 10, pb = 26, max = 6;
  const X = (i) => pl + i / (RATE.length - 1) * (w - pl - pr), Y = (v) => pt + (1 - v / max) * (h - pt - pb);
  const pts = RATE.map((v, i) => [X(i), Y(v)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = line + ` L${X(RATE.length - 1)} ${h - pb} L${X(0)} ${h - pb} Z`;
  // 10 min window over 5 min points: the mean of two
  const win = RATE.map((v, i) => i ? (v + RATE[i - 1]) / 2 : v);
  const firing = win.map((v) => v > th);
  const first = firing.indexOf(true);
  const segs = []; firing.forEach((f, i) => { if (f) segs.push(`<rect x="${X(i) - (w - pl - pr) / (RATE.length - 1) / 2}" y="${pt}" width="${(w - pl - pr) / (RATE.length - 1)}" height="${h - pt - pb}" fill="var(--fault)" opacity=".13"/>`); });
  const grid = [0, 2, 4, 6].map((v) => `<line x1="${pl}" x2="${w - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,.06)"/><text x="${pl - 8}" y="${Y(v) + 4}" text-anchor="end" fill="var(--app-t4)" font-size="11" font-family="var(--mono)">${v}%</text>`).join("");
  const times = [0, 6, 12, 18, 23].map((i) => { const m = 12 * 60 + i * 5; return `<text x="${X(i)}" y="${h - 6}" text-anchor="middle" fill="var(--app-t4)" font-size="11" font-family="var(--mono)">${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}</text>`; }).join("");
  svg.innerHTML = `${grid}${segs.join("")}<path d="${area}" fill="var(--lamp)" opacity=".08"/><path d="${line}" fill="none" stroke="var(--lamp)" stroke-width="1.8" stroke-linejoin="round"/>
    <line x1="${pl}" x2="${w - pr}" y1="${Y(th)}" y2="${Y(th)}" stroke="var(--fault)" stroke-dasharray="5 4" stroke-width="1.4"/><text x="${w - pr}" y="${Y(th) - 6}" text-anchor="end" fill="var(--fault)" font-size="11.5" font-family="var(--sans)">above ${th}%</text>${times}`;
  const v = $("#aVerdict");
  if (first < 0) v.innerHTML = `<b>Stays quiet.</b> The 10 minute rate never passed ${th}%.`;
  else { const m = 12 * 60 + first * 5; const n = firing.filter(Boolean).length; v.innerHTML = `<b>Fires at ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}</b> and stays open for ${n * 5} min, then sends the recovery.`; }
}
drawAlert(2);

/* ---------------- Agents transcript ---------------- */
const term = $("#term"), tlines = $$(".ln", term);
function playTerm(instant) {
  if (instant || reduce) { tlines.forEach((l) => l.classList.add("on")); return; }
  const q = tlines[0], tx = $(".tx", q), full = q.dataset.type; tx.textContent = ""; q.classList.add("on", "typed");
  let i = 0; const typer = setInterval(() => { tx.textContent = full.slice(0, ++i); if (i >= full.length) { clearInterval(typer); q.classList.remove("typed"); next(1); } }, 34);
  function next(k) { if (k >= tlines.length) return; setTimeout(() => { tlines[k].classList.add("on"); next(k + 1); }, k === tlines.length - 1 ? 1100 : 750); }
}
const termIO = new IntersectionObserver(([e]) => { if (e.isIntersecting) { playTerm(false); termIO.disconnect(); } }, { threshold: .45 });
if (!deep) termIO.observe(term); else playTerm(true);

/* ---------------- Redaction, the same rules as server/lib/redact.ts ---------------- */
const SECRET_KEY = /(^|[._-])(password|passwd|pwd|token|authorization|cookie|set-cookie|secret|api[_-]?key|private[_-]?key|session[_-]?token)($|[._-])/i;
const SECRET_PATH = /(\/(?:reset-password|parcelo\/webhooks|order-receipts)\/)(?!:)[^/?#\s"]+/g;
const EMAIL = /([a-zA-Z0-9])[a-zA-Z0-9._%+-]*@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
const CARD = /\b(?:\d[ -]?){13,16}\b/g;
const SAFE_EMAIL_KEYS = /^(service\.|telemetry\.|process\.|host\.)/;
const SAFE_ID = /(\.id|Id)$/;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
function redactValue(key, value, n) {
  if (SECRET_KEY.test(key) && !SAFE_ID.test(key)) { n["secret-keys"]++; return "\u0001[REDACTED]\u0002"; }
  if (value.length < 6 || SAFE_EMAIL_KEYS.test(key)) return value;
  let out = value;
  if (out.includes("/")) out = out.replace(SECRET_PATH, (_, p) => { n["secret-paths"]++; return `${p}\u0001[REDACTED]\u0002`; });
  if (out.includes("@")) out = out.replace(EMAIL, (_, f, d) => { n.emails++; return `\u0001${f}***@${d}\u0002`; });
  if (/\d{4}/.test(out) && !key.endsWith("id") && !key.endsWith("Id")) out = out.replace(CARD, (m) => { if (m.replace(/\D/g, "").length < 13) return m; n.cards++; return "\u0001[CARD]\u0002"; });
  return out;
}
const redIn = $("#redIn"), redOut = $("#redOut");
let prev = "";
function redact() {
  const n = { "secret-keys": 0, "secret-paths": 0, emails: 0, cards: 0 };
  const html = redIn.value.split("\n").map((line) => {
    const m = line.match(/^\s*([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (!m) return esc(line);
    const v = redactValue(m[1], m[2], n);
    return `<span class="key">${esc(m[1])}=</span>${esc(v).replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>")}`;
  }).join("\n");
  redOut.innerHTML = html;
  const totalN = Object.values(n).reduce((a, b) => a + b, 0);
  $("#redCount").textContent = totalN === 1 ? "1 value masked" : `${totalN} values masked`;
  $$("#rules b").forEach((b) => (b.textContent = n[b.dataset.r]));
  if (prev && prev !== html) $$("mark", redOut).slice(-1).forEach((m) => m.classList.add("fl"));
  prev = html;
}
redIn.addEventListener("input", redact); redact();

/* ---------------- Start ---------------- */
$$(".tabs[data-group]").forEach((list) => {
  const group = list.dataset.group;
  const tabs = [...list.querySelectorAll(".tab")];
  const show = (name) => { tabs.forEach((t) => t.setAttribute("aria-selected", t.dataset.s === name)); $$(`.spane[data-g="${group}"]`).forEach((p) => p.classList.toggle("on", p.dataset.sp === name)); };
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.s)));
});

/* ---------------- Stack: scroll assembles it, then walks each layer ---------------- */
const story2 = $("#story2"), iso = $("#iso"), plates = $$(".plate", iso), lbtns = $$("#layers button");
let hoverL = null, scrubL = null;
function setLayer(l) {
  plates.forEach((p) => p.classList.toggle("on", +p.dataset.l === l));
  lbtns.forEach((b) => b.classList.toggle("on", +b.dataset.l === l));
  iso.classList.toggle("focus", l != null);
}
const enter = (l) => { hoverL = l; setLayer(l); }, leave = () => { hoverL = null; setLayer(scrubL); };
lbtns.forEach((b) => { b.addEventListener("pointerenter", () => enter(+b.dataset.l)); b.addEventListener("pointerleave", leave); b.addEventListener("focus", () => enter(+b.dataset.l)); b.addEventListener("blur", leave); b.addEventListener("click", () => enter(+b.dataset.l)); });
plates.forEach((p) => { p.addEventListener("pointerenter", () => enter(+p.dataset.l)); p.addEventListener("pointerleave", leave); });
// pixel textures on each plate, alive while the section is on screen
const TEX = {};
$$(".px", iso).forEach((px) => {
  const kind = px.dataset.tex, cells = [];
  for (let i = 0; i < 120; i++) { const c = document.createElement("i"); px.append(c); cells.push(c); }
  TEX[kind] = cells;
  cells.forEach((c, i) => {
    const x = i % 12, y = (i / 12) | 0;
    if (kind === "cols" && x % 2 === 0 && y > 9 - ((x * 7 + 3) % 8) - 2) c.className = "d";
    if (kind === "rows" && y % 2 === 0 && x < [11, 7, 9, 5, 10][y / 2]) c.className = y === 2 ? "l" : "d";
    if (kind === "code" && y % 2 === 0 && x >= [0, 1, 2, 2, 1][y / 2] && x < [7, 10, 8, 11, 4][y / 2]) c.className = "d";
  });
});
let texT = 0, texN = 0;
function texTick() {
  texN++;
  TEX.flow.forEach((c, i) => { const x = i % 12, y = (i / 12) | 0; c.className = (x + y * 5 + texN) % 9 === 0 ? (x === 7 && y === 4 ? "f" : "l") : (x + y) % 3 === 0 ? "d" : ""; });
  TEX.pulse.forEach((c, i) => { c.className = Math.random() < .06 ? "l" : (i % 12) % 3 === 0 && ((i / 12) | 0) % 2 ? "d" : ""; });
  TEX.code.forEach((c, i) => { if (c.classList.contains("l")) c.className = "d"; });
  const caret = TEX.code[[4, 25, 52, 74][texN % 4]]; if (caret) caret.className = "l";
}
texTick();
if (!reduce && !deep) onScreen(iso, (v) => { clearInterval(texT); if (v) texT = setInterval(texTick, 380); });
let cycle = 0;
if (!reduce && !deep) setInterval(() => { if (innerWidth <= 960 && hoverL == null) { scrubL = 4 - (cycle++ % 5); setLayer(scrubL); } }, 2200);

/* ---------------- Glows, the daybreak, the sunrise, the LED gate, the terminal's lighthouse ---------------- */
const GLOWS = {
  tour: { blobs: [{ x: .5, y: .66, r: .4, ry: .2, c: "--lamp", a: .3 }, { x: .12, y: .3, r: .26, c: "--ocean", a: .55 }, { x: .9, y: .28, r: .22, c: "--sun", a: .26 }] },
  stack: { blobs: [{ x: .3, y: .58, r: .3, c: "--ocean", a: .62 }, { x: .32, y: .42, r: .14, c: "--lamp", a: .24 }, { x: .85, y: .85, r: .2, c: "--sun", a: .16 }] },
  defs: { blobs: [{ x: .82, y: .62, r: .3, c: "--lamp", a: .22 }, { x: .1, y: .85, r: .3, c: "--ocean", a: .5 }] },
  agents: { blobs: [{ x: .78, y: .5, r: .32, c: "--sun", a: .3 }, { x: .2, y: .75, r: .26, c: "--lamp", a: .18 }] },
};
$$("canvas.glow").forEach((c) => Dither(c, GLOWS[c.dataset.glow]));
Dither($("#dawnPx"), { mode: "dissolve", color: "--dawn", cell: 7 });

let rise = 0;
const MARK = 29, markCell = (i, j) => {
  const dx = i - 14, dy = j - 14, cx = Math.abs(dx) - 7, cy = Math.abs(dy) - 7;
  if (cx > 0 && cy > 0 && cx * cx + cy * cy > 52) return 0;
  const d = Math.hypot(dx, dy); return Math.abs(d - 7.4) < 1.45 || d < 2.5 ? 2 : 1;
};
const sunCfg = {
  cell: 7, blobs: [{ x: .5, y: 1.2, r: .4, ry: .26, c: "--sun-2", a: .75, dx: 0, dy: 0 }, { x: .5, y: 1.2, r: .22, ry: .16, c: "--sun", a: .7, dx: 0, dy: 0 }],
  after(ctx, W, H, C) {
    const k = 7, x0 = Math.round(W / 2 - MARK * k / 2), y0 = Math.round(H + 8 - rise * (MARK * k + 40));
    const body = css("--sun"), ink = css("--dawn-panel");
    for (let j = 0; j < MARK; j++) for (let i = 0; i < MARK; i++) { const v = markCell(i, j); if (!v) continue; if (v === 2) { ctx.fillStyle = ink; ctx.fillRect(x0 + i * k, y0 + j * k, k, k); } else { ctx.fillStyle = body; ctx.fillRect(x0 + i * k + .5, y0 + j * k + .5, k - 1.5, k - 1.5); } }
  },
};
const sun = Dither($("#sunPx"), sunCfg);
const foot = $(".foot");

Ticker($("#led"), [
  { k: "password=", raw: "hunter2", mask: "[REDACTED]" },
  { k: "authorization=", raw: "Bearer eyJhbGciOiJIUzI1NiJ9", mask: "[REDACTED]" },
  { k: "customer.email=", raw: "claire.martin@acme.fr", mask: "c***@acme.fr" },
  { k: "billing.card=", raw: "4242 4242 4242 4242", mask: "[CARD]" },
  { k: "http.url=/reset-password/", raw: "8f3c2a1b9d", mask: "[REDACTED]" },
]);

{ const lc = $("#termLogo"), lx = lc.getContext("2d"), d = 2; lc.width = 63 * d; lc.height = 78 * d; lx.scale(d, d);
  const pal = { r: css("--sun"), c: css("--sun"), w: css("--ink"), g: css("--ink-3"), d: css("--night-3"), l: css("--lamp"), L: css("--lamp"), b: css("--rock"), shade: css("--night") };
  drawTower(lx, 3, 0, 0, 1.1, pal); }

/* ---------------- One scroll handler drives every pinned story ---------------- */
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function onScroll() {
  if (pinned()) {
    const p = clamp01(-story.getBoundingClientRect().top / (story.offsetHeight - innerHeight)), x = p * 5, idx = Math.min(4, Math.floor(x));
    steps.forEach((s, i) => $(".bar", s).style.setProperty("--p", i < idx ? 1 : i === idx ? (x - idx).toFixed(3) : 0));
    showTour(TOUR[idx]);
  }
  if (innerWidth > 960) {
    const p = clamp01(-story2.getBoundingClientRect().top / (story2.offsetHeight - innerHeight));
    const e = clamp01(p / .3); iso.style.setProperty("--e", (e * e * (3 - 2 * e)).toFixed(3));
    scrubL = p < .3 ? null : 4 - Math.min(4, Math.floor((p - .3) / .7 * 5));
    if (hoverL == null) setLayer(scrubL);
  }
  const r = foot.getBoundingClientRect(); const nr = clamp01((innerHeight - r.top) / (innerHeight * .7));
  if (Math.abs(nr - rise) > .002) { rise = nr; sunCfg.blobs.forEach((b) => (b.y = 1.25 - .55 * rise)); sun.draw(performance.now() / 1000); }
}
addEventListener("scroll", onScroll, { passive: true }); addEventListener("resize", onScroll); onScroll();

/* ---------------- Deep links for review: #tour-traces, #stack, #define-alert, #banner ... ---------------- */
if (deep) { if (document.readyState === "complete") setTimeout(runDeep, 60); else addEventListener("load", () => setTimeout(runDeep, 60)); }
function runDeep() {
  const s = stateName; document.documentElement.style.scrollBehavior = "auto";
  const top = (el) => el.getBoundingClientRect().top + scrollY;
  const go = (y) => { scrollTo(0, y); onScroll(); };
  if (s.startsWith("tour")) { const i = Math.max(0, TOUR.indexOf(s.split("-")[1] || "logs")); if (pinned()) go(top(story) + (i + .6) / 5 * (story.offsetHeight - innerHeight)); else { showTour(TOUR[i]); go(top(story)); } }
  else if (s === "stack") go(top(story2) + (innerWidth > 960 ? .5 * (story2.offsetHeight - innerHeight) : 0));
  else if (s === "stack-packed") go(top(story2));
  else if (s.startsWith("define")) { showDef(s.split("-")[1] || "renderer"); go(top($("#definitions")) - 24); }
  else if (s === "agents") go(top($("#agents")) - 24);
  else if (s === "redact") go(top($("#secure")) - 24);
  else if (s.startsWith("start")) { const pick = { "start-server": ["run", "server"], "start-nestjs": ["app", "nestjs"], "start-any": ["app", "any"] }[s]; const tab = pick && $(`.tabs[data-group="${pick[0]}"] .tab[data-s="${pick[1]}"]`); tab?.click(); go(top(tab ? tab.closest(".shell") : $("#start")) - 96); }
  else if (s === "footer") go(document.body.scrollHeight);
  else if (s === "banner") {
    const st = $("#bstage"); st.classList.add("on"); st.setAttribute("aria-hidden", "false");
    const fitB = () => st.querySelector(".banner").style.setProperty("--bk", Math.min(1, innerWidth / 1280, innerHeight / 640));
    fitB(); addEventListener("resize", fitB);
    Watch($("#bsea"), { lines: 24, horizon: .6, tower: .84, finds: [{ line: 15, fx: .56 }], still: true, stillTime: 6, aim: 0 }).start();
  }
}

return () => { dead = true; ac.abort(); timers.forEach((id) => clearInterval(id)); observers.forEach((o) => o.disconnect()); };
}
