import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionHealth, type ConnectionState } from '../../connections/connection_state.js';
import { CONNECTOR_INFOS, ConnectorType, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from '../../connections/connector_info.js';
import { SessionSetupStatus } from '../../loading/session_setup_status.js';
import { SELECT_SESSION } from '../../router/router.js';
import { SessionWorkbenchSidebar, type SessionWorkbenchSidebarDependencies } from './session_workbench_sidebar.js';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const state = {
    navigate: vi.fn(),
    dispatchDatabase: vi.fn(),
    createSession: vi.fn(),
    write: vi.fn<() => Promise<boolean>>(),
    refreshCatalog: vi.fn(),
    createConnectionStateFromParams: vi.fn(),
    deleteSession: vi.fn(),
    allocateConnection: vi.fn(),
    local: null as ConnectionState | null,
    overlayProps: null as { connectionId: string | null; headerTitle?: string; isOpen: boolean; onClose: () => void; onConnected?: (database: ConnectionState) => void } | null,
    shareProps: null as { isOpen: boolean; sessionId?: string } | null,
    fileSaveProps: null as { isOpen: boolean; sessionScripts?: { sessionId: string }; fileName?: string } | null,
    connections: new Map<string, ConnectionState>(),
    attachedDatabasesBySession: new Map<string, { mainDatabaseId: string; attachedDatabaseIds: string[] }>(),
    sessionScriptsMap: new Map<string, unknown>(),
    sessionAttachedDatabases: null as { main: ConnectionState; attached: ConnectionState[] } | null,
};

/// The connections that the sessions of the fake scripts registry use
const references = {
    connectionsOf: (sessionId: string) => {
        const mapping = state.attachedDatabasesBySession.get(sessionId);
        return mapping == null || !state.sessionScriptsMap.has(sessionId) ? [] : [mapping.mainDatabaseId, ...mapping.attachedDatabaseIds];
    },
    sessionsOf: (connectionId: string) => [...state.attachedDatabasesBySession.keys()]
        .filter(sessionId => references.connectionsOf(sessionId).includes(connectionId)),
    subscribe: () => () => { },
};

/// The connection ids of the fake registry by connector type
function connectionsByType(): string[][] {
    const byType: string[][] = [[], [], []];
    for (const database of state.connections.values()) (byType[database.connectorInfo?.connectorType ?? 0] ??= []).push(database.connectionId);
    return byType;
}

const dependencies = {
    useRouterNavigate: () => state.navigate,
    useRouteContext: () => ({ sessionId: 'current-session', sessionSetupStatus: SessionSetupStatus.NONE }),
    useConnectionRegistry: () => [{
        connections: state.connections,
    }, vi.fn()],
    useConnectionReferences: () => references,
    useSessionConnections: () => state.sessionAttachedDatabases,
    useDynamicConnectionDispatch: () => [{
        connections: state.connections,
        connectionsByType: connectionsByType(),
    }, state.dispatchDatabase],
    useConnectionAllocator: () => state.allocateConnection,
    ConnectionSettingsOverlay: (props: typeof state.overlayProps) => {
        state.overlayProps = props;
        return props?.isOpen ? <button onClick={() => props.onConnected?.(state.local!)}>Complete setup</button> : null;
    },
    useSessionScriptsDeletion: () => vi.fn(),
    useSessionScriptsRegistry: () => [{ sessionScriptsMap: state.sessionScriptsMap }],
    useSessionCreation: () => state.createSession,
    useStorageReader: () => ({
        backend: {},
        getSessionLocation: () => ({ type: 'opfs' }),
        getSessionOrder: () => [],
    }),
    useStorageWriter: () => ({
        write: state.write,
        deleteSession: state.deleteSession,
        backend: {},
        cancelPendingWritesForSession: vi.fn(),
    }),
    useComputationDispatch: () => vi.fn(),
    BundledSessionsOverlay: () => null,
    SessionStorageOverlay: () => null,
    SessionURLShareOverlay: (props: typeof state.shareProps) => {
        state.shareProps = props;
        return props?.isOpen ? <div data-testid="share-url-overlay" /> : null;
    },
    SessionFileSaveOverlay: (props: typeof state.fileSaveProps) => {
        state.fileSaveProps = props;
        return props?.isOpen ? <div data-testid="file-save-overlay" /> : null;
    },
    useSessionImport: () => ({}),
    useInvalidSessions: () => ({ invalidSessions: new Map(), deleteInvalidSession: vi.fn() }),
    useDashQLCoreSetup: () => vi.fn(),
    usePlatformType: () => 0,
    useLogger: () => ({ warn: vi.fn(), error: vi.fn() }),
    createDefaultHyperWasmConnectionState: () => ({ type: 'local' }),
    createConnectionStateFromParams: (...args: unknown[]) => state.createConnectionStateFromParams(...args),
} as unknown as SessionWorkbenchSidebarDependencies;

/// The catalog of a connection without relations
const EMPTY_CATALOG = {
    catalog: {
        createSnapshot: () => ({
            read: () => ({ catalogReader: { databasesLength: () => 0 } }),
        }),
    },
    catalogUpdates: { currentFullRefresh: null, tasksRunning: new Map() },
};

describe('SessionWorkbenchSidebar session creation', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        state.navigate.mockReset();
        state.dispatchDatabase.mockReset();
        state.createSession.mockReset().mockReturnValue({ sessionId: '00000000-0000-4000-8000-000000000001' });
        state.write.mockReset().mockResolvedValue(true);
        state.refreshCatalog.mockReset();
        state.createConnectionStateFromParams.mockReset().mockReturnValue({ type: 'remote' });
        state.deleteSession.mockReset();
        state.overlayProps = null;
        state.shareProps = null;
        state.fileSaveProps = null;
        state.connections.clear();
        state.attachedDatabasesBySession.clear();
        state.sessionScriptsMap.clear();
        state.sessionAttachedDatabases = null;
        state.local = { connectionId: 'local-database' } as ConnectionState;
        state.local = {
            connectionId: 'local-database',
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
            details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'WASM' } } } },
            ...EMPTY_CATALOG,
        } as unknown as ConnectionState;
        state.allocateConnection.mockReset().mockReturnValue(state.local);
        vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
        act(() => root.render(<SessionWorkbenchSidebar sessionScripts={{
            sessionId: 'current-session',
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

    it('shows session and connection counts', () => {
        const main = {
            ...state.local!,
            connectorInfo: { icons: { colored: 'database' }, names: { displayLong: 'Hyper' } },
            catalog: {
                createSnapshot: () => ({
                    read: () => ({ catalogReader: { databasesLength: () => 0 } }),
                }),
            },
            catalogUpdates: { currentFullRefresh: null, tasksRunning: new Map() },
        } as ConnectionState;
        const attached = { ...main, connectionId: 'attached-database' };
        state.connections.set(main.connectionId, main);
        state.connections.set(attached.connectionId, attached);
        state.attachedDatabasesBySession.set('current-session', {
            mainDatabaseId: main.connectionId,
            attachedDatabaseIds: [attached.connectionId],
        });
        state.sessionScriptsMap.set('current-session', {
            sessionId: 'current-session',
            name: 'Current session',
            sessionMetadata: {},
        });
        state.sessionAttachedDatabases = { main, attached: [attached] };

        act(() => root.render(<SessionWorkbenchSidebar sessionScripts={{
            sessionId: 'current-session',
            instance: {},
        } as any} dependencies={dependencies} />));

        expect(container.querySelector('[aria-label="1 session"]')?.textContent).toBe('1');
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
        } as ConnectionState;
        state.sessionAttachedDatabases = { main, attached: [] };
        act(() => root.render(<SessionWorkbenchSidebar sessionScripts={{
            sessionId: 'current-session', instance: {},
        } as any} dependencies={dependencies} />));
        click('More actions for Hyper Local');
        act(() => {
            Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Settings')!.click();
        });
        expect(state.overlayProps).toMatchObject({ connectionId: main.connectionId, isOpen: true });
        expect(state.overlayProps?.onConnected).toBeUndefined();
        act(() => {
            Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Complete setup')!.click();
        });
        expect(state.overlayProps?.isOpen).toBe(true);
        expect(state.navigate).not.toHaveBeenCalled();
    });

    it.each(['Hyper', 'Trino', 'Salesforce'])('creates and selects a %s session before connecting', async connector => {
        state.write.mockReturnValue(new Promise(() => {}));
        click('Create session');
        expect(state.createSession).not.toHaveBeenCalled();
        expect(Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Hyper Local')).toBe(false);
        const choice = Array.from(document.querySelectorAll('button')).find(button => button.textContent === connector)!;
        expect(choice.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
        expect(choice.querySelector('use')?.getAttribute('xlink:href')).toContain(
            `#${connector === 'Salesforce' ? 'salesforce_notext' : connector.toLowerCase()}`,
        );
        act(() => {
            choice.click();
        });
        expect(state.createSession).toHaveBeenCalledWith(state.local);
        expect(state.allocateConnection).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
        expect(state.navigate).toHaveBeenCalledWith({
            type: SELECT_SESSION,
            value: '00000000-0000-4000-8000-000000000001',
        });
        expect(state.overlayProps?.isOpen).toBe(false);
        if (connector === 'Hyper') {
            expect(state.allocateConnection).toHaveBeenCalledWith(expect.objectContaining({ type: 'local' }));
            expect(state.createConnectionStateFromParams).not.toHaveBeenCalled();
        } else {
            const params = state.createConnectionStateFromParams.mock.calls[0][1];
            expect(Object.keys(params)).toEqual([connector === 'Salesforce' ? 'salesforce' : connector.toLowerCase()]);
        }
        act(() => root.render(<SessionWorkbenchSidebar sessionScripts={{
            sessionId: 'current-session', instance: {},
        } as any} dependencies={{
            ...dependencies,
            useRouteContext: () => ({
                sessionId: 'current-session', sessionSetupStatus: SessionSetupStatus.CONFIGURING,
            } as ReturnType<SessionWorkbenchSidebarDependencies['useRouteContext']>),
        }} />));
        act(() => state.overlayProps!.onClose());
        expect(state.deleteSession).not.toHaveBeenCalled();
        expect(state.dispatchDatabase).not.toHaveBeenCalled();
    });

    it.each([ConnectionHealth.NOT_STARTED, ConnectionHealth.CONNECTING, ConnectionHealth.FAILED, ConnectionHealth.CANCELLED])('selects a disconnected session immediately (%s)', async connectionHealth => {
        const database = {
            connectionId: 'salesforce-database',
            connectionHealth,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD],
            details: {
                type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                value: { proto: { setupParams: {} } },
            },
            ...EMPTY_CATALOG,
        } as unknown as ConnectionState;
        state.connections.set(database.connectionId, database);
        state.attachedDatabasesBySession.set('salesforce-session', {
            mainDatabaseId: database.connectionId,
            attachedDatabaseIds: [],
        });
        state.sessionScriptsMap.set('salesforce-session', {
            sessionId: 'salesforce-session',
            name: 'Salesforce session',
            sessionMetadata: {},
        });
        act(() => root.render(<SessionWorkbenchSidebar sessionScripts={{
            sessionId: 'current-session',
            instance: {},
        } as any} dependencies={dependencies} />));

        act(() => {
            Array.from(container.querySelectorAll('button'))
                .find(button => button.textContent?.includes('Salesforce session'))!
                .click();
        });

        expect(state.overlayProps?.isOpen).toBe(false);
        expect(state.navigate).toHaveBeenCalledWith({
            type: SELECT_SESSION,
            value: 'salesforce-session',
        });
    });

    it('offers URL sharing from the session row menu', () => {
        const sessionId = 'current-session';
        state.connections.set('local-database', state.local!);
        state.attachedDatabasesBySession.set(sessionId, {
            mainDatabaseId: 'local-database',
            attachedDatabaseIds: [],
        });
        state.sessionScriptsMap.set(sessionId, {
            sessionId,
            name: 'Current session',
            sessionMetadata: { originalFileName: 'current' },
        });
        act(() => root.render(<SessionWorkbenchSidebar sessionScripts={{
            sessionId,
            instance: {},
        } as any} dependencies={dependencies} />));

        click('More actions for Current session');
        const share = Array.from(document.querySelectorAll('button'))
            .find(button => button.textContent?.includes('Share as URL'))!;
        expect(share).toBeDefined();

        act(() => share.click());
        expect(state.shareProps).toMatchObject({ isOpen: true, sessionId });
        expect(document.querySelector('[data-testid="share-url-overlay"]')).not.toBeNull();
    });

    it('opens export settings before saving from the session row menu', () => {
        const sessionId = 'current-session';
        state.connections.set('local-database', state.local!);
        state.attachedDatabasesBySession.set(sessionId, {
            mainDatabaseId: 'local-database',
            attachedDatabaseIds: [],
        });
        state.sessionScriptsMap.set(sessionId, {
            sessionId,
            name: 'Current session',
            sessionMetadata: { originalFileName: 'current' },
        });
        act(() => root.render(<SessionWorkbenchSidebar sessionScripts={{
            sessionId,
            instance: {},
        } as any} dependencies={dependencies} />));

        click('More actions for Current session');
        const exportItem = Array.from(document.querySelectorAll('button'))
            .find(button => button.textContent?.includes('Export .dashql'))!;
        expect(exportItem).toBeDefined();

        act(() => exportItem.click());
        expect(state.fileSaveProps).toMatchObject({
            isOpen: true,
            sessionScripts: { sessionId },
            fileName: 'Current session',
        });
        expect(document.querySelector('[data-testid="file-save-overlay"]')).not.toBeNull();
    });

    it('lists the connections of other sessions and creates sessions with them', () => {
        const other = { ...state.local!, connectionId: 'trino-database', connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO],
            details: { type: TRINO_CONNECTOR, value: { proto: { setupParams: {} } } } } as unknown as ConnectionState;
        state.connections.set(state.local!.connectionId, state.local!);
        state.connections.set(other.connectionId, other);
        state.attachedDatabasesBySession.set('current-session', { mainDatabaseId: state.local!.connectionId, attachedDatabaseIds: [] });
        state.attachedDatabasesBySession.set('trino-session', { mainDatabaseId: other.connectionId, attachedDatabaseIds: [] });
        state.attachedDatabasesBySession.set('shell', { mainDatabaseId: 'shell', attachedDatabaseIds: [] });
        state.connections.set('shell', { ...other, connectionId: 'shell' } as ConnectionState);
        for (const sessionId of ['current-session', 'trino-session']) {
            state.sessionScriptsMap.set(sessionId, { sessionId, name: sessionId, sessionMetadata: {} });
        }
        state.sessionAttachedDatabases = { main: state.local!, attached: [] };
        act(() => root.render(<SessionWorkbenchSidebar sessionScripts={{
            sessionId: 'current-session', instance: {},
        } as any} dependencies={dependencies} />));

        // The shell connection is not referenced by a session of the registry
        expect(container.querySelector('[aria-label="2 connections"]')?.textContent).toBe('2');
        click('Create session');
        const existing = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Trino'))!;
        act(() => existing.click());
        expect(state.allocateConnection).not.toHaveBeenCalled();
        expect(state.createSession).toHaveBeenCalledWith(other);
        expect(state.navigate).toHaveBeenCalledWith({ type: SELECT_SESSION, value: '00000000-0000-4000-8000-000000000001' });
    });

    it('groups the connections of the session and numbers connections of the same connector', () => {
        const trino = { ...state.local!, connectionId: 'trino-database', connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO],
            details: { type: TRINO_CONNECTOR, value: { proto: { setupParams: {} } } } } as unknown as ConnectionState;
        const secondHyper = { ...state.local!, connectionId: 'second-hyper' } as ConnectionState;
        for (const database of [state.local!, trino, secondHyper]) state.connections.set(database.connectionId, database);
        state.attachedDatabasesBySession.set('current-session', { mainDatabaseId: state.local!.connectionId, attachedDatabaseIds: [] });
        state.attachedDatabasesBySession.set('trino-session', { mainDatabaseId: trino.connectionId, attachedDatabaseIds: [secondHyper.connectionId] });
        for (const sessionId of ['current-session', 'trino-session']) {
            state.sessionScriptsMap.set(sessionId, { sessionId, name: sessionId, sessionMetadata: {} });
        }
        state.sessionAttachedDatabases = { main: state.local!, attached: [] };
        act(() => root.render(<SessionWorkbenchSidebar sessionScripts={{
            sessionId: 'current-session', instance: {},
        } as any} dependencies={dependencies} />));

        const headings = Array.from(container.querySelectorAll('[role="heading"]')).map(heading => heading.textContent);
        expect(headings).toEqual(['This session', 'Other connections']);
        const text = container.textContent ?? '';
        expect(text).toContain('Hyper #1');
        expect(text).toContain('Hyper #2');
        // Every session row shows the connections of its session, the default one first
        const sessionConnections = Array.from(container.querySelectorAll('[aria-label^="Connections: "]'))
            .map(element => element.getAttribute('aria-label'));
        expect(sessionConnections).toHaveLength(2);
        expect(sessionConnections.find(label => label!.includes('Trino'))).toMatch(/^Connections: Trino \S+ \(default\), Hyper #2 /);
    });
});
