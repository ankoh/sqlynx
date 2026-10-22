import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionViewMode } from '../scripts/session_commands.js';
import { SessionPage, type SessionPageDependencies } from './session_page.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const state = {
    mode: 0,
    feedMounts: 0,
    feedUnmounts: 0,
};

const dependencies = {
    useSessionViewMode: () => ({ mode: state.mode }),
    useSessionScripts: () => [{ sessionId: 'session', name: 'Session' }, vi.fn()],
    useConnectionState: () => [null],
    useLogger: () => ({ warn: vi.fn() }),
    useRouteContext: () => ({ sessionId: 'session' }),
    SessionFeedPage: ({ active }: { active: boolean }) => {
        React.useEffect(() => {
            state.feedMounts += 1;
            return () => { state.feedUnmounts += 1; };
        }, []);
        return <div data-testid="feed" data-active={active} />;
    },
    SessionShellPage: () => <div data-testid="shell" />,
} as unknown as SessionPageDependencies;

describe('SessionPage view transitions', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        state.mode = 0;
        state.feedMounts = 0;
        state.feedUnmounts = 0;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('keeps the feed mounted through a shell round trip', async () => {
        await act(async () => root.render(<SessionPage dependencies={dependencies} />));
        expect(state.feedMounts).toBe(1);
        expect(container.querySelector('[data-testid="feed"]')?.getAttribute('data-active')).toBe('true');

        state.mode = SessionViewMode.Shell;
        await act(async () => root.render(<SessionPage dependencies={dependencies} />));
        expect(state.feedUnmounts).toBe(0);
        expect(container.querySelector('[data-testid="feed"]')?.getAttribute('data-active')).toBe('false');
        expect(container.querySelector('[data-testid="shell"]')).not.toBeNull();

        state.mode = SessionViewMode.Session;
        await act(async () => root.render(<SessionPage dependencies={dependencies} />));
        expect(state.feedMounts).toBe(1);
        expect(state.feedUnmounts).toBe(0);
        expect(container.querySelector('[data-testid="feed"]')?.getAttribute('data-active')).toBe('true');
    });

    it('keeps the feed page mounted for the Dashboard view', async () => {
        await act(async () => root.render(<SessionPage dependencies={dependencies} />));
        state.mode = SessionViewMode.Dashboard;
        await act(async () => root.render(<SessionPage dependencies={dependencies} />));

        expect(container.querySelector('[data-testid="feed"]')?.getAttribute('data-active')).toBe('false');
        expect(state.feedMounts).toBe(1);
        expect(state.feedUnmounts).toBe(0);
    });
});
