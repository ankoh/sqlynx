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

## Test infrastructure

- **Unregistered parser snapshots.** The C++ parser snapshot suite
  (`packages/dashql-core/test/parser_snapshot_test_suite.cc`) never registers `error_recovery.yaml`,
  `functions.yaml`, `sql_function.yaml` and `tpch_schema.yaml` (18 cases). They are still up to date:
  `//packages/dashql-core-rs:oracle_parser_snapshot_test` replays all 506 parser cases.
