# Core Analyzer

The analyzer transforms a `ParsedScript` (a flat post-order AST buffer) into an `AnalyzedScript` enriched with semantic information such as resolved names, expression types, constants, and visualization specs.

## AST Layout and Left-to-Right Traversal

The parser emits AST nodes into a flat buffer in **post-order DFS** (children before parents, left siblings before right siblings). This means that for any node at index `i`, all of its children appear at indices `< i`.

The analyzer exploits this layout directly. Instead of walking a tree, it scans the buffer left to right. When a pass visits node `i`, every child has already been visited. Each pass maintains a parallel `node_states` vector and merges child state upward:

```cpp
void MergeChildStates(NodeState& dst, const Node& parent) {
    for (size_t i = 0; i < parent.children_count(); ++i) {
        auto child_id = parent.children_begin_or_value() + i;
        dst.Merge(std::move(node_states[child_id]));
    }
}
```

This gives every pass a bottom-up view of the tree without recursion or pointer chasing.

## Pass Manager

The `PassManager` runs all passes in a single interleaved sweep over the AST buffer. It processes nodes in **morsels** of 1024 nodes:

```
for each morsel in AST:
    for each pass:
        pass.Visit(morsel)
```

Each pass has three phases:
1. **Prepare** — allocate per-node state, initialize data structures.
2. **Visit** — called once per morsel, left to right; the pass inspects each node and accumulates state.
3. **Finish** — post-processing after all nodes have been visited (resolve names, deduplicate, index).

The interleaved morsel execution keeps all passes in cache proximity over the same set of nodes.

## Passes

All passes execute in a single sweep in this order:

| # | Pass | Purpose |
|---|------|---------|
| 1 | NameResolutionPass | Resolve table and column references |
| 2 | IdentifyFunctionCallsPass | Map function call expressions |
| 3 | ConstantPropagationPass | Identify constant sub-expressions |
| 4 | AnalyzeVisualizationPass | Extract visualization specs |

Later passes can depend on results from earlier passes via the shared `ExpressionIndex`. Because the morsel loop runs passes sequentially within each morsel, pass N sees the output of pass N-1 for the same morsel.

### 1. Name Resolution

The most complex pass. It operates in two stages:

**Stage A — Visit (bottom-up via buffer scan):**
During the left-to-right scan, the pass collects table references, column references, result targets, CTE definitions, and column definitions. At scope-creating nodes (`SELECT`, trailing `VISUALISE`, `CREATE TABLE`), it:
- Merges child state into a new `NameScope`
- Registers the scope's CTE definitions
- Links parent/child scope relationships
- Associates collected column and table refs with the scope

**Stage B — Finish (explicit scope tree traversal):**
After the buffer scan completes, `ResolveNames()` runs two DFS passes over the scope tree:

1. **Bottom-up (post-order):** For each scope, from leaves to root:
   - `ResolveTableRefsInScope` — resolve table names against CTEs (walking parent scopes) then the catalog
   - `ResolveColumnRefsLocally` — resolve column refs against tables in the same scope
   - `ResolveColumnRefsFromChildOutputs` — resolve against child scope output columns
   - `PopulateOutputColumns` — compute this scope's output columns from result targets

2. **Top-down (pre-order):** For remaining unresolved column refs:
   - `ResolveColumnRefsFromParents` — walk up parent scopes to resolve correlated subquery references

Column resolution resolves to one of:
- A `CatalogEntry::TableColumn` (physical table column from the catalog)
- A `ScopeColumn` (output column from a child scope or CTE)

### 2. Identify Function Calls

Recognizes `OBJECT_SQL_FUNCTION_EXPRESSION` nodes, extracts the qualified function name and argument expressions, and registers them in `analyzed->function_arguments`.

### 3. Constant Propagation

Bottom-up identification of constant expressions:
- Literal nodes (`NULL`, `INTEGER`, `FLOAT`, `STRING`, `INTERVAL`) are constant
- A cast or function call is constant if all its arguments are constant
- During Finish, collects non-redundant constant roots (roots whose parent is not also constant)

### 4. Analyze Visualization

Processes DashQL visualization AST nodes, extracting:
- The complete, self-contained classical `SELECT` query on the left side of
  `<query> VISUALIZE USING <renderer> (...)`
- Mark types (bar, line, point, etc.)
- Encoding channels (x, y, color, size, etc.) with their field references
- Scale, axis, and legend configuration

The query is retained as one AST source span and later executed verbatim. The
analyzer does not classify visualization sources or resolve them through
session script metadata. Standalone `VISUALIZE`, source-free visualization,
and the former `VISUALIZE <source> USING ...` form are rejected by the parser
and therefore never reach this pass. The cutover has no compatibility path in
the analyzer.

## Shared State

All passes share an `AnalysisState` struct containing:
- `scanned` / `parsed` / `ast` — the input script and its flat AST buffer
- `analyzed` — the output `AnalyzedScript` being built
- `catalog` — external table/function definitions for resolution
- `expression_index` — maps AST node IDs to their `Expression*`, enabling cross-pass communication (e.g., pass 3 can check if a node was tagged as a column ref by pass 1)

## Output

The `AnalyzedScript` contains:
- `name_scopes` — the scope tree with resolved table/column refs and output columns
- `table_references` / `table_declarations` — resolved table refs and DDL tables
- `expressions` — all semantic expressions (column refs, literals, comparisons, functions, etc.)
- `constant_expressions` — identified constant roots
- `visualization_specs` — extracted visualization configurations
- `node_markers` — parallel vector tagging AST nodes with their semantic role
- `errors` — analyzer diagnostics (ambiguous refs, duplicates, etc.)
