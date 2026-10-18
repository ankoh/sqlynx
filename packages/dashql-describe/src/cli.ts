import { parseArgs } from 'node:util';
import { describeFiles } from './commands/describe.js';
import { SqlAnalyzer } from './analysis/core.js';
import { ClaudeCodeDescriber, ClaudeDescriber, DEFAULT_DESCRIBE_MODEL, type Describer } from './describe/describe.js';
import { collectSqlFiles } from './inputs.js';

const USAGE = `dashql-describe: describe SQL scripts for semantic example search

Usage:
  dashql-describe <dir|file.sql>... [options]
      Ask Claude for a description of each script and write it as a header comment into scripts that have none.
      The model gets the statements of the script, without comments.
      --model <id>             Claude model (default ${DEFAULT_DESCRIBE_MODEL})
      --describer <kind>       claude-code (default, runs \`claude -p\` with the login of Claude Code) or
                               api (needs ANTHROPIC_API_KEY or an \`ant auth login\` profile)
      --force                  Replace existing generated descriptions
      --skip-commented         Skip scripts that already have comments
      --dry-run                Print the descriptions without touching the scripts
      --concurrency <n>        Parallel requests (default 4)
`;

const log = (message: string) => console.error(message);

function intOption(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
    return n;
}

async function main(argv: string[]): Promise<number> {
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
    if (values.help || positionals.length === 0) {
        console.log(USAGE);
        return values.help ? 0 : 1;
    }
    const model = values.model ?? DEFAULT_DESCRIBE_MODEL;
    const files = await collectSqlFiles(positionals);
    const analyzer = await SqlAnalyzer.create();
    const describer = createDescriber(values.describer, model);
    const dryRun = values['dry-run'] ?? false;
    const outcomes = await describeFiles(files, analyzer, describer, {
        force: values.force ?? false,
        dryRun,
        skipCommented: values['skip-commented'] ?? false,
        concurrency: intOption(values.concurrency, 4, 'concurrency'),
        log,
    });
    let described = 0, skipped = 0, failed = 0;
    for (const outcome of outcomes) {
        if (outcome.status === 'described') {
            described += 1;
            log(`${dryRun ? 'would write' : outcome.action} ${outcome.scriptName}`);
            if (dryRun) console.log(`# ${outcome.scriptName}\n${outcome.header}`);
        } else if (outcome.status === 'skipped') {
            skipped += 1;
            log(`skipped ${outcome.scriptName}: ${outcome.reason}`);
        } else {
            failed += 1;
        }
    }
    log(`${described} described, ${skipped} skipped, ${failed} failed`);
    return failed > 0 ? 2 : 0;
}

function createDescriber(kind: string | undefined, model: string): Describer {
    if (kind === undefined || kind === 'claude-code') return new ClaudeCodeDescriber(model);
    if (kind === 'api') return new ClaudeDescriber(model);
    throw new Error('--describer must be claude-code or api');
}

main(process.argv.slice(2)).then(
    code => {
        process.exitCode = code;
    },
    error => {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    },
);
