import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionHealth } from '../connections/attached_database_state.js';
import { CONNECTION_ATTENTION_DURATION_MS, SessionConnectionAttentionContext, useSessionConnectionAttention } from './session_connection_attention.js';

describe('session connection attention', () => {
    let container: HTMLDivElement;
    let root: Root;
    let signal: ReturnType<typeof useSessionConnectionAttention>;
    function Probe(props: { sessionId: string; health: ConnectionHealth; databaseId?: string }) {
        signal = useSessionConnectionAttention(props.sessionId, props.databaseId ?? 'main', props.health);
        return <SessionConnectionAttentionContext.Provider value={signal}><Child /></SessionConnectionAttentionContext.Provider>;
    }
    function Child() {
        const shared = React.useContext(SessionConnectionAttentionContext)!;
        return <span data-active={shared.active}>{shared.sessionId}</span>;
    }
    beforeEach(() => {
        vi.useFakeTimers();
        container = document.createElement('div');
        root = createRoot(container);
    });
    afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

    it('shares a finite coalesced pulse, rejects other sessions, and never focuses', () => {
        act(() => root.render(<Probe sessionId="session" health={ConnectionHealth.NOT_STARTED} />));
        const focused = document.activeElement;
        act(() => signal.request('other'));
        expect(signal.active).toBe(false);
        act(() => signal.request('session'));
        expect(container.querySelector('[data-active="true"]')).not.toBeNull();
        act(() => vi.advanceTimersByTime(500));
        act(() => signal.request('session'));
        act(() => vi.advanceTimersByTime(CONNECTION_ATTENTION_DURATION_MS - 500));
        expect(signal.active).toBe(false);
        expect(document.activeElement).toBe(focused);
    });

    it('clears on session, main database, or health changes and ignores online requests', () => {
        const render = (sessionId: string, health: ConnectionHealth, databaseId = 'main') =>
            act(() => root.render(<Probe sessionId={sessionId} health={health} databaseId={databaseId} />));
        render('a', ConnectionHealth.NOT_STARTED);
        act(() => signal.request('a'));
        render('b', ConnectionHealth.NOT_STARTED);
        expect(signal.active).toBe(false);
        act(() => signal.request('b'));
        render('b', ConnectionHealth.NOT_STARTED, 'replacement');
        expect(signal.active).toBe(false);
        act(() => signal.request('b'));
        render('b', ConnectionHealth.ONLINE, 'replacement');
        expect(signal.active).toBe(false);
        act(() => signal.request('b'));
        expect(signal.active).toBe(false);
    });
});
