# Handoff — basemap / label work

**Shipped 2026-08-19.** Everything described below is committed and live on
tremor.keithtroutt.com. Kept for the dead-ends section, which is the part worth
not rediscovering.

---

## The screenshot harness exists — use it

This file used to open by asking for one. `shoot.mjs` is it.

    npm install && npx playwright install chromium    # once
    node shoot.mjs                                    # → shots/*.png

It serves the working tree, waits for `#boot` to clear, and shoots six
viewports at 2x, plus the mobile sheet open. `--views` adds the Ring of Fire
and California presets; `--zoom N` wheel-steps out of California to cross the
4.6–6.2 tile crossfade. It exits non-zero if any page logged a console error or
never finished booting, which is the only automated check this project has.

Do not change anything visual without shooting before and after. The loop this
replaced was change → wait for a screenshot → find out it was wrong, and two
whole rounds of it went into lighting a mesh that could never have rendered.

One limit worth knowing: `deckgl` is module-scoped in app.js, so the harness
cannot set a camera directly. `--zoom` steps the mouse wheel and labels the
shots by step count, not by zoom level. Exact zooms need a seam in app.js.

---

## Verified 2026-08-19: the hillshade renders

It was shipped unrendered and has now been checked in a browser at z4.9, z5.6,
z6.7 and z8.6. Relief reads correctly — the Sierra Nevada, Death Valley and the
Grand Canyon are all legible at `HILLSHADE_STRENGTH = 0.35`. Both tile hosts
send `access-control-allow-origin: *`, so the CORS trap that killed terrarium
does not apply. `ERR_ABORTED` on hillshade tiles during a fast zoom is deck
cancelling in-flight requests, not a failure; those URLs return 200 to curl.

## Believed good

- **Magnitude sizing** — linear above a threshold (`MAG_BASE/SLOPE/ZERO`),
  ~3px per whole magnitude. Density scales the whole ramp by a multiplier
  rather than flooring its bottom, which is what previously made M4.5, M5.0
  and M5.5 all render at the same 2.2px.
- **Legend** is generated from the same `MAG_R()` and multiplier the layer
  uses, so it matches by construction. Steps 4/5/6/7/8+.
- **Label decluttering** — a greedy screen-space pass in `declutter()`.
  Projects each candidate, walks in priority order, keeps one only if its box
  is clear. Cities and admin names share one pass so they arbitrate against
  each other. Priority: country 90, city >1M 60, city >200k 35, state 25,
  town 15. City dots still draw for every town; only names compete.
- **Label rendering** — SDF OFF. It renders one atlas at `fontSize` and scales
  it, which is right for text that zooms and wrong for text pinned to 9-12px.
  A 26px atlas lands ~1:1 against a 20-25 physical-pixel target on retina.
  Contrast comes from a background plate because `outlineWidth` is SDF-only.
- **Country labels retire at z4.0** where state labels take over. NE's
  `max_label` is honoured again but is not sufficient alone — the USA's is 5.7.
- **Cities** — `prepare_borders.py` emits `cities.json` (7,342 places, NE
  1:10m, 357 KB), lazily fetched the first time zoom crosses 4, gated on NE's
  own `min_zoom`.
- **World view fits exactly.** It used to zoom out 8% "for margin", and
  `repeat: true` filled that slack with a second copy of the world — Alaska
  appearing twice down both edges, reading as tiled wallpaper.
- **Silhouette crossfades out** as tiles come in (`opacity: 1 - tOp`). Left
  drawing under semi-opaque tiles it bled through as a second, coarser
  coastline offset from the real one — most visible in the Aleutians.
- **Paint order is declared** in `ORDER`, not implied by push position. All
  three seismic layers sit above every basemap and label layer.

## Open

1. **The basemap is flatter than it was, and the hillshade is the reason.**
   Closed the old inversion item and opened this one in its place. CARTO
   started requiring an API key — keyless requests still return 200, with
   "API KEY REQUIRED" painted into the tile, so it degraded into a watermarked
   map with nothing in the console. Esri's World_Dark_Gray_Base replaced it:
   keyless, same host as the hillshade, already in the CSP.

   That fixes the inversion — Esri draws land lighter than water (measured 65
   vs 46), which is the silhouette's own relationship — but it costs relief.
   The dark hillshade paints ocean as a flat 95 against land averaging ~65, so
   it lifts water faster than land. DarkMatter did not care, because it drew
   water lighter anyway. Esri does. Solving for both the silhouette's 17-level
   land/water gap and visible relief wants HILLSHADE_STRENGTH 0.0065, i.e.
   none, so 0.12 is a compromise and the map reads flatter than it did.

   Three ways out, none tried: a CARTO key restores the old look exactly;
   masking the hillshade to land.geojson would free the strength to go back
   up; or a different relief source whose water is dark.

2. **No test covers any of this.** `shoot.mjs` catches a console error or a
   boot that never finishes, which is better than nothing and does not
   distinguish a correct map from a watermarked one. Everything visual is
   still verified by eye — but now against PNGs the harness produces, and
   values sampled out of them with `magick ... -format %[fx:mean]`, rather
   than by guessing.

---

## Dead ends — do not re-attempt blind

**TerrainLayer + AWS terrarium.** `s3.amazonaws.com` sends no
`access-control-allow-origin`. The browser fetches the tile but cannot read it
as data, so the mesh stays flat regardless of lighting or exaggeration. `curl`
returns 200, so a reachability check does not catch this.

**Esri World Hillshade (the light one).** Ocean `#fcfcfc`, land mean 243.
Additive adds ~250 everywhere and the map turns white. Multiply is the right
blend for it, but CARTO's land is `#090909` and 9 x 0.45 is 4 — invisible.
`World_Hillshade_Dark` is the variant that works.

**CollisionFilterExtension.** Tried twice. Without `collisionTestProps` it
silently does nothing; with it, it removed every label on the map rather than
thinning them. Replaced by `declutter()`.

**SDF text at small sizes.** Raising `fontSize` to sharpen it makes it worse.

---

## Deploy notes (done, but true next time too)

1. `cities.json` is committed. It is fetched at runtime, so an untracked copy
   deploys as a 404.
2. `manifest.json` did not name `cities.json` until the Monday refresh
   regenerated it; `manifest.cities || "cities.json"` covered the gap.
3. Push to `main` deploys to tremor.keithtroutt.com via Netlify.
4. `shoot.mjs`, `serve.py`, `package.json` and `node_modules/` are dev tooling.
   The deploy is still every other file, unbuilt and unbundled.

## Local dev

    python3 serve.py        # http://localhost:8080

A **no-cache** server matters — a cached `manifest.json` or Parquet pins you to
stale data and looks like an app bug. `serve.py` suppresses `Last-Modified` as
well as setting `no-store`, because with a validator present the browser still
revalidates and takes a 304.
