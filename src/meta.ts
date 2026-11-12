/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import type { VgiDataType, VgiField } from "@query-farm/vgi";
import { field } from "@query-farm/vgi/worker-cf";

export const CATALOG_NAME = "mvt";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-mvt-typescript";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  {
    name: "readers",
    title: "Tile Readers",
    description: "Table functions that read vector tiles from tilesets, URLs and single tiles into rows.",
  },
  {
    name: "metadata",
    title: "Tileset Metadata",
    description: "Table functions that describe a tileset: layers, attributes, zoom range and bounds.",
  },
] as const;

/** Public sample tilesets used in the (non-executable) examples and the README. */
export const FIRENZE_PMTILES =
  "https://raw.githubusercontent.com/protomaps/PMTiles/main/spec/v3/protomaps(vector)ODbL_firenze.pmtiles";

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

export const CATALOG_DOC_LLM =
  "Decode Mapbox Vector Tiles (MVT, the protobuf tile format behind most web maps) into DuckDB " +
  "rows. Each feature becomes a row with its layer, tile address (z/x/y), feature id, a `GEOMETRY` " +
  "in WGS84 longitude/latitude (or Web Mercator, or raw tile pixels) and its attributes as `JSON`; " +
  "naming one layer also returns each attribute the tileset metadata lists as a typed column. " +
  "Sources: PMTiles archives over HTTP range requests (or local files when the worker runs under " +
  "Bun) and `{z}/{x}/{y}` tile-server URL templates. The worker is written in TypeScript so the " +
  "same code also runs inside a browser Web Worker next to Haybarn WASM (Haybarn's DuckDB build for the browser). Read the tileset metadata " +
  "first to learn its zoom range, layers and attributes. Geometry is quantised to the tile grid. " +
  "Tilesets store a feature once per tile it touches: `tile_edges := 'clip'` (the default) trims " +
  "each piece to its own tile so lengths and areas add up, `'raw'` returns tiles as stored.";

export const CATALOG_DOC_MD =
  "# Read Mapbox Vector Tiles in DuckDB\n\n" +
  "**Turn vector tiles back into data.** Decode Mapbox Vector Tiles into rows with a DuckDB " +
  "`GEOMETRY` column and the features' attributes, from PMTiles archives or `{z}/{x}/{y}` tile " +
  "servers.\n\n" +
  "Coordinates come back as WGS84 longitude/latitude by default; Web Mercator metres and raw tile " +
  "pixels are available too. Vector tiles are a lossy, display-oriented format: coordinates snap " +
  "to a grid of usually 4096 per tile, and features are clipped at tile edges and simplified at low " +
  "zoom, so read the highest zoom for the most faithful geometry.";

export const SCHEMA_DOC_LLM =
  "Vector tile readers. Every feature-reading function returns the same leading columns: layer, z, " +
  "x, y, feature_id, geometry_type, geometry (`GEOMETRY`), properties (`JSON`). Tile addresses use " +
  "the XYZ scheme (row 0 at the north). Whole tilesets are read one zoom at a time, limited by an " +
  "optional WGS84 bbox (west, south, east, north) that selects tiles, not features: filter features " +
  "afterwards with `ST_Intersects`. A `max_tiles` guard (default 10000) stops accidental " +
  "planet-sized reads. Use DuckDB spatial (ST_*) on the geometry column.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Read vector tiles as tables: whole tilesets at one zoom or single tiles, plus the layer " +
  "catalogue that describes a tileset.\n\n" +
  "Feature rows always carry `layer`, `z`, `x`, `y`, `feature_id`, `geometry_type`, `geometry` and " +
  "`properties`.";

export const AGENT_TEST_TASKS = [
  {
    name: "fixture_city_count",
    prompt:
      "Using the mvt worker, how many features are in the 'cities' layer of the tileset " +
      "test/fixtures/sample.pmtiles at zoom 3?",
  },
  {
    name: "tile_polygons",
    prompt: "How many polygon features does the single vector tile test/fixtures/0-0-0.mvt (tile 0/0/0) hold?",
  },
  {
    name: "region_attributes",
    prompt: "List the attribute names of the 'regions' layer in test/fixtures/sample.pmtiles, alphabetically.",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Vector Tile Reader",
  "vgi.subtitle":
    "Decode PMTiles and XYZ vector tiles into DuckDB rows with GEOMETRY columns, natively or in the browser.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query.Farm",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "vgi, duckdb, vector tiles, mvt, mapbox vector tile, pmtiles, xyz tiles, gis, geometry, protobuf, wasm, browser",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Vector Tile Readers",
  domain: "geospatial",
  "vgi.keywords": keywordsArray("vector tiles, mvt, pmtiles, read tiles, decode, layers, geometry"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
