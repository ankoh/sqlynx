import { describe, expect, it } from 'vitest';

import { Logger } from '../../../platform/logger/logger.js';
import { NotebookTestBackend } from './notebook_test_backend.js';
import {
    DELETE_SCRIPT,
    groupScriptDeletes,
    groupScriptRenames,
    groupScriptWrites,
    RENAME_SCRIPT,
    StorageWriter,
    WRITE_NOTEBOOK_MANIFEST,
    WRITE_SCRIPT,
    WRITE_NOTEBOOK_NAME,
    groupNotebookConnectionWrites,
    groupNotebookManifestWrites,
} from './storage_writer.js';
import { ConnectorType, HYPER_CONNECTOR, TRINO_CONNECTOR } from '../connections/connector_info.js';
import { ConnectionHealth, ConnectionStatus, DISCARD_CONNECTION_DRAFT, SET_CONNECTION_DRAFT, reduceAttachedDatabaseState, type AttachedDatabaseState } from '../connections/attached_database_state.js';
import { CONNECTOR_INFOS } from '../connections/connector_info.js';
import { testNotebook, TEST_DATABASE_ID, TEST_NOTEBOOK_ID } from './notebook_test_backend.js';

class NullLogger extends Logger {
    public destroy(): void {}
    protected flushPendingRecords(): void {}
}

describe('V2 storage writer flat mutations', () => {
    it.each(['name-first', 'connection-first'])('retains rename and draft/discard in separate debounced tasks (%s)', async order => {
        const backend = new NotebookTestBackend();
        const logger = new NullLogger();
        const writer = new StorageWriter(logger, backend);
        const params = { trino: { endpoint: 'committed', catalogName: '', auth: { authType: 'AUTH_BASIC' as const } } };
        const paramsDraft = { trino: { ...params.trino, endpoint: 'unfinished' } };
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook({ mainDatabase: { databaseId: TEST_DATABASE_ID, params } }));
        let state = {
            databaseId: TEST_DATABASE_ID, params,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO],
            connectionHealth: ConnectionHealth.NOT_STARTED, connectionStatus: ConnectionStatus.NOT_STARTED,
            details: { type: TRINO_CONNECTOR, value: { proto: { setupParams: params.trino, setupTimings: {} } } },
        } as AttachedDatabaseState;
        for (const discard of [false, true]) {
            state = reduceAttachedDatabaseState(state, discard
                ? { type: DISCARD_CONNECTION_DRAFT, value: null }
                : { type: SET_CONNECTION_DRAFT, value: paramsDraft }, writer, logger);
            const name = discard ? 'renamed during discard' : 'renamed during edit';
            const rename = () => writer.write(groupNotebookManifestWrites(TEST_NOTEBOOK_ID), {
                type: WRITE_NOTEBOOK_NAME, value: [TEST_NOTEBOOK_ID, name],
            }, 10_000);
            const connection = () => writer.write(groupNotebookConnectionWrites(TEST_NOTEBOOK_ID), {
                type: WRITE_NOTEBOOK_MANIFEST, value: [TEST_NOTEBOOK_ID, TEST_DATABASE_ID, [state]],
            }, 10_000);
            const tasks = order === 'name-first' ? [rename(), connection()] : [connection(), rename()];
            expect(writer.getPendingKeysForNotebook(TEST_NOTEBOOK_ID)).toHaveLength(2);
            await writer.flush();
            await expect(Promise.all(tasks)).resolves.toEqual([true, true]);
            const saved = await backend.loadNotebook(TEST_NOTEBOOK_ID);
            expect(saved.name).toBe(name);
            expect(saved.mainDatabase.params).toEqual(params);
            expect(saved.mainDatabase.paramsDraft).toEqual(discard ? undefined : paramsDraft);
        }
    });
    it('persists only committed and draft settings, not attempted params or OAuth runtime state', async () => {
        const backend = new NotebookTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const notebookId = '11111111-2222-4333-8444-555555555555';
        const databaseId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const state = {
            databaseId,
            params: { trino: { endpoint: 'committed' } },
            paramsDraft: { trino: { endpoint: '' } },
            details: { type: TRINO_CONNECTOR, value: { proto: {
                setupParams: { endpoint: 'attempted' },
                oauthState: { accessToken: { accessToken: 'runtime-secret' } },
            } } },
        } as unknown as AttachedDatabaseState;
        await writer.write(notebookId, { type: WRITE_NOTEBOOK_MANIFEST, value: [notebookId, databaseId, [state]] });
        const saved = await backend.loadNotebook(notebookId);
        expect(saved.mainDatabase).toEqual({ databaseId, params: state.params, paramsDraft: state.paramsDraft });
        expect(JSON.stringify(saved)).not.toContain('runtime-secret');
        await writer.write(notebookId, { type: WRITE_NOTEBOOK_MANIFEST, value: [notebookId, databaseId, [{ ...state, paramsDraft: undefined }]] });
        expect((await backend.loadNotebook(notebookId)).mainDatabase.paramsDraft).toBeUndefined();
    });
    it('round-trips local and remote attached databases with an explicit main database', async () => {
        const backend = new NotebookTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const notebookId = '11111111-2222-4333-8444-555555555555';
        const state = (databaseId: string, connectorType: ConnectorType, setupParams: object) => ({
            databaseId,
            connectorInfo: { connectorType },
            params: connectorType === ConnectorType.HYPER ? { hyper: setupParams } : { trino: setupParams },
            details: connectorType === ConnectorType.HYPER
                ? { type: HYPER_CONNECTOR, value: { proto: { setupParams } } }
                : { type: TRINO_CONNECTOR, value: { proto: { setupParams } } },
        }) as unknown as AttachedDatabaseState;

        await writer.write(notebookId, {
            type: WRITE_NOTEBOOK_MANIFEST,
            value: [notebookId, 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb', [
                state('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ConnectorType.HYPER, { protocol: 'WASM' }),
                state('ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb', ConnectorType.TRINO, { endpoint: 'https://trino.example' }),
            ]],
        });

        expect((await backend.loadNotebook(notebookId)).attachedDatabases).toEqual([
            { databaseId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', params: { hyper: { protocol: 'WASM' } } },
        ]);
        expect((await backend.loadNotebook(notebookId)).mainDatabase.databaseId).toBe('ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb');
    });

    it('keeps rename, write, and delete in distinct ordered keyspaces', async () => {
        const backend = new NotebookTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const id = '11111111-2222-4333-8444-555555555555';
        await backend.saveScript(id, '01_old.sql', 'old');
        backend.calls.length = 0;

        const rename = writer.write(groupScriptRenames(id, '01_old.sql'), {
            type: RENAME_SCRIPT, value: [id, '01_old.sql', '01_new.sql'],
        }, 10_000);
        const write = writer.write(groupScriptWrites(id, '01_new.sql'), {
            type: WRITE_SCRIPT, value: [id, '01_new.sql', 'new'],
        }, 10_000);
        const remove = writer.write(groupScriptDeletes(id, '02_unused.sql'), {
            type: DELETE_SCRIPT, value: [id, '02_unused.sql'],
        }, 10_000);
        await writer.flush();
        await expect(Promise.all([rename, write, remove])).resolves.toEqual([true, true, true]);
        expect(backend.calls).toEqual([
            `rename:${id}/01_old.sql->01_new.sql`,
            `write:${id}/01_new.sql=new`,
            `delete:${id}/02_unused.sql`,
        ]);
        expect(await backend.loadScript(id, '01_new.sql')).toEqual({ name: '01_new.sql', sql: 'new' });
    });

    it('does not overlap mutations of different files in the same notebook', async () => {
        let beginDelete!: () => void;
        let finishDelete!: () => void;
        const deleting = new Promise<void>(resolve => { beginDelete = resolve; });
        const releaseDelete = new Promise<void>(resolve => { finishDelete = resolve; });
        class PausedBackend extends NotebookTestBackend {
            override async deleteScript(notebookId: string, scriptName: string): Promise<void> {
                beginDelete();
                await releaseDelete;
                await super.deleteScript(notebookId, scriptName);
            }
        }
        const backend = new PausedBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const id = '11111111-2222-4333-8444-555555555555';

        const deletion = writer.write(groupScriptDeletes(id, '02_old.sql'), {
            type: DELETE_SCRIPT, value: [id, '02_old.sql'],
        });
        await deleting;
        const write = writer.write(groupScriptWrites(id, '03_new.sql'), {
            type: WRITE_SCRIPT, value: [id, '03_new.sql', 'SELECT 3'],
        }, 10_000);
        const flushing = writer.flush();
        try {
            // Flush has started the next mutation, but it must wait for the first one.
            expect(backend.calls).not.toContain(`write:${id}/03_new.sql=SELECT 3`);
        } finally {
            finishDelete();
        }
        await expect(Promise.all([deletion, write, flushing])).resolves.toEqual([true, true, undefined]);
        expect(backend.calls).toEqual([
            `delete:${id}/02_old.sql`,
            `write:${id}/03_new.sql=SELECT 3`,
        ]);
    });
});
