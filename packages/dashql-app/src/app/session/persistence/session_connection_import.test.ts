import { describe, expect, it } from 'vitest';

import { sanitizeConnectionParamsForSharing } from '../connections/connection_params.js';
import {
    applyConnectionImportPlan,
    connectionImportQuestions,
    connectionRefsChanged,
    planConnectionImport,
} from './session_connection_import.js';
import { testSession } from './session_test_backend.js';
import type { ConnectionEntry, ConnectionParams } from './storage_backend.js';

const KNOWN = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER = 'aaaaaaaa-0000-4000-8000-00000000000b';
const IMPORTED = 'bbbbbbbb-0000-4000-8000-00000000000b';
const FRESH = 'cccccccc-0000-4000-8000-00000000000c';
const trino = (endpoint: string, secret = ''): ConnectionParams => ({
    trino: { endpoint, auth: { authType: 'AUTH_BASIC', basic: { username: 'user', secret } } },
}) as ConnectionParams;

const ENTRIES: ConnectionEntry[] = [
    { id: KNOWN, params: trino('https://trino', 'secret'), aliases: ['dddddddd-0000-4000-8000-00000000000d'] },
    { id: OTHER, params: trino('https://other', 'secret') },
];

function imported(databaseId: string, params: ConnectionParams) {
    return testSession({ mainDatabase: { databaseId, params } });
}

describe('session connection import', () => {
    it('links a known connection silently when only secrets differ', () => {
        const session = imported(KNOWN, sanitizeConnectionParamsForSharing(trino('https://trino', 'secret'), false));
        const plan = planConnectionImport(session, ENTRIES);
        expect(plan.map(item => item.decision)).toEqual([{ kind: 'link', connectionId: KNOWN }]);
        expect(connectionImportQuestions(plan)).toEqual([]);
        // The copy takes the full params of the app's connection
        expect(applyConnectionImportPlan(session, plan, new Map(), ENTRIES).mainDatabase).toEqual({ databaseId: KNOWN, params: ENTRIES[0].params });
    });

    it('resolves aliases of known connections', () => {
        const session = imported('dddddddd-0000-4000-8000-00000000000d', trino('https://trino'));
        expect(planConnectionImport(session, ENTRIES)[0].decision).toEqual({ kind: 'link', connectionId: KNOWN });
    });

    it('asks when a regenerated id describes a known connection', () => {
        const session = imported(IMPORTED, trino('https://trino'));
        const plan = planConnectionImport(session, ENTRIES);
        expect(plan[0].decision).toEqual({ kind: 'ask', candidates: [ENTRIES[0]] });
        const linked = applyConnectionImportPlan(session, plan, new Map([[IMPORTED, { kind: 'link', connectionId: KNOWN }]]), ENTRIES);
        expect(linked.mainDatabase.databaseId).toBe(KNOWN);
        expect(connectionRefsChanged(session, linked)).toBe(true);
        const separate = applyConnectionImportPlan(session, plan, new Map([[IMPORTED, { kind: 'separate' }]]), ENTRIES);
        expect(separate.mainDatabase).toEqual({ databaseId: IMPORTED, params: trino('https://trino') });
        expect(connectionRefsChanged(session, separate)).toBe(false);
    });

    it('asks when a known id comes with other params and never reuses the id for a separate connection', () => {
        const session = imported(KNOWN, trino('https://elsewhere'));
        const plan = planConnectionImport(session, ENTRIES);
        expect(plan[0].decision).toEqual({ kind: 'ask', candidates: [ENTRIES[0]] });
        const separate = applyConnectionImportPlan(session, plan, new Map([[KNOWN, { kind: 'separate' }]]), ENTRIES, () => FRESH);
        expect(separate.mainDatabase).toEqual({ databaseId: FRESH, params: trino('https://elsewhere') });
    });

    it('registers unknown connections with their ids', () => {
        const session = imported(IMPORTED, trino('https://unknown'));
        const plan = planConnectionImport(session, ENTRIES);
        expect(plan[0].decision).toEqual({ kind: 'register' });
        expect(connectionRefsChanged(session, applyConnectionImportPlan(session, plan, new Map(), ENTRIES))).toBe(false);
    });
});
