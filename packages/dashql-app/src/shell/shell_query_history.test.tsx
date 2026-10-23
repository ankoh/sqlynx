import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';

import { EXECUTE_QUERY, QUERY_SUCCEEDED, QueryExecutionStatus, QueryType, createQueryExecutionState } from '../query/query_execution_state.js';
import {
    SHELL_DATABASE_ID,
    ShellQueryHistoryProvider,
    shellQueryEntries,
    useShellQueryHistory,
} from './shell_query_history.js';

describe('ShellQueryHistoryProvider', () => {
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

    it('lists the queries of the shell as entries of the query history', () => {
        let history: ReturnType<typeof useShellQueryHistory> | null = null;
        const Probe = () => {
            history = useShellQueryHistory();
            return null;
        };

        act(() => root.render(
            <ShellQueryHistoryProvider>
                <Probe />
            </ShellQueryHistoryProvider>
        ));

        const query = createQueryExecutionState(
            1,
            1,
            'SELECT 1',
            {
                queryType: QueryType.USER_PROVIDED,
                title: 'Shell Query',
                description: null,
                issuer: 'DashQL Shell',
                userProvided: true,
            },
            new AbortController(),
        );
        act(() => {
            history!.dispatch({ type: EXECUTE_QUERY, value: [query.queryId, query] });
            history!.dispatch({ type: QUERY_SUCCEEDED, value: [query.queryId] });
        });

        const entries = shellQueryEntries(history!.getSnapshot());
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ connectionId: SHELL_DATABASE_ID, sourceName: 'Hyper', queryId: query.queryId });
        expect(entries[0].query).toMatchObject({
            queryText: 'SELECT 1',
            status: QueryExecutionStatus.SUCCEEDED,
        });
    });
});
