import * as React from 'react';

import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';

import { JsonView } from './json_view.js';

describe('JsonView array pagination', () => {
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

    it('renders large arrays incrementally', () => {
        const value = Array.from({ length: 250 }, (_, index) => index);
        act(() => root.render(<JsonView value={value} arrayPageSize={100} />));

        const loadMore = Array.from(container.querySelectorAll('button'))
            .find(button => button.textContent?.includes('Show 100 more'));
        expect(loadMore).toBeDefined();
        expect(container.textContent).not.toContain('249');

        act(() => loadMore!.click());
        expect(container.textContent).toContain('199');
        expect(container.textContent).not.toContain('249');
    });

    it('paginates nested arrays independently', () => {
        const value = { embedding: Array.from({ length: 250 }, (_, index) => index) };
        act(() => root.render(<JsonView value={value} arrayPageSize={100} />));

        expect(container.textContent).toContain('Show 100 more (150 remaining)');
        expect(container.textContent).not.toContain('249');
    });

    it('opts out of enclosing Electron drag regions', () => {
        act(() => root.render(<JsonView value={{ nested: true }} />));

        expect(container.firstElementChild?.getAttribute('data-electron-drag-region')).toBe('false');
    });

    it('collapses nested values below a numeric depth', () => {
        const value = { a: { b: { c: { d: 'deep' } } } };
        act(() => root.render(<JsonView value={value} collapsed={2} />));

        expect(container.textContent).toContain('c');
        expect(container.textContent).not.toContain('deep');
        const collapsedButtons = container.querySelectorAll('button[aria-expanded="false"]');
        expect(collapsedButtons.length).toBe(1);

        act(() => (collapsedButtons[0] as HTMLButtonElement).click());
        expect(container.textContent).toContain('deep');
    });
});
