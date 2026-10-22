import * as React from 'react';
import * as arrow from 'apache-arrow';
import type * as dashql from '@ankoh/dashql-core';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

import { QueryExecutionStatus } from '../connections/query_execution_state.js';
import {
    ShellQueryResultOverlay,
    type ShellQueryResultOverlayDependencies,
} from './shell_query_result_overlay.js';

const dependencies: ShellQueryResultOverlayDependencies = {
    QueryResultDetails: () => <div aria-label="Query results panel" style={{ height: 240 }}>Query results</div>,
    useHyperPlan: (planText: string | null) => ({
        plan: planText?.includes('executiontarget')
            ? { read: () => ({}) } as unknown as dashql.FlatBufferPtr<dashql.buffers.view.PlanViewModel>
            : null,
        rejected: planText != null && !planText.includes('executiontarget'),
    }),
    PlanView: () => <div aria-label="Query plan viewer">Query plan viewer</div>,
};

describe('ShellQueryResultOverlay', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        act(() => root.unmount());
        container.remove();
        document.getElementById('__dashqlPortalRoot__')?.remove();
    });

    it('does not dismiss on outside mouse events when disabled', () => {
        const onClose = vi.fn();
        act(() => root.render(
            <ShellQueryResultOverlay
                query={{ queryId: 42, status: QueryExecutionStatus.SUCCEEDED } as any}
                onClose={onClose}
                dismissOnClickOutside={false}
                dependencies={dependencies}
            />,
        ));

        act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));

        expect(onClose).not.toHaveBeenCalled();
        expect(document.querySelector('[aria-label="Shell query results"]')).not.toBeNull();
    });

    it('retains outside mouse dismissal by default', () => {
        const onClose = vi.fn();
        act(() => root.render(
            <ShellQueryResultOverlay
                query={{ queryId: 42, status: QueryExecutionStatus.SUCCEEDED } as any}
                onClose={onClose}
                dependencies={dependencies}
            />,
        ));

        act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));

        expect(onClose).toHaveBeenCalledOnce();
    });

    it('initially focuses the dialog rather than its close button', () => {
        act(() => root.render(
            <ShellQueryResultOverlay
                query={{ queryId: 42, status: QueryExecutionStatus.SUCCEEDED } as any}
                onClose={vi.fn()}
                dependencies={dependencies}
            />,
        ));

        expect(document.activeElement).toBe(document.querySelector('[aria-label="Shell query results"]'));
    });

    it('adds and selects a Plan tab for a valid 1x1 plan result', () => {
        const plan = '{"operator":"executiontarget","operatorId":1}';
        act(() => root.render(
            <ShellQueryResultOverlay
                query={{
                    queryId: 42,
                    status: QueryExecutionStatus.SUCCEEDED,
                    resultTable: arrow.tableFromArrays({ value: [plan] }),
                } as any}
                onClose={vi.fn()}
                dependencies={dependencies}
            />,
        ));

        const planButton = document.querySelector<HTMLButtonElement>('button[aria-label="Query plan"]')!;
        const resultsButton = document.querySelector<HTMLButtonElement>('button[aria-label="Query results"]')!;
        expect(planButton.getAttribute('aria-current')).toBe('page');
        expect(resultsButton.getAttribute('aria-current')).toBeNull();
        expect(document.querySelector('[aria-label="Query plan viewer"]')).not.toBeNull();
        expect(document.querySelector('[aria-label="Query results panel"]')).toBeNull();
        expect(document.querySelector<HTMLElement>('[aria-label="Shell query results"]')!.style.minHeight)
            .toBe('min(360px, 80vh)');

        act(() => resultsButton.click());
        expect(resultsButton.getAttribute('aria-current')).toBe('page');
        expect(planButton.getAttribute('aria-current')).toBeNull();
        expect(document.querySelector('[aria-label="Query results panel"]')).not.toBeNull();
        expect(document.querySelector('[aria-label="Query plan viewer"]')).toBeNull();
        expect(document.querySelector<HTMLElement>('[aria-label="Shell query results"]')!.style.minHeight).toBe('');

        act(() => planButton.click());
        expect(planButton.getAttribute('aria-current')).toBe('page');
        expect(resultsButton.getAttribute('aria-current')).toBeNull();
        expect(document.querySelector('[aria-label="Query plan viewer"]')).not.toBeNull();
        expect(document.querySelector('[aria-label="Query results panel"]')).toBeNull();
        expect(document.querySelector<HTMLElement>('[aria-label="Shell query results"]')!.style.minHeight)
            .toBe('min(360px, 80vh)');
    });

    it('keeps only the Data tab for ordinary 1x1 JSON results', () => {
        act(() => root.render(
            <ShellQueryResultOverlay
                query={{
                    queryId: 42,
                    status: QueryExecutionStatus.SUCCEEDED,
                    resultTable: arrow.tableFromArrays({ value: ['{"key":1}'] }),
                } as any}
                onClose={vi.fn()}
                dependencies={dependencies}
            />,
        ));

        expect(document.querySelector('button[aria-label="Query plan"]')).toBeNull();
        expect(document.querySelector('[aria-label="Query results panel"]')).not.toBeNull();
        expect(document.querySelector<HTMLElement>('[aria-label="Shell query results"]')!.style.height).toBe('');
    });

    it('expands the Plan tab to fill the window', () => {
        const plan = '{"operator":"executiontarget","operatorId":1}';
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 272 } as DOMRect);
        act(() => root.render(
            <ShellQueryResultOverlay
                query={{
                    queryId: 42,
                    status: QueryExecutionStatus.SUCCEEDED,
                    resultTable: arrow.tableFromArrays({ value: [plan] }),
                } as any}
                onClose={vi.fn()}
                dependencies={dependencies}
            />,
        ));

        const card = () => document.querySelector<HTMLElement>('[aria-label="Shell query results"]')!;
        const overlay = () => card().parentElement!;
        const sizeBefore = overlay().className;
        expect(card().style.height).toBe('272px');

        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Expand plan"]')!.click());
        const restore = document.querySelector<HTMLButtonElement>('button[aria-label="Restore plan size"]')!;
        expect(restore.getAttribute('aria-pressed')).toBe('true');
        expect(overlay().className).not.toBe(sizeBefore);
        expect(card().style.height).toBe('');
        expect(card().style.minHeight).toBe('');

        // The Data tab keeps its regular size
        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Query results"]')!.click());
        expect(overlay().className).toBe(sizeBefore);

        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Query plan"]')!.click());
        act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Restore plan size"]')!.click());
        expect(overlay().className).toBe(sizeBefore);
        expect(card().style.height).toBe('272px');
    });

    it('locks the initial result height before selecting the Plan tab', () => {
        const plan = '{"operator":"executiontarget","operatorId":1}';
        const getBoundingClientRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockReturnValue({ height: 272 } as DOMRect);

        act(() => root.render(
            <ShellQueryResultOverlay
                query={{
                    queryId: 42,
                    status: QueryExecutionStatus.SUCCEEDED,
                    resultTable: arrow.tableFromArrays({ value: [plan] }),
                } as any}
                onClose={vi.fn()}
                dependencies={dependencies}
            />,
        ));

        expect(document.querySelector<HTMLElement>('[aria-label="Shell query results"]')!.style.height).toBe('272px');
        expect(document.querySelector<HTMLElement>('[aria-label="Shell query results"]')!.style.minHeight)
            .toBe('min(360px, 80vh)');
        expect(getBoundingClientRect).toHaveBeenCalled();
    });
});
