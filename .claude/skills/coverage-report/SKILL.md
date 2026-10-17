---
name: coverage-report
description: Run coverage for dashql-core and update the coverage report
---

# Update dashql-core Coverage Report

Run LLVM source-based coverage for all dashql-core test targets and regenerate `docs/reports/dashql_core_coverage_report.md`.

## Steps

1. Run coverage collection:

```bash
bazel coverage --config=fastbuild \
    --instrumentation_filter="//packages/dashql-core[/:],-//packages/dashql-core/vendor[/:]" \
    //packages/dashql-core/...
```

2. Extract per-file coverage from the lcov report at `$(bazel info output_path)/_coverage/_coverage_report.dat`. Parse each `SF:` record for files matching `packages/dashql-core/src/` and extract `LH:` (lines hit) and `LF:` (lines found) values.

3. Rewrite `docs/reports/dashql_core_coverage_report.md` with:
   - Today's date
   - Overall line coverage percentage
   - Per-file table sorted by coverage percentage (descending)
   - Top offenders section listing files with the most uncovered lines
   - Suggested actions for improving coverage

4. Only include `src/` files in the table (exclude `include/` headers and `test/` / `src/testing/` files).

5. Report the overall coverage percentage and highlight any significant changes vs the previous report.
