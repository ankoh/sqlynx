#!/usr/bin/env bash
# Re-resolve the crate universes declared in bazel/crates/*.MODULE.bazel and rewrite their Cargo.lock files.
#
#   bazel run //scripts:repin_crates                 re-resolve after spec edits, keeping locked transitive versions
#   bazel run //scripts:repin_crates -- full         upgrade every crate to the newest version the specs allow
#   bazel run //scripts:repin_crates -- <crate>@<v>  upgrade one crate
#
# Set CARGO_BAZEL_REPIN_ONLY=<universe> (crates, core_crates, umap_crates) to limit the repin to one universe.
set -euo pipefail
cd "${BUILD_WORKSPACE_DIRECTORY:-$(dirname "$0")/..}"
CARGO_BAZEL_REPIN="${1:-1}" bazel mod deps --lockfile_mode=update
# Evaluate once more without CARGO_BAZEL_REPIN, so MODULE.bazel.lock does not record it.
bazel mod deps --lockfile_mode=update
