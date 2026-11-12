/**
 * Where tiles come from: PMTiles v3 archives (URL or local file) and XYZ URL templates.
 *
 * A port of vgi-mvt's `sources.py`, minus MBTiles (SQLite has no place in a browser
 * worker). Remote reads use HTTP range requests through global `fetch`, so the same
 * code runs in Bun, Cloudflare Workers and a browser Web Worker. Local paths need Bun.
 */

import { type BBox, MvtDecodeError, maybeDecompress, tileRange } from "./mvt.ts";

export class TileSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TileSourceError";
  }
}

export type TileKey = [z: number, x: number, y: number];

export interface LayerInfo {
  id: string;
  fields: Record<string, string>;
  description: string | null;
  minzoom: number | null;
  maxzoom: number | null;
}

export interface TilesetInfo {
  format: "pmtiles" | "xyz";
  minzoom: number | null;
  maxzoom: number | null;
  bounds: BBox | null;
  metadata: Record<string, unknown>;
  layers: LayerInfo[];
}

export interface TileSource {
  info(): Promise<TilesetInfo>;
  /** Tiles at zoom z (inside bbox); throws when there are more than `limit`. */
  tiles(z: number, bbox: BBox | null, limit: number): Promise<TileKey[]>;
  /** Decompressed bytes of the tiles that exist, in order. */
  fetch(keys: TileKey[]): Promise<[TileKey, Uint8Array][]>;
}

export const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

const HTTP_TIMEOUT_MS = 30_000;
const HTTP_RETRIES = 4;
const HEAD_BYTES = 16384;
const DIRECTORY_CACHE = 256;
const COALESCE_GAP = 64 << 10;
const COALESCE_MAX = 8 << 20;
const FETCH_CONCURRENCY = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a URL (optionally a byte range). Returns null on 404/204; retries 429 and 5xx. */
export async function httpGet(url: string, range?: [offset: number, length: number]): Promise<Uint8Array | null> {
  const headers: Record<string, string> = {};
  if (range) headers.Range = `bytes=${range[0]}-${range[0] + range[1] - 1}`;
  let lastStatus = 0;
  for (let attempt = 0; attempt <= HTTP_RETRIES; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch (err) {
      if (attempt === HTTP_RETRIES) throw new TileSourceError(`fetching ${url} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (resp.status === 404 || resp.status === 204) return null;
    if (resp.status === 429 || resp.status >= 500) {
      lastStatus = resp.status;
      const retryAfter = Number(resp.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt);
      continue;
    }
    if (!resp.ok) throw new TileSourceError(`HTTP ${resp.status} fetching ${url}`);
    const body = new Uint8Array(await resp.arrayBuffer());
    if (range && resp.status === 200) {
      // The server ignored the Range header and sent the whole file.
      return body.subarray(range[0], range[0] + range[1]);
    }
    return body;
  }
  throw new TileSourceError(`HTTP ${lastStatus} fetching ${url} (gave up after ${HTTP_RETRIES} retries)`);
}

/** Random-access bytes from a URL or (under Bun) a local file. */
class ByteSource {
  private head: Uint8Array = new Uint8Array();
  private constructor(readonly source: string) {}

  static async open(source: string): Promise<ByteSource> {
    const b = new ByteSource(source);
    b.head = await b.read(0, HEAD_BYTES, true);
    if (b.head.length === 0) throw new TileSourceError(`${source} is empty or missing`);
    return b;
  }

  private async read(offset: number, length: number, head = false): Promise<Uint8Array> {
    if (isUrl(this.source)) {
      const data = await httpGet(this.source, [offset, length]);
      if (!data) throw new TileSourceError(`HTTP 404 reading ${head ? "" : `bytes ${offset}+${length} of `}${this.source}`);
      return data;
    }
    const bun = (globalThis as { Bun?: { file(p: string): Blob } }).Bun;
    if (!bun) throw new TileSourceError(`local files need the Bun runtime; use an http(s) URL for ${this.source}`);
    const path = this.source.startsWith("~/") ? `${process.env.HOME}${this.source.slice(1)}` : this.source;
    try {
      return new Uint8Array(await bun.file(path).slice(offset, offset + length).arrayBuffer());
    } catch (err) {
      throw new TileSourceError(`cannot open ${this.source}: ${(err as Error).message}`);
    }
  }

  get(offset: number, length: number): Promise<Uint8Array> {
    if (offset + length <= this.head.length) return Promise.resolve(this.head.subarray(offset, offset + length));
    return this.read(offset, length);
  }
}

// ---------------------------------------------------------------- PMTiles v3

interface Header {
  rootOffset: number;
  rootLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafOffset: number;
  tileDataOffset: number;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  bounds: BBox;
}

const COMPRESSION = ["unknown", "none", "gzip", "brotli", "zstd"];

function parseHeader(b: Uint8Array, source: string): Header {
  const magic = new TextDecoder().decode(b.subarray(0, 7));
  if (b.length < 127 || magic !== "PMTiles" || b[7] !== 3) {
    throw new TileSourceError(`${source} is not a PMTiles v3 archive`);
  }
  const v = new DataView(b.buffer, b.byteOffset, 127);
  const u64 = (at: number) => Number(v.getBigUint64(at, true));
  const e7 = (at: number) => v.getInt32(at, true) / 1e7;
  return {
    rootOffset: u64(8),
    rootLength: u64(16),
    metadataOffset: u64(24),
    metadataLength: u64(32),
    leafOffset: u64(40),
    tileDataOffset: u64(56),
    internalCompression: v.getUint8(97),
    tileCompression: v.getUint8(98),
    tileType: v.getUint8(99),
    minZoom: v.getUint8(100),
    maxZoom: v.getUint8(101),
    bounds: [e7(102), e7(106), e7(110), e7(114)],
  };
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

function readVarint(buf: Uint8Array, pos: { at: number }): number {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos.at >= buf.length) throw new TileSourceError("corrupt PMTiles directory: truncated varint");
    const b = buf[pos.at++]!;
    result += (b & 0x7f) * mul;
    if (b < 0x80) return result;
    mul *= 128;
  }
  throw new TileSourceError("corrupt PMTiles directory: varint too long");
}

/** Decode an already-decompressed PMTiles v3 directory. */
export function parseDirectory(buf: Uint8Array): Entry[] {
  const pos = { at: 0 };
  const n = readVarint(buf, pos);
  const ids = new Array<number>(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last += readVarint(buf, pos);
    ids[i] = last;
  }
  const cols: number[][] = [];
  for (let c = 0; c < 3; c++) {
    const col = new Array<number>(n);
    for (let i = 0; i < n; i++) col[i] = readVarint(buf, pos);
    cols.push(col); // run_lengths, lengths, offsets
  }
  const entries: Entry[] = [];
  for (let i = 0; i < n; i++) {
    const rawOffset = cols[2]![i]!;
    const length = cols[1]![i]!;
    const prev = entries[i - 1];
    const offset = i > 0 && rawOffset === 0 && prev ? prev.offset + prev.length : rawOffset - 1;
    entries.push({ tileId: ids[i]!, offset, length, runLength: cols[0]![i]! });
  }
  return entries;
}

function findTile(entries: Entry[], tileId: number): Entry | null {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = tileId - entries[mid]!.tileId;
    if (c > 0) lo = mid + 1;
    else if (c < 0) hi = mid - 1;
    else return entries[mid]!;
  }
  if (hi >= 0) {
    const e = entries[hi]!;
    if (e.runLength === 0) return e; // a leaf directory
    if (tileId - e.tileId < e.runLength) return e;
  }
  return null;
}

// Hilbert tile ids (the PMTiles v3 spec).
function rotate(n: number, xy: [number, number], rx: number, ry: number): void {
  if (ry === 0) {
    if (rx === 1) {
      xy[0] = n - 1 - xy[0];
      xy[1] = n - 1 - xy[1];
    }
    const t = xy[0];
    xy[0] = xy[1];
    xy[1] = t;
  }
}

const levelStart = (z: number): number => (4 ** z - 1) / 3;

export function zxyToTileId(z: number, x: number, y: number): number {
  if (z > 26) throw new TileSourceError("zoom above 26 is not supported");
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw new TileSourceError(`tile ${z}/${x}/${y} is outside the world`);
  const xy: [number, number] = [x, y];
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    // Bitwise, as in the PMTiles reference: a rotation can make xy negative, and the
    // two's-complement bit test is what the spec's ids are built from. z <= 26 fits int32.
    const rx = (xy[0] & s) !== 0 ? 1 : 0;
    const ry = (xy[1] & s) !== 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    rotate(s, xy, rx, ry);
  }
  return levelStart(z) + d;
}

export function tileIdToZxy(id: number): TileKey {
  let acc = 0;
  for (let z = 0; z <= 26; z++) {
    const count = 4 ** z;
    if (acc + count > id) {
      let t = id - acc;
      const n = 2 ** z;
      const xy: [number, number] = [0, 0];
      for (let s = 1; s < n; s *= 2) {
        const rx = Math.floor(t / 2) % 2;
        const ry = (t ^ rx) & 1; // t < 2^53, but only its low bit matters here
        rotate(s, xy, rx, ry);
        xy[0] += s * rx;
        xy[1] += s * ry;
        t = Math.floor(t / 4);
      }
      return [z, xy[0], xy[1]];
    }
    acc += count;
  }
  throw new TileSourceError(`tile id ${id} is beyond zoom 26`);
}

function checkCount(z: number, count: number, limit: number, shown?: number): void {
  if (count > limit) {
    throw new TileSourceError(
      `more than ${shown ?? limit} tiles at zoom ${z} (max_tiles); narrow the area with the ` +
        "west/south/east/north arguments, pick a lower zoom, or raise max_tiles",
    );
  }
}

async function partDecompress(data: Uint8Array, compression: number, what: string): Promise<Uint8Array> {
  if (compression === 1) return data;
  if (compression === 3 || compression === 4) {
    throw new TileSourceError(`PMTiles ${COMPRESSION[compression]} compression is not supported (only gzip/none)`);
  }
  try {
    return await maybeDecompress(data);
  } catch (err) {
    if (err instanceof MvtDecodeError) throw new TileSourceError(`corrupt PMTiles ${what}: ${err.message}`);
    throw err;
  }
}

export function parseVectorLayers(raw: unknown): LayerInfo[] {
  if (!Array.isArray(raw)) return [];
  const intOrNull = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
  const out: LayerInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || !("id" in item)) continue;
    const it = item as Record<string, unknown>;
    const fields = it.fields && typeof it.fields === "object" ? (it.fields as Record<string, unknown>) : {};
    out.push({
      id: String(it.id),
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])),
      description: typeof it.description === "string" && it.description ? it.description : null,
      minzoom: intOrNull(it.minzoom),
      maxzoom: intOrNull(it.maxzoom),
    });
  }
  return out;
}

export class PMTilesSource implements TileSource {
  private readonly dirs = new Map<string, Promise<Entry[]>>();
  private infoCache: Promise<TilesetInfo> | null = null;

  private constructor(
    private readonly bytes: ByteSource,
    readonly header: Header,
  ) {}

  static async open(source: string): Promise<PMTilesSource> {
    const bytes = await ByteSource.open(source);
    const header = parseHeader(await bytes.get(0, 127), source);
    if (header.tileType !== 0 && header.tileType !== 1) {
      throw new TileSourceError(`${source} holds tile type ${header.tileType}, not vector tiles`);
    }
    return new PMTilesSource(bytes, header);
  }

  private directory(offset: number, length: number): Promise<Entry[]> {
    const key = `${offset}:${length}`;
    let d = this.dirs.get(key);
    if (d) {
      this.dirs.delete(key);
      this.dirs.set(key, d); // LRU: most recent last
      return d;
    }
    d = (async () => {
      const raw = await partDecompress(await this.bytes.get(offset, length), this.header.internalCompression, "directory");
      return parseDirectory(raw);
    })();
    d.catch(() => this.dirs.delete(key));
    this.dirs.set(key, d);
    while (this.dirs.size > DIRECTORY_CACHE) this.dirs.delete(this.dirs.keys().next().value!);
    return d;
  }

  info(): Promise<TilesetInfo> {
    this.infoCache ??= (async () => {
      const h = this.header;
      let meta: Record<string, unknown> = {};
      if (h.metadataLength) {
        const raw = await partDecompress(
          await this.bytes.get(h.metadataOffset, h.metadataLength),
          h.internalCompression,
          "metadata",
        );
        try {
          const parsed = JSON.parse(new TextDecoder().decode(raw));
          if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
        } catch {
          meta = {};
        }
      }
      return {
        format: "pmtiles",
        minzoom: h.minZoom,
        maxzoom: h.maxZoom,
        bounds: h.bounds,
        metadata: meta,
        layers: parseVectorLayers(meta.vector_layers),
      };
    })();
    return this.infoCache;
  }

  /** [absolute offset, length] of a tile's bytes, or null when the archive doesn't have it. */
  async lookup(tileId: number): Promise<[number, number] | null> {
    const h = this.header;
    let offset = h.rootOffset;
    let length = h.rootLength;
    for (let depth = 0; depth < 4; depth++) {
      const entry = findTile(await this.directory(offset, length), tileId);
      if (!entry) return null;
      if (entry.runLength === 0) {
        offset = h.leafOffset + entry.offset;
        length = entry.length;
        continue;
      }
      return [h.tileDataOffset + entry.offset, entry.length];
    }
    return null;
  }

  async tiles(z: number, bbox: BBox | null, limit: number): Promise<TileKey[]> {
    if (bbox) {
      const [x0, y0, x1, y1] = tileRange(z, bbox);
      // Sparse archives may hold far fewer tiles than the bbox covers: allow 4x candidates.
      checkCount(z, (x1 - x0 + 1) * (y1 - y0 + 1), limit * 4, limit);
      const candidates: TileKey[] = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) candidates.push([z, x, y]);
      const found = await mapLimit(candidates, FETCH_CONCURRENCY, async (k) =>
        (await this.lookup(zxyToTileId(...k))) ? k : null,
      );
      const keys = found.filter((k): k is TileKey => k !== null);
      checkCount(z, keys.length, limit);
      return keys;
    }
    const lo = zxyToTileId(z, 0, 0);
    const hi = levelStart(z + 1);
    const found: TileKey[] = [];
    await this.walk(this.header.rootOffset, this.header.rootLength, lo, hi, found, limit);
    checkCount(z, found.length, limit);
    found.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    return found;
  }

  private async walk(offset: number, length: number, lo: number, hi: number, found: TileKey[], limit: number): Promise<void> {
    const entries = await this.directory(offset, length);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const next = i + 1 < entries.length ? entries[i + 1]!.tileId : Number.MAX_SAFE_INTEGER;
      if (e.runLength === 0) {
        if (next > lo && e.tileId < hi) await this.walk(this.header.leafOffset + e.offset, e.length, lo, hi, found, limit);
      } else {
        for (let t = Math.max(e.tileId, lo); t < Math.min(e.tileId + e.runLength, hi); t++) found.push(tileIdToZxy(t));
      }
      if (found.length > limit) return;
    }
  }

  async fetch(keys: TileKey[]): Promise<[TileKey, Uint8Array][]> {
    const locs = await mapLimit(keys, FETCH_CONCURRENCY, (k) => this.lookup(zxyToTileId(...k)));
    const found: [TileKey, [number, number]][] = [];
    keys.forEach((k, i) => {
      const loc = locs[i];
      if (loc) found.push([k, loc]);
    });
    // Tiles are stored in Hilbert order, so nearby tiles are nearby bytes: one request per run.
    const unique = [...new Map(found.map(([, l]) => [`${l[0]}:${l[1]}`, l])).values()].sort((a, b) => a[0] - b[0]);
    const spans = coalesce(unique);
    const raw = new Map<string, Uint8Array>();
    await mapLimit(spans, FETCH_CONCURRENCY, async ([start, length, members]) => {
      const blob = await this.bytes.get(start, length);
      for (const [off, n] of members) raw.set(`${off}:${n}`, blob.subarray(off - start, off - start + n));
    });
    const out: [TileKey, Uint8Array][] = [];
    for (const [k, loc] of found) {
      const data = raw.get(`${loc[0]}:${loc[1]}`)!;
      try {
        out.push([k, await partDecompress(data, this.header.tileCompression, "tile")]);
      } catch (err) {
        throw new MvtDecodeError(`tile ${k.join("/")} is not a valid vector tile: ${(err as Error).message}`);
      }
    }
    return out;
  }
}

function coalesce(locs: [number, number][]): [number, number, [number, number][]][] {
  const spans: [number, number, [number, number][]][] = [];
  for (const [off, n] of locs) {
    const last = spans[spans.length - 1];
    if (last) {
      const end = last[0] + last[1];
      if (off - end <= COALESCE_GAP && Math.max(end, off + n) - last[0] <= COALESCE_MAX) {
        last[2].push([off, n]);
        last[1] = Math.max(end, off + n) - last[0];
        continue;
      }
    }
    spans.push([off, n, [[off, n]]]);
  }
  return spans;
}

/** Map with at most `limit` promises in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// ---------------------------------------------------------------- XYZ templates

export class XYZSource implements TileSource {
  constructor(readonly template: string) {
    for (const part of ["{z}", "{x}", "{y}"]) {
      if (!template.includes(part)) throw new TileSourceError(`tile URL template must contain {z}, {x} and {y}: ${template}`);
    }
    if (!isUrl(template)) throw new TileSourceError(`XYZ templates must be http(s) URLs: ${template}`);
  }

  async info(): Promise<TilesetInfo> {
    return { format: "xyz", minzoom: null, maxzoom: null, bounds: null, metadata: {}, layers: [] };
  }

  async tiles(z: number, bbox: BBox | null, limit: number): Promise<TileKey[]> {
    if (!bbox) throw new TileSourceError("reading an XYZ tile template needs a bbox (west, south, east, north)");
    const [x0, y0, x1, y1] = tileRange(z, bbox);
    checkCount(z, (x1 - x0 + 1) * (y1 - y0 + 1), limit);
    const keys: TileKey[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push([z, x, y]);
    return keys;
  }

  async fetch(keys: TileKey[]): Promise<[TileKey, Uint8Array][]> {
    const got = await mapLimit(keys, FETCH_CONCURRENCY, async (k): Promise<[TileKey, Uint8Array] | null> => {
      const url = this.template.replace("{z}", String(k[0])).replace("{x}", String(k[1])).replace("{y}", String(k[2]));
      const data = await httpGet(url);
      if (!data || data.length === 0) return null;
      try {
        return [k, await maybeDecompress(data)];
      } catch (err) {
        throw new MvtDecodeError(`tile ${k.join("/")} is not a valid vector tile: ${(err as Error).message}`);
      }
    });
    return got.filter((g): g is [TileKey, Uint8Array] => g !== null);
  }
}

// ---------------------------------------------------------------- opening

const OPEN = new Map<string, Promise<TileSource>>();

export function sourceFormat(source: string): "pmtiles" | "xyz" {
  if (source.includes("{z}")) return "xyz";
  const path = source.split("?", 1)[0]!.toLowerCase();
  if (path.endsWith(".mbtiles")) throw new TileSourceError("MBTiles is not supported by this worker; use PMTiles");
  return "pmtiles"; // the header check rejects anything else
}

/** Open (and cache per process) the tileset behind `source`. */
export function openSource(source: string): Promise<TileSource> {
  let hit = OPEN.get(source);
  if (hit) {
    OPEN.delete(source);
    OPEN.set(source, hit);
    return hit;
  }
  hit = sourceFormat(source) === "xyz" ? Promise.resolve(new XYZSource(source)) : PMTilesSource.open(source);
  hit.catch(() => OPEN.delete(source));
  OPEN.set(source, hit);
  while (OPEN.size > 16) OPEN.delete(OPEN.keys().next().value!);
  return hit;
}
