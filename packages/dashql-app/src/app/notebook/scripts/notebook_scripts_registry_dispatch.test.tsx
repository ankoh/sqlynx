import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { LoggerProvider } from '../../../platform/logger/logger_provider.js';
import { AttachedDatabaseRegistry } from '../connections/attached_database_registry.js';
import { NotebookTestBackend } from '../persistence/notebook_test_backend.js';
import { StorageProvider } from '../persistence/storage_provider.js';
import { REGISTER_QUERY, RENAME_NOTEBOOK, type NotebookScripts } from './notebook_scripts.js';
import { StorageWriter, WRITE_NOTEBOOK_NAME } from '../persistence/storage_writer.js';
import {
    NotebookScriptsRegistryProvider,
    useNotebookScripts,
    useNotebookScriptsRegistry,
} from './notebook_scripts_registry.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function fixture(notebookId: string): NotebookScripts {
    // REGISTER_QUERY only needs the script entry; no Wasm or execution setup is required.
    return {
        notebookId,
        scripts: { 1: { scriptKey: 1, latestQueryId: null } },
    } as unknown as NotebookScripts;
}

function SeedRegistry(props: { notebooks: NotebookScripts[]; children: React.ReactNode }) {
    const [, setRegistry] = useNotebookScriptsRegistry();
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
        setRegistry(registry => ({
            ...registry,
            notebookScriptsMap: new Map(props.notebooks.map(notebook => [notebook.notebookId, notebook])),
        }));
        setReady(true);
    }, [props.notebooks, setRegistry]);
    return ready ? props.children : null;
}

type ScriptsHook = ReturnType<typeof useNotebookScripts>;
type ScriptsRegistry = ReturnType<typeof useNotebookScriptsRegistry>[0];

function Consumer(props: { notebookId: string; capture: (scripts: ScriptsHook, registry: ScriptsRegistry) => void }) {
    const scripts = useNotebookScripts(props.notebookId);
    const [registry] = useNotebookScriptsRegistry();
    React.useLayoutEffect(() => props.capture(scripts, registry));
    return null;
}

describe('useNotebookScripts dispatch', () => {
    it('keeps retained and current modifiers bound to their notebooks when a reused route batches actions', async () => {
        const write = vi.spyOn(StorageWriter.prototype, 'write').mockResolvedValue(true);
        const notebooks = [fixture('a'), fixture('b')];
        const backend = new NotebookTestBackend();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        let current!: ScriptsHook;
        let registry!: ScriptsRegistry;
        const capture = (scripts: ScriptsHook, nextRegistry: ScriptsRegistry) => {
            current = scripts;
            registry = nextRegistry;
        };
        const render = async (notebookId: string) => {
            await act(async () => {
                root.render(<LoggerProvider>
                    <StorageProvider backend={backend}>
                        <AttachedDatabaseRegistry>
                            <NotebookScriptsRegistryProvider>
                                <SeedRegistry notebooks={notebooks}>
                                    {/* No key: changing the route id must reuse the hook and its pending queue. */}
                                    <Consumer notebookId={notebookId} capture={capture} />
                                </SeedRegistry>
                            </NotebookScriptsRegistryProvider>
                        </AttachedDatabaseRegistry>
                    </StorageProvider>
                </LoggerProvider>);
                await new Promise(resolve => setTimeout(resolve, 0));
            });
        };

        try {
            await render('a');
            expect(current[0]?.notebookId).toBe('a');
            const modifyA = current[1];
            await render('b');
            expect(current[0]?.notebookId).toBe('b');
            const modifyB = current[1];
            expect(modifyB).not.toBe(modifyA);

            let resultA!: ReturnType<typeof modifyA>;
            let resultB!: ReturnType<typeof modifyB>;
            await act(async () => {
                // Both calls enqueue synchronously before the shared queue's microtask flush.
                resultA = modifyA({ type: REGISTER_QUERY, value: [1, 101] });
                resultB = modifyB({ type: REGISTER_QUERY, value: [1, 202] });
                expect(registry.notebookScriptsMap.get('a')?.scripts[1].latestQueryId).toBeNull();
                expect(registry.notebookScriptsMap.get('b')?.scripts[1].latestQueryId).toBeNull();
                await new Promise(resolve => setTimeout(resolve, 0));
            });

            const [resolvedA, resolvedB] = await Promise.all([resultA, resultB]);
            expect(resolvedA).toMatchObject({ notebookId: 'a', scripts: { 1: { latestQueryId: 101 } } });
            expect(resolvedB).toMatchObject({ notebookId: 'b', scripts: { 1: { latestQueryId: 202 } } });
            expect(registry.notebookScriptsMap.get('a')?.scripts[1].latestQueryId).toBe(101);
            expect(registry.notebookScriptsMap.get('b')?.scripts[1].latestQueryId).toBe(202);
            expect(current[0]?.scripts[1].latestQueryId).toBe(202);
            await act(async () => {
                modifyA({ type: RENAME_NOTEBOOK, value: 'Offline notebook' });
                await new Promise(resolve => setTimeout(resolve, 0));
            });
            expect(write).toHaveBeenCalledWith(expect.any(String), {
                type: WRITE_NOTEBOOK_NAME, value: ['a', 'Offline notebook'],
            }, expect.any(Number));
        } finally {
            write.mockRestore();
            act(() => root.unmount());
            container.remove();
        }
    });
});
