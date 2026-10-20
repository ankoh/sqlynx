# Known quirks of the C++ core

The Rust port reproduces the C++ core **bug for bug** until the switch-over, so that snapshots and the
differential oracle can demand zero differences. Every behavior that looks wrong but is kept on purpose
is listed here. After the switch-over, each one is fixed in Rust as an ordinary change with a snapshot
update.

Add an entry when you find another quirk while porting. Each entry names where the behavior lives in
the C++ core.

## Scanner (`grammar/scanner.l`, `packages/dashql-core/src/parser/scanner.cc`)

- **`1..` scans as FCONST.** The `{decimalfail}` rule returns FCONST for `1`, where Postgres returns
  ICONST.
- **Integer overflow stays ICONST.** `ReadInteger` falls back to FCONST only on `invalid_argument`, so
  integers that overflow int64 are still returned as ICONST.
- **`DOT_TRAILING` has length 1.** The rule matches `\.{space}`, but the token excludes the space.
- **Literals are right-trimmed.** String, hex and bit literals drop trailing whitespace that
  `quotestop` swallowed.
- **`DOT_DOT` and `RAW_CHAR` are emitted, but no rule uses them.** They always end up as syntax
  errors.
- **UTF-8 is passed through, not decoded.** Bytes `\200-\377` are identifier bytes, with no
  validation, and case folding is ASCII only.
- **Hyper obfuscation markers are case-sensitive** (`(?-i:)`), unlike the rest of the scanner.
- **Unimplemented forms.** No dollar-quoted strings, `E''`, `U&` or `N''`, although the scanner header
  comment mentions dollar quotes. Backslash has no special meaning in `'...'`, and quoted strings
  continue across a newline only for bit and hex strings.
- **`\r` is not recorded as a line break.**
- **Operators keep the wrong length after trimming.** The `{operator}` action calls `yyless(yyleng - nchars)`
  where Postgres calls `yyless(nchars)`. So `+--x` scans as a 2-byte PLUS followed by MINUS, and the
  comment is lost; `*/*` scans as a 2-byte STAR.
- **Literals swallow trailing comments.** `{quotestop}` includes trailing `{whitespace}`, comments included,
  and `Read*Literal` only trims spaces and `\n`. `'abc'  -- c` is an 11-byte SCONST, and the comment is
  never recorded.
- **Some line breaks are recorded twice.** A `{quotefail}` match records the line breaks of its whitespace,
  then `yyless(1)` puts that whitespace back and it is scanned again (`'a'\n-1`).
- **EOF is located at `(length, 1)`.** Errors of unterminated constructs therefore end one byte past the
  text.
- **Zero-length quoted identifiers still return an IDENT**, with an empty name, next to the error.

## Parser (`grammar/`, `packages/dashql-core/src/parser/`)

- **Keyword names carry token indexes as byte spans.** `NameFromKeyword` and `NameFromStringLiteral`
  register names with `TextSpan(symbol.offset, ...)`, which is a token index stored in a byte-span
  field. Scanner-registered names carry real byte offsets.
- **Lenient incomplete statements.** `SELECT a FROM` and `SELECT * FROM A WHERE` parse without errors,
  because `sql_from_clause: FROM` and `sql_where_clause: WHERE` accept a bare keyword.
- **`EOF` is part of rules.** The grammar shifts `EOF` inside rules (`ext_dot_trailing: DOT EOF`).
  Parsing can still finish because `NextSymbol` keeps returning EOF at the end of input.
- **Stale comment on `CollectExpectedSymbols`** (`parser.cc:93-102`). It describes a
  "length-1 default reduce" heuristic that the code does not implement.

## FlatBuffers enums (`proto/fb/dashql/parsed_script.fbs`)

- **`NodeType` ordinals are not cleanly ranged.**
  - `ENUM_VIS_ENCODING_CHANNEL`, `ENUM_VIS_MARK_TYPE`, `ENUM_VIS_FIELD_TYPE` and `ENUM_VIS_SCALE_TYPE`
    (114-117) sit above `OBJECT_KEYS_` (41), so the check "`> OBJECT_KEYS_` means object" is wrong
    for them. `script_diff.cc` special-cases them; other ordinal checks do not.
  - Many `OBJECT_SQL_*` types come after `VIS_OBJECT_KEYS_` (118).
  - Pinned by `//packages/dashql-core-rs:dashql_buffers_test`.

## Formatter (`packages/dashql-core/src/formatter/`)

- **Attribute lookup picks different duplicates** (`utils/ast_attributes.h` `LookupAttributes`). With
  one key it returns the first matching child; with several keys it returns the last match of each.
  The analyzer relies on the same helper.
- **Comment wrapping splits words at byte offsets** (`AppendWrappedCommentParagraph`) and can cut a
  UTF-8 character in half. `Formatter::format_bytes` returns the raw bytes.
- **Two whitespace sets in comments.** Trimming uses C `isspace` (including `\v`), word splitting
  uses `" \t\r\n\f"`.
- **Keyword upper-casing** (`AppendGeneratedText`) only touches exact lower-case keywords in
  generated text, so source `TRUE` or `Select` stay as written. Line widths count bytes.
- **`FormatNodeAt` does not mark statement roots**, so a CREATE TABLE formatted that way renders
  `'<OBJECT_SQL_CREATE>'`.
- **An empty property graph** formats as `Text("")`, a non-empty document.
- **Unformattable nodes** are recorded in visit order and can repeat.
- **Unknown enum values** are unformattable. `GetOperatorPrecedence` has no default case (undefined
  behavior); Rust returns precedence 0, non-associative. `ENUM_VIS_ENCODING_CHANNEL` is always
  unformattable.
- **Text past the end of the input.** C++ reads into the two padding NUL bytes after the text, Rust
  stops at the end. No differential input hits a difference.

## Test infrastructure

- **Unregistered parser snapshots.** The C++ parser snapshot suite
  (`packages/dashql-core/test/parser_snapshot_test_suite.cc`) never registers `error_recovery.yaml`,
  `functions.yaml`, `sql_function.yaml` and `tpch_schema.yaml` (18 cases). They are still up to date:
  `//packages/dashql-core-rs:oracle_parser_snapshot_test` replays all 506 parser cases.

## Fixed in C++ before porting

Behavior that depended on the hash table implementation was made deterministic in the C++ core first,
because native builds (libstdc++) and wasm builds (libc++) could disagree, and a port cannot reproduce
it. This changed one snapshot (`analyzer/names.yaml`):

- **Ambiguous column candidates are listed in FROM order.** `NameScope::referenced_tables_by_name` and
  `NameScope::cte_definitions` are `ankerl::unordered_dense::map`s, which iterate in insertion order.
- **Duplicate unqualified names resolve in declaration order.** `CatalogEntry::tables_by_unqualified_name`,
  `table_columns_by_name` and `functions_by_unqualified_name` are btree multimaps that keep the insertion
  order of equal keys.
- **Catalog-wide column lookups visit entries by rank** (`ResolveTableColumnsWithCatalog`).
- **The `FlatCatalog` name dictionary is built in rank order** (`Catalog::Flatten`).
