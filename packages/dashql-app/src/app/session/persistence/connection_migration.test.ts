import { describe, expect, it } from 'vitest';

import { Logger } from '../../../platform/logger/logger.js';
import { applyConnectionMigration, planConnectionMigration, type MigratingSession } from './connection_migration.js';
import { SessionTestBackend, testSession } from './session_test_backend.js';
import { STORAGE_CATALOG_RELATIONS, type ConnectionParams } from './storage_backend.js';

class NullLogger extends Logger {
    public destroy(): void {}
    protected flushPendingRecords(): void {}
}

const SESSION_A = '11111111-0000-4000-8000-00000000000a';
const SESSION_B = '11111111-0000-4000-8000-00000000000b';
const SESSION_C = '11111111-0000-4000-8000-00000000000c';
const DB_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const DB_B = 'aaaaaaaa-0000-4000-8000-00000000000b';
const DB_C = 'aaaaaaaa-0000-4000-8000-00000000000c';
const WASM: ConnectionParams = { hyper: { protocol: 'WASM' } } as ConnectionParams;
const trino = (endpoint: string, secret = ''): ConnectionParams => ({
    trino: { endpoint, auth: { authType: 'AUTH_BASIC', basic: { username: 'user', secret } } },
}) as ConnectionParams;

function session(sessionId: string, databaseId: string, params: ConnectionParams, paramsDraft?: ConnectionParams): MigratingSession {
    return {
        sessionId,
        data: testSession({
            sessionId,
            mainDatabase: { databaseId, params, ...(paramsDraft ? { paramsDraft } : {}) },
        }),
    };
}

describe('connection migration', () => {
    it('consolidates databases with equal params under the first id', () => {
        const plan = planConnectionMigration([
            session(SESSION_A, DB_A, WASM),
            session(SESSION_B, DB_B, WASM),
            session(SESSION_C, DB_C, trino('https://trino')),
        ]);
        expect(plan.entries.map(entry => [entry.id, entry.aliases])).toEqual([
            [DB_A, [DB_B]],
            [DB_C, undefined],
        ]);
        // Only the session that referenced the alias changes
        expect([...plan.rewrites.keys()]).toEqual([SESSION_B]);
        expect(plan.rewrites.get(SESSION_B)!.mainDatabase).toEqual({ databaseId: DB_A, params: WASM });
        expect(plan.catalogSources).toEqual(new Map([[DB_A, SESSION_A], [DB_C, SESSION_C]]));
    });

    it('keeps databases that differ in a secret separate', () => {
        const plan = planConnectionMigration([
            session(SESSION_A, DB_A, trino('https://trino', 'one')),
            session(SESSION_B, DB_B, trino('https://trino', 'two')),
        ]);
        expect(plan.entries.map(entry => entry.id)).toEqual([DB_A, DB_B]);
        expect(plan.rewrites.size).toBe(0);
    });

    it('moves drafts into the app manifest and keeps conflicting drafts in connections of their own', () => {
        const draftOne = trino('https://draft-one');
        const draftTwo = trino('https://draft-two');
        const plan = planConnectionMigration([
            session(SESSION_A, DB_A, trino('https://trino')),
            session(SESSION_B, DB_B, trino('https://trino'), draftOne),
            session(SESSION_C, DB_C, trino('https://trino'), draftTwo),
        ]);
        expect(plan.entries.map(entry => [entry.id, entry.paramsDraft, entry.aliases])).toEqual([
            [DB_A, draftOne, [DB_B]],
            [DB_C, draftTwo, undefined],
        ]);
        // Every session drops its draft
        for (const rewrite of plan.rewrites.values()) {
            expect(rewrite.mainDatabase.paramsDraft).toBeUndefined();
        }
        expect(plan.rewrites.get(SESSION_B)!.mainDatabase.databaseId).toBe(DB_A);
        expect(plan.rewrites.get(SESSION_C)!.mainDatabase.databaseId).toBe(DB_C);
    });

    it('dedupes references that consolidate within a session', () => {
        const plan = planConnectionMigration([{
            sessionId: SESSION_A,
            data: testSession({
                sessionId: SESSION_A,
                mainDatabase: { databaseId: DB_A, params: WASM },
                attachedDatabases: [{ databaseId: DB_B, params: WASM }, { databaseId: DB_C, params: trino('https://trino') }],
            }),
        }]);
        expect(plan.rewrites.get(SESSION_A)!.attachedDatabases).toEqual([{ databaseId: DB_C, params: trino('https://trino') }]);
    });

    it('commits once, copies catalogs and rewrites sessions', async () => {
        const backend = new SessionTestBackend();
        const sessions = [session(SESSION_A, DB_A, WASM), session(SESSION_B, DB_B, WASM)];
        for (const { sessionId, data } of sessions) backend.sessions.set(sessionId, data);
        backend.schemas.set(SESSION_A, 'CREATE TABLE a(id int);');
        const plan = planConnectionMigration(sessions);
        await expect(applyConnectionMigration(backend, plan, new NullLogger())).resolves.toBe(true);
        expect(backend.connections?.map(entry => entry.id)).toEqual([DB_A]);
        expect(backend.connectionFiles.get(`${DB_A}/${STORAGE_CATALOG_RELATIONS}`)).toBe('CREATE TABLE a(id int);');
        expect(backend.sessions.get(SESSION_B)!.mainDatabase.databaseId).toBe(DB_A);
        // A second migration finds the committed connections and changes nothing
        await expect(applyConnectionMigration(backend, planConnectionMigration([]), new NullLogger())).resolves.toBe(false);
        expect(backend.connections?.map(entry => entry.id)).toEqual([DB_A]);
    });
});
