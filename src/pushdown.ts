/**
 * Turn the spatial filter DuckDB pushes into `read_tiles` into a bounding box.
 * A port of vgi-mvt's `pushdown.py`.
 *
 * For `WHERE ST_Intersects(geometry, <constant>)` (and ST_Contains, ST_Within,
 * ST_Covers, ...) the VGI extension adds an *optional* `geometry && <constant>`
 * filter to the scan of any function that declares
 * `duckdb.spatial/intersects_extent@1`. DuckDB still applies the exact predicate,
 * so the worker may use the constant's bounding box only to read fewer tiles,
 * never to change the answer. Every helper here errs towards "no box" (read
 * everything) when it is unsure.
 */

import type { BBox, Coordinates } from "./mvt.ts";

export const INTERSECTS_EXTENT = { namespace: "duckdb.spatial", name: "intersects_extent", version: 1 };
const GEOMETRY_COLUMN = "geometry";
const R = 6378137.0;
const MAX_LAT = 85.0511287798066;

class WkbError extends Error {}

/** [minX, minY, maxX, maxY] of a WKB/EWKB geometry; null if empty, invalid or non-finite. */
export function wkbEnvelope(wkb: Uint8Array): [number, number, number, number] | null {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  try {
    const view = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const end = readGeometry(view, 0, box, 0);
    if (end !== wkb.length || !box.every(Number.isFinite)) return null;
  } catch {
    return null;
  }
  return [box[0]!, box[1]!, box[2]!, box[3]!];
}

function readGeometry(v: DataView, pos: number, box: number[], depth: number): number {
  if (depth > 32) throw new WkbError("geometry nested too deeply");
  const order = v.getUint8(pos);
  if (order !== 0 && order !== 1) throw new WkbError("bad byte order");
  const le = order === 1;
  let code = v.getUint32(pos + 1, le);
  pos += 5;
  let hasZ = (code & 0x80000000) !== 0;
  let hasM = (code & 0x40000000) !== 0;
  if (code & 0x20000000) pos += 4; // EWKB SRID
  code &= 0x0fffffff;
  const base = code % 1000;
  const iso = Math.floor(code / 1000);
  if (iso === 1 || iso === 3) hasZ = true;
  if (iso === 2 || iso === 3) hasM = true;
  const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  if (base === 1) return readPoints(v, pos, le, dims, 1, box);
  if (base === 2) return readPoints(v, pos + 4, le, dims, v.getUint32(pos, le), box);
  if (base === 3) {
    const rings = v.getUint32(pos, le);
    pos += 4;
    for (let i = 0; i < rings; i++) pos = readPoints(v, pos + 4, le, dims, v.getUint32(pos, le), box);
    return pos;
  }
  if (base >= 4 && base <= 7) {
    const parts = v.getUint32(pos, le);
    pos += 4;
    for (let i = 0; i < parts; i++) pos = readGeometry(v, pos, box, depth + 1);
    return pos;
  }
  throw new WkbError(`unsupported WKB type ${code}`);
}

function readPoints(v: DataView, pos: number, le: boolean, dims: number, n: number, box: number[]): number {
  if (n > (v.byteLength - pos) / (8 * dims)) throw new WkbError("point count exceeds the buffer");
  for (let i = 0; i < n; i++) {
    const x = v.getFloat64(pos + i * dims * 8, le);
    const y = v.getFloat64(pos + i * dims * 8 + 8, le);
    if (Number.isNaN(x) && Number.isNaN(y)) continue; // an empty point is written as NaN NaN
    box[0] = Math.min(box[0]!, x);
    box[1] = Math.min(box[1]!, y);
    box[2] = Math.max(box[2]!, x);
    box[3] = Math.max(box[3]!, y);
  }
  return pos + n * dims * 8;
}

/** Inverse spherical Web Mercator (EPSG:3857 metres to degrees). */
export function mercatorToLonlat(x: number, y: number): [number, number] {
  const lon = ((x / R) * 180) / Math.PI;
  const lat = ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI;
  return [lon, lat];
}

/** An envelope in the output coordinates as a WGS84 bbox; null when it can't be (raw tile pixels). */
function toLonlatBox(env: [number, number, number, number], coordinates: Coordinates): BBox | null {
  if (coordinates === "tile") return null;
  let [w, s, e, n] = env;
  if (coordinates === "web_mercator") {
    [w, s] = mercatorToLonlat(w, s);
    [e, n] = mercatorToLonlat(e, n);
  }
  return [w, s, e, n];
}

/** Intersect two optional boxes; false when they are disjoint (nothing can match). */
export function intersect(a: BBox | null, b: BBox | null): BBox | null | false {
  if (!a) return b;
  if (!b) return a;
  const w = Math.max(a[0], b[0]);
  const s = Math.max(a[1], b[1]);
  const e = Math.min(a[2], b[2]);
  const n = Math.min(a[3], b[3]);
  return w > e || s > n ? false : [w, s, e, n];
}

/** Clip a bbox to the area tiles cover; false when it lies entirely outside it. */
export function clampToWorld([w, s, e, n]: BBox): BBox | false {
  if (e < -180 || w > 180 || n < -MAX_LAT || s > MAX_LAT) return false;
  return [Math.max(w, -180), Math.max(s, -MAX_LAT), Math.min(e, 180), Math.min(n, MAX_LAT)];
}

type Expr = { node: string; [k: string]: unknown };

/**
 * The WGS84 box implied by the pushed `geometry && <constant>` filters (top-level
 * predicates are ANDed). null when there is no usable spatial filter, false when the
 * filters prove that no feature can match.
 */
export function pushedBBox(
  filters: { predicates?: { expression: unknown }[] } | undefined,
  coordinates: Coordinates,
): BBox | null | false {
  if (!filters?.predicates) return null;
  let current: BBox | null = null;
  for (const pred of filters.predicates) {
    const call = pred.expression as Expr;
    if (call?.node !== "call") continue;
    const fn = call.function as { namespace?: string; name?: string; version?: number } | string;
    if (
      typeof fn !== "object" ||
      fn.namespace !== INTERSECTS_EXTENT.namespace ||
      fn.name !== INTERSECTS_EXTENT.name ||
      fn.version !== INTERSECTS_EXTENT.version
    ) {
      continue;
    }
    const args = (call.arguments as Expr[]) ?? [];
    if (args.length !== 2) continue;
    const column = args.find((a) => a.node === "column_ref");
    const literal = args.find((a) => a.node === "literal");
    if (!column || !literal || column.columnName !== GEOMETRY_COLUMN) continue;
    if (!(literal.value instanceof Uint8Array)) continue;
    const env = wkbEnvelope(literal.value);
    if (!env) continue;
    const box = toLonlatBox(env, coordinates);
    if (!box) continue;
    const combined = intersect(current, box);
    if (combined === false) return false;
    current = combined;
  }
  return current;
}
