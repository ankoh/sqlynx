import { describe, it, expect } from 'vitest';
import { sanitizeConnectionParamsForSharing, createDefaultConnectionParamsForConnector, ConnectionParams } from './connection_params.js';
import { CONNECTOR_INFOS, ConnectorType } from './connector_info.js';

describe('createDefaultConnectionParamsForConnector', () => {
    it('uses WASM for browser Hyper', () => {
        const params = createDefaultConnectionParamsForConnector(CONNECTOR_INFOS[ConnectorType.HYPER]);
        expect(params).toMatchObject({ hyper: { protocol: 'WASM' } });
    });

    it('uses WASM for Electron Hyper', () => {
        (globalThis as any).dashqlElectron = {};
        try {
            const params = createDefaultConnectionParamsForConnector(CONNECTOR_INFOS[ConnectorType.HYPER]);
            expect(params).toMatchObject({ hyper: { protocol: 'WASM' } });
        } finally {
            delete (globalThis as any).dashqlElectron;
        }
    });

    it('uses HTTP for Salesforce', () => {
        const params = createDefaultConnectionParamsForConnector(CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD]);
        expect(params).toMatchObject({ salesforce: { hyperProtocol: 'V3_HTTP' } });
    });
});

describe('sanitizeConnectionParamsForSharing', () => {
    it('omits all Hyper headers and query parameters without mutating local settings', () => {
        const params: ConnectionParams = { hyper: {
            protocol: 'V3_HTTP', endpoint: 'https://hyper.example.com',
            tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
            attachedDatabases: [{ path: 'database.hyper', alias: 'db' }],
            metadata: { authorization: 'bearer-secret', Cookie: 'session-secret', 'x-api-key': 'key-secret', arbitrary: 'unknown-secret' },
            queryParameters: { password: 'query-secret', harmless: 'value' },
            draftRows: { metadata: [{ key: '', value: 'draft-secret' }] },
        } };
        const sanitized = sanitizeConnectionParamsForSharing(params);
        expect(sanitized).toEqual({ hyper: {
            protocol: 'V3_HTTP', endpoint: 'https://hyper.example.com',
            tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
            attachedDatabases: [{ path: 'database.hyper', alias: 'db' }],
        } });
        expect(params.hyper.metadata?.authorization).toBe('bearer-secret');
        expect(params.hyper.queryParameters?.password).toBe('query-secret');
    });

    it('omits all Trino headers while preserving nonsecret connection identity', () => {
        const params: ConnectionParams = { trino: {
            endpoint: 'https://trino.example.com', catalogName: 'catalog', schemaNames: ['public'],
            auth: { authType: 'AUTH_BASIC', basic: { username: 'alice', secret: 'password' } },
            metadata: { Authorization: 'bearer-secret', cookie: 'session-secret', api_key: 'key-secret', arbitrary: 'unknown-secret' },
        } };
        expect(sanitizeConnectionParamsForSharing(params)).toEqual({ trino: {
            endpoint: 'https://trino.example.com', catalogName: 'catalog', schemaNames: ['public'],
            auth: { authType: 'AUTH_BASIC', basic: { username: 'alice', secret: '' } },
        } });
        expect(params.trino.metadata?.Authorization).toBe('bearer-secret');
    });
    it('strips the salesforce consumer secret but keeps the identity and login hint', () => {
        const params: ConnectionParams = {
            salesforce: {
                hyperProtocol: 'V3_HTTP',
                instanceUrl: 'https://example.my.salesforce.com',
                appConsumerKey: 'consumer-key',
                appConsumerSecret: 'super-secret',
                login: 'user@example.com',
            },
        };
        const sanitized = sanitizeConnectionParamsForSharing(params) as any;
        expect(sanitized.salesforce.appConsumerSecret).toBe('');
        expect(sanitized.salesforce.appConsumerKey).toBe('consumer-key');
        expect(sanitized.salesforce.instanceUrl).toBe('https://example.my.salesforce.com');
        expect(sanitized.salesforce.login).toBe('user@example.com');
        // The original must not be mutated.
        expect(params.salesforce!.appConsumerSecret).toBe('super-secret');
    });

    it('clears the salesforce login hint when withLoginHint is false but keeps the rest of the identity', () => {
        const params: ConnectionParams = {
            salesforce: {
                hyperProtocol: 'V3_HTTP',
                instanceUrl: 'https://example.my.salesforce.com',
                appConsumerKey: 'consumer-key',
                appConsumerSecret: 'super-secret',
                login: 'user@example.com',
            },
        };
        const sanitized = sanitizeConnectionParamsForSharing(params, false) as any;
        expect(sanitized.salesforce.login).toBe('');
        expect(sanitized.salesforce.appConsumerSecret).toBe('');
        expect(sanitized.salesforce.appConsumerKey).toBe('consumer-key');
        expect(sanitized.salesforce.instanceUrl).toBe('https://example.my.salesforce.com');
        // The original must not be mutated.
        expect(params.salesforce!.login).toBe('user@example.com');
    });

    it('strips the trino basic-auth secret but keeps the username', () => {
        const params: ConnectionParams = {
            trino: {
                endpoint: 'https://trino.example.com',
                catalogName: 'tpch',
                auth: { authType: 'AUTH_BASIC', basic: { username: 'alice', secret: 'password' } },
            },
        };
        const sanitized = sanitizeConnectionParamsForSharing(params) as any;
        expect(sanitized.trino.auth.basic.secret).toBe('');
        expect(sanitized.trino.auth.basic.username).toBe('alice');
        expect(sanitized.trino.endpoint).toBe('https://trino.example.com');
        expect(params.trino!.auth.basic!.secret).toBe('password');
    });

    it('clears the trino basic-auth username when withLoginHint is false', () => {
        const params: ConnectionParams = {
            trino: {
                endpoint: 'https://trino.example.com',
                catalogName: 'tpch',
                auth: { authType: 'AUTH_BASIC', basic: { username: 'alice', secret: 'password' } },
            },
        };
        const sanitized = sanitizeConnectionParamsForSharing(params, false) as any;
        expect(sanitized.trino.auth.basic.username).toBe('');
        expect(sanitized.trino.auth.basic.secret).toBe('');
        expect(sanitized.trino.endpoint).toBe('https://trino.example.com');
        expect(params.trino!.auth.basic!.username).toBe('alice');
    });

    it('clears hyper TLS file paths but keeps the endpoint and protocol', () => {
        const params: ConnectionParams = {
            hyper: {
                protocol: 'V3_HTTP',
                endpoint: 'https://hyper.example.com',
                tls: { clientKeyPath: '/k', clientCertPath: '/c', caCertsPath: '/ca' },
            },
        };
        const sanitized = sanitizeConnectionParamsForSharing(params) as any;
        expect(sanitized.hyper.tls.clientKeyPath).toBe('');
        expect(sanitized.hyper.tls.clientCertPath).toBe('');
        expect(sanitized.hyper.tls.caCertsPath).toBe('');
        expect(sanitized.hyper.endpoint).toBe('https://hyper.example.com');
    });

});
