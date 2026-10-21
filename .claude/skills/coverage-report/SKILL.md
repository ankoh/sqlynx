---
name: coverage-report
description: Run coverage for the Rust core and update the coverage report
---

# Update the Core Coverage Report

Run LLVM source-based coverage for the test targets of the Rust core (dashql-core, dashql-grammar, dashql-snapshots) and regenerate `docs/reports/dashql_core_coverage_report.md`.

## Steps

1. Run coverage collection:

```bash
bazel coverage --config=fastbuild \
    --instrumentation_filter="//packages/dashql-core[/:],//packages/dashql-grammar[/:]" \
    //packages/dashql-core/... //packages/dashql-grammar/... //packages/dashql-snapshots/...
```

2. Extract per-file coverage from the lcov report at `$(bazel info output_path)/_coverage/_coverage_report.dat`. Parse each `SF:` record for files matching `packages/dashql-core/src/` and `packages/dashql-grammar/src/` and extract `LH:` (lines hit) and `LF:` (lines found) values.

3. Rewrite `docs/reports/dashql_core_coverage_report.md` with:
   - Today's date
   - Overall line coverage percentage
   - Per-file table sorted by coverage percentage (descending)
   - Top offenders section listing files with the most uncovered lines
   - Suggested actions for improving coverage

4. Only include `src/` files in the table (exclude `tests/`, `benches/` and generated files such as `src/tables.rs`).

5. Report the overall coverage percentage and highlight any significant changes vs the previous report.
