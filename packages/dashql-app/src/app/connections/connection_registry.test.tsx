import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_INFOS } from './connector_info.js';
import { DELETE_CONNECTION, SET_CONNECTION_DRAFT } from './connection_state.js';
import { ConnectionPersistenceProvider, useConnectionSave, type ConnectionSaveResult } from './connection_persistence.js';

import {
    CATALOG_UPDATE_PARTIALLY_SUCCEEDED,
    CATALOG_UPDATE_SUCCEEDED,
    ConnectionHealth,
    UPDATE_CATALOG,
    type ConnectionState,
} from './connection_state.js';
import {
    type ConnectionRegistry,
    type DynamicConnectionDispatch,
    ConnectionRegistry as ConnectionRegistryProvider,
    ConnectionReferencesProvider,
    didPersistedConnectionChange,
    resolveSessionConnections,
    resolveDefaultConnection,
    useConnectionRegistry,
    useDynamicConnectionDispatch,
} from './connection_registry.js';
import { ConnectorType, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR } from './connector_info.js';
import { CatalogUpdateTaskStatus, CatalogUpdateVariant } from './catalog_update_state.js';
import { LoggerProvider } from '../../platform/logger/logger_provider.js';
import { StorageProvider, useStorageWriter } from '../storage/storage_provider.js';
import { SessionTestBackend, TEST_CONNECTION_ID, TEST_SESSION_ID, testSession } from '../storage/session_test_backend.js';
import type { StorageWriter } from '../storage/storage_writer.js';
import { fixedConnectionReferences } from '../../tests/mocks/connection_references.js';

function database(connectionId: string, health: ConnectionHealth): ConnectionState {
    return { connectionId: connectionId, connectionHealth: health } as ConnectionState;
}

function registry(): ConnectionRegistry {
    return {
        connections: new Map([
            ['local', database('local', ConnectionHealth.ONLINE)],
            ['remote', database('remote', ConnectionHealth.FAILED)],
        ]),
        connectionsByType: [],
    };
}

describe('session connection routing', () => {
    it('resolves the default connection and the other connections of a session', () => {
        const connections = resolveSessionConnections(registry(), fixedConnectionReferences({ session: ['local', 'remote'] }), 'session');
        expect(connections?.main.connectionId).toBe('local');
        expect(connections?.attached.map(database => database.connectionId)).toEqual(['remote']);
    });

    it('routes to the remote default connection even when it is offline', () => {
        const connection = resolveDefaultConnection(registry(), fixedConnectionReferences({ session: ['remote'] }), 'session');
        expect(connection?.connectionId).toBe('remote');
        expect(connection?.connectionHealth).toBe(ConnectionHealth.FAILED);
    });

    it('routes to the local default connection even when scripts use a remote one', () => {
        expect(resolveDefaultConnection(registry(), fixedConnectionReferences({ session: ['local', 'remote'] }), 'session')?.connectionId).toBe('local');
    });

    it('does not fall back to local when a configured remote is missing', () => {
        const value = registry();
        value.connections.delete('remote');
        expect(resolveDefaultConnection(value, fixedConnectionReferences({ session: ['remote'] }), 'session')).toBeNull();
        expect(resolveSessionConnections(value, fixedConnectionReferences({ session: ['local', 'remote'] }), 'session')).toBeNull();
    });
});

describe('session manifest persistence', () => {
    const state = (active: boolean, endpoint: string): ConnectionState => ({
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
    } as unknown as ConnectionState);

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
        const backend = new SessionTestBackend();
        backend.sessions.set(TEST_SESSION_ID, testSession({
            connections: [{ connectionId: TEST_CONNECTION_ID, params: { salesforce: { instanceUrl: 'https://example.my.salesforce.com' } } as any }],
        }));
        const schemaSQL = 'CREATE TABLE "lakehouse"."public"."Account__dlm" ("Id__c" VARCHAR);';
        const functionsSQL = 'CREATE FUNCTION test() AS 1;';
        const script = (sql: string) => ({ toString: () => sql });
        const connection = {
            connectionId: TEST_CONNECTION_ID,
            active: true,
            params: { salesforce: { instanceUrl: 'https://example.my.salesforce.com' } },
            connectorInfo: { connectorType: ConnectorType.SALESFORCE_DATA_CLOUD },
            details: { type: SALESFORCE_DATA_CLOUD_CONNECTOR, value: { proto: { setupParams: { instanceUrl: 'https://example.my.salesforce.com' } } } },
            catalogRelationScript: script(schemaSQL),
            catalogFunctionScript: script(functionsSQL),
            catalogChangesSql,
            catalogUpdates: {
                tasksRunning: new Map(), tasksFinished: new Map(), currentFullRefresh: null, lastFullRefresh: null, restoredAt: null,
            },
        } as unknown as ConnectionState;
        let setRegistry!: React.Dispatch<React.SetStateAction<ConnectionRegistry>>;
        let currentRegistry!: ConnectionRegistry;
        let dispatch!: DynamicConnectionDispatch;
        let writer!: StorageWriter;
        function Harness() {
            [currentRegistry, setRegistry] = useConnectionRegistry();
            [, dispatch] = useDynamicConnectionDispatch();
            writer = useStorageWriter();
            return null;
        }
        const container = document.createElement('div');
        const root = createRoot(container);
        try {
            await act(async () => root.render(React.createElement(LoggerProvider, null,
                React.createElement(StorageProvider, { backend },
                    React.createElement(ConnectionReferencesProvider, { value: fixedConnectionReferences({ [TEST_SESSION_ID]: [TEST_CONNECTION_ID] }) }, React.createElement(ConnectionRegistryProvider, null, React.createElement(Harness))),
                ),
            )));
            await act(async () => setRegistry(reg => {
                reg.connections.set(TEST_CONNECTION_ID, connection);
                return { ...reg };
            }));
            expect(currentRegistry.connections.get(TEST_CONNECTION_ID)).toBe(connection);
            const task = {
                taskId: 1, taskVariant: CatalogUpdateVariant.FULL_CATALOG_REFRESH,
                status: CatalogUpdateTaskStatus.STARTED, cancellation: new AbortController(),
                queries: [], error: null, startedAt: new Date(), finishedAt: null, lastUpdateAt: new Date(),
            };
            act(() => {
                dispatch(TEST_CONNECTION_ID, { type: UPDATE_CATALOG, value: [1, task] });
                dispatch(TEST_CONNECTION_ID, outcome === 'succeeded'
                    ? { type: CATALOG_UPDATE_SUCCEEDED, value: [1] }
                    : { type: CATALOG_UPDATE_PARTIALLY_SUCCEEDED, value: [1, new Error('partial metadata')] });
            });
            await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
            expect(currentRegistry.connections.get(TEST_CONNECTION_ID)?.catalogUpdates.tasksFinished.has(1)).toBe(true);
            // The connection owns the catalog, sessions don't keep a copy
            expect(writer.getPendingKeysForSession(TEST_SESSION_ID)).toEqual([]);
            await writer.flush();
            expect(backend.calls).not.toContain(`manifest:${TEST_SESSION_ID}`);
            expect(backend.connectionFiles.get(`${TEST_CONNECTION_ID}/dashql-catalog-relations.sql`)).toBe(schemaSQL);
            expect(backend.connectionFiles.get(`${TEST_CONNECTION_ID}/dashql-catalog-functions.sql`)).toBe(functionsSQL);
            // The refresh describes the changes of earlier statements, recorded catalog changes are cleared
            expect(backend.connectionFiles.get(`${TEST_CONNECTION_ID}/dashql-catalog-changes.sql`)).toBe(catalogChangesSql === '' ? undefined : '');
        } finally {
            act(() => root.unmount());
            container.remove();
        }
    });

    it('saves only the functions when the embedded database refreshes', async () => {
        const backend = new SessionTestBackend();
        backend.sessions.set(TEST_SESSION_ID, testSession());
        const functionsSQL = 'CREATE FUNCTION test() AS 1;';
        const task = {
            taskId: 3, taskVariant: CatalogUpdateVariant.FULL_CATALOG_REFRESH,
            status: CatalogUpdateTaskStatus.STARTED, cancellation: new AbortController(),
            queries: [], error: null, startedAt: new Date(), finishedAt: null, lastUpdateAt: new Date(),
        };
        const embedded = {
            connectionId: TEST_CONNECTION_ID, active: true,
            params: { hyper: { protocol: 'WASM' } },
            connectorInfo: { connectorType: ConnectorType.HYPER },
            details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'WASM' } } } },
            catalogRelationScript: { toString: () => 'CREATE TABLE "hyper"."public"."gone" (id INT);' },
            catalogFunctionScript: { toString: () => functionsSQL },
            catalogChangesSql: '-- Catalog changes of executed statements\n\nDROP TABLE "hyper"."public"."gone";\n',
            catalogUpdates: {
                tasksRunning: new Map([[3, task]]), tasksFinished: new Map(), currentFullRefresh: 3,
                lastFullRefresh: null, restoredAt: null,
            },
        } as unknown as ConnectionState;
        let dispatch!: DynamicConnectionDispatch;
        let writer!: StorageWriter;
        let setRegistry!: React.Dispatch<React.SetStateAction<ConnectionRegistry>>;
        function Harness() {
            [, setRegistry] = useConnectionRegistry();
            [, dispatch] = useDynamicConnectionDispatch();
            writer = useStorageWriter();
            return null;
        }
        const container = document.createElement('div');
        const root = createRoot(container);
        try {
            await act(async () => root.render(React.createElement(LoggerProvider, null,
                React.createElement(StorageProvider, { backend },
                    React.createElement(ConnectionReferencesProvider, { value: fixedConnectionReferences({ [TEST_SESSION_ID]: [TEST_CONNECTION_ID] }) }, React.createElement(ConnectionRegistryProvider, null, React.createElement(Harness))),
                ),
            )));
            act(() => setRegistry(reg => {
                reg.connections.set(TEST_CONNECTION_ID, embedded);
                return { ...reg };
            }));
            // The refresh clears the recorded catalog changes as well
            act(() => dispatch(TEST_CONNECTION_ID, { type: CATALOG_UPDATE_SUCCEEDED, value: [3] }));
            await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
            await writer.flush();
            expect([...backend.connectionFiles.keys()]).toEqual([`${TEST_CONNECTION_ID}/dashql-catalog-functions.sql`]);
        } finally {
            act(() => root.unmount());
            container.remove();
        }
    });

    it('writes the catalog of an attached connection into the files of that connection', async () => {
        const backend = new SessionTestBackend();
        backend.sessions.set(TEST_SESSION_ID, testSession());
        const attachedId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        const relationScript = { toString: () => 'CREATE TABLE "other"."public"."Attached" (id INT);' };
        const functionScript = { toString: () => 'CREATE FUNCTION attached() AS 1;' };
        const task = {
            taskId: 2, taskVariant: CatalogUpdateVariant.FULL_CATALOG_REFRESH,
            status: CatalogUpdateTaskStatus.STARTED, cancellation: new AbortController(),
            queries: [], error: null, startedAt: new Date(), finishedAt: null, lastUpdateAt: new Date(),
        };
        const attached = {
            connectionId: attachedId, active: true,
            params: { salesforce: {} },
            connectorInfo: { connectorType: ConnectorType.SALESFORCE_DATA_CLOUD },
            details: { type: SALESFORCE_DATA_CLOUD_CONNECTOR, value: { proto: { setupParams: {} } } },
            catalogRelationScript: relationScript, catalogFunctionScript: functionScript,
            catalogUpdates: {
                tasksRunning: new Map([[2, task]]), tasksFinished: new Map(), currentFullRefresh: 2,
                lastFullRefresh: null, restoredAt: null,
            },
        } as unknown as ConnectionState;
        let dispatch!: DynamicConnectionDispatch;
        let writer!: StorageWriter;
        let setRegistry!: React.Dispatch<React.SetStateAction<ConnectionRegistry>>;
        function Harness() {
            [, setRegistry] = useConnectionRegistry();
            [, dispatch] = useDynamicConnectionDispatch();
            writer = useStorageWriter();
            return null;
        }
        const container = document.createElement('div');
        const root = createRoot(container);
        try {
            await act(async () => root.render(React.createElement(LoggerProvider, null,
                React.createElement(StorageProvider, { backend },
                    React.createElement(ConnectionReferencesProvider, { value: fixedConnectionReferences({ [TEST_SESSION_ID]: [TEST_CONNECTION_ID, attachedId] }) }, React.createElement(ConnectionRegistryProvider, null, React.createElement(Harness))),
                ),
            )));
            act(() => setRegistry(reg => {
                reg.connections.set(attachedId, attached);
                return { ...reg };
            }));
            act(() => dispatch(attachedId, { type: CATALOG_UPDATE_SUCCEEDED, value: [2] }));
            await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
            expect(writer.getPendingKeysForSession(TEST_SESSION_ID)).toEqual([]);
            await writer.flush();
            expect([...backend.connectionFiles.keys()].every(key => key.startsWith(`${attachedId}/`))).toBe(true);
            expect(backend.connectionFiles.get(`${attachedId}/dashql-catalog-relations.sql`)).toBe(relationScript.toString());
            expect(backend.connectionFiles.get(`${attachedId}/dashql-catalog-functions.sql`)).toBe(functionScript.toString());
        } finally {
            act(() => root.unmount());
            container.remove();
        }
    });
});

describe('shared connection persistence', () => {
    const OTHER_SESSION_ID = '22222222-3333-4444-8555-666666666666';
    const MISSING_SESSION_ID = '33333333-4444-4555-8666-777777777777';
    const trino = (endpoint: string) => ({ trino: { endpoint, catalogName: '', auth: { authType: 'AUTH_BASIC' } } }) as any;

    /// Dispatch to the connection and let the batched registry update apply
    async function dispatchAndSettle(harness: { dispatch: DynamicConnectionDispatch }, action: Parameters<DynamicConnectionDispatch>[1]) {
        await act(async () => {
            harness.dispatch(TEST_CONNECTION_ID, action);
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        });
    }

    async function render(sessionIds: string[]) {
        const backend = new SessionTestBackend();
        for (const sessionId of [TEST_SESSION_ID, OTHER_SESSION_ID]) {
            backend.sessions.set(sessionId, testSession({ sessionId, connections: [{ connectionId: TEST_CONNECTION_ID, params: trino('https://old') }] }));
        }
        const connection = {
            connectionId: TEST_CONNECTION_ID,
            active: true,
            params: trino('https://old'),
            connectionHealth: ConnectionHealth.NOT_STARTED,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO],
            catalogChangesSql: '',
        } as unknown as ConnectionState;
        const harness = {} as {
            registry: ConnectionRegistry;
            dispatch: DynamicConnectionDispatch;
            writer: StorageWriter;
            save: () => Promise<ConnectionSaveResult | null>;
        };
        let setRegistry!: React.Dispatch<React.SetStateAction<ConnectionRegistry>>;
        function Harness() {
            [harness.registry, setRegistry] = useConnectionRegistry();
            [, harness.dispatch] = useDynamicConnectionDispatch();
            harness.writer = useStorageWriter();
            harness.save = useConnectionSave(TEST_CONNECTION_ID).save;
            return null;
        }
        const container = document.createElement('div');
        const root = createRoot(container);
        await act(async () => root.render(React.createElement(LoggerProvider, null,
            React.createElement(StorageProvider, { backend },
                React.createElement(ConnectionReferencesProvider, { value: fixedConnectionReferences(Object.fromEntries(sessionIds.map(sessionId => [sessionId, [TEST_CONNECTION_ID]]))) }, React.createElement(ConnectionRegistryProvider, null,
                    React.createElement(ConnectionPersistenceProvider, null, React.createElement(Harness)),
                )),
            ),
        )));
        await act(async () => setRegistry(reg => {
            reg.connections.set(TEST_CONNECTION_ID, connection);
            return { ...reg };
        }));
        return { backend, harness, unmount: () => { act(() => root.unmount()); container.remove(); } };
    }

    it('keeps drafts in the app manifest and saves them into every session', async () => {
        const { backend, harness, unmount } = await render([TEST_SESSION_ID, OTHER_SESSION_ID]);
        try {
            await dispatchAndSettle(harness, { type: SET_CONNECTION_DRAFT, value: trino('https://new') });
            await harness.writer.flush();
            expect(backend.connections).toEqual([{ id: TEST_CONNECTION_ID, params: trino('https://old'), paramsDraft: trino('https://new') }]);
            expect(backend.calls.filter(call => call.startsWith('manifest:'))).toEqual([]);

            let result!: ConnectionSaveResult | null;
            await act(async () => {
                result = await harness.save();
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            });
            expect(result!.manifest).toEqual({ status: 'written' });
            expect(result!.sessions.map(n => [n.sessionId, n.result.status])).toEqual([
                [TEST_SESSION_ID, 'written'],
                [OTHER_SESSION_ID, 'written'],
            ]);
            expect(backend.connections).toEqual([{ id: TEST_CONNECTION_ID, params: trino('https://new') }]);
            for (const sessionId of [TEST_SESSION_ID, OTHER_SESSION_ID]) {
                expect(backend.sessions.get(sessionId)!.connections).toEqual([{ connectionId: TEST_CONNECTION_ID, params: trino('https://new') }]);
            }
            const saved = harness.registry.connections.get(TEST_CONNECTION_ID)!;
            expect(saved.params).toEqual(trino('https://new'));
            expect(saved.paramsDraft).toBeUndefined();
        } finally {
            unmount();
        }
    });

    it('reports sessions whose copies could not be written', async () => {
        const { backend, harness, unmount } = await render([TEST_SESSION_ID, MISSING_SESSION_ID]);
        try {
            await dispatchAndSettle(harness, { type: SET_CONNECTION_DRAFT, value: trino('https://new') });
            let result!: ConnectionSaveResult | null;
            await act(async () => {
                result = await harness.save();
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            });
            expect(result!.manifest.status).toBe('written');
            expect(result!.sessions.map(n => [n.sessionId, n.result.status])).toEqual([
                [TEST_SESSION_ID, 'written'],
                [MISSING_SESSION_ID, 'failed'],
            ]);
            expect(backend.sessions.has(MISSING_SESSION_ID)).toBe(false);
        } finally {
            unmount();
        }
    });

    it('refuses to delete connections that sessions use', async () => {
        const { harness, unmount } = await render([TEST_SESSION_ID]);
        try {
            await dispatchAndSettle(harness, { type: DELETE_CONNECTION, value: null });
            expect(harness.registry.connections.has(TEST_CONNECTION_ID)).toBe(true);
        } finally {
            unmount();
        }
    });
});
