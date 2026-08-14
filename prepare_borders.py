"""
Builds borders.geojson and labels.json — political context for the basemap.

land.geojson gives coastlines, which answers "is this event offshore". It does
not answer "which state is that", and at California zoom the frame is a bare
silhouette with nothing to orient against.

Two outputs, deliberately separate:

  borders.geojson  admin-0 (country) and admin-1 (state/province) lines,
                   merged into one MultiLineString per level. Per-feature
                   properties are dead weight for a layer that renders as two
                   flat strokes, so everything is stripped and the level is
                   carried on the feature itself.

  labels.json      name + label anchor + the zoom range Natural Earth itself
                   recommends showing it at. NE ships min_label/max_label per
                   feature, so the zoom gating is cartographers' judgement
                   rather than thresholds I guessed.

Coverage note: NE's 1:50m admin-1 set only covers nine large countries (US,
Canada, Brazil, Russia, China, India, Indonesia, Australia, South Africa).
Country borders are global. Chile and Japan therefore get a border and a
coastline but no provinces — the 1:10m set would fix that at several times
the payload, which is not worth it for context that sits under the data.

Natural Earth 1:50m, rounded to ~100m. Static; run once.

    uv run prepare_borders.py
"""
import json
import pathlib
import urllib.request

HERE = pathlib.Path(__file__).parent
BASE = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
        "master/geojson/")
BORDERS_OUT = HERE / "borders.geojson"
LABELS_OUT = HERE / "labels.json"
PRECISION = 3  # ~100m at the equator; finer than any zoom here resolves

SOURCES = {
    "lines_0":  "ne_50m_admin_0_boundary_lines_land.geojson",
    "lines_1":  "ne_50m_admin_1_states_provinces_lines.geojson",
    "labels_0": "ne_50m_admin_0_countries.geojson",
    "labels_1": "ne_50m_admin_1_states_provinces.geojson",
}


def fetch(name):
    print(f"fetching {name}")
    with urllib.request.urlopen(BASE + name, timeout=180) as r:
        return json.load(r)


def snap(o):
    if isinstance(o, float):
        return round(o, PRECISION)
    if isinstance(o, list):
        return [snap(v) for v in o]
    return o


def line_strings(gj):
    """Flatten every LineString / MultiLineString into a list of coord arrays."""
    out = []
    for f in gj["features"]:
        g = f.get("geometry") or {}
        if g.get("type") == "LineString":
            out.append(snap(g["coordinates"]))
        elif g.get("type") == "MultiLineString":
            out.extend(snap(part) for part in g["coordinates"])
    return out


def main():
    # ---- lines ------------------------------------------------------------
    feats = []
    for level, key in ((0, "lines_0"), (1, "lines_1")):
        parts = line_strings(fetch(SOURCES[key]))
        feats.append({
            "type": "Feature",
            "properties": {"lvl": level},
            "geometry": {"type": "MultiLineString", "coordinates": parts},
        })
        print(f"  admin-{level}: {len(parts):,} segments, "
              f"{sum(len(p) for p in parts):,} vertices")

    BORDERS_OUT.write_text(json.dumps(
        {"type": "FeatureCollection", "features": feats}, separators=(",", ":")))

    # ---- labels -----------------------------------------------------------
    # NE spells admin-0 properties in caps and admin-1 in lowercase.
    labels = []
    for p in (f["properties"] for f in fetch(SOURCES["labels_0"])["features"]):
        if p.get("LABEL_X") is None or p.get("LABEL_Y") is None:
            continue
        # "United States of America" laid across the west coast covers the
        # densest part of the map. NE ships an abbreviation for exactly this;
        # use it once the full name stops being worth the space.
        name = p["NAME"]
        if len(name) > 16 and p.get("ABBREV"):
            name = p["ABBREV"].replace(".", "")
        labels.append({
            "n": name,
            "p": [round(p["LABEL_X"], PRECISION), round(p["LABEL_Y"], PRECISION)],
            "lvl": 0,
            "min": p.get("MIN_LABEL") or 1.7,
            "max": p.get("MAX_LABEL") or 11,
        })
    for p in (f["properties"] for f in fetch(SOURCES["labels_1"])["features"]):
        if p.get("longitude") is None or p.get("latitude") is None:
            continue
        labels.append({
            "n": p["name"],
            "p": [round(p["longitude"], PRECISION), round(p["latitude"], PRECISION)],
            "lvl": 1,
            "min": p.get("min_label") or 3.5,
            "max": p.get("max_label") or 11,
        })

    LABELS_OUT.write_text(json.dumps(labels, separators=(",", ":"),
                                     ensure_ascii=False))

    n0 = sum(1 for l in labels if l["lvl"] == 0)
    print(f"\n{BORDERS_OUT.name}  {BORDERS_OUT.stat().st_size/1e6:.2f} MB")
    print(f"{LABELS_OUT.name}  {LABELS_OUT.stat().st_size/1e3:.1f} KB "
          f"({n0} countries, {len(labels)-n0} states/provinces)")


if __name__ == "__main__":
    main()
