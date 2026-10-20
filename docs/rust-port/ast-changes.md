# Parse tree changes

By default the Rust port keeps the parse tree **exactly** as the C++ core builds it:
- the flat post-order node array
- the same `NodeType` and `AttributeKey` values
- the same object attributes and node order

The tree may change when it has to, but only deliberately, because every change risks losing parser
expressiveness.

## Rules

1. **Never as a side effect of porting.** A difference between the Rust core and the C++ oracle is a
   bug until a change has been decided here and applied to the C++ core.
2. **Write it up first.** Add an entry below with:
   - the motivation
   - the affected `NodeType` and `AttributeKey` values
   - an argument that every construct still parses and stays distinguishable, so no expressiveness
     is lost
3. **Land it on the C++ side first.** Change both grammar rule sets, `proto/fb/dashql/parsed_script.fbs`
   and the C++ consumers, and update the snapshots in the same change. The oracle and the Rust port
   stay in lockstep, so the differential diff stays at zero.
4. **Bump `SCRIPT_SIGNATURE_VERSION`** (`packages/dashql-core/src/script.cc`) when the change touches
   the tree shape or the enum values. Script signatures are persisted cache keys.

## Changes

None yet.

<!--
### YYYY-MM-DD: <title>

- Motivation:
- Affected node types / attribute keys:
- Expressiveness:
- Landed in C++ by: <commit>
-->
