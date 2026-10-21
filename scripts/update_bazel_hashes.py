#!/usr/bin/env python3
# Recomputes sha256 hashes for Bazel external deps after a version bump.
# Run after any version bump so the sha256 fields stay in sync.
#
# Usage:
#   python3 scripts/update_bazel_hashes.py                          # core_dependencies.bzl
#   python3 scripts/update_bazel_hashes.py bazel/core_dependencies.bzl
#   python3 scripts/update_bazel_hashes.py bazel/external_tableauhyperapi.bzl
import hashlib
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Dep configuration: bazel name -> (version_var, url_template)
# URL templates use {VERSION} as placeholder; GitHub strips leading 'v' from
# the archive directory name, so strip_prefix does not need it.
# ---------------------------------------------------------------------------
DEPS = [
    ("com_google_flatbuffers",      "_FLATBUFFERS_VERSION", "https://github.com/google/flatbuffers/archive/refs/tags/v{VERSION}.zip"),
    ("duckdb_cli_osx",              "_DUCKDB_VERSION",      "https://github.com/duckdb/duckdb/releases/download/v{VERSION}/duckdb_cli-osx-universal.zip"),
    ("duckdb_cli_linux_amd64",      "_DUCKDB_VERSION",      "https://github.com/duckdb/duckdb/releases/download/v{VERSION}/duckdb_cli-linux-amd64.zip"),
]


def get_version(content: str, varname: str) -> str:
    m = re.search(rf'^{re.escape(varname)}\s*=\s*"([^"]+)"', content, re.MULTILINE)
    if not m:
        raise ValueError(f"Variable {varname} not found")
    return m.group(1)


def compute_sha256(url: str) -> str:
    print(f"  Downloading: {url}", flush=True)
    if "downloads.tableau.com" in url:
        digest = hashlib.sha256()
        process = subprocess.Popen(["curl", "-fsSL", "--retry", "3", url], stdout=subprocess.PIPE)
        assert process.stdout is not None
        while chunk := process.stdout.read(1024 * 1024):
            digest.update(chunk)
        if process.wait() != 0:
            raise RuntimeError(f"Failed to download {url} with curl")
        return digest.hexdigest()

    req = urllib.request.Request(url, headers={"User-Agent": "update_bazel_hashes/1.0"})
    with urllib.request.urlopen(req) as resp:
        data = resp.read()
    return hashlib.sha256(data).hexdigest()


def update_sha256(content: str, dep_name: str, new_sha: str) -> str:
    pattern = re.compile(
        r'(http_archive\([^)]*?name\s*=\s*"' + re.escape(dep_name) + r'"[^)]*?sha256\s*=\s*")[^"]*(")',
        re.DOTALL,
    )
    new_content, count = pattern.subn(lambda m: m.group(1) + new_sha + m.group(2), content)
    if count == 0:
        raise ValueError(f"Could not find sha256 field for dep '{dep_name}'")
    return new_content


def versions_changed(filepath: Path, workspace: Path) -> bool:
    """Return True if any _*_VERSION variable in filepath differs from the base branch.

    With Renovate executionMode=branch, version bumps are already committed to
    the PR branch before postUpgradeTasks runs, so 'git diff HEAD' is always
    empty. Compare the branch tip against origin/main (the merge base) instead.
    Falls back to 'git diff HEAD' for local invocations where origin/main is
    not available.
    """
    import subprocess
    for base in ("origin/main", "origin/master"):
        probe = subprocess.run(
            ["git", "rev-parse", "--verify", base],
            capture_output=True, cwd=str(workspace),
        )
        if probe.returncode != 0:
            continue
        result = subprocess.run(
            ["git", "diff", f"{base}...HEAD", "--", str(filepath)],
            capture_output=True, text=True, cwd=str(workspace),
        )
        if result.returncode == 0:
            return "_VERSION" in result.stdout
    # Fallback: compare working tree against HEAD (local use, detached HEAD, etc.)
    result = subprocess.run(
        ["git", "diff", "HEAD", "--", str(filepath)],
        capture_output=True, text=True, cwd=str(workspace),
    )
    if result.returncode != 0:
        print(f"git diff failed: {result.stderr.strip()}", file=sys.stderr)
        return True
    return "_VERSION" in result.stdout


def update_core_dependencies(filepath: Path, workspace: Path, force: bool = False) -> None:
    if not force and not versions_changed(filepath, workspace):
        print(f"No _VERSION changes detected in {filepath}, skipping hash update.")
        return

    print(f"Updating sha256 hashes in {filepath} ...")
    content = filepath.read_text()

    for dep_name, version_var, url_template in DEPS:
        try:
            version = get_version(content, version_var)
        except ValueError as e:
            print(f"SKIP {dep_name}: {e}", file=sys.stderr)
            continue

        url = url_template.replace("{VERSION}", version)
        print(f"[{dep_name}] version={version}")
        sha = compute_sha256(url)
        print(f"  sha256={sha}")
        content = update_sha256(content, dep_name, sha)

    filepath.write_text(content)
    print("Done.")


# ---------------------------------------------------------------------------
# Handler: bazel/external_tableauhyperapi.bzl
# ---------------------------------------------------------------------------

_HYPER_CXX_PLATFORMS = {
    "linux_x86_64": "linux-x86_64",
    "macos_x86_64": "macos-x86_64",
    "macos_arm64": "macos-arm64",
}


def update_tableauhyperapi_hashes(filepath: Path, workspace: Path, force: bool = False) -> None:
    if not force and not versions_changed(filepath, workspace):
        print(f"No _VERSION changes detected in {filepath}, skipping hash update.")
        return

    print(f"Updating sha256 hashes in {filepath} ...")
    content = filepath.read_text()
    version = get_version(content, "TABLEAUHYPERAPI_VERSION")

    print(f"[tableauhyperapi] version={version}")
    releases_url = "https://tableau.github.io/hyper-db/docs/releases"
    req = urllib.request.Request(releases_url, headers={"User-Agent": "update_bazel_hashes/1.0"})
    with urllib.request.urlopen(req) as resp:
        releases = resp.read().decode()

    for platform_key, archive_platform in _HYPER_CXX_PLATFORMS.items():
        pattern = rf'https://downloads\.tableau\.com/tssoftware/+tableauhyperapi-cxx-{archive_platform}-release-[^"<]+?\.zip'
        urls = [url for url in re.findall(pattern, releases) if f".{version}." in url]
        if urls:
            url = urls[0].replace("/tssoftware//", "/tssoftware/")
        else:
            existing = re.search(
                rf'"{platform_key}":\s*\{{.*?"url":\s*"([^"]+)"',
                content,
                flags=re.DOTALL,
            )
            if not existing or f".{version}." not in existing.group(1):
                raise ValueError(f"No C++ archive found for {platform_key} and tableauhyperapi {version}")
            url = existing.group(1)
        sha = compute_sha256(url)
        print(f"  [{platform_key}] sha256={sha}")
        block_pattern = rf'("{platform_key}":\s*\{{.*?"url":\s*")[^"]+(".*?"sha256":\s*")[^"]+(".*?"strip_prefix":\s*")[^"]+(".*?\}})'
        strip_prefix = Path(url).stem
        content, count = re.subn(
            block_pattern,
            lambda m: m.group(1) + url + m.group(2) + sha + m.group(3) + strip_prefix + m.group(4),
            content,
            count=1,
            flags=re.DOTALL,
        )
        if count != 1:
            raise ValueError(f"Could not update archive metadata for {platform_key}")

    filepath.write_text(content)
    print("Done.")


# ---------------------------------------------------------------------------
# Handler: packages/dashql-data/datasets.bzl (vendored DuckDB tpch extension)
# ---------------------------------------------------------------------------
#
# The TPCH_EXTENSION_SHA256 dict pins one gzipped tpch extension per platform. The
# version MUST track the DuckDB CLI (an extension only loads into the exact build it
# was compiled for), so it is bumped in lockstep with _DUCKDB_VERSION and these four
# hashes recomputed here. Keys match DuckDB's `PRAGMA platform` names.


def update_dashql_data_datasets(filepath: Path, workspace: Path, force: bool = False) -> None:
    if not force and not versions_changed(filepath, workspace):
        print(f"No _VERSION changes detected in {filepath}, skipping hash update.")
        return

    print(f"Updating sha256 hashes in {filepath} ...")
    content = filepath.read_text()
    version = get_version(content, "TPCH_DUCKDB_VERSION")
    print(f"[tpch_extension] version={version}")

    # The set of platforms is whatever keys the dict currently declares.
    dict_match = re.search(r"TPCH_EXTENSION_SHA256\s*=\s*\{([^}]*)\}", content, re.DOTALL)
    if not dict_match:
        raise ValueError("TPCH_EXTENSION_SHA256 dict not found")
    platforms = re.findall(r'"([^"]+)":\s*"', dict_match.group(1))

    for platform in platforms:
        url = f"https://extensions.duckdb.org/v{version}/{platform}/tpch.duckdb_extension.gz"
        sha = compute_sha256(url)
        print(f"  [{platform}] sha256={sha}")
        content = re.sub(
            r'("' + re.escape(platform) + r'":\s*")[^"]*(")',
            lambda m, s=sha: m.group(1) + s + m.group(2),
            content,
        )

    filepath.write_text(content)
    print("Done.")


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

_HANDLERS = {
    "external_tableauhyperapi.bzl": update_tableauhyperapi_hashes,
    "datasets.bzl": update_dashql_data_datasets,
}


def main() -> None:
    workspace = Path(os.environ.get("BUILD_WORKSPACE_DIRECTORY", "."))
    args = sys.argv[1:]
    force = "--force" in args
    args = [a for a in args if a != "--force"]

    if not args:
        print("Usage: update_bazel_hashes.py [--force] <path/to/file.bzl>", file=sys.stderr)
        print("Known files:", ", ".join(_HANDLERS) or "core_dependencies.bzl (default handler)", file=sys.stderr)
        sys.exit(1)
    filepath = Path(args[0])

    handler = _HANDLERS.get(filepath.name, update_core_dependencies)
    handler(filepath, workspace, force=force)


if __name__ == "__main__":
    main()
