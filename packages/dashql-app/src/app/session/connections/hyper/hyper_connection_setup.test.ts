import { vi } from 'vitest';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { setupHyperConnection } from './hyper_connection_setup.js';
import { HYPER_CHANNEL_READY } from './hyper_connection_state.js';
import { HyperDatabaseChannel, HyperDatabaseClient, HyperDatabaseConnectionContext } from './hyperdb_grpc_client.js';
import { TestLogger } from '../../../../platform/logger/test_logger.js';

describe('Hyper connection setup', () => {
    it('publishes WASM setup parameters with the ready channel', async () => {
        const channel = { close: vi.fn() } as unknown as HyperDatabaseChannel;
        const dispatch = vi.fn();
        const params = {
            protocol: 'WASM',
            endpoint: '',
            tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
        } as connection.HyperConnectionParams;
        const embedded = {
            connect: vi.fn(async () => ({})),
        };

        await setupHyperConnection(
            dispatch,
            new TestLogger(),
            params,
            {},
            null,
            null,
            vi.fn(async () => embedded as any),
            new AbortController().signal,
        );

        const ready = dispatch.mock.calls.find(([action]) => action.type === HYPER_CHANNEL_READY)?.[0];
        expect(ready?.value[1]).toEqual(params);
        expect(ready?.value[1]).not.toBe(params);
        expect(ready?.value[0]).toBeInstanceOf(Object);
        expect(channel.close).not.toHaveBeenCalled();
    });

    it('provides configured gRPC metadata to the client context', async () => {
        const channel = { close: vi.fn() } as unknown as HyperDatabaseChannel;
        let capturedContext: HyperDatabaseConnectionContext | null = null;
        const client: HyperDatabaseClient = {
            connect: vi.fn(async (_params, context) => {
                capturedContext = context;
                return channel;
            }),
        };
        const params = {
            protocol: 'V3_GRPC',
            endpoint: 'https://hyper.example.com:443',
            tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
            metadata: { 'ctx-tenant-id': 'tenant-123' },
        } as connection.HyperConnectionParams;

        await setupHyperConnection(
            vi.fn(),
            new TestLogger(),
            params,
            {},
            client,
            null,
            vi.fn(),
            new AbortController().signal,
        );

        expect(capturedContext).not.toBeNull();
        params.metadata!['ctx-tenant-id'] = 'edited-after-setup';
        expect(await capturedContext!.getRequestMetadata()).toEqual({ 'ctx-tenant-id': 'tenant-123' });
    });

    it('normalizes metadata persisted with the legacy details wrapper', async () => {
        let capturedContext: HyperDatabaseConnectionContext | null = null;
        const client: HyperDatabaseClient = {
            connect: vi.fn(async (_params, context) => {
                capturedContext = context;
                return { close: vi.fn() } as unknown as HyperDatabaseChannel;
            }),
        };
        const params = {
            protocol: 'V3_GRPC',
            endpoint: 'https://hyper.example.com:443',
            tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
            metadata: { details: { 'ctx-tenant-id': 'tenant-123' } },
        } as unknown as connection.HyperConnectionParams;

        await setupHyperConnection(
            vi.fn(),
            new TestLogger(),
            params,
            {},
            client,
            null,
            vi.fn(),
            new AbortController().signal,
        );

        expect(await capturedContext!.getRequestMetadata()).toEqual({ 'ctx-tenant-id': 'tenant-123' });
    });
});
