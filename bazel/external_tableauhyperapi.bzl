"""Repository rules for the native Tableau Hyper API C++ distribution."""

# renovate: datasource=pypi depName=tableauhyperapi
TABLEAUHYPERAPI_VERSION = "0.0.26359"

_CXX_ARCHIVES = {
    "linux_x86_64": {
        "url": "https://downloads.tableau.com/tssoftware/tableauhyperapi-cxx-linux-x86_64-release-main.0.0.26359.r07abb490.zip",
        "sha256": "e3e9dca5c777259f96d9bfa8f4a57e520bd2b9ddc2a1ab4d5a37c56e38b2ebcd",
        "strip_prefix": "tableauhyperapi-cxx-linux-x86_64-release-main.0.0.26359.r07abb490",
        "shared_library": "lib/libtableauhyperapi.so",
    },
    "macos_x86_64": {
        "url": "https://downloads.tableau.com/tssoftware/tableauhyperapi-cxx-macos-x86_64-release-main.0.0.26359.r07abb490.zip",
        "sha256": "4ca10d30fb7e8e97d396e4e34f85ae9a5ea946b4223a5e7f2f05f618e6083a39",
        "strip_prefix": "tableauhyperapi-cxx-macos-x86_64-release-main.0.0.26359.r07abb490",
        "shared_library": "lib/libtableauhyperapi.dylib",
    },
    "macos_arm64": {
        "url": "https://downloads.tableau.com/tssoftware/tableauhyperapi-cxx-macos-arm64-release-main.0.0.26359.r07abb490.zip",
        "sha256": "e874120cfd2d0cfd4c4aed772e46de458d4eacc1a46c6feb1b1a5a85ae0c208f",
        "strip_prefix": "tableauhyperapi-cxx-macos-arm64-release-main.0.0.26359.r07abb490",
        "shared_library": "lib/libtableauhyperapi.dylib",
    },
}

def _tableauhyperapi_cxx_repository_impl(repository_ctx):
    # Tableau's CDN rejects Bazel's downloader user agent. Fetch with curl,
    # verify the pinned digest, then hand the archive back to Bazel to extract.
    archive = repository_ctx.path("tableauhyperapi-cxx.zip")
    download = repository_ctx.execute([
        "curl",
        "-fsSL",
        "--retry",
        "5",
        "--retry-all-errors",
        "--retry-delay",
        "2",
        "--continue-at",
        "-",
        "-o",
        str(archive),
        repository_ctx.attr.url,
    ], timeout = 600)
    if download.return_code != 0:
        fail("Failed to download Tableau Hyper API: {}".format(download.stderr))

    verify = repository_ctx.execute([
        "sh",
        "-c",
        "actual=$(if command -v sha256sum >/dev/null; then sha256sum \"$1\" | cut -d' ' -f1; else shasum -a 256 \"$1\" | cut -d' ' -f1; fi); " +
        "test \"$actual\" = \"$2\" || { echo \"sha256 mismatch: expected $2, got $actual\" >&2; exit 1; }",
        "verify-tableauhyperapi",
        str(archive),
        repository_ctx.attr.sha256,
    ])
    if verify.return_code != 0:
        fail("Failed to verify Tableau Hyper API: {}".format(verify.stderr))

    repository_ctx.extract(
        archive = archive,
        stripPrefix = repository_ctx.attr.strip_prefix,
    )
    repository_ctx.delete(archive)

    # Tableau 0.0.26359 calls the int overload of abs for a long duration count.
    # Patch all platform archives before their headers are exposed to C++ consumers.
    repository_ctx.patch(
        Label("//bazel:tableauhyperapi_abs.patch"),
        strip = 1,
    )

    # Debug symbols and examples make the extracted repository several times
    # larger but are not inputs to the native library.
    repository_ctx.delete("examples")
    repository_ctx.delete("lib/libtableauhyperapi.so.debug")
    repository_ctx.delete("lib/libtableauhyperapi.so.dwp")
    repository_ctx.delete("lib/libtableauhyperapi.dylib.dSYM")

    repository_ctx.file("BUILD.bazel", content = """\
load("@rules_cc//cc:defs.bzl", "cc_import", "cc_library")

package(default_visibility = ["//visibility:public"])

cc_import(
    name = "hyperapi_c",
    shared_library = "{shared_library}",
)

cc_library(
    name = "hyperapi",
    hdrs = glob(["include/hyperapi/**/*.h", "include/hyperapi/**/*.hpp"]),
    includes = ["include"],
    deps = [":hyperapi_c"],
)

filegroup(
    name = "hyperd",
    srcs = ["lib/hyper/hyperd"],
)

filegroup(
    name = "runtime_files",
    srcs = [
        "lib/hyper/hyperd",
        "{shared_library}",
    ],
)

filegroup(
    name = "licenses",
    srcs = [
        "HYPER_API_OSS_disclosure.txt",
        "LICENSE",
        "NOTICES.txt",
    ],
)
""".format(shared_library = repository_ctx.attr.shared_library))

tableauhyperapi_cxx_repository = repository_rule(
    implementation = _tableauhyperapi_cxx_repository_impl,
    doc = "Downloads one platform's Tableau Hyper API C++ archive.",
    attrs = {
        "url": attr.string(mandatory = True),
        "sha256": attr.string(mandatory = True),
        "strip_prefix": attr.string(mandatory = True),
        "shared_library": attr.string(mandatory = True),
    },
)

def _declare_repository(name, platform):
    archive = _CXX_ARCHIVES[platform]
    tableauhyperapi_cxx_repository(
        name = name,
        url = archive["url"],
        sha256 = archive["sha256"],
        strip_prefix = archive["strip_prefix"],
        shared_library = archive["shared_library"],
    )

def _tableauhyperapi_ext_impl(_mctx):
    _declare_repository("tableauhyperapi_cxx_linux_x86_64", "linux_x86_64")
    _declare_repository("tableauhyperapi_cxx_macos_arm64", "macos_arm64")
    _declare_repository("tableauhyperapi_cxx_macos_x86_64", "macos_x86_64")

tableauhyperapi_ext = module_extension(
    implementation = _tableauhyperapi_ext_impl,
)
