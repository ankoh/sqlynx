#!/usr/bin/env python3
"""Bundle the Rust output of `flatc --rust --rust-module-root-file` into a single file.

flatc writes one `<name>_generated.rs` file per type plus a `mod.rs` that declares
them as `mod <name>_generated;`. The number and names of these files depend on the
schemas, which does not fit Bazel's declared outputs. This script inlines every
`mod <name>_generated;` declaration of the root module file with the contents of the
generated file, producing one self-contained Rust source file.
"""

import argparse
import os
import re
import sys

MOD_DECL = re.compile(r"^(\s*)mod (\w+_generated);\s*$")
NAMESPACE_DECL = re.compile(r"^\s*pub mod (\w+) \{\s*$")
NAMESPACE_END = re.compile(r"^\s*\}\s*(//.*)?$")


CRATE_ROOT_PROLOGUE = """\
// Bundled from the output of `flatc --rust` by //proto/fb/bazel:flatbuf_rust_bundle.py.
// DO NOT EDIT.
#![allow(clippy::all, dead_code, non_camel_case_types, non_snake_case, unused_imports)]

pub use self::dashql::buffers::*;

"""


def bundle(root_dir: str) -> str:
    root_file = os.path.join(root_dir, "mod.rs")
    with open(root_file, encoding="utf-8") as f:
        lines = f.read().splitlines()

    out = []
    namespace = []
    for line in lines:
        m = NAMESPACE_DECL.match(line)
        if m:
            namespace.append(m.group(1))
            out.append(line)
            continue
        if NAMESPACE_END.match(line) and namespace:
            namespace.pop()
            out.append(line)
            continue
        m = MOD_DECL.match(line)
        if not m:
            out.append(line)
            continue
        indent, module = m.group(1), m.group(2)
        path = os.path.join(root_dir, *namespace, module + ".rs")
        with open(path, encoding="utf-8") as f:
            body = f.read().splitlines()
        out.append(f"{indent}mod {module} {{")
        for body_line in body:
            out.append(f"{indent}  {body_line}" if body_line else "")
        out.append(f"{indent}}}")
    return CRATE_ROOT_PROLOGUE + "\n".join(out) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root_dir", required=True, help="The flatc output directory containing mod.rs")
    parser.add_argument("--output", required=True, help="The bundled Rust file")
    args = parser.parse_args()
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(bundle(args.root_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main())
