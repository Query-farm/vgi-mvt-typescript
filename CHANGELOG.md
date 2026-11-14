# Changelog

## 0.1.0 (2026-11-14)

First release. A TypeScript port of vgi-mvt's vector tile reader: decodes MVT tiles from
PMTiles archives, attaches a tileset as a database, and runs in the browser on Haybarn WASM
over `worker:`. Ships composed examples (spatial layer join, metadata vs tiles). Signed
standalone binaries for linux x86-64/arm64, macOS arm64 and Windows x86-64.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
