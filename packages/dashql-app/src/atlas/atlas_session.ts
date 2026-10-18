import type { DashQL } from '@ankoh/dashql-core';
import type * as arrow from 'apache-arrow';

import type {
    EmbeddedComputeDatabase,
    EmbeddedExternalDirectoryDatabase,
    EmbeddedTableImportConnection,
} from '../platform/database/embedded_database.js';
import type { Logger, TracedLogger } from '../platform/logger/logger.js';
import { stringifyError } from '../platform/logger/logger.js';
import { createTrace } from '../platform/logger/trace_context.js';
import type { QueryExecutionTracker } from '../query/query_execution_state.js';
import type { AIDescribeClient } from '../platform/ai/ai_task_clients.js';
import { AtlasSql } from './atlas_sql.js';
import {
    DESCRIBE_LOG_CTX,
    describeScripts,
    describeTargets,
    type DescribeExclusion,
    type DescribeOutcome,
} from './describe/describe.js';
import { descriptionText, extractComments } from './index/analysis/comments.js';
import { SqlAnalyzer, type AnalyzedSql } from './index/analysis/core.js';
import { AtlasEmbedder } from './index/embedder_client.js';
import { INDEX_LOG_CTX, analyzeScripts, buildIndex, hasDescription, type IndexProgress } from './index/indexer.js';
import { ATLAS_EMBEDDER_CONFIG } from './index/model.js';
import { readSqlFile, scanSqlFiles, type SqlFile } from './index/scan.js';
import { searchAll, type SearchResults } from './search/search.js';
import {
    checkIndexModel,
    outdatedScripts,
    externalDirectoryDatabase,
    hasIndexFile,
    loadIndexedScripts,
    indexPoints,
    indexRowsTable,
    loadIndexTable,
    mountFolder,
    unmountFolder,
    writeIndexFile,
    type AtlasLocation,
    type IndexPoints,
} from './store.js';

const LOG_CTX = 'atlas';

/// A rough duration for progress messages, e.g. "40 s" or "3 min"
function formatDuration(ms: number): string {
    const seconds = Math.max(1, Math.round(ms / 1000));
    if (seconds < 90) return `${seconds} s`;
    return `${Math.round(seconds / 60)} min`;
}

export type AtlasPhase =
    | { kind: 'model'; message: string; fraction: number | null }
    | { kind: 'mount'; message: string }
    | { kind: 'scan'; message: string }
    | { kind: 'index'; message: string; fraction: number }
    | { kind: 'write'; message: string }
    | { kind: 'describe'; message: string; fraction: number };

export interface LoadedIndex {
    /// The index file in the folder was loaded, nothing had to be computed
    reused: boolean;
    /// The number of scripts that were added, changed or removed since the loaded index was written
    outdated: number;
    /// The embedded descriptions in their 3D layout
    points: IndexPoints;
    /// The rows of the index file without the embeddings and the layout, row i is point i
    rows: arrow.Table;
}

export interface OpenedFolder {
    name: string;
    scripts: number;
    /// The scripts with a description, only those are indexed
    described: number;
    /// The scripts that can be described and have no description yet
    undescribed: number;
    /// Null until the folder is indexed, or if its index file cannot be loaded
    index: LoadedIndex | null;
    /// Why the index file of the folder cannot be loaded, e.g. because it was written by an older version.
    /// Indexing the folder replaces it.
    indexError: string | null;
}

export interface DescribeSummary {
    described: number;
    skipped: number;
    failed: number;
    /// The run was cancelled before all scripts were sent
    cancelled: boolean;
    /// The run stopped after too many failures in a row
    stopped: boolean;
    /// The reason of the last failure
    lastError: string | null;
}

export interface AtlasSessionOptions {
    database: EmbeddedComputeDatabase;
    core: DashQL;
    logger: Logger;
    tracker: QueryExecutionTracker;
    /// Resolved when the model is loaded, the app config may arrive after the session was created
    modelBaseUrl: () => string;
}

/// One selected folder, from mounting it to answering prompts. All Hyper SQL goes through the tracked query path of the
/// shell and all stages are logged, so both show up in the internals overlay.
export class AtlasSession {
    private readonly traced: TracedLogger;
    private readonly analyzer: SqlAnalyzer;
    private connection: EmbeddedTableImportConnection | null = null;
    private sql: AtlasSql | null = null;
    private embedder: Promise<AtlasEmbedder> | null = null;
    private location: AtlasLocation | null = null;
    /// The .sql files of the open folder as of the last scan
    private files: SqlFile[] = [];
    private mounts: EmbeddedExternalDirectoryDatabase | undefined;

    constructor(private readonly options: AtlasSessionOptions) {
        this.traced = options.logger.withTrace(createTrace());
        this.analyzer = SqlAnalyzer.fromCore(options.core);
        this.mounts = externalDirectoryDatabase(options.database);
    }

    /// Load the embedding model once. Reports download progress of the model files.
    private loadEmbedder(report: (phase: AtlasPhase) => void): Promise<AtlasEmbedder> {
        this.embedder ??= (async () => {
            const baseUrl = this.options.modelBaseUrl();
            this.traced.info('Loading embedding model', { model: ATLAS_EMBEDDER_CONFIG.model, base: baseUrl }, LOG_CTX);
            report({ kind: 'model', message: 'Loading the embedding model', fraction: null });
            const files = new Map<string, { loaded: number; total: number }>();
            try {
                const embedder = await AtlasEmbedder.create(baseUrl, ATLAS_EMBEDDER_CONFIG, progress => {
                    files.set(progress.file, { loaded: progress.loaded, total: progress.total });
                    let loaded = 0;
                    let total = 0;
                    for (const f of files.values()) {
                        loaded += f.loaded;
                        total += f.total;
                    }
                    report({
                        kind: 'model',
                        message: `Downloading the embedding model (${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB)`,
                        fraction: total > 0 ? loaded / total : null,
                    });
                });
                this.traced.info('Loaded embedding model', {}, LOG_CTX);
                return embedder;
            } catch (e) {
                this.embedder = null;
                this.traced.error('Failed to load the embedding model', { error: stringifyError(e), base: baseUrl }, LOG_CTX);
                throw new Error(`could not load the embedding model from ${baseUrl}: ${stringifyError(e)}`);
            }
        })();
        return this.embedder;
    }

    private async ensureSql(): Promise<AtlasSql> {
        if (this.sql == null) {
            this.connection = await this.options.database.connect() as EmbeddedTableImportConnection;
            this.sql = new AtlasSql(this.connection, this.options.tracker);
        }
        return this.sql;
    }

    /// Mount the folder, scan its scripts and load its index file if there is one. Nothing is computed, a folder
    /// without an index file waits for index().
    async open(directory: FileSystemDirectoryHandle, report: (phase: AtlasPhase) => void): Promise<OpenedFolder> {
        if (this.mounts == null) throw new Error('this database cannot mount folders');
        await this.closeFolder();
        const sql = await this.ensureSql();

        report({ kind: 'mount', message: `Mounting ${directory.name}` });
        this.traced.info('Mounting folder', { name: directory.name }, LOG_CTX);
        const location = await mountFolder(this.mounts, directory);
        this.location = location;

        await this.scan(report);
        if (!(await hasIndexFile(directory))) {
            this.traced.info('No index found', { name: directory.name }, LOG_CTX);
            return this.folderState(null, null);
        }
        const embedder = await this.loadEmbedder(report);
        let loaded: Omit<LoadedIndex, 'reused' | 'outdated'>;
        let indexed: Map<string, string>;
        try {
            loaded = await this.loadIndex(sql, location);
            await checkIndexModel(sql, location, embedder.config.model);
            indexed = await loadIndexedScripts(sql, location);
        } catch (e) {
            this.traced.warn('Failed to load the index', { name: directory.name, error: stringifyError(e) }, LOG_CTX);
            return this.folderState(null, `the index of ${directory.name} cannot be loaded: ${stringifyError(e)}`);
        }
        const outdated = outdatedScripts(indexed, this.indexableScripts(this.files, indexed));
        this.traced.info('Loaded the existing index', { scripts: String(this.files.length), outdated: String(outdated.length) }, LOG_CTX);
        for (const { script, change } of outdated) {
            this.traced.info('Script changed since indexing', { script, change }, INDEX_LOG_CTX);
        }
        return this.folderState({ reused: true, outdated: outdated.length, ...loaded }, null);
    }

    /// Collect the .sql files of the open folder
    private async scan(report: (phase: AtlasPhase) => void): Promise<void> {
        const directory = this.location!.directory;
        report({ kind: 'scan', message: 'Looking for .sql files' });
        const files = await scanSqlFiles(directory, count => report({ kind: 'scan', message: `Found ${count} .sql files` }));
        this.traced.info('Scanned folder', { name: directory.name, scripts: String(files.length) }, LOG_CTX);
        if (files.length === 0) {
            await this.closeFolder();
            throw new Error(`there are no .sql files in ${directory.name}`);
        }
        this.files = files;
    }

    private analyzeFiles(): AnalyzedSql[] {
        return this.analyzer.analyze(this.files.map(f => ({ id: f.id, text: f.text })));
    }

    private folderState(index: LoadedIndex | null, indexError: string | null): OpenedFolder {
        const analyzed = this.analyzeFiles();
        return {
            name: this.location!.directory.name,
            scripts: this.files.length,
            described: analyzed.filter(sql => descriptionText(extractComments(sql)) != null).length,
            undescribed: describeTargets(this.files, analyzed).length,
            index,
            indexError,
        };
    }

    /// The scripts of the folder that an index would contain. Scripts that are not in the index are only counted if they
    /// have a description, a script without one never gets a row and would always look new.
    private indexableScripts(files: SqlFile[], indexed: ReadonlyMap<string, string>): Map<string, string> {
        const unknown = files.filter(f => !indexed.has(f.id));
        const described = new Set(
            analyzeScripts(unknown, this.analyzer)
                .filter(hasDescription)
                .map(s => s.file.id),
        );
        return new Map(files.filter(f => indexed.has(f.id) || described.has(f.id)).map(f => [f.id, f.hash]));
    }

    private async loadIndex(sql: AtlasSql, location: AtlasLocation): Promise<Omit<LoadedIndex, 'reused' | 'outdated'>> {
        const table = await loadIndexTable(sql, location);
        return { points: indexPoints(table), rows: indexRowsTable(table) };
    }

    /// Scan the open folder again and build its index, an existing index file is replaced
    async index(report: (phase: AtlasPhase) => void): Promise<OpenedFolder> {
        const location = this.location;
        if (location == null) throw new Error('no folder is open');
        const sql = await this.ensureSql();
        // A span per run, with a record per script and per stage
        const log = this.traced.childSpan();
        // The scripts may have changed since the folder was opened, e.g. because they were described
        await this.scan(report);
        const embedder = await this.loadEmbedder(report);

        const startedAt = performance.now();
        log.info('Indexing scripts', { folder: location.directory.name, scripts: String(this.files.length) }, INDEX_LOG_CTX);
        const built = await buildIndex(this.files, this.analyzer, embedder, (progress: IndexProgress) => {
            report({ kind: 'index', message: progress.message, fraction: progress.fraction });
        }, log);

        report({ kind: 'write', message: 'Writing the Parquet file' });
        const writeStart = performance.now();
        await writeIndexFile(sql, location, built.rows, built.layout, embedder.config);
        log.info('Wrote the index file', { rows: String(built.rows.length), ms: String(Math.round(performance.now() - writeStart)) }, INDEX_LOG_CTX);
        const loaded = await this.loadIndex(sql, location);
        log.info('Indexed scripts', {
            scripts: String(built.analyzedScripts),
            rows: String(built.rows.length),
            layout: built.layout.mode,
            ms: String(Math.round(performance.now() - startedAt)),
        }, INDEX_LOG_CTX);
        return this.folderState({ reused: false, outdated: 0, ...loaded }, null);
    }

    /// Describe the scripts of the open folder that have no description with a model, and write the descriptions into
    /// them. The index is not touched, index() picks the descriptions up.
    /// Every script is written as soon as it is described, `onScript` learns about it right away.
    async describe(
        client: AIDescribeClient,
        report: (phase: AtlasPhase) => void,
        signal: AbortSignal,
        onScript?: (outcome: DescribeOutcome) => void,
    ): Promise<DescribeSummary> {
        if (this.location == null) throw new Error('no folder is open');
        // A span per run, the records of the scripts are spans below it
        const log = this.traced.childSpan();
        await this.scan(report);
        const excluded = new Map<DescribeExclusion, number>();
        const targets = describeTargets(this.files, this.analyzeFiles(), (file, reason) => {
            excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
            log.debug('Not describing script', { script: file.id, reason }, DESCRIBE_LOG_CTX);
        });
        log.info('Describing scripts', {
            model: client.model,
            scripts: String(targets.length),
            already_described: String(excluded.get('already described') ?? 0),
            unparsable: String(excluded.get('cannot be parsed') ?? 0),
            without_statements: String(excluded.get('has no statements') ?? 0),
        }, DESCRIBE_LOG_CTX);

        const startedAt = performance.now();
        const summary: DescribeSummary = { described: 0, skipped: 0, failed: 0, cancelled: false, stopped: false, lastError: null };
        report({ kind: 'describe', message: `Describing ${targets.length} scripts`, fraction: 0 });
        const run = await describeScripts(targets, client, signal, (done, total, outcome) => {
            if (outcome.status === 'described') ++summary.described;
            else if (outcome.status === 'skipped') ++summary.skipped;
            else if (!signal.aborted) {
                ++summary.failed;
                summary.lastError = outcome.reason;
            }
            onScript?.(outcome);
            // The scripts run in parallel, the time per finished script so far is the best guess for the rest
            const left = ((performance.now() - startedAt) / done) * (total - done);
            report({
                kind: 'describe',
                message: done < total ? `Described ${done} of ${total}, ${formatDuration(left)} left` : `Described ${done} of ${total}`,
                fraction: done / total,
            });
        }, log);
        summary.cancelled = signal.aborted;
        summary.stopped = run.stopped;
        const ms = performance.now() - startedAt;
        log.info('Described scripts', {
            described: String(summary.described),
            skipped: String(summary.skipped),
            failed: String(summary.failed),
            cancelled: String(summary.cancelled),
            stopped: String(summary.stopped),
            ms: String(Math.round(ms)),
            ms_per_script: run.outcomes.length === 0 ? undefined : String(Math.round(ms / run.outcomes.length)),
        }, DESCRIBE_LOG_CTX);
        return summary;
    }

    /// Embed the prompt and run all search strategies
    async search(prompt: string): Promise<SearchResults[]> {
        if (this.location == null || this.sql == null || this.embedder == null) throw new Error('no folder is open');
        const embedder = await this.embedder;
        const startedAt = performance.now();
        const query = await embedder.embedQuery(prompt);
        const results = await searchAll(this.sql, this.location, query);
        this.traced.info('Searched', {
            hits: results.map(r => `${r.strategy.id}=${r.hits.length}`).join(','),
            ms: String(Math.round(performance.now() - startedAt)),
        }, LOG_CTX);
        return results;
    }

    async readScript(name: string): Promise<string> {
        if (this.location == null) throw new Error('no folder is open');
        return await readSqlFile(this.location.directory, name);
    }

    async closeFolder(): Promise<void> {
        this.location = null;
        this.files = [];
        if (this.mounts != null) {
            try {
                await unmountFolder(this.mounts);
            } catch {
                // Nothing was mounted
            }
        }
    }

    async dispose(): Promise<void> {
        await this.closeFolder();
        (await this.embedder?.catch(() => null))?.dispose();
        this.embedder = null;
        await this.connection?.close();
        this.connection = null;
        this.sql = null;
    }
}
