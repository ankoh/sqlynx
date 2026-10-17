# dashql-lint

A CLI that runs SQL scripts through the DashQL scanner, parser and analyzer and reports their errors and warnings.
It is meant for agents that write DashQL scripts and want to check them before handing them over.

```
dashql-lint [--schema <file.sql>]... <file.sql|dir|->...
```

Run it through Bazel: `bazel run //packages/dashql-lint:cli -- examples/notebooks`.
Relative paths are resolved against the directory you invoke Bazel from. Directories are searched recursively for
`*.sql` files, `-` reads a script from stdin:

```
echo "select 1 +;" | bazel run //packages/dashql-lint:cli -- -
```

## Output

stdout is a JSON array with one diagnostic per line, so it is both valid JSON and easy to read or grep:

```
[
{"file":"<stdin>","line":1,"column":11,"stage":"parse","severity":"error","message":"syntax error, unexpected SEMICOLON","offset":10,"length":1}
]
```

| field | |
|---|---|
| `file` | path relative to the invoking directory, or `<stdin>` |
| `line`, `column` | 1-based, the column counts code points |
| `stage` | `scan`, `parse`, `analyze`, or `failure` if processing threw |
| `severity` | `error` or `warning` |
| `message` | |
| `offset`, `length` | UTF-8 byte span in the script |

A summary (`N files, E errors, W warnings`) goes to stderr. The exit code is 0 without errors (warnings are fine),
1 with errors and 2 on usage or I/O errors.

## Schemas

Scripts are analyzed on their own, names resolve only against what the script declares itself.
`--schema` adds a script with `CREATE TABLE` statements to the catalog, so that ambiguous or mistyped columns of those
tables are reported. Diagnostics of the schema scripts are reported as well.

The parser accepts some incomplete statements (e.g. a `FROM` or `WHERE` without anything after it) so the editor can
complete them. They are not reported.

## Tests

`bazel test //packages/dashql-lint:tests`
