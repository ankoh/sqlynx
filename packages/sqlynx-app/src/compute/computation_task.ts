import * as arrow from 'apache-arrow';
import * as proto from '@ankoh/sqlynx-protobuf';

import { VariantKind } from '../utils/variant.js';

const TABLE_SUMMARY_TASK = Symbol("TABLE_STATS_TASK");
const TABLE_ORDERING_TASK = Symbol("TABLE_ORDERING_TASK");
const COLUMN_SUMMARY_TASK = Symbol("COLUMN_STATS_TASK");
const TASK_PROGRESS = Symbol("TASK_PROGRESS");
const TASK_ERROR = Symbol("TASK_ERROR");
const NUMERIC_COLUMN = Symbol("NUMERIC_COLUMN");
const STRING_COLUMN = Symbol("STRING_COLUMN");
const LIST_COLUMN = Symbol("LIST_COLUMN");

// ------------------------------------------------------------

export type OrderingTaskSlot =
    VariantKind<typeof TABLE_ORDERING_TASK, TableOrderingTask>
    | VariantKind<typeof TABLE_SUMMARY_TASK, TableSummaryTask>
    | VariantKind<typeof COLUMN_SUMMARY_TASK, ColumnSummaryTask>
    | TaskStatus
    ;

export interface TableSummaryTask {
    /// The column entries
    columnEntries: ColumnEntryVariant[];
}

export interface TableOrderingTask {
    /// The ordering constraints
    orderingConstraints: proto.sqlynx_compute.pb.OrderByConstraint[];
}

export interface ColumnSummaryTask {
    /// The column entry
    columnEntry: ColumnEntryVariant;
}

// ------------------------------------------------------------

export type TaskStatus =
    VariantKind<typeof TASK_PROGRESS, TaskProgress>
    | VariantKind<typeof TASK_ERROR, TaskError>
    ;

export interface TaskProgress {
}

export interface TaskError {
    /// The error
    error: Error;
}

// ------------------------------------------------------------

type ColumnEntryVariant =
    VariantKind<typeof NUMERIC_COLUMN, NumericColumnEntry>
    | VariantKind<typeof STRING_COLUMN, StringColumnEntry>
    | VariantKind<typeof LIST_COLUMN, ListColumnEntry>
    ;

interface NumericColumnEntry {
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

export type ColumnStatsVariant =
    VariantKind<typeof NUMERIC_COLUMN, NumericColumnStats>
    | VariantKind<typeof STRING_COLUMN, StringColumnStats>
    | VariantKind<typeof LIST_COLUMN, ListColumnStats>
    ;

interface NumericColumnStats {
    /// The numeric column entry
    columnEntry: NumericColumnEntry;
    /// The binned values
    binnedValues: BinnedValuesTable;
}

interface StringColumnStats {
    /// The string column entry
    columnEntry: StringColumnEntry;
    /// The frequent values
    frequentValues: FrequentValuesTable;
}

interface ListColumnStats {
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

export function createTableStatsTransform(task: TableSummaryTask): proto.sqlynx_compute.pb.DataFrameTransform {
    const out = new proto.sqlynx_compute.pb.DataFrameTransform();

    return out;
}

export function createColumnStatsTransform(task: ColumnSummaryTask): proto.sqlynx_compute.pb.DataFrameTransform {
    const out = new proto.sqlynx_compute.pb.DataFrameTransform();

    return out;
}

export function createOrderByTransform(): proto.sqlynx_compute.pb.DataFrameTransform {
    const out = new proto.sqlynx_compute.pb.DataFrameTransform();

    return out;
}
