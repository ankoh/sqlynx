import * as arrow from 'apache-arrow';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { ArrowTableFormatter } from './arrow_formatter.js';
import { DataFrame, DataFrameRegistry } from './data_frame.js';
import { AsyncValue } from '../utils/async_value.js';
import { CLEAR_TABLE_ORDERING, COLUMN_SEARCH_SUCCEEDED, COMPUTATION_FROM_QUERY_RESULT, CREATED_DATA_FRAME, DATA_SEARCH_SUCCEEDED, FILTERED_COLUMN_AGGREGATION_SUCCEEDED, SET_RESULT_SEARCH_PATTERN, TABLE_FILTERING_SUCCEEDED, TABLE_ORDERING_SUCCEDED, ComputationAction, ComputationState, createComputationState, createTableComputationState, DELETE_COMPUTATION, reduceComputationState, SCHEDULE_TASK, UMAP_COMPUTATION_SUCCEEDED, UNREGISTER_SCHEDULER_TASK, UPDATE_SCHEDULER_TASK } from './computation_state.js';
import { BinnedValuesTable, ColumnAggregationVariant, ColumnGroup, ComputationStateVersion, FilterTable, LIST_COLUMN, OrderingTable, ORDINAL_COLUMN, OrdinalColumnAnalysis, OrdinalGridColumnGroup, ROWNUMBER_COLUMN, STRING_COLUMN, TableAggregation, TaskStatus, WithFilterEpoch } from './computation_types.js';
import { LoggableException } from '../platform/logger/logger.js';
import { COLUMN_AGGREGATION_TASK, FILTERED_COLUMN_AGGREGATION_TASK, SYSTEM_COLUMN_COMPUTATION_TASK, TABLE_AGGREGATION_TASK, TABLE_FILTERING_TASK, TABLE_ORDERING_TASK } from './computation_types.js';
import { TestLogger } from '../platform/logger/test_logger.js';
import type { EmbeddedComputeDatabase } from '../platform/database/embedded_database.js';

function createMockDataFrame(tableName: string): DataFrame {
    return new DataFrame({} as EmbeddedComputeDatabase, tableName);
}

function createOrdinalAggregate(
    columnEntry: OrdinalGridColumnGroup,
    dataFrame: DataFrame,
    aggregateTable: BinnedValuesTable<arrow.DataType<arrow.Type, any>, arrow.DataType<arrow.Type, any>>,
    formatter: ArrowTableFormatter,
    analysis: OrdinalColumnAnalysis,
): ColumnAggregationVariant {
    return {
        type: ORDINAL_COLUMN,
        value: {
            columnEntry,
            binnedDataFrame: dataFrame,
            binnedValues: aggregateTable,
            binnedValuesFormatter: formatter,
            columnAnalysis: analysis,
        },
    };
}

function createFilteredOrdinalAggregate(
    columnEntry: OrdinalGridColumnGroup,
    dataFrame: DataFrame,
    aggregateTable: BinnedValuesTable<arrow.DataType<arrow.Type, any>, arrow.DataType<arrow.Type, any>>,
    formatter: ArrowTableFormatter,
    analysis: OrdinalColumnAnalysis,
    filterVersion: ComputationStateVersion,
): WithFilterEpoch<ColumnAggregationVariant> {
    return {
        ...createOrdinalAggregate(columnEntry, dataFrame, aggregateTable, formatter, analysis),
        filterVersion,
        dataSearchRequestId: null,
    };
}

function getAggregationDataFrame(aggregation: ColumnAggregationVariant | null | undefined): DataFrame | null {
    if (aggregation == null) {
        return null;
    }
    switch (aggregation.type) {
        case ORDINAL_COLUMN:
            return aggregation.value.binnedDataFrame;
        case STRING_COLUMN:
            return aggregation.value.frequentValuesDataFrame;
        case LIST_COLUMN:
            return aggregation.value.frequentValuesDataFrame;
        default:
            return null;
    }
}

function releaseAllRegisteredDataFramesFromLatestState(state: ComputationState, memory: DataFrameRegistry) {
    expect(Object.entries(state.tableComputations).length).toBeGreaterThan(0);
    const liveDataFrames = new Set<DataFrame>();
    const addDataFrame = (dataFrame: DataFrame | null | undefined) => {
        if (dataFrame != null) {
            liveDataFrames.add(dataFrame);
        }
    };

    for (const tableState of Object.values(state.tableComputations)) {
        addDataFrame(tableState.dataFrame);
        addDataFrame(tableState.filterTable?.dataFrame);
        addDataFrame(tableState.dataSearchTable?.dataFrame);
        addDataFrame(tableState.orderingTable?.dataFrame);
        addDataFrame(tableState.tableAggregation?.dataFrame);

        for (const aggregate of tableState.columnAggregates) {
            addDataFrame(getAggregationDataFrame(aggregate));
        }
        for (const aggregate of tableState.filteredColumnAggregates) {
            addDataFrame(getAggregationDataFrame(aggregate));
        }

        addDataFrame(tableState.tasks.filteringTask?.inputDataFrame);
        addDataFrame(tableState.tasks.orderingTask?.inputDataFrame);
        addDataFrame(tableState.tasks.orderingTask?.filterTable?.dataFrame);
        addDataFrame(tableState.tasks.orderingTask?.dataSearchTable?.dataFrame);
        addDataFrame(tableState.tasks.dataSearchTask?.inputDataFrame);
        addDataFrame(tableState.tasks.tableAggregationTask?.inputDataFrame);
        addDataFrame(tableState.tasks.systemColumnTask?.inputDataFrame);
        addDataFrame(tableState.tasks.systemColumnTask?.tableAggregate.dataFrame);

        for (const task of tableState.tasks.columnAggregationTasks) {
            addDataFrame(task?.inputDataFrame);
            addDataFrame(task?.tableAggregate.dataFrame);
        }
        for (const task of tableState.tasks.filteredColumnAggregationTasks) {
            addDataFrame(task?.inputDataFrame);
            addDataFrame(task?.tableAggregate.dataFrame);
            addDataFrame(task?.filterTable?.dataFrame);
            addDataFrame(task?.dataSearchTable?.dataFrame);
            addDataFrame(getAggregationDataFrame(task?.unfilteredAggregate));
        }
    }

    for (const dataFrame of liveDataFrames) {
        const refCount = memory.getRegisteredDataFrames().get(dataFrame) ?? 0;
        for (let i = 0; i < refCount; ++i) {
            memory.release(dataFrame);
        }
    }

    expect(memory.getRegisteredDataFrames().size).toEqual(0);
}

describe('ComputationState', () => {
    const logger = new TestLogger();

    const inputTable = arrow.tableFromArrays({
        rowNumber: new Int32Array([0, 1, 2, 3]),
        score: new Float64Array([42, 10, 10, 30]),
    });
    const inputTableFieldIndex = new Map([
        ['rowNumber', 0],
        ['score', 1],
    ]);
    const inputTableColumns: ColumnGroup[] = [
        {
            type: ROWNUMBER_COLUMN,
            value: { rowNumberFieldName: 'rowNumber' },
        },
        {
            type: ORDINAL_COLUMN,
            value: {
                inputFieldName: 'score',
                inputFieldType: new arrow.Float64(),
                inputFieldNullable: true,
                statsFields: {
                    countFieldName: '_1_count',
                    distinctCountFieldName: null,
                    minAggregateFieldName: '_1_min',
                    maxAggregateFieldName: '_1_max',
                },
                binFieldName: null,
                binCount: 10,
            },
        },
    ];

    const aggregateTable = arrow.tableFromArrays({
        "_count_star": new BigUint64Array([BigInt(4)]),
        "_1_count": new BigUint64Array([BigInt(4)]),
        "_1_min": new Float64Array([10]),
        "_1_max": new Float64Array([42]),
    });
    const aggregateTableFieldIndex = new Map([
        ["_1_count", 0],
        ["_1_min", 1],
        ["_1_max", 2],
    ]);
    const aggregateTableFormatter = new ArrowTableFormatter(aggregateTable.schema, aggregateTable.batches, logger);

    const scoreAggregateTable: BinnedValuesTable<arrow.Float64, arrow.Float64> = arrow.tableFromArrays({
        "bin": new Int32Array([0, 1, 2, 3]),
        "binWidth": new Float64Array([2, 0, 1, 1]),
        "binLowerBound": new Float64Array([10, 10, 10, 10]),
        "binUpperBound": new Float64Array([10, 20, 30, 40]),
        "count": new BigInt64Array([BigInt(20), BigInt(30), BigInt(40), BigInt(50)]),
    });
    const scoreAggregateTableFormatter = new ArrowTableFormatter(scoreAggregateTable.schema, scoreAggregateTable.batches, logger);

    const filterTable = arrow.tableFromArrays({
        "rowNumber": new Int32Array([0, 1]),
    });
    const ordinalColumnAnalysis: OrdinalColumnAnalysis = {
        totalCount: 4,
        countNotNull: 4,
        countNull: 0,
        minValue: '10',
        maxValue: '42',
        binCount: 4,
        binValueCounts: new BigInt64Array([BigInt(2), BigInt(0), BigInt(1), BigInt(1)]),
        binPercentages: new Float64Array([0.5, 0, 0.25, 0.25]),
        binLowerBounds: ['10', '20', '30', '40'],
    };

    it('configure a computation state', () => {
        const memory = new DataFrameRegistry(logger);
        const state = createComputationState();
        expect(Object.keys(state.tableComputations)).toEqual([]);
        expect(memory.getRegisteredDataFrames().size).toEqual(0);
    });

    it('computation from query result', () => {
        const memory = new DataFrameRegistry(logger);
        const state = createComputationState();
        const tableLifetime = new AbortController();
        const action: ComputationAction = {
            type: COMPUTATION_FROM_QUERY_RESULT,
            value: [1, inputTable, inputTableColumns, tableLifetime, 'connection'],
        };
        const output = reduceComputationState(state, action, memory);
        expect(Object.entries(output.tableComputations).length).toEqual(1);
        // The computation queries are tracked on the connection that ran the query of the table
        expect(output.tableComputations[1].connectionId).toBe('connection');
        expect(output.tableComputations[1].dataTable).toEqual(inputTable);
        expect(output.tableComputations[1].dataTableFieldsByName).toEqual(inputTableFieldIndex);
        expect(output.tableComputations[1].columnGroups).toEqual(inputTableColumns);
        expect(output.tableComputations[1].dataTableLifetime).toEqual(tableLifetime);
        expect(output.tableComputations[1].dataFrame).toBeNull();
    });

    it('keeps column matches visible while a replacement search is pending', () => {
        const memory = new DataFrameRegistry(logger);
        const dataFrame = createMockDataFrame('__test_input');
        let state = createComputationState();
        state.tableComputations[1] = createTableComputationState(
            1,
            inputTable,
            inputTableColumns,
            new AbortController(),
        );
        state.tableComputations[1].dataFrame = dataFrame;

        state = reduceComputationState(state, {
            type: SET_RESULT_SEARCH_PATTERN,
            value: [1, 'columns', 'score'],
        }, memory);
        state = reduceComputationState(state, {
            type: COLUMN_SEARCH_SUCCEEDED,
            value: [1, dataFrame, 1, [1]],
        }, memory);
        state = reduceComputationState(state, {
            type: SET_RESULT_SEARCH_PATTERN,
            value: [1, 'columns', 'sc'],
        }, memory);

        expect(state.tableComputations[1].columnSearch.pending).toBe(true);
        expect(state.tableComputations[1].columnSearch.requestedPattern).toBe('sc');
        expect(state.tableComputations[1].columnSearch.appliedPattern).toBe('score');
        expect(state.tableComputations[1].columnSearch.matchingColumnGroups).toEqual([1]);
    });

    it('accepts the latest materialized Data search without changing the filter version', () => {
        const memory = new DataFrameRegistry(logger);
        const dataFrame = createMockDataFrame('__test_input');
        const searchFrame = createMockDataFrame('__test_search');
        let state = createComputationState();
        state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
        state.tableComputations[1].dataFrame = dataFrame;
        state.tableComputations[1].version = new ComputationStateVersion(2, 7);
        state = reduceComputationState(state, {
            type: SET_RESULT_SEARCH_PATTERN,
            value: [1, 'data', '10'],
        }, memory);

        state = reduceComputationState(state, {
            type: DATA_SEARCH_SUCCEEDED,
            value: [1, dataFrame, 1, {
                inputRowNumberColumnName: 'rowNumber',
                dataTable: arrow.tableFromArrays({ row_idx: new Int32Array([2, 3]), column_indices: [[1], [1]] }),
                dataFrame: searchFrame,
                version: new ComputationStateVersion(2, 7),
                requestId: 1,
            }],
        }, memory);

        expect(state.tableComputations[1].version).toEqual(new ComputationStateVersion(2, 7));
        expect(state.tableComputations[1].dataSearch.matchingRows).toEqual(new Map([[2, [1]], [3, [1]]]));
        expect(state.tableComputations[1].dataSearchTable?.dataFrame).toBe(searchFrame);
        expect(memory.getRegisteredDataFrames().get(searchFrame)).toBe(1);
    });

    it('umap computation appends coordinate columns and records them on the embedding group', () => {
        const memory = new DataFrameRegistry(logger);
        let state = createComputationState();
        const tableLifetime = new AbortController();
        // Seed a table state with an existing (system-column) data frame. The embedding
        // column is a LIST_COLUMN whose group carries the projection meta fields.
        const baseColumns: ColumnGroup[] = [
            { type: ROWNUMBER_COLUMN, value: { rowNumberFieldName: 'rowNumber' } },
            {
                type: LIST_COLUMN,
                value: {
                    inputFieldName: 'embedding',
                    inputFieldType: new arrow.List(new arrow.Field('item', new arrow.Float32(), true)),
                    inputFieldNullable: true,
                    statsFields: null,
                    valueIdFieldName: null,
                    umapProjection: null,
                },
            },
        ];
        const baseFrame = createMockDataFrame('__base');
        state.tableComputations[1] = createTableComputationState(1, inputTable, baseColumns, tableLifetime);
        state.tableComputations[1] = { ...state.tableComputations[1], dataFrame: baseFrame };
        memory.acquire(baseFrame);

        // The projection result: the input table extended with x/y coordinate columns, a
        // new data frame carrying the same columns, and the embedding group updated with
        // the coordinate field names.
        const projectedTable = inputTable.assign(arrow.tableFromArrays({
            _umap_x: new Float32Array([0.1, 0.2, 0.3, 0.4]),
            _umap_y: new Float32Array([1.1, 1.2, 1.3, 1.4]),
        }));
        const projectedFrame = createMockDataFrame('__umap');
        const projectedColumns: ColumnGroup[] = [
            baseColumns[0],
            {
                type: LIST_COLUMN,
                value: {
                    ...(baseColumns[1].value as any),
                    umapProjection: { xFieldName: '_umap_x', yFieldName: '_umap_y' },
                },
            },
        ];

        state = reduceComputationState(state, {
            type: UMAP_COMPUTATION_SUCCEEDED,
            value: [1, projectedTable, projectedFrame, projectedColumns],
        }, memory);

        const ts = state.tableComputations[1];
        // The coordinate columns are present on the swapped-in data table.
        expect(ts.dataTable.getChild('_umap_x')).not.toBeNull();
        expect(ts.dataTable.getChild('_umap_y')).not.toBeNull();
        expect(ts.dataTableFieldsByName.has('_umap_x')).toBe(true);
        expect(ts.dataTableFieldsByName.has('_umap_y')).toBe(true);
        // The embedding group records the coordinate field names.
        const umapGroup = ts.columnGroups.find(g => g.type === LIST_COLUMN && g.value.umapProjection != null);
        expect(umapGroup).toBeDefined();
        // The data frame is swapped: the new one is acquired, the previous released.
        expect(ts.dataFrame).toBe(projectedFrame);
        expect(memory.getRegisteredDataFrames().has(projectedFrame)).toBe(true);
        expect(memory.getRegisteredDataFrames().has(baseFrame)).toBe(false);
    });

    it('delete computation', () => {
        const memory = new DataFrameRegistry(logger);
        const state = createComputationState();
        const tableLifetime = new AbortController();
        state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, tableLifetime);
        const action: ComputationAction = {
            type: DELETE_COMPUTATION,
            value: [1],
        };
        const output = reduceComputationState(state, action, memory);
        expect(Object.entries(output.tableComputations).length).toEqual(0);
        expect(tableLifetime.signal.aborted).toBe(true);
    });

    it('releases the previous computation when replacing the same table id', () => {
        const memory = new DataFrameRegistry(logger);
        let state = createComputationState();
        const previousFrame = createMockDataFrame('__previous');
        const destroy = vi.spyOn(previousFrame, 'destroy').mockResolvedValue();

        state = reduceComputationState(state, {
            type: COMPUTATION_FROM_QUERY_RESULT,
            value: [1, inputTable, inputTableColumns, new AbortController()],
        }, memory);
        state = reduceComputationState(state, {
            type: CREATED_DATA_FRAME,
            value: [1, previousFrame],
        }, memory);

        state = reduceComputationState(state, {
            type: COMPUTATION_FROM_QUERY_RESULT,
            value: [1, inputTable, inputTableColumns, new AbortController()],
        }, memory);

        expect(state.tableComputations[1].dataFrame).toBeNull();
        expect(memory.getRegisteredDataFrames().has(previousFrame)).toBe(false);
        expect(destroy).toHaveBeenCalledOnce();
    });

    describe('task scheduling', () => {
        it('filtering task', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.nextSchedulerTaskId = 42;
            const schedulingAction: ComputationAction = {
                type: SCHEDULE_TASK,
                value: {
                    type: TABLE_FILTERING_TASK,
                    value: {
                        tableId: 1,
                        tableVersion: new ComputationStateVersion(0, 20),
                        inputDataTable: inputTable,
                        inputDataTableFieldIndex: inputTableFieldIndex,
                        inputDataFrame,
                        rowNumberColumnName: 'rowNumber',
                        filters: [
                            { fieldName: 'score', op: "<", value: 20 },
                        ],
                    },
                    result: new AsyncValue<FilterTable | null, LoggableException>(),
                },
            };

            state = reduceComputationState(state, schedulingAction, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(1);
            expect(state.schedulerTasks[42].type).toEqual(TABLE_FILTERING_TASK);
            expect(state.schedulerTasks[42].taskId).toEqual(42);
            expect(state.nextSchedulerTaskId).toEqual(43);
            expect(state.tableComputations[1].tasks.filteringTask).toBeDefined();
            expect(state.tableComputations[1].tasks.filteringTask?.progress.status).toEqual(TaskStatus.TASK_RUNNING);
            expect(memory.getRegisteredDataFrames().size).toEqual(1);

            let inputRefCount = memory.getRegisteredDataFrames().get(inputDataFrame);
            expect(inputRefCount).toEqual(2);

            const updateAction: ComputationAction = {
                type: UPDATE_SCHEDULER_TASK,
                value: [state.schedulerTasks[42], {
                    status: TaskStatus.TASK_SUCCEEDED,
                    completedAt: new Date(),
                }],
            };
            state = reduceComputationState(state, updateAction, memory);
            expect(state.tableComputations[1].tasks.filteringTask?.progress.status).toEqual(TaskStatus.TASK_SUCCEEDED);

            const deleteTask: ComputationAction = {
                type: UNREGISTER_SCHEDULER_TASK,
                value: state.schedulerTasks[42],
            };
            state = reduceComputationState(state, deleteTask, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(0);
            expect(memory.getRegisteredDataFrames().size).toEqual(1);
            expect(state.tableComputations[1].tasks.filteringTask).not.toBeNull();
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('ordering task', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.nextSchedulerTaskId = 42;
            const schedulingAction: ComputationAction = {
                type: SCHEDULE_TASK,
                value: {
                    type: TABLE_ORDERING_TASK,
                    value: {
                        tableId: 1,
                        tableVersion: new ComputationStateVersion(0, 20),
                        inputDataTable: inputTable,
                        inputDataTableFieldIndex: inputTableFieldIndex,
                        inputDataFrame,
                        filterTable: null,
                        dataSearchTable: null,
                        rowNumberColumnName: 'rowNumber',
                        orderingConstraints: [
                            { field: 'score', ascending: false, nullsFirst: false },
                        ],
                    },
                    result: new AsyncValue<OrderingTable, LoggableException>(),
                },
            };

            state = reduceComputationState(state, schedulingAction, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(1);
            expect(state.schedulerTasks[42].type).toEqual(TABLE_ORDERING_TASK);
            expect(state.schedulerTasks[42].taskId).toEqual(42);
            expect(state.nextSchedulerTaskId).toEqual(43);
            expect(state.tableComputations[1].tasks.orderingTask?.progress.status).toEqual(TaskStatus.TASK_RUNNING);
            expect(memory.getRegisteredDataFrames().size).toEqual(1);

            let inputRefCount = memory.getRegisteredDataFrames().get(inputDataFrame);
            expect(inputRefCount).toEqual(2);

            const updateAction: ComputationAction = {
                type: UPDATE_SCHEDULER_TASK,
                value: [state.schedulerTasks[42], {
                    status: TaskStatus.TASK_SUCCEEDED,
                    completedAt: new Date(),
                }],
            };
            state = reduceComputationState(state, updateAction, memory);
            expect(state.tableComputations[1].tasks.orderingTask?.progress.status).toEqual(TaskStatus.TASK_SUCCEEDED);

            const deleteTask: ComputationAction = {
                type: UNREGISTER_SCHEDULER_TASK,
                value: state.schedulerTasks[42],
            };
            state = reduceComputationState(state, deleteTask, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(0);
            expect(memory.getRegisteredDataFrames().size).toEqual(1);
            expect(state.tableComputations[1].tasks.orderingTask).not.toBeNull();
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('table aggregation task', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.nextSchedulerTaskId = 42;
            const schedulingAction: ComputationAction = {
                type: SCHEDULE_TASK,
                value: {
                    type: TABLE_AGGREGATION_TASK,
                    value: {
                        tableId: 1,
                        tableVersion: new ComputationStateVersion(0, 20),
                        inputDataFrame,
                        columnEntries: inputTableColumns,
                    },
                    result: new AsyncValue<[TableAggregation, ColumnGroup[]], LoggableException>(),
                },
            };

            state = reduceComputationState(state, schedulingAction, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(1);
            expect(state.schedulerTasks[42].type).toEqual(TABLE_AGGREGATION_TASK);
            expect(state.schedulerTasks[42].taskId).toEqual(42);
            expect(state.nextSchedulerTaskId).toEqual(43);
            expect(state.tableComputations[1].tasks.tableAggregationTask?.progress.status).toEqual(TaskStatus.TASK_RUNNING);
            expect(memory.getRegisteredDataFrames().size).toEqual(1);

            const deleteTask: ComputationAction = {
                type: UNREGISTER_SCHEDULER_TASK,
                value: state.schedulerTasks[42],
            };
            state = reduceComputationState(state, deleteTask, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(0);
            expect(memory.getRegisteredDataFrames().size).toEqual(1);
            expect(state.tableComputations[1].tasks.tableAggregationTask).not.toBeNull();
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('system column computation task', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input");
            const aggregateDataFrame = createMockDataFrame("__test_agg");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.nextSchedulerTaskId = 42;
            const schedulingAction: ComputationAction = {
                type: SCHEDULE_TASK,
                value: {
                    type: SYSTEM_COLUMN_COMPUTATION_TASK,
                    value: {
                        tableId: 1,
                        tableVersion: new ComputationStateVersion(0, 20),
                        inputDataFrame,
                        inputTable: inputTable,
                        columnEntries: inputTableColumns,
                        tableAggregate: {
                            dataFrame: aggregateDataFrame,
                            table: aggregateTable,
                            tableFieldsByName: aggregateTableFieldIndex,
                            tableFormatter: aggregateTableFormatter,
                            countStarFieldName: '_1_count',
                        },
                    },
                    result: new AsyncValue<[arrow.Table, DataFrame, ColumnGroup[]], LoggableException>(),
                },
            };

            state = reduceComputationState(state, schedulingAction, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(1);
            expect(state.schedulerTasks[42].type).toEqual(SYSTEM_COLUMN_COMPUTATION_TASK);
            expect(state.schedulerTasks[42].taskId).toEqual(42);
            expect(state.nextSchedulerTaskId).toEqual(43);
            expect(state.tableComputations[1].tasks.systemColumnTask?.progress.status).toEqual(TaskStatus.TASK_RUNNING);
            expect(memory.getRegisteredDataFrames().size).toEqual(2);

            let inputRefCount = memory.getRegisteredDataFrames().get(inputDataFrame);
            let aggregateRefCount = memory.getRegisteredDataFrames().get(aggregateDataFrame);
            expect(inputRefCount).toEqual(2);
            expect(aggregateRefCount).toEqual(2);

            const deleteTask: ComputationAction = {
                type: UNREGISTER_SCHEDULER_TASK,
                value: state.schedulerTasks[42],
            };
            state = reduceComputationState(state, deleteTask, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(0);
            expect(memory.getRegisteredDataFrames().size).toEqual(2);
            expect(state.tableComputations[1].tasks.systemColumnTask).not.toBeNull();
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('column aggregation task', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input");
            const aggregateDataFrame = createMockDataFrame("__test_agg");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.nextSchedulerTaskId = 42;
            const schedulingAction: ComputationAction = {
                type: SCHEDULE_TASK,
                value: {
                    type: COLUMN_AGGREGATION_TASK,
                    value: {
                        tableId: 1,
                        tableVersion: new ComputationStateVersion(0, 20),
                        inputDataFrame,
                        columnId: 1,
                        columnEntry: inputTableColumns[1],
                        tableAggregate: {
                            dataFrame: aggregateDataFrame,
                            table: aggregateTable,
                            tableFieldsByName: aggregateTableFieldIndex,
                            tableFormatter: aggregateTableFormatter,
                            countStarFieldName: '_count_star',
                        },
                    },
                    result: new AsyncValue<ColumnAggregationVariant, LoggableException>(),
                },
            };

            state = reduceComputationState(state, schedulingAction, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(1);
            expect(state.schedulerTasks[42].type).toEqual(COLUMN_AGGREGATION_TASK);
            expect(state.schedulerTasks[42].taskId).toEqual(42);
            expect(state.nextSchedulerTaskId).toEqual(43);
            expect(state.tableComputations[1].tasks.columnAggregationTasks[1]?.progress.status).toEqual(TaskStatus.TASK_RUNNING);
            expect(memory.getRegisteredDataFrames().size).toEqual(2);

            let inputRefCount = memory.getRegisteredDataFrames().get(inputDataFrame);
            let aggregateRefCount = memory.getRegisteredDataFrames().get(aggregateDataFrame);
            expect(inputRefCount).toEqual(2);
            expect(aggregateRefCount).toEqual(2);

            const deleteTask: ComputationAction = {
                type: UNREGISTER_SCHEDULER_TASK,
                value: state.schedulerTasks[42],
            };
            state = reduceComputationState(state, deleteTask, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(0);
            expect(memory.getRegisteredDataFrames().size).toEqual(2);
            expect(state.tableComputations[1].tasks.columnAggregationTasks[1]).not.toBeNull();
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('filtered column aggregation task', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input");
            const tableAggregateDataFrame = createMockDataFrame("__test_tbl_agg");
            const scoreAggregateDataFrame = createMockDataFrame("__test_col_agg");
            const filterDataFrame = createMockDataFrame("__test_filter");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.nextSchedulerTaskId = 42;

            const schedulingAction: ComputationAction = {
                type: SCHEDULE_TASK,
                value: {
                    type: FILTERED_COLUMN_AGGREGATION_TASK,
                    value: {
                        tableId: 1,
                        tableVersion: new ComputationStateVersion(0, 20),
                        inputDataFrame,
                        columnId: 1,
                        columnEntry: inputTableColumns[1],
                        tableAggregate: {
                            dataFrame: tableAggregateDataFrame,
                            table: aggregateTable,
                            tableFieldsByName: aggregateTableFieldIndex,
                            tableFormatter: aggregateTableFormatter,
                            countStarFieldName: '_count_star',
                        },
                        filterTable: {
                            inputRowNumberColumnName: 'rowNumber',
                            dataTable: filterTable,
                            dataFrame: filterDataFrame,
                            version: new ComputationStateVersion(0, 10),
                        },
                        dataSearchTable: null,
                        selectionRowCount: filterTable.numRows,
                        unfilteredAggregate: {
                            ...createOrdinalAggregate(inputTableColumns[1].value as OrdinalGridColumnGroup, scoreAggregateDataFrame, scoreAggregateTable as unknown as BinnedValuesTable<arrow.DataType<arrow.Type, any>, arrow.DataType<arrow.Type, any>>, scoreAggregateTableFormatter, ordinalColumnAnalysis),
                        },
                    },
                    result: new AsyncValue<WithFilterEpoch<ColumnAggregationVariant> | null, LoggableException>(),
                },
            };

            state = reduceComputationState(state, schedulingAction, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(1);
            expect(state.schedulerTasks[42].type).toEqual(FILTERED_COLUMN_AGGREGATION_TASK);
            expect(state.schedulerTasks[42].taskId).toEqual(42);
            expect(state.nextSchedulerTaskId).toEqual(43);
            expect(state.tableComputations[1].tasks.filteredColumnAggregationTasks[1]?.progress.status).toEqual(TaskStatus.TASK_RUNNING);
            expect(memory.getRegisteredDataFrames().size).toEqual(4);

            let inputRefCount = memory.getRegisteredDataFrames().get(inputDataFrame);
            let filterRefCount = memory.getRegisteredDataFrames().get(filterDataFrame);
            let tableAggregateRefCount = memory.getRegisteredDataFrames().get(tableAggregateDataFrame);
            let columnAggregateRefCount = memory.getRegisteredDataFrames().get(scoreAggregateDataFrame);
            expect(inputRefCount).toEqual(2);
            expect(filterRefCount).toEqual(2);
            expect(tableAggregateRefCount).toEqual(2);
            expect(columnAggregateRefCount).toEqual(2);

            const deleteTask: ComputationAction = {
                type: UNREGISTER_SCHEDULER_TASK,
                value: state.schedulerTasks[42],
            };
            state = reduceComputationState(state, deleteTask, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(0);
            expect(memory.getRegisteredDataFrames().size).toEqual(4);
            expect(state.tableComputations[1].tasks.filteredColumnAggregationTasks[1]).not.toBeNull();
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('marks filtered column summaries outdated without scheduling all columns on filter success', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input");
            const filterDataFrame = createMockDataFrame("__test_filter");
            const scoreAggregateDataFrame = createMockDataFrame("__test_col_agg");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.tableComputations[1].version = new ComputationStateVersion(0, 10); // State must match filter result version
            state.tableComputations[1].columnAggregates[1] = createOrdinalAggregate(
                inputTableColumns[1].value as OrdinalGridColumnGroup,
                scoreAggregateDataFrame,
                scoreAggregateTable as unknown as BinnedValuesTable<arrow.DataType<arrow.Type, any>, arrow.DataType<arrow.Type, any>>,
                scoreAggregateTableFormatter,
                ordinalColumnAnalysis,
            );

            const filterSucceeded: ComputationAction = {
                type: TABLE_FILTERING_SUCCEEDED,
                value: [1, new ComputationStateVersion(0, 10), {
                    inputRowNumberColumnName: 'rowNumber',
                    dataTable: filterTable,
                    dataFrame: filterDataFrame,
                    version: new ComputationStateVersion(0, 10),
                }],
            };

            state = reduceComputationState(state, filterSucceeded, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(0);
            expect(state.tableComputations[1].filterTable?.version.filter).toEqual(10);
            expect(state.tableComputations[1].version.filter).toEqual(10); // State version unchanged (already incremented when task was scheduled)
            expect(state.tableComputations[1].filteredColumnAggregatesOutdated[0]).toEqual(false);
            expect(state.tableComputations[1].filteredColumnAggregatesOutdated[1]).toEqual(true);
            expect(state.tableComputations[1].tasks.filteredColumnAggregationTasks[1]).toBeNull();
        });

        it('ignores stale filter table success for an older table epoch', () => {
            const memory = new DataFrameRegistry(logger);
            const staleFilterDataFrame = createMockDataFrame("__test_filter_stale");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].version = new ComputationStateVersion(0, 11);

            const staleFilterSucceeded: ComputationAction = {
                type: TABLE_FILTERING_SUCCEEDED,
                value: [1, new ComputationStateVersion(0, 10), {
                    inputRowNumberColumnName: 'rowNumber',
                    dataTable: filterTable,
                    dataFrame: staleFilterDataFrame,
                    version: new ComputationStateVersion(0, 10),
                }],
            };

            state = reduceComputationState(state, staleFilterSucceeded, memory);
            expect(state.tableComputations[1].version.filter).toEqual(11);
            expect(state.tableComputations[1].filterTable).toBeNull();
            expect(memory.getRegisteredDataFrames().size).toEqual(0);
        });

        it('accepts filter table success for current table epoch', () => {
            const memory = new DataFrameRegistry(logger);
            const currentFilterDataFrame = createMockDataFrame("__test_filter_current");
            const orderingDataFrame = createMockDataFrame("__test_ordering_current");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].version = new ComputationStateVersion(0, 10);
            state.tableComputations[1].orderingTable = {
                inputRowNumberColumnName: 'rowNumber',
                orderingConstraints: [{ field: 'score', ascending: false, nullsFirst: false }],
                dataTable: filterTable,
                dataFrame: orderingDataFrame,
                version: new ComputationStateVersion(0, 9),
                dataSearchRequestId: null,
            };

            const currentFilterSucceeded: ComputationAction = {
                type: TABLE_FILTERING_SUCCEEDED,
                value: [1, new ComputationStateVersion(0, 10), {
                    inputRowNumberColumnName: 'rowNumber',
                    dataTable: filterTable,
                    dataFrame: currentFilterDataFrame,
                    version: new ComputationStateVersion(0, 10),
                }],
            };

            state = reduceComputationState(state, currentFilterSucceeded, memory);
            expect(state.tableComputations[1].version.filter).toEqual(10); // State unchanged (already incremented when task was scheduled)
            expect(state.tableComputations[1].filterTable?.version.filter).toEqual(10);
            expect(state.tableComputations[1].orderingTable).toBeNull(); // Ordering cleared because filter changed
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('stores ordering table without replacing the immutable base table', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input");
            const orderingDataFrame = createMockDataFrame("__test_ordering");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].version = new ComputationStateVersion(0, 10);
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.tableComputations[1].tasks.orderingTask = {
                tableId: 1,
                tableVersion: state.tableComputations[1].version,
                inputDataTable: inputTable,
                inputDataTableFieldIndex: inputTableFieldIndex,
                inputDataFrame,
                filterTable: null,
                dataSearchTable: null,
                rowNumberColumnName: 'rowNumber',
                orderingConstraints: [{ field: 'score', ascending: false, nullsFirst: false }],
                progress: {
                    status: TaskStatus.TASK_RUNNING,
                    startedAt: new Date(),
                    completedAt: null,
                    failedAt: null,
                    failedWithError: null,
                },
            };
            memory.acquire(inputDataFrame);

            const orderingSucceeded: ComputationAction = {
                type: TABLE_ORDERING_SUCCEDED,
                value: [1, {
                    inputRowNumberColumnName: 'rowNumber',
                    orderingConstraints: [{ field: 'score', ascending: false, nullsFirst: false }],
                    dataTable: filterTable,
                    dataFrame: orderingDataFrame,
                    version: new ComputationStateVersion(0, 10),
                    dataSearchRequestId: null,
                }],
            };

            state = reduceComputationState(state, orderingSucceeded, memory);
            expect(state.tableComputations[1].version.filter).toEqual(10); // Ordering doesn't change filter version
            expect(state.tableComputations[1].dataFrame).toBe(inputDataFrame);
            expect(state.tableComputations[1].dataTable).toBe(inputTable);
            expect(state.tableComputations[1].orderingTable?.dataFrame).toBe(orderingDataFrame);
            expect(state.tableComputations[1].dataTableOrdering).toEqual([{ field: 'score', ascending: false, nullsFirst: false }]);
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('clears the active table ordering', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input_clear_ordering");
            const orderingDataFrame = createMockDataFrame("__test_ordering_clear");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.tableComputations[1].dataTableOrdering = [{ field: 'score', ascending: false }];
            state.tableComputations[1].orderingTable = {
                inputRowNumberColumnName: 'rowNumber',
                orderingConstraints: [{ field: 'score', ascending: false }],
                dataTable: filterTable,
                dataFrame: orderingDataFrame,
                version: state.tableComputations[1].version,
                dataSearchRequestId: null,
            };
            memory.acquire(orderingDataFrame);

            state = reduceComputationState(state, { type: CLEAR_TABLE_ORDERING, value: 1 }, memory);

            expect(state.tableComputations[1].dataTableOrdering).toEqual([]);
            expect(state.tableComputations[1].orderingTable).toBeNull();
            expect(memory.getRegisteredDataFrames().has(orderingDataFrame)).toBe(false);
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('ignores an ordering result after ordering is cleared', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input_stale_clear");
            const orderingDataFrame = createMockDataFrame("__test_ordering_stale_clear");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.tableComputations[1].tasks.orderingTask = {
                tableId: 1,
                tableVersion: state.tableComputations[1].version,
                inputDataTable: inputTable,
                inputDataTableFieldIndex: inputTableFieldIndex,
                inputDataFrame,
                filterTable: null,
                dataSearchTable: null,
                rowNumberColumnName: 'rowNumber',
                orderingConstraints: [],
                progress: {
                    status: TaskStatus.TASK_RUNNING,
                    startedAt: new Date(),
                    completedAt: null,
                    failedAt: null,
                    failedWithError: null,
                },
            };

            state = reduceComputationState(state, {
                type: TABLE_ORDERING_SUCCEDED,
                value: [1, {
                    inputRowNumberColumnName: 'rowNumber',
                    orderingConstraints: [{ field: 'score', ascending: false }],
                    dataTable: filterTable,
                    dataFrame: orderingDataFrame,
                    version: state.tableComputations[1].version,
                    dataSearchRequestId: null,
                }],
            }, memory);

            expect(state.tableComputations[1].dataTableOrdering).toEqual([]);
            expect(state.tableComputations[1].orderingTable).toBeNull();
            expect(memory.getRegisteredDataFrames().has(orderingDataFrame)).toBe(false);
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('ignores stale ordering table success for an older table epoch', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input");
            const staleOrderingDataFrame = createMockDataFrame("__test_ordering_stale");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].version = new ComputationStateVersion(0, 11);
            state.tableComputations[1].dataFrame = inputDataFrame;
            memory.acquire(inputDataFrame);

            const staleOrderingSucceeded: ComputationAction = {
                type: TABLE_ORDERING_SUCCEDED,
                value: [1, {
                    inputRowNumberColumnName: 'rowNumber',
                    orderingConstraints: [{ field: 'score', ascending: false, nullsFirst: false }],
                    dataTable: filterTable,
                    dataFrame: staleOrderingDataFrame,
                    version: new ComputationStateVersion(0, 10),
                    dataSearchRequestId: null,
                }],
            };

            state = reduceComputationState(state, staleOrderingSucceeded, memory);
            expect(state.tableComputations[1].version.filter).toEqual(11);
            expect(state.tableComputations[1].orderingTable).toBeNull();
            expect(state.tableComputations[1].dataFrame).toBe(inputDataFrame);
            releaseAllRegisteredDataFramesFromLatestState(state, memory);
        });

        it('discards stale filtered aggregation results without replacing the active task', () => {
            const memory = new DataFrameRegistry(logger);
            const inputDataFrame = createMockDataFrame("__test_input");
            const tableAggregateDataFrame = createMockDataFrame("__test_tbl_agg");
            const scoreAggregateDataFrame = createMockDataFrame("__test_col_agg");
            const filteredAggregateDataFrame = createMockDataFrame("__test_filtered_col_agg");
            const filterDataFrame = createMockDataFrame("__test_filter");

            let state = createComputationState();
            state.tableComputations[1] = createTableComputationState(1, inputTable, inputTableColumns, new AbortController());
            state.tableComputations[1].dataFrame = inputDataFrame;
            state.tableComputations[1].version = new ComputationStateVersion(0, 10);
            state.tableComputations[1].filterTable = {
                inputRowNumberColumnName: 'rowNumber',
                dataTable: filterTable,
                dataFrame: filterDataFrame,
                version: new ComputationStateVersion(0, 10),
            };
            state.tableComputations[1].columnAggregates[1] = createOrdinalAggregate(
                inputTableColumns[1].value as OrdinalGridColumnGroup,
                scoreAggregateDataFrame,
                scoreAggregateTable as unknown as BinnedValuesTable<arrow.DataType<arrow.Type, any>, arrow.DataType<arrow.Type, any>>,
                scoreAggregateTableFormatter,
                ordinalColumnAnalysis,
            );
            state.tableComputations[1].filteredColumnAggregatesOutdated[1] = true;
            state.tableComputations[1].tasks.filteredColumnAggregationTasks[1] = {
                tableId: 1,
                tableVersion: new ComputationStateVersion(0, 10),
                inputDataFrame,
                columnId: 1,
                columnEntry: inputTableColumns[1],
                tableAggregate: {
                    dataFrame: tableAggregateDataFrame,
                    table: aggregateTable,
                    tableFieldsByName: aggregateTableFieldIndex,
                    tableFormatter: aggregateTableFormatter,
                    countStarFieldName: '_count_star',
                },
                filterTable: {
                    inputRowNumberColumnName: 'rowNumber',
                    dataTable: filterTable,
                    dataFrame: filterDataFrame,
                    version: new ComputationStateVersion(0, 10),
                },
                dataSearchTable: null,
                selectionRowCount: filterTable.numRows,
                unfilteredAggregate: createOrdinalAggregate(
                    inputTableColumns[1].value as OrdinalGridColumnGroup,
                    scoreAggregateDataFrame,
                    scoreAggregateTable as unknown as BinnedValuesTable<arrow.DataType<arrow.Type, any>, arrow.DataType<arrow.Type, any>>,
                    scoreAggregateTableFormatter,
                    ordinalColumnAnalysis,
                ),
                progress: {
                    status: TaskStatus.TASK_RUNNING,
                    startedAt: new Date(),
                    completedAt: null,
                    failedAt: null,
                    failedWithError: null,
                },
            };

            const aggregationSucceeded: ComputationAction = {
                type: FILTERED_COLUMN_AGGREGATION_SUCCEEDED,
                value: [1, 1, new ComputationStateVersion(0, 9), createFilteredOrdinalAggregate(
                    inputTableColumns[1].value as OrdinalGridColumnGroup,
                    filteredAggregateDataFrame,
                    scoreAggregateTable as unknown as BinnedValuesTable<arrow.DataType<arrow.Type, any>, arrow.DataType<arrow.Type, any>>,
                    scoreAggregateTableFormatter,
                    ordinalColumnAnalysis,
                    new ComputationStateVersion(0, 9),
                )],
            };

            state = reduceComputationState(state, aggregationSucceeded, memory);
            expect(Object.entries(state.schedulerTasks).length).toEqual(0);
            expect(state.tableComputations[1].filteredColumnAggregates[1]).toBeNull();
            expect(state.tableComputations[1].filteredColumnAggregatesOutdated[1]).toEqual(true);
            expect(state.tableComputations[1].tasks.filteredColumnAggregationTasks[1]?.progress.status).toEqual(TaskStatus.TASK_RUNNING);

            const currentAggregationSucceeded: ComputationAction = {
                type: FILTERED_COLUMN_AGGREGATION_SUCCEEDED,
                value: [1, 1, new ComputationStateVersion(0, 10), createFilteredOrdinalAggregate(
                    inputTableColumns[1].value as OrdinalGridColumnGroup,
                    filteredAggregateDataFrame,
                    scoreAggregateTable as unknown as BinnedValuesTable<arrow.DataType<arrow.Type, any>, arrow.DataType<arrow.Type, any>>,
                    scoreAggregateTableFormatter,
                    ordinalColumnAnalysis,
                    new ComputationStateVersion(0, 10),
                )],
            };
            state = reduceComputationState(state, currentAggregationSucceeded, memory);
            expect(state.tableComputations[1].filteredColumnAggregates[1]?.filterVersion.filter).toEqual(10);
            expect(state.tableComputations[1].filteredColumnAggregatesOutdated[1]).toEqual(false);
            expect(state.tableComputations[1].tasks.filteredColumnAggregationTasks[1]?.progress.status).toEqual(TaskStatus.TASK_SUCCEEDED);
        });
    });
});
