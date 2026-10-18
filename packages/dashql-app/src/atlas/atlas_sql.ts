import * as arrow from 'apache-arrow';

import type { EmbeddedTableImportConnection } from '../platform/database/embedded_database.js';
import {
    QUERY_RECEIVED_ALL_BATCHES,
    createQueryResponseStreamMetrics,
    QueryType,
    type QueryExecutionTracker,
} from '../query/query_execution_state.js';
import { executeTrackedQuery } from '../query/tracked_query_execution.js';

const LOG_CTX = 'atlas';

/// Runs the SQL of the atlas through the tracked query path of the shell, so that every statement shows up in the
/// Queries tab of the internals overlay.
export class AtlasSql {
    constructor(
        private readonly connection: EmbeddedTableImportConnection,
        private readonly tracker: QueryExecutionTracker,
    ) {}

    /// Run a query and return its result
    async query(title: string, query: string): Promise<arrow.Table> {
        return await executeTrackedQuery({
            query,
            tracker: this.tracker,
            errorTarget: LOG_CTX,
            metadata: this.metadata(title),
            execute: async tracked => {
                const bytes = await this.connection.queryArrowIPC(query, tracked.cancellation.signal);
                const table = bytes.byteLength === 0 ? arrow.tableFromArrays({}) : arrow.tableFromIPC(bytes);
                const metrics = createQueryResponseStreamMetrics();
                metrics.totalDataBytesReceived = bytes.byteLength;
                metrics.totalBatchesReceived = table.batches.length;
                metrics.totalRowsReceived = table.numRows;
                tracked.dispatch({ type: QUERY_RECEIVED_ALL_BATCHES, value: [tracked.queryId, table, new Map(), metrics] });
                return table;
            },
        });
    }

    /// Run a statement without a result
    async run(title: string, statement: string): Promise<void> {
        await this.query(title, statement);
    }

    /// Load an Arrow table into a new Hyper table
    async insert(title: string, table: arrow.Table, name: string): Promise<void> {
        await executeTrackedQuery({
            query: `-- insert ${table.numRows} rows from Arrow into ${name}`,
            tracker: this.tracker,
            errorTarget: LOG_CTX,
            metadata: this.metadata(title),
            execute: async () => {
                await this.connection.insertArrowTable(table, { name, create: true });
            },
        });
    }

    private metadata(title: string) {
        return {
            queryType: QueryType.USER_PROVIDED,
            title,
            description: null,
            issuer: 'DashQL Atlas',
            userProvided: false,
        };
    }
}

export function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

export function quoteString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/// A query vector as SQL literal. The cast is required, Hyper's vector functions do not accept untyped arrays.
export function vectorLiteral(vector: Float32Array): string {
    return `ARRAY[${Array.from(vector, v => (Number.isFinite(v) ? String(v) : '0')).join(',')}]::real[]`;
}
