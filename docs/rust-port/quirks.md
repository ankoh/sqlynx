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

## Analyzer (`packages/dashql-core/src/analyzer/`)

- **The analyzer modifies the scanned script.** `AnalysisState` registers an empty name in the
  scanner's name registry and writes analyzer tags and resolved objects into the scanned names, which
  forces `Script::AnalyzeInternal` to rescan before reanalyzing. The Rust analyzed script owns a copy
  of the names (`AnalyzedScript::names`, `name_tags`, `name_objects`) and leaves the scan untouched.
- **CREATE TABLE columns are sorted with the unstable `std::sort`.** Duplicate column names in tables
  with more than 16 columns may be ordered differently in C++. Rust sorts stably.
- **`AND`/`OR` over constants become binary expressions with function `UNKNOWN`**, because
  `ReadBinaryExpressionFunction` has no mapping for them.
- **Function calls without arguments are constant but never constant roots.** Only calls with
  arguments are added to the constant list.
- **Unreadable qualified function names throw.** `IdentifyFunctionCallsPass` calls `value()` on the
  empty optional of a function name path it cannot read, which throws `std::bad_optional_access` out
  of the analysis. Rust returns an error.
- **Root scopes iterate like `ankerl::unordered_dense::set`**: in insertion order, and erasing moves
  the last element into the hole. Name resolution visits the roots in that order.

## Completion (`packages/dashql-core/src/analyzer/completion.cc`)

- **Candidates are ranked with the unstable `std::sort`.** `TopKHeap` sorts the candidates (score,
  then case-insensitive name) and the catalog objects of a candidate (score only), so ties come out
  in introsort order. `dashql_core::utils::sort::std_sort` reproduces the libstdc++ algorithm;
  libc++ (the C++ wasm build) orders ties differently.
- **A candidate scores with its lowest top object.** `SelectTopCandidates` takes the score of the
  last of the descending top 24 catalog objects.
- **Spans mix text offsets and token indexes.** Candidate target locations are `SymbolSpan`s holding
  text offsets, and keyword-registered names keep token indexes in their text location, which the
  "is it the cursor symbol" check compares with text offsets.
- **A dot at the begin of the cursor symbol never completes.** The switch in `Compute` falls through
  from `BEGIN_OF_SYMBOL` into the `return`.
- **The analysis of one script can attach objects to the names of another one.** Derived tables
  (`CREATE VIEW v AS SELECT * FROM t`) push their columns into the resolved objects of the names they
  copy, which can be names of a catalog entry. The Rust analyzer only records objects for the name
  index of its own script.
- **Table refs are promoted through the catalog only.** `PromoteIdentifiersInScope` resolves the
  tables of the scope with `Catalog::ResolveTable`, so tables of the script being edited are only
  promoted once that script is loaded into the catalog.
- **The snapshot encoder reads the target symbol unconditionally**, which completions inside comments
  do not have. The oracle reports them as `no-target`.

## Visualize (`packages/dashql-core/src/visualize/`)

**Vega-Lite generator** (`vegalite_generator.cc`)
- String array elements have their quotes stripped, `''` is not unescaped.
- Integer literals in arrays are JSON integers if their double value is an integer in the int64 range,
  doubles otherwise.
- The top-level spec writes `resolve` before `layer`, nested layers `layer` before `resolve`.

**Vega-Lite parser** (`vegalite_parser.cc`)
- Doubles that are not integral or are at least 1e15 are printed with `%g` (6 significant digits). **Not reproduced:** Rust writes the shortest round-trip digits, the differential test compares at 6 digits.
- `ToSnakeCase("Field")` gives `field`, which then counts as an identifier key.
- A mark object with only `type` collapses to `mark => type`, an empty bin object becomes `true`.
- An empty `$sql` does not fall back to `$raw`.

**Markdown** (`markdown.cc` and md4c 0.5.2). **Not reproduced:** the Rust core parses templates with
pulldown-cmark (see the README), and the differential test compares the documents by meaning. md4c
behavior that differs:
- Text nodes are cut at every resolved mark and never merged.
- `md_text_with_null_replacement` does not advance past a NUL, which also starts the next text node.
- The empty-list-item check reads the last 8 bytes of the block stream as a block header, so a list
  item paragraph whose last line starts at offset 4 (mod 256) followed by two blank lines ends the
  list (`-   a\n\n\n    b`).
- A fence closes the fenced code block of a list item even if it is indented less than the item
  content (`` - ```\n  a\n ```\n- b ``).
- Tabs in indented code blocks are expanded to spaces.
- A code span that starts in a link destination wins over the link (`` [a](`b)` ``).
- The trailing whitespace of a paragraph at the end of the document is kept.
- `md_line_contains` misses an HTML end marker that ends at the end of the document.
- HTML block type 4 starts with `<!` and any ASCII character; `<header>` matches `head` first, fails,
  and becomes type 7, which cannot interrupt a paragraph.
- An autolink scheme only needs an ASCII first character.
- An empty ordered list item interrupts a paragraph.

**Not reproduced.** The Rust core reads and writes JSON with serde_json and parses numbers of the
script with `str::parse::<f64>`. These C++ behaviors are gone; the visualize differential test skips
the inputs that hit them:
- Text from the script (field names, `$sql`, array strings, stack and resolve values, bounds) was cut
  at the first NUL (`c_str()`), and so were strings of parsed specs (`GetString()`).
- Bounds and numeric options were numbers when glibc `strtod` consumed the whole text: empty text
  became 0, hex floats and `nan(...)` were numbers. Rust takes the number syntax of `str::parse::<f64>`.
- NaN and infinity made the rapidjson writer fail after the key (`"rangeMax": ,`). Rust writes `null`.
- Axis and legend `zindex` values outside int32 became INT32_MIN (`static_cast<int32_t>` is
  `cvttsd2si` on x86-64). Rust saturates.
- The Vega-Lite parser read rapidjson's default dialect: no UTF-8 validation, lone low surrogates
  decoded into invalid UTF-8, a NUL ended the input. Duplicate keys were looked up by their first
  member and iterated all; serde_json keeps the last one.

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

## Plan view model (`packages/dashql-core/src/view/`)

- **Root order follows heap addresses** (`FlattenOperators`): roots are placed in the iteration order
  of an `std::unordered_map` keyed by node address. Rust uses reverse plan order, which matches
  libstdc++ for up to two roots and unless hash buckets collide.
- **Fragment order.** Execution-target fragments come in reverse root order, before federate fragments.
- **Lookups.** `FindNumber` stops at the first existing name even if it is not a number, a non-array
  `earlyProbes` blocks the `early-probes` fallback, pipeline operator lists keep duplicates, and
  pipeline edge ids count across pipelines.

**Not reproduced.** The Rust core reads plans as standard JSON with serde_json. The C++ core parses
them with rapidjson (comments, NaN and infinity, trailing commas, imprecise number parsing):
- Comments, `NaN`/`Inf`/`Infinity`, trailing commas and input after a NUL byte are parse errors.
  Lone surrogates (`\uDC00`) are parse errors; C++ decoded lone low surrogates into invalid UTF-8.
- Strings keep NUL characters; C++ read attribute names, operator types and labels as C strings, so
  `"operator\u0000x"` counted as `operator`.
- Duplicate keys keep the last value; C++ kept all members and looked up the first.
- Numbers are read with full precision, `-0` is the double -0.0 (C++: integer 0).
- Counts in the runtime statistics that are not unsigned integers are ignored, `sqlpos` entries that
  are not unsigned 32-bit integers are 0. C++ asserted, release builds read the raw number storage.

## Script session (`packages/dashql-core/src/script_session.cc`)

- **Offset projection.** In UTF-8 mode, offsets are projected without checks. In UTF-16 mode, spans
  that are not on a code point boundary are dropped, including keyword names whose byte-span fields
  hold token indexes.
- **Scanner errors at the end of the file** are projected one byte past the text.
- **Field presence differs by offset unit.** In UTF-16 mode, completions and diffs go through an
  object API round trip, so empty strings and vectors are left out; in UTF-8 mode they are not.
- **Stale spans.** `PackDiff` and `RewriteDashboard` apply the spans of a possibly outdated parse to
  the current text. A diff span that is then not on a boundary is an error.
- **Table definitions** are sorted with libstdc++'s unstable `std::sort`.
- **Cursor bookkeeping.** `Analyze()` stamps the cursor versions even when placing the cursor failed;
  `Apply` does not.
- **`Format` allocates the entry id** before rejecting output that is not valid UTF-8 (comment
  wrapping can cut a character).
- **Text padding.** Spans that end past the text read the two NUL padding bytes of the text buffer.
  The Rust `script_diff` reads them the same way instead of panicking.

## Shell (`packages/dashql-core/src/shell/`)

- **Arrow values print like Arrow C++ 19 `Scalar::ToString`.** Binary columns print as raw bytes.
  Nested values embed `DataType::ToString` (`list<item: int32>[…]`, `{name:type = v}`,
  `union{f: t = v}`, `map<…>` with ` ('keys')`). A dictionary cell pretty-prints the whole
  dictionary followed by `[index]`. Half floats inside pretty printing show their raw int16 bits,
  durations print raw counts, `date64` truncates towards zero, out-of-range dates and times print
  `<value out of range: N>`, timestamps with a time zone get a trailing `Z` without conversion, and
  decimals with an out-of-range scale print a marker text.
- **Float ties** round to an even digit (double-conversion); Rust rounds them up, which is emulated.
- **Sliced sparse unions.** `IsNullSparseUnion` ignores the slice offset, so union elements inside
  lists, maps and structs take the null flag of another row.
- **Stale cursor row.** After prompt edits outside the terminal the cursor row is stale, and the
  cursor-down count of a submit wraps like `size_t`.
- **`\r\n` is one grapheme of width 0** in the prompt layout. Rust keeps this: clusters that start with a
  control character take no columns.
- **utf8proc 2.4** measures text with the grapheme rules of Unicode 12.1 and the width of the first code
  point of a cluster. Rust measures with `unicode-segmentation` and `unicode-width` and does not
  reproduce this.
- **Completion limit 0** trips an assertion in the C++ `TopKHeap`.
- **Up/Down at a CR LF line break** dereferences an empty `std::optional` in C++ (undefined
  behavior); Rust takes the boundary before it.
- **Invalid UTF-8 queries.** `StartQuery` returns `INTERNAL_ERROR` "rope input must contain valid
  UTF-8" after allocating a catalog entry id.

## Test infrastructure

- **Unregistered parser snapshots.** The C++ parser snapshot suite
  (`packages/dashql-core/test/parser_snapshot_test_suite.cc`) never registers `error_recovery.yaml`,
  `functions.yaml`, `sql_function.yaml` and `tpch_schema.yaml` (18 cases). They are still up to date:
  `//packages/dashql-core-rs:oracle_parser_snapshot_test` replays all 506 parser cases.

## Fixed in C++ before porting

Two bugs of the C++ analyzer snapshot encoder (`src/testing/analyzer_snapshot_test.cc`) were fixed.
Neither changed a checked-in snapshot:

- **Binary expression names were off by one.** The encoder looked up names by indexing the dense
  type table names with the enum value, but `BinaryExpressionFunction` skips the value 3. `MULTIPLY`
  printed as `DIVIDE`, `DIVIDE` as `MODULUS`, and `XOR` read past the end. It now uses
  `EnumNameBinaryExpressionFunction` (and `EnumNameComparisonFunction`).
- **Warnings without a symbol span crashed the encoder.** `MALFORMED_COMMENT_TAG` warnings only have
  a text span, and the encoder dereferenced the null symbol span.

The packed name scopes of `AnalyzedScript::Pack` carried corrupted id lists and were fixed: the
lists were built with `PushElement` of the `size_t` field `buffer_index` into `uint32` vectors, so the
readers saw the first half of the reversed 64-bit values, and `NameScope::buffer_index` was never
set, so child scopes were all 0. They are now the scope, expression and table reference ids in list
order. No TypeScript code read them.

**Removing an empty range at the end of a text with several leaves aborted the process.**
`Rope::Remove` descended into a leaf that does not contain the end of the text, and the `noexcept`
`LeafNode::RemoveCharRange` threw "UTF-8 codepoint index exceeds buffer". `ScriptSession::Apply`
removes an empty range before every insert, so typing at the end of a pure ASCII document of about
1 KB or more terminated the core. Empty removals are now a no-op (`RopeTest.RemovesEmptyRangeAtEndOfMultiLeafText`).
Found by `:session_differential_test`.

Hash-table-dependent behavior was also made deterministic:

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
