import { describe, it, expect } from 'vitest';
import { NotebookScriptsRegistry, addNotebookScriptsForConnection, removeNotebookScriptsFromRegistry } from './notebook_scripts_registry.js';
import { NotebookScripts } from './notebook_scripts.js';
import { ConnectorType } from '../connections/connector_info.js';

// removeNotebookScriptsFromRegistry only reads notebookScriptsMap and entry.connectorInfo.connectorType, so a
// tiny stand-in NotebookScripts is enough — no Wasm needed.
function scripts(notebookId: string, connectorType: ConnectorType, databaseId: string = `connection-${notebookId}`): NotebookScripts {
    return { notebookId, databaseId, connectorInfo: { connectorType } } as unknown as NotebookScripts;
}

function registry(entries: Array<[string, ConnectorType]>): NotebookScriptsRegistry {
    const reg: NotebookScriptsRegistry = {
        notebookScriptsMap: new Map(),
        notebookScriptsByConnection: new Map(),
        notebookScriptsByConnectionType: [[], [], [], []],
    };
    for (const [notebookId, connectorType] of entries) {
        reg.notebookScriptsMap.set(notebookId, scripts(notebookId, connectorType));
        addNotebookScriptsForConnection(reg, `connection-${notebookId}`, notebookId);
        reg.notebookScriptsByConnectionType[connectorType].push(notebookId);
    }
    return reg;
}

describe('removeNotebookScriptsFromRegistry', () => {
    it('drops the entry from all three indices', () => {
        const reg = registry([['a', ConnectorType.HYPER]]);
        const next = removeNotebookScriptsFromRegistry(reg, 'a');

        expect(next.notebookScriptsMap.has('a')).toBe(false);
        expect(next.notebookScriptsByConnection.has('connection-a')).toBe(false);
        expect(next.notebookScriptsByConnectionType[ConnectorType.HYPER]).not.toContain('a');
    });

    it('leaves sibling notebooks of the same connector type intact', () => {
        const reg = registry([['a', ConnectorType.HYPER], ['b', ConnectorType.HYPER]]);
        const next = removeNotebookScriptsFromRegistry(reg, 'a');

        expect(next.notebookScriptsMap.has('a')).toBe(false);
        expect(next.notebookScriptsMap.has('b')).toBe(true);
        expect(next.notebookScriptsByConnection.get('connection-b')).toEqual(['b']);
        expect(next.notebookScriptsByConnectionType[ConnectorType.HYPER]).toEqual(['b']);
    });

    it('only touches the type index of the removed notebook', () => {
        const reg = registry([['a', ConnectorType.HYPER], ['t', ConnectorType.TRINO]]);
        const next = removeNotebookScriptsFromRegistry(reg, 'a');

        expect(next.notebookScriptsByConnectionType[ConnectorType.HYPER]).toEqual([]);
        expect(next.notebookScriptsByConnectionType[ConnectorType.TRINO]).toEqual(['t']);
    });

    it('is a no-op for an unknown notebook id (returns the same reference)', () => {
        const reg = registry([['a', ConnectorType.HYPER]]);
        const next = removeNotebookScriptsFromRegistry(reg, 'missing');

        expect(next).toBe(reg);
        expect(next.notebookScriptsMap.has('a')).toBe(true);
    });

    it('keeps the other notebooks of a shared connection', () => {
        const reg = registry([]);
        for (const notebookId of ['a', 'b']) {
            reg.notebookScriptsMap.set(notebookId, scripts(notebookId, ConnectorType.TRINO, 'shared'));
            addNotebookScriptsForConnection(reg, 'shared', notebookId);
            reg.notebookScriptsByConnectionType[ConnectorType.TRINO].push(notebookId);
        }
        expect(reg.notebookScriptsByConnection.get('shared')).toEqual(['a', 'b']);
        const next = removeNotebookScriptsFromRegistry(reg, 'a');
        expect(next.notebookScriptsByConnection.get('shared')).toEqual(['b']);
        const last = removeNotebookScriptsFromRegistry(next, 'b');
        expect(last.notebookScriptsByConnection.has('shared')).toBe(false);
    });
});
