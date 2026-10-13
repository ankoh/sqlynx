import type * as arrow from 'apache-arrow';

export interface EmbeddedTableInsertOptions {
    schema?: string;
    name: string;
    create?: boolean;
}

export interface EmbeddedConnection {
    close(): Promise<void>;
    query(query: string): Promise<arrow.Table>;
    queryArrowIPC(query: string, abort?: AbortSignal): Promise<Uint8Array>;
}

export interface EmbeddedConnectionOptions {
    defaultDatabase?: '__dashql_compute' | 'hyper';
}

export interface EmbeddedTableImportConnection extends EmbeddedConnection {
    insertArrowTable(table: arrow.Table, options: EmbeddedTableInsertOptions): Promise<void>;
    createTableAs(name: string, query: string, abort?: AbortSignal): Promise<void>;
}

export interface PersistentDatabaseMetadata {
    readonly name: string;
    readonly storage: 'memory' | 'persistent';
}

/** Optional browser-backed database management capability. */
export interface EmbeddedPersistentDatabase {
    listDatabases(): Promise<readonly PersistentDatabaseMetadata[]>;
    createPersistentDatabase(name: string): Promise<void>;
    openPersistentDatabase(name: string): Promise<void>;
    checkpointPersistentDatabase(name: string): Promise<void>;
    dropPersistentDatabase(name: string): Promise<void>;
}

export interface EmbeddedPersistentDatabaseConnection extends EmbeddedConnection {
    attachPersistentDatabase(name: string, alias: string): Promise<void>;
    detachPersistentDatabase(alias: string): Promise<void>;
}

/** Optional browser file registration capability. */
export interface OPFSFileImportOptions {
    readonly signal?: AbortSignal;
    readonly onProgress?: (bytesWritten: number) => void;
}

export interface EmbeddedExternalFileDatabase {
    registerExternalFile(name: string, blob: Blob, signal?: AbortSignal): Promise<string>;
    removeExternalFile(path: string): Promise<void>;
    importOPFSFile(path: string, blob: Blob, options?: OPFSFileImportOptions): Promise<void>;
    prepareOPFSFile(path: string): Promise<void>;
    writeOPFSFile(path: string, chunk: Uint8Array, offset: number): Promise<void>;
    finishOPFSFile(path: string): Promise<void>;
    abortOPFSFile(path: string): Promise<void>;
    removeOPFSFile(path: string): Promise<void>;
}

export type ExternalDirectoryMode = 'read' | 'readwrite';

/** Optional browser directory registration capability. */
export interface EmbeddedExternalDirectoryDatabase {
    registerExternalDirectory(handle: FileSystemDirectoryHandle, mode: ExternalDirectoryMode): Promise<string>;
    removeExternalDirectory(path: string): Promise<void>;
}

export interface EmbeddedDatabase<Connection extends EmbeddedConnection = EmbeddedConnection> {
    terminate(): void | Promise<void>;
    getVersion(): Promise<string>;
    connect(options?: EmbeddedConnectionOptions): Promise<Connection>;
}

export type EmbeddedComputeDatabase = EmbeddedDatabase<EmbeddedTableImportConnection>;
