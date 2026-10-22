import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { LoggerProvider } from '../../../platform/logger/logger_provider.js';
import { AttachedDatabaseRegistry } from '../connections/attached_database_registry.js';
import { SessionTestBackend } from '../../storage/session_test_backend.js';
import { StorageProvider } from '../../storage/storage_provider.js';
import { REGISTER_QUERY, RENAME_SESSION, type SessionScripts } from './session_scripts.js';
import { StorageWriter, WRITE_SESSION_PROPERTIES } from '../../storage/storage_writer.js';
import {
    SessionScriptsRegistryProvider,
    useSessionScripts,
    useSessionScriptsRegistry,
} from './session_scripts_registry.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function fixture(sessionId: string): SessionScripts {
    // REGISTER_QUERY only needs the script entry; no Wasm or execution setup is required.
    return {
        sessionId,
        settings: { cacheQueryResults: false },
        scripts: { 1: { scriptKey: 1, latestQueryId: null } },
    } as unknown as SessionScripts;
}

function SeedRegistry(props: { sessions: SessionScripts[]; children: React.ReactNode }) {
    const [, setRegistry] = useSessionScriptsRegistry();
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
        setRegistry(registry => ({
            ...registry,
            sessionScriptsMap: new Map(props.sessions.map(session => [session.sessionId, session])),
        }));
        setReady(true);
    }, [props.sessions, setRegistry]);
    return ready ? props.children : null;
}

type ScriptsHook = ReturnType<typeof useSessionScripts>;
type ScriptsRegistry = ReturnType<typeof useSessionScriptsRegistry>[0];

function Consumer(props: { sessionId: string; capture: (scripts: ScriptsHook, registry: ScriptsRegistry) => void }) {
    const scripts = useSessionScripts(props.sessionId);
    const [registry] = useSessionScriptsRegistry();
    React.useLayoutEffect(() => props.capture(scripts, registry));
    return null;
}

describe('useSessionScripts dispatch', () => {
    it('keeps retained and current modifiers bound to their sessions when a reused route batches actions', async () => {
        const write = vi.spyOn(StorageWriter.prototype, 'write').mockResolvedValue(true);
        const sessions = [fixture('a'), fixture('b')];
        const backend = new SessionTestBackend();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        let current!: ScriptsHook;
        let registry!: ScriptsRegistry;
        const capture = (scripts: ScriptsHook, nextRegistry: ScriptsRegistry) => {
            current = scripts;
            registry = nextRegistry;
        };
        const render = async (sessionId: string) => {
            await act(async () => {
                root.render(<LoggerProvider>
                    <StorageProvider backend={backend}>
                        <AttachedDatabaseRegistry>
                            <SessionScriptsRegistryProvider>
                                <SeedRegistry sessions={sessions}>
                                    {/* No key: changing the route id must reuse the hook and its pending queue. */}
                                    <Consumer sessionId={sessionId} capture={capture} />
                                </SeedRegistry>
                            </SessionScriptsRegistryProvider>
                        </AttachedDatabaseRegistry>
                    </StorageProvider>
                </LoggerProvider>);
            });
            // The seeded registry renders the consumer from a scheduled (non-sync) update.
            await vi.waitFor(() => expect(current?.[0]?.sessionId).toBe(sessionId));
        };

        try {
            await render('a');
            const modifyA = current[1];
            await render('b');
            const modifyB = current[1];
            expect(modifyB).not.toBe(modifyA);

            let resultA!: ReturnType<typeof modifyA>;
            let resultB!: ReturnType<typeof modifyB>;
            await act(async () => {
                // Both calls enqueue synchronously before the shared queue's microtask flush.
                resultA = modifyA({ type: REGISTER_QUERY, value: [1, 101] });
                resultB = modifyB({ type: REGISTER_QUERY, value: [1, 202] });
                expect(registry.sessionScriptsMap.get('a')?.scripts[1].latestQueryId).toBeNull();
                expect(registry.sessionScriptsMap.get('b')?.scripts[1].latestQueryId).toBeNull();
            });

            const [resolvedA, resolvedB] = await Promise.all([resultA, resultB]);
            expect(resolvedA).toMatchObject({ sessionId: 'a', scripts: { 1: { latestQueryId: 101 } } });
            expect(resolvedB).toMatchObject({ sessionId: 'b', scripts: { 1: { latestQueryId: 202 } } });
            await vi.waitFor(() => expect(current[0]?.scripts[1].latestQueryId).toBe(202));
            expect(registry.sessionScriptsMap.get('a')?.scripts[1].latestQueryId).toBe(101);
            expect(registry.sessionScriptsMap.get('b')?.scripts[1].latestQueryId).toBe(202);
            act(() => {
                modifyA({ type: RENAME_SESSION, value: 'Offline session' });
            });
            await vi.waitFor(() => expect(write).toHaveBeenCalledWith(expect.any(String), {
                type: WRITE_SESSION_PROPERTIES, value: ['a', { name: 'Offline session', settings: { cacheQueryResults: false } }],
            }, expect.any(Number)));
        } finally {
            write.mockRestore();
            act(() => root.unmount());
            container.remove();
        }
    });
});
