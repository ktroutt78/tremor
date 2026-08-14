# Tremor — revision spec

Fixes for overplotting, basemap legibility, layout, and three new features.
Work in this order; the first item resolves most of the visual problems.

---

## 1. Default to the last 30 days, not the full decade

The root cause of the overplotting. 86K events painted at once saturates the
Ring of Fire into a solid stroke, hides the basemap, and buries the depth
encoding under shallow events.

- On load: time window = last 30 days, sourced from the live feed.
- The decade archive loads in the background and becomes available when the
  user drags the timeline or clicks a month.
- Rail headline stat becomes the live count. It's the most arresting number
  on the screen and it's currently in a small box.
- Keep the full-decade view one click away — it should feel like a reveal.

## 2. Fix the point rendering

**Sort by depth descending before building buffers** so deep (cyan) events
draw on top of shallow (red). Shallow events are ~90% of the catalog and
currently bury the subduction signal.

```js
// after the query, before filling typed arrays
ORDER BY depth DESC
```

**Additive blending** — overlapping events brighten instead of stacking
opaquely, so density reads as luminance and the basemap survives:

```js
new ScatterplotLayer({
  parameters: { blendFunc: [770, 1], depthTest: false },  // SRC_ALPHA, ONE
  opacity: 0.18,
  radiusMinPixels: 0.8,
  radiusMaxPixels: 60,
})
```

**Radius should scale with energy, not magnitude.** Seismic energy goes as
10^(1.5M), so linear-on-magnitude undersells large events badly:

```js
radii[i] = Math.pow(10, mag[i] * 0.36) * 900;
```

Tune the constants against the M8.8 until it reads right.

## 3. Basemap legibility

- Raise basemap opacity from 0.62 to 1.0.
- Land should sit slightly lighter than ocean so continents read as
  silhouettes behind the data. If the CARTO dark style won't give that,
  try `dark_nolabels` at full opacity over a slightly lighter ground,
  or composite a solid land polygon layer underneath.
- Coastlines matter here — the story is where quakes sit relative to land.

## 4. Layout

- Rail: 332px → 420px.
- Initial view: `{ longitude: -40, latitude: 12, zoom: 1.9 }` — kills the
  dead Pacific on the right and fills the frame with landmass.
- Timeline stays bottom-right, but give it the extra width.

## 5. Tooltips — the source is richer than it looks

USGS ComCat carries these per event. Pull them into the Parquet and the
live feed:

| field | use |
|---|---|
| `place` | human-readable, e.g. "112 km SSW of Adak, Alaska" — lead with it |
| `mag`, `magType` | magnitude and scale used |
| `depth` | km |
| `time` | epoch ms |
| `felt` | count of Did You Feel It reports — **the humanizing number** |
| `cdi`, `mmi` | community and instrumental shaking intensity |
| `alert` | PAGER level: green / yellow / orange / red |
| `tsunami` | 0/1 flag |
| `sig` | USGS significance score, good for "notable events" filtering |
| `url` | event page — make the tooltip click through |

Tooltip layout: place as the header, then magnitude + depth + local time,
then `felt` if non-null ("1,847 people reported feeling this"), then an
alert chip if `alert` is set. Click opens the USGS page in a new tab.

Note `felt`, `cdi`, `mmi`, and `alert` are frequently null — most events
are offshore and unfelt. Design the tooltip to collapse gracefully.

## 6. Animation mode

Not month-by-month stepping. A continuous time cursor with a decay tail:

- Cursor sweeps the selected range over ~40 seconds.
- Each event is drawn with alpha falling from 1.0 at its timestamp to 0
  over a ~30-day tail, so quakes flash and fade.
- Implement in the shader path if possible: pass `time` as an attribute
  and compute alpha from a `currentTime` uniform, so the GPU does the
  work and you're not rebuilding buffers each frame. If that's too much,
  rebuild the color buffer per frame — at a few thousand points in the
  30-day window it's cheap.
- Respect `prefers-reduced-motion`: no autoplay, offer the scrubber.

This is the shareable asset. Record it for the post.

## 7. Copy fix

The standfirst says "past decade"; the timeline reads 2015–2026. Pick one
and make them agree.
