import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResizeObserverMock } from '../../tests/mocks/view_mocks.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

import { VerticalSplit } from './vertical_split.js';

function dispatchPointerEvent(target: EventTarget, type: string, init: PointerEventInit) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
    Object.defineProperties(event, {
        button: { value: init.button ?? 0 },
        clientY: { value: init.clientY ?? 0 },
        pointerId: { value: init.pointerId ?? 1 },
    });
    target.dispatchEvent(event);
}

describe('VerticalSplit', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        ResizeObserverMock.reset();
        container = document.createElement('div');
        container.style.height = '516px';
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    function renderSplit() {
        act(() => root.render(
            <VerticalSplit
                first={<div>Editor</div>}
                second={<div>Result</div>}
                defaultRatio={0.4}
                minFirstSize={120}
                minSecondSize={160}
                separatorLabel="Resize editor and result"
            />,
        ));
        const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
        const split = separator.parentElement!;
        split.getBoundingClientRect = () => ({
            x: 0,
            y: 100,
            top: 100,
            left: 0,
            right: 600,
            bottom: 616,
            width: 600,
            height: 516,
            toJSON: () => ({}),
        });
        act(() => ResizeObserverMock.triggerAll());
        return { separator, split };
    }

    it('exposes an adjustable separator with the initial ratio', () => {
        const { separator } = renderSplit();

        expect(separator.getAttribute('aria-label')).toBe('Resize editor and result');
        expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
        expect(separator.getAttribute('aria-valuenow')).toBe('40');
        expect(container.textContent).toContain('Editor');
        expect(container.textContent).toContain('Result');
    });

    it('resizes and clamps both panes while dragging', () => {
        const { separator } = renderSplit();

        act(() => {
            dispatchPointerEvent(separator, 'pointerdown', { pointerId: 4, clientY: 308 });
            dispatchPointerEvent(window, 'pointermove', { pointerId: 4, clientY: 508 });
        });
        expect(separator.getAttribute('aria-valuenow')).toBe('68');

        act(() => dispatchPointerEvent(window, 'pointerup', { pointerId: 4, clientY: 508 }));
    });

    it('supports keyboard resizing', () => {
        const { separator } = renderSplit();

        act(() => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
        expect(separator.getAttribute('aria-valuenow')).toBe('45');

        act(() => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
        expect(separator.getAttribute('aria-valuenow')).toBe('24');

        act(() => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
        expect(separator.getAttribute('aria-valuenow')).toBe('68');
    });

    it('restores the previous size after pointer cancellation', () => {
        const { separator } = renderSplit();

        act(() => {
            dispatchPointerEvent(separator, 'pointerdown', { pointerId: 7, clientY: 308 });
            dispatchPointerEvent(window, 'pointermove', { pointerId: 7, clientY: 508 });
            dispatchPointerEvent(window, 'pointercancel', { pointerId: 7, clientY: 508 });
        });

        expect(separator.getAttribute('aria-valuenow')).toBe('40');
    });

    it('swaps panel sizes on a click or tap without dragging', () => {
        const { separator } = renderSplit();

        act(() => {
            dispatchPointerEvent(separator, 'pointerdown', { pointerId: 9, clientY: 308 });
            dispatchPointerEvent(window, 'pointerup', { pointerId: 9, clientY: 308 });
        });

        expect(separator.getAttribute('aria-valuenow')).toBe('60');
    });
});
