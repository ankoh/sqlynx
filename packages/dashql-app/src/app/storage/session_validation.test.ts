import { describe, it, expect } from 'vitest';
import {
    validateSessionData,
    describeInvalidSession,
    describeSessionValidationError,
    SessionValidationError,
} from './session_validation.js';
import type { SessionData, SessionEntry } from './storage_backend.js';
import { ConnectorType } from '../connections/connector_info.js';

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONNECTION_ID = '11111111-2222-3333-4444-555555555555';
const REMOTE_CONNECTION_ID = '66666666-7777-8888-9999-aaaaaaaaaaaa';

function session(extra: Partial<SessionData> = {}): SessionData {
    return {
        formatVersion: 6,
        sessionId: UUID,
        defaultConnectionId: CONNECTION_ID,
        connections: [{ connectionId: CONNECTION_ID, params: { hyper: {} } as any }],
        scripts: [],
        attachments: [],
        metadata: {},
        ...extra,
    } as SessionData;
}

/// A session whose only connection is the default connection
function withDefault(connection: Record<string, unknown>): SessionData {
    return session({ defaultConnectionId: connection.connectionId as string, connections: [connection as any] });
}

describe('validateSessionData', () => {
    it('accepts a well-formed Hyper session', () => {
        expect(validateSessionData(session())).toEqual({ ok: true });
    });

    it('accepts each known remote connector after the local database', () => {
        const local = { connectionId: CONNECTION_ID, params: { hyper: { protocol: 'WASM' } } as any };
        const remote = (params: any) => session({
            defaultConnectionId: REMOTE_CONNECTION_ID,
            connections: [{ connectionId: REMOTE_CONNECTION_ID, params }, local],
        });
        const hyper = remote({ hyper: { protocol: 'V3_HTTP' } });
        const sf = remote({ salesforce: {} });
        const trino = remote({ trino: {} });
        expect(validateSessionData(hyper).ok).toBe(true);
        expect(validateSessionData(sf).ok).toBe(true);
        expect(validateSessionData(trino).ok).toBe(true);
    });

    it('rejects removed connector metadata', () => {
        expect(validateSessionData(withDefault({ connectionId: CONNECTION_ID, params: { duckdb: {} } }))).toEqual({
            ok: false,
            error: SessionValidationError.UnknownConnector,
        });
    });

    it('rejects legacy dataless sessions', () => {
        expect(validateSessionData(withDefault({ connectionId: CONNECTION_ID, params: { dataless: {} } }))).toEqual({
            ok: false,
            error: SessionValidationError.UnknownConnector,
        });
    });

    it('rejects a session with an empty sessionId', () => {
        expect(validateSessionData(session({ sessionId: '' }))).toEqual({
            ok: false,
            error: SessionValidationError.MissingSessionId,
        });
    });

    it('rejects a session whose sessionId is not a valid UUID', () => {
        for (const badId of ['imported-1700000000000', 'opfs://sessions/' + UUID, 'not-a-uuid', UUID + '-extra']) {
            expect(validateSessionData(session({ sessionId: badId }))).toEqual({
                ok: false,
                error: SessionValidationError.InvalidSessionId,
            });
        }
    });

    it('accepts an uppercase UUID', () => {
        expect(validateSessionData(session({ sessionId: UUID.toUpperCase() }))).toEqual({ ok: true });
    });

    it('rejects missing, older, and unknown format versions', () => {
        for (const formatVersion of [undefined, 1, 2, 3, 4, 5, 7]) {
            expect(validateSessionData(session({ formatVersion } as any))).toEqual({
                ok: false,
                error: SessionValidationError.UnsupportedFormatVersion,
            });
        }
    });

    it('requires a non-empty connection list', () => {
        const data = session();
        delete (data as any).connections;
        expect(validateSessionData(data)).toEqual({
            ok: false,
            error: SessionValidationError.InvalidConnections,
        });
        expect(validateSessionData(session({ connections: [] }))).toEqual({
            ok: false,
            error: SessionValidationError.InvalidConnections,
        });
    });

    it('accepts multiple connections with unique ids', () => {
        expect(validateSessionData(session({ connections: [
            { connectionId: CONNECTION_ID, params: { hyper: {} } as any },
            { connectionId: REMOTE_CONNECTION_ID, params: { trino: {} } as any },
            { connectionId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', params: { salesforce: {} } as any },
        ] }))).toEqual({ ok: true });
    });

    it('rejects invalid and duplicate connection ids', () => {
        for (const connectionId of ['', 'not-a-uuid']) {
            expect(validateSessionData(session({ connections: [
                { connectionId: CONNECTION_ID, params: { hyper: {} } as any },
                { connectionId, params: { hyper: {} } as any },
            ] }))).toEqual({ ok: false, error: SessionValidationError.InvalidConnectionId });
        }
        expect(validateSessionData(session({ connections: [
            { connectionId: CONNECTION_ID, params: { hyper: {} } as any },
            { connectionId: CONNECTION_ID, params: { trino: {} } as any },
        ] }))).toEqual({ ok: false, error: SessionValidationError.InvalidConnectionId });
    });

    it('requires the default connection to be a connection of the session', () => {
        expect(validateSessionData(session({ defaultConnectionId: REMOTE_CONNECTION_ID }))).toEqual({
            ok: false,
            error: SessionValidationError.InvalidDefaultConnectionId,
        });
    });

    it('rejects a connection with missing or unknown params', () => {
        expect(validateSessionData(withDefault({ connectionId: CONNECTION_ID }))).toEqual({
            ok: false,
            error: SessionValidationError.MissingConnectionParams,
        });
        expect(validateSessionData(withDefault({ connectionId: CONNECTION_ID, params: { garbage: 'data' } }))).toEqual({
            ok: false,
            error: SessionValidationError.UnknownConnector,
        });
    });
});

describe('describeSessionValidationError', () => {
    it('produces a human-readable string for every error', () => {
        for (const e of Object.values(SessionValidationError)) {
            const msg = describeSessionValidationError(e);
            expect(typeof msg).toBe('string');
            expect(msg.length).toBeGreaterThan(0);
        }
    });

    it('describes an unreadable session as missing files', () => {
        expect(describeSessionValidationError(SessionValidationError.SessionUnreadable))
            .toBe('Session files missing');
    });
});

describe('describeInvalidSession', () => {
    const entry: SessionEntry = { path: UUID };

    it('keys on the manifest entry path and uses session data for title and connector', () => {
        const data = session({ name: 'My Session' });
        const inv = describeInvalidSession(entry, SessionValidationError.UnknownConnector, data);
        expect(inv.sessionId).toBe(UUID);
        expect(inv.title).toBe('My Session');
        expect(inv.connectorType).toBe(ConnectorType.HYPER);
        expect(inv.error).toBe(SessionValidationError.UnknownConnector);
    });

    it('always uses the manifest entry path as the id, even when session data has a different one', () => {
        // The entry path is the authoritative registry/delete key; a mismatched (or malformed)
        // sessionId in the session data must not become the key.
        const data = session({ sessionId: 'imported-123' });
        const inv = describeInvalidSession({ path: UUID }, SessionValidationError.InvalidSessionId, data);
        expect(inv.sessionId).toBe(UUID);
    });

    it('falls back to the manifest path for the title when session data is absent', () => {
        const inv = describeInvalidSession(entry, SessionValidationError.MissingSessionId, null);
        expect(inv.sessionId).toBe(UUID);
        expect(inv.title).toBe(UUID);
        expect(inv.connectorType).toBeNull();
    });

    it('has a null connector type when params are unknown', () => {
        const data = withDefault({ connectionId: CONNECTION_ID, params: { garbage: 'data' } });
        const inv = describeInvalidSession(entry, SessionValidationError.UnknownConnector, data);
        expect(inv.connectorType).toBeNull();
    });
});
