import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';

import { useCreateComputeQueryExecution } from '../compute/computation_query_execution.js';
import { TABLE_AGGREGATION_TASK, type TaskVariant } from '../compute/computation_types.js';
import { QueryExecutionStatus, QueryType } from '../query/query_execution_state.js';
import { ShellComputeQueryExecutionProvider } from './computation_query_execution.js';
import { ShellQueryHistoryProvider, useShellQueryHistory } from './shell_query_history.js';

describe('ShellComputeQueryExecutionProvider', () => {
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

    it('tracks aggregation queries in the shell query history', async () => {
        let createExecution: ReturnType<typeof useCreateComputeQueryExecution> = null;
        let history: ReturnType<typeof useShellQueryHistory> | null = null;
        const Probe = () => {
            createExecution = useCreateComputeQueryExecution();
            history = useShellQueryHistory();
            return null;
        };

        act(() => root.render(
            <ShellQueryHistoryProvider>
                <ShellComputeQueryExecutionProvider>
                    <Probe />
                </ShellComputeQueryExecutionProvider>
            </ShellQueryHistoryProvider>,
        ));

        const task = {
            type: TABLE_AGGREGATION_TASK,
            value: { tableId: 1 },
        } as TaskVariant;
        await act(async () => {
            await createExecution!(task)('SELECT count(*) FROM input', async () => 42);
        });

        expect(history!.getSnapshot()).toMatchObject([{
            queryText: 'SELECT count(*) FROM input',
            queryMetadata: {
                queryType: QueryType.INTERNAL_SQLFRAME,
                title: 'Table aggregation',
                issuer: 'SQLFrame',
            },
            status: QueryExecutionStatus.SUCCEEDED,
        }]);
    });
});
