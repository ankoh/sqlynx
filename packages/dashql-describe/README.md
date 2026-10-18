# dashql-describe

A CLI that writes natural-language descriptions into SQL scripts, so that a semantic search over the scripts has
something to match a user prompt against. Indexing and searching happen in the browser, see
[DashQL Atlas](../../docs/misc/atlas.md).

```
dashql-describe <dir|file.sql>... [--force] [--dry-run] [--skip-commented] [--model <id>] [--describer claude-code|api]
```

Run it through Bazel: `bazel run //packages/dashql-describe:cli -- ./examples/atlas --model claude-sonnet-5-5`.
Relative paths are resolved against the directory you invoke Bazel from.

It asks Claude for a short description and a few example questions per script and writes them as a marked header
comment. The model sees the statements of the script and nothing else, no comments and no analysis. Scripts that
already have such a block are skipped, `--force` replaces the block and leaves everything else alone.

```sql
-- @dashql:description
-- Revenue of the ten highest-value unshipped orders for customers of the BUILDING market segment.
--
-- Example questions:
-- - Which unshipped orders bring in the most revenue?
-- @dashql:end
-- TPC-H query 3
select ...
```

A `@dashql:properties` block (user-provided properties, see [DashQL Atlas](../../docs/misc/atlas.md#properties)) is
never changed or sent to the model. If a script starts with one, the description is inserted below it.

The result is plain SQL that can be reviewed, edited and committed. Run it again and only scripts without a
description block are sent to the model.

By default it runs the Claude Code CLI (`claude -p`) and uses its login, so `claude` has to be on the `PATH`.
`--describer api` calls the Anthropic API instead, with credentials from `ANTHROPIC_API_KEY` or an `ant auth login`
profile.

## Development

- `bazel test //packages/dashql-describe:tests` runs unit tests, an offline end-to-end test (stubbed describer) and the
  snapshot check.
- `snapshots/describe/*.yaml` (`basic` for plain SQL, `dashql` for VISUALIZE, SET and EXPLAIN scripts) show the prompt
  that is sent to the model for a script, or that the script is skipped. Regenerate with
  `bazel run //snapshots/describe:update` from `snapshots/describe/*.tpl.yaml`.
