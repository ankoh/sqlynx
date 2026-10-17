import { parseArgs } from 'node:util';
import { describeFiles } from './commands/describe.js';
import { SqlAnalyzer } from './analysis/core.js';
import { runIndex } from './commands/index.js';
import { CachedDescriber, ClaudeDescriber, DEFAULT_DESCRIBE_MODEL } from './describe/describe.js';
import { DEFAULT_MODEL, HashEmbedder, TransformersEmbedder, defaultCacheDir, type Embedder } from './embedding/embedder.js';
import { collectSqlFiles, resolveUserPath } from './inputs.js';
import { DEFAULT_SEARCH_OPTIONS, embedderForIndex, loadIndex, searchIndex, type Fusion } from './query.js';

const USAGE = `dashql-embed: describe and embed SQL scripts for semantic example search

Usage:
  dashql-embed describe <dir|file.sql>... [options]
      Ask Claude for a description of each script and write it as a header comment into scripts that have none.
      The model gets the statements of the script, without comments.
      --model <id>             Claude model (default ${DEFAULT_DESCRIBE_MODEL})
      --force                  Replace existing generated descriptions
      --skip-commented         Skip scripts that already have comments
      --dry-run                Print the descriptions without touching the scripts
      --concurrency <n>        Parallel requests (default 4)
      --cache-dir <dir>        Cache for descriptions and models (default ${defaultCacheDir()})

  dashql-embed index <dir|file.sql>... --out-dir <dir> [options]
      Write comments.parquet and features.parquet with embeddings.
      --model <id>             transformers.js model, Snowflake Arctic Embed only (default ${DEFAULT_MODEL})
      --dtype <dtype>          fp32 (default), fp16, q8, q4, ...
      --max-tokens <n>         Token window of the model (default from the preset)
      --batch-size <n>         Embedding batch size (default 32)
      --embedder <kind>        transformers (default) or hash (offline, deterministic, for tests)
      --no-layout              Skip the 2D layout (layout_x/y) of the scripts
      --cache-dir <dir>        Model cache

  dashql-embed query <dir|file.sql>... --index-dir <dir> --prompt <text> [options]
      Search a set of scripts with the Parquet files that "index" wrote for it and print the best matches.
      Index rows of other scripts are ignored. Scripts that changed since indexing are reported and not searched.
      --index-dir <dir>        Directory with comments.parquet and features.parquet
      --prompt <text>          What you are looking for
      --top <n>                Number of scripts to print (default ${DEFAULT_SEARCH_OPTIONS.topK})
      --fusion <weighted|rrf>  How comment and feature scores are combined (default weighted)
      --weight-comments <w>    Weight of the comment score (default ${DEFAULT_SEARCH_OPTIONS.weightComments})
      --weight-features <w>    Weight of the feature score (default ${DEFAULT_SEARCH_OPTIONS.weightFeatures})
`;

const log = (message: string) => console.error(message);

function intOption(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
    return n;
}

async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (!command || command === '--help' || command === '-h') {
        console.log(USAGE);
        return command ? 0 : 1;
    }
    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
            model: { type: 'string' },
            force: { type: 'boolean' },
            'skip-commented': { type: 'boolean' },
            'dry-run': { type: 'boolean' },
            concurrency: { type: 'string' },
            'cache-dir': { type: 'string' },
            'out-dir': { type: 'string' },
            'index-dir': { type: 'string' },
            dtype: { type: 'string' },
            'max-tokens': { type: 'string' },
            'batch-size': { type: 'string' },
            embedder: { type: 'string' },
            'no-layout': { type: 'boolean' },
            prompt: { type: 'string' },
            top: { type: 'string' },
            fusion: { type: 'string' },
            'weight-comments': { type: 'string' },
            'weight-features': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (values.help) {
        console.log(USAGE);
        return 0;
    }
    const cacheDir = values['cache-dir'] ? resolveUserPath(values['cache-dir']) : defaultCacheDir();

    switch (command) {
        case 'describe': {
            if (positionals.length === 0) throw new Error('describe needs at least one directory or file');
            const model = values.model ?? DEFAULT_DESCRIBE_MODEL;
            const files = await collectSqlFiles(positionals);
            const analyzer = await SqlAnalyzer.create();
            const describer = new CachedDescriber(new ClaudeDescriber(model), cacheDir, model);
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
        case 'index': {
            if (positionals.length === 0) throw new Error('index needs at least one directory or file');
            if (!values['out-dir']) throw new Error('index needs --out-dir');
            const embedder = await createEmbedder(values, cacheDir);
            const summary = await runIndex({
                inputs: positionals,
                outDir: values['out-dir'],
                embedder,
                layout: !values['no-layout'],
                log,
            });
            log(
                `${summary.scripts} scripts: ${summary.featureRows} feature rows, ${summary.commentRows} comment rows, ` +
                    `${summary.truncated} truncated, ${summary.withDiagnostics} with diagnostics, layout: ${summary.layout}`,
            );
            return 0;
        }
        case 'query': {
            if (positionals.length === 0) throw new Error('query needs the scripts to search');
            if (!values['index-dir']) throw new Error('query needs --index-dir');
            const prompt = values.prompt?.trim();
            if (!prompt) throw new Error('query needs --prompt');
            const fusion = (values.fusion ?? DEFAULT_SEARCH_OPTIONS.fusion) as Fusion;
            if (fusion !== 'weighted' && fusion !== 'rrf') throw new Error('--fusion must be weighted or rrf');
            const files = await collectSqlFiles(positionals);
            const index = await loadIndex(resolveUserPath(values['index-dir']));
            const embedder = await embedderForIndex(index.features, cacheDir);
            const { hits, missing, stale } = await searchIndex(
                index,
                prompt,
                embedder,
                files.map(f => ({ name: f.id, hash: f.hash })),
                {
                    topK: intOption(values.top, DEFAULT_SEARCH_OPTIONS.topK, 'top'),
                    fusion,
                    weightComments: Number(values['weight-comments'] ?? DEFAULT_SEARCH_OPTIONS.weightComments),
                    weightFeatures: Number(values['weight-features'] ?? DEFAULT_SEARCH_OPTIONS.weightFeatures),
                },
            );
            if (missing.length > 0) log(`warning: ${missing.length} scripts are not in the index: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`);
            if (stale.length > 0) log(`warning: ${stale.length} scripts changed since indexing and are skipped: ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', ...' : ''}`);
            const paths = new Map(files.map(f => [f.id, f.path]));
            hits.forEach((hit, i) => {
                const fmt = (v: number | null) => (v === null ? '-' : v.toFixed(2));
                console.log(`${i + 1}. ${hit.scriptName}  score ${hit.score.toFixed(3)}  (comments ${fmt(hit.commentScore)}, features ${fmt(hit.featureScore)})`);
                console.log(`   ${paths.get(hit.scriptName)}`);
                if (hit.bestComment) console.log(`   ${hit.bestComment.replace(/\s+/g, ' ').slice(0, 140)}`);
            });
            return 0;
        }
        default:
            console.error(`unknown command '${command}'\n`);
            console.error(USAGE);
            return 1;
    }
}

async function createEmbedder(values: Record<string, any>, cacheDir: string): Promise<Embedder> {
    const kind = values.embedder ?? 'transformers';
    if (kind === 'hash') return new HashEmbedder();
    if (kind !== 'transformers') throw new Error('--embedder must be transformers or hash');
    return TransformersEmbedder.create({
        model: values.model,
        dtype: values.dtype,
        maxTokens: values['max-tokens'] ? intOption(values['max-tokens'], 512, 'max-tokens') : undefined,
        batchSize: intOption(values['batch-size'], 32, 'batch-size'),
        cacheDir,
    });
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
