# DashQL Atlas

`atlas.html` (`/atlas` on dashql.app) searches a folder of `.sql` files by what their comments and their SQL are about.
Everything runs in the browser: dashql-core analyzes the scripts, transformers.js embeds them with
`Snowflake/snowflake-arctic-embed-xs`, UMAP places them in 3D, and hyperdb-wasm writes, mounts and queries the Parquet
index files. It needs the File System Access API (Chromium) and a cross-origin-isolated page, like the shell.

## Files in the selected folder

| File | Content |
|------|---------|
| `dashql-atlas-comments.parquet` | One row per comment chunk: embedding, `atlas_description_3d_{x,y,z}` |
| `dashql-atlas-features.parquet` | One row per script: embedding, `atlas_features_3d_{x,y,z}`, extracted features |
| `dashql-atlas-index.json` | Sidecar: embedder settings and the hash of every indexed script |

Features and comment chunks have independent UMAP layouts: embedded together, UMAP clusters the comments with the
comments and the features with the features, which says nothing about the scripts.

Hyper writes Parquet without key-value metadata, which is why the sidecar exists. An index is reused when the sidecar
has the same format version and embedder settings and lists exactly the scripts of the folder with the same SHA-256
hashes, and when Hyper can read both Parquet files. Anything else is re-indexed from scratch.

Search is plain SQL over the mounted files, see `src/atlas/search/search.ts`:
`dot_product(embedding, ARRAY[...]::real[])`. The cast is required.

## The page

Before a folder is open the background is made-up dots. Hovering one pauses the rotation and shows a made-up script
(`src/atlas/demo_data.ts`). Once a folder is open the background shows the real index, one point per embedding. A
segmented control at the top switches between **Description** (the comment chunks, what a script is about) and
**Features** (the extracted query features, what its queries look like). The points sit at their `atlas_description_3d_{x,y,z}` or
`atlas_features_3d_{x,y,z}` positions (`loadIndexPoints` in `src/atlas/store.ts`, drawn by `src/atlas/point_cloud.ts`).

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

The index records the model and dtype in the sidecar. Changing either re-indexes folders on their next visit.

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
