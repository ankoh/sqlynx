import * as React from 'react';

import type { QueryExecutionState } from '../query/query_execution_state.js';
import type { ShellQueryExecutionTracker } from '../shell/query_execution.js';

export function useShellQueryResult(queryExecutions: ShellQueryExecutionTracker) {
    const [resultQuery, setResultQuery] = React.useState<QueryExecutionState | null>(null);
    const showResultQuery = React.useCallback((queryId: number) => {
        const query = queryExecutions.getSnapshot().find(candidate => candidate.queryId === queryId) ?? null;
        setResultQuery(query);
    }, [queryExecutions]);
    const closeResultQuery = React.useCallback(() => setResultQuery(null), []);

    return { resultQuery, showResultQuery, closeResultQuery };
}
