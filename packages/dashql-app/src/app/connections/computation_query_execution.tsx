import * as React from 'react';

import { ComputeQueryExecutionProvider } from '../../compute/computation_query_execution.js';
import {
    COLUMN_AGGREGATION_TASK,
    DATA_SEARCH_TASK,
    FILTERED_COLUMN_AGGREGATION_TASK,
    SYSTEM_COLUMN_COMPUTATION_TASK,
    TABLE_AGGREGATION_TASK,
    TABLE_FILTERING_TASK,
    TABLE_ORDERING_TASK,
    type TaskVariant,
} from '../../compute/computation_scheduler.js';
import { QueryType } from '../../query/query_execution_state.js';
import { executeTrackedQuery } from '../../query/tracked_query_execution.js';
import { useConnectionDispatch, useConnectionRegistryStore } from './connection_registry.js';

const LOG_CTX = 'scheduler';

export function SessionComputeQueryExecutionProvider(props: React.PropsWithChildren) {
    // Resolve the connection through the store when the task starts.
    // Every tracked compute query changes the registry, subscribing to it would re-create the execution factory
    // and re-render the scheduler for every query lifecycle event.
    const store = useConnectionRegistryStore();
    const dispatch = useConnectionDispatch();
    const createExecution = React.useCallback((task: TaskVariant) => {
        let connectionId: string | null = null;
        for (const [candidateId, connection] of store.current.connections) {
            if (connection.queriesActive.has(task.value.tableId) || connection.queriesFinished.has(task.value.tableId)) {
                connectionId = candidateId;
                break;
            }
        }
        return <T,>(query: string, execute: () => Promise<T>) => {
            if (connectionId == null) return execute();
            return executeTrackedQuery({
                query,
                tracker: { dispatch: action => dispatch(connectionId, action) },
                metadata: {
                    queryType: QueryType.INTERNAL_SQLFRAME,
                    title: getTaskQueryTitle(task),
                    description: null,
                    issuer: 'SQLFrame',
                    userProvided: false,
                },
                execute,
                errorTarget: LOG_CTX,
            });
        };
    }, [store, dispatch]);

    return (
        <ComputeQueryExecutionProvider createExecution={createExecution}>
            {props.children}
        </ComputeQueryExecutionProvider>
    );
}

function getTaskQueryTitle(task: TaskVariant): string {
    switch (task.type) {
        case COLUMN_AGGREGATION_TASK: return 'Column aggregation';
        case TABLE_FILTERING_TASK: return 'Table filtering';
        case TABLE_ORDERING_TASK: return 'Table ordering';
        case TABLE_AGGREGATION_TASK: return 'Table aggregation';
        case SYSTEM_COLUMN_COMPUTATION_TASK: return 'System column computation';
        case FILTERED_COLUMN_AGGREGATION_TASK: return 'Filtered column aggregation';
        case DATA_SEARCH_TASK: return 'Data search';
    }
}
