import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionHealth, type AttachedDatabaseState } from '../connections/attached_database_state.js';
import { CONNECTOR_INFOS, ConnectorType, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from '../connections/connector_info.js';
import { NotebookSetupStatus } from '../../router/notebook_setup_status.js';
import { SELECT_NOTEBOOK } from '../../router/router.js';
import { NotebookWorkbenchSidebar, type NotebookWorkbenchSidebarDependencies } from './notebook_workbench_sidebar.js';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const state = {
    navigate: vi.fn(),
    dispatchDatabase: vi.fn(),
    setupNotebookScripts: vi.fn(),
    write: vi.fn<() => Promise<boolean>>(),
    refreshCatalog: vi.fn(),
    createConnectionStateFromParams: vi.fn(),
    deleteNotebook: vi.fn(),
    allocateDatabase: vi.fn(),
    allocateConnection: vi.fn(),
    attachConnection: vi.fn(),
    local: null as AttachedDatabaseState | null,
    overlayProps: null as { databaseId: string | null; headerTitle?: string; isOpen: boolean; onClose: () => void; onConnected?: (database: AttachedDatabaseState) => void } | null,
    shareProps: null as { isOpen: boolean; notebookId?: string } | null,
    fileSaveProps: null as { isOpen: boolean; notebookScripts?: { notebookId: string }; fileName?: string } | null,
    attachedDatabases: new Map<string, AttachedDatabaseState>(),
    attachedDatabasesByNotebook: new Map<string, { mainDatabaseId: string; attachedDatabaseIds: string[] }>(),
    notebookScriptsMap: new Map<string, unknown>(),
    notebookAttachedDatabases: null as { main: AttachedDatabaseState; attached: AttachedDatabaseState[] } | null,
};

const dependencies = {
    useRouterNavigate: () => state.navigate,
    useRouteContext: () => ({ notebookId: 'current-notebook', notebookSetupStatus: NotebookSetupStatus.NONE }),
    useAttachedDatabaseRegistry: () => [{
        attachedDatabases: state.attachedDatabases,
        attachedDatabasesByNotebook: state.attachedDatabasesByNotebook,
    }, vi.fn()],
    useNotebookAttachedDatabases: () => state.notebookAttachedDatabases,
    useDynamicAttachedDatabaseDispatch: () => [{
        attachedDatabases: state.attachedDatabases,
        attachedDatabasesByNotebook: state.attachedDatabasesByNotebook,
        attachedDatabasesBySignature: new Map(),
    }, state.dispatchDatabase],
    useAttachedDatabaseStateAllocator: () => state.allocateDatabase,
    useConnectionAllocator: () => state.allocateConnection,
    useAttachConnection: () => state.attachConnection,
    ConnectionSettingsOverlay: (props: typeof state.overlayProps) => {
        state.overlayProps = props;
        return props?.isOpen ? <button onClick={() => props.onConnected?.(state.local!)}>Complete setup</button> : null;
    },
    useNotebookScriptsDeletion: () => vi.fn(),
    useNotebookScriptsRegistry: () => [{ notebookScriptsMap: state.notebookScriptsMap }],
    useNotebookScriptsSetup: () => state.setupNotebookScripts,
    useStorageReader: () => ({
        backend: {},
        getNotebookLocation: () => ({ type: 'opfs' }),
        getNotebookOrder: () => [],
    }),
    useStorageWriter: () => ({
        write: state.write,
        backend: { deleteNotebook: state.deleteNotebook },
        cancelPendingWritesForNotebook: vi.fn(),
    }),
    useComputationDispatch: () => vi.fn(),
    BundledNotebooksOverlay: () => null,
    NotebookStorageOverlay: () => null,
    NotebookURLShareOverlay: (props: typeof state.shareProps) => {
        state.shareProps = props;
        return props?.isOpen ? <div data-testid="share-url-overlay" /> : null;
    },
    NotebookFileSaveOverlay: (props: typeof state.fileSaveProps) => {
        state.fileSaveProps = props;
        return props?.isOpen ? <div data-testid="file-save-overlay" /> : null;
    },
    useNotebookImport: () => ({}),
    useInvalidNotebookRegistry: () => ({ invalidNotebooks: new Map(), deleteInvalidNotebook: vi.fn() }),
    useDashQLCoreSetup: () => vi.fn(),
    usePlatformType: () => 0,
    useLogger: () => ({ warn: vi.fn(), error: vi.fn() }),
    createDefaultHyperWasmAttachedDatabaseState: () => ({ type: 'local' }),
    createConnectionStateFromParams: (...args: unknown[]) => state.createConnectionStateFromParams(...args),
} as unknown as NotebookWorkbenchSidebarDependencies;

/// The catalog of a connection without relations
const EMPTY_CATALOG = {
    catalog: {
        createSnapshot: () => ({
            read: () => ({ catalogReader: { databasesLength: () => 0 } }),
        }),
    },
    catalogUpdates: { currentFullRefresh: null, tasksRunning: new Map() },
};

describe('NotebookWorkbenchSidebar notebook creation', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        state.navigate.mockReset();
        state.dispatchDatabase.mockReset();
        state.setupNotebookScripts.mockReset();
        state.write.mockReset().mockResolvedValue(true);
        state.refreshCatalog.mockReset();
        state.createConnectionStateFromParams.mockReset().mockReturnValue({ type: 'remote' });
        state.deleteNotebook.mockReset();
        state.overlayProps = null;
        state.shareProps = null;
        state.fileSaveProps = null;
        state.attachedDatabases.clear();
        state.attachedDatabasesByNotebook.clear();
        state.notebookScriptsMap.clear();
        state.notebookAttachedDatabases = null;
        state.local = { databaseId: 'local-database' } as AttachedDatabaseState;
        state.local = {
            databaseId: 'local-database',
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
            details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'WASM' } } } },
            ...EMPTY_CATALOG,
        } as unknown as AttachedDatabaseState;
        state.allocateDatabase.mockReset().mockReturnValue(state.local);
        state.allocateConnection.mockReset();
        state.attachConnection.mockReset();
        vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
        act(() => root.render(<NotebookWorkbenchSidebar notebookScripts={{
            notebookId: 'current-notebook',
            instance: {},
        } as any} dependencies={dependencies} />));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        act(() => root.unmount());
        container.remove();
    });

    function click(label: string): void {
        act(() => {
            (container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click();
        });
    }

    it('shows notebook and connection counts', () => {
        const main = {
            ...state.local!,
            connectorInfo: { icons: { colored: 'database' } },
            catalog: {
                createSnapshot: () => ({
                    read: () => ({ catalogReader: { databasesLength: () => 0 } }),
                }),
            },
            catalogUpdates: { currentFullRefresh: null, tasksRunning: new Map() },
        } as AttachedDatabaseState;
        const attached = { ...main, databaseId: 'attached-database' };
        state.attachedDatabases.set(main.databaseId, main);
        state.attachedDatabases.set(attached.databaseId, attached);
        state.attachedDatabasesByNotebook.set('current-notebook', {
            mainDatabaseId: main.databaseId,
            attachedDatabaseIds: [attached.databaseId],
        });
        state.notebookScriptsMap.set('current-notebook', {
            notebookId: 'current-notebook',
            name: 'Current notebook',
            notebookMetadata: {},
        });
        state.notebookAttachedDatabases = { main, attached: [attached] };

        act(() => root.render(<NotebookWorkbenchSidebar notebookScripts={{
            notebookId: 'current-notebook',
            instance: {},
        } as any} dependencies={dependencies} />));

        expect(container.querySelector('[aria-label="1 notebook"]')?.textContent).toBe('1');
        expect(container.querySelector('[aria-label="2 connections"]')?.textContent).toBe('2');
    });

    it('keeps ordinary settings open for an online database without a completion callback', () => {
        const main = {
            ...state.local!,
            connectionHealth: ConnectionHealth.ONLINE,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
            catalog: { createSnapshot: () => ({
                read: () => ({ catalogReader: { databasesLength: () => 0 } }),
            }) },
            catalogUpdates: { currentFullRefresh: null, tasksRunning: new Map() },
        } as AttachedDatabaseState;
        state.notebookAttachedDatabases = { main, attached: [] };
        act(() => root.render(<NotebookWorkbenchSidebar notebookScripts={{
            notebookId: 'current-notebook', instance: {},
        } as any} dependencies={dependencies} />));
        click('More actions for Memory');
        act(() => {
            Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Settings')!.click();
        });
        expect(state.overlayProps).toMatchObject({ databaseId: main.databaseId, isOpen: true });
        expect(state.overlayProps?.onConnected).toBeUndefined();
        act(() => {
            Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Complete setup')!.click();
        });
        expect(state.overlayProps?.isOpen).toBe(true);
        expect(state.navigate).not.toHaveBeenCalled();
    });

    it.each(['Hyper', 'Trino', 'Salesforce'])('creates and selects a %s notebook before connecting', async connector => {
        state.write.mockReturnValue(new Promise(() => {}));
        click('Create notebook');
        expect(state.setupNotebookScripts).not.toHaveBeenCalled();
        expect(Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Memory')).toBe(false);
        const choice = Array.from(document.querySelectorAll('button')).find(button => button.textContent === connector)!;
        expect(choice.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
        expect(choice.querySelector('use')?.getAttribute('xlink:href')).toContain(
            `#${connector === 'Salesforce' ? 'salesforce_notext' : connector.toLowerCase()}`,
        );
        act(() => {
            choice.click();
        });
        expect(state.setupNotebookScripts).toHaveBeenCalledWith(
            '00000000-0000-4000-8000-000000000001',
            state.local,
        );
        expect(state.allocateDatabase).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ active: true }));
        expect(state.navigate).toHaveBeenCalledWith({
            type: SELECT_NOTEBOOK,
            value: '00000000-0000-4000-8000-000000000001',
        });
        expect(state.write).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            value: ['00000000-0000-4000-8000-000000000001', 'local-database', [state.local]],
        }));
        expect(state.overlayProps?.isOpen).toBe(false);
        if (connector === 'Hyper') {
            expect(state.allocateDatabase).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'local' }));
            expect(state.createConnectionStateFromParams).not.toHaveBeenCalled();
        } else {
            const params = state.createConnectionStateFromParams.mock.calls[0][1];
            expect(Object.keys(params)).toEqual([connector === 'Salesforce' ? 'salesforce' : connector.toLowerCase()]);
        }
        act(() => root.render(<NotebookWorkbenchSidebar notebookScripts={{
            notebookId: 'current-notebook', instance: {},
        } as any} dependencies={{
            ...dependencies,
            useRouteContext: () => ({
                notebookId: 'current-notebook', notebookSetupStatus: NotebookSetupStatus.CONFIGURING,
            } as ReturnType<NotebookWorkbenchSidebarDependencies['useRouteContext']>),
        }} />));
        act(() => state.overlayProps!.onClose());
        expect(state.deleteNotebook).not.toHaveBeenCalled();
        expect(state.dispatchDatabase).not.toHaveBeenCalled();
    });

    it.each([ConnectionHealth.NOT_STARTED, ConnectionHealth.CONNECTING, ConnectionHealth.FAILED, ConnectionHealth.CANCELLED])('selects a disconnected notebook immediately (%s)', async connectionHealth => {
        const database = {
            databaseId: 'salesforce-database',
            connectionHealth,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD],
            details: {
                type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                value: { proto: { setupParams: {} } },
            },
            ...EMPTY_CATALOG,
        } as unknown as AttachedDatabaseState;
        state.attachedDatabases.set(database.databaseId, database);
        state.attachedDatabasesByNotebook.set('salesforce-notebook', {
            mainDatabaseId: database.databaseId,
            attachedDatabaseIds: [],
        });
        state.notebookScriptsMap.set('salesforce-notebook', {
            notebookId: 'salesforce-notebook',
            name: 'Salesforce notebook',
            notebookMetadata: {},
        });
        act(() => root.render(<NotebookWorkbenchSidebar notebookScripts={{
            notebookId: 'current-notebook',
            instance: {},
        } as any} dependencies={dependencies} />));

        act(() => {
            Array.from(container.querySelectorAll('button'))
                .find(button => button.textContent?.includes('Salesforce notebook'))!
                .click();
        });

        expect(state.overlayProps?.isOpen).toBe(false);
        expect(state.navigate).toHaveBeenCalledWith({
            type: SELECT_NOTEBOOK,
            value: 'salesforce-notebook',
        });
    });

    it('offers URL sharing from the notebook row menu', () => {
        const notebookId = 'current-notebook';
        state.attachedDatabases.set('local-database', state.local!);
        state.attachedDatabasesByNotebook.set(notebookId, {
            mainDatabaseId: 'local-database',
            attachedDatabaseIds: [],
        });
        state.notebookScriptsMap.set(notebookId, {
            notebookId,
            name: 'Current notebook',
            notebookMetadata: { originalFileName: 'current' },
        });
        act(() => root.render(<NotebookWorkbenchSidebar notebookScripts={{
            notebookId,
            instance: {},
        } as any} dependencies={dependencies} />));

        click('More actions for Current notebook');
        const share = Array.from(document.querySelectorAll('button'))
            .find(button => button.textContent?.includes('Share as URL'))!;
        expect(share).toBeDefined();

        act(() => share.click());
        expect(state.shareProps).toMatchObject({ isOpen: true, notebookId });
        expect(document.querySelector('[data-testid="share-url-overlay"]')).not.toBeNull();
    });

    it('opens export settings before saving from the notebook row menu', () => {
        const notebookId = 'current-notebook';
        state.attachedDatabases.set('local-database', state.local!);
        state.attachedDatabasesByNotebook.set(notebookId, {
            mainDatabaseId: 'local-database',
            attachedDatabaseIds: [],
        });
        state.notebookScriptsMap.set(notebookId, {
            notebookId,
            name: 'Current notebook',
            notebookMetadata: { originalFileName: 'current' },
        });
        act(() => root.render(<NotebookWorkbenchSidebar notebookScripts={{
            notebookId,
            instance: {},
        } as any} dependencies={dependencies} />));

        click('More actions for Current notebook');
        const exportItem = Array.from(document.querySelectorAll('button'))
            .find(button => button.textContent?.includes('Export .dashql'))!;
        expect(exportItem).toBeDefined();

        act(() => exportItem.click());
        expect(state.fileSaveProps).toMatchObject({
            isOpen: true,
            notebookScripts: { notebookId },
            fileName: 'Current notebook',
        });
        expect(document.querySelector('[data-testid="file-save-overlay"]')).not.toBeNull();
    });

    it('lists the connections of other notebooks and creates notebooks with them', () => {
        const other = { ...state.local!, databaseId: 'trino-database', connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO],
            details: { type: TRINO_CONNECTOR, value: { proto: { setupParams: {} } } } } as unknown as AttachedDatabaseState;
        state.attachedDatabases.set(state.local!.databaseId, state.local!);
        state.attachedDatabases.set(other.databaseId, other);
        state.attachedDatabasesByNotebook.set('current-notebook', { mainDatabaseId: state.local!.databaseId, attachedDatabaseIds: [] });
        state.attachedDatabasesByNotebook.set('trino-notebook', { mainDatabaseId: other.databaseId, attachedDatabaseIds: [] });
        state.attachedDatabasesByNotebook.set('shell', { mainDatabaseId: 'shell', attachedDatabaseIds: [] });
        state.attachedDatabases.set('shell', { ...other, databaseId: 'shell' } as AttachedDatabaseState);
        for (const notebookId of ['current-notebook', 'trino-notebook']) {
            state.notebookScriptsMap.set(notebookId, { notebookId, name: notebookId, notebookMetadata: {} });
        }
        state.notebookAttachedDatabases = { main: state.local!, attached: [] };
        act(() => root.render(<NotebookWorkbenchSidebar notebookScripts={{
            notebookId: 'current-notebook', instance: {},
        } as any} dependencies={dependencies} />));

        // The shell connection is not referenced by a notebook of the registry
        expect(container.querySelector('[aria-label="2 connections"]')?.textContent).toBe('2');
        click('Create notebook');
        const existing = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Trino'))!;
        act(() => existing.click());
        expect(state.allocateDatabase).not.toHaveBeenCalled();
        expect(state.attachConnection).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', 'trino-database');
        expect(state.setupNotebookScripts).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', other);
        expect(state.navigate).toHaveBeenCalledWith({ type: SELECT_NOTEBOOK, value: '00000000-0000-4000-8000-000000000001' });
    });
});
