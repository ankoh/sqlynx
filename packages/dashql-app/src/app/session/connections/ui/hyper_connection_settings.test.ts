import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import {
    HYPERDB_WASM_ENGINE_SETTING_ELEMENTS,
    buildHyperConnectionPageState,
    buildHyperConnectionSetupParams,
} from './hyper_connection_settings.js';
import { HYPERDB_WASM_ENGINE_SETTINGS } from '../../../../platform/hyperdb/hyperdb_settings.js';

describe('Hyper connection settings', () => {
    it('shows every immutable embedded engine setting', () => {
        expect(HYPERDB_WASM_ENGINE_SETTING_ELEMENTS).toEqual(
            Object.entries(HYPERDB_WASM_ENGINE_SETTINGS).map(([key, value]) => ({
                key,
                value: typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
            })),
        );
        expect(HYPERDB_WASM_ENGINE_SETTING_ELEMENTS).toContainEqual({
            key: 'http_location_allowlist',
            value: '["*"]',
        });
        expect(Object.isFrozen(HYPERDB_WASM_ENGINE_SETTINGS)).toBe(true);
        expect(Object.isFrozen(HYPERDB_WASM_ENGINE_SETTING_ELEMENTS)).toBe(true);
        expect(HYPERDB_WASM_ENGINE_SETTING_ELEMENTS.every(Object.isFrozen)).toBe(true);
    });

    it('preserves restored mTLS paths and gRPC metadata in setup params', () => {
        const params = {
            protocol: 'V3_GRPC',
            endpoint: 'https://hyper.example.com:443',
            tls: {
                clientKeyPath: '/certs/client.key',
                clientCertPath: '/certs/client.pem',
                caCertsPath: '/certs/ca.pem',
            },
            attachedDatabases: [],
            metadata: { 'ctx-tenant-id': 'tenant-123' },
            queryParameters: {},
        } as connection.HyperConnectionParams;

        const setupParams = buildHyperConnectionSetupParams(buildHyperConnectionPageState(params));

        expect(setupParams.tls).toEqual(params.tls);
        expect(setupParams.metadata).toEqual(params.metadata);
    });

    it('reads metadata persisted with the legacy details wrapper', () => {
        const params = {
            protocol: 'V3_GRPC',
            endpoint: 'https://hyper.example.com:443',
            tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
            metadata: { details: { 'ctx-tenant-id': 'tenant-123' } },
        } as unknown as connection.HyperConnectionParams;

        const setupParams = buildHyperConnectionSetupParams(buildHyperConnectionPageState(params));

        expect(setupParams.metadata).toEqual({ 'ctx-tenant-id': 'tenant-123' });
    });

    it('selects WASM by default', () => {
        expect(buildHyperConnectionPageState(undefined).protocol).toBe('WASM');
    });
});
