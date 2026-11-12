/**
 * Assemble the functions into the catalog DuckDB attaches.
 *
 * To add a function: write it (see `read_tiles.ts`), then add it to
 * `FUNCTIONS` below.
 */

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { CATALOG_DOC_MD, CATALOG_NAME, CATALOG_TAGS, SCHEMA_DOC_MD, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";
import { readMvt, readTiles, tilesetLayers } from "./read_tiles.ts";

export const FUNCTIONS: VgiFunction[] = [readTiles, readMvt, tilesetLayers];

interface Example {
  description: string;
  sql: string;
}

/**
 * Publish each function's examples as `vgi.example_queries` (with descriptions).
 *
 * Overloads share one SQL name, so their examples are merged per name.
 * Returns every example, for the schema-level list.
 */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const byName = new Map<string, Example[]>();
  for (const fn of functions) {
    const bucket = byName.get(fn.meta.name) ?? [];
    byName.set(fn.meta.name, bucket);
    for (const ex of fn.meta.examples ?? []) {
      if (!bucket.some((e) => e.sql === ex.sql)) bucket.push({ description: ex.description, sql: ex.sql });
    }
  }
  for (const fn of functions) {
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(byName.get(fn.meta.name)) };
  }
  return [...byName.values()].flat();
}

const ALL_EXAMPLES = stampExampleQueries(FUNCTIONS);

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_DOC_MD,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: FUNCTIONS,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES) },
    },
  ],
};
