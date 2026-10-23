import * as core from '@ankoh/dashql-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Logger } from '../../../platform/logger/logger.js';
import { TestLogger } from '../../../platform/logger/test_logger.js';
import { findSessionsForConnection, syncSessionConnections, type ConnectionRegistry } from '../../connections/connection_registry.js';
import { ConnectorType } from '../../connections/connector_info.js';
import { CompositeStorageBackend } from '../../storage/composite_storage_backend.js';
import { writePortableSessionFresh } from '../../storage/session_import_transaction.js';
import { SessionTestBackend } from '../../storage/session_test_backend.js';
import type { ConnectionEntry, SessionData, SessionEntry, SessionRegistryBackend } from '../../storage/storage_backend.js';
import { StorageBackendType } from '../../storage/storage_backend.js';
import { StorageWriter } from '../../storage/storage_writer.js';
import { makeFsMock, resetFsStore } from '../../storage/test_fs_mock.js';
import { SESSION_FORMAT_VERSION } from '../../../migration/versions.js';
import { ANALYZE_OUTDATED_SCRIPT, analyzeScriptData, reduceSessionScripts, REORDER_SCRIPTS, scriptConnectionOf, sessionConnectionIds, SET_SCRIPT_CONNECTION, type SessionScripts } from '../scripts/session_scripts.js';
import { restoreAppState, type RestoredAppState } from './app_state_loader.js';
import { applyConnectionImportPlan, planConnectionImport, type ConnectionImportChoice } from './session_connection_import.js';
import { exportSessionAsSharedZip } from './session_export.js';
import { readSessionBundleFromZip } from './session_import.js';
import { readStoredSessionScripts } from './native_session_sync_react.js';
import { sessionScriptsResolutionChanged } from './session_script_connections.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

/// Integration tests for the connections of a session.
///
/// A script names its connection in the session file, the app resolves it to a connection of the
/// registry and analyzes the script in the catalog of that connection. These tests drive the real
/// core, the storage writer and the loader through the round trips that touch that mapping:
/// restoring, changing the connection of a script, reloading, exporting and importing.

class NullLogger extends Logger {
    public destroy(): void {}
    protected flushPendingRecords(): void {}
}

/// A storage backend that owns a session registry, the backend of the composite storage
class Registry extends SessionTestBackend implements SessionRegistryBackend {
    manifest: SessionEntry[] = [];
    override async listSessions(): Promise<SessionEntry[]> { return [...this.manifest]; }
    override async saveSessionManifest(id: string, data: SessionData): Promise<void> {
        await super.saveSessionManifest(id, data);
        await this.upsertSessionEntry({ path: id, storageType: StorageBackendType.OPFS });
    }
    async upsertSessionEntry(entry: SessionEntry): Promise<void> {
        const index = this.manifest.findIndex(value => value.path === entry.path);
        if (index < 0) this.manifest.push(entry); else this.manifest[index] = entry;
    }
    async removeSessionEntry(id: string): Promise<void> { this.manifest = this.manifest.filter(entry => entry.path !== id); }
    async reorderSessions(ids: string[]): Promise<void> {
        const byId = new Map(this.manifest.map(entry => [entry.path, entry]));
        this.manifest = ids.flatMap(id => byId.get(id) ?? []).concat(this.manifest.filter(entry => !ids.includes(entry.path)));
    }
    async deleteSessionFiles(id: string): Promise<void> { await super.deleteSession(id); }
}

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const IMPORTED_SESSION_ID = '22222222-3333-4444-8555-666666666666';
/// The default connection of the session
const HYPER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HYPER_PARAMS = { hyper: {} } as SessionData['connections'][number]['params'];
/// A second connection of the session
const TRINO_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const TRINO_PARAMS = { trino: { endpoint: 'https://trino.example' } } as SessionData['connections'][number]['params'];

/// A script of a seeded session: file name, connection id and text
type SeedScript = [string, string, string];

/// Store a session with the hyper connection as default connection and both connections in the manifest
async function seedSession(backend: SessionTestBackend, scripts: SeedScript[], connectionIds: string[] = [HYPER_ID, TRINO_ID]): Promise<void> {
    const params = new Map([[HYPER_ID, HYPER_PARAMS], [TRINO_ID, TRINO_PARAMS]]);
    backend.connections = [HYPER_ID, TRINO_ID].map(id => ({ id, params: params.get(id)! } as ConnectionEntry));
    await backend.saveSessionManifest(SESSION_ID, {
        formatVersion: SESSION_FORMAT_VERSION,
        sessionId: SESSION_ID,
        name: 'Connections',
        defaultConnectionId: HYPER_ID,
        connections: connectionIds.map(connectionId => ({ connectionId, params: params.get(connectionId)! })),
        scripts: scripts.map(([name, connectionId]) => ({ name, connectionId })),
        attachments: [],
        metadata: {},
    });
    for (const [name, , sql] of scripts) {
        await backend.saveScript(SESSION_ID, name, sql);
    }
}

describe('Session connections', () => {
    let dql: core.DashQL;
    const logger = new NullLogger();

    beforeAll(async () => { dql = await core.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED }); });
    afterEach(() => { dql.resetUnsafe(); });

    const restore = (backend: SessionTestBackend | CompositeStorageBackend) => restoreAppState(dql, backend, logger, () => {});

    /// The restored scripts of the session
    const sessionOf = (restored: RestoredAppState, sessionId: string = SESSION_ID): SessionScripts => {
        const session = restored.sessionScripts.get(sessionId);
        if (session == null) throw new Error(`Session ${sessionId} was not restored`);
        return session;
    };
    const scriptOf = (session: SessionScripts, fileName: string) => session.scripts[session.scriptRefs[fileName].scriptId];

    /// Load every script into the catalog of its connection like a session run does and return the
    /// number of table references of a script that its catalog does not resolve
    const unresolvedReferences = (session: SessionScripts, fileName: string): number => {
        for (const name of session.scriptOrder) analyzeScriptData(scriptOf(session, name), logger);
        const script = scriptOf(session, fileName);
        script.scriptSession.analyze();
        return dql.plan([script.scriptSession]).unpackAndDestroy().unresolvedReferences.length;
    };

    /// Run a script on another connection the way the connection picker of the feed does
    const pickConnection = (session: SessionScripts, restored: RestoredAppState, writer: StorageWriter, fileName: string, connectionId: string): SessionScripts =>
        reduceSessionScripts(session, {
            type: SET_SCRIPT_CONNECTION,
            value: { fileName, connection: scriptConnectionOf(restored.connectionStates.get(connectionId)!) },
        }, writer, logger);

    /// The connection registry of a restored app state
    const connectionRegistryOf = (restored: RestoredAppState): ConnectionRegistry => ({
        connections: restored.connectionStates,
        attachedDatabasesBySession: restored.attachedDatabasesBySession,
        connectionsByType: restored.connectionStatesByType,
    });

    describe('restoring', () => {
        it('analyzes every script in the catalog of its own connection', async () => {
            const backend = new SessionTestBackend();
            await seedSession(backend, [
                ['define.sql', HYPER_ID, 'create table items (id int)'],
                ['remote.sql', TRINO_ID, 'select id from items'],
                ['local.sql', HYPER_ID, 'select id from items'],
            ]);
            const restored = await restore(backend);
            const session = sessionOf(restored);

            expect(session.scriptOrder).toEqual(['define.sql', 'remote.sql', 'local.sql']);
            expect(scriptOf(session, 'remote.sql').connection.catalog).toBe(restored.connectionStates.get(TRINO_ID)!.catalog);
            expect(scriptOf(session, 'local.sql').connection.catalog).toBe(restored.connectionStates.get(HYPER_ID)!.catalog);
            // Only the scripts of the same connection see the table
            expect(unresolvedReferences(session, 'local.sql')).toBe(0);
            expect(unresolvedReferences(session, 'remote.sql')).toBe(1);
            expect(restored.sessionScriptsByConnection.get(TRINO_ID)).toEqual([SESSION_ID]);
        });

        it('attaches a known connection that a script uses but the session file misses', async () => {
            const backend = new SessionTestBackend();
            await seedSession(backend, [['remote.sql', TRINO_ID, 'select 1']], [HYPER_ID]);
            const restored = await restore(backend);

            expect(scriptOf(sessionOf(restored), 'remote.sql').connection.connectionId).toBe(TRINO_ID);
            expect(backend.sessions.get(SESSION_ID)!.connections.map(connection => connection.connectionId)).toEqual([HYPER_ID, TRINO_ID]);
        });

        it('registers a connection that only the session file knows', async () => {
            const backend = new SessionTestBackend();
            await seedSession(backend, [['remote.sql', TRINO_ID, 'select 1']]);
            backend.connections = backend.connections!.filter(entry => entry.id !== TRINO_ID);
            const restored = await restore(backend);

            expect(scriptOf(sessionOf(restored), 'remote.sql').connection.connectionId).toBe(TRINO_ID);
            expect(restored.connectionStates.get(TRINO_ID)?.connectorInfo.connectorType).toBe(ConnectorType.TRINO);
            expect(backend.connections!.map(entry => entry.id)).toEqual([HYPER_ID, TRINO_ID]);
        });

        it('drops the copies of connections that no script uses', async () => {
            const backend = new SessionTestBackend();
            await seedSession(backend, [['query.sql', HYPER_ID, 'select 1']]);
            const restored = await restore(backend);

            expect(restored.attachedDatabasesBySession.get(SESSION_ID)).toEqual({ mainDatabaseId: HYPER_ID, attachedDatabaseIds: [] });
            expect(backend.sessions.get(SESSION_ID)!.connections.map(connection => connection.connectionId)).toEqual([HYPER_ID]);
            // The connection itself stays a connection of the app
            expect(restored.connectionStates.has(TRINO_ID)).toBe(true);
        });
    });

    describe('changing the connection of a script', () => {
        it('moves the script between catalogs and keeps it there across a reload', async () => {
            const backend = new SessionTestBackend();
            await seedSession(backend, [
                ['define.sql', HYPER_ID, 'create table items (id int)'],
                ['query.sql', TRINO_ID, 'select id from items'],
            ], [HYPER_ID]);
            // The session file misses the trino connection, the loader attaches it
            let restored = await restore(backend);
            let session = sessionOf(restored);
            expect(unresolvedReferences(session, 'query.sql')).toBe(1);

            const writer = new StorageWriter(logger, backend);
            const moved = scriptOf(session, 'query.sql').scriptKey;
            session = pickConnection(session, restored, writer, 'query.sql', HYPER_ID);
            // The script keeps its key and now resolves the table of its new catalog
            expect(scriptOf(session, 'query.sql').scriptKey).toBe(moved);
            expect(scriptOf(session, 'query.sql').connection.connectionId).toBe(HYPER_ID);
            expect(unresolvedReferences(session, 'query.sql')).toBe(0);
            await writer.flush();
            expect(backend.sessions.get(SESSION_ID)!.scripts).toEqual([
                { name: 'define.sql', connectionId: HYPER_ID },
                { name: 'query.sql', connectionId: HYPER_ID },
            ]);

            restored = await restore(backend);
            session = sessionOf(restored);
            expect(scriptOf(session, 'query.sql').connection.connectionId).toBe(HYPER_ID);
            expect(unresolvedReferences(session, 'query.sql')).toBe(0);
        });

        it('takes the declarations of a moved script out of the catalog it leaves', async () => {
            const backend = new SessionTestBackend();
            await seedSession(backend, [
                ['define.sql', HYPER_ID, 'create table items (id int)'],
                ['local.sql', HYPER_ID, 'select id from items'],
                ['remote.sql', TRINO_ID, 'select id from items'],
            ]);
            const restored = await restore(backend);
            let session = sessionOf(restored);
            const writer = new StorageWriter(logger, backend);
            for (const name of session.scriptOrder) {
                session = reduceSessionScripts(session, { type: ANALYZE_OUTDATED_SCRIPT, value: scriptOf(session, name).scriptKey }, writer, logger);
            }
            expect(unresolvedReferences(session, 'local.sql')).toBe(0);
            expect(scriptOf(session, 'local.sql').analysisOutdated).toBe(false);
            expect(scriptOf(session, 'remote.sql').analysisOutdated).toBe(false);

            session = pickConnection(session, restored, writer, 'define.sql', TRINO_ID);
            expect(scriptOf(session, 'local.sql').analysisOutdated).toBe(true);
            expect(scriptOf(session, 'remote.sql').analysisOutdated).toBe(true);
            expect(unresolvedReferences(session, 'local.sql')).toBe(1);
            expect(unresolvedReferences(session, 'remote.sql')).toBe(0);
            await writer.flush();
        });

        it('attaches a newly picked connection to the session file before the scripts reference it', async () => {
            const backend = new SessionTestBackend();
            await seedSession(backend, [['query.sql', HYPER_ID, 'select 1']], [HYPER_ID]);
            const restored = await restore(backend);
            const writer = new StorageWriter(logger, backend);
            pickConnection(sessionOf(restored), restored, writer, 'query.sql', TRINO_ID);
            await writer.flush();

            const stored = backend.sessions.get(SESSION_ID)!;
            expect(stored.connections).toEqual([
                { connectionId: HYPER_ID, params: HYPER_PARAMS },
                { connectionId: TRINO_ID, params: TRINO_PARAMS },
            ]);
            expect(stored.scripts).toEqual([{ name: 'query.sql', connectionId: TRINO_ID }]);
        });

        it('keeps the reference to a connection that the app can not resolve', async () => {
            const backend = new SessionTestBackend();
            const unknownId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
            // A hand-edited session file names a connection without a copy
            await seedSession(backend, [['query.sql', unknownId, 'select 1'], ['other.sql', HYPER_ID, 'select 2']], [HYPER_ID]);
            const restored = await restore(backend);
            let session = sessionOf(restored);
            const query = scriptOf(session, 'query.sql');
            expect(query.connection.connectionId).toBe(HYPER_ID);
            expect(query.unresolvedConnectionId).toBe(unknownId);
            expect(backend.sessions.get(SESSION_ID)!.scripts[0]).toEqual({ name: 'query.sql', connectionId: unknownId });

            // Other changes of the script list keep the reference
            const writer = new StorageWriter(logger, backend);
            session = reduceSessionScripts(session, { type: REORDER_SCRIPTS, value: ['other.sql', 'query.sql'] }, writer, logger);
            await writer.flush();
            expect(backend.sessions.get(SESSION_ID)!.scripts).toEqual([
                { name: 'other.sql', connectionId: HYPER_ID },
                { name: 'query.sql', connectionId: unknownId },
            ]);
            expect(backend.sessions.get(SESSION_ID)!.connections.map(connection => connection.connectionId)).toEqual([HYPER_ID]);

            // Picking a connection replaces it
            pickConnection(session, restored, writer, 'query.sql', TRINO_ID);
            await writer.flush();
            expect(backend.sessions.get(SESSION_ID)!.scripts[1]).toEqual({ name: 'query.sql', connectionId: TRINO_ID });
        });

        it('releases a connection after its last script moved away', async () => {
            const backend = new SessionTestBackend();
            await seedSession(backend, [['query.sql', TRINO_ID, 'select 1']]);
            let restored = await restore(backend);
            let registry = connectionRegistryOf(restored);
            expect(findSessionsForConnection(registry, TRINO_ID)).toEqual([SESSION_ID]);

            const writer = new StorageWriter(logger, backend);
            const session = pickConnection(sessionOf(restored), restored, writer, 'query.sql', HYPER_ID);
            // The connection registry follows the scripts right away
            registry = syncSessionConnections(registry, new Map([[SESSION_ID, sessionConnectionIds(session)]]));
            expect(findSessionsForConnection(registry, TRINO_ID)).toEqual([]);
            await writer.flush();
            expect(backend.sessions.get(SESSION_ID)!.connections.map(connection => connection.connectionId)).toEqual([HYPER_ID]);

            restored = await restore(backend);
            expect(findSessionsForConnection(connectionRegistryOf(restored), TRINO_ID)).toEqual([]);
        });
    });

    describe('reloading a native folder', () => {
        it('keeps a script on a connection that a pulled session file brings along', async () => {
            const backend = new SessionTestBackend();
            await seedSession(backend, [['query.sql', HYPER_ID, 'select 1']]);
            backend.connections = backend.connections!.filter(entry => entry.id !== TRINO_ID);
            const restored = await restore(backend);
            expect(restored.connectionStates.has(TRINO_ID)).toBe(false);

            // A pull adds a script on a connection that the app doesn't know
            const pulled: SessionData = {
                ...backend.sessions.get(SESSION_ID)!,
                connections: [{ connectionId: HYPER_ID, params: HYPER_PARAMS }, { connectionId: TRINO_ID, params: TRINO_PARAMS }],
                scripts: [{ name: 'query.sql', connectionId: HYPER_ID }, { name: 'remote.sql', connectionId: TRINO_ID }],
            };
            const stored = readStoredSessionScripts(connectionRegistryOf(restored), SESSION_ID, pulled, [
                { name: 'query.sql', sql: 'select 1' },
                { name: 'remote.sql', sql: 'select 2' },
            ])!;
            expect(stored.created.map(connection => connection.connectionId)).toEqual([TRINO_ID]);
            expect(stored.snapshot.scripts.map(script => [script.name, script.connection.connectionId])).toEqual([
                ['query.sql', HYPER_ID],
                ['remote.sql', TRINO_ID],
            ]);
            // The session file stays as it was pulled
            expect(sessionScriptsResolutionChanged(pulled, stored.session)).toBe(false);
        });
    });

    describe('sharing', () => {
        let registry: Registry;
        let backend: CompositeStorageBackend;

        beforeEach(async () => {
            resetFsStore();
            globalThis.dashqlElectron = { fs: makeFsMock() } as unknown as DashQLElectronBridge;
            registry = new Registry();
            backend = new CompositeStorageBackend(registry, new TestLogger());
            await backend.initialize();
            await seedSession(registry, [
                ['define.sql', HYPER_ID, 'create table items (id int)'],
                ['remote.sql', TRINO_ID, 'select 42'],
            ]);
            await backend.refreshLocations();
        });

        afterEach(() => {
            delete globalThis.dashqlElectron;
        });

        /// Export the seeded session the way the share dialog does and read it back like an import
        const exportAndRead = async () => readSessionBundleFromZip(await exportSessionAsSharedZip(backend, SESSION_ID, new Map()));

        it('gives the connections fresh ids and keeps every script on its connection', async () => {
            const bundle = await exportAndRead();
            const { session } = bundle;
            expect(session.sessionId).not.toBe(SESSION_ID);
            const ids = session.connections.map(connection => connection.connectionId);
            expect(ids).not.toContain(HYPER_ID);
            expect(ids).not.toContain(TRINO_ID);
            // The connector of the connection a script references, the export normalizes the params
            const connectorOf = (connectionId: string) => Object.keys(session.connections.find(connection => connection.connectionId === connectionId)?.params ?? {});
            expect(connectorOf(session.defaultConnectionId)).toEqual(['hyper']);
            expect(session.scripts.map(script => [script.name, connectorOf(script.connectionId)])).toEqual([
                ['define.sql', ['hyper']],
                ['remote.sql', ['trino']],
            ]);
        });

        it('imports a shared session with connections of its own', async () => {
            const bundle = await exportAndRead();
            const entries = registry.connections!;
            const plan = planConnectionImport(bundle.session, entries);
            // Both connections describe connections of the app, the user is asked
            expect(plan.map(item => item.decision.kind)).toEqual(['ask', 'ask']);
            const choices = new Map<string, ConnectionImportChoice>(plan.map(item => [item.ref.connectionId, { kind: 'separate' }]));
            const session = applyConnectionImportPlan(bundle.session, plan, choices, entries);
            await writePortableSessionFresh(backend, { ...bundle, session }, IMPORTED_SESSION_ID);

            const restored = await restore(backend);
            const imported = sessionOf(restored, IMPORTED_SESSION_ID);
            const remote = scriptOf(imported, 'remote.sql').connection.connectionId;
            expect(remote).not.toBe(TRINO_ID);
            expect(restored.connectionStates.get(remote)?.connectorInfo.connectorType).toBe(ConnectorType.TRINO);
            expect(restored.connectionStates.get(remote)?.catalog).not.toBe(restored.connectionStates.get(TRINO_ID)!.catalog);
        });

        it('imports a shared session that links its connections to the connections of the app', async () => {
            const bundle = await exportAndRead();
            const entries = registry.connections!;
            const plan = planConnectionImport(bundle.session, entries);
            const choices = new Map<string, ConnectionImportChoice>(plan.map(item => [
                item.ref.connectionId,
                { kind: 'link', connectionId: item.decision.kind === 'ask' ? item.decision.candidates[0].id : '' },
            ]));
            const session = applyConnectionImportPlan(bundle.session, plan, choices, entries);
            expect(session.scripts).toEqual([
                { name: 'define.sql', connectionId: HYPER_ID },
                { name: 'remote.sql', connectionId: TRINO_ID },
            ]);
            await writePortableSessionFresh(backend, { ...bundle, session }, IMPORTED_SESSION_ID);

            const restored = await restore(backend);
            const imported = sessionOf(restored, IMPORTED_SESSION_ID);
            // Both sessions share the connections of the app
            expect(scriptOf(imported, 'remote.sql').connection.catalog).toBe(restored.connectionStates.get(TRINO_ID)!.catalog);
            expect(findSessionsForConnection(connectionRegistryOf(restored), TRINO_ID)).toEqual([SESSION_ID, IMPORTED_SESSION_ID]);
        });
    });
});
