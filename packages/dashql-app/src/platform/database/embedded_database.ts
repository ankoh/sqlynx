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
    /// Run a statement without a result, returns the affected rows of COPY, DELETE, FETCH, INSERT, MERGE and UPDATE.
    execute(statement: string, abort?: AbortSignal): Promise<bigint | null>;
}

export interface EmbeddedConnectionOptions {
    defaultDatabase?: '__dashql_compute' | 'hyper';
    /// Reuse an idle connection and return it to a pool on close.
    /// Only for callers that leave no session state behind, such as settings, transactions or temporary tables.
    pooled?: boolean;
}

export interface EmbeddedTableImportConnection extends EmbeddedConnection {
    insertArrowTable(table: arrow.Table, options: EmbeddedTableInsertOptions): Promise<void>;
    createTableAs(name: string, query: string, abort?: AbortSignal): Promise<void>;
}

export interface EmbeddedExternalFileDatabase {
    registerExternalFile(name: string, blob: Blob, path?: string, signal?: AbortSignal): Promise<string>;
    removeExternalFile(path: string): Promise<void>;
}

export type ExternalDirectoryMode = 'read' | 'readwrite';

/** Optional browser directory registration capability. */
export interface EmbeddedExternalDirectoryDatabase {
    registerExternalDirectory(
        handle: FileSystemDirectoryHandle,
        path: string | undefined,
        mode: ExternalDirectoryMode,
    ): Promise<string>;
    removeExternalDirectory(path: string): Promise<void>;
}

export interface EmbeddedDatabase<Connection extends EmbeddedConnection = EmbeddedConnection> {
    terminate(): void | Promise<void>;
    getVersion(): Promise<string>;
    connect(options?: EmbeddedConnectionOptions): Promise<Connection>;
}

export type EmbeddedComputeDatabase = EmbeddedDatabase<EmbeddedTableImportConnection>;
