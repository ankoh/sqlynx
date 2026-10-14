// @vitest-environment node
import type { EmbeddedConnection } from '../platform/database/embedded_database.js';
import { TestLogger } from '../platform/logger/test_logger.js';
import {
    quoteSqlIdentifier,
    quoteSqlString,
    SALESFORCE_CATALOG_RANK,
    SalesforceRemoteAttachmentManager,
    type SalesforceRemoteAttachmentDependencies,
    type SalesforceRemoteCatalog,
    type SalesforceRemoteDataCloudToken,
} from './salesforce_remote_attachment.js';

const CATALOG: SalesforceRemoteCatalog = {
    tables: [
        { name: 'Account', columns: [{ name: 'Id', ordinalPosition: 0, dataType: 'Text' }] },
        {
            name: 'Opportunity',
            columns: [
                { name: 'Id', ordinalPosition: 0, dataType: 'Text' },
                { name: 'Amount', ordinalPosition: 1, dataType: 'Number' },
            ],
        },
    ],
};

function makeToken(instanceUrl: string, tenant: string, raw: string): SalesforceRemoteDataCloudToken {
    return { instanceUrl, jwt: { raw, payload: { audienceTenantId: tenant } } };
}

function createManager(options: {
    failAt?: number;
    createEndpointKey?: (alias: string) => string;
} = {}) {
    const sql: string[] = [];
    const queryArrowIPC = vi.fn(async (query: string) => {
        sql.push(query);
        if (options.failAt === sql.length) throw new Error('query failed');
        return new Uint8Array();
    });
    const connection = { queryArrowIPC } as unknown as EmbeddedConnection;
    const functionScript = {} as any;
    const catalogScript = {} as any;
    const loadCatalogScript = vi.fn()
        .mockReturnValueOnce(functionScript)
        .mockReturnValueOnce(catalogScript);
    const replaceCatalogScript = vi.fn();
    const logger = new TestLogger();
    const dependencies: SalesforceRemoteAttachmentDependencies = {
        loadPrefetchedFunctionSql: vi.fn().mockResolvedValue('functions'),
        createEndpointKey: options.createEndpointKey ?? (alias => `key-${alias.toLowerCase()}`),
        logger,
    };
    return {
        manager: new SalesforceRemoteAttachmentManager(
            connection,
            { loadCatalogScript, replaceCatalogScript },
            dependencies,
        ),
        sql,
        queryArrowIPC,
        loadCatalogScript,
        replaceCatalogScript,
        catalogScript,
        dependencies,
        logger,
    };
}

describe('SalesforceRemoteAttachmentManager', () => {
    it.each(['https://data.example.com', 'https://data.example.com/', 'https://data.example.com:8443/api'])(
        'uses exchanged token endpoint %s and credentials', async endpoint => {
            const { manager, sql } = createManager();
            await manager.attach('Salesforce', makeToken(endpoint, 'cdp-tenant', 'data-cloud-token'));
            expect(sql[0]).toContain('"host":"https://data.example.com"');
            expect(sql[0]).toContain(`"port":${endpoint.includes(':8443') ? 8443 : 443}`);
            expect(sql[0]).toContain('"tenant":"cdp-tenant","token":"data-cloud-token"');
        },
    );

    it.each([
        'http://data.example.com',
        'ftp://data.example.com',
        'https://user:password@data.example.com',
        'https://data.example.com?query=1',
        'https://data.example.com#fragment',
        '//data.example.com',
    ])('rejects unsafe token endpoint %s before executing SQL', async endpoint => {
        const { manager, queryArrowIPC } = createManager();
        await expect(manager.attach('Salesforce', makeToken(endpoint, 'tenant', 'data-cloud-token'))).rejects.toThrow();
        expect(queryArrowIPC).not.toHaveBeenCalled();
        expect(manager.hasAlias('Salesforce')).toBe(false);
    });

    it.each(['instanceUrl', 'audienceTenantId', 'raw'] as const)('rejects a missing token %s before executing SQL', async field => {
        const { manager, queryArrowIPC } = createManager();
        const token = makeToken(field === 'instanceUrl' ? '' : 'https://data.example.com',
            field === 'audienceTenantId' ? '' : 'tenant', field === 'raw' ? '' : 'data-cloud-token');
        await expect(manager.attach('Salesforce', token)).rejects.toThrow('Salesforce Data Cloud token is missing');
        expect(queryArrowIPC).not.toHaveBeenCalled();
    });

    it('quotes SQL strings and identifiers safely', () => {
        expect(quoteSqlString("x'; DROP TABLE secrets; --")).toBe("'x''; DROP TABLE secrets; --'");
        expect(quoteSqlIdentifier('a"; DETACH db; --')).toBe('"a""; DETACH db; --"');
    });

    it('uses safely quoted injected aliases, endpoint keys, and tokens', async () => {
        const endpointKey = "key'; DROP TABLE endpoints; --";
        const { manager, sql } = createManager({ createEndpointKey: () => endpointKey });
        await manager.attach(
            'a"; DETACH db; --',
            makeToken('https://data.example.com:8443/path', "tenant'one", "jwt'one"),
        );
        expect(sql[0]).toContain("SET global.hyper_remote_endpoints = '");
        expect(sql[0]).toContain("jwt''one");
        expect(sql[2]).toBe(
            'ATTACH DATABASE "hyper.remote://key\'; DROP TABLE endpoints; --" AS "a""; DETACH db; --"',
        );
    });

    it('executes setting, gate, and attach without loading catalogs', async () => {
        const { manager, sql, loadCatalogScript, logger } = createManager();
        await expect(manager.attach(
            'Salesforce',
            makeToken('https://data.example.com:8443/api', 'tenant-1', 'jwt.payload.signature'),
        )).resolves.toEqual({ alias: 'Salesforce' });

        expect(sql).toEqual([
            'SET global.hyper_remote_endpoints = \'{"key-salesforce":{"connection":{"host":"https://data.example.com","port":8443},"tenant":"tenant-1","token":"jwt.payload.signature"}}\'',
            'SET global.experimental_dbregistry_hyper_remote = true',
            'ATTACH DATABASE "hyper.remote://key-salesforce" AS "Salesforce"',
        ]);
        expect(loadCatalogScript).not.toHaveBeenCalled();
        expect(manager.hasAlias('salesforce')).toBe(true);
        const startRecord = Array.from({ length: logger.buffer.length }, (_, index) => logger.buffer.at(index))
            .find(record => record?.message === 'Starting Salesforce database attachment');
        expect(startRecord?.keyValues).toMatchObject({
            hostOrigin: 'https://data.example.com',
            port: '8443',
            tenantPresent: 'true',
            tokenPresent: 'true',
            tokenPartCount: '3',
        });
        for (let index = 0; index < logger.buffer.length; ++index) {
            expect(JSON.stringify(logger.buffer.at(index))).not.toContain('jwt.payload.signature');
        }
    });

    it('preserves the first endpoint when attaching a second alias', async () => {
        const { manager, sql, loadCatalogScript, dependencies } = createManager();
        await manager.attach('One', makeToken('https://one.example.com', 'tenant-1', 'jwt-1'));
        await manager.attach('Two', makeToken('https://two.example.com:9443', 'tenant-2', 'jwt-2'));

        const secondSetting = sql[3];
        expect(secondSetting).toContain('"key-one":{"connection":{"host":"https://one.example.com","port":443}');
        expect(secondSetting).toContain('"key-two":{"connection":{"host":"https://two.example.com","port":9443}');
        expect(dependencies.loadPrefetchedFunctionSql).not.toHaveBeenCalled();
        expect(loadCatalogScript).not.toHaveBeenCalled();
        expect(manager.hasAlias('ONE')).toBe(true);
        expect(manager.hasAlias('two')).toBe(true);
        expect(manager.getAliases()).toEqual(['One', 'Two']);
    });

    it('loads functions once and replaces an existing alias catalog', async () => {
        const { manager, loadCatalogScript, replaceCatalogScript, catalogScript, dependencies } = createManager();
        await manager.attach('Salesforce', makeToken('https://data.example.com', 'tenant-1', 'jwt-1'));

        await manager.refreshCatalog('salesFORCE', CATALOG);
        await manager.refreshCatalog('Salesforce', {
            tables: [{ name: 'Contact', columns: [{ name: 'Id', ordinalPosition: 0, dataType: 'Text' }] }],
        });

        expect(dependencies.loadPrefetchedFunctionSql).toHaveBeenCalledOnce();
        expect(loadCatalogScript).toHaveBeenCalledTimes(2);
        expect(loadCatalogScript).toHaveBeenNthCalledWith(1, 'functions', SALESFORCE_CATALOG_RANK);
        expect(loadCatalogScript).toHaveBeenNthCalledWith(
            2,
            expect.stringMatching(/^CREATE TABLE "Salesforce"\."public"\."Account"/),
            SALESFORCE_CATALOG_RANK,
        );
        expect(replaceCatalogScript).toHaveBeenCalledWith(
            catalogScript,
            expect.stringMatching(/^CREATE TABLE "Salesforce"\."public"\."Contact"/),
            SALESFORCE_CATALOG_RANK,
        );
    });

    it('rejects refreshes for unknown aliases', async () => {
        const { manager, loadCatalogScript } = createManager();
        await expect(manager.refreshCatalog('missing', CATALOG)).rejects.toThrow(
            'Salesforce alias not found: missing',
        );
        expect(loadCatalogScript).not.toHaveBeenCalled();
    });

    it('rejects duplicate aliases case-insensitively without executing more SQL', async () => {
        const { manager, queryArrowIPC } = createManager();
        const token = makeToken('https://data.example.com', 'tenant-1', 'jwt-1');
        await manager.attach('Salesforce', token);
        await expect(manager.attach('salesFORCE', token)).rejects.toThrow(
            'Salesforce alias already exists: salesFORCE',
        );
        expect(queryArrowIPC).toHaveBeenCalledTimes(3);
    });

    it('restores the setting without detaching when attach fails', async () => {
        const { manager, sql, logger } = createManager({ failAt: 3 });
        await expect(manager.attach(
            'Salesforce',
            makeToken('https://data.example.com', 'tenant-1', 'jwt-1'),
        )).rejects.toThrow('query failed');
        expect(sql.slice(-2)).toEqual([
            "SET global.hyper_remote_endpoints = '{}'",
            'SET global.experimental_dbregistry_hyper_remote = false',
        ]);
        for (let index = 0; index < logger.buffer.length; ++index) {
            expect(JSON.stringify(logger.buffer.at(index))).not.toContain('jwt-1');
        }
    });
});
