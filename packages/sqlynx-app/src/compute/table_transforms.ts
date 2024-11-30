import * as arrow from 'apache-arrow';
import * as proto from '@ankoh/sqlynx-protobuf';

import { VariantKind } from '../utils/variant.js';
import { AsyncDataFrame } from './compute_worker_bindings.js';

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

// ------------------------------------------------------------

export type TaskVariant =
    VariantKind<typeof TABLE_ORDERING_TASK, TableOrderingTask>
    | VariantKind<typeof TABLE_SUMMARY_TASK, TableSummaryTask>
    | VariantKind<typeof COLUMN_SUMMARY_TASK, ColumnSummaryTask>
    ;

export interface TableOrderingTask {
    /// The computation id
    computationId: number;
    /// The ordering constraints
    orderingConstraints: proto.sqlynx_compute.pb.OrderByConstraint[];
}

export interface TableSummaryTask {
    /// The computation id
    computationId: number;
    /// The column entries
    columnEntries: ColumnEntryVariant[];
}

export interface TablePrecomputationTask {
    /// The computation id
    computationId: number;
    /// The column entries
    columnEntries: ColumnEntryVariant[];
}

export interface ColumnSummaryTask {
    /// The computation id
    computationId: number;
    /// The task id
    columnId: number;
    /// The column entry
    columnEntry: ColumnEntryVariant;
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

export type ColumnEntryVariant =
    VariantKind<typeof ORDINAL_COLUMN, OrdinalColumnEntry>
    | VariantKind<typeof STRING_COLUMN, StringColumnEntry>
    | VariantKind<typeof LIST_COLUMN, ListColumnEntry>
    | VariantKind<typeof SKIPPED_COLUMN, SkippedColumnEntry>
    ;

export function getColumnEntryTypeScript(variant: ColumnEntryVariant) {
    switch (variant.type) {
        case ORDINAL_COLUMN: return "ORDINAL";
        case STRING_COLUMN: return "STRING";
        case LIST_COLUMN: return "LIST";
        case SKIPPED_COLUMN: return "SKIPPED";
    }
}

export interface ColumnStatsFields {
    /// Entry count (!= null)
    countField: number;
    /// Distinct entry count (only for strings and lists)
    distinctCountField: number | null;
    /// Maximum value
    minAggregateField: number;
    /// Minimum value
    maxAggregateField: number;
}

export interface ColumnBinningFields {
    /// The bin field
    binField: number;
    /// The fractional bin field
    fractionalBinField: number;
}

export interface OrdinalColumnEntry {
    /// The input column id
    inputFieldId: number;
    /// The input field name
    inputFieldName: string;
    /// The column stats
    statsFields: ColumnStatsFields | null;
    /// The binning fields
    binningFields: ColumnBinningFields | null;
}

export interface StringColumnEntry {
    /// The input column id
    inputFieldId: number;
    /// The input field name
    inputFieldName: string;
    /// The column stats
    statsFields: ColumnStatsFields | null;
}

export interface ListColumnEntry {
    /// The input column id
    inputFieldId: number;
    /// The input field name
    inputFieldName: string;
    /// The column stats
    statsFields: ColumnStatsFields | null;
}

export interface SkippedColumnEntry {
    /// The input column id
    inputFieldId: number;
    /// The input field name
    inputFieldName: string;
}

// ------------------------------------------------------------

export interface OrderedTable {
    /// The ordering constraints
    orderingConstraints: proto.sqlynx_compute.pb.OrderByConstraint[];
    /// The arrow table
    dataTable: arrow.Table;
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
    /// The entries
    columnEntries: ColumnEntryVariant[];
    /// The statistics
    statsDataFrame: AsyncDataFrame;
    /// The statistics
    statsTable: arrow.Table;
    /// Maximum value
    statsCountStarField: number | null;
}

export interface OrdinalColumnSummary {
    /// The numeric column entry
    columnEntry: OrdinalColumnEntry;
    /// The binned values
    binnedValues: BinnedValuesTable;
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
    /// The bin percentages
    binPercentages: number[];
    /// The bin lower bounds
    binLowerBounds: string[];
    /// The bin upper bounds
    binUpperBounds: string[]
}

export interface StringColumnSummary {
    /// The string column entry
    columnEntry: StringColumnEntry;
    /// The frequent values
    frequentValues: FrequentValuesTable;
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
    /// The minimum value
    minValue: string;
    /// The maximum value
    maxValue: string;
    /// Is unique?
    isUnique: boolean;
    /// The frequent value percentages
    frequentValuePercentages: number[];
    /// The frequent values
    frequentValues: string[];
}

export interface ListColumnSummary {
    /// The list column entry
    /// The string column entry
    columnEntry: ListColumnEntry;
    /// The binned lengths
    binnedLengths: BinnedValuesTable;
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
    /// The minimum value
    minValue: string;
    /// The maximum value
    maxValue: string;
    /// Is unique?
    isUnique: boolean;
    /// The frequent value percentages
    frequentValuePercentages: number[];
    /// The frequent values
    frequentValues: string[];
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

export function createTableSummaryTransform(task: TableSummaryTask): [proto.sqlynx_compute.pb.DataFrameTransform, ColumnEntryVariant[], number] {
    let aggregates: proto.sqlynx_compute.pb.GroupByAggregate[] = [];
    let nextOutputColumn = 0;

    // Add count(*) aggregate
    const countStarColumn = nextOutputColumn++;
    aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
        outputAlias: `c${countStarColumn}`,
        aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.CountStar,
    }));

    // Add column aggregates
    const newEntries: ColumnEntryVariant[] = [];
    for (const entry of task.columnEntries) {
        switch (entry.type) {
            case ORDINAL_COLUMN: {
                const countAggregateColumn = nextOutputColumn++;
                const minAggregateColumn = nextOutputColumn++;
                const maxAggregateColumn = nextOutputColumn++;
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${countAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${minAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Min,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${maxAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Max,
                }));
                const newEntry: ColumnEntryVariant = {
                    type: ORDINAL_COLUMN,
                    value: {
                        ...entry.value,
                        statsFields: {
                            countField: countAggregateColumn,
                            distinctCountField: null,
                            minAggregateField: minAggregateColumn,
                            maxAggregateField: maxAggregateColumn,
                        }
                    }
                };
                newEntries.push(newEntry);
                break;
            }
            case STRING_COLUMN: {
                const countAggregateColumn = nextOutputColumn++;
                const countDistinctAggregateColumn = nextOutputColumn++;
                const minAggregateColumn = nextOutputColumn++;
                const maxAggregateColumn = nextOutputColumn++;
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${countAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${countDistinctAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                    aggregateDistinct: true,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${minAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Min,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${maxAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Max,
                }));
                const newEntry: ColumnEntryVariant = {
                    type: STRING_COLUMN,
                    value: {
                        ...entry.value,
                        statsFields: {
                            countField: countAggregateColumn,
                            distinctCountField: countDistinctAggregateColumn,
                            minAggregateField: minAggregateColumn,
                            maxAggregateField: maxAggregateColumn,
                        }
                    }
                };
                newEntries.push(newEntry);
                break;
            }
            case LIST_COLUMN: {
                const countAggregateColumn = nextOutputColumn++;
                const countDistinctAggregateColumn = nextOutputColumn++;
                const minAggregateColumn = nextOutputColumn++;
                const maxAggregateColumn = nextOutputColumn++;
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${countAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${countDistinctAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                    aggregateDistinct: true,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${minAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Min,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${maxAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Max,
                }));
                const newEntry: ColumnEntryVariant = {
                    type: LIST_COLUMN,
                    value: {
                        ...entry.value,
                        statsFields: {
                            countField: countAggregateColumn,
                            distinctCountField: countDistinctAggregateColumn,
                            minAggregateField: minAggregateColumn,
                            maxAggregateField: maxAggregateColumn,
                        }
                    }
                };
                newEntries.push(newEntry);
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
    return [transform, newEntries, countStarColumn];
}

export const BIN_COUNT = 16;

export function createColumnSummaryTransform(task: ColumnSummaryTask, tableSummary: TableSummary): proto.sqlynx_compute.pb.DataFrameTransform {
    if (task.columnEntry.type == SKIPPED_COLUMN || task.columnEntry.value.statsFields == null) {
        throw new Error("column summary requires precomputed table summary");
    }
    let fieldName = task.columnEntry.value.inputFieldName;
    let out: proto.sqlynx_compute.pb.DataFrameTransform;
    let tableSummarySchema = tableSummary.statsTable.schema;
    switch (task.columnEntry.type) {
        case ORDINAL_COLUMN: {
            const minField = tableSummarySchema.fields[task.columnEntry.value.statsFields.minAggregateField].name;
            const maxField = tableSummarySchema.fields[task.columnEntry.value.statsFields.maxAggregateField].name;
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
                            outputAlias: "value",
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
