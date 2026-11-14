# Vector Tile Reader examples

Two executed stories use the public native **v0.1.0** TypeScript worker:

- [How much do tile buffers inflate a measurement?](01_measure_tile_buffer_overlap.ipynb) compares raw pieces with a clipped reference, then changes `TILE_EDGES` from `raw` to `merge`. It also reconciles declared attributes and directly attached layer tables.
- [Valid geometry can still be in the wrong place](02_valid_geometry_wrong_tile_address.ipynb) decodes identical bytes using a deliberately wrong XYZ column and the recorded reference. Change `ASSIGNED_X` from 1 to 2 to restore the recorded address.

The fixtures are unchanged GDAL repository test outputs. They contain invented roads/areas and city records with fixture/historical attribute values, **not observed infrastructure or a current place dataset**. [Provenance](fixtures/provenance.json) records released paths, sizes and SHA-256 hashes. The input tile in the second story is already quantized and has known XYZ address 2/2/1.

## Run from this folder or a single notebook

Install [uv](https://docs.astral.sh/uv/) and Git, then:

```bash
uv sync --locked
uv run --locked vgi-notebooks 01_measure_tile_buffer_overlap.ipynb
uv run --locked vgi-notebooks 02_valid_geometry_wrong_tile_address.ipynb
```

The notebook lock pins shared **v0.3.32** with `[runner]` for local execution. Each Colab badge opens a single file whose conditional bootstrap installs only the base shared package. `prepare("mvt-typescript")` downloads seven companion files from immutable public commit `d9af054ead71bdcbdc28d2928112b260736ecb80` and verifies their hashes. No parent worker checkout, root virtual environment, Bun installation or build is required.

The actual connection remains visible:

```sql
INSTALL vgi FROM community;
LOAD vgi;
INSTALL spatial;
LOAD spatial;
ATTACH 'mvt' (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-mvt-typescript@v0.1.0');
```

The launcher selects the host-platform asset and validates its published checksum before caching the executable. Release v0.1.0 and current public source both resolve to `85aded6d7319f72ec4f37138c728fa3302382743`. The notebook engine is published Haybarn 2.0.0rc11. Initial shared-package, release and extension retrieval needs internet; analysis reads local immutable fixtures only. Shared setup opens an empty temporary SQL-secret directory with persistent secrets disabled before ATTACH; cleanup verifies the inventory and closes the session.

**Validation download limitation:** the anonymous cold GitHub API request returned HTTP 403 from its rate limit. Validation downloaded the actual pinned release using existing GitHub authentication confined to a test subprocess, then executed notebooks anonymously from the verified cache. A separate empty-cache anonymous retry also returned 403. No token appears in these notebooks, setup files or outputs. Cold anonymous download is not claimed successful while throttled; a first run needs GitHub API access below its rate limit or the launcher's supported authenticated environment. This is separate from SQL-secret isolation.

For an editor, register and select the local environment:

```bash
uv run --locked python -m ipykernel install --user --name mvt-typescript-examples \
  --display-name "Python (vgi-mvt-typescript notebooks)"
```

Restart and Run All after changing parameters. Setup/presentation code is folded. Native SVG and exact image-link SVG files support standalone notebook and GitHub rendering. All analytical geometry and measurements are visible SQL; Python draws returned geometry and formats returned numbers.

## Separate experiments

```bash
uv run --locked vgi-notebooks 01_measure_tile_buffer_overlap.ipynb \
  --parameters '{"TILE_EDGES":"merge"}' --output-dir artifacts/merge
uv run --locked vgi-notebooks 02_valid_geometry_wrong_tile_address.ipynb \
  --parameters '{"ASSIGNED_X":2}' --output-dir artifacts/correct-address
```

The runner requires a separate output directory for overrides, preserves the saved default and carries experiment branding/documentation. Reset defaults to `raw` and 1 respectively.

The edge-policy experiment retains the archive, zoom 3, selected feature identities and clipped reference. It changes returned piece counts and measured overlap. Unique layer/name keys belong to this four-feature fixture; they are not universal IDs. Merge may snap line endpoints, so clipped/merged lengths are compared within a stated 0.1% tolerance instead of assumed identical. Every archive read has `max_tiles=64`.

The address experiment retains the exact raw tile bytes, six property objects and valid geometries while correcting the supplied X column. At zoom 2, one column spans 90° longitude and one quarter of the Web Mercator world width. Both X=1 and X=2 are syntactically legal, but only X=2 matches this fixture's provenance. Geometry validity does not establish correct geographic placement. The city labels are fixture values, not a mechanism for inferring the tile address.

Lengths/areas are planar EPSG:3857 comparisons, **not ground distances, geodesic areas or location-accuracy estimates**. The address plot uses longitude/latitude schematically without a basemap and a separate signed projected-displacement axis. Original encoding quantization and projection distortion remain outside these controls.

## Catalog and validation evidence

The actual unconfigured catalog exposes **three fixed functions**: `read_tiles`, `read_mvt` and `tileset_layers`, with no COPY formats or static tables. Selecting `edges.pmtiles` adds typed `areas` and `roads` tables. The first story reads both and reconciles their complete geometry/name multisets with the selected function; metadata declarations are compared with populated attributes.

[coverage.json](coverage.json) records **5/5 for this explicitly selected fixture configuration**, including **3/3 fixed functions**. Future archives can expose different names and columns; this is not a global static denominator for arbitrary data. Complete runtime function/table/view inventories, arguments and output/table DESCRIBE schemas are in [coverage/](coverage/). Release and current snapshots use the same peeled source revision because the tag and public main are identical; there is no substituted local build.

Defaults, detached single-parameter experiments, six overwrite/parameter guards, all rendered figures and a fresh notebook-only bootstrap with eight libraries preloaded are checked. The latter is a compatible Python 3.12 kernel test; hosted Colab itself is not manually operated. The verified native release cache is shared by these runs; companion retrieval starts cold in the detached directories.

Worker source and root locks are unchanged. This notebook-only publication reuses [green source CI](https://github.com/Query-farm/vgi-mvt-typescript/actions/runs/43614805268), with no repeated source build, full transport suite or deployment. See the [shared standard](STANDARD.md).
