/**
 * `tile_edges := 'clip'`: cut every piece back to its own tile, in tile pixels.
 *
 * A tile stores features with a buffer around its square, so a feature crossing a
 * tile edge comes back once per tile and the pieces overlap. Clipping each piece to
 * [0, extent] removes the overlap: counts of pieces still exceed counts of features,
 * but summed lengths and areas are right.
 *
 * Lines use Liang–Barsky per segment. Polygons are intersected with the tile square by
 * polygon-clipping, which (like the Python worker's GEOS intersection) returns valid
 * polygons: no zero-width slivers along the edge, no self-touching rings.
 * Points are kept only by the tile whose square contains them.
 */

import polygonClipping, { type Polygon as PcPolygon } from "polygon-clipping";
import { classifyRings, classifyRingsByNesting, type Part } from "./mvt.ts";

export type TileEdges = "merge" | "clip" | "raw";
export const TILE_EDGE_CHOICES: TileEdges[] = ["merge", "clip", "raw"];

/**
 * Cut points snap to a grid of 65536 units per tile (1/16 pixel at extent 4096), the
 * grid the Python worker's GEOS intersection uses (`REF`, grid_size=1), so both workers
 * cut at the same coordinates.
 */
const REF = 65536;
function snap(v: number, e: number): number {
  const k = REF / e;
  return Math.round(v * k) / k;
}

/** Clip one line to the square [0, e] x [0, e]; returns zero or more pieces. */
export function clipLine(line: Part, e: number): Part[] {
  const out: Part[] = [];
  let current: Part = [];
  for (let i = 0; i + 3 < line.length; i += 2) {
    const x0 = line[i]!;
    const y0 = line[i + 1]!;
    const dx = line[i + 2]! - x0;
    const dy = line[i + 3]! - y0;
    let t0 = 0;
    let t1 = 1;
    let visible = true;
    for (const [p, q] of [
      [-dx, x0],
      [dx, e - x0],
      [-dy, y0],
      [dy, e - y0],
    ] as const) {
      if (p === 0) {
        if (q < 0) visible = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
      if (t0 > t1) visible = false;
      if (!visible) break;
    }
    if (!visible) {
      if (current.length >= 4) out.push(current);
      current = [];
      continue;
    }
    const ax = t0 === 0 ? x0 : snap(x0 + t0 * dx, e);
    const ay = t0 === 0 ? y0 : snap(y0 + t0 * dy, e);
    const bx = t1 === 1 ? x0 + dx : snap(x0 + t1 * dx, e);
    const by = t1 === 1 ? y0 + dy : snap(y0 + t1 * dy, e);
    const n = current.length;
    if (n === 0 || current[n - 2] !== ax || current[n - 1] !== ay) {
      if (n >= 4) out.push(current);
      current = [ax, ay];
    }
    current.push(bx, by);
    if (t1 < 1) {
      out.push(current);
      current = [];
    }
  }
  if (current.length >= 4) out.push(current);
  // Drop repeated points; a piece that only touches the square (one distinct point) goes.
  const pieces: Part[] = [];
  for (const l of out) {
    const d: number[] = [l[0]!, l[1]!];
    for (let i = 2; i + 1 < l.length; i += 2) {
      if (l[i] !== d[d.length - 2] || l[i + 1] !== d[d.length - 1]) d.push(l[i]!, l[i + 1]!);
    }
    if (d.length >= 4) pieces.push(d);
  }
  return pieces;
}

/** Clip one closed ring to the square [0, e] x [0, e] (Sutherland–Hodgman); null when nothing is left. */
export function clipRing(ring: Part, e: number): Part | null {
  // Work on the open ring (drop the closing point), close again at the end.
  let pts = ring.slice(0, ring.length - 2);
  const edges: [
    (x: number, y: number) => boolean,
    (ax: number, ay: number, bx: number, by: number) => [number, number],
  ][] = [
    [(x) => x >= 0, (ax, ay, bx, by) => [0, snap(ay + ((by - ay) * (0 - ax)) / (bx - ax), e)]],
    [(x) => x <= e, (ax, ay, bx, by) => [e, snap(ay + ((by - ay) * (e - ax)) / (bx - ax), e)]],
    [(_x, y) => y >= 0, (ax, ay, bx, by) => [snap(ax + ((bx - ax) * (0 - ay)) / (by - ay), e), 0]],
    [(_x, y) => y <= e, (ax, ay, bx, by) => [snap(ax + ((bx - ax) * (e - ay)) / (by - ay), e), e]],
  ];
  for (const [inside, cross] of edges) {
    const next: number[] = [];
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const cx = pts[2 * i]!;
      const cy = pts[2 * i + 1]!;
      const j = (i + n - 1) % n;
      const px = pts[2 * j]!;
      const py = pts[2 * j + 1]!;
      const cin = inside(cx, cy);
      const pin = inside(px, py);
      if (cin) {
        if (!pin) next.push(...cross(px, py, cx, cy));
        next.push(cx, cy);
      } else if (pin) next.push(...cross(px, py, cx, cy));
    }
    pts = next;
    if (pts.length < 6) return null;
  }
  pts.push(pts[0]!, pts[1]!);
  return pts;
}

/** True when the part's points all lie inside the tile square (no clipping needed). */
export function insideTile(part: Part, e: number): boolean {
  for (let i = 0; i < part.length; i++) {
    const v = part[i]!;
    if (v < 0 || v > e) return false;
  }
  return true;
}

/** Points owned by this tile: inside [0, e) on both axes. */
export function ownedPoints(points: Part, e: number): Part {
  const out: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    if (x >= 0 && x < e && y >= 0 && y < e) out.push(x, y);
  }
  return out;
}

/** Apply `tile_edges := 'clip'` to one feature's decoded parts. */
export function clipParts(gtype: number, parts: Part[], e: number): Part[] {
  if (gtype === 1) {
    const kept = ownedPoints(parts.flat(), e);
    return kept.length ? [kept] : [];
  }
  if (gtype === 2) {
    const out: Part[] = [];
    for (const line of parts) {
      if (insideTile(line, e)) out.push(line);
      else out.push(...clipLine(line, e));
    }
    return out;
  }
  if (gtype === 3) {
    const out: Part[] = [];
    for (const ring of parts) {
      const m = ring.length;
      const closed =
        m >= 2 && (ring[0] !== ring[m - 2] || ring[1] !== ring[m - 1]) ? [...ring, ring[0]!, ring[1]!] : ring;
      if (closed.length < 8) continue;
      if (insideTile(closed, e)) {
        out.push(closed);
        continue;
      }
      const c = clipRing(closed, e);
      if (c && c.length >= 8) out.push(c);
    }
    return out;
  }
  return parts;
}

const toPairs = (ring: Part): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ring.length; i += 2) out.push([ring[i]!, ring[i + 1]!]);
  return out;
};

/**
 * A polygon feature's rings cut to the tile square [0, e] and made valid, as polygons
 * (exterior first, then holes) in tile pixels; [] when nothing of it is inside.
 */
export function clipPolygons(rings: Part[], e: number, version: number): Part[][] {
  const closed: Part[] = [];
  for (const ring of rings) {
    const m = ring.length;
    const c = m >= 2 && (ring[0] !== ring[m - 2] || ring[1] !== ring[m - 1]) ? [...ring, ring[0]!, ring[1]!] : ring;
    if (c.length >= 8) closed.push(c);
  }
  const grouped = version >= 2 ? classifyRings(closed) : classifyRingsByNesting(closed);
  if (grouped.length === 0) return [];
  const square: PcPolygon = [
    [
      [0, 0],
      [e, 0],
      [e, e],
      [0, e],
      [0, 0],
    ],
  ];
  try {
    const polys = grouped.map((poly) => poly.map(toPairs));
    const out = polygonClipping.intersection(square, polygonClipping.union(polys[0]!, ...polys.slice(1)));
    // Cut points lie on the square's edges; snap them along the edge to the REF grid,
    // as the Python worker's GEOS intersection (grid_size=1) does.
    const onEdge = (v: number) => v === 0 || v === e;
    return out.map((poly) =>
      poly.map((ring) => ring.flatMap(([px, py]) => [onEdge(py) ? snap(px, e) : px, onEdge(px) ? snap(py, e) : py])),
    );
  } catch {
    // degenerate input polygon-clipping rejects: fall back to cutting each ring
    return grouped
      .map((poly) => poly.map((r) => clipRing(r, e)).filter((r): r is Part => r !== null && r.length >= 8))
      .filter((poly) => poly.length > 0);
  }
}
