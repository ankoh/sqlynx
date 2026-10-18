# DashQL Atlas

`atlas.html` (`/atlas` on dashql.app) searches a folder of `.sql` files by their descriptions, their SQL and their
user-provided properties.
Everything runs in the browser: dashql-core analyzes the scripts, transformers.js embeds them with
`Snowflake/snowflake-arctic-embed-xs`, UMAP places them in 3D, and hyperdb-wasm writes, mounts and queries the Parquet
index files. It needs the File System Access API (Chromium) and a cross-origin-isolated page, like the shell.

## Files in the selected folder

Every embedding space has its own Parquet file and its own 3D layout. All files name the vector columns the same:
`dashql_atlas_embedding` and `dashql_atlas_{x,y,z}`.

| File | Content |
|------|---------|
| `dashql-atlas-structure.parquet` | One row per script: the embedding of its structure features (tables, joins, function calls, ...), the feature lists and a `<feature>_count` column for most of them |
| `dashql-atlas-description.parquet` | One row per chunk of the `@dashql:description` blocks of a script |
| `dashql-atlas-properties.parquet` | One row per script with a `@dashql:properties` block: a column per property and the embedded `key: value` text |

The files are written in the shape that the page shows, nothing is derived when they are loaded. The feature lists of
the structure cannot be binned, so `table_count`, `function_call_count`, `cte_count` and so on are stored next to them.
Joins and operators are not counted: the number of joins is up to the optimizer (a cross join with a predicate is a join
as well), and the operators are SQL clauses, not the operators of a plan. Every property key becomes a column of the
properties file: a double if all its values are numbers, a bool if all are booleans, text otherwise (objects and arrays
as JSON), null for scripts without the key. A key that collides with a fixed column is prefixed with `property_`. Only
the vector columns are stored as `real`.

Ordinary comments are not embedded, only `@dashql:description` blocks (written by `dashql-describe` or by hand).
The spaces are laid out independently: embedded together, UMAP clusters the descriptions with the descriptions and the
structure with the structure, which says nothing about the scripts.

There is no sidecar. A folder without index files is indexed when it is opened. Otherwise the index files are loaded,
and if that fails, e.g. because an older version wrote them (a structure file without `table_count`), the page asks to
reindex the folder. Every row carries the
`script_name` and the SHA-256 `script_hash` of the script text, the prompt bar shows how many scripts were added,
changed or removed since the index was written. Reindexing replaces the files and removes those of earlier versions
(`dashql-atlas-comments.parquet`, `dashql-atlas-features.parquet`, `dashql-atlas-index.json`).

Search is plain SQL over the mounted files, see `src/atlas/search/search.ts`:
`dot_product(dashql_atlas_embedding, ARRAY[...]::real[])`. The cast is required. There is one strategy per space.

## Properties

A script can carry user-provided properties as a pretty-printed JSON object in a `@dashql:properties` block:

```sql
-- @dashql:properties
-- {
--   "owner": "finance",
--   "dashboard": "Revenue Weekly",
--   "avg_runtime_ms": 1834
-- }
-- @dashql:end
```

dashql-core recognizes the tag and validates that the content is a JSON object (`ParsedScript.properties_block`,
`MALFORMED_COMMENT_TAG` warnings otherwise). `readProperties` and `renderPropertiesBlock` in `@ankoh/dashql-core` read
and write the block, clients never parse it themselves. Atlas embeds the properties as `key: value` lines.
`dashql-describe` never touches the block, never sends it to the model and inserts new descriptions below it.

The query result viewer writes such folders: the download button of a result offers **SQL Column as Atlas** next to
**Result as Arrow**. It writes one `.sql` file per row of the chosen SQL text column with the other columns as
properties, named after the row number (`row_00001.sql`, ...)
(`src/app/notebook/compute/ui/query_result/atlas_export.ts`).

## The page

Before a folder is open the background is made-up dots. Hovering one pauses the rotation and shows a made-up script
(`src/atlas/demo_data.ts`). Once a folder is open the background shows the real index, one point per embedding. A
segmented control at the top switches between **Description** (the description chunks, what a script is about),
**Structure** (the extracted structure features, what its queries look like) and **Properties** (what the user said about
it). The points sit at the `dashql_atlas_{x,y,z}` positions of the file (`loadIndexPoints` in `src/atlas/store.ts`,
drawn by `src/atlas/point_cloud.ts`).

The shape of the cloud depends on how many points there are (`src/atlas/point_cloud_shape.ts`): a handful of scripts
get big dots on a contracted cloud, a thousand get fine dots on the full one, and points are pulled toward the middle.
Hovering a dot, made up or indexed, holds the rotation, rings the dot, marks the other dots of its script and shows a
tooltip with the script and what the dot says (the description chunk, the tables of the structure or the properties).

The rows of the shown file are a panel on the left, built like the result overlay of the shell
(`src/atlas/index_rows.tsx`). Each file is loaded without its embedding, analyzed like a query result (`analyzeTable`:
table and column aggregates, a histogram or the most frequent values per column) and shown as a data table with plot
headers. Brushing a histogram or clicking a frequent value cross-filters the rows, and the dots of the rows that do not
match fade (`PointCloud.setSelection`), row i of a file is point i of its cloud. Every kind keeps its own filters.

The prompt sits at the bottom and the candidates of every search strategy are a card on the right. Hovering a candidate
pauses the rotation and marks all dots of its script in the shown cloud, the other candidates are marked less strongly.

## The embedding model

The model and the onnxruntime assets are not part of the Pages deployment: the model is 90 MB and the onnxruntime wasm
is 27 MB, Cloudflare Pages accepts 25 MiB per file. The Vite config drops the onnxruntime wasm that transformers.js would
otherwise emit (`dashql-strip-onnxruntime-wasm-asset` in `vite.config.tpl.ts`).

They are loaded from `atlas.modelBaseUrl` in `static/config.json` and default to `/static/models/`:

```
<base>/Snowflake/snowflake-arctic-embed-xs/config.json
<base>/Snowflake/snowflake-arctic-embed-xs/tokenizer.json
<base>/Snowflake/snowflake-arctic-embed-xs/tokenizer_config.json
<base>/Snowflake/snowflake-arctic-embed-xs/onnx/model.onnx           (fp32)
<base>/ort/ort-wasm-simd-threaded.asyncify.mjs
<base>/ort/ort-wasm-simd-threaded.asyncify.wasm
```

A base URL on another origin has to send CORS headers that allow the `Range` request header (transformers.js probes files
with `Range: bytes=0-0`) and `Cross-Origin-Resource-Policy: cross-origin`, because the page is cross-origin isolated.

The index files do not record the model. After changing the model or its settings, folders have to be reindexed.

### Local development

`packages/dashql-app/static/models/` is ignored by git. Fetch the files once and serve them from the dev server:

```bash
M=packages/dashql-app/static/models
HF=https://huggingface.co/Snowflake/snowflake-arctic-embed-xs/resolve/main
mkdir -p $M/Snowflake/snowflake-arctic-embed-xs/onnx $M/ort
for f in config.json tokenizer.json tokenizer_config.json onnx/model.onnx; do
    curl -L --fail -o $M/Snowflake/snowflake-arctic-embed-xs/$f $HF/$f
done
cp node_modules/.pnpm/onnxruntime-web@*/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.{mjs,wasm} $M/ort/
bazel run //packages/dashql-app:dev   # http://localhost:9002/atlas.html
```

## Internals

The page uses the same providers, navbar and internals overlay as the shell: every Hyper statement goes through
`executeTrackedQuery` and shows up in the Queries tab, and every stage of opening a folder is logged under the `atlas`
target. `ShellConnectionProvider` is shared and registers the database as `atlas`.

## Tests

`src/atlas/**/*.test.ts` run in `//packages/dashql-app:test_chromium`. `atlas_store.test.ts` writes an index into an OPFS
folder through Hyper and searches it, which covers the Arrow load, `COPY ... TO` into a mount and the vector SQL.
The browser test frame does not have the CSP of the real pages, so it cannot catch `eval` in dependencies: the Arrow
columns of the index are built from buffers because `arrow.vectorFromArray` compiles code with `new Function`.
