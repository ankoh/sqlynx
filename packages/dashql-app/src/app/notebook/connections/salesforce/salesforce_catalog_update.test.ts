import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as dashql from '@ankoh/dashql-core';
import { PREFETCHED_HYPER_FUNCTIONS_SQL } from '../prefetched_hyper_functions.js';
import { updateSalesforceCatalog } from './salesforce_catalog_update.js';
import type { SalesforceConnectionStateDetails } from './salesforce_connection_state.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: dashql.DashQL;

beforeAll(async () => {
    dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});

afterEach(() => {
    vi.unstubAllGlobals();
    dql.resetUnsafe();
});

describe('updateSalesforceCatalog', () => {
    it.each(['V3_GRPC', 'V3_HTTP'] as const)('loads %s metadata relations and the prefetched function catalog', async protocol => {
        const functionsSQL = PREFETCHED_HYPER_FUNCTIONS_SQL;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(functionsSQL)));
        const api = {
            getDataCloudMetadata: vi.fn().mockResolvedValue({
                metadata: [{
                    name: 'Account__dlm',
                    fields: [{ name: 'Id__c', type: 'Text' }],
                }],
            }),
        };
        const connection = {
            proto: {
                setupParams: { hyperProtocol: protocol },
                oauthState: {
                    coreAccessToken: {
                        createdAt: new Date(0).toISOString(),
                        expiresAt: new Date(1).toISOString(),
                        accessToken: 'org-jwt',
                        instanceUrl: 'https://example.my.salesforce.com',
                        jwt: { raw: 'org-jwt', header: {}, payload: { exp: 0.001, customAttributes: { dataspace: 'Marketing' } } },
                    },
                },
            },
            channel: null,
        } as unknown as SalesforceConnectionStateDetails;
        const catalog = dql.createCatalog();
        const relationScript = dql.createScript(catalog);
        const functionScript = dql.createScript(catalog);
        const logger = { info: vi.fn() };

        await updateSalesforceCatalog(
            logger as any,
            connection,
            catalog,
            dql,
            relationScript,
            functionScript,
            api as any,
            new AbortController(),
            { processor: async request => dql.processBatch(request) },
        );

        expect(relationScript.toString()).toContain('CREATE TABLE "lakehouse"."public"."Account__dlm"');
        expect(api.getDataCloudMetadata).toHaveBeenCalledWith(
            connection.proto.oauthState!.coreAccessToken,
            'Marketing',
            expect.any(AbortSignal),
            undefined,
        );
        const catalogSnapshot = catalog.createSnapshot().read();
        const findEntry = (
            begin: number,
            count: number,
            readEntry: (index: number, entry: dashql.buffers.catalog.FlatCatalogEntry) => dashql.buffers.catalog.FlatCatalogEntry | null,
            name: string,
        ) => {
            for (let index = begin; index < begin + count; ++index) {
                const entry = readEntry(index, new dashql.buffers.catalog.FlatCatalogEntry());
                if (entry != null && catalogSnapshot.readName(entry.nameId()) === name) return entry;
            }
            return null;
        };
        const database = findEntry(
            0,
            catalogSnapshot.catalogReader.databasesLength(),
            (index, entry) => catalogSnapshot.catalogReader.databases(index, entry),
            'lakehouse',
        );
        expect(database).not.toBeNull();
        const schema = findEntry(
            database!.childBegin(),
            database!.childCount(),
            (index, entry) => catalogSnapshot.catalogReader.schemas(index, entry),
            'public',
        );
        expect(schema).not.toBeNull();
        expect(findEntry(
            schema!.childBegin(),
            schema!.childCount(),
            (index, entry) => catalogSnapshot.catalogReader.tables(index, entry),
            'Account__dlm',
        )).not.toBeNull();
        expect(relationScript.toString()).not.toContain('"sf"."public"');
        const text = 'select * from Acc';
        const query = dql.createScript(catalog);
        query.insertTextAt(0, text);
        query.analyze();
        query.moveCursor(text.length);
        const candidates = query.completeAtCursor(10).read();
        const account = Array.from({ length: candidates.candidatesLength() }, (_, index) => candidates.candidates(index))
            .find(candidate => candidate?.completionText() === '"Account__dlm"');
        expect(account).toBeDefined();
        const qualified = account!.catalogObjects(0)!;
        expect(Array.from({ length: qualified.qualifiedNameLength() }, (_, index) => qualified.qualifiedName(index)))
            .toEqual(['lakehouse', 'public', '"Account__dlm"']);
        expect(functionScript.toString()).toBe(functionsSQL);
        expect(catalog.describeEntries().unpackAndDestroy().entries.every((entry: dashql.buffers.catalog.CatalogEntryT) =>
            entry.catalogEntryType === dashql.buffers.catalog.CatalogEntryType.DESCRIPTOR_POOL,
        )).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(
            'Loaded Salesforce catalog script',
            expect.objectContaining({ tables: '1', functions: '350' }),
            'salesforce_catalog',
        );
    });

    it.each(['processing', 'publication', 'later publication', 'aborted'])('retains earlier publications and unchanged pools after %s failure', async failure => {
        const connection = { proto: { oauthState: {
            coreAccessToken: {
                createdAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString(),
                accessToken: 'token', instanceUrl: 'https://example.my.salesforce.com',
                jwt: { raw: 'token', header: {}, payload: { exp: 0.001 } },
            },
        } }, channel: null } as unknown as SalesforceConnectionStateDetails;
        const catalog = dql.createCatalog();
        const relations = dql.createScript(catalog);
        const functions = dql.createScript(catalog);
        let name = 'old_table';
        const api = { getDataCloudMetadata: vi.fn(async () => ({ metadata: [{ name, fields: [{ name: 'id', type: 'Text' }] }] })) };
        const refresh = (abort: AbortController, processor = async (request: dashql.BatchRequest) => dql.processBatch(request)) =>
            updateSalesforceCatalog({ info: vi.fn() } as any, connection, catalog, dql, relations, functions,
                api as any, abort, { processor });
        await refresh(new AbortController());
        const oldRelations = relations.toString();
        const oldFunctions = functions.toString();
        const snapshot = catalog.createSnapshot();
        const version = snapshot.read().catalogReader.catalogVersion();
        name = 'new_table';
        const abort = new AbortController();
        const processor = async (request: dashql.BatchRequest) => {
            const result = dql.processBatch(request);
            if (failure === 'processing') result.scripts[1].failure = 'functions failed';
            if (failure === 'aborted') abort.abort();
            return result;
        };
        const replaceDescriptor = catalog.replaceDescriptor.bind(catalog);
        const replace = failure === 'publication' || failure === 'later publication'
            ? vi.spyOn(catalog, 'replaceDescriptor').mockImplementation((id, rank, descriptor) => {
                if (failure === 'publication' || id === functions.catalog_entry_id) throw new Error('import failed');
                replaceDescriptor(id, rank, descriptor);
            })
            : null;
        try {
            await expect(refresh(abort, processor)).rejects.toThrow();
            if (failure === 'later publication') expect(relations.toString()).toContain('new_table');
            else expect(relations.toString()).toBe(oldRelations);
            expect(functions.toString()).toBe(oldFunctions);
            const currentSnapshot = catalog.createSnapshot();
            if (failure === 'later publication') {
                expect(replace).toHaveBeenCalledTimes(2);
                expect(currentSnapshot).not.toBe(snapshot);
                expect(currentSnapshot.read().catalogReader.catalogVersion()).toBe(version + 1n);
            } else expect(currentSnapshot).toBe(snapshot);
        } finally {
            replace?.mockRestore();
        }
    });

    it.each([{ metadata: [] }, { metadata: [{ name: 'empty', fields: [] }] }])('preserves the catalog when metadata has no usable relations: %j', async ({ metadata }) => {
        const connection = { proto: { oauthState: {
            coreAccessToken: {
                createdAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString(),
                accessToken: 'token', instanceUrl: 'https://example.my.salesforce.com',
                jwt: { raw: 'token', header: {}, payload: { exp: 0.001 } },
            },
        } }, channel: null } as unknown as SalesforceConnectionStateDetails;
        const catalog = dql.createCatalog();
        const relations = dql.createScript(catalog);
        const functions = dql.createScript(catalog);
        const api = { getDataCloudMetadata: vi.fn().mockResolvedValue({ metadata: [{ name: 'old', fields: [{ name: 'id', type: 'Text' }] }] }) };
        await updateSalesforceCatalog({ info: vi.fn() } as any, connection, catalog, dql, relations, functions,
            api as any, new AbortController(), { processor: async request => dql.processBatch(request) });
        const oldRelations = relations.toString();
        const oldFunctions = functions.toString();
        const snapshot = catalog.createSnapshot();
        api.getDataCloudMetadata.mockResolvedValue({ metadata });
        const processor = vi.fn();
        await expect(updateSalesforceCatalog({ info: vi.fn() } as any, connection, catalog, dql, relations, functions,
            api as any, new AbortController(), { processor })).rejects.toThrow('no usable catalog relations');
        expect(processor).not.toHaveBeenCalled();
        expect(relations.toString()).toBe(oldRelations);
        expect(functions.toString()).toBe(oldFunctions);
        expect(catalog.createSnapshot()).toBe(snapshot);
    });
});
