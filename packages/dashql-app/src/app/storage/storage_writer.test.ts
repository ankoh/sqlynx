import { describe, expect, it } from 'vitest';

import { Logger } from '../../platform/logger/logger.js';
import { SessionTestBackend } from './session_test_backend.js';
import {
    DELETE_SCRIPT,
    groupScriptDeletes,
    groupScriptRenames,
    groupScriptWrites,
    RENAME_SCRIPT,
    StorageWriter,
    WRITE_SESSION_MANIFEST,
    WRITE_SCRIPT,
    WRITE_SESSION_PROPERTIES,
    WRITE_CONNECTION_ENTRY,
    PATCH_SESSION_CONNECTION,
    SessionUnavailableError,
    groupConnectionEntryWrites,
    groupSessionConnectionCopyWrites,
    groupSessionManifestWrites,
    storageWriteChainKey,
} from './storage_writer.js';
import { ConnectorType, HYPER_CONNECTOR, TRINO_CONNECTOR } from '../session/connections/connector_info.js';
import { ConnectionHealth, ConnectionStatus, DISCARD_CONNECTION_DRAFT, SET_CONNECTION_DRAFT, reduceAttachedDatabaseState, type AttachedDatabaseState } from '../session/connections/attached_database_state.js';
import { CONNECTOR_INFOS } from '../session/connections/connector_info.js';
import { testSession, TEST_DATABASE_ID, TEST_SESSION_ID } from './session_test_backend.js';

class NullLogger extends Logger {
    public destroy(): void {}
    protected flushPendingRecords(): void {}
}

describe('V2 storage writer flat mutations', () => {
    it.each(['name-first', 'connection-first'])('retains rename and connection copy in separate debounced tasks (%s)', async order => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const params = { trino: { endpoint: 'committed', catalogName: '', auth: { authType: 'AUTH_BASIC' as const } } };
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession({ mainDatabase: { databaseId: TEST_DATABASE_ID, params } }));
        for (const endpoint of ['saved', 'saved again']) {
            const saved = { trino: { ...params.trino, endpoint } };
            const name = `renamed before ${endpoint}`;
            const rename = () => writer.write(groupSessionManifestWrites(TEST_SESSION_ID), {
                type: WRITE_SESSION_PROPERTIES, value: [TEST_SESSION_ID, { name, settings: { cacheQueryResults: true } }],
            }, 10_000);
            const connection = () => writer.write(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_DATABASE_ID), {
                type: PATCH_SESSION_CONNECTION, value: [TEST_SESSION_ID, TEST_DATABASE_ID, saved],
            }, 10_000);
            const tasks = order === 'name-first' ? [rename(), connection()] : [connection(), rename()];
            expect(writer.getPendingKeysForSession(TEST_SESSION_ID)).toHaveLength(2);
            await writer.flush();
            await expect(Promise.all(tasks)).resolves.toEqual([true, true]);
            const session = await backend.loadSession(TEST_SESSION_ID);
            expect(session.name).toBe(name);
            expect(session.settings).toEqual({ cacheQueryResults: true });
            expect(session.mainDatabase).toEqual({ databaseId: TEST_DATABASE_ID, params: saved });
        }
    });
    it('writes drafts into the app manifest and never into sessions', async () => {
        const backend = new SessionTestBackend();
        const logger = new NullLogger();
        const writer = new StorageWriter(logger, backend);
        const params = { trino: { endpoint: 'committed', catalogName: '', auth: { authType: 'AUTH_BASIC' as const } } };
        const paramsDraft = { trino: { ...params.trino, endpoint: 'unfinished' } };
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
            await writer.write(groupConnectionEntryWrites(TEST_DATABASE_ID), {
                type: WRITE_CONNECTION_ENTRY,
                value: { id: TEST_DATABASE_ID, params: state.params, ...(state.paramsDraft ? { paramsDraft: state.paramsDraft } : {}) },
            });
            expect(backend.connections).toEqual([{ id: TEST_DATABASE_ID, params, ...(discard ? {} : { paramsDraft }) }]);
        }
        expect(backend.sessions.size).toBe(0);
    });
    it('persists only committed settings, not drafts, attempted params or OAuth runtime state', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const sessionId = '11111111-2222-4333-8444-555555555555';
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
        await writer.write(sessionId, { type: WRITE_SESSION_MANIFEST, value: [sessionId, databaseId, [state]] });
        const saved = await backend.loadSession(sessionId);
        expect(saved.mainDatabase).toEqual({ databaseId, params: state.params });
        expect(JSON.stringify(saved)).not.toContain('runtime-secret');
    });
    it('round-trips local and remote attached databases with an explicit main database', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const sessionId = '11111111-2222-4333-8444-555555555555';
        const state = (databaseId: string, connectorType: ConnectorType, setupParams: object) => ({
            databaseId,
            connectorInfo: { connectorType },
            params: connectorType === ConnectorType.HYPER ? { hyper: setupParams } : { trino: setupParams },
            details: connectorType === ConnectorType.HYPER
                ? { type: HYPER_CONNECTOR, value: { proto: { setupParams } } }
                : { type: TRINO_CONNECTOR, value: { proto: { setupParams } } },
        }) as unknown as AttachedDatabaseState;

        await writer.write(sessionId, {
            type: WRITE_SESSION_MANIFEST,
            value: [sessionId, 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb', [
                state('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ConnectorType.HYPER, { protocol: 'WASM' }),
                state('ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb', ConnectorType.TRINO, { endpoint: 'https://trino.example' }),
            ]],
        });

        expect((await backend.loadSession(sessionId)).attachedDatabases).toEqual([
            { databaseId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', params: { hyper: { protocol: 'WASM' } } },
        ]);
        expect((await backend.loadSession(sessionId)).mainDatabase.databaseId).toBe('ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb');
    });

    it('keeps rename, write, and delete in distinct ordered keyspaces', async () => {
        const backend = new SessionTestBackend();
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

    it('does not overlap mutations of different files in the same session', async () => {
        let beginDelete!: () => void;
        let finishDelete!: () => void;
        const deleting = new Promise<void>(resolve => { beginDelete = resolve; });
        const releaseDelete = new Promise<void>(resolve => { finishDelete = resolve; });
        class PausedBackend extends SessionTestBackend {
            override async deleteScript(sessionId: string, scriptName: string): Promise<void> {
                beginDelete();
                await releaseDelete;
                await super.deleteScript(sessionId, scriptName);
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

describe('storage writer outcomes', () => {
    it('chains global keys per entity and session keys per session', () => {
        expect(storageWriteChainKey(`${TEST_SESSION_ID}/scripts/01.sql`)).toBe(TEST_SESSION_ID);
        expect(storageWriteChainKey(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_DATABASE_ID))).toBe(TEST_SESSION_ID);
        expect(storageWriteChainKey(groupConnectionEntryWrites(TEST_DATABASE_ID))).toBe('@manifest');
        expect(storageWriteChainKey(`@connections/${TEST_DATABASE_ID}/dashql-catalog-relations.sql`)).toBe(`@connections/${TEST_DATABASE_ID}`);
    });

    it('writes durably without debouncing and defers while paused', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const params = (endpoint: string) => ({ trino: { endpoint } }) as any;
        const debounced = writer.write(groupConnectionEntryWrites(TEST_DATABASE_ID), {
            type: WRITE_CONNECTION_ENTRY, value: { id: TEST_DATABASE_ID, params: params('draft') },
        }, 10_000);
        await expect(writer.writeDurable(groupConnectionEntryWrites(TEST_DATABASE_ID), {
            type: WRITE_CONNECTION_ENTRY, value: { id: TEST_DATABASE_ID, params: params('saved') },
        })).resolves.toEqual({ status: 'written' });
        await expect(debounced).resolves.toBe(false);
        expect(backend.connections).toEqual([{ id: TEST_DATABASE_ID, params: params('saved') }]);

        writer.pause();
        await expect(writer.writeDurable(groupConnectionEntryWrites(TEST_DATABASE_ID), {
            type: WRITE_CONNECTION_ENTRY, value: { id: TEST_DATABASE_ID, params: params('paused') },
        })).resolves.toEqual({ status: 'deferred' });
        expect(backend.connections).toEqual([{ id: TEST_DATABASE_ID, params: params('saved') }]);
        writer.resume();
        await writer.flush();
        expect(backend.connections).toEqual([{ id: TEST_DATABASE_ID, params: params('paused') }]);
    });

    it('reports failed writes and never recreates a missing session', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const result = await writer.writeDurable(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_DATABASE_ID), {
            type: PATCH_SESSION_CONNECTION, value: [TEST_SESSION_ID, TEST_DATABASE_ID, { trino: { endpoint: 'x' } } as any],
        });
        expect(result.status).toBe('failed');
        expect(result.status === 'failed' && result.error).toBeInstanceOf(SessionUnavailableError);
        expect(backend.sessions.size).toBe(0);
    });

    it('patches the copies of a connection and resolves aliases', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const alias = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        const old = { trino: { endpoint: 'old' } } as any;
        const next = { trino: { endpoint: 'new' } } as any;
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession({
            mainDatabase: { databaseId: TEST_DATABASE_ID, params: old, paramsDraft: old },
            attachedDatabases: [{ databaseId: alias, params: old }],
        }));
        backend.calls.length = 0;
        const result = await writer.writeDurable(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_DATABASE_ID), {
            type: PATCH_SESSION_CONNECTION, value: [TEST_SESSION_ID, TEST_DATABASE_ID, next, [alias]],
        });
        expect(result).toEqual({ status: 'written' });
        const session = await backend.loadSession(TEST_SESSION_ID);
        expect(session.mainDatabase).toEqual({ databaseId: TEST_DATABASE_ID, params: next });
        expect(session.attachedDatabases).toEqual([]);
        // An up-to-date copy is not written again
        await writer.writeDurable(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_DATABASE_ID), {
            type: PATCH_SESSION_CONNECTION, value: [TEST_SESSION_ID, TEST_DATABASE_ID, next],
        });
        expect(backend.calls).toEqual([`manifest:${TEST_SESSION_ID}`]);
    });

    it('keeps the creation time and aliases of connection entries', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        backend.connections = [{ id: TEST_DATABASE_ID, params: { trino: { endpoint: 'a' } } as any, aliases: ['x'], createdAt: '2026-01-01T00:00:00.000Z' }];
        await writer.writeDurable(groupConnectionEntryWrites(TEST_DATABASE_ID), {
            type: WRITE_CONNECTION_ENTRY, value: { id: TEST_DATABASE_ID, params: { trino: { endpoint: 'b' } } as any },
        });
        expect(backend.connections).toEqual([{ id: TEST_DATABASE_ID, params: { trino: { endpoint: 'b' } }, aliases: ['x'], createdAt: '2026-01-01T00:00:00.000Z' }]);
    });
});
