#!/usr/bin/env node
/**
 * Screenshot harness.
 *
 *     npm install                       # once — playwright-core + a browser
 *     npx playwright install chromium   # once
 *     node shoot.mjs                    # → shots/*.png
 *
 *     node shoot.mjs --out shots/before          label a run
 *     node shoot.mjs --only mobile,laptop        subset of the viewport matrix
 *     node shoot.mjs --views                     also shoot World / Ring / California
 *     node shoot.mjs --zoom 4                    plus N wheel-zoom steps from California
 *     node shoot.mjs --url https://tremor.keithtroutt.com   shoot production instead
 *
 * Every visual change to this project is invisible to whoever is making it
 * until someone loads a browser. HANDOFF.md describes a five-round loop of
 * change → wait for a screenshot → find out it was wrong, including two rounds
 * spent lighting a mesh that could never have rendered. This collapses that:
 * build, shoot, look at the PNGs, fix everything in one pass.
 *
 * Exits non-zero if any page logged a console error or never cleared the boot
 * overlay, which is the closest thing this project has to a regression test.
 */
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
if (flag("help") || argv.includes("-h")) {
  // The usage block at the top of this file is the documentation; print it
  // rather than keeping a second copy in sync with it.
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.log(src.slice(src.indexOf("/**") + 3, src.indexOf("*/"))
    .replace(/^\s*\* ?/gm, "").trim());
  process.exit(0);
}

const OUT = String(flag("out", path.join(ROOT, "shots")));
const ONLY = flag("only") ? String(flag("only")).split(",") : null;
const SHOOT_VIEWS = !!flag("views");
const ZOOM_STEPS = Number(flag("zoom", 0)) || 0;
const EXTERNAL = flag("url");

// Deck needs a moment past first paint for tiles and buffers to land; the
// boot overlay clearing only means DuckDB answered.
const SETTLE_MS = 6000;
const BOOT_MS = 90_000;

const VIEWPORTS = [
  { name: "desktop-wide", width: 1920, height: 1080 },
  { name: "desktop-short", width: 1440, height: 820 },
  { name: "laptop", width: 1280, height: 720 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844, mobile: true },
  { name: "mobile-landscape", width: 844, height: 390, mobile: true },
];

// ---- the server ----------------------------------------------------------
// Mirrors serve.py: no validators, so nothing is ever served from cache.
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/json",
  ".parquet": "application/octet-stream", ".svg": "image/svg+xml",
  ".png": "image/png", ".wasm": "application/wasm",
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, () => r([server, server.address().port])));
}

// ---- the browser ---------------------------------------------------------
// playwright-core ships no binaries. Prefer $PLAYWRIGHT_CHROMIUM, then the
// cache `npx playwright install chromium` writes — whose directory layout
// differs by platform and has been renamed across releases, hence the search.
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const roots = [
    path.join(process.env.HOME || "", "Library/Caches/ms-playwright"),
    path.join(process.env.HOME || "", ".cache/ms-playwright"),
    process.env.PLAYWRIGHT_BROWSERS_PATH,
  ].filter((d) => d && fs.existsSync(d));
  const candidates = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux/chrome",
    "chrome-win/chrome.exe",
  ];
  for (const root of roots) {
    const builds = fs.readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse();
    for (const b of builds)
      for (const c of candidates) {
        const exe = path.join(root, b, c);
        if (fs.existsSync(exe)) return exe;
      }
  }
  return null;
}

// ---- run -----------------------------------------------------------------
const [server, port] = EXTERNAL ? [null, 0] : await serve();
const base = EXTERNAL === true ? "http://localhost:8080" : EXTERNAL || `http://localhost:${port}`;

const exe = findChromium();
if (!exe) {
  console.error("No Chromium found. Run: npx playwright install chromium");
  console.error("Or point PLAYWRIGHT_CHROMIUM at a Chrome binary.");
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: exe,
  // deck.gl wants a real GPU path; SwiftShader is the fallback on machines
  // and CI boxes that will not give a headless process one.
  args: ["--use-gl=angle", "--use-angle=metal", "--enable-unsafe-swiftshader",
         "--force-color-profile=srgb"],
});

const problems = [];
let shots = 0;

const save = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  shots++;
  console.log(`  ${name}.png`);
};

for (const vp of VIEWPORTS) {
  if (ONLY && !ONLY.includes(vp.name)) continue;
  console.log(`${vp.name} ${vp.width}x${vp.height}`);

  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: !!vp.mobile,
    hasTouch: !!vp.mobile,
    userAgent: vp.mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : undefined,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${vp.name}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${vp.name}: uncaught ${e.message}`));

  await page.goto(base, { waitUntil: "domcontentloaded" });
  try {
    // app.js hides #boot inline once the first query has answered.
    await page.waitForFunction(
      () => document.getElementById("boot")?.style.display === "none",
      null, { timeout: BOOT_MS });
  } catch {
    const stuck = await page.locator("#boot-msg").textContent().catch(() => "?");
    problems.push(`${vp.name}: boot never cleared, stuck at "${stuck}"`);
  }
  await page.waitForTimeout(SETTLE_MS);
  await save(page, vp.name);

  // The rail is where the controls live, and on a phone it is behind a handle.
  if (vp.mobile) {
    await page.click("#sheet-handle");
    await page.waitForTimeout(900);
    await save(page, `${vp.name}-sheet`);
    await page.click("#sheet-handle");
    await page.waitForTimeout(600);
  }

  // Only worth doing once — the presets are the same camera at every size.
  if (SHOOT_VIEWS && vp.name === "desktop-short") {
    for (const [id, label] of [["b-ring", "ring-of-fire"], ["b-ca", "california"]]) {
      await page.click(`#${id}`);
      await page.waitForTimeout(2600);       // flyTo is a 900ms transition
      await save(page, `view-${label}`);
    }
    // Wheel steps out of California, which is the only way to cross the
    // 4.6–6.2 tile crossfade without a camera seam in app.js — deckgl is
    // module-scoped, so the harness cannot set a zoom directly. Labels are
    // step counts, not zoom levels; read them as "further in", not as z6.7.
    for (let i = 1; i <= ZOOM_STEPS; i++) {
      await page.mouse.move(vp.width / 2 + 200, vp.height / 2);
      await page.mouse.wheel(0, -320);
      await page.waitForTimeout(2200);
      await save(page, `zoom-step-${i}`);
    }
  }

  await ctx.close();
}

await browser.close();
server?.close();

console.log(`\n${shots} shots → ${OUT}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("no console errors");
