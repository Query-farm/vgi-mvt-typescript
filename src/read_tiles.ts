/**
 * Table functions `read_tiles` (a tileset at one zoom), `read_mvt` (one tile) and
 * `tileset_layers` (the layer catalogue). Ports of vgi-mvt's read_tiles.py/layers.py.
 */

import type { VgiSchema } from "@query-farm/vgi";
import { batchFromColumns, defineTableFunction, float64, int32, schema, utf8 } from "@query-farm/vgi/worker-cf";
import { TILE_EDGE_CHOICES, type TileEdges } from "./edges.ts";
import { assemblerFor } from "./merge.ts";
import { column, FIRENZE_PMTILES, objectTags } from "./meta.ts";
import {
  type BBox,
  COORDINATE_CHOICES,
  type Coordinates,
  decodeTile,
  inTile,
  MvtDecodeError,
  maybeDecompress,
} from "./mvt.ts";
import { clampToWorld, INTERSECTS_EXTENT, intersect, pushedBBox } from "./pushdown.ts";
import { attributeFields, inferFieldTypes, outputSchema, RESULT_COLUMNS_DOC, RowBuilder } from "./rows.ts";
import { httpGet, isUrl, openSource, type TileKey, TileSourceError } from "./sources.ts";

const TILES_PER_BATCH = 16;
export const DEFAULT_MAX_TILES = 10_000;

const COORDS_DOC = "Output coordinates: 'wgs84' (default), 'web_mercator' or 'tile' (raw tile pixels).";
const LAYER_DOC =
  "Read only this layer; NULL reads every layer. Naming a layer also adds a typed column per attribute the tileset metadata lists for it.";
const EDGES_DOC =
  "How to treat features cut at tile edges: 'merge' (default) joins a feature's pieces across tiles into one row; 'clip' trims each piece to its own tile without joining; 'raw' returns every tile as stored, buffer included.";

interface ReadTilesArgs {
  source: string;
  zoom: number | null;
  layer: string | null;
  west: number | null;
  south: number | null;
  east: number | null;
  north: number | null;
  coordinates: string;
  tile_edges: string;
  max_tiles: number;
}

interface ReadTilesState {
  listed: boolean;
  keys: number[]; // flattened [z, x, y, z, x, y, ...]
  next: number;
  run: string; // identifies this query's merge state in this process
}

// A pushed box is grown by this much (degrees) so a feature exactly on its edge still reads its tile.
const HINT_MARGIN = 1e-9;

function bboxOf(a: ReadTilesArgs): BBox | null {
  const parts = [a.west, a.south, a.east, a.north];
  const given = parts.filter((v) => v !== null && v !== undefined).length;
  if (given === 0) return null;
  if (given !== 4) throw new TileSourceError("give all four of west, south, east and north, or none");
  const [w, s, e, n] = parts.map(Number) as BBox;
  if (w >= e || s >= n) throw new TileSourceError("the bbox needs west < east and south < north");
  return [w, s, e, n];
}

async function resolveZoom(source: string, zoom: number | null): Promise<number> {
  if (zoom !== null && zoom !== undefined) return Number(zoom);
  const info = await (await openSource(source)).info();
  if (info.maxzoom === null) throw new TileSourceError("this source has no maxzoom metadata; pass zoom := <level>");
  return info.maxzoom;
}

export const readTiles = defineTableFunction<ReadTilesArgs, ReadTilesState>({
  name: "read_tiles",
  description: "Read the vector tiles of a PMTiles archive or XYZ tile server at one zoom as one row per feature",
  args: {
    source: utf8(),
    zoom: int32(),
    layer: utf8(),
    west: float64(),
    south: float64(),
    east: float64(),
    north: float64(),
    coordinates: utf8(),
    tile_edges: utf8(),
    max_tiles: int32(),
  },
  argDefaults: {
    zoom: null,
    layer: null,
    west: null,
    south: null,
    east: null,
    north: null,
    coordinates: "wgs84",
    tile_edges: "merge",
    max_tiles: DEFAULT_MAX_TILES,
  },
  argDocs: {
    source:
      "A PMTiles archive (http(s) URL, or a local path when the worker runs under Bun) or a tile URL template containing {z}, {x} and {y}.",
    zoom: "Zoom level to read; defaults to the tileset's maxzoom.",
    layer: LAYER_DOC,
    west: "West edge of the area to read, degrees longitude.",
    south: "South edge of the area to read, degrees latitude.",
    east: "East edge of the area to read, degrees longitude.",
    north: "North edge of the area to read, degrees latitude.",
    coordinates: COORDS_DOC,
    tile_edges: EDGES_DOC,
    max_tiles:
      "Refuse to read more tiles than this (default 10000), so a missing bbox can't start a planet-sized read.",
  },
  argConstraints: {
    zoom: { ge: 0, le: 26 },
    west: { ge: -180, le: 180 },
    east: { ge: -180, le: 180 },
    south: { ge: -90, le: 90 },
    north: { ge: -90, le: 90 },
    coordinates: { choices: COORDINATE_CHOICES },
    tile_edges: { choices: TILE_EDGE_CHOICES },
    max_tiles: { ge: 1 },
  },

  onBind: async ({ args }) => {
    bboxOf(args);
    const coordinates = args.coordinates as Coordinates;
    if (args.layer === null || args.layer === undefined) return { outputSchema: outputSchema(coordinates) };
    const info = await (await openSource(args.source)).info();
    const layer = info.layers.find((l) => l.id === args.layer);
    if (!layer && info.layers.length > 0) {
      const names = info.layers.map((l) => l.id).sort();
      throw new TileSourceError(`layer '${args.layer}' is not in this tileset; its layers are: ${names.join(", ")}`);
    }
    return { outputSchema: outputSchema(coordinates, layer ? attributeFields(layer.fields) : []) };
  },

  // Accept DuckDB's filters so the VGI extension can push the bounding box of
  // WHERE ST_Intersects(geometry, <constant>) (an optional `&&` hint) into the
  // scan; the SDK applies every pushed filter to the rows we emit.
  filterPushdown: true,
  autoApplyFilters: true,
  additionalFilterFunctions: [INTERSECTS_EXTENT],

  initialState: () => ({ listed: false, keys: [], next: 0, run: "" }),

  process: async (params, state, out) => {
    const a = params.args;
    const src = await openSource(a.source);
    if (!state.listed) {
      state.listed = true;
      state.run = crypto.randomUUID();
      const hint = pushedBBox(params.pushdownFilters as Parameters<typeof pushedBBox>[0], a.coordinates as Coordinates);
      const grown: BBox | null = hint
        ? [hint[0] - HINT_MARGIN, hint[1] - HINT_MARGIN, hint[2] + HINT_MARGIN, hint[3] + HINT_MARGIN]
        : null;
      const combined = hint === false ? false : intersect(bboxOf(a), grown);
      const clamped = combined ? clampToWorld(combined) : combined;
      if (clamped === false) {
        out.finish(); // the filters prove nothing can match
        return;
      }
      const z = await resolveZoom(a.source, a.zoom);
      state.keys = (await src.tiles(z, clamped, Number(a.max_tiles))).flat();
    }
    if (state.next * 3 >= state.keys.length) {
      out.finish();
      return;
    }
    const chunk: TileKey[] = [];
    for (let i = state.next; i < state.next + TILES_PER_BATCH && i * 3 < state.keys.length; i++) {
      chunk.push([state.keys[i * 3]!, state.keys[i * 3 + 1]!, state.keys[i * 3 + 2]!]);
    }
    state.next += chunk.length;
    const rows = new RowBuilder(
      params.outputSchema,
      a.coordinates as Coordinates,
      a.layer ?? null,
      a.tile_edges as TileEdges,
    );
    if (a.tile_edges === "merge") {
      const all: TileKey[] = [];
      for (let i = 0; i * 3 < state.keys.length; i++)
        all.push([state.keys[i * 3]!, state.keys[i * 3 + 1]!, state.keys[i * 3 + 2]!]);
      const edges = assemblerFor(state.run, src, all, a.layer ?? null, a.coordinates as Coordinates);
      for (const [[z, x, y], data] of await src.fetch(chunk)) {
        await inTile(z, x, y, () => edges.addTile(rows, [z, x, y], data));
      }
    } else {
      for (const [[z, x, y], data] of await src.fetch(chunk)) {
        await inTile(z, x, y, () => rows.addTile(z, x, y, data));
      }
    }
    out.emit(rows.take());
  },

  tags: {
    ...objectTags({
      title: "Read a Tileset",
      category: "readers",
      keywords: "vector tiles, pmtiles, xyz tiles, tile server, read tileset, mvt, geometry, bbox, range requests",
      docLlm:
        "Read every vector tile of a tileset at one zoom level and return one row per feature: layer, z, " +
        "x, y, feature_id, geometry_type, geometry (GEOMETRY, WGS84 by default), properties (JSON). " +
        "`source` is a PMTiles archive (http(s) URL read with range requests, or a local path under Bun) " +
        "or a tile URL template with {z}/{x}/{y}. Named arguments: `zoom` (default: the tileset's " +
        "maxzoom), `layer` (one layer, adding a typed column per attribute the metadata lists), " +
        "`west`/`south`/`east`/`north` (a WGS84 bbox that selects tiles; required for URL templates), " +
        "`coordinates` ('wgs84', 'web_mercator' or 'tile'), `tile_edges` ('merge', the default, joins a " +
        "feature's pieces across tiles into one row; 'clip' trims pieces to their tile; 'raw' returns " +
        "tiles as stored) and `max_tiles` (default 10000). A bbox argument selects tiles, not features. " +
        "`WHERE ST_Intersects(geometry, <constant geometry>)` (or ST_Contains, ST_Within, ST_Covers, " +
        "ST_Overlaps, ...) is pushed down: its bounding box chooses the tiles, and DuckDB still applies " +
        "the exact predicate. The box must be a constant: one from a join, an OR or a NOT isn't pushed.",
      docMd:
        "## read_tiles(source, zoom := maxzoom, layer := NULL, west/south/east/north := NULL, " +
        "coordinates := 'wgs84', tile_edges := 'merge', max_tiles := 10000)\n\n" +
        "Read a PMTiles archive or XYZ tile server at one zoom as one row per feature. Remote " +
        "PMTiles are read with HTTP range requests, so a bbox over a planet-sized archive fetches " +
        "only the directory pages and tiles under it.",
    }),
    "vgi.result_columns_schema": JSON.stringify(RESULT_COLUMNS_DOC),
    "vgi.executable_examples": JSON.stringify([
      {
        description: "Count the fixture tileset's features per layer at zoom 2",
        sql: "SELECT layer, count(*) AS features FROM mvt.main.read_tiles('test/fixtures/sample.pmtiles', zoom := 2) GROUP BY layer ORDER BY layer",
        expected_result: [
          ["cities", 4],
          ["regions", 4],
        ],
      },
    ]),
  },
  examples: [
    {
      sql: "SELECT layer, count(*) AS features FROM mvt.main.read_tiles('test/fixtures/sample.pmtiles', zoom := 2) GROUP BY layer ORDER BY layer",
      description: "Count the fixture tileset's features per layer at zoom 2",
    },
    {
      sql: `SELECT "pmap:kind" AS kind, count(*) AS n FROM mvt.main.read_tiles('${FIRENZE_PMTILES}', layer := 'roads', west := 11.24, south := 43.76, east := 11.27, north := 43.78) GROUP BY kind ORDER BY n DESC`,
      description: "Road kinds in central Florence from the Protomaps sample, over HTTP range requests",
    },
  ],
});

// ---------------------------------------------------------------- read_mvt

interface ReadMvtArgs {
  source: string;
  z: number;
  x: number;
  y: number;
  layer: string | null;
  coordinates: string;
}

async function readTileBytes(source: string): Promise<Uint8Array> {
  if (isUrl(source)) {
    const data = await httpGet(source);
    if (!data) throw new TileSourceError(`HTTP 404 fetching ${source}`);
    return data;
  }
  const bun = (globalThis as { Bun?: { file(p: string): Blob } }).Bun;
  if (!bun) throw new TileSourceError(`local files need the Bun runtime; use an http(s) URL for ${source}`);
  try {
    return new Uint8Array(await bun.file(source).arrayBuffer());
  } catch (err) {
    throw new TileSourceError(`cannot open ${source}: ${(err as Error).message}`);
  }
}

export const readMvt = defineTableFunction<ReadMvtArgs, { done: boolean }>({
  name: "read_mvt",
  description: "Decode one vector tile (.mvt/.pbf file or URL) into one row per feature",
  args: { source: utf8(), z: int32(), x: int32(), y: int32(), layer: utf8(), coordinates: utf8() },
  argDefaults: { layer: null, coordinates: "wgs84" },
  argDocs: {
    source: "One vector tile: a .mvt/.pbf http(s) URL, or a local path under Bun (gzip is detected).",
    z: "Zoom level of the tile.",
    x: "XYZ column of the tile.",
    y: "XYZ row of the tile (0 at the north edge).",
    layer: "Decode only this layer; NULL decodes every layer.",
    coordinates: COORDS_DOC,
  },
  argConstraints: { z: { ge: 0, le: 30 }, x: { ge: 0 }, y: { ge: 0 }, coordinates: { choices: COORDINATE_CHOICES } },
  onBind: async ({ args }) => {
    const { z, x, y } = args;
    if (x >= 2 ** z || y >= 2 ** z)
      throw new TileSourceError(`tile ${z}/${x}/${y} does not exist: x and y must be below 2^z`);
    const coordinates = args.coordinates as Coordinates;
    if (args.layer === null || args.layer === undefined) return { outputSchema: outputSchema(coordinates) };
    // A single tile has no metadata: infer the attribute types from the tile itself.
    const layers = await inTile(z, x, y, async () =>
      decodeTile(await maybeDecompress(await readTileBytes(args.source)), args.layer),
    );
    return { outputSchema: outputSchema(coordinates, attributeFields(inferFieldTypes(layers))) };
  },
  initialState: () => ({ done: false }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    state.done = true;
    const { source, z, x, y, layer, coordinates } = params.args;
    const rows = new RowBuilder(params.outputSchema, coordinates as Coordinates, layer ?? null, "raw");
    await inTile(z, x, y, async () => rows.addTile(z, x, y, await maybeDecompress(await readTileBytes(source))));
    out.emit(rows.take());
  },
  tags: {
    ...objectTags({
      title: "Read One Tile",
      category: "readers",
      keywords: "vector tile, mvt, pbf, single tile, decode, protobuf, geometry",
      docLlm:
        "Decode a single Mapbox Vector Tile into one row per feature. Positional arguments: `source` " +
        "(a .mvt/.pbf URL, or a local path under Bun; gzip is detected) and the tile's `z`, `x`, `y` " +
        "(XYZ scheme), which place its pixels on the map. Named arguments: `layer` and `coordinates` " +
        "as in read_tiles. Returns the same columns as read_tiles; the tile is returned as stored, " +
        "including its buffer.",
      docMd:
        "## read_mvt(source, z, x, y, layer := NULL, coordinates := 'wgs84')\n\n" +
        "Decode one vector tile. The `z/x/y` address is needed to turn tile pixels into coordinates.",
    }),
    "vgi.result_columns_schema": JSON.stringify(RESULT_COLUMNS_DOC),
    "vgi.executable_examples": JSON.stringify([
      {
        description: "Features per geometry type in the fixture tile",
        sql: "SELECT geometry_type, count(*) AS n FROM mvt.main.read_mvt('test/fixtures/0-0-0.mvt', 0, 0, 0) GROUP BY geometry_type ORDER BY geometry_type",
        expected_result: [
          ["POINT", 4],
          ["POLYGON", 2],
        ],
      },
    ]),
  },
  examples: [
    {
      sql: "SELECT geometry_type, count(*) AS n FROM mvt.main.read_mvt('test/fixtures/0-0-0.mvt', 0, 0, 0) GROUP BY geometry_type ORDER BY geometry_type",
      description: "Features per geometry type in the fixture tile",
    },
  ],
});

// ---------------------------------------------------------------- tileset_layers

const LAYERS_SCHEMA: VgiSchema = schema([
  column("layer", utf8(), "Layer name.", false),
  column("field", utf8(), "Attribute name; NULL for a layer the metadata lists without attributes."),
  column("type", utf8(), "Attribute type from the metadata: String, Number or Boolean."),
  column("minzoom", int32(), "Lowest zoom the layer appears at, if the metadata says."),
  column("maxzoom", int32(), "Highest zoom the layer appears at, if the metadata says."),
  column("description", utf8(), "Layer description from the metadata, if any."),
]);

export const tilesetLayers = defineTableFunction<{ source: string }, { done: boolean }>({
  name: "tileset_layers",
  description: "List a tileset's layers and their attributes from its vector_layers metadata",
  args: { source: utf8() },
  argDocs: { source: "A PMTiles archive: an http(s) URL, or a local path under Bun." },
  onBind: () => ({ outputSchema: LAYERS_SCHEMA }),
  initialState: () => ({ done: false }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    state.done = true;
    const info = await (await openSource(params.args.source)).info();
    const cols: Record<string, unknown[]> = {
      layer: [],
      field: [],
      type: [],
      minzoom: [],
      maxzoom: [],
      description: [],
    };
    for (const l of info.layers) {
      const fields = Object.entries(l.fields);
      for (const [name, type] of fields.length ? fields : [[null, null]]) {
        cols.layer!.push(l.id);
        cols.field!.push(name);
        cols.type!.push(type);
        cols.minzoom!.push(l.minzoom);
        cols.maxzoom!.push(l.maxzoom);
        cols.description!.push(l.description);
      }
    }
    out.emit(batchFromColumns(cols, params.outputSchema));
  },
  tags: {
    ...objectTags({
      title: "Tileset Layers",
      category: "metadata",
      keywords: "tileset metadata, vector_layers, layers, attributes, fields, schema, pmtiles",
      docLlm:
        "List the layers of a PMTiles tileset and their attributes, from the archive's TileJSON " +
        "`vector_layers` metadata: one row per (layer, attribute) with the attribute type (String, " +
        "Number, Boolean), plus each layer's zoom range and description. Use it before read_tiles " +
        "to learn layer names and which typed columns `layer := '<name>'` will add.",
      docMd:
        "## tileset_layers(source)\n\n" + "One row per layer attribute, from the tileset's `vector_layers` metadata.",
    }),
    "vgi.result_columns_schema": JSON.stringify([
      { name: "layer", type: "VARCHAR", description: "Layer name." },
      { name: "field", type: "VARCHAR", description: "Attribute name." },
      { name: "type", type: "VARCHAR", description: "Attribute type." },
      { name: "minzoom", type: "INTEGER", description: "Lowest zoom of the layer." },
      { name: "maxzoom", type: "INTEGER", description: "Highest zoom of the layer." },
      { name: "description", type: "VARCHAR", description: "Layer description." },
    ]),
    "vgi.executable_examples": JSON.stringify([
      {
        description: "Attributes of the fixture tileset's cities layer",
        sql: "SELECT field, type FROM mvt.main.tileset_layers('test/fixtures/sample.pmtiles') WHERE layer = 'cities' ORDER BY field",
        expected_result: [
          ["capital", "Boolean"],
          ["name", "String"],
          ["population", "Number"],
        ],
      },
    ]),
  },
  examples: [
    {
      sql: "SELECT field, type FROM mvt.main.tileset_layers('test/fixtures/sample.pmtiles') WHERE layer = 'cities' ORDER BY field",
      description: "Attributes of the fixture tileset's cities layer",
    },
  ],
});

export { MvtDecodeError };
