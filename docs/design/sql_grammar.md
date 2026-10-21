
# SQL Grammar

DashQL's SQL grammar is derived from the PostgreSQL grammar.
This document tracks deliberate deviations from upstream PostgreSQL.

## Trailing Dots

PostgreSQL's scanner emits a single `DOT` token for `.` regardless of context.
When a user is typing an incomplete qualified name like `schema.table.`, the parser sees the trailing dot followed by a token that cannot continue the indirection rule, and the parse fails.

DashQL splits the dot into two tokens in the scanner:

- **`DOT`** — a dot followed by a non-whitespace character (the common case: `a.b`)
- **`DOT_TRAILING`** — a dot followed by whitespace or EOF

The pattern `\.{space}` matches the trailing case in the scanner; the space is not consumed (the location is trimmed to length 1).
A helper rule `ext_dot_trailing` accepts either `DOT_TRAILING` or `DOT EOF` so both `a. ` and `a.<eof>` are covered.

The grammar then accepts `ext_dot_trailing` as a valid `sql_indirection_el`, producing a sentinel `TrailingDot` AST node.
Downstream, the completion engine recognizes trailing dots and offers completions for the namespace to the left.

**Files:**
- `packages/dashql-parser/src/scanner.rs` — `{raw_dot_trailing}` pattern (`Initial::DotTrailing`), `DOT_TRAILING` token
- `grammar/prologue.y` — `DOT_TRAILING` token declaration
- `grammar/rules/sql_select.y` — `ext_dot_trailing` rule, usage in `sql_indirection_el` and `sql_attrs`


## Backtick-Quoted Identifiers

PostgreSQL does not support backtick-quoted identifiers.
The backtick character is part of `op_chars` in the upstream grammar, meaning it can appear inside operator tokens.

DashQL removes the backtick from `op_chars` and adds a dedicated lexer state (`xbt`) that mirrors the existing double-quote identifier state (`xd`).
Backtick-quoted identifiers are case-preserving and produce the same `IDENT` token as double-quoted identifiers, so they work everywhere an identifier is accepted.

This allows DashQL to parse SQL dialects that use backticks for identifier quoting (MySQL, Spark, BigQuery) without requiring a dialect-specific lexer mode.

Embedded backticks are supported via doubling (``` `` ```), matching the MySQL convention.

**Files:**
- `packages/dashql-parser/src/scanner.rs` — `xbt` exclusive state (the `Xbt` lexer and `State::Xbt`), backtick removed from `{op_chars}`, the identifier is read by `identifier_stop`
