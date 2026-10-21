# Parse tree changes

By default the Rust core keeps the parse tree **exactly** as the C++ core built it:
- the flat post-order node array
- the same `NodeType` and `AttributeKey` values
- the same object attributes and node order

The tree may change when it has to, but only deliberately, because every change risks losing parser
expressiveness, and the TypeScript code reads the tree through the generated FlatBuffers readers.

## Rules

1. **Never as a side effect.** A snapshot diff in the parse tree is a bug until a change has been
   decided here.
2. **Write it up first.** Add an entry below with:
   - the motivation
   - the affected `NodeType` and `AttributeKey` values
   - an argument that every construct still parses and stays distinguishable, so no expressiveness
     is lost
3. **Land it in one change.** Change the grammar rules (`grammar/rules/*.y`),
   `proto/fb/dashql/parsed_script.fbs`, the Rust and TypeScript consumers, and update the snapshots
   (`bazel run //snapshots:update`) in the same change.
4. **Script signatures may change.** `SCRIPT_SIGNATURE_VERSION` (`packages/dashql-core/src/signature.rs`)
   versions the signature encoding, but signatures are not required to stay stable across versions,
   and no test pins them.

## Changes

None yet.

<!--
### YYYY-MM-DD: <title>

- Motivation:
- Affected node types / attribute keys:
- Expressiveness:
- Landed by: <commit>
-->
