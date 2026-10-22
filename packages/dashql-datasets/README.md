# dashql-datasets — hosted test datasets for `data.dashql.app`

Real test datasets (à la [vega-datasets](https://github.com/vega/vega-datasets)) that
demo sessions can query over HTTP — e.g. from a local Hyper connector reading remote
Parquet. This package **builds** the datasets hermetically with Bazel and **mirrors**
them to the R2 bucket `dashql-data` (served at `https://data.dashql.app`).

## URL scheme

```
https://data.dashql.app/<dataset>/v<version>/<table>.parquet   # immutable, cache-forever
https://data.dashql.app/index.json                             # mutable registry, short TTL
```

`index.json` is `{ dataset -> version -> [ {url, bytes, sha256} ] }`.

## How it works

Everything up to the upload is a normal, cacheable Bazel build — **offline**, since
network access is only allowed in the fetch phase (repo rules requiring a pinned
`sha256`):

1. **Fetch** (`deps.bzl` module extension): each source in `DATASETS` becomes a
   hash-pinned `http_file`. (`tpch` datasets have no sources — see below.)
2. **Convert** (`datasets.bzl` → genrule): the vendored DuckDB CLI (`//bazel:duckdb_cli`)
   runs each output's **verbatim SQL** — the author writes the full statement (reader +
   `COPY … TO … (FORMAT …)`); the format is whatever the SQL says (Parquet, CSV, …).
   `tpch` datasets instead `LOAD` the vendored tpch extension and `CALL dbgen`.
3. **Assemble** (`copy_to_directory`): stage into `<dataset>/v<version>/<file>`.
4. **Index** (`dashql-datasets index`): walk the tree → `index.json`.
5. **Mirror** (`dashql-datasets sync`): upload to R2 — versioned files are immutable
   (skip-if-present via HeadObject), `index.json` is always re-put (and uploaded last).

## Add a dataset

1. Add an entry to `DATASETS` in [`datasets.bzl`](./datasets.bzl):
   ```python
   {
       "name": "my-dataset",
       "version": "1",
       "sources": [{
           "as": "raw",                     # referenced from sql as {raw}
           "url": "https://example.com/data.json",
           "sha256": "…",                   # pin the hash (see below); Renovate can bump it
       }],
       "outputs": [{
           "file": "points.parquet",        # -> my-dataset/v1/points.parquet
           "sql": "COPY (SELECT id, CAST(embedding AS FLOAT[]) AS embedding "
                  "FROM read_json_auto('{raw}')) TO '{output}' (FORMAT PARQUET)",
       }],
   }
   ```
   Each output's `sql` runs verbatim through the DuckDB CLI. Two placeholders are
   substituted: `{output}` (the COPY target) and `{<source as>}` (a fetched source's
   local path, e.g. `{raw}`). You choose the reader and the output format — e.g.
   `(FORMAT CSV, HEADER)` to emit CSV, `read_csv_auto('{raw}')` / `read_parquet('{raw}')`
   to read other source formats. A dataset may declare several outputs (parquet + csv,
   multiple tables, …). To write a literal `$`, use `$$` (Bazel genrule escaping).

   > Vector columns for the embedding atlas must be `FLOAT[]` (Float32), not `DOUBLE[]`
   > — `CAST(… AS FLOAT[])` in the SQL if the source ships doubles.

2. Add the generated `http_file` repo to `use_repo(dashql_datasets, …)` in
   `MODULE.bazel`. The repo name is `dataset_<name>_<as>` with `-`/`.` replaced by `_`
   (e.g. `my-dataset` + `raw` → `dataset_my_dataset_raw`).

3. **Pin the hash**: download the URL and `shasum -a 256 <file>`, or after adding the
   entry with a placeholder run `python3 scripts/update_bazel_hashes.py` (the DuckDB CLI
   archives are handled there; dataset sources are pinned by hand or via Renovate).

4. Bump `version` whenever you reshape an existing dataset — paths are immutable, so old
   sessions keep working against the old version.

## TPC-H

TPC-H is hosted as one dataset per scale factor (`tpch-0.001`, `tpch-0.01`, `tpch-0.1`,
`tpch-1`), each with all 8 tables:

```
https://data.dashql.app/tpch-<sf>/v1/{customer,lineitem,nation,orders,part,partsupp,region,supplier}.parquet
```

Unlike the classic dbgen pipeline (a `tpch-dbgen` submodule plus a bespoke
`.tbl`→Parquet converter), generation reuses the DuckDB CLI we already vendor: a `tpch`
dataset entry just declares a `scale_factor`, and the convert genrule `CALL dbgen(sf=…)`
+ `COPY … TO … (FORMAT PARQUET)` writes each table directly.

To keep this **hermetic**, the signed `tpch.duckdb_extension` is vendored — DuckDB's
`tpch` extension is not statically linked, so `CALL dbgen` would otherwise need
`INSTALL tpch` (network, forbidden in the sandbox). It is fetched as a hash-pinned
`http_file` per exec platform (`TPCH_EXTENSION_SHA256` in `datasets.bzl`, selected by
the `//packages/dashql-datasets:tpch_extension` alias), gunzipped in the genrule, and
`LOAD`ed by absolute path with autoinstall/autoload disabled.

- **Add a scale factor**: append `{"name": "tpch-<sf>", "version": "1", "kind": "tpch",
  "scale_factor": "<sf>"}` to `DATASETS`. No sources, no `MODULE.bazel` change (the
  extension repos are already registered).
- **Version coupling**: `TPCH_DUCKDB_VERSION` **must** equal `_DUCKDB_VERSION` in
  `bazel/core_dependencies.bzl` — an extension only loads into the exact CLI build it
  was compiled against. Renovate bumps both together and reruns
  `scripts/update_bazel_hashes.py packages/dashql-datasets/datasets.bzl` to refresh the four
  extension hashes.

## Build & publish

```bash
# Hermetic build (fetch + convert + assemble + index); re-runs are cached.
bazel build //packages/dashql-datasets:datasets

# Inspect
duckdb -c "SELECT * FROM 'bazel-bin/packages/dashql-datasets/datasets/vega-cars/v1/cars.parquet' LIMIT 5"

# Dry run — print planned uploads, touch nothing (no credentials needed)
bazel run //packages/dashql-datasets:sync -- --dry-run

# Live mirror to R2 (needs the three env vars below)
export DASHQL_DATA_R2_ENDPOINT=…
export DASHQL_DATA_R2_ACCESS_KEY_ID=…
export DASHQL_DATA_R2_SECRET_ACCESS_KEY=…
bazel run //packages/dashql-datasets:sync
```

CI does the same on `workflow_dispatch` (and on push to `packages/dashql-datasets/**`) via
`.github/workflows/publish_data.yml`, reading the credentials from GitHub secrets.
