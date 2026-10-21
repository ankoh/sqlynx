# Test Data (`data.dashql.app`)

dashql needs real data to demo against. Historically the app had none: example schemas and
queries are static SQL, and demo mode *synthesizes* random Arrow batches at runtime
(`packages/dashql-app/src/utils/random_data.ts`). No CSV/Parquet is committed anywhere.

`data.dashql.app` hosts real test datasets (à la
[vega-datasets](https://github.com/vega/vega-datasets)) that notebooks can query over HTTP.
The immediate consumer is the umap renderer
(`SELECT * FROM '<dataset-url>' VISUALIZE USING umap (...)`),
which needs a query result with a `FLOAT[]` vector column — data that is impractical to
synthesize convincingly.

## Design constraints

- **Nothing raw committed, no standalone scripts.** Datasets are produced entirely by Bazel:
  sources are hash-pinned downloads, conversion runs in a genrule via a vendored DuckDB CLI,
  and the result is an assembled directory tree — a normal, cacheable build artifact.
- **The upload tool is a dumb mirror.** It takes a locally-built directory and mirrors it to
  the R2 bucket (skip-if-present for immutable files, always re-put `index.json`). It knows
  nothing about dataset definitions, DuckDB, or fetching.
- **Independent from the release tool.** The mirror lives in `packages/dashql-datasets`, *not* as a
  subcommand of `dashql-pack` (which owns get.dashql.app: git/semver/minisign/channels). They
  share only ~10 lines of S3-client setup, intentionally duplicated rather than coupled, so the
  release pipeline stays untouched and de-risked.
- **Immutable versioned paths** on R2, so old notebooks keep working and CDN caching is safe.

### Why it's hermetic

Bazel build actions are offline; network is allowed only in the fetch phase (repo rules like
`http_file`, which *require* a pinned `sha256`). This is exactly how the repo already pulls
duckdb/arrow/flatbuffers in `bazel/core_dependencies.bzl`, with hashes maintained by
`scripts/update_bazel_hashes.py` + Renovate. Each dataset source is an `http_file`; the genrule
reads the **local** fetched file (`read_json_auto('<path>')`), never over HTTPFS. Conversion is
deterministic and remote-cacheable — re-runs are free unless a source hash or the DuckDB version
changes. Everything is produced by the same DuckDB engine, so the output is exactly what
consumers see.

## Architecture

```
packages/dashql-datasets/datasets.bzl   (DATASETS: url+sha256 sources, outputs = {file, sql})
        │
        │  ── fetch phase (hash-pinned) ──►  @dataset_<name>_<as>//file   (http_file, via deps.bzl)
        ▼
packages/dashql-datasets/BUILD.bazel    (declare_datasets() expands each dataset)
   genrule       ─ DuckDB CLI (exec tool) runs each output's verbatim SQL ─►  <file>
   copy_to_directory ─ assemble  <name>/v<version>/<file>  ───────────────►
   index_json    ─ dashql-datasets index: walk tree → {url,bytes,sha256} ──►  index.json
        ▼
   :datasets     (one directory: all outputs + index.json)   ← the build artifact
        │
        ▼   bazel run //packages/dashql-datasets:sync   (mirror :datasets → R2)
   dashql-datasets sync (Rust): walk dir, per-file head_object on `dashql-data`,
     skip-if-present (immutable), else put_object; index.json always re-put, LAST.
        ▼
R2 bucket `dashql-data`  ──►  data.dashql.app
   /<dataset>/v<version>/<file>   (immutable, cache-forever)
   /index.json                    (mutable registry, short TTL)
```

Bazel owns fetch + convert + assemble + manifest (all hermetic, all cached). `dashql-datasets` owns
only indexing and the R2 mirror — no definitions parsing, no fetch, no coupling to the release
tool.

## Dataset declarations

`DATASETS` in `packages/dashql-datasets/datasets.bzl` is the single source of truth, consumed by both
the fetch phase (`deps.bzl`) and the build phase (`declare_datasets()`). Source hashes sit beside
`# renovate:` markers so Renovate can bump a tag and its hash together.

The schema is **format-agnostic**: each dataset declares `sources` (fetched inputs) and `outputs`
(files to produce). Each output is an explicit `{file, sql}` pair — the `sql` is a **verbatim**
DuckDB statement run through the CLI, so the author writes the whole thing (reader + `COPY … TO …
(FORMAT …)`) and picks the output format. There is no reader inference and no auto-assembled
SELECT/COPY.

```python
DATASETS = [
    {
        "name": "vega-cars",     # URL path segment + R2 key prefix
        "version": "1",          # bump on any breaking reshape (paths are immutable)
        "sources": [{
            "as": "cars",        # referenced from sql as {cars}
            # renovate: datasource=github-tags depName=vega/vega-datasets
            "url": "https://raw.githubusercontent.com/vega/vega-datasets/v2.9.0/data/cars.json",
            "sha256": "f686a536…",
        }],
        "outputs": [
            {"file": "cars.parquet",
             "sql": "COPY (SELECT * FROM read_json_auto('{cars}')) TO '{output}' (FORMAT PARQUET)"},
            {"file": "cars.csv",
             "sql": "COPY (SELECT * FROM read_json_auto('{cars}')) TO '{output}' (FORMAT CSV, HEADER)"},
        ],
    },
]
```

Only two placeholders are substituted into `sql`; everything else passes through untouched:

| Placeholder     | Expands to                                            |
| --------------- | ----------------------------------------------------- |
| `{output}`      | the output file's build path (the `COPY` target)      |
| `{<source as>}` | `$(location …)` of that fetched source (e.g. `{cars}`) |

The SQL is fed to the CLI via a quoted heredoc, so arbitrary author SQL — single **and** double
quotes — passes through verbatim. A literal `$` must be written `$$` (standard Bazel genrule
escaping). The output `.ext` is cosmetic: it becomes the R2 key and drives the upload
`Content-Type`, but does not drive conversion (DuckDB reads sources by content, not extension).

> **Embedding vectors** must be `FLOAT[]` (Float32), not `DOUBLE[]` — the renderer rejects
> Float64 (`embedding_extraction.ts`). `CAST(… AS FLOAT[])` in the output SQL if the source ships
> doubles.

### The vendored DuckDB CLI

Conversion needs a DuckDB binary as an **exec-config build tool**. `bazel/core_dependencies.bzl`
adds two `http_archive`s next to the existing prebuilt libs — `duckdb_cli_osx` and
`duckdb_cli_linux_amd64` — reusing `_DUCKDB_VERSION` and carrying `# renovate:` markers (and both
are registered in `scripts/update_bazel_hashes.py`). `//bazel:duckdb_cli` is an alias that selects
per `@platforms//os`. Parquet/CSV/JSON are core CLI features, so no extension install is needed —
conversion is fully offline.

## The `dashql-datasets` binary

A small Rust crate (`packages/dashql-datasets`, a member of the root Cargo workspace and the `crates`
crate_universe) with two subcommands, both operating on the assembled directory tree:

- **`index --dir <tree> --base-url <url> --out index.json`** — walks the tree and emits
  `{ dataset → version → files[{url,bytes,sha256}] }`. Run inside the hermetic build (a genrule),
  so it touches no network. It walks with `follow_links(true)` because `copy_to_directory`
  TreeArtifact contents are staged as symlinks inside the genrule sandbox.

  > This replaces the originally-planned `py_binary`: the repo declares `rules_python` but
  > registers no Python toolchain and has no `py_binary` anywhere, so generating the index from
  > the Rust binary we already build avoids new toolchain wiring.

- **`sync --dir <tree> [--dry-run]`** — mirrors the tree to R2. Reads three env vars
  (`DASHQL_DATA_R2_{ENDPOINT,ACCESS_KEY_ID,SECRET_ACCESS_KEY}`), builds the R2 client the same way
  `dashql-pack`'s `publish_command.rs` does, then walks the dir: the key is each file's path
  relative to `--dir`; immutable versioned files are skipped when `head_object` finds them, else
  `put_object` (single-shot — files are KB–MB, no multipart). `index.json` is always re-put and is
  uploaded **last**, so it only becomes visible after the files it references exist.

The `sync` run target has `data = [":datasets"]` and `args = ["sync", "--dir", "$(rootpath
:datasets)"]`, so `bazel run //packages/dashql-datasets:sync` builds the hermetic tree and then mirrors
it. It is `tags = ["manual"]`, excluded from wildcard builds (like `dashql-pack:publish`).

## Continuous deployment

`.github/workflows/publish_data.yml` runs on `workflow_dispatch` and on push to
`packages/dashql-datasets/**` — decoupled from the release pipeline, not on every main push. It checks
out, runs `.github/actions/setup-bazel`, and `bazel run --config=release
//packages/dashql-datasets:sync` with the three R2 secrets mapped to the `DASHQL_DATA_R2_*` env vars.
No Python/pip — Bazel provides the DuckDB CLI and the index generator.

## Adding a dataset

1. Add an entry to `DATASETS` in `datasets.bzl` (source `url` + `sha256`, one or more
   `{file, sql}` outputs).
2. Add the generated `http_file` repo to `use_repo(dashql_datasets, …)` in `MODULE.bazel`. The
   repo name is `dataset_<name>_<as>` with `-`/`.` replaced by `_`.
3. Pin the source hash (`shasum -a 256`, or `scripts/update_bazel_hashes.py`).
4. Bump `version` whenever you reshape an existing dataset — paths are immutable, so old notebooks
   keep working against the old version.
5. `bazel run //packages/dashql-datasets:sync` (or trigger the workflow).

See `packages/dashql-datasets/README.md` for the operational walkthrough.

## R2 / domain setup (one-time, out of repo)

1. R2 bucket **`dashql-data`**.
2. Custom domain **`data.dashql.app`** bound to it (Cloudflare R2 → Custom Domains).
3. R2 API token scoped to `dashql-data`; endpoint/key/secret provided as the three
   `DASHQL_DATA_R2_*` env vars locally and as GitHub secrets (`R2_DASHQL_DATA_*`) for CI.
4. (Optional) Cache rules: long TTL for `/*/v*/*`, short/no-cache for `/index.json`.

## Verification

1. **Vendored CLI**: `bazel run //bazel:duckdb_cli -- --version` resolves per platform.
2. **Hermetic build**: `bazel build //packages/dashql-datasets:datasets` → inspect
   `bazel-bin/packages/dashql-datasets/datasets/vega-cars/v1/cars.parquet` and `index.json`; rebuild →
   fully cached.
3. **Dry-run mirror**: `bazel run //packages/dashql-datasets:sync -- --dry-run` prints planned keys
   (index last) without uploading — no credentials needed.
4. **End-to-end**: set the three env vars, `bazel run //packages/dashql-datasets:sync`, then
   `curl https://data.dashql.app/index.json` and query the Parquet from Hyper over HTTP.
5. **Idempotency**: re-run `:sync`; every versioned file is skipped (HeadObject hit), only
   `index.json` re-uploads.
