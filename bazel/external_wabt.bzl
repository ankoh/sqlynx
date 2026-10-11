"""Repository rule: download prebuilt WABT for x86_64-linux and arm64-macos.

Both platform archives are fetched unconditionally.  A sh_binary wrapper selects
the right binary at runtime via RUNFILES_DIR so the same target works on Linux CI
and macOS developer/CI machines without re-fetching.
"""

# WABT releases: https://github.com/WebAssembly/wabt/releases
# Match scripts/install_infra.sh
_WABT_VERSION = "1.0.42"
_BASE_URL = "https://github.com/WebAssembly/wabt/releases/download/" + _WABT_VERSION

def _wabt_prebuilt_repository_impl(repository_ctx):
    strip_prefix = "wabt-{}".format(_WABT_VERSION)

    repository_ctx.download_and_extract(
        url = _BASE_URL + "/wabt-{}-linux-x64.tar.gz".format(_WABT_VERSION),
        output = "linux",
        stripPrefix = strip_prefix,
    )
    repository_ctx.download_and_extract(
        url = _BASE_URL + "/wabt-{}-macos-arm64.tar.gz".format(_WABT_VERSION),
        output = "macos",
        stripPrefix = strip_prefix,
    )

    # Embed the canonical repo name so RUNFILES_DIR/<name>/linux|macos/bin/wasm-strip resolves.
    # repository_ctx.name returns the canonical bzlmod name (e.g. dashql+ext~wabt).
    canon = repository_ctx.name
    wrapper = """#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${{RUNFILES_DIR:-}}" ]]; then
    _RF="$RUNFILES_DIR"
elif [[ -d "${{BASH_SOURCE[0]}}.runfiles" ]]; then
    _RF="${{BASH_SOURCE[0]}}.runfiles"
else
    echo "wasm-strip wrapper: cannot locate runfiles" >&2
    exit 1
fi
case "$(uname -s)" in
    Darwin) exec "$_RF/{canon}/macos/bin/wasm-strip" "$@" ;;
    Linux)  exec "$_RF/{canon}/linux/bin/wasm-strip" "$@" ;;
    *)      echo "wasm-strip: unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
""".format(canon = canon)

    repository_ctx.file("wasm_strip.sh", content = wrapper, executable = True)

    repository_ctx.file("BUILD.bazel", content = """
load("@rules_shell//shell:sh_binary.bzl", "sh_binary")

package(default_visibility = ["//visibility:public"])

sh_binary(
    name = "wasm_strip",
    srcs = ["wasm_strip.sh"],
    data = [
        "linux/bin/wasm-strip",
        "macos/bin/wasm-strip",
    ],
)
""")

wabt_prebuilt_repository = repository_rule(
    implementation = _wabt_prebuilt_repository_impl,
    doc = "Downloads prebuilt WABT (wasm-strip) for x86_64-linux and arm64-macos; selects at runtime via wrapper.",
)
