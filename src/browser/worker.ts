/**
 * The worker inside a browser: Haybarn WASM's VGI extension spawns it for
 * `ATTACH 'worker:<url>' AS mvt (TYPE vgi)` and talks to it over a
 * SharedArrayBuffer channel (the `worker:` transport). No server is involved:
 * tiles are fetched straight from the PMTiles URLs with range requests.
 *
 * The extension's bridge starts a *classic* Worker, which can't run an ES module,
 * so `public/mvt-worker.js` (a tiny classic shim) buffers the init message and
 * imports this bundle (`bun run build:browser` writes it to dist/browser/).
 *
 * Every channel slot is served on this one event loop (`serveChannel`), so all
 * of DuckDB's connections share one set of open tilesets and directory caches.
 */

import { FunctionRegistry, ReadOnlyCatalogInterface } from "@query-farm/vgi/worker-cf";
import { serveStream } from "@query-farm/vgi-rpc";
// buildVgiProtocol isn't exported from a browser-safe entry yet (the root entry pulls in
// Node transports), so import its module directly. Remove once worker-cf exports it.
import { buildVgiProtocol } from "../../node_modules/@query-farm/vgi/src/protocol/dispatch.ts";
import { CATALOG } from "../catalog.ts";
import { openChannel, serveChannel } from "./sab.ts";

const registry = new FunctionRegistry();
for (const schema of CATALOG.schemas) for (const fn of schema.functions ?? []) registry.register(fn);
const catalogInterface = new ReadOnlyCatalogInterface(CATALOG, registry);
const protocol = buildVgiProtocol({ registry, catalogInterface, catalogName: CATALOG.name });

const post = (m: unknown) => (self as unknown as { postMessage(x: unknown): void }).postMessage(m);

function handle(d: { type?: string; buffer?: SharedArrayBuffer; offset?: number } | null): void {
  if (!d || d.type !== "vgi-init") return;
  try {
    const ch = openChannel(d.buffer as SharedArrayBuffer, d.offset as number);
    serveChannel(ch, (readable, writable) => serveStream(protocol, { readable, writable }));
    post({ type: "vgi-ready" });
  } catch (err) {
    post({ type: "vgi-error", error: String((err as Error)?.message ?? err) });
  }
}

const buffered = (globalThis as { __vgiBuffered?: unknown[] }).__vgiBuffered;
if (Array.isArray(buffered)) for (const d of buffered) handle(d as { type?: string });
self.addEventListener("message", (e: MessageEvent) => handle(e.data));
