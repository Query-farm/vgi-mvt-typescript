/**
 * Decode Mapbox Vector Tiles (MVT 2.1) into features with WKB geometry.
 *
 * A port of vgi-mvt's `mvt.py`: a minimal protobuf reader for the four MVT
 * messages (Tile, Layer, Feature, Value), the geometry command decoder, polygon
 * ring classification, and a WKB writer. Runs unchanged in Bun, Cloudflare
 * Workers and browser Web Workers: it uses only typed arrays, DataView and
 * DecompressionStream.
 */

export type Coordinates = "wgs84" | "web_mercator" | "tile";
export const COORDINATE_CHOICES: Coordinates[] = ["wgs84", "web_mercator", "tile"];

export type PropertyValue = string | number | bigint | boolean | null;

const EARTH_HALF_CIRCUMFERENCE = Math.PI * 6378137.0;
const RAD_TO_DEG = 180 / Math.PI;

/** A decompressed tile larger than this is refused (a few KB of gzip can expand to GB). */
export const MAX_TILE_BYTES = 64 << 20;

export class MvtDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MvtDecodeError";
  }
}

/** Name the tile in any MvtDecodeError thrown by `fn`. */
export async function inTile<T>(z: number, x: number, y: number, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MvtDecodeError && !err.message.startsWith("tile ")) {
      throw new MvtDecodeError(`tile ${z}/${x}/${y} is not a valid vector tile: ${err.message}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- protobuf

const utf8 = new TextDecoder("utf-8");

/** A cursor over protobuf bytes. Varints are read as Number (exact below 2^53) or BigInt. */
class Reader {
  pos = 0;
  constructor(
    readonly buf: Uint8Array,
    readonly end = buf.length,
  ) {}

  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new MvtDecodeError("truncated varint");
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
    throw new MvtDecodeError("varint too long");
  }

  varint64(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new MvtDecodeError("truncated varint");
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return BigInt.asUintN(64, result); // protobuf truncates varints to 64 bits
      shift += 7n;
    }
    throw new MvtDecodeError("varint too long");
  }

  bytes(): Uint8Array {
    const n = this.varint();
    if (this.pos + n > this.end) throw new MvtDecodeError("truncated length-delimited field");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  fixed(n: 4 | 8): DataView {
    if (this.pos + n > this.end) throw new MvtDecodeError(`truncated fixed${n * 8}`);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, n);
    this.pos += n;
    return view;
  }

  skip(wire: number): void {
    if (wire === 0) this.varint64();
    else if (wire === 2) this.bytes();
    else if (wire === 1) this.fixed(8);
    else if (wire === 5) this.fixed(4);
    else throw new MvtDecodeError(`unsupported protobuf wire type ${wire}`);
  }
}

/** Packed (or single, non-packed) uint32 values, appended to `out`. */
function readPacked(r: Reader, wire: number, out: number[]): void {
  if (wire === 0) {
    out.push(r.varint());
    return;
  }
  if (wire !== 2) {
    r.skip(wire);
    return;
  }
  const body = r.bytes();
  const sub = new Reader(body);
  while (sub.pos < sub.end) out.push(sub.varint());
}

const zigzag = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
const zigzag64 = (n: bigint): bigint => (n >> 1n) ^ -(n & 1n);

function decodeValue(buf: Uint8Array): PropertyValue {
  const r = new Reader(buf);
  let result: PropertyValue = null;
  while (r.pos < r.end) {
    const key = r.varint();
    const num = Math.floor(key / 8);
    const wire = key & 7;
    // Check the wire type too: a corrupt tile can put bytes where a float belongs.
    if (num === 1 && wire === 2) result = utf8.decode(r.bytes());
    else if (num === 2 && wire === 5) result = r.fixed(4).getFloat32(0, true);
    else if (num === 3 && wire === 1) result = r.fixed(8).getFloat64(0, true);
    else if (num === 4 && wire === 0) result = BigInt.asIntN(64, r.varint64());
    else if (num === 5 && wire === 0) result = r.varint64();
    else if (num === 6 && wire === 0) result = zigzag64(r.varint64());
    else if (num === 7 && wire === 0) result = r.varint64() !== 0n;
    else r.skip(wire);
  }
  return result;
}

// ---------------------------------------------------------------- model

export interface Feature {
  id: bigint | null;
  geomType: number;
  geometry: number[];
  properties: Map<string, PropertyValue>;
}

export interface Layer {
  name: string;
  extent: number;
  version: number;
  features: Feature[];
}

async function inflate(data: Uint8Array, format: "gzip" | "deflate", limit: number): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new MvtDecodeError(`tile expands past ${limit >> 20} MiB when decompressed`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof MvtDecodeError) throw err;
    throw new MvtDecodeError(`corrupt ${format === "gzip" ? "gzip" : "zlib"} data: ${(err as Error).message}`);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Undo gzip/zlib compression, which most tile stores apply. Raw MVT never starts with either magic. */
export async function maybeDecompress(data: Uint8Array, limit = MAX_TILE_BYTES): Promise<Uint8Array> {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return inflate(data, "gzip", limit);
  if (data.length >= 2 && data[0] === 0x78 && (data[0] * 256 + data[1]!) % 31 === 0) {
    try {
      return await inflate(data, "deflate", limit);
    } catch (err) {
      if (err instanceof MvtDecodeError && err.message.startsWith("corrupt")) return data; // zlib-looking, but not zlib
      throw err;
    }
  }
  return data;
}

/** Parse already-decompressed MVT bytes into layers; skip layers not matching `layerFilter`. */
export function decodeTile(data: Uint8Array, layerFilter: string | null = null): Layer[] {
  const r = new Reader(data);
  const layers: Layer[] = [];
  while (r.pos < r.end) {
    const key = r.varint();
    const num = Math.floor(key / 8);
    const wire = key & 7;
    if (num === 3 && wire === 2) {
      const layer = decodeLayer(r.bytes(), layerFilter);
      if (layer) layers.push(layer);
    } else r.skip(wire);
  }
  return layers;
}

function decodeLayer(buf: Uint8Array, layerFilter: string | null): Layer | null {
  const r = new Reader(buf);
  let name = "";
  let extent = 4096;
  let version = 1;
  const keys: string[] = [];
  const values: PropertyValue[] = [];
  const rawFeatures: Uint8Array[] = [];
  while (r.pos < r.end) {
    const key = r.varint();
    const num = Math.floor(key / 8);
    const wire = key & 7;
    if (num === 1 && wire === 2) {
      name = utf8.decode(r.bytes());
      if (layerFilter !== null && name !== layerFilter) return null;
    } else if (num === 2 && wire === 2) rawFeatures.push(r.bytes());
    else if (num === 3 && wire === 2) keys.push(utf8.decode(r.bytes()));
    else if (num === 4 && wire === 2) values.push(decodeValue(r.bytes()));
    else if (num === 5 && wire === 0) extent = r.varint();
    else if (num === 15 && wire === 0) version = r.varint();
    else r.skip(wire);
  }
  if (layerFilter !== null && name !== layerFilter) return null;
  const layer: Layer = { name, extent: extent || 4096, version, features: [] };
  for (const raw of rawFeatures) {
    const f = new Reader(raw);
    let id: bigint | null = null;
    let geomType = 0;
    const tags: number[] = [];
    const geometry: number[] = [];
    while (f.pos < f.end) {
      const key = f.varint();
      const num = Math.floor(key / 8);
      const wire = key & 7;
      if (num === 1 && wire === 0) id = f.varint64();
      else if (num === 2) readPacked(f, wire, tags);
      else if (num === 3 && wire === 0) geomType = f.varint();
      else if (num === 4) readPacked(f, wire, geometry);
      else f.skip(wire);
    }
    const properties = new Map<string, PropertyValue>();
    for (let i = 0; i + 1 < tags.length; i += 2) {
      const k = tags[i]!;
      const v = tags[i + 1]!;
      if (k < keys.length && v < values.length) properties.set(keys[k]!, values[v]!);
    }
    layer.features.push({ id, geomType, geometry, properties });
  }
  return layer;
}

// ---------------------------------------------------------------- geometry

/** A ring, line or point group as flat [x0, y0, x1, y1, ...] tile pixels. */
export type Part = number[];

/** Turn the MVT command stream into parts (point groups, lines or rings) in tile pixels. */
export function decodeGeometry(commands: number[]): Part[] {
  const parts: Part[] = [];
  let current: Part = [];
  let x = 0;
  let y = 0;
  let i = 0;
  const n = commands.length;
  while (i < n) {
    const cmd = commands[i++]!;
    const cid = cmd & 7;
    const count = Math.floor(cmd / 8);
    if (cid === 1) {
      for (let k = 0; k < count && i + 1 < n; k++) {
        x += zigzag(commands[i]!);
        y += zigzag(commands[i + 1]!);
        i += 2;
        if (current.length) parts.push(current);
        current = [x, y];
      }
    } else if (cid === 2) {
      for (let k = 0; k < count && i + 1 < n; k++) {
        x += zigzag(commands[i]!);
        y += zigzag(commands[i + 1]!);
        i += 2;
        current.push(x, y);
      }
    } else if (cid === 7) {
      const m = current.length;
      if (m >= 2 && (current[0] !== current[m - 2] || current[1] !== current[m - 1])) current.push(current[0]!, current[1]!);
    } else {
      throw new MvtDecodeError(`unknown geometry command ${cid}`);
    }
  }
  if (current.length) parts.push(current);
  return parts;
}

function signedArea(ring: Part): number {
  let total = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    total += ring[2 * i]! * ring[2 * j + 1]! - ring[2 * j]! * ring[2 * i + 1]!;
  }
  return total / 2;
}

/** Group rings into polygons: a ring with the exterior's winding (the first ring's sign) starts one. */
export function classifyRings(rings: Part[]): Part[][] {
  const polygons: Part[][] = [];
  let exteriorSign = 0;
  for (const ring of rings) {
    const area = signedArea(ring);
    if (area === 0) continue;
    if (exteriorSign === 0) exteriorSign = Math.sign(area);
    if (Math.sign(area) === exteriorSign) polygons.push([ring]);
    else if (polygons.length) polygons[polygons.length - 1]!.push(ring);
  }
  return polygons;
}

function pointInRing(px: number, py: number, ring: Part): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i]!;
    const yi = ring[2 * i + 1]!;
    const xj = ring[2 * j]!;
    const yj = ring[2 * j + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const MAX_NESTING_RINGS = 5000;

/** MVT 1.x had no winding rule: even nesting depth is an exterior, odd is a hole. */
export function classifyRingsByNesting(rings: Part[]): Part[][] {
  if (rings.length > MAX_NESTING_RINGS) return classifyRings(rings);
  type Item = { area: number; bbox: [number, number, number, number]; ring: Part };
  const items: Item[] = [];
  for (const ring of rings) {
    const area = Math.abs(signedArea(ring));
    if (area === 0) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]!);
      x1 = Math.max(x1, ring[i]!);
      y0 = Math.min(y0, ring[i + 1]!);
      y1 = Math.max(y1, ring[i + 1]!);
    }
    items.push({ area, bbox: [x0, y0, x1, y1], ring });
  }
  items.sort((a, b) => b.area - a.area);
  const polygons: Part[][] = [];
  const placed: { bbox: [number, number, number, number]; ring: Part; depth: number; idx: number }[] = [];
  for (const { bbox, ring } of items) {
    const sx = (ring[0]! + ring[2]!) / 2;
    const sy = (ring[1]! + ring[3]!) / 2;
    let parent: { depth: number; idx: number } | null = null;
    for (let k = placed.length - 1; k >= 0; k--) {
      const p = placed[k]!;
      const contains = p.bbox[0] <= bbox[0] && p.bbox[1] <= bbox[1] && p.bbox[2] >= bbox[2] && p.bbox[3] >= bbox[3];
      if (contains && pointInRing(sx, sy, p.ring)) {
        parent = p;
        break;
      }
    }
    const depth = parent ? parent.depth + 1 : 0;
    if (depth % 2 === 0) {
      polygons.push([ring]);
      placed.push({ bbox, ring, depth, idx: polygons.length - 1 });
    } else {
      polygons[parent!.idx]!.push(ring);
      placed.push({ bbox, ring, depth, idx: parent!.idx });
    }
  }
  return polygons;
}

/** Map tile pixels to the requested coordinate system. */
export class Projector {
  private readonly size: number;
  private readonly x0: number;
  private readonly y0: number;
  constructor(
    z: number,
    x: number,
    y: number,
    extent: number,
    readonly coordinates: Coordinates,
  ) {
    this.size = extent * 2 ** z;
    this.x0 = x * extent;
    this.y0 = y * extent;
  }

  /** Project flat [x, y, ...] pixels in place into a new array. */
  project(part: Part): number[] {
    const out = new Array<number>(part.length);
    if (this.coordinates === "tile") {
      for (let i = 0; i < part.length; i++) out[i] = part[i]!;
      return out;
    }
    const { size, x0, y0 } = this;
    if (this.coordinates === "web_mercator") {
      const c = EARTH_HALF_CIRCUMFERENCE;
      for (let i = 0; i < part.length; i += 2) {
        out[i] = ((x0 + part[i]!) / size) * 2 * c - c;
        out[i + 1] = c - ((y0 + part[i + 1]!) / size) * 2 * c;
      }
      return out;
    }
    for (let i = 0; i < part.length; i += 2) {
      out[i] = ((x0 + part[i]!) / size) * 360 - 180;
      const t = Math.PI * (1 - (2 * (y0 + part[i + 1]!)) / size);
      out[i + 1] = Math.atan(Math.sinh(Math.max(-40, Math.min(40, t)))) * RAD_TO_DEG; // as Python's math.degrees
    }
    return out;
  }
}

/** Growable little-endian WKB writer. */
class WkbWriter {
  private buf = new ArrayBuffer(256);
  private view = new DataView(this.buf);
  private pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
  }

  header(type: number): void {
    this.ensure(5);
    this.view.setUint8(this.pos, 1);
    this.view.setUint32(this.pos + 1, type, true);
    this.pos += 5;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  coords(flat: number[]): void {
    this.ensure(flat.length * 8);
    for (const v of flat) {
      this.view.setFloat64(this.pos, v, true);
      this.pos += 8;
    }
  }

  /** A point count followed by the coordinates. */
  sequence(flat: number[]): void {
    this.u32(flat.length / 2);
    this.coords(flat);
  }

  done(): Uint8Array {
    return new Uint8Array(this.buf.slice(0, this.pos));
  }
}

export type GeometryType = "POINT" | "MULTIPOINT" | "LINESTRING" | "MULTILINESTRING" | "POLYGON" | "MULTIPOLYGON" | "UNKNOWN";

function writePolygon(w: WkbWriter, rings: Part[], p: Projector): void {
  w.header(3);
  w.u32(rings.length);
  for (const r of rings) w.sequence(p.project(r));
}

/**
 * The OGC type and WKB of a geometry, from decoded parts. WKB is null for empty or
 * unknown geometry. `version` is the layer's MVT version: 2 classifies polygon rings
 * by winding (the spec), 1 by nesting.
 */
export function partsWkb(gtype: number, parts: Part[], p: Projector, version = 2): [GeometryType, Uint8Array | null] {
  const w = new WkbWriter();
  if (gtype === 1) {
    const points = parts.flat();
    if (points.length === 0) return ["POINT", null];
    const flat = p.project(points);
    if (flat.length === 2) {
      w.header(1);
      w.coords(flat);
      return ["POINT", w.done()];
    }
    w.header(4);
    w.u32(flat.length / 2);
    for (let i = 0; i < flat.length; i += 2) {
      w.header(1);
      w.coords([flat[i]!, flat[i + 1]!]);
    }
    return ["MULTIPOINT", w.done()];
  }
  if (gtype === 2) {
    const lines = parts.filter((l) => l.length >= 4);
    if (lines.length === 0) return ["LINESTRING", null];
    if (lines.length === 1) {
      w.header(2);
      w.sequence(p.project(lines[0]!));
      return ["LINESTRING", w.done()];
    }
    w.header(5);
    w.u32(lines.length);
    for (const l of lines) {
      w.header(2);
      w.sequence(p.project(l));
    }
    return ["MULTILINESTRING", w.done()];
  }
  if (gtype === 3) {
    const usable: Part[] = [];
    for (const ring of parts) {
      if (ring.length < 6) continue;
      const m = ring.length;
      const closed = ring[0] === ring[m - 2] && ring[1] === ring[m - 1] ? ring : [...ring, ring[0]!, ring[1]!];
      if (closed.length >= 8) usable.push(closed);
    }
    const polygons = version >= 2 ? classifyRings(usable) : classifyRingsByNesting(usable);
    if (polygons.length === 0) return ["POLYGON", null];
    if (polygons.length === 1) {
      writePolygon(w, polygons[0]!, p);
      return ["POLYGON", w.done()];
    }
    w.header(6);
    w.u32(polygons.length);
    for (const poly of polygons) writePolygon(w, poly, p);
    return ["MULTIPOLYGON", w.done()];
  }
  return ["UNKNOWN", null];
}

export function featureWkb(f: Feature, p: Projector, version = 2): [GeometryType, Uint8Array | null] {
  return partsWkb(f.geomType, decodeGeometry(f.geometry), p, version);
}

// ---------------------------------------------------------------- tile math

function tileXyFloat(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const la = Math.max(Math.min(lat, 85.0511287798066), -85.0511287798066);
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.asinh(Math.tan((la * Math.PI) / 180)) / Math.PI) / 2) * n;
  return [x, y];
}

/** The XYZ tile containing a WGS84 point at zoom z, clamped to the world. */
export function lonlatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const [x, y] = tileXyFloat(lon, lat, z);
  return [Math.min(Math.max(Math.floor(x), 0), n - 1), Math.min(Math.max(Math.floor(y), 0), n - 1)];
}

export type BBox = [west: number, south: number, east: number, north: number];

/** Inclusive [minX, minY, maxX, maxY] of the tiles covering a bbox; an edge on a tile boundary doesn't pull in the next tile. */
export function tileRange(z: number, [west, south, east, north]: BBox): [number, number, number, number] {
  const n = 2 ** z;
  const [x0, y0] = lonlatToTile(west, north, z);
  const [fx1, fy1] = tileXyFloat(east, south, z);
  const x1 = Math.min(Math.max(Math.ceil(fx1) - 1, x0), n - 1);
  const y1 = Math.min(Math.max(Math.ceil(fy1) - 1, y0), n - 1);
  return [x0, y0, x1, y1];
}
