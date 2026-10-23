import * as arrow from 'apache-arrow';
import {
    HyperDB as HyperDBEngine,
    type HyperDBConnection as HyperDBEngineConnection,
    type MountedResource,
    type QueryInfo,
} from 'hyperdb-wasm';

import type {
    EmbeddedComputeDatabase,
    EmbeddedConnectionOptions,
    EmbeddedExternalDirectoryDatabase,
    EmbeddedExternalFileDatabase,
    EmbeddedResultStream,
    ExternalDirectoryMode,
    EmbeddedTableImportConnection,
    EmbeddedTableInsertOptions,
} from '../database/embedded_database.js';
import { prepareHyperArrowInsert } from './hyperdb_arrow_insert.js';

export { HyperDBEngine };
export type { HyperDBSettings } from 'hyperdb-wasm';
/// The client of the engine worker. Tests share one between test frames, every frame wraps it in its own HyperDBEngine.
export type HyperDBClient = ConstructorParameters<typeof HyperDBEngine>[0];
/// A response of the engine client
export type HyperDBResult = Awaited<ReturnType<HyperDBClient['connect']>>;

/// The result of statements without result, Hyper sends no Arrow IPC for them.
const EMPTY_RESULT_IPC = arrow.tableToIPC(arrow.tableFromArrays({}), 'stream');

export interface HyperDBOptions {
    /// The database of the compute tables, created on startup and dropped on termination
    computeDatabasePath?: string;
    /// The database attached as "hyper", created on startup and dropped on termination
    defaultDatabasePath?: string;
    /// Terminate the engine with the database. Tests share one engine client between databases.
    terminateEngine?: boolean;
}

/// The rows a statement affected.
/// Hyper reports a row count for every statement, but it only means affected rows for these kinds.
function readAffectedRowCount(info: QueryInfo | undefined): bigint | null {
    switch (info?.statementKind) {
        case 'COPY':
        case 'DELETE':
        case 'FETCH':
        case 'INSERT':
        case 'MERGE':
        case 'UPDATE':
            return info.rowCount;
        default:
            return null;
    }
}

async function* prependChunk(first: Uint8Array, rest: AsyncGenerator<Uint8Array, unknown>): AsyncGenerator<Uint8Array> {
    yield first;
    yield* rest;
}

async function* singleChunk(chunk: Uint8Array): AsyncGenerator<Uint8Array> {
    yield chunk;
}

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

// Pooled connections stay attached to their default database when closed and are reused.
// ATTACH is expensive since Hyper loads the statistics of every table in the database, and the compute code
// opens a connection per statement. Connections are only pooled when the caller opts in.
const MAX_IDLE_SESSIONS = 4;

export class HyperDB implements EmbeddedComputeDatabase, EmbeddedExternalFileDatabase, EmbeddedExternalDirectoryDatabase {
    private readonly sessions = new Set<HyperDBSession>();
    /// The idle pooled sessions by default database alias.
    private readonly idleSessions = new Map<string, HyperDBSession[]>();
    private initialization: Promise<void> | null = null;
    private termination: Promise<void> | null = null;
    private terminated = false;
    private databaseOperation: Promise<void> = Promise.resolve();
    private readonly terminateEngine: boolean;
    private readonly computeDatabasePath: string | null;
    private readonly defaultDatabasePath: string | null;
    private readonly externalFiles = new Map<string, MountedResource>();
    private readonly externalDirectories = new Map<string, MountedResource>();

    constructor(
        private readonly engine: HyperDBEngine,
        options: HyperDBOptions = {},
    ) {
        this.computeDatabasePath = options.computeDatabasePath ?? null;
        this.defaultDatabasePath = options.defaultDatabasePath ?? null;
        this.terminateEngine = options.terminateEngine ?? true;
    }

    static async create(engine: HyperDBEngine, options?: HyperDBOptions): Promise<HyperDB> {
        const database = new HyperDB(engine, options);
        await database.initialize();
        return database;
    }

    async connect(options: EmbeddedConnectionOptions = {}): Promise<HyperDBConnection> {
        await this.initialize();
        if (this.termination || this.terminated) {
            throw new Error('database is terminated');
        }
        const compute = options.defaultDatabase !== 'hyper';
        const alias = compute ? '__dashql_compute' : 'hyper';
        let pool: HyperDBSession[] | null = null;
        if (options.pooled) {
            pool = this.idleSessions.get(alias) ?? [];
            this.idleSessions.set(alias, pool);
        }
        const release = (session: HyperDBSession) => this.releaseSession(session, pool);

        const idle = pool?.pop();
        if (idle != null) {
            return new HyperDBConnection(idle, release);
        }

        const connection = await this.engine.connect();
        if (this.termination || this.terminated) {
            await connection.close();
            throw new Error('database is terminated');
        }

        const databasePath = compute ? this.computeDatabasePath : this.defaultDatabasePath;
        const session = new HyperDBSession(connection, this.mountFile, () => {
            this.sessions.delete(session);
        }, databasePath == null ? undefined : alias);
        try {
            if (databasePath != null) {
                await session.execute(`ATTACH DATABASE ${quoteIdentifier(databasePath)} AS ${quoteIdentifier(alias)}`);
            }
        } catch (error) {
            await session.close();
            throw error;
        }
        this.sessions.add(session);
        return new HyperDBConnection(session, release);
    }

    /// Mount a file for a statement of a session
    private readonly mountFile = async (file: File, path: string): Promise<MountedResource> =>
        await this.engine.mount(file, { path });

    private async releaseSession(session: HyperDBSession, pool: HyperDBSession[] | null): Promise<void> {
        if (pool != null && session.reusable && !this.termination && !this.terminated
            && pool.length < MAX_IDLE_SESSIONS) {
            pool.push(session);
            return;
        }
        await session.close();
    }

    async getVersion(): Promise<string> {
        const connection = await this.connect();
        try {
            const result = await connection.query('SELECT version() AS version');
            const version = result.getChild('version')?.get(0);
            if (typeof version !== 'string') {
                throw new Error('version query returned an invalid result');
            }
            return version;
        } finally {
            await connection.close();
        }
    }

    async registerExternalFile(name: string, blob: Blob, path?: string, signal?: AbortSignal): Promise<string> {
        return await this.runDatabaseOperation(async () => {
            throwIfAborted(signal);
            path ??= externalMountPath(name);
            validateExternalMountPath(path);
            // The engine wants a file name without separators, the last path component is one.
            const file = new File([blob], path.slice(path.lastIndexOf('/') + 1), { type: blob.type });
            const resource = await this.engine.mount(file, { path });
            if (signal?.aborted) {
                try {
                    await resource.close();
                } catch {
                    // Termination retries the removal.
                    this.externalFiles.set(path, resource);
                }
                throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
            }
            this.externalFiles.set(path, resource);
            return path;
        });
    }

    async removeExternalFile(path: string): Promise<void> {
        await this.runDatabaseOperation(async () => {
            const resource = this.externalFiles.get(path);
            if (resource == null) throw new Error(`external file is not registered: ${path}`);
            await resource.close();
            this.externalFiles.delete(path);
        });
    }

    async registerExternalDirectory(
        handle: FileSystemDirectoryHandle,
        path: string | undefined,
        mode: ExternalDirectoryMode,
    ): Promise<string> {
        return await this.runDatabaseOperation(async () => {
            path ??= externalMountPath(handle.name);
            validateExternalMountPath(path);
            const resource = await this.engine.mount(handle, { path, mode });
            this.externalDirectories.set(path, resource);
            return path;
        });
    }

    async removeExternalDirectory(path: string): Promise<void> {
        await this.runDatabaseOperation(async () => {
            const resource = this.externalDirectories.get(path);
            if (resource == null) throw new Error(`external directory is not registered: ${path}`);
            await resource.close();
            this.externalDirectories.delete(path);
        });
    }

    async terminate(): Promise<void> {
        if (this.terminated) {
            return;
        }
        if (!this.termination) {
            this.termination = (async () => {
                try {
                    await this.databaseOperation;
                    this.idleSessions.clear();
                    await Promise.all([...this.sessions].map(session => session.closeForTermination()));
                    for (const mounts of [this.externalFiles, this.externalDirectories]) {
                        for (const [path, resource] of mounts) {
                            await resource.close();
                            mounts.delete(path);
                        }
                    }
                    if (this.computeDatabasePath != null) {
                        await this.executeDatabaseStatement(`DROP DATABASE ${quoteIdentifier(this.computeDatabasePath)}`);
                    }
                    if (this.defaultDatabasePath != null) {
                        await this.executeDatabaseStatement(`DROP DATABASE ${quoteIdentifier(this.defaultDatabasePath)}`);
                    }
                    if (this.terminateEngine) {
                        await this.engine.terminate();
                    }
                    this.terminated = true;
                } catch (error) {
                    this.termination = null;
                    throw error;
                }
            })();
        }
        await this.termination;
    }

    private async initialize(): Promise<void> {
        if (this.terminated) {
            throw new Error('database is terminated');
        }
        if (!this.initialization) {
            this.initialization = (async () => {
                await this.engine.ready();
                if (this.computeDatabasePath != null) {
                    await this.executeDatabaseStatement(`CREATE DATABASE ${quoteIdentifier(this.computeDatabasePath)}`);
                }
                if (this.defaultDatabasePath != null) {
                    await this.executeDatabaseStatement(`CREATE DATABASE ${quoteIdentifier(this.defaultDatabasePath)}`);
                }
            })().catch(error => {
                this.initialization = null;
                throw error;
            });
        }
        await this.initialization;
    }

    private async runDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.databaseOperation;
        let release!: () => void;
        this.databaseOperation = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            if (this.termination || this.terminated) throw new Error('database is terminated');
            return await operation();
        } finally {
            release();
        }
    }

    private async executeDatabaseStatement(statement: string): Promise<void> {
        const session = new HyperDBSession(await this.engine.connect(), this.mountFile, () => {});
        try {
            await session.execute(statement);
        } finally {
            await session.close();
        }
    }
}

function externalMountPath(name: string): string {
    // Mount paths allow only ASCII components and at most 200 bytes below /mnt/external/.
    const component = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    return `/mnt/external/${!component || component === '.' || component === '..' ? 'file' : component}`;
}

function validateExternalMountPath(path: string): void {
    const prefix = '/mnt/external/';
    const relativePath = path.startsWith(prefix) ? path.slice(prefix.length) : '';
    if (
        relativePath.length === 0 ||
        new TextEncoder().encode(relativePath).byteLength > 200 ||
        relativePath.split('/').some(component => !/^[A-Za-z0-9._-]+$/.test(component) || component === '.' || component === '..')
    ) {
        throw new Error('external mount path must be below /mnt/external/ with ASCII path components');
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/// A connection lease handed out by HyperDB.connect().
/// Closing it releases the physical session, which HyperDB may hand to the next lease.
/// The lease stays closed, so a stale reference cannot run statements on a reused session.
export class HyperDBConnection implements EmbeddedTableImportConnection {
    private closed = false;

    constructor(
        private readonly session: HyperDBSession,
        private readonly release: (session: HyperDBSession) => Promise<void>,
    ) {}

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        if (this.session.active) {
            throw new Error('connection has an active operation');
        }
        this.closed = true;
        await this.release(this.session);
    }

    async query(query: string, abort?: AbortSignal): Promise<arrow.Table> {
        this.checkOpen();
        return await this.session.query(query, abort);
    }

    async queryStream(query: string, abort?: AbortSignal): Promise<EmbeddedResultStream> {
        this.checkOpen();
        return await this.session.queryStream(query, abort);
    }

    async execute(statement: string, abort?: AbortSignal): Promise<bigint | null> {
        this.checkOpen();
        return await this.session.execute(statement, abort);
    }

    async insertArrowTable(table: arrow.Table, options: EmbeddedTableInsertOptions): Promise<void> {
        this.checkOpen();
        await this.session.insertArrowTable(table, options);
    }

    async createTableAs(name: string, query: string, abort?: AbortSignal): Promise<void> {
        this.checkOpen();
        await this.session.createTableAs(name, query, abort);
    }

    private checkOpen(): void {
        if (this.closed) {
            throw new Error('connection is closed');
        }
    }
}

/// The result batches of a session query.
/// Arrow readers never close their source, so the stream stops the query of the session itself.
class HyperDBResultStream implements EmbeddedResultStream {
    constructor(
        /// The reader of the Arrow IPC chunks
        private readonly reader: arrow.AsyncRecordBatchStreamReader,
        /// Stops the query and waits until the session is free
        private readonly stop: () => Promise<void>,
    ) {}

    get schema(): arrow.Schema {
        return this.reader.schema;
    }

    async next(): Promise<IteratorResult<arrow.RecordBatch>> {
        try {
            const next = await this.reader.next();
            if (next.done) await this.stop();
            return next;
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async cancel(): Promise<void> {
        await this.stop();
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<arrow.RecordBatch> {
        try {
            for (let next = await this.next(); !next.done; next = await this.next()) {
                yield next.value;
            }
        } finally {
            await this.stop();
        }
    }
}

/// The running query of a session
interface HyperDBSessionQuery {
    /// The Arrow IPC chunks of the query
    chunks: AsyncGenerator<Uint8Array, QueryInfo | undefined>;
    /// Cancels the query when the session terminates
    cancellation: AbortController;
}

/// A physical engine connection.
class HyperDBSession {
    private closed = false;
    /// Set while an operation runs, the engine connection serves one at a time.
    active = false;
    /// Cleared when a query could not be cancelled or finished, the session must not be reused then.
    reusable = true;
    private closing: Promise<void> | null = null;
    /// The running query, if any
    private current: HyperDBSessionQuery | null = null;

    constructor(
        private readonly connection: HyperDBEngineConnection,
        private readonly mountFile: (file: File, path: string) => Promise<MountedResource>,
        private readonly onClose: () => void,
        private readonly databaseAlias?: string,
    ) {}

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        if (this.active) {
            throw new Error('connection has an active operation');
        }
        await this.closeImpl();
    }

    async query(query: string, abort?: AbortSignal): Promise<arrow.Table> {
        const stream = await this.queryStream(query, abort);
        const batches: arrow.RecordBatch[] = [];
        for await (const batch of stream) {
            batches.push(batch);
        }
        return new arrow.Table(stream.schema, batches);
    }

    async queryStream(query: string, abort?: AbortSignal): Promise<EmbeddedResultStream> {
        this.begin();
        const chunks = this.startQuery(query, abort);
        const cancellation = this.current!.cancellation;
        const stop = async () => {
            cancellation.abort(new DOMException('The result stream was cancelled', 'AbortError'));
            await chunks.return(undefined).catch(() => {});
        };
        const first = await chunks.next();
        const source = first.done ? singleChunk(EMPTY_RESULT_IPC) : prependChunk(first.value, chunks);
        try {
            const reader = await arrow.RecordBatchReader.from(source);
            if (!reader.isAsync() || !reader.isStream()) {
                throw new Error('query did not produce an Arrow stream');
            }
            await reader.open();
            return new HyperDBResultStream(reader, stop);
        } catch (error) {
            await stop();
            throw error;
        }
    }

    async execute(statement: string, abort?: AbortSignal): Promise<bigint | null> {
        this.begin();
        return await this.drain(this.startQuery(statement, abort));
    }

    /// Insert an Arrow table through an external scan of its Arrow IPC stream, mounted as a file.
    async insertArrowTable(table: arrow.Table, options: EmbeddedTableInsertOptions): Promise<void> {
        if (!options.name) {
            throw new Error('Arrow insert table name must not be empty');
        }
        const insert = prepareHyperArrowInsert(table);
        this.begin();
        let resource: MountedResource | null = null;
        try {
            const name = `__dashql_insert_${crypto.randomUUID().replace(/-/g, '_')}.arrows`;
            const path = `/mnt/external/${name}`;
            // tableToIPC writes into a fresh ArrayBuffer.
            const bytes = arrow.tableToIPC(insert.table, 'stream') as Uint8Array<ArrayBuffer>;
            resource = await this.mountFile(new File([bytes], name), path);
            const target = options.schema == null
                ? quoteIdentifier(options.name)
                : `${quoteIdentifier(options.schema)}.${quoteIdentifier(options.name)}`;
            const source = `SELECT * FROM external(${quoteLiteral(path)}, format => 'arrowstream', columns => descriptor(${insert.columns}))`;
            await this.drain(this.startQuery(
                options.create ?? true ? `CREATE TABLE ${target} AS ${source}` : `INSERT INTO ${target} ${source}`,
            ));
        } finally {
            this.active = false;
            await resource?.close();
        }
    }

    /// Read the chunks of a statement to the end and return the rows it affected.
    private async drain(chunks: AsyncGenerator<Uint8Array, QueryInfo | undefined>): Promise<bigint | null> {
        let next = await chunks.next();
        while (!next.done) {
            next = await chunks.next();
        }
        return readAffectedRowCount(next.value);
    }

    async createTableAs(name: string, query: string, abort?: AbortSignal): Promise<void> {
        await this.execute(`CREATE TABLE ${quoteIdentifier(name)} AS ${query}`, abort);
    }

    async closeForTermination(): Promise<void> {
        const current = this.current;
        if (current != null) {
            current.cancellation.abort(new Error('database is terminating'));
            await current.chunks.return(undefined).catch(() => {});
            // A query that never started has nothing running in the engine.
            if (this.current === current) this.finishQuery();
        }
        while (this.active) {
            await yieldToEventLoop();
        }
        await this.closeImpl();
    }

    /// Start a query of the running operation, the returned chunks run it as they are read.
    private startQuery(query: string, abort?: AbortSignal): AsyncGenerator<Uint8Array, QueryInfo | undefined> {
        const cancellation = new AbortController();
        const signal = abort == null ? cancellation.signal : AbortSignal.any([abort, cancellation.signal]);
        const chunks = this.readChunks(query, signal);
        this.current = { chunks, cancellation };
        return chunks;
    }

    private async *readChunks(query: string, signal: AbortSignal): AsyncGenerator<Uint8Array, QueryInfo | undefined> {
        const stream = this.connection.queryStreamIPC(query, { signal });
        const chunks = stream[Symbol.asyncIterator]();
        try {
            for (;;) {
                const next = await chunks.next();
                if (next.done) break;
                yield next.value;
            }
            return await stream.info;
        } finally {
            // An aborted scan rejects at once, return() waits until the engine connection finished the query.
            await chunks.return?.(undefined).catch(() => {});
            // The query information is only missing when the query could not be cancelled or finished.
            if (!signal.aborted && !await stream.info.then(() => true, () => false)) {
                this.reusable = false;
            }
            this.finishQuery();
        }
    }

    private begin(): void {
        this.checkOpen();
        if (this.active) {
            throw new Error('connection has an active operation');
        }
        this.active = true;
    }

    private finishQuery(): void {
        this.current = null;
        this.active = false;
    }

    private async closeImpl(): Promise<void> {
        if (!this.closing) {
            this.closing = (async () => {
                if (this.databaseAlias != null) {
                    await this.execute(`DETACH DATABASE ${quoteIdentifier(this.databaseAlias)}`);
                }
                await this.connection.close();
                this.closed = true;
                this.onClose();
            })().catch(error => {
                this.closing = null;
                throw error;
            });
        }
        await this.closing;
    }

    private checkOpen(): void {
        if (this.closed) {
            throw new Error('connection is closed');
        }
    }
}

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}
