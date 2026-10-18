# dashql-embed

A CLI that prepares SQL scripts for semantic search: it writes natural-language descriptions into the scripts,
extracts structured features with DashQL and embeds both with transformers.js.
The embeddings go into two Parquet files that a later example library can search with a user prompt.

```
dashql-embed describe <dir|file.sql>... [--force] [--dry-run]
dashql-embed index    <dir|file.sql>... --out-dir <dir> [--model <id>] [--layout 3d|2d|none] [--output-feature-text]
dashql-embed query    <dir|file.sql>... --index-dir <dir> --prompt "<text>" [--top 10]
```

Run it through Bazel: `bazel run //packages/dashql-embed:cli -- index examples/notebooks --out-dir /tmp/idx`.
Relative paths are resolved against the directory you invoke Bazel from.

## Two steps

**`describe`** asks Claude for a short description and a few example questions per script and writes them as a
marked header comment. The model sees the statements of the script and nothing else, no comments and no analysis. Scripts that already have such a block are skipped, `--force` replaces the block and leaves
everything else alone.

```sql
-- @dashql:description
-- Revenue of the ten highest-value unshipped orders for customers of the BUILDING market segment.
--
-- Example questions:
-- - Which unshipped orders bring in the most revenue?
-- @dashql:end
-- TPC-H query 3
select ...
```

The result is plain SQL that can be reviewed, edited and committed. `index` never calls an LLM, so you can
regenerate embeddings without paying for descriptions again. Run it again and only scripts without a description
block are sent to the model.

By default `describe` runs the Claude Code CLI (`claude -p`) and uses its login, so `claude` has to be on the `PATH`.
`--describer api` calls the Anthropic API instead, with credentials from `ANTHROPIC_API_KEY` or an `ant auth login`
profile.

**`index`** analyzes every script with DashQL and embeds two separate things, one Parquet file each.
Both files identify the script by `script_name` (its path relative to the input directory) and `script_hash`
(sha256 of its content), which is also how the two files are joined. Neither file stores the script or the embedded
feature text: apps that need them read the SQL files, and the feature text can be recomputed from them.

`comments.parquet`, one row per comment chunk. The description block and human comments are embedded, commented-out SQL
is not. Long comments are split to fit the model window.

| column | type | |
|---|---|---|
| `script_name` | utf8 | |
| `script_hash` | utf8 | |
| `chunk_index` | int32 | |
| `source` | utf8 | `dashql_description` or `comment` |
| `text` | utf8 | the embedded chunk |
| `embedding` | fixed size list<float32>[dim] | L2-normalized |

`features.parquet`, one row per script. The embedding is computed from the feature text, a deterministic summary of
tables, joins, aggregates, grouping, filters, operators and output columns, fitted to the model window.

| column | type | |
|---|---|---|
| `script_name`, `script_hash` | utf8 | |
| `truncated` | bool | whether sections of the feature text had to be cut to fit |
| `embedding` | fixed size list<float32>[dim] | L2-normalized |
| `statement_types`, `tables`, `columns`, `functions`, `aggregates`, `function_calls`, `ctes`, `joins`, `filters`, `operators`, `visualizations` | list<utf8> | the extracted features |
| `diagnostics` | list<utf8> | scan, parse and analyze messages |
| `atlas_3d_x`, `atlas_3d_y`, `atlas_3d_z` | float32 | position in a 3D point cloud, see [Layout](#layout) (default) |
| `atlas_2d_x`, `atlas_2d_y` | float32 | position in a 2D scatter plot, instead of the 3D columns with `--layout 2d` (`--layout none` omits both) |
| `feature_text`, `feature_token_count` | utf8, int32 | the embedded text and its length, only with `--output-feature-text` (for debugging) |

The metadata of both files records `kind`, `model`, `dtype`, `pooling`, `query_prefix`, `max_tokens`, `dim`,
`dashql_core_version` and `format_version`, so queries are embedded exactly like the documents.

Comments and features are never mixed into one window.

## Layout

`index` also places every script in 3D so that a viewer can show the library as a point cloud. The coordinates are
in `features.parquet` as `atlas_3d_x`, `atlas_3d_y` and `atlas_3d_z`. `--layout 2d` writes `atlas_2d_x` and
`atlas_2d_y` for a scatter plot instead. The 2D layout is a UMAP run of its own, not the 3D one without z, and the
dimensions are in the column names so that a SQL query cannot mistake one for the other. The coordinates are
centered at the origin and scaled so that the 98th percentile of the distance from the center is 1. The metadata has
`dashql_embed.layout` (`umap-3d` or `umap-2d`) and `dashql_embed.layout_scale`.

The layout is UMAP on the feature embeddings (cosine, the UMAP defaults of 15 neighbors and minimum distance 0.1), run
by the vendored wasm module of `//packages/dashql-umap`. Three things keep it stable:

- **Duplicates are removed first.** Scripts with the same feature text have the same embedding. UMAP gets only the
  distinct vectors and the duplicates are scattered in a radius of 0.01 around their twin. With duplicates in the input
  the layout changes completely from one run to the next.
- **PCA start.** A cold start begins at the first three (or two) principal components instead of spectral or random
  coordinates, so the same embeddings always give the same layout.
- **Warm start.** When `--out-dir` already has a `features.parquet` of the same model and layout dimensions, scripts
  with the same name and hash start where they were. New scripts start at the mean position of their five nearest
  neighbors, and 60 gentle epochs follow instead of a full run. If no script is new, nothing is optimized and the layout
  stays as it is. If less than half of the scripts are known, the layout starts from scratch.

Measured in 2D: on the embeddings of 700 distinct test scripts, replacing 10% of the scripts moved the known ones by
0.07 to 0.08 of the cloud radius (from 150 scripts up), with the same neighbor quality as a fresh layout. With 60
scripts they moved by 0.23. Re-indexing the same scripts moves nothing.

## Searching

`query` searches a set of scripts with the index files that `index` wrote for it:

```
bazel run //packages/dashql-embed:cli -- query examples/notebooks/tpch/scripts \
    --index-dir /tmp/idx --prompt "unshipped orders with the highest revenue" --top 5
```

It embeds the prompt, scores every script of the set against its comment chunks (best chunk) and its feature text, and
prints the best `--top` scripts. Index rows of scripts outside the set are ignored. Scripts that are not in the index or
changed since they were indexed are reported and not searched. The two scores are combined by `--fusion weighted`
(default, `--weight-comments 0.6 --weight-features 0.4`; a script without comments uses its feature score) or `rrf`.

## Features

Features come from the DashQL parser and analyzer. Scripts are analyzed on their own: tables and columns resolve
only against what the script declares itself (`create table …`), all other names stay as written. Table aliases are
resolved to their table, but unqualified columns of undeclared tables stay unqualified, and `a.id = b.id`-style joins
are found while `c_custkey = o_custkey` is not (it is listed as a filter). The analyzer does not model the output
columns of subqueries, so such names can show up unqualified.

Nothing is masked: function names and literals are kept as written. `function_calls` lists every call with its
arguments, and filters are rendered with qualified columns and normalized spacing and case:

```
function_calls: current_timestamp, date_trunc('day', orders.o_orderdate), sum(orders.o_totalprice)
filters:        date_trunc('day', orders.o_orderdate) > current_timestamp - interval '30' day
                customer.c_mktsegment = 'BUILDING'
                orders.o_orderdate < date '1995-03-15'
```

A trailing `VISUALIZE USING` statement is compiled like the app does it. The effective spec becomes one `visualizations`
entry per chart (one per layer), rendered as the `Visualization:` line of the feature text. An entry names the chart in
the words that people search for, then lists the mark and the encoded channels:

```
vegalite scatter plot (point, x weight quantitative, y horsepower quantitative, color origin nominal)
vegalite normalized stacked bar chart titled "Revenue by region" (bar, x category nominal, y sum(revenue) quantitative normalized stack, color region nominal)
vegalite layer 1 of 2 time series line chart (line, x date temporal, y revenue quantitative, independent y scale)
markdown (customer, nation, order_count)
```

Chart names are derived from the mark and the encoding (scatter plot, bubble chart, histogram, stacked and grouped bar
chart, time series, heatmap, pie chart, map). Titles, mark options, time units, binning, aggregates, stacking, sorting,
faceting and independent layer scales are kept. The fields of the spec are not listed as `columns` and the raw JSON,
including its `data` member, is not embedded. The spec itself only shows up in the snapshots.

`group by 1` and `order by 1` are shown as the expression they refer to. Single expressions are cut at 120 characters.

## Models

The default is `Snowflake/snowflake-arctic-embed-xs` (384 dimensions, 512 tokens, CLS pooling, queries get the
Snowflake retrieval prefix). `--model` accepts only the Snowflake Arctic Embed presets (`-xs`, `-s`, `-m-v2.0`).
`--embedder hash` is an offline, deterministic stand-in for tests.

## Tests and snapshots

- `bazel test //packages/dashql-embed:tests` runs unit tests, an offline end-to-end test (stubbed describer, hash
  embedder) and the snapshot check.
- `snapshots/embed/*.yaml` (`basic` for plain SQL, `dashql` for VISUALIZE, SET and EXPLAIN scripts) show what `index` extracts from a script: features, feature text and the
  comment chunks that are embedded. Cases with a `describe` key also show the exact prompt that `describe` sends to the
  model, or that it skips the script because it already has a description. No model is involved; the header rendering
  is covered by unit tests. Regenerate with `bazel run //snapshots/embed:update` from `snapshots/embed/*.tpl.yaml`.
- `bazel test //packages/dashql-embed:model_smoke_test` checks that the default model loads (needs network).

# Examples

```
# Generate descriptions
bazel run //packages/dashql-embed:cli -- describe ./examples/atlas --model claude-sonnet-5-5

# Generate embeddings
bazel run //packages/dashql-embed:cli -- index ./examples/atlas --out-dir /tmp/atlas-index
```
