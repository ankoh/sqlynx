"""Generates rust-project.json for rust-analyzer from the Bazel build graph.

Usage: bazel run //scripts:gen_rust_project [-- <target patterns>]

Runs @rules_rust//tools/rust_analyzer:gen_rust_project for every package with Rust targets (or the given target
patterns) and repairs two things it gets wrong for this repository:

- Crates that are built in several configurations (natively and for wasm32 through the wasm-bindgen
  transitions) show up once per configuration if their crate root is generated or copied into bazel-out.
  rust-analyzer then sees the parser crate twice and reports mismatches like "expected StatusCode, found
  StatusCode". The duplicates are merged into the native crate.
- A crate that mixes checked-in and generated sources (the parser) has its sources copied into bazel-out.
  rules_rust points rust-analyzer at the copy, so the checked-in files are not part of any crate. The crate
  root is pointed back at the checked-in sources, and the generated files are symlinked next to them (they
  are git-ignored, and Bazel resolves their paths to the generated files).
"""

import json
import os
import re
import shutil
import subprocess
import sys

from python.runfiles import runfiles

RUST_TARGETS = 'kind("rust_", //...)'
# On Linux, native-tls builds openssl-sys against the system OpenSSL.
OPENSSL_PACKAGES_QUERY = f'{RUST_TARGETS} intersect rdeps(//..., filter("openssl-sys", deps({RUST_TARGETS})))'

# <execution root>/bazel-out/<configuration>/bin/<workspace path>
BAZEL_OUT = re.compile(r"^(?P<prefix>.*/bazel-out/)(?P<config>[^/]+)(?P<path>/bin/.*)$")
BAZEL_BIN = re.compile(r"^.*/bazel-out/[^/]+/bin/(?P<path>.*)$")


def workspace_counterpart(workspace, path):
    """Returns the checked-in file or directory that a bazel-out path mirrors, if any."""
    match = BAZEL_BIN.match(path)
    if match is None:
        return None
    candidate = os.path.join(workspace, match.group("path"))
    return candidate if os.path.exists(candidate) else None


def source_root(workspace, crate):
    """Returns the checked-in crate root of a crate whose root rules_rust copied into bazel-out."""
    root = crate["root_module"]
    counterpart = workspace_counterpart(workspace, root)
    if counterpart is not None and os.path.realpath(root) == os.path.realpath(counterpart):
        return counterpart
    return root


def crate_key(workspace, crate):
    """Identifies a crate independently of the configuration it was built in."""
    root = source_root(workspace, crate)
    match = BAZEL_OUT.match(root)
    return match.group("prefix") + "*" + match.group("path") if match else root


def link_generated_sources(workspace, crate):
    """Symlinks the generated sources of a crate next to its checked-in ones."""
    source = crate.get("source")
    if not source:
        return
    root_dir = os.path.dirname(crate["root_module"])
    include_dirs = []
    for include_dir in source["include_dirs"]:
        counterpart = workspace_counterpart(workspace, include_dir)
        if (
            counterpart is None
            or not os.path.isdir(counterpart)
            or os.path.commonpath([root_dir, counterpart]) != counterpart
        ):
            include_dirs.append(include_dir)
            continue
        # rules_rust symlinks the checked-in sources into bazel-out, everything else there is generated.
        for directory, _, files in os.walk(include_dir):
            for name in files:
                generated = os.path.join(directory, name)
                if not name.endswith(".rs") or os.path.islink(generated):
                    continue
                link = os.path.join(counterpart, os.path.relpath(generated, include_dir))
                if os.path.lexists(link) and not os.path.islink(link):
                    print(f"warning: {link} exists and is no symlink, leaving it alone", file=sys.stderr)
                    continue
                os.makedirs(os.path.dirname(link), exist_ok=True)
                if os.path.lexists(link):
                    os.remove(link)
                os.symlink(generated, link)
                print(f"linked {os.path.relpath(link, workspace)}")
        include_dirs.append(counterpart)
    source["include_dirs"] = include_dirs


def is_wasm(crate):
    return crate["target"].startswith("wasm32")


def fix_project(workspace, project):
    crates = project["crates"]

    # Merge the crates of the different configurations, preferring the native one.
    keep = {}
    for index, crate in enumerate(crates):
        key = crate_key(workspace, crate)
        if key not in keep or (is_wasm(crates[keep[key]]) and not is_wasm(crate)):
            keep[key] = index
    kept = sorted(keep.values())
    new_index = {old: new for new, old in enumerate(kept)}
    remap = {index: new_index[keep[crate_key(workspace, crate)]] for index, crate in enumerate(crates)}

    fixed = []
    for index in kept:
        crate = crates[index]
        if crate.get("is_workspace_member"):
            crate["root_module"] = source_root(workspace, crate)
            link_generated_sources(workspace, crate)
        deps = []
        seen = set()
        for dep in crate["deps"]:
            target = remap[dep["crate"]]
            if target not in seen:
                seen.add(target)
                deps.append({**dep, "crate": target})
        crate["deps"] = deps
        fixed.append(crate)
    project["crates"] = fixed
    return len(crates) - len(fixed)


def query_packages(workspace, query):
    result = subprocess.run(
        ["bazel", "query", query, "--output=package"], check=True, cwd=workspace, capture_output=True, text=True
    )
    return set(result.stdout.split())


def has_system_openssl():
    if not sys.platform.startswith("linux"):
        return True
    pkg_config = shutil.which("pkg-config")
    return pkg_config is not None and subprocess.run([pkg_config, "--exists", "openssl"]).returncode == 0


def default_targets(workspace):
    """Returns the packages with Rust targets, without those that cannot build on this machine."""
    packages = query_packages(workspace, RUST_TARGETS)
    if not has_system_openssl():
        skipped = packages & query_packages(workspace, OPENSSL_PACKAGES_QUERY)
        if skipped:
            print(
                f"warning: skipping {', '.join(sorted(skipped))}, openssl-sys needs the OpenSSL headers "
                "(apt install libssl-dev pkg-config)",
                file=sys.stderr,
            )
            packages -= skipped
    return [f"//{package}/..." for package in sorted(packages)]


def main():
    workspace = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
    if not workspace:
        sys.exit("run this with bazel run //scripts:gen_rust_project")
    gen_rust_project = runfiles.Create().Rlocation(sys.argv[1])
    targets = sys.argv[2:]
    if not targets:
        targets = default_targets(workspace)

    subprocess.run([gen_rust_project, *targets], check=True, cwd=workspace)

    path = os.path.join(workspace, "rust-project.json")
    with open(path) as file:
        project = json.load(file)
    merged = fix_project(workspace, project)
    with open(path, "w") as file:
        json.dump(project, file, indent=2)
        file.write("\n")
    print(f"wrote {path} ({len(project['crates'])} crates, merged {merged} duplicates)")


if __name__ == "__main__":
    main()
