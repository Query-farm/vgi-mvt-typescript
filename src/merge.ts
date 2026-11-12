/**
 * `tile_edges := 'merge'`: one row per feature, joining the pieces of features that
 * cross tile edges. A port of vgi-mvt's `edges.py` (EdgeAssembler).
 *
 * Points are kept only by the tile that owns them. Lines and polygons that reach a
 * tile edge are clipped to their tile, and the pieces that share a layer, feature
 * id, geometry kind and properties are joined across neighbouring tiles: polygons
 * by union (polygon-clipping, where Python uses GEOS), lines by joining their ends
 * (GEOS's line merge). The joined row is reported at the first tile, in read order,
 * that holds a piece. Features without an id join only where their pieces touch.
 *
 * Work happens in a global grid (REF units per tile) so pieces from neighbouring
 * tiles share exact coordinates; geometry is projected when a row is written.
 *
 * Pieces are nodes of a graph. Two pieces in neighbouring tiles (or, with an id, in
 * the same tile) are linked when they share a key and either has an id or they
 * touch at the tile edge. Each connected group is written once, by its first piece
 * in read order: a process that hasn't seen earlier tiles (HTTP transport) finds an
 * earlier piece and leaves the group to whoever owns it, so no group is written twice.
 */

import polygonClipping, { type MultiPolygon, type Ring as PcRing } from "polygon-clipping";
import { clipLine, clipRing } from "./edges.ts";
import {
  type Coordinates,
  classifyRings,
  classifyRingsByNesting,
  decodeGeometry,
  decodeTile,
  linesWkb,
  type Part,
  type PartProjector,
  Projector,
  type PropertyValue,
  partsWkb,
  polygonsWkb,
} from "./mvt.ts";
import type { RowBuilder } from "./rows.ts";
import type { TileKey, TileSource } from "./sources.ts";

export const REF = 65536; // global grid units per tile
const EDGE_MARGIN = 16; // a feature within extent/16 of an edge may continue in the next tile
const TOUCH = REF / 1024; // pieces without an id join when this close (4 px of 4096) at the edge
const CACHE_BYTES = 128 << 20;
const PREFETCH = 32;
const HALF_CIRCUMFERENCE = Math.PI * 6378137.0;
const RAD_TO_DEG = 180 / Math.PI;

type Reach = [w: boolean, n: boolean, e: boolean, s: boolean];

interface Piece {
  layer: string;
  fid: bigint | null;
  dim: 1 | 2;
  extent: number;
  props: Map<string, PropertyValue>;
  key: string;
  lines: Part[]; // dim 1, global grid
  polygons: MultiPolygon; // dim 2, global grid
  bbox: [number, number, number, number];
  reach: Reach;
}

interface Row {
  layer: string;
  fid: bigint | null;
  gtype: string;
  wkb: Uint8Array | null;
  props: Map<string, PropertyValue>;
}

interface TilePieces {
  pieces: Piece[];
  byKey: Map<string, number[]>;
  rows: Row[] | null; // finished rows, kept until the tile's own turn so it is decoded once
}

type Node = [tile: string, index: number];
const tileKey = (k: TileKey) => k.join("/");

function stableJson(props: Map<string, PropertyValue>): string {
  const keys = [...props.keys()].sort();
  return JSON.stringify(keys.map((k) => [k, typeof props.get(k) === "bigint" ? String(props.get(k)) : props.get(k)]));
}

/** Map a global-grid geometry to the output coordinates (tile pixels of the reporting tile for 'tile'). */
class GlobalProjector implements PartProjector {
  constructor(
    readonly z: number,
    readonly x: number,
    readonly y: number,
    readonly extent: number,
    readonly coordinates: Coordinates,
  ) {}

  project(part: Part): number[] {
    const out = new Array<number>(part.length);
    const size = REF * 2 ** this.z;
    for (let i = 0; i < part.length; i += 2) {
      const gx = part[i]!;
      const gy = part[i + 1]!;
      if (this.coordinates === "tile") {
        const k = this.extent / REF;
        out[i] = (gx - this.x * REF) * k;
        out[i + 1] = (gy - this.y * REF) * k;
      } else if (this.coordinates === "web_mercator") {
        const h = HALF_CIRCUMFERENCE;
        out[i] = (gx / size) * 2 * h - h;
        out[i + 1] = h - (gy / size) * 2 * h;
      } else {
        out[i] = (gx / size) * 360 - 180;
        const t = Math.PI * (1 - (2 * gy) / size);
        out[i + 1] = Math.atan(Math.sinh(Math.max(-40, Math.min(40, t)))) * RAD_TO_DEG;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- splitting a tile

function toGlobal(part: Part, x: number, y: number, k: number): Part {
  const out = new Array<number>(part.length);
  for (let i = 0; i < part.length; i += 2) {
    out[i] = Math.round(x * REF + part[i]! * k);
    out[i + 1] = Math.round(y * REF + part[i + 1]! * k);
  }
  return out;
}

const ringToPairs = (r: Part): PcRing => {
  const out: PcRing = [];
  for (let i = 0; i < r.length; i += 2) out.push([r[i]!, r[i + 1]!]);
  return out;
};

function bboxOf(parts: Part[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]!);
      x1 = Math.max(x1, p[i]!);
      y0 = Math.min(y0, p[i + 1]!);
      y1 = Math.max(y1, p[i + 1]!);
    }
  }
  return [x0, y0, x1, y1];
}

/** Split a tile into finished rows (owned points, features clear of every edge) and edge pieces. */
export function splitTile(
  [z, x, y]: TileKey,
  data: Uint8Array,
  layerFilter: string | null,
  coordinates: Coordinates,
): { rows: Row[]; pieces: Piece[] } {
  const rows: Row[] = [];
  const pieces: Piece[] = [];
  for (const layer of decodeTile(data, layerFilter)) {
    const ext = layer.extent;
    const project = new Projector(z, x, y, ext, coordinates);
    const k = REF / ext;
    for (const f of layer.features) {
      let parts = decodeGeometry(f.geometry);
      if ((f.geomType !== 2 && f.geomType !== 3) || parts.length === 0) {
        if (f.geomType === 1) {
          const points = parts.flat();
          const own: number[] = [];
          for (let i = 0; i + 1 < points.length; i += 2) {
            if (points[i]! >= 0 && points[i]! < ext && points[i + 1]! >= 0 && points[i + 1]! < ext) {
              own.push(points[i]!, points[i + 1]!);
            }
          }
          if (points.length && !own.length) continue; // another tile owns it
          parts = own.length ? [own] : [];
        }
        const [gtype, wkb] = partsWkb(f.geomType, parts, project, layer.version);
        rows.push({ layer: layer.name, fid: f.id, gtype, wkb, props: f.properties });
        continue;
      }
      const [minX, minY, maxX, maxY] = bboxOf(parts);
      const crosses = minX < 0 || minY < 0 || maxX > ext || maxY > ext;
      // Encoders simplify each tile on its own, so a neighbour's copy of a feature that crosses
      // the edge can stop a few pixels short of it: features with an id near an edge are pieces too.
      const m = f.id !== null ? Math.floor(ext / EDGE_MARGIN) : 0;
      const reach: Reach = [minX <= m, minY <= m, maxX >= ext - m, maxY >= ext - m];
      if (!crosses && !reach.some(Boolean)) {
        const [gtype, wkb] = partsWkb(f.geomType, parts, project, layer.version);
        rows.push({ layer: layer.name, fid: f.id, gtype, wkb, props: f.properties });
        continue;
      }
      const dim = (f.geomType - 1) as 1 | 2;
      const piece: Piece = {
        layer: layer.name,
        fid: f.id,
        dim,
        extent: ext,
        props: f.properties,
        key: `${layer.name}\u0000${f.id ?? ""}\u0000${dim}\u0000${stableJson(f.properties)}`,
        lines: [],
        polygons: [],
        bbox: [0, 0, 0, 0],
        reach,
      };
      if (dim === 1) {
        const clipped = crosses ? parts.flatMap((l) => clipLine(l, ext)) : parts.filter((l) => l.length >= 4);
        piece.lines = clipped.map((l) => toGlobal(l, x, y, k));
        if (!piece.lines.length) continue;
        piece.bbox = bboxOf(piece.lines);
      } else {
        const rings: Part[] = [];
        for (const ring of parts) {
          const m2 = ring.length;
          const closed =
            m2 >= 2 && (ring[0] !== ring[m2 - 2] || ring[1] !== ring[m2 - 1]) ? [...ring, ring[0]!, ring[1]!] : ring;
          if (closed.length < 8) continue;
          const c = crosses ? clipRing(closed, ext) : closed;
          if (c && c.length >= 8) rings.push(c);
        }
        const grouped = layer.version >= 2 ? classifyRings(rings) : classifyRingsByNesting(rings);
        piece.polygons = grouped.map((poly) => poly.map((r) => ringToPairs(toGlobal(r, x, y, k))));
        if (!piece.polygons.length) continue;
        piece.bbox = bboxOf(grouped.flat().map((r) => toGlobal(r, x, y, k)));
      }
      pieces.push(piece);
    }
  }
  return { rows, pieces };
}

// ---------------------------------------------------------------- joining

/** Move line ends that lie within TOUCH of another end (and on a tile edge) onto it. */
function snapLineEnds(lines: Part[]): Part[] {
  const out = lines.map((l) => [...l]);
  const onEdge = (v: number) => {
    const r = ((v % REF) + REF) % REF;
    return Math.min(r, REF - r) <= TOUCH;
  };
  const ends: [number, number][] = []; // [line, coordinate index of the end's x]
  out.forEach((l, i) => {
    for (const j of [0, l.length - 2]) if (onEdge(l[j]!) || onEdge(l[j + 1]!)) ends.push([i, j]);
  });
  if (ends.length > 2000) return out; // quadratic below; very long features keep their tiny gaps
  for (let a = 0; a < ends.length; a++) {
    const [ia, ja] = ends[a]!;
    const ax = out[ia]![ja]!;
    const ay = out[ia]![ja + 1]!;
    for (let b = a + 1; b < ends.length; b++) {
      const [ib, jb] = ends[b]!;
      const bx = out[ib]![jb]!;
      const by = out[ib]![jb + 1]!;
      if ((bx !== ax || by !== ay) && Math.abs(bx - ax) <= TOUCH && Math.abs(by - ay) <= TOUCH) {
        out[ib]![jb] = ax;
        out[ib]![jb + 1] = ay;
      }
    }
  }
  return out;
}

/** Chain lines that meet end to end where exactly two ends meet (GEOS LineMerger). */
export function lineMerge(lines: Part[]): Part[] {
  const ls = lines.filter((l) => l.length >= 4);
  const nodeKey = (l: Part, end: 0 | 1) => (end === 0 ? `${l[0]},${l[1]}` : `${l[l.length - 2]},${l[l.length - 1]}`);
  const incident = new Map<string, [number, 0 | 1][]>();
  ls.forEach((l, i) => {
    for (const end of [0, 1] as const) {
      const k = nodeKey(l, end);
      const list = incident.get(k) ?? [];
      list.push([i, end]);
      incident.set(k, list);
    }
  });
  const degree = (k: string) => incident.get(k)?.length ?? 0;
  const used = new Array<boolean>(ls.length).fill(false);
  const out: Part[] = [];

  const walk = (start: number, startEnd: 0 | 1) => {
    // Orient the first line so it leaves the start node.
    let line = startEnd === 0 ? ls[start]! : reverse(ls[start]!);
    used[start] = true;
    const chain = [...line];
    for (;;) {
      const far = `${chain[chain.length - 2]},${chain[chain.length - 1]}`;
      if (degree(far) !== 2) break;
      const next = incident.get(far)!.find(([i]) => !used[i]);
      if (!next) break;
      const [i, end] = next;
      used[i] = true;
      line = end === 0 ? ls[i]! : reverse(ls[i]!);
      for (let k = 2; k < line.length; k++) chain.push(line[k]!);
    }
    out.push(chain);
  };

  // Start at ends that aren't simple pass-through nodes, then whatever is left is a ring of lines.
  ls.forEach((l, i) => {
    if (used[i]) return;
    if (degree(nodeKey(l, 0)) !== 2) walk(i, 0);
    else if (degree(nodeKey(l, 1)) !== 2) walk(i, 1);
  });
  ls.forEach((_, i) => {
    if (!used[i]) walk(i, 0);
  });
  return out;
}

function reverse(l: Part): Part {
  const out = new Array<number>(l.length);
  for (let i = 0; i < l.length; i += 2) {
    out[l.length - 2 - i] = l[i]!;
    out[l.length - 1 - i] = l[i + 1]!;
  }
  return out;
}

/** Drop repeated points, and parts left with fewer than two distinct points. */
function cleanLines(lines: Part[]): Part[] {
  const out: Part[] = [];
  for (const l of lines) {
    const d: number[] = [];
    for (let i = 0; i + 1 < l.length; i += 2) {
      if (d.length && l[i] === d[d.length - 2] && l[i + 1] === d[d.length - 1]) continue;
      d.push(l[i]!, l[i + 1]!);
    }
    if (d.length >= 4) out.push(d);
  }
  return out;
}

function joinPieces(pieces: Piece[]): { lines: Part[]; polygons: Part[][] } {
  if (pieces[0]!.dim === 1) {
    const lines = pieces.flatMap((p) => p.lines);
    return { lines: cleanLines(pieces.length === 1 ? lines : lineMerge(snapLineEnds(lines))), polygons: [] };
  }
  // Always union, even one piece: as GEOS does in the Python worker, this dissolves
  // overlapping parts and the zero-width slivers a ring clip can leave on the tile edge.
  let mp: MultiPolygon;
  try {
    const [first, ...rest] = pieces.map((p) => p.polygons);
    mp = polygonClipping.union(first!, ...rest);
  } catch {
    mp = pieces.flatMap((p) => p.polygons); // a degenerate input: keep the pieces side by side
  }
  const polygons = mp.map((poly) => poly.map((ring) => ring.flat()));
  return { lines: [], polygons };
}

// ---------------------------------------------------------------- touching (features without an id)

function segDist2(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

function segmentsOf(p: Piece): Part[] {
  return p.dim === 1 ? p.lines : p.polygons.flatMap((poly) => poly.map((r) => r.flat()));
}

/** Whether two pieces come within TOUCH of each other (vertex-to-segment distance). */
function touch(a: Piece, b: Piece): boolean {
  const [ax0, ay0, ax1, ay1] = a.bbox;
  const [bx0, by0, bx1, by1] = b.bbox;
  if (ax0 > bx1 + TOUCH || bx0 > ax1 + TOUCH || ay0 > by1 + TOUCH || by0 > ay1 + TOUCH) return false;
  const t2 = TOUCH * TOUCH;
  const near = (from: Part[], to: Part[]) => {
    for (const s of to) {
      for (let i = 0; i + 3 < s.length; i += 2) {
        for (const f of from) {
          for (let j = 0; j + 1 < f.length; j += 2) {
            if (segDist2(s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!, f[j]!, f[j + 1]!) <= t2) return true;
          }
        }
      }
    }
    return false;
  };
  const sa = segmentsOf(a);
  const sb = segmentsOf(b);
  return near(sa, sb) || near(sb, sa);
}

const faces = (p: Piece, dx: number, dy: number): boolean => {
  const [w, n, e, s] = p.reach;
  return (dx === 0 || (dx < 0 ? w : e)) && (dy === 0 || (dy < 0 ? n : s));
};

// ---------------------------------------------------------------- the assembler

function estimate(tp: TilePieces): number {
  let coords = 0;
  for (const p of tp.pieces) for (const s of segmentsOf(p)) coords += s.length / 2;
  let rowBytes = 0;
  for (const r of tp.rows ?? []) rowBytes += (r.wkb?.length ?? 0) + 200;
  return 16 * coords + 400 * tp.pieces.length + rowBytes + 1000;
}

function index(pieces: Piece[], rows: Row[] | null): TilePieces {
  const byKey = new Map<string, number[]>();
  pieces.forEach((p, i) => {
    const list = byKey.get(p.key) ?? [];
    list.push(i);
    byKey.set(p.key, list);
  });
  return { pieces, byKey, rows };
}

export class EdgeAssembler {
  private readonly order = new Map<string, number>();
  private readonly done = new Set<string>();
  private readonly tiles = new Map<string, TilePieces>();
  private readonly remaining = new Map<string, number>();
  private readonly finished = new Set<string>();
  private readonly sizes = new Map<string, number>();
  private cachedBytes = 0;

  constructor(
    private readonly source: TileSource,
    private readonly keys: TileKey[],
    private readonly layerFilter: string | null,
    private readonly coordinates: Coordinates,
  ) {
    keys.forEach((k, i) => {
      this.order.set(tileKey(k), i);
    });
  }

  /** Append the rows that tile `key` contributes. */
  async addTile(rows: RowBuilder, key: TileKey, data: Uint8Array): Promise<void> {
    const [z, x, y] = key;
    const tk = tileKey(key);
    const cached = this.tiles.get(tk);
    let finished: Row[];
    let pieces: Piece[];
    if (cached?.rows) {
      finished = cached.rows;
      pieces = cached.pieces;
      cached.rows = null;
    } else {
      ({ rows: finished, pieces } = splitTile(key, data, this.layerFilter, this.coordinates));
    }
    for (const r of finished) rows.append(r.layer, z, x, y, r.fid, r.gtype, r.wkb, r.props);
    this.remember(tk, index(pieces, null));
    for (let i = 0; i < pieces.length; i++) {
      if (this.done.has(`${tk}#${i}`)) continue;
      const group = await this.group([tk, i]);
      if (!group) continue;
      const groupPieces: Piece[] = [];
      for (const [t, j] of group) groupPieces.push((await this.tile(t)).pieces[j]!);
      this.markDone(group);
      const joined = joinPieces(groupPieces);
      const p = pieces[i]!;
      const proj = new GlobalProjector(z, x, y, p.extent, this.coordinates);
      const [gtype, wkb] = p.dim === 1 ? linesWkb(joined.lines, proj) : polygonsWkb(joined.polygons, proj);
      if (wkb) rows.append(p.layer, z, x, y, p.fid, gtype, wkb, p.props);
    }
  }

  private rank([t, i]: Node): [number, number] {
    return [this.order.get(t) ?? Number.MAX_SAFE_INTEGER, i];
  }

  /** The pieces linked to `start`; null when one of them comes before it in read order. */
  private async group(start: Node): Promise<Node[] | null> {
    const [f0, f1] = this.rank(start);
    const seen = new Set([`${start[0]}#${start[1]}`]);
    const stack: Node[] = [start];
    const found: Node[] = [];
    while (stack.length) {
      const node = stack.pop()!;
      const [r0, r1] = this.rank(node);
      if (r0 < f0 || (r0 === f0 && r1 < f1)) return null;
      found.push(node);
      const [tile, i] = node;
      const tp = await this.tile(tile);
      const p = tp.pieces[i]!;
      const links: Node[] = [];
      if (p.fid !== null) for (const j of tp.byKey.get(p.key) ?? []) links.push([tile, j]);
      const [z, x, y] = tile.split("/").map(Number) as TileKey;
      const neighbours: TileKey[] = [];
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) neighbours.push([z, x + dx, y + dy]);
      await this.load(neighbours.filter((n) => !this.finished.has(tileKey(n))));
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          const n = tileKey([z, x + dx, y + dy]);
          if ((dx === 0 && dy === 0) || !this.order.has(n) || this.finished.has(n)) continue;
          const other = await this.tile(n);
          for (const j of other.byKey.get(p.key) ?? []) {
            const q = other.pieces[j]!;
            if (!(faces(p, dx, dy) || faces(q, -dx, -dy))) continue;
            if (p.fid !== null || touch(p, q)) links.push([n, j]);
          }
        }
      }
      for (const link of links) {
        const id = `${link[0]}#${link[1]}`;
        if (!seen.has(id)) {
          seen.add(id);
          stack.push(link);
        }
      }
    }
    return found;
  }

  private remember(tk: string, tp: TilePieces): void {
    if (this.tiles.has(tk)) {
      this.cachedBytes -= this.sizes.get(tk) ?? 0;
      this.tiles.delete(tk);
    }
    this.tiles.set(tk, tp);
    const size = estimate(tp);
    this.sizes.set(tk, size);
    this.cachedBytes += size;
    if (!this.remaining.has(tk)) {
      let left = 0;
      for (let i = 0; i < tp.pieces.length; i++) if (!this.done.has(`${tk}#${i}`)) left++;
      this.remaining.set(tk, left);
      if (!left) this.finished.add(tk);
    }
    while (this.cachedBytes > CACHE_BYTES && this.tiles.size > 1) {
      // Finished tiles first (oldest first), then the least recently used.
      let drop: string | undefined;
      for (const k of this.tiles.keys()) {
        if (this.finished.has(k) && k !== tk) {
          drop = k;
          break;
        }
      }
      drop ??= this.tiles.keys().next().value!;
      this.tiles.delete(drop);
      this.cachedBytes -= this.sizes.get(drop) ?? 0;
      this.sizes.delete(drop);
    }
  }

  private markDone(nodes: Node[]): void {
    for (const [t, i] of nodes) {
      const id = `${t}#${i}`;
      if (this.done.has(id)) continue;
      this.done.add(id);
      const left = (this.remaining.get(t) ?? 0) - 1;
      this.remaining.set(t, left);
      if (left <= 0) this.finished.add(t);
    }
  }

  /** Fetch and split the tiles of `keys` that are in the read list and not cached, in one round trip. */
  private async load(keys: TileKey[], prefetch = true): Promise<void> {
    const missing = keys.filter((k) => this.order.has(tileKey(k)) && !this.tiles.has(tileKey(k)));
    if (!missing.length) return;
    // The tiles that follow in read order are needed next anyway: fetch them in the same round trip.
    const next = Math.max(...missing.map((k) => this.order.get(tileKey(k))!)) + 1;
    const want = new Set(missing.map(tileKey));
    for (const k of this.keys.slice(next, next + (prefetch ? PREFETCH : 0))) {
      if (!this.tiles.has(tileKey(k)) && !want.has(tileKey(k))) {
        missing.push(k);
        want.add(tileKey(k));
      }
    }
    const got = new Map((await this.source.fetch(missing)).map(([k, d]) => [tileKey(k), d]));
    for (const k of missing) {
      const data = got.get(tileKey(k));
      if (!data) {
        this.remember(tileKey(k), index([], []));
        continue;
      }
      const { rows, pieces } = splitTile(k, data, this.layerFilter, this.coordinates);
      this.remember(tileKey(k), index(pieces, rows));
    }
  }

  private async tile(tk: string): Promise<TilePieces> {
    let hit = this.tiles.get(tk);
    const key = tk.split("/").map(Number) as TileKey;
    if (!hit) {
      await this.load([key]);
      hit = this.tiles.get(tk);
    }
    if (!hit) {
      // The prefetch that came with it pushed it out again.
      await this.load([key], false);
      hit = this.tiles.get(tk) ?? index([], null);
    }
    if (this.tiles.has(tk)) {
      this.tiles.delete(tk);
      this.tiles.set(tk, hit);
    }
    return hit;
  }
}

// One assembler per running query, so later batches see the groups earlier batches wrote.
const RUNS = new Map<string, EdgeAssembler>();

export function assemblerFor(
  run: string,
  source: TileSource,
  keys: TileKey[],
  layerFilter: string | null,
  coordinates: Coordinates,
): EdgeAssembler {
  let a = RUNS.get(run);
  if (!a) {
    a = new EdgeAssembler(source, keys, layerFilter, coordinates);
    RUNS.set(run, a);
    while (RUNS.size > 8) RUNS.delete(RUNS.keys().next().value!);
  }
  return a;
}
