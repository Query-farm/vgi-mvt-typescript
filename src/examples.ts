/**
 * Example queries that combine several of the worker's functions.
 *
 * Each is defined once here and listed on the function that drives it (the
 * catalog also publishes it in the schema-level list); the offline ones are
 * executable examples too.
 */

const SAMPLE = "test/fixtures/sample.pmtiles";

/** tileset_layers + read_tiles: what the metadata promises next to what the tiles hold. */
export const LAYER_PROFILE = {
  description:
    "Profile the fixture tileset: each layer's declared attributes and zoom range (tileset_layers) " +
    "beside its feature count and geometry types at the max zoom (read_tiles)",
  sql:
    "WITH declared AS (SELECT layer, string_agg(field, ', ' ORDER BY field) AS attributes, " +
    "min(minzoom) AS minzoom, max(maxzoom) AS maxzoom " +
    `FROM mvt.main.tileset_layers('${SAMPLE}') GROUP BY layer), ` +
    "found AS (SELECT layer, count(*) AS features, string_agg(DISTINCT geometry_type, ', ') AS geometry_types " +
    `FROM mvt.main.read_tiles('${SAMPLE}') GROUP BY layer) ` +
    "SELECT d.layer, d.attributes, d.minzoom, d.maxzoom, f.features, f.geometry_types " +
    "FROM declared AS d LEFT JOIN found AS f USING (layer) ORDER BY d.layer",
  expected: [
    ["cities", "capital, name, population", 0, 3, 4, "POINT"],
    ["regions", "area_rank, code, label", 0, 3, 2, "POLYGON"],
  ],
};

/** read_mvt + tileset_layers: check one tile file against the tileset's declared attributes. */
export const TILE_ATTRIBUTE_FILL = {
  description:
    "For each attribute the sample tileset's metadata declares (tileset_layers), how many of the " +
    "standalone tile 0/0/0's features in that layer carry a value for it (read_mvt)",
  sql:
    "SELECT t.layer, t.field, count(f.layer) AS features, count(f.properties->>t.field) AS with_value " +
    `FROM mvt.main.tileset_layers('${SAMPLE}') AS t ` +
    "LEFT JOIN mvt.main.read_mvt('test/fixtures/0-0-0.mvt', 0, 0, 0) AS f ON f.layer = t.layer " +
    "GROUP BY t.layer, t.field ORDER BY t.layer, t.field",
};

/** read_tiles x read_tiles: a point-in-polygon join between two layers of one tileset. */
export const CITY_REGIONS = {
  description:
    "Spatial join of two layers: the region polygon (if any) each city of the fixture tileset lies in, " +
    "using the typed columns layer := adds",
  sql:
    "SELECT c.name, c.population, r.code AS region, r.label " +
    `FROM mvt.main.read_tiles('${SAMPLE}', layer := 'cities') AS c ` +
    `LEFT JOIN mvt.main.read_tiles('${SAMPLE}', layer := 'regions') AS r ON ST_Within(c.geometry, r.geometry) ` +
    "ORDER BY c.name",
  expected: [
    ["Berlin", 3645000.0, null, null],
    ["Milan", 1352000.0, "A", "Square with a hole"],
    ["Paris", 2148000.0, null, null],
    ["Vienna", 1897000.0, null, null],
  ],
};

/** The `{description, sql}` form the function example lists take. */
export const example = (e: { description: string; sql: string }) => ({ description: e.description, sql: e.sql });

/** The executable-example form, with its expected rows. */
export const executable = (e: { description: string; sql: string; expected: unknown[][] }) => ({
  description: e.description,
  sql: e.sql,
  expected_result: e.expected,
});
