import {
    createQueryExecutionMetrics,
    type QueryExecutionAction,
    type QueryExecutionHistoryState,
    type QueryExecutionState,
    type QueryExecutionTracker,
    reduceQueryAction,
} from '../query/query_execution_state.js';

export const SHELL_QUERY_HISTORY_LIMIT = 100;

export class ShellQueryExecutionTracker implements QueryExecutionTracker {
    private state: QueryExecutionHistoryState = {
        queriesActive: new Map(),
        queriesActiveOrdered: [],
        queriesFinished: new Map(),
        queriesFinishedOrdered: [],
        snapshotQueriesActiveFinished: 1,
        metrics: createQueryExecutionMetrics(),
    };
    private snapshot: readonly QueryExecutionState[] = [];
    private readonly listeners = new Set<() => void>();

    readonly getSnapshot = (): readonly QueryExecutionState[] => this.snapshot;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    dispatch(action: QueryExecutionAction): void {
        this.state = reduceQueryAction(this.state, action);
        while (this.state.queriesFinishedOrdered.length + this.state.queriesActiveOrdered.length > SHELL_QUERY_HISTORY_LIMIT) {
            const finishedQueryId = this.state.queriesFinishedOrdered.shift();
            if (finishedQueryId != null) {
                this.state.queriesFinished.delete(finishedQueryId);
                continue;
            }
            const activeQueryId = this.state.queriesActiveOrdered.shift();
            if (activeQueryId != null) this.state.queriesActive.delete(activeQueryId);
        }
        this.snapshot = [
            ...this.state.queriesFinishedOrdered.flatMap(queryId => {
                const execution = this.state.queriesFinished.get(queryId);
                return execution == null ? [] : [execution];
            }),
            ...this.state.queriesActiveOrdered.flatMap(queryId => {
                const execution = this.state.queriesActive.get(queryId);
                return execution == null ? [] : [execution];
            }),
        ];
        for (const listener of this.listeners) listener();
    }
}
