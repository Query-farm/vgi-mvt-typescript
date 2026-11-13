/**
 * Demo: Haybarn WASM (@haybarn/haybarn-wasm, threads build) with the mvt worker running in a Web
 * Worker over VGI's `worker:` transport. No server: the worker fetches tile ranges
 * from the PMTiles URLs directly.
 */

import * as duckdb from "@haybarn/haybarn-wasm";
import { installVgiWebWorkerBridge } from "@haybarn/haybarn-wasm/vgi";

const HAYBARN = new URL("./haybarn/", location.href).href;
const FLORENCE =
  "https://raw.githubusercontent.com/protomaps/PMTiles/main/spec/v3/protomaps(vector)ODbL_firenze.pmtiles";
const OVERTURE = "https://r2-public.protomaps.com/protomaps-sample-datasets/overture-pois.pmtiles";

export const EXAMPLES: { title: string; sql: string }[] = [
  {
    title: "Attach the Florence basemap as a database: one table per layer",
    sql: `ATTACH IF NOT EXISTS 'worker:mvt-worker.js' AS florence (TYPE vgi,\n  tileset '${FLORENCE}');\n\nSELECT "pmap:kind" AS kind, count(*) AS roads\nFROM florence.roads\nGROUP BY kind ORDER BY roads DESC;`,
  },
  {
    title: "Layers of the Florence basemap",
    sql: `SELECT layer, count(*) AS attributes\nFROM mvt.main.tileset_layers('${FLORENCE}')\nGROUP BY layer ORDER BY layer;`,
  },
  {
    title: "A tileset stores a road once per tile: raw, clip and merge",
    sql: `SELECT mode, count(*) AS rows, count(DISTINCT feature_id) AS roads\nFROM (\n  SELECT 'raw' AS mode, feature_id FROM mvt.main.read_tiles('${FLORENCE}', zoom := 14, layer := 'roads', tile_edges := 'raw')\n  UNION ALL\n  SELECT 'clip', feature_id FROM mvt.main.read_tiles('${FLORENCE}', zoom := 14, layer := 'roads', tile_edges := 'clip')\n  UNION ALL\n  SELECT 'merge', feature_id FROM mvt.main.read_tiles('${FLORENCE}', zoom := 14, layer := 'roads')\n)\nGROUP BY mode ORDER BY rows DESC;`,
  },
  {
    title: "Florence roads by kind, with their length",
    sql: `SELECT "pmap:kind" AS kind, count(*) AS roads,\n       round(sum(ST_Length_Spheroid(geometry)) / 1000, 1) AS km\nFROM mvt.main.read_tiles('${FLORENCE}', layer := 'roads', zoom := 14)\nGROUP BY kind ORDER BY km DESC;`,
  },
  {
    title: "Places in central Florence, from a 4.66 GB worldwide file",
    sql: `SELECT category_main, count(*) AS n\nFROM mvt.main.read_tiles('${OVERTURE}', layer := 'pois')\nWHERE ST_Intersects(geometry, ST_MakeEnvelope(11.24, 43.76, 11.27, 43.78))\nGROUP BY ALL ORDER BY n DESC LIMIT 10;`,
  },
  {
    title: "Join two tilesets: Overture places inside each kind of Florence land use",
    sql: `WITH landuse AS (\n  SELECT "pmap:kind" AS kind, geometry\n  FROM mvt.main.read_tiles('${FLORENCE}', layer := 'landuse', zoom := 14)\n  WHERE ST_Intersects(geometry, ST_MakeEnvelope(11.24, 43.76, 11.27, 43.78))\n), places AS (\n  SELECT category_main AS category, geometry\n  FROM mvt.main.read_tiles('${OVERTURE}', layer := 'pois')\n  WHERE ST_Intersects(geometry, ST_MakeEnvelope(11.24, 43.76, 11.27, 43.78))\n)\nSELECT l.kind, count(*) AS places, mode(p.category) AS most_common\nFROM landuse l JOIN places p ON ST_Contains(l.geometry, p.geometry)\nGROUP BY l.kind ORDER BY places DESC;`,
  },
];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const status = (msg: string) => {
  $("#status").textContent = msg;
  console.info(`[mvt-demo] ${msg}`);
};

async function boot(): Promise<duckdb.AsyncDuckDBConnection> {
  if (!self.crossOriginIsolated) {
    throw new Error("this page must be cross-origin isolated (COOP/COEP headers) for the worker: transport");
  }
  const bundle = await duckdb.selectBundle({
    base: { mainModule: `${HAYBARN}duckdb-base.wasm`, mainWorker: `${HAYBARN}duckdb-browser-base.worker.js` },
    threads: {
      mainModule: `${HAYBARN}duckdb-threads.wasm`,
      mainWorker: `${HAYBARN}duckdb-browser-threads.worker.js`,
      pthreadWorker: `${HAYBARN}duckdb-browser-threads.pthread.worker.js`,
    },
  });
  if (!bundle.pthreadWorker) throw new Error("the browser picked the single-threaded build; the worker: transport needs threads");
  status("Starting the DuckDB engine (threads build)…");
  const engineWorker = new Worker(bundle.mainWorker!);
  installVgiWebWorkerBridge()(engineWorker); // lets SQL spawn same-origin `worker:` URLs
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), engineWorker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  status("Opening the database…");
  await db.open({ query: { castBigIntToDouble: true } });
  const conn = await db.connect();
  status("Loading the vgi and spatial extensions…");
  await conn.query("INSTALL vgi FROM community; LOAD vgi;");
  await conn.query("INSTALL spatial; LOAD spatial; INSTALL json; LOAD json;");
  status("Starting the mvt worker in a Web Worker…");
  await conn.query("ATTACH 'worker:mvt-worker.js' AS mvt (TYPE vgi);");
  return conn;
}

function render(table: { schema: { fields: { name: string }[] }; numRows: number; getChildAt(i: number): { get(r: number): unknown } | null }) {
  const out = $("#out");
  const names = table.schema.fields.map((f) => f.name);
  const head = `<tr>${names.map((n) => `<th>${escape(n)}</th>`).join("")}</tr>`;
  const rows: string[] = [];
  for (let r = 0; r < Math.min(table.numRows, 200); r++) {
    const cells = names.map((_, c) => {
      const v = table.getChildAt(c)?.get(r);
      const text = v === null || v === undefined ? "NULL" : v instanceof Uint8Array ? `<${v.length} bytes>` : String(v);
      return `<td class="${typeof v === "number" ? "num" : ""}">${escape(text)}</td>`;
    });
    rows.push(`<tr>${cells.join("")}</tr>`);
  }
  out.innerHTML = `<table><thead>${head}</thead><tbody>${rows.join("")}</tbody></table>`;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function main() {
  const picker = $<HTMLSelectElement>("#examples");
  EXAMPLES.forEach((e, i) => picker.add(new Option(e.title, String(i))));
  const editor = $<HTMLTextAreaElement>("#sql");
  editor.value = EXAMPLES[0]!.sql;
  picker.addEventListener("change", () => {
    editor.value = EXAMPLES[Number(picker.value)]!.sql;
  });

  status("Starting Haybarn WASM…");
  let conn: duckdb.AsyncDuckDBConnection;
  try {
    conn = await boot();
  } catch (err) {
    status(`Startup failed: ${(err as Error).message}`);
    (window as unknown as { __mvtDemo: unknown }).__mvtDemo = { ready: false, error: String(err) };
    return;
  }
  status("Ready. The mvt worker runs in this tab; tiles come straight from the PMTiles URLs.");
  const run = async () => {
    const button = $<HTMLButtonElement>("#run");
    button.disabled = true;
    status("Running…");
    const t0 = performance.now();
    try {
      const result = await conn.query(editor.value);
      render(result as unknown as Parameters<typeof render>[0]);
      status(`${result.numRows} rows in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
    } catch (err) {
      $("#out").innerHTML = `<pre class="error">${escape(String((err as Error).message ?? err))}</pre>`;
      status("Query failed");
    } finally {
      button.disabled = false;
    }
  };
  $("#run").addEventListener("click", run);
  editor.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
  });
  // For automated checks: run SQL and get plain rows back.
  (window as unknown as { __mvtDemo: unknown }).__mvtDemo = {
    ready: true,
    query: async (sql: string) => (await conn.query(sql)).toArray().map((r: { toJSON(): unknown }) => r.toJSON()),
  };
}

void main();
