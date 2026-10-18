# dashql-cli

A CLI that checks, executes and describes DashQL scripts. `execute` and `lint` are meant for agents that write DashQL
scripts and want to know whether they work before handing them over, `describe` writes the descriptions that the
semantic search of [DashQL Atlas](../../docs/misc/atlas.md) matches a prompt against.

```
dashql-cli execute [--schema <file.sql>]... [--debug] <file.sql|dir|->...
dashql-cli lint [--schema <file.sql>]... [--debug] <file.sql|dir|->...
dashql-cli describe [--force] [--dry-run] [--skip-commented] [--model <id>] [--describer claude-code|api] [--concurrency <n>] <file.sql|dir>...
```

Run it through Bazel: `bazel run //packages/dashql-cli:cli -- execute examples/notebooks/tpch`.
Relative paths are resolved against the directory you invoke Bazel from. Directories are searched recursively for
`*.sql` files, the generated catalog files of notebooks (`dashql-functions.sql`, `dashql-relations.sql`) are skipped.
`-` reads a script from stdin:

```
echo "select 1 +;" | bazel run //packages/dashql-cli:cli -- execute -
```

## What it does

Every script is scanned, parsed and analyzed by dashql-core. Scripts without errors are then executed in an in-memory
Hyper database (hyperdb-wasm) with the engine settings of the app, so they may load data over HTTP like in the app.

- A script is compiled into its statements like the app does it. It may prepare data with any number of statements
  and end with a query or a `VISUALIZE` statement, whose query is executed. Only the final statement may produce a
  result.
- The rows of that result are counted, not printed.
- Scripts run in the given order on one connection, later scripts see the tables of earlier ones. The database is
  removed when the CLI exits.

`lint` stops after the analysis and prints only the scripts with diagnostics.

## Output

```
examples/notebooks/tpch/scripts/05_tpch_q3.sql
    ok       execute  1 statement, 10 rows

broken.sql
  2:27  error    parse    syntax error, unexpected SEMICOLON
        │ select a from t where a = ;
        │                           ^
        skipped  execute  not executed due to errors

missing.sql
    error    execute  statement 3: table "missing_table" does not exist [42P01]
                      line 1, column 15: select * from missing_table
                                                       ^~~~~~~~~~~~~

3 files, 2 errors, 0 warnings, 1 executed
```

Diagnostics show the line and column (in code points), the severity, the stage (`scan`, `parse`, `analyze`, or
`failure` if processing threw) and the source line. Execution errors name the failing statement and show the SQL
state and the detail of Hyper, which points into that statement. Colors are used when stdout is a terminal
(`NO_COLOR` and `FORCE_COLOR` are honored).

The exit code is 0 without errors (warnings are fine), 1 with errors and 2 on usage or I/O errors.

## Schemas

Scripts are analyzed on their own, names resolve only against what the script declares itself.
`--schema` adds a script with `CREATE TABLE` statements to the catalog, so that ambiguous or mistyped columns of those
tables are reported. Schema scripts are checked and executed first.

The parser accepts some incomplete statements (e.g. a `FROM` or `WHERE` without anything after it) so the editor can
complete them. They are not reported by the analysis, but Hyper rejects them when they are executed.

## Describe

`describe` asks Claude for a short description and a few example questions per script and writes them as a marked
header comment. The model sees the statements of the script and nothing else, no comments and no analysis. Scripts
that already have such a block are skipped, `--force` replaces the block and leaves everything else alone.

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

A `@dashql:metadata` block (user-provided metadata, see [DashQL Atlas](../../docs/misc/atlas.md#metadata)) is
never changed or sent to the model. If a script starts with one, the description is inserted below it.

The result is plain SQL that can be reviewed, edited and committed. Run it again and only scripts without a
description block are sent to the model. Scripts from stdin cannot be described.

By default it runs the Claude Code CLI (`claude -p`) and uses its login, so `claude` has to be on the `PATH`.
`--describer api` calls the Anthropic API instead, with credentials from `ANTHROPIC_API_KEY` or an `ant auth login`
profile.

Twelve scripts are described at a time (`--concurrency`), a request mostly waits for the model. Every script is written
and reported with its time as soon as it is described, and a run stops after three failures in a row, which usually
means that the describer cannot reach the model or is not logged in. Progress goes to stderr, the descriptions of a
`--dry-run` to stdout. The exit code is 1 if a script failed.

```
bazel run //packages/dashql-cli:cli -- describe examples/atlas --model claude-sonnet-5-5
```

The atlas page describes the same way with the external model of its AI settings. It carries copies of
`src/describe/prompt.ts` and `src/describe/header.ts` in `packages/dashql-app/src/atlas/describe/`, both are free of
Node APIs and have to be kept in sync.

## Tests

`bazel test //packages/dashql-cli:tests` runs the unit tests, the execution in hyperdb-wasm, an offline end-to-end
test of `describe` (stubbed describer) and the snapshot check.

`snapshots/describe/*.yaml` (`basic` for plain SQL, `dashql` for VISUALIZE, SET and EXPLAIN scripts) show the prompt
that `describe` sends to the model for a script, or that the script is skipped. Regenerate with
`bazel run //snapshots/describe:update` from `snapshots/describe/*.tpl.yaml`.

# Example

Executing all scripts under ./examples/atlas:

`bazel run //packages/dashql-cli:cli -- execute examples/atlas`
