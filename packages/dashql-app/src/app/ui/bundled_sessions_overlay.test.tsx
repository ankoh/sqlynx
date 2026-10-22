import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchSessionUrl = vi.fn();
const writeText = vi.fn<() => Promise<void>>(() => Promise.resolve());

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.stubGlobal('ResizeObserver', class {
    observe() { }
    unobserve() { }
    disconnect() { }
});

import { BundledSessionsOverlay, type BundledSessionsOverlayDependencies } from './bundled_sessions_overlay.js';

const dependencies: BundledSessionsOverlayDependencies = {
    useLogger: () => ({ error: vi.fn() }),
};

describe('BundledSessionsOverlay', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        dispatchSessionUrl.mockReset();
        writeText.mockClear();
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        document.getElementById('__dashqlPortalRoot__')?.remove();
    });

    it('copies a public link and dispatches a bundled session URL', async () => {
        act(() => root.render(<BundledSessionsOverlay dispatchSessionUrl={dispatchSessionUrl} dependencies={dependencies} />));
        act(() => (container.querySelector('[aria-label="Example sessions"]') as HTMLButtonElement).click());

        expect(document.querySelector('[aria-label="Add Property Graphs session"]')).toBeInstanceOf(HTMLButtonElement);
        expect(document.querySelector('[aria-label="Close example sessions"]')).toBeInstanceOf(HTMLButtonElement);
        await act(async () => {
            (document.querySelector('[aria-label="Copy Explain session link"]') as HTMLButtonElement).click();
            await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledWith(
            'https://dashql.app?session=https%3A%2F%2Fdashql.app%2Fstatic%2Fexamples%2Fsessions%2Fhyper-explain%2Fdashql-session.json',
        );

        act(() => (document.querySelector('[aria-label="Add Explain session"]') as HTMLButtonElement).click());
        expect(dispatchSessionUrl).toHaveBeenCalledWith(
            new URL('/static/examples/sessions/hyper-explain/dashql-session.json', globalThis.location.href).toString(),
        );
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
});
