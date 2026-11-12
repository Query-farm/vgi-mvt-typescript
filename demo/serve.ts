/**
 * Serve the demo with the headers SharedArrayBuffer needs (cross-origin isolation).
 *
 *   bun run demo          # builds, then serves http://localhost:8800
 *
 * /haybarn/* is the Haybarn WASM (@haybarn/haybarn-wasm) dist from node_modules; everything else
 * comes from dist/browser (the built worker, demo bundle, page and shim).
 */
import { join, normalize } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HAYBARN = join(ROOT, "node_modules", "@haybarn", "haybarn-wasm", "dist");
const SITE = join(ROOT, "dist", "browser");
const port = Number(process.env.PORT ?? 8800);

const TYPES: Record<string, string> = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".html": "text/html; charset=utf-8" };

const server = Bun.serve({
  port,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const [base, rel] = path.startsWith("/haybarn/") ? [HAYBARN, path.slice("/haybarn/".length)] : [SITE, path.slice(1) || "index.html"];
    const full = normalize(join(base, rel));
    if (!full.startsWith(base)) return new Response("forbidden", { status: 403 });
    const file = Bun.file(full);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const ext = full.slice(full.lastIndexOf("."));
    return new Response(file, {
      headers: {
        "Content-Type": TYPES[ext] ?? file.type,
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "no-store",
      },
    });
  },
});
console.log(`demo at http://localhost:${server.port}/`);
