#!/usr/bin/env bash
# Compare this worker with the Python vgi-mvt worker, table by table, on the Florence
# basemap at z14 in every tile_edges mode. Prints a diff of per-table statistics
# (rows, ids, geometry types, area, length, vertices, invalid count, properties hash);
# vertex counts are expected to differ in clip/merge (see README).
#
#   ci/compare-python.sh /abs/path/to/python/vgi-mvt-worker
set -euo pipefail
PY_WORKER="${1:?usage: ci/compare-python.sh /abs/path/to/python/vgi-mvt-worker}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HV="$(grep -m1 '^HAYBARN_VERSION' "$REPO/Makefile" | sed 's/.*= *//')"
TILESET='https://raw.githubusercontent.com/protomaps/PMTiles/main/spec/v3/protomaps(vector)ODbL_firenze.pmtiles'
LAYERS="boundaries buildings earth landcover landuse natural physical_line physical_point places pois roads transit water"
OUT="$(mktemp -d)"
for impl in "ts:$REPO/bin/vgi-mvt-worker" "py:$PY_WORKER"; do
  name="${impl%%:*}" worker="${impl#*:}" q=""
  for e in merge clip raw; do for t in $LAYERS; do
    q="$q UNION ALL SELECT '$e' e, '$t' t, count(*) n, count(DISTINCT feature_id) ids, string_agg(DISTINCT geometry_type, '|' ORDER BY geometry_type) gt, round(sum(ST_Area(geometry)), 9) area, round(sum(ST_Length(geometry)), 5) len, sum(ST_NPoints(geometry)) pts, count(*) FILTER (WHERE NOT ST_IsValid(geometry)) invalid, md5(string_agg(properties::VARCHAR, '' ORDER BY properties::VARCHAR)) props FROM $e.$t"
  done; done
  {
    echo "INSTALL spatial; LOAD vgi; LOAD spatial;"
    for e in merge clip raw; do echo "ATTACH 'mvt' AS $e (TYPE vgi, LOCATION '$worker', zoom 14, tile_edges '$e', tileset '$TILESET');"; done
    echo "COPY (SELECT database_name, table_name, string_agg(column_name || ':' || data_type, ',' ORDER BY column_index) FROM duckdb_columns() WHERE database_name IN ('merge', 'clip', 'raw') GROUP BY ALL ORDER BY ALL) TO '$OUT/cols_$name.csv';"
    echo "COPY (SELECT * FROM (${q# UNION ALL }) ORDER BY e, t) TO '$OUT/stats_$name.csv';"
  } | uvx --from "haybarn-cli==$HV" haybarn -no-agent
done
echo "== columns"; diff "$OUT/cols_ts.csv" "$OUT/cols_py.csv" && echo identical
echo "== per-table statistics (< this worker, > Python)"; diff "$OUT/stats_ts.csv" "$OUT/stats_py.csv" && echo identical || true
