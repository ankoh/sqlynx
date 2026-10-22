import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CatalogLoaderProvider, useCatalogLoaderQueue, type CatalogLoaderDependencies } from './catalog_loader.js';
import { type ConnectionRegistry, type DynamicConnectionDispatch } from './connection_registry.js';
import { CATALOG_UPDATE_CANCELLED, CATALOG_UPDATE_FAILED, CATALOG_UPDATE_SUCCEEDED, ConnectionHealth, type ConnectionState, type CatalogAction } from './connection_state.js';
import { reduceCatalogAction } from './catalog_update_state.js';
import { CatalogResolver, HYPER_CONNECTOR } from './connector_info.js';
import { LoggerProvider } from '../../platform/logger/logger_provider.js';
import type { StorageWriter } from '../storage/storage_writer.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

describe('CatalogLoaderProvider queue', () => {
    let container: HTMLDivElement;
    let root: Root;
    let registry: ConnectionRegistry;
    let enqueue: ReturnType<typeof useCatalogLoaderQueue>;
    let dependencies: CatalogLoaderDependencies;
    let providerRenders: number;
    const updates: Array<{ signal: AbortSignal; resolve: () => void; reject: (error: Error) => void }> = [];
    const dispatch = vi.fn<DynamicConnectionDispatch>();
    const scriptsDispatch = vi.fn();
    const updateHyperCatalog = vi.fn<CatalogLoaderDependencies['updateHyperCatalog']>();

    function CaptureQueue() {
        enqueue = useCatalogLoaderQueue();
        return null;
    }

    async function render() {
        await act(async () => root.render(
            <LoggerProvider>
                <CatalogLoaderProvider dependencies={dependencies} onCatalogDidUpdate={scriptsDispatch}>
                    <CaptureQueue />
                </CatalogLoaderProvider>
            </LoggerProvider>,
        ));
    }

    async function settleUpdate(settle: () => void, drainsQueue = false) {
        const rendersBeforeCompletion = providerRenders;
        await act(async () => {
            settle();
            // Browser act uses flushSync, not React's development async-act queue.
            // Let updateImpl and doUpdate finish before flushing their queue state update.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        });
        if (drainsQueue) {
            // Completion wakes the queue, then consuming the request commits its removal.
            // flushSync alone does not flush these asynchronously scheduled renders.
            await vi.waitFor(() => expect(providerRenders).toBeGreaterThanOrEqual(rendersBeforeCompletion + 2));
        }
    }

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        updates.length = 0;
        providerRenders = 0;
        dispatch.mockReset();
        scriptsDispatch.mockReset();
        updateHyperCatalog.mockReset();
        const connection = {
            connectionId: 'database',
            connectorInfo: { catalogResolver: CatalogResolver.SQL_HYPER },
            details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: {} } } },
            catalog: {},
            catalogUpdates: {
                tasksRunning: new Map(), tasksFinished: new Map(),
                currentFullRefresh: null, lastFullRefresh: null, restoredAt: null,
            },
        } as unknown as ConnectionState;
        registry = {
            connections: new Map([['database', connection]]),
            attachedDatabasesBySession: new Map(),
            connectionsByType: [],
            connectionsBySignature: new Map(),
        };
        // Deliberately do not rerender on dispatch: completion itself must wake the queue.
        dispatch.mockImplementation((id, action) => {
            registry.connections.set(id!, reduceCatalogAction(
                registry.connections.get(id!)!, action as CatalogAction, {} as StorageWriter,
            ));
        });
        updateHyperCatalog.mockImplementation((...args) => new Promise((resolve, reject) => {
            updates.push({
                signal: args[11],
                resolve: () => resolve({ updatedDatabases: ['database'], failures: [] }),
                reject,
            });
        }));
        const executor = vi.fn<ReturnType<CatalogLoaderDependencies['useQueryExecutor']>>();
        dependencies = {
            useDynamicConnectionDispatch: () => {
                providerRenders++;
                return [registry, dispatch];
            },
            useQueryExecutor: () => executor,
            useSalesforceAPI: () => null as unknown as ReturnType<CatalogLoaderDependencies['useSalesforceAPI']>,
            updateHyperCatalog,
        };
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
            for (const update of updates) update.reject(new DOMException('Test cleanup', 'AbortError'));
        });
        container.remove();
        vi.restoreAllMocks();
    });

    it('aborts a running refresh once, preserves pending force, and starts its replacement after cancellation settles', async () => {
        await render();
        await act(async () => enqueue('database', false));
        expect(updateHyperCatalog).toHaveBeenCalledTimes(1);
        const first = updates[0];
        const task = registry.connections.get('database')!.catalogUpdates.tasksRunning.values().next().value!;
        const abort = vi.spyOn(task.cancellation, 'abort');

        await act(async () => enqueue('database', true));
        expect(first.signal.aborted).toBe(true);
        expect(first.signal.reason.name).toBe('AbortError');
        expect(updateHyperCatalog).toHaveBeenCalledTimes(1);
        // An auto request cannot downgrade force while cancellation is still pending.
        await act(async () => enqueue('database', false));
        registry = { ...registry };
        await render();
        expect(abort).toHaveBeenCalledTimes(1);
        expect(updateHyperCatalog).toHaveBeenCalledTimes(1);

        await settleUpdate(() => first.reject(first.signal.reason), true);
        expect(updateHyperCatalog).toHaveBeenCalledTimes(2);
        expect(updates[1].signal.aborted).toBe(false);
        expect(dispatch.mock.calls.some(([, action]) => action.type === CATALOG_UPDATE_CANCELLED)).toBe(true);
        registry = { ...registry };
        await render();
        expect(updates[1].signal.aborted).toBe(false);
        expect(updateHyperCatalog).toHaveBeenCalledTimes(2);
        await settleUpdate(() => updates[1].resolve());
        expect(scriptsDispatch).toHaveBeenCalledTimes(1);
    });

    it('drains an auto request after failure without a registry rerender or another enqueue', async () => {
        await render();
        await act(async () => enqueue('database', true));
        await act(async () => enqueue('database', false));
        expect(updates[0].signal.aborted).toBe(false);
        expect(updateHyperCatalog).toHaveBeenCalledTimes(1);
        await settleUpdate(() => updates[0].reject(new Error('metadata unavailable')), true);
        expect(dispatch.mock.calls.some(([, action]) => action.type === CATALOG_UPDATE_FAILED)).toBe(true);
        expect(updateHyperCatalog).toHaveBeenCalledTimes(1);
        expect(scriptsDispatch).not.toHaveBeenCalled();

        // Completion must consume the throttled request, rather than leave it to run later.
        const connection = registry.connections.get('database')!;
        connection.catalogUpdates.lastFullRefresh = null;
        registry = { ...registry };
        await render();
        expect(updateHyperCatalog).toHaveBeenCalledTimes(1);
    });

    it('consumes a queued auto request after success without cancelling a later forced refresh', async () => {
        await render();
        await act(async () => enqueue('database', true));
        await act(async () => enqueue('database', false));
        await settleUpdate(() => updates[0].resolve(), true);
        expect(dispatch.mock.calls.some(([, action]) => action.type === CATALOG_UPDATE_SUCCEEDED)).toBe(true);
        expect(updateHyperCatalog).toHaveBeenCalledTimes(1);
        expect(scriptsDispatch).toHaveBeenCalledTimes(1);
        registry.connections.get('database')!.catalogUpdates.lastFullRefresh = null;
        registry = { ...registry };
        await render();
        expect(updateHyperCatalog).toHaveBeenCalledTimes(1);

        await act(async () => enqueue('database', true));
        registry = { ...registry };
        await render();
        expect(updateHyperCatalog).toHaveBeenCalledTimes(2);
        expect(updates[1].signal.aborted).toBe(false);
        await settleUpdate(() => updates[1].resolve());
        expect(scriptsDispatch).toHaveBeenCalledTimes(2);
    });
    it('refreshes the catalog of an embedded database whenever it comes online', async () => {
        const connection = registry.connections.get('database')!;
        registry.connections.set('database', { ...connection, params: { hyper: { protocol: 'WASM' } }, connectionHealth: ConnectionHealth.ONLINE } as ConnectionState);
        // The request is enqueued by an effect, its update starts with a later render
        await render();
        await vi.waitFor(() => expect(updateHyperCatalog).toHaveBeenCalledTimes(1));
        await settleUpdate(() => updates[0].resolve());
        registry = { ...registry };
        await render();
        expect(updateHyperCatalog).toHaveBeenCalledTimes(1);

        // A reconnect describes the database again
        const online = registry.connections.get('database')!;
        registry.connections.set('database', { ...online, connectionHealth: ConnectionHealth.CONNECTING });
        registry = { ...registry };
        await render();
        registry.connections.set('database', {
            ...online,
            catalogUpdates: { ...online.catalogUpdates, lastFullRefresh: null },
        });
        registry = { ...registry };
        await render();
        await vi.waitFor(() => expect(updateHyperCatalog).toHaveBeenCalledTimes(2));
    });

    it('keeps the catalog of a durable connection when it comes online', async () => {
        const connection = registry.connections.get('database')!;
        registry.connections.set('database', { ...connection, params: { hyper: { protocol: 'V3_HTTP', endpoint: 'http://hyper.example' } }, connectionHealth: ConnectionHealth.ONLINE } as ConnectionState);
        await render();
        await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
        expect(updateHyperCatalog).not.toHaveBeenCalled();
    });
});
