import * as arrow from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';

import { AsyncConsumerLambdas } from '../../../../utils/async_consumer.js';
import type { EmbeddedConnection } from '../../../../platform/database/embedded_database.js';
import { QueryExecutionStatus } from '../query_execution_state.js';
import { EmbeddedDatabaseChannel } from './embedded_database_channel.js';

/// A connection that rejects a statement while another one is running, like a HyperDB session.
function createExclusiveConnection() {
    const running: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }[] = [];
    let active = false;
    const connection: EmbeddedConnection = {
        close: vi.fn().mockResolvedValue(undefined),
        query: vi.fn(),
        queryArrowIPC: vi.fn((): Promise<Uint8Array> => {
            if (active) return Promise.reject(new Error('connection has an active operation'));
            active = true;
            return new Promise<Uint8Array>((resolve, reject) => {
                running.push({
                    resolve: bytes => { active = false; resolve(bytes); },
                    reject: error => { active = false; reject(error); },
                });
            });
        }),
    };
    return { connection, running };
}

const ONE_ROW = arrow.tableToIPC(arrow.tableFromArrays({ value: [1] }), 'stream');

describe('EmbeddedDatabaseChannel', () => {
    it('runs concurrent queries one at a time on the shared connection', async () => {
        const { connection, running } = createExclusiveConnection();
        const channel = new EmbeddedDatabaseChannel(connection);

        const first = channel.executeQuery('select 1');
        const second = channel.executeQuery('select 2');
        await vi.waitFor(() => expect(running).toHaveLength(1));
        expect(connection.queryArrowIPC).toHaveBeenCalledOnce();

        running[0].resolve(ONE_ROW);
        await vi.waitFor(() => expect(running).toHaveLength(2));
        running[1].resolve(ONE_ROW);

        await expect(first).resolves.toBeDefined();
        await expect(second).resolves.toBeDefined();
        expect(connection.queryArrowIPC).toHaveBeenNthCalledWith(2, 'select 2', undefined);
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

    it('skips a waiting query that is cancelled', async () => {
        const { connection, running } = createExclusiveConnection();
        const channel = new EmbeddedDatabaseChannel(connection);
        const abort = new AbortController();

        const first = expect(channel.executeQuery('select 1')).resolves.toBeDefined();
        const second = expect(channel.executeQuery('select 2', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(running).toHaveLength(1));
        abort.abort(new DOMException('cancelled', 'AbortError'));
        running[0].resolve(ONE_ROW);

        await first;
        await second;
        expect(connection.queryArrowIPC).toHaveBeenCalledOnce();
    });

    it('adapts Arrow IPC results to the query response stream', async () => {
        const table = arrow.tableFromArrays({ value: [1, 2, 3] });
        const bytes = arrow.tableToIPC(table, 'stream');
        const connection: EmbeddedConnection = {
            close: vi.fn().mockResolvedValue(undefined),
            query: vi.fn(),
            queryArrowIPC: vi.fn().mockResolvedValue(bytes),
        };
        const channel = new EmbeddedDatabaseChannel(connection);
        const stream = await channel.executeQuery('select 1');
        const batches: arrow.RecordBatch[] = [];

        await stream.produce(new AsyncConsumerLambdas((_stream, batch) => batches.push(batch)), new AsyncConsumerLambdas());

        expect(connection.queryArrowIPC).toHaveBeenCalledWith('select 1', undefined);
        expect(stream.getStatus()).toBe(QueryExecutionStatus.SUCCEEDED);
        expect(stream.getMetrics().totalRowsReceived).toBe(3);
        expect(stream.getMetrics().totalBatchesReceived).toBe(table.batches.length);
        expect(new arrow.Table((await stream.getSchema())!, batches).numRows).toBe(3);
    });

    it('honors an already-aborted query and closes the logical connection', async () => {
        const connection: EmbeddedConnection = {
            close: vi.fn().mockResolvedValue(undefined),
            query: vi.fn(),
            queryArrowIPC: vi.fn(),
        };
        const channel = new EmbeddedDatabaseChannel(connection);
        const abort = new AbortController();
        abort.abort();

        await expect(channel.executeQuery('select 1', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(connection.queryArrowIPC).not.toHaveBeenCalled();
        await channel.close();
        expect(connection.close).toHaveBeenCalledOnce();
    });

    it('forwards cancellation while a query is running', async () => {
        let signal: AbortSignal | undefined;
        const connection: EmbeddedConnection = {
            close: vi.fn().mockResolvedValue(undefined),
            query: vi.fn(),
            queryArrowIPC: vi.fn((_query, abort): Promise<Uint8Array> => {
                signal = abort;
                return new Promise<Uint8Array>((_resolve, reject) => {
                    abort?.addEventListener('abort', () => reject(abort.reason), { once: true });
                });
            }),
        };
        const channel = new EmbeddedDatabaseChannel(connection);
        const abort = new AbortController();
        const execution = channel.executeQuery('select slow()', abort.signal);
        await vi.waitFor(() => expect(connection.queryArrowIPC).toHaveBeenCalled());

        abort.abort(new DOMException('cancelled', 'AbortError'));

        await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
        expect(signal?.aborted).toBe(true);
    });
});
