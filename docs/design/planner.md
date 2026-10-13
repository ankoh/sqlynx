# Planner

`dashql::Planner` builds a statement-level dependency DAG above the analyzer. It
consumes an ordered set of analyzed scripts without analyzing, publishing, or
modifying them. Notebook order, followed by statement order, defines the baseline
semantics; independent statements do not acquire source-order edges.

## Preparation and API

All inputs must share a catalog and have current parsing and analysis for both
their text and the catalog revision. Publish participating definitions before
refreshing every input's analysis. Publishing another script can invalidate an
earlier analysis, even if that script's text did not change.

The native API is `Planner::Plan(std::span<const PlannerInput>)`. Each input
contains only a borrowed live `Script*`; there is no caller-supplied revision.
The core-js API is:

```typescript
const buffer = dashql.plan(orderedSessions);
try {
    const graph = buffer.read().unpack();
    if (!graph.valid) {
        // Do not execute partial nodes from an invalid plan.
        throw new Error(graph.diagnostics.map(d => d.message).join('\n'));
    }
    // The unpacked graph owns its SQL and metadata independently of Wasm memory.
} finally {
    buffer.destroy();
}
```

Planning captures executable SQL, script IDs, text versions, catalog revisions, catalog
entities, unresolved references, accesses, edges, and diagnostics in
`execution_graph.fbs`. The authoritative native `Script::text_version` is the
single shared 64-bit text version; `ScriptSession::GetTextVersion()` derives it
from the script rather than maintaining an independent counter. Script metadata
records `text_version` directly from the live script, `analyzed_text_version` from
the text snapshot retained by analysis, and `analyzed_catalog_revision` captured
by analysis. Valid graphs have equal `text_version` and `analyzed_text_version`.
A plan is a snapshot, not a live view. Before execution, consumers must compare
each captured `(text_version, analyzed_catalog_revision)` pair for equality with
the corresponding current `(session.GetTextVersion(), catalog revision)` pair
and reject the graph if either value changed. Planning rejects missing or stale
input analysis with diagnostics and no executable partial nodes.

Each `ExecutionGraphEntity` requires a typed `catalog_object_id` struct containing
`object_type`, `object_id` (`uint64`), and `sub_object_id` (`uint32`). It also carries
`catalog_database_id`, `catalog_schema_id`, and the separate `database_name`,
`schema_name`, and `name` components. Identity is the typed catalog ID, not a name
or graph-local index. For TABLE, `object_id` is the packed native catalog table ID
and `sub_object_id` is zero. Views currently use TABLE declaration identities too.
The generic enum contains DEFERRED, DATABASE, SCHEMA, TABLE, COLUMN, and FUNCTION;
the current planner emits only real TABLE entities, never synthetic DEFERRED
entities for unresolved names.

`unresolved_references` is a separate vector of qualified name components with no
catalog identity. Accesses and non-barrier edges select exactly one target:
`entity` indexes `entities`, or `unresolved_reference` indexes
`unresolved_references`. The inactive field is `4294967295` (`UINT32_MAX`). Barrier
edges have both fields set to that sentinel. Node IDs and these target indices
are local to the graph. Edges point from prerequisites to dependents; a conflict
edge identifies the destination access's entity or unresolved reference.

For example, the unpacked core-js graph exposes typed IDs separately from vector
indices (64-bit IDs and revisions are JavaScript `bigint` values):

```typescript
const none = 0xffffffff;
for (const node of graph.nodes) {
    for (const access of node.accesses) {
        if (access.entity !== none) {
            const entity = graph.entities[access.entity];
            const id = entity.catalogObjectId!; // Required by the wire schema.
            console.log(id.objectType, id.objectId, id.subObjectId,
                        entity.catalogDatabaseId, entity.catalogSchemaId, entity.name);
        } else {
            const reference = graph.unresolvedReferences[access.unresolvedReference];
            console.log(reference.databaseName, reference.schemaName, reference.name);
        }
    }
}
```

The graph owns its SQL and metadata, not execution state, and does not imply that
database objects declared in the catalog already exist in the backend.

## Conflicts

For each qualified relation name, the planner remembers its last writer and the
readers since that writer. A read depends on the last writer. A write depends on
that writer and outstanding readers. DDL participates in the same conflict timeline, with
distinct DDL edge reasons. Repeated accesses within one statement are merged;
there are no self-edges for INSERT or DELETE statements reading their own destination.

Conflict grouping uses internal `(database, schema, name)` tuples so DROP and
recreation share a timeline without conflating their published entity identities.
CREATE, subsequent accesses, and DROP refer to the live declaration's catalog ID;
recreation has a distinct catalog ID, even within one script. Earlier accesses are
not rebound to the recreated declaration merely because refreshed analysis finds
that declaration. Repeated accesses to the same identity are merged, but a
statement reading an old declaration and creating a same-name new declaration
retains both identity accesses. Only conflict tracking merges those accesses by
qualified name, using the strongest mode.

DROP resolves against the live namespace, not future input declarations. An
unresolved DROP records an unresolved reference, not a synthetic catalog entity.
References to later producers are diagnosed rather than moving those producers
ahead of notebook order. CTE bindings are not catalog entities in this graph.

The current supported statement families are SELECT, INSERT, DELETE, EXPLAIN,
VISUALIZE, CREATE TABLE, CREATE TABLE AS, CREATE VIEW, SELECT INTO, DROP TABLE,
and DROP VIEW. Multiple outputs within a script are supported independently of
the sequential script compiler's terminal-output policy. INSERT and DELETE
produce output only when their root DML node has RETURNING. Nested DML RETURNING
never overrides the output classification of an enclosing EXPLAIN.

## Explain and Visualize

EXPLAIN always produces output, preserving its statement type and backend SQL.
Plain EXPLAIN treats all referenced relations as READ, including nested INSERT
and DELETE targets. The analyzer still retains the body's table references and
DML roles. Nested CREATE TABLE, CTAS, CREATE VIEW, and SELECT INTO declarations
are not registered as catalog tables, even when the analyzed script is published;
they cannot become planner producers or resolve later consumers.

Execution-enabled EXPLAIN of SELECT or expressions is supported. Options are
inspected structurally through `EXT_EXPLAIN_OPTIONS` and the generic option
key/value attributes, not by searching the whole SQL text. `analyze` and `analyse`
enable execution unless their argument is an explicit boolean false; missing or
unknown arguments are conservative. `format analyze` (including quoted values)
also enables execution. Any enabling option wins over a disabling duplicate.
Execution-enabled EXPLAIN with a mutating body is an invalid barrier with the
diagnostic `execution-enabled EXPLAIN with a mutating body cannot be safely classified`
and no backend SQL. Its nested DML target accesses remain WRITE for diagnostic
dependency tracking, but consumers must not execute any node of an invalid graph.
An ordering barrier alone is not a proof that backend execution, DDL publication,
or session effects are safe.

VISUALIZE always produces output and keeps its `VIS_VISUALISE` statement type.
Backend SQL is only the already-parsed `VIS_VISUALISE_SELECT` child's source span;
descriptions and visualization syntax are excluded. Analyzer table reads, CTE
bindings, and conflict dependencies are preserved. This is raw backend SELECT
syntax, without whole-script compilation or dialect rewriting. Visualization
metadata and application rendering integration are not part of the planner API
yet. SELECT INTO within VISUALIZE is rejected with no backend SQL because its
mutation and session effects are not represented by this query lowering.

## Conservative Limits

Views are not expanded into underlying declarations yet. Reads and writes through
views, and unresolved physical relations, create barriers against all earlier and
later nodes. Such barriers have diagnostics but do not necessarily invalidate
the graph. Ambiguous references, stale inputs, malformed SQL, unsupported
statements, and recognized session/locking/constraint/graph effects invalidate it.
Execution-enabled mutating EXPLAIN and VISUALIZE SELECT INTO invalidate the graph.

This is relation-level planning, not a proof of arbitrary SQL side effects.
Opaque function effects, triggers, backend search-path behavior, and transaction
semantics require additional knowledge. A barrier alone does not guarantee
backend session affinity. TypeScript scheduling and connector admission limits
remain separate work; notably, one embedded Hyper connection cannot execute
concurrent operations.

## Tests

Planner snapshots contain ordered named scripts, optional external catalog SQL,
and expected native text versions, catalog revisions, entities, unresolved
references, nodes, accesses, edges, and diagnostics. Node identifiers are
structured: `id` is the graph-local node index, `script` is the fixture script
name, and `statement-id` is the zero-based statement index. Edge `from`/`to` and
diagnostic `node` fields refer to numeric node IDs. The same preparation and
encoding helper serves generation and comparison, including a repeated encoding
check for deterministic output.
Fixtures do not inject independent document revisions or default versions; script
`text-version` and `analyzed-text-version` come from native preparation and agree
for valid snapshots. Unit tests also round-trip versions above `2^32` through the
wire schema and reject stale script snapshots without executable partial plans.

Every entity and unresolved reference is emitted in graph vector order. TABLE
snapshot IDs follow the analyzer's quoted `database-id.schema-id.object-id`
notation. Other categories use a type-prefixed ID; DATABASE uses `object_id`,
SCHEMA uses `object_id.sub_object_id`, COLUMN appends its column sub-ID to the
qualified object ID, and remaining categories use the qualified object ID with
any nonzero sub-ID. The type discriminator prevents cross-category collisions.
These display IDs are not the wire's vector indices or a replacement wire format.
Names appear once per entry as dotted SQL identifiers, quoting and escaping each
component when necessary and omitting empty qualifiers. Accesses and edges print
the quoted entity display ID or a numeric unresolved-reference vector index:

```yaml
entities:
  - catalog-id: '256.65536.4294967296'
    type: TABLE
    name: db.s.a
  - catalog-id: '256.65536.8589934592'
    type: TABLE
    name: db.s.a
unresolved-references:
  - name: 'db.s."Missing.Name"'
# A CREATE after DROP uses the second identity, but shares the name timeline.
accesses:
  - entity: '256.65536.8589934592'
    mode: DDL
  - unresolved-reference: 0
    mode: READ
```

Fixtures cover cross-script, same-script, and external-catalog DROP/recreation
identities, preserved DDL hazards, unresolved names without catalog entities, and
qualified identifiers containing dots, quotes, keywords, or case-sensitive text.

```bash
bazel run //snapshots/planner:update
bazel test //packages/dashql-core:planner_tests //packages/dashql-core:unit_tests
bazel test //packages/dashql-core-js:all //packages/dashql-core-js/test:all
```
