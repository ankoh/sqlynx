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
    groupSessionScriptListWrites,
    groupSessionWrites,
    REPLACE_SESSION_SCRIPTS,
    WRITE_SESSION_SCRIPTS,
    storageWriteChainKey,
} from './storage_writer.js';
import { ConnectorType, HYPER_CONNECTOR, TRINO_CONNECTOR } from '../connections/connector_info.js';
import { ConnectionHealth, ConnectionStatus, DISCARD_CONNECTION_DRAFT, SET_CONNECTION_DRAFT, reduceConnectionState, type ConnectionState } from '../connections/connection_state.js';
import { CONNECTOR_INFOS } from '../connections/connector_info.js';
import { sessionConnectionFromState } from '../connections/connection_registry.js';
import { testConnections, testSession, TEST_CONNECTION_ID, TEST_SESSION_ID } from './session_test_backend.js';

class NullLogger extends Logger {
    public destroy(): void {}
    protected flushPendingRecords(): void {}
}

describe('V2 storage writer flat mutations', () => {
    it.each(['name-first', 'connection-first'])('retains rename and connection copy in separate debounced tasks (%s)', async order => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const params = { trino: { endpoint: 'committed', catalogName: '', auth: { authType: 'AUTH_BASIC' as const } } };
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession({ ...testConnections({ connectionId: TEST_CONNECTION_ID, params } as any) }));
        for (const endpoint of ['saved', 'saved again']) {
            const saved = { trino: { ...params.trino, endpoint } };
            const name = `renamed before ${endpoint}`;
            const rename = () => writer.write(groupSessionManifestWrites(TEST_SESSION_ID), {
                type: WRITE_SESSION_PROPERTIES, value: [TEST_SESSION_ID, { name, settings: { cacheQueryResults: true } }],
            }, 10_000);
            const connection = () => writer.write(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_CONNECTION_ID), {
                type: PATCH_SESSION_CONNECTION, value: [TEST_SESSION_ID, { connectionId: TEST_CONNECTION_ID, params: saved }],
            }, 10_000);
            const tasks = order === 'name-first' ? [rename(), connection()] : [connection(), rename()];
            expect(writer.getPendingKeysForSession(TEST_SESSION_ID)).toHaveLength(2);
            await writer.flush();
            await expect(Promise.all(tasks)).resolves.toEqual([true, true]);
            const session = await backend.loadSession(TEST_SESSION_ID);
            expect(session.name).toBe(name);
            expect(session.settings).toEqual({ cacheQueryResults: true });
            expect(session.connections).toEqual([{ connectionId: TEST_CONNECTION_ID, params: saved }]);
        }
    });
    it('patches the script list with its connections without losing pending property writes', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const remoteId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        const remote = { connectionId: remoteId, params: { trino: { endpoint: 'remote' } } as any };
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());
        const scripts = [{ name: 'b.sql', connectionId: remoteId }, { name: 'a.sql', connectionId: TEST_CONNECTION_ID }];
        const tasks = [
            writer.write(groupSessionManifestWrites(TEST_SESSION_ID), {
                type: WRITE_SESSION_PROPERTIES, value: [TEST_SESSION_ID, { name: 'renamed', settings: { cacheQueryResults: true } }],
            }, 10_000),
            writer.write(groupSessionScriptListWrites(TEST_SESSION_ID), {
                type: WRITE_SESSION_SCRIPTS, value: [TEST_SESSION_ID, { scripts, connections: [remote] }],
            }, 10_000),
        ];
        await writer.flush();
        await Promise.all(tasks);
        const session = await backend.loadSession(TEST_SESSION_ID);
        expect(session.name).toBe('renamed');
        expect(session.connections).toEqual([testSession().connections[0], remote]);
        expect(session.defaultConnectionId).toBe(TEST_CONNECTION_ID);
        expect(session.scripts).toEqual(scripts);

        // A manifest rewrite keeps the script list and the connections of its scripts
        await writer.write(groupSessionManifestWrites(TEST_SESSION_ID), {
            type: WRITE_SESSION_MANIFEST, value: [TEST_SESSION_ID, TEST_CONNECTION_ID, [testSession().connections[0]]],
        }, 0);
        await writer.flush();
        expect((await backend.loadSession(TEST_SESSION_ID)).scripts).toEqual(scripts);
        expect((await backend.loadSession(TEST_SESSION_ID)).connections).toEqual([testSession().connections[0], remote]);

        // Once no script uses the remote connection, the session drops its copy
        await writer.write(groupSessionScriptListWrites(TEST_SESSION_ID), {
            type: WRITE_SESSION_SCRIPTS, value: [TEST_SESSION_ID, { scripts: [{ name: 'a.sql', connectionId: TEST_CONNECTION_ID }], connections: [] }],
        }, 0);
        await writer.flush();
        expect((await backend.loadSession(TEST_SESSION_ID)).connections).toEqual([testSession().connections[0]]);
    });

    it('keeps the latest script list when the session file is rewritten in between', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());
        const list = (names: string[]) => ({ scripts: names.map(name => ({ name, connectionId: TEST_CONNECTION_ID })), connections: [] });
        // The first list write arms the timer, the rewrite of the session file follows, the latest list
        // supersedes the first one and keeps its earlier timer
        const tasks = [
            writer.write(groupSessionScriptListWrites(TEST_SESSION_ID), { type: WRITE_SESSION_SCRIPTS, value: [TEST_SESSION_ID, list(['a.sql'])] }, 10_000),
            writer.write(groupSessionWrites(TEST_SESSION_ID), {
                type: REPLACE_SESSION_SCRIPTS,
                value: {
                    sessionId: TEST_SESSION_ID, name: null, scripts: [{ fileName: 'a.sql', readText: () => 'SELECT 1' }],
                    defaultConnection: testSession().connections[0], originalFileName: undefined, settings: { cacheQueryResults: false },
                },
            }, 10_000),
            writer.write(groupSessionScriptListWrites(TEST_SESSION_ID), { type: WRITE_SESSION_SCRIPTS, value: [TEST_SESSION_ID, list(['b.sql', 'a.sql'])] }, 10_000),
        ];
        await writer.flush();
        await Promise.all(tasks);
        expect((await backend.loadSession(TEST_SESSION_ID)).scripts).toEqual(list(['b.sql', 'a.sql']).scripts);
    });

    it('writes drafts into the app manifest and never into sessions', async () => {
        const backend = new SessionTestBackend();
        const logger = new NullLogger();
        const writer = new StorageWriter(logger, backend);
        const params = { trino: { endpoint: 'committed', catalogName: '', auth: { authType: 'AUTH_BASIC' as const } } };
        const paramsDraft = { trino: { ...params.trino, endpoint: 'unfinished' } };
        let state = {
            connectionId: TEST_CONNECTION_ID, params,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO],
            connectionHealth: ConnectionHealth.NOT_STARTED, connectionStatus: ConnectionStatus.NOT_STARTED,
            details: { type: TRINO_CONNECTOR, value: { proto: { setupParams: params.trino, setupTimings: {} } } },
        } as ConnectionState;
        for (const discard of [false, true]) {
            state = reduceConnectionState(state, discard
                ? { type: DISCARD_CONNECTION_DRAFT, value: null }
                : { type: SET_CONNECTION_DRAFT, value: paramsDraft }, logger);
            await writer.write(groupConnectionEntryWrites(TEST_CONNECTION_ID), {
                type: WRITE_CONNECTION_ENTRY,
                value: { id: TEST_CONNECTION_ID, params: state.params, ...(state.paramsDraft ? { paramsDraft: state.paramsDraft } : {}) },
            });
            expect(backend.connections).toEqual([{ id: TEST_CONNECTION_ID, params, ...(discard ? {} : { paramsDraft }) }]);
        }
        expect(backend.sessions.size).toBe(0);
    });
    it('persists only committed settings, not drafts, attempted params or OAuth runtime state', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const sessionId = '11111111-2222-4333-8444-555555555555';
        const connectionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const state = {
            connectionId,
            params: { trino: { endpoint: 'committed' } },
            paramsDraft: { trino: { endpoint: '' } },
            details: { type: TRINO_CONNECTOR, value: { proto: {
                setupParams: { endpoint: 'attempted' },
                oauthState: { accessToken: { accessToken: 'runtime-secret' } },
            } } },
        } as unknown as ConnectionState;
        await writer.write(sessionId, { type: WRITE_SESSION_MANIFEST, value: [sessionId, connectionId, [sessionConnectionFromState(state)]] });
        const saved = await backend.loadSession(sessionId);
        expect(saved.connections).toEqual([{ connectionId, params: state.params }]);
        expect(JSON.stringify(saved)).not.toContain('runtime-secret');
    });
    it('round-trips local and remote connections with an explicit default connection', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const sessionId = '11111111-2222-4333-8444-555555555555';
        const state = (connectionId: string, connectorType: ConnectorType, setupParams: object) => ({
            connectionId,
            connectorInfo: { connectorType },
            params: connectorType === ConnectorType.HYPER ? { hyper: setupParams } : { trino: setupParams },
            details: connectorType === ConnectorType.HYPER
                ? { type: HYPER_CONNECTOR, value: { proto: { setupParams } } }
                : { type: TRINO_CONNECTOR, value: { proto: { setupParams } } },
        }) as unknown as ConnectionState;
        // A script of the session runs on the local connection
        backend.sessions.set(sessionId, testSession({ scripts: [{ name: 'local.sql', connectionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }] }));

        await writer.write(sessionId, {
            type: WRITE_SESSION_MANIFEST,
            value: [sessionId, 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb', [
                state('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ConnectorType.HYPER, { protocol: 'WASM' }),
                state('ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb', ConnectorType.TRINO, { endpoint: 'https://trino.example' }),
            ].map(sessionConnectionFromState)],
        });

        // The default connection comes first, then the connections of the scripts
        expect((await backend.loadSession(sessionId)).connections).toEqual([
            { connectionId: 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb', params: { trino: { endpoint: 'https://trino.example' } } },
            { connectionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', params: { hyper: { protocol: 'WASM' } } },
        ]);
        expect((await backend.loadSession(sessionId)).defaultConnectionId).toBe('ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb');
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
        expect(storageWriteChainKey(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_CONNECTION_ID))).toBe(TEST_SESSION_ID);
        expect(storageWriteChainKey(groupConnectionEntryWrites(TEST_CONNECTION_ID))).toBe('@manifest');
        expect(storageWriteChainKey(`@connections/${TEST_CONNECTION_ID}/dashql-catalog-relations.sql`)).toBe(`@connections/${TEST_CONNECTION_ID}`);
    });

    it('writes durably without debouncing and defers while paused', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const params = (endpoint: string) => ({ trino: { endpoint } }) as any;
        const debounced = writer.write(groupConnectionEntryWrites(TEST_CONNECTION_ID), {
            type: WRITE_CONNECTION_ENTRY, value: { id: TEST_CONNECTION_ID, params: params('draft') },
        }, 10_000);
        await expect(writer.writeDurable(groupConnectionEntryWrites(TEST_CONNECTION_ID), {
            type: WRITE_CONNECTION_ENTRY, value: { id: TEST_CONNECTION_ID, params: params('saved') },
        })).resolves.toEqual({ status: 'written' });
        await expect(debounced).resolves.toBe(false);
        expect(backend.connections).toEqual([{ id: TEST_CONNECTION_ID, params: params('saved') }]);

        writer.pause();
        await expect(writer.writeDurable(groupConnectionEntryWrites(TEST_CONNECTION_ID), {
            type: WRITE_CONNECTION_ENTRY, value: { id: TEST_CONNECTION_ID, params: params('paused') },
        })).resolves.toEqual({ status: 'deferred' });
        expect(backend.connections).toEqual([{ id: TEST_CONNECTION_ID, params: params('saved') }]);
        writer.resume();
        await writer.flush();
        expect(backend.connections).toEqual([{ id: TEST_CONNECTION_ID, params: params('paused') }]);
    });

    it('reports failed writes and never recreates a missing session', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const result = await writer.writeDurable(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_CONNECTION_ID), {
            type: PATCH_SESSION_CONNECTION, value: [TEST_SESSION_ID, { connectionId: TEST_CONNECTION_ID, params: { trino: { endpoint: 'x' } } as any }],
        });
        expect(result.status).toBe('failed');
        expect(result.status === 'failed' && result.error).toBeInstanceOf(SessionUnavailableError);
        expect(backend.sessions.size).toBe(0);
    });

    it('drops pending and later writes of a deleted session', async () => {
        const backend = new SessionTestBackend();
        backend.sessions.set(TEST_SESSION_ID, testSession());
        const writer = new StorageWriter(new NullLogger(), backend);
        const pending = writer.write(groupScriptWrites(TEST_SESSION_ID, 'a.sql'), { type: WRITE_SCRIPT, value: [TEST_SESSION_ID, 'a.sql', 'select 1'] }, 1000);
        await writer.deleteSession(TEST_SESSION_ID);
        expect(await pending).toBe(false);
        expect(await writer.write(groupScriptWrites(TEST_SESSION_ID, 'b.sql'), { type: WRITE_SCRIPT, value: [TEST_SESSION_ID, 'b.sql', 'select 2'] })).toBe(false);
        await writer.flush();
        expect(backend.sessions.has(TEST_SESSION_ID)).toBe(false);
        expect(backend.calls.filter(call => call.startsWith('write:'))).toEqual([]);
    });

    it('patches the copies of a connection and resolves aliases', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const alias = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        const old = { trino: { endpoint: 'old' } } as any;
        const next = { trino: { endpoint: 'new' } } as any;
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession({
            ...testConnections({ connectionId: TEST_CONNECTION_ID, params: old, paramsDraft: old } as any, { connectionId: alias, params: old }),
        }));
        backend.calls.length = 0;
        const result = await writer.writeDurable(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_CONNECTION_ID), {
            type: PATCH_SESSION_CONNECTION, value: [TEST_SESSION_ID, { connectionId: TEST_CONNECTION_ID, params: next }, [alias]],
        });
        expect(result).toEqual({ status: 'written' });
        const session = await backend.loadSession(TEST_SESSION_ID);
        expect(session.connections).toEqual([{ connectionId: TEST_CONNECTION_ID, params: next }]);
        expect(session.defaultConnectionId).toBe(TEST_CONNECTION_ID);
        // An up-to-date copy is not written again
        await writer.writeDurable(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_CONNECTION_ID), {
            type: PATCH_SESSION_CONNECTION, value: [TEST_SESSION_ID, { connectionId: TEST_CONNECTION_ID, params: next }],
        });
        expect(backend.calls).toEqual([`manifest:${TEST_SESSION_ID}`]);
    });

    it('patches the name of a connection into its copies', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        const params = { trino: { endpoint: 'x' } } as any;
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession({
            ...testConnections({ connectionId: TEST_CONNECTION_ID, params }),
        }));
        await writer.writeDurable(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_CONNECTION_ID), {
            type: PATCH_SESSION_CONNECTION, value: [TEST_SESSION_ID, { connectionId: TEST_CONNECTION_ID, name: 'Production', params }],
        });
        expect((await backend.loadSession(TEST_SESSION_ID)).connections).toEqual([{ connectionId: TEST_CONNECTION_ID, name: 'Production', params }]);
        // Removing the name removes it from the copy
        await writer.writeDurable(groupSessionConnectionCopyWrites(TEST_SESSION_ID, TEST_CONNECTION_ID), {
            type: PATCH_SESSION_CONNECTION, value: [TEST_SESSION_ID, { connectionId: TEST_CONNECTION_ID, params }],
        });
        expect((await backend.loadSession(TEST_SESSION_ID)).connections).toEqual([{ connectionId: TEST_CONNECTION_ID, params }]);
    });

    it('keeps the creation time and aliases of connection entries', async () => {
        const backend = new SessionTestBackend();
        const writer = new StorageWriter(new NullLogger(), backend);
        backend.connections = [{ id: TEST_CONNECTION_ID, params: { trino: { endpoint: 'a' } } as any, aliases: ['x'], createdAt: '2026-01-01T00:00:00.000Z' }];
        await writer.writeDurable(groupConnectionEntryWrites(TEST_CONNECTION_ID), {
            type: WRITE_CONNECTION_ENTRY, value: { id: TEST_CONNECTION_ID, params: { trino: { endpoint: 'b' } } as any },
        });
        expect(backend.connections).toEqual([{ id: TEST_CONNECTION_ID, params: { trino: { endpoint: 'b' } }, aliases: ['x'], createdAt: '2026-01-01T00:00:00.000Z' }]);
    });
});
