import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';

import { fakeReactWindowModule, ResizeObserverMock } from '../../../../test/view_mocks.js';

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

import { createQueryExecutionState, QueryType } from '../query_execution_state.js';
import {
    getQueryTarget,
    QueryHistoryViewer,
    type QueryHistoryViewerDependencies,
    QueryTarget,
    type QueryEntry,
} from './query_viewer.js';

const dependencies = fakeReactWindowModule(React, vi.fn()) as QueryHistoryViewerDependencies;

function createExecution(queryType: QueryType, userProvided: boolean) {
    return createQueryExecutionState(
        1,
        1,
        'SELECT 1',
        {
            queryType,
            title: 'Shell Query',
            description: null,
            issuer: 'DashQL Shell',
            userProvided,
        },
        new AbortController(),
    );
}

describe('QueryHistoryViewer', () => {
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

    it('classifies connection and memory query targets', () => {
        expect(getQueryTarget(createExecution(QueryType.USER_PROVIDED, true))).toBe(QueryTarget.CONNECTION);
        expect(getQueryTarget(createExecution(QueryType.INTERNAL_SQLFRAME, false))).toBe(QueryTarget.MEMORY);
        expect(QueryTarget.CONNECTION).toBe('Attached');
    });

    it('shows query targets', () => {
        const query = createExecution(QueryType.INTERNAL_SQLFRAME, false);
        const entries: QueryEntry[] = [{
            connectionId: 'shell',
            sourceName: 'Hyper',
            target: QueryTarget.MEMORY,
            queryId: query.queryId,
            query,
        }];

        act(() => root.render(<QueryHistoryViewer entries={entries} onClose={() => {}} dependencies={dependencies} />));

        expect(container.textContent).toContain('Source');
        expect(container.textContent).toContain('Target');
        expect(container.textContent).toContain('Hyper');
        expect(container.textContent).toContain('Memory');
        expect(container.textContent).toContain('Title');
        expect(container.textContent).toContain('Shell Query');
    });
});
