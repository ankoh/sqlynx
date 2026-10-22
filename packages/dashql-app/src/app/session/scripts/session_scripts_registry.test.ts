import { describe, it, expect } from 'vitest';
import { SessionScriptsRegistry, addSessionScriptsForConnection, removeSessionScriptsFromRegistry } from './session_scripts_registry.js';
import { SessionScripts } from './session_scripts.js';
import { ConnectorType } from '../../connections/connector_info.js';

// removeSessionScriptsFromRegistry only reads sessionScriptsMap and entry.connectorInfo.connectorType, so a
// tiny stand-in SessionScripts is enough — no Wasm needed.
function scripts(sessionId: string, connectorType: ConnectorType, connectionId: string = `connection-${sessionId}`): SessionScripts {
    return { sessionId, connectionId, connectorInfo: { connectorType } } as unknown as SessionScripts;
}

function registry(entries: Array<[string, ConnectorType]>): SessionScriptsRegistry {
    const reg: SessionScriptsRegistry = {
        sessionScriptsMap: new Map(),
        sessionScriptsByConnection: new Map(),
        sessionScriptsByConnectionType: [[], [], [], []],
    };
    for (const [sessionId, connectorType] of entries) {
        reg.sessionScriptsMap.set(sessionId, scripts(sessionId, connectorType));
        addSessionScriptsForConnection(reg, `connection-${sessionId}`, sessionId);
        reg.sessionScriptsByConnectionType[connectorType].push(sessionId);
    }
    return reg;
}

describe('removeSessionScriptsFromRegistry', () => {
    it('drops the entry from all three indices', () => {
        const reg = registry([['a', ConnectorType.HYPER]]);
        const next = removeSessionScriptsFromRegistry(reg, 'a');

        expect(next.sessionScriptsMap.has('a')).toBe(false);
        expect(next.sessionScriptsByConnection.has('connection-a')).toBe(false);
        expect(next.sessionScriptsByConnectionType[ConnectorType.HYPER]).not.toContain('a');
    });

    it('leaves sibling sessions of the same connector type intact', () => {
        const reg = registry([['a', ConnectorType.HYPER], ['b', ConnectorType.HYPER]]);
        const next = removeSessionScriptsFromRegistry(reg, 'a');

        expect(next.sessionScriptsMap.has('a')).toBe(false);
        expect(next.sessionScriptsMap.has('b')).toBe(true);
        expect(next.sessionScriptsByConnection.get('connection-b')).toEqual(['b']);
        expect(next.sessionScriptsByConnectionType[ConnectorType.HYPER]).toEqual(['b']);
    });

    it('only touches the type index of the removed session', () => {
        const reg = registry([['a', ConnectorType.HYPER], ['t', ConnectorType.TRINO]]);
        const next = removeSessionScriptsFromRegistry(reg, 'a');

        expect(next.sessionScriptsByConnectionType[ConnectorType.HYPER]).toEqual([]);
        expect(next.sessionScriptsByConnectionType[ConnectorType.TRINO]).toEqual(['t']);
    });

    it('is a no-op for an unknown session id (returns the same reference)', () => {
        const reg = registry([['a', ConnectorType.HYPER]]);
        const next = removeSessionScriptsFromRegistry(reg, 'missing');

        expect(next).toBe(reg);
        expect(next.sessionScriptsMap.has('a')).toBe(true);
    });

    it('keeps the other sessions of a shared connection', () => {
        const reg = registry([]);
        for (const sessionId of ['a', 'b']) {
            reg.sessionScriptsMap.set(sessionId, scripts(sessionId, ConnectorType.TRINO, 'shared'));
            addSessionScriptsForConnection(reg, 'shared', sessionId);
            reg.sessionScriptsByConnectionType[ConnectorType.TRINO].push(sessionId);
        }
        expect(reg.sessionScriptsByConnection.get('shared')).toEqual(['a', 'b']);
        const next = removeSessionScriptsFromRegistry(reg, 'a');
        expect(next.sessionScriptsByConnection.get('shared')).toEqual(['b']);
        const last = removeSessionScriptsFromRegistry(next, 'b');
        expect(last.sessionScriptsByConnection.has('shared')).toBe(false);
    });
});
