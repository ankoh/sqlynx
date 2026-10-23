import { describe, expect, it } from 'vitest';

import { sanitizeConnectionParamsForSharing } from '../../connections/connection_params.js';
import {
    applyConnectionImportPlan,
    connectionImportQuestions,
    connectionRefsChanged,
    planConnectionImport,
} from './session_connection_import.js';
import { testSession } from '../../storage/session_test_backend.js';
import type { ConnectionEntry, ConnectionParams } from '../../storage/storage_backend.js';

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

function imported(connectionId: string, params: ConnectionParams) {
    return testSession({
        defaultConnectionId: connectionId,
        connections: [{ connectionId, params }],
        scripts: [{ name: 'query.sql', connectionId }],
    });
}

describe('session connection import', () => {
    it('links a known connection silently when only secrets differ', () => {
        const session = imported(KNOWN, sanitizeConnectionParamsForSharing(trino('https://trino', 'secret'), false));
        const plan = planConnectionImport(session, ENTRIES);
        expect(plan.map(item => item.decision)).toEqual([{ kind: 'link', connectionId: KNOWN }]);
        expect(connectionImportQuestions(plan)).toEqual([]);
        // The copy takes the full params of the app's connection
        expect(applyConnectionImportPlan(session, plan, new Map(), ENTRIES).session.connections).toEqual([{ connectionId: KNOWN, params: ENTRIES[0].params }]);
    });

    it('resolves aliases of known connections', () => {
        const session = imported('dddddddd-0000-4000-8000-00000000000d', trino('https://trino'));
        expect(planConnectionImport(session, ENTRIES)[0].decision).toEqual({ kind: 'link', connectionId: KNOWN });
    });

    it('asks when a regenerated id describes a known connection', () => {
        const session = imported(IMPORTED, trino('https://trino'));
        const plan = planConnectionImport(session, ENTRIES);
        expect(plan[0].decision).toEqual({ kind: 'ask', candidates: [ENTRIES[0]] });
        const linkedImport = applyConnectionImportPlan(session, plan, new Map([[IMPORTED, { kind: 'link', connectionId: KNOWN }]]), ENTRIES);
        expect(linkedImport.connectionIds).toEqual(new Map([[IMPORTED, KNOWN]]));
        const linked = linkedImport.session;
        expect(linked.defaultConnectionId).toBe(KNOWN);
        // The scripts follow their connection
        expect(linked.scripts).toEqual([{ name: 'query.sql', connectionId: KNOWN }]);
        expect(connectionRefsChanged(session, linked)).toBe(true);
        const separate = applyConnectionImportPlan(session, plan, new Map([[IMPORTED, { kind: 'separate' }]]), ENTRIES).session;
        expect(separate.connections).toEqual([{ connectionId: IMPORTED, params: trino('https://trino') }]);
        expect(connectionRefsChanged(session, separate)).toBe(false);
    });

    it('asks when a known id comes with other params and never reuses the id for a separate connection', () => {
        const session = imported(KNOWN, trino('https://elsewhere'));
        const plan = planConnectionImport(session, ENTRIES);
        expect(plan[0].decision).toEqual({ kind: 'ask', candidates: [ENTRIES[0]] });
        const result = applyConnectionImportPlan(session, plan, new Map([[KNOWN, { kind: 'separate' }]]), ENTRIES, () => FRESH);
        // The catalogs of the bundle follow the renamed connection
        expect(result.connectionIds).toEqual(new Map([[KNOWN, FRESH]]));
        const separate = result.session;
        expect(separate.connections).toEqual([{ connectionId: FRESH, params: trino('https://elsewhere') }]);
        expect(separate.defaultConnectionId).toBe(FRESH);
        expect(separate.scripts).toEqual([{ name: 'query.sql', connectionId: FRESH }]);
    });

    it('keeps the name of a separate connection and takes the name of a linked one', () => {
        const session = testSession({
            defaultConnectionId: IMPORTED,
            connections: [{ connectionId: IMPORTED, name: 'Imported', params: trino('https://trino') }],
            scripts: [{ name: 'query.sql', connectionId: IMPORTED }],
        });
        const entries: ConnectionEntry[] = [{ ...ENTRIES[0], name: 'Known' }];
        const plan = planConnectionImport(session, entries);
        expect(plan[0].ref.name).toBe('Imported');
        const separate = applyConnectionImportPlan(session, plan, new Map([[IMPORTED, { kind: 'separate' }]]), entries).session;
        expect(separate.connections).toEqual([{ connectionId: IMPORTED, name: 'Imported', params: trino('https://trino') }]);
        const linked = applyConnectionImportPlan(session, plan, new Map([[IMPORTED, { kind: 'link', connectionId: KNOWN }]]), entries).session;
        expect(linked.connections).toEqual([{ connectionId: KNOWN, name: 'Known', params: entries[0].params }]);
    });

    it('registers unknown connections with their ids', () => {
        const session = imported(IMPORTED, trino('https://unknown'));
        const plan = planConnectionImport(session, ENTRIES);
        expect(plan[0].decision).toEqual({ kind: 'register' });
        expect(connectionRefsChanged(session, applyConnectionImportPlan(session, plan, new Map(), ENTRIES).session)).toBe(false);
    });
});
