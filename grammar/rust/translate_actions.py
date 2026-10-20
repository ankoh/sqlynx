#!/usr/bin/env python3
"""Translate the C++ actions of grammar/rules/*.y into Rust actions for grammar/rules_rs/*.y.

A migration tool for the Rust rewrite of dashql-core. The C++ actions use a small vocabulary
(ctx.Object, ctx.Array, ctx.List, Attr, Enum, Expr, ...) that maps one to one to
dashql_grammar::parser. This script parses that subset of C++ and emits the equivalent Rust:

  - actions become Rust block expressions whose value is `$$`,
  - helper calls keep their argument order, so nodes are emitted in the same order,
  - initializer lists become slices, `std::move(x)` becomes `x`,
  - `YYERROR` returns an error, `yyclearin` asks the driver to drop the lookahead.

The grammar rules (everything outside of actions) are copied verbatim, so both rule sets describe
the same automaton (checked by //packages/dashql-core-rs:dashql_grammar_table_parity_test).

//grammar:rust_rule_files runs the translator in the build, so grammar/rules/*.y stay the single
source of the grammar while both cores exist. A new action that the translator does not understand
fails the build; extend the translator (or the action vocabulary of dashql_grammar::parser::actions).

Usage: translate_actions.py --output_dir <dir> grammar/rules/*.y
"""

import argparse
import os
import re
import sys

RUST_KEYWORDS = {"as", "box", "fn", "impl", "in", "loop", "match", "mod", "move", "ref", "self", "type", "use", "where"}

# Namespaces that are dropped from scoped C++ names.
NAMESPACES = {"buffers", "parser", "sx", "dashql"}


class TranslateError(Exception):
    pass


# ---------------------------------------------------------------------------
# Splitting rule files into grammar text and actions
# ---------------------------------------------------------------------------


def split_actions(text):
    """Yield ("text", s) and ("action", s) segments. Actions include their braces."""
    i = 0
    start = 0
    while i < len(text):
        c = text[i]
        if text.startswith("//", i):
            i = text.index("\n", i) if "\n" in text[i:] else len(text)
        elif text.startswith("/*", i):
            i = text.index("*/", i) + 2
        elif c == "{":
            if start < i:
                yield ("text", text[start:i])
            j = skip_braces(text, i)
            yield ("action", text[i:j])
            i = start = j
        else:
            i += 1
    if start < len(text):
        yield ("text", text[start:])


def skip_braces(text, i):
    depth = 0
    while i < len(text):
        c = text[i]
        if c == '"' or c == "'":
            i = skip_quoted(text, i)
            continue
        if text.startswith("//", i):
            i = text.index("\n", i)
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise TranslateError("unbalanced braces")


def skip_quoted(text, i):
    quote = text[i]
    i += 1
    while text[i] != quote:
        i += 2 if text[i] == "\\" else 1
    return i + 1


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------

TOKEN = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<bcomment>/\*.*?\*/)
  | (?P<comment>//[^\n]*)
  | (?P<dollar>\$\$|\$[0-9]+)
  | (?P<at>@\$|@[0-9]+)
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<number>[0-9]+)
  | (?P<name>[A-Za-z_][A-Za-z_0-9]*(?:::[A-Za-z_][A-Za-z_0-9]*)*)
  | (?P<op>->|==|!=|&&|\|\||<=|>=|[(){}\[\],;.=!?:<>+\-*/&|])
    """,
    re.VERBOSE | re.DOTALL,
)


def tokenize(code):
    tokens = []
    pos = 0
    while pos < len(code):
        m = TOKEN.match(code, pos)
        if not m:
            raise TranslateError(f"cannot tokenize {code[pos:pos + 30]!r}")
        pos = m.end()
        kind = m.lastgroup
        if kind in ("ws", "bcomment"):
            continue
        tokens.append((kind, m.group()))
    return tokens


# ---------------------------------------------------------------------------
# Parser for the C++ subset
# ---------------------------------------------------------------------------


class Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.i = 0

    def peek(self, k=0):
        j = self.i + k
        return self.tokens[j] if j < len(self.tokens) else (None, None)

    def take(self, value=None):
        tok = self.peek()
        if value is not None and tok[1] != value:
            raise TranslateError(f"expected {value!r}, got {tok[1]!r}")
        self.i += 1
        return tok

    def at(self, value):
        return self.peek()[1] == value

    # Statements

    def statements(self, end=None):
        out = []
        while self.peek()[0] is not None and not self.at(end):
            out.append(self.statement())
        return out

    def statement(self):
        kind, value = self.peek()
        if kind == "comment":
            self.take()
            return ("comment", value)
        if value == "{":
            self.take()
            body = self.statements("}")
            self.take("}")
            return ("block", body)
        if value == "if":
            self.take()
            self.take("(")
            cond = self.expr()
            self.take(")")
            then = self.statement()
            other = None
            if self.at("else"):
                self.take()
                other = self.statement()
            return ("if", cond, then, other)
        if value == "YYERROR":
            self.take()
            self.take(";")
            return ("yyerror",)
        if value == "yyclearin":
            self.take()
            self.take(";")
            return ("yyclearin",)
        if value == "auto":
            self.take()
            _, name = self.take()
            self.take("=")
            init = self.expr()
            self.take(";")
            return ("let", name, init)
        if value == "$$" and self.peek(1)[1] == "=":
            self.take()
            self.take("=")
            e = self.expr()
            self.take(";")
            return ("result", e)
        if kind == "dollar" and self.peek(1)[1] == "=":
            self.take()
            self.take("=")
            e = self.expr()
            self.take(";")
            return ("assign", value, e)
        e = self.expr()
        self.take(";")
        return ("expr", e)

    # Expressions

    def expr(self):
        cond = self.binary(0)
        if self.at("?"):
            self.take()
            a = self.expr()
            self.take(":")
            b = self.expr()
            return ("ternary", cond, a, b)
        return cond

    BINARY = [("||",), ("&&",), ("==", "!="), ("<", ">", "<=", ">="), ("+", "-"), ("*", "/")]

    def binary(self, level):
        if level == len(self.BINARY):
            return self.unary()
        left = self.binary(level + 1)
        while self.peek()[1] in self.BINARY[level]:
            _, op = self.take()
            right = self.binary(level + 1)
            left = ("binary", op, left, right)
        return left

    def unary(self):
        if self.at("!") or self.at("-"):
            _, op = self.take()
            return ("unary", op, self.unary())
        return self.postfix()

    def postfix(self):
        e = self.primary()
        while True:
            if self.at("("):
                e = ("call", e, self.arguments())
            elif self.at(".") or self.at("->"):
                _, sep = self.take()
                _, name = self.take()
                if self.at("("):
                    e = ("method", e, sep, name, self.arguments())
                else:
                    e = ("field", e, sep, name)
            else:
                return e

    def arguments(self):
        self.take("(")
        args = []
        while not self.at(")"):
            args.append(self.expr())
            if self.at(","):
                self.take()
        self.take(")")
        return args

    def primary(self):
        kind, value = self.take()
        if kind in ("dollar", "at", "string", "number"):
            return (kind, value)
        if kind == "name":
            return ("name", value)
        if value == "(":
            e = self.expr()
            self.take(")")
            return ("paren", e)
        if value == "{":
            items = []
            while not self.at("}"):
                items.append(self.expr())
                if self.at(","):
                    self.take()
            self.take("}")
            return ("init", items)
        raise TranslateError(f"unexpected {value!r}")


# ---------------------------------------------------------------------------
# Rust emitter
# ---------------------------------------------------------------------------

FREE_FUNCTIONS = {
    "Attr": "attr",
    "Null": "null",
    "Bool": "bool_node",
    "Const": "const_node",
    "Enum": "enum_node",
    "Operator": "operator_node",
    "NameFromIdentifier": "name_from_identifier",
    "Merge": "merge_join",
    "Into": "into_node",
    "ColumnRef": "column_ref",
    "Negate": "negate",
    "VarArgField": "vararg_field",
}

CTX_METHODS = {
    "List": "list",
    "Expression": "expression",
    "NameFromKeyword": "name_from_keyword",
    "NameFromStringLiteral": "name_from_string_literal",
    "TrailingDot": "trailing_dot",
    "ReadFloatType": "read_float_type",
    "RequireAdjacent": "require_adjacent",
    "RequireOperator": "require_operator",
    "AddStatement": "add_statement",
    "ResetStatement": "reset_statement",
    "MarkVisSpecSpan": "mark_vis_spec_span",
    "IsVisEnabled": "is_vis_enabled",
}

LIST_METHODS = {
    "push_back": "push_back",
    "push_front": "push_front",
    "empty": "list_is_empty",
}

WIDTH = 110


class Emitter:
    def __init__(self):
        # $n that an action assigns to, bound to mutable locals
        self.locals = {}

    def name(self, n):
        parts = [p for p in n.split("::") if p not in NAMESPACES]
        if n.startswith("std::"):
            raise TranslateError(f"unsupported std name {n}")
        name = "::".join(parts)
        if name in RUST_KEYWORDS:
            name = "r#" + name
        return name

    def list_arg(self, e, indent):
        """An argument that is a node list: an initializer list or a list expression."""
        if e[0] == "init":
            if not e[1]:
                return "NO_NODES"
            return "&" + self.items("[", "]", e[1], indent)
        return self.expr(e, indent)

    def items(self, open_, close, items, indent):
        parts = [self.expr(i, indent + 4) for i in items]
        inline = open_ + ", ".join(parts) + close
        if len(inline) + indent <= WIDTH and "\n" not in inline:
            return inline
        pad = " " * (indent + 4)
        return open_ + "\n" + "".join(f"{pad}{p},\n" for p in parts) + " " * indent + close

    def args(self, args, indent):
        return self.items("(", ")", args, indent)

    def unmove(self, e):
        while e[0] == "call" and e[1] == ("name", "std::move"):
            if len(e[2]) != 1:
                raise TranslateError("std::move with multiple arguments")
            e = e[2][0]
        return e

    def expr(self, e, indent=8):
        e = self.unmove(e)
        kind = e[0]
        if kind == "dollar":
            if e[1] == "$$":
                return "yyval"
            return self.locals.get(e[1], e[1])
        if kind in ("at", "string", "number"):
            return e[1]
        if kind == "name":
            if e[1] in ("true", "false"):
                return e[1]
            return self.name(e[1])
        if kind == "paren":
            return "(" + self.expr(e[1], indent) + ")"
        if kind == "unary":
            return e[1] + self.expr(e[2], indent)
        if kind == "binary":
            return f"{self.expr(e[2], indent)} {e[1]} {self.expr(e[3], indent)}"
        if kind == "ternary":
            return f"if {self.expr(e[1], indent)} {{ {self.expr(e[2], indent)} }} else {{ {self.expr(e[3], indent)} }}"
        if kind == "init":
            raise TranslateError("initializer list outside of a list argument")
        if kind == "call":
            return self.call(e, indent)
        if kind == "method":
            return self.method(e, indent)
        raise TranslateError(f"unsupported expression {kind}")

    def call(self, e, indent):
        callee, args = e[1], e[2]
        if callee[0] != "name":
            raise TranslateError("call of a non-name")
        fn = callee[1]
        if fn == "Loc":
            if len(args) != 1 or args[0][0] != "init":
                raise TranslateError("Loc expects an initializer list")
            return "loc(&" + self.items("[", "]", args[0][1], indent) + ")"
        if fn == "Concat":
            if len(args) < 2 or len(args) > 4:
                raise TranslateError("Concat arity")
            parts = [self.list_arg(a, indent + 4) for a in args]
            return f"ctx.concat{len(args)}" + self.raw_args(parts, indent)
        if fn == "Expr":
            if self.expr(args[0]) != "ctx":
                raise TranslateError("Expr expects ctx")
            rest = args[1:]
            if rest and rest[-1] == ("name", "PostFix"):
                return "expr_postfix" + self.args([args[0]] + rest[:-1], indent)
            arity = len(rest) - 2
            return f"expr{arity}" + self.args(args, indent)
        if fn == "IndirectionIndex":
            name = "indirection_index" if len(args) == 3 else "indirection_index_bounds"
            return name + self.args(args, indent)
        if fn == "error":
            return "ctx.error" + self.args(args, indent)
        if fn in FREE_FUNCTIONS:
            return FREE_FUNCTIONS[fn] + self.args(args, indent)
        raise TranslateError(f"unknown function {fn}")

    def raw_args(self, parts, indent):
        inline = "(" + ", ".join(parts) + ")"
        if len(inline) + indent <= WIDTH and "\n" not in inline:
            return inline
        pad = " " * (indent + 4)
        return "(\n" + "".join(f"{pad}{p},\n" for p in parts) + " " * indent + ")"

    def method(self, e, indent):
        target, sep, name, args = e[1], e[2], e[3], e[4]
        target = self.unmove(target)
        if target == ("name", "ctx") and sep == ".":
            if name in ("Object", "Array"):
                fixed = 3 if name == "Object" else 2
                head = [self.expr(a, indent + 4) for a in args[: fixed - 1]]
                parts = head + [self.list_arg(args[fixed - 1], indent + 4)]
                extra = [self.expr(a, indent + 4) for a in args[fixed:]]
                fn = name.lower()
                if extra:
                    while len(extra) < 2:
                        extra.append("false")
                    fn += "_ex"
                return f"ctx.{fn}" + self.raw_args(parts + extra, indent)
            if name == "List":
                if not args:
                    return "ctx.list(NO_NODES)"
                return "ctx.list" + self.raw_args([self.list_arg(a, indent + 4) for a in args], indent)
            if name in CTX_METHODS:
                return f"ctx.{CTX_METHODS[name]}" + self.args(args, indent)
            raise TranslateError(f"unknown ctx method {name}")
        if sep == "->" and name in LIST_METHODS:
            parts = [self.expr(target, indent + 4)] + [self.expr(a, indent + 4) for a in args]
            return f"ctx.{LIST_METHODS[name]}" + self.raw_args(parts, indent)
        raise TranslateError(f"unsupported method {name}")

    def statements(self, stmts, indent):
        """Emit statements, returning (lines, has_result)."""
        lines = []
        pad = " " * indent
        result_at = [i for i, s in enumerate(stmts) if s[0] == "result"]
        if len(result_at) > 1:
            raise TranslateError("multiple $$ assignments")
        for i, s in enumerate(stmts):
            kind = s[0]
            last = i == len(stmts) - 1
            if kind == "comment":
                lines.append(pad + s[1])
            elif kind == "result":
                value = self.expr(s[1], indent)
                if last:
                    lines.append(pad + value)
                else:
                    lines.append(f"{pad}let yyval = {value};")
            elif kind == "expr":
                lines.append(pad + self.expr(s[1], indent) + ";")
            elif kind == "assign":
                lines.append(f"{pad}{self.locals[s[1]]} = {self.expr(s[2], indent)};")
            elif kind == "let":
                lines.append(f"{pad}let {self.name(s[1])} = {self.expr(s[2], indent)};")
            elif kind == "yyerror":
                lines.append(pad + "return Err(ReduceError::YyError);")
            elif kind == "yyclearin":
                lines.append(pad + "ctx.clear_lookahead();")
            elif kind == "if":
                lines.extend(self.if_statement(s, indent))
            elif kind == "block":
                inner, _ = self.statements(s[1], indent + 4)
                lines.append(pad + "{")
                lines.extend(inner)
                lines.append(pad + "}")
            else:
                raise TranslateError(f"unsupported statement {kind}")
        if result_at and result_at[0] != len(stmts) - 1:
            lines.append(pad + "yyval")
        return lines, bool(result_at)

    def branch_value(self, branch, indent):
        """Emit an if branch that ends with `$$ = ...;` as a block producing a Value."""
        stmts = branch[1] if branch[0] == "block" else [branch]
        if not stmts or stmts[-1][0] != "result" or any(t[0] == "result" for t in stmts[:-1]):
            raise TranslateError("$$ must be the last statement of both branches")
        lines, _ = self.statements(stmts[:-1], indent + 4)
        lines.append(" " * (indent + 4) + f"Value::from({self.expr(stmts[-1][1], indent + 4)})")
        return lines

    def if_statement(self, s, indent):
        pad = " " * indent
        _, cond, then, other = s
        out = [f"{pad}if {self.expr(cond, indent)} {{"]
        then_stmts = then[1] if then[0] == "block" else [then]
        if any(t[0] == "result" for t in then_stmts):
            # Both branches set $$, the if is the value of the action.
            if other is None:
                raise TranslateError("$$ inside if without else")
            out.extend(self.branch_value(then, indent))
            out.append(pad + "} else {")
            out.extend(self.branch_value(other, indent))
            out.append(pad + "}")
            return out
        inner, _ = self.statements(then_stmts, indent + 4)
        out.extend(inner)
        if other is not None:
            other_stmts = other[1] if other[0] == "block" else [other]
            if any(t[0] == "result" for t in other_stmts):
                raise TranslateError("$$ inside else")
            inner, _ = self.statements(other_stmts, indent + 4)
            out.append(pad + "} else {")
            out.extend(inner)
        out.append(pad + "}")
        return out


def assigned_dollars(stmts):
    out = []
    for s in stmts:
        if s[0] == "assign":
            out.append(s[1])
        elif s[0] == "block":
            out += assigned_dollars(s[1])
        elif s[0] == "if":
            out += assigned_dollars([s[2]] + ([s[3]] if s[3] else []))
    return out


def translate_action(code, column):
    """Translate a C++ action `{ ... }` into a Rust block."""
    body = code[1:-1]
    stmts = Parser(tokenize(body)).statements()
    emitter = Emitter()
    if not stmts:
        return "{}"
    assigned = sorted(set(assigned_dollars(stmts)))
    if assigned:
        pad = " " * (column + 4)
        prologue = [f"{pad}let mut yy_{d[1:]} = {d};" for d in assigned]
        emitter.locals = {d: f"yy_{d[1:]}" for d in assigned}
        lines, _ = emitter.statements(stmts, column + 4)
        return "{\n" + "\n".join(prologue + lines) + "\n" + " " * column + "}"
    if len(stmts) == 1 and stmts[0][0] == "result":
        value = emitter.expr(stmts[0][1], column)
        if "\n" not in value and len(value) + column < WIDTH:
            return "{ " + value + " }"
    lines, _ = emitter.statements(stmts, column + 4)
    if len(lines) == 1 and len(lines[0].strip()) + column < WIDTH:
        return "{ " + lines[0].strip() + " }"
    return "{\n" + "\n".join(lines) + "\n" + " " * column + "}"


def translate_file(text, path):
    out = []
    line_start = 0
    for kind, segment in split_actions(text):
        if kind == "text":
            out.append(segment)
            continue
        # The indentation of the line the action starts on
        emitted = "".join(out)
        last_line = emitted[emitted.rfind("\n") + 1 :]
        column = len(last_line) - len(last_line.lstrip())
        try:
            out.append(translate_action(segment, column))
        except TranslateError as e:
            line = emitted.count("\n") + 1
            raise TranslateError(f"{path}:{line}: {e}\n{segment}") from None
    return "".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output_dir", required=True)
    parser.add_argument("rule_files", nargs="+")
    args = parser.parse_args()
    failures = 0
    for path in args.rule_files:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        try:
            translated = translate_file(text, path)
        except TranslateError as e:
            print(e, file=sys.stderr)
            failures += 1
            continue
        header = (
            "// Generated by //grammar/rust:translate_actions.py from grammar/rules/" + os.path.basename(path) + ".\n"
            "// DO NOT EDIT.\n\n"
        )
        with open(os.path.join(args.output_dir, os.path.basename(path)), "w", encoding="utf-8") as f:
            f.write(header + translated)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
