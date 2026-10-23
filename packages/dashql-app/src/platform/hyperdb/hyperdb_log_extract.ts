import type { EmbeddedConnection } from '../database/embedded_database.js';
import {
    quoteLiteral,
    type HyperDBExtractColumn,
    type HyperDBExtractState,
    type HyperDBExtractTable,
    type HyperDBIncrementalExtractSource,
} from './hyperdb_incremental_extract.js';
import { quoteIdentifier } from './hyperdb_wasm.js';

/// The columns of hyper_log(), with ctx and v as JSON text.
export const HYPER_LOG_COLUMNS: readonly HyperDBExtractColumn[] = [
    { name: 'ts', type: 'TIMESTAMP' },
    { name: 'pid', type: 'BIGINT' },
    { name: 'tid', type: 'TEXT' },
    { name: 'sev', type: 'TEXT' },
    { name: 'req', type: 'TEXT' },
    { name: 'sess', type: 'TEXT' },
    { name: 'coordinating-req', type: 'TEXT' },
    { name: 'coordinating-sess', type: 'TEXT' },
    { name: 'ctx', type: 'TEXT' },
    { name: 'k', type: 'TEXT' },
    { name: 'v', type: 'TEXT' },
];

/// An extract table with the unchanged log events.
export const HYPER_LOG_EVENTS_TABLE: HyperDBExtractTable = {
    name: 'events',
    query: 'SELECT * FROM log',
};

/// An extract table with one row per finished query.
export const HYPER_LOG_QUERY_ENDS_TABLE: HyperDBExtractTable = {
    name: 'query_ends',
    query: `
        SELECT
            ts,
            sess,
            req,
            k AS outcome,
            v::json->>'statement' AS statement,
            v::json->>'query-trunc' AS query,
            (v::json->>'elapsed')::double precision AS elapsed,
            (v::json->>'rows')::bigint AS rows,
            v::json->>'error-code' AS error_code
        FROM log
        WHERE k LIKE 'query-end%'
    `,
};

/// A number of a resource-metrics event, NULL for the gauges that the platform does not record and logs as `{}`.
function resourceMetric(path: readonly string[], type: string): string {
    const parents = path.slice(0, -1).map(key => `->${quoteLiteral(key)}`).join('');
    return `nullif(v::json${parents}->>${quoteLiteral(path[path.length - 1])}, '{}')::${type}`;
}

/// An extract table with one row per resource-metrics event, which Hyper writes every log_resource_usage_interval.
/// The process memory is the size of the Wasm memory, which never shrinks. The transaction memory is the memory that
/// the running queries hold. The loads are between 0 and 1.
export const HYPER_LOG_RESOURCE_METRICS_TABLE: HyperDBExtractTable = {
    name: 'resource_metrics',
    query: `
        SELECT
            ts,
            ${resourceMetric(['memory', 'process_physical_memory_mb'], 'double precision')} AS process_memory_mb,
            ${resourceMetric(['memory', 'total_physical_memory_mb'], 'double precision')} AS total_memory_mb,
            ${resourceMetric(['mem-trackers', 'memory_tracked_current_usage_mb', 'global_transactions'], 'double precision')} AS transaction_memory_mb,
            ${resourceMetric(['load', 'overall_load'], 'double precision')} AS overall_load,
            ${resourceMetric(['load', 'scheduler_load'], 'double precision')} AS scheduler_load,
            ${resourceMetric(['load', 'memory_load'], 'double precision')} AS memory_load,
            ${resourceMetric(['scheduler-thread-count', 'scheduler_thread_count', 'active'], 'integer')} AS active_threads,
            ${resourceMetric(['scheduler-thread-count', 'scheduler_waiting_jobs_count'], 'integer')} AS waiting_jobs
        FROM log
        WHERE k = 'resource-metrics'
    `,
};

/// The state key of the session ids of all monitor connections that ever read the log.
export const HYPER_LOG_MONITOR_SESSION_KEY = 'hyper_log.monitor_session';

/// The Hyper log as the source of an incremental extract, the relation `log` of its queries.
///
/// The source connection is a long-lived monitor connection that keeps the log cursor in its session: an update reads
/// the events since the last `RESET hyper_log_scope_start`, and advancing resets it. The cursor dies with the
/// connection, the backfill of the next open reads the retained log files from the watermark instead.
/// The events of the monitor sessions are never read.
///
/// Limits:
/// - Events that other sessions write between the end of an update's log scan and its reset are only recovered by the
///   backfill of the next open.
/// - Log files that were rotated out, or written by an earlier Hyper process, cannot be backfilled.
/// - The source query only sees the events of one update or backfill, e.g. not the earlier events of a session.
export class HyperDBLogSource implements HyperDBIncrementalExtractSource {
    readonly relation = 'log';
    readonly columns = HYPER_LOG_COLUMNS;
    readonly watermarkColumn = 'ts';
    /// The session ids of the monitor connections, known after open()
    private monitorSessions: string[] = [];

    constructor(
        /// A query over the relation `log` with the source events that selects the events to extract,
        /// e.g. `SELECT * FROM log WHERE sess <> '-' AND k LIKE 'query-%'`. It returns the columns of hyper_log().
        private readonly sourceQuery = 'SELECT * FROM log',
    ) {}

    async open(connection: EmbeddedConnection, state: HyperDBExtractState): Promise<void> {
        await state.add(HYPER_LOG_MONITOR_SESSION_KEY, await readSessionId(connection));
        this.monitorSessions = await state.values(HYPER_LOG_MONITOR_SESSION_KEY);
        // Start the scope before the backfill, the first update reads the events that both read again.
        await connection.execute('RESET hyper_log_scope_start');
    }

    backfillQuery(since: string | null): string {
        return this.query(false, since);
    }

    updateQuery(): string {
        return this.query(true, null);
    }

    async advance(connection: EmbeddedConnection): Promise<void> {
        await connection.execute('RESET hyper_log_scope_start');
    }

    /// The source query over the scoped or watermarked log, without the events of monitor sessions.
    private query(scoped: boolean, since: string | null): string {
        const predicates = since == null ? [] : [since];
        if (this.monitorSessions.length > 0) {
            predicates.push(`sess IS NULL OR sess NOT IN (${this.monitorSessions.map(quoteLiteral).join(', ')})`);
        }
        return `
            WITH log AS (
                SELECT ${HYPER_LOG_COLUMNS.map(({ name, type }) =>
                    `${quoteIdentifier(name)}::${type} AS ${quoteIdentifier(name)}`).join(', ')}
                FROM hyper_log(current_session := false, last_log_scope := ${scoped})
                ${predicates.length > 0 ? `WHERE ${predicates.map(predicate => `(${predicate})`).join(' AND ')}` : ''}
            ),
            source_query AS (${this.sourceQuery})
            SELECT * FROM source_query
        `;
    }
}

async function readSessionId(connection: EmbeddedConnection): Promise<string> {
    const result = await connection.query(
        "SELECT sess FROM hyper_log(current_session := true) WHERE sess <> '-' LIMIT 1",
    );
    const session = result.getChild('sess')?.get(0);
    if (typeof session !== 'string') throw new Error('could not read the Hyper session id of the log monitor');
    return session;
}
