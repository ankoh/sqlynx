import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
    ConnectionHealth, ConnectionStatus, DISCARD_CONNECTION_DRAFT, HEALTH_CHECK_FAILED,
    HEALTH_CHECK_CANCELLED, HEALTH_CHECK_SUCCEEDED, RESET_ATTACHED_DATABASE, SET_CONNECTION_DRAFT,
    reduceAttachedDatabaseState, type AttachedDatabaseState, type AttachedDatabaseAction,
} from './attached_database_state.js';
import {
    AttachedDatabaseRegistry as RegistryProvider, useAttachedDatabaseRegistry,
    useAttachedDatabaseById, useConnectionDraftForm,
} from './attached_database_registry.js';
import { ConnectorType, CONNECTOR_INFOS } from './connector_info.js';
import { createDefaultConnectionParamsForConnector, getConnectionStateDetailsFromParams, type ConnectionParams } from './connection_params.js';
import { HYPER_CHANNEL_SETUP_STARTED, HYPER_CHANNEL_READY, HYPER_CHANNEL_SETUP_FAILED, HYPER_CHANNEL_SETUP_CANCELLED } from './hyper/hyper_connection_state.js';
import { buildHyperConnectionPageState, buildHyperConnectionSetupParams, type HyperConnectionPageState } from './ui/hyper_connection_settings.js';
import { TRINO_CHANNEL_SETUP_STARTED, TRINO_CHANNEL_SETUP_FAILED, TRINO_CHANNEL_SETUP_CANCELLED } from './trino/trino_connection_state.js';
import { SETUP_STARTED, SETUP_FAILED, SETUP_CANCELLED } from './salesforce/salesforce_connection_state.js';
import { encodeConnectionAsProto } from './connection_export.js';
import { cancelConnectionSetup, registerConnectionSetup } from './connection_setup_cancellation.js';
import { buildPageStateFromParams } from './ui/trino_connection_settings.js';
import { LoggerProvider } from '../../../platform/logger/logger_provider.js';
import { StorageProvider, useStorageWriter } from '../persistence/storage_provider.js';
import { NotebookTestBackend, TEST_DATABASE_ID, TEST_NOTEBOOK_ID } from '../persistence/notebook_test_backend.js';
import type { StorageWriter } from '../persistence/storage_writer.js';
import type { Logger } from '../../../platform/logger/logger.js';

function database(type: ConnectorType): AttachedDatabaseState {
    const connectorInfo = CONNECTOR_INFOS[type];
    const params = createDefaultConnectionParamsForConnector(connectorInfo);
    return {
        databaseId: TEST_DATABASE_ID, connectorInfo, params, active: false,
        connectionStatus: ConnectionStatus.NOT_STARTED, connectionHealth: ConnectionHealth.NOT_STARTED,
        details: getConnectionStateDetailsFromParams(params),
        connectionSignature: { signatureString: 'initial', signatures: new Map() },
        catalog: { clear: vi.fn() }, catalogUpdates: { tasksRunning: new Map() },
    } as unknown as AttachedDatabaseState;
}
function reduce(state: AttachedDatabaseState, action: AttachedDatabaseAction) {
    return reduceAttachedDatabaseState(state, action, {} as StorageWriter, {} as Logger);
}
function edited(params: ConnectionParams, endpoint: string): ConnectionParams {
    if ('hyper' in params) return { hyper: { ...params.hyper, protocol: 'V3_HTTP', endpoint } };
    if ('trino' in params) return { trino: { ...params.trino, endpoint } };
    return { salesforce: { ...params.salesforce, instanceUrl: endpoint } };
}
function start(params: ConnectionParams): AttachedDatabaseAction {
    if ('hyper' in params) return { type: HYPER_CHANNEL_SETUP_STARTED, value: params.hyper as any };
    if ('trino' in params) return { type: TRINO_CHANNEL_SETUP_STARTED, value: params.trino as any };
    return { type: SETUP_STARTED, value: params.salesforce };
}

describe('durable connection drafts', () => {
    it('shares startup cancellation and protects newer registrations from stale cleanup', () => {
        const startup = new AbortController();
        const unregisterStartup = registerConnectionSetup(TEST_DATABASE_ID, startup);
        cancelConnectionSetup(TEST_DATABASE_ID);
        expect(startup.signal.aborted).toBe(true);
        expect(startup.signal.reason.name).toBe('AbortError');
        const next = new AbortController();
        const unregisterNext = registerConnectionSetup(TEST_DATABASE_ID, next);
        unregisterStartup();
        cancelConnectionSetup(TEST_DATABASE_ID);
        expect(next.signal.aborted).toBe(true);
        unregisterNext();
    });
    it.each([ConnectorType.HYPER, ConnectorType.TRINO, ConnectorType.SALESFORCE_DATA_CLOUD])('keeps %s committed until health check succeeds', type => {
        let state = database(type);
        const committed = state.params;
        const draft = edited(committed, 'invalid endpoint');
        state = reduce(state, { type: SET_CONNECTION_DRAFT, value: draft });
        state = reduce(state, start(draft));
        expect(state.params).toEqual(committed);
        expect(state.paramsDraft).toEqual(draft);
        expect(reduce(state, { type: DISCARD_CONNECTION_DRAFT, value: null })).toBe(state);
        const newer = edited(committed, 'newer incomplete edit');
        state = reduce(state, { type: SET_CONNECTION_DRAFT, value: newer });
        state = reduce(state, { type: HEALTH_CHECK_SUCCEEDED, value: null });
        expect(state.params).toEqual(draft);
        expect(state.paramsDraft).toEqual(newer);
        state = reduce(state, start(newer));
        state = reduce(state, { type: HEALTH_CHECK_SUCCEEDED, value: null });
        expect(state.params).toEqual(newer);
        expect(state.paramsDraft).toBeUndefined();
    });

    it.each([ConnectorType.HYPER, ConnectorType.TRINO, ConnectorType.SALESFORCE_DATA_CLOUD])('preserves %s draft and committed parameters on failure, cancellation and reset', type => {
        const initial = database(type);
        const draft = edited(initial.params, 'invalid incomplete endpoint');
        let state = reduce(initial, { type: SET_CONNECTION_DRAFT, value: draft });
        state = reduce(state, start(draft));
        const setupFailed = type === ConnectorType.HYPER ? HYPER_CHANNEL_SETUP_FAILED
            : type === ConnectorType.TRINO ? TRINO_CHANNEL_SETUP_FAILED : SETUP_FAILED;
        const setupCancelled = type === ConnectorType.HYPER ? HYPER_CHANNEL_SETUP_CANCELLED
            : type === ConnectorType.TRINO ? TRINO_CHANNEL_SETUP_CANCELLED : SETUP_CANCELLED;
        for (const action of [
            { type: setupFailed, value: { message: 'setup failed' } },
            { type: setupCancelled, value: { message: 'setup cancelled' } },
            { type: HEALTH_CHECK_FAILED, value: { message: 'failed' } },
            { type: HEALTH_CHECK_CANCELLED, value: null },
            { type: RESET_ATTACHED_DATABASE, value: null },
        ] as AttachedDatabaseAction[]) {
            const next = reduce(state, action);
            expect(next.params).toEqual(initial.params);
            expect(next.paramsDraft).toEqual(draft);
            expect(next.setupAttemptParams).toBeUndefined();
            expect(next.details.value.proto.setupParams).not.toEqual(
                'hyper' in initial.params ? initial.params.hyper : 'trino' in initial.params ? initial.params.trino : initial.params.salesforce,
            );
        }
        state = reduce(state, { type: HEALTH_CHECK_FAILED, value: { message: 'failed' } });
        state = reduce(state, { type: DISCARD_CONNECTION_DRAFT, value: null });
        expect(state.paramsDraft).toBeUndefined();
        expect(state.params).toEqual(initial.params);
        expect(state.details.value.proto.healthCheckError).toBeUndefined();
    });

    it('exports only sanitized committed settings through the connection encoder', () => {
        const state = database(ConnectorType.SALESFORCE_DATA_CLOUD);
        state.params = { salesforce: { hyperProtocol: 'V3_HTTP', instanceUrl: 'committed', appConsumerKey: 'key', appConsumerSecret: 'secret', login: '' } };
        state.paramsDraft = edited(state.params, 'draft');
        state.details = getConnectionStateDetailsFromParams(edited(state.params, 'attempted'))!;
        const encoded = JSON.stringify(encodeConnectionAsProto(state));
        expect(encoded).toContain('committed');
        expect(encoded).not.toContain('attempted');
        expect(encoded).not.toContain('draft');
        expect(encoded).not.toContain('"secret"');
    });

    it('promotes embedded Hyper when its local channel becomes ready', () => {
        let state = database(ConnectorType.HYPER);
        state = reduce(state, { type: SET_CONNECTION_DRAFT, value: state.params });
        state = reduce(state, start(state.params));
        state = reduce(state, { type: HYPER_CHANNEL_READY, value: [{} as any, 'hyper' in state.params ? state.params.hyper as any : undefined] });
        expect(state.connectionHealth).toBe(ConnectionHealth.ONLINE);
        expect(state.paramsDraft).toBeUndefined();
        expect(state.active).toBe(true);
    });

    it.each([false, true])('saves invalid edits with active=%s and does not resurrect a discarded draft', async active => {
        const backend = new NotebookTestBackend();
        let setRegistry!: ReturnType<typeof useAttachedDatabaseRegistry>[1];
        let edit!: React.Dispatch<React.SetStateAction<string>>;
        let dispatch!: ReturnType<typeof useAttachedDatabaseById>[1];
        let writer!: StorageWriter;
        let current!: AttachedDatabaseState;
        let value = '';
        function Harness() {
            [, setRegistry] = useAttachedDatabaseRegistry();
            [current, dispatch] = useAttachedDatabaseById(TEST_DATABASE_ID) as [AttachedDatabaseState, typeof dispatch];
            [value, edit] = useConnectionDraftForm(TEST_DATABASE_ID,
                params => params && 'trino' in params ? params.trino.endpoint : '',
                endpoint => edited(current.params, endpoint));
            writer = useStorageWriter();
            return null;
        }
        const root = createRoot(document.createElement('div'));
        try {
            await act(async () => root.render(<LoggerProvider><StorageProvider backend={backend}><RegistryProvider><Harness /></RegistryProvider></StorageProvider></LoggerProvider>));
            await act(async () => setRegistry(reg => {
                reg.attachedDatabases.set(TEST_DATABASE_ID, { ...database(ConnectorType.TRINO), active });
                reg.attachedDatabasesByNotebook.set(TEST_NOTEBOOK_ID, { mainDatabaseId: TEST_DATABASE_ID, attachedDatabaseIds: [] });
                return { ...reg };
            }));
            await act(async () => edit('not a URL'));
            expect(current.active).toBe(active);
            expect(value).toBe('not a URL');
            await writer.flush();
            expect((await backend.loadNotebook(TEST_NOTEBOOK_ID)).mainDatabase.paramsDraft).toEqual(edited(current.params, 'not a URL'));
            await act(async () => edit('newer unfinished value'));
            await act(async () => dispatch({ type: DISCARD_CONNECTION_DRAFT, value: null }));
            await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
            expect(value).toBe('');
            await writer.flush();
            expect((await backend.loadNotebook(TEST_NOTEBOOK_ID)).mainDatabase.paramsDraft).toBeUndefined();
            await act(async () => { await Promise.resolve(); });
            expect(writer.getPendingKeysForNotebook(TEST_NOTEBOOK_ID)).toEqual([]);
            expect(current.connectionHealth).toBe(ConnectionHealth.NOT_STARTED);
        } finally {
            act(() => root.unmount());
        }
    });

    it('persists and rehydrates incomplete duplicate header rows without flattening the form', async () => {
        const backend = new NotebookTestBackend();
        let setRegistry!: ReturnType<typeof useAttachedDatabaseRegistry>[1];
        let edit!: React.Dispatch<React.SetStateAction<HyperConnectionPageState>>;
        let dispatch!: ReturnType<typeof useAttachedDatabaseById>[1];
        let form!: HyperConnectionPageState;
        let writer!: StorageWriter;
        function Harness() {
            [, setRegistry] = useAttachedDatabaseRegistry();
            [, dispatch] = useAttachedDatabaseById(TEST_DATABASE_ID);
            [form, edit] = useConnectionDraftForm(TEST_DATABASE_ID,
                params => buildHyperConnectionPageState(params && 'hyper' in params ? params.hyper as any : undefined),
                value => ({ hyper: { ...buildHyperConnectionSetupParams(value), draftRows: { metadata: value.gRPCMetadata, queryParameters: value.queryParameters } } }));
            writer = useStorageWriter();
            return null;
        }
        const root = createRoot(document.createElement('div'));
        try {
            await act(async () => root.render(<LoggerProvider><StorageProvider backend={backend}><RegistryProvider><Harness /></RegistryProvider></StorageProvider></LoggerProvider>));
            await act(async () => setRegistry(reg => {
                reg.attachedDatabases.set(TEST_DATABASE_ID, database(ConnectorType.HYPER));
                reg.attachedDatabasesByNotebook.set(TEST_NOTEBOOK_ID, { mainDatabaseId: TEST_DATABASE_ID, attachedDatabaseIds: [] });
                return { ...reg };
            }));
            const rows = [{ key: '', value: 'unfinished' }, { key: '', value: '' }];
            await act(async () => edit(prev => ({ ...prev, endpoint: 'invalid', gRPCMetadata: rows })));
            await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
            expect(form.gRPCMetadata).toEqual(rows);
            expect(form.endpoint).toBe('invalid');
            await writer.flush();
            const persisted = JSON.parse(JSON.stringify(await backend.loadNotebook(TEST_NOTEBOOK_ID)));
            expect(buildHyperConnectionPageState(persisted.mainDatabase.paramsDraft.hyper).gRPCMetadata).toEqual(rows);
            expect(buildHyperConnectionPageState(persisted.mainDatabase.paramsDraft.hyper).endpoint).toBe('invalid');
            await act(async () => setRegistry(reg => {
                const current = reg.attachedDatabases.get(TEST_DATABASE_ID)!;
                reg.attachedDatabases.set(TEST_DATABASE_ID, { ...current, paramsDraft: persisted.mainDatabase.paramsDraft });
                return { ...reg };
            }));
            expect(form.gRPCMetadata).toEqual(rows);
            expect(form.endpoint).toBe('invalid');
            await act(async () => dispatch({ type: DISCARD_CONNECTION_DRAFT, value: null }));
            await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
            expect(form.gRPCMetadata).toEqual([]);
            expect(form.endpoint).toBe('');
            await writer.flush();
            expect((await backend.loadNotebook(TEST_NOTEBOOK_ID)).mainDatabase.paramsDraft).toBeUndefined();
        } finally {
            act(() => root.unmount());
        }
    });

    it('reloads ordered incomplete Trino metadata and Hyper query rows and strips them on successful promotion', () => {
        const rows = [{ key: '', value: 'partial' }, { key: '', value: '' }, { key: 'duplicate', value: 'one' }, { key: 'duplicate', value: 'two' }];
        const trino = database(ConnectorType.TRINO);
        const params = { trino: { ...('trino' in trino.params ? trino.params.trino : {}), endpoint: 'invalid', draftRows: { metadata: rows } } } as ConnectionParams;
        const reloaded = JSON.parse(JSON.stringify(params));
        expect(buildPageStateFromParams(reloaded.trino).newParamsMetadata).toEqual(rows);
        let hyper = database(ConnectorType.HYPER);
        const draft = { hyper: { ...('hyper' in hyper.params ? hyper.params.hyper : {}), draftRows: { queryParameters: rows } } } as ConnectionParams;
        expect(buildHyperConnectionPageState(JSON.parse(JSON.stringify(draft)).hyper).queryParameters).toEqual(rows);
        hyper = reduce(hyper, { type: SET_CONNECTION_DRAFT, value: draft });
        hyper = reduce(hyper, start(draft));
        hyper = reduce(hyper, { type: HEALTH_CHECK_SUCCEEDED, value: null });
        expect(hyper.paramsDraft).toBeUndefined();
        expect(JSON.stringify(hyper.params)).not.toContain('draftRows');
    });

    it('keeps edits to raw duplicate rows made during setup even when their flattened parameters are unchanged', () => {
        let state = database(ConnectorType.HYPER);
        const initial = { hyper: {
            ...('hyper' in state.params ? state.params.hyper : {}),
            metadata: { duplicate: 'same' },
            draftRows: { metadata: [{ key: 'duplicate', value: 'same' }] },
        } } as ConnectionParams;
        state = reduce(state, { type: SET_CONNECTION_DRAFT, value: initial });
        state = reduce(state, start(initial));
        const newer = { hyper: {
            ...('hyper' in initial ? initial.hyper : {}),
            draftRows: { metadata: [{ key: 'duplicate', value: 'unfinished' }, { key: 'duplicate', value: 'same' }] },
        } } as ConnectionParams;
        state = reduce(state, { type: SET_CONNECTION_DRAFT, value: newer });
        state = reduce(state, { type: HEALTH_CHECK_SUCCEEDED, value: null });
        expect(state.paramsDraft).toEqual(newer);
        expect(JSON.stringify(state.params)).not.toContain('draftRows');
    });
});
