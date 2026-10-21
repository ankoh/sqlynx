"""Repository rule for Playwright's pinned Firefox build."""

_REVISION = "1543"

# Mirrors in the order Playwright's own installer tries them. The first one
# redirects to playwright.download.prss.microsoft.com, which does not always
# resolve, so fall back to the storage bucket behind cdn.playwright.dev.
_MIRRORS = [
    "https://cdn.playwright.dev/dbazure/download/playwright",
    "https://playwright.download.prss.microsoft.com/dbazure/download/playwright",
    "https://cdn.playwright.dev",
]

_PLATFORMS = {
    ("darwin", "aarch64"): (
        "firefox-mac-arm64.zip",
        "12798eac57cad33a466d7315ddae1350a326dedd167ee4ac73307425f4fa8f28",
        "firefox/Nightly.app/Contents/MacOS/firefox",
    ),
    ("darwin", "x86_64"): (
        "firefox-mac.zip",
        "717693ae50e22f6070895a73bc5546dc862ffdf87e6ba9892a5f9e423b312741",
        "firefox/Nightly.app/Contents/MacOS/firefox",
    ),
    ("linux", "aarch64"): (
        "firefox-ubuntu-24.04-arm64.zip",
        "10a0c716eb93ee7e57aabf8d626bd35b5c4007517c90708f67634f640a47a569",
        "firefox/firefox",
    ),
    ("linux", "x86_64"): (
        "firefox-ubuntu-24.04.zip",
        "b0905e84427cc162b9a6e4392be14e5e54e0ade911c83639962c8078b273565e",
        "firefox/firefox",
    ),
}

_ARCH_ALIASES = {
    "amd64": "x86_64",
    "arm64": "aarch64",
}

def _playwright_firefox_repository_impl(repository_ctx):
    os_name = repository_ctx.os.name
    os_key = "darwin" if os_name == "mac os x" else os_name
    arch = _ARCH_ALIASES.get(repository_ctx.os.arch, repository_ctx.os.arch)
    platform = _PLATFORMS.get((os_key, arch))
    if not platform:
        fail("Playwright Firefox is not available for {}-{}".format(os_key, arch))
    archive, sha256, executable = platform
    repository_ctx.download_and_extract(
        url = ["{}/builds/firefox/{}/{}".format(mirror, _REVISION, archive) for mirror in _MIRRORS],
        sha256 = sha256,
    )
    repository_ctx.file("BUILD.bazel", content = """
package(default_visibility = ["//visibility:public"])
exports_files(["{executable}"])
alias(name = "firefox", actual = "{executable}")
filegroup(name = "firefox_files", srcs = glob(["firefox/**"]))
alias(name = "runtime", actual = ":firefox_files")
""".format(executable = executable))

playwright_firefox_repository = repository_rule(
    implementation = _playwright_firefox_repository_impl,
    doc = "Downloads the Playwright-compatible Firefox build for the host platform.",
)
