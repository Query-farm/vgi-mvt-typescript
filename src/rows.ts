/**
 * Turn decoded tiles into Arrow batches, one row per feature.
 *
 * Every reader shares the leading columns (layer, z, x, y, feature_id,
 * geometry_type, geometry, properties). With a single `layer`, each attribute that
 * the tileset metadata lists for it also becomes a typed column.
 */

import type { VgiDataType, VgiField, VgiSchema } from "@query-farm/vgi";
import {
  batchFromColumns,
  binary,
  bool,
  field,
  float64,
  int32,
  int64,
  schema,
  uint64,
  utf8,
} from "@query-farm/vgi/worker-cf";
import { clipParts, type TileEdges } from "./edges.ts";
import { column } from "./meta.ts";
import {
  type Coordinates,
  decodeGeometry,
  decodeTile,
  type Layer,
  Projector,
  type PropertyValue,
  partsWkb,
} from "./mvt.ts";

const CRS: Record<Coordinates, string | null> = { wgs84: "OGC:CRS84", web_mercator: "EPSG:3857", tile: null };

function geometryField(coordinates: Coordinates): VgiField {
  const crs = CRS[coordinates];
  return field(
    "geometry",
    binary(),
    true,
    new Map([
      ["ARROW:extension:name", "geoarrow.wkb"],
      ["ARROW:extension:metadata", JSON.stringify(crs ? { crs } : {})],
      ["comment", "Feature geometry as a DuckDB GEOMETRY, in the coordinate system chosen by `coordinates`."],
    ]),
  );
}

const propertiesField = (): VgiField =>
  field(
    "properties",
    utf8(),
    true,
    new Map([
      ["ARROW:extension:name", "arrow.json"],
      ["comment", "Every attribute of the feature as a JSON object."],
    ]),
  );

export const BASE_NAMES = new Set(["layer", "z", "x", "y", "feature_id", "geometry_type", "geometry", "properties"]);

function baseFields(coordinates: Coordinates): VgiField[] {
  return [
    column("layer", utf8(), "Name of the vector tile layer the feature belongs to.", false),
    column("z", int32(), "Zoom level of the tile the feature was read from.", false),
    column("x", int32(), "XYZ column of the tile (0 at the antimeridian, increasing east).", false),
    column("y", int32(), "XYZ row of the tile (0 at the north edge, increasing south).", false),
    column("feature_id", uint64(), "Feature id stored in the tile, or NULL when the encoder set none."),
    column(
      "geometry_type",
      utf8(),
      "OGC type of the geometry: POINT, MULTIPOINT, LINESTRING, MULTILINESTRING, POLYGON or MULTIPOLYGON.",
      false,
    ),
    geometryField(coordinates),
    propertiesField(),
  ];
}

export const RESULT_COLUMNS_DOC = [
  { name: "layer", type: "VARCHAR", description: "Vector tile layer name." },
  { name: "z", type: "INTEGER", description: "Tile zoom level." },
  { name: "x", type: "INTEGER", description: "Tile column (XYZ scheme)." },
  { name: "y", type: "INTEGER", description: "Tile row (XYZ scheme, 0 at the north)." },
  { name: "feature_id", type: "UBIGINT", description: "Feature id from the tile; NULL if absent." },
  { name: "geometry_type", type: "VARCHAR", description: "OGC geometry type of the feature." },
  { name: "geometry", type: "GEOMETRY", description: "Feature geometry (WGS84 lon/lat by default)." },
  { name: "properties", type: "JSON", description: "All feature attributes as a JSON object." },
];

type AttrKind = "number" | "integer" | "boolean" | "string";
const TYPE_MAP: Record<AttrKind, () => VgiDataType> = { number: float64, integer: int64, boolean: bool, string: utf8 };

/** Typed columns for a layer's attributes; names clashing (case-insensitively) with earlier columns stay in `properties`. */
export function attributeFields(fields: Record<string, string>): VgiField[] {
  const out: VgiField[] = [];
  const taken = new Set([...BASE_NAMES]);
  for (const [name, kind] of Object.entries(fields)) {
    if (taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    const make = TYPE_MAP[kind.toLowerCase() as AttrKind] ?? utf8;
    out.push(column(name, make(), `Layer attribute \`${name}\` (${kind}) from the tileset metadata.`));
  }
  return out;
}

/** Infer `{attribute: Number|Integer|Boolean|String}` from decoded features. */
export function inferFieldTypes(layers: Layer[]): Record<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const layer of layers) {
    for (const f of layer.features) {
      for (const [k, v] of f.properties) {
        if (v === null) continue;
        const kind =
          typeof v === "boolean"
            ? "Boolean"
            : typeof v === "bigint"
              ? "Integer"
              : typeof v === "number"
                ? "Number"
                : "String";
        const s = seen.get(k) ?? new Set<string>();
        seen.set(k, s);
        s.add(kind);
      }
    }
  }
  const out: Record<string, string> = {};
  for (const [k, kinds] of seen) {
    if (kinds.size === 1) out[k] = [...kinds][0]!;
    else if ([...kinds].every((x) => x === "Integer" || x === "Number")) out[k] = "Number";
    else out[k] = "String";
  }
  return out;
}

export function outputSchema(coordinates: Coordinates, extra: VgiField[] = []): VgiSchema {
  return schema([...baseFields(coordinates), ...extra]);
}

/** JSON.stringify that writes bigints as numbers and non-finite floats as null. */
export function propertiesJson(props: Map<string, PropertyValue>): string {
  let s = "{";
  let first = true;
  for (const [k, v] of props) {
    if (!first) s += ",";
    first = false;
    s += `${JSON.stringify(k)}:`;
    if (v === null) s += "null";
    else if (typeof v === "bigint") s += v.toString();
    else if (typeof v === "number") s += Number.isFinite(v) ? JSON.stringify(v) : "null";
    else s += JSON.stringify(v);
  }
  return `${s}}`;
}

function convert(v: PropertyValue | undefined, typeName: string): unknown {
  if (v === undefined || v === null) return null;
  switch (typeName) {
    case "bool":
      return typeof v === "boolean" ? v : null;
    case "int64":
      if (typeof v === "bigint") return v >= -(2n ** 63n) && v < 2n ** 63n ? v : null;
      if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 2 ** 63) return BigInt(v);
      return null;
    case "float64":
      if (typeof v === "bigint") return Number(v);
      return typeof v === "number" ? v : null;
    default:
      if (typeof v === "string") return v;
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "bigint") return v.toString();
      return Number.isFinite(v) ? JSON.stringify(v) : null;
  }
}

function typeName(f: VgiField): string {
  const t = f.type as unknown as { typeId?: number; bitWidth?: number; precision?: number; toString(): string };
  const s = String(t).toLowerCase();
  if (s.includes("bool")) return "bool";
  if (s.includes("int64") || (s.includes("int") && t.bitWidth === 64)) return "int64";
  if (s.includes("float") || s.includes("double")) return "float64";
  return "string";
}

/** Accumulate feature rows for one output schema. */
export class RowBuilder {
  private cols: Record<string, unknown[]> = {};
  private readonly extra: { name: string; kind: string }[];

  constructor(
    readonly outSchema: VgiSchema,
    readonly coordinates: Coordinates,
    readonly layer: string | null,
    readonly edges: TileEdges,
  ) {
    this.extra = outSchema.fields
      .filter((f) => !BASE_NAMES.has(f.name))
      .map((f) => ({ name: f.name, kind: typeName(f) }));
    this.reset();
  }

  private reset(): void {
    this.cols = Object.fromEntries(this.outSchema.fields.map((f) => [f.name, []]));
  }

  get length(): number {
    return this.cols.layer!.length;
  }

  addTile(z: number, x: number, y: number, data: Uint8Array): void {
    for (const layer of decodeTile(data, this.layer)) this.addLayer(z, x, y, layer);
  }

  addLayer(z: number, x: number, y: number, layer: Layer): void {
    const p = new Projector(z, x, y, layer.extent, this.coordinates);
    for (const f of layer.features) {
      let parts = decodeGeometry(f.geometry);
      if (this.edges === "clip") {
        parts = clipParts(f.geomType, parts, layer.extent);
        if (parts.length === 0) continue; // nothing of it inside this tile's square
      }
      const [gtype, wkb] = partsWkb(f.geomType, parts, p, layer.version);
      if (this.edges === "clip" && wkb === null) continue;
      const c = this.cols;
      c.layer!.push(layer.name);
      c.z!.push(z);
      c.x!.push(x);
      c.y!.push(y);
      c.feature_id!.push(f.id);
      c.geometry_type!.push(gtype);
      c.geometry!.push(wkb);
      c.properties!.push(propertiesJson(f.properties));
      for (const { name, kind } of this.extra) c[name]!.push(convert(f.properties.get(name), kind));
    }
  }

  take() {
    const batch = batchFromColumns(this.cols as Record<string, unknown[]>, this.outSchema);
    this.reset();
    return batch;
  }
}
