import { describe, expect, it } from 'vitest';

import { QueryExecutionStatus } from '../connections/query_execution_state.js';
import { deriveEntryStatus, getQueryStatusText } from './entry_status_model.js';

describe('getQueryStatusText', () => {
    it.each([
        [QueryExecutionStatus.REQUESTED, 'Requested statement 2 of 3'],
        [QueryExecutionStatus.PREPARING, 'Preparing statement 2 of 3'],
        [QueryExecutionStatus.SENDING, 'Sending statement 2 of 3'],
        [QueryExecutionStatus.QUEUED, 'Statement 2 of 3 queued'],
        [QueryExecutionStatus.RUNNING, 'Executing statement 2 of 3'],
        [QueryExecutionStatus.RECEIVED_FIRST_BATCH, 'Executing statement 2 of 3, fetching results'],
        [QueryExecutionStatus.RECEIVED_ALL_BATCHES, 'Executing statement 2 of 3, received all results'],
        [QueryExecutionStatus.PROCESSING_RESULTS, 'Processing results for statement 2 of 3'],
        [QueryExecutionStatus.PROCESSED_RESULTS, 'Processed results for statement 2 of 3'],
        [QueryExecutionStatus.FAILED, 'Statement 2 of 3 execution failed'],
        [QueryExecutionStatus.CANCELLED, 'Statement 2 of 3 execution was cancelled'],
        [QueryExecutionStatus.SUCCEEDED, 'Statement 2 of 3 executed successfully'],
    ])('includes the statement position for status %s', (status, expected) => {
        expect(getQueryStatusText(status, 2, 3)).toBe(expected);
    });

    it('includes the statement count when the latest statement succeeded before the script completed', () => {
        expect(getQueryStatusText(QueryExecutionStatus.RUNNING, 2, 3, true))
            .toBe('Statement 2 of 3 executed successfully');
    });

    it('keeps single-statement status messages concise', () => {
        expect(getQueryStatusText(QueryExecutionStatus.RUNNING, 1, 1)).toBe('Executing query');
        expect(getQueryStatusText(QueryExecutionStatus.SUCCEEDED, 1, 1)).toBe('Statement executed successfully');
    });

    it('includes the statement position in a custom failure message', () => {
        const status = deriveEntryStatus({
            queryId: 7,
            status: QueryExecutionStatus.FAILED,
            statementIndex: 2,
            statementCount: 3,
            queryText: 'select * from missing',
            queryMetadata: { title: 'Missing relation' },
            error: {
                message: 'relation does not exist',
                keyValues: { sqlState: '42P01', hint: 'Check the table name' },
                target: 'trino',
            },
            metrics: null,
            traceId: 42,
        } as any);

        expect(status.message).toBe('Statement 2 of 3: relation does not exist');
        expect(status.errorDetail).toEqual({
            status: 'failed',
            message: 'Statement 2 of 3: relation does not exist',
            target: 'trino',
            queryId: 7,
            traceId: 42,
            statementIndex: 2,
            statementCount: 3,
            query: 'select * from missing',
            metadata: { title: 'Missing relation' },
            details: { sqlState: '42P01', hint: 'Check the table name' },
        });
    });

    it('provides error details even when the connector only supplies a message', () => {
        const status = deriveEntryStatus({
            queryId: 7,
            status: QueryExecutionStatus.FAILED,
            statementIndex: null,
            statementCount: null,
            queryText: 'select 1',
            queryMetadata: null,
            error: { message: 'connection lost', keyValues: {} },
            metrics: null,
            traceId: 42,
        } as any);

        expect(status.errorDetail).toEqual({
            status: 'failed',
            message: 'connection lost',
            queryId: 7,
            traceId: 42,
            query: 'select 1',
        });
    });

    it('includes the statement position in a cached result message when available', () => {
        const status = deriveEntryStatus({
            status: QueryExecutionStatus.SUCCEEDED,
            statementIndex: 3,
            statementCount: 3,
            servedFromCache: true,
            metrics: null,
            traceId: 42,
        } as any);

        expect(status.message).toBe('Statement 3 of 3: Result loaded from cache');
    });
});
