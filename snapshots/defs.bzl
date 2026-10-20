"""Macros for snapshot subfolder BUILD files."""

load("@rules_shell//shell:sh_binary.bzl", "sh_binary")

def snapshot_library(filter, files_srcs = None):
    """Defines :files (filegroup) and :update (run snapshotter for this category).

    Args:
        filter: Snapshot category passed to snapshotter --filter (e.g. "parser").
        files_srcs: If set, use these targets for :files instead of glob (use for root package).
    """
    native.filegroup(
        name = "files",
        srcs = files_srcs if files_srcs != None else native.glob(["*.yaml"]),
        visibility = ["//visibility:public"],
    )

    # The snapshotter uses the snapshot encoders of the (testonly) test library
    sh_binary(
        name = "update",
        testonly = True,
        srcs = ["//snapshots:run_snapshotter.sh"],
        args = [
            "$(rootpath //packages/dashql-core-rs:snapshotter)",
            filter,
        ],
        data = ["//packages/dashql-core-rs:snapshotter"],
    )
