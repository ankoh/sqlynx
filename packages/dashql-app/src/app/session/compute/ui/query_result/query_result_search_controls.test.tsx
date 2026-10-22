import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

import { createResultSearchState } from '../../../../../compute/computation_types.js';
import { QueryResultSearchControls } from './query_result_search_controls.js';

describe('QueryResultSearchControls', () => {
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

    it('replaces each button with a search-icon input', () => {
        act(() => root.render(
            <QueryResultSearchControls
                columnSearch={createResultSearchState()}
                dataSearch={createResultSearchState()}
                onColumnPatternChange={() => {}}
                onDataPatternChange={() => {}}
                columnMatchCount={null}
                dataMatchCount={null}
            />,
        ));
        const buttons = Array.from(container.querySelectorAll('button'));
        act(() => buttons.find(button => button.textContent?.includes('Columns'))!.click());
        expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('Columns'))).toBe(false);
        const columnInput = container.querySelector('input[aria-label="Search columns"]');
        expect(columnInput).not.toBeNull();
        expect(columnInput?.getAttribute('placeholder')).toBe('Search columns');
        expect(container.querySelector('button[aria-label="Close columns search"]')).not.toBeNull();

        const dataButton = Array.from(container.querySelectorAll('button'))
            .find(button => button.textContent?.includes('Data'))!;
        act(() => dataButton.click());
        expect(container.querySelector('input[aria-label="Search data"]')).not.toBeNull();
        expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('Data'))).toBe(false);
    });

    it('collapses an empty input when it loses focus', () => {
        act(() => root.render(
            <QueryResultSearchControls
                columnSearch={createResultSearchState()}
                dataSearch={createResultSearchState()}
                onColumnPatternChange={() => {}}
                onDataPatternChange={() => {}}
                columnMatchCount={null}
                dataMatchCount={null}
            />,
        ));
        const columnsButton = Array.from(container.querySelectorAll('button'))
            .find(button => button.textContent?.includes('Columns'))!;
        act(() => columnsButton.click());
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Search columns"]')!;
        act(() => input.blur());
        expect(container.querySelector('input[aria-label="Search columns"]')).toBeNull();
        expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('Columns'))).toBe(true);
    });

    it('keeps an active search visible when Escape is pressed', () => {
        const columnSearch = { ...createResultSearchState(), requestedPattern: 'customer' };
        act(() => root.render(
            <QueryResultSearchControls
                columnSearch={columnSearch}
                dataSearch={createResultSearchState()}
                onColumnPatternChange={() => {}}
                onDataPatternChange={() => {}}
                columnMatchCount={2}
                dataMatchCount={null}
            />,
        ));
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Search columns"]')!;
        act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(container.querySelector('input[aria-label="Search columns"]')).not.toBeNull();
        expect(container.querySelector('[role="status"]')?.textContent).toContain('2 matching columns');
    });

    it('starts expanded when remounted with an active Data search', () => {
        const dataSearch = { ...createResultSearchState(), requestedPattern: 'customer' };

        act(() => root.render(
            <QueryResultSearchControls
                columnSearch={createResultSearchState()}
                dataSearch={dataSearch}
                onColumnPatternChange={() => {}}
                onDataPatternChange={() => {}}
                columnMatchCount={null}
                dataMatchCount={2}
            />,
        ));

        expect(container.querySelector<HTMLInputElement>('input[aria-label="Search data"]')?.value).toBe('customer');
        expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('Data'))).toBe(false);
    });

    it('clears and collapses an active search from its close button', () => {
        const onColumnPatternChange = vi.fn();
        const columnSearch = { ...createResultSearchState(), requestedPattern: 'customer' };
        act(() => root.render(
            <QueryResultSearchControls
                columnSearch={columnSearch}
                dataSearch={createResultSearchState()}
                onColumnPatternChange={onColumnPatternChange}
                onDataPatternChange={() => {}}
                columnMatchCount={2}
                dataMatchCount={null}
            />,
        ));
        const clearButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close columns search"]')!;

        act(() => clearButton.click());

        expect(onColumnPatternChange).toHaveBeenCalledWith('');
        expect(container.querySelector('input[aria-label="Search columns"]')).toBeNull();
        expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('Columns'))).toBe(true);
    });
});
