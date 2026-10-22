# dashql-cli

A CLI that checks DashQL scripts with the native dashql-core. It is meant for agents that write DashQL scripts and want
to know whether they scan, parse and analyze before handing them over.

```
dashql-cli lint [--schema <file.sql>]... [--debug] <file.sql|dir|->...
```

Run it through Bazel: `bazel run //packages/dashql-cli:cli -- lint examples/sessions/tpch`.
Relative paths are resolved against the directory you invoke Bazel from. Directories are searched recursively for
`*.sql` files, the generated catalog files of sessions (`dashql-catalog-relations.sql`, `dashql-catalog-functions.sql`, `dashql-catalog-changes.sql`) are skipped.
`-` reads a script from stdin:

```
echo "select 1 +;" | bazel run //packages/dashql-cli:cli -- lint -
```

## What it does

Every script is scanned, parsed and analyzed by dashql-core, and only the scripts with diagnostics are printed. Scripts
are not executed.

## Output

```
broken.sql
  2:27  error    parse    syntax error, unexpected SEMICOLON
        │ select a from t where a = ;
        │                           ^

3 files, 1 error, 0 warnings
```

Diagnostics show the line and column (in code points), the severity, the stage (`scan`, `parse`, `analyze`, or
`failure` if processing failed) and the source line. Colors are used when stdout is a terminal (`NO_COLOR` and
`FORCE_COLOR` are honored). `--debug` adds how long dashql-core took.

The exit code is 0 without errors (warnings are fine), 1 with errors and 2 on usage or I/O errors.

## Schemas

Scripts are analyzed on their own, names resolve only against what the script declares itself.
`--schema` adds a script with `CREATE TABLE` statements to the catalog, so that ambiguous or mistyped columns of those
tables are reported. Schema scripts are checked first, a schema with errors is not added.

The parser accepts some incomplete statements (e.g. a `FROM` or `WHERE` without anything after it) so the editor can
complete them. They are not reported.

## Tests

`bazel test //packages/dashql-cli:tests`
