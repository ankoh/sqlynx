import * as React from 'react';

import { ComputeQueryExecutionProvider } from '../compute/computation_query_execution.js';
import {
    COLUMN_AGGREGATION_TASK,
    DATA_SEARCH_TASK,
    FILTERED_COLUMN_AGGREGATION_TASK,
    SYSTEM_COLUMN_COMPUTATION_TASK,
    TABLE_AGGREGATION_TASK,
    TABLE_FILTERING_TASK,
    TABLE_ORDERING_TASK,
    type TaskVariant,
} from '../compute/computation_types.js';
import { QueryType } from '../query/query_execution_state.js';
import { executeTrackedQuery } from '../query/tracked_query_execution.js';
import { useShellConnection } from './shell_connection.js';

const LOG_CTX = 'scheduler';

export function ShellComputeQueryExecutionProvider(props: React.PropsWithChildren) {
    const { queryExecutions } = useShellConnection();
    const createExecution = React.useCallback((task: TaskVariant) => {
        return <T,>(query: string, execute: () => Promise<T>) => executeTrackedQuery({
            query,
            tracker: queryExecutions,
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
    }, [queryExecutions]);

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
