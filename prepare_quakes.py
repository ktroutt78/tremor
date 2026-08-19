"""
Builds the static tiers behind Tremor, per DATA-TIERS.md.

  quakes-YYYY-MM-DD.parquet   global M4.5+ since 2015 — the decade archive
  majors-YYYY-MM-DD.parquet   global M7+ since 1900 — the great earthquakes
  manifest.json               freshness oracle + monthly histogram

Filenames are content-addressed by build date so the data files can carry
`immutable` cache headers while still being regenerated weekly. The manifest
names the current pair and must be served `no-cache` — it is the only thing
that tells the client what is current.

The M4.5 floor is deliberate: USGS is globally complete at about that
magnitude. Below it, event density tracks instrument placement more than
geology, and the mid-ocean ridges go dark while Oklahoma glows.

    uv run --with pandas,pyarrow prepare_quakes.py
"""
import datetime as dt
import json
import pathlib
import time
import urllib.parse
import urllib.request

import pandas as pd

HERE = pathlib.Path(__file__).parent
QUERY = "https://earthquake.usgs.gov/fdsnws/event/1/query"

ARCHIVE_START = dt.date(2015, 1, 1)
ARCHIVE_MIN_MAG = 4.5
MAJOR_START = dt.date(1900, 1, 1)
MAJOR_MIN_MAG = 7.0
KEEP_TYPE = "earthquake"      # ComCat also carries quarry blasts and nuclear tests
RETAIN = 3                    # current build plus the previous two

# Tooltip payload. `felt`, `cdi`, `mmi` and `alert` are null for most events —
# the ocean does not file Did You Feel It reports — so the tooltip has to
# collapse gracefully rather than render empty rows.
FIELDS = ["ID", "TIME", "YEAR", "MAG", "MAG_TYPE", "DEPTH_KM", "LATITUDE",
          "LONGITUDE", "PLACE", "FELT", "CDI", "MMI", "ALERT", "TSUNAMI", "SIG"]


def fetch(params, label):
    url = QUERY + "?" + urllib.parse.urlencode({**params, "format": "geojson"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                return json.load(r).get("features", [])
        except Exception as e:
            if attempt == 4:
                raise RuntimeError(f"{label} failed: {e}")
            time.sleep(2 * (attempt + 1))


def rows_from(features):
    out = []
    for f in features:
        p, g = f["properties"], f["geometry"]
        if p.get("type") != KEEP_TYPE or p.get("mag") is None or not g:
            continue
        lon, lat, *rest = g["coordinates"]
        depth = rest[0] if rest else None
        if lon is None or lat is None or depth is None:
            continue
        out.append({
            "ID": f["id"],                      # event page URL is derivable from this
            "TIME": p["time"],                  # epoch ms, UTC
            "MAG": p["mag"],
            "MAG_TYPE": p.get("magType") or "",
            "DEPTH_KM": depth,
            "LATITUDE": lat,
            "LONGITUDE": lon,
            "PLACE": p.get("place") or "",
            "FELT": p.get("felt") or 0,
            "CDI": p.get("cdi") or 0.0,
            "MMI": p.get("mmi") or 0.0,
            "ALERT": p.get("alert") or "",
            "TSUNAMI": p.get("tsunami") or 0,
            "SIG": p.get("sig") or 0,
        })
    return out


def frame(rows):
    df = pd.DataFrame(rows).drop_duplicates(subset="ID")
    ts = pd.to_datetime(df.TIME, unit="ms", utc=True)
    # Stored tz-naive. The catalogue is UTC end to end, and duckdb-wasm
    # surfaces a tz-aware parquet column as TIMESTAMP WITH TIME ZONE, which
    # strftime() has no overload for.
    df["TIME"] = ts.dt.tz_localize(None)
    df["YEAR"] = ts.dt.year.astype("int16")
    return (df.sort_values("TIME").reset_index(drop=True)
              .astype({"MAG": "float32", "DEPTH_KM": "float32",
                       "LATITUDE": "float32", "LONGITUDE": "float32",
                       "FELT": "int32", "CDI": "float32", "MMI": "float32",
                       "TSUNAMI": "int8", "SIG": "int32"})[FIELDS])


def prune(pattern, keep):
    files = sorted(HERE.glob(pattern))
    for old in files[:-keep]:
        old.unlink()
        print(f"  pruned {old.name}")


def main():
    today = dt.date.today()
    stamp = today.isoformat()

    print(f"archive: M{ARCHIVE_MIN_MAG}+ {ARCHIVE_START} to {today}, by year")
    rows = []
    for y in range(ARCHIVE_START.year, today.year + 1):
        a = max(ARCHIVE_START, dt.date(y, 1, 1))
        b = min(today + dt.timedelta(days=1), dt.date(y + 1, 1, 1))
        got = fetch({"starttime": a.isoformat(), "endtime": b.isoformat(),
                     "minmagnitude": ARCHIVE_MIN_MAG, "orderby": "time-asc"}, str(y))
        if len(got) >= 20000:
            raise SystemExit(f"{y} returned {len(got)} — at the 20k cap, chunk finer")
        rows.extend(rows_from(got))
        print(f"  {y}  +{len(got):>5}   total {len(rows):>7,}")

    quakes = frame(rows)
    majors = frame(rows_from(fetch(
        {"starttime": MAJOR_START.isoformat(), "endtime": (today + dt.timedelta(days=1)).isoformat(),
         "minmagnitude": MAJOR_MIN_MAG, "orderby": "time-asc"}, "majors")))

    qpath = HERE / f"quakes-{stamp}.parquet"
    mpath = HERE / f"majors-{stamp}.parquet"
    quakes.to_parquet(qpath, compression="zstd", index=False)
    majors.to_parquet(mpath, compression="zstd", index=False)

    # Monthly histogram travels in the manifest so the timeline can render
    # complete on first paint, before anyone commits to downloading the
    # archive. Fixed at the archive's own magnitude floor.
    monthly = (quakes.groupby(quakes.TIME.dt.strftime("%Y-%m")).size()
                     .astype(int).to_dict())

    manifest = {
        "parquet": qpath.name,
        "majors": mpath.name,
        "land": "land.geojson",
        "borders": "borders.geojson",
        "labels": "labels.json",
        "cities": "cities.json",
        "built_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "coverage_start": quakes.TIME.min().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "coverage_end": quakes.TIME.max().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "event_count": int(len(quakes)),
        "major_count": int(len(majors)),
        "min_magnitude": ARCHIVE_MIN_MAG,
        "bytes": qpath.stat().st_size,
        "monthly": monthly,
        "source": "USGS ComCat via fdsnws/event/1",
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2))

    prune("quakes-*.parquet", RETAIN)
    prune("majors-*.parquet", RETAIN)

    print(f"\n{qpath.name}")
    print(f"  events      {len(quakes):,}")
    print(f"  span        {quakes.TIME.min():%Y-%m-%d} to {quakes.TIME.max():%Y-%m-%d}")
    print(f"  magnitude   {quakes.MAG.min():.1f} to {quakes.MAG.max():.1f}")
    print(f"  depth       {quakes.DEPTH_KM.min():.0f} to {quakes.DEPTH_KM.max():.0f} km")
    print(f"  file        {qpath.stat().st_size/1e6:.2f} MB")
    print(f"  with felt   {(quakes.FELT > 0).sum():,}  ({100*(quakes.FELT>0).mean():.1f}%)")
    print(f"  with alert  {(quakes.ALERT != '').sum():,}")
    print(f"\n{mpath.name}\n  events      {len(majors):,}  M{majors.MAG.min():.1f}-{majors.MAG.max():.1f}")
    print(f"\nmanifest.json  {len(monthly)} months, "
          f"{len(json.dumps(monthly))} bytes of histogram")


if __name__ == "__main__":
    main()
