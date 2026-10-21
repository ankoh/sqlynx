# Core Parser

The DashQL parser transforms source text into a flat, FlatBuffer-serializable AST.
It runs in two phases—scanning then parsing—and produces a contiguous array of fixed-size nodes rather than a heap-allocated tree.

It lives in `packages/dashql-parser`: the scanner in `src/scanner.rs`, the LR driver, parse context and action helpers in `src/parser/`.
Bison compiles `grammar/rules/*.y` into tables and Rust actions (`//grammar:parser_tables_rs`).
The parser was ported from the C++ core; some names below still mention the C++ originals.

## Architecture Overview

```
Source text
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ Scanner (logos)                                     │
│  - Tokenizes into ScannedScript::symbols            │
│  - Resolves identifiers vs keywords                 │
│  - Performs 1-token lookahead to emit NOT_LA,       │
│    NULLS_LA, WITH_LA for LALR(1) compatibility      │
│  - Tracks line breaks, comments, name registry      │
└─────────────────────────────────────────────────────┘
    │
    │  ScannedScript (all tokens materialized)
    ▼
┌─────────────────────────────────────────────────────┐
│ Parser (Bison LALR(1))                              │
│  - Consumes the pre-scanned token buffer            │
│  - Grammar actions build nodes using projection     │
│    helpers (object, array, list, attr, expr2, …)    │
│  - Nodes are appended to a Vec<Node>                │
│  - Statements are finalized via add_statement()     │
└─────────────────────────────────────────────────────┘
    │
    │  ParsedScript { nodes: Vec<Node>, statements: Vec<Statement> }
    ▼
  FlatBuffer serialization (parsed_script.fbs)
```

## Flat AST Design

### The Node struct

Every AST node is a fixed-size 24-byte FlatBuffer struct (`proto/fb/dashql/parsed_script.fbs`):

```
struct Node {
    symbol_span: SymbolSpan;        // 8 bytes: {offset, length} in token-index space
    node_type: NodeType;            // 2 bytes
    attribute_key: AttributeKey;    // 2 bytes
    parent: uint32;                 // 4 bytes: index into the node array
    children_begin_or_value: uint32;// 4 bytes: first child index, or inline scalar
    children_count: uint32;         // 4 bytes
}
```

All nodes live in a single flat vector.
Parent/child relationships are encoded as array indices—`children_begin_or_value` points to the first child, the next `children_count` consecutive nodes are the children.
When a node is a leaf (literal, enum, name), `children_begin_or_value` stores the value inline instead (e.g., a name ID or boolean).

### Node kinds

Nodes are categorized by their `NodeType`:

| Category | Examples | Children |
|----------|----------|----------|
| Terminals | `NAME`, `BOOL`, `LITERAL_INTEGER`, `LITERAL_STRING`, `OPERATOR` | None; value in `children_begin_or_value` |
| Enums | `ENUM_SQL_JOIN_TYPE`, `ENUM_SQL_EXPRESSION_OPERATOR`, … | None; enum discriminant in `children_begin_or_value` |
| Arrays | `ARRAY` | Children are ordered elements |
| Objects | `OBJECT_SQL_SELECT`, `OBJECT_SQL_COLUMN_REF`, … | Children are attribute nodes (keyed by `attribute_key`) |

### Attribute encoding

Object children carry an `attribute_key` that names their role within the parent.
For example, a SELECT object's children might be:

```
[parent] NodeType: OBJECT_SQL_SELECT
    ├─ [child 0] attribute_key: SQL_SELECT_TARGETS, node_type: ARRAY
    ├─ [child 1] attribute_key: SQL_SELECT_FROM,    node_type: ARRAY
    └─ [child 2] attribute_key: SQL_SELECT_WHERE,   node_type: OBJECT_SQL_NARY_EXPRESSION
```

Null (omitted) attributes are simply not stored—the parser uses `Null()` which produces `NodeType::NONE` and gets filtered out when materializing.

### Statements

Each top-level statement is tracked in a `Statement` record:

```
table Statement {
    statement_type: StatementType;  // SELECT, CREATE_TABLE, VIS_VISUALISE, …
    root_node: uint32;              // Index of root node
    nodes_begin: uint32;            // First node index belonging to this statement
    node_count: uint32;             // Total nodes in the statement
}
```

The node array is partitioned by statement—each statement owns a contiguous slice.

## Grammar Assembly

The grammar is modular and assembled at build time by `grammar/assemble_grammar.py`.
The final `.y` file is composed in this order:

1. **Prologue** (`prologue.y`) — Rust skeleton options (`api.rust.*`), the `use` of the action helpers, token declarations
2. **Keyword token declarations** — generated from `lists/*.list` files
3. **Precedences** (`precedences.y`) — operator precedence and associativity
4. **Type declarations** (`rules/*.yh`) — `%type` directives mapping nonterminals to Rust types
5. **`%%`** — start of rules section
6. **Keyword identity rules** — generated pass-through rules for keyword categories
7. **Rule files** (`rules/*.y`) — the actual grammar productions
8. **`%%`** — end

### Rule files

| File | Scope |
|------|-------|
| `ext_statement.y` | Top-level dispatch: `statement → sql_query_statement` |
| `sql_select.y` | SELECT, set operations, expressions, types (~110 KB) |
| `sql_create.y` | CREATE TABLE |
| `sql_view.y` | CREATE VIEW |
| `sql_function.y` | CREATE FUNCTION, function calls |
| `ext_visualize.y` | VISUALISE extension |
| `ext_set.y` | SET variable statements |
| `ext_varargs.y` | Nested key/value field syntax |
| `ext_explain.y` | EXPLAIN wrapper |

### Type files (`.yh`)

Each rule file has a companion `.yh` declaring the Bison `%type` for its nonterminals.
The three main semantic value types (`src/parser/value.rs`) are:

- **`Node`** — a single materialized node (terminal, object, enum)
- **`NodeList`** — the id of a temporary list of nodes in the parse context (not yet committed to the node array)
- **`ExprVariant`** — either a `Node` or the id of an n-ary expression (allows flattening chains of AND/OR)

## Bison Projections

Grammar actions construct nodes through helpers defined in `src/parser/actions.rs` and `ParseContext` (`src/parser/context.rs`).
The term "projection" refers to the pattern of mapping a grammar production into flat AST nodes.

### Core helpers

```rust
// Wrap a node with an attribute key
attr(key: AttributeKey, node: Node) -> Node

// Allocate a temporary working list
ctx.list(&[node1, node2, …]) -> NodeList

// Materialize a list into a contiguous ARRAY node
ctx.array(loc, list) -> Node

// Materialize attributes into an OBJECT node
ctx.object(loc, node_type, &[attr1, attr2, …]) -> Node

// Concatenate temporary lists
ctx.concat2(list1, &[extra_attrs…]) -> NodeList
```

### Projection patterns

**Pattern 1: Direct object construction**

When a rule maps directly to one AST object:

```bison
sql_common_table_expr:
    sql_name LRB sql_name_list RRB AS LRB sql_preparable_stmt RRB {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_CTE,
            &[
                attr(Key::SQL_CTE_NAME, $1),
                attr(Key::SQL_CTE_COLUMNS, ctx.array(@3, $3)),
                attr(Key::SQL_CTE_STATEMENT, $7),
            ],
        )
    }
```

**Pattern 2: Deferred object construction via lists**

SELECT statements accumulate attributes across multiple productions using `list` and `concat2`, deferring `object()` to the top:

```bison
sql_simple_select:
    SELECT sql_opt_all_clause sql_opt_target_list sql_into_clause sql_from_clause sql_where_clause … {
        ctx.list(
            &[
                attr(Key::SQL_SELECT_ALL, $2),
                attr(Key::SQL_SELECT_TARGETS, ctx.array(@3, $3)),
                attr(Key::SQL_SELECT_INTO, $4),
                attr(Key::SQL_SELECT_FROM, ctx.array(@5, $5)),
                attr(Key::SQL_SELECT_WHERE, $6),
                …
            ],
        )
    }

sql_classical_select_no_parens:
    sql_select_clause sql_sort_clause { ctx.concat2($1, &[attr(Key::SQL_SELECT_ORDER, $2)]) }

// Final materialization at the top-level dispatch:
sql_query_statement:
    sql_select_stmt { ctx.object(@$, NodeType::OBJECT_SQL_SELECT, $1) }
```

This avoids intermediate object allocations for partial SELECT parse states.

**Pattern 3: Expression flattening**

Binary expressions like `a AND b AND c` are represented as a single n-ary node rather than nested binary trees.
The expression helpers check whether adjacent expressions share the same operator and collapse them:

```bison
sql_a_expr:
    sql_a_expr AND sql_a_expr { expr2(ctx, @$, enum_node(@2, ExprFunc::AND), $1, $3) }
```

If both operands are already AND-chains, `expr2` merges their argument lists into a single `OBJECT_SQL_NARY_EXPRESSION` with one flat args array.
The intermediate n-ary expression lives in an arena of the parse context and is only materialized into the node array at the end via `ctx.expression()`.

**Pattern 4: Terminal construction**

Leaf values are constructed inline without touching the node array:

```rust
const_node(loc, AConstType::INTEGER)       // literal with type tag
bool_node(loc, true)                       // inline boolean
enum_node(loc, ExpressionOperator::NEGATE) // enum discriminant
name_from_identifier(loc, name_id)         // name referencing the name registry
operator_node(loc)                         // operator marker (text from source)
```

These return `Node` values that only get committed when passed to `array()` or `object()`.

## Scanner / Lexer

### Two-phase tokenization

The scanner runs **completely before parsing begins**.
All tokens are materialized into `ScannedScript::symbols` (a `Vec<Symbol>`).
The parser then iterates this buffer.

This design enables:
- The parser can recover from errors without re-scanning
- Token metadata (types, offsets) is available for syntax highlighting independent of parsing
- Lookahead disambiguation happens once during scanning

### logos lexers

The scanner (`packages/dashql-parser/src/scanner.rs`) was ported from a flex scanner and keeps its rules and start conditions.
Every start condition is a `#[derive(Logos)]` enum that matches bytes; the actions (`yyless`, state switches, nested comments) are hand-written around them.

Key characteristics:
- **No global state** — a scan is a plain function call (`scan`)
- **Case-insensitive** — keywords matched regardless of case; the patterns spell out both cases

### Exclusive states

The scanner uses exclusive states for multi-character tokens:

| State | Purpose |
|-------|---------|
| `<xb>` | Bit string literals (`B'...'`) |
| `<xc>` | C-style block comments |
| `<xd>` | Double-quoted identifiers |
| `<xbt>` | Backtick-quoted identifiers |
| `<xh>` | Hex string literals (`X'...'`) |
| `<xq>` | Standard single-quoted strings |

### Identifier resolution

When the scanner matches an unquoted identifier, it:
1. Lower-cases the text
2. Looks it up in the keyword table (`Keyword::find`, generated by `//grammar:keywords_rs`)
3. If found: returns the keyword token with the canonical spelling
4. If not found: registers the name in `ScannedScript::name_registry` and returns `IDENT` with the name ID

### Lookahead rewrites

Some tokens require 1-token lookahead to resolve LALR(1) conflicts.
The scanner wraps the raw lexer with a lookahead filter (`next_symbol` in `scanner.rs`):

- `NOT` → `NOT_LA` when followed by `BETWEEN`, `IN`, `LIKE`, `ILIKE`, `SIMILAR`
- `NULLS` → `NULLS_LA` when followed by `FIRST` or `LAST`
- `WITH` → `WITH_LA` when followed by `TIME` or `ORDINALITY`

## Location Tracking

### SymbolSpan

Locations are represented as `SymbolSpan { offset: uint32, length: uint32 }`.

During **scanning**, offset/length refer to byte positions in the source text.
During **parsing**, the parser remaps locations to **token indices**—each token is stamped with `SymbolSpan(next_token_index, 1)`.
This means parse-time `@N` locations reference positions in the token stream, not the source text.

The scanner-phase byte locations are preserved in the `ScannerTokens` table (`token_offsets`, `token_lengths`) so downstream consumers can map back to source positions.

### Default location

Bison's default location merge (`YYLLOC_DEFAULT`) is replaced by `default_location` in `src/parser/driver.rs`:

```rust
fn default_location(rhs: &[SymbolSpan], below: SymbolSpan) -> SymbolSpan {
    match (rhs.first(), rhs.last()) {
        (Some(first), Some(last)) => SymbolSpan::new(
            first.offset(),
            last.offset().wrapping_add(last.length()).wrapping_sub(first.offset()),
        ),
        _ => SymbolSpan::new(below.offset().wrapping_add(below.length()), 0),
    }
}
```

For a non-empty production, the result span covers from the first symbol's start to the last symbol's end.
For an empty production, the span is zero-length positioned after the preceding symbol.

### Manual span merging

When a grammar action needs a span that doesn't match the full production (e.g., just the parenthesized portion), `loc()` merges arbitrary spans:

```rust
loc(&[@2, @3, @4])  // span covering symbols 2 through 4
```

## Memory Management

### Node array

Nodes are stored in a `Vec<Node>` of the parse context and referenced by index, so growth never invalidates them.

### Arenas

Semantic values are `Copy`. Working structures that are discarded after materialization live in arenas of the parse context and are referenced by id:

- node lists (`NodeList`)
- intermediate n-ary expression chains (`ExprVariant::Nary`)

Consumed lists are recycled, which avoids heap allocations during parsing.

### Materialization

Working lists (`NodeList`) are "materialized" when passed to `ctx.array()` or `ctx.object()`.
Materialization walks the list, appends each non-null node to the node array, sets parent pointers, and returns a single `Node` whose `children_begin_or_value` points to the start of the newly appended range.
After materialization, the list is returned to the arena for reuse.
