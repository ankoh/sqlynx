import { ArrowTableFormatter } from '../arrow_formatter.js';
import { DataFrame, generateTableName } from '../data_frame.js';
import { ColumnAggregationVariant, ColumnAggregationTask, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, SKIPPED_COLUMN, ROWNUMBER_COLUMN, getGridColumnTypeName, WithFilter, WithFilterEpoch } from '../computation_types.js';
import { LoggableException, LoggerLike, stringifyError } from '../../platform/logger/logger.js';
import { SQLFrame } from '../sql/sqlframe_builder.js';
import { ComputeQueryExecution, executeDirectly } from '../computation_tasks.js';
import { getToNumericFn, isIntegerType } from '../arrow_columns.js';
import { analyzeOrdinalColumn, analyzeStringColumn } from '../column_analysis.js';

const LOG_CTX = "compute";

export async function computeColumnAggregates(task: ColumnAggregationTask, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<ColumnAggregationVariant> {
    if (task.columnEntry.type == SKIPPED_COLUMN || task.columnEntry.type == ROWNUMBER_COLUMN || task.columnEntry.type == LIST_COLUMN) {
        throw new LoggableException(`Column of type cannot be aggregated`, {
            type: getGridColumnTypeName(task.columnEntry),
        }, LOG_CTX);
    }

    const sql = buildColumnAggregationSQL(task);

    try {
        const transformStart = performance.now();
        const tableName = generateTableName("__col_agg");
        const aggregateDataFrame = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const transformEnd = performance.now();

        const aggregateTable = await aggregateDataFrame.readTable();
        const aggregateTableFormatter = new ArrowTableFormatter(aggregateTable.schema, aggregateTable.batches, logger);
        const readEnd = performance.now();

        let columnAggregate: ColumnAggregationVariant;
        switch (task.columnEntry.type) {
            case ORDINAL_COLUMN: {
                const analysis = analyzeOrdinalColumn(task.tableAggregate, task.columnEntry.value, aggregateTable, aggregateTableFormatter);
                columnAggregate = {
                    type: ORDINAL_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        binnedDataFrame: aggregateDataFrame,
                        binnedValues: aggregateTable,
                        binnedValuesFormatter: aggregateTableFormatter,
                        columnAnalysis: analysis,
                    }
                };
                break;
            }
            case STRING_COLUMN: {
                const analysis = analyzeStringColumn(task.tableAggregate, task.columnEntry.value, aggregateTable, aggregateTableFormatter);
                columnAggregate = {
                    type: STRING_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        frequentValuesDataFrame: aggregateDataFrame,
                        frequentValuesTable: aggregateTable,
                        frequentValuesFormatter: aggregateTableFormatter,
                        analysis,
                    }
                };
                break;
            }
        }
        const analysisEnd = performance.now();
        logger.info("Aggregated table column", {
            "version": task.tableVersion.toString(),
            "table": task.tableId.toString(),
            "columnIndex": task.columnId.toString(),
            "columnName": task.columnEntry.value.inputFieldName,
            "groupType": getGridColumnTypeName(task.columnEntry),
            "duration": Math.floor(analysisEnd - transformStart).toString(),
            "queryDuration": Math.floor(transformEnd - transformStart).toString(),
            "readDuration": Math.floor(readEnd - transformEnd).toString(),
            "analysisDuration": Math.floor(analysisEnd - readEnd).toString(),
            "resultRows": aggregateTable.numRows.toString(),
            "sql": sql,
        }, LOG_CTX);
        return columnAggregate;

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            const exception = new LoggableException("Computing column aggregate failed", {
                "table": task.tableId.toString(),
                "error": stringifyError(error),
            }, LOG_CTX);
            logger.warn(exception.message, exception.keyValues, exception.target);
            throw exception;
        }
    }
}

function buildColumnAggregationSQL(task: ColumnAggregationTask, filtered: WithFilter<ColumnAggregationTask> | null = null): string {
    if (task.columnEntry.type == SKIPPED_COLUMN || task.columnEntry.type == ROWNUMBER_COLUMN || task.columnEntry.value.statsFields == null) {
        throw new Error("Column summary requires precomputed table summary");
    }

    let frame = SQLFrame.from(task.inputDataFrame.tableName);

    if (filtered != null) {
        if (filtered.filterTable != null) {
            frame = frame.semiJoinFilter(
                filtered.filterTable.inputRowNumberColumnName,
                filtered.filterTable.dataFrame.tableName,
                filtered.filterTable.dataTable.schema.fields[0].name,
            );
        }
        if (filtered.dataSearchTable != null) {
            frame = frame.semiJoinFilter(
                filtered.dataSearchTable.inputRowNumberColumnName,
                filtered.dataSearchTable.dataFrame.tableName,
                filtered.dataSearchTable.dataTable.schema.fields[0].name,
            );
        }
    }

    const targetFieldName = task.columnEntry.value.inputFieldName;

    switch (task.columnEntry.type) {
        case ORDINAL_COLUMN: {
            const minField = task.columnEntry.value.statsFields.minAggregateFieldName!;
            const maxField = task.columnEntry.value.statsFields.maxAggregateFieldName!;
            frame = frame.groupBy({
                keys: [{
                    fieldName: targetFieldName,
                    outputAlias: "bin",
                    binning: {
                        preBinnedFieldName: task.columnEntry.value.binFieldName ?? undefined,
                        statsTable: task.tableAggregate.dataFrame.tableName,
                        statsMinField: minField,
                        statsMaxField: maxField,
                        binCount: task.columnEntry.value.binCount,
                        minBinWidth: isIntegerType(task.columnEntry.value.inputFieldType.typeId) ? 1 : undefined,
                        outputBinWidthAlias: "binWidth",
                        outputBinLbAlias: "binLowerBound",
                        outputBinUbAlias: "binUpperBound",
                        includeNullBin: true,
                        toNumericFn: getToNumericFn(task.columnEntry.value.inputFieldType.typeId),
                    }
                }],
                aggregates: [{
                    func: "count_star",
                    outputAlias: "count",
                }]
            }).orderBy([{ field: "bin", ascending: true }]);
            break;
        }
        case STRING_COLUMN: {
            if (task.columnEntry.value.valueIdFieldName == null) {
                throw new Error("Cannot aggregate string column without precomputed value id");
            }
            frame = frame.groupBy({
                keys: [
                    { fieldName: targetFieldName, outputAlias: "key" },
                    { fieldName: task.columnEntry.value.valueIdFieldName, outputAlias: "keyId" },
                ],
                aggregates: [{
                    func: "count_star",
                    outputAlias: "count",
                }]
            }).orderBy([{ field: "count", ascending: false }], 32);
            break;
        }
    }

    return frame.toSQL();
}

export async function computeFilteredColumnAggregates(task: WithFilter<ColumnAggregationTask>, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<WithFilterEpoch<ColumnAggregationVariant> | null> {
    if (task.columnEntry.type == SKIPPED_COLUMN || task.columnEntry.type == ROWNUMBER_COLUMN || task.columnEntry.type == LIST_COLUMN) {
        throw new LoggableException(`Column of type cannot be aggregated`, {
            type: getGridColumnTypeName(task.columnEntry),
        }, LOG_CTX);
    }

    const sql = buildColumnAggregationSQL(task, task);

    try {
        logger.info("Aggregating filtered table column", {
            "version": task.tableVersion.toString(),
            "table": task.tableId.toString(),
            "columnIndex": task.columnId.toString(),
            "columnName": task.columnEntry.value.inputFieldName,
            "groupType": getGridColumnTypeName(task.columnEntry),
        }, LOG_CTX);
        const transformStart = performance.now();
        const tableName = generateTableName("__filt_col_agg");
        const aggregateDataFrame = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const transformEnd = performance.now();
        logger.info("Aggregated filtered table column", {
            "version": task.tableVersion.toString(),
            "table": task.tableId.toString(),
            "columnIndex": task.columnId.toString(),
            "columnName": task.columnEntry.value.inputFieldName,
            "groupType": getGridColumnTypeName(task.columnEntry),
            "duration": Math.floor(transformEnd - transformStart).toString(),
            "sql": sql
        }, LOG_CTX);

        const aggregateTable = await aggregateDataFrame.readTable();
        const aggregateTableFormatter = new ArrowTableFormatter(aggregateTable.schema, aggregateTable.batches, logger);

        let columnAggregate: WithFilterEpoch<ColumnAggregationVariant>;
        switch (task.columnEntry.type) {
            case ORDINAL_COLUMN: {
                const analysis = analyzeOrdinalColumn(task.tableAggregate, task.columnEntry.value, aggregateTable, aggregateTableFormatter, task.selectionRowCount);
                columnAggregate = {
                    type: ORDINAL_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        binnedDataFrame: aggregateDataFrame,
                        binnedValues: aggregateTable,
                        binnedValuesFormatter: aggregateTableFormatter,
                        columnAnalysis: analysis,
                    },
                    filterVersion: task.tableVersion.clone(),
                    dataSearchRequestId: task.dataSearchTable?.requestId ?? null,
                };
                break;
            }
            case STRING_COLUMN: {
                const analysis = analyzeStringColumn(task.tableAggregate, task.columnEntry.value, aggregateTable, aggregateTableFormatter, task.selectionRowCount);
                columnAggregate = {
                    type: STRING_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        frequentValuesDataFrame: aggregateDataFrame,
                        frequentValuesTable: aggregateTable,
                        frequentValuesFormatter: aggregateTableFormatter,
                        analysis,
                    },
                    filterVersion: task.tableVersion.clone(),
                    dataSearchRequestId: task.dataSearchTable?.requestId ?? null,
                };
                break;
            }
        }
        return columnAggregate;

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            const exception = new LoggableException("Failed to compute filtered column aggregate", {
                "table": task.tableId.toString(),
                "columnIndex": task.columnId.toString(),
                "columnName": task.columnEntry.value.inputFieldName,
                "error": stringifyError(error),
            }, LOG_CTX);
            logger.warn(exception.message, exception.keyValues, exception.target);
            throw exception;
        }
    }
}
