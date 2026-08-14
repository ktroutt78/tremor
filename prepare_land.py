"""
Builds land.geojson — global land polygons for the basemap.

REVISIONS.md item 3: the CARTO raster tiles can't be made to render land
lighter than ocean, and pushing them to full opacity just makes them compete
with the data. A flat land polygon underneath gives exact control over the
land/ocean contrast, and coastlines are load-bearing here — the story is
where earthquakes sit relative to land.

Natural Earth 1:50m, rounded to ~100m. Static; run once.

    uv run --with shapely prepare_land.py
"""
import json
import pathlib
import urllib.request

HERE = pathlib.Path(__file__).parent
OUT = HERE / "land.geojson"
URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
       "master/geojson/ne_50m_land.geojson")
PRECISION = 3  # ~100m at the equator; finer than any zoom here resolves


def snap(o):
    if isinstance(o, float):
        return round(o, PRECISION)
    if isinstance(o, list):
        return [snap(v) for v in o]
    return o


def main():
    print(f"fetching {URL.rsplit('/', 1)[-1]}")
    with urllib.request.urlopen(URL, timeout=120) as r:
        gj = json.load(r)

    # Attributes are dead weight — this layer is a silhouette, not data.
    feats = []
    for f in gj["features"]:
        feats.append({"type": "Feature", "properties": {},
                      "geometry": {"type": f["geometry"]["type"],
                                   "coordinates": snap(f["geometry"]["coordinates"])}})
    out = {"type": "FeatureCollection", "features": feats}
    OUT.write_text(json.dumps(out, separators=(",", ":")))

    verts = sum(
        len(ring)
        for f in feats
        for poly in ([f["geometry"]["coordinates"]]
                     if f["geometry"]["type"] == "Polygon"
                     else f["geometry"]["coordinates"])
        for ring in poly
    )
    print(f"  {len(feats)} features, {verts:,} vertices")
    print(f"  {OUT.name}  {OUT.stat().st_size/1e6:.2f} MB")


if __name__ == "__main__":
    main()
