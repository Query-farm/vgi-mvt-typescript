import { describe, expect, test } from "bun:test";
import { decodeAttach, parseBBox, tilesetAttach } from "../src/tileset_catalog.ts";

describe("tileset ATTACH options", () => {
  test("no tileset means a functions-only attach", () => {
    expect(tilesetAttach({})).toBeNull();
    expect(tilesetAttach({ tileset: "  " })).toBeNull();
  });

  test("defaults and BIGINT options", () => {
    expect(tilesetAttach({ tileset: "a.pmtiles", zoom: -1n, max_tiles: 10000n })).toEqual({
      source: "a.pmtiles",
      zoom: null,
      coordinates: "wgs84",
      bbox: null,
      max_tiles: 10000,
      tile_edges: "merge",
    });
    expect(tilesetAttach({ tileset: "a.pmtiles", zoom: 14n })?.zoom).toBe(14);
  });

  test("bad values are refused", () => {
    expect(() => tilesetAttach({ tileset: "a", zoom: 31n })).toThrow(/zoom/);
    expect(() => tilesetAttach({ tileset: "a", coordinates: "lambert" })).toThrow(/coordinates must be one of/);
    expect(() => tilesetAttach({ tileset: "a", tile_edges: "dedupe" })).toThrow(/tile_edges must be one of/);
    expect(() => tilesetAttach({ tileset: "a", max_tiles: 0n })).not.toThrow(); // 0 falls back to the default
    expect(() => tilesetAttach({ tileset: "a", max_tiles: -2n })).toThrow(/max_tiles/);
  });

  test("bbox parsing", () => {
    expect(parseBBox("")).toBeNull();
    expect(parseBBox("11.2, 43.7, 11.3, 43.8")).toEqual([11.2, 43.7, 11.3, 43.8]);
    expect(() => parseBBox("1,2,3")).toThrow(/west,south,east,north/);
    expect(() => parseBBox("10,0,5,1")).toThrow(/west <= east/);
  });

  test("the settings round-trip through attach_opaque_data", () => {
    const attach = tilesetAttach({ tileset: "https://x/a.pmtiles", zoom: 3n, bbox: "0,40,30,55", tile_edges: "clip" })!;
    const { attach_opaque_data } = {
      attach_opaque_data: new TextEncoder().encode(`vgi-mvt-tileset:${JSON.stringify(attach)}`),
    };
    expect(decodeAttach(attach_opaque_data)).toEqual(attach);
    expect(decodeAttach(new Uint8Array(16))).toBeNull();
    expect(decodeAttach(null)).toBeNull();
  });
});
