import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';

import { ConnectionRegistry, useConnectionRegistry } from '../app/connections/connection_registry.js';
import { useCreateComputeQueryExecution } from '../compute/computation_query_execution.js';
import { TABLE_AGGREGATION_TASK, type TaskVariant } from '../compute/computation_types.js';
import { QueryExecutionStatus, QueryType } from '../query/query_execution_state.js';
import { ShellComputeQueryExecutionProvider } from './computation_query_execution.js';
import { ShellConnectionProvider, useShellConnection } from './shell_connection.js';

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
        let shell: ReturnType<typeof useShellConnection> | null = null;
        let registry: ReturnType<typeof useConnectionRegistry>[0] | null = null;
        const Probe = () => {
            createExecution = useCreateComputeQueryExecution();
            shell = useShellConnection();
            [registry] = useConnectionRegistry();
            return null;
        };

        act(() => root.render(
            <ConnectionRegistry>
                <ShellConnectionProvider>
                    <ShellComputeQueryExecutionProvider>
                        <Probe />
                    </ShellComputeQueryExecutionProvider>
                </ShellConnectionProvider>
            </ConnectionRegistry>,
        ));

        const task = {
            type: TABLE_AGGREGATION_TASK,
            value: { tableId: 1 },
        } as TaskVariant;
        await act(async () => {
            await createExecution!(task)('SELECT count(*) FROM input', async () => 42);
        });

        expect(shell!.queryExecutions.getSnapshot()).toMatchObject([{
            queryText: 'SELECT count(*) FROM input',
            queryMetadata: {
                queryType: QueryType.INTERNAL_SQLFRAME,
                title: 'Table aggregation',
                issuer: 'SQLFrame',
            },
            status: QueryExecutionStatus.SUCCEEDED,
        }]);
        expect([...registry!.connections.values()][0].queriesFinished.size).toBe(1);
    });
});
