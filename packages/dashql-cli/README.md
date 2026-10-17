# dashql-cli

A CLI that checks and executes DashQL scripts. It is meant for agents that write DashQL scripts and want to know
whether they work before handing them over.

```
dashql-cli [--lint] [--schema <file.sql>]... <file.sql|dir|->...
```

Run it through Bazel: `bazel run //packages/dashql-cli:cli -- examples/notebooks/tpch`.
Relative paths are resolved against the directory you invoke Bazel from. Directories are searched recursively for
`*.sql` files, the generated catalog files of notebooks (`dashql-functions.sql`, `dashql-relations.sql`) are skipped.
`-` reads a script from stdin:

```
echo "select 1 +;" | bazel run //packages/dashql-cli:cli -- -
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

`--lint` stops after the analysis and prints only the scripts with diagnostics.

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

## Tests

`bazel test //packages/dashql-cli:tests`

# Example


Executing all scripts under ./examples/atlas:

`bazel run //packages/dashql-cli:cli -- examples/atlas`
