import type * as arrow from 'apache-arrow';

export interface EmbeddedTableInsertOptions {
    schema?: string;
    name: string;
    create?: boolean;
}

/// The record batches of a running query
export interface EmbeddedResultStream extends AsyncIterable<arrow.RecordBatch> {
    /// The schema of the result
    readonly schema: arrow.Schema;
    /// Read the next record batch
    next(): Promise<IteratorResult<arrow.RecordBatch>>;
    /// Stop reading, a query that did not finish is cancelled
    cancel(): Promise<void>;
}

export interface EmbeddedConnection {
    close(): Promise<void>;
    /// Run a query and read its whole result, statements without a result give a table without columns.
    query(query: string, abort?: AbortSignal): Promise<arrow.Table>;
    /// Run a query and stream the result batches as the engine produces them.
    /// The connection serves nothing else until the stream is read to the end or cancelled.
    queryStream(query: string, abort?: AbortSignal): Promise<EmbeddedResultStream>;
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
