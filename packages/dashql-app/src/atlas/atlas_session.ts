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
import { buildIndex, type IndexProgress } from './index/indexer.js';
import { ATLAS_EMBEDDER_CONFIG, type Embedder } from './index/model.js';
import { readSqlFile, scanSqlFiles, type SqlFile } from './index/scan.js';
import {
    ATLAS_FORMAT_VERSION,
    isIndexCurrent,
    readSidecar,
    writeSidecar,
    type AtlasSidecar,
} from './index/sidecar.js';
import { searchAll, type SearchResults } from './search/search.js';
import {
    externalDirectoryDatabase,
    indexFilesReadable,
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
    /// The index files in the folder were current, nothing had to be computed
    reused: boolean;
    /// The embeddings of both index files in their 3D layouts
    points: Record<EmbeddingKind, IndexPoints>;
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

    /// Mount the folder, load the index files or build them, and get ready for prompts. `force` builds the index even if
    /// the existing one is current.
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
        const hashes = new Map(files.map(f => [f.id, f.hash]));
        const sidecar = await readSidecar(directory);
        const current = !force && isIndexCurrent(sidecar, ATLAS_EMBEDDER_CONFIG, hashes) && await indexFilesReadable(sql, location);
        if (current) {
            this.traced.info('Reusing the existing index', { scripts: String(files.length) }, LOG_CTX);
            return { name: directory.name, scripts: files.length, reused: true, points: await this.loadPoints(sql, location) };
        }
        this.traced.info(force ? 'Reindexing on request' : sidecar ? 'The index is outdated, indexing' : 'No index found, indexing', {}, LOG_CTX);
        await this.index(directory, location, files, embedder, sql, report);
        return { name: directory.name, scripts: files.length, reused: false, points: await this.loadPoints(sql, location) };
    }

    /// Build the index of the open folder again, e.g. after the embedder or the analysis changed
    async reindex(report: (phase: AtlasPhase) => void): Promise<OpenedFolder> {
        if (this.location == null) throw new Error('no folder is open');
        return await this.open(this.location.directory, report, true);
    }

    private async loadPoints(sql: AtlasSql, location: AtlasLocation): Promise<Record<EmbeddingKind, IndexPoints>> {
        return {
            features: await loadIndexPoints(sql, location, 'features'),
            comments: await loadIndexPoints(sql, location, 'comments'),
        };
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
            features: String(built.features.length),
            comments: String(built.comments.length),
            featureLayout: built.featureLayout.mode,
            commentLayout: built.commentLayout.mode,
            ms: String(Math.round(performance.now() - startedAt)),
        }, LOG_CTX);

        report({ kind: 'write', message: 'Writing the Parquet files' });
        await writeIndexFiles(sql, location, built.comments, built.features, built.featureLayout.coords, built.commentLayout.coords, embedder.config.dim);
        const sidecar: AtlasSidecar = {
            formatVersion: ATLAS_FORMAT_VERSION,
            embedder: ATLAS_EMBEDDER_CONFIG,
            layout: built.features.length + built.comments.length > 0 ? 'umap-3d' : 'none',
            layoutScales: { features: built.featureLayout.scale, comments: built.commentLayout.scale },
            scripts: Object.fromEntries(files.map(f => [f.id, f.hash])),
            createdAt: new Date().toISOString(),
        };
        await writeSidecar(directory, sidecar);
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
