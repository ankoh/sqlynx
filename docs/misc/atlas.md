# DashQL Atlas

`atlas.html` (`/atlas` on dashql.app) searches a folder of `.sql` files by their descriptions and filters them by their
SQL and their user-provided metadata.
Everything runs in the browser: dashql-core analyzes the scripts, transformers.js embeds them with
`Snowflake/snowflake-arctic-embed-xs`, UMAP places them in 3D, and hyperdb-wasm writes, mounts and queries the Parquet
index files. It needs the File System Access API (Chromium) and a cross-origin-isolated page, like the shell.

## The index file

Atlas writes one Parquet file into the selected folder, `dashql-atlas.parquet`, with one row per script, the
embedding of its `@dashql:description` block. Only the descriptions are embedded and laid out in 3D. The structure and the
metadata of a script are columns of its rows, to filter by, they are neither embedded nor laid out. A script without a
description has no row: describe it first, in the page or with `dashql-cli describe`.

The columns are prefixed by where they come from and ordered by prefix:

| Columns | Type | Content |
|---------|------|---------|
| `script_name`, `script_hash` | text | The path of the script in the folder and the SHA-256 of its text |
| `description` | text | The `@dashql:description` block |
| `description_embedding` | real[] | The embedding of the description |
| `description_embedding_model` | text | The model that computed the embedding, the same in every row |
| `description_x`, `description_y`, `description_z` | real | The position of the script in the cloud |
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
| `structure_filter_count` | `structure_filter_predicates` |
| `structure_visualization_count` | `structure_visualization_summaries` |
| `structure_diagnostic_count` | `structure_diagnostic_messages` |

The file is written in the shape that the page shows, nothing is derived when it is loaded. The lists cannot be binned,
so `structure_table_count`, `structure_function_call_count` and so on are stored next to them. The table names are all
referenced tables as written, base tables and CTEs alike, plus the tables the script creates. Equalities between columns
of two tables are join conditions and are left out of the filter predicates. The counts are null and the lists empty for
a script that could not be analyzed. A metadata column is a double if all its values are numbers, a bool if all are booleans, text
otherwise (objects and arrays as JSON), null for scripts without the key. Only the vector columns are stored as `real`.

The model reads 512 tokens, the embedding pipeline truncates longer descriptions. `dashql-cli describe` is told to stay
well below that.

Ordinary comments are not embedded, only `@dashql:description` blocks (written by the page, by `dashql-cli describe` or by
hand).

There is no sidecar. Opening a folder computes nothing: a folder without an index file waits until it is indexed or
described. Otherwise the index file is loaded, and if that fails, e.g. because an older version wrote it (no
`structure_table_count`) or another model embedded it (the `description_embedding_model` of its first row is not the
model of the atlas), the Index card says so and indexing replaces it. Every row carries the `script_name` and the
SHA-256 `script_hash` of the script text, the Index card shows how many described scripts were added, changed or
removed since the index was written. Indexing replaces the file and
removes those of earlier versions (`dashql-atlas-structure.parquet`, `dashql-atlas-description.parquet`,
`dashql-atlas-properties.parquet`, `dashql-atlas-comments.parquet`, `dashql-atlas-features.parquet`,
`dashql-atlas-index.json`).

Search is plain SQL over the mounted file, see `src/atlas/search/search.ts`:
`dot_product(description_embedding, ARRAY[...]::real[])`. The cast is required. Scripts are ranked by the
similarity of their description.

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
`dashql-cli describe` never touches the block, never sends it to the model and inserts new descriptions below it.

The query result viewer writes such folders: the download button of a result offers **SQL Column as Atlas** next to
**Result as Arrow**. It writes one `.sql` file per row of the chosen SQL text column with the other columns as
metadata, named after the row number (`row_00001.sql`, ...)
(`src/app/notebook/compute/ui/query_result/atlas_export.ts`).

## The page

The steps are brief cards on the left (`src/atlas/atlas_steps.tsx`), the search is on the right:

- **Folder** selects a folder (read-write) and shows how many of its scripts are described.
- **Index** embeds the described scripts and writes the index file, or says why the existing one cannot be loaded or
  that it is outdated.
- **Describe** sends every script without a description to the model of the **describe** task (see
  [AI models](#ai-models)) and writes the `@dashql:description` blocks into the files, then indexes the folder again.
- **Search** is the prompt of the semantic search, enabled once the folder has an index, and the best matches below it.

Only one step runs at a time and its card shows the progress. Describing can be cancelled, the files that were written
stay described.

Before a folder is indexed the background is made-up dots. Hovering one pauses the rotation and shows a made-up script
(`src/atlas/demo_data.ts`). Once a folder is indexed the background shows the real index, one point per script,
at the `description_{x,y,z}` positions of the file (`indexPoints` in `src/atlas/store.ts`, drawn by
`src/atlas/point_cloud.ts`).

The shape of the cloud depends on how many points there are (`src/atlas/point_cloud_shape.ts`): a handful of scripts
get big dots on a contracted cloud, a thousand get fine dots on the full one, and points are pulled toward the middle.
Hovering a dot, made up or indexed, holds the rotation, rings the dot, marks its script and shows a
tooltip with the script, the description and the tables of the script.

The rows of the index file are a panel on the left, built like the result overlay of the shell
(`src/atlas/index_rows.tsx`). The file is loaded without its embedding, analyzed like a query result (`analyzeTable`:
table and column aggregates, a histogram or the most frequent values per column) and shown as a data table with plot
headers. Brushing a histogram or clicking a frequent value cross-filters the rows, e.g. by a metadata key or by
`structure_table_count`, and the dots of the rows that do not match fade (`PointCloud.setSelection`), row i of the file
is point i of the cloud.

The candidates of every search strategy are a card below the prompt on the right. Hovering a candidate pauses the
rotation and marks its dot, the other candidates are marked less strongly.

## Describing in the page

`src/atlas/describe/` describes like `dashql-cli describe` and shares its prompt and its header logic:
`describe/prompt.ts` and `describe/header.ts` are copies of the files of the same name in
`packages/dashql-cli/src/describe/`, keep them in sync. The model gets the system prompt and the statements of the
script, and is asked for the JSON schema of a description through the OpenAI `response_format`. The answer is parsed
leniently (code fences and prose around the object are dropped) for endpoints that ignore the format. Twelve scripts
are described at a time, a request mostly waits for the model. Every script is written into its file as soon as it is
described, so a run can be stopped at any point: the cards count the new descriptions right away, and a stopped run is
not reindexed, the Index card offers it. A script that changed while it was described is skipped, and a run stops
after three failures in a row, which usually means that the endpoint is not reachable or rejects the key.

Both steps log every script. A run is a span below the trace of the session and, for describing, every script is a
span below the run:

- `atlas_describe`: the scripts that are left out and why, then per script the time in total and with the model, the
  token counts, the finish reason and the summary, or the reason and the start of the response if it was skipped.
  Many completion tokens for a short description mean that the model reasons before it answers.
- `atlas_index`: per script whether it gets a row, its statements, tables, metadata keys and diagnostics, then the
  time of every stage (analyze, embed, layout, write). Opening a folder logs every script that was added, changed or
  removed since the index was written.

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

`bazel run //packages/dashql-app:dev` needs no setup. Bazel downloads the pinned, hash-checked model files (`MODULE.bazel`),
takes the ONNX runtime from the installed `onnxruntime-web` and stages both in `//packages/dashql-app:dep_atlas_models`.
The dev server (`dashql-serve-atlas-models` in `vite.config.tpl.ts`) serves them at `/static/models/` with Range support.
Deployments do not bundle them, they come from `atlas.modelBaseUrl`.

## Internals

The page uses the same providers, navbar and internals overlay as the shell: every Hyper statement goes through
`executeTrackedQuery` and shows up in the Queries tab, and every stage of opening a folder is logged under the `atlas`
target. `ShellConnectionProvider` is shared and registers the database as `atlas`.

## AI models

The internals overlay of the atlas has an **AI** tab with three sections. **Bundled Model** shows the embedding model
above, which ships with the app. **External Model** configures one model behind an OpenAI-compatible endpoint (Ollama,
OpenAI, vLLM, ...) with its URL, model id and extra headers. **Tasks** chooses per task which of the two runs it:
**embed** wants a fast model (bundled by default), **describe** writes `dashql-cli describe` style descriptions and wants a
smart one (external by default). `useAIClientForTask(task)` (`src/app/config/ai_models_provider.tsx`)
returns the client of the model a task runs on: `complete(messages, signal, { jsonSchema })` for describe,
`embedDocuments(texts)` and `embedQuery(text)` for embed, null if the model cannot run the task. The bundled model only
embeds, describing with it has no client until a bundled text model ships, and the Describe card asks to choose an
external model. It is loaded when it embeds the first time.

The settings are stored in the app manifest (`dashql-manifest.json` in OPFS) as a top-level `aiModels` field
(`{ config: { external }, tasks: { describe, embed } }`), headers (API keys) included. They are not part of `appSettings`, the app rewrites
`appSettings` from memory and would drop changes made by the atlas. The Describe card uses the describe client, indexing
and search still load their own bundled embedder.

## Tests

`src/atlas/**/*.test.ts` run in `//packages/dashql-app:test_chromium`. `atlas_store.test.ts` writes an index into an OPFS
folder through Hyper and searches it, which covers the Arrow load, `COPY ... TO` into a mount and the vector SQL.
The browser test frame does not have the CSP of the real pages, so it cannot catch `eval` in dependencies: the Arrow
columns of the index are built from buffers because `arrow.vectorFromArray` compiles code with `new Function`.
