<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Mapbox Vector Tiles & PMTiles in DuckDB, Natively or in the Browser

> **vgi-mvt-typescript** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-mvt-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-mvt-typescript/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

A TypeScript port of [vgi-mvt](https://github.com/Query-farm/vgi-mvt)'s vector tile reader, so
the same worker runs natively (Bun, over stdio/launch/HTTP) **and inside a browser tab** next to
[Haybarn WASM](https://www.npmjs.com/package/@haybarn/haybarn-wasm), over VGI's `worker:` transport. In the browser there is no server: the worker fetches
PMTiles byte ranges straight from the tileset URLs, so one page can query and join several
tilesets.

```sql
-- Haybarn WASM (@haybarn/haybarn-wasm, threads build) on a cross-origin-isolated page
INSTALL vgi FROM community; LOAD vgi; LOAD spatial;
ATTACH 'worker:mvt-worker.js' AS mvt (TYPE vgi);

SELECT "pmap:kind" AS kind, count(*) AS roads
FROM mvt.main.read_tiles('https://raw.githubusercontent.com/protomaps/PMTiles/main/spec/v3/protomaps(vector)ODbL_firenze.pmtiles',
                         layer := 'roads', zoom := 14)
GROUP BY kind ORDER BY roads DESC;
```

Natively it attaches like any worker:

```sql
ATTACH 'mvt' (TYPE vgi, LOCATION '/abs/path/to/bin/vgi-mvt-worker');
```

## Attach a tileset as a database

With a `tileset` option, each layer of the archive becomes a table and each layer attribute a
typed column, as in the Python worker:

```sql
ATTACH 'worker:mvt-worker.js' AS florence (TYPE vgi,
  tileset 'https://raw.githubusercontent.com/protomaps/PMTiles/main/spec/v3/protomaps(vector)ODbL_firenze.pmtiles');

SELECT "pmap:kind" AS kind, count(*) AS roads FROM florence.roads GROUP BY kind ORDER BY roads DESC;
```

| ATTACH option | Default | Meaning |
|---|---|---|
| `tileset` | (none) | PMTiles URL (or local path under Bun). Without it you get only the functions. |
| `zoom` | the tileset's max zoom | Zoom level every layer table reads. |
| `bbox` | whole tileset | `'west,south,east,north'` in degrees: every table reads only the tiles covering it. |
| `coordinates` | `'wgs84'` | `'web_mercator'` or `'tile'` instead. |
| `max_tiles` | 10000 | A table scan fails rather than read more tiles than this. |
| `tile_edges` | `'merge'` | `'merge'`, `'clip'` or `'raw'`, as for `read_tiles`. |

A table scan is redirected to `read_tiles`, so `WHERE ST_Intersects(geometry, <constant>)`
pushdown works on the tables too.

## Functions

| Function | What it does |
|---|---|
| `read_tiles(source, zoom, layer, west/south/east/north, coordinates, tile_edges, max_tiles)` | A PMTiles archive (URL, or local path under Bun) or `{z}/{x}/{y}` template at one zoom, one row per feature |
| `read_mvt(source, z, x, y, layer, coordinates)` | One `.mvt` / `.pbf` tile |
| `tileset_layers(source)` | Layers and attributes from the tileset's `vector_layers` metadata |

Rows carry `layer, z, x, y, feature_id, geometry_type, geometry (GEOMETRY), properties (JSON)`;
`layer := '<name>'` adds a typed column per attribute.

## Compared with the Python worker

Checked feature by feature against vgi-mvt 0.2.2 on the Florence basemap at z14: every table
of every layer in all three `tile_edges` modes (39 tables), plus the test fixtures and the
4.66 GB Overture places archive.

- **Identical:** column names and types, row counts, feature ids, geometry types, and the
  `properties` JSON text (floats are written as Python's `json` writes them: `5.0`, `1e+16`).
- `'raw'`: geometries identical, vertex for vertex.
- `'clip'`: the same pieces; lines lie within 0.5 m of Python's, and each polygon piece's
  symmetric difference from Python's is at most 2.4e-7 of its area. Polygons are cut with
  [polygon-clipping](https://github.com/mfogel/polygon-clipping) where Python uses GEOS, and
  cut points snap to the same 1/16-pixel grid.
- `'merge'` (the default): the same features, areas within 3e-4 of each feature's (a vertex
  one grid step, about 3 cm, away). Vertex counts are lower: GEOS keeps collinear points on
  tile edges and adds a node where a line crosses itself, polygon-clipping doesn't.
- One building of 115, a 421-part multipolygon, comes back with two parts touching
  (`ST_IsValid` false, `ST_MakeValid` fixes it); its area matches Python's to 1e-13.
- Pushdown: `WHERE ST_Intersects(geometry, ST_MakeEnvelope(11.24, 43.76, 11.27, 43.78))` on the
  Overture archive reads only the tiles under the box and returns the same counts.
- `ATTACH ... tileset`: the same tables, columns, comments and errors, and
  `test/sql/attach.test` is Python's `attach.test` with MBTiles swapped for the PMTiles fixture.

Not ported yet: `mvt_decode`, `tileset_metadata`, MBTiles
and the `COPY ... TO (FORMAT 'mvt.pmtiles')` writer.

## Demo

```sh
bun install
bun run demo        # builds dist/browser and serves http://localhost:8800 with COOP/COEP
```

The page boots Haybarn's threads build, attaches the worker over `worker:`, and offers example
queries, including a join between the Florence basemap and the 4.66 GB Overture places
archive. Status: works in Chrome and Safari. (Playwright's headless WebKit fails while opening
Haybarn's threads engine, before the worker starts; real Safari is fine, so test there.)

## Development

`make check` is the gate: Biome, `tsc`, unit tests, the SQL suite over stdio, launch and HTTP
(offline, against `test/fixtures` and a range-capable fixture server), and vgi-lint.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the BSD Zero Clause License
(see [LICENSE](LICENSE)).

Copyright 2026 Query Farm LLC - https://query.farm
