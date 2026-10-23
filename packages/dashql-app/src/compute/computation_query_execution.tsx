import * as React from 'react';

import type { ComputeQueryExecution } from './computation_logic.js';
import type { TaskVariant } from './computation_types.js';

export type CreateComputeQueryExecution = (task: TaskVariant) => ComputeQueryExecution;

const COMPUTE_QUERY_EXECUTION_CTX = React.createContext<CreateComputeQueryExecution | null>(null);

export function ComputeQueryExecutionProvider(props: React.PropsWithChildren<{ createExecution: CreateComputeQueryExecution }>) {
    return (
        <COMPUTE_QUERY_EXECUTION_CTX.Provider value={props.createExecution}>
            {props.children}
        </COMPUTE_QUERY_EXECUTION_CTX.Provider>
    );
}

export function useCreateComputeQueryExecution(): CreateComputeQueryExecution | null {
    return React.useContext(COMPUTE_QUERY_EXECUTION_CTX);
}
