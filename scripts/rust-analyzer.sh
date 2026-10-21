#!/usr/bin/env bash
# Starts the rust-analyzer of the Bazel Rust toolchain that rust-project.json was generated for.
#
# The sysroot in rust-project.json is the rust-src of the pinned toolchain (MODULE.bazel). A rust-analyzer
# release that is much newer than that toolchain no longer resolves the macros of its standard library
# (`vec!`, `format!`, `assert_eq!`, ...), the one shipped with the toolchain does. Point the editor's
# rust-analyzer command at this script, see docs/agents/rust_analyzer.md.
set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="${workspace}/rust-project.json"

if [[ ! -f "${project}" ]]; then
    echo "${project} is missing, run: bazel run //scripts:rust_project" >&2
    exit 1
fi

sysroot="$(sed -n 's/^  "sysroot": "\(.*\)",$/\1/p' "${project}")"
if [[ ! -x "${sysroot}/bin/rust-analyzer" ]]; then
    echo "no rust-analyzer in the sysroot '${sysroot}', run: bazel run //scripts:rust_project" >&2
    exit 1
fi

exec "${sysroot}/bin/rust-analyzer" "$@"
