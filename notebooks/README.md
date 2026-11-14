# Map tile measurements through VGI

[01 — Measure tile buffer overlap](01_measure_tile_buffer_overlap.ipynb) compares synthetic roads and polygons read with raw, clipped and merged edge handling. The saved default is raw; the experiment changes only the policy to merge. SQL performs all decoding, spatial measures and comparisons; Python plots returned geometry.

## Run from this directory alone

Prerequisites: Python 3.13 or 3.14, uv, Git, and **Bun 1.3.14** on PATH. Internet access is required to obtain the pinned public worker, frozen Bun packages, Python environment and signed VGI/spatial extensions. Subsequent data reads use only the bundled synthetic archive. No account or API credentials are used.

```sh
cd notebooks
uv sync --frozen
uv run --frozen python execute.py
uv run --frozen python execute.py --parameters '{"TILE_EDGES":"merge"}' --output-dir artifacts/experiment
```

For Jupyter, select `notebooks/.venv/bin/python` as the interpreter, or register it explicitly:

```sh
uv run --frozen python -m ipykernel install --user --name vgi-mvt-typescript-notebooks --display-name "Python (vgi-mvt-typescript notebooks)"
```

The runner uses a temporary kernel specification and notebook-directory cwd. It atomically saves only successful runs, rejects unknown overrides, and requires a separate output directory for overrides. Experiment directories contain all fixtures, helpers, assets and environment instructions. Failure leaves the last successful source notebook untouched. `artifacts/`, environments and generated logs are ignored.

## Worker and data pins

Visible SQL uses `LOCATION 'python3 worker_launcher.py'`. The launcher fetches unchanged public revision **b1d8396c360d6db194ab45abf1749c5938143e89** from [Query-farm/vgi-mvt-typescript](https://github.com/Query-farm/vgi-mvt-typescript/tree/b1d8396c360d6db194ab45abf1749c5938143e89), installs its original `bun.lock` with `--frozen-lockfile`, verifies tracked worker source and Git HEAD on reuse, and executes `src/worker.ts`. No local worker installation or engine build is involved. Haybarn is separately pinned to **2.0.0rc11** in this directory's lockfile. The worker SDK remains at its source revision's tested TypeScript constraints.

A bounded 180-second directory lock serializes cold installs, which are published by atomic rename. To clear the cache, stop every running notebook first, then remove `artifacts/worker-*`; remove a stale `.lock` directory only after ensuring no launcher is active. Upgrading the source revision, Bun or engine requires rerunning all default/experiment and source checks; do not edit only one pin and assume compatibility.

`fixtures/edges.pmtiles` and its two source GeoJSON companions are copied byte-for-byte from the pinned revision's `test/fixtures/`. They are authored synthetic test data, not a public geographical survey. The source GeoJSON documents intended shapes; notebook measurements use only the actual worker-decoded archive, including its quantization. SHA-256:

- `edges.pmtiles`: `304713286a01292458da750741a1c9b1f5bac9e0923153788540ce27a60eb698`
- `edges_areas.geojson`: `876371d0a4d65ea75c178d1185179550aba97515891e9be7919137587375ef99`
- `edges_roads.geojson`: `288a021c3b38ff18e23d1406ae5143d4be759fa7a043be08fee83fe241d77288`

## Interpretation and validation

`raw` retains buffered tile copies; `clip` keeps each tile's piece; `merge` joins pieces. Counts are piece counts, and `(layer, name)` is a known identity key only in this fixture. Coordinates use EPSG:3857. Kilometres and square kilometres are **projected**, not ground/geodesic measures. Small merged line-length differences can arise from edge snapping; the notebook does not claim exact equivalence with clip.

Validation results are recorded after running the default, a standalone cold-cache copy and the focused merge experiment, visually reviewing all four default/experiment charts, checking runner guards and running the repository's `make check`.

Validated on macOS arm64 with Bun 1.3.14: default 2.6 s; detached empty-cache default 21.4 s; detached merge experiment 2.4 s. Both runs pass nine SQL invariants and render two reviewed charts. Raw returns nine pieces versus merge four; raw Four tiles area is +20.1904% above clip, while merge area agrees and Diagonal length differs by -0.0045%. Three runner rejection/preservation guards and two simultaneous cold-cache worker starts passed. `make check` passed: Biome, TypeScript, 26 Bun tests, 268 stdio + 268 launch + 232 HTTP SQL assertions, and metadata 100/100 L2 with zero findings. Notebook structural review and helper Ruff checks passed. Root source, tests and Bun lock are unchanged.
