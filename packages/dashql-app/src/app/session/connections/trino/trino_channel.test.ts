import { describe, expect, it, vi } from 'vitest';

import { createQueryResponseStreamMetrics } from '../query_execution_state.js';
import type { Logger } from '../../../../platform/logger/logger.js';
import type { TrinoApiClientInterface, TrinoQueryResult } from './trino_api_client.js';
import { TrinoApiEndpoint } from './trino_api_client.js';
import { TrinoQueryResultStream } from './trino_channel.js';

describe('TrinoQueryResultStream', () => {
    it('exposes the schema from an already-finished zero-row response', async () => {
        const result: TrinoQueryResult = {
            id: 'query-id',
            columns: [{ name: 'customer_id', type: 'bigint' }],
            stats: { state: 'FINISHED' },
        } as TrinoQueryResult;
        const stream = new TrinoQueryResultStream(
            { debug: vi.fn() } as unknown as Logger,
            {} as TrinoApiClientInterface,
            new TrinoApiEndpoint('https://example.com', {} as never),
            result,
            createQueryResponseStreamMetrics(),
        );

        const schema = await stream.getSchema();
        expect(schema?.fields.map(field => field.name)).toEqual(['customer_id']);
    });

    it('uses Decimal128 for Trino decimals that exceed 64-bit precision', async () => {
        const result: TrinoQueryResult = {
            id: 'query-id',
            columns: [{ name: 'amount', type: 'decimal(21, 1)' }],
            stats: { state: 'FINISHED' },
        } as TrinoQueryResult;
        const stream = new TrinoQueryResultStream(
            { debug: vi.fn() } as unknown as Logger,
            {} as TrinoApiClientInterface,
            new TrinoApiEndpoint('https://example.com', {} as never),
            result,
            createQueryResponseStreamMetrics(),
        );

        const schema = await stream.getSchema();
        const decimal = schema?.fields[0].type as import('apache-arrow').Decimal;
        expect(decimal.precision).toBe(21);
        expect(decimal.scale).toBe(1);
        expect(decimal.bitWidth).toBe(128);
    });
});
