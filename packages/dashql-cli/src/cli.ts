import { parseArgs, styleText } from 'node:util';
import { Executor } from './execute.js';
import { readInputs } from './inputs.js';
import { Linter } from './lint.js';
import { formatFile, formatSummary, type FileReport, type Style } from './report.js';

const USAGE = `dashql-cli: check and execute DashQL scripts

Usage:
  dashql-cli [options] <file.sql|dir|->...
      Scans, parses and analyzes the scripts and executes the ones without errors in an in-memory Hyper database.
      Scripts run in the given order on one connection, later scripts see the tables of earlier ones.
      A script may prepare data with any number of statements, only its final query or VISUALIZE produces a result.
      The rows of that result are counted, not printed.
      Directories are searched recursively for *.sql files, - reads a script from stdin.
      Exits with 0 without errors (warnings are fine), 1 with errors and 2 on usage errors.
      --lint                   Only scan, parse and analyze, do not execute. Prints only scripts with diagnostics.
      --schema <file.sql>      Schema script (CREATE TABLE ...) to resolve names against, executed first, can be repeated
`;

/// Colors only when stdout is a terminal, styleText also honors NO_COLOR and FORCE_COLOR
const style: Style = (format, text) => styleText(format, text, { stream: process.stdout });

async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            lint: { type: 'boolean' },
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
    const schemas = await readInputs(values.schema ?? []);
    const schemaDiagnostics = schemas.map(schema => linter.addSchema(schema));
    const inputs = await readInputs(positionals);
    // Schemas run first, so that the scripts find their tables
    const scripts = [...schemas, ...inputs];
    const diagnostics = [...schemaDiagnostics, ...linter.lint(inputs)];

    const executor = values.lint ? null : await Executor.create(linter.core);
    const summary = { files: scripts.length, errors: 0, warnings: 0, executed: 0 };
    try {
        for (let i = 0; i < scripts.length; ++i) {
            const report: FileReport = { file: scripts[i].id, text: scripts[i].text, diagnostics: diagnostics[i] };
            let failed = false;
            for (const d of report.diagnostics) {
                if (d.severity === 'error') {
                    summary.errors += 1;
                    failed = true;
                } else {
                    summary.warnings += 1;
                }
            }
            if (executor) {
                report.execution = failed ? 'skipped' : await executor.execute(scripts[i].text);
                if (report.execution !== 'skipped') {
                    if (report.execution.ok) summary.executed += 1;
                    else summary.errors += 1;
                }
            } else if (report.diagnostics.length === 0) {
                continue;
            }
            process.stdout.write(`${formatFile(report, style)}\n\n`);
        }
    } finally {
        await executor?.close();
    }
    process.stdout.write(`${formatSummary({ ...summary, executed: executor ? summary.executed : undefined }, style)}\n`);
    // Warnings alone do not fail
    return summary.errors > 0 ? 1 : 0;
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
