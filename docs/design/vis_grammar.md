# Trailing VISUALIZE clause

`VISUALIZE` is a trailing dashql clause grafted onto the SQL grammar. It
describes a chart as a structured spec — a nested key-value tree that mirrors
Vega-Lite's JSON shape — applied to a required SQL relation and a visualization
*renderer* named after `USING`.

## Shape

```
<complete classical SELECT query> VISUALIZE USING <renderer> (
    ...
)

SELECT * FROM <relation> VISUALIZE USING <renderer> (
    mark => <mark-type>,
    encoding => (
        <channel> => (<field-def-key> => <value>, ...),
        ...
    ),
    dashboard => (
        row => <zero-based row>,
        column => <zero-based column>,
        width => <column span>,
        height => <row span>
    ),
    title => <string>,
    ...
)
```

The grammar is organized into four nested levels, each with its own object type
and key rule so that bison reports level-appropriate expected symbols for
autocompletion:

| Level | Node type | Contains |
|-------|-----------|----------|
| 1 | `OBJECT_VIS_SPEC` | Top-level spec properties: mark, encoding, dashboard, title, layer, etc. |
| 2 | `OBJECT_VIS_ENCODING` | Encoding channel definitions keyed by channel name |
| 3 | `OBJECT_VIS_FIELD_DEF` | Field definition properties: field, type, aggregate, bin, scale, axis, legend |
| 4 | `OBJECT_VIS_SCALE` / `OBJECT_VIS_AXIS` / `OBJECT_VIS_LEGEND` | Scale/axis/legend configuration |

## Renderer

The `USING <renderer>` clause selects the visualization renderer. `renderer` is a
closed keyword set (like the mark/field/scale-type enums), so the parser
validates it and offers it for autocompletion after `USING`; an unknown renderer
is a parse error. The current renderers are `vegalite`, `umap`, `markdown`, and `table`:

```sql
SELECT * FROM sales VISUALIZE USING vegalite (mark => bar);
SELECT * FROM embeddings VISUALIZE USING umap (vector => embedding);
SELECT product, revenue FROM product_summary VISUALIZE USING markdown (
    template => '## {{product}}: {{revenue}}'
);
SELECT product, revenue FROM product_summary VISUALIZE USING table (
    dashboard => (width => 12, height => 4)
);
```

The renderer is captured on the AST as the `VIS_VISUALISE_USING` attribute and
surfaced on the analyzed `VisualizationSpec` as `renderer`. Renderer-specific
analysis and output generation then process the spec. Vega-Lite and UMAP emit
their renderer JSON. Markdown templates are parsed once in the core with
pulldown-cmark (CommonMark) and encoded as a safe typed FlatBuffer AST.
`{{field}}` placeholders become `FIELD` leaves, raw HTML is discarded, and
unsafe or dynamic link destinations are not emitted as links. The app renders the generated FlatBuffer object model
directly, substituting formatted Arrow values as React text without parsing them
as Markdown, once per result row.

`table` has no renderer-specific output. It opts the query into Dashboard and
renders the existing result table directly.

## Dashboard placement

Every renderer accepts a root-level `dashboard` object. Dashboard uses a
12-column grid with zero-based coordinates. `row` and `column` are optional
starting hints; `width` defaults to 6 columns and `height` defaults to 3 rows.
Dashboard placement is not accepted inside nested Vega-Lite layers.

Invalid values produce analyzer warnings and are normalized: coordinates must
be non-negative, width is clamped to 1 through 12, height is at least 1, and a
specified column is moved left when necessary so the card fits the grid.

## Data source

`VISUALIZE` requires a complete, self-contained classical `SELECT` query on the
preceding query. A relation is visualized by selecting from it in that query:

```sql
SELECT * FROM sales VISUALIZE USING vegalite (mark => bar);
SELECT * FROM schema.sales VISUALIZE USING vegalite (mark => bar);
SELECT category, revenue FROM sales WHERE fy = 2026 VISUALIZE USING vegalite (mark => bar);
```

Standalone `VISUALIZE`, `VISUALIZE <source> USING ...`, and source-free
visualization are not part of the grammar. This is a hard cutover; there is no
legacy compatibility form. The query cannot name another notebook script
through a synthetic relation; all CTEs, projections, filters, and catalog-table
references needed by the chart must be present in the query itself.

## Mark types

The `mark` key accepts one of the following keywords, resolved against the
`VisMarkType` enum:

`arc`, `area`, `bar`, `boxplot`, `circle`, `geoshape`, `image`, `line`,
`point`, `rect`, `rule`, `square`, `text`, `tick`, `trail`

The mark value can also be a nested spec object for mark configuration:

```sql
SELECT * FROM sales VISUALIZE USING vegalite (
    mark => (type => bar, opacity => 0.7)
);
```

## Encoding channels

The `encoding` key introduces a level-2 list of channel definitions. Each
channel is keyed by one of 34 channel keywords:

**Positional:** `x`, `y`, `x2`, `y2`, `x_offset`, `y_offset`

**Color:** `color`, `fill`, `stroke`, `fill_opacity`, `stroke_opacity`,
`stroke_width`, `stroke_dash`, `opacity`

**Mark properties:** `size`, `shape`, `angle`

**Polar/radial:** `theta`, `theta2`, `radius`, `radius2`

**Geographic:** `latitude`, `longitude`, `latitude2`, `longitude2`

**Faceting:** `row`, `column`, `facet`

**Other:** `detail`, `order`, `tooltip`, `text`, `href`, `url`, `key`

### Shorthand encoding

A channel can take a bare column reference instead of a full field-def object.
This maps to `field => <column>`:

```sql
SELECT * FROM sales VISUALIZE USING vegalite (
    mark => line,
    encoding => (x => date, y => revenue)
);
```

### Full field definitions

Each channel's value can be a parenthesized list of field-def properties:

```sql
encoding => (
    x => (field => category, type => nominal),
    y => (field => revenue, type => quantitative, aggregate => sum)
)
```

**Field-def keys:** `field`, `type`, `bin`, `aggregate`, `time_unit`, `sort`,
`stack`, `impute`, `condition`, `title`, `band_position`, `datum`, `value`,
`format`, `format_type`, `scale`, `axis`, `legend`

### Field types

The `type` key accepts a `VisFieldType` enum keyword:

`nominal`, `ordinal`, `quantitative`, `temporal`, `geojson`

## Scale configuration

The `scale` key inside a field definition introduces a level-4 nested object:

```sql
x => (field => revenue, type => quantitative, scale => (type => log, zero => false))
```

**Scale types** (keywords for the `type` key within a scale):

`linear`, `log`, `pow`, `sqrt`, `symlog`, `identity`, `sequential`, `time`,
`utc`, `quantile`, `quantize`, `threshold`, `ordinal`, `band`, `point`

**Scale keys:** `type`, `domain`, `domain_min`, `domain_max`, `domain_mid`,
`range`, `range_min`, `range_max`, `scheme`, `interpolate`, `nice`, `zero`,
`clamp`, `padding`, `padding_inner`, `padding_outer`, `reverse`, `round`,
`exponent`, `bins`, `name`

## Axis configuration

The `axis` key inside a field definition introduces a level-4 nested object:

```sql
x => (field => category, type => nominal, axis => (label_angle => -45, grid => false))
```

**Axis keys:** `orient`, `format`, `format_type`, `grid`, `ticks`, `tick_count`,
`tick_size`, `label_angle`, `label_font_size`, `label_overlap`, `direction`,
`offset`, `values`, `z_index`, `title`, `domain`, `name`

## Legend configuration

The `legend` key inside a field definition introduces a level-4 nested object:

```sql
color => (field => category, type => nominal, legend => (orient => right, title => 'Category'))
```

**Legend keys:** `type`, `orient`, `format`, `format_type`, `direction`,
`title`, `values`, `padding`, `offset`, `z_index`, `name`

## Top-level spec keys

Beyond `mark` and `encoding`, the level-1 spec accepts:

`layer`, `data`, `transform`, `params`, `projection`, `autosize`, `resolve`,
`datasets`, `view`, `name`, `title`, `dashboard`, `padding`,
`background`, `filter`, `describe`, `type`

Unknown identifiers (`IDENT`) are accepted at every level with `Key::NONE` so
the grammar does not reject future Vega-Lite properties it doesn't yet have
dedicated handling for.

## Values

At levels 1, 3, and 4, values can be:

- Nested spec objects: `(key => value, ...)`
- Bracket arrays: `[1, 2, 3]` or `['a', 'b']`
- SQL function expressions: `count(*)`, `date_trunc('month', date)`
- Column references: `category`, `sales.revenue`
- Constants: numbers, strings, `true`, `false`, `null`
- Signed constants: `-45`, `+100`

At level 2 (encoding channel values), nested spec objects use the field-def
production instead; all other value forms are supported for the shorthand
encoding path.

## AST mapping

Top-level node: `OBJECT_VIS_VISUALISE` with attributes:
- `VIS_VISUALISE_SELECT` — the complete classical `SELECT` query prefix
- `VIS_VISUALISE_USING` — the required renderer `NAME` node (e.g. `vegalite`)
- `VIS_VISUALISE_SPEC` — the `OBJECT_VIS_SPEC` node

Per-level nodes:

| Level | Node type | Example attributes |
|-------|-----------|--------------------|
| 1 | `OBJECT_VIS_SPEC` | `VIS_SPEC_MARK`, `VIS_SPEC_ENCODING`, `VIS_SPEC_DASHBOARD`, ... |
| dashboard | `OBJECT_VIS_DASHBOARD_SPEC` | `VIS_DASHBOARD_ROW`, `VIS_DASHBOARD_COLUMN`, `VIS_DASHBOARD_WIDTH`, `VIS_DASHBOARD_HEIGHT` |
| 2 | `OBJECT_VIS_ENCODING` | `VIS_ENCODING_X`, `VIS_ENCODING_Y`, `VIS_ENCODING_COLOR`, ... |
| 3 | `OBJECT_VIS_FIELD_DEF` | `VIS_FIELD_DEF_FIELD`, `VIS_FIELD_DEF_TYPE`, `VIS_FIELD_DEF_SCALE`, ... |
| 4 | `OBJECT_VIS_SCALE` | `VIS_SCALE_TYPE`, `VIS_SCALE_DOMAIN`, `VIS_SCALE_ZERO`, ... |
| 4 | `OBJECT_VIS_AXIS` | `VIS_AXIS_ORIENT`, `VIS_AXIS_GRID`, `VIS_AXIS_LABEL_ANGLE`, ... |
| 4 | `OBJECT_VIS_LEGEND` | `VIS_LEGEND_TYPE`, `VIS_LEGEND_ORIENT`, ... |

Enums: `VisMarkType`, `VisFieldType`, `VisScaleType` (see
`proto/fb/dashql/parsed_script_enums.fbs`).

## Feature flag

`VISUALIZE` parsing is gated on `ParseContext::is_vis_enabled()`. When disabled,
the parser emits an error on the `VISUALIZE` token.

## Design rationale

The grammar deliberately mirrors Vega-Lite's JSON structure rather than
inventing a novel clause-based syntax. This has several advantages:

1. **Predictable mapping.** Every Vega-Lite spec has a mechanical translation
   to/from VISUALIZE syntax. No inference or restructuring is needed.
2. **Autocompletion.** Each level has its own key rule, so the parser can
   report exactly which keys are valid at the cursor position.
3. **Extensibility.** New Vega-Lite properties can be supported by adding a
   keyword and attribute key — no grammar restructuring required. Unknown
   identifiers are already accepted gracefully.
4. **SQL integration.** A complete classical `SELECT` query feeds the operator
   as a trailing clause, and values can be SQL expressions, so the visualization
   grammar composes cleanly with the rest of the SQL parser.

## Source files

- Grammar: `grammar/rules/ext_visualize.y` and `.yh`
- Flatbuffer schema: `proto/fb/dashql/parsed_script.fbs` and
  `parsed_script_enums.fbs`
- Analyzer: `packages/dashql-core/src/analyzer/visualization.rs`
- Vega-Lite generator: `packages/dashql-core/src/visualize/vegalite_generator.rs`
- Vega-Lite parser: `packages/dashql-core/src/visualize/vegalite_parser.rs`
- Test snapshots: `snapshots/visualize/basic.yaml`
