// @vitest-environment node
import type * as connection from '@ankoh/dashql-jsonschema/connection.js';

import {
    createRefreshCommand,
    type SalesforceRefreshCatalog,
    type SalesforceRefreshCommandDependencies,
} from './refresh.js';
import type { SalesforceLoginAuthentication } from './login.js';

const AUTHENTICATION: SalesforceLoginAuthentication = {
    coreAccessToken: {
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(1).toISOString(),
        accessToken: 'org-jwt',
        instanceUrl: 'https://example.my.salesforce.com',
        jwt: { raw: 'org-jwt', header: {}, payload: { exp: 0.001 } },
    } as connection.SalesforceCoreAccessToken,
};

const CATALOG: SalesforceRefreshCatalog = {
    tableCount: 2,
    columnCount: 5,
    metadataStatus: 'Metadata: 2 done, 0 active, 1 failed | DMO 1 | DLO failed | CI 1',
    tables: [],
    functionsSQL: 'functions',
};

function createDependencies(overrides: Partial<SalesforceRefreshCommandDependencies> = {}) {
    const authentications = new Map([
        ['one', AUTHENTICATION],
        ['two', AUTHENTICATION],
    ]);
    return {
        getAliases: vi.fn(() => ['One', 'Two']),
        getAuthentication: vi.fn((alias: string) => authentications.get(alias.toLowerCase())),
        resolveCatalog: vi.fn().mockResolvedValue(CATALOG),
        refreshCatalog: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } satisfies SalesforceRefreshCommandDependencies;
}

describe('Salesforce refresh command', () => {
    it('rejects more than one alias', async () => {
        const dependencies = createDependencies();
        await expect(createRefreshCommand(dependencies)[2](['one', 'two'], {})).rejects.toThrow(
            'usage: .refresh [alias]',
        );
    });

    it('refreshes every attached alias by default', async () => {
        const dependencies = createDependencies();
        const onProgress = vi.fn();

        await expect(createRefreshCommand(dependencies)[2]([], { onProgress })).resolves.toBe(
            'Metadata: 2 done, 0 active, 1 failed | DMO 1 | DLO failed | CI 1\r\n' +
            'Refreshed One: 2 tables, 5 columns\r\n' +
            'Metadata: 2 done, 0 active, 1 failed | DMO 1 | DLO failed | CI 1\r\n' +
            'Refreshed Two: 2 tables, 5 columns',
        );
        expect(dependencies.resolveCatalog).toHaveBeenNthCalledWith(
            1,
            'One',
            AUTHENTICATION,
            undefined,
            onProgress,
        );
        expect(dependencies.resolveCatalog).toHaveBeenNthCalledWith(
            2,
            'Two',
            AUTHENTICATION,
            undefined,
            onProgress,
        );
        expect(dependencies.refreshCatalog).toHaveBeenNthCalledWith(1, 'One', CATALOG, undefined);
        expect(dependencies.refreshCatalog).toHaveBeenNthCalledWith(2, 'Two', CATALOG, undefined);
    });

    it('refreshes one alias case-insensitively', async () => {
        const dependencies = createDependencies();

        await expect(createRefreshCommand(dependencies)[2](['oNe'], {})).resolves.toBe(
            'Metadata: 2 done, 0 active, 1 failed | DMO 1 | DLO failed | CI 1\r\n' +
            'Refreshed oNe: 2 tables, 5 columns',
        );
        expect(dependencies.resolveCatalog).toHaveBeenCalledOnce();
        expect(dependencies.refreshCatalog).toHaveBeenCalledWith('oNe', CATALOG, undefined);
    });

    it('reports missing connections and aliases', async () => {
        const empty = createDependencies({ getAliases: () => [] });
        await expect(createRefreshCommand(empty)[2]([], {})).rejects.toThrow(
            'No Salesforce connections are attached',
        );

        const dependencies = createDependencies();
        await expect(createRefreshCommand(dependencies)[2](['missing'], {})).rejects.toThrow(
            'Salesforce alias not found: missing',
        );
        expect(dependencies.resolveCatalog).not.toHaveBeenCalled();
    });
});
