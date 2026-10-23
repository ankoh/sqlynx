import * as React from 'react';

import * as computationLogic from './computation_logic.js';

import { COLUMN_AGGREGATION_SUCCEEDED, ComputationAction, DATA_SEARCH_FAILED, DATA_SEARCH_SUCCEEDED, UNREGISTER_SCHEDULER_TASK, FILTERED_COLUMN_AGGREGATION_SUCCEEDED, SYSTEM_COLUMN_COMPUTATION_SUCCEEDED, TABLE_AGGREGATION_SUCCEEDED, TABLE_FILTERING_SUCCEEDED, TABLE_ORDERING_SUCCEDED, UPDATE_SCHEDULER_TASK } from './computation_state.js';
import { Dispatch } from '../utils/variant.js';
import { LoggableException, Logger, stringifyError } from '../platform/logger/logger.js';
import { createTrace } from '../platform/logger/trace_context.js';
import { TaskStatus, TaskProgress, TaskVariant, COLUMN_AGGREGATION_TASK, DATA_SEARCH_TASK, FILTERED_COLUMN_AGGREGATION_TASK, SYSTEM_COLUMN_COMPUTATION_TASK, TABLE_AGGREGATION_TASK, TABLE_FILTERING_TASK, TABLE_ORDERING_TASK } from "./computation_types.js";
import { useComputationRegistry } from "./computation_registry.js";
import { useLogger } from '../platform/logger/logger_provider.js';
import type { ComputeQueryExecution } from './computation_logic.js';
import { useCreateComputeQueryExecution } from './computation_query_execution.js';

const LOG_CTX = 'scheduler';

export const COMPUTATION_OPERATIONS = {
    computeColumnAggregates: computationLogic.computeColumnAggregates,
    computeFilteredColumnAggregates: computationLogic.computeFilteredColumnAggregates,
    computeSystemColumns: computationLogic.computeSystemColumns,
    computeTableAggregates: computationLogic.computeTableAggregates,
    filterTable: computationLogic.filterTable,
    searchData: computationLogic.searchData,
    sortTable: computationLogic.sortTable,
};

interface SchedulerState {
    /// Started tasks
    launched: Set<number>
}

export function ComputationScheduler(props: React.PropsWithChildren<{}>) {
    const logger = useLogger();
    const [computationState, dispatchComputation] = useComputationRegistry();
    const createQueryExecution = useCreateComputeQueryExecution();

    const schedulerState = React.useRef<SchedulerState>({ launched: new Set() });
    React.useEffect(() => {
        const launched = schedulerState.current.launched!;
        for (const [taskId, task] of Object.entries(computationState.schedulerTasks)) {
            const id = +taskId;
            // Already processed?
            if (launched.has(id)) {
                continue;
            }
            // Launch the task
            launched.add(id);

            // Process a task asynchronously
            processTask(task, dispatchComputation, logger, createQueryExecution?.(task));
        }
        // Cleanup tasks that are no longer in included in the background tasks
        for (const l of launched) {
            if (computationState.schedulerTasks[l] === undefined) {
                launched.delete(l);
            }
        }
    });

    return props.children;
}

export async function processTask(
    task: TaskVariant,
    dispatchComputation: Dispatch<ComputationAction>,
    logger: Logger,
    executeQuery?: ComputeQueryExecution,
) {
    if (task.taskId === undefined) {
        logger.warn("Task has no task id", {
            taskId: task.taskId,
            taskType: getTaskVariantName(task)
        }, LOG_CTX);
        return;
    }

    // Start a trace for this task
    const traced = logger.withTrace(createTrace());

    let progress: TaskProgress = {
        status: TaskStatus.TASK_RUNNING,
        startedAt: new Date(),
        completedAt: null,
        failedAt: null,
        failedWithError: null
    };
    try {
        // Mark the task as running
        dispatchComputation({
            type: UPDATE_SCHEDULER_TASK,
            value: [task, progress]
        });

        // Process task
        switch (task.type) {
            case TABLE_FILTERING_TASK: {
                // Filter the table
                const filter = await COMPUTATION_OPERATIONS.filterTable(task.value, traced, executeQuery);
                // Mark as succeeded
                dispatchComputation({
                    type: TABLE_FILTERING_SUCCEEDED,
                    value: [task.value.tableId, task.value.tableVersion, filter]
                });
                // Resolve the promise
                task.result.resolve(filter);
                break;
            }
            case TABLE_ORDERING_TASK: {
                // Sort the table
                const ordered = await COMPUTATION_OPERATIONS.sortTable(task.value, traced, executeQuery);
                // Mark as succeeded
                dispatchComputation({
                    type: TABLE_ORDERING_SUCCEDED,
                    value: [task.value.tableId, ordered]
                });
                // Resolve the promise
                task.result.resolve(ordered);
                break;
            }
            case DATA_SEARCH_TASK: {
                const searchTable = await COMPUTATION_OPERATIONS.searchData(task.value, traced, executeQuery);
                dispatchComputation({
                    type: DATA_SEARCH_SUCCEEDED,
                    value: [task.value.tableId, task.value.inputDataFrame, task.value.requestId, searchTable],
                });
                task.result.resolve(searchTable);
                break;
            }
            case TABLE_AGGREGATION_TASK: {
                // Aggregate the table
                const [tableAgg, colEntries] = await COMPUTATION_OPERATIONS.computeTableAggregates(task.value, traced, executeQuery);
                // Mark as succeeded
                dispatchComputation({
                    type: TABLE_AGGREGATION_SUCCEEDED,
                    value: [task.value.tableId, tableAgg]
                });
                // Resolve the promise
                task.result.resolve([tableAgg, colEntries]);
                break;
            }
            case SYSTEM_COLUMN_COMPUTATION_TASK: {
                // Compute the system columns
                const [table, dataFrame, columnGroups] = await COMPUTATION_OPERATIONS.computeSystemColumns(task.value, traced, executeQuery);
                // Mark as succeeded
                dispatchComputation({
                    type: SYSTEM_COLUMN_COMPUTATION_SUCCEEDED,
                    value: [task.value.tableId, table, dataFrame, columnGroups]
                });
                // Resolve the promise
                task.result.resolve([table, dataFrame, columnGroups]);
                break;
            }
            case COLUMN_AGGREGATION_TASK:
                // Compute column aggregates
                const columnAgg = await COMPUTATION_OPERATIONS.computeColumnAggregates(task.value, traced, executeQuery);
                // Mark as succeeded
                dispatchComputation({
                    type: COLUMN_AGGREGATION_SUCCEEDED,
                    value: [task.value.tableId, task.value.columnId, columnAgg]
                });
                // Resolve the task
                task.result.resolve(columnAgg);
                break;
            case FILTERED_COLUMN_AGGREGATION_TASK:
                // Filtered column aggregates
                const filteredColumnAgg = await COMPUTATION_OPERATIONS.computeFilteredColumnAggregates(task.value, traced, executeQuery);
                // Mark as succeeded
                dispatchComputation({
                    type: FILTERED_COLUMN_AGGREGATION_SUCCEEDED,
                    value: [task.value.tableId, task.value.columnId, task.value.tableVersion, filteredColumnAgg]
                });
                // Resolve the task
                task.result.resolve(filteredColumnAgg);
                break;
        }
    } catch (e: any) {
        if (task.type === DATA_SEARCH_TASK) {
            dispatchComputation({
                type: DATA_SEARCH_FAILED,
                value: [task.value.tableId, task.value.inputDataFrame, task.value.requestId, stringifyError(e)],
            });
        }
        let loggable: LoggableException = (e instanceof LoggableException)
            ? e
            : new LoggableException("Failed to execute task", { error: stringifyError(e) }, LOG_CTX);

        // Mark the task as failed
        progress = {
            ...progress,
            status: TaskStatus.TASK_FAILED,
            failedAt: new Date(),
            failedWithError: loggable,
        }
        // Register as failed
        dispatchComputation({
            type: UPDATE_SCHEDULER_TASK,
            value: [task, progress]
        });
        // Reject for users
        task.result.reject(e);
        dispatchComputation({
            type: UNREGISTER_SCHEDULER_TASK,
            value: task,
        });
        return;
    }

    // Remove the task from the scheduler
    dispatchComputation({
        type: UNREGISTER_SCHEDULER_TASK,
        value: task
    });
}

function getTaskVariantName(task: TaskVariant): string {
    switch (task.type) {
        case COLUMN_AGGREGATION_TASK:
            return "column_aggregation";
        case TABLE_FILTERING_TASK:
            return "table_filtering";
        case TABLE_ORDERING_TASK:
            return "table_ordering";
        case TABLE_AGGREGATION_TASK:
            return "table_aggregation";
        case SYSTEM_COLUMN_COMPUTATION_TASK:
            return "system_column";
        case FILTERED_COLUMN_AGGREGATION_TASK:
            return "filtered_column_aggregation"
        case DATA_SEARCH_TASK:
            return "data_search";
    }
}
