# Data tiers, freshness, and caching

Build this before any rendering work. Item 1 of REVISIONS.md depends on it.

Endpoint behavior below was verified against the live USGS feeds, not
inferred from documentation. Where the docs and the headers disagree, the
headers win.

---

## The contract

The `4.5_month` feed always covers `now − 30d → now` (measured: 654 events,
29.9-day span, `access-control-allow-origin: *`). The archive covers
`2015-01-01 → built_at`.

**If `now − built_at < 30d`, the windows overlap and no gap can exist.**

Regenerate weekly. But do not treat that cadence as the safety mechanism —
see *Staleness is the steady state* below.

---

## Caching — read this first, it's where the design was broken

The original spec said `Cache-Control: public, max-age=31536000, immutable`
on the data file. Under weekly regeneration at a fixed filename, that pins
returning visitors to whatever they first downloaded, for a year. The
manifest would report a `coverage_end` for a file the browser never fetches.
The weekly commit and the immutable header cannot both be true.

**Content-address the data file. Let the manifest name it.**

```json
{
  "parquet":        "quakes-2026-08-14.parquet",
  "built_at":       "2026-08-14T06:00:00Z",
  "coverage_start": "2015-01-01T00:00:00Z",
  "coverage_end":   "2026-08-14T05:00:00Z",
  "event_count":    86071,
  "min_magnitude":  4.5,
  "bytes":          2612480,
  "monthly": { "2015-01": 512, "2015-02": 486, "2015-03": 604, "…": 0 },
  "source": "USGS ComCat via fdsnws/event/1"
}
```

`monthly` carries the per-month event counts — 140 integers, about 1 KB.
See *What the timeline draws on first paint* below; it is not optional.

| file | header |
|---|---|
| `quakes-YYYY-MM-DD.parquet` | `public, max-age=31536000, immutable` |
| `manifest.json` | `no-cache` |

Immutable stays valid because the URL changes when the content does.
`manifest.json` is the staleness oracle — if it caches, staleness detection
goes stale. It is the one file where the original caching advice inverts.

The manifest must be written by the same run that writes the Parquet.
Never hand-maintain it; the counts drift between builds.

**Retention: keep 3 Parquets on the host — current plus the previous two.**
In-flight sessions holding an older manifest won't 404. The prune step in
the refresh job uses this same number.

---

## Tier 1 — live (default view)

    https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson

Pre-built, CDN-cached, no key, permissive CORS. ~650 events, 457 KB.

### Polling

Every USGS feed returns `cache-control: public, max-age=60` — including
`4.5_month`. There is no 15-minute TTL; that was wrong. But the cost of
getting it wrong is smaller than it first appears:

| condition | bytes on the wire |
|---|---|
| unconditional, gzip negotiated | **~55 KB** |
| unconditional, uncompressed | 456,368 |
| `If-Modified-Since`, unchanged | 304, 0 bytes |

The feed is 457 KB uncompressed but `vary: Accept-Encoding` is set and
browsers always negotiate gzip, so the real per-poll cost is ~55 KB. At a
60-second cadence that's a few MB an hour with no revalidation at all —
worth fixing, but a nice-to-have rather than an emergency.

**USGS serves no `ETag`** — only `last-modified`. Any `If-None-Match`
logic silently never fires and every poll is a full 200.

The simplest correct version lets HTTP caching do the work and reads the
outcome from the header rather than the status code:

```js
let lastMod = null;
async function pollLive() {
  const res = await fetch(FEED_URL);            // no cache override
  const lm = res.headers.get("last-modified");
  if (lm && lm === lastMod) return null;        // unchanged — skip the re-parse
  lastMod = lm;
  return res.json();
}
```

With `max-age=60` and a 60-second cadence the browser revalidates on its
own, sends `If-Modified-Since`, and takes the 304. You get the bandwidth
win without the bookkeeping.

Do **not** reach for `cache: "no-cache"` here. In that mode the browser
owns revalidation — it attaches its own validators and, on a 304, hands
JavaScript a synthesized 200 with the cached body. `res.status === 304` is
unreachable, so a hand-rolled conditional check never fires. Going fully
manual means `cache: "no-store"` plus your own `If-Modified-Since` header,
which is more code for identical bytes.

Poll every 60s while the tab is visible; pause on `document.hidden` and
refresh once on `visibilitychange`.

### The hourly counter

Source it from `all_hour.geojson` (small) and **label the threshold**. The
rail currently shows an all-magnitude count beside an M4.5+ map — two
different populations on one screen. "8 worldwide, all magnitudes" is both
honest and a livelier number than the M4.5 count, which usually reads 0–2.

### Tier 1 cannot be a single point of failure

First paint currently depends entirely on a third-party feed. On feed
error the result is a blank map — a USGS outage or a corporate proxy turns
the piece into an empty ocean.

**On live-feed failure: load the archive, show its most recent 30 days,
and say so.** "Live feed unreachable — showing archived data through
{coverage_end}." Slower and staler, but it renders.

---

## Tier 2 — archive

    https://earthquake.usgs.gov/fdsnws/event/1/query
      ?format=geojson&starttime=…&endtime=…&minmagnitude=4.5&orderby=time-asc

Year-chunked pagination is safe: the busiest year holds 8,959 events at
M4.5+, well under the 20,000 cap.

At M4.5+ the file is ~2.6 MB, down from 9.8 MB unfiltered. Advertise that
number — a decade of global seismicity in 2.6 MB is the architecture's best
single statistic.

Two consequences of the floor that must be handled, not left implicit:

- **The magnitude slider currently ranges 2.5–7.0.** Its lower half now
  addresses data that doesn't exist. Clamp the floor to 4.5.
- **You lose the "below M4.5 you're mapping seismometers, not seismicity"
  note.** That's one of the better honesty beats in the UI. Reword rather
  than delete: *"Floored at M4.5, where USGS coverage is globally complete.
  Below that, density tracks instrument placement more than geology."*

### Give tier 2 a real control

"Fetched when the user drags the timeline before the live window" is a
gesture most visitors never perform — which means the plate-boundary
reveal, the thing this piece is *about*, mostly doesn't happen.

Make it an explicit button: **"Show the full decade — 86,071 events."**
State the cost in the label. That's the click the whole demo is built for.

### What the timeline draws on first paint

The bottom timeline is ~140 monthly bars computed from the archive — and
under this architecture the archive isn't fetched on load. Left unspecified,
the second-largest element on screen is empty at first paint.

**Serve the monthly counts in `manifest.json`.** 140 integers, ~1 KB,
already fetched. That buys four things at once:

- the histogram renders complete on first paint, from the manifest alone;
- the decade's *shape* is visible before anyone commits to 2.6 MB;
- clicking a bar becomes the natural tier-2 trigger, alongside the button;
- the greyed-gap behavior in the staleness table finally has something to
  grey out — currently it has no data to operate on before tier 2 loads.

This complements the explicit button rather than replacing it. The button
states the cost; the histogram makes you want to pay it.

---

## The seam

In the overlap, **live wins** — USGS refines magnitudes, revises depths,
and occasionally withdraws events after the fact. Preferring live gives
you revisions for free.

Mind the key shapes: archive rows carry `ID` (uppercase, from Parquet);
live GeoJSON carries `id` on the *feature*, not in `properties`. Keying
naively collapses the whole map to one entry.

```js
const byId = new Map();
for (const r of archiveRows) byId.set(r.ID, r);                    // uppercase
for (const f of liveJson.features) byId.set(f.id, normalize(f));   // feature.id
```

Normalize live features into the archive's column shape before merging.

---

## Staleness is the steady state, not the tail

Scheduled GitHub Actions are disabled after ~60 days of repository
inactivity. That is exactly this project's trajectory: the demo ships, the
repo goes quiet, the cron silently stops, and the archive drifts past 30
days with nothing to catch it. A 23-day slack budget does not help against
a scheduler that stopped firing.

**So the client-side check is the primary safety net, not a backstop.**

| `now − coverage_end` | behavior |
|---|---|
| `< 25 days` | Normal. Footer: "Archive current through 12 Aug 2026." |
| `25–30 days` | Same, plus an amber dot on the footer line. |
| `> 30 days` | **A real gap exists.** Banner naming the missing range. Grey out the uncovered stretch of the timeline. |

The last row is the one that matters. An unlabeled gap in a seismic
timeline renders as a flat stretch, and a flat stretch reads as *quiet* —
the worst possible failure mode for this dataset. Never draw an empty range
that could be mistaken for an absence of earthquakes.

---

## Regeneration

```yaml
name: refresh-archive
on:
  schedule: [{ cron: "0 6 * * 1" }]   # Mondays 06:00 UTC
  workflow_dispatch:                   # manual re-arm after cron disabling

permissions:
  contents: write                      # default token is read-only

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install pandas pyarrow        # NOT duckdb/requests — the
                                               # script uses pandas, pyarrow,
                                               # and stdlib urllib
      - run: python prepare_quakes.py          # writes quakes-YYYY-MM-DD.parquet
                                               # and manifest.json together
      - name: Commit if changed
        run: |
          git config user.name  "archive-bot"
          git config user.email "bot@users.noreply.github.com"
          git add 'quakes-*.parquet' manifest.json
          git diff --staged --quiet || \
            git commit -m "archive: refresh through $(date -u +%F)"
          git push
```

`workflow_dispatch` is there so you can re-arm by hand after inactivity
disables the schedule. GitHub emails you before it does.

### Decide the binary-in-git question on purpose

~2.6 MB weekly is ~135 MB/year, permanently, and content-addressed
filenames mean every build adds a new blob rather than replacing one.

- **Commit to `main`.** Keeps the thesis literal — data versioned beside
  code, roll back a deploy and roll back the data. 135 MB/year is fine
  against GitHub's soft limits for a year or two. Prune to 3 Parquets in
  the same job so the working tree stays clean even though history grows.
- **Orphan `data` branch, force-pushed.** History never accumulates. Costs
  you the "roll back together" story.
- **Build-time fetch.** Nothing in git at all. Cleanest repo, but your
  deploy now depends on USGS being up.

Recommendation: commit to `main`. The thesis is the reason this project
exists, and the storage cost stays theoretical for years. Revisit if the
repo ever gets cloned often enough for the history to hurt.

---

## Corrections to sibling docs

- SPEC.md:95 — the `immutable` header on a fixed filename is superseded by
  the content-addressing table above.
- REVISIONS.md — poll cadences of 15 min / 60 s were based on a stale
  mailing-list figure. All feeds are `max-age=60`, serve `last-modified`
  and no `ETag`, and gzip to ~55 KB.
- Stray references to `fires.parquet` and "40MB" are leftovers from the
  wildfire spec. It's `quakes-YYYY-MM-DD.parquet`, ~2.6 MB.
