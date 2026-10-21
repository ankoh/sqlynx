# Extending and Validating SQL Formatting

This guide documents the standard workflow to add or improve SQL formatter behavior in DashQL and validate it end-to-end.

## 1) Implement formatter behavior

1. Update formatter logic in the Rust core, `packages/dashql-core/src/formatter/`: `mod.rs` holds the dispatch and the shared helpers, the statement formatters live in `select.rs`, `create.rs`, `insert.rs`, `delete.rs`, `explain.rs`, `pgq.rs` and `vis.rs`.
2. Ensure the node is handled in the `Formatter::format_node` dispatch (`mod.rs`).
3. Keep lowercase SQL keywords as the default; honor the configured keyword case without changing identifiers, literals, comments, or current break/indent behavior.
4. Don't use the source text of a node (`text_at`) as escape hatch to copy over the AST node content, instead use a place holder similar to unsupported node types (`format_unimplemented`).
5. Don't format children nodes in parent nodes, let the formatter format children when visiting them and look up the child's `FmtReg` (`reg`, `reg_or_placeholder`).
6. The formatter visits the nodes in post-order (the order of the node array), so the regs of the children are already computed (if we can format them).

Example: for `OBJECT_SQL_ORDER`, read attributes like `SQL_ORDER_VALUE`, `SQL_ORDER_DIRECTION`, and `SQL_ORDER_NULLRULE`, then render the order item text used by `order by` clauses.

## 2) Add/extend formatter snapshot templates

Formatter snapshot templates live in:
- `snapshots/formatter/*.tpl.yaml`

Generated snapshot files live in:
- `snapshots/formatter/*.yaml`

To add a new category:
1. Create `snapshots/formatter/<category>.tpl.yaml`.
2. Follow template structure used by existing files such as `expressions.tpl.yaml`.
3. Add multiple focused test cases with:
   - `name`
   - `input`
   - `dialects.hyper`
4. Prefer adding `validation.setup` for Hyper-validatable SQL so formatted outputs can be executed in validation tests.
5. Add per-mode overrides in `formatted` only when needed (for example, custom `width` in compact mode).

## 3) Generate snapshots from templates

Run:

```bash
bazel run //snapshots/formatter:update
```

This generates/updates `snapshots/formatter/<category>.yaml` from all `.tpl.yaml` files in the formatter snapshot folder.

## 4) Snapshot tests

Neither test needs a registration: both read every `snapshots/formatter/*.yaml`.

### Snapshot equality
Target:
- `//packages/dashql-core:formatter_snapshot_test` (`packages/dashql-core/tests/formatter_snapshots.rs`)

Formats the input of every case for every expectation of every dialect that is not skipped. Cases named
`coverage_*` must also be fully formattable, and their output must scan and parse without errors.

### Hyper validation
Target:
- `//packages/dashql-core:formatter_validation_hyper_test` (`packages/dashql-core/tests/formatter_validation_hyper.rs`)

Every case of every formatter snapshot file with a `dialects.hyper.validation` block runs
in a fresh Hyper database. The test executes `validation.setup`, checks that the Rust formatter output equals each
expectation of the `hyper` dialect, and executes it statement by statement. Hyper is reached through the C ABI
`//packages/hyper-api:hyper_ffi`.

This ensures both textual snapshot checks and executable SQL validation are covered.

## 5) Add a JS API formatting test (recommended)

File:
- `packages/dashql-core-js/src/api_formatting.test.ts`

Add at least one focused runtime formatting test that:
1. Creates a script via API
2. Inserts SQL input
3. Formats with `FormattingConfigT`
4. Asserts exact output string

This catches integration regressions between core formatter and app-side API/WASM binding behavior.

## 6) Run required Bazel tests

Run the full targets used for acceptance:

```bash
bazel test //packages/dashql-core:formatter_snapshot_test //packages/dashql-core:formatter_validation_hyper_test
bazel test //packages/dashql-core:all
bazel test //packages/dashql-core-js:all
bazel test //packages/dashql-app:all
```

If failures occur:
1. Fix formatter or expected snapshots as needed.
2. Re-run `bazel run //snapshots/formatter:update` if templates changed.
3. Re-run both test targets until green.

## 7) Typical change checklist

- [ ] Formatter logic updated in core (`packages/dashql-core/src/formatter/`)
- [ ] New/updated `.tpl.yaml` tests added
- [ ] Snapshots regenerated via `//snapshots/formatter:update`
- [ ] `validation.setup` added for Hyper-validatable cases
- [ ] JS API formatting test added/updated
- [ ] `bazel test //packages/dashql-core:all` passes
- [ ] `//packages/dashql-core:formatter_validation_hyper_test` passes
- [ ] `bazel test //packages/dashql-core-js:all` passes
- [ ] `bazel test //packages/dashql-app:all` passes
