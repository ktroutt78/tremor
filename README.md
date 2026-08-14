# Tremor

A decade of global earthquakes, queried in your browser. No server, no
warehouse, no BI license — the Parquet file is a static asset and every query
runs client-side in DuckDB-WASM.

Live at **https://tremor.keithtroutt.com**

## What's here

| file | role |
|---|---|
| `index.html` | markup + styles |
| `app.js` | the whole application (DuckDB-WASM, deck.gl, timeline, tooltips) |
| `manifest.json` | names the current Parquet, carries the monthly histogram |
| `quakes-YYYY-MM-DD.parquet` | global M4.5+ since 2015 — the decade archive |
| `majors-YYYY-MM-DD.parquet` | global M7+ since 1900 — the great earthquakes |
| `land.geojson` | Natural Earth 1:50m land polygons (the basemap) |
| `borders.geojson` | country and state/province lines, one MultiLineString per level |
| `labels.json` | place names + the zoom range Natural Earth recommends for each |
| `prepare_quakes.py` | builds both Parquets + the manifest from USGS ComCat |
| `prepare_land.py` | builds `land.geojson`; static, run once |
| `prepare_borders.py` | builds `borders.geojson` + `labels.json`; static, run once |

`DATA-TIERS.md` documents the freshness contract between the archive and the
live feeds. `REVISIONS.md` is the build spec the current version was cut to.

## Run it

    python3 -m http.server 8080

Open http://localhost:8080. It has to be HTTP — `file://` will not start the
WASM worker.

## Data

The archive is rebuilt weekly by `.github/workflows/refresh-archive.yml`
(Mondays 06:00 UTC, plus manual dispatch). `prepare_quakes.py` writes a new
date-stamped pair, rewrites `manifest.json`, and prunes to the newest three of
each — so a browser holding a manifest up to two refreshes old still resolves
to a file that exists.

The M4.5 floor is deliberate: USGS coverage is globally complete at about that
magnitude. Below it, point density tracks where the instruments are more than
where the earthquakes are.

Source: USGS Advanced National Seismic System (ANSS) Comprehensive Catalog via
the FDSN event service, plus the past-hour and past-month live feeds.
Coastlines: Natural Earth 1:50m.

## Caching

`netlify.toml` is load-bearing. Netlify defaults to `max-age=0,
must-revalidate` on everything, which would make the immutable-Parquet design
inert. `manifest.json` is `no-cache`; the date-stamped Parquets are
`immutable` for a year.

    curl -sI https://tremor.keithtroutt.com/manifest.json | grep -i cache-control
