# DashQL Atlas

`atlas.html` (`/atlas` on dashql.app) searches a folder of `.sql` files by their descriptions and filters them by their
SQL and their user-provided metadata.
Everything runs in the browser: dashql-core analyzes the scripts, transformers.js embeds them with
`Snowflake/snowflake-arctic-embed-xs`, UMAP places them in 3D, and hyperdb-wasm writes, mounts and queries the Parquet
index files. It needs the File System Access API (Chromium) and a cross-origin-isolated page, like the shell.

## The index file

Atlas writes one Parquet file into the selected folder, `dashql-atlas.parquet`, with one row per chunk of the
`@dashql:description` block of a script. Only the descriptions are embedded and laid out in 3D. The structure and the
metadata of a script are columns of its rows, to filter by, they are neither embedded nor laid out. A script without a
description has no row: run `dashql-describe` first.

The columns are prefixed by where they come from and ordered by prefix:

| Columns | Type | Content |
|---------|------|---------|
| `script_name`, `script_hash` | text | The path of the script in the folder and the SHA-256 of its text |
| `description_chunk_index`, `description_chunk` | int, text | The chunk of the `@dashql:description` block |
| `description_embedding` | real[] | The embedding of the chunk |
| `description_embedding_model` | text | The model that computed the embedding, the same in every row |
| `description_x`, `description_y`, `description_z` | real | The position of the chunk in the cloud |
| `metadata_<key>` | double, bool or text | One column per key of the `@dashql:metadata` blocks |
| `structure_*_count` next to its list | int, text[] | The analysis of the SQL, see below |

The structure columns, each count next to its list:

| Count | List |
|-------|------|
| `structure_statement_count` | `structure_statement_types` |
| `structure_table_count` | `structure_table_names` |
| `structure_column_count` | `structure_column_names` |
| `structure_function_count` | `structure_function_names` |
| `structure_aggregate_count` | `structure_aggregate_names` |
| `structure_function_call_count` | `structure_function_call_expressions` |
| `structure_cte_count` | `structure_cte_names` |
| | `structure_join_conditions` |
| `structure_filter_count` | `structure_filter_predicates` |
| | `structure_operator_names` |
| `structure_visualization_count` | `structure_visualization_summaries` |
| `structure_diagnostic_count` | `structure_diagnostic_messages` |

The file is written in the shape that the page shows, nothing is derived when it is loaded. The lists cannot be binned,
so `structure_table_count`, `structure_function_call_count` and so on are stored next to them. Joins and operators are
not counted: the number of joins is up to the optimizer (a cross join with a predicate is a join as well), and the
operators are SQL clauses, not the operators of a plan. The counts are null and the lists empty for a script that could
not be analyzed. A metadata column is a double if all its values are numbers, a bool if all are booleans, text
otherwise (objects and arrays as JSON), null for scripts without the key. Only the vector columns are stored as `real`.

The structure and the metadata are repeated on every chunk of a script, so a histogram counts chunks, not scripts.
Most descriptions are a single chunk.

Ordinary comments are not embedded, only `@dashql:description` blocks (written by `dashql-describe` or by hand).

There is no sidecar. A folder without an index file is indexed when it is opened. Otherwise the index file is loaded,
and if that fails, e.g. because an older version wrote it (no `structure_table_count`) or another model embedded it
(the `description_embedding_model` of its first row is not the model of the atlas), the page asks to reindex the
folder. Every row carries the `script_name` and the SHA-256 `script_hash` of the script text, the prompt bar shows how
many described scripts were added, changed or removed since the index was written. Reindexing replaces the file and
removes those of earlier versions (`dashql-atlas-structure.parquet`, `dashql-atlas-description.parquet`,
`dashql-atlas-properties.parquet`, `dashql-atlas-comments.parquet`, `dashql-atlas-features.parquet`,
`dashql-atlas-index.json`).

Search is plain SQL over the mounted file, see `src/atlas/search/search.ts`:
`dot_product(description_embedding, ARRAY[...]::real[])`. The cast is required. Every script is ranked by its best
description chunk.

## Metadata

A script can carry user-provided metadata as a pretty-printed JSON object in a `@dashql:metadata` block:

```sql
-- @dashql:metadata
-- {
--   "owner": "finance",
--   "dashboard": "Revenue Weekly",
--   "avg_runtime_ms": 1834
-- }
-- @dashql:end
```

dashql-core recognizes the tag and validates that the content is a JSON object (`ParsedScript.metadata_block`,
`MALFORMED_COMMENT_TAG` warnings otherwise). `readMetadata` and `renderMetadataBlock` in `@ankoh/dashql-core` read and
write the block, clients never parse it themselves. Atlas stores every key as a `metadata_<key>` column of the index
file.
`dashql-describe` never touches the block, never sends it to the model and inserts new descriptions below it.

The query result viewer writes such folders: the download button of a result offers **SQL Column as Atlas** next to
**Result as Arrow**. It writes one `.sql` file per row of the chosen SQL text column with the other columns as
metadata, named after the row number (`row_00001.sql`, ...)
(`src/app/notebook/compute/ui/query_result/atlas_export.ts`).

## The page

Before a folder is open the background is made-up dots. Hovering one pauses the rotation and shows a made-up script
(`src/atlas/demo_data.ts`). Once a folder is open the background shows the real index, one point per description
chunk, at the `description_{x,y,z}` positions of the file (`indexPoints` in `src/atlas/store.ts`, drawn by
`src/atlas/point_cloud.ts`).

The shape of the cloud depends on how many points there are (`src/atlas/point_cloud_shape.ts`): a handful of scripts
get big dots on a contracted cloud, a thousand get fine dots on the full one, and points are pulled toward the middle.
Hovering a dot, made up or indexed, holds the rotation, rings the dot, marks the other dots of its script and shows a
tooltip with the script, the description chunk and the tables of the script.

The rows of the index file are a panel on the left, built like the result overlay of the shell
(`src/atlas/index_rows.tsx`). The file is loaded without its embedding, analyzed like a query result (`analyzeTable`:
table and column aggregates, a histogram or the most frequent values per column) and shown as a data table with plot
headers. Brushing a histogram or clicking a frequent value cross-filters the rows, e.g. by a metadata key or by
`structure_table_count`, and the dots of the rows that do not match fade (`PointCloud.setSelection`), row i of the file
is point i of the cloud.

The prompt sits at the bottom and the candidates of every search strategy are a card on the right. Hovering a candidate
pauses the rotation and marks all dots of its script, the other candidates are marked less strongly.

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

The index file records the model in `description_embedding_model`, a file of another model is reported as unreadable
and has to be reindexed. The other settings (dtype, pooling, prefixes) are not recorded, after changing them folders have
to be reindexed by hand.

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

## AI models

The internals overlay of the atlas has an **AI** tab with three sections. **Bundled Model** shows the embedding model
above, which ships with the app. **External Model** configures one model behind an OpenAI-compatible endpoint (Ollama,
OpenAI, vLLM, ...) with its URL, model id and extra headers. **Tasks** chooses per task which of the two runs it:
**embed** wants a fast model (bundled by default), **describe** writes `dashql-describe` style descriptions and wants a
smart one (external by default). `useAIClientForTask(task)` (`src/app/config/ai_models_provider.tsx`)
returns the client of the model a task runs on: `complete(messages)` for describe, `embedDocuments(texts)` and
`embedQuery(text)` for embed, null if the model cannot run the task. The bundled model only embeds, describing with it
has no client until a bundled text model ships. It is loaded when it embeds the first time.

The settings are stored in the app manifest (`dashql-manifest.json` in OPFS) as a top-level `aiModels` field
(`{ config: { external }, tasks: { describe, embed } }`), headers (API keys) included. They are not part of `appSettings`, the app rewrites
`appSettings` from memory and would drop changes made by the atlas. Nothing uses these clients yet: indexing and search
still load their own bundled embedder.

## Tests

`src/atlas/**/*.test.ts` run in `//packages/dashql-app:test_chromium`. `atlas_store.test.ts` writes an index into an OPFS
folder through Hyper and searches it, which covers the Arrow load, `COPY ... TO` into a mount and the vector SQL.
The browser test frame does not have the CSP of the real pages, so it cannot catch `eval` in dependencies: the Arrow
columns of the index are built from buffers because `arrow.vectorFromArray` compiles code with `new Function`.
