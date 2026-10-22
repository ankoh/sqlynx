// @vitest-environment node

import * as arrow from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';

import type {
    QueryExecutionProgress,
    QueryExecutionResponseStream,
} from '../../../query/query_execution_state.js';
import { QueryExecutionStatus } from '../../../query/query_execution_state.js';
import { LogLevel } from '../../../platform/logger/log_buffer.js';
import { TestLogger } from '../../../platform/logger/test_logger.js';
import { createTrace } from '../../../platform/logger/trace_context.js';
import { HyperHttpError } from './hyper/hyperdb_http_client.js';
import { logQueryFailure } from './query_executor.js';
import { consumeQueryResponseStream } from './query_execution.js';

function createStream(table: arrow.Table): QueryExecutionResponseStream {
    const metrics = {
        totalDataBytesReceived: 0,
        totalBatchesReceived: table.batches.length,
        totalRowsReceived: table.numRows,
        totalQueryRequestsStarted: 1,
        totalQueryRequestsSucceeded: 1,
        totalQueryRequestsFailed: 0,
        totalQueryRequestDurationMs: 0,
        durationUntilFirstBatchMs: 0,
    };
    return {
        getMetadata: () => new Map(),
        getMetrics: () => metrics,
        getStatus: () => QueryExecutionStatus.SUCCEEDED,
        getSchema: async () => table.schema,
        produce: async (batches, progress) => {
            progress.resolve(null!, { isQueued: false, metrics });
            for (const batch of table.batches) batches.resolve(null!, batch);
        },
    };
}

describe('consumeQueryResponseStream', () => {
    it('publishes batches and builds the output table', async () => {
        const input = arrow.tableFromArrays({ value: [1, 2, 3] });
        const stream = createStream(input);
        const onProgress = vi.fn<(progress: QueryExecutionProgress) => void>();
        const onBatch = vi.fn();

        const result = await consumeQueryResponseStream({
            stream,
            publishResults: true,
            onProgress,
            onBatch,
        });

        expect(result?.numRows).toBe(3);
        expect(result?.getChild('value')?.toArray()).toEqual(input.getChild('value')?.toArray());
        expect(onProgress).toHaveBeenCalledOnce();
        expect(onBatch).toHaveBeenCalledTimes(input.batches.length);
    });

    it('drains command results without publishing or requesting a schema', async () => {
        const input = arrow.tableFromArrays({ ignored: [1] });
        const stream = createStream(input);
        stream.getSchema = vi.fn(stream.getSchema);
        const onBatch = vi.fn();

        const result = await consumeQueryResponseStream({
            stream,
            publishResults: false,
            onProgress: vi.fn(),
            onBatch,
        });

        expect(result).toBeNull();
        expect(onBatch).not.toHaveBeenCalled();
        expect(stream.getSchema).not.toHaveBeenCalled();
    });

    it('reports execution completion before constructing the result table', async () => {
        const input = arrow.tableFromArrays({ value: [1] });
        const stream = createStream(input);
        const events: string[] = [];
        stream.produce = async () => {};
        stream.getSchema = async () => {
            events.push('schema');
            return input.schema;
        };

        await consumeQueryResponseStream({
            stream,
            publishResults: true,
            onProgress: vi.fn(),
            onResultsReceived: () => events.push('execution'),
        });

        expect(events).toEqual(['execution', 'schema']);
    });
});

describe('logQueryFailure', () => {
    it('records HTTP diagnostics at error level on the query trace', () => {
        const logger = new TestLogger();
        const trace = createTrace();
        const failure = new HyperHttpError(400, null, {
            status: '400',
            hyperdbStatusPresent: 'false',
            bodyType: 'array',
            bodyKeys: 'message,errorCode',
        });

        logQueryFailure(logger.withTrace(trace), failure, 2, 'session-1');

        expect(logger.buffer.collectTraceLogs(trace.traceId)).toMatchObject([{
            level: LogLevel.Error,
            target: 'hyperdb_http_client',
            message: 'HTTP 400',
            keyValues: {
                queryId: '2',
                sessionId: 'session-1',
                status: '400',
                hyperdbStatusPresent: 'false',
                bodyType: 'array',
                bodyKeys: 'message,errorCode',
            },
        }]);
    });
});
