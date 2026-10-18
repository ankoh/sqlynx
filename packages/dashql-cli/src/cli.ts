import { parseArgs, styleText } from 'node:util';
import { SqlAnalyzer } from './describe/analysis/core.js';
import { describableFiles, describeFiles } from './describe/command.js';
import { ClaudeCodeDescriber, ClaudeDescriber, DEFAULT_DESCRIBE_MODEL } from './describe/describe.js';
import { Executor } from './execute.js';
import { readInputs } from './inputs.js';
import { Linter } from './lint.js';
import { formatFile, formatSummary, formatTimings, type FileReport, type RunTimings, type Style } from './report.js';

/// A request mostly waits for the model, more of them in flight make a run faster until the model throttles
const DEFAULT_CONCURRENCY = 12;

const USAGE = `dashql-cli: check, execute and describe DashQL scripts

Usage:
  dashql-cli execute [options] <file.sql|dir|->...
      Scans, parses and analyzes the scripts and executes the ones without errors in an in-memory Hyper database.
      Scripts run in the given order on one connection, later scripts see the tables of earlier ones.
      A script may prepare data with any number of statements, only its final query or VISUALIZE produces a result.
      The rows of that result are counted, not printed.
      --schema <file.sql>      Schema script (CREATE TABLE ...) to resolve names against, executed first, can be repeated
      --debug                  Show where the time goes, per statement in Hyper and in dashql-core

  dashql-cli lint [options] <file.sql|dir|->...
      Only scans, parses and analyzes the scripts, does not execute them. Prints only scripts with diagnostics.
      --schema <file.sql>      Schema script (CREATE TABLE ...) to resolve names against, can be repeated
      --debug                  Show where the time goes in dashql-core

  dashql-cli describe [options] <file.sql|dir>...
      Asks Claude for a description of each script and writes it as a header comment into scripts that have none.
      The model gets the statements of the script, without comments.
      --model <id>             Claude model (default ${DEFAULT_DESCRIBE_MODEL})
      --describer <kind>       claude-code (default, runs \`claude -p\` with the login of Claude Code) or
                               api (needs ANTHROPIC_API_KEY or an \`ant auth login\` profile)
      --force                  Replace existing generated descriptions
      --skip-commented         Skip scripts that already have comments
      --dry-run                Print the descriptions without touching the scripts
      --concurrency <n>        Parallel requests (default ${DEFAULT_CONCURRENCY})

Directories are searched recursively for *.sql files, - reads a script from stdin.
Exits with 0 without errors (warnings are fine), 1 with errors and 2 on usage errors.
`;

/// Colors only when stdout is a terminal, styleText also honors NO_COLOR and FORCE_COLOR
const style: Style = (format, text) => styleText(format, text, { stream: process.stdout });

/// Thrown for invalid arguments, the CLI prints the usage and exits with 2
class UsageError extends Error {}

function intOption(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
    return n;
}

async function main(argv: string[]): Promise<number> {
    const [command, ...args] = argv;
    switch (command) {
        case 'execute':
            return check(args, false);
        case 'lint':
            return check(args, true);
        case 'describe':
            return describe(args);
        case '-h':
        case '--help':
        case 'help':
            console.log(USAGE);
            return 0;
        default:
            if (command !== undefined) console.error(`error: unknown command ${command}\n`);
            console.error(USAGE);
            return 2;
    }
}

/// `execute` and `lint`
async function check(argv: string[], lint: boolean): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            schema: { type: 'string', multiple: true },
            debug: { type: 'boolean' },
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
    const debug = values.debug ?? false;
    let start = performance.now();
    const linter = await Linter.create();
    const coreStartup = performance.now() - start;
    const schemas = await readInputs(values.schema ?? []);
    const inputs = await readInputs(positionals);
    // Schemas run first, so that the scripts find their tables
    const scripts = [...schemas, ...inputs];
    start = performance.now();
    const schemaDiagnostics = schemas.map(schema => linter.addSchema(schema));
    const diagnostics = [...schemaDiagnostics, ...linter.lint(inputs)];
    const timings: RunTimings = {
        coreStartup,
        lint: performance.now() - start,
        compile: 0,
        hyperWall: 0,
        hyperParsing: 0,
        hyperCompilation: 0,
        hyperExecution: 0,
        statements: 0,
    };

    start = performance.now();
    const executor = lint ? null : await Executor.create(linter.core);
    if (executor) timings.hyperStartup = performance.now() - start;
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
                    timings.compile += report.execution.timings.core;
                    for (const statement of report.execution.timings.statements) {
                        timings.statements += 1;
                        timings.hyperWall += statement.wall;
                        timings.hyperParsing += statement.hyper?.parsing ?? 0;
                        timings.hyperCompilation += statement.hyper?.compilation ?? 0;
                        timings.hyperExecution += statement.hyper?.execution ?? 0;
                    }
                }
            } else if (report.diagnostics.length === 0) {
                continue;
            }
            process.stdout.write(`${formatFile(report, style, debug)}\n\n`);
        }
    } finally {
        await executor?.close();
    }
    if (debug) process.stdout.write(`${formatTimings(timings, style)}\n\n`);
    process.stdout.write(`${formatSummary({ ...summary, executed: executor ? summary.executed : undefined }, style)}\n`);
    // Warnings alone do not fail
    return summary.errors > 0 ? 1 : 0;
}

/// Describe the scripts with Claude and write the descriptions into them
async function describe(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            model: { type: 'string' },
            force: { type: 'boolean' },
            'skip-commented': { type: 'boolean' },
            'dry-run': { type: 'boolean' },
            concurrency: { type: 'string' },
            describer: { type: 'string' },
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
    const concurrency = intOption(values.concurrency, DEFAULT_CONCURRENCY, 'concurrency');
    const model = values.model ?? DEFAULT_DESCRIBE_MODEL;
    const describer =
        values.describer === undefined || values.describer === 'claude-code'
            ? new ClaudeCodeDescriber(model)
            : values.describer === 'api'
              ? new ClaudeDescriber(model)
              : null;
    if (describer == null) throw new UsageError('--describer must be claude-code or api');
    const files = describableFiles(await readInputs(positionals));
    const analyzer = await SqlAnalyzer.create();
    const dryRun = values['dry-run'] ?? false;
    // Progress goes to stderr, the descriptions of a dry run to stdout
    const log = (message: string) => console.error(message);
    let described = 0, skipped = 0, failed = 0;
    const run = await describeFiles(files, analyzer, describer, {
        force: values.force ?? false,
        dryRun,
        skipCommented: values['skip-commented'] ?? false,
        concurrency,
        onOutcome: outcome => {
            const took = outcome.ms === undefined ? '' : ` (${(outcome.ms / 1000).toFixed(1)}s)`;
            if (outcome.status === 'described') {
                described += 1;
                log(`${dryRun ? 'would write' : outcome.action} ${outcome.scriptName}${took}`);
                if (dryRun) console.log(`# ${outcome.scriptName}\n${outcome.header}`);
            } else if (outcome.status === 'skipped') {
                skipped += 1;
                log(`skipped ${outcome.scriptName}${took}: ${outcome.reason}`);
            } else {
                failed += 1;
                log(`warning: ${outcome.scriptName}${took}: ${outcome.reason}`);
            }
        },
    });
    if (run.stopped) {
        log(`stopped after failures in a row, ${files.length - run.outcomes.length} scripts were not sent`);
    }
    log(`${described} described, ${skipped} skipped, ${failed} failed`);
    return failed > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
    code => {
        process.exitCode = code;
    },
    error => {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof UsageError) console.error(`\n${USAGE}`);
        process.exitCode = 2;
    },
);
