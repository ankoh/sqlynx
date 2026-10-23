import { QueryExecutionState, QueryExecutionStatus, queryIsDone } from '../../../query/query_execution_state.js';
import { IndicatorStatus } from '../../../ui/foundations/status_indicator.js';

/// Which source produced the status shown in the bar.
export const enum EntryStatusKind {
    Query = 0,
    Idle = 1,
}

/// The presentation-ready status for one session entry, derived from its latest query execution.
/// Every entry has a status, including entries that
/// have not run yet, so the server card always has a stable status header.
export interface EntryStatus {
    kind: EntryStatusKind;
    /// The spinner/check/cross state.
    indicator: IndicatorStatus;
    /// The single-line query status message.
    message: string;
    /// The trace to reveal in the footer log when the bar is clicked.
    traceId: number | null;
    /// Everything known about a failed query, shown in the status bar's error-details overlay.
    /// Null for non-error statuses.
    errorDetail: Record<string, unknown> | null;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null));
}

function getQueryErrorDetail(query: QueryExecutionState, message: string): Record<string, unknown> {
    const error = query.error;
    return compactObject({
        status: query.status === QueryExecutionStatus.FAILED ? 'failed' : 'cancelled',
        message,
        target: error?.target,
        queryId: query.queryId,
        traceId: query.traceId,
        statementIndex: query.statementIndex,
        statementCount: query.statementCount,
        query: query.queryText,
        metadata: query.queryMetadata,
        details: error != null && Object.keys(error.keyValues).length > 0 ? error.keyValues : undefined,
    });
}

function getStatementStatusText(message: string, statementIndex: number | null, statementCount: number | null): string {
    return statementIndex != null && statementCount != null && statementCount > 1
        ? `Statement ${statementIndex} of ${statementCount}: ${message}`
        : message;
}

/// Human-readable label for a query execution status. Shared by the feed status bar and the Details
/// query status panel so both stay in sync.
export function getQueryStatusText(
    status: QueryExecutionStatus,
    statementIndex: number | null = null,
    statementCount: number | null = null,
    statementSucceeded: boolean = false,
): string {
    const hasMultipleStatements = statementIndex != null && statementCount != null && statementCount > 1;
    if (hasMultipleStatements && statementSucceeded && !queryIsDone(status)) {
        return `Statement ${statementIndex} of ${statementCount} executed successfully`;
    }
    switch (status) {
        case QueryExecutionStatus.REQUESTED:
            return hasMultipleStatements
                ? `Requested statement ${statementIndex} of ${statementCount}`
                : 'Requested query';
        case QueryExecutionStatus.PREPARING:
            return hasMultipleStatements
                ? `Preparing statement ${statementIndex} of ${statementCount}`
                : 'Preparing query';
        case QueryExecutionStatus.SENDING:
            return hasMultipleStatements
                ? `Sending statement ${statementIndex} of ${statementCount}`
                : 'Sending query';
        case QueryExecutionStatus.QUEUED:
            return hasMultipleStatements
                ? `Statement ${statementIndex} of ${statementCount} queued`
                : 'Queued query';
        case QueryExecutionStatus.RUNNING:
            return hasMultipleStatements
                ? `Executing statement ${statementIndex} of ${statementCount}`
                : 'Executing query';
        case QueryExecutionStatus.RECEIVED_FIRST_BATCH:
            return hasMultipleStatements
                ? `Executing statement ${statementIndex} of ${statementCount}, fetching results`
                : 'Executing query, fetching results';
        case QueryExecutionStatus.RECEIVED_ALL_BATCHES:
            return hasMultipleStatements
                ? `Executing statement ${statementIndex} of ${statementCount}, received all results`
                : 'Executing query, received all results';
        case QueryExecutionStatus.PROCESSING_RESULTS:
            return hasMultipleStatements
                ? `Processing results for statement ${statementIndex} of ${statementCount}`
                : 'Processing results';
        case QueryExecutionStatus.PROCESSED_RESULTS:
            return hasMultipleStatements
                ? `Processed results for statement ${statementIndex} of ${statementCount}`
                : 'Processed results';
        case QueryExecutionStatus.FAILED:
            return hasMultipleStatements
                ? `Statement ${statementIndex} of ${statementCount} execution failed`
                : 'Statement execution failed';
        case QueryExecutionStatus.CANCELLED:
            return hasMultipleStatements
                ? `Statement ${statementIndex} of ${statementCount} execution was cancelled`
                : 'Statement execution was cancelled';
        case QueryExecutionStatus.SUCCEEDED:
            return hasMultipleStatements
                ? `Statement ${statementIndex} of ${statementCount} executed successfully`
                : 'Statement executed successfully';
    }
}

/// Derive the status bar contents for a session entry from its query execution.
export function deriveEntryStatus(query: QueryExecutionState | null): EntryStatus {
    if (query != null && !queryIsDone(query.status)) {
        return {
            kind: EntryStatusKind.Query,
            indicator: IndicatorStatus.Running,
            message: getQueryStatusText(
                query.status,
                query.statementIndex,
                query.statementCount,
                query.statementSucceeded,
            ),
            traceId: query.traceId,
            errorDetail: null,
        };
    }
    if (query != null && (query.status === QueryExecutionStatus.FAILED || query.status === QueryExecutionStatus.CANCELLED)) {
        const message = query.error?.message != null
            ? getStatementStatusText(query.error.message, query.statementIndex, query.statementCount)
            : getQueryStatusText(query.status, query.statementIndex, query.statementCount);
        return {
            kind: EntryStatusKind.Query,
            indicator: IndicatorStatus.Failed,
            message,
            traceId: query.traceId,
            errorDetail: getQueryErrorDetail(query, message),
        };
    }
    if (query != null) {
        return {
            kind: EntryStatusKind.Query,
            indicator: IndicatorStatus.Succeeded,
            message: query.status === QueryExecutionStatus.SUCCEEDED && query.servedFromCache
                ? getStatementStatusText('Result loaded from cache', query.statementIndex, query.statementCount)
                : getQueryStatusText(query.status, query.statementIndex, query.statementCount),
            traceId: query.traceId,
            errorDetail: null,
        };
    }
    return {
        kind: EntryStatusKind.Idle,
        indicator: IndicatorStatus.None,
        message: 'Not run yet',
        traceId: null,
        errorDetail: null,
    };
}
