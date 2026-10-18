import type { DashQL } from '@ankoh/dashql-core';

import type {
    EmbeddedComputeDatabase,
    EmbeddedExternalDirectoryDatabase,
    EmbeddedTableImportConnection,
} from '../platform/database/embedded_database.js';
import type { Logger, TracedLogger } from '../platform/logger/logger.js';
import { stringifyError } from '../platform/logger/logger.js';
import { createTrace } from '../platform/logger/trace_context.js';
import type { QueryExecutionTracker } from '../query/query_execution_state.js';
import { AtlasSql } from './atlas_sql.js';
import { SqlAnalyzer } from './index/analysis/core.js';
import { AtlasEmbedder } from './index/embedder_client.js';
import { analyzeScripts, buildIndex, EMBEDDING_KINDS, hasEmbeddableText, type IndexProgress } from './index/indexer.js';
import { ATLAS_EMBEDDER_CONFIG, type Embedder } from './index/model.js';
import { readSqlFile, scanSqlFiles, type SqlFile } from './index/scan.js';
import { searchAll, type SearchResults } from './search/search.js';
import {
    countOutdatedScripts,
    externalDirectoryDatabase,
    hasIndexFiles,
    loadIndexedScripts,
    loadIndexPoints,
    mountFolder,
    unmountFolder,
    writeIndexFiles,
    type AtlasLocation,
    type EmbeddingKind,
    type IndexPoints,
} from './store.js';

const LOG_CTX = 'atlas';

export type AtlasPhase =
    | { kind: 'model'; message: string; fraction: number | null }
    | { kind: 'mount'; message: string }
    | { kind: 'scan'; message: string }
    | { kind: 'index'; message: string; fraction: number }
    | { kind: 'write'; message: string };

export interface OpenedFolder {
    name: string;
    scripts: number;
    /// The index files in the folder were loaded, nothing had to be computed
    reused: boolean;
    /// The number of scripts that were added, changed or removed since the loaded index was written
    outdated: number;
    /// The embeddings of every index file in their 3D layouts
    points: Record<EmbeddingKind, IndexPoints>;
}

/// The index files of a folder exist but cannot be loaded, e.g. because they were written by an older version.
/// The folder stays open so that it can be reindexed.
export class AtlasIndexUnreadable extends Error {
    constructor(readonly folder: string, cause: unknown) {
        super(`the index of ${folder} cannot be loaded: ${stringifyError(cause)}`);
    }
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

    /// Mount the folder, load the index files or build them, and get ready for prompts. A folder without index files is
    /// indexed, index files that cannot be loaded throw AtlasIndexUnreadable. `force` builds the index in any case.
    async open(directory: FileSystemDirectoryHandle, report: (phase: AtlasPhase) => void, force = false): Promise<OpenedFolder> {
        if (this.mounts == null) throw new Error('this database cannot mount folders');
        await this.closeFolder();
        const sql = await this.ensureSql();

        report({ kind: 'mount', message: `Mounting ${directory.name}` });
        this.traced.info('Mounting folder', { name: directory.name }, LOG_CTX);
        const location = await mountFolder(this.mounts, directory);
        this.location = location;

        report({ kind: 'scan', message: 'Looking for .sql files' });
        const files = await scanSqlFiles(directory, count => report({ kind: 'scan', message: `Found ${count} .sql files` }));
        this.traced.info('Scanned folder', { name: directory.name, scripts: String(files.length) }, LOG_CTX);
        if (files.length === 0) {
            await this.closeFolder();
            throw new Error(`there are no .sql files in ${directory.name}`);
        }

        const embedder = await this.loadEmbedder(report);
        if (!force && await hasIndexFiles(directory)) {
            let points: Record<EmbeddingKind, IndexPoints>;
            let indexed: Map<string, string>;
            try {
                points = await this.loadPoints(sql, location);
                indexed = await loadIndexedScripts(sql, location);
            } catch (e) {
                this.traced.warn('Failed to load the index', { name: directory.name, error: stringifyError(e) }, LOG_CTX);
                throw new AtlasIndexUnreadable(directory.name, e);
            }
            const outdated = countOutdatedScripts(indexed, this.indexableScripts(files, indexed, embedder));
            this.traced.info('Loaded the existing index', { scripts: String(files.length), outdated: String(outdated) }, LOG_CTX);
            return { name: directory.name, scripts: files.length, reused: true, outdated, points };
        }
        this.traced.info(force ? 'Reindexing on request' : 'No index found, indexing', {}, LOG_CTX);
        await this.index(directory, location, files, embedder, sql, report);
        return { name: directory.name, scripts: files.length, reused: false, outdated: 0, points: await this.loadPoints(sql, location) };
    }

    /// The scripts of the folder that an index would contain. Scripts that are not in the index are only counted if they
    /// have something to embed, an empty or comment-only script never gets a row and would always look new.
    private indexableScripts(files: SqlFile[], indexed: ReadonlyMap<string, string>, embedder: Embedder): Map<string, string> {
        const unknown = files.filter(f => !indexed.has(f.id));
        const embeddable = new Set(
            analyzeScripts(unknown, this.analyzer, t => embedder.countTokens(t), embedder.config.maxTokens)
                .filter(hasEmbeddableText)
                .map(s => s.file.id),
        );
        return new Map(files.filter(f => indexed.has(f.id) || embeddable.has(f.id)).map(f => [f.id, f.hash]));
    }

    /// Build the index of the open folder again, e.g. after the embedder or the analysis changed
    async reindex(report: (phase: AtlasPhase) => void): Promise<OpenedFolder> {
        if (this.location == null) throw new Error('no folder is open');
        return await this.open(this.location.directory, report, true);
    }

    private async loadPoints(sql: AtlasSql, location: AtlasLocation): Promise<Record<EmbeddingKind, IndexPoints>> {
        const points: Partial<Record<EmbeddingKind, IndexPoints>> = {};
        for (const kind of EMBEDDING_KINDS) {
            points[kind] = await loadIndexPoints(sql, location, kind);
        }
        return points as Record<EmbeddingKind, IndexPoints>;
    }

    private async index(
        directory: FileSystemDirectoryHandle,
        location: AtlasLocation,
        files: SqlFile[],
        embedder: Embedder,
        sql: AtlasSql,
        report: (phase: AtlasPhase) => void,
    ): Promise<void> {
        const startedAt = performance.now();
        const built = await buildIndex(files, this.analyzer, embedder, (progress: IndexProgress) => {
            report({ kind: 'index', message: progress.message, fraction: progress.fraction });
        });
        this.traced.info('Built the index', {
            scripts: String(built.analyzedScripts),
            structure: String(built.structure.length),
            description: String(built.description.length),
            properties: String(built.properties.length),
            structureLayout: built.layouts.structure.mode,
            descriptionLayout: built.layouts.description.mode,
            propertiesLayout: built.layouts.properties.mode,
            ms: String(Math.round(performance.now() - startedAt)),
        }, LOG_CTX);

        report({ kind: 'write', message: 'Writing the Parquet files' });
        await writeIndexFiles(sql, location, built, built.layouts, embedder.config.dim);
        this.traced.info('Wrote the index files', { name: directory.name }, LOG_CTX);
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
