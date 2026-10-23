import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    EXECUTE_QUERY,
    QUERY_SUCCEEDED,
    createQueryExecutionState,
    QueryType,
} from '../query/query_execution_state.js';
import { SHELL_QUERY_HISTORY_LIMIT, ShellQueryExecutionTracker } from '../shell/query_execution.js';
import { useShellQueryResult } from './use_shell_query_result.js';

function createExecution(queryId: number) {
    return createQueryExecutionState(
        queryId,
        queryId,
        `SELECT ${queryId}`,
        {
            queryType: QueryType.USER_PROVIDED,
            title: 'Shell Query',
            description: null,
            issuer: 'DashQL Shell',
            userProvided: true,
        },
        new AbortController(),
    );
}

describe('useShellQueryResult', () => {
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

    it('keeps the open result after shell history evicts its query', () => {
        const tracker = new ShellQueryExecutionTracker();
        tracker.dispatch({ type: EXECUTE_QUERY, value: [1, createExecution(1)] });
        tracker.dispatch({ type: QUERY_SUCCEEDED, value: [1] });

        let result!: ReturnType<typeof useShellQueryResult>;
        const Harness = () => {
            result = useShellQueryResult(tracker);
            return null;
        };
        act(() => root.render(<Harness />));
        act(() => result.showResultQuery(1));

        for (let queryId = 2; queryId <= SHELL_QUERY_HISTORY_LIMIT + 1; ++queryId) {
            tracker.dispatch({ type: EXECUTE_QUERY, value: [queryId, createExecution(queryId)] });
            tracker.dispatch({ type: QUERY_SUCCEEDED, value: [queryId] });
        }

        expect(tracker.getSnapshot().some(query => query.queryId === 1)).toBe(false);
        expect(result.resultQuery?.queryId).toBe(1);

        act(() => result.closeResultQuery());
        expect(result.resultQuery).toBeNull();
    });
});
