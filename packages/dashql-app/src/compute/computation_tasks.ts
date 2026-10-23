import { AsyncValue } from '../utils/async_value.js';
import { TaskVariant } from './computation_types.js';
import { ComputationAction, SCHEDULE_TASK } from './computation_state.js';
import { Dispatch } from '../utils/variant.js';
import { LoggableException } from '../platform/logger/logger.js';

/// Executes the query of a task, e.g. to track it as a query of the connection of the table
export type ComputeQueryExecution = <T>(queryText: string, execute: () => Promise<T>) => Promise<T>;

/// Execute the query of a task without tracking it
export const executeDirectly: ComputeQueryExecution = (_queryText, execute) => execute();

/// The task variant of a task type
type TaskOf<T extends TaskVariant['type']> = Extract<TaskVariant, { type: T }>;
/// The result of a task type
type TaskResultOf<T extends TaskVariant['type']> = TaskOf<T>['result'] extends AsyncValue<infer R, LoggableException> ? R : never;

/// Schedule a task with the scheduler and wait for its result
export function scheduleTask<T extends TaskVariant['type']>(type: T, task: TaskOf<T>['value'], dispatch: Dispatch<ComputationAction>): Promise<TaskResultOf<T>> {
    const result = new AsyncValue<TaskResultOf<T>, LoggableException>();
    // TypeScript doesn't narrow the variant from the generic task type
    const variant = { type, value: task, result } as unknown as TaskOf<T>;
    dispatch({ type: SCHEDULE_TASK, value: variant });
    return result.getValue();
}
