import * as arrow from 'apache-arrow';

import type {
    EmbeddedComputeDatabase,
    EmbeddedConnectionOptions,
    EmbeddedExternalDirectoryDatabase,
    EmbeddedExternalFileDatabase,
    ExternalDirectoryMode,
    OPFSFileImportOptions,
    EmbeddedTableImportConnection,
    EmbeddedTableInsertOptions,
} from '../database/embedded_database.js';

const DATABASE_SCHEMA = 'public';

export interface HyperDBOptions {
    computeDatabasePath?: string;
    defaultDatabasePath?: string;
    terminateClient?: boolean;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
}

export type HyperDBResult =
    | { state: 'ok'; payload: Uint8Array }
    | { state: 'pending' }
    | { state: 'chunk'; payload: Uint8Array }
    | { state: 'done' }
    | { state: 'error'; error: string | HyperDBError }
    | { state: 'busy'; error: string };

interface HyperDBError {
    message: string;
    sqlState: string;
    errorSource: 'User' | 'System' | 'OverloadRejection';
    detail: string;
    hint: string;
}

type HyperDBSettingValue = string | number | boolean | null | readonly HyperDBSettingValue[] | {
    readonly [key: string]: HyperDBSettingValue;
};
export type HyperDBSettings = Readonly<Record<string, HyperDBSettingValue>>;

export interface HyperDBEngineClient {
    ready(): Promise<void>;
    initialize(settings: string): Promise<HyperDBResult>;
    connect(): Promise<HyperDBResult>;
    disconnect(connection: number): Promise<HyperDBResult>;
    startQuery(connection: number, sql: string): Promise<HyperDBResult>;
    insertArrowIPCFromPath(
        connection: number,
        path: string,
        name: string,
        schema: string | null,
        create: boolean,
        internal: boolean,
    ): Promise<HyperDBResult>;
    createTemporaryFile(bytes: Uint8Array): Promise<HyperDBResult>;
    removeFile(path: string): Promise<HyperDBResult>;
    registerExternalFile(name: string, url: string, size: number): Promise<HyperDBResult>;
    registerExternalDirectory(handle: FileSystemDirectoryHandle, mode: ExternalDirectoryMode): Promise<HyperDBResult>;
    removeExternalRegistration(path: string): Promise<HyperDBResult>;
    importOPFSFile?(path: string, blob: Blob, options?: OPFSFileImportOptions): Promise<void>;
    prepareOPFSFile?(path: string): Promise<void>;
    writeOPFSFile?(path: string, chunk: Uint8Array, offset: number): Promise<void>;
    finishOPFSFile?(path: string): Promise<void>;
    abortOPFSFile?(path: string): Promise<void>;
    removeOPFSFile?(path: string): Promise<void>;
    pollQuery(query: number): Promise<HyperDBResult>;
    cancelQuery(query: number): Promise<HyperDBResult>;
    finishQuery(query: number): Promise<HyperDBResult>;
    shutdown(): Promise<HyperDBResult>;
    terminate(): Promise<void>;
}

function readError(result: HyperDBResult, operation: string): Error {
    if (result.state === 'error' || result.state === 'busy') {
        return new Error(typeof result.error === 'string' ? result.error : result.error.message);
    }
    return new Error(`${operation} returned unexpected state ${result.state}`);
}

function expectOK(result: HyperDBResult, operation: string): asserts result is Extract<HyperDBResult, { state: 'ok' }> {
    if (result.state !== 'ok') {
        throw readError(result, operation);
    }
}

function readHandle(result: HyperDBResult, operation: string): number {
    expectOK(result, operation);
    if (result.payload.byteLength !== 4) {
        throw new Error(`${operation} returned an invalid handle`);
    }
    return new DataView(result.payload.buffer, result.payload.byteOffset, result.payload.byteLength).getUint32(0, true);
}

function concatChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
    const result = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

function decodeArrowTable(buffer: Uint8Array): arrow.Table {
    return new arrow.Table(arrow.RecordBatchReader.from(buffer));
}

function materializeDictionaryColumns(table: arrow.Table): arrow.Table {
    const dictionaryColumns = table.schema.fields
        .map((field, index) => arrow.DataType.isDictionary(field.type) ? index : -1)
        .filter(index => index !== -1);
    if (dictionaryColumns.length === 0) {
        return table;
    }

    const fields = table.schema.fields.map(field => arrow.DataType.isDictionary(field.type)
        ? field.clone({ type: (field.type as arrow.Dictionary).dictionary })
        : field);
    const batches = table.batches.map(batch => {
        let result = batch;
        for (const index of dictionaryColumns) {
            const column = result.getChildAt(index);
            const sourceField = table.schema.fields[index];
            if (!column || !sourceField) {
                throw new Error(`Arrow table is missing column ${index}`);
            }
            const dictionary = sourceField.type as arrow.Dictionary;
            result = result.setChildAt(index, arrow.vectorFromArray([...column], dictionary.dictionary));
        }
        return result;
    });
    return new arrow.Table(new arrow.Schema(fields, table.schema.metadata, null, table.schema.metadataVersion), batches);
}

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export class HyperDB implements EmbeddedComputeDatabase, EmbeddedExternalFileDatabase, EmbeddedExternalDirectoryDatabase {
    private readonly connections = new Set<HyperDBConnection>();
    private initialization: Promise<void> | null = null;
    private termination: Promise<void> | null = null;
    private terminated = false;
    private databaseOperation: Promise<void> = Promise.resolve();
    private readonly terminateClient: boolean;
    private readonly computeDatabasePath: string | null;
    private readonly defaultDatabasePath: string | null;
    private readonly createObjectURL: (blob: Blob) => string;
    private readonly revokeObjectURL: (url: string) => void;
    private readonly externalFiles = new Map<string, string>();
    private readonly externalDirectories = new Set<string>();

    constructor(
        private readonly client: HyperDBEngineClient,
        private readonly settings?: HyperDBSettings,
        options: HyperDBOptions = {},
    ) {
        this.computeDatabasePath = options.computeDatabasePath ?? null;
        this.defaultDatabasePath = options.defaultDatabasePath ?? null;
        this.terminateClient = options.terminateClient ?? true;
        this.createObjectURL = options.createObjectURL ?? (blob => URL.createObjectURL(blob));
        this.revokeObjectURL = options.revokeObjectURL ?? (url => URL.revokeObjectURL(url));
    }

    static async create(
        client: HyperDBEngineClient,
        settings?: HyperDBSettings,
        options?: HyperDBOptions,
    ): Promise<HyperDB> {
        const database = new HyperDB(client, settings, options);
        await database.initialize();
        return database;
    }

    async connect(options: EmbeddedConnectionOptions = {}): Promise<HyperDBConnection> {
        await this.initialize();
        if (this.termination || this.terminated) {
            throw new Error('database is terminated');
        }

        const connectionHandle = readHandle(await this.client.connect(), 'connect');
        if (this.termination || this.terminated) {
            expectOK(await this.client.disconnect(connectionHandle), 'disconnect');
            throw new Error('database is terminated');
        }

        const databasePath = options.defaultDatabase === 'hyper' ? this.defaultDatabasePath : this.computeDatabasePath;
        const alias = options.defaultDatabase === 'hyper' ? 'hyper' : '__dashql_compute';
        const connection = new HyperDBConnection(this.client, connectionHandle, () => {
            this.connections.delete(connection);
        }, databasePath == null ? undefined : alias);
        try {
            if (databasePath != null) {
                await connection.query(`ATTACH DATABASE ${quoteIdentifier(databasePath)} AS ${quoteIdentifier(alias)}`);
            }
        } catch (error) {
            await connection.close();
            throw error;
        }
        this.connections.add(connection);
        return connection;
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

    async registerExternalFile(name: string, blob: Blob, signal?: AbortSignal): Promise<string> {
        return await this.runDatabaseOperation(async () => {
            throwIfAborted(signal);
            const url = this.createObjectURL(blob);
            let path: string | null = null;
            let registered = false;
            try {
                const result = await this.client.registerExternalFile(name, url, blob.size);
                expectOK(result, 'register external file');
                registered = true;
                path = new TextDecoder('utf-8', { fatal: true }).decode(result.payload);
                if (!path.startsWith('/mnt/external/')) {
                    const removal = await this.client.removeExternalRegistration(path);
                    if (removal.state === 'ok') registered = false;
                    else this.externalFiles.set(path, url);
                    throw new Error('register external file returned an invalid path');
                }
                if (signal?.aborted) {
                    const removal = await this.client.removeExternalRegistration(path);
                    if (removal.state === 'ok') registered = false;
                    else this.externalFiles.set(path, url);
                    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
                }
                this.externalFiles.set(path, url);
                return path;
            } catch (error) {
                if (!registered) this.revokeObjectURL(url);
                throw error;
            }
        });
    }

    async removeExternalFile(path: string): Promise<void> {
        await this.runDatabaseOperation(async () => {
            const url = this.externalFiles.get(path);
            if (url == null) throw new Error(`external file is not registered: ${path}`);
            expectOK(await this.client.removeExternalRegistration(path), 'remove external file');
            this.externalFiles.delete(path);
            this.revokeObjectURL(url);
        });
    }

    async registerExternalDirectory(handle: FileSystemDirectoryHandle, mode: ExternalDirectoryMode): Promise<string> {
        return await this.runDatabaseOperation(async () => {
            const result = await this.client.registerExternalDirectory(handle, mode);
            expectOK(result, 'register external directory');
            const path = new TextDecoder('utf-8', { fatal: true }).decode(result.payload);
            if (!path.startsWith('/mnt/external/')) {
                await this.client.removeExternalRegistration(path).catch(() => {});
                throw new Error('register external directory returned an invalid path');
            }
            this.externalDirectories.add(path);
            return path;
        });
    }

    async removeExternalDirectory(path: string): Promise<void> {
        await this.runDatabaseOperation(async () => {
            if (!this.externalDirectories.has(path)) throw new Error(`external directory is not registered: ${path}`);
            expectOK(await this.client.removeExternalRegistration(path), 'remove external directory');
            this.externalDirectories.delete(path);
        });
    }

    async importOPFSFile(path: string, blob: Blob, options?: OPFSFileImportOptions): Promise<void> {
        if (this.client.importOPFSFile == null) throw new Error('importing OPFS files is not supported');
        await this.client.importOPFSFile(path, blob, options);
    }

    async prepareOPFSFile(path: string): Promise<void> {
        if (this.client.prepareOPFSFile == null) throw new Error('preparing OPFS files is not supported');
        await this.client.prepareOPFSFile(path);
    }

    async writeOPFSFile(path: string, chunk: Uint8Array, offset: number): Promise<void> {
        if (this.client.writeOPFSFile == null) throw new Error('writing OPFS files is not supported');
        await this.client.writeOPFSFile(path, chunk, offset);
    }

    async finishOPFSFile(path: string): Promise<void> {
        if (this.client.finishOPFSFile == null) throw new Error('finishing OPFS files is not supported');
        await this.client.finishOPFSFile(path);
    }

    async abortOPFSFile(path: string): Promise<void> {
        if (this.client.abortOPFSFile == null) throw new Error('aborting OPFS files is not supported');
        await this.client.abortOPFSFile(path);
    }

    async removeOPFSFile(path: string): Promise<void> {
        if (this.client.removeOPFSFile == null) throw new Error('removing OPFS files is not supported');
        await this.client.removeOPFSFile(path);
    }

    async terminate(): Promise<void> {
        if (this.terminated) {
            return;
        }
        if (!this.termination) {
            this.termination = (async () => {
                try {
                    await this.databaseOperation;
                    await Promise.all([...this.connections].map(connection => connection.closeForTermination()));
                    for (const [path, url] of this.externalFiles) {
                        expectOK(await this.client.removeExternalRegistration(path), 'remove external file during termination');
                        this.externalFiles.delete(path);
                        this.revokeObjectURL(url);
                    }
                    for (const path of this.externalDirectories) {
                        expectOK(await this.client.removeExternalRegistration(path), 'remove external directory during termination');
                        this.externalDirectories.delete(path);
                    }
                    if (this.computeDatabasePath != null) {
                        await this.executeDatabaseStatement(`DROP DATABASE ${quoteIdentifier(this.computeDatabasePath)}`);
                    }
                    if (this.defaultDatabasePath != null) {
                        await this.executeDatabaseStatement(`DROP DATABASE ${quoteIdentifier(this.defaultDatabasePath)}`);
                    }
                    if (this.terminateClient) {
                        expectOK(await this.client.shutdown(), 'shutdown');
                        await this.client.terminate();
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
                await this.client.ready();
                if (this.settings) {
                    expectOK(
                        await this.client.initialize(JSON.stringify(this.settings)),
                        'initialize HyperDB settings',
                    );
                }
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
        const connection = new HyperDBConnection(this.client, readHandle(await this.client.connect(), 'connect'), () => {});
        try {
            await connection.query(statement);
        } finally {
            await connection.close();
        }
    }

}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

export class HyperDBConnection implements EmbeddedTableImportConnection {
    private closed = false;
    private active = false;
    private closing: Promise<void> | null = null;

    constructor(
        private readonly client: HyperDBEngineClient,
        private readonly connectionHandle: number,
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

    async query(query: string): Promise<arrow.Table> {
        return decodeArrowTable(await this.queryArrowIPC(query));
    }

    async queryArrowIPC(query: string, abort?: AbortSignal): Promise<Uint8Array> {
        return await this.run(async () => {
            abort?.throwIfAborted();
            let queryHandle: number | null = null;
            const chunks: Uint8Array[] = [];
            let byteLength = 0;
            let terminal = false;
            try {
                queryHandle = readHandle(await this.client.startQuery(this.connectionHandle, query), 'start query');
                for (;;) {
                    abort?.throwIfAborted();
                    let result = await this.client.pollQuery(queryHandle);
                    while (result.state === 'pending') {
                        await yieldToEventLoop();
                        abort?.throwIfAborted();
                        result = await this.client.pollQuery(queryHandle);
                    }
                    if (result.state === 'chunk') {
                        chunks.push(result.payload);
                        byteLength += result.payload.byteLength;
                        continue;
                    }
                    terminal = true;
                    if (result.state === 'done') {
                        return concatChunks(chunks, byteLength);
                    }
                    throw readError(result, 'poll query');
                }
            } finally {
                let cleanupError: unknown;
                if (queryHandle !== null && !terminal) {
                    try {
                        expectOK(await this.client.cancelQuery(queryHandle), 'cancel query');
                    } catch (error) {
                        cleanupError = error;
                    }
                }
                if (queryHandle !== null) {
                    try {
                        await this.finishQuery(queryHandle);
                    } catch (error) {
                        cleanupError ??= error;
                    }
                }
                if (cleanupError) {
                    throw cleanupError;
                }
            }
        });
    }

    async insertArrowTable(table: arrow.Table, options: EmbeddedTableInsertOptions): Promise<void> {
        if (!options.name) {
            throw new Error('Arrow insert table name must not be empty');
        }
        await this.run(async () => {
            let path: string | null = null;
            try {
                const bytes = arrow.tableToIPC(materializeDictionaryColumns(table), 'stream');
                const temporaryFile = await this.client.createTemporaryFile(bytes);
                expectOK(temporaryFile, 'create temporary Arrow IPC file');
                path = new TextDecoder().decode(temporaryFile.payload);

                const queryHandle = readHandle(await this.client.insertArrowIPCFromPath(
                    this.connectionHandle,
                    path,
                    options.name,
                    options.schema ?? DATABASE_SCHEMA,
                    options.create ?? true,
                    true,
                ), 'insert Arrow IPC from path');
                try {
                    for (;;) {
                        let result = await this.client.pollQuery(queryHandle);
                        while (result.state === 'pending') {
                            await yieldToEventLoop();
                            result = await this.client.pollQuery(queryHandle);
                        }
                        if (result.state === 'chunk') {
                            continue;
                        }
                        if (result.state === 'done') {
                            return;
                        }
                        throw readError(result, 'insert Arrow IPC from path');
                    }
                } finally {
                    await this.finishQuery(queryHandle);
                }
            } finally {
                if (path !== null) {
                    expectOK(await this.client.removeFile(path), 'remove temporary Arrow IPC file');
                }
            }
        });
    }

    async createTableAs(name: string, query: string, abort?: AbortSignal): Promise<void> {
        this.checkOpen();
        await this.queryArrowIPC(`CREATE TABLE ${quoteIdentifier(name)} AS ${query}`, abort);
    }

    async closeForTermination(): Promise<void> {
        while (this.active) {
            await yieldToEventLoop();
        }
        await this.closeImpl();
    }

    private async run<T>(operation: () => Promise<T>): Promise<T> {
        this.checkOpen();
        if (this.active) {
            throw new Error('connection has an active operation');
        }
        this.active = true;
        try {
            return await operation();
        } finally {
            this.active = false;
        }
    }

    private async closeImpl(): Promise<void> {
        if (!this.closing) {
            this.closing = (async () => {
                if (this.databaseAlias != null) {
                    await this.queryArrowIPC(`DETACH DATABASE ${quoteIdentifier(this.databaseAlias)}`);
                }
                expectOK(await this.client.disconnect(this.connectionHandle), 'disconnect');
                this.closed = true;
                this.onClose();
            })().catch(error => {
                this.closing = null;
                throw error;
            });
        }
        await this.closing;
    }

    private async finishQuery(query: number): Promise<void> {
        let delay = 1;
        for (;;) {
            const result = await this.client.finishQuery(query);
            if (result.state === 'ok') {
                return;
            }
            if (result.state !== 'pending') {
                throw readError(result, 'finish query');
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 32);
        }
    }

    private checkOpen(): void {
        if (this.closed) {
            throw new Error('connection is closed');
        }
    }
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}
