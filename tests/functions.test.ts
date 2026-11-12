// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Arguments, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import { clipLine, clipParts, clipRing } from "../src/edges.ts";
import { decodeGeometry, decodeTile, featureWkb, maybeDecompress, Projector, tileRange } from "../src/mvt.ts";
import { propertiesJson } from "../src/rows.ts";
import { parseDirectory, tileIdToZxy, zxyToTileId } from "../src/sources.ts";

const ROOT = join(import.meta.dir, "..");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => Number.parseInt(b, 16)));

// A 48-byte tile: layer "points", one POINT at (2048, 2048) of 4096, id 7, name='origin'.
const POINT_TILE = fromHex(
  "1a2e78020a06706f696e7473120f0807120200001801220509802080201a046e616d6522080a066f726967696e288020",
);

test("decode: a hand-made point tile", () => {
  const [layer] = decodeTile(POINT_TILE);
  expect(layer!.name).toBe("points");
  expect(layer!.extent).toBe(4096);
  const f = layer!.features[0]!;
  expect(f.id).toBe(7n);
  expect(f.properties.get("name")).toBe("origin");
  const [type, wkb] = featureWkb(f, new Projector(0, 0, 0, 4096, "wgs84"), layer!.version);
  expect(type).toBe("POINT");
  const v = new DataView(wkb!.buffer);
  expect([v.getFloat64(5, true), v.getFloat64(13, true)]).toEqual([0, 0]);
});

test("decode: layer filter skips other layers", () => {
  expect(decodeTile(POINT_TILE, "nope")).toEqual([]);
});

test("decode: gzip is detected", async () => {
  const gz = new Uint8Array(
    await new Response(new Blob([POINT_TILE]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );
  expect(await maybeDecompress(gz)).toEqual(POINT_TILE);
});

test("decode: a truncated tile is a decode error, not a crash", () => {
  expect(() => decodeTile(POINT_TILE.subarray(0, 20))).toThrow(/truncated/);
});

test("geometry: MoveTo/LineTo/ClosePath", () => {
  // MoveTo(1,1) LineTo(+2,0)(0,+2) ClosePath -> a closed triangle.
  expect(decodeGeometry([9, 2, 2, 18, 4, 0, 0, 4, 15])).toEqual([[1, 1, 3, 1, 3, 3, 1, 1]]);
});

test("properties JSON keeps 64-bit integers exact", () => {
  const props = new Map<string, string | number | bigint | boolean | null>([
    ["big", 9007199254740993n],
    ["f", 1.5],
    ["nan", Number.NaN],
    ["s", 'a"b'],
  ]);
  expect(propertiesJson(props)).toBe('{"big":9007199254740993,"f":1.5,"nan":null,"s":"a\\"b"}');
});

test("hilbert tile ids: spec values and round trips", () => {
  // Values from the PMTiles spec / the Python pmtiles package.
  expect(zxyToTileId(0, 0, 0)).toBe(0);
  expect(zxyToTileId(1, 0, 0)).toBe(1);
  expect(zxyToTileId(1, 0, 1)).toBe(2);
  expect(zxyToTileId(1, 1, 1)).toBe(3);
  expect(zxyToTileId(1, 1, 0)).toBe(4);
  expect(zxyToTileId(12, 3423, 1763)).toBe(19078479);
  expect(zxyToTileId(20, 2 ** 20 - 1, 2 ** 20 - 1)).toBe(1099511627775);
  for (const z of [0, 3, 7]) {
    for (let x = 0; x < 2 ** z; x += 3) {
      for (let y = 0; y < 2 ** z; y += 5) expect(tileIdToZxy(zxyToTileId(z, x, y))).toEqual([z, x, y]);
    }
  }
  expect(tileIdToZxy(zxyToTileId(26, 2 ** 26 - 1, 12345))).toEqual([26, 2 ** 26 - 1, 12345]);
});

test("pmtiles directory: run-length entries and implicit offsets", () => {
  // 2 entries: ids 5, 6 (delta 5, 1); run lengths 1, 1; lengths 10, 20; offsets 1 (=0), 0 (=follows).
  const dir = parseDirectory(new Uint8Array([2, 5, 1, 1, 1, 10, 20, 1, 0]));
  expect(dir).toEqual([
    { tileId: 5, offset: 0, length: 10, runLength: 1 },
    { tileId: 6, offset: 10, length: 20, runLength: 1 },
  ]);
});

test("tile range: an edge on a tile boundary doesn't pull in the next tile", () => {
  expect(tileRange(1, [-180, -85, 0, 85])).toEqual([0, 0, 0, 1]);
  expect(tileRange(2, [0, 0, 1, 1])).toEqual([2, 1, 2, 1]);
});

test("clip: a line crossing the tile is cut at the edge", () => {
  expect(clipLine([-100, 100, 200, 100], 4096)).toEqual([[0, 100, 200, 100]]);
  // Leaves and re-enters: two pieces.
  expect(clipLine([100, 100, 100, -50, 300, -50, 300, 100], 4096)).toEqual([
    [100, 100, 100, 0],
    [300, 0, 300, 100],
  ]);
  // Only touches a corner: nothing.
  expect(clipLine([-10, 10, 0, 0, 10, -10], 4096)).toEqual([]);
});

test("clip: a ring is cut to the square and stays closed", () => {
  const ring = clipRing([-100, -100, 100, -100, 100, 100, -100, 100, -100, -100], 4096)!;
  expect(ring.slice(-2)).toEqual(ring.slice(0, 2));
  const xs = ring.filter((_, i) => i % 2 === 0);
  expect(Math.min(...xs)).toBe(0);
  expect(Math.max(...xs)).toBe(100);
});

test("clip: points belong to the tile whose square contains them", () => {
  expect(clipParts(1, [[10, 10, -5, 10, 4096, 20]], 4096)).toEqual([[10, 10]]);
});

describe("against the worker", () => {
  let client: VgiClient;

  beforeAll(() => {
    // A client that launches the worker as a subprocess, the way DuckDB does.
    client = new VgiClient(subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")]));
  });

  afterAll(() => client?.close());

  async function table(name: string, positional: unknown[], named: Record<string, unknown> = {}) {
    const rows: Record<string, unknown>[] = [];
    for await (const page of client.tableFunctionRows({
      functionName: name,
      arguments: new Arguments(positional, new Map(Object.entries(named))),
      int64: "bigint",
    })) {
      rows.push(...page);
    }
    return rows;
  }

  const fixture = (f: string) => join(ROOT, "test", "fixtures", f);
  const countBy = (rows: Record<string, unknown>[], key: string) =>
    Object.fromEntries(
      [...new Set(rows.map((r) => r[key]))].sort().map((k) => [k, rows.filter((r) => r[key] === k).length]),
    );

  test("read_tiles: features per layer", async () => {
    const rows = await table("read_tiles", [fixture("sample.pmtiles")], { zoom: 2 });
    expect(countBy(rows, "layer")).toEqual({ cities: 4, regions: 2 });
  });

  test("read_tiles: layer adds typed columns", async () => {
    const rows = await table("read_tiles", [fixture("sample.pmtiles")], { layer: "cities" });
    const berlin = rows.find((r) => r.name === "Berlin")!;
    expect(berlin.population).toBe(3645000);
    expect(berlin.capital).toBe(true);
  });

  test("read_tiles: clip keeps one piece per tile, raw keeps the buffers", async () => {
    const clip = await table("read_tiles", [fixture("edges.pmtiles")], { zoom: 3 });
    const raw = await table("read_tiles", [fixture("edges.pmtiles")], { zoom: 3, tile_edges: "raw" });
    expect(countBy(clip, "layer")).toEqual({ areas: 5, roads: 4 });
    expect(countBy(raw, "layer")).toEqual({ areas: 5, roads: 4 });
  });

  test("read_tiles: an unknown layer names the real ones", async () => {
    await expect(table("read_tiles", [fixture("sample.pmtiles")], { layer: "nope" })).rejects.toThrow(
      /cities, regions/,
    );
  });

  test("read_mvt: one tile", async () => {
    const rows = await table("read_mvt", [fixture("0-0-0.mvt"), 0, 0, 0]);
    expect(countBy(rows, "geometry_type")).toEqual({ POINT: 4, POLYGON: 2 });
  });

  test("tileset_layers: attributes from the metadata", async () => {
    const rows = await table("tileset_layers", [fixture("sample.pmtiles")]);
    const cities = rows.filter((r) => r.layer === "cities").map((r) => `${r.field}:${r.type}`);
    expect(cities.sort()).toEqual(["capital:Boolean", "name:String", "population:Number"]);
  });
});
