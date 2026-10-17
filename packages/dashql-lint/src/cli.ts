import { parseArgs } from 'node:util';
import { readInputs } from './inputs.js';
import { Linter, formatDiagnostics, type Diagnostic } from './lint.js';

const USAGE = `dashql-lint: report DashQL scanner, parser and analyzer diagnostics of SQL scripts

Usage:
  dashql-lint [options] <file.sql|dir|->...
      Directories are searched recursively for *.sql files, - reads a script from stdin.
      Prints a JSON array with one diagnostic per line:
        {"file","line","column","stage","severity","message","offset","length"}
      stage is scan, parse, analyze or failure, severity is error or warning.
      Exits with 0 without errors (warnings are fine), 1 with errors and 2 on usage errors.
      --schema <file.sql>      Schema script (CREATE TABLE ...) to resolve names against, can be repeated
`;

async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            schema: { type: 'string', multiple: true },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (values.help) {
        console.log(USAGE);
        return 0;
    }
    if (positionals.length === 0) {
        console.error(USAGE);
        return 2;
    }
    const linter = await Linter.create();
    const diagnostics: Diagnostic[] = [];
    for (const schema of await readInputs(values.schema ?? [])) {
        diagnostics.push(...linter.addSchema(schema));
    }
    const inputs = await readInputs(positionals);
    diagnostics.push(...linter.lint(inputs));
    process.stdout.write(formatDiagnostics(diagnostics));

    let errors = 0;
    for (const d of diagnostics) if (d.severity === 'error') errors += 1;
    console.error(`${inputs.length} files, ${errors} errors, ${diagnostics.length - errors} warnings`);
    // Warnings alone do not fail
    return errors > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
    code => {
        process.exitCode = code;
    },
    error => {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
    },
);
