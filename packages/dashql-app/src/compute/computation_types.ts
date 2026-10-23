import * as arrow from 'apache-arrow';

import { OrderByConstraint, ScalarFilter } from './sql/sqlframe_builder.js';
import { VariantKind } from '../utils/variant.js';
import { DataFrame } from './data_frame.js';
import { ArrowTableFormatter } from './arrow_formatter.js';
import { LoggableException } from '../platform/logger/logger.js';
import { AsyncValue } from '../utils/async_value.js';

export const TASK_FAILED = Symbol("TASK_FAILED");
export const TASK_RUNNING = Symbol("TASK_RUNNING");
export const TASK_SUCCEDED = Symbol("TASK_SUCCEDED");
export const ORDINAL_COLUMN = Symbol("ORDINAL_COLUMN");
export const STRING_COLUMN = Symbol("STRING_COLUMN");
export const LIST_COLUMN = Symbol("LIST_COLUMN");
export const SKIPPED_COLUMN = Symbol("SKIPPED_COLUMN");
export const ROWNUMBER_COLUMN = Symbol("ROWNUMBER_COLUMN");

// ------------------------------------------------------------

export class ComputationStateVersion {
    /// The data version - incremented when underlying data changes
    public data: number;
    /// The filter version - incremented when filters change
    public filter: number;

    constructor(data: number = 0, filter: number = 0) {
        this.data = data;
        this.filter = filter;
    }

    /// Clone a computation state version
    clone(): ComputationStateVersion {
        return new ComputationStateVersion(this.data, this.filter);
    }

    /// Create a new version with data incremented
    withDataIncrement(): ComputationStateVersion {
        return new ComputationStateVersion(this.data + 1, this.filter);
    }

    /// Create a new version with filter incremented
    withFilterIncrement(): ComputationStateVersion {
        return new ComputationStateVersion(this.data, this.filter + 1);
    }

    /// Check if this version matches another in the data dimension
    dataMatches(other: ComputationStateVersion): boolean {
        return this.data === other.data;
    }

    /// Check if this version matches another in data + filter dimensions
    filterMatches(other: ComputationStateVersion): boolean {
        return this.data === other.data && this.filter === other.filter;
    }

    /// Serialize the version
    public toString(): string {
        return `${this.data}.${this.filter}`;
    }
};

export interface TableFilteringTask {
    /// The table id
    tableId: number;
    /// The table version
    tableVersion: ComputationStateVersion;
    /// The data frame
    inputDataTable: arrow.Table;
    /// The data frame
    inputDataTableFieldIndex: Map<string, number>;
    /// The data frame
    inputDataFrame: DataFrame;
    /// The row number columns
    rowNumberColumnName: string;
    /// The scalar filters
    filters: ScalarFilter[];
}

export interface TableOrderingTask {
    /// The table id
    tableId: number;
    /// The table version
    tableVersion: ComputationStateVersion;
    /// The data frame
    inputDataTable: arrow.Table;
    /// The data frame
    inputDataTableFieldIndex: Map<string, number>;
    /// The data frame
    inputDataFrame: DataFrame;
    /// The active filter table, if ordering should happen on a filtered subset
    filterTable: FilterTable | null;
    /// The active Data-search table, if ordering should happen on searched rows
    dataSearchTable: DataSearchTable | null;
    /// The row number column that provides stable ids into the immutable base table
    rowNumberColumnName: string;
    /// The ordering constraints
    orderingConstraints: OrderByConstraint[];
}

export type ResultSearchKind = 'columns' | 'data';

export interface ResultSearchState {
    /// The plain-text search requested by the user
    requestedPattern: string;
    /// The last successfully applied search text
    appliedPattern: string;
    /// Incremented for every requested search
    requestId: number;
    /// The last applied request
    appliedRequestId: number;
    /// Matching column-group indexes for a Columns search
    matchingColumnGroups: number[] | null;
    /// Matching original-column indexes keyed by 1-based row number
    matchingRows: Map<number, number[]> | null;
    /// Whether a search is currently running
    pending: boolean;
    /// Latest search error, if any
    error: string | null;
}

export interface DataSearchTask {
    /// The table id
    tableId: number;
    /// The data/filter version when the search was requested
    tableVersion: ComputationStateVersion;
    /// The source data frame
    inputDataFrame: DataFrame;
    /// The stable row-number column in the source data frame
    rowNumberColumnName: string;
    /// Original result columns searched by the query
    columns: Array<{ columnIdx: number; columnGroupIdx: number; fieldName: string }>;
    /// The plain-text search pattern
    pattern: string;
    /// The request id used to reject stale results
    requestId: number;
    /// Cancels materialization when superseded or when the source table is destroyed
    abortController: AbortController;
}

export function createResultSearchState(): ResultSearchState {
    return {
        requestedPattern: '',
        appliedPattern: '',
        requestId: 0,
        appliedRequestId: 0,
        matchingColumnGroups: null,
        matchingRows: null,
        pending: false,
        error: null,
    };
}

export interface TableAggregationTask {
    /// The table id
    tableId: number;
    /// The table version
    tableVersion: ComputationStateVersion;
    /// The column entries
    columnEntries: ColumnGroup[];
    /// The data frame
    inputDataFrame: DataFrame;
}

export interface SystemColumnComputationTask {
    /// The table id
    tableId: number;
    /// The table version
    tableVersion: ComputationStateVersion;
    /// The column entries
    columnEntries: ColumnGroup[];
    /// The input table
    inputTable: arrow.Table;
    /// The input data frame
    inputDataFrame: DataFrame;
    /// The stats table
    tableAggregate: TableAggregation;
}

export interface ColumnAggregationTask {
    /// The table id
    tableId: number;
    /// The table version
    tableVersion: ComputationStateVersion;
    /// The task id
    columnId: number;
    /// The column entry
    columnEntry: ColumnGroup;
    /// The input data frame
    inputDataFrame: DataFrame;
    /// The table summary
    tableAggregate: TableAggregation;
}

// ------------------------------------------------------------

export enum TaskStatus {
    TASK_RUNNING = 1,
    TASK_SUCCEEDED = 2,
    TASK_FAILED = 3,
};

export interface TaskProgress {
    /// Task status
    status: TaskStatus;
    /// Task started at timestamp
    startedAt: Date;
    /// Task completed at timestamp
    completedAt: Date | null;
    /// Task failed at timestamp
    failedAt: Date | null;
    /// Task failed with error
    failedWithError: LoggableException | null;
}

export type WithProgress<T> = T & { progress: TaskProgress };

// ------------------------------------------------------------

export type ColumnGroup =
    | VariantKind<typeof ROWNUMBER_COLUMN, RowNumberGridColumnGroup>
    | VariantKind<typeof SKIPPED_COLUMN, SkippedGridColumnGroup>
    | VariantKind<typeof ORDINAL_COLUMN, OrdinalGridColumnGroup>
    | VariantKind<typeof STRING_COLUMN, StringGridColumnGroup>
    | VariantKind<typeof LIST_COLUMN, ListGridColumnGroup>
    ;

export function getGridColumnTypeName(variant: ColumnGroup) {
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
    rowNumberFieldName: string;
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
    /// The bin field name
    binFieldName: string | null;
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
    /// The UMAP projection coordinate fields, if this (vector) column was projected.
    /// These are generated meta columns of the group, just like `valueIdFieldName`:
    /// they render inline after the value/id columns in debug mode and are read by the
    /// scatter renderer. Both are set together or both null.
    umapProjection: UmapProjectionFields | null;
}

export interface UmapProjectionFields {
    /// The generated field holding the projected x coordinate (Float32)
    xFieldName: string;
    /// The generated field holding the projected y coordinate (Float32)
    yFieldName: string;
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

export interface OrderingTable {
    /// The row number column that is used for the ordering ids
    inputRowNumberColumnName: string;
    /// The ordering constraints
    orderingConstraints: OrderByConstraint[];
    /// The arrow table, only containing the row ids in display order
    dataTable: arrow.Table;
    /// The data frame
    dataFrame: DataFrame;
    /// The version when this ordering was computed
    version: ComputationStateVersion;
    /// The Data-search request included in the ordering, if any
    dataSearchRequestId: number | null;
}

export interface FilterTable {
    /// The row number column that is used for the filter
    inputRowNumberColumnName: string;
    /// The arrow table, only containing the row ids of the filtered rows
    dataTable: arrow.Table;
    /// The data frame
    dataFrame: DataFrame;
    /// The version when this filter was computed
    version: ComputationStateVersion;
}

export interface DataSearchTable {
    /// The source row-number column matched by this search
    inputRowNumberColumnName: string;
    /// The Arrow table containing matched row ids and matching original-column ids
    dataTable: arrow.Table;
    /// The materialized search result
    dataFrame: DataFrame;
    /// The source data version searched
    version: ComputationStateVersion;
    /// The request represented by this table
    requestId: number;
}

// ------------------------------------------------------------

export type ColumnAggregationVariant =
    VariantKind<typeof ORDINAL_COLUMN, OrdinalColumnAggregation>
    | VariantKind<typeof STRING_COLUMN, StringColumnAggregation>
    | VariantKind<typeof LIST_COLUMN, ListColumnAggregation>
    | VariantKind<typeof SKIPPED_COLUMN, null>
    ;

export type WithFilter<T> = T & {
    /// The cross-filter table, if active
    filterTable: FilterTable | null,
    /// The Data-search table, if active
    dataSearchTable: DataSearchTable | null,
    /// Number of rows in the effective intersection
    selectionRowCount: number,
    /// The unfiltered aggregate
    unfilteredAggregate: ColumnAggregationVariant;
};

export type WithFilterEpoch<T> = T & {
    /// The filter version when this aggregate was computed
    filterVersion: ComputationStateVersion,
    /// The Data-search request when this aggregate was computed
    dataSearchRequestId: number | null,
};

export interface TableAggregation {
    /// The statistics
    dataFrame: DataFrame;
    /// The statistics
    table: arrow.Table;
    /// The statistics field index
    tableFieldsByName: Map<string, number>;
    /// The formatter for the stats table
    tableFormatter: ArrowTableFormatter;
    /// Maximum value
    countStarFieldName: string;
}

export interface OrdinalColumnAggregation<WidthType extends arrow.DataType = arrow.DataType, BoundType extends arrow.DataType = arrow.DataType> {
    /// The column entry
    columnEntry: OrdinalGridColumnGroup;
    /// The binned data frame
    binnedDataFrame: DataFrame;
    /// The binned values
    binnedValues: BinnedValuesTable;
    /// The formatter for the binned values
    binnedValuesFormatter: ArrowTableFormatter;
    /// The analyzed information for an ordinal column
    columnAnalysis: OrdinalColumnAnalysis;
}

export interface OrdinalColumnAnalysis {
    /// The total row count
    totalCount: number;
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

export interface OrdinalColumnFilterAnalysis {
    /// The bin counts
    binValueCounts: BigInt64Array;
    /// The bin percentages
    binPercentages: Float64Array;
}

export interface StringColumnAggregation {
    /// The string column entry
    columnEntry: StringGridColumnGroup;
    /// The frequent values
    frequentValuesDataFrame: DataFrame;
    /// The frequent values
    frequentValuesTable: FrequentValuesTable;
    /// The formatter for the frequent values
    frequentValuesFormatter: ArrowTableFormatter;
    /// The analyzed column information
    analysis: StringColumnAnalysis;
}

export interface StringColumnAnalysis {
    /// The total row count
    totalCount: number;
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
    /// The frequent value ids (for plotting)
    frequentValueIds: BigInt64Array;
    /// The frequent value counts
    frequentValueCounts: BigInt64Array;
    /// The frequent value percentages
    frequentValuePercentages: Float64Array;
}

export interface ListColumnAggregation {
    /// The list column entry
    columnEntry: ListGridColumnGroup;
    /// The frequent values
    frequentValuesDataFrame: DataFrame;
    /// The frequent values
    frequentValuesTable: FrequentValuesTable;
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
    keyId: arrow.Int64,
    count: arrow.Int64,
}>

// ------------------------------------------------------------

export type ComputationTask<Type, Task, Result> = VariantKind<Type, Task> & {
    result: AsyncValue<Result, LoggableException>,
    taskId?: number,
};

export const FILTERED_COLUMN_AGGREGATION_TASK = Symbol("FILTERED_COLUMN_AGGREGATION_TASK");
export const COLUMN_AGGREGATION_TASK = Symbol("COLUMN_AGGREGATION_TASK");
export const TABLE_FILTERING_TASK = Symbol("TABLE_FILTERING_TASK");
export const TABLE_ORDERING_TASK = Symbol("TABLE_ORDERING_TASK");
export const TABLE_AGGREGATION_TASK = Symbol("TABLE_AGGREGATION_TASK");
export const SYSTEM_COLUMN_COMPUTATION_TASK = Symbol("SYSTEM_COLUMN_COMPUTATION_TASK");
export const DATA_SEARCH_TASK = Symbol("DATA_SEARCH_TASK");

export type TaskVariant =
    | ComputationTask<typeof TABLE_FILTERING_TASK, TableFilteringTask, FilterTable | null>
    | ComputationTask<typeof TABLE_ORDERING_TASK, TableOrderingTask, OrderingTable>
    | ComputationTask<typeof TABLE_AGGREGATION_TASK, TableAggregationTask, [TableAggregation, ColumnGroup[]]>
    | ComputationTask<typeof SYSTEM_COLUMN_COMPUTATION_TASK, SystemColumnComputationTask, [arrow.Table, DataFrame, ColumnGroup[]]>
    | ComputationTask<typeof COLUMN_AGGREGATION_TASK, ColumnAggregationTask, ColumnAggregationVariant>
    | ComputationTask<typeof FILTERED_COLUMN_AGGREGATION_TASK, WithFilter<ColumnAggregationTask>, WithFilterEpoch<ColumnAggregationVariant> | null>
    | ComputationTask<typeof DATA_SEARCH_TASK, DataSearchTask, DataSearchTable>
    ;

/// The title of the queries of a task in the query history
export function computationTaskTitle(task: TaskVariant): string {
    switch (task.type) {
        case COLUMN_AGGREGATION_TASK: return 'Column aggregation';
        case TABLE_FILTERING_TASK: return 'Table filtering';
        case TABLE_ORDERING_TASK: return 'Table ordering';
        case TABLE_AGGREGATION_TASK: return 'Table aggregation';
        case SYSTEM_COLUMN_COMPUTATION_TASK: return 'System column computation';
        case FILTERED_COLUMN_AGGREGATION_TASK: return 'Filtered column aggregation';
        case DATA_SEARCH_TASK: return 'Data search';
    }
}
