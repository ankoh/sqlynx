#!/usr/bin/env python3
"""
Assembles the dashql.y grammar from grammar fragments: prologue, keyword declarations/rules from
.list files, precedences, types, rule files, epilogue.
Accepts paths via arguments for hermetic Bazel genrules.
"""
import argparse
import os
import sys
from typing import Optional

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
    args = ap.parse_args()

    with open(args.output, "w") as out:
        with open(args.prologue) as f:
            out.write(f.read())

        for path in args.keyword_lists:
            basename, tokens = process_keyword_list(path)
            if not tokens:
                continue
            out.write("\n%type<Str> ")
            out.write(basename)
            out.write("\n%token<Str> ")
            out.write(" ".join(tokens))
            out.write("\n")

        with open(args.precedences) as f:
            out.write(f.read())

        for path in args.type_files:
            with open(path) as f:
                out.write(f.read())

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
                out.write("{ $1 }")
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
