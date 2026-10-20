#!/usr/bin/env python3
"""
Assembles the dashql.y grammar from grammar fragments.
Replicates the CMake logic: prologue, keyword declarations/rules from .list files,
precedences, types, rule files, epilogue.
Accepts paths via arguments for hermetic Bazel genrules.
"""
import argparse
import os
import re
import sys
from typing import Optional

# The Rust types of the C++ semantic value types (--lang rust).
RUST_TYPES = {
    "BackedUniquePtr<NodeList>": "NodeList",
    "ExpressionVariant": "ExprVariant",
    "bool": "bool",
    "buffers::parser::AttributeKey": "AttributeKey",
    "buffers::parser::JoinType": "JoinType",
    "buffers::parser::Node": "Node",
    "buffers::parser::NumericType": "NumericType",
    "size_t": "NameId",
    "std::string_view": "Str",
}

# The header of the Rust grammar, replacing the C++ skeleton options and code blocks.
RUST_PROLOGUE_HEADER = """// The Rust grammar of DashQL, assembled by grammar/assemble_grammar.py --lang rust.
// Emitted through //grammar/rust:tables.rs.m4, the actions run in dashql_grammar::parser.

%code use {
use crate::parser::actions::*;
}

%define api.token.raw true
%define api.rust.context {ParseContext}
%define api.rust.location {SymbolSpan}
%define api.rust.error {ReduceError}

"""


def rust_type_tags(text: str) -> str:
    """Replace the C++ type tags of %type and %token declarations with Rust types."""

    def replace(m):
        tag = m.group(2)
        if tag not in RUST_TYPES:
            raise SystemExit(f"no Rust type for <{tag}>")
        return f"{m.group(1)}<{RUST_TYPES[tag]}>"

    return re.sub(r"(%type|%token)\s*<((?:[^<>]|<[^<>]*>)*)>", replace, text)


def rust_prologue(text: str) -> str:
    """Derive the Rust prologue from the C++ prologue: keep the token declarations, drop the
    C++ skeleton options and code blocks."""
    out = []
    lines = text.splitlines(keepends=True)
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped.startswith("%code"):
            # Skip the balanced { ... } block
            depth = 0
            while True:
                depth += lines[i].count("{") - lines[i].count("}")
                i += 1
                if depth == 0:
                    break
            continue
        if stripped.startswith(("%skeleton", "%define", "%parse-param", "%locations")):
            i += 1
            continue
        out.append(line)
        i += 1
    return RUST_PROLOGUE_HEADER + rust_type_tags("".join(out))


def token_from_list_line(line: str) -> Optional[str]:
    """Extract token from X(CATEGORY, "keyword", TOKEN) - third field, strip trailing )."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    parts = line.split(",")
    if len(parts) < 3:
        return None
    third = parts[2].strip().rstrip(")")
    return third.strip() if third else None


def process_keyword_list(path: str) -> tuple[str, list[str]]:
    """Return (basename without .list, list of token names)."""
    basename = os.path.splitext(os.path.basename(path))[0]
    tokens = []
    with open(path) as f:
        for line in f:
            t = token_from_list_line(line)
            if t:
                tokens.append(t)
    return basename, tokens


def main():
    ap = argparse.ArgumentParser(description="Assemble dashql.y from grammar fragments")
    ap.add_argument("--output", required=True, help="Output .y file")
    ap.add_argument("--prologue", required=True)
    ap.add_argument("--epilogue", required=True)
    ap.add_argument("--precedences", required=True)
    ap.add_argument("--keyword_lists", nargs="+", required=True, help="Paths to .list files")
    ap.add_argument("--type_files", nargs="+", required=True, help="Paths to .yh files")
    ap.add_argument("--rule_files", nargs="+", required=True, help="Paths to .y rule files")
    ap.add_argument("--lang", choices=["cpp", "rust"], default="cpp", help="The language of the actions")
    args = ap.parse_args()
    rust = args.lang == "rust"
    keyword_type = "Str" if rust else "std::string_view"
    keyword_action = "{ $1 }" if rust else "{$$=$1;}"

    with open(args.output, "w") as out:
        with open(args.prologue) as f:
            prologue = f.read()
            out.write(rust_prologue(prologue) if rust else prologue)

        for path in args.keyword_lists:
            basename, tokens = process_keyword_list(path)
            if not tokens:
                continue
            out.write(f"\n%type<{keyword_type}> ")
            out.write(basename)
            out.write(f"\n%token<{keyword_type}> ")
            out.write(" ".join(tokens))
            out.write("\n")

        with open(args.precedences) as f:
            out.write(f.read())

        for path in args.type_files:
            with open(path) as f:
                types = f.read()
                out.write(rust_type_tags(types) if rust else types)

        out.write("%%\n")

        for path in args.keyword_lists:
            basename, tokens = process_keyword_list(path)
            if not tokens:
                continue
            out.write("\n")
            out.write(basename)
            out.write(":")
            for i, t in enumerate(tokens):
                if i > 0:
                    out.write(" | ")
                out.write(t)
                out.write(keyword_action)
            out.write(";\n\n")

        for path in args.rule_files:
            with open(path) as f:
                out.write(f.read())

        out.write("%%\n")

        if os.path.exists(args.epilogue):
            with open(args.epilogue) as f:
                out.write(f.read())


if __name__ == "__main__":
    main()
