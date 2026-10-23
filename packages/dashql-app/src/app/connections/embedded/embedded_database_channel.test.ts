import * as arrow from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';

import { AsyncConsumerLambdas } from '../../../utils/async_consumer.js';
import type { EmbeddedConnection, EmbeddedResultStream } from '../../../platform/database/embedded_database.js';
import { QueryExecutionStatus, type QueryExecutionResponseStream } from '../../../query/query_execution_state.js';
import { EmbeddedDatabaseChannel } from './embedded_database_channel.js';

/// A result stream over the batches of a table, onDone runs when it is read to the end or cancelled.
async function readTable(table: arrow.Table, onDone: () => void = () => {}): Promise<EmbeddedResultStream> {
    let next = 0;
    let done = false;
    const finish = () => {
        if (!done) {
            done = true;
            onDone();
        }
    };
    return {
        schema: table.schema,
        async next(): Promise<IteratorResult<arrow.RecordBatch>> {
            if (next < table.batches.length) return { done: false, value: table.batches[next++] };
            finish();
            return { done: true, value: undefined };
        },
        async cancel() {
            finish();
        },
        async *[Symbol.asyncIterator]() {
            for (const batch of table.batches) yield batch;
            finish();
        },
    };
}

/// Read a response stream to the end.
async function produceAll(stream: QueryExecutionResponseStream): Promise<arrow.RecordBatch[]> {
    const batches: arrow.RecordBatch[] = [];
    await stream.produce(new AsyncConsumerLambdas((_stream, batch) => batches.push(batch)), new AsyncConsumerLambdas());
    return batches;
}

/// A connection that rejects a statement while a result is still read, like a HyperDB session.
function createExclusiveConnection() {
    const running: { resolve: (table: arrow.Table) => void; reject: (error: Error) => void }[] = [];
    let active = false;
    const connection: EmbeddedConnection = {
        close: vi.fn().mockResolvedValue(undefined),
        query: vi.fn(),
        execute: vi.fn(),
        queryStream: vi.fn((): Promise<EmbeddedResultStream> => {
            if (active) return Promise.reject(new Error('connection has an active operation'));
            active = true;
            return new Promise<EmbeddedResultStream>((resolve, reject) => {
                running.push({
                    resolve: table => { void readTable(table, () => { active = false; }).then(resolve); },
                    reject: error => { active = false; reject(error); },
                });
            });
        }),
    };
    return { connection, running };
}

const ONE_ROW = arrow.tableFromArrays({ value: [1] });

describe('EmbeddedDatabaseChannel', () => {
    it('runs concurrent queries one at a time on the shared connection', async () => {
        const { connection, running } = createExclusiveConnection();
        const channel = new EmbeddedDatabaseChannel(connection);

        const first = channel.executeQuery('select 1');
        const second = channel.executeQuery('select 2');
        await vi.waitFor(() => expect(running).toHaveLength(1));
        running[0].resolve(ONE_ROW);
        const firstStream = await first;
        // The second query waits until the result of the first one is read.
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(connection.queryStream).toHaveBeenCalledOnce();

        await produceAll(firstStream);
        await vi.waitFor(() => expect(running).toHaveLength(2));
        running[1].resolve(ONE_ROW);

        expect(await produceAll(await second)).toHaveLength(1);
        expect(connection.queryStream).toHaveBeenNthCalledWith(2, 'select 2', undefined);
    });

    it('runs the next query after a failed query', async () => {
        const { connection, running } = createExclusiveConnection();
        const channel = new EmbeddedDatabaseChannel(connection);

        const first = expect(channel.executeQuery('select missing')).rejects.toThrow('column does not exist');
        const second = expect(channel.executeQuery('select 2')).resolves.toBeDefined();
        await vi.waitFor(() => expect(running).toHaveLength(1));
        running[0].reject(new Error('column does not exist'));
        await vi.waitFor(() => expect(running).toHaveLength(2));
        running[1].resolve(ONE_ROW);

        await first;
        await second;
    });

    it('runs the next query after a result stream is cancelled', async () => {
        const { connection, running } = createExclusiveConnection();
        const channel = new EmbeddedDatabaseChannel(connection);

        const first = channel.executeQuery('select 1');
        const second = channel.executeQuery('select 2');
        await vi.waitFor(() => expect(running).toHaveLength(1));
        running[0].resolve(ONE_ROW);
        const firstStream = await first;
        await firstStream.cancel!();
        expect(firstStream.getStatus()).toBe(QueryExecutionStatus.CANCELLED);

        await vi.waitFor(() => expect(running).toHaveLength(2));
        running[1].resolve(ONE_ROW);
        await expect(second).resolves.toBeDefined();
    });

    it('skips a waiting query that is cancelled', async () => {
        const { connection, running } = createExclusiveConnection();
        const channel = new EmbeddedDatabaseChannel(connection);
        const abort = new AbortController();

        const first = channel.executeQuery('select 1');
        const second = expect(channel.executeQuery('select 2', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(running).toHaveLength(1));
        abort.abort(new DOMException('cancelled', 'AbortError'));
        running[0].resolve(ONE_ROW);
        await produceAll(await first);

        await second;
        expect(connection.queryStream).toHaveBeenCalledOnce();
    });

    it('streams the result batches to the query response stream', async () => {
        const table = arrow.tableFromArrays({ value: [1, 2, 3] });
        const connection: EmbeddedConnection = {
            close: vi.fn().mockResolvedValue(undefined),
            query: vi.fn(),
            execute: vi.fn(),
            queryStream: vi.fn(() => readTable(table)),
        };
        const channel = new EmbeddedDatabaseChannel(connection);
        const stream = await channel.executeQuery('select 1');
        expect(stream.getStatus()).toBe(QueryExecutionStatus.RUNNING);

        const batches = await produceAll(stream);

        expect(connection.queryStream).toHaveBeenCalledWith('select 1', undefined);
        expect(stream.getStatus()).toBe(QueryExecutionStatus.SUCCEEDED);
        expect(stream.getMetrics().totalRowsReceived).toBe(3);
        expect(stream.getMetrics().totalBatchesReceived).toBe(table.batches.length);
        expect(stream.getMetrics().totalDataBytesReceived).toBeGreaterThan(0);
        expect(new arrow.Table((await stream.getSchema())!, batches).numRows).toBe(3);
    });

    it('honors an already-aborted query and closes the logical connection', async () => {
        const connection: EmbeddedConnection = {
            close: vi.fn().mockResolvedValue(undefined),
            query: vi.fn(),
            execute: vi.fn(),
            queryStream: vi.fn(),
        };
        const channel = new EmbeddedDatabaseChannel(connection);
        const abort = new AbortController();
        abort.abort();

        await expect(channel.executeQuery('select 1', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(connection.queryStream).not.toHaveBeenCalled();
        await channel.close();
        expect(connection.close).toHaveBeenCalledOnce();
    });

    it('forwards cancellation while a query is running', async () => {
        let signal: AbortSignal | undefined;
        const connection: EmbeddedConnection = {
            close: vi.fn().mockResolvedValue(undefined),
            query: vi.fn(),
            execute: vi.fn(),
            queryStream: vi.fn((_query, abort): Promise<EmbeddedResultStream> => {
                signal = abort;
                return new Promise<EmbeddedResultStream>((_resolve, reject) => {
                    abort?.addEventListener('abort', () => reject(abort.reason), { once: true });
                });
            }),
        };
        const channel = new EmbeddedDatabaseChannel(connection);
        const abort = new AbortController();
        const execution = channel.executeQuery('select slow()', abort.signal);
        await vi.waitFor(() => expect(connection.queryStream).toHaveBeenCalled());

        abort.abort(new DOMException('cancelled', 'AbortError'));

        await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
        expect(signal?.aborted).toBe(true);
    });
});
