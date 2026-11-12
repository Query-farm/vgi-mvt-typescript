// Classic Worker shim for the mvt worker. Haybarn WASM's VGI bridge spawns this with
// `new Worker(url)` (classic). A classic worker can't run an ES module, so buffer the
// one-shot `vgi-init` message and import the ESM bundle, which drains the buffer.
globalThis.__vgiBuffered = [];
self.addEventListener("message", (e) => {
  globalThis.__vgiBuffered.push(e.data);
});
import("./mvt-worker.mjs").catch((err) => {
  self.postMessage({ type: "vgi-error", error: `mvt worker import failed: ${err?.message ?? err}` });
});
