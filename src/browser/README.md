# Browser entry

`worker.ts` is bundled for the browser by `bun run build:browser`; it is not part of the
`tsc --noEmit` gate (see `tsconfig.json`'s `exclude`). It imports the SDK's
`protocol/dispatch.ts` by path because `buildVgiProtocol` isn't exported from a browser-safe
entry yet, and type-checking that source under this repo's strict, non-DOM settings fails.
The bundle build plus the demo check in a real browser cover it instead. `sab.ts` is the
SharedArrayBuffer channel adapter from vgi-typescript's `examples/sab-worker`.
