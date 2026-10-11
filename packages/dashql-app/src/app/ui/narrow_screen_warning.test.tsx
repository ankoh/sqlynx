import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNarrowScreenWarning } from './narrow_screen_warning.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function ScreenGate(props: { ready?: boolean; enabled?: boolean }) {
    const warning = useNarrowScreenWarning(props.ready ?? true, props.enabled ?? false);
    return <div>{warning ? 'warning' : 'app'}</div>;
}

describe('Narrow screen warning', () => {
    let container: HTMLDivElement;
    let root: Root;
    let width: number;
    let media: MediaQueryList;
    let listeners: Set<() => void>;
    let matchMedia: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        width = 390;
        listeners = new Set();
        media = {
            get matches() { return width < 800; },
            addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
            removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        } as unknown as MediaQueryList;
        matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue(media);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        matchMedia.mockRestore();
    });

    it('warns below the compact layout breakpoint and updates when resized', () => {
        act(() => root.render(<ScreenGate />));
        expect(matchMedia).toHaveBeenCalledWith('(max-width: 799px)');
        expect(container.textContent).toBe('warning');

        act(() => {
            width = 800;
            listeners.forEach(update => update());
        });
        expect(container.textContent).toBe('app');

        act(() => {
            width = 799;
            listeners.forEach(update => update());
        });
        expect(container.textContent).toBe('warning');
    });

    it('waits for persisted settings and respects the narrow screen override', () => {
        act(() => root.render(<ScreenGate ready={false} />));
        expect(container.textContent).toBe('app');
        act(() => root.render(<ScreenGate enabled />));
        expect(container.textContent).toBe('app');
        act(() => root.render(<ScreenGate />));
        expect(container.textContent).toBe('warning');
        act(() => root.render(<ScreenGate enabled />));
        expect(container.textContent).toBe('app');
    });

    it('removes the media query listener on unmount', () => {
        act(() => root.render(<ScreenGate />));
        expect(listeners.size).toBe(1);
        act(() => root.render(null));
        expect(listeners.size).toBe(0);
    });
});
