# Handoff — basemap / label work

**Shipped 2026-08-19.** Everything described below is committed and live on
tremor.keithtroutt.com. Kept for the dead-ends section, which is the part worth
not rediscovering.

---

## The one thing that would help most

Every change here is visual and the agent making them cannot see the rendered
output. Each iteration was: change → wait for a screenshot → find out it was
wrong. Several fixes made things worse before getting better, and two whole
rounds were spent tuning lighting on a mesh that could never have rendered.

**A headless screenshot script — Playwright against localhost, save PNGs at a
few zooms, agent reads them — would collapse a five-round loop into one.**
Do this before any further visual work.

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

1. The hillshade, unverified (above).
2. **Land/water luminance is inverted between the two basemaps.** CARTO
   DarkMatter draws land darker than water; the Natural Earth silhouette does
   the opposite, so they swap relative brightness across the crossfade.
   Making them agree is a look decision nobody has made yet.

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
4. The screenshot harness this file asked for exists now — drive the app at a
   set of zooms and save PNGs, rather than changing and hoping.

## Local dev

A **no-cache** server matters — a cached `manifest.json` or Parquet pins you to
stale data and looks like an app bug.
