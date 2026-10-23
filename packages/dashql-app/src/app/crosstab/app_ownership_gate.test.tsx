import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppOwnershipGate } from './app_ownership_gate.js';
import { useAppHandOver } from '../../platform/crosstab/app_hand_over.js';
import { LoggerProvider } from '../../platform/logger/logger_provider.js';
import type { AppOwnershipEnvironment } from '../../platform/crosstab/app_ownership.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function App(props: { name: string; onHandOver: () => Promise<void> }) {
    useAppHandOver(props.onHandOver);
    return <div>{`app ${props.name}`}</div>;
}

/// The button that takes over the app
function findUseHereButton(container: HTMLElement): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find(button => button.textContent === 'Use Here');
    if (button == null) {
        throw new Error('The page has no "Use Here" button');
    }
    return button;
}

/// Flush React updates until the condition holds
async function actUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!condition()) {
        if (performance.now() > deadline) {
            throw new Error('Timed out waiting for the condition');
        }
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
}

describe('AppOwnershipGate', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        for (const cleanup of cleanups.splice(0).reverse()) {
            cleanup();
        }
    });

    /// Render the app in a browsing context that stands in for a tab
    function openTab(name: string, names: { lockName: string; channelName: string }, onHandOver: () => Promise<void>) {
        const frame = document.createElement('iframe');
        document.body.appendChild(frame);
        const tab = frame.contentWindow as Window & typeof globalThis;
        const environment: AppOwnershipEnvironment = { ...names, locks: tab.navigator.locks, openChannel: name => new tab.BroadcastChannel(name) };
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        act(() => root.render(
            <MemoryRouter>
                <LoggerProvider>
                    <AppOwnershipGate environment={environment} leave={async () => { }}>
                        <App name={name} onHandOver={onHandOver} />
                    </AppOwnershipGate>
                </LoggerProvider>
            </MemoryRouter>,
        ));
        cleanups.push(() => {
            act(() => root.unmount());
            container.remove();
            frame.remove();
        });
        return container;
    }

    it('renders the app in one tab and moves it on request', async () => {
        const id = crypto.randomUUID();
        const names = { lockName: `dashql-test-app-${id}`, channelName: `dashql-test-app-${id}` };
        const events: string[] = [];

        const a = openTab('a', names, async () => { events.push('a stopped'); });
        await actUntil(() => a.textContent === 'app a');
        const b = openTab('b', names, async () => { events.push('b stopped'); });
        await actUntil(() => b.textContent?.includes('Open in Another Tab') ?? false);
        expect(b.textContent).toContain('DashQL is open in another tab');

        await act(async () => findUseHereButton(b).click());
        await actUntil(() => b.textContent === 'app b');
        expect(a.textContent).toContain('Open in Another Tab');
        expect(events).toEqual(['a stopped']);

        // The first tab takes the app back
        await act(async () => findUseHereButton(a).click());
        await actUntil(() => a.textContent === 'app a');
        expect(b.textContent).toContain('Open in Another Tab');
        expect(events).toEqual(['a stopped', 'b stopped']);
    });
});
