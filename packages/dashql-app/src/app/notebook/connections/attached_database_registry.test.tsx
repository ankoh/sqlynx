import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import {
    CATALOG_UPDATE_PARTIALLY_SUCCEEDED,
    CATALOG_UPDATE_SUCCEEDED,
    ConnectionHealth,
    UPDATE_CATALOG,
    type AttachedDatabaseState,
} from './attached_database_state.js';
import {
    type AttachedDatabaseRegistry,
    type DynamicAttachedDatabaseDispatch,
    AttachedDatabaseRegistry as AttachedDatabaseRegistryProvider,
    didPersistedConnectionChange,
    resolveNotebookAttachedDatabases,
    resolveNotebookExecutionDatabase,
    useAttachedDatabaseRegistry,
    useDynamicAttachedDatabaseDispatch,
} from './attached_database_registry.js';
import { ConnectorType, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR } from './connector_info.js';
import { CatalogUpdateTaskStatus, CatalogUpdateVariant } from './catalog_update_state.js';
import { LoggerProvider } from '../../../platform/logger/logger_provider.js';
import { StorageProvider, useStorageWriter } from '../persistence/storage_provider.js';
import { NotebookTestBackend, TEST_DATABASE_ID, TEST_NOTEBOOK_ID, testNotebook } from '../persistence/notebook_test_backend.js';
import type { StorageWriter } from '../persistence/storage_writer.js';

function database(databaseId: string, health: ConnectionHealth): AttachedDatabaseState {
    return { databaseId, connectionHealth: health } as AttachedDatabaseState;
}

function registry(attachedDatabaseId: string | null, mainDatabaseId = attachedDatabaseId ?? 'local'): AttachedDatabaseRegistry {
    return {
        attachedDatabases: new Map([
            ['local', database('local', ConnectionHealth.ONLINE)],
            ['remote', database('remote', ConnectionHealth.FAILED)],
        ]),
        attachedDatabasesByNotebook: new Map([['notebook', {
            mainDatabaseId,
            attachedDatabaseIds: attachedDatabaseId == null ? [] : [attachedDatabaseId],
        }]]),
        attachedDatabasesByType: [],
        attachedDatabasesBySignature: new Map(),
    };
}

describe('notebook attached database routing', () => {
    it('resolves local and remote databases independently', () => {
        const attached = resolveNotebookAttachedDatabases(registry('remote'), 'notebook');
        expect(attached?.main.databaseId).toBe('remote');
        expect(attached?.attached.map(database => database.databaseId)).toEqual(['remote']);
    });

    it('routes execution to the remote main database even when it is offline', () => {
        const execution = resolveNotebookExecutionDatabase(registry('remote'), 'notebook');
        expect(execution?.databaseId).toBe('remote');
        expect(execution?.connectionHealth).toBe(ConnectionHealth.FAILED);
    });

    it('routes execution to the local main database even when a remote is attached', () => {
        expect(resolveNotebookExecutionDatabase(registry('remote', 'local'), 'notebook')?.databaseId).toBe('local');
    });

    it('routes execution to local when it is the only attached database', () => {
        expect(resolveNotebookExecutionDatabase(registry(null), 'notebook')?.databaseId).toBe('local');
    });

    it('does not fall back to local when a configured remote is missing', () => {
        const value = registry('remote', 'remote');
        value.attachedDatabases.delete('remote');
        expect(resolveNotebookExecutionDatabase(value, 'notebook')).toBeNull();
    });
});

describe('notebook manifest persistence', () => {
    const state = (active: boolean, endpoint: string): AttachedDatabaseState => ({
        active,
        params: { hyper: { protocol: 'V3_HTTP', endpoint, tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' } } },
        details: {
            type: HYPER_CONNECTOR,
            value: {
                proto: {
                    setupParams: {
                        protocol: 'HTTP',
                        endpoint,
                        tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
                    },
                },
            },
        },
    } as unknown as AttachedDatabaseState);

    it('ignores transient connection state changes', () => {
        const prev = state(true, 'https://db.example.com');
        const next = { ...prev, snapshotQueriesActiveFinished: 2 };
        expect(didPersistedConnectionChange(prev, next)).toBe(false);
    });

    it('persists activation and connection parameter changes', () => {
        expect(didPersistedConnectionChange(
            state(false, 'https://db.example.com'),
            state(true, 'https://db.example.com'),
        )).toBe(true);
        expect(didPersistedConnectionChange(
            state(true, 'https://db.example.com'),
            state(true, 'https://other.example.com'),
        )).toBe(true);
    });
});

describe('catalog refresh persistence', () => {
    it.each([
        ['succeeded', ''],
        ['partially succeeded', ''],
        ['succeeded', '-- Catalog changes of executed statements\n\nDROP TABLE "lakehouse"."public"."Old__dlm";\n'],
    ] as const)('saves a %s Salesforce catalog without rewriting the manifest, catalog changes %j', async (outcome, catalogChangesSql) => {
        const backend = new NotebookTestBackend();
        backend.notebooks.set(TEST_NOTEBOOK_ID, testNotebook({
            mainDatabase: { databaseId: TEST_DATABASE_ID, params: { salesforce: { instanceUrl: 'https://example.my.salesforce.com' } } as any },
        }));
        const schemaSQL = 'CREATE TABLE "lakehouse"."public"."Account__dlm" ("Id__c" VARCHAR);';
        const functionsSQL = 'CREATE FUNCTION test() AS 1;';
        const script = (sql: string) => ({ toString: () => sql });
        const connection = {
            databaseId: TEST_DATABASE_ID,
            active: true,
            connectionSignature: { signatureString: 'salesforce' },
            connectorInfo: { connectorType: ConnectorType.SALESFORCE_DATA_CLOUD },
            details: { type: SALESFORCE_DATA_CLOUD_CONNECTOR, value: { proto: { setupParams: { instanceUrl: 'https://example.my.salesforce.com' } } } },
            catalogRelationScript: script(schemaSQL),
            catalogFunctionScript: script(functionsSQL),
            catalogChangesSql,
            catalogUpdates: {
                tasksRunning: new Map(), tasksFinished: new Map(), currentFullRefresh: null, lastFullRefresh: null, restoredAt: null,
            },
        } as unknown as AttachedDatabaseState;
        let setRegistry!: React.Dispatch<React.SetStateAction<AttachedDatabaseRegistry>>;
        let currentRegistry!: AttachedDatabaseRegistry;
        let dispatch!: DynamicAttachedDatabaseDispatch;
        let writer!: StorageWriter;
        function Harness() {
            [currentRegistry, setRegistry] = useAttachedDatabaseRegistry();
            [, dispatch] = useDynamicAttachedDatabaseDispatch();
            writer = useStorageWriter();
            return null;
        }
        const container = document.createElement('div');
        const root = createRoot(container);
        try {
            await act(async () => root.render(React.createElement(LoggerProvider, null,
                React.createElement(StorageProvider, { backend },
                    React.createElement(AttachedDatabaseRegistryProvider, null, React.createElement(Harness)),
                ),
            )));
            await act(async () => setRegistry(reg => {
                reg.attachedDatabases.set(TEST_DATABASE_ID, connection);
                reg.attachedDatabasesByNotebook.set(TEST_NOTEBOOK_ID, { mainDatabaseId: TEST_DATABASE_ID, attachedDatabaseIds: [] });
                return { ...reg };
            }));
            expect(currentRegistry.attachedDatabases.get(TEST_DATABASE_ID)).toBe(connection);
            expect(currentRegistry.attachedDatabasesByNotebook.get(TEST_NOTEBOOK_ID)?.mainDatabaseId).toBe(TEST_DATABASE_ID);
            const task = {
                taskId: 1, taskVariant: CatalogUpdateVariant.FULL_CATALOG_REFRESH,
                status: CatalogUpdateTaskStatus.STARTED, cancellation: new AbortController(),
                queries: [], error: null, startedAt: new Date(), finishedAt: null, lastUpdateAt: new Date(),
            };
            act(() => {
                dispatch(TEST_DATABASE_ID, { type: UPDATE_CATALOG, value: [1, task] });
                dispatch(TEST_DATABASE_ID, outcome === 'succeeded'
                    ? { type: CATALOG_UPDATE_SUCCEEDED, value: [1] }
                    : { type: CATALOG_UPDATE_PARTIALLY_SUCCEEDED, value: [1, new Error('partial metadata')] });
            });
            await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
            expect(currentRegistry.attachedDatabases.get(TEST_DATABASE_ID)?.catalogUpdates.tasksFinished.has(1)).toBe(true);
            // The refresh describes the changes of earlier statements, recorded catalog changes are cleared
            expect(writer.getPendingKeysForNotebook(TEST_NOTEBOOK_ID)).toEqual([
                `${TEST_NOTEBOOK_ID}/dashql-catalog-relations.sql`,
                `${TEST_NOTEBOOK_ID}/dashql-catalog-functions.sql`,
                ...(catalogChangesSql === '' ? [] : [`${TEST_NOTEBOOK_ID}/dashql-catalog-changes.sql`]),
            ]);
            await writer.flush();
            expect(backend.schemas.get(TEST_NOTEBOOK_ID)).toBe(schemaSQL);
            expect(backend.functions.get(TEST_NOTEBOOK_ID)).toBe(functionsSQL);
            expect(backend.catalogChanges.get(TEST_NOTEBOOK_ID)).toBe(catalogChangesSql === '' ? undefined : '');
            expect(backend.calls).not.toContain(`manifest:${TEST_NOTEBOOK_ID}`);
        } finally {
            act(() => root.unmount());
            container.remove();
        }
    });

    it('does not overwrite main catalog files when an attached database refreshes', async () => {
        const backend = new NotebookTestBackend();
        backend.notebooks.set(TEST_NOTEBOOK_ID, testNotebook());
        const attachedId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        const relationScript = { toString: () => 'CREATE TABLE "other"."public"."Attached" (id INT);' };
        const functionScript = { toString: () => 'CREATE FUNCTION attached() AS 1;' };
        const task = {
            taskId: 2, taskVariant: CatalogUpdateVariant.FULL_CATALOG_REFRESH,
            status: CatalogUpdateTaskStatus.STARTED, cancellation: new AbortController(),
            queries: [], error: null, startedAt: new Date(), finishedAt: null, lastUpdateAt: new Date(),
        };
        const attached = {
            databaseId: attachedId, active: true,
            connectionSignature: { signatureString: 'attached' },
            connectorInfo: { connectorType: ConnectorType.SALESFORCE_DATA_CLOUD },
            details: { type: SALESFORCE_DATA_CLOUD_CONNECTOR, value: { proto: { setupParams: {} } } },
            catalogRelationScript: relationScript, catalogFunctionScript: functionScript,
            catalogUpdates: {
                tasksRunning: new Map([[2, task]]), tasksFinished: new Map(), currentFullRefresh: 2,
                lastFullRefresh: null, restoredAt: null,
            },
        } as unknown as AttachedDatabaseState;
        let dispatch!: DynamicAttachedDatabaseDispatch;
        let writer!: StorageWriter;
        let setRegistry!: React.Dispatch<React.SetStateAction<AttachedDatabaseRegistry>>;
        function Harness() {
            [, setRegistry] = useAttachedDatabaseRegistry();
            [, dispatch] = useDynamicAttachedDatabaseDispatch();
            writer = useStorageWriter();
            return null;
        }
        const container = document.createElement('div');
        const root = createRoot(container);
        try {
            await act(async () => root.render(React.createElement(LoggerProvider, null,
                React.createElement(StorageProvider, { backend },
                    React.createElement(AttachedDatabaseRegistryProvider, null, React.createElement(Harness)),
                ),
            )));
            act(() => setRegistry(reg => {
                reg.attachedDatabases.set(attachedId, attached);
                reg.attachedDatabasesByNotebook.set(TEST_NOTEBOOK_ID, {
                    mainDatabaseId: TEST_DATABASE_ID, attachedDatabaseIds: [attachedId],
                });
                return { ...reg };
            }));
            act(() => dispatch(attachedId, { type: CATALOG_UPDATE_SUCCEEDED, value: [2] }));
            await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
            expect(writer.getPendingKeysForNotebook(TEST_NOTEBOOK_ID)).toEqual([]);
        } finally {
            act(() => root.unmount());
            container.remove();
        }
    });
});
