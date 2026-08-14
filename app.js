import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

const MANIFEST_URL = "./manifest.json";
const FEED_MONTH = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson";
const FEED_HOUR  = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";
const EVENT_PAGE = "https://earthquake.usgs.gov/earthquakes/eventpage/";

const $ = (id) => document.getElementById(id);
const boot = (m) => ($("boot-msg").textContent = m);
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

// A hardcoded world zoom cuts whatever doesn't fit the viewport it was tuned
// on — at zoom 1.9 that was ~80° of longitude and everything above ~55°N,
// which is precisely the Aleutians. Compute it instead, from the map area
// actually available, so the whole seismic band is always in frame.
const RAIL_W = 420, TIMELINE_H = 152, TILE = 512;
const LAT_N = 78, LAT_S = -62;   // Aleutians down to the South Sandwich arc
const mercY = (lat) =>
  0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) / (2 * Math.PI);
const invMercY = (f) =>
  (2 * Math.atan(Math.exp((0.5 - f) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI;

function worldView() {
  const w = Math.max(320, innerWidth - (innerWidth > 900 ? RAIL_W : 0));
  const h = Math.max(240, innerHeight - TIMELINE_H);
  const span = mercY(LAT_S) - mercY(LAT_N);
  const zoom = Math.min(Math.log2(w / TILE), Math.log2(h / (TILE * span)));
  return {
    longitude: -40,
    latitude: invMercY((mercY(LAT_S) + mercY(LAT_N)) / 2),
    zoom: Math.max(0.2, zoom - 0.08),   // a hair of margin
    pitch: 0, bearing: 0,
  };
}

const VIEWS = {
  ring:  { longitude: 155, latitude: 8, zoom: 2.1, pitch: 0, bearing: 0 },
  ca:    { longitude: -119.4, latitude: 36.6, zoom: 4.9, pitch: 0, bearing: 0 },
};
const viewFor = (name) => (name === "world" ? worldView() : VIEWS[name]);

const BANDS = [
  { hi: 35,  c: [255, 95, 74] },
  { hi: 70,  c: [255, 159, 69] },
  { hi: 150, c: [224, 85, 155] },
  { hi: 300, c: [140, 106, 224] },
  { hi: 1e9, c: [62, 200, 224] },
];
const depthColor = (d) => {
  for (const b of BANDS) if (d < b.hi) return b.c;
  return BANDS[4].c;
};

// Radius in PIXELS, not metres. An epicentre is a point — the circle is a
// symbol, not a footprint — and a metre radius resizes with every zoom,
// which makes a legend impossible to keep honest. Monotonic in energy, but
// the exponent is compressed for legibility: true energy scaling (10^1.5M)
// would put an M9 some 30,000x an M4 and there is no usable range in that.
const MAG_R = (m) => 0.103 * Math.pow(10, m * 0.237);
const LEGEND_MAGS = [5, 6.5, 8];

const MAJOR_STEPS = [
  { floor: 8.0, label: "M8+ · 100" },
  { floor: 7.5, label: "M7.5+ · 501" },
  { floor: 7.0, label: "M7+ · 1583" },
  { floor: null, label: "Majors off" },
];

const COLS = `ID, TIME, MAG, MAG_TYPE, DEPTH_KM, LATITUDE, LONGITUDE,
              PLACE, FELT, CDI, MMI, ALERT, TSUNAMI, SIG`;

let db = null, conn = null, deckgl = null, landLayer = null;
// Political context for the basemap. Borders split by admin level at load so
// each renders as its own flat stroke; labels stay raw because which ones are
// visible depends on the live zoom.
let borders0 = null, borders1 = null, placeLabels = null;
let zoomNow = 0, contextSig = "";

// Above this zoom the frame is regional enough that state and province lines
// orient rather than clutter. Below it, country outlines carry the map.
const STATE_LINE_ZOOM = 3.2;

// No names at all until the view is tighter than the presets. The world and
// Ring of Fire frames are about the shape of the data, and country labels
// scattered across them read as noise over the one thing worth looking at.
// Both presets sit below this (world lands near 1.45, ring at 2.1), so names
// are something you zoom in to get rather than something you dismiss.
const LABEL_MIN_ZOOM = 2.5;

/** NE's max_label is deliberately ignored — it assumes city labels take over at
 *  high zoom, and this map has none, so honouring it makes names vanish exactly
 *  when someone zooms in to read them. Off-viewport labels cost nothing. */
const labelVisible = (l, z) => z >= LABEL_MIN_ZOOM && z >= l.min;

/** What the context layers would render at this zoom — used to skip redraws. */
function contextSignature(z) {
  if (!placeLabels) return "";
  let n = 0;
  for (const l of placeLabels) if (labelVisible(l, z)) n++;
  return `${n}|${z >= STATE_LINE_ZOOM ? 1 : 0}`;
}
let manifest = null;
let hasArchive = false, archiveLoading = false;
let monthKeys = [], monthCounts = [], liveMonths = new Set(), gapMonths = new Set();
let liveFeatures = [], hourCount = null;
let lastMod = null, pollTimer = null;
let gpu = null;                 // {n, positions, colors, radii, times}
let rows = null;                // retained Arrow table, for picking
let majorsRows = [];
let anim = null;

// The past-hour feed is all-magnitude; everything else is floored at M4.5.
// They are two different populations, so the hour view reads from its own
// table and drops the magnitude floor rather than rendering an empty map.
const WINDOWS = {
  hour:  { ms: 36e5,     label: "Hour" },
  day:   { ms: 864e5,    label: "Day" },
  week:  { ms: 7 * 864e5, label: "Week" },
  month: { ms: 30 * 864e5, label: "30 days" },
  all:   { ms: null,     label: "Decade" },
};
const utcLit = (ms) => new Date(ms).toISOString().slice(0, 19);

let hourFeatures = [];

let state = {
  minMag: 4.5, depth: null, month: null, window: "month",
  majorStep: 0, view: "world",
};
const majorFloor = () => MAJOR_STEPS[state.majorStep].floor;

const fmt = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" :
  n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n));
const commas = (n) => Math.round(n).toLocaleString();

// "2015-01" reads like a database key. Spell the months out.
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const monthLabel = (key) => {
  if (!key) return "";
  const [y, m] = key.split("-");
  return `${MONTH_NAMES[+m - 1]} ${y}`;
};

// ---- source: live only until the archive is pulled in --------------------
// The merge happens in SQL, not a JS Map. Pulling 86k archive rows into
// JavaScript objects to dedup against ~650 live ones would undo the whole
// binary-buffer path; this keeps everything columnar through to the GPU.
// archive + live, with live winning the overlap.
function mergedSource() {
  if (!hasArchive) return "live";
  return `(SELECT ${COLS} FROM live
           UNION ALL
           SELECT ${COLS} FROM archive WHERE ID NOT IN (SELECT ID FROM live))`;
}

// What the map draws — the Hour window swaps in its own all-magnitude table.
function source() {
  return state.window === "hour" ? "hourly" : mergedSource();
}

// What the timeline draws. Deliberately NOT source(): the histogram is an
// overview of the whole archive and must not follow the active window. Built
// from `hourly` it would collapse 140 months into the one containing the
// past hour, and the chart would appear to vanish.
const timelineSource = () => mergedSource();

function where() {
  const c = [];
  // The hourly feed carries every magnitude it recorded; applying the M4.5
  // floor to it would empty the map, since M4.5+ worldwide runs under one
  // per hour.
  if (state.window !== "hour") c.push(`MAG >= ${state.minMag}`);
  const w = WINDOWS[state.window];
  // A picked month is an explicit override of the rolling window.
  if (state.month) c.push(`strftime(TIME, '%Y-%m') = '${state.month}'`);
  else if (w.ms) c.push(`TIME >= TIMESTAMP '${utcLit(Date.now() - w.ms)}'`);
  if (state.depth) c.push(`DEPTH_KM >= ${state.depth.lo} AND DEPTH_KM < ${state.depth.hi}`);
  return c.length ? "WHERE " + c.join(" AND ") : "";
}

// ---- boot ----------------------------------------------------------------
async function init() {
  try {
    // The manifest is the freshness oracle and is served no-cache. Nothing
    // else can tell us which parquet is current or how stale it is.
    boot("Reading manifest");
    const mres = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (!mres.ok) throw new Error(`manifest.json unavailable (HTTP ${mres.status})`);
    manifest = await mres.json();

    applyCopy();
    buildTimelineFromManifest();
    applyStaleness();

    boot("Starting DuckDB");
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    conn = await db.connect();

    boot("Fetching live feed");
    const ok = await loadLive();
    if (!ok) await fallbackToArchive();

    boot("Building the map");
    await initDeck();
    await loadMajors();
    // Before the first refresh: the Hour window needs `hourly` to exist and
    // the ring overlay needs the features.
    await pollHour();
    await setWindow(state.window);

    $("boot").style.display = "none";
    startPolling();
    setInterval(pollHour, 60_000);
  } catch (e) {
    console.error(e);
    $("boot").innerHTML =
      `<div class="msg err"><strong>Could not start.</strong><br/>${e.message}</div>`;
  }
}

// ---- tier 1: live --------------------------------------------------------
function normalize(f) {
  const p = f.properties, g = f.geometry.coordinates;
  return {
    ID: f.id, TIME: p.time, MAG: p.mag, MAG_TYPE: p.magType || "",
    DEPTH_KM: g[2] ?? 0, LATITUDE: g[1], LONGITUDE: g[0],
    PLACE: p.place || "", FELT: p.felt || 0, CDI: p.cdi || 0,
    MMI: p.mmi || 0, ALERT: p.alert || "", TSUNAMI: p.tsunami || 0,
    SIG: p.sig || 0,
  };
}

// Shared by both feeds: coerce a flat JSON array into the archive's exact
// column shape and types, so live, hourly and archive are union-compatible.
const castJson = (file) => `
  SELECT ID, epoch_ms(CAST(TIME AS BIGINT))::TIMESTAMP AS TIME,
         CAST(MAG AS FLOAT) MAG, MAG_TYPE, CAST(DEPTH_KM AS FLOAT) DEPTH_KM,
         CAST(LATITUDE AS FLOAT) LATITUDE, CAST(LONGITUDE AS FLOAT) LONGITUDE,
         PLACE, CAST(FELT AS INT) FELT, CAST(CDI AS FLOAT) CDI,
         CAST(MMI AS FLOAT) MMI, ALERT, CAST(TSUNAMI AS TINYINT) TSUNAMI,
         CAST(SIG AS INT) SIG
  FROM read_json_auto('${file}')`;

async function registerLive(feats) {
  // Normalising ~650 features in JS is cheap; the point of doing the merge
  // in SQL is to avoid materialising the *archive* as objects.
  const flat = feats.map(normalize);
  await db.registerFileText("live.json", JSON.stringify(flat.length ? flat : [dummyRow()]));
  await conn.query(`CREATE OR REPLACE TABLE live AS ${castJson("live.json")}`);
  if (!flat.length) await conn.query(`DELETE FROM live`);
}

async function loadLive() {
  try {
    const res = await fetch(FEED_MONTH);
    if (!res.ok) throw new Error(res.status);
    lastMod = res.headers.get("last-modified");
    const gj = await res.json();
    liveFeatures = (gj.features || []).filter(
      (f) => f.properties.type === "earthquake" && f.properties.mag !== null && f.geometry
    );
    await registerLive(liveFeatures);
    markLiveMonths();
    return true;
  } catch (e) {
    console.warn("live feed unavailable", e);
    return false;
  }
}

// Tier 1 must not be a single point of failure — a USGS outage or a
// corporate proxy would otherwise leave an empty ocean.
async function fallbackToArchive() {
  // Archive first — the empty live table is defined from its schema, so it
  // cannot be created before the view exists.
  await loadArchive(true);
  await conn.query(`CREATE OR REPLACE TABLE live AS
    SELECT ${COLS} FROM archive WHERE false`).catch(() => {});
  showBanner(
    `Live feed unreachable — showing archived data through ` +
    `${new Date(manifest.coverage_end).toUTCString().slice(5, 16)}.`
  );
}

// Let HTTP caching do the revalidation. USGS serves last-modified but no
// ETag, and `cache: "no-cache"` would hide the 304 behind a synthesised
// 200 — so we compare the validator we can actually read.
async function pollLive() {
  if (document.hidden) return;
  try {
    const res = await fetch(FEED_MONTH);
    const lm = res.headers.get("last-modified");
    if (lm && lm === lastMod) return;
    lastMod = lm;
    const gj = await res.json();
    liveFeatures = (gj.features || []).filter(
      (f) => f.properties.type === "earthquake" && f.properties.mag !== null && f.geometry
    );
    await registerLive(liveFeatures);
    markLiveMonths();
    await refresh();
  } catch (e) { /* keep the last good state */ }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(pollLive, 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollLive(); });
}

async function pollHour() {
  try {
    const r = await fetch(FEED_HOUR);
    if (!r.ok) throw new Error(r.status);
    const gj = await r.json();
    hourFeatures = (gj.features || []).filter(
      (f) => f.properties.type === "earthquake" && f.properties.mag !== null && f.geometry
    );
    hourCount = hourFeatures.length;
    $("live-n").textContent = hourCount;
    const t = new Date(gj.metadata.generated);
    $("live-lab").textContent =
      `Past hour · all magnitudes · ${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    // Registered as its own table so the Hour window has something to query
    // that isn't subject to the M4.5 floor.
    const flat = hourFeatures.map(normalize);
    await db.registerFileText("hour.json", JSON.stringify(flat.length ? flat : [dummyRow()]));
    await conn.query(`CREATE OR REPLACE TABLE hourly AS ${castJson("hour.json")}`);
    if (!flat.length) await conn.query(`DELETE FROM hourly`);

    if (state.window === "hour") await refresh(); else draw();
  } catch {
    $("live-n").textContent = "—";
    $("live-lab").textContent = "Past-hour feed unreachable";
  }
}

// read_json_auto needs at least one row to infer a schema; an empty hour is
// possible, so seed and immediately clear.
const dummyRow = () => ({
  ID: "_", TIME: 0, MAG: 0, MAG_TYPE: "", DEPTH_KM: 0, LATITUDE: 0,
  LONGITUDE: 0, PLACE: "", FELT: 0, CDI: 0, MMI: 0, ALERT: "", TSUNAMI: 0, SIG: 0,
});

// ---- tier 2: archive -----------------------------------------------------
async function loadArchive(quiet) {
  if (hasArchive || archiveLoading) return;
  archiveLoading = true;
  const btn = $("b-decade");
  btn.textContent = "Loading…";
  btn.disabled = true;
  try {
    const res = await fetch(manifest.parquet);   // content-addressed, immutable
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await db.registerFileBuffer(manifest.parquet, new Uint8Array(await res.arrayBuffer()));
    await conn.query(
      `CREATE OR REPLACE VIEW archive AS SELECT ${COLS} FROM read_parquet('${manifest.parquet}')`
    );
    hasArchive = true;
    btn.textContent = `Decade loaded · ${commas(manifest.event_count)}`;
    btn.dataset.loaded = "true";
    $("b-play").disabled = false;
    $("decade-note").innerHTML =
      `Archive merged. In the overlap the live feed wins — USGS revises ` +
      `magnitudes and depths after the fact, so live carries the current value.`;
    await rebuildTimelineFromArchive();
    if (!quiet) await refresh();
  } catch (e) {
    btn.textContent = "Archive unavailable";
    $("decade-note").textContent = `Could not load ${manifest.parquet}: ${e.message}`;
  } finally {
    btn.disabled = hasArchive;
    archiveLoading = false;
  }
}

let majorsError = null;
async function loadMajors() {
  try {
    const res = await fetch(manifest.majors);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await db.registerFileBuffer(manifest.majors, new Uint8Array(await res.arrayBuffer()));
    await conn.query(
      `CREATE OR REPLACE VIEW majors AS SELECT * FROM read_parquet('${manifest.majors}')`
    );
    majorsError = null;
  } catch (e) {
    // The map works without them, but failing silently made a broken layer
    // look like an empty one. Say so instead.
    majorsError = e.message;
    console.error("majors layer:", e);
    $("b-majors").textContent = "Majors failed";
  }
}

// ---- copy, staleness -----------------------------------------------------
function applyCopy() {
  // Derived from the data, not hardcoded — "past decade" drifts every build.
  const a = new Date(manifest.coverage_start), b = new Date(manifest.coverage_end);
  const yrs = ((b - a) / (365.25 * 864e5)).toFixed(0);
  $("eyebrow").textContent =
    `USGS ANSS · ${a.getUTCFullYear()}–${b.getUTCFullYear()} · Queried client-side`;
  $("standfirst").innerHTML =
    `Every earthquake on Earth above <b style="color:#e4e9f2">M${manifest.min_magnitude}</b> — ` +
    `live right now, and ${yrs} years back. Nobody drew the plate boundaries ` +
    `on this map; the earthquakes did.`;
  $("decade-note").innerHTML =
    `${commas(manifest.event_count)} events, ` +
    `${(manifest.bytes / 1e6).toFixed(1)} MB, fetched once and queried in the browser. ` +
    `The live view above needs none of it.`;
  $("b-decade").textContent = `Show the full decade — ${commas(manifest.event_count)}`;
}

function applyStaleness() {
  const end = new Date(manifest.coverage_end);
  const days = (Date.now() - end) / 864e5;
  const through = end.toUTCString().slice(5, 16);
  $("footer-text").textContent = `Archive current through ${through}.`;
  $("footer-amber").style.display = days >= 25 ? "block" : "none";
  if (days > 30) {
    const gapStart = end, gapEnd = new Date(Date.now() - 30 * 864e5);
    showBanner(
      `Historical data is stale. Events between ${gapStart.toUTCString().slice(5, 16)} ` +
      `and ${gapEnd.toUTCString().slice(5, 16)} are missing from this map.`
    );
    // Mark the uncovered stretch so it is never drawn as a flat run of bars.
    // A flat stretch in a seismic timeline reads as quiet, which is the
    // worst available failure mode for this dataset.
    for (let d = new Date(gapStart); d <= gapEnd; d.setUTCMonth(d.getUTCMonth() + 1))
      gapMonths.add(d.toISOString().slice(0, 7));
  }
}

function showBanner(text) {
  const b = $("banner");
  b.textContent = text;
  b.style.display = "block";
}

// ---- timeline ------------------------------------------------------------
function markLiveMonths() {
  liveMonths = new Set(
    liveFeatures.map((f) => new Date(f.properties.time).toISOString().slice(0, 7))
  );
}

// First paint: the histogram comes from the manifest, so the decade's shape
// is visible before anyone commits to downloading it.
function buildTimelineFromManifest() {
  const m = manifest.monthly || {};
  monthKeys = Object.keys(m).sort();
  monthCounts = monthKeys.map((k) => m[k]);
  renderBars();
  $("tl-lab").textContent = `Events per month · M${manifest.min_magnitude}+ · from manifest`;
}

// Once the archive is in, recompute so the histogram tracks the magnitude
// slider instead of being frozen at the archive's own floor.
async function rebuildTimelineFromArchive() {
  const r = await conn.query(`
    SELECT strftime(TIME, '%Y-%m') AS m, count(*) AS n
    FROM ${timelineSource()} WHERE MAG >= ${state.minMag}
    GROUP BY 1 ORDER BY 1`);
  monthKeys = []; monthCounts = [];
  for (let i = 0; i < r.numRows; i++) {
    const row = r.get(i);
    monthKeys.push(row.m);
    monthCounts.push(Number(row.n));
  }
  renderBars();
  $("tl-lab").textContent = `Events per month · M${state.minMag.toFixed(1)}+`;
}

function renderBars() {
  const nowKey = new Date().toISOString().slice(0, 7);
  const max = Math.max(1, ...monthCounts);
  const bars = $("bars");
  bars.innerHTML = "";
  monthKeys.forEach((m, i) => {
    const b = document.createElement("div");
    const gap = gapMonths.has(m);
    b.className = "bar" + (gap ? " gap" : m === nowKey ? " partial" : "")
                + (liveMonths.has(m) && !hasArchive ? " live" : "");
    b.style.height = Math.max(2, (monthCounts[i] / max) * 100) + "%";
    b.title = gap
      ? `${monthLabel(m)} · not covered — archive is stale`
      : `${monthLabel(m)} · ${commas(monthCounts[i])} events`
        + (m === nowKey ? " · month in progress" : "");
    b.onclick = () => pickMonth(m);
    bars.appendChild(b);
  });
  const yrs = [...new Set(monthKeys.map((k) => k.slice(0, 4)))];
  $("tl-axis").innerHTML = yrs.filter((_, i) => i % 2 === 0).map((y) => `<span>${y}</span>`).join("");
  drawBarState();
}

function drawBarState() {
  const bars = $("bars").children;
  for (let i = 0; i < bars.length; i++)
    bars[i].classList.toggle("on", state.month === monthKeys[i]);
  $("tl-when").textContent = state.month
    ? monthLabel(state.month)
    : hasArchive
      ? `${monthLabel(monthKeys[0])} – ${monthLabel(monthKeys.at(-1))}`
      : `Past ${WINDOWS[state.window].label.toLowerCase()}`;
  // The clear control appears beside the filter it clears, and the rail
  // button lights up when there is something to clear rather than dimming.
  $("tl-clear").hidden = !state.month;
  $("b-all").disabled = !state.month;
  $("b-all").setAttribute("aria-pressed", String(!!state.month));
}

// Clicking a bar before the archive exists is the other natural way in.
async function pickMonth(m) {
  if (!hasArchive) { await loadArchive(); }
  state.month = state.month === m ? null : m;
  if (state.month) state.window = "all";     // a month overrides the rolling window
  $("windows").querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-pressed", String(!state.month && b.dataset.win === state.window)));
  $("win-sel").textContent = monthLabel(state.month);
  await refresh();
}

// ---- deck ---------------------------------------------------------------
async function initDeck() {
  const { DeckGL, GeoJsonLayer } = deck;
  zoomNow = viewFor(state.view).zoom;
  deckgl = new DeckGL({
    container: "map",
    initialViewState: viewFor(state.view),
    controller: true,
    layers: [],
    getTooltip: null,
    // Which labels and border levels belong on screen is a function of zoom,
    // so the view has to be able to trigger a redraw. Redrawing on every
    // frame of a pan would be wasteful, so redraw only when the set of things
    // that would render actually changes.
    onViewStateChange: ({ viewState }) => {
      zoomNow = viewState.zoom;
      const sig = contextSignature(zoomNow);
      if (sig === contextSig) return;
      contextSig = sig;
      draw();
    },
  });
  // Flat land polygons instead of raster tiles: exact control over the
  // land/ocean contrast, real coastlines, and one less network dependency.
  try {
    const land = await (await fetch(manifest.land || "land.geojson")).json();
    landLayer = new GeoJsonLayer({
      id: "land", data: land,
      filled: true, stroked: true,
      getFillColor: [26, 35, 51],
      getLineColor: [45, 58, 82],
      getLineWidth: 1, lineWidthUnits: "pixels", lineWidthMinPixels: 0.6,
      pickable: false,
    });
  } catch { landLayer = null; }

  // Borders and labels are context, not data — a failure to load them should
  // cost the map its place names, not its earthquakes.
  try {
    const bg = await (await fetch(manifest.borders || "borders.geojson")).json();
    const byLevel = (lvl) => ({
      type: "FeatureCollection",
      features: bg.features.filter((f) => f.properties.lvl === lvl),
    });
    borders0 = byLevel(0);
    borders1 = byLevel(1);
  } catch { borders0 = borders1 = null; }

  try {
    placeLabels = await (await fetch(manifest.labels || "labels.json")).json();
  } catch { placeLabels = null; }

  contextSig = contextSignature(zoomNow);
}

// ---- the hot path --------------------------------------------------------
async function refresh() {
  const t0 = performance.now();
  const src = source();
  // One query feeds both the GPU buffers and picking. Two queries with the
  // same WHERE but no ORDER BY are not guaranteed to return rows in the
  // same order, which would make a hover resolve to the wrong event.
  const [pts, stats, maj] = await Promise.all([
    conn.query(`SELECT ${COLS}, epoch_ms(TIME) AS T_MS
                FROM ${src} ${where()} ORDER BY TIME`),
    conn.query(`SELECT count(*) AS n, max(MAG) AS mx, max(DEPTH_KM) AS deep,
                       sum(FELT) AS felt
                FROM ${src} ${where()}`),
    majorFloor() !== null
      ? conn.query(`SELECT LONGITUDE, LATITUDE, MAG, DEPTH_KM, PLACE, YEAR
                    FROM majors WHERE MAG >= ${majorFloor()} ORDER BY MAG DESC`)
          .catch((e) => { majorsError = e.message; console.error("majors query:", e); return null; })
      : null,
  ]);
  // Same table retained for picking — binary attributes hand back an index
  // and nothing else, so the row has to be resolved from here.
  rows = pts;
  const qMs = performance.now() - t0;

  const n = pts.numRows;
  const lon = pts.getChild("LONGITUDE").toArray();
  const lat = pts.getChild("LATITUDE").toArray();
  const mag = pts.getChild("MAG").toArray();
  const dep = pts.getChild("DEPTH_KM").toArray();
  const tms = pts.getChild("T_MS").toArray();

  const positions = new Float32Array(n * 2);
  const colors = new Uint8Array(n * 4);      // RGBA — alpha is animated
  const radii = new Float32Array(n);
  const times = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    positions[i * 2] = lon[i];
    positions[i * 2 + 1] = lat[i];
    const c = depthColor(dep[i]);
    colors[i * 4] = c[0]; colors[i * 4 + 1] = c[1];
    colors[i * 4 + 2] = c[2]; colors[i * 4 + 3] = 255;
    radii[i] = MAG_R(mag[i]);
    times[i] = Number(tms[i]);
  }
  const buildMs = performance.now() - t0 - qMs;
  gpu = { n, positions, colors, radii, times };
  // The sweep works on whatever is loaded — the tail scales to the range,
  // so the live-only window animates as readably as the full decade.
  $("b-play").disabled = n < 2;

  majorsRows = [];
  if (maj) {
    for (let i = 0; i < maj.numRows; i++) {
      const r = maj.get(i);
      majorsRows.push({
        position: [Number(r.LONGITUDE), Number(r.LATITUDE)],
        mag: Number(r.MAG), depth: Number(r.DEPTH_KM),
        place: r.PLACE, year: Number(r.YEAR),
      });
    }
  }

  const s = stats.get(0);
  const total = Number(s.n);
  $("s-n").textContent = fmt(total);
  $("s-max").textContent = total ? "M" + Number(s.mx).toFixed(1) : "—";
  $("s-deep").textContent = total ? Math.round(Number(s.deep)) : "—";
  $("s-felt").textContent = total ? fmt(Number(s.felt || 0)) : "—";

  $("perf").innerHTML =
    `<b>${fmt(n)}</b> events · ` +
    (majorsError ? `<span style="color:#ff5f4a">majors: ${majorsError}</span>`
                 : `<b>${majorsRows.length}</b> majors`) +
    ` · ${hasArchive ? "archive + live" : "live only"}<br/>` +
    `query <b>${qMs.toFixed(0)}ms</b> · buffers <b>${buildMs.toFixed(0)}ms</b><br/>` +
    `archive requests since load: <b>${hasArchive ? 1 : 0}</b> · live poll 60s`;

  draw();
  drawBarState();
}

// Additive blending trades per-point visibility for density. At 86k events
// low alpha is essential — thousands of points accumulate into brightness.
// At five events nothing accumulates, and an energy-scaled M2.0 is 4.7 km,
// which is a fifth of a pixel at world zoom. So both alpha and the pixel
// floor have to scale with how much is actually on screen.
function renderScale(n) {
  if (n > 20000) return { opacity: 0.18, minPx: 0.8 };
  if (n > 2000)  return { opacity: 0.34, minPx: 1.3 };
  if (n > 200)   return { opacity: 0.6,  minPx: 2.2 };
  if (n > 20)    return { opacity: 0.85, minPx: 3 };
  return { opacity: 1, minPx: 4 };
}

// The legend is drawn from MAG_R and the same pixel floor the layer uses, so
// a swatch is the size the map actually renders — not an approximation of it.
function renderLegendMags(minPx) {
  const el = $("lg-mags");
  if (!el) return;
  el.innerHTML = LEGEND_MAGS.map((m) => {
    const d = Math.round(Math.max(minPx, MAG_R(m)) * 2);
    return `<div class="lg-mag"><i style="width:${d}px;height:${d}px"></i>` +
           `<span>M${m}</span></div>`;
  }).join("");
  $("lg-magcap").innerHTML =
    `Drawn at a fixed pixel size, so these hold at every zoom. ` +
    (minPx > MAG_R(LEGEND_MAGS[0])
      ? `Sparse views raise a ${minPx}px floor, so the smallest are levelled up.`
      : `Monotonic in energy, compressed to stay legible.`);
}

function draw(alphaOverride) {
  const { ScatterplotLayer, GeoJsonLayer, TextLayer } = deck;
  const layers = [];
  if (landLayer) layers.push(landLayer);

  // Borders sit between the land silhouette and the events, and are kept
  // dimmer than the coastline on purpose. The premise of the map is that the
  // earthquakes draw the plate boundaries; political lines are here to answer
  // "which state is that", not to compete for attention.
  if (borders0) {
    layers.push(new GeoJsonLayer({
      id: "borders-0", data: borders0,
      stroked: true, filled: false,
      getLineColor: [62, 78, 106, 210],
      getLineWidth: 1, lineWidthUnits: "pixels", lineWidthMinPixels: 0.7,
      pickable: false,
    }));
  }
  if (borders1 && zoomNow >= STATE_LINE_ZOOM) {
    layers.push(new GeoJsonLayer({
      id: "borders-1", data: borders1,
      stroked: true, filled: false,
      getLineColor: [48, 62, 88, 190],
      getLineWidth: 1, lineWidthUnits: "pixels", lineWidthMinPixels: 0.5,
      pickable: false,
    }));
  }

  const scale = renderScale(gpu ? gpu.n : 0);
  renderLegendMags(scale.minPx);

  if (gpu && gpu.n) {
    layers.push(new ScatterplotLayer({
      id: "events",
      data: { length: gpu.n, attributes: {
        getPosition: { value: gpu.positions, size: 2 },
        getFillColor: { value: alphaOverride || gpu.colors, size: 4 },
        getRadius: { value: gpu.radii, size: 1 },
      }},
      // Additive blending: overlapping events brighten rather than stack
      // opaquely, so density reads as luminance. Note this also makes draw
      // order irrelevant — additive is commutative — which is why there is
      // no depth sort here.
      parameters: {
        blendColorOperation: "add",
        blendColorSrcFactor: "src-alpha",
        blendColorDstFactor: "one",
        blendAlphaOperation: "add",
        blendAlphaSrcFactor: "one",
        blendAlphaDstFactor: "one",
        depthCompare: "always",
      },
      radiusUnits: "pixels",
      radiusMinPixels: scale.minPx,
      radiusMaxPixels: 60,
      opacity: scale.opacity,
      stroked: false,
      pickable: true,
      onHover: onEventHover,
      onClick: onEventClick,
      updateTriggers: { getFillColor: alphaOverride ? Math.random() : 0 },
    }));
  }

  if (majorsRows.length) {
    layers.push(new ScatterplotLayer({
      id: "majors",
      data: majorsRows,
      getPosition: (d) => d.position,
      getRadius: (d) => 5 + (d.mag - 7) * 6,
      radiusUnits: "pixels",
      radiusMinPixels: 2,
      filled: false, stroked: true,
      getLineColor: [226, 233, 245, 150],
      getLineWidth: 1, lineWidthUnits: "pixels",
      pickable: true,
      onHover: (info) => tipHTML(info, (d) =>
        `<div class="place">${d.place}</div><b>M${d.mag.toFixed(1)}</b> · ${d.year} · ` +
        `${Math.round(d.depth)} km`),
    }));
  }
  // Past-hour events ring on top in every window — including the Hour
  // window itself, where the energy-scaled points are sub-pixel and the
  // ring is the only thing that makes them findable.
  if (hourFeatures.length) {
    layers.push(new ScatterplotLayer({
      id: "past-hour",
      data: hourFeatures,
      getPosition: (f) => [f.geometry.coordinates[0], f.geometry.coordinates[1]],
      getRadius: (f) => Math.max(7, 5 + (f.properties.mag ?? 0) * 2),
      radiusUnits: "pixels",
      filled: false, stroked: true,
      getLineColor: [255, 224, 102, 225],
      getLineWidth: 1.5, lineWidthUnits: "pixels",
      pickable: true,
      onHover: (info) => tipHTML(info, (f) => {
        const p = f.properties;
        return `<div class="place">${p.place || "Location pending"}</div>` +
          `<b>M${(p.mag ?? 0).toFixed(1)}</b> · ${Math.round(f.geometry.coordinates[2] ?? 0)} km deep<br/>` +
          `<span class="felt">${Math.round((Date.now() - p.time) / 6e4)} minutes ago</span>`;
      }),
    }));
  }

  // Labels last so nothing paints over them. Natural Earth ships a min/max
  // zoom per name, so what shows at a given zoom is a cartographer's call
  // rather than a threshold guessed here — country names at world zoom,
  // states and provinces once the frame is regional.
  if (placeLabels) {
    const visible = placeLabels.filter((l) => labelVisible(l, zoomNow));
    if (visible.length) {
      layers.push(new TextLayer({
        id: "labels", data: visible,
        getPosition: (l) => l.p,
        // Country names in caps, states in title case: hierarchy that survives
        // being dimmed, which size and colour alone would not.
        getText: (l) => (l.lvl === 0 ? l.n.toUpperCase() : l.n),
        getSize: (l) => (l.lvl === 0 ? 11.5 : 10),
        getColor: (l) => (l.lvl === 0 ? [166, 181, 207, 235] : [124, 140, 168, 225]),
        sizeUnits: "pixels",
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        fontWeight: 500,
        characterSet: "auto",
        // An SDF halo in the ocean colour keeps names readable over the bright
        // additive pileups without boxing them in.
        fontSettings: { sdf: true, buffer: 8, radius: 12 },
        outlineWidth: 3,
        outlineColor: [11, 18, 32, 235],
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        pickable: false,
        // Natural Earth's anchors are per-country, not per-frame, so at some
        // zooms neighbours still land on top of each other (Israel over
        // Jordan). CollisionFilterExtension is the documented fix and ships in
        // this bundle, but wiring it to this layer changed nothing on screen,
        // so it is left out rather than carried as a dead render pass.
        updateTriggers: { getText: visible.length, getSize: visible.length },
      }));
    }
  }

  deckgl.setProps({ layers });
}

// ---- tooltips ------------------------------------------------------------
const ALERT_COLOR = { green: "#3ec88a", yellow: "#ffe066", orange: "#ff9f45", red: "#ff5f4a" };

function tipHTML({ x, y, object }, render) {
  const el = $("tip");
  if (!object) { el.style.display = "none"; return; }
  el.style.display = "block";
  el.style.left = Math.min(x + 16, innerWidth - 312) + "px";
  el.style.top = Math.min(y + 16, innerHeight - 150) + "px";
  el.innerHTML = render(object);
}

function onEventHover({ index, x, y }) {
  const el = $("tip");
  if (index < 0 || !rows) { el.style.display = "none"; return; }
  const r = rows.get(index);
  if (!r) { el.style.display = "none"; return; }
  const when = new Date(Number(r.TIME));
  const felt = Number(r.FELT || 0);
  const alert = String(r.ALERT || "");
  // felt / cdi / mmi / alert are null for most events — the ocean files no
  // Did You Feel It reports — so every enriched row is optional.
  let html =
    `<div class="place">${r.PLACE || "Location pending"}</div>` +
    `<b>M${Number(r.MAG).toFixed(1)}</b>${r.MAG_TYPE ? ` <span style="color:#55637d">${r.MAG_TYPE}</span>` : ""}` +
    ` · ${Math.round(Number(r.DEPTH_KM))} km deep<br/>` +
    `${when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  if (felt > 0) html += `<br/><span class="felt">${commas(felt)} people reported feeling this</span>`;
  if (Number(r.TSUNAMI)) html += `<br/><span class="felt">Tsunami evaluated</span>`;
  if (alert) html += `<br/><span class="chip" style="background:${ALERT_COLOR[alert] || "#7c8ca8"}">PAGER ${alert}</span>`;
  html += `<br/><span class="hint">Click for the USGS event page</span>`;
  el.style.display = "block";
  el.style.left = Math.min(x + 16, innerWidth - 312) + "px";
  el.style.top = Math.min(y + 16, innerHeight - 170) + "px";
  el.innerHTML = html;
}

function onEventClick({ index }) {
  if (index < 0 || !rows) return;
  const r = rows.get(index);
  if (r && r.ID) window.open(EVENT_PAGE + r.ID, "_blank", "noopener");
}

// ---- animation: continuous cursor with a decay tail ----------------------
const SWEEP_MS = 40_000;
// The tail has to be a fraction of the range being swept, not a fixed
// duration. A flat 30-day tail equals the whole live window (and any single
// selected month), so alpha decays from 1 to 0 across the entire sweep and
// nothing ever visibly fades. 4% of the range keeps events on screen for
// roughly 1.5s of a 40s pass at any zoom level of time.
const TAIL_FRACTION = 0.04;
const TAIL_MIN = 36e5;          // 1 hour
const TAIL_MAX = 30 * 864e5;    // 30 days — the ceiling REVISIONS.md asked for
const tailFor = (range) =>
  Math.min(TAIL_MAX, Math.max(TAIL_MIN, range * TAIL_FRACTION));

const humanDur = (ms) =>
  ms >= 864e5 ? `${(ms / 864e5).toFixed(ms < 8.64e5 * 10 ? 1 : 0)}d`
  : ms >= 36e5 ? `${(ms / 36e5).toFixed(1)}h`
  : `${Math.round(ms / 6e4)}m`;

function stopAnim() {
  if (anim) cancelAnimationFrame(anim.raf);
  anim = null;
  $("cursor").style.display = "none";
  $("b-play").setAttribute("aria-pressed", "false");
  $("b-play").textContent = "Play";
  $("tl-lab").textContent = hasArchive
    ? `Events per month · M${state.minMag.toFixed(1)}+`
    : `Events per month · M${manifest.min_magnitude}+ · from manifest`;
  drawBarState();
  draw();
}

function startAnim() {
  if (!gpu || !gpu.n) return;
  const t0 = gpu.times[0], t1 = gpu.times[gpu.n - 1];
  if (!(t1 > t0)) return;
  $("b-play").setAttribute("aria-pressed", "true");
  $("b-play").textContent = "Stop";
  $("cursor").style.display = "block";
  const buf = new Uint8Array(gpu.colors);
  const started = performance.now();
  const tail = tailFor(t1 - t0);
  $("tl-lab").textContent = `Sweeping · ${humanDur(tail)} decay tail`;

  const frame = (now) => {
    const p = ((now - started) % SWEEP_MS) / SWEEP_MS;
    const cursor = t0 + (t1 - t0) * p;
    // Alpha falls from 1 at the event's timestamp to 0 over the tail, so
    // events flash and fade rather than accumulating.
    for (let i = 0; i < gpu.n; i++) {
      const age = cursor - gpu.times[i];
      buf[i * 4 + 3] = age < 0 ? 0 : age > tail ? 0 : 255 * (1 - age / tail);
    }
    // A fresh view each frame so deck.gl re-uploads; ~4n bytes, which at
    // this scale is cheaper than a shader extension would be to maintain.
    draw(buf.slice());
    const box = $("timeline").getBoundingClientRect();
    $("cursor").style.left = (30 + p * (box.width - 60)) + "px";
    $("tl-when").textContent = new Date(cursor).toISOString().slice(0, 10);
    anim = { raf: requestAnimationFrame(frame) };
  };
  anim = { raf: requestAnimationFrame(frame) };
}

// ---- controls ------------------------------------------------------------
$("depth").querySelectorAll("div").forEach((el) => {
  const pick = async () => {
    const lo = +el.dataset.lo, hi = +el.dataset.hi;
    const same = state.depth && state.depth.lo === lo;
    state.depth = same ? null : { lo, hi };
    $("depth").querySelectorAll("div").forEach((d) => {
      const on = !state.depth || +d.dataset.lo === state.depth.lo;
      d.classList.toggle("dim", !on);
      d.setAttribute("aria-pressed", String(!!state.depth && +d.dataset.lo === state.depth.lo));
    });
    $("depth-sel").textContent = state.depth
      ? `${state.depth.lo}–${state.depth.hi === 1000 ? "700+" : state.depth.hi} km` : "";
    await refresh();
  };
  el.onclick = pick;
  el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
});

$("mag").oninput = (e) => {
  state.minMag = +e.target.value;
  $("magval").textContent = "M" + state.minMag.toFixed(1);
};
$("mag").onchange = async () => {
  await refresh();
  if (hasArchive) await rebuildTimelineFromArchive();
};

function flyTo(v) {
  state.view = v;
  for (const [k, id] of [["world","b-world"],["ring","b-ring"],["ca","b-ca"]])
    $(id).setAttribute("aria-pressed", String(k === v));
  deckgl.setProps({ initialViewState: { ...viewFor(v), transitionDuration: 900 } });
}
$("b-world").onclick = () => flyTo("world");
$("b-ring").onclick = () => flyTo("ring");
$("b-ca").onclick = () => flyTo("ca");

// One path for every way of clearing: the chip on the timeline, the rail
// button, Escape, or clicking the highlighted bar again.
async function clearMonth() {
  if (!state.month) return;
  state.month = null;
  $("windows").querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.win === state.window)));
  $("win-sel").textContent = state.window === "all"
    ? "" : `last ${WINDOWS[state.window].label.toLowerCase()}`;
  await refresh();
}

$("b-all").onclick = clearMonth;
$("tl-clear").onclick = clearMonth;
addEventListener("keydown", (e) => { if (e.key === "Escape") clearMonth(); });

$("b-decade").onclick = async () => { await loadArchive(); await setWindow("all"); };

async function setWindow(w) {
  if (w === "all" && !hasArchive) await loadArchive(true);
  state.window = w;
  state.month = null;                       // a rolling window replaces a picked month
  $("windows").querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.win === w)));
  $("win-sel").textContent = w === "all" ? "" : `last ${WINDOWS[w].label.toLowerCase()}`;
  $("win-note").innerHTML = w === "hour"
    ? `Past hour is the <b>all-magnitude</b> feed — the floor below does not apply. ` +
      `M4.5+ averages well under one per hour worldwide, so an M4.5 hour view ` +
      `would usually be empty.`
    : w === "all"
      ? `The whole archive. Every earthquake above M${state.minMag.toFixed(1)} since ` +
        `${new Date(manifest.coverage_start).getUTCFullYear()}.`
      : `Rolling window from the live feed, floored at M${state.minMag.toFixed(1)}.`;
  await refresh();
}

$("windows").querySelectorAll("button").forEach((b) => {
  b.onclick = () => setWindow(b.dataset.win);
});

// The ticker is the most arresting number on the page; make it the shortcut
// to the thing it counts.
$("live").style.cursor = "pointer";
$("live").setAttribute("role", "button");
$("live").setAttribute("tabindex", "0");
$("live").onclick = () => setWindow("hour");
$("live").onkeydown = (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setWindow("hour"); }
};

function applyMajorStep() {
  const step = MAJOR_STEPS[state.majorStep];
  $("b-majors").textContent = step.label;
  $("b-majors").setAttribute("aria-pressed", String(step.floor !== null));
  if (step.floor === null) $("tip").style.display = "none";
}
$("b-majors").onclick = async () => {
  state.majorStep = (state.majorStep + 1) % MAJOR_STEPS.length;
  applyMajorStep();
  await refresh();
};

// Reduced motion gets discrete month stepping instead of a continuous
// sweep — the scrubber still works, nothing moves on its own.
$("b-play").onclick = () => {
  if (anim) { stopAnim(); return; }
  if (REDUCED) {
    let i = state.month ? monthKeys.indexOf(state.month) : -1;
    i = (i + 1) % monthKeys.length;
    pickMonth(monthKeys[i]);
    return;
  }
  startAnim();
};

// ---- legend --------------------------------------------------------------
// Preference persists — "hide legend" should stay hidden on the next visit
// rather than reappearing every load.
const LEGEND_KEY = "tremor.legend";
function setLegend(on, persist = true) {
  $("legend").hidden = !on;
  $("legend-show").hidden = on;      // collapsed handle takes its place
  $("b-legend").setAttribute("aria-pressed", String(on));
  if (persist) { try { localStorage.setItem(LEGEND_KEY, on ? "1" : "0"); } catch {} }
}
let legendOn = true;
try { legendOn = localStorage.getItem(LEGEND_KEY) !== "0"; } catch {}
setLegend(legendOn, false);

$("b-legend").onclick = () => setLegend($("legend").hidden);
$("lg-close").onclick = () => setLegend(false);
$("legend-show").onclick = () => setLegend(true);
addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "l" || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  setLegend($("legend").hidden);
});

applyMajorStep();
init();
