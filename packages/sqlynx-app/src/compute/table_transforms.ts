import * as arrow from 'apache-arrow';
import * as proto from '@ankoh/sqlynx-protobuf';

import { VariantKind } from '../utils/variant.js';
import { AsyncDataFrame } from './compute_worker_bindings.js';
import { ArrowTableFormatter } from 'view/query_result/arrow_formatter.js';

export const COLUMN_SUMMARY_TASK = Symbol("COLUMN_STATS_TASK");
export const TABLE_ORDERING_TASK = Symbol("TABLE_ORDERING_TASK");
export const TABLE_SUMMARY_TASK = Symbol("TABLE_STATS_TASK");
export const TASK_FAILED = Symbol("TASK_FAILED");
export const TASK_RUNNING = Symbol("TASK_RUNNING");
export const TASK_SUCCEDED = Symbol("TASK_SUCCEDED");
export const ORDINAL_COLUMN = Symbol("ORDINAL_COLUMN");
export const STRING_COLUMN = Symbol("STRING_COLUMN");
export const LIST_COLUMN = Symbol("LIST_COLUMN");
export const SKIPPED_COLUMN = Symbol("SKIPPED_COLUMN");
export const ROWNUMBER_COLUMN = Symbol("ROWNUMBER_COLUMN");

// ------------------------------------------------------------

export type TaskVariant =
    VariantKind<typeof TABLE_ORDERING_TASK, TableOrderingTask>
    | VariantKind<typeof TABLE_SUMMARY_TASK, TableSummaryTask>
    | VariantKind<typeof COLUMN_SUMMARY_TASK, ColumnSummaryTask>
    ;

export interface TableOrderingTask {
    /// The computation id
    computationId: number;
    /// The data frame
    inputDataTable: arrow.Table;
    /// The data frame
    inputDataTableFieldIndex: Map<string, number>;
    /// The data frame
    inputDataFrame: AsyncDataFrame;
    /// The ordering constraints
    orderingConstraints: proto.sqlynx_compute.pb.OrderByConstraint[];
}

export interface TableSummaryTask {
    /// The computation id
    computationId: number;
    /// The column entries
    columnEntries: GridColumnGroup[];
    /// The data frame
    inputDataFrame: AsyncDataFrame;
}

export interface ColumnPrecomputationTask {
    /// The computation id
    computationId: number;
    /// The column entries
    columnEntries: GridColumnGroup[];
    /// The input table
    inputTable: arrow.Table;
    /// The input data frame
    inputDataFrame: AsyncDataFrame;
    /// The stats table
    tableSummary: TableSummary;
}

export interface ColumnSummaryTask {
    /// The computation id
    computationId: number;
    /// The task id
    columnId: number;
    /// The column entry
    columnEntry: GridColumnGroup;
    /// The input data frame
    inputDataFrame: AsyncDataFrame;
    /// The table summary
    tableSummary: TableSummary;
}

// ------------------------------------------------------------

export enum TaskStatus {
    TASK_RUNNING,
    TASK_SUCCEEDED,
    TASK_FAILED,
};

export interface TaskProgress {
    /// Task status
    status: TaskStatus;
    /// Task started at timestamp
    startedAt: Date | null;
    /// Task completed at timestamp
    completedAt: Date | null;
    /// Task failed at timestamp
    failedAt: Date | null;
    /// Task failed with error
    failedWithError: any;
}

// ------------------------------------------------------------

export type GridColumnGroup =
    | VariantKind<typeof ROWNUMBER_COLUMN, RowNumberGridColumnGroup>
    | VariantKind<typeof SKIPPED_COLUMN, SkippedGridColumnGroup>
    | VariantKind<typeof ORDINAL_COLUMN, OrdinalGridColumnGroup>
    | VariantKind<typeof STRING_COLUMN, StringGridColumnGroup>
    | VariantKind<typeof LIST_COLUMN, ListGridColumnGroup>
    ;

export function getGridColumnTypeName(variant: GridColumnGroup) {
    switch (variant.type) {
        case ROWNUMBER_COLUMN: return "ROWNUMBER";
        case SKIPPED_COLUMN: return "SKIPPED";
        case ORDINAL_COLUMN: return "ORDINAL";
        case STRING_COLUMN: return "STRING";
        case LIST_COLUMN: return "LIST";
    }
}

export interface ColumnStatsFields {
    /// Entry count (!= null)
    countFieldName: string;
    /// Distinct entry count (only for strings and lists)
    distinctCountFieldName: string | null;
    /// Maximum value
    minAggregateFieldName: string | null;
    /// Minimum value
    maxAggregateFieldName: string | null;
}

export interface ColumnBinningFields {
    /// The bin field
    binFieldName: string;
}

export interface RowNumberGridColumnGroup {
    /// The input field
    inputFieldIdName: string;
}

export interface OrdinalGridColumnGroup {
    /// The input field name
    inputFieldName: string;
    /// The input field type
    inputFieldType: arrow.DataType;
    /// Is the input nullable?
    inputFieldNullable: boolean;
    /// The column stats
    statsFields: ColumnStatsFields | null;
    /// The bin field
    binFieldName: number | null;
    /// The bin count
    binCount: number;
}

export interface StringGridColumnGroup {
    /// The input field name
    inputFieldName: string;
    /// The input field type
    inputFieldType: arrow.DataType;
    /// Is the input nullable?
    inputFieldNullable: boolean;
    /// The column stats
    statsFields: ColumnStatsFields | null;
    /// The identifier field
    valueIdFieldName: string | null;
}

export interface ListGridColumnGroup {
    /// The input field name
    inputFieldName: string;
    /// The input field type
    inputFieldType: arrow.DataType;
    /// Is the input nullable?
    inputFieldNullable: boolean;
    /// The column stats
    statsFields: ColumnStatsFields | null;
    /// The identifier field
    valueIdFieldName: string | null;
}

export interface SkippedGridColumnGroup {
    /// The input field name
    inputFieldName: string;
    /// The input field type
    inputFieldType: arrow.DataType;
    /// Is the input nullable?
    inputFieldNullable: boolean;
}

// ------------------------------------------------------------

export interface OrderedTable {
    /// The ordering constraints
    orderingConstraints: proto.sqlynx_compute.pb.OrderByConstraint[];
    /// The arrow table
    dataTable: arrow.Table;
    /// The field index
    dataTableFieldsByName: Map<string, number>;
    /// The data frame
    dataFrame: AsyncDataFrame;
}

// ------------------------------------------------------------

export type ColumnSummaryVariant =
    VariantKind<typeof ORDINAL_COLUMN, OrdinalColumnSummary>
    | VariantKind<typeof STRING_COLUMN, StringColumnSummary>
    | VariantKind<typeof LIST_COLUMN, ListColumnSummary>
    | VariantKind<typeof SKIPPED_COLUMN, null>
    ;

export interface TableSummary {
    /// The statistics
    statsDataFrame: AsyncDataFrame;
    /// The statistics
    statsTable: arrow.Table;
    /// The statistics field index
    statsTableFieldsByName: Map<string, number>;
    /// The formatter for the stats table
    statsTableFormatter: ArrowTableFormatter;
    /// Maximum value
    statsCountStarFieldName: string;
}

export interface OrdinalColumnSummary {
    /// The column entry
    columnEntry: OrdinalGridColumnGroup;
    /// The binned values
    binnedValues: BinnedValuesTable;
    /// The formatter for the binned values
    binnedValuesFormatter: ArrowTableFormatter;
    /// The analyzed information for a string column
    analysis: OrdinalColumnAnalysis;
}

export interface OrdinalColumnAnalysis {
    /// The value count
    countNotNull: number;
    /// The null count
    countNull: number;
    /// The minimum value
    minValue: string;
    /// The maximum value
    maxValue: string;
    /// The bin count
    binCount: number;
    /// The bin counts
    binValueCounts: BigInt64Array;
    /// The bin percentages
    binPercentages: Float64Array;
    /// The bin lower bounds
    binLowerBounds: string[];
}

export interface StringColumnSummary {
    /// The string column entry
    columnEntry: StringGridColumnGroup;
    /// The frequent values
    frequentValues: FrequentValuesTable;
    /// The formatter for the frequent values
    frequentValuesFormatter: ArrowTableFormatter;
    /// The analyzed column information
    analysis: StringColumnAnalysis;
}

export interface StringColumnAnalysis {
    /// The value count
    countNotNull: number;
    /// The null count
    countNull: number;
    /// The distinct count
    countDistinct: number;
    /// Is unique?
    isUnique: boolean;
    /// The frequent values
    frequentValueStrings: (string | null)[];
    /// The frequent value counts
    frequentValueCounts: BigInt64Array;
    /// The frequent value percentages
    frequentValuePercentages: Float64Array;
}

export interface ListColumnSummary {
    /// The list column entry
    /// The string column entry
    columnEntry: ListGridColumnGroup;
    /// The frequent values
    frequentValues: FrequentValuesTable;
    /// The formatter for the frequent values
    frequentValuesFormatter: ArrowTableFormatter;
    /// The analyzed information for a list column
    analysis: ListColumnAnalysis;
}

export interface ListColumnAnalysis {
    /// The value count
    countNotNull: number;
    /// The null count
    countNull: number;
    /// The distinct count
    countDistinct: number;
    /// Is unique?
    isUnique: boolean;
    /// The frequent value is null
    frequentValueIsNull: Uint8Array;
    /// The frequent value counts
    frequentValueCounts: BigInt64Array;
    /// The frequent value percentages
    frequentValuePercentages: Float64Array;
}

// ------------------------------------------------------------

export type BinnedValuesTable<WidthType extends arrow.DataType = arrow.DataType, BoundType extends arrow.DataType = arrow.DataType> = arrow.Table<{
    bin: arrow.Int32,
    binWidth: WidthType,
    binLowerBound: BoundType,
    binUpperBound: BoundType,
    count: arrow.Int64,
}>;

export type FrequentValuesTable<KeyType extends arrow.DataType = arrow.DataType> = arrow.Table<{
    key: KeyType,
    count: arrow.Int64,
}>


// ------------------------------------------------------------

export function createTableSummaryTransform(task: TableSummaryTask): [proto.sqlynx_compute.pb.DataFrameTransform, GridColumnGroup[], string] {
    let aggregates: proto.sqlynx_compute.pb.GroupByAggregate[] = [];

    // Add count(*) aggregate
    const countColumn = `_count`;
    aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
        outputAlias: `_count`,
        aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.CountStar,
    }));

    // Add column aggregates
    const updatedEntries: GridColumnGroup[] = [];
    for (let i = 0; i < task.columnEntries.length; ++i) {
        const entry = task.columnEntries[i];
        switch (entry.type) {
            case SKIPPED_COLUMN:
            case ROWNUMBER_COLUMN:
                updatedEntries.push(entry);
                break;
            case ORDINAL_COLUMN: {
                const countAggregateColumn = `_${i}_count`;
                const minAggregateColumn = `_${i}_min`;
                const maxAggregateColumn = `_${i}_max`;
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: countAggregateColumn,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: minAggregateColumn,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Min,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: maxAggregateColumn,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Max,
                }));
                const newEntry: GridColumnGroup = {
                    type: ORDINAL_COLUMN,
                    value: {
                        ...entry.value,
                        statsFields: {
                            countFieldName: countAggregateColumn,
                            distinctCountFieldName: null,
                            minAggregateFieldName: minAggregateColumn,
                            maxAggregateFieldName: maxAggregateColumn,
                        }
                    }
                };
                updatedEntries.push(newEntry);
                break;
            }
            case STRING_COLUMN: {
                const countAggregateColumn = `_${i}_count`;
                const countDistinctAggregateColumn = `_${i}_countd`;
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: countAggregateColumn,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: countDistinctAggregateColumn,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                    aggregateDistinct: true,
                }));
                const newEntry: GridColumnGroup = {
                    type: STRING_COLUMN,
                    value: {
                        ...entry.value,
                        statsFields: {
                            countFieldName: countAggregateColumn,
                            distinctCountFieldName: countDistinctAggregateColumn,
                            minAggregateFieldName: null,
                            maxAggregateFieldName: null
                        }
                    }
                };
                updatedEntries.push(newEntry);
                break;
            }
            case LIST_COLUMN: {
                const countAggregateColumn = `_${i}_count`;
                const countDistinctAggregateColumn = `_${i}_countd`;
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: countAggregateColumn,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: countDistinctAggregateColumn,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                    aggregateDistinct: true,
                }));
                const newEntry: GridColumnGroup = {
                    type: LIST_COLUMN,
                    value: {
                        ...entry.value,
                        statsFields: {
                            countFieldName: countAggregateColumn,
                            distinctCountFieldName: countDistinctAggregateColumn,
                            minAggregateFieldName: null,
                            maxAggregateFieldName: null,
                        }
                    }
                };
                updatedEntries.push(newEntry);
                break;
            }
        }
    }
    const transform = new proto.sqlynx_compute.pb.DataFrameTransform({
        groupBy: new proto.sqlynx_compute.pb.GroupByTransform({
            keys: [],
            aggregates
        })
    });
    return [transform, updatedEntries, countColumn];
}

export const BIN_COUNT = 16;

export function createColumnSummaryTransform(task: ColumnSummaryTask): proto.sqlynx_compute.pb.DataFrameTransform {
    if (task.columnEntry.type == SKIPPED_COLUMN || task.columnEntry.type == ROWNUMBER_COLUMN || task.columnEntry.value.statsFields == null) {
        throw new Error("column summary requires precomputed table summary");
    }
    let fieldName = task.columnEntry.value.inputFieldName;
    let out: proto.sqlynx_compute.pb.DataFrameTransform;
    switch (task.columnEntry.type) {
        case ORDINAL_COLUMN: {
            const minField = task.columnEntry.value.statsFields.minAggregateFieldName!;
            const maxField = task.columnEntry.value.statsFields.maxAggregateFieldName!;
            out = new proto.sqlynx_compute.pb.DataFrameTransform({
                groupBy: new proto.sqlynx_compute.pb.GroupByTransform({
                    keys: [
                        new proto.sqlynx_compute.pb.GroupByKey({
                            fieldName,
                            outputAlias: "bin",
                            binning: new proto.sqlynx_compute.pb.GroupByKeyBinning({
                                statsMinimumFieldName: minField,
                                statsMaximumFieldName: maxField,
                                binCount: BIN_COUNT,
                                outputBinWidthAlias: "binWidth",
                                outputBinLbAlias: "binLowerBound",
                                outputBinUbAlias: "binUpperBound",
                            })
                        })
                    ],
                    aggregates: [
                        new proto.sqlynx_compute.pb.GroupByAggregate({
                            fieldName,
                            outputAlias: "count",
                            aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.CountStar,
                        })
                    ]
                }),
                orderBy: new proto.sqlynx_compute.pb.OrderByTransform({
                    constraints: [
                        new proto.sqlynx_compute.pb.OrderByConstraint({
                            fieldName: "bin",
                            ascending: true,
                            nullsFirst: false,
                        })
                    ],
                })
            });
            break;
        }
        case LIST_COLUMN:
        case STRING_COLUMN: {
            out = new proto.sqlynx_compute.pb.DataFrameTransform({
                groupBy: new proto.sqlynx_compute.pb.GroupByTransform({
                    keys: [
                        new proto.sqlynx_compute.pb.GroupByKey({
                            fieldName,
                            outputAlias: "key",
                        })
                    ],
                    aggregates: [
                        new proto.sqlynx_compute.pb.GroupByAggregate({
                            fieldName,
                            outputAlias: "count",
                            aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.CountStar,
                        })
                    ]
                }),
                orderBy: new proto.sqlynx_compute.pb.OrderByTransform({
                    constraints: [
                        new proto.sqlynx_compute.pb.OrderByConstraint({
                            fieldName: "count",
                            ascending: false,
                            nullsFirst: false,
                        })
                    ],
                    limit: 32
                })
            });
            break;
        }
    }
    return out;
}

export function createOrderByTransform(constraints: proto.sqlynx_compute.pb.OrderByConstraint[], limit?: number): proto.sqlynx_compute.pb.DataFrameTransform {
    const out = new proto.sqlynx_compute.pb.DataFrameTransform({
        orderBy: new proto.sqlynx_compute.pb.OrderByTransform({
            constraints,
            limit
        })
    });
    return out;
}

/// Helper to create a unique column name
function createUniqueColumnName(prefix: string, fieldNames: Set<string>) {
    let name = prefix;
    while (true) {
        if (fieldNames.has(name)) {
            name = `_${name}`;
        } else {
            fieldNames.add(name);
            return name;
        }
    }
}

export function createPrecomputationTransform(schema: arrow.Schema, columns: GridColumnGroup[], stats: arrow.Table): [proto.sqlynx_compute.pb.DataFrameTransform, GridColumnGroup[]] {
    let nextOutputColumn = schema.fields.length;
    let binningTransforms = [];
    let identifierTransforms = [];

    // Track field names for unique system columns
    let fieldNames = new Set<string>();
    for (const field of schema.fields) {
        fieldNames.add(field.name);
    }

    // Prepend the row number column at position 0
    const rowNumberFieldName = createUniqueColumnName(`_rownum`, fieldNames);
    const rowNumberTransform = new proto.sqlynx_compute.pb.RowNumberTransform({
        outputAlias: rowNumberFieldName
    });
    const rowNumberGridColumn: GridColumnGroup = {
        type: ROWNUMBER_COLUMN,
        value: {
            inputFieldIdName: rowNumberFieldName
        }
    };
    let gridColumns: GridColumnGroup[] = [
        rowNumberGridColumn,
        ...columns
    ];

    // Create the metadata columns for all others
    for (let i = 1; i <= columns.length; ++i) {
        let column = gridColumns[i];
        switch (column.type) {
            case ROWNUMBER_COLUMN:
            case SKIPPED_COLUMN:
                break;
            case ORDINAL_COLUMN: {
                const binFieldId = nextOutputColumn++;
                const binFieldName = createUniqueColumnName(`_${i}_bin`, fieldNames);
                binningTransforms.push(new proto.sqlynx_compute.pb.BinningTransform({
                    fieldName: column.value.inputFieldName,
                    statsMaximumFieldName: column.value.statsFields!.maxAggregateFieldName!,
                    statsMinimumFieldName: column.value.statsFields!.minAggregateFieldName!,
                    binCount: column.value.binCount,
                    outputAlias: binFieldName
                }));
                gridColumns[i] = {
                    type: ORDINAL_COLUMN,
                    value: {
                        ...column.value,
                        binFieldName: binFieldId,
                    }
                };
                break;
            }
            case STRING_COLUMN: {
                const valueFieldName = createUniqueColumnName(`_${i}_id`, fieldNames);
                identifierTransforms.push(new proto.sqlynx_compute.pb.ValueIdentifierTransform({
                    fieldName: column.value.inputFieldName,
                    outputAlias: valueFieldName
                }));
                gridColumns[i] = {
                    type: STRING_COLUMN,
                    value: {
                        ...column.value,
                        valueIdFieldName: valueFieldName
                    }
                };
                break;
            }
            case LIST_COLUMN: {
                const valueFieldName = createUniqueColumnName(`_${i}_id`, fieldNames);
                identifierTransforms.push(new proto.sqlynx_compute.pb.ValueIdentifierTransform({
                    fieldName: column.value.inputFieldName,
                    outputAlias: valueFieldName
                }));
                gridColumns[i] = {
                    type: LIST_COLUMN,
                    value: {
                        ...column.value,
                        valueIdFieldName: valueFieldName
                    }
                };
                break;
            }
        }
    }

    const ordering = new proto.sqlynx_compute.pb.OrderByTransform({
        constraints: [
            new proto.sqlynx_compute.pb.OrderByConstraint({
                fieldName: rowNumberFieldName,
                ascending: true,
                nullsFirst: false
            })
        ]
    });

    const transform = new proto.sqlynx_compute.pb.DataFrameTransform({
        rowNumber: rowNumberTransform,
        valueIdentifiers: identifierTransforms,
        binning: binningTransforms,
        orderBy: ordering
    });
    return [transform, gridColumns];
}
