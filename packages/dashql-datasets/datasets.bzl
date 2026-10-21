"""Dataset declarations and the build macro for data.dashql.app.

`DATASETS` is the single source of truth for what gets hosted. It is consumed in
two places:

  * the fetch phase (`deps.bzl` module extension) turns every source into a
    hash-pinned `http_file` — `http_file` *requires* `sha256`, so the pin is
    load-bearing, exactly like `bazel/core_dependencies.bzl`;
  * the build phase (`declare_datasets()`, called from `BUILD.bazel`) executes each
    output with its declared engine, assembles the versioned tree, and computes
    `index.json`.

Adding a dataset = one entry here + `bazel run //packages/dashql-datasets:sync`. See
`README.md`. Source hashes sit beside `# renovate:` markers so Renovate can bump a
tag and its hash together.

Dataset schema:
    {
        "name":    "vega-cars",       # URL path segment; also the R2 key prefix
        "version": "1",               # bumped on any breaking reshape (immutable paths)
        "sources": [{
            "as":     "cars",         # placeholder name referenced from `sql` as {cars}
            "url":    "https://…",
            "sha256": "…",            # hash-pinned
        }],
        "outputs": [{
            "file": "cars.parquet",   # exact output file -> <name>/v<version>/cars.parquet
            "engine": "duckdb",
            "sql":  "COPY (...) TO '{output}' (FORMAT PARQUET)",
        }],
    }

Each output is produced by running its `sql` verbatim through the DuckDB CLI. The
only substitutions are two placeholders:

  * `{output}`        -> the output file's path (the COPY target),
  * `{<source as>}`   -> the local path of that fetched source (e.g. `{cars}`).

So the author writes the full statement — no reader is inferred, no SELECT/COPY is
assembled. The output format is whatever the SQL says: `(FORMAT PARQUET)`,
`(FORMAT CSV, HEADER)`, etc. The `.file` extension is cosmetic (it's just the R2
key); it does not drive conversion.
"""

load("@aspect_bazel_lib//lib:copy_to_directory.bzl", "copy_to_directory")

# Two dataset kinds, distinguished by the optional "kind" field (default "sql"):
#
#   * "sql"  — fetch each source (http_file), run each output's verbatim SQL through
#     the DuckDB CLI. This is the general case documented above.
#   * "tpch" — no sources; generate all 8 TPC-H tables at `scale_factor` with DuckDB's
#     tpch extension (`CALL dbgen`) and write each to Parquet. The extension is
#     vendored (see TPCH_* below) and LOADed offline, so generation stays hermetic —
#     no `INSTALL` (network), no dbgen submodule, no bespoke Arrow/Parquet transcoder.
DATASETS = [
    {
        "name": "vega-cars",
        "version": "1",
        "sources": [{
            "as": "cars",
            # renovate: datasource=github-tags depName=vega/vega-datasets
            "url": "https://raw.githubusercontent.com/vega/vega-datasets/v2.9.0/data/cars.json",
            "sha256": "f686a53678b21f4231e2f6a5ba7ce5761d9d39204fccdea1caa29fb8c460e319",
        }],
        "outputs": [{
            "file": "cars.parquet",
            "engine": "duckdb",
            "sql": "COPY (SELECT * FROM read_json_auto('{cars}')) TO '{output}' (FORMAT PARQUET)",
        }, {
            "file": "cars.csv",
            "engine": "duckdb",
            "sql": "COPY (SELECT * FROM read_json_auto('{cars}')) TO '{output}' (FORMAT CSV, HEADER)",
        }],
    },
    {
        "name": "vega-stocks",
        "version": "1",
        "sources": [{
            "as": "stocks",
            # renovate: datasource=npm depName=vega-datasets
            "url": "https://cdn.jsdelivr.net/npm/vega-datasets@3.2.1/data/stocks.csv",
            "sha256": "f9953ac6693e587476b4ebf2f0b00d9bb95371ca8c39da4cc6155077b3e417cd",
        }],
        "outputs": [{
            "folder": "iceberg",
            "engine": "hyper",
            "sql": """COPY (
                SELECT symbol, "date"::date AS date, price
                FROM external('{stocks}', format => 'csv', header => true,
                    columns => descriptor(symbol text, "date" text, price double precision))
            ) TO '{output}' WITH (format => 'iceberg')""",
        }],
    },
    # TPC-H at several scale factors (each an independent, immutably-versioned dataset,
    # e.g. tpch-0.01/v1/lineitem.parquet). Rows scale ~linearly with the SF: SF 1 is
    # the full ~1 GB standard scale (lineitem ~6M rows); SF 0.001 is a ~1 MB smoke-test
    # set (lineitem ~6k rows).
    {"name": "tpch-0.001", "version": "1", "kind": "tpch", "scale_factor": "0.001"},
    {"name": "tpch-0.01", "version": "1", "kind": "tpch", "scale_factor": "0.01"},
    {"name": "tpch-0.1", "version": "1", "kind": "tpch", "scale_factor": "0.1"},
    {"name": "tpch-1", "version": "1", "kind": "tpch", "scale_factor": "1"},
]

# --- TPC-H generation via the vendored DuckDB tpch extension ----------------------
#
# DuckDB's tpch extension is NOT statically linked into the release CLI: `CALL dbgen`
# normally requires `INSTALL tpch` (network), which the genrule sandbox forbids. So we
# vendor the *signed* extension as gzipped, hash-pinned http_files (one per exec
# platform, deps.bzl), gunzip it in the convert genrule, and LOAD it by absolute path
# — fully offline. This replaces both moving parts of the classic pipeline (the
# tpch-dbgen submodule and a hand-written .tbl->Parquet converter) with the CLI we
# already vendor for the other datasets.

# The DuckDB version whose tpch extension we vendor. MUST equal _DUCKDB_VERSION in
# bazel/core_dependencies.bzl: an extension only loads into the exact CLI build it was
# compiled against. Bump both (and the four hashes below) together; the hashes are
# refreshed by scripts/update_bazel_hashes.py.
# renovate: datasource=github-releases depName=duckdb/duckdb
TPCH_DUCKDB_VERSION = "1.5.6"

# sha256 of tpch.duckdb_extension.gz per platform, keyed by DuckDB's own `PRAGMA
# platform` name (osx_amd64 == x86_64 macOS, linux_amd64 == x86_64 Linux, …).
TPCH_EXTENSION_SHA256 = {
    "osx_arm64": "1b37b59168a14e1e147702f315ec9ef7cfa029ee5d4ca9342f01635132665733",
    "osx_amd64": "bd4aed693742dc63e8f1ad23029ec4cb25161e4ee8a8b8d68958fdf85b9c1d13",
    "linux_amd64": "51959cc795f6ea8c95cf8cc6cc4065358998ce959bf863e21ff1aa471c06bc41",
    "linux_arm64": "2eb6c90160fed1d207d866650c4a67fd7144f7f781df8735f1231df8571fd952",
}

# The 8 TPC-H tables dbgen populates. Each becomes <dataset>/v<version>/<table>.parquet.
TPCH_TABLES = ["customer", "lineitem", "nation", "orders", "part", "partsupp", "region", "supplier"]

def tpch_extension_url(platform):
    """CDN URL for one platform's gzipped tpch extension (fetch phase, deps.bzl)."""
    return "https://extensions.duckdb.org/v{v}/{p}/tpch.duckdb_extension.gz".format(
        v = TPCH_DUCKDB_VERSION,
        p = platform,
    )

def tpch_extension_repo_name(platform):
    """The `http_file` repo name for one platform's tpch extension. Shared between
    deps.bzl (declares the repo) and BUILD.bazel (selects one via alias)."""
    return "tpch_extension_{}".format(platform)

# Public base URL the hosted files are served from (used to root index.json URLs).
DATA_BASE_URL = "https://data.dashql.app"

def _sanitize(name):
    """Turn a dataset name into a bzlmod-safe repo-name fragment."""
    return name.replace("-", "_").replace(".", "_")

def dataset_repo_name(dataset_name, src_as):
    """The `http_file` repo name for one source. Shared with deps.bzl so the fetch
    phase and the build phase agree on a single name."""
    return "dataset_{}_{}".format(_sanitize(dataset_name), src_as)

def _source_label(dataset_name, src_as):
    return "@{}//file".format(dataset_repo_name(dataset_name, src_as))

# The vendored tpch extension, selected per exec platform by the alias in BUILD.bazel.
_TPCH_EXTENSION = "//packages/dashql-datasets:tpch_extension"

def _resolve_sql(dataset, output):
    """Substitute the two placeholders in an output's verbatim SQL:

      * `{output}`      -> the output file's build path ($(RULEDIR)/…),
      * `{<source as>}` -> $(location …) of that fetched source.

    Everything else is passed through untouched (Bazel then expands the make-vars).
    Only these exact tokens are replaced, so DuckDB struct/list literals like
    `{'k': 1}` are safe. A literal `$` in SQL must be written `$$` (standard Bazel
    genrule escaping)."""
    sql = output["sql"]
    output_name = output.get("file", output.get("folder"))
    out_path = "$(RULEDIR)/{}/v{}/{}".format(dataset["name"], dataset["version"], output_name)
    sql = sql.replace("{output}", out_path)
    for src in dataset["sources"]:
        placeholder = "{" + src["as"] + "}"
        sql = sql.replace(placeholder, "$(location {})".format(_source_label(dataset["name"], src["as"])))
    return sql

def _hyper_folder_output_impl(ctx):
    output = ctx.actions.declare_directory(ctx.attr.out)
    arguments = [
        ctx.executable._hyper_sql.path,
        ctx.file._hyperd.path,
        output.path,
        ctx.attr.sql,
        ctx.executable._folder_index.path,
        "true",
    ]
    for source_name, source in zip(ctx.attr.source_names, ctx.files.srcs):
        arguments += [source_name, source.path]

    ctx.actions.run_shell(
        inputs = ctx.files.srcs,
        outputs = [output],
        tools = [ctx.executable._hyper_sql, ctx.file._hyperd, ctx.executable._folder_index],
        arguments = arguments,
        command = "\n".join([
            "set -euo pipefail",
            "mkdir -p \"$3\"",
            "hyper_sql=\"$1\"; hyperd=\"$2\"; output=\"$3\"; sql=\"$4\"; folder_index=\"$5\"; should_index=\"$6\"",
            "shift 6",
            "args=(\"$hyper_sql\" --hyperd \"$hyperd\" --output \"$output\" --sql \"$sql\")",
            "while [ \"$#\" -gt 0 ]; do args+=(--source \"$1\" \"$2\"); shift 2; done",
            "\"${args[@]}\"",
            "if [ \"$should_index\" = true ]; then \"$folder_index\" folder-index --dir \"$output\"; fi",
        ]),
        mnemonic = "DashqlHyperDataset",
        progress_message = "Generating Hyper folder dataset %{label}",
    )
    return [DefaultInfo(files = depset([output]))]

_hyper_folder_output = rule(
    implementation = _hyper_folder_output_impl,
    attrs = {
        "srcs": attr.label_list(allow_files = True),
        "source_names": attr.string_list(),
        "sql": attr.string(mandatory = True),
        "out": attr.string(mandatory = True),
        "_hyper_sql": attr.label(default = "//packages/hyper-api:hyper_sql", executable = True, cfg = "exec"),
        "_hyperd": attr.label(default = "//packages/hyper-api:hyperd", allow_single_file = True, cfg = "exec"),
        "_folder_index": attr.label(default = "//packages/dashql-datasets:dashql-datasets", executable = True, cfg = "exec"),
    },
)

def _declare_sql_dataset(dataset):
    """Convert genrule for a "sql" dataset: fetched sources -> DuckDB CLI runs each
    output's verbatim SQL. Returns the genrule label."""
    convert_name = "convert_{}".format(_sanitize(dataset["name"]))
    srcs = [_source_label(dataset["name"], src["as"]) for src in dataset["sources"]]
    duckdb_outputs = [output for output in dataset["outputs"] if output["engine"] == "duckdb"]
    unsupported = []
    for output in dataset["outputs"]:
        if output["engine"] not in ["duckdb", "hyper"]:
            unsupported.append(output["engine"])
    if unsupported:
        fail("unsupported dataset output engine(s): {}".format(", ".join(unsupported)))
    for output in duckdb_outputs:
        if "folder" in output:
            fail("duckdb outputs must declare file, not folder")
    outs = [
        "{}/v{}/{}".format(dataset["name"], dataset["version"], output["file"])
        for output in duckdb_outputs
    ]
    version_dir = "$(RULEDIR)/{}/v{}".format(dataset["name"], dataset["version"])

    # One combined SQL script per dataset, fed to the CLI via a quoted heredoc so
    # arbitrary author SQL (single AND double quotes) passes through verbatim.
    # Bazel expands the $(RULEDIR)/$(location) make-vars before the shell runs.
    targets = []
    if duckdb_outputs:
        sql_lines = [_resolve_sql(dataset, output) + ";" for output in duckdb_outputs]
        cmd = "\n".join([
            "mkdir -p {}".format(version_dir),
            "$(execpath //bazel:duckdb_cli) <<'__DASHQL_SQL__'",
        ] + sql_lines + [
            "__DASHQL_SQL__",
        ])
        native.genrule(
            name = convert_name,
            srcs = srcs,
            outs = outs,
            tools = ["//bazel:duckdb_cli"],
            cmd = cmd,
        )
        targets.append(":" + convert_name)

    for output in dataset["outputs"]:
        if output["engine"] != "hyper":
            continue
        if "folder" not in output or "file" in output:
            fail("hyper outputs must declare folder and not file")
        folder_target = "convert_{}_{}".format(_sanitize(dataset["name"]), _sanitize(output["folder"]))
        _hyper_folder_output(
            name = folder_target,
            srcs = srcs,
            source_names = [source["as"] for source in dataset["sources"]],
            sql = output["sql"],
            out = "{}/v{}/{}".format(dataset["name"], dataset["version"], output["folder"]),
        )
        targets.append(":" + folder_target)
    return targets

def _declare_tpch_dataset(dataset):
    """Convert genrule for a "tpch" dataset: LOAD the vendored tpch extension offline,
    `CALL dbgen(sf=…)`, then COPY each of the 8 tables to Parquet. Returns the label.

    The extension is gzipped, so we gunzip it to an mktemp dir first: DuckDB will only
    LOAD a path ending in `.duckdb_extension`, and rejects relative paths ("hardened
    program"), so the target must be an absolute *.duckdb_extension file. autoinstall/
    autoload are disabled so nothing touches the network inside the sandbox."""
    convert_name = "convert_{}".format(_sanitize(dataset["name"]))
    sf = dataset["scale_factor"]
    version_dir = "$(RULEDIR)/{}/v{}".format(dataset["name"], dataset["version"])
    outs = [
        "{}/v{}/{}.parquet".format(dataset["name"], dataset["version"], table)
        for table in TPCH_TABLES
    ]

    # COPY one Parquet per table into the version dir.
    copy_lines = [
        "COPY (SELECT * FROM {t}) TO '{d}/{t}.parquet' (FORMAT PARQUET);".format(t = table, d = version_dir)
        for table in TPCH_TABLES
    ]
    cmd = "\n".join([
        # Absolute gunzip target ending in .duckdb_extension (DuckDB LOAD constraints).
        "TPCH_EXT_DIR=$$(mktemp -d)",
        "gunzip -c $(execpath {ext}) > $$TPCH_EXT_DIR/tpch.duckdb_extension".format(ext = _TPCH_EXTENSION),
        "mkdir -p {}".format(version_dir),
        "$(execpath //bazel:duckdb_cli) <<__DASHQL_SQL__",
        "SET autoinstall_known_extensions=false;",
        "SET autoload_known_extensions=false;",
        "LOAD '$$TPCH_EXT_DIR/tpch.duckdb_extension';",
        "CALL dbgen(sf={});".format(sf),
    ] + copy_lines + [
        "__DASHQL_SQL__",
    ])
    native.genrule(
        name = convert_name,
        srcs = [_TPCH_EXTENSION],
        outs = outs,
        tools = ["//bazel:duckdb_cli"],
        cmd = cmd,
    )
    return ":" + convert_name

def declare_datasets(name = "datasets", index_tool = "//packages/dashql-datasets:dashql-datasets"):
    """Expand every dataset into convert genrules + assembled tree + index.json.

    Produces:
      * `convert_<dataset>` genrule per dataset (DuckDB CLI runs each output's SQL),
      * `<name>_tree` copy_to_directory (versioned output tree only),
      * `index_json` genrule (walks the tree → index.json),
      * `<name>` copy_to_directory (output tree + index.json) — the sync artifact.
    """
    output_targets = []
    for dataset in DATASETS:
        if dataset.get("kind", "sql") == "tpch":
            output_targets.append(_declare_tpch_dataset(dataset))
        else:
            output_targets += _declare_sql_dataset(dataset)

    # Output tree (<dataset>/v<version>/<file> at the root) — a single directory the
    # index tool can walk. The package prefix is stripped by default.
    tree = name + "_tree"
    copy_to_directory(
        name = tree,
        srcs = output_targets,
        out = tree,
    )

    # index.json = { dataset -> version -> files[{url,bytes,sha256}] }, computed by
    # walking the assembled tree. Rust, not a py_binary (no Python toolchain is
    # registered in this repo).
    native.genrule(
        name = "index_json",
        srcs = [":" + tree],
        outs = ["index.json"],
        tools = [index_tool],
        cmd = "$(execpath {tool}) index --dir $(location :{tree}) --base-url {base} --out $@".format(
            tool = index_tool,
            tree = tree,
            base = DATA_BASE_URL,
        ),
    )

    # Final artifact the mirror uploads: the versioned output files + index.json, all
    # rooted at the top. Built from the output *files* (not the tree directory) plus
    # index.json — all package-relative files, so no directory-nesting ambiguity.
    copy_to_directory(
        name = name,
        srcs = output_targets + [":index_json"],
        out = name,
    )
