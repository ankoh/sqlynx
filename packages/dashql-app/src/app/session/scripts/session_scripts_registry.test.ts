import { describe, it, expect } from 'vitest';
import { SessionScriptsRegistry, addSessionScriptsForConnection, removeSessionScriptsFromRegistry } from './session_scripts_registry.js';
import { SessionScripts } from './session_scripts.js';

// removeSessionScriptsFromRegistry only reads sessionScriptsMap and the connections of the scripts,
// so a tiny stand-in SessionScripts is enough — no Wasm needed.
function scripts(sessionId: string, connectionId: string = `connection-${sessionId}`): SessionScripts {
    return { sessionId, connectionId, scripts: {} } as unknown as SessionScripts;
}

function registry(sessionIds: string[]): SessionScriptsRegistry {
    const reg: SessionScriptsRegistry = {
        sessionScriptsMap: new Map(),
        sessionScriptsByConnection: new Map(),
        invalidSessions: new Map(),
    };
    for (const sessionId of sessionIds) {
        reg.sessionScriptsMap.set(sessionId, scripts(sessionId));
        addSessionScriptsForConnection(reg, `connection-${sessionId}`, sessionId);
    }
    return reg;
}

describe('removeSessionScriptsFromRegistry', () => {
    it('drops the entry from both indices', () => {
        const reg = registry(['a']);
        const next = removeSessionScriptsFromRegistry(reg, 'a');

        expect(next.sessionScriptsMap.has('a')).toBe(false);
        expect(next.sessionScriptsByConnection.has('connection-a')).toBe(false);
    });

    it('leaves sibling sessions intact', () => {
        const reg = registry(['a', 'b']);
        const next = removeSessionScriptsFromRegistry(reg, 'a');

        expect(next.sessionScriptsMap.has('a')).toBe(false);
        expect(next.sessionScriptsMap.has('b')).toBe(true);
        expect(next.sessionScriptsByConnection.get('connection-b')).toEqual(['b']);
    });

    it('is a no-op for an unknown session id (returns the same reference)', () => {
        const reg = registry(['a']);
        const next = removeSessionScriptsFromRegistry(reg, 'missing');

        expect(next).toBe(reg);
        expect(next.sessionScriptsMap.has('a')).toBe(true);
    });

    it('keeps the other sessions of a shared connection', () => {
        const reg = registry([]);
        for (const sessionId of ['a', 'b']) {
            reg.sessionScriptsMap.set(sessionId, scripts(sessionId, 'shared'));
            addSessionScriptsForConnection(reg, 'shared', sessionId);
        }
        expect(reg.sessionScriptsByConnection.get('shared')).toEqual(['a', 'b']);
        const next = removeSessionScriptsFromRegistry(reg, 'a');
        expect(next.sessionScriptsByConnection.get('shared')).toEqual(['b']);
        const last = removeSessionScriptsFromRegistry(next, 'b');
        expect(last.sessionScriptsByConnection.has('shared')).toBe(false);
    });
});
