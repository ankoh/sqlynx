import { vi } from 'vitest';
import * as arrow from 'apache-arrow';

import { AsyncValue } from '../utils/async_value.js';
import { LoggableException } from '../platform/logger/logger.js';
import { TestLogger } from '../platform/logger/test_logger.js';
import { TaskStatus, ComputationStateVersion } from './computation_types.js';
import {
    ComputationAction,
    UPDATE_SCHEDULER_TASK,
    UNREGISTER_SCHEDULER_TASK,
    TABLE_FILTERING_SUCCEEDED,
    TABLE_ORDERING_SUCCEDED,
    TABLE_AGGREGATION_SUCCEEDED,
    SYSTEM_COLUMN_COMPUTATION_SUCCEEDED,
    COLUMN_AGGREGATION_SUCCEEDED,
    DATA_SEARCH_FAILED,
    DATA_SEARCH_SUCCEEDED,
    FILTERED_COLUMN_AGGREGATION_SUCCEEDED,
} from './computation_state.js';
import { processTask, ComputationScheduler, COMPUTATION_OPERATIONS } from './computation_scheduler.js';
import {
    TaskVariant,
    TABLE_FILTERING_TASK,
    TABLE_ORDERING_TASK,
    TABLE_AGGREGATION_TASK,
    SYSTEM_COLUMN_COMPUTATION_TASK,
    COLUMN_AGGREGATION_TASK,
    DATA_SEARCH_TASK,
    FILTERED_COLUMN_AGGREGATION_TASK,
} from './computation_types.js';
const computationLogic = COMPUTATION_OPERATIONS;
import { Dispatch } from '../utils/variant.js';
import type { ComputeQueryExecution } from './computation_logic.js';
import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { ComputationRegistry, useComputationRegistry } from './computation_registry.js';
import { ComputeQueryExecutionProvider } from './computation_query_execution.js';
import { COMPUTATION_FROM_QUERY_RESULT, SCHEDULE_TASK } from './computation_state.js';
import { LoggerProvider } from '../platform/logger/logger_provider.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function ScheduleTask(props: { task: TaskVariant }) {
    const [, dispatch] = useComputationRegistry();
    React.useEffect(() => {
        dispatch({
            type: COMPUTATION_FROM_QUERY_RESULT,
            value: [props.task.value.tableId, arrow.tableFromArrays({ value: [1] }), [], new AbortController()],
        });
        dispatch({ type: SCHEDULE_TASK, value: props.task });
    }, [dispatch, props.task]);
    return null;
}

describe('ComputationScheduler', () => {
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

    it('creates an internal query executor for scheduled tasks', async () => {
        const executeQuery = vi.fn(<T,>(_queryText: string, execute: () => Promise<T>) => execute()) as ComputeQueryExecution;
        const createExecution = vi.fn(() => executeQuery);
        vi.spyOn(computationLogic, 'filterTable').mockResolvedValue(null);
        const task: TaskVariant = {
            type: TABLE_FILTERING_TASK,
            value: { tableId: 42 } as any,
            result: new AsyncValue() as any,
        };

        await act(async () => {
            root.render(
                <LoggerProvider>
                    <ComputationRegistry>
                        <ComputeQueryExecutionProvider createExecution={createExecution}>
                            <ComputationScheduler />
                            <ScheduleTask task={task} />
                        </ComputeQueryExecutionProvider>
                    </ComputationRegistry>
                </LoggerProvider>,
            );
            await new Promise(resolve => setTimeout(resolve, 0));
        });

        await vi.waitFor(() => expect(createExecution).toHaveBeenCalled());
        expect(computationLogic.filterTable).toHaveBeenCalledWith(expect.anything(), expect.anything(), executeQuery);
    });
});

describe('processTask', () => {
    let logger: TestLogger;
    let dispatch: Dispatch<ComputationAction>;

    beforeEach(() => {
        logger = new TestLogger();
        dispatch = vi.fn() as unknown as Dispatch<ComputationAction>;
        vi.restoreAllMocks();
        vi.spyOn(computationLogic, 'filterTable').mockResolvedValue(null);
        vi.spyOn(computationLogic, 'sortTable').mockResolvedValue({} as any);
        vi.spyOn(computationLogic, 'computeTableAggregates').mockResolvedValue([{} as any, []]);
        vi.spyOn(computationLogic, 'computeSystemColumns').mockResolvedValue([{} as any, {} as any, []]);
        vi.spyOn(computationLogic, 'computeColumnAggregates').mockResolvedValue({} as any);
        vi.spyOn(computationLogic, 'computeFilteredColumnAggregates').mockResolvedValue(null);
        vi.spyOn(computationLogic, 'searchData').mockResolvedValue({} as any);
    });

    it('warns and skips if task has no taskId', async () => {
        const task: TaskVariant = {
            type: TABLE_FILTERING_TASK,
            value: { tableId: 1 } as any,
            result: new AsyncValue(),
        };

        await processTask(task, dispatch, logger);

        expect(dispatch).not.toHaveBeenCalled();
        expect(computationLogic.filterTable).not.toHaveBeenCalled();
    });

    it('processes TABLE_FILTERING_TASK successfully', async () => {
        const mockFilter = { inputRowNumberColumnName: 'rowNumber', dataTable: {} as any, dataFrame: {} as any, version: new ComputationStateVersion(0, 0) };
        vi.spyOn(computationLogic, 'filterTable').mockResolvedValue(mockFilter);

        const result = new AsyncValue<typeof mockFilter | null, LoggableException>();
        const task: TaskVariant = {
            type: TABLE_FILTERING_TASK,
            value: { tableId: 42 } as any,
            result: result as any,
            taskId: 1,
        };

        await processTask(task, dispatch, logger);

        const calls = (dispatch as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(3);
        expect(calls[0][0]).toMatchObject({ type: UPDATE_SCHEDULER_TASK, value: [task, expect.objectContaining({ status: TaskStatus.TASK_RUNNING })] });
        expect(calls[1][0]).toEqual({
            type: TABLE_FILTERING_SUCCEEDED,
            value: [42, task.value.tableVersion, mockFilter],
        });
        expect(calls[2][0]).toEqual({ type: UNREGISTER_SCHEDULER_TASK, value: task });
        await expect(result.getValue()).resolves.toBe(mockFilter);
    });

    it('passes the internal query executor to computation logic', async () => {
        const executeQuery = vi.fn(<T,>(_queryText: string, execute: () => Promise<T>) => execute()) as ComputeQueryExecution;
        const task: TaskVariant = {
            type: TABLE_FILTERING_TASK,
            value: { tableId: 42 } as any,
            result: new AsyncValue() as any,
            taskId: 12,
        };

        await processTask(task, dispatch, logger, executeQuery);

        expect(computationLogic.filterTable).toHaveBeenCalledWith(task.value, expect.anything(), executeQuery);
    });

    it('processes TABLE_ORDERING_TASK successfully', async () => {
        const mockOrdered = { inputRowNumberColumnName: 'rowNumber', orderingConstraints: [], dataTable: {} as any, dataFrame: {} as any, version: new ComputationStateVersion(0, 0), dataSearchRequestId: null };
        vi.spyOn(computationLogic, 'sortTable').mockResolvedValue(mockOrdered);

        const result = new AsyncValue<typeof mockOrdered, LoggableException>();
        const task: TaskVariant = {
            type: TABLE_ORDERING_TASK,
            value: { tableId: 42 } as any,
            result: result as any,
            taskId: 2,
        };

        await processTask(task, dispatch, logger);

        const calls = (dispatch as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(3);
        expect(calls[0][0]).toMatchObject({ type: UPDATE_SCHEDULER_TASK, value: [task, expect.objectContaining({ status: TaskStatus.TASK_RUNNING })] });
        expect(calls[1][0]).toEqual({ type: TABLE_ORDERING_SUCCEDED, value: [42, mockOrdered] });
        expect(calls[2][0]).toEqual({ type: UNREGISTER_SCHEDULER_TASK, value: task });
        await expect(result.getValue()).resolves.toBe(mockOrdered);
    });

    it('processes DATA_SEARCH_TASK successfully', async () => {
        const searchTable = { requestId: 3 } as any;
        vi.spyOn(computationLogic, 'searchData').mockResolvedValue(searchTable);
        const result = new AsyncValue<any, LoggableException>();
        const inputDataFrame = {} as any;
        const task: TaskVariant = {
            type: DATA_SEARCH_TASK,
            value: { tableId: 42, inputDataFrame, requestId: 3 } as any,
            result,
            taskId: 20,
        };

        await processTask(task, dispatch, logger);

        const calls = (dispatch as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[1][0]).toEqual({
            type: DATA_SEARCH_SUCCEEDED,
            value: [42, inputDataFrame, 3, searchTable],
        });
        expect(calls[2][0]).toEqual({ type: UNREGISTER_SCHEDULER_TASK, value: task });
        await expect(result.getValue()).resolves.toBe(searchTable);
    });

    it('reports DATA_SEARCH_TASK failures to search state', async () => {
        const error = new Error('search failed');
        vi.spyOn(computationLogic, 'searchData').mockRejectedValue(error);
        const result = new AsyncValue<any, any>();
        const inputDataFrame = {} as any;
        const task: TaskVariant = {
            type: DATA_SEARCH_TASK,
            value: { tableId: 42, inputDataFrame, requestId: 4 } as any,
            result,
            taskId: 21,
        };

        await processTask(task, dispatch, logger);

        const calls = (dispatch as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[1][0]).toEqual({ type: DATA_SEARCH_FAILED, value: [42, inputDataFrame, 4, 'search failed'] });
        expect(calls[2][0]).toMatchObject({
            type: UPDATE_SCHEDULER_TASK,
            value: [task, expect.objectContaining({ status: TaskStatus.TASK_FAILED })],
        });
        expect(calls[3][0]).toEqual({ type: UNREGISTER_SCHEDULER_TASK, value: task });
        await expect(result.getValue()).rejects.toBe(error);
    });

    it('processes TABLE_AGGREGATION_TASK successfully', async () => {
        const mockTableAgg = { dataFrame: {} as any, table: {} as any, tableFieldsByName: new Map(), tableFormatter: {} as any, countStarFieldName: '_count_star' };
        vi.spyOn(computationLogic, 'computeTableAggregates').mockResolvedValue([mockTableAgg, []]);

        const result = new AsyncValue<[typeof mockTableAgg, any[]], LoggableException>();
        const task: TaskVariant = {
            type: TABLE_AGGREGATION_TASK,
            value: { tableId: 42 } as any,
            result: result as any,
            taskId: 3,
        };

        await processTask(task, dispatch, logger);

        const calls = (dispatch as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(3);
        expect(calls[0][0]).toMatchObject({ type: UPDATE_SCHEDULER_TASK, value: [task, expect.objectContaining({ status: TaskStatus.TASK_RUNNING })] });
        expect(calls[1][0]).toEqual({ type: TABLE_AGGREGATION_SUCCEEDED, value: [42, mockTableAgg] });
        expect(calls[2][0]).toEqual({ type: UNREGISTER_SCHEDULER_TASK, value: task });
        await expect(result.getValue()).resolves.toEqual([mockTableAgg, []]);
    });

    it('processes SYSTEM_COLUMN_COMPUTATION_TASK successfully', async () => {
        const mockTable = { schema: {} } as any;
        const mockDataFrame = { id: 99 } as any;
        const mockColGroups: any[] = [];
        vi.spyOn(computationLogic, 'computeSystemColumns').mockResolvedValue([mockTable, mockDataFrame, mockColGroups]);

        const result = new AsyncValue<[typeof mockTable, typeof mockDataFrame, typeof mockColGroups], LoggableException>();
        const task: TaskVariant = {
            type: SYSTEM_COLUMN_COMPUTATION_TASK,
            value: { tableId: 42 } as any,
            result: result as any,
            taskId: 4,
        };

        await processTask(task, dispatch, logger);

        const calls = (dispatch as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(3);
        expect(calls[0][0]).toMatchObject({ type: UPDATE_SCHEDULER_TASK, value: [task, expect.objectContaining({ status: TaskStatus.TASK_RUNNING })] });
        expect(calls[1][0]).toEqual({ type: SYSTEM_COLUMN_COMPUTATION_SUCCEEDED, value: [42, mockTable, mockDataFrame, mockColGroups] });
        expect(calls[2][0]).toEqual({ type: UNREGISTER_SCHEDULER_TASK, value: task });
        await expect(result.getValue()).resolves.toEqual([mockTable, mockDataFrame, mockColGroups]);
    });

    it('processes COLUMN_AGGREGATION_TASK successfully', async () => {
        const mockColumnAgg = { type: Symbol('ORDINAL_COLUMN'), value: { binCount: 10 } } as any;
        vi.spyOn(computationLogic, 'computeColumnAggregates').mockResolvedValue(mockColumnAgg);

        const result = new AsyncValue<typeof mockColumnAgg, LoggableException>();
        const task: TaskVariant = {
            type: COLUMN_AGGREGATION_TASK,
            value: { tableId: 42, columnId: 7 } as any,
            result: result as any,
            taskId: 5,
        };

        await processTask(task, dispatch, logger);

        const calls = (dispatch as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(3);
        expect(calls[0][0]).toMatchObject({ type: UPDATE_SCHEDULER_TASK, value: [task, expect.objectContaining({ status: TaskStatus.TASK_RUNNING })] });
        expect(calls[1][0]).toEqual({ type: COLUMN_AGGREGATION_SUCCEEDED, value: [42, 7, mockColumnAgg] });
        expect(calls[2][0]).toEqual({ type: UNREGISTER_SCHEDULER_TASK, value: task });
        await expect(result.getValue()).resolves.toBe(mockColumnAgg);
    });

    it('processes FILTERED_COLUMN_AGGREGATION_TASK successfully', async () => {
        vi.spyOn(computationLogic, 'computeFilteredColumnAggregates').mockResolvedValue(null);

        const result = new AsyncValue<null, LoggableException>();
        const filterVersion = new ComputationStateVersion(0, 3);
        const task: TaskVariant = {
            type: FILTERED_COLUMN_AGGREGATION_TASK,
            value: {
                tableId: 42,
                columnId: 7,
                tableVersion: filterVersion,
                filterTable: { version: filterVersion },
            } as any,
            result: result as any,
            taskId: 6,
        };

        await processTask(task, dispatch, logger);

        const calls = (dispatch as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(3);
        expect(calls[0][0]).toMatchObject({ type: UPDATE_SCHEDULER_TASK, value: [task, expect.objectContaining({ status: TaskStatus.TASK_RUNNING })] });
        expect(calls[1][0]).toEqual({
            type: FILTERED_COLUMN_AGGREGATION_SUCCEEDED,
            value: [42, 7, filterVersion, null],
        });
        expect(calls[2][0]).toEqual({ type: UNREGISTER_SCHEDULER_TASK, value: task });
        await expect(result.getValue()).resolves.toBeNull();
    });

    it('marks task as failed and rejects when computation throws', async () => {
        const error = new Error('computation failed');
        vi.spyOn(computationLogic, 'filterTable').mockRejectedValue(error);

        const result = new AsyncValue<any, any>();
        const task: TaskVariant = {
            type: TABLE_FILTERING_TASK,
            value: { tableId: 42 } as any,
            result: result as any,
            taskId: 10,
        };

        await processTask(task, dispatch, logger);

        const calls = (dispatch as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(3);
        expect(calls[0][0]).toMatchObject({ type: UPDATE_SCHEDULER_TASK, value: [task, expect.objectContaining({ status: TaskStatus.TASK_RUNNING })] });
        expect(calls[1][0]).toMatchObject({
            type: UPDATE_SCHEDULER_TASK,
            value: [task, expect.objectContaining({
                status: TaskStatus.TASK_FAILED,
                failedWithError: expect.any(LoggableException),
            })],
        });
        expect(calls[2][0]).toEqual({ type: UNREGISTER_SCHEDULER_TASK, value: task });
        await expect(result.getValue()).rejects.toBe(error);
    });

    it('preserves a LoggableException directly in failedWithError', async () => {
        const loggable = new LoggableException('specific error', { detail: 'info' }, 'test');
        vi.spyOn(computationLogic, 'filterTable').mockRejectedValue(loggable);

        const result = new AsyncValue<any, any>();
        const task: TaskVariant = {
            type: TABLE_FILTERING_TASK,
            value: { tableId: 42 } as any,
            result: result as any,
            taskId: 11,
        };

        await processTask(task, dispatch, logger);

        const calls = (dispatch as ReturnType<typeof vi.fn>).mock.calls;
        const failedProgress = calls[1][0].value[1];
        expect(failedProgress.failedWithError).toBe(loggable);
        await expect(result.getValue()).rejects.toBe(loggable);
    });
});
