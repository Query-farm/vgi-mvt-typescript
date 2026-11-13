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

Checked against vgi-mvt 0.2.2 on the same inputs (Florence basemap at z14, the test fixtures,
the 4.66 GB Overture places archive):

- `tile_edges := 'merge'` (the default): the same rows (roads 3,557, buildings 115, land use
  1,361), the same count of each geometry type, and areas within 2e-8. Pieces are joined with
  [polygon-clipping](https://github.com/mfogel/polygon-clipping) where Python uses GEOS; one
  building of 115 comes back with two parts touching (`ST_MakeValid` fixes it), and total line
  length differs by a few parts in a million, where GEOS dissolves a line that overlaps itself.
- `'clip'`: the same rows (3,847) and ids (3,557); areas match exactly.
- `'raw'`: identical, including vertex counts.
- Pushdown: `WHERE ST_Intersects(geometry, ST_MakeEnvelope(11.24, 43.76, 11.27, 43.78))` on the
  Overture archive reads only the tiles under the box and returns the same counts.

- `ATTACH ... tileset`: the same tables, columns, comments and errors; Florence at zoom 14
  gives the same roads (3,557) and building area, and `test/sql/attach.test` is Python's
  `attach.test` with MBTiles swapped for the PMTiles fixture.

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
