import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResizeObserverMock } from '../../tests/mocks/view_mocks.js';
import { getVerticalScrollOverflow, VerticalScrollShadows } from './vertical_scroll_shadows.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

interface ScrollMetrics {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}

const TestHost: React.FC<{ metrics: ScrollMetrics }> = ({ metrics }) => {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const getScrollElement = React.useCallback(() => scrollRef.current, []);
    const setScrollElement = React.useCallback((element: HTMLDivElement | null) => {
        scrollRef.current = element;
        if (element == null) return;
        Object.defineProperties(element, {
            clientHeight: { configurable: true, get: () => metrics.clientHeight },
            scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
            scrollTop: {
                configurable: true,
                get: () => metrics.scrollTop,
                set: value => { metrics.scrollTop = value; },
            },
        });
    }, [metrics]);
    return (
        <div>
            <div ref={setScrollElement} />
            <VerticalScrollShadows getScrollElement={getScrollElement} />
        </div>
    );
};

describe('VerticalScrollShadows', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', ResizeObserverMock);
        ResizeObserverMock.reset();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('handles fractional positions at the scroll boundaries', () => {
        expect(getVerticalScrollOverflow({ clientHeight: 100, scrollHeight: 100, scrollTop: 0 })).toEqual({ top: false, bottom: false });
        expect(getVerticalScrollOverflow({ clientHeight: 100, scrollHeight: 200, scrollTop: 0 })).toEqual({ top: false, bottom: true });
        expect(getVerticalScrollOverflow({ clientHeight: 100, scrollHeight: 200, scrollTop: 50 })).toEqual({ top: true, bottom: true });
        expect(getVerticalScrollOverflow({ clientHeight: 100, scrollHeight: 200.5, scrollTop: 100 })).toEqual({ top: true, bottom: false });
    });

    it('updates shadows as content overflows and the viewport scrolls', () => {
        const metrics = { clientHeight: 100, scrollHeight: 100, scrollTop: 0 };
        act(() => root.render(<TestHost metrics={metrics} />));
        const scroller = container.firstElementChild?.firstElementChild as HTMLDivElement;
        const top = container.querySelector('[data-scroll-shadow="top"]') as HTMLElement;
        const bottom = container.querySelector('[data-scroll-shadow="bottom"]') as HTMLElement;

        expect(top.dataset.visible).toBe('false');
        expect(bottom.dataset.visible).toBe('false');

        metrics.scrollHeight = 200;
        act(() => ResizeObserverMock.triggerAll());
        expect(top.dataset.visible).toBe('false');
        expect(bottom.dataset.visible).toBe('true');

        metrics.scrollTop = 50;
        act(() => scroller.dispatchEvent(new Event('scroll')));
        expect(top.dataset.visible).toBe('true');
        expect(bottom.dataset.visible).toBe('true');

        metrics.scrollTop = 100;
        act(() => scroller.dispatchEvent(new Event('scroll')));
        expect(top.dataset.visible).toBe('true');
        expect(bottom.dataset.visible).toBe('false');
    });
});
