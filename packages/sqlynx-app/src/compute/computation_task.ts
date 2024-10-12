import * as arrow from 'apache-arrow';
import * as proto from '@ankoh/sqlynx-protobuf';

import { VariantKind } from '../utils/variant.js';

export const TASK_RUNNING = Symbol("TASK_PROGRESS");
const TABLE_SUMMARY_TASK = Symbol("TABLE_STATS_TASK");
const TABLE_ORDERING_TASK = Symbol("TABLE_ORDERING_TASK");
const COLUMN_SUMMARY_TASK = Symbol("COLUMN_STATS_TASK");
const TASK_ERROR = Symbol("TASK_ERROR");
const ORDINAL_COLUMN = Symbol("ORDINAL_COLUMN");
const STRING_COLUMN = Symbol("STRING_COLUMN");
const LIST_COLUMN = Symbol("LIST_COLUMN");

// ------------------------------------------------------------

export type TaskVariant =
    VariantKind<typeof TABLE_ORDERING_TASK, TableOrderingTask>
    | VariantKind<typeof TABLE_SUMMARY_TASK, TableSummaryTask>
    | VariantKind<typeof COLUMN_SUMMARY_TASK, ColumnSummaryTask>
    ;

export interface TableOrderingTask {
    /// The table id
    tableId: number;
    /// The ordering constraints
    orderingConstraints: proto.sqlynx_compute.pb.OrderByConstraint[];
}

export interface TableSummaryTask {
    /// The table id
    tableId: number;
    /// The column entries
    columnEntries: ColumnEntryVariant[];
}

export interface ColumnSummaryTask {
    /// The table id
    tableId: number;
    /// The task id
    taskId: number;
    /// The column entry
    columnEntry: ColumnEntryVariant;
}

// ------------------------------------------------------------

export type TaskStatus =
    VariantKind<typeof TASK_RUNNING, TaskProgress>
    | VariantKind<typeof TASK_ERROR, TaskError>
    ;

export interface TaskProgress {
    /// Task was queued at timestamp
    queuedAt: Date;
    /// Task started after duration
    startedAfterMs: number | null;
    /// Task completed after duration
    completedAfterMs: number | null;
    /// Task finished after duration
    finishedAfterMs: number | null;
}

export interface TaskError {
    /// The task progress after
    progress: TaskProgress;
    /// The error
    error: Error;
}

// ------------------------------------------------------------

type ColumnEntryVariant =
    VariantKind<typeof ORDINAL_COLUMN, OrdinalColumnEntry>
    | VariantKind<typeof STRING_COLUMN, StringColumnEntry>
    | VariantKind<typeof LIST_COLUMN, ListColumnEntry>
    ;

interface OrdinalColumnEntry {
    /// The input field name
    inputFieldName: string;
    /// Entry count (!= null)
    statsCountField: number;
    /// Maximum value
    statsMinAggregateField: number;
    /// Minimum value
    statsMaxAggregateField: number;
}

interface StringColumnEntry {
    /// The input field name
    inputFieldName: string;
    /// Entry count (!= null)
    statsCountField: number;
    /// Maximum value
    statsMinLengthAggregateField: number;
    /// Minimum value
    statsMaxLengthAggregateField: number;
}

interface ListColumnEntry {
    /// The input field name
    inputFieldName: string;
    /// Entry count (!= null)
    statsCountField: number;
    /// Maximum value
    statsMinLengthAggregateField: number;
    /// Minimum value
    statsMaxLengthAggregateField: number;
}

// ------------------------------------------------------------

export interface OrderedTable {
    /// The ordering constraints
    orderingConstraints: proto.sqlynx_compute.pb.OrderByConstraint[];
    /// The table
    table: arrow.Table;
}

// ------------------------------------------------------------

export type ColumnSummaryVariant =
    VariantKind<typeof ORDINAL_COLUMN, OrdinalColumnSummary>
    | VariantKind<typeof STRING_COLUMN, StringColumnSummary>
    | VariantKind<typeof LIST_COLUMN, ListColumnSummary>
    ;

export interface TableSummary {
    /// The entries
    columnEntries: ColumnEntryVariant[];
    /// The statistics
    stats: arrow.Table;
    /// Maximum value
    statsCountStarField: number;
}

interface OrdinalColumnSummary {
    /// The numeric column entry
    columnEntry: OrdinalColumnEntry;
    /// The binned values
    binnedValues: BinnedValuesTable;
}

interface StringColumnSummary {
    /// The string column entry
    columnEntry: StringColumnEntry;
    /// The frequent values
    frequentValues: FrequentValuesTable;
}

interface ListColumnSummary {
    /// The list column entry
    /// The string column entry
    columnEntry: ListColumnEntry;
    /// The binned lengths
    binnedLengths: BinnedValuesTable;
}

// ------------------------------------------------------------

type BinnedValuesTable<WidthType extends arrow.DataType = arrow.DataType, BoundType extends arrow.DataType = arrow.DataType> = arrow.Table<{
    bin: arrow.Int32,
    binWidth: WidthType,
    binLowerBound: BoundType,
    binUpperBound: BoundType,
    count: arrow.Int64,
}>;

type FrequentValuesTable<KeyType extends arrow.DataType = arrow.DataType> = arrow.Table<{
    key: KeyType,
    count: arrow.Int64,
}>

// ------------------------------------------------------------

export function createTableSummaryTransform(task: TableSummaryTask): proto.sqlynx_compute.pb.DataFrameTransform {
    let aggregates: proto.sqlynx_compute.pb.GroupByAggregate[] = [];
    let nextOutputColumn = 0;

    // Add count(*) aggregate
    const countStarColumn = nextOutputColumn++;
    aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
        outputAlias: `c${countStarColumn}`,
        aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.CountStar,
    }));

    // Add column aggregates
    for (const entry of task.columnEntries) {
        switch (entry.type) {
            case ORDINAL_COLUMN: {
                const minAggregateColumn = nextOutputColumn++;
                const maxAggregateColumn = nextOutputColumn++;
                const countAggregateColumn = nextOutputColumn++;
                entry.value.statsMinAggregateField = minAggregateColumn;
                entry.value.statsMaxAggregateField = maxAggregateColumn;
                entry.value.statsCountField = countAggregateColumn;
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
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${countAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                }));
                break;
            }
            case STRING_COLUMN: {
                const minLengthAggregateColumn = nextOutputColumn++;
                const maxLengthAggregateColumn = nextOutputColumn++;
                const countAggregateColumn = nextOutputColumn++;
                entry.value.statsMinLengthAggregateField = minLengthAggregateColumn;
                entry.value.statsMaxLengthAggregateField = maxLengthAggregateColumn;
                entry.value.statsCountField = countAggregateColumn;
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${minLengthAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Min,
                    aggregateLengths: true,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${maxLengthAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Max,
                    aggregateLengths: true,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${countAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                }));
                break;
            }
            case LIST_COLUMN: {
                const minLengthAggregateColumn = nextOutputColumn++;
                const maxLengthAggregateColumn = nextOutputColumn++;
                const countAggregateColumn = nextOutputColumn++;
                entry.value.statsMinLengthAggregateField = minLengthAggregateColumn;
                entry.value.statsMaxLengthAggregateField = maxLengthAggregateColumn;
                entry.value.statsCountField = countAggregateColumn;
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${minLengthAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Min,
                    aggregateLengths: true,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${maxLengthAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Max,
                    aggregateLengths: true,
                }));
                aggregates.push(new proto.sqlynx_compute.pb.GroupByAggregate({
                    fieldName: entry.value.inputFieldName,
                    outputAlias: `c${countAggregateColumn}`,
                    aggregationFunction: proto.sqlynx_compute.pb.AggregationFunction.Count,
                }));
                break;
            }
        }
    }
    const out = new proto.sqlynx_compute.pb.DataFrameTransform({
        groupBy: new proto.sqlynx_compute.pb.GroupByTransform({
            keys: [],
            aggregates
        })
    });
    return out;
}

export function createColumnSummaryTransform(task: ColumnSummaryTask, input: arrow.Table): proto.sqlynx_compute.pb.DataFrameTransform {
    let fieldName = task.columnEntry.value.inputFieldName;
    let out: proto.sqlynx_compute.pb.DataFrameTransform;
    switch (task.columnEntry.type) {
        case ORDINAL_COLUMN: {
            const minField = input.schema.fields[task.columnEntry.value.statsMaxAggregateField].name;
            const maxField = input.schema.fields[task.columnEntry.value.statsMinAggregateField].name;
            out = new proto.sqlynx_compute.pb.DataFrameTransform({
                groupBy: new proto.sqlynx_compute.pb.GroupByTransform({
                    keys: [
                        new proto.sqlynx_compute.pb.GroupByKey({
                            fieldName,
                            outputAlias: "bin",
                            binning: new proto.sqlynx_compute.pb.GroupByKeyBinning({
                                statsMinimumFieldName: minField,
                                statsMaximumFieldName: maxField,
                                binCount: 8,
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
        case LIST_COLUMN: {
            const minField = input.schema.fields[task.columnEntry.value.statsMaxLengthAggregateField].name;
            const maxField = input.schema.fields[task.columnEntry.value.statsMinLengthAggregateField].name;
            out = new proto.sqlynx_compute.pb.DataFrameTransform({
                groupBy: new proto.sqlynx_compute.pb.GroupByTransform({
                    keys: [
                        new proto.sqlynx_compute.pb.GroupByKey({
                            fieldName,
                            outputAlias: "bin",
                            binning: new proto.sqlynx_compute.pb.GroupByKeyBinning({
                                statsMinimumFieldName: minField,
                                statsMaximumFieldName: maxField,
                                binCount: 8,
                                outputBinWidthAlias: "binWidth",
                                outputBinLbAlias: "binLowerBound",
                                outputBinUbAlias: "binUpperBound",
                            }),
                            groupLengths: true
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
                    limit: 100
                })
            });
            break;
        }
    }
    return out;
}

export function createOrderByTransform(constraints: proto.sqlynx_compute.pb.OrderByConstraint[], limit: number): proto.sqlynx_compute.pb.DataFrameTransform {
    const out = new proto.sqlynx_compute.pb.DataFrameTransform({
        orderBy: new proto.sqlynx_compute.pb.OrderByTransform({
            constraints,
            limit
        })
    });
    return out;
}
