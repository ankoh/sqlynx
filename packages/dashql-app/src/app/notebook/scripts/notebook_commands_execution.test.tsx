import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookCommands, type NotebookCommandsDependencies } from './notebook_commands.js';
import { ConnectionHealth } from '../connections/attached_database_state.js';
import { NotebookConnectionAttentionContext } from '../ui/notebook_connection_attention.js';

describe('global notebook execution feedback', () => {
    let container: HTMLDivElement;
    let root: Root;
    let connection: any;
    let attention: React.ContextType<typeof NotebookConnectionAttentionContext>;
    const execute = vi.fn();
    const resolveMain = vi.fn();
    const notebookScripts = {
        notebookId: 'notebook', connectorInfo: { features: { executeQueryAction: true } },
        scriptFocus: { fileName: '01_query.sql' },
        scriptRefs: { '01_query.sql': { scriptId: 1, fileName: '01_query.sql' } },
        scripts: { 1: { scriptKey: 1, annotations: {}, analysisOutdated: false, scriptSession: {
            getText: () => 'SELECT 1', startExecution: () => ({}),
            compileQuery: () => ({ read: () => ({ errorsLength: () => 0, sql: () => 'SELECT 1', cacheable: () => false, cacheSignature: () => '' }), destroy: () => {} }),
        } } },
    };
    const dependencies = {
        useNotebookScripts: () => [notebookScripts, vi.fn()],
        useAttachedDatabaseState: (notebookId: string) => { resolveMain(notebookId); return [connection, vi.fn()]; },
        useQueryExecutor: () => execute,
        useCatalogLoaderQueue: () => vi.fn(),
        useLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
        useAppConfig: () => null,
        useAppSettingsReady: () => true,
    } as unknown as NotebookCommandsDependencies;
    function Probe() {
        attention = React.useContext(NotebookConnectionAttentionContext);
        return <span data-active={attention?.active} />;
    }
    const render = () => act(() => root.render(<MemoryRouter initialEntries={['/notebooks/notebook']}>
        <NotebookCommands dependencies={dependencies}><Probe /></NotebookCommands>
    </MemoryRouter>));
    const shortcut = () => act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true })));
    beforeEach(() => {
        connection = null;
        execute.mockReset().mockReturnValue([42, Promise.resolve()]);
        resolveMain.mockReset();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => { act(() => root.unmount()); container.remove(); });

    it('handles a missing main connection safely and pulses the descendant header signal', () => {
        render();
        const focused = document.activeElement;
        shortcut();
        expect(attention?.active).toBe(true);
        expect(execute).not.toHaveBeenCalled();
        expect(resolveMain).toHaveBeenCalledWith('notebook');
        expect(document.activeElement).toBe(focused);
        connection = { databaseId: 'main', connectionHealth: ConnectionHealth.ONLINE };
        render();
        expect(attention?.active).toBe(false);
    });

    it('executes against the main database rather than a script database identity', () => {
        connection = { databaseId: 'main', connectionHealth: ConnectionHealth.ONLINE };
        render();
        shortcut();
        expect(execute).toHaveBeenCalledWith('main', expect.objectContaining({ query: 'SELECT 1' }));
        expect(attention?.active).toBe(false);
    });
});
