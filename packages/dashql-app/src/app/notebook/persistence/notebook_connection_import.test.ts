import { describe, expect, it } from 'vitest';

import { sanitizeConnectionParamsForSharing } from '../connections/connection_params.js';
import {
    applyConnectionImportPlan,
    connectionImportQuestions,
    connectionRefsChanged,
    planConnectionImport,
} from './notebook_connection_import.js';
import { testNotebook } from './notebook_test_backend.js';
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
    return testNotebook({ mainDatabase: { databaseId, params } });
}

describe('notebook connection import', () => {
    it('links a known connection silently when only secrets differ', () => {
        const notebook = imported(KNOWN, sanitizeConnectionParamsForSharing(trino('https://trino', 'secret'), false));
        const plan = planConnectionImport(notebook, ENTRIES);
        expect(plan.map(item => item.decision)).toEqual([{ kind: 'link', connectionId: KNOWN }]);
        expect(connectionImportQuestions(plan)).toEqual([]);
        // The copy takes the full params of the app's connection
        expect(applyConnectionImportPlan(notebook, plan, new Map(), ENTRIES).mainDatabase).toEqual({ databaseId: KNOWN, params: ENTRIES[0].params });
    });

    it('resolves aliases of known connections', () => {
        const notebook = imported('dddddddd-0000-4000-8000-00000000000d', trino('https://trino'));
        expect(planConnectionImport(notebook, ENTRIES)[0].decision).toEqual({ kind: 'link', connectionId: KNOWN });
    });

    it('asks when a regenerated id describes a known connection', () => {
        const notebook = imported(IMPORTED, trino('https://trino'));
        const plan = planConnectionImport(notebook, ENTRIES);
        expect(plan[0].decision).toEqual({ kind: 'ask', candidates: [ENTRIES[0]] });
        const linked = applyConnectionImportPlan(notebook, plan, new Map([[IMPORTED, { kind: 'link', connectionId: KNOWN }]]), ENTRIES);
        expect(linked.mainDatabase.databaseId).toBe(KNOWN);
        expect(connectionRefsChanged(notebook, linked)).toBe(true);
        const separate = applyConnectionImportPlan(notebook, plan, new Map([[IMPORTED, { kind: 'separate' }]]), ENTRIES);
        expect(separate.mainDatabase).toEqual({ databaseId: IMPORTED, params: trino('https://trino') });
        expect(connectionRefsChanged(notebook, separate)).toBe(false);
    });

    it('asks when a known id comes with other params and never reuses the id for a separate connection', () => {
        const notebook = imported(KNOWN, trino('https://elsewhere'));
        const plan = planConnectionImport(notebook, ENTRIES);
        expect(plan[0].decision).toEqual({ kind: 'ask', candidates: [ENTRIES[0]] });
        const separate = applyConnectionImportPlan(notebook, plan, new Map([[KNOWN, { kind: 'separate' }]]), ENTRIES, () => FRESH);
        expect(separate.mainDatabase).toEqual({ databaseId: FRESH, params: trino('https://elsewhere') });
    });

    it('registers unknown connections with their ids', () => {
        const notebook = imported(IMPORTED, trino('https://unknown'));
        const plan = planConnectionImport(notebook, ENTRIES);
        expect(plan[0].decision).toEqual({ kind: 'register' });
        expect(connectionRefsChanged(notebook, applyConnectionImportPlan(notebook, plan, new Map(), ENTRIES))).toBe(false);
    });
});
