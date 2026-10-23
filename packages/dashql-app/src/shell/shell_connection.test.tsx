import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';

import { ConnectionHealth } from '../app/connections/connection_state.js';
import { ConnectionRegistry, useConnectionRegistry } from '../app/connections/connection_registry.js';
import { EXECUTE_QUERY, QUERY_SUCCEEDED, QueryExecutionStatus, QueryType, createQueryExecutionState } from '../query/query_execution_state.js';
import {
    SHELL_DATABASE_ID,
    ShellConnectionProvider,
    useShellConnection,
} from './shell_connection.js';

describe('ShellConnectionProvider', () => {
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

    it('publishes shell connection and query state through the shared registry', () => {
        let shell: ReturnType<typeof useShellConnection> | null = null;
        let registry: ReturnType<typeof useConnectionRegistry>[0] | null = null;
        const Probe = () => {
            shell = useShellConnection();
            [registry] = useConnectionRegistry();
            return null;
        };

        act(() => root.render(
            <ConnectionRegistry>
                <ShellConnectionProvider>
                    <Probe />
                </ShellConnectionProvider>
            </ConnectionRegistry>
        ));

        expect(registry!.connections.get(SHELL_DATABASE_ID)?.connectionHealth).toBe(ConnectionHealth.NOT_STARTED);

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
            shell!.setConnected(true);
            shell!.queryExecutions.dispatch({ type: EXECUTE_QUERY, value: [query.queryId, query] });
            shell!.queryExecutions.dispatch({ type: QUERY_SUCCEEDED, value: [query.queryId] });
        });

        const connection = registry!.connections.get(SHELL_DATABASE_ID)!;
        expect(connection.connectionHealth).toBe(ConnectionHealth.ONLINE);
        expect(connection.queriesActive.size).toBe(0);
        expect(connection.queriesFinished.get(query.queryId)).toMatchObject({
            queryText: 'SELECT 1',
            status: QueryExecutionStatus.SUCCEEDED,
        });
    });
});
