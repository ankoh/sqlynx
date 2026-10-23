import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';

import { ResizeObserverMock } from '../tests/mocks/view_mocks.js';
import { ShellNavBar } from './shell_navbar.js';

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

const EmptyInternals = () => null;

describe('ShellNavBar', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('resets the shell when the Hyper logo is clicked', () => {
        const onReset = vi.fn();
        act(() => root.render(
            <ShellNavBar engineVersion="1.0.0" onReset={onReset} Internals={EmptyInternals} />,
        ));

        const resetButton = container.querySelector<HTMLButtonElement>('button[aria-label="Reset shell"]');
        expect(resetButton).not.toBeNull();
        act(() => resetButton!.click());

        expect(onReset).toHaveBeenCalledOnce();
    });
});
