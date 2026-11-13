/**
 * Attach a tileset as a database: one table per vector tile layer.
 * A port of vgi-mvt's `catalog.py`.
 *
 *   ATTACH 'mvt' AS florence (TYPE vgi, LOCATION '...',
 *                             tileset 'https://example.com/florence.pmtiles');
 *   SELECT name, geometry FROM florence.pois WHERE "pmap:kind" = 'cafe';
 *
 * Without a `tileset` option the catalog holds only the reader functions. With
 * one, `main` also lists a table per layer of the tileset's `vector_layers`
 * metadata, with the feature columns plus one typed column per attribute, and
 * every scan is redirected to `read_tiles` with the attach's zoom, bbox,
 * coordinates, tile limit and tile_edges.
 *
 * Nothing per attach is kept on the catalog object: the options travel inside
 * `attach_opaque_data`, which every hook receives, so pooled, HTTP and browser
 * workers behave the same.
 */

import type {
  AttachOptionSpec,
  CatalogAttachResult,
  CatalogDescriptor,
  SchemaInfo,
  TableInfo,
  VgiField,
} from "@query-farm/vgi/worker-cf";
import {
  batchFromColumns,
  type FunctionRegistry,
  field,
  float64,
  int32,
  int64,
  ReadOnlyCatalogInterface,
  schema,
  serializeBatch,
  utf8,
} from "@query-farm/vgi/worker-cf";
import { TILE_EDGE_CHOICES, type TileEdges } from "./edges.ts";
import { type BBox, COORDINATE_CHOICES, type Coordinates } from "./mvt.ts";
import { DEFAULT_MAX_TILES } from "./read_tiles.ts";
import { attributeFields, outputSchema } from "./rows.ts";
import { type LayerInfo, openSource, sourceFormat } from "./sources.ts";

const MAIN = ["main"];
const PREFIX = "vgi-mvt-tileset:";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TILESET_ATTACH_OPTIONS: AttachOptionSpec[] = [
  {
    name: "tileset",
    description:
      "PMTiles file or http(s) URL to expose as tables (one per layer). Empty attaches only the reader functions.",
    type: utf8(),
    default: "",
  },
  {
    name: "zoom",
    description: "Zoom level the layer tables read; -1 (default) uses the tileset's maxzoom.",
    type: int64(),
    default: -1n,
  },
  {
    name: "bbox",
    description: "Limit every layer table to the tiles covering 'west,south,east,north' (degrees); empty reads all.",
    type: utf8(),
    default: "",
  },
  {
    name: "coordinates",
    description: "Geometry coordinates of the layer tables: 'wgs84' (default), 'web_mercator' or 'tile'.",
    type: utf8(),
    default: "wgs84",
  },
  {
    name: "max_tiles",
    description: "A layer table scan fails rather than read more than this many tiles.",
    type: int64(),
    default: BigInt(DEFAULT_MAX_TILES),
  },
  {
    name: "tile_edges",
    description:
      "Features reaching a tile edge: 'merge' (default, one row per feature), 'clip' (one non-overlapping " +
      "piece per tile) or 'raw' (as stored, tile buffers included).",
    type: utf8(),
    default: "merge",
  },
];

/** The tileset settings of one ATTACH. */
export interface TilesetAttach {
  source: string;
  zoom: number | null;
  coordinates: Coordinates;
  bbox: BBox | null;
  max_tiles: number;
  tile_edges: TileEdges;
}

/** Parse `'west,south,east,north'` (degrees); empty means the whole tileset. */
export function parseBBox(raw: string): BBox | null {
  const text = raw.trim();
  if (!text) return null;
  const bad = () => new Error(`bbox must be 'west,south,east,north' in degrees, got '${raw}'`);
  const values = text
    .replace(/ /g, ",")
    .split(",")
    .filter((p) => p)
    .map(Number);
  if (values.length !== 4 || !values.every(Number.isFinite)) throw bad();
  const [w, s, e, n] = values as [number, number, number, number];
  if (!(-180 <= w && w <= e && e <= 180 && -90 <= s && s <= n && n <= 90)) {
    throw new Error(`bbox needs -180 <= west <= east <= 180 and -90 <= south <= north <= 90, got '${raw}'`);
  }
  return [w, s, e, n];
}

const num = (v: unknown, fallback: number): number =>
  v === null || v === undefined || v === "" ? fallback : Number(v);

/** Read and validate the tileset options; null when no `tileset` was given. */
export function tilesetAttach(options: Record<string, unknown>): TilesetAttach | null {
  const source = String(options.tileset ?? "").trim();
  if (!source) return null;
  const zoomRaw = num(options.zoom, -1);
  if (!Number.isInteger(zoomRaw)) throw new Error(`zoom must be an integer, got ${options.zoom}`);
  const zoom = zoomRaw < 0 ? null : zoomRaw;
  if (zoom !== null && zoom > 30) throw new Error(`zoom must be between 0 and 30, got ${zoom}`);
  const coordinates = String(options.coordinates || "wgs84");
  if (!(COORDINATE_CHOICES as readonly string[]).includes(coordinates)) {
    throw new Error(`coordinates must be one of ${COORDINATE_CHOICES.join(", ")}, got '${coordinates}'`);
  }
  const maxTiles = num(options.max_tiles, DEFAULT_MAX_TILES) || DEFAULT_MAX_TILES;
  if (!Number.isInteger(maxTiles) || maxTiles < 1) throw new Error(`max_tiles must be at least 1, got ${maxTiles}`);
  if (maxTiles > 2 ** 31 - 1) throw new Error(`max_tiles must be at most ${2 ** 31 - 1}, got ${maxTiles}`);
  const tileEdges = String(options.tile_edges || "merge");
  if (!(TILE_EDGE_CHOICES as readonly string[]).includes(tileEdges)) {
    throw new Error(`tile_edges must be one of ${TILE_EDGE_CHOICES.join(", ")}, got '${tileEdges}'`);
  }
  return {
    source,
    zoom,
    coordinates: coordinates as Coordinates,
    bbox: parseBBox(String(options.bbox ?? "")),
    max_tiles: maxTiles,
    tile_edges: tileEdges as TileEdges,
  };
}

function encodeAttach(attach: TilesetAttach): Uint8Array {
  return encoder.encode(PREFIX + JSON.stringify({ v: 1, ...attach }));
}

/** The tileset settings carried in `attach_opaque_data`, or null for a functions-only attach. */
export function decodeAttach(data: Uint8Array | null | undefined): TilesetAttach | null {
  if (!data || data.length <= PREFIX.length) return null;
  const text = decoder.decode(data);
  if (!text.startsWith(PREFIX)) return null;
  const d = JSON.parse(text.slice(PREFIX.length)) as Partial<TilesetAttach>;
  return {
    source: String(d.source),
    zoom: d.zoom ?? null,
    coordinates: (d.coordinates ?? "wgs84") as Coordinates,
    bbox: d.bbox ? [Number(d.bbox[0]), Number(d.bbox[1]), Number(d.bbox[2]), Number(d.bbox[3])] : null,
    max_tiles: Number(d.max_tiles ?? DEFAULT_MAX_TILES),
    tile_edges: (d.tile_edges ?? "merge") as TileEdges,
  };
}

async function layersOf(attach: TilesetAttach): Promise<LayerInfo[]> {
  return (await (await openSource(attach.source)).info()).layers;
}

async function zoomOf(attach: TilesetAttach): Promise<number | null> {
  return attach.zoom ?? (await (await openSource(attach.source)).info()).maxzoom;
}

function layerComment(layer: LayerInfo, attach: TilesetAttach, zoom: number | null): string {
  const parts = layer.description?.trim() ? [layer.description.trim()] : [];
  parts.push(`Features of the \`${layer.id}\` layer of ${attach.source}, read at zoom ${zoom}.`);
  if (layer.minzoom !== null && zoom !== null && zoom < layer.minzoom) {
    parts.push(`The layer starts at zoom ${layer.minzoom}, so it is empty at this zoom.`);
  }
  return parts.join(" ");
}

const isMain = (path: string[]): boolean => path.length === 1 && path[0]!.toLowerCase() === "main";

/** The `mvt` catalog: reader functions, plus one table per layer when a tileset is attached. */
export class TilesetCatalog extends ReadOnlyCatalogInterface {
  // The tables depend on the ATTACH options: never share one catalog_contents
  // snapshot between attaches, and let catalog items carry the attach's bytes.
  override catalogContentsAttachIndependent = false;
  override perAttachItemIds = true;

  /**
   * One descriptor catalog per distinct tileset attach, holding its layer tables;
   * the SDK then serves their columns, comments and nullability as for any static table.
   */
  private readonly inner = new Map<string, Promise<ReadOnlyCatalogInterface>>();

  constructor(
    private readonly descriptor: CatalogDescriptor,
    private readonly registry: FunctionRegistry,
  ) {
    super(descriptor, registry, { perAttachItemIds: true });
  }

  override attachOptionSpecs(_name: string): AttachOptionSpec[] {
    return TILESET_ATTACH_OPTIONS;
  }

  override async attach(
    name: string,
    options?: Record<string, unknown>,
    dataVersionSpec?: string | null,
    implementationVersion?: string | null,
    clientCapabilities?: Uint8Array | null,
  ): Promise<CatalogAttachResult> {
    const attach = tilesetAttach(options ?? {});
    const base = await super.attach(name, options, dataVersionSpec, implementationVersion, clientCapabilities);
    if (!attach) return base;
    if (sourceFormat(attach.source) === "xyz") {
      throw new Error(
        "a {z}/{x}/{y} URL template has no layer metadata, so it cannot be attached as a database; " +
          "query it with read_tiles(...) instead",
      );
    }
    if ((await layersOf(attach)).length === 0) {
      throw new Error(
        `${attach.source} declares no vector_layers metadata, so there are no tables to list; ` +
          "query it with read_tiles(...) instead",
      );
    }
    return { ...base, attach_opaque_data: encodeAttach(attach) };
  }

  /** The descriptor catalog serving this attach's layer tables; null without a tileset. */
  private tablesFor(attachOpaqueData: Uint8Array): Promise<ReadOnlyCatalogInterface> | null {
    const attach = decodeAttach(attachOpaqueData);
    if (!attach) return null;
    const key = JSON.stringify(attach);
    let cat = this.inner.get(key);
    if (!cat) {
      cat = this.buildTables(attach);
      this.inner.set(key, cat);
      cat.catch(() => this.inner.delete(key)); // retry a failed open on the next call
    }
    return cat;
  }

  private async buildTables(attach: TilesetAttach): Promise<ReadOnlyCatalogInterface> {
    const zoom = await zoomOf(attach);
    const tables = (await layersOf(attach)).map((layer) => ({
      name: layer.id,
      columns: outputSchema(attach.coordinates, attributeFields(layer.fields)),
      comment: layerComment(layer, attach, zoom),
      tags: {
        "vgi.title": `Layer ${layer.id}`,
        "mvt.tileset": attach.source,
        "mvt.layer": layer.id,
        "mvt.zoom": zoom === null ? "" : String(zoom),
        "mvt.attributes": JSON.stringify(layer.fields),
      },
    }));
    const main = this.descriptor.schemas.find((s) => isMain(s.path ?? [s.name ?? ""]));
    const descriptor: CatalogDescriptor = {
      ...this.descriptor,
      schemas: [{ ...main, path: MAIN, functions: [], tables }],
    };
    return new ReadOnlyCatalogInterface(descriptor, this.registry, { perAttachItemIds: true });
  }

  private async layerTables(attachOpaqueData: Uint8Array, path: string[]): Promise<TableInfo[]> {
    const cat = isMain(path) ? this.tablesFor(attachOpaqueData) : null;
    return cat ? (await cat).schemaContentsTables(attachOpaqueData, MAIN) : [];
  }

  /** `main`'s advertised table count: the client skips a listing whose count is 0. */
  private async withTableCount(info: SchemaInfo, attachOpaqueData: Uint8Array): Promise<SchemaInfo> {
    if (!isMain(info.path)) return info;
    const cat = this.tablesFor(attachOpaqueData);
    if (!cat) return info;
    const tables = (await layersOf(decodeAttach(attachOpaqueData)!)).length;
    await cat;
    return { ...info, estimated_object_count: { ...info.estimated_object_count, table: tables } };
  }

  override async schemas(attachOpaqueData: Uint8Array, tx?: Uint8Array): Promise<SchemaInfo[]> {
    const infos = await super.schemas(attachOpaqueData, tx);
    return Promise.all(infos.map((i) => this.withTableCount(i, attachOpaqueData)));
  }

  override async schemaGet(attachOpaqueData: Uint8Array, path: string[], tx?: Uint8Array): Promise<SchemaInfo | null> {
    const info = await super.schemaGet(attachOpaqueData, path, tx);
    return info ? this.withTableCount(info, attachOpaqueData) : null;
  }

  override async schemaContentsTables(attachOpaqueData: Uint8Array, path: string[], tx?: Uint8Array) {
    return [
      ...(await super.schemaContentsTables(attachOpaqueData, path, tx)),
      ...(await this.layerTables(attachOpaqueData, path)),
    ];
  }

  override async tableGet(
    attachOpaqueData: Uint8Array,
    schemaPath: string[],
    name: string,
    atUnit?: string,
    _atValue?: string,
  ): Promise<TableInfo | null> {
    if (atUnit) throw new Error("vector tile layers do not support time travel (AT ...)");
    const tables = await this.layerTables(attachOpaqueData, schemaPath);
    return (
      tables.find((t) => t.name === name) ?? tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null
    );
  }

  /** Redirect a layer table scan to `read_tiles` with the attach's settings. */
  override async tableScanFunctionGet(
    attachOpaqueData: Uint8Array,
    schemaPath: string[],
    name: string,
    atUnit?: string,
    atValue?: string,
  ) {
    const attach = decodeAttach(attachOpaqueData);
    const table = await this.tableGet(attachOpaqueData, schemaPath, name, atUnit, atValue);
    if (!attach || !table) throw new Error(`no layer table named '${name}' in this tileset`);
    const fields: VgiField[] = [
      field("arg_0", utf8(), true),
      field("layer", utf8(), true),
      field("coordinates", utf8(), true),
      field("max_tiles", int32(), true),
      field("tile_edges", utf8(), true),
    ];
    const values: Record<string, unknown[]> = {
      arg_0: [attach.source],
      layer: [table.tags["mvt.layer"] ?? table.name],
      coordinates: [attach.coordinates],
      max_tiles: [attach.max_tiles],
      tile_edges: [attach.tile_edges],
    };
    if (attach.zoom !== null) {
      fields.push(field("zoom", int32(), true));
      values.zoom = [attach.zoom];
    }
    if (attach.bbox) {
      ["west", "south", "east", "north"].forEach((k, i) => {
        fields.push(field(k, float64(), true));
        values[k] = [attach.bbox![i]];
      });
    }
    return {
      function_name: "read_tiles",
      arguments: serializeBatch(batchFromColumns(values, schema(fields))),
      required_extensions: [],
      schema_path: MAIN,
    };
  }
}
