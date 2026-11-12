# vgi-mvt-typescript

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

## Functions

| Function | What it does |
|---|---|
| `read_tiles(source, zoom, layer, west/south/east/north, coordinates, tile_edges, max_tiles)` | A PMTiles archive (URL, or local path under Bun) or `{z}/{x}/{y}` template at one zoom, one row per feature |
| `read_mvt(source, z, x, y, layer, coordinates)` | One `.mvt` / `.pbf` tile |
| `tileset_layers(source)` | Layers and attributes from the tileset's `vector_layers` metadata |

Rows carry `layer, z, x, y, feature_id, geometry_type, geometry (GEOMETRY), properties (JSON)`;
`layer := '<name>'` adds a typed column per attribute.

## Compared with the Python worker

Checked against vgi-mvt 0.2.2 on the same inputs:

- `tile_edges := 'raw'` is identical: on Florence's roads at z14, 4,092 rows, 3,628 ids, the same
  total length and the same 67,731 vertices; building areas agree to 1e-11.
- `'clip'` (the default here) gives the same rows (3,847) and ids (3,557); areas match exactly.
  Total line length differs by about one part in a million, where GEOS dissolves a line that
  overlaps itself and a segment clip doesn't.

Not ported yet: `tile_edges := 'merge'` (joining pieces across tiles; the Python worker's
default), `ATTACH ... tileset` catalog tables, `mvt_decode`, `tileset_metadata`, MBTiles,
spatial filter pushdown and the `COPY ... TO (FORMAT 'mvt.pmtiles')` writer.

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
