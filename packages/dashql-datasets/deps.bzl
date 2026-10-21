"""Fetch-phase module extension for data.dashql.app datasets.

Iterates `DATASETS` (the single source of truth in `datasets.bzl`) and declares one
hash-pinned `http_file` per source, at repo name `dataset_<name>_<as>` (label
`@dataset_<name>_<as>//file`). `http_file` *requires* `sha256`, which is what makes
the source pin load-bearing — the build genrules then read the local fetched file
offline, never over the network.

Registered in `MODULE.bazel`; the generated repos are surfaced with `use_repo`.
"""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")
load(
    "//packages/dashql-datasets:datasets.bzl",
    "DATASETS",
    "TPCH_EXTENSION_SHA256",
    "dataset_repo_name",
    "tpch_extension_repo_name",
    "tpch_extension_url",
)

def _downloaded_name(src):
    """A stable on-disk filename for the fetched source. Cosmetic — the dataset SQL
    picks the reader explicitly and DuckDB reads by content, not extension — but we
    keep the URL's basename (sans query string) so it's recognizable."""
    basename = src["url"].split("?")[0].rstrip("/").split("/")[-1]
    return basename if basename else src["as"]

def _dashql_datasets_impl(_ctx):
    for dataset in DATASETS:
        for src in dataset.get("sources", []):
            http_file(
                name = dataset_repo_name(dataset["name"], src["as"]),
                urls = [src["url"]],
                sha256 = src["sha256"],
                downloaded_file_path = _downloaded_name(src),
            )

    # The vendored DuckDB tpch extension, one hash-pinned http_file per exec platform.
    # These back the "tpch" datasets: LOADed offline in the convert genrule so `CALL
    # dbgen` needs no `INSTALL` (network). See datasets.bzl for the version coupling.
    for platform, sha256 in TPCH_EXTENSION_SHA256.items():
        http_file(
            name = tpch_extension_repo_name(platform),
            urls = [tpch_extension_url(platform)],
            sha256 = sha256,
            downloaded_file_path = "tpch.duckdb_extension.gz",
        )

dashql_datasets = module_extension(
    implementation = _dashql_datasets_impl,
)
